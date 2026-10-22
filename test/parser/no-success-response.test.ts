import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #264: an operation that declares no 2xx or 3xx response — only
 * `default`, only errors, only ranges, an empty `responses` map, or no
 * `responses` key at all — has `response` set to `unknown`, the type of a
 * body the document does not describe, exactly as a lone 3xx does. It used
 * to keep the parser's initial `string`, so an emitter typed the return value
 * of a `default`-only or error-only operation as a string the API never
 * sends. `responseDescription` and `responseHeaders` stay absent.
 */

const info = { title: 'Things', version: '1' };
const untyped: TypeRef = { kind: 'primitive', type: 'unknown' };
const model = (name: string): TypeRef => ({ kind: 'model', name });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const errorSchema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
const thingSchema = { type: 'object', properties: { name: { type: 'string' } } };
const errorRef = json({ $ref: '#/components/schemas/Error' });

/** A `GET /things` (`listThings`) document; `responses` is left off the operation when not given. */
function thingsSpec(responses?: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info,
    paths: { '/things': { get: { operationId: 'listThings', ...(responses && { responses }) } } },
    components: { schemas: { Thing: thingSchema, Error: errorSchema } },
  };
}

async function parseTempSpec(spec: Record<string, unknown>, fileName = 'spec.json'): Promise<ApiSpec> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-no-success-response-'));
  const specFile = path.join(tmpDir, fileName);
  try {
    await fs.writeFile(specFile, JSON.stringify(spec), 'utf-8');
    return await parseSpec(specFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
}

async function parseWithoutWarnings(spec: Record<string, unknown>, fileName?: string): Promise<ApiSpec> {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parseTempSpec(spec, fileName);
    expect(warnSpy.mock.calls).toEqual([]);
    return ir;
  } finally {
    warnSpy.mockRestore();
  }
}

/** The only operation a document declares. */
function only(ir: ApiSpec): Operation {
  const operations = ir.services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return operations[0];
}

function modelRefsAnywhere(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => modelRefsAnywhere(v, out));
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record['kind'] === 'model' && typeof record['name'] === 'string') out.add(record['name']);
    for (const v of Object.values(record)) modelRefsAnywhere(v, out);
  }
  return out;
}

/**
 * Every `model` ref in every operation (fallback and error responses
 * included) and in every model resolves to a parsed model, and every model
 * other than the named components is referenced — nothing dangles and nothing
 * is orphaned.
 */
function expectConsistent(ir: ApiSpec, components: string[] = ['Thing', 'Error']): void {
  const referenced = modelRefsAnywhere(ir.services.flatMap((s) => s.operations));
  for (const m of ir.models) modelRefsAnywhere(m.fields, referenced);
  const known = new Set(ir.models.map((m) => m.name));
  expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
  expect([...known].filter((name) => !components.includes(name) && !referenced.has(name))).toEqual([]);
}

/** `response` is `unknown` and nothing describes it: no description, headers or media types, and no success list. */
function expectUndescribedResponse(op: Operation): void {
  expect(op.response).toEqual(untyped);
  expect(op.successResponses).toBeUndefined();
  expect(Object.keys(op)).not.toContain('responseDescription');
  expect(Object.keys(op)).not.toContain('responseHeaders');
  expect(Object.keys(op)).not.toContain('responseContentTypes');
  expect(Object.keys(op)).not.toContain('responseContents');
  expect(op.pagination).toBeUndefined();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an operation that declares no 2xx or 3xx response (issue #264)', () => {
  it("the issue's repro: default-only and 404-only read as unknown, the same as a lone 302", async () => {
    const files: Array<[string, Record<string, unknown>]> = [
      ['default-only.json', thingsSpec({ default: { description: 'err', content: errorRef } })],
      ['404-only.json', thingsSpec({ '404': { description: 'nope' } })],
      ['302-only.json', thingsSpec({ '302': { description: 'Moved' } })],
    ];
    const seen: Array<[string, TypeRef, string | undefined, number[]]> = [];
    for (const [file, spec] of files) {
      const op = only(await parseWithoutWarnings(spec, file));
      seen.push([file, op.response, op.responseDescription, op.errors.map(({ statusCode }) => statusCode)]);
    }

    expect(seen).toEqual([
      ['default-only.json', untyped, undefined, []],
      ['404-only.json', untyped, undefined, [404]],
      ['302-only.json', untyped, 'Moved', []],
    ]);
  });

  it('types a default-only operation as unknown and keeps the default body where it belongs', async () => {
    const ir = await parseWithoutWarnings(thingsSpec({ default: { description: 'err', content: errorRef } }));
    const op = only(ir);

    expectUndescribedResponse(op);
    expect(op.errors).toEqual([]);
    expect(op.defaultResponse).toEqual({
      type: model('Error'),
      contentTypes: ['application/json'],
      contents: [{ contentType: 'application/json', type: model('Error') }],
      description: 'err',
    });
    expectConsistent(ir);
  });

  it('types an error-only operation as unknown and keeps its errors', async () => {
    const ir = await parseWithoutWarnings(thingsSpec({ '404': { description: 'nope', content: errorRef } }));
    const op = only(ir);

    expectUndescribedResponse(op);
    expect(op.errors).toEqual([{ statusCode: 404, type: model('Error'), description: 'nope' }]);
    expect(Object.keys(op)).not.toContain('defaultResponse');
    expect(Object.keys(op)).not.toContain('rangeResponses');
    expectConsistent(ir);
  });

  it('types an operation with no `responses` key as unknown', async () => {
    const ir = await parseWithoutWarnings(thingsSpec());
    const op = only(ir);

    expectUndescribedResponse(op);
    expect(op.errors).toEqual([]);
    expect(Object.keys(op)).not.toContain('defaultResponse');
    expect(Object.keys(op)).not.toContain('rangeResponses');
    expectConsistent(ir);
  });

  it('types an operation with an empty `responses` map as unknown', async () => {
    const op = only(await parseWithoutWarnings(thingsSpec({})));

    expectUndescribedResponse(op);
    expect(op.errors).toEqual([]);
    expect(Object.keys(op)).not.toContain('defaultResponse');
    expect(Object.keys(op)).not.toContain('rangeResponses');
  });

  it('types an operation whose only keys are ranges as unknown, without promoting the 2XX body', async () => {
    const ir = await parseWithoutWarnings(
      thingsSpec({
        '2XX': { description: 'ok', content: json({ $ref: '#/components/schemas/Thing' }) },
        '4XX': { description: 'bad', content: errorRef },
      }),
    );
    const op = only(ir);

    expectUndescribedResponse(op);
    expect(op.errors).toEqual([]);
    expect(op.rangeResponses).toEqual([
      {
        range: '2XX',
        type: model('Thing'),
        contentTypes: ['application/json'],
        contents: [{ contentType: 'application/json', type: model('Thing') }],
        description: 'ok',
      },
      {
        range: '4XX',
        type: model('Error'),
        contentTypes: ['application/json'],
        contents: [{ contentType: 'application/json', type: model('Error') }],
        description: 'bad',
      },
    ]);
    expectConsistent(ir);
  });

  it('types an operation declaring default, an error and a range together as unknown', async () => {
    const ir = await parseWithoutWarnings(
      thingsSpec({
        default: { description: 'err', content: errorRef },
        '404': { description: 'nope' },
        '5XX': { description: 'down' },
      }),
    );
    const op = only(ir);

    expectUndescribedResponse(op);
    expect(op.errors).toEqual([{ statusCode: 404, description: 'nope' }]);
    expect(op.defaultResponse?.type).toEqual(model('Error'));
    expect(op.rangeResponses).toEqual([{ range: '5XX', description: 'down' }]);
    expectConsistent(ir);
  });

  it('types an operation whose only explicit code is 1xx as unknown and carries nothing for it', async () => {
    const op = only(await parseWithoutWarnings(thingsSpec({ '101': { description: 'switching' } })));

    expectUndescribedResponse(op);
    expect(op.errors).toEqual([]);
  });

  it('materializes an inline default body under its own name while response stays unknown', async () => {
    const ir = await parseWithoutWarnings(
      thingsSpec({
        default: {
          description: 'err',
          content: json({ type: 'object', properties: { code: { type: 'integer' } } }),
        },
      }),
    );
    const op = only(ir);

    expectUndescribedResponse(op);
    expect(op.defaultResponse?.type).toEqual(model('ListThingsDefaultResponse'));
    expect(ir.models.map((m) => m.name)).toEqual(['Thing', 'Error', 'ListThingsDefaultResponse']);
    expectConsistent(ir);
  });

  it('materializes an inline error body under its own name while response stays unknown', async () => {
    const ir = await parseWithoutWarnings(
      thingsSpec({
        '404': {
          description: 'nope',
          content: json({ type: 'object', properties: { code: { type: 'integer' } } }),
        },
      }),
    );
    const op = only(ir);

    expectUndescribedResponse(op);
    expect(op.errors).toHaveLength(1);
    expect(op.errors[0].type).toEqual(model('ListThingsError404'));
    expect(ir.models.map((m) => m.name)).toEqual(['Thing', 'Error', 'ListThingsError404']);
    expectConsistent(ir);
  });

  it('reads an undefined `responses` the same way when operations are extracted directly', () => {
    const { services } = extractOperations({ '/things': { get: { operationId: 'listThings' } } } as never);
    const op = services[0].operations[0];

    expectUndescribedResponse(op);
    expect(op.errors).toEqual([]);
  });
});

describe('the boundary: a declared 2xx or 3xx still decides the primary response', () => {
  it('a lone 3xx is unknown too, but keeps its description and headers', async () => {
    const op = only(
      await parseWithoutWarnings(
        thingsSpec({
          '302': { description: 'Moved', headers: { Location: { schema: { type: 'string' } } } },
        }),
      ),
    );

    expect(op.response).toEqual(untyped);
    expect(op.responseDescription).toBe('Moved');
    expect(op.responseHeaders).toEqual([
      { name: 'Location', type: { kind: 'primitive', type: 'string' }, required: false },
    ]);
    expect(op.successResponses).toBeUndefined();
  });

  it('a lone 2xx without content is unknown, with its description', async () => {
    const op = only(await parseWithoutWarnings(thingsSpec({ '204': { description: 'gone' } })));

    expect(op.response).toEqual(untyped);
    expect(op.responseDescription).toBe('gone');
  });

  it('a 2xx with a body is typed from it, whatever else the operation declares', async () => {
    const op = only(
      await parseWithoutWarnings(
        thingsSpec({
          '200': { description: 'ok', content: json({ $ref: '#/components/schemas/Thing' }) },
          '404': { description: 'nope' },
          default: { description: 'err', content: errorRef },
        }),
      ),
    );

    expect(op.response).toEqual(model('Thing'));
    expect(op.responseDescription).toBe('ok');
    expect(op.errors.map(({ statusCode }) => statusCode)).toEqual([404]);
    expect(op.defaultResponse?.type).toEqual(model('Error'));
  });
});
