import { describe, it, expect, afterAll, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { followReference, siblingDocsMode } from '../../src/parser/reference-objects.js';
import { parseSpec } from '../../src/parser/parse.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import type { ApiSpec, Operation } from '../../src/ir/types.js';

/**
 * One rule for the text written beside a `$ref` (OAS 3.1 §4.8.23), applied
 * by every Reference Object resolver: the outermost `description` (and
 * `summary`, where the type has one) with content wins over an inner ref's
 * and over the component's own in a 3.1 document, a blank one falls through,
 * and a 3.0 document ignores everything beside a `$ref`.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function parseDocument(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-reference-objects-'));
  dirs.push(dir);
  const file = path.join(dir, 'spec.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

describe('siblingDocsMode', () => {
  it('ignores text beside a $ref in a 3.0 document and reads it in 3.1 or an unrecognised version', () => {
    expect(siblingDocsMode('3.0.3')).toBe('ignore');
    expect(siblingDocsMode('3.0')).toBe('ignore');
    expect(siblingDocsMode('3.1.0')).toBe('override');
    expect(siblingDocsMode('3.2.0')).toBe('override');
    expect(siblingDocsMode(undefined)).toBe('override');
  });
});

describe('followReference', () => {
  type Described = { description?: string; summary?: string; value?: unknown };
  const limit: Described = { description: 'Component text.', value: 10 };
  const components = {
    Limit: limit,
    Alias: { $ref: '#/components/parameters/Limit', description: 'Alias text.' },
    Blank: { $ref: '#/components/parameters/Limit', description: '   ' },
    Loop: { $ref: '#/components/parameters/Loop' },
    'a/b~c': limit,
  };

  it('returns an inline object and an undescribed component by identity', () => {
    expect(followReference<Described>(limit, 'parameters', components, 'override')).toEqual({
      outcome: 'resolved',
      value: limit,
    });
    const followed = followReference<Described>(
      { $ref: '#/components/parameters/Limit' },
      'parameters',
      components,
      'override',
    );
    expect(followed.outcome).toBe('resolved');
    expect(followed.value).toBe(limit);
  });

  it('follows a chain and decodes JSON Pointer escapes (~1 then ~0)', () => {
    expect(
      followReference<Described>({ $ref: '#/components/parameters/a~1b~0c' }, 'parameters', components, 'override')
        .value,
    ).toBe(limit);
  });

  it("lets the outermost description with content win over an inner ref's and the component's", () => {
    const outer = followReference<Described>(
      { $ref: '#/components/parameters/Alias', description: 'Outer text.' },
      'parameters',
      components,
      'override',
    );
    expect(outer.value).toEqual({ ...limit, description: 'Outer text.' });
    const inner = followReference<Described>(
      { $ref: '#/components/parameters/Alias' },
      'parameters',
      components,
      'override',
    );
    expect(inner.value).toEqual({ ...limit, description: 'Alias text.' });
  });

  it('falls through a blank sibling to the next text along the chain, then to the component’s own', () => {
    const toAlias = followReference<Described>(
      { $ref: '#/components/parameters/Alias', description: '' },
      'parameters',
      components,
      'override',
    );
    expect(toAlias.value).toEqual({ ...limit, description: 'Alias text.' });
    const toComponent = followReference<Described>(
      { $ref: '#/components/parameters/Blank' },
      'parameters',
      components,
      'override',
    );
    expect(toComponent.value).toBe(limit);
  });

  it("keeps the component's own text under 'ignore', whatever is written beside the refs", () => {
    const followed = followReference<Described>(
      { $ref: '#/components/parameters/Alias', description: 'Outer text.' },
      'parameters',
      components,
      'ignore',
    );
    expect(followed.outcome).toBe('resolved');
    expect(followed.value).toBe(limit);
  });

  it('applies a summary only where the referenced type has one (an Example Object)', () => {
    const example: Described = { summary: 'Component summary.', value: 1 };
    const ref = { $ref: '#/components/examples/Sample', summary: 'Sibling summary.', description: 'Sibling text.' };
    expect(followReference<Described>(ref, 'examples', { Sample: example }, 'override').value).toEqual({
      ...example,
      summary: 'Sibling summary.',
      description: 'Sibling text.',
    });
    // A parameter has no `summary`, so the sibling's has no effect and only the description is applied.
    expect(
      followReference<Described>(
        { ...ref, $ref: '#/components/parameters/Limit' },
        'parameters',
        components,
        'override',
      ).value,
    ).toEqual({
      ...limit,
      description: 'Sibling text.',
    });
  });

  it('reports a ref nothing answers, into this section or another, with the ref as written and its text kept', () => {
    const missing = { $ref: '#/components/parameters/Missing', description: 'Gone.' };
    expect(followReference<Described>(missing, 'parameters', components, 'override')).toEqual({
      outcome: 'unresolved',
      ref: '#/components/parameters/Missing',
      value: missing,
    });
    const elsewhere = { $ref: '#/components/schemas/Limit' };
    const followed = followReference<Described>(elsewhere, 'parameters', components, 'override');
    expect(followed).toMatchObject({ outcome: 'unresolved', ref: '#/components/schemas/Limit' });
    expect(followed.value).toBe(elsewhere);
    // The outer text travels to the ref the walk stopped at.
    expect(
      followReference<Described>(
        { $ref: '#/components/parameters/Dangling', description: 'Outer text.' },
        'parameters',
        { Dangling: { $ref: '#/components/parameters/Missing' } },
        'override',
      ).value,
    ).toEqual({ $ref: '#/components/parameters/Missing', description: 'Outer text.' });
  });

  it('reports a circular chain, a $ref that is not a string, and a component that is not an object', () => {
    expect(
      followReference<Described>({ $ref: '#/components/parameters/Loop' }, 'parameters', components, 'override'),
    ).toMatchObject({
      outcome: 'circular',
      ref: '#/components/parameters/Loop',
    });
    expect(followReference<Described>({ $ref: 5 } as never, 'parameters', components, 'override')).toMatchObject({
      outcome: 'malformed',
      ref: '5',
    });
    expect(
      followReference<Described>(
        { $ref: '#/components/parameters/Text' },
        'parameters',
        { Text: 'nope' as never },
        'override',
      ),
    ).toMatchObject({ outcome: 'unresolved', ref: '#/components/parameters/Text' });
    // A `$ref` key holding `undefined` is no reference.
    const explicit: Described & { $ref?: undefined } = { $ref: undefined, description: 'Inline.' };
    expect(followReference<Described>(explicit, 'parameters', components, 'override')).toEqual({
      outcome: 'resolved',
      value: explicit,
    });
  });
});

describe('text beside a $ref through the parser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const limit = {
    name: 'limit',
    in: 'query',
    description: 'Component text.',
    schema: { type: 'integer', description: 'Schema text.' },
  };
  const requestId = { description: 'Component text.', schema: { type: 'string' } };

  /** A document whose only operation declares the given parameters and response headers. */
  const document = (
    openapi: string,
    parameters: unknown[],
    headers: Record<string, unknown> = {},
    responses: Record<string, unknown> = {},
  ) => ({
    openapi,
    info: { title: 'refs', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters,
          responses: { '200': { description: 'ok', headers }, ...responses },
        },
      },
    },
    components: {
      parameters: { Limit: limit, LimitAlias: { $ref: '#/components/parameters/Limit', description: 'Alias text.' } },
      headers: { RequestId: requestId },
      responses: { NotFound: { description: 'Component text.' } },
    },
  });

  it('reads a description beside a components/parameters $ref as the parameter’s own in a 3.1 document', async () => {
    const spec = await parseDocument(
      document('3.1.0', [
        { $ref: '#/components/parameters/Limit', description: 'Sibling text.' },
        { $ref: '#/components/parameters/LimitAlias', description: 'Outer text.' },
        { $ref: '#/components/parameters/LimitAlias' },
        { $ref: '#/components/parameters/Limit', description: '  ' },
      ]),
    );
    const op = opsOf(spec).listPets;

    // Four refs to one parameter are one identity; the last declaration wins, as for any repeated parameter.
    expect(op.queryParams.map((p) => p.description)).toEqual(['Component text.']);
    const one = async (parameter: unknown) =>
      opsOf(await parseDocument(document('3.1.0', [parameter]))).listPets.queryParams[0].description;
    expect(await one({ $ref: '#/components/parameters/Limit', description: 'Sibling text.' })).toBe('Sibling text.');
    expect(await one({ $ref: '#/components/parameters/LimitAlias', description: 'Outer text.' })).toBe('Outer text.');
    expect(await one({ $ref: '#/components/parameters/LimitAlias' })).toBe('Alias text.');
    expect(await one({ $ref: '#/components/parameters/Limit', description: '  ' })).toBe('Component text.');
  });

  it('ignores a description beside a components/parameters $ref in a 3.0 document', async () => {
    const spec = await parseDocument(
      document('3.0.3', [{ $ref: '#/components/parameters/LimitAlias', description: 'Outer text.' }]),
    );

    expect(opsOf(spec).listPets.queryParams[0].description).toBe('Component text.');
    expect(JSON.stringify(spec)).not.toContain('Outer text.');
    expect(JSON.stringify(spec)).not.toContain('Alias text.');
  });

  it('reads a description beside a components/headers $ref in a 3.1 document and ignores it in a 3.0 one', async () => {
    const headers = {
      'X-Request-Id': { $ref: '#/components/headers/RequestId', description: 'Sibling text.' },
      'X-Blank': { $ref: '#/components/headers/RequestId', description: ' ' },
    };
    const described = async (openapi: string) =>
      opsOf(await parseDocument(document(openapi, [], headers))).listPets.responseHeaders?.map((h) => [
        h.name,
        h.description,
      ]);

    expect(await described('3.1.0')).toEqual([
      ['X-Request-Id', 'Sibling text.'],
      ['X-Blank', 'Component text.'],
    ]);
    expect(await described('3.0.3')).toEqual([
      ['X-Request-Id', 'Component text.'],
      ['X-Blank', 'Component text.'],
    ]);
  });

  it('reads a description beside a components/responses $ref by the same rule on an error response', async () => {
    const responses = { '404': { $ref: '#/components/responses/NotFound', description: 'Sibling text.' } };
    const notFound = async (openapi: string) =>
      opsOf(await parseDocument(document(openapi, [], {}, responses))).listPets.errors.find((e) => e.statusCode === 404)
        ?.description;

    expect(await notFound('3.1.0')).toBe('Sibling text.');
    expect(await notFound('3.0.3')).toBe('Component text.');
  });

  it('applies the document’s mode to a webhook’s responses and parameters', () => {
    const webhooks = {
      petAdopted: {
        post: {
          parameters: [{ $ref: '#/components/parameters/Limit', description: 'Sibling text.' }],
          responses: {
            '200': { $ref: '#/components/responses/NotFound', description: 'Sibling text.' },
            '204': { $ref: '#/components/responses/NotFound', description: '  ' },
          },
        },
      },
    };
    const components = {
      parameters: { Limit: limit },
      responses: { NotFound: { description: 'Component text.' } },
    };
    const read = (mode: 'override' | 'ignore') => {
      const [hook] = extractWebhooks(webhooks, components, [], [], mode).webhooks;
      return [hook.queryParams[0].description, ...hook.responses.map((r) => r.description)];
    };

    expect(read('override')).toEqual(['Sibling text.', 'Sibling text.', 'Component text.']);
    expect(read('ignore')).toEqual(['Component text.', 'Component text.', 'Component text.']);
  });
});
