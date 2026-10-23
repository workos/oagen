import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { collectInlineEnumsFromOperations } from '../../src/parser/collect-inline-enums.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { assignModelsToServices, collectFallbackResponseTypes, collectResponseHeaders } from '../../src/ir/types.js';
import type { ApiSpec, Enum, Model, Operation, TypeRef } from '../../src/ir/types.js';

const info = { title: 'Pets', version: '1' };
const str: TypeRef = { kind: 'primitive', type: 'string' };
/** The type of a body the document does not describe (issue #264). */
const untyped: TypeRef = { kind: 'primitive', type: 'unknown' };
const int: TypeRef = { kind: 'primitive', type: 'integer' };
const model = (name: string): TypeRef => ({ kind: 'model', name });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const errorSchema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
const petSchema = { type: 'object', properties: { name: { type: 'string' } } };
const ok = { description: 'ok', content: json({ $ref: '#/components/schemas/Pet' }) };
/** The media-type lists a fallback declaring only `application/json` carries, its entry sharing the body's type. */
const jsonBody = (type: TypeRef) => ({
  contentTypes: ['application/json'],
  contents: [{ contentType: 'application/json', type }],
});

/** A `GET /pets` (`listPets`) document with the given responses and the `Pet` and `Error` components. */
function petsSpec(
  responses: Record<string, unknown>,
  operation: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info,
    paths: { '/pets': { get: { operationId: 'listPets', ...operation, responses } } },
    components: { schemas: { Pet: petSchema, Error: errorSchema } },
  };
}

/** A cursor parameter, so a list envelope is unwrapped for the iterator it drives (#309). */
const afterParam = { parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }] };

async function parseTempSpec(spec: Record<string, unknown>): Promise<ApiSpec> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-fallback-responses-'));
  const specFile = path.join(tmpDir, 'spec.json');
  try {
    await fs.writeFile(specFile, JSON.stringify(spec), 'utf-8');
    return await parseSpec(specFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
}

async function parseWithoutWarnings(spec: Record<string, unknown>): Promise<ApiSpec> {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parseTempSpec(spec);
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
 * Every `model` ref in every operation (fallback responses included) and in
 * every model resolves to a parsed model, and every model other than the
 * named components is referenced — nothing dangles and nothing is orphaned.
 */
function expectConsistent(ir: ApiSpec, components: string[] = ['Pet', 'Error']): void {
  const referenced = modelRefsAnywhere(ir.services.flatMap((s) => s.operations));
  for (const m of ir.models) modelRefsAnywhere(m.fields, referenced);
  const known = new Set(ir.models.map((m) => m.name));
  expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
  expect([...known].filter((name) => !components.includes(name) && !referenced.has(name))).toEqual([]);
}

function fieldTypesByModel(models: Model[]): Record<string, Record<string, TypeRef>> {
  return Object.fromEntries(models.map((m) => [m.name, Object.fromEntries(m.fields.map((f) => [f.name, f.type]))]));
}

/** Extract `GET /pets` (`listPets`) without parsing a document, for warning and header assertions. */
function extractPets(responses: Record<string, unknown>): { op: Operation; inlineModels: Model[] } {
  const { services, inlineModels } = extractOperations({
    '/pets': { get: { operationId: 'listPets', responses } },
  } as never);
  return { op: services[0].operations[0], inlineModels };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the default response (issue #214)', () => {
  it("the issue's repro: keeps the default response, apart from errors, as the referenced model", async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              '200': {
                description: 'ok',
                content: json({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }),
              },
              '404': { description: 'Not found', content: json({ $ref: '#/components/schemas/Error' }) },
              default: { description: 'Any other error', content: json({ $ref: '#/components/schemas/Error' }) },
            },
          },
        },
      },
      components: { schemas: { Error: errorSchema } },
    });
    const op = only(ir);

    expect(op.response).toEqual(model('GetPetResponse'));
    // `errors` is exactly what it was: the default is not an entry without a code.
    expect(op.errors).toEqual([{ statusCode: 404, description: 'Not found', type: model('Error') }]);
    expect(op.defaultResponse).toEqual({
      type: model('Error'),
      ...jsonBody(model('Error')),
      description: 'Any other error',
    });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Error', 'GetPetResponse']);
    expectConsistent(ir, []);
  });

  it('is present without a type when the response declares no content', async () => {
    const op = only(await parseWithoutWarnings(petsSpec({ '200': ok, default: { description: 'Unexpected' } })));

    expect(Object.keys(op)).toContain('defaultResponse');
    expect(op.defaultResponse).toEqual({ description: 'Unexpected' });
    expect(op.errors).toEqual([]);
  });

  it('is never promoted to the primary response when the operation declares no 2xx', async () => {
    const op = only(
      await parseWithoutWarnings(
        petsSpec({ default: { description: 'err', content: json({ $ref: '#/components/schemas/Error' }) } }),
      ),
    );

    expect(op.response).toEqual(untyped);
    expect(op.successResponses).toBeUndefined();
    expect(op.errors).toEqual([]);
    expect(op.defaultResponse).toEqual({ type: model('Error'), ...jsonBody(model('Error')), description: 'err' });
  });

  it('leaves the key off an operation that declares none', async () => {
    const op = only(await parseWithoutWarnings(petsSpec({ '200': ok })));

    expect(Object.keys(op)).not.toContain('defaultResponse');
    expect(Object.keys(op)).not.toContain('rangeResponses');
    expect(collectFallbackResponseTypes(op)).toEqual([]);
  });

  it('materializes an inline body as <Op>DefaultResponse, nested objects included, with nothing dangling', async () => {
    const ir = await parseWithoutWarnings(
      petsSpec({
        '200': ok,
        default: {
          description: 'err',
          content: json({
            type: 'object',
            properties: {
              message: { type: 'string' },
              detail: { type: 'object', properties: { field: { type: 'string' } } },
            },
            required: ['message'],
          }),
        },
      }),
    );
    const op = only(ir);

    expect(op.defaultResponse).toEqual({
      type: model('ListPetsDefaultResponse'),
      ...jsonBody(model('ListPetsDefaultResponse')),
      description: 'err',
    });
    const types = fieldTypesByModel(ir.models);
    expect(types['ListPetsDefaultResponse']).toEqual({ message: str, detail: model('ListPetsDefaultResponseDetail') });
    expect(types['ListPetsDefaultResponseDetail']).toEqual({ field: str });
    expect(ir.models.map((m) => m.name).sort()).toEqual([
      'Error',
      'ListPetsDefaultResponse',
      'ListPetsDefaultResponseDetail',
      'Pet',
    ]);
    expectConsistent(ir);
  });

  it("materializes inline array items under the body's name, as a field's array items take its name", async () => {
    const ir = await parseWithoutWarnings(
      petsSpec({
        '200': ok,
        default: {
          description: 'errs',
          content: json({ type: 'array', items: { type: 'object', properties: { code: { type: 'string' } } } }),
        },
      }),
    );

    const items: TypeRef = { kind: 'array', items: model('ListPetsDefaultResponse') };
    expect(only(ir).defaultResponse).toEqual({ type: items, ...jsonBody(items), description: 'errs' });
    expect(fieldTypesByModel(ir.models)['ListPetsDefaultResponse']).toEqual({ code: str });
    expectConsistent(ir);
  });

  it('types a oneOf body as a union and materializes its inline variants', async () => {
    const ir = await parseWithoutWarnings(
      petsSpec({
        '200': ok,
        default: {
          description: 'err',
          content: json({
            oneOf: [
              { $ref: '#/components/schemas/Error' },
              { type: 'object', properties: { code: { type: 'integer' } } },
            ],
          }),
        },
      }),
    );
    const type = only(ir).defaultResponse?.type;

    expect(type?.kind).toBe('union');
    expectConsistent(ir);
  });

  it('names the inline body of an operationId-less operation from its path, like the primary body', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets/{petId}': {
          get: {
            responses: {
              '200': { description: 'ok', content: json({ type: 'object', properties: { name: { type: 'string' } } }) },
              default: {
                description: 'err',
                content: json({ type: 'object', properties: { message: { type: 'string' } } }),
              },
            },
          },
        },
      },
    });
    const op = only(ir);
    const primary = (op.response as { name: string }).name;

    expect(primary.endsWith('Response')).toBe(true);
    const body = model(primary.replace(/Response$/, 'DefaultResponse'));
    expect(op.defaultResponse).toEqual({ type: body, ...jsonBody(body), description: 'err' });
    expectConsistent(ir, []);
  });

  it('reads a +json media type when application/json is absent, ignoring media type parameters', async () => {
    const problem = { 'application/problem+json; charset=utf-8': { schema: { $ref: '#/components/schemas/Error' } } };
    const op = only(
      await parseWithoutWarnings(petsSpec({ '200': ok, default: { description: 'err', content: problem } })),
    );

    // The media type is kept as written and its entry shares the body's type,
    // so a reader can tell which media type `type` was read from.
    expect(op.defaultResponse).toEqual({
      type: model('Error'),
      contentTypes: ['application/problem+json; charset=utf-8'],
      contents: [{ contentType: 'application/problem+json; charset=utf-8', type: model('Error') }],
      description: 'err',
    });
    expect(op.defaultResponse?.contents?.[0].type).toBe(op.defaultResponse?.type);
  });

  it('prefers application/json over a +json media type', async () => {
    const content = {
      'application/problem+json': { schema: { type: 'object', properties: { title: { type: 'string' } } } },
      'application/json': { schema: { $ref: '#/components/schemas/Error' } },
    };
    const ir = await parseWithoutWarnings(petsSpec({ '200': ok, default: { description: 'err', content } }));
    const op = only(ir);

    // `type` is the `application/json` body; the `+json` body is typed on its
    // own and its inline object materialized like a secondary media type's.
    expect(op.defaultResponse).toEqual({
      type: model('Error'),
      contentTypes: ['application/problem+json', 'application/json'],
      contents: [
        { contentType: 'application/problem+json', type: model('ListPetsDefaultApplicationProblemJsonResponse') },
        { contentType: 'application/json', type: model('Error') },
      ],
      description: 'err',
    });
    expect(fieldTypesByModel(ir.models)['ListPetsDefaultApplicationProblemJsonResponse']).toEqual({ title: str });
    expectConsistent(ir);
  });

  it('has no type for a non-JSON body, as errors do, but keeps its media type', async () => {
    const content = { 'text/plain': { schema: { type: 'string' } } };
    const op = only(await parseWithoutWarnings(petsSpec({ '200': ok, default: { description: 'err', content } })));

    expect(op.defaultResponse).toEqual({
      contentTypes: ['text/plain'],
      contents: [{ contentType: 'text/plain', type: str }],
      description: 'err',
    });
  });
});

describe('range responses (1XX–5XX)', () => {
  it('keeps every range in rangeResponses, in declaration order, and in no other list', async () => {
    const ir = await parseWithoutWarnings(
      petsSpec({
        '200': ok,
        '5XX': { description: 'down', content: json({ $ref: '#/components/schemas/Error' }) },
        '2XX': { description: 'other success' },
        '4XX': { description: 'rejected', content: json({ type: 'object', properties: { code: { type: 'string' } } }) },
        '1XX': { description: 'info' },
        '3XX': { description: 'moved' },
      }),
    );
    const op = only(ir);

    expect(op.rangeResponses).toEqual([
      { range: '5XX', type: model('Error'), ...jsonBody(model('Error')), description: 'down' },
      { range: '2XX', description: 'other success' },
      {
        range: '4XX',
        type: model('ListPetsError4Xx'),
        ...jsonBody(model('ListPetsError4Xx')),
        description: 'rejected',
      },
      { range: '1XX', description: 'info' },
      { range: '3XX', description: 'moved' },
    ]);
    // A range never stands in for a status code: the explicit lists are untouched.
    expect(op.response).toEqual(model('Pet'));
    expect(op.successResponses).toBeUndefined();
    expect(op.errors).toEqual([]);
    expect(collectFallbackResponseTypes(op)).toEqual([model('Error'), model('ListPetsError4Xx')]);
    expectConsistent(ir);
  });

  it('does not promote a 2XX range to the primary response', async () => {
    const op = only(await parseWithoutWarnings(petsSpec({ '2XX': ok })));

    expect(op.response).toEqual(untyped);
    expect(op.rangeResponses).toEqual([
      { range: '2XX', type: model('Pet'), ...jsonBody(model('Pet')), description: 'ok' },
    ]);
  });

  it.each([
    ['1XX', 'ListPetsInformationalResponse'],
    ['2XX', 'ListPetsSuccessResponse'],
    ['3XX', 'ListPetsRedirectResponse'],
    ['4XX', 'ListPetsError4Xx'],
    ['5XX', 'ListPetsError5Xx'],
  ])('names the inline body of a %s response %s', async (range, name) => {
    const ir = await parseWithoutWarnings(
      petsSpec({
        '200': ok,
        [range]: { description: 'r', content: json({ type: 'object', properties: { code: { type: 'string' } } }) },
      }),
    );

    expect(only(ir).rangeResponses).toEqual([{ range, type: model(name), ...jsonBody(model(name)), description: 'r' }]);
    expect(fieldTypesByModel(ir.models)[name]).toEqual({ code: str });
    expectConsistent(ir);
  });

  it('reads a lowercase range key as its uppercase range', async () => {
    const op = only(
      await parseWithoutWarnings(
        petsSpec({
          '200': ok,
          '4xx': { description: 'rejected', content: json({ $ref: '#/components/schemas/Error' }) },
        }),
      ),
    );

    expect(op.rangeResponses).toEqual([
      { range: '4XX', type: model('Error'), ...jsonBody(model('Error')), description: 'rejected' },
    ]);
  });

  it('keeps the first of a duplicate range and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { op } = extractPets({
      '200': ok,
      '4XX': { description: 'first', content: json({ $ref: '#/components/schemas/Error' }) },
      '4xx': { description: 'second' },
    });

    expect(op.rangeResponses).toEqual([
      { range: '4XX', type: model('Error'), ...jsonBody(model('Error')), description: 'first' },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate "4XX" response on listPets'));
  });

  it('keeps an explicit code and its range side by side', async () => {
    const op = only(
      await parseWithoutWarnings(
        petsSpec({
          '200': ok,
          '404': { description: 'missing', content: json({ $ref: '#/components/schemas/Error' }) },
          '4XX': { description: 'rejected', content: json({ $ref: '#/components/schemas/Error' }) },
          default: { description: 'other' },
        }),
      ),
    );

    expect(op.errors).toEqual([{ statusCode: 404, description: 'missing', type: model('Error') }]);
    expect(op.rangeResponses).toEqual([
      { range: '4XX', type: model('Error'), ...jsonBody(model('Error')), description: 'rejected' },
    ]);
    expect(op.defaultResponse).toEqual({ description: 'other' });
  });
});

describe('response keys OpenAPI does not define', () => {
  it('skips specification extensions silently, whatever their value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { op } = extractPets({ '200': ok, 'x-internal': true, 'x-notes': null });

    expect(op.response).toEqual(model('Pet'));
    expect(Object.keys(op)).not.toContain('defaultResponse');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about, then ignores, a key that is neither a status code, a range, nor default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { op } = extractPets({ '200': ok, error: { description: 'not a key OpenAPI knows' } });

    expect(op.response).toEqual(model('Pet'));
    expect(op.errors).toEqual([]);
    expect(Object.keys(op)).not.toContain('defaultResponse');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring response key "error" on listPets'));
  });

  /** The warning `classifyResponseKey` leaves for a key OpenAPI does not define, on `listPets`. */
  const ignored = (key: string): string =>
    `[oagen] Warning: Ignoring response key "${key}" on listPets: not a status code (three digits, 100–599), a 1XX–5XX range, or "default"`;

  describe('a key that starts with digits but is no status code (issue #275)', () => {
    const inlineBody = (description: string) => ({
      description,
      content: json({ type: 'object', properties: { code: { type: 'string' } } }),
    });

    it("the issue's repro: warns about, then ignores, `6XX`, `4XXX` and `20X`, each with a JSON body", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ir = await parseTempSpec(
        petsSpec({ '200': ok, '6XX': inlineBody('6XX'), '4XXX': inlineBody('4XXX'), '20X': inlineBody('20X') }),
      );
      const op = only(ir);

      expect(op.response).toEqual(model('Pet'));
      expect(op.defaultResponse).toBeUndefined();
      expect(op.errors).toEqual([]);
      expect(op.rangeResponses).toBeUndefined();
      // Nothing was read from a numeric prefix: no `6`, `4` or `20` entry
      // anywhere, and no model minted for an ignored body.
      expect(op.successResponses).toBeUndefined();
      expect(ir.models.map((m) => m.name).sort()).toEqual(['Error', 'Pet']);
      expectConsistent(ir);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([ignored('6XX'), ignored('4XXX'), ignored('20X')]);
    });

    it("the comment's repro: warns about, then ignores, `600` instead of filing it under errors", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ir = await parseTempSpec(petsSpec({ '200': ok, '600': inlineBody('600') }));
      const op = only(ir);

      expect(op.response).toEqual(model('Pet'));
      expect(op.errors).toEqual([]);
      // No `Error600`-like model is minted for the ignored body.
      expect(ir.models.map((m) => m.name).sort()).toEqual(['Error', 'Pet']);
      expectConsistent(ir);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([ignored('600')]);
    });

    it('decides by the whole key: every key that is not three digits in 100–599 is warned about and ignored', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Each of these parses to a number under `parseInt`, or starts with a
      // digit; `200a`, `0200` and `200 ` once added a second `200` to
      // `successResponses`, `999`, `2001` and `20` once reached the branches.
      const keys = [
        '000',
        '099',
        '0200',
        '200a',
        '200 ',
        ' 200',
        '2e2',
        '20',
        '999',
        '2001',
        '0XX',
        '6xx',
        '5XXX',
        '20X',
        '4X',
      ];
      const responses = { '200': ok, ...Object.fromEntries(keys.map((key) => [key, inlineBody(key)])) };
      const { op, inlineModels } = extractPets(responses);

      expect(op.response).toEqual(model('Pet'));
      expect(op.successResponses).toBeUndefined();
      expect(op.errors).toEqual([]);
      expect(Object.keys(op)).not.toContain('defaultResponse');
      expect(Object.keys(op)).not.toContain('rangeResponses');
      expect(inlineModels).toEqual([]);
      // One warning per key, in the order the parser reads the Responses
      // Object (`Object.entries`: integer-like keys such as `20` first).
      const expected = Object.keys(responses)
        .filter((key) => key !== '200')
        .map(ignored);
      expect(expected).toHaveLength(keys.length);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(expected);
    });

    it('still reads an explicit 1xx code as a status code: not carried, and not warned about', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { op } = extractPets({ '101': { description: 'switching protocols' }, '200': ok });

      expect(op.response).toEqual(model('Pet'));
      expect(op.successResponses).toBeUndefined();
      expect(op.errors).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('headers on fallback responses', () => {
  it('keeps them, typed, and collectResponseHeaders yields them after the explicit lists', () => {
    const { op } = extractPets({
      '200': { description: 'ok', headers: { ETag: { schema: { type: 'string' } } } },
      default: { description: 'err', headers: { 'Retry-After': { schema: { type: 'integer' }, required: true } } },
      '5XX': { description: 'down', headers: { 'X-Request-Id': { schema: { type: 'string' } } } },
    });

    expect(op.defaultResponse).toEqual({
      headers: [{ name: 'Retry-After', type: int, required: true }],
      description: 'err',
    });
    expect(op.rangeResponses).toEqual([
      { range: '5XX', headers: [{ name: 'X-Request-Id', type: str, required: false }], description: 'down' },
    ]);
    expect(collectResponseHeaders(op).map((h) => h.name)).toEqual(['ETag', 'Retry-After', 'X-Request-Id']);
  });

  it('materializes an object-shaped header under the response label when the bare name is taken', () => {
    const { op, inlineModels } = extractPets({
      '200': {
        description: 'ok',
        headers: { 'X-Meta': { schema: { type: 'object', properties: { a: { type: 'string' } } } } },
      },
      default: {
        description: 'err',
        headers: { 'X-Meta': { schema: { type: 'object', properties: { b: { type: 'integer' } } } } },
      },
      '4XX': {
        description: 'rejected',
        headers: { 'X-Meta': { schema: { type: 'object', properties: { c: { type: 'boolean' } } } } },
      },
    });

    expect(op.responseHeaders?.[0].type).toEqual(model('PetsXMeta'));
    expect(op.defaultResponse?.headers?.[0].type).toEqual(model('PetsXMetaDefault'));
    expect(op.rangeResponses?.[0].headers?.[0].type).toEqual(model('PetsXMetaClientError'));
    expect(inlineModels.map((m) => m.name).sort()).toEqual(['PetsXMeta', 'PetsXMetaClientError', 'PetsXMetaDefault']);
  });

  it('promotes an inline header enum, qualified by the response label when a 200 header of the same name differs', () => {
    const policy = (values: string[]) => ({ schema: { type: 'string', enum: values } });
    const { services } = extractOperations({
      '/pets': {
        get: {
          operationId: 'listPets',
          responses: {
            '200': { description: 'ok', headers: { 'X-Policy': policy(['fast', 'slow']) } },
            default: { description: 'err', headers: { 'X-Policy': policy(['retry', 'stop']) } },
            '5XX': { description: 'down', headers: { 'X-Policy': policy(['wait', 'later']) } },
          },
        },
      },
    } as never);
    const enums: Enum[] = [];
    collectInlineEnumsFromOperations(services, enums);
    const op = services[0].operations[0];

    expect(op.defaultResponse?.headers?.[0].type).toEqual({
      kind: 'enum',
      name: 'PetsXPolicyDefault',
      values: ['retry', 'stop'],
    });
    expect(op.rangeResponses?.[0].headers?.[0].type).toEqual({
      kind: 'enum',
      name: 'PetsXPolicyServerError',
      values: ['wait', 'later'],
    });
    expect(enums.map((e) => e.name).sort()).toEqual(['PetsXPolicy', 'PetsXPolicyDefault', 'PetsXPolicyServerError']);
  });
});

describe('fallback response bodies reach every pass', () => {
  const spec = petsSpec({
    '200': { description: 'ok', content: { 'text/plain': { schema: { type: 'string' } } } },
    default: { description: 'err', content: json({ $ref: '#/components/schemas/Error' }) },
    '5XX': { description: 'down', content: json({ type: 'object', properties: { code: { type: 'string' } } }) },
  });

  it('validateModelRefs resolves them, and reports a dangling one with its context', async () => {
    const ir = await parseWithoutWarnings(spec);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    validateModelRefs(ir);
    expect(warn).not.toHaveBeenCalled();

    const op = only(ir);
    op.defaultResponse!.type = model('Missing');
    op.rangeResponses![0].type = model('AlsoMissing');
    validateModelRefs(ir);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unresolved model reference "Missing" (context: Pets.listPets.defaultResponse)'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unresolved model reference "AlsoMissing" (context: Pets.listPets.rangeResponses.5XX)'),
    );
  });

  it('assigns a model reached only through a fallback response to that service', async () => {
    const ir = await parseWithoutWarnings(spec);
    const assigned = assignModelsToServices(ir.models, ir.services);

    expect(assigned.get('Error')).toBe('Pets');
    expect(assigned.get('ListPetsError5Xx')).toBe('Pets');
    expect(assigned.get('Pet')).toBeUndefined();
  });
});

describe('every body shape a field can take is materialized, for default and for a range', () => {
  const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties });
  const code = obj({ code: { type: 'string' } });
  const reason = obj({ reason: { type: 'string' } });

  type Shape = {
    label: string;
    schema: unknown;
    /** The body's type, given the name the body is materialized under. */
    type: (name: string) => TypeRef;
    /** Every model the body materializes, given that name. */
    models: (name: string) => string[];
  };
  const shapes: Shape[] = [
    { label: 'an object', schema: code, type: model, models: (n) => [n] },
    {
      label: 'a nullable object (type array)',
      schema: { type: ['object', 'null'], properties: { code: { type: 'string' } } },
      type: (n) => ({ kind: 'nullable', inner: model(n) }),
      models: (n) => [n],
    },
    {
      label: 'a oneOf with a null variant',
      schema: { oneOf: [code, { type: 'null' }] },
      type: (n) => ({ kind: 'nullable', inner: model(n) }),
      models: (n) => [n],
    },
    {
      label: 'a oneOf of inline objects',
      schema: { oneOf: [code, reason] },
      type: (n) => ({ kind: 'union', variants: [model(n), model(`${n}WithReason`)], compositionKind: 'oneOf' }),
      models: (n) => [n, `${n}WithReason`],
    },
    {
      label: 'an anyOf of inline objects',
      schema: { anyOf: [code, reason] },
      type: (n) => ({ kind: 'union', variants: [model(n), model(`${n}WithReason`)], compositionKind: 'anyOf' }),
      models: (n) => [n, `${n}WithReason`],
    },
    {
      label: 'a map of objects',
      schema: { type: 'object', additionalProperties: code },
      type: (n) => ({ kind: 'map', valueType: model(n) }),
      models: (n) => [n],
    },
    {
      label: 'an array of objects',
      schema: { type: 'array', items: code },
      type: (n) => ({ kind: 'array', items: model(n) }),
      models: (n) => [n],
    },
    {
      label: 'a nullable array of objects',
      schema: { type: ['array', 'null'], items: code },
      type: (n) => ({ kind: 'nullable', inner: { kind: 'array', items: model(n) } }),
      models: (n) => [n],
    },
    {
      label: 'nested objects',
      schema: obj({ detail: obj({ field: { type: 'string' } }) }),
      type: model,
      models: (n) => [n, `${n}Detail`],
    },
    {
      label: 'an allOf merge of a $ref and an inline object',
      schema: { allOf: [{ $ref: '#/components/schemas/Error' }, code] },
      type: model,
      models: (n) => [n],
    },
  ];
  const keys: Array<[key: string, name: string, pick: (op: Operation) => TypeRef | undefined]> = [
    ['default', 'ListPetsDefaultResponse', (op) => op.defaultResponse?.type],
    ['4XX', 'ListPetsError4Xx', (op) => op.rangeResponses?.[0].type],
  ];

  for (const [key, name, pick] of keys) {
    it.each(shapes)(`${key}: $label`, async ({ schema, type, models }) => {
      const ir = await parseWithoutWarnings(
        petsSpec({ '200': ok, [key]: { description: 'r', content: json(schema) } }),
      );

      expect(pick(only(ir))).toEqual(type(name));
      expect(ir.models.map((m) => m.name).sort()).toEqual(['Error', 'Pet', ...models(name)].sort());
      expectConsistent(ir);
    });
  }
});

describe('fallback body enums reach spec.enums', () => {
  const enumOf = (ir: ApiSpec, name: string) => ir.enums.find((e) => e.name === name)?.values.map((v) => v.value);

  it('promotes a body that is itself an inline enum, for default and for a range', async () => {
    const ir = await parseWithoutWarnings(
      petsSpec({
        '200': ok,
        default: { description: 'd', content: json({ type: 'string', enum: ['retry', 'stop'] }) },
        '5XX': { description: 's', content: json({ type: 'string', enum: ['wait', 'later'] }) },
      }),
    );
    const op = only(ir);

    expect(op.defaultResponse?.type).toEqual({
      kind: 'enum',
      name: 'ListPetsDefaultResponse',
      values: ['retry', 'stop'],
    });
    expect(op.rangeResponses?.[0].type).toEqual({
      kind: 'enum',
      name: 'ListPetsError5Xx',
      values: ['wait', 'later'],
    });
    expect(enumOf(ir, 'ListPetsDefaultResponse')).toEqual(['retry', 'stop']);
    expect(enumOf(ir, 'ListPetsError5Xx')).toEqual(['wait', 'later']);
  });

  it('promotes the items enum of an array body', async () => {
    const ir = await parseWithoutWarnings(
      petsSpec({
        '200': ok,
        default: {
          description: 'd',
          content: json({ type: 'array', items: { type: 'string', enum: ['retry', 'stop'] } }),
        },
      }),
    );

    expect(only(ir).defaultResponse?.type).toEqual({
      kind: 'array',
      items: { kind: 'enum', name: 'ListPetsDefaultResponse', values: ['retry', 'stop'] },
    });
    expect(enumOf(ir, 'ListPetsDefaultResponse')).toEqual(['retry', 'stop']);
  });

  it('promotes an enum field nested in an inline body model', async () => {
    const ir = await parseWithoutWarnings(
      petsSpec({
        '200': ok,
        default: {
          description: 'd',
          content: json({ type: 'object', properties: { status: { type: 'string', enum: ['open', 'closed'] } } }),
        },
      }),
    );

    expect(fieldTypesByModel(ir.models)['ListPetsDefaultResponse']).toEqual({
      status: { kind: 'enum', name: 'ListPetsDefaultResponseStatus', values: ['open', 'closed'] },
    });
    expect(enumOf(ir, 'ListPetsDefaultResponseStatus')).toEqual(['open', 'closed']);
  });

  it('numbers a field enum of an inline body model whose name a component enum with other values owns', async () => {
    const spec = petsSpec({
      '200': ok,
      default: {
        description: 'd',
        content: json({ type: 'object', properties: { status: { type: 'string', enum: ['c', 'd'] } } }),
      },
    }) as { components: { schemas: Record<string, unknown> } };
    spec.components.schemas['ListPetsDefaultResponseStatus'] = { type: 'string', enum: ['a', 'b'] };
    const ir = await parseWithoutWarnings(spec);

    // The component enum keeps its name and values; the field's enum is
    // promoted beside it under a distinct name, not folded into it.
    expect(fieldTypesByModel(ir.models)['ListPetsDefaultResponse']).toEqual({
      status: { kind: 'enum', name: 'ListPetsDefaultResponseStatus2', values: ['c', 'd'] },
    });
    expect(enumOf(ir, 'ListPetsDefaultResponseStatus')).toEqual(['a', 'b']);
    expect(enumOf(ir, 'ListPetsDefaultResponseStatus2')).toEqual(['c', 'd']);
  });

  it('numbers a body enum whose name a component enum with other values owns, and shares one with the same values', async () => {
    const components = { ListPetsDefaultResponse: { type: 'string', enum: ['a', 'b'] } };
    const withSchemas = (responses: Record<string, unknown>) => {
      const spec = petsSpec(responses) as { components: { schemas: Record<string, unknown> } };
      Object.assign(spec.components.schemas, components);
      return spec;
    };

    const clash = await parseWithoutWarnings(
      withSchemas({
        '200': ok,
        default: { description: 'd', content: json({ type: 'string', enum: ['retry', 'stop'] }) },
      }),
    );
    expect(only(clash).defaultResponse?.type).toEqual({
      kind: 'enum',
      name: 'ListPetsDefaultResponse2',
      values: ['retry', 'stop'],
    });
    expect(enumOf(clash, 'ListPetsDefaultResponse')).toEqual(['a', 'b']);
    expect(enumOf(clash, 'ListPetsDefaultResponse2')).toEqual(['retry', 'stop']);

    const shared = await parseWithoutWarnings(
      withSchemas({ '200': ok, default: { description: 'd', content: json({ type: 'string', enum: ['a', 'b'] }) } }),
    );
    expect(only(shared).defaultResponse?.type).toEqual({
      kind: 'enum',
      name: 'ListPetsDefaultResponse',
      values: ['a', 'b'],
    });
    expect(shared.enums.map((e) => e.name)).toEqual(['ListPetsDefaultResponse']);
  });
});

describe('a fallback body never overwrites a model that owns its name', () => {
  const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties });
  const withComponent = (name: string, schema: unknown, responses: Record<string, unknown>) => {
    const spec = petsSpec(responses) as { components: { schemas: Record<string, unknown> } };
    spec.components.schemas[name] = schema;
    return spec;
  };

  it('moves the body, its nested models and its ref to the next free name when a component of another shape owns it', async () => {
    const ir = await parseWithoutWarnings(
      withComponent('ListPetsDefaultResponse', obj({ message: str }), {
        '200': ok,
        default: {
          description: 'd',
          content: json(obj({ message: str, code: str, detail: obj({ field: { type: 'string' } }) })),
        },
      }),
    );
    const types = fieldTypesByModel(ir.models);

    // The component is exactly what it was.
    expect(types['ListPetsDefaultResponse']).toEqual({ message: str });
    expect(only(ir).defaultResponse).toEqual({
      type: model('ListPetsDefaultResponse2'),
      ...jsonBody(model('ListPetsDefaultResponse2')),
      description: 'd',
    });
    expect(types['ListPetsDefaultResponse2']).toEqual({
      message: str,
      code: str,
      detail: model('ListPetsDefaultResponse2Detail'),
    });
    expect(types['ListPetsDefaultResponse2Detail']).toEqual({ field: str });
    expectConsistent(ir, ['Pet', 'Error', 'ListPetsDefaultResponse']);
  });

  it('shares the name with a component of the same shape and materializes nothing new', async () => {
    const ir = await parseWithoutWarnings(
      withComponent('ListPetsDefaultResponse', obj({ message: str }), {
        '200': ok,
        default: { description: 'd', content: json(obj({ message: str })) },
      }),
    );

    expect(only(ir).defaultResponse).toEqual({
      type: model('ListPetsDefaultResponse'),
      ...jsonBody(model('ListPetsDefaultResponse')),
      description: 'd',
    });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Error', 'ListPetsDefaultResponse', 'Pet']);
    expectConsistent(ir);
  });

  it('does the same for a range body', async () => {
    const ir = await parseWithoutWarnings(
      withComponent('ListPetsError4Xx', obj({ message: str }), {
        '200': ok,
        '4XX': { description: 'r', content: json(obj({ code: str })) },
      }),
    );
    const types = fieldTypesByModel(ir.models);

    expect(types['ListPetsError4Xx']).toEqual({ message: str });
    expect(only(ir).rangeResponses).toEqual([
      {
        range: '4XX',
        type: model('ListPetsError4XxBody'),
        ...jsonBody(model('ListPetsError4XxBody')),
        description: 'r',
      },
    ]);
    expect(types['ListPetsError4XxBody']).toEqual({ code: str });
    expectConsistent(ir, ['Pet', 'Error', 'ListPetsError4Xx']);
  });

  it('moves the whole body when only a nested model name is owned by a component', async () => {
    const ir = await parseWithoutWarnings(
      withComponent('ListPetsDefaultResponseDetail', obj({ other: str }), {
        '200': ok,
        default: { description: 'd', content: json(obj({ detail: obj({ field: { type: 'string' } }) })) },
      }),
    );
    const types = fieldTypesByModel(ir.models);

    expect(types['ListPetsDefaultResponseDetail']).toEqual({ other: str });
    expect(only(ir).defaultResponse).toEqual({
      type: model('ListPetsDefaultResponse2'),
      ...jsonBody(model('ListPetsDefaultResponse2')),
      description: 'd',
    });
    expect(types['ListPetsDefaultResponse2']).toEqual({ detail: model('ListPetsDefaultResponse2Detail') });
    expectConsistent(ir, ['Pet', 'Error', 'ListPetsDefaultResponseDetail']);
  });
});

describe('names no stem can move (titled variants) terminate and step around their owner', () => {
  // Each case used to make the parser loop forever: a variant named from its
  // own `title` keeps that name under every retry of the body's stem, so a
  // clash with a differently shaped owner never cleared. Every test runs
  // under the default vitest timeout, which is the regression guard.
  const HANG_GUARD_MS = 5_000;
  const num: TypeRef = { kind: 'primitive', type: 'number' };
  const titled = (title: string, kind: string, properties: Record<string, unknown>) => ({
    type: 'object',
    title,
    properties: { kind: { type: 'string', const: kind }, ...properties },
  });
  const shapes = {
    oneOf: [
      titled('Circle', 'circle', { diameter: { type: 'number' } }),
      titled('Square', 'square', { side: { type: 'number' } }),
    ],
  };
  const union = (circle: string): TypeRef => ({
    kind: 'union',
    variants: [model(circle), model('Square')],
    compositionKind: 'oneOf',
    discriminator: { property: 'kind', mapping: { circle, square: 'Square' } },
  });
  const withComponent = (name: string, schema: unknown, responses: Record<string, unknown>) => {
    const spec = petsSpec(responses) as { components: { schemas: Record<string, unknown> } };
    spec.components.schemas[name] = schema;
    return spec;
  };

  it(
    'a titled variant clashing with a differently shaped component takes its context-qualified name',
    async () => {
      const ir = await parseWithoutWarnings(
        withComponent(
          'Circle',
          { type: 'object', properties: { radius: { type: 'number' } } },
          {
            '200': ok,
            default: { description: 'd', content: json(shapes) },
          },
        ),
      );
      const types = fieldTypesByModel(ir.models);

      expect(only(ir).defaultResponse).toEqual({
        type: union('CircleListPetsDefaultResponse'),
        ...jsonBody(union('CircleListPetsDefaultResponse')),
        description: 'd',
      });
      expect(types['Circle']).toEqual({ radius: num });
      expect(types['CircleListPetsDefaultResponse']).toEqual({
        kind: { kind: 'literal', value: 'circle' },
        diameter: num,
      });
      expect(types['Square']).toEqual({ kind: { kind: 'literal', value: 'square' }, side: num });
      expectConsistent(ir, ['Pet', 'Error', 'Circle']);
    },
    HANG_GUARD_MS,
  );

  it(
    'a titled variant matching a component of the same shape shares it',
    async () => {
      const ir = await parseWithoutWarnings(
        withComponent('Circle', titled('Circle', 'circle', { diameter: { type: 'number' } }), {
          '200': ok,
          default: { description: 'd', content: json(shapes) },
        }),
      );

      expect(only(ir).defaultResponse).toEqual({
        type: union('Circle'),
        ...jsonBody(union('Circle')),
        description: 'd',
      });
      expect(ir.models.map((m) => m.name).sort()).toEqual(['Circle', 'Error', 'Pet', 'Square']);
    },
    HANG_GUARD_MS,
  );

  it(
    'a titled variant clashing with a model a component field mints (a map value) takes its context-qualified name',
    async () => {
      // `Report.details` mints `ReportDetail` from its map values, a model
      // `parseSpec` reads from the components' fields rather than from
      // `components/schemas` directly, so it must be reserved by name before
      // the fallback is named or the field merge would keep the fallback's
      // shape under the component's name.
      const ir = await parseWithoutWarnings(
        withComponent(
          'Report',
          {
            type: 'object',
            properties: {
              details: {
                type: 'object',
                additionalProperties: { type: 'object', properties: { reason: { type: 'string' } } },
              },
            },
          },
          {
            '200': ok,
            default: {
              description: 'd',
              content: json({
                oneOf: [
                  titled('ReportDetail', 'detail', { message: { type: 'string' } }),
                  titled('Other', 'other', { code: { type: 'number' } }),
                ],
              }),
            },
          },
        ),
      );
      const types = fieldTypesByModel(ir.models);

      const body: TypeRef = {
        kind: 'union',
        variants: [model('ReportDetailListPetsDefaultResponse'), model('Other')],
        compositionKind: 'oneOf',
        discriminator: {
          property: 'kind',
          mapping: { detail: 'ReportDetailListPetsDefaultResponse', other: 'Other' },
        },
      };
      expect(only(ir).defaultResponse).toEqual({ type: body, ...jsonBody(body), description: 'd' });
      expect(types['Report']).toEqual({ details: { kind: 'map', valueType: model('ReportDetail') } });
      expect(types['ReportDetail']).toEqual({ reason: str });
      expect(types['ReportDetailListPetsDefaultResponse']).toEqual({
        kind: { kind: 'literal', value: 'detail' },
        message: str,
      });
      expect(types['Other']).toEqual({ kind: { kind: 'literal', value: 'other' }, code: num });
      expectConsistent(ir, ['Pet', 'Error', 'Report']);
    },
    HANG_GUARD_MS,
  );

  it(
    "steps around a same-named variant of another operation's primary response, which keeps its name",
    async () => {
      const primary = {
        oneOf: [
          titled('Circle', 'circle', { radius: { type: 'number' } }),
          titled('Square', 'square', { side: { type: 'number' } }),
        ],
      };
      const spec = petsSpec({ '200': ok, default: { description: 'd', content: json(shapes) } }) as {
        paths: Record<string, unknown>;
      };
      spec.paths['/shapes'] = {
        get: { operationId: 'getShape', responses: { '200': { description: 'ok', content: json(primary) } } },
      };
      const ir = await parseWithoutWarnings(spec);
      const [getShape, listPets] = ir.services
        .flatMap((s) => s.operations)
        .sort((a, b) => a.name.localeCompare(b.name));
      const types = fieldTypesByModel(ir.models);

      expect(getShape.response).toEqual(union('Circle'));
      expect(listPets.defaultResponse).toEqual({
        type: union('CircleListPetsDefaultResponse'),
        ...jsonBody(union('CircleListPetsDefaultResponse')),
        description: 'd',
      });
      expect(types['Circle']).toEqual({ kind: { kind: 'literal', value: 'circle' }, radius: num });
      expect(types['CircleListPetsDefaultResponse']).toEqual({
        kind: { kind: 'literal', value: 'circle' },
        diameter: num,
      });
      expectConsistent(ir, ['Pet', 'Error']);
    },
    HANG_GUARD_MS,
  );

  it(
    "steps around a same-named variant of the same operation's primary response",
    async () => {
      const primary = {
        oneOf: [
          titled('Circle', 'circle', { radius: { type: 'number' } }),
          titled('Square', 'square', { side: { type: 'number' } }),
        ],
      };
      const ir = await parseWithoutWarnings(
        petsSpec({
          '200': { description: 'ok', content: json(primary) },
          default: { description: 'd', content: json(shapes) },
        }),
      );
      const op = only(ir);

      expect(op.response).toEqual(union('Circle'));
      expect(op.defaultResponse).toEqual({
        type: union('CircleListPetsDefaultResponse'),
        ...jsonBody(union('CircleListPetsDefaultResponse')),
        description: 'd',
      });
      expectConsistent(ir, ['Pet', 'Error']);
    },
    HANG_GUARD_MS,
  );

  it(
    'a titled variant nested below the top level, where no reservation reaches, is renamed under the root and its refs follow',
    async () => {
      const ir = await parseWithoutWarnings(
        withComponent(
          'Circle',
          { type: 'object', properties: { radius: { type: 'number' } } },
          {
            '200': ok,
            default: { description: 'd', content: json({ type: 'object', properties: { shape: shapes } }) },
          },
        ),
      );
      const types = fieldTypesByModel(ir.models);

      expect(only(ir).defaultResponse).toEqual({
        type: model('ListPetsDefaultResponse'),
        ...jsonBody(model('ListPetsDefaultResponse')),
        description: 'd',
      });
      expect(types['ListPetsDefaultResponse']).toEqual({ shape: union('ListPetsDefaultResponseCircle') });
      expect(types['ListPetsDefaultResponseCircle']).toEqual({
        kind: { kind: 'literal', value: 'circle' },
        diameter: num,
      });
      expect(types['Circle']).toEqual({ radius: num });
      expectConsistent(ir, ['Pet', 'Error', 'Circle']);
    },
    HANG_GUARD_MS,
  );

  it(
    "a renamed nested variant's inline enums follow it, away from a component enum of other values (Greptile)",
    async () => {
      const spec = withComponent(
        'Circle',
        { type: 'object', properties: { radius: { type: 'number' } } },
        {
          '200': ok,
          default: {
            description: 'd',
            content: json({
              type: 'object',
              properties: {
                shape: {
                  oneOf: [
                    titled('Circle', 'circle', { status: { type: 'string', enum: ['c', 'd'] } }),
                    titled('Square', 'square', { side: { type: 'number' } }),
                  ],
                },
              },
            }),
          },
        },
      ) as { components: { schemas: Record<string, unknown> } };
      spec.components.schemas['CircleStatus'] = { type: 'string', enum: ['a', 'b'] };
      const ir = await parseWithoutWarnings(spec);
      const types = fieldTypesByModel(ir.models);
      expect(types['ListPetsDefaultResponseCircle']).toMatchObject({
        status: { kind: 'enum', name: 'ListPetsDefaultResponseCircleStatus', values: ['c', 'd'] },
      });
      const values = (name: string) => ir.enums.find((e) => e.name === name)?.values.map((v) => v.value);
      expect(values('CircleStatus')).toEqual(['a', 'b']);
      expect(values('ListPetsDefaultResponseCircleStatus')).toEqual(['c', 'd']);
      expectConsistent(ir, ['Pet', 'Error', 'Circle']);
    },
    HANG_GUARD_MS,
  );

  it(
    "a fallback variant titled like a list envelope's companion steps around it (Greptile)",
    async () => {
      // `list_metadata` on the 200 becomes the companion `ListMetadata` once every
      // list operation is known; a fallback variant titled `ListMetadata` of another
      // shape must not take that name first and leave the merge to pick one.
      const ir = await parseWithoutWarnings(
        petsSpec(
          {
            '200': {
              description: 'ok',
              content: json({
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
                  list_metadata: { type: 'object', properties: { after: { type: 'string' } } },
                },
              }),
            },
            default: {
              description: 'd',
              content: json({
                oneOf: [
                  titled('ListMetadata', 'meta', { reason: { type: 'string' }, hint: { type: 'string' } }),
                  titled('Square', 'square', { side: { type: 'number' } }),
                ],
              }),
            },
          },
          afterParam,
        ),
      );
      const types = fieldTypesByModel(ir.models);
      expect(types['ListMetadata']).toEqual({ after: str });
      expect(only(ir).pagination?.envelopeFields?.[0]?.type).toEqual(model('ListMetadata'));
      const fallback = only(ir).defaultResponse?.type as { variants: TypeRef[] } | undefined;
      const variant = fallback!.variants[0];
      expect(variant).not.toEqual(model('ListMetadata'));
      expect(types[(variant as { name: string }).name]).toMatchObject({ reason: str, hint: str });
      expectConsistent(ir, ['Pet', 'Error']);
    },
    HANG_GUARD_MS,
  );

  it(
    'fails loudly when a nested clashing title and a $ref to the same component cannot be told apart',
    async () => {
      const body = { type: 'object', properties: { shape: shapes, original: { $ref: '#/components/schemas/Circle' } } };
      await expect(
        parseTempSpec(
          withComponent(
            'Circle',
            { type: 'object', properties: { radius: { type: 'number' } } },
            {
              '200': ok,
              default: { description: 'd', content: json(body) },
            },
          ),
        ),
      ).rejects.toThrow(
        'Inline schema "Circle" under ListPetsDefaultResponse has another shape than component "Circle"',
      );
    },
    HANG_GUARD_MS,
  );

  it(
    'a parent matching a component whose nested titled child differs moves with its child; the component keeps its own',
    async () => {
      // Renaming the child changes the parent's shape: it matched component
      // `ListPetsDefaultResponse` before and must not be dropped at commit as
      // "already defined", or the body would resolve to the component and so
      // to the component's `Circle{radius}` instead of the renamed `{diameter}`.
      const refShapes = {
        oneOf: [{ $ref: '#/components/schemas/Circle' }, { $ref: '#/components/schemas/Square' }],
        discriminator: {
          propertyName: 'kind',
          mapping: { circle: '#/components/schemas/Circle', square: '#/components/schemas/Square' },
        },
      };
      const spec = petsSpec({
        '200': ok,
        default: { description: 'd', content: json({ type: 'object', properties: { shape: shapes } }) },
      }) as { components: { schemas: Record<string, unknown> } };
      Object.assign(spec.components.schemas, {
        Circle: titled('Circle', 'circle', { radius: { type: 'number' } }),
        Square: titled('Square', 'square', { side: { type: 'number' } }),
        ListPetsDefaultResponse: { type: 'object', properties: { shape: refShapes } },
      });
      const ir = await parseWithoutWarnings(spec);
      const types = fieldTypesByModel(ir.models);

      expect(only(ir).defaultResponse).toEqual({
        type: model('ListPetsDefaultResponse2'),
        ...jsonBody(model('ListPetsDefaultResponse2')),
        description: 'd',
      });
      expect(types['ListPetsDefaultResponse2']).toEqual({ shape: union('ListPetsDefaultResponse2Circle') });
      expect(types['ListPetsDefaultResponse2Circle']).toEqual({
        kind: { kind: 'literal', value: 'circle' },
        diameter: num,
      });
      // The component and its own child are exactly what they were.
      expect(types['ListPetsDefaultResponse']).toEqual({ shape: union('Circle') });
      expect(types['Circle']).toEqual({ kind: { kind: 'literal', value: 'circle' }, radius: num });
      expect(ir.models.map((m) => m.name).sort()).toEqual([
        'Circle',
        'Error',
        'ListPetsDefaultResponse',
        'ListPetsDefaultResponse2',
        'ListPetsDefaultResponse2Circle',
        'Pet',
        'Square',
      ]);
      expectConsistent(ir, ['Pet', 'Error', 'ListPetsDefaultResponse']);
    },
    HANG_GUARD_MS,
  );

  it(
    'moving the parent keeps a child that matches an existing component shared, even one the body also $refs',
    async () => {
      // The reviewer's extension of the case above: `detail` is an inline
      // object identical to component `ListPetsDefaultResponseDetail`, which
      // `original` references. Moving the parent must not rename that child
      // (it is the component's, exactly as when nothing moves), or the
      // rewrite would trip over the reference and the parse would fail.
      const detail = { type: 'object', properties: { field: { type: 'string' } } };
      const refShapes = {
        oneOf: [{ $ref: '#/components/schemas/Circle' }, { $ref: '#/components/schemas/Square' }],
        discriminator: {
          propertyName: 'kind',
          mapping: { circle: '#/components/schemas/Circle', square: '#/components/schemas/Square' },
        },
      };
      const spec = petsSpec({
        '200': ok,
        default: {
          description: 'd',
          content: json({
            type: 'object',
            properties: {
              shape: shapes,
              detail,
              original: { $ref: '#/components/schemas/ListPetsDefaultResponseDetail' },
            },
          }),
        },
      }) as { components: { schemas: Record<string, unknown> } };
      Object.assign(spec.components.schemas, {
        Circle: titled('Circle', 'circle', { radius: { type: 'number' } }),
        Square: titled('Square', 'square', { side: { type: 'number' } }),
        ListPetsDefaultResponseDetail: detail,
        ListPetsDefaultResponse: {
          type: 'object',
          properties: {
            shape: refShapes,
            detail: { $ref: '#/components/schemas/ListPetsDefaultResponseDetail' },
            original: { $ref: '#/components/schemas/ListPetsDefaultResponseDetail' },
          },
        },
      });
      const ir = await parseWithoutWarnings(spec);
      const types = fieldTypesByModel(ir.models);

      expect(only(ir).defaultResponse).toEqual({
        type: model('ListPetsDefaultResponse2'),
        ...jsonBody(model('ListPetsDefaultResponse2')),
        description: 'd',
      });
      // Only the parent and the clashing child moved; the matching child is the component's.
      expect(types['ListPetsDefaultResponse2']).toEqual({
        shape: union('ListPetsDefaultResponse2Circle'),
        detail: model('ListPetsDefaultResponseDetail'),
        original: model('ListPetsDefaultResponseDetail'),
      });
      expect(types['ListPetsDefaultResponseDetail']).toEqual({ field: str });
      expect(types['ListPetsDefaultResponse']).toEqual({
        shape: union('Circle'),
        detail: model('ListPetsDefaultResponseDetail'),
        original: model('ListPetsDefaultResponseDetail'),
      });
      expect(ir.models.map((m) => m.name).sort()).toEqual([
        'Circle',
        'Error',
        'ListPetsDefaultResponse',
        'ListPetsDefaultResponse2',
        'ListPetsDefaultResponse2Circle',
        'ListPetsDefaultResponseDetail',
        'Pet',
        'Square',
      ]);
      expectConsistent(ir, ['Pet', 'Error', 'ListPetsDefaultResponse']);
    },
    HANG_GUARD_MS,
  );

  it(
    "keeps a nested child shared with an earlier operation's inline model while the clashing sibling moves",
    async () => {
      // `getShape`, first in the document, materializes `Square{kind,side}`
      // from its 200. The fallback's nested `Square` is the same shape and
      // shares it; its `Circle{diameter}` differs from `getShape`'s
      // `Circle{radius}` and is renamed; the root clashes with a component
      // of another shape and takes the next stem.
      const primary = {
        oneOf: [
          titled('Circle', 'circle', { radius: { type: 'number' } }),
          titled('Square', 'square', { side: { type: 'number' } }),
        ],
      };
      const spec = {
        openapi: '3.1.0',
        info,
        paths: {
          '/shapes': {
            get: { operationId: 'getShape', responses: { '200': { description: 'ok', content: json(primary) } } },
          },
          '/pets': {
            get: {
              operationId: 'listPets',
              responses: {
                '200': ok,
                default: { description: 'd', content: json({ type: 'object', properties: { shape: shapes } }) },
              },
            },
          },
        },
        components: {
          schemas: {
            Pet: petSchema,
            Error: errorSchema,
            ListPetsDefaultResponse: { type: 'object', properties: { x: { type: 'string' } } },
          },
        },
      };
      const ir = await parseWithoutWarnings(spec);
      const [getShape, listPets] = ir.services
        .flatMap((s) => s.operations)
        .sort((a, b) => a.name.localeCompare(b.name));
      const types = fieldTypesByModel(ir.models);

      expect(getShape.response).toEqual(union('Circle'));
      expect(listPets.defaultResponse).toEqual({
        type: model('ListPetsDefaultResponse2'),
        ...jsonBody(model('ListPetsDefaultResponse2')),
        description: 'd',
      });
      expect(types['ListPetsDefaultResponse2']).toEqual({ shape: union('ListPetsDefaultResponse2Circle') });
      expect(types['ListPetsDefaultResponse2Circle']).toEqual({
        kind: { kind: 'literal', value: 'circle' },
        diameter: num,
      });
      expect(types['Circle']).toEqual({ kind: { kind: 'literal', value: 'circle' }, radius: num });
      // One `Square`, owned by getShape, referenced from both operations.
      expect(ir.models.filter((m) => m.name === 'Square')).toHaveLength(1);
      expect(types['Square']).toEqual({ kind: { kind: 'literal', value: 'square' }, side: num });
      expectConsistent(ir, ['Pet', 'Error', 'ListPetsDefaultResponse']);
    },
    HANG_GUARD_MS,
  );
});

describe('a fallback written as a $ref into components/responses', () => {
  const problem = {
    description: 'A problem',
    headers: { 'Retry-After': { schema: { type: 'integer' } } },
    content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
  const withResponses = (responses: Record<string, unknown>, components: Record<string, unknown>) => {
    const spec = petsSpec(responses) as { components: Record<string, unknown> };
    spec.components['responses'] = components;
    return spec;
  };
  /** The lists the component's `application/problem+json` body carries, its entry sharing the body's type. */
  const problemBody = {
    contentTypes: ['application/problem+json'],
    contents: [{ contentType: 'application/problem+json', type: model('Error') }],
  };

  it('is resolved, body and headers alike, for default and for a range', async () => {
    const ir = await parseWithoutWarnings(
      withResponses(
        {
          '200': ok,
          default: { $ref: '#/components/responses/Problem' },
          '5XX': { $ref: '#/components/responses/Problem' },
        },
        { Problem: problem },
      ),
    );
    const op = only(ir);
    const retryAfter = [{ name: 'Retry-After', type: int, required: false }];

    // The component's own description comes through the resolved ref.
    expect(op.defaultResponse).toEqual({
      type: model('Error'),
      ...problemBody,
      headers: retryAfter,
      description: 'A problem',
    });
    expect(op.rangeResponses).toEqual([
      { range: '5XX', type: model('Error'), ...problemBody, headers: retryAfter, description: 'A problem' },
    ]);
  });

  it("materializes an inline body declared in the component response under the component's name (issue #301)", async () => {
    // Named after the component, as at an explicit status code, so every
    // operation that returns `Problem` — as `default`, in a range or at a
    // status code — shares the one `ProblemResponse`.
    const ir = await parseWithoutWarnings(
      withResponses(
        { '200': ok, default: { $ref: '#/components/responses/Problem' } },
        { Problem: { description: 'p', content: json({ type: 'object', properties: { code: { type: 'string' } } }) } },
      ),
    );

    expect(only(ir).defaultResponse).toEqual({
      type: model('ProblemResponse'),
      ...jsonBody(model('ProblemResponse')),
      description: 'p',
    });
    expect(fieldTypesByModel(ir.models)['ProblemResponse']).toEqual({ code: str });
    expect(ir.models.map((m) => m.name)).not.toContain('ListPetsDefaultResponse');
    expectConsistent(ir);
  });

  it('follows a chain of refs and an escaped JSON pointer', async () => {
    const ir = await parseWithoutWarnings(
      withResponses(
        {
          '200': ok,
          default: { $ref: '#/components/responses/Alias' },
          '4XX': { $ref: '#/components/responses/a~1b~0c' },
        },
        { Alias: { $ref: '#/components/responses/Problem' }, Problem: problem, 'a/b~c': problem },
      ),
    );
    const op = only(ir);

    expect(op.defaultResponse?.type).toEqual(model('Error'));
    expect(op.rangeResponses?.[0].type).toEqual(model('Error'));
  });

  it('warns on a ref no component response answers, naming the response, and reads it as written', () => {
    // As for an explicit status code (#241): a document that parsed before
    // response refs were resolved still parses; the entry has no body or headers.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { services } = extractOperations(
      {
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: { '200': ok, default: { $ref: '#/components/responses/Missing' } },
          },
        },
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
    );
    const op = services[0].operations[0];
    expect(op.defaultResponse).toBeDefined();
    expect(op.defaultResponse?.type).toBeUndefined();
    expect(op.defaultResponse?.headers).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unresolved response $ref "#/components/responses/Missing" in default response of listPets',
      ),
    );
    warn.mockRestore();
  });
});
