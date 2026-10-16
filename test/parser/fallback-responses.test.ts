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
const int: TypeRef = { kind: 'primitive', type: 'integer' };
const model = (name: string): TypeRef => ({ kind: 'model', name });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const errorSchema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
const petSchema = { type: 'object', properties: { name: { type: 'string' } } };
const ok = { description: 'ok', content: json({ $ref: '#/components/schemas/Pet' }) };

/** A `GET /pets` (`listPets`) document with the given responses and the `Pet` and `Error` components. */
function petsSpec(responses: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info,
    paths: { '/pets': { get: { operationId: 'listPets', responses } } },
    components: { schemas: { Pet: petSchema, Error: errorSchema } },
  };
}

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
    expect(op.errors).toEqual([{ statusCode: 404, type: model('Error') }]);
    expect(op.defaultResponse).toEqual({ type: model('Error') });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Error', 'GetPetResponse']);
    expectConsistent(ir, []);
  });

  it('is present without a type when the response declares no content', async () => {
    const op = only(await parseWithoutWarnings(petsSpec({ '200': ok, default: { description: 'Unexpected' } })));

    expect(Object.keys(op)).toContain('defaultResponse');
    expect(op.defaultResponse).toEqual({});
    expect(op.errors).toEqual([]);
  });

  it('is never promoted to the primary response when the operation declares no 2xx', async () => {
    const op = only(
      await parseWithoutWarnings(
        petsSpec({ default: { description: 'err', content: json({ $ref: '#/components/schemas/Error' }) } }),
      ),
    );

    expect(op.response).toEqual(str);
    expect(op.successResponses).toBeUndefined();
    expect(op.errors).toEqual([]);
    expect(op.defaultResponse).toEqual({ type: model('Error') });
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

    expect(op.defaultResponse).toEqual({ type: model('ListPetsDefaultResponse') });
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

  it('materializes inline array items as <Op>DefaultItem', async () => {
    const ir = await parseWithoutWarnings(
      petsSpec({
        '200': ok,
        default: {
          description: 'errs',
          content: json({ type: 'array', items: { type: 'object', properties: { code: { type: 'string' } } } }),
        },
      }),
    );

    expect(only(ir).defaultResponse).toEqual({ type: { kind: 'array', items: model('ListPetsDefaultItem') } });
    expect(fieldTypesByModel(ir.models)['ListPetsDefaultItem']).toEqual({ code: str });
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
    expect(op.defaultResponse).toEqual({ type: model(primary.replace(/Response$/, 'DefaultResponse')) });
    expectConsistent(ir, []);
  });

  it('reads a +json media type when application/json is absent, ignoring media type parameters', async () => {
    const problem = { 'application/problem+json; charset=utf-8': { schema: { $ref: '#/components/schemas/Error' } } };
    const op = only(
      await parseWithoutWarnings(petsSpec({ '200': ok, default: { description: 'err', content: problem } })),
    );

    expect(op.defaultResponse).toEqual({ type: model('Error') });
  });

  it('prefers application/json over a +json media type', async () => {
    const content = {
      'application/problem+json': { schema: { type: 'object', properties: { title: { type: 'string' } } } },
      'application/json': { schema: { $ref: '#/components/schemas/Error' } },
    };
    const op = only(await parseWithoutWarnings(petsSpec({ '200': ok, default: { description: 'err', content } })));

    expect(op.defaultResponse).toEqual({ type: model('Error') });
  });

  it('has no type for a non-JSON body, as errors do', async () => {
    const content = { 'text/plain': { schema: { type: 'string' } } };
    const op = only(await parseWithoutWarnings(petsSpec({ '200': ok, default: { description: 'err', content } })));

    expect(op.defaultResponse).toEqual({});
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
      { range: '5XX', type: model('Error') },
      { range: '2XX' },
      { range: '4XX', type: model('ListPetsClientErrorResponse') },
      { range: '1XX' },
      { range: '3XX' },
    ]);
    // A range never stands in for a status code: the explicit lists are untouched.
    expect(op.response).toEqual(model('Pet'));
    expect(op.successResponses).toBeUndefined();
    expect(op.errors).toEqual([]);
    expect(collectFallbackResponseTypes(op)).toEqual([model('Error'), model('ListPetsClientErrorResponse')]);
    expectConsistent(ir);
  });

  it('does not promote a 2XX range to the primary response', async () => {
    const op = only(await parseWithoutWarnings(petsSpec({ '2XX': ok })));

    expect(op.response).toEqual(str);
    expect(op.rangeResponses).toEqual([{ range: '2XX', type: model('Pet') }]);
  });

  it.each([
    ['1XX', 'ListPetsInformationalResponse'],
    ['2XX', 'ListPetsSuccessResponse'],
    ['3XX', 'ListPetsRedirectResponse'],
    ['4XX', 'ListPetsClientErrorResponse'],
    ['5XX', 'ListPetsServerErrorResponse'],
  ])('names the inline body of a %s response %s', async (range, name) => {
    const ir = await parseWithoutWarnings(
      petsSpec({
        '200': ok,
        [range]: { description: 'r', content: json({ type: 'object', properties: { code: { type: 'string' } } }) },
      }),
    );

    expect(only(ir).rangeResponses).toEqual([{ range, type: model(name) }]);
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

    expect(op.rangeResponses).toEqual([{ range: '4XX', type: model('Error') }]);
  });

  it('keeps the first of a duplicate range and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { op } = extractPets({
      '200': ok,
      '4XX': { description: 'first', content: json({ $ref: '#/components/schemas/Error' }) },
      '4xx': { description: 'second' },
    });

    expect(op.rangeResponses).toEqual([{ range: '4XX', type: model('Error') }]);
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

    expect(op.errors).toEqual([{ statusCode: 404, type: model('Error') }]);
    expect(op.rangeResponses).toEqual([{ range: '4XX', type: model('Error') }]);
    expect(op.defaultResponse).toEqual({});
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
});

describe('headers on fallback responses', () => {
  it('keeps them, typed, and collectResponseHeaders yields them after the explicit lists', () => {
    const { op } = extractPets({
      '200': { description: 'ok', headers: { ETag: { schema: { type: 'string' } } } },
      default: { description: 'err', headers: { 'Retry-After': { schema: { type: 'integer' }, required: true } } },
      '5XX': { description: 'down', headers: { 'X-Request-Id': { schema: { type: 'string' } } } },
    });

    expect(op.defaultResponse).toEqual({ headers: [{ name: 'Retry-After', type: int, required: true }] });
    expect(op.rangeResponses).toEqual([
      { range: '5XX', headers: [{ name: 'X-Request-Id', type: str, required: false }] },
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
    expect(assigned.get('ListPetsServerErrorResponse')).toBe('Pets');
    expect(assigned.get('Pet')).toBeUndefined();
  });
});
