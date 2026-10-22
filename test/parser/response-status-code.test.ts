import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { collectModelRefs, collectResponseBodyTypes } from '../../src/ir/types.js';
import type { ApiSpec, HttpMethod, Operation } from '../../src/ir/types.js';

/**
 * Issue #274, review: `Operation.responseStatusCode` is the status code of
 * the response `response` was read from — the primary success response — so
 * a consumer that checks a live status against the document (the smoke
 * helpers) credits a lone `302`, or a POST's lone `200`, instead of guessing
 * a code from the HTTP method. It is present exactly when the operation
 * declares at least one 2xx or 3xx response.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-response-status-code-'));
  dirs.push(dir);
  const file = path.join(dir, 'spec.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

const unknown = { kind: 'primitive', type: 'unknown' };
const json = (schema: unknown) => ({ 'application/json': { schema } });
const petSchema = { type: 'object', properties: { id: { type: 'string' } } };
const errorSchema = { type: 'object', properties: { message: { type: 'string' } } };

/** A document with one `/pets` operation declaring `responses` (left off when undefined). */
const specDoc = (
  method: HttpMethod,
  responses: Record<string, unknown> | undefined,
  componentResponses: Record<string, unknown> = {},
) => ({
  openapi: '3.1.0',
  info: { title: 'pets', version: '1' },
  paths: { '/pets': { [method]: { operationId: 'listPets', ...(responses && { responses }) } } },
  components: { schemas: { Pet: petSchema, Error: errorSchema }, responses: componentResponses },
});

async function parseOnly(
  method: HttpMethod,
  responses: Record<string, unknown> | undefined,
  componentResponses?: Record<string, unknown>,
): Promise<{ spec: ApiSpec; op: Operation }> {
  const spec = await parseSpec(await writeSpec(specDoc(method, responses, componentResponses)));
  const ops = spec.services.flatMap((s) => s.operations);
  expect(ops).toHaveLength(1);
  return { spec, op: ops[0] };
}

/** Every model reference the operation's responses hold that names no model, as `"source → Model"`. */
function unresolvedResponseRefs(spec: ApiSpec, op: Operation): string[] {
  const names = new Set(spec.models.map((m) => m.name));
  const refs: Array<[string, ReturnType<typeof collectModelRefs>]> = [
    ['response', collectModelRefs(op.response)],
    ...(op.successResponses ?? []).map((r): [string, string[]] => [`${r.statusCode}`, collectModelRefs(r.type)]),
    ...op.errors.map((e): [string, string[]] => [`${e.statusCode}`, e.type ? collectModelRefs(e.type) : []]),
    ...collectResponseBodyTypes(op).map((e): [string, string[]] => [e.source, collectModelRefs(e.type)]),
  ];
  return refs.flatMap(([source, models]) => models.filter((m) => !names.has(m)).map((m) => `${source} → ${m}`));
}

describe('Operation.responseStatusCode', () => {
  it('is the lone success response code, whatever the HTTP method would suggest', async () => {
    const get = await parseOnly('get', {
      '200': { description: 'OK', content: json({ $ref: '#/components/schemas/Pet' }) },
    });
    const post = await parseOnly('post', {
      '200': { description: 'Updated', content: json({ $ref: '#/components/schemas/Pet' }) },
    });
    const del = await parseOnly('delete', { '204': { description: 'Deleted' } });
    const redirect = await parseOnly('get', { '302': { description: 'See the photo' } });

    expect([get, post, del, redirect].map(({ op }) => op.responseStatusCode)).toEqual([200, 200, 204, 302]);
    for (const { op } of [get, post, del, redirect]) expect(op.successResponses).toBeUndefined();
    expect(redirect.op.response).toEqual(unknown);
  });

  it('is the primary entry among several: the lowest 2xx with a typed body', async () => {
    const bothTyped = await parseOnly('post', {
      '200': { description: 'Updated', content: json({ $ref: '#/components/schemas/Pet' }) },
      '201': { description: 'Created', content: json({ $ref: '#/components/schemas/Pet' }) },
    });
    expect(bothTyped.op.responseStatusCode).toBe(200);
    expect(bothTyped.op.successResponses?.map((r) => r.statusCode)).toEqual([200, 201]);

    // An untyped `200` (no content) yields to the typed `201`, and the code follows the body.
    const untypedFirst = await parseOnly('post', {
      '200': { description: 'Nothing to say' },
      '201': { description: 'Created', content: json({ $ref: '#/components/schemas/Pet' }) },
    });
    expect(untypedFirst.op.responseStatusCode).toBe(201);
    expect(untypedFirst.op.response).toEqual({ kind: 'model', name: 'Pet' });
    expect(untypedFirst.op.responseDescription).toBe('Created');
    expect(untypedFirst.op.successResponses?.find((r) => r.statusCode === 201)?.type).toEqual(untypedFirst.op.response);

    const redirects = await parseOnly('get', {
      '301': { description: 'Moved' },
      '302': { description: 'Found' },
    });
    expect(redirects.op.responseStatusCode).toBe(301);
  });

  it('is read through a $ref into components/responses', async () => {
    const { spec, op } = await parseOnly(
      'get',
      { '200': { $ref: '#/components/responses/PetList' }, '404': { $ref: '#/components/responses/NotFound' } },
      {
        PetList: {
          description: 'The pets',
          content: json({ type: 'object', properties: { data: { type: 'array', items: petSchema } } }),
        },
        NotFound: { description: 'Not found', content: json({ $ref: '#/components/schemas/Error' }) },
      },
    );

    expect(op.responseStatusCode).toBe(200);
    expect(op.errors.map((e) => e.statusCode)).toEqual([404]);
    expect(unresolvedResponseRefs(spec, op)).toEqual([]);
  });

  it('is absent, not undefined-valued, when the operation declares no 2xx or 3xx response', async () => {
    const cases: Array<[string, Record<string, unknown> | undefined]> = [
      ['only an error', { '404': { description: 'Not found', content: json({ $ref: '#/components/schemas/Error' }) } }],
      ['only default', { default: { description: 'Anything', content: json({ $ref: '#/components/schemas/Error' }) } }],
      [
        'only a 2XX range',
        { '2XX': { description: 'Some success', content: json({ $ref: '#/components/schemas/Pet' }) } },
      ],
      ['an empty responses map', {}],
      ['no responses key', undefined],
    ];
    for (const [label, responses] of cases) {
      const { spec, op } = await parseOnly('get', responses);
      expect(op, label).not.toHaveProperty('responseStatusCode');
      expect(op.response, label).toEqual(unknown);
      expect(unresolvedResponseRefs(spec, op), label).toEqual([]);
    }
  });
});
