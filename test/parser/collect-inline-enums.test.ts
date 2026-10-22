import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import {
  collectEnumRefs,
  collectModelRefs,
  collectModelTypeRefs,
  collectResponseBodyTypes,
  collectResponseHeaders,
} from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';
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

function doc(paths: Doc, schemas: Record<string, SchemaObject> = {}): Doc {
  return {
    openapi: '3.1.0',
    info: { title: 'inline body enums', version: '1' },
    paths,
    components: { schemas },
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
 * Every `ModelRef` and `EnumRef` reachable from an operation or a model names
 * a model or enum of the IR, and no model or enum besides a component is
 * left unreferenced.
 */
function expectSound(ir: ApiSpec, componentNames: string[] = []): void {
  const models = new Set(ir.models.map((m) => m.name));
  const enums = new Set(enumNames(ir));
  const refs = [...operationsOf(ir).flatMap(operationTypeRefs), ...ir.models.flatMap(collectModelTypeRefs)];
  const referencedModels = new Set(refs.flatMap(collectModelRefs));
  const referencedEnums = new Set(refs.flatMap(collectEnumRefs));
  expect([...referencedModels].filter((name) => !models.has(name))).toEqual([]);
  expect([...referencedEnums].filter((name) => !enums.has(name))).toEqual([]);
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
    expect(operation(ir, 'getPetKind').response).toEqual({
      kind: 'array',
      items: inlineEnum('GetPetKindResponse', ['cat', 'dog']),
    });
    expect(enumNames(ir)).toEqual(['GetPetKindResponse']);
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
