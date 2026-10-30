import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { collectInlineEnumsFromOperations } from '../../src/parser/collect-inline-enums.js';
import {
  collectEnumRefs,
  collectModelRefs,
  collectModelTypeRefs,
  collectResponseBodyTypes,
  collectResponseHeaders,
  collectWebhookTypeRefs,
} from '../../src/ir/types.js';
import type { ApiSpec, Enum, Operation, TypeRef } from '../../src/ir/types.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

// workos/oagen#281: an inline enum that is an operation's primary response
// body, one of its success bodies or its request body was referenced by name
// (`GetPetKindResponse`, `SetMoodRequest`) but never added to `spec.enums`,
// so no emitter generated it. `collectInlineEnumsFromOperations` walked the
// parameters, the envelope fields, the response headers, the error bodies and
// the bodies `collectResponseBodyTypes` yields — never `requestBody`,
// `response` or `successResponses[].type`, which that helper leaves out
// because each is reached through the entry's own `type`.

type Doc = Record<string, unknown>;

const str: SchemaObject = { type: 'string' };
const en = (values: string[], extra: SchemaObject = {}): SchemaObject => ({ type: 'string', enum: values, ...extra });
/** The issue's `kind` schema. */
const kind = en(['cat', 'dog']);
const json = (schema: SchemaObject) => ({ content: { 'application/json': { schema } } });
const petId = [{ name: 'petId', in: 'path', required: true, schema: str }];
const noContent = { '204': { description: 'ok' } };

function doc(paths: Doc, schemas: Record<string, SchemaObject> = {}, extra: Doc = {}): Doc {
  return {
    openapi: '3.1.0',
    info: { title: 'inline body enums', version: '1' },
    paths,
    components: { schemas },
    ...extra,
  };
}

/** `GET /pets/{petId}/kind` (`getPetKind`) with the given responses. */
const getPetKind = (responses: Doc): Doc => ({
  '/pets/{petId}/kind': { get: { operationId: 'getPetKind', parameters: petId, responses } },
});

/** `POST /pets/{petId}/mood` (`setMood`) with the given request body and, by default, a bodiless 204. */
const setMood = (requestBody: Doc, responses: Doc = noContent): Doc => ({
  '/pets/{petId}/mood': { post: { operationId: 'setMood', parameters: petId, requestBody, responses } },
});

async function parseTempSpec(spec: Doc): Promise<ApiSpec> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-collect-inline-enums-'));
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
const operation = (ir: ApiSpec, name: string): Operation => {
  const found = operationsOf(ir).find((op) => op.name === name);
  expect(found, name).toBeDefined();
  return found!;
};
const enumNames = (ir: ApiSpec): string[] => ir.enums.map((e) => e.name);
const enumValues = (ir: ApiSpec, name: string): Array<string | number> | undefined =>
  ir.enums.find((e) => e.name === name)?.values.map((v) => v.value);
const inlineEnum = (name: string, values: string[]) => ({ kind: 'enum', name, values });

/** The issue's rendering of a type: `enum GetPetKindResponse`, `array<enum GetPetError410>`, `primitive string`. */
const ref = (type: TypeRef | undefined): string | undefined => {
  if (!type) return undefined;
  if (type.kind === 'array') return `array<${ref(type.items)}>`;
  return `${type.kind} ${'name' in type ? type.name : 'type' in type ? type.type : ''}`;
};

/** Every type reference an operation holds: bodies of every kind, headers, parameters and paging fields. */
function operationTypeRefs(op: Operation): TypeRef[] {
  const params = [
    ...op.pathParams,
    ...op.queryParams,
    ...(op.bodyOwnedQueryParams ?? []),
    ...op.headerParams,
    ...(op.cookieParams ?? []),
  ];
  return [
    ...(op.requestBody ? [op.requestBody] : []),
    op.response,
    ...(op.successResponses ?? []).map((entry) => entry.type),
    ...op.errors.flatMap((error) => (error.type ? [error.type] : [])),
    ...collectResponseBodyTypes(op).map((body) => body.type),
    ...collectResponseHeaders(op).map((header) => header.type),
    ...params.map((param) => param.type),
    ...(op.pagination ? [op.pagination.itemType, ...(op.pagination.envelopeFields ?? []).map((f) => f.type)] : []),
  ];
}

/**
 * Every `ModelRef` and `EnumRef` reachable from an operation, a webhook or a
 * model names a model or enum of the IR; no model and enum share a name; and
 * no model or enum besides a component is left unreferenced.
 */
function expectSound(ir: ApiSpec, componentNames: string[] = []): void {
  const models = new Set(ir.models.map((m) => m.name));
  const enums = new Set(enumNames(ir));
  const refs = [
    ...operationsOf(ir).flatMap(operationTypeRefs),
    ...(ir.webhooks ?? []).flatMap(collectWebhookTypeRefs),
    ...ir.models.flatMap(collectModelTypeRefs),
  ];
  const referencedModels = new Set(refs.flatMap(collectModelRefs));
  const referencedEnums = new Set(refs.flatMap(collectEnumRefs));
  expect([...referencedModels].filter((name) => !models.has(name))).toEqual([]);
  expect([...referencedEnums].filter((name) => !enums.has(name))).toEqual([]);
  expect([...models].filter((name) => enums.has(name))).toEqual([]);
  const orphan = (name: string): boolean =>
    !componentNames.includes(name) && !referencedModels.has(name) && !referencedEnums.has(name);
  expect([...models].filter(orphan)).toEqual([]);
  expect([...enums].filter(orphan)).toEqual([]);
}

describe("the issue's repro: an inline enum as the response's own body (#281)", () => {
  it('lands in spec.enums beside the ones a secondary media type and a default response already got', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getPetKind({
          '200': {
            description: 'kind',
            content: { 'application/json': { schema: kind }, 'application/vnd.pet+json': { schema: kind } },
          },
        }),
        '/pets/{petId}/kind/check': {
          get: {
            operationId: 'checkPetKind',
            parameters: petId,
            responses: {
              '200': { description: 'kind', ...json(kind) },
              '202': { description: 'later', ...json(kind) },
            },
          },
        },
        '/pets/{petId}/kind/guess': {
          get: {
            operationId: 'guessPetKind',
            parameters: petId,
            responses: {
              '200': { description: 'guess', ...json(str) },
              default: { description: 'kind', ...json(kind) },
            },
          },
        },
      }),
    );
    expect(enumNames(ir)).toEqual([
      'GetPetKindResponse',
      'GetPetKindApplicationVndPetJsonResponse',
      'CheckPetKindResponse',
      'GuessPetKindDefaultResponse',
    ]);
    expect(enumValues(ir, 'GetPetKindResponse')).toEqual(['cat', 'dog']);
    expect(enumValues(ir, 'CheckPetKindResponse')).toEqual(['cat', 'dog']);

    const getKind = operation(ir, 'getPetKind');
    expect(ref(getKind.response)).toBe('enum GetPetKindResponse');
    expect(getKind.responseContents?.map(({ type }) => ref(type))).toEqual([
      'enum GetPetKindResponse',
      'enum GetPetKindApplicationVndPetJsonResponse',
    ]);
    expect(getKind.successResponses).toBeUndefined();

    const check = operation(ir, 'checkPetKind');
    expect(ref(check.response)).toBe('enum CheckPetKindResponse');
    expect(check.successResponses?.map(({ statusCode, type }) => `${statusCode}: ${ref(type)}`)).toEqual([
      '200: enum CheckPetKindResponse',
      '202: enum CheckPetKindResponse',
    ]);

    const guess = operation(ir, 'guessPetKind');
    expect(ref(guess.response)).toBe('primitive string');
    expect(ref(guess.defaultResponse?.type)).toBe('enum GuessPetKindDefaultResponse');
    expectSound(ir);
  });

  it("the first comment's repro: an inline enum as the request body lands in spec.enums as <Op>Request", async () => {
    const ir = await parseWithoutWarnings(doc(setMood(json(en(['calm', 'busy'])))));
    const op = operation(ir, 'setMood');
    expect(op.requestBody).toEqual(inlineEnum('SetMoodRequest', ['calm', 'busy']));
    expect(ref(op.response)).toBe('primitive unknown');
    expect(ir.enums).toEqual([
      {
        name: 'SetMoodRequest',
        values: [
          { name: 'CALM', value: 'calm' },
          { name: 'BUSY', value: 'busy' },
        ],
      },
    ]);
    expectSound(ir);
  });

  it("the second comment's repro: error bodies (#243), the primary body and the request body all land in spec.enums", async () => {
    const ir = await parseWithoutWarnings(
      doc({
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: petId,
            responses: {
              '200': { description: 'pet', ...json(str) },
              '409': { description: 'conflict', ...json(kind) },
              '410': { description: 'gone', ...json({ type: 'array', items: kind }) },
              '422': { description: 'invalid', ...json({ type: 'object', properties: { kind } }) },
            },
          },
        },
        ...getPetKind({ '200': { description: 'kind', ...json(kind) } }),
        ...setMood(json(en(['calm', 'busy']))),
      }),
    );
    expect(enumNames(ir)).toEqual([
      'GetPetError422Kind',
      'GetPetError409',
      'GetPetError410',
      'GetPetKindResponse',
      'SetMoodRequest',
    ]);
    const describe = (op: Operation) => ({
      errors: op.errors.map(({ statusCode, type }) => `${statusCode}: ${ref(type)}`),
      requestBody: ref(op.requestBody),
      response: ref(op.response),
    });
    expect(describe(operation(ir, 'getPet'))).toEqual({
      errors: ['409: enum GetPetError409', '410: array<enum GetPetError410>', '422: model GetPetError422'],
      requestBody: undefined,
      response: 'primitive string',
    });
    expect(describe(operation(ir, 'getPetKind'))).toEqual({
      errors: [],
      requestBody: undefined,
      response: 'enum GetPetKindResponse',
    });
    expect(describe(operation(ir, 'setMood'))).toEqual({
      errors: [],
      requestBody: 'enum SetMoodRequest',
      response: 'primitive unknown',
    });
    expectSound(ir);
  });
});

describe('every shape a body enum takes is promoted', () => {
  it('an array of an inline enum as the primary response body', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPetKind({ '200': { description: 'kinds', ...json({ type: 'array', items: kind }) } })),
    );
    // An array body's items are typed as `<Op>Item` whatever their shape
    // (#282), so the enum is `GetPetKindItem`, as a list envelope's would be.
    expect(operation(ir, 'getPetKind').response).toEqual({
      kind: 'array',
      items: inlineEnum('GetPetKindItem', ['cat', 'dog']),
    });
    expect(enumNames(ir)).toEqual(['GetPetKindItem']);
    expectSound(ir);
  });

  it('an array of, and a nullable, inline enum as the request body', async () => {
    const asArray = await parseWithoutWarnings(doc(setMood(json({ type: 'array', items: en(['calm', 'busy']) }))));
    expect(operation(asArray, 'setMood').requestBody).toEqual({
      kind: 'array',
      items: inlineEnum('SetMoodRequest', ['calm', 'busy']),
    });
    expect(enumNames(asArray)).toEqual(['SetMoodRequest']);
    expectSound(asArray);

    const asNullable = await parseWithoutWarnings(
      doc(setMood(json({ type: ['string', 'null'], enum: ['calm', 'busy', null] }))),
    );
    expect(operation(asNullable, 'setMood').requestBody).toEqual({
      kind: 'nullable',
      inner: inlineEnum('SetMoodRequest', ['calm', 'busy']),
    });
    expect(enumNames(asNullable)).toEqual(['SetMoodRequest']);
    expectSound(asNullable);
  });

  it('a request body read from a form media type is walked like a JSON one', async () => {
    const ir = await parseWithoutWarnings(
      doc(setMood({ content: { 'application/x-www-form-urlencoded': { schema: en(['calm', 'busy']) } } })),
    );
    const op = operation(ir, 'setMood');
    expect(op.requestBodyEncoding).toBe('form-urlencoded');
    expect(op.requestBody).toEqual(inlineEnum('SetMoodRequest', ['calm', 'busy']));
    expect(enumNames(ir)).toEqual(['SetMoodRequest']);
    expectSound(ir);
  });

  it('a oneOf of string consts as the body is an inline enum, promoted with its per-value documentation and link', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({
          '200': {
            description: 'kind',
            ...json({
              oneOf: [
                { const: 'cat', description: 'A cat' },
                { const: 'dog', deprecated: true },
              ],
              externalDocs: { url: 'https://example.com/kinds' },
            }),
          },
        }),
      ),
    );
    expect(operation(ir, 'getPetKind').response).toEqual(inlineEnum('GetPetKindResponse', ['cat', 'dog']));
    expect(ir.enums).toEqual([
      {
        name: 'GetPetKindResponse',
        values: [
          { name: 'CAT', value: 'cat', description: 'A cat' },
          { name: 'DOG', value: 'dog', deprecated: true },
        ],
        externalDocs: { url: 'https://example.com/kinds' },
      },
    ]);
    expectSound(ir);
  });

  it('a request-body enum and a response enum of one operation are promoted side by side', async () => {
    const ir = await parseWithoutWarnings(
      doc(setMood(json(en(['calm', 'busy'])), { '200': { description: 'mood', ...json(en(['calm', 'busy'])) } })),
    );
    const op = operation(ir, 'setMood');
    expect(op.requestBody).toEqual(inlineEnum('SetMoodRequest', ['calm', 'busy']));
    expect(op.response).toEqual(inlineEnum('SetMoodResponse', ['calm', 'busy']));
    expect(enumNames(ir)).toEqual(['SetMoodRequest', 'SetMoodResponse']);
    expectSound(ir);
  });

  it('an enum nested in a body model is promoted once, by the model pass, under the field name', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        setMood(json({ type: 'object', properties: { mood: en(['calm', 'busy']) } }), {
          '200': { description: 'pet', ...json({ type: 'object', properties: { kind } }) },
        }),
      ),
    );
    const op = operation(ir, 'setMood');
    expect(op.requestBody).toEqual({ kind: 'model', name: 'SetMoodRequest' });
    expect(op.response).toEqual({ kind: 'model', name: 'SetMoodResponse' });
    expect([...enumNames(ir)].sort()).toEqual(['SetMoodRequestMood', 'SetMoodResponseKind']);
    expectSound(ir);
  });

  it('a 3xx entry beside an enum 2xx body stays unknown and the enum is promoted once', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPetKind({ '200': { description: 'kind', ...json(kind) }, '302': { description: 'moved' } })),
    );
    const op = operation(ir, 'getPetKind');
    expect(op.successResponses?.map(({ statusCode, type }) => `${statusCode}: ${ref(type)}`)).toEqual([
      '200: enum GetPetKindResponse',
      '302: primitive unknown',
    ]);
    expect(enumNames(ir)).toEqual(['GetPetKindResponse']);
    expectSound(ir);
  });
});

describe('a body enum whose name is taken', () => {
  it('two success bodies with the same members share one enum', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({ '200': { description: 'kind', ...json(kind) }, '202': { description: 'later', ...json(kind) } }),
      ),
    );
    expect(enumNames(ir)).toEqual(['GetPetKindResponse']);
    expect(operation(ir, 'getPetKind').successResponses?.map(({ type }) => ref(type))).toEqual([
      'enum GetPetKindResponse',
      'enum GetPetKindResponse',
    ]);
    expectSound(ir);
  });

  it('a second success body with other members is qualified by its status code', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({
          '200': { description: 'kind', ...json(kind) },
          '202': { description: 'later', ...json(en(['pending', 'unknown'])) },
        }),
      ),
    );
    const op = operation(ir, 'getPetKind');
    expect(op.response).toEqual(inlineEnum('GetPetKindResponse', ['cat', 'dog']));
    expect(op.successResponses?.map(({ type }) => ref(type))).toEqual([
      'enum GetPetKindResponse',
      'enum GetPetKindResponse202',
    ]);
    expect(enumValues(ir, 'GetPetKindResponse')).toEqual(['cat', 'dog']);
    expect(enumValues(ir, 'GetPetKindResponse202')).toEqual(['pending', 'unknown']);
    expectSound(ir);
  });

  it('a second array-of-enum success body is qualified the same way, from the `<Op>Item` its items take (#447)', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({
          '200': { description: 'kinds', ...json({ type: 'array', items: kind }) },
          '202': { description: 'later', ...json({ type: 'array', items: en(['pending', 'unknown']) }) },
        }),
      ),
    );
    expect(operation(ir, 'getPetKind').successResponses?.map(({ type }) => ref(type))).toEqual([
      'array<enum GetPetKindItem>',
      'array<enum GetPetKindItem202>',
    ]);
    expect(enumNames(ir)).toEqual(['GetPetKindItem', 'GetPetKindItem202']);
    expect(enumValues(ir, 'GetPetKindItem')).toEqual(['cat', 'dog']);
    expect(enumValues(ir, 'GetPetKindItem202')).toEqual(['pending', 'unknown']);
    expectSound(ir);
  });

  it('a lone response body steps around a component enum of the same name and other members', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPetKind({ '200': { description: 'kind', ...json(kind) } }), { GetPetKindResponse: en(['old', 'new']) }),
    );
    expect(operation(ir, 'getPetKind').response).toEqual(inlineEnum('GetPetKindResponse2', ['cat', 'dog']));
    expect(enumValues(ir, 'GetPetKindResponse')).toEqual(['old', 'new']);
    expect(enumValues(ir, 'GetPetKindResponse2')).toEqual(['cat', 'dog']);
    expectSound(ir, ['GetPetKindResponse']);
  });

  it('a lone response body shares a component enum of the same name and the same members, in any order', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPetKind({ '200': { description: 'kind', ...json(kind) } }), { GetPetKindResponse: en(['dog', 'cat']) }),
    );
    expect(operation(ir, 'getPetKind').response).toEqual(inlineEnum('GetPetKindResponse', ['cat', 'dog']));
    expect(enumNames(ir)).toEqual(['GetPetKindResponse']);
    expect(enumValues(ir, 'GetPetKindResponse')).toEqual(['dog', 'cat']);
    expectSound(ir, ['GetPetKindResponse']);
  });

  it('a request body steps around a component enum of the same name and other members', async () => {
    const ir = await parseWithoutWarnings(
      doc(setMood(json(en(['calm', 'busy']))), { SetMoodRequest: en(['old', 'new']) }),
    );
    expect(operation(ir, 'setMood').requestBody).toEqual(inlineEnum('SetMoodRequest2', ['calm', 'busy']));
    expect(enumValues(ir, 'SetMoodRequest')).toEqual(['old', 'new']);
    expect(enumValues(ir, 'SetMoodRequest2')).toEqual(['calm', 'busy']);
    expectSound(ir, ['SetMoodRequest']);
  });

  it('success bodies beside a component enum of their name are qualified by status code, and identical members share the first', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({
          '200': { description: 'kind', ...json(kind) },
          '202': { description: 'later', ...json(kind) },
          '203': { description: 'maybe', ...json(en(['pending', 'unknown'])) },
        }),
        { GetPetKindResponse: en(['old', 'new']) },
      ),
    );
    const op = operation(ir, 'getPetKind');
    expect(op.successResponses?.map(({ statusCode, type }) => `${statusCode}: ${ref(type)}`)).toEqual([
      '200: enum GetPetKindResponse200',
      '202: enum GetPetKindResponse200',
      '203: enum GetPetKindResponse203',
    ]);
    expect(enumNames(ir)).toEqual(['GetPetKindResponse', 'GetPetKindResponse200', 'GetPetKindResponse203']);
    expect(enumValues(ir, 'GetPetKindResponse')).toEqual(['old', 'new']);
    expect(enumValues(ir, 'GetPetKindResponse200')).toEqual(['cat', 'dog']);
    expect(enumValues(ir, 'GetPetKindResponse203')).toEqual(['pending', 'unknown']);
    expectSound(ir, ['GetPetKindResponse']);
  });

  it('a body enum never takes a model name: a component model owning the stem sends it to the next suffix', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPetKind({ '200': { description: 'kind', ...json(kind) } }), {
        GetPetKindResponse: en(['old', 'new']),
        GetPetKindResponse2: { type: 'object', properties: { name: str } },
      }),
    );
    expect(operation(ir, 'getPetKind').response).toEqual(inlineEnum('GetPetKindResponse3', ['cat', 'dog']));
    expect(enumNames(ir)).toEqual(['GetPetKindResponse', 'GetPetKindResponse3']);
    expectSound(ir, ['GetPetKindResponse', 'GetPetKindResponse2']);
  });
});

// PR #332 review: `collectDistinctEnums` consulted `modelNames` only for the
// name it stepped to, so a model alone — an object component owning the very
// name an inline enum derives, with no enum of that name — never triggered a
// rename, and a model and an enum reached the emitters under one name. Every
// site that promotes an inline enum now checks the original name against
// the models too.
describe('an inline enum never takes a name a model owns', () => {
  const owner: SchemaObject = { type: 'object', properties: { name: str } };
  const modelNames = (ir: ApiSpec): string[] => ir.models.map((m) => m.name);

  it('a lone response body beside an object component of its name is numbered', async () => {
    const ir = await parseWithoutWarnings(
      doc(getPetKind({ '200': { description: 'kind', ...json(kind) } }), { GetPetKindResponse: owner }),
    );
    expect(operation(ir, 'getPetKind').response).toEqual(inlineEnum('GetPetKindResponse2', ['cat', 'dog']));
    expect(modelNames(ir)).toEqual(['GetPetKindResponse']);
    expect(enumNames(ir)).toEqual(['GetPetKindResponse2']);
    expectSound(ir, ['GetPetKindResponse']);
  });

  it('a request body beside an object component of its name is numbered', async () => {
    const ir = await parseWithoutWarnings(doc(setMood(json(en(['calm', 'busy']))), { SetMoodRequest: owner }));
    expect(operation(ir, 'setMood').requestBody).toEqual(inlineEnum('SetMoodRequest2', ['calm', 'busy']));
    expect(modelNames(ir)).toEqual(['SetMoodRequest']);
    expect(enumNames(ir)).toEqual(['SetMoodRequest2']);
    expectSound(ir, ['SetMoodRequest']);
  });

  it('an error body beside an object component of its name steps to …Body', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({
          '200': { description: 'kind', ...json(str) },
          '404': { description: 'nf', ...json(en(['gone', 'missing'])) },
        }),
        { GetPetKindError404: owner },
      ),
    );
    expect(operation(ir, 'getPetKind').errors[0].type).toEqual(
      inlineEnum('GetPetKindError404Body', ['gone', 'missing']),
    );
    expect(modelNames(ir)).toEqual(['GetPetKindError404']);
    expect(enumNames(ir)).toEqual(['GetPetKindError404Body']);
    expectSound(ir, ['GetPetKindError404']);
  });

  it('a response header beside an object component of its name is numbered', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({
          '200': { description: 'kind', ...json(str), headers: { 'X-Kind': { schema: kind } } },
        }),
        { PetsXKind: owner },
      ),
    );
    expect(operation(ir, 'getPetKind').responseHeaders?.[0].type).toEqual(inlineEnum('PetsXKind2', ['cat', 'dog']));
    expect(modelNames(ir)).toEqual(['PetsXKind']);
    expect(enumNames(ir)).toEqual(['PetsXKind2']);
    expectSound(ir, ['PetsXKind']);
  });

  it('a query parameter beside an object component of its name is numbered', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        {
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [{ name: 'kind', in: 'query', schema: kind }],
              responses: { '200': { description: 'pets', ...json(str) } },
            },
          },
        },
        { PetsKind: owner },
      ),
    );
    expect(operation(ir, 'listPets').queryParams[0].type).toEqual(inlineEnum('PetsKind2', ['cat', 'dog']));
    expect(modelNames(ir)).toEqual(['PetsKind']);
    expect(enumNames(ir)).toEqual(['PetsKind2']);
    expectSound(ir, ['PetsKind']);
  });

  it('a default body beside an object component of its name is numbered', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({ '200': { description: 'kind', ...json(str) }, default: { description: 'kind', ...json(kind) } }),
        { GetPetKindDefaultResponse: owner },
      ),
    );
    expect(operation(ir, 'getPetKind').defaultResponse?.type).toEqual(
      inlineEnum('GetPetKindDefaultResponse2', ['cat', 'dog']),
    );
    expect(modelNames(ir)).toEqual(['GetPetKindDefaultResponse']);
    expect(enumNames(ir)).toEqual(['GetPetKindDefaultResponse2']);
    expectSound(ir, ['GetPetKindDefaultResponse']);
  });

  it("a component field's enum beside an object component of its name is numbered at extraction", async () => {
    const ir = await parseWithoutWarnings(doc({}, { Pet: { type: 'object', properties: { kind } }, PetKind: owner }));
    const pet = ir.models.find((m) => m.name === 'Pet');
    expect(pet?.fields.map(({ name, type }) => `${name}: ${ref(type)}`)).toEqual(['kind: enum PetKind2']);
    expect(modelNames(ir)).toEqual(['Pet', 'PetKind']);
    expect(enumNames(ir)).toEqual(['PetKind2']);
    expectSound(ir, ['Pet', 'PetKind']);
  });

  it('a webhook parameter beside an object component of its name is moved by the stem reservation first', async () => {
    // `resolveWebhookModelStems` hashes a stem whose minted names collide with
    // a component or operation name (`PetAdoptedB4A950`, the documented SHA-1
    // prefix of `petAdopted`), so the enum reaches the webhook collector under
    // the moved stem and nothing shares the component's name.
    const ir = await parseWithoutWarnings(
      doc(
        {},
        { PetAdoptedXSource: owner },
        {
          webhooks: {
            petAdopted: {
              post: {
                parameters: [{ name: 'X-Source', in: 'header', schema: en(['app', 'api']) }],
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        },
      ),
    );
    expect(ir.webhooks?.[0].headerParams[0].type).toEqual(inlineEnum('PetAdoptedB4A950XSource', ['app', 'api']));
    expect(modelNames(ir)).toEqual(['PetAdoptedXSource']);
    expect(enumNames(ir)).toEqual(['PetAdoptedB4A950XSource']);
    expectSound(ir, ['PetAdoptedXSource']);
  });

  it('a model owning the stem and an enum of other members together send the body to the next free suffix', async () => {
    const ir = await parseWithoutWarnings(
      doc(setMood(json(en(['calm', 'busy']))), { SetMoodRequest: owner, SetMoodRequest2: en(['old', 'new']) }),
    );
    expect(operation(ir, 'setMood').requestBody).toEqual(inlineEnum('SetMoodRequest3', ['calm', 'busy']));
    expect(modelNames(ir)).toEqual(['SetMoodRequest']);
    expect(enumNames(ir)).toEqual(['SetMoodRequest2', 'SetMoodRequest3']);
    expectSound(ir, ['SetMoodRequest', 'SetMoodRequest2']);
  });
});

// The stepped-name reuse in `distinctEnumName` (identical members share a
// digit-qualified name the stem already stepped to, before a new one is
// minted) applies wherever a status code qualifies a name, so response
// headers share across status codes exactly as bodies do — the enum twin of
// the rule #331 gives identical inline models. A header enum that used to be
// minted per status code (`PetsXPolicy503`, `PetsXPolicyDefault`) is no
// longer, so an SDK regenerated from such a spec loses that type (noted as
// breaking in the PR).
describe('identical members on another status code share the stepped name, headers included', () => {
  const policy = (values: string[]) => ({ 'X-Policy': { schema: en(values) } });
  const headerOf = (entry: { headers?: Array<{ type: TypeRef }> } | undefined): string | undefined =>
    ref(entry?.headers?.[0].type);

  it('a 503 header with the members the 429 header stepped to shares `…429`; `…503` is never minted', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({
          '200': { description: 'kind', ...json(str), headers: policy(['fast', 'slow']) },
          '429': { description: 'slow down', headers: policy(['retry', 'stop']) },
          '503': { description: 'down', headers: policy(['retry', 'stop']) },
        }),
      ),
    );
    const op = operation(ir, 'getPetKind');
    expect(ref(op.responseHeaders?.[0].type)).toBe('enum PetsXPolicy');
    expect(op.errors.map((error) => `${error.statusCode}: ${headerOf(error)}`)).toEqual([
      '429: enum PetsXPolicy429',
      '503: enum PetsXPolicy429',
    ]);
    expect(enumNames(ir)).toEqual(['PetsXPolicy', 'PetsXPolicy429']);
    expect(enumValues(ir, 'PetsXPolicy')).toEqual(['fast', 'slow']);
    expect(enumValues(ir, 'PetsXPolicy429')).toEqual(['retry', 'stop']);
    expectSound(ir);
  });

  it("a default response's header with those members shares `…429` too; `…Default` is never minted", async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({
          '200': { description: 'kind', ...json(str), headers: policy(['fast', 'slow']) },
          '429': { description: 'slow down', headers: policy(['retry', 'stop']) },
          default: { description: 'anything else', headers: policy(['retry', 'stop']) },
        }),
      ),
    );
    const op = operation(ir, 'getPetKind');
    expect(headerOf(op.errors[0])).toBe('enum PetsXPolicy429');
    expect(headerOf(op.defaultResponse)).toBe('enum PetsXPolicy429');
    expect(enumNames(ir)).toEqual(['PetsXPolicy', 'PetsXPolicy429']);
    expectSound(ir);
  });

  it('a header whose members no stepped name holds still takes its own status code', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getPetKind({
          '200': { description: 'kind', ...json(str), headers: policy(['fast', 'slow']) },
          '429': { description: 'slow down', headers: policy(['retry', 'stop']) },
          '503': { description: 'down', headers: policy(['wait', 'queue']) },
        }),
      ),
    );
    const op = operation(ir, 'getPetKind');
    expect(op.errors.map((error) => `${error.statusCode}: ${headerOf(error)}`)).toEqual([
      '429: enum PetsXPolicy429',
      '503: enum PetsXPolicy503',
    ]);
    expect(enumNames(ir)).toEqual(['PetsXPolicy', 'PetsXPolicy429', 'PetsXPolicy503']);
    expect(enumValues(ir, 'PetsXPolicy503')).toEqual(['wait', 'queue']);
    expectSound(ir);
  });
});

// workos/oagen#391: the stepped-name reuse searched every enum of the
// document, so any `<stem><digits>` holding the same members — another
// operation's status-code step, a component named for a year or for a 404 —
// handed its name to an unrelated site before the site's own status code or
// number was tried. Only a name the same operation's own sites stepped the
// stem to is shared now.
describe('a stepped name is shared only by the operation whose sites stepped to it (#391)', () => {
  const policy = (values: string[]) => ({ 'X-Policy': { schema: en(values) } });
  const id = [{ name: 'id', in: 'path', required: true, schema: str }];
  /** The issue's `steps.yaml`; `getPet` may take extra parameters or other responses. */
  const steps = ({ parameters = [], responses }: { parameters?: Doc[]; responses?: Doc } = {}): Doc =>
    doc(
      {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'status', in: 'query', schema: en(['available', 'sold']) }],
            responses: {
              '200': { description: 'OK', headers: policy(['fast', 'slow']) },
              '429': { description: 'Too many requests', headers: policy(['retry', 'stop']) },
            },
          },
        },
        '/pets/{id}': {
          get: {
            operationId: 'getPet',
            parameters: [...id, ...parameters],
            responses: responses ?? { '200': { description: 'OK', headers: policy(['retry', 'stop']) } },
          },
        },
        '/pets/{id}/kind': {
          get: {
            operationId: 'getPetKind',
            parameters: id,
            responses: { '200': { description: 'OK', ...json(kind) } },
          },
        },
      },
      {
        GetPetKindResponse: en(['bird', 'fish']),
        GetPetKindResponse404: kind,
        PetsStatus: en(['pending']),
        PetsStatus2024: en(['available', 'sold']),
      },
    );
  const components = ['GetPetKindResponse', 'GetPetKindResponse404', 'PetsStatus', 'PetsStatus2024'];
  /** The issue's printout of an operation: its success and error headers, its query parameters and an enum body. */
  const typesOf = (op: Operation): string[] => [
    ...(op.responseHeaders ?? []).map(({ name, type }) => `${name}: ${ref(type)}`),
    ...op.errors.flatMap(({ statusCode, headers = [] }) =>
      headers.map(({ name, type }) => `${statusCode} ${name}: ${ref(type)}`),
    ),
    ...op.queryParams.map(({ name, type }) => `${name}: ${ref(type)}`),
    ...(op.response.kind === 'enum' ? [`response: ${ref(op.response)}`] : []),
  ];

  it("the issue's repro: `getPet`'s header, `status` and `getPetKind`'s body are numbered, not named for a 429, a year or a 404", async () => {
    const ir = await parseWithoutWarnings(steps());

    // Before: `PetsXPolicy429`, `PetsStatus2024` and `GetPetKindResponse404`.
    expect(typesOf(operation(ir, 'listPets'))).toEqual([
      'X-Policy: enum PetsXPolicy',
      '429 X-Policy: enum PetsXPolicy429',
      'status: enum PetsStatus2',
    ]);
    expect(typesOf(operation(ir, 'getPet'))).toEqual(['X-Policy: enum PetsXPolicy2']);
    expect(typesOf(operation(ir, 'getPetKind'))).toEqual(['response: enum GetPetKindResponse2']);
    expect(enumValues(ir, 'PetsStatus2')).toEqual(['available', 'sold']);
    expect(enumValues(ir, 'PetsXPolicy2')).toEqual(['retry', 'stop']);
    expect(enumValues(ir, 'GetPetKindResponse2')).toEqual(['cat', 'dog']);
    expectSound(ir, components);
  });

  it("the issue's `x-policy` query parameter on `getPet` is numbered too, and the operation's header shares it", async () => {
    const ir = await parseWithoutWarnings(
      steps({ parameters: [{ name: 'x-policy', in: 'query', schema: en(['retry', 'stop']) }] }),
    );

    // Before: both took `listPets`'s `PetsXPolicy429`.
    expect(typesOf(operation(ir, 'getPet'))).toEqual(['X-Policy: enum PetsXPolicy2', 'x-policy: enum PetsXPolicy2']);
    expect(enumNames(ir).filter((name) => name.startsWith('PetsXPolicy'))).toEqual([
      'PetsXPolicy',
      'PetsXPolicy429',
      'PetsXPolicy2',
    ]);
    expectSound(ir, components);
  });

  it("a later status code of `getPet` shares the number its own lone 2xx header stepped to, not `listPets`'s `…429`", async () => {
    const ir = await parseWithoutWarnings(
      steps({
        responses: {
          '200': { description: 'OK', headers: policy(['retry', 'stop']) },
          '503': { description: 'down', headers: policy(['retry', 'stop']) },
        },
      }),
    );

    expect(typesOf(operation(ir, 'getPet'))).toEqual([
      'X-Policy: enum PetsXPolicy2',
      '503 X-Policy: enum PetsXPolicy2',
    ]);
    expectSound(ir, components);
  });

  it("another operation's status-code step is not this operation's: a 503 and a `default` take `…503`, not `…429`", async () => {
    const ir = await parseWithoutWarnings(
      steps({
        responses: {
          '200': { description: 'OK', headers: policy(['fast', 'slow']) },
          '503': { description: 'down', headers: policy(['retry', 'stop']) },
          default: { description: 'anything else', headers: policy(['retry', 'stop']) },
        },
      }),
    );
    const op = operation(ir, 'getPet');

    // Before: both took `listPets`'s `PetsXPolicy429`.
    expect(typesOf(op)).toEqual(['X-Policy: enum PetsXPolicy', '503 X-Policy: enum PetsXPolicy503']);
    expect(ref(op.defaultResponse?.headers?.[0].type)).toBe('enum PetsXPolicy503');
    expect(enumValues(ir, 'PetsXPolicy503')).toEqual(['retry', 'stop']);
    expectSound(ir, components);
  });

  it("the comment's repro: a header of a response shared through `components/responses` is numbered past a component named for a year", async () => {
    const ir = await parseWithoutWarnings({
      ...doc({
        '/pets/{id}': {
          get: {
            operationId: 'getPet',
            parameters: id,
            responses: { '200': { $ref: '#/components/responses/PetFound' } },
          },
        },
      }),
      components: {
        schemas: { PetFoundXMode: en(['auto']), PetFoundXMode2024: en(['fast', 'slow']) },
        responses: { PetFound: { description: 'found', headers: { 'X-Mode': { schema: en(['fast', 'slow']) } } } },
      },
    });

    // Before: `PetFoundXMode2024`.
    expect(typesOf(operation(ir, 'getPet'))).toEqual(['X-Mode: enum PetFoundXMode2']);
    expect(enumValues(ir, 'PetFoundXMode2')).toEqual(['fast', 'slow']);
    expectSound(ir, ['PetFoundXMode', 'PetFoundXMode2024']);
  });

  it("a component response's header shares no operation's step, so every operation that returns it agrees on one number", async () => {
    // A component `Pets` names its header from the stem the `Pets` service
    // derives too (`PetsXPolicy`), beside `getPet`'s own 429 step.
    const ir = await parseWithoutWarnings({
      ...doc({
        '/pets/{id}': {
          get: {
            operationId: 'getPet',
            parameters: id,
            responses: {
              '200': { description: 'OK', headers: policy(['fast', 'slow']) },
              '429': { description: 'Too many requests', headers: policy(['retry', 'stop']) },
              '503': { $ref: '#/components/responses/Pets' },
            },
          },
        },
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: { '200': { description: 'OK' }, '503': { $ref: '#/components/responses/Pets' } },
          },
        },
      }),
      components: { responses: { Pets: { description: 'down', headers: policy(['retry', 'stop']) } } },
    });

    expect(typesOf(operation(ir, 'getPet'))).toEqual([
      'X-Policy: enum PetsXPolicy',
      '429 X-Policy: enum PetsXPolicy429',
      '503 X-Policy: enum PetsXPolicy2',
    ]);
    expect(typesOf(operation(ir, 'listPets'))).toEqual(['503 X-Policy: enum PetsXPolicy2']);
    expectSound(ir);
  });
});

describe('the record of component sites is the third argument of collectInlineEnumsFromOperations (#356)', () => {
  const signature =
    'collectInlineEnumsFromOperations(services, enums, shared, models?, componentNames?): `shared` must be the Set of ' +
    'component-site references (`OperationExtractionResult.componentSites`), got ';

  it('fails by name, before any enum is read, when a caller still passes the models list third', () => {
    const { services, inlineModels, componentSites } = extractOperations(
      getPetKind({ '200': { description: 'ok', ...json(kind) } }) as never,
    );
    const enums: Enum[] = [];

    // The order every caller used before the record moved: models, then the
    // component names, then the record last — `models.map` would have thrown
    // on the Set, or a hand-built list would have been read as the record.
    expect(() =>
      collectInlineEnumsFromOperations(
        services,
        enums,
        inlineModels as never,
        new Set() as never,
        componentSites as never,
      ),
    ).toThrow(new TypeError(`${signature}an array`));
    expect(() => collectInlineEnumsFromOperations(services, enums, undefined as never)).toThrow(
      new TypeError(`${signature}undefined`),
    );
    expect(enums).toEqual([]);
  });

  it('promotes the body enum once the record is passed third, as every caller passes it', () => {
    const { services, inlineModels, componentSites } = extractOperations(
      getPetKind({ '200': { description: 'ok', ...json(kind) } }) as never,
    );
    const enums: Enum[] = [];

    collectInlineEnumsFromOperations(services, enums, componentSites, inlineModels);
    expect(enums.map((e) => e.name)).toEqual(['GetPetKindResponse']);
  });
});
