import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { collectInlineEnumsFromOperations } from '../../src/parser/collect-inline-enums.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { collectAlternateResponseContents, collectModelRefs, collectEnumRefs } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Enum, Model, Operation, ResponseContent, Service, TypeRef } from '../../src/ir/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/response-content-types.yml');

/** Extract the only operation declared in an inline paths object. */
function singleOperation(paths: Record<string, unknown>): { operation: Operation; inlineModels: Model[] } {
  const { services, inlineModels } = extractOperations(paths as never);
  const operations = services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return { operation: operations[0], inlineModels };
}

/** A GET /things operation whose 200 declares the given content map. */
function getWithContent(content: Record<string, unknown>) {
  return { '/things': { get: { operationId: 'listThings', responses: { '200': { description: 'ok', content } } } } };
}

function findOp(spec: ApiSpec, name: string): Operation {
  const op = spec.services.flatMap((s) => s.operations).find((o) => o.name === name);
  if (!op) throw new Error(`no operation named ${name}`);
  return op;
}

function fieldsOf(spec: ApiSpec, modelName: string): string[] | undefined {
  return spec.models.find((m) => m.name === modelName)?.fields.map((f) => f.name);
}

function typeOf(op: Operation, contentType: string): TypeRef | undefined {
  return op.responseContents?.find((c) => c.contentType === contentType)?.type;
}

function unresolvedWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes('Unresolved'));
}

const op = (over: Partial<Operation>): Operation => ({
  name: 'get',
  httpMethod: 'get',
  path: '/things',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'primitive', type: 'unknown' },
  errors: [],
  injectIdempotencyKey: false,
  ...over,
});

describe('response content types', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('through parseSpec (issue #211 repro)', () => {
    it('keeps every media type of the card beside the unchanged fixed-order pick', async () => {
      const spec = await parseSpec(FIXTURE);
      const card = findOp(spec, 'renderPetCard');

      // The fixed-order pick is untouched: the PDF still wins and reads as binary.
      expect(card.response).toEqual({ kind: 'primitive', type: 'string', format: 'binary' });
      expect(card.successResponses).toBeUndefined();
      expect(card.responseContentTypes).toEqual(['text/html', 'application/pdf']);
      expect(card.responseContents).toMatchInlineSnapshot(`
        [
          {
            "contentType": "text/html",
            "type": {
              "kind": "primitive",
              "type": "string",
            },
          },
          {
            "contentType": "application/pdf",
            "type": {
              "format": "binary",
              "kind": "primitive",
              "type": "string",
            },
          },
        ]
      `);
    });

    it('shares the primary entry with `response`, and the operation lists with the primary success entry', async () => {
      const spec = await parseSpec(FIXTURE);
      const report = findOp(spec, 'getReport');
      expect(report.responseContents?.[0].contentType).toBe('application/json');
      expect(report.responseContents?.[0].type).toBe(report.response);

      const job = findOp(spec, 'startJob');
      const primary = job.successResponses![0];
      expect(primary.statusCode).toBe(200);
      expect(job.response).toBe(primary.type);
      expect(job.responseContentTypes).toBe(primary.contentTypes);
      expect(job.responseContents).toBe(primary.contents);
      expect(primary.contents![0].type).toBe(primary.type);
      // Each alternate 2xx entry shares its own type with its own entry.
      for (const entry of job.successResponses!) expect(entry.contents![0].type).toBe(entry.type);
    });

    it('keeps media types verbatim — parameters, vendor suffixes and wildcards — in document order', async () => {
      const spec = await parseSpec(FIXTURE);
      expect(findOp(spec, 'getReport').responseContentTypes).toEqual([
        'application/json',
        'application/vnd.api+json',
        'application/json; charset=utf-8',
      ]);
      expect(findOp(spec, 'downloadExport').responseContentTypes).toEqual(['application/zip', '*/*', 'application/*']);
    });

    it('types a secondary media type the way the fixed-order pick would had it been declared alone', async () => {
      const spec = await parseSpec(FIXTURE);
      const exports = findOp(spec, 'downloadExport');
      // Outside the fixed order the schema decides, and no schema is unknown.
      expect(typeOf(exports, '*/*')).toEqual({ kind: 'primitive', type: 'string', format: 'binary' });
      expect(typeOf(exports, 'application/*')).toEqual({ kind: 'primitive', type: 'unknown' });
      const avatar = findOp(spec, 'listAvatar');
      expect(typeOf(avatar, 'image/png')).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(typeOf(avatar, 'image/webp')).toEqual({ kind: 'primitive', type: 'string', format: 'binary' });
      // A text type is a string whatever its schema says, exactly as when it is primary.
      expect(typeOf(findOp(spec, 'getStatus'), 'text/plain')).toEqual({ kind: 'primitive', type: 'string' });
      // A parameterized JSON type referencing a component is that component.
      expect(typeOf(findOp(spec, 'getReport'), 'application/json; charset=utf-8')).toEqual({
        kind: 'model',
        name: 'Report',
      });
    });

    it('materializes an inline body under a secondary media type as a model named after it, nested objects included', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseSpec(FIXTURE);

      expect(findOp(spec, 'getReport').responseContents?.[1]).toEqual({
        contentType: 'application/vnd.api+json',
        type: { kind: 'model', name: 'GetReportApplicationVndApiJsonResponse' },
      });
      expect(fieldsOf(spec, 'GetReportApplicationVndApiJsonResponse')).toEqual(['data', 'links']);
      expect(fieldsOf(spec, 'GetReportApplicationVndApiJsonResponseLink')).toEqual(['self']);
      // An error body is named for its role.
      expect(fieldsOf(spec, 'RenderPetCardApplicationProblemJsonError')).toEqual(['title', 'detail']);
      // Without an operationId the path names it, as it names the primary body.
      expect(findOp(spec, 'listAvatar').responseContents?.[3].type).toEqual({
        kind: 'model',
        name: 'PetsByPetIdAvatarGetApplicationVndPetJsonResponse',
      });
      expect(fieldsOf(spec, 'PetsByPetIdAvatarGetApplicationVndPetJsonResponse')).toEqual(['url', 'width']);
      expect(unresolvedWarnings(warn)).toEqual([]);
    });

    it('resolves every model and enum reachable only through a content entry', async () => {
      const spec = await parseSpec(FIXTURE);
      const modelNames = new Set(spec.models.map((m) => m.name));
      const enumNames = new Set(spec.enums.map((e) => e.name));
      const walked: string[] = [];
      for (const operation of spec.services.flatMap((s) => s.operations)) {
        for (const content of collectAlternateResponseContents(operation)) {
          walked.push(`${operation.name} ${content.contentType}`);
          for (const name of collectModelRefs(content.type)) {
            expect(modelNames, `${operation.name} ${content.contentType} → model ${name}`).toContain(name);
          }
          for (const name of collectEnumRefs(content.type)) {
            expect(enumNames, `${operation.name} ${content.contentType} → enum ${name}`).toContain(name);
          }
        }
      }
      expect(walked).toMatchInlineSnapshot(`
        [
          "renderPetCard text/html",
          "renderPetCard text/html",
          "renderPetCard application/problem+json",
          "listAvatar image/png",
          "listAvatar image/webp",
          "listAvatar application/vnd.pet+json",
          "getReport application/vnd.api+json",
          "getReport application/json; charset=utf-8",
          "getReport text/plain",
          "downloadExport */*",
          "downloadExport application/*",
          "getStatus application/vnd.status+json",
          "getStatus text/plain",
          "startJob application/x-ndjson",
          "startJob application/x-ndjson",
          "startJob application/x-ndjson",
          "getLegacy text/html",
          "getCard application/vnd.card+json",
        ]
      `);
    });

    it('shares one model for an identical inline shape on another status code and re-derives a different one by code', async () => {
      const spec = await parseSpec(FIXTURE);
      const job = findOp(spec, 'startJob');
      const ndjson = (code: number) => job.successResponses!.find((r) => r.statusCode === code)!.contents![1].type;
      expect(ndjson(200)).toEqual({ kind: 'model', name: 'StartJobApplicationXNdjsonResponse' });
      expect(ndjson(201)).toEqual({ kind: 'model', name: 'StartJobApplicationXNdjsonResponse' });
      expect(ndjson(202)).toEqual({ kind: 'model', name: 'StartJobApplicationXNdjsonResponse202' });
      expect(fieldsOf(spec, 'StartJobApplicationXNdjsonResponse')).toEqual(['id', 'state']);
      expect(fieldsOf(spec, 'StartJobApplicationXNdjsonResponse202')).toEqual(['id', 'state', 'eta']);
      expect(spec.models.filter((m) => m.name.startsWith('StartJobApplicationXNdjson'))).toHaveLength(2);
    });

    it('steps around a component schema that already owns the derived name with a different shape', async () => {
      const spec = await parseSpec(FIXTURE);
      expect(findOp(spec, 'getCard').responseContents?.[1].type).toEqual({
        kind: 'model',
        name: 'GetCardApplicationVndCardJsonResponse200',
      });
      expect(fieldsOf(spec, 'GetCardApplicationVndCardJsonResponse')).toEqual(['back']);
      expect(fieldsOf(spec, 'GetCardApplicationVndCardJsonResponse200')).toEqual(['front']);
    });

    it('promotes an inline enum under a secondary media type to spec.enums', async () => {
      const spec = await parseSpec(FIXTURE);
      expect(findOp(spec, 'getStatus').responseContents?.[1].type).toMatchObject({
        kind: 'enum',
        name: 'GetStatusApplicationVndStatusJsonResponse',
      });
      const promoted = spec.enums.find((e) => e.name === 'GetStatusApplicationVndStatusJsonResponse');
      expect(promoted?.values.map((v) => v.value)).toEqual(['ok', 'degraded', 'down']);
    });

    it('leaves a response that declares no media type without the fields', async () => {
      const spec = await parseSpec(FIXTURE);
      const health = findOp(spec, 'getHealth');
      expect(Object.keys(health)).not.toContain('responseContentTypes');
      expect(Object.keys(health)).not.toContain('responseContents');
      expect(health.successResponses?.map((r) => r.statusCode)).toEqual([200, 204]);
      for (const entry of health.successResponses!) {
        // 200 with `content: {}` and a bodiless 204 alike.
        expect(Object.keys(entry)).not.toContain('contentTypes');
        expect(Object.keys(entry)).not.toContain('contents');
      }
      expect(collectAlternateResponseContents(health)).toEqual([]);
    });

    it("types a redirect's body without reading it into the redirect's unknown type", async () => {
      const spec = await parseSpec(FIXTURE);
      const legacy = findOp(spec, 'getLegacy');
      expect(legacy.response).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(legacy.responseContentTypes).toEqual(['text/html']);
      expect(legacy.responseContents).toEqual([
        { contentType: 'text/html', type: { kind: 'primitive', type: 'string' } },
      ]);
      // Not read from any media type, so the entry is reachable only through itself.
      expect(collectAlternateResponseContents(legacy)).toEqual(legacy.responseContents);
    });

    it('keeps error media types, sharing the application/json entry with `type`', async () => {
      const spec = await parseSpec(FIXTURE);
      const [notFound, problem] = findOp(spec, 'renderPetCard').errors;

      expect(notFound.statusCode).toBe(404);
      expect(notFound.type).toEqual({ kind: 'model', name: 'Error' });
      expect(notFound.contentTypes).toEqual(['application/json', 'text/html']);
      expect(notFound.contents?.[0].type).toBe(notFound.type);
      expect(notFound.contents?.[1]).toEqual({ contentType: 'text/html', type: { kind: 'primitive', type: 'string' } });

      // No application/json: `type` stays unset, the body is still typed.
      expect(problem.statusCode).toBe(500);
      expect(problem.type).toBeUndefined();
      expect(problem.contentTypes).toEqual(['application/problem+json']);
      expect(problem.contents).toEqual([
        {
          contentType: 'application/problem+json',
          type: { kind: 'model', name: 'RenderPetCardApplicationProblemJsonError' },
        },
      ]);
    });

    it('leaves an inline application/json error body exactly as before: no new model, no new warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseSpec(FIXTURE);
      const report = findOp(spec, 'getReport');
      const [invalid] = report.errors;

      // The unqualified `Error<code>` ref the parser has always produced for an inline error body.
      expect(invalid.statusCode).toBe(422);
      expect(invalid.type).toEqual({ kind: 'model', name: 'Error422' });
      expect(invalid.contents?.[0].type).toBe(invalid.type);
      expect(invalid.contents?.[1]).toEqual({ contentType: 'text/plain', type: { kind: 'primitive', type: 'string' } });
      expect(spec.models.map((m) => m.name)).not.toContain('Error422');
      expect(spec.models.some((m) => m.name.startsWith('GetReport') && m.name.endsWith('Error'))).toBe(false);
      // The shared entry is reached through `errors[].type`, never through the
      // content walk, so it raises no unresolved-reference warning either.
      expect(collectAlternateResponseContents(report).map((c) => c.contentType)).toEqual([
        'application/vnd.api+json',
        'application/json; charset=utf-8',
        'text/plain',
      ]);
      expect(unresolvedWarnings(warn)).toEqual([]);
    });
  });

  describe('through extractOperations', () => {
    /** A GET /things operation whose 400 declares the given content map (or none). */
    function getWithErrorContent(content?: Record<string, unknown>) {
      return {
        '/things': {
          get: {
            operationId: 'listThings',
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } },
              '400': { description: 'bad', ...(content && { content }) },
            },
          },
        },
      };
    }

    it('keeps an error that declares only application/json with a schema in exactly its old shape', () => {
      const { operation } = singleOperation(
        getWithErrorContent({ 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }),
      );
      expect(operation.errors).toEqual([{ statusCode: 400, type: { kind: 'model', name: 'Error' } }]);
      expect(Object.keys(operation.errors[0])).toEqual(['statusCode', 'type']);
    });

    it('keeps an error with no content, or an empty content map, without the lists', () => {
      expect(singleOperation(getWithErrorContent()).operation.errors).toEqual([{ statusCode: 400, type: undefined }]);
      expect(singleOperation(getWithErrorContent({})).operation.errors).toEqual([{ statusCode: 400, type: undefined }]);
    });

    it('keeps the lists on an error whose application/json body has no schema, since `type` says nothing', () => {
      const { operation } = singleOperation(getWithErrorContent({ 'application/json': {} }));
      expect(operation.errors).toEqual([
        {
          statusCode: 400,
          type: undefined,
          contentTypes: ['application/json'],
          contents: [{ contentType: 'application/json', type: { kind: 'primitive', type: 'unknown' } }],
        },
      ]);
    });

    it('keeps the lists on an error that declares a media type beside application/json, sharing the JSON entry', () => {
      const { operation } = singleOperation(
        getWithErrorContent({
          'application/json': { schema: { $ref: '#/components/schemas/Error' } },
          'text/html': { schema: { type: 'string' } },
        }),
      );
      const [error] = operation.errors;
      expect(error.contentTypes).toEqual(['application/json', 'text/html']);
      expect(error.contents?.[0].type).toBe(error.type);
      expect(error.contents?.[1]).toEqual({ contentType: 'text/html', type: { kind: 'primitive', type: 'string' } });
    });

    it('lets a typed media type win over a schema-less application/json, which reads as unknown', () => {
      const { operation } = singleOperation(
        getWithContent({ 'application/json': {}, 'text/html': { schema: { type: 'string' } } }),
      );
      expect(operation.response).toEqual({ kind: 'primitive', type: 'string' });
      expect(operation.responseContents).toEqual([
        { contentType: 'application/json', type: { kind: 'primitive', type: 'unknown' } },
        { contentType: 'text/html', type: { kind: 'primitive', type: 'string' } },
      ]);
      expect(operation.responseContents?.[1].type).toBe(operation.response);
    });

    it('gives two parameterizations of one media type distinct models', () => {
      const { operation, inlineModels } = singleOperation(
        getWithContent({
          'application/json': { schema: { $ref: '#/components/schemas/Thing' } },
          'application/vnd.thing+json; version=1': {
            schema: { type: 'object', properties: { a: { type: 'string' } } },
          },
          'application/vnd.thing+json; version=2': {
            schema: { type: 'object', properties: { b: { type: 'string' } } },
          },
        }),
      );
      expect(operation.responseContents?.map((c) => c.type)).toEqual([
        { kind: 'model', name: 'Thing' },
        { kind: 'model', name: 'ListThingsApplicationVndThingJsonVersion1Response' },
        { kind: 'model', name: 'ListThingsApplicationVndThingJsonVersion2Response' },
      ]);
      expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
        ['ListThingsApplicationVndThingJsonVersion1Response', ['a']],
        ['ListThingsApplicationVndThingJsonVersion2Response', ['b']],
      ]);
    });

    it('reads a wildcard segment as Any when naming', () => {
      const { operation } = singleOperation(
        getWithContent({
          'application/json': { schema: { $ref: '#/components/schemas/Thing' } },
          'application/*': { schema: { type: 'object', properties: { blob: { type: 'string' } } } },
        }),
      );
      expect(operation.responseContents?.[1].type).toEqual({ kind: 'model', name: 'ListThingsApplicationAnyResponse' });
    });

    it("falls back to Content for a media type the caser reduces to nothing, so it cannot take the primary body's name", () => {
      const { operation, inlineModels } = singleOperation(
        getWithContent({
          'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } },
          '/': { schema: { type: 'object', properties: { raw: { type: 'string' } } } },
        }),
      );
      expect(operation.response).toEqual({ kind: 'model', name: 'ListThingsResponse' });
      expect(operation.responseContents?.[1].type).toEqual({ kind: 'model', name: 'ListThingsContentResponse' });
      expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
        ['ListThingsResponse', ['id']],
        ['ListThingsContentResponse', ['raw']],
      ]);
    });

    it('types an inline array and union under a secondary media type as schemaToTypeRef names them', () => {
      const { operation, inlineModels } = singleOperation(
        getWithContent({
          'application/json': { schema: { $ref: '#/components/schemas/Thing' } },
          'application/vnd.list+json': {
            schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
          },
          'application/vnd.either+json': {
            schema: {
              oneOf: [
                { type: 'object', properties: { a: { type: 'string' } } },
                { type: 'object', properties: { b: { type: 'string' } } },
              ],
            },
          },
        }),
      );
      expect(operation.responseContents?.slice(1)).toMatchInlineSnapshot(`
        [
          {
            "contentType": "application/vnd.list+json",
            "type": {
              "items": {
                "kind": "model",
                "name": "ListThingsApplicationVndListJsonResponse",
              },
              "kind": "array",
            },
          },
          {
            "contentType": "application/vnd.either+json",
            "type": {
              "compositionKind": "oneOf",
              "kind": "union",
              "variants": [
                {
                  "kind": "model",
                  "name": "ListThingsApplicationVndEitherJsonResponse",
                },
                {
                  "kind": "model",
                  "name": "ListThingsApplicationVndEitherJsonResponseWithB",
                },
              ],
            },
          },
        ]
      `);
      expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toMatchInlineSnapshot(`
        [
          [
            "ListThingsApplicationVndListJsonResponse",
            [
              "id",
            ],
          ],
          [
            "ListThingsApplicationVndEitherJsonResponse",
            [
              "a",
            ],
          ],
          [
            "ListThingsApplicationVndEitherJsonResponseWithB",
            [
              "b",
            ],
          ],
        ]
      `);
    });
  });

  describe('collectAlternateResponseContents', () => {
    const string: TypeRef = { kind: 'primitive', type: 'string' };

    it('yields each list once and skips the entry that shares the response type', () => {
      const primaryType: TypeRef = { kind: 'model', name: 'Thing' };
      const html: ResponseContent = { contentType: 'text/html', type: string };
      const primary: ResponseContent[] = [{ contentType: 'application/json', type: primaryType }, html];
      const createdType: TypeRef = { kind: 'model', name: 'Thing' }; // equal to primaryType, but another object
      const createdXml: ResponseContent = { contentType: 'application/xml', type: string };
      const redirectHtml: ResponseContent = { contentType: 'text/html', type: string };
      const errorType: TypeRef = { kind: 'model', name: 'Error' };
      const errorText: ResponseContent = { contentType: 'text/plain', type: string };
      const operation = op({
        response: primaryType,
        responseContentTypes: ['application/json', 'text/html'],
        responseContents: primary,
        successResponses: [
          { statusCode: 200, type: primaryType, contentTypes: ['application/json', 'text/html'], contents: primary },
          {
            statusCode: 201,
            type: createdType,
            contentTypes: ['application/json', 'application/xml'],
            contents: [{ contentType: 'application/json', type: createdType }, createdXml],
          },
          // Not read from any media type: every entry is reachable only through itself.
          {
            statusCode: 302,
            type: { kind: 'primitive', type: 'unknown' },
            contentTypes: ['text/html'],
            contents: [redirectHtml],
          },
        ],
        errors: [
          {
            statusCode: 404,
            type: errorType,
            contentTypes: ['application/json', 'text/plain'],
            contents: [{ contentType: 'application/json', type: errorType }, errorText],
          },
        ],
      });

      const result = collectAlternateResponseContents(operation);
      expect(result).toHaveLength(4);
      expect(result[0]).toBe(html);
      expect(result[1]).toBe(createdXml);
      expect(result[2]).toBe(redirectHtml);
      expect(result[3]).toBe(errorText);
    });

    it('yields nothing for an operation without content', () => {
      expect(collectAlternateResponseContents(op({}))).toEqual([]);
      expect(
        collectAlternateResponseContents(
          op({ successResponses: [{ statusCode: 204, type: { kind: 'primitive', type: 'unknown' } }] }),
        ),
      ).toEqual([]);
    });
  });

  describe('validateModelRefs', () => {
    it('warns about a model reachable only through a content entry that nothing defines, naming the media type', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const response: TypeRef = { kind: 'primitive', type: 'string' };
      const spec: ApiSpec = {
        name: 'Test',
        version: '1.0.0',
        baseUrl: '',
        services: [
          {
            name: 'Things',
            operations: [
              op({
                response,
                responseContentTypes: ['text/html', 'application/vnd.x+json'],
                responseContents: [
                  { contentType: 'text/html', type: response },
                  { contentType: 'application/vnd.x+json', type: { kind: 'model', name: 'Missing' } },
                ],
                errors: [
                  {
                    statusCode: 500,
                    contentTypes: ['application/problem+json'],
                    contents: [
                      {
                        contentType: 'application/problem+json',
                        type: { kind: 'array', items: { kind: 'model', name: 'AlsoMissing' } },
                      },
                    ],
                  },
                ],
              }),
            ],
          },
        ],
        models: [],
        enums: [],
        sdk: defaultSdkBehavior(),
      };

      validateModelRefs(spec);

      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        '[oagen] Warning: Unresolved model reference "Missing" (context: Things.get.contents.application/vnd.x+json)',
        '[oagen] Warning: Unresolved model reference "AlsoMissing" (context: Things.get.contents.application/problem+json)',
      ]);
    });
  });

  describe('collectInlineEnumsFromOperations', () => {
    it('promotes an inline enum reachable only through a content entry and keeps a clashing value set apart', () => {
      const first: TypeRef = { kind: 'enum', name: 'Mode', values: ['a', 'b'] };
      const second: TypeRef = { kind: 'enum', name: 'Mode', values: ['c'] };
      const content = (type: TypeRef): Partial<Operation> => ({
        responseContentTypes: ['application/json', 'application/vnd.x+json'],
        responseContents: [
          { contentType: 'application/json', type: { kind: 'primitive', type: 'unknown' } },
          { contentType: 'application/vnd.x+json', type },
        ],
      });
      const services: Service[] = [
        {
          name: 'Things',
          operations: [op({ name: 'one', ...content(first) }), op({ name: 'two', ...content(second) })],
        },
      ];
      const enums: Enum[] = [];

      collectInlineEnumsFromOperations(services, enums);

      expect(enums.map((e) => [e.name, e.values.map((v) => v.value)])).toEqual([
        ['Mode', ['a', 'b']],
        ['Mode2', ['c']],
      ]);
      // The ref itself is renamed, so the IR keeps pointing at the enum that was promoted.
      expect(second.name).toBe('Mode2');
    });
  });
});
