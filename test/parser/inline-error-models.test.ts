import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
import { assignModelsToServices, collectEnumRefs, collectModelRefs } from '../../src/ir/types.js';
import { specDerivedNames } from '../../src/compat/spec-filter.js';
import { nodeHints } from '../../src/compat/language-hints.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Model, Operation } from '../../src/ir/types.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

// workos/oagen#236: an inline error body was typed with `schemaToTypeRef`
// alone, which named a model (`Error404`) that nothing created, and no walker
// looked at `errors[].type`, so nothing warned. The body is now materialized
// under an operation-qualified name, and every pass that walks an operation's
// type refs reaches it.

type Doc = Record<string, unknown>;

const str: SchemaObject = { type: 'string' };
const num: SchemaObject = { type: 'number' };
const int: SchemaObject = { type: 'integer' };
const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
  type: 'object',
  properties,
  ...extra,
});
const json = (schema: SchemaObject) => ({ content: { 'application/json': { schema } } });
const petRef: SchemaObject = { $ref: '#/components/schemas/Pet' };
const ok = { '200': { description: 'The pet', ...json(petRef) } };
const petComponent = { Pet: obj({ name: str }, { required: ['name'] }) };

const model = (name: string) => ({ kind: 'model', name });
const primitive = (type: string) => ({ kind: 'primitive', type });

function doc(paths: Doc, schemas: Record<string, SchemaObject> = {}): Doc {
  return {
    openapi: '3.1.0',
    info: { title: 'inline error bodies', version: '1' },
    paths,
    components: { schemas: { ...petComponent, ...schemas } },
  };
}

/** `GET /pets/{petId}` (`getPet`) returning `Pet`, with the given error responses. */
function getPet(errors: Doc, operation: Doc = {}): Doc {
  return {
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: str }],
        responses: { ...ok, ...errors },
        ...operation,
      },
    },
  };
}

async function parseTempSpec(spec: Doc): Promise<ApiSpec> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-inline-error-models-'));
  const specFile = path.join(tmpDir, 'spec.json');
  try {
    await fs.writeFile(specFile, JSON.stringify(spec), 'utf-8');
    return await parseSpec(specFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
}

async function parseWithoutWarnings(spec: Doc): Promise<ApiSpec> {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parseTempSpec(spec);
    expect(warnSpy.mock.calls).toEqual([]);
    return ir;
  } finally {
    warnSpy.mockRestore();
  }
}

const operationsOf = (ir: ApiSpec): Operation[] => ir.services.flatMap((s) => s.operations);
const onlyOperation = (ir: ApiSpec): Operation => {
  const operations = operationsOf(ir);
  expect(operations).toHaveLength(1);
  return operations[0];
};
const modelNames = (ir: ApiSpec): string[] => ir.models.map((m) => m.name);
const enumNames = (ir: ApiSpec): string[] => ir.enums.map((e) => e.name);
const fieldTypes = (ir: ApiSpec, name: string): Record<string, unknown> | undefined => {
  const found = ir.models.find((m) => m.name === name);
  return found && Object.fromEntries(found.fields.map((f) => [f.name, f.type]));
};

/** Every model or enum name referenced from any model field or any operation's types, errors included. */
function referencedEverywhere(ir: ApiSpec): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if ((record['kind'] === 'model' || record['kind'] === 'enum') && typeof record['name'] === 'string') {
        names.add(record['name']);
      }
      Object.values(record).forEach(visit);
    }
  };
  for (const m of ir.models) visit(m.fields);
  for (const op of operationsOf(ir)) {
    visit([
      op.requestBody,
      op.response,
      op.responseHeaders,
      op.successResponses,
      op.errors,
      op.pagination?.envelopeFields,
      op.pathParams,
      op.queryParams,
      op.headerParams,
    ]);
  }
  return names;
}

/**
 * Every reference resolves to a model or enum, every model other than `roots`
 * is referenced from somewhere, and in particular every `{ kind: 'model' }`
 * reachable from any operation's `errors` names a model in `spec.models`.
 */
function expectConsistent(ir: ApiSpec, roots: string[] = []): void {
  const referenced = referencedEverywhere(ir);
  const known = new Set([...modelNames(ir), ...enumNames(ir)]);
  expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
  expect(modelNames(ir).filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
  for (const op of operationsOf(ir)) {
    for (const error of op.errors) {
      if (!error.type) continue;
      const names = [...collectModelRefs(error.type), ...collectEnumRefs(error.type)];
      expect(names.filter((name) => !known.has(name))).toEqual([]);
    }
  }
}

describe("the issue's repro: an inline 404 body gets a model (#236)", () => {
  const repro: Doc = {
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'The pet',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
            },
            '404': {
              description: 'No such pet',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    },
  };

  it('creates GetPetError404 with the body fields, referenced from errors[].type, with no warning', async () => {
    const ir = await parseWithoutWarnings(repro);
    const op = onlyOperation(ir);

    expect(modelNames(ir)).toEqual(['Pet', 'GetPetError404']);
    expect(op.errors).toEqual([{ statusCode: 404, description: 'No such pet', type: model('GetPetError404') }]);
    expect(ir.models.find((m) => m.name === 'GetPetError404')).toMatchInlineSnapshot(`
      {
        "description": undefined,
        "fields": [
          {
            "default": undefined,
            "deprecated": undefined,
            "description": undefined,
            "example": undefined,
            "name": "reason",
            "readOnly": undefined,
            "required": true,
            "type": {
              "kind": "primitive",
              "type": "string",
            },
            "writeOnly": undefined,
          },
        ],
        "name": "GetPetError404",
      }
    `);
    expectConsistent(ir);
  });

  it('a `$ref` body stays a plain reference and mints nothing', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPet({ '404': { description: 'nf', ...json({ $ref: '#/components/schemas/Problem' }) } }), {
        Problem: obj({ title: str }),
      }),
    );
    expect(onlyOperation(ir).errors).toEqual([{ statusCode: 404, description: 'nf', type: model('Problem') }]);
    expect(modelNames(ir)).toEqual(['Pet', 'Problem']);
    expectConsistent(ir);
  });

  it('a primitive body stays primitive and mints nothing', async () => {
    const ir = await parseWithoutWarnings(doc(getPet({ '404': { description: 'nf', ...json(str) } })));
    expect(onlyOperation(ir).errors).toEqual([{ statusCode: 404, description: 'nf', type: primitive('string') }]);
    expect(modelNames(ir)).toEqual(['Pet']);
  });

  it('an error without a JSON body keeps no type; a `default` body is a fallback, never an error', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet({
          '404': { description: 'nf' },
          default: { description: 'anything', ...json(obj({ reason: str })) },
        }),
      ),
    );
    const op = onlyOperation(ir);
    expect(op.errors).toEqual([{ statusCode: 404, description: 'nf' }]);
    // The `default` body is read by the fallback path under `<Op>DefaultResponse`, not as an `<Op>Error<code>`.
    expect(op.defaultResponse?.type).toEqual(model('GetPetDefaultResponse'));
    expect(modelNames(ir)).toEqual(['Pet', 'GetPetDefaultResponse']);
  });
});

describe('every inline body shape is materialized under the name its TypeRef references', () => {
  it('array of inline objects: the item model', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet({ '400': { description: 'bad', ...json({ type: 'array', items: obj({ field: str, message: str }) }) } }),
      ),
    );
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 400, description: 'bad', type: { kind: 'array', items: model('GetPetError400') } },
    ]);
    expect(fieldTypes(ir, 'GetPetError400')).toEqual({ field: primitive('string'), message: primitive('string') });
    expectConsistent(ir);
  });

  it('oneOf with inline variants and a `$ref` variant: one model per inline variant, named as the union names them', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet({
          '400': {
            description: 'bad',
            ...json({ oneOf: [obj({ message: str }), obj({ message: str, code: int }), petRef] }),
          },
        }),
      ),
    );
    expect(onlyOperation(ir).errors).toEqual([
      {
        statusCode: 400,
        description: 'bad',
        type: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model('GetPetError400'), model('GetPetError400WithCode'), model('Pet')],
        },
      },
    ]);
    expect(modelNames(ir)).toEqual(['Pet', 'GetPetError400', 'GetPetError400WithCode']);
    expect(fieldTypes(ir, 'GetPetError400WithCode')).toEqual({
      message: primitive('string'),
      code: primitive('integer'),
    });
    expectConsistent(ir);
  });

  it('oneOf with const-discriminated inline variants: const-prefixed models and a mapping onto them', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet({
          '400': {
            description: 'bad',
            ...json({
              oneOf: [
                obj({ kind: { type: 'string', const: 'validation' }, field: str }),
                obj({ kind: { type: 'string', const: 'auth' }, realm: str }),
              ],
            }),
          },
        }),
      ),
    );
    expect(onlyOperation(ir).errors[0].type).toEqual({
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [model('GetPetError400'), model('AuthGetPetError400')],
      discriminator: { property: 'kind', mapping: { validation: 'GetPetError400', auth: 'AuthGetPetError400' } },
    });
    expect(fieldTypes(ir, 'AuthGetPetError400')).toEqual({
      kind: { kind: 'literal', value: 'auth' },
      realm: primitive('string'),
    });
    expectConsistent(ir);
  });

  it('anyOf with inline variants', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet({
          '400': { description: 'bad', ...json({ anyOf: [obj({ message: str }), obj({ message: str, error: str })] }) },
        }),
      ),
    );
    expect(onlyOperation(ir).errors[0].type).toEqual({
      kind: 'union',
      compositionKind: 'anyOf',
      variants: [model('GetPetError400'), model('GetPetError400WithError')],
    });
    expect(modelNames(ir)).toEqual(['Pet', 'GetPetError400', 'GetPetError400WithError']);
    expectConsistent(ir);
  });

  it('allOf with a `$ref` branch and an inline branch: one merged model, the component untouched', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet({
          '409': {
            description: 'conflict',
            ...json({ allOf: [{ $ref: '#/components/schemas/Problem' }, obj({ conflicting_id: str })] }),
          },
        }),
        { Problem: obj({ title: str, status: int }) },
      ),
    );
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 409, description: 'conflict', type: model('GetPetError409') },
    ]);
    expect(fieldTypes(ir, 'GetPetError409')).toEqual({
      title: primitive('string'),
      status: primitive('integer'),
      conflicting_id: primitive('string'),
    });
    expect(fieldTypes(ir, 'Problem')).toEqual({ title: primitive('string'), status: primitive('integer') });
    expectConsistent(ir, ['Problem']);
  });

  it('allOf with only `$ref` branches: a plain reference to the component', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPet({ '409': { description: 'c', ...json({ allOf: [{ $ref: '#/components/schemas/Problem' }] }) } }), {
        Problem: obj({ title: str }),
      }),
    );
    expect(onlyOperation(ir).errors).toEqual([{ statusCode: 409, description: 'c', type: model('Problem') }]);
    expect(modelNames(ir)).toEqual(['Pet', 'Problem']);
    expectConsistent(ir);
  });

  it('allOf with two inline branches: one merged model', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPet({ '409': { description: 'c', ...json({ allOf: [obj({ a: str }), obj({ b: str })] }) } })),
    );
    expect(onlyOperation(ir).errors).toEqual([{ statusCode: 409, description: 'c', type: model('GetPetError409') }]);
    expect(fieldTypes(ir, 'GetPetError409')).toEqual({ a: primitive('string'), b: primitive('string') });
    expectConsistent(ir);
  });

  it.each([
    ['type: [object, null]', { ...obj({ reason: str }), type: ['object', 'null'] } as SchemaObject],
    ['nullable: true (OAS 3.0)', { ...obj({ reason: str }), nullable: true } as SchemaObject],
    ['oneOf: [object, null]', { oneOf: [obj({ reason: str }), { type: 'null' }] } as SchemaObject],
  ])('nullable object (%s): a nullable reference to the one model', async (_label, schema) => {
    const ir = await parseWithoutWarnings(doc(getPet({ '404': { description: 'nf', ...json(schema) } })));
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 404, description: 'nf', type: { kind: 'nullable', inner: model('GetPetError404') } },
    ]);
    expect(fieldTypes(ir, 'GetPetError404')).toEqual({ reason: primitive('string') });
    expectConsistent(ir);
  });

  it('nested inline objects, array items and enums inside the body, qualified under the error name', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet({
          '422': {
            description: 'unprocessable',
            ...json(
              obj({
                message: str,
                severity: { type: 'string', enum: ['warning', 'fatal'] },
                details: obj({ field: str, location: obj({ line: int }) }),
                violations: {
                  type: 'array',
                  items: obj({ path: str, rule: { type: 'string', enum: ['required', 'format'] } }),
                },
              }),
            ),
          },
        }),
      ),
    );
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 422, description: 'unprocessable', type: model('GetPetError422') },
    ]);
    expect(modelNames(ir)).toEqual([
      'Pet',
      'GetPetError422',
      'GetPetError422Detail',
      'GetPetError422DetailLocation',
      'GetPetError422Violation',
    ]);
    expect(fieldTypes(ir, 'GetPetError422')).toEqual({
      message: primitive('string'),
      severity: { kind: 'enum', name: 'GetPetError422Severity', values: ['warning', 'fatal'] },
      details: model('GetPetError422Detail'),
      violations: { kind: 'array', items: model('GetPetError422Violation') },
    });
    expect(fieldTypes(ir, 'GetPetError422Detail')).toEqual({
      field: primitive('string'),
      location: model('GetPetError422DetailLocation'),
    });
    expect(enumNames(ir)).toEqual(['GetPetError422Severity', 'GetPetError422ViolationRule']);
    expectConsistent(ir);
  });

  it('a map of inline objects (`additionalProperties`): the value model', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet({
          '400': { description: 'bad', ...json({ type: 'object', additionalProperties: obj({ message: str }) }) },
        }),
      ),
    );
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 400, description: 'bad', type: { kind: 'map', valueType: model('GetPetError400') } },
    ]);
    expect(fieldTypes(ir, 'GetPetError400')).toEqual({ message: primitive('string') });
    expectConsistent(ir);
  });

  it('a body that is itself an inline enum, or an array of one, is promoted to spec.enums', async () => {
    const asEnum = await parseWithoutWarnings(
      doc(getPet({ '404': { description: 'nf', ...json({ type: 'string', enum: ['gone', 'never_existed'] }) } })),
    );
    expect(onlyOperation(asEnum).errors).toEqual([
      {
        statusCode: 404,
        description: 'nf',
        type: { kind: 'enum', name: 'GetPetError404', values: ['gone', 'never_existed'] },
      },
    ]);
    expect(asEnum.enums).toEqual([
      {
        name: 'GetPetError404',
        values: [
          { name: 'GONE', value: 'gone', description: undefined },
          { name: 'NEVER_EXISTED', value: 'never_existed', description: undefined },
        ],
      },
    ]);
    expectConsistent(asEnum);

    const asArray = await parseWithoutWarnings(
      doc(
        getPet({
          '404': { description: 'nf', ...json({ type: 'array', items: { type: 'string', enum: ['a', 'b'] } }) },
        }),
      ),
    );
    expect(onlyOperation(asArray).errors[0].type).toEqual({
      kind: 'array',
      items: { kind: 'enum', name: 'GetPetError404', values: ['a', 'b'] },
    });
    expect(enumNames(asArray)).toEqual(['GetPetError404']);
    expectConsistent(asArray);
  });

  it('a deep chain — object → array items → oneOf variants — materializes every level', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet({
          '400': {
            description: 'bad',
            ...json(
              obj({
                details: obj({
                  items: {
                    type: 'array',
                    items: obj({ shape: { oneOf: [obj({ radius: num }), obj({ side: num })] } }),
                  },
                }),
              }),
            ),
          },
        }),
      ),
    );
    expect(modelNames(ir)).toEqual([
      'Pet',
      'GetPetError400',
      'GetPetError400Detail',
      'GetPetError400DetailItem',
      'GetPetError400DetailItemShape',
      'GetPetError400DetailItemShapeWithSide',
    ]);
    expect(fieldTypes(ir, 'GetPetError400DetailItem')).toEqual({
      shape: {
        kind: 'union',
        compositionKind: 'oneOf',
        variants: [model('GetPetError400DetailItemShape'), model('GetPetError400DetailItemShapeWithSide')],
      },
    });
    expectConsistent(ir);
  });
});

describe('the name is operation-qualified: `<Op>Error<code>`', () => {
  it('follows the `<Op>Response` stem, operationId normalization included', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        '/pets/{petId}': {
          get: {
            // Overload index, backend prefix and `Controller` infix: all stripped the way they are for `Response`.
            operationId: 'userlandPetsControllerGet[0]',
            responses: {
              '200': { description: 'ok', ...json(obj({ a: str })) },
              '404': { description: 'nf', ...json(obj({ reason: str })) },
            },
          },
        },
      }),
    );
    const op = onlyOperation(ir);
    expect(op.response).toEqual(model('PetsGetResponse'));
    expect(op.errors).toEqual([{ statusCode: 404, description: 'nf', type: model('PetsGetError404') }]);
    expectConsistent(ir, ['Pet']);
  });

  it('an operationId-less operation uses its path-derived prefix, as its `Response` does', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        '/pets/{petId}': {
          get: {
            parameters: [{ name: 'petId', in: 'path', required: true, schema: str }],
            responses: {
              '200': { description: 'ok', ...json(obj({ a: str })) },
              '404': { description: 'nf', ...json(obj({ reason: str })) },
            },
          },
        },
      }),
    );
    const op = onlyOperation(ir);
    expect(op.response).toEqual(model('PetsByPetIdGetResponse'));
    expect(op.errors).toEqual([{ statusCode: 404, description: 'nf', type: model('PetsByPetIdGetError404') }]);
    expectConsistent(ir, ['Pet']);
  });

  it('two operations with identical inline 404 bodies get two models, one each', async () => {
    const notFound = { '404': { description: 'nf', ...json(obj({ reason: str })) } };
    const ir = await parseWithoutWarnings(
      doc({
        ...getPet(notFound),
        '/pets': { delete: { operationId: 'deletePets', responses: { '204': { description: 'gone' }, ...notFound } } },
      }),
    );
    const [get, del] = operationsOf(ir);
    expect(get.errors).toEqual([{ statusCode: 404, description: 'nf', type: model('GetPetError404') }]);
    expect(del.errors).toEqual([{ statusCode: 404, description: 'nf', type: model('DeletePetsError404') }]);
    expect(modelNames(ir)).toEqual(['Pet', 'GetPetError404', 'DeletePetsError404']);
    expect(fieldTypes(ir, 'DeletePetsError404')).toEqual(fieldTypes(ir, 'GetPetError404'));
    expectConsistent(ir);
  });

  it('two status codes on one operation get distinct models', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet({
          '404': { description: 'nf', ...json(obj({ reason: str })) },
          '409': { description: 'conflict', ...json(obj({ conflicting_id: str })) },
        }),
      ),
    );
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 404, description: 'nf', type: model('GetPetError404') },
      { statusCode: 409, description: 'conflict', type: model('GetPetError409') },
    ]);
    expect(fieldTypes(ir, 'GetPetError404')).toEqual({ reason: primitive('string') });
    expect(fieldTypes(ir, 'GetPetError409')).toEqual({ conflicting_id: primitive('string') });
    expectConsistent(ir);
  });
});

describe('the name is reserved like a header model name', () => {
  const notFound = { '404': { description: 'nf', ...json(obj({ reason: str })) } };

  it('steps around a component schema of the same name and a different shape', async () => {
    const ir = await parseWithoutWarnings(doc(getPet(notFound), { GetPetError404: obj({ unrelated: int }) }));
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 404, description: 'nf', type: model('GetPetError404Body') },
    ]);
    expect(fieldTypes(ir, 'GetPetError404')).toEqual({ unrelated: primitive('integer') });
    expect(fieldTypes(ir, 'GetPetError404Body')).toEqual({ reason: primitive('string') });
    expectConsistent(ir, ['GetPetError404']);
  });

  it('shares a component schema of the same name and the identical shape, minting nothing', async () => {
    const ir = await parseWithoutWarnings(doc(getPet(notFound), { GetPetError404: obj({ reason: str }) }));
    expect(onlyOperation(ir).errors).toEqual([{ statusCode: 404, description: 'nf', type: model('GetPetError404') }]);
    expect(modelNames(ir)).toEqual(['Pet', 'GetPetError404']);
    expectConsistent(ir);
  });

  it('steps around a header model minted earlier in the same operation', async () => {
    // Service `GetPet` + header `Error404` → header model `GetPetError404`, registered first (the 200 precedes the 404).
    const ir = await parseWithoutWarnings(
      doc({
        '/pets/{petId}': {
          get: {
            tags: ['getPet'],
            operationId: 'getPet',
            responses: {
              '200': { description: 'ok', ...json(petRef), headers: { Error404: { schema: obj({ hint: str }) } } },
              ...notFound,
            },
          },
        },
      }),
    );
    const op = onlyOperation(ir);
    expect(op.responseHeaders).toEqual([
      {
        name: 'Error404',
        type: model('GetPetError404'),
        required: false,
        description: undefined,
        deprecated: undefined,
      },
    ]);
    expect(op.errors).toEqual([{ statusCode: 404, description: 'nf', type: model('GetPetError404Body') }]);
    expect(fieldTypes(ir, 'GetPetError404')).toEqual({ hint: primitive('string') });
    expect(fieldTypes(ir, 'GetPetError404Body')).toEqual({ reason: primitive('string') });
    expectConsistent(ir);
  });

  it('is registered so a later header model steps around it in turn', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        '/a': { get: { tags: ['getPet'], operationId: 'getPet', responses: { ...ok, ...notFound } } },
        '/b': {
          get: {
            tags: ['getPet'],
            operationId: 'listPets',
            responses: {
              '200': { description: 'ok', ...json(petRef), headers: { Error404: { schema: obj({ hint: str }) } } },
            },
          },
        },
      }),
    );
    const [get, list] = operationsOf(ir);
    expect(get.errors).toEqual([{ statusCode: 404, description: 'nf', type: model('GetPetError404') }]);
    expect(list.responseHeaders?.[0].type).toEqual(model('GetPetListPetsError404'));
    expect(fieldTypes(ir, 'GetPetError404')).toEqual({ reason: primitive('string') });
    expect(fieldTypes(ir, 'GetPetListPetsError404')).toEqual({ hint: primitive('string') });
    expectConsistent(ir);
  });
});

describe('error models survive the other response merges', () => {
  it('are kept when a later 2xx replaces the inline response models wholesale', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            responses: {
              '200': { description: 'ok', ...json(petRef) },
              '201': { description: 'created', ...json(obj({ a: str })) },
              '404': { description: 'nf', ...json(obj({ reason: str })) },
            },
          },
        },
      }),
    );
    const op = onlyOperation(ir);
    expect(op.response).toEqual(model('Pet'));
    expect(op.successResponses?.map((r) => r.type)).toEqual([model('Pet'), model('GetPetResponse')]);
    expect(op.errors).toEqual([{ statusCode: 404, description: 'nf', type: model('GetPetError404') }]);
    expect(modelNames(ir)).toEqual(['Pet', 'GetPetResponse', 'GetPetError404']);
    expectConsistent(ir);
  });

  it('sit beside the header models of the same error response', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            responses: {
              '200': { description: 'ok', ...json(obj({ a: str })) },
              '404': {
                description: 'nf',
                ...json(obj({ reason: str })),
                headers: { 'X-Meta': { schema: obj({ etag: str }) } },
              },
            },
          },
        },
      }),
    );
    const op = onlyOperation(ir);
    expect(op.response).toEqual(model('GetPetResponse'));
    expect(op.errors).toEqual([
      {
        statusCode: 404,
        description: 'nf',
        type: model('GetPetError404'),
        headers: [
          { name: 'X-Meta', type: model('PetsXMeta'), required: false, description: undefined, deprecated: undefined },
        ],
      },
    ]);
    // Materialized in document order: the 404's header is read before its body.
    expect(modelNames(ir)).toEqual(['Pet', 'GetPetResponse', 'PetsXMeta', 'GetPetError404']);
    expectConsistent(ir, ['Pet']);
  });
});

describe('every walker reaches errors[].type', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseOperation: Operation = {
    name: 'getPet',
    httpMethod: 'get',
    path: '/pets/{petId}',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'string' },
    errors: [],
    injectIdempotencyKey: false,
  };
  const problem: Model = {
    name: 'Problem',
    fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' }, required: false }],
  };
  const detail: Model = {
    name: 'ProblemDetail',
    fields: [{ name: 'line', type: { kind: 'primitive', type: 'integer' }, required: false }],
  };
  const withError = (type: Operation['errors'][number]['type']): Operation => ({
    ...baseOperation,
    errors: [{ statusCode: 404, description: 'nf', type }],
  });
  const specOf = (operations: Operation[], models: Model[]): ApiSpec => ({
    name: 'Test',
    version: '1',
    baseUrl: '',
    services: [{ name: 'Pets', operations }],
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  });

  it('validateModelRefs warns about a dangling error type, with the status code as context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateModelRefs(specOf([withError({ kind: 'array', items: { kind: 'model', name: 'Missing' } })], []));
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[oagen] Warning: Unresolved model reference "Missing" (context: Pets.getPet.errors.404)',
    ]);

    warn.mockClear();
    validateModelRefs(specOf([withError({ kind: 'model', name: 'Problem' })], [problem]));
    expect(warn).not.toHaveBeenCalled();
  });

  it('assignModelsToServices assigns a model reached only through an error, and what it references', () => {
    const viaError: Model = {
      ...problem,
      fields: [...problem.fields, { name: 'detail', type: { kind: 'model', name: 'ProblemDetail' }, required: false }],
    };
    const spec = specOf(
      [withError({ kind: 'nullable', inner: { kind: 'model', name: 'Problem' } })],
      [viaError, detail],
    );
    expect(assignModelsToServices(spec.models, spec.services)).toEqual(
      new Map([
        ['Problem', 'Pets'],
        ['ProblemDetail', 'Pets'],
      ]),
    );
  });

  it('specDerivedNames includes a name reached only through an error', () => {
    const spec = specOf([withError({ kind: 'model', name: 'OnlyViaError' })], []);
    expect(specDerivedNames(spec, nodeHints).has('OnlyViaError')).toBe(true);
  });

  it('a model rename (the Json-suffix collapse) rewrites the error type with the rest', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const problemJson: Model = {
      name: 'ProblemJson',
      fields: [...problem.fields, { name: 'detail', type: { kind: 'primitive', type: 'string' }, required: false }],
    };
    const op = withError({ kind: 'model', name: 'ProblemJson' });
    const services = [{ name: 'Pets', operations: [op] }];
    const models = collapseJsonSuffixModels([{ ...problem, fields: [...problem.fields] }, problemJson], services);
    expect(models.map((m) => m.name)).toEqual(['Problem']);
    expect(op.errors[0].type).toEqual({ kind: 'model', name: 'Problem' });
  });
});

describe('round 1: the reserved set covers every name the component and header passes mint', () => {
  const en = (values: string[]): SchemaObject => ({ type: 'string', enum: values });
  const enumValues = (ir: ApiSpec, name: string) => ir.enums.find((e) => e.name === name)?.values.map((v) => v.value);
  const notFound = (schema: SchemaObject) => ({ '404': { description: 'nf', ...json(schema) } });
  const reason = obj({ reason: str });
  /** `getPet` and `get-pet`: two operationIds with one stem, so one `<Op>Error404` name. */
  const sameStem = (second: Doc) =>
    doc({
      ...getPet(notFound(reason)),
      '/pet/{petId}': { get: { operationId: 'get-pet', responses: { ...ok, ...second } } },
    });

  it("steps around a component's nested inline model of the same name and a different shape", async () => {
    // Component `GetPet.error404` mints `GetPetError404` in the component pass,
    // which runs after operations; the registry must know it in advance.
    const ir = await parseWithoutWarnings(
      doc(getPet(notFound(reason)), { GetPet: obj({ error404: obj({ original: str }) }) }),
    );
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 404, description: 'nf', type: model('GetPetError404Body') },
    ]);
    // The child keeps its name, its shape and its parent's reference.
    expect(fieldTypes(ir, 'GetPet')).toEqual({ error404: model('GetPetError404') });
    expect(fieldTypes(ir, 'GetPetError404')).toEqual({ original: primitive('string') });
    expect(fieldTypes(ir, 'GetPetError404Body')).toEqual({ reason: primitive('string') });
    expect(modelNames(ir).filter((n) => n.startsWith('GetPetError404'))).toHaveLength(2);
    expectConsistent(ir, ['GetPet']);
  });

  it("shares a component's nested inline model of the same name and the identical shape", async () => {
    const ir = await parseWithoutWarnings(doc(getPet(notFound(reason)), { GetPet: obj({ error404: reason }) }));
    expect(onlyOperation(ir).errors).toEqual([{ statusCode: 404, description: 'nf', type: model('GetPetError404') }]);
    expect(fieldTypes(ir, 'GetPet')).toEqual({ error404: model('GetPetError404') });
    expect(modelNames(ir).filter((n) => n.startsWith('GetPetError404'))).toEqual(['GetPetError404']);
    expect(fieldTypes(ir, 'GetPetError404')).toEqual({ reason: primitive('string') });
    expectConsistent(ir, ['GetPet']);
  });

  it('two operations whose operationIds share a stem: different 404 bodies get distinct models', async () => {
    const ir = await parseWithoutWarnings(sameStem(notFound(obj({ code: int }))));
    const [first, second] = operationsOf(ir);
    expect(first.errors).toEqual([{ statusCode: 404, description: 'nf', type: model('GetPetError404') }]);
    expect(second.errors).toEqual([{ statusCode: 404, description: 'nf', type: model('GetPetError404Body') }]);
    expect(fieldTypes(ir, 'GetPetError404')).toEqual({ reason: primitive('string') });
    expect(fieldTypes(ir, 'GetPetError404Body')).toEqual({ code: primitive('integer') });
    expectConsistent(ir);
  });

  it('two operations whose operationIds share a stem: identical 404 bodies share one model', async () => {
    const ir = await parseWithoutWarnings(sameStem(notFound(reason)));
    expect(operationsOf(ir).map((op) => op.errors[0].type)).toEqual([model('GetPetError404'), model('GetPetError404')]);
    expect(modelNames(ir).filter((n) => n.startsWith('GetPetError404'))).toEqual(['GetPetError404']);
    expectConsistent(ir);
  });

  it('an enum body steps around a component enum of the same name and other members', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPet(notFound(en(['gone', 'missing']))), { GetPetError404: en(['old', 'new']) }),
    );
    expect(onlyOperation(ir).errors).toEqual([
      {
        statusCode: 404,
        description: 'nf',
        type: { kind: 'enum', name: 'GetPetError404Body', values: ['gone', 'missing'] },
      },
    ]);
    expect(enumValues(ir, 'GetPetError404')).toEqual(['old', 'new']);
    expect(enumValues(ir, 'GetPetError404Body')).toEqual(['gone', 'missing']);
    expectConsistent(ir);
  });

  it('an enum body shares a component enum of the same name and the same members, in any order', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPet(notFound(en(['gone', 'missing']))), { GetPetError404: en(['missing', 'gone']) }),
    );
    expect(onlyOperation(ir).errors[0].type).toEqual({
      kind: 'enum',
      name: 'GetPetError404',
      values: ['gone', 'missing'],
    });
    expect(enumNames(ir)).toEqual(['GetPetError404']);
    expect(enumValues(ir, 'GetPetError404')).toEqual(['missing', 'gone']);
  });

  it('an array of an enum body steps the same way', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPet(notFound({ type: 'array', items: en(['gone', 'missing']) })), { GetPetError404: en(['old', 'new']) }),
    );
    expect(onlyOperation(ir).errors[0].type).toEqual({
      kind: 'array',
      items: { kind: 'enum', name: 'GetPetError404Body', values: ['gone', 'missing'] },
    });
    expect(enumNames(ir)).toEqual(['GetPetError404', 'GetPetError404Body']);
  });

  it('a header enum minted earlier in the same operation keeps the name; the error enum steps', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        '/pets/{petId}': {
          get: {
            tags: ['getPet'],
            operationId: 'getPet',
            responses: {
              '200': { description: 'ok', ...json(petRef), headers: { Error404: { schema: en(['a', 'b']) } } },
              ...notFound(en(['gone', 'missing'])),
            },
          },
        },
      }),
    );
    const op = onlyOperation(ir);
    expect(op.responseHeaders?.[0].type).toEqual({ kind: 'enum', name: 'GetPetError404', values: ['a', 'b'] });
    expect(op.errors[0].type).toEqual({ kind: 'enum', name: 'GetPetError404Body', values: ['gone', 'missing'] });
    expect(enumValues(ir, 'GetPetError404')).toEqual(['a', 'b']);
    expect(enumValues(ir, 'GetPetError404Body')).toEqual(['gone', 'missing']);
  });

  it('an error enum minted earlier keeps the name; a later header enum with other members steps', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        '/a': {
          get: { tags: ['getPet'], operationId: 'getPet', responses: { ...ok, ...notFound(en(['gone', 'missing'])) } },
        },
        '/b': {
          get: {
            tags: ['getPet'],
            operationId: 'listPets',
            responses: {
              '200': { description: 'ok', ...json(petRef), headers: { Error404: { schema: en(['a', 'b']) } } },
            },
          },
        },
      }),
    );
    const [get, list] = operationsOf(ir);
    expect(get.errors[0].type).toEqual({ kind: 'enum', name: 'GetPetError404', values: ['gone', 'missing'] });
    const headerType = list.responseHeaders?.[0].type as { kind: string; name: string };
    expect(headerType.kind).toBe('enum');
    expect(headerType.name).not.toBe('GetPetError404');
    expect(enumValues(ir, 'GetPetError404')).toEqual(['gone', 'missing']);
    expect(enumValues(ir, headerType.name)).toEqual(['a', 'b']);
  });

  it('two operations whose operationIds share a stem: enum bodies with other members get distinct enums', async () => {
    const ir = await parseWithoutWarnings(sameStem(notFound(en(['absent', 'unknown']))));
    // The first operation's 404 is `reason`-shaped (a model), so only its stem is shared here.
    const second = operationsOf(ir)[1];
    expect(second.errors[0].type).toEqual({ kind: 'enum', name: 'GetPetError404', values: ['absent', 'unknown'] });

    const both = await parseWithoutWarnings(
      doc({
        ...getPet(notFound(en(['gone', 'missing']))),
        '/pet/{petId}': {
          get: { operationId: 'get-pet', responses: { ...ok, ...notFound(en(['absent', 'unknown'])) } },
        },
      }),
    );
    expect(operationsOf(both).map((op) => op.errors[0].type)).toEqual([
      { kind: 'enum', name: 'GetPetError404', values: ['gone', 'missing'] },
      { kind: 'enum', name: 'GetPetError404Body', values: ['absent', 'unknown'] },
    ]);
    expect(enumValues(both, 'GetPetError404Body')).toEqual(['absent', 'unknown']);
  });

  const unprocessable = (schema: SchemaObject) => ({ '422': { description: 'unprocessable', ...json(schema) } });
  const severityBody = obj({ severity: en(['warning', 'fatal']) });

  it('an enum nested in the body steps around a component enum of the same name and other members', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPet(unprocessable(severityBody)), { GetPetError422Severity: en(['x', 'y']) }),
    );
    // No model clashes, so the body keeps its name; the nested enum alone is
    // renamed by the collision-aware pass that promotes every model's field
    // enums (`collectInlineEnumsFromModels`), and the field reference and
    // the promoted enum move together.
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 422, description: 'unprocessable', type: model('GetPetError422') },
    ]);
    expect(fieldTypes(ir, 'GetPetError422')).toEqual({
      severity: { kind: 'enum', name: 'GetPetError422Severity2', values: ['warning', 'fatal'] },
    });
    expect(enumValues(ir, 'GetPetError422Severity')).toEqual(['x', 'y']);
    expect(enumValues(ir, 'GetPetError422Severity2')).toEqual(['warning', 'fatal']);
    expect(enumNames(ir)).toEqual(['GetPetError422Severity', 'GetPetError422Severity2']);
    expectConsistent(ir);
  });

  it('an enum nested in the body shares a component enum of the same name and the same members', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPet(unprocessable(severityBody)), { GetPetError422Severity: en(['fatal', 'warning']) }),
    );
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 422, description: 'unprocessable', type: model('GetPetError422') },
    ]);
    expect(fieldTypes(ir, 'GetPetError422')).toEqual({
      severity: { kind: 'enum', name: 'GetPetError422Severity', values: ['warning', 'fatal'] },
    });
    expect(enumNames(ir)).toEqual(['GetPetError422Severity']);
    expect(enumValues(ir, 'GetPetError422Severity')).toEqual(['fatal', 'warning']);
    expectConsistent(ir);
  });

  it("a component field's inline enum keeps its name too (GetPet.error422_severity); the error's steps", async () => {
    const ir = await parseWithoutWarnings(
      doc(getPet(unprocessable(severityBody)), { GetPet: obj({ error422_severity: en(['x', 'y']) }) }),
    );
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 422, description: 'unprocessable', type: model('GetPetError422') },
    ]);
    // The component's field is promoted first, so it owns the bare name.
    expect(fieldTypes(ir, 'GetPet')).toEqual({
      error422_severity: { kind: 'enum', name: 'GetPetError422Severity', values: ['x', 'y'] },
    });
    expect(fieldTypes(ir, 'GetPetError422')).toEqual({
      severity: { kind: 'enum', name: 'GetPetError422Severity2', values: ['warning', 'fatal'] },
    });
    expect(enumValues(ir, 'GetPetError422Severity')).toEqual(['x', 'y']);
    expect(enumValues(ir, 'GetPetError422Severity2')).toEqual(['warning', 'fatal']);
    expectConsistent(ir, ['GetPet']);
  });

  it("a header model's nested enum steps around a component enum of other members the same way", async () => {
    const ir = await parseWithoutWarnings(
      doc(
        {
          '/pets/{petId}': {
            get: {
              tags: ['getPet'],
              operationId: 'getPet',
              responses: {
                '200': {
                  description: 'ok',
                  ...json(petRef),
                  headers: { 'X-Meta': { schema: obj({ level: en(['a', 'b']) }) } },
                },
              },
            },
          },
        },
        { GetPetXMetaLevel: en(['x', 'y']) },
      ),
    );
    expect(onlyOperation(ir).responseHeaders?.[0].type).toEqual(model('GetPetXMeta'));
    expect(fieldTypes(ir, 'GetPetXMeta')).toEqual({
      level: { kind: 'enum', name: 'GetPetXMetaLevel2', values: ['a', 'b'] },
    });
    expect(enumValues(ir, 'GetPetXMetaLevel')).toEqual(['x', 'y']);
    expect(enumValues(ir, 'GetPetXMetaLevel2')).toEqual(['a', 'b']);
    expectConsistent(ir);
  });
});

describe('round 3: a clash on a name the body name does not reach reserves the title, and the search is bounded', () => {
  const en = (values: string[]): SchemaObject => ({ type: 'string', enum: values });
  const enumValues = (ir: ApiSpec, name: string) => ir.enums.find((e) => e.name === name)?.values.map((v) => v.value);
  const bad = (schema: SchemaObject) => ({ '400': { description: 'bad', ...json(schema) } });
  // Every variant titled and pinning a const: the union names them by their
  // bare titles, which no candidate for the body's own name can change.
  const circle = obj(
    { kind: { type: 'string', const: 'circle' }, state: en(['on', 'off']), radius: num },
    { title: 'Circle' },
  );
  const square = obj({ kind: { type: 'string', const: 'square' }, side: num }, { title: 'Square' });
  const titled: SchemaObject = { oneOf: [circle, square] };
  const unionOf = (circleName: string, squareName: string) => ({
    kind: 'union',
    compositionKind: 'oneOf',
    variants: [model(circleName), model(squareName)],
    discriminator: { property: 'kind', mapping: { circle: circleName, square: squareName } },
  });

  it(
    'a nested enum under a titled variant colliding with a component enum of other members: terminates, the enum renamed',
    { timeout: 10_000 },
    async () => {
      const ir = await parseWithoutWarnings(doc(getPet(bad(titled)), { CircleState: en(['x', 'y']) }));
      const op = onlyOperation(ir);
      // No model clashes, so the variant keeps its title; the nested enum
      // alone is renamed by the collision-aware model pass, and the field
      // reference and the promoted enum move together.
      expect(op.errors).toEqual([{ statusCode: 400, description: 'bad', type: unionOf('Circle', 'Square') }]);
      expect(fieldTypes(ir, 'Circle')).toEqual({
        kind: { kind: 'literal', value: 'circle' },
        state: { kind: 'enum', name: 'CircleState2', values: ['on', 'off'] },
        radius: primitive('number'),
      });
      expect(enumValues(ir, 'CircleState')).toEqual(['x', 'y']);
      expect(enumValues(ir, 'CircleState2')).toEqual(['on', 'off']);
      expect(enumNames(ir)).toEqual(['CircleState', 'CircleState2']);
      expectConsistent(ir);
    },
  );

  it('the same enum with identical members (any order) is shared, nothing is renamed', async () => {
    const ir = await parseWithoutWarnings(doc(getPet(bad(titled)), { CircleState: en(['off', 'on']) }));
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 400, description: 'bad', type: unionOf('Circle', 'Square') },
    ]);
    expect(fieldTypes(ir, 'Circle')?.['state']).toEqual({ kind: 'enum', name: 'CircleState', values: ['on', 'off'] });
    expect(enumNames(ir)).toEqual(['CircleState']);
    expect(enumValues(ir, 'CircleState')).toEqual(['off', 'on']);
    expectConsistent(ir);
  });

  it(
    'a titled variant colliding with a component model of another shape: the variant, its mapping entry and what is named under it move',
    { timeout: 10_000 },
    async () => {
      const ir = await parseWithoutWarnings(doc(getPet(bad(titled)), { Circle: obj({ unrelated: str }) }));
      expect(onlyOperation(ir).errors).toEqual([
        { statusCode: 400, description: 'bad', type: unionOf('CircleGetPetError400', 'Square') },
      ]);
      expect(fieldTypes(ir, 'Circle')).toEqual({ unrelated: primitive('string') });
      expect(fieldTypes(ir, 'CircleGetPetError400')?.['state']).toEqual({
        kind: 'enum',
        name: 'CircleGetPetError400State',
        values: ['on', 'off'],
      });
      expect(fieldTypes(ir, 'Square')).toEqual({
        kind: { kind: 'literal', value: 'square' },
        side: primitive('number'),
      });
      expect(enumNames(ir)).toEqual(['CircleGetPetError400State']);
      expectConsistent(ir, ['Circle']);
    },
  );

  it('every colliding variant is qualified; a variant with the identical shape is shared', async () => {
    const both = await parseWithoutWarnings(
      doc(getPet(bad(titled)), { Circle: obj({ unrelated: str }), Square: obj({ other: str }) }),
    );
    expect(onlyOperation(both).errors).toEqual([
      { statusCode: 400, description: 'bad', type: unionOf('CircleGetPetError400', 'SquareGetPetError400') },
    ]);
    expectConsistent(both, ['Circle', 'Square']);

    const shared = await parseWithoutWarnings(
      doc(getPet(bad(titled)), { Square: obj({ kind: { type: 'string', const: 'square' }, side: num }) }),
    );
    expect(onlyOperation(shared).errors).toEqual([
      { statusCode: 400, description: 'bad', type: unionOf('Circle', 'Square') },
    ]);
    expect(modelNames(shared).filter((n) => n === 'Square')).toEqual(['Square']);
    expectConsistent(shared);
  });

  it('two operations whose operationIds share a stem: a differing titled variant steps, an identical one is shared', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getPet(bad(titled)),
        '/pet/{petId}': {
          get: {
            operationId: 'get-pet',
            responses: {
              ...ok,
              ...bad({
                oneOf: [obj({ kind: { type: 'string', const: 'circle' }, area: num }, { title: 'Circle' }), square],
              }),
            },
          },
        },
      }),
    );
    const [first, second] = operationsOf(ir);
    expect(first.errors[0].type).toEqual(unionOf('Circle', 'Square'));
    expect(second.errors[0].type).toEqual(unionOf('CircleGetPetError400', 'Square'));
    expect(fieldTypes(ir, 'CircleGetPetError400')).toEqual({
      kind: { kind: 'literal', value: 'circle' },
      area: primitive('number'),
    });
    expectConsistent(ir);
  });

  it(
    'the header path is bounded the same way: a titled header variant colliding with a component model is qualified',
    { timeout: 10_000 },
    async () => {
      const ir = await parseWithoutWarnings(
        doc(
          {
            '/pets/{petId}': {
              get: {
                tags: ['pets'],
                operationId: 'getPet',
                responses: {
                  '200': { description: 'ok', ...json(petRef), headers: { 'X-Shape': { schema: titled } } },
                },
              },
            },
          },
          { Circle: obj({ unrelated: str }) },
        ),
      );
      expect(onlyOperation(ir).responseHeaders?.[0].type).toEqual(unionOf('CirclePetsXShape', 'Square'));
      expect(fieldTypes(ir, 'Circle')).toEqual({ unrelated: primitive('string') });
      expect(fieldTypes(ir, 'CirclePetsXShape')?.['state']).toEqual({
        kind: 'enum',
        name: 'CirclePetsXShapeState',
        values: ['on', 'off'],
      });
      expectConsistent(ir, ['Circle']);
    },
  );
});

describe('round 4: a clashing title is reserved, never renamed after the fact', () => {
  const en = (values: string[]): SchemaObject => ({ type: 'string', enum: values });
  const bad = (schema: SchemaObject) => ({ '400': { description: 'bad', ...json(schema) } });
  const circleTitled = (properties: Record<string, SchemaObject>): SchemaObject =>
    obj({ kind: { type: 'string', const: 'circle' }, ...properties }, { title: 'Circle' });
  const square = obj({ kind: { type: 'string', const: 'square' }, side: num }, { title: 'Square' });
  const literal = (value: string) => ({ kind: 'literal', value });
  const unionOf = (mapping: Record<string, string>) => ({
    kind: 'union',
    compositionKind: 'oneOf',
    variants: Object.values(mapping).map(model),
    discriminator: { property: 'kind', mapping },
  });

  it('a `$ref` inside the qualified variant keeps its component: no self-reference, component intact', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet(bad({ oneOf: [circleTitled({ inner: { $ref: '#/components/schemas/Circle' }, radius: num }), square] })),
        {
          Circle: obj({ unrelated: str }),
        },
      ),
    );
    expect(onlyOperation(ir).errors).toEqual([
      { statusCode: 400, description: 'bad', type: unionOf({ circle: 'CircleGetPetError400', square: 'Square' }) },
    ]);
    expect(fieldTypes(ir, 'CircleGetPetError400')).toEqual({
      kind: literal('circle'),
      inner: model('Circle'),
      radius: primitive('number'),
    });
    expect(fieldTypes(ir, 'Circle')).toEqual({ unrelated: primitive('string') });
    expectConsistent(ir);
  });

  it('a sibling already titled like a qualified name stays distinct: three models, three mapping targets', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPet(
          bad({
            oneOf: [
              circleTitled({ radius: num }),
              obj({ kind: { type: 'string', const: 'gpe' }, side: num }, { title: 'GetPetError400Circle' }),
            ],
          }),
        ),
        { Circle: obj({ unrelated: str }) },
      ),
    );
    expect(onlyOperation(ir).errors[0].type).toEqual(
      unionOf({ circle: 'CircleGetPetError400', gpe: 'GetPetError400Circle' }),
    );
    expect(fieldTypes(ir, 'Circle')).toEqual({ unrelated: primitive('string') });
    expect(fieldTypes(ir, 'CircleGetPetError400')).toEqual({ kind: literal('circle'), radius: primitive('number') });
    expect(fieldTypes(ir, 'GetPetError400Circle')).toEqual({ kind: literal('gpe'), side: primitive('number') });
    expect(
      modelNames(ir)
        .filter((n) => n.includes('Circle'))
        .sort(),
    ).toEqual(['Circle', 'CircleGetPetError400', 'GetPetError400Circle']);
    expectConsistent(ir, ['Circle']);
  });

  it(
    'a titled union nested under a field is out of the reserved set’s reach: the variant is renamed under the body, no warning',
    { timeout: 10_000 },
    async () => {
      const ir = await parseWithoutWarnings(
        doc(getPet(bad(obj({ shape: { oneOf: [circleTitled({ state: en(['on', 'off']) }), square] } }))), {
          Circle: obj({ unrelated: str }),
        }),
      );
      // Neither a candidate for the body's name nor a reservation reaches a
      // title nested below the top level, so the clashing variant is renamed
      // in place, qualified by the body (`materializeInlineSchema`): the
      // component keeps its name and shape, the mapping entry and the enum
      // named under the variant follow, and nothing dangles.
      expect(onlyOperation(ir).errors).toEqual([
        { statusCode: 400, description: 'bad', type: model('GetPetError400') },
      ]);
      expect(fieldTypes(ir, 'GetPetError400')).toEqual({
        shape: unionOf({ circle: 'GetPetError400Circle', square: 'Square' }),
      });
      expect(fieldTypes(ir, 'GetPetError400Circle')).toEqual({
        kind: literal('circle'),
        state: { kind: 'enum', name: 'GetPetError400CircleState', values: ['on', 'off'] },
      });
      expect(fieldTypes(ir, 'Circle')).toEqual({ unrelated: primitive('string') });
      expect(enumNames(ir)).toEqual(['GetPetError400CircleState']);
      expectConsistent(ir, ['Circle']);
    },
  );
});

describe('review round 1: a 2xx body reserves what it mints before any error body is typed (MichaelDeBoey)', () => {
  const titled = (title: string, kind: string, properties: Record<string, SchemaObject>): SchemaObject =>
    obj(
      { kind: { type: 'string', const: kind }, ...properties },
      { title, required: ['kind', ...Object.keys(properties)] },
    );
  const listShapes = {
    get: {
      operationId: 'listShapes',
      responses: {
        '200': {
          description: 'ok',
          ...json({ oneOf: [titled('Circle', 'circle', { radius: num }), titled('Square', 'square', { side: num })] }),
        },
      },
    },
  };
  const getNote = {
    get: {
      operationId: 'getNote',
      responses: {
        '400': {
          description: 'bad',
          ...json({
            oneOf: [
              titled('Circle', 'circle', { reason: str, hint: str, extra: str }),
              titled('Square', 'square', { code: int }),
            ],
          }),
        },
      },
    },
  };
  const literal = (value: string) => ({ kind: 'literal', value });

  it.each([
    ['success first', { '/shapes': listShapes, '/notes': getNote }],
    ['error first', { '/notes': getNote, '/shapes': listShapes }],
  ])('an error variant titled like a success variant is qualified, not merged over it (%s)', async (_, paths) => {
    const ir = await parseWithoutWarnings(doc(paths));
    const byName = Object.fromEntries(operationsOf(ir).map((op) => [op.name, op]));
    // The success response keeps its bare titles and its own fields.
    expect(byName.listShapes.response).toEqual({
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [model('Circle'), model('Square')],
      discriminator: { property: 'kind', mapping: { circle: 'Circle', square: 'Square' } },
    });
    expect(fieldTypes(ir, 'Circle')).toEqual({ kind: literal('circle'), radius: primitive('number') });
    expect(fieldTypes(ir, 'Square')).toEqual({ kind: literal('square'), side: primitive('number') });
    // The error's variants step around them, in either order.
    expect(byName.getNote.errors).toEqual([
      {
        statusCode: 400,
        description: 'bad',
        type: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model('CircleGetNoteError400'), model('SquareGetNoteError400')],
          discriminator: {
            property: 'kind',
            mapping: { circle: 'CircleGetNoteError400', square: 'SquareGetNoteError400' },
          },
        },
      },
    ]);
    expect(fieldTypes(ir, 'CircleGetNoteError400')).toEqual({
      kind: literal('circle'),
      reason: primitive('string'),
      hint: primitive('string'),
      extra: primitive('string'),
    });
    expect(fieldTypes(ir, 'SquareGetNoteError400')).toEqual({ kind: literal('square'), code: primitive('integer') });
    expectConsistent(ir, ['Pet']);
  });

  it('an error variant with the identical shape shares the success model', async () => {
    const sameShapes = {
      get: {
        operationId: 'getNote',
        responses: {
          '400': {
            description: 'bad',
            ...json({
              oneOf: [titled('Circle', 'circle', { radius: num }), titled('Square', 'square', { side: num })],
            }),
          },
        },
      },
    };
    const ir = await parseWithoutWarnings(doc({ '/notes': sameShapes, '/shapes': listShapes }));
    const byName = Object.fromEntries(operationsOf(ir).map((op) => [op.name, op]));
    expect(byName.getNote.errors[0].type).toEqual(byName.listShapes.response);
    expect(modelNames(ir).filter((n) => n.startsWith('Circle') || n.startsWith('Square'))).toEqual([
      'Circle',
      'Square',
    ]);
    expectConsistent(ir, ['Pet']);
  });

  it("reserves only the 2xx body that is kept, so a header sharing a dropped body's model still emits it (Greptile)", async () => {
    // The 200 body and its header both mint `Circle`/`Square`; the 201 `$ref` body
    // is the one whose models extractResponses keeps, dropping the 200's. The
    // header must not have shared a model that is never emitted.
    const shapes = { oneOf: [titled('Circle', 'circle', { radius: num }), titled('Square', 'square', { side: num })] };
    const ir = await parseWithoutWarnings(
      doc({
        '/shapes': {
          get: {
            operationId: 'listShapes',
            responses: {
              '200': { description: 'ok', ...json(shapes), headers: { 'X-Shape': { schema: shapes } } },
              '201': { description: 'created', ...json(petRef) },
            },
          },
        },
      }),
    );
    const op = onlyOperation(ir);
    const header = op.successResponses?.find((r) => r.statusCode === 200)?.headers?.[0];
    expect(header?.name).toBe('X-Shape');
    for (const name of collectModelRefs(header!.type)) expect(modelNames(ir)).toContain(name);
    expectConsistent(ir, ['Pet']);
  });

  it("reserves a request body's field variants, so an error union with the same titles is qualified (Greptile)", async () => {
    const ir = await parseWithoutWarnings(
      doc({
        '/shapes': {
          post: {
            operationId: 'createShape',
            requestBody: {
              content: {
                'application/json': {
                  schema: obj({
                    shape: {
                      oneOf: [titled('Circle', 'circle', { radius: num }), titled('Square', 'square', { side: num })],
                    },
                  }),
                },
              },
            },
            responses: { '204': { description: 'ok' } },
          },
        },
        '/notes': getNote,
      }),
    );
    expect(fieldTypes(ir, 'CreateShapeRequest')?.shape).toMatchObject({
      kind: 'union',
      variants: [model('Circle'), model('Square')],
    });
    expect(fieldTypes(ir, 'Circle')).toEqual({ kind: literal('circle'), radius: primitive('number') });
    expect(fieldTypes(ir, 'CircleGetNoteError400')).toEqual({
      kind: literal('circle'),
      reason: primitive('string'),
      hint: primitive('string'),
      extra: primitive('string'),
    });
    expectConsistent(ir, ['Pet']);
  });

  it("reserves each request body as its own operation mints it, never a stepped twin of another's (Greptile)", async () => {
    // Two operations whose request bodies are the same const-pinned union mint the
    // same AuthGetPetRequest each; a shared pre-pass array would have reserved an
    // AuthGetPetRequest2 nobody emits, which an error variant could then share
    // without a model behind it.
    const body = (operationId: string) => ({
      post: {
        operationId,
        requestBody: {
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  obj({ kind: { type: 'string', const: 'auth' }, token: str }),
                  obj({ kind: { type: 'string', const: 'anon' } }),
                ],
              },
            },
          },
        },
        responses: {
          '204': { description: 'ok' },
          '400': {
            description: 'bad',
            ...json({
              oneOf: [
                obj({ kind: { type: 'string', const: 'auth' }, token: str }, { title: 'AuthGetPetRequest2' }),
                obj({ kind: { type: 'string', const: 'other' }, x: str }, { title: 'Other' }),
              ],
            }),
          },
        },
      },
    });
    const ir = await parseWithoutWarnings(doc({ '/a': body('getPet'), '/b': body('get-pet') }));
    for (const op of operationsOf(ir)) {
      for (const error of op.errors) {
        for (const name of collectModelRefs(error.type!)) expect(modelNames(ir)).toContain(name);
      }
    }
    expectConsistent(ir, ['Pet']);
  });

  it('tells a numeric component enum from an error enum with the same spellings (Greptile)', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPet({ '422': { description: 'bad', ...json(obj({ severity: { type: 'string', enum: ['1', '2'] } })) } }), {
        GetPetError422Severity: { type: 'integer', enum: [1, 2] },
      }),
    );
    // Different members: the nested enum steps around the component enum, as for `['x', 'y']`.
    expect(onlyOperation(ir).errors[0].type).toEqual(model('GetPetError422'));
    expect(fieldTypes(ir, 'GetPetError422')).toEqual({
      severity: { kind: 'enum', name: 'GetPetError422Severity2', values: ['1', '2'] },
    });
    expect(ir.enums.find((e) => e.name === 'GetPetError422Severity')?.values.map((v) => v.value)).toEqual([1, 2]);
    expect(ir.enums.find((e) => e.name === 'GetPetError422Severity2')?.values.map((v) => v.value)).toEqual(['1', '2']);
    expectConsistent(ir);
  });
});
