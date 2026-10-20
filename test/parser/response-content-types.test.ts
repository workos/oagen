import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { collectInlineEnumsFromOperations } from '../../src/parser/collect-inline-enums.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import {
  collectAlternateResponseContents,
  collectResponseBodyTypes,
  collectModelRefs,
  collectEnumRefs,
  assignModelsToServices,
} from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Enum, Model, Operation, ResponseContent, Service, TypeRef } from '../../src/ir/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/response-content-types.yml');

/** Parse an inline OpenAPI document through the whole pipeline (models, enums, ref validation). */
async function parseDocument(document: Record<string, unknown>): Promise<ApiSpec> {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-response-content-types-'));
  try {
    const file = join(dir, 'spec.json');
    writeFileSync(file, JSON.stringify(document));
    return await parseSpec(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An OpenAPI 3.1 document with the given paths and component schemas. */
function document(paths: Record<string, unknown>, schemas: Record<string, unknown> = {}): Record<string, unknown> {
  return { openapi: '3.1.0', info: { title: 'Test', version: '1' }, paths, components: { schemas } };
}

/** A GET operation whose 200 declares the given content map (and headers, when given). */
function getWith(
  operationId: string,
  content: Record<string, unknown>,
  responses: Record<string, unknown> = {},
  headers?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    get: {
      operationId,
      responses: { '200': { description: 'ok', ...(headers && { headers }), content }, ...responses },
    },
  };
}

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties,
  ...extra,
});
/** A title-mapped variant: a title and the `kind` const every variant pins (`titleMappedDiscriminatorProperty`). */
const titled = (title: string, kind: string, properties: Record<string, unknown>) => ({
  title,
  type: 'object',
  properties: { kind: { const: kind }, ...properties },
});
/** A title-mapped `oneOf` of `Circle` and `Square`, with the given extra `Circle` properties. */
const shapes = (circle: Record<string, unknown>, square: Record<string, unknown> = { side: str }) => ({
  oneOf: [titled('Circle', 'circle', circle), titled('Square', 'square', square)],
});

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
      expect(operation.errors).toEqual([
        { statusCode: 400, type: { kind: 'model', name: 'Error' }, description: 'bad' },
      ]);
      expect(Object.keys(operation.errors[0])).toEqual(['statusCode', 'type', 'description']);
    });

    it('keeps an error with no content, or an empty content map, without the lists', () => {
      const bare = [{ statusCode: 400, type: undefined, description: 'bad' }];
      expect(singleOperation(getWithErrorContent()).operation.errors).toEqual(bare);
      expect(singleOperation(getWithErrorContent({})).operation.errors).toEqual(bare);
    });

    it('keeps the lists on an error whose application/json body has no schema, since `type` says nothing', () => {
      const { operation } = singleOperation(getWithErrorContent({ 'application/json': {} }));
      expect(operation.errors).toEqual([
        {
          statusCode: 400,
          type: undefined,
          description: 'bad',
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

  describe('array and map variants of a union body (Greptile)', () => {
    const union = {
      oneOf: [
        { type: 'array', items: obj({ id: str }) },
        { type: 'object', additionalProperties: obj({ n: str }) },
        str,
      ],
    };

    it("materializes the inline items and values a secondary body's union variants reference", async () => {
      const spec = await parseDocument(
        document({
          '/things': getWith('listThings', {
            'application/json': { schema: str },
            'application/vnd.x+json': { schema: union },
          }),
        }),
      );
      const op = spec.services[0].operations[0];
      const vnd = op.responseContents?.find((c) => c.contentType === 'application/vnd.x+json')?.type;
      expect(vnd?.kind).toBe('union');
      const names = spec.models.map((m) => m.name);
      for (const name of collectModelRefs(vnd!)) expect(names).toContain(name);
    });

    it('keeps an object variant apart from an array variant of the same union (Greptile)', async () => {
      const spec = await parseDocument(
        document({
          '/things': {
            post: {
              operationId: 'createThing',
              requestBody: {
                content: {
                  'application/json': {
                    schema: obj({ f: { oneOf: [obj({ a: str }), { type: 'array', items: obj({ b: str, c: str }) }] } }),
                  },
                },
              },
              responses: { '204': { description: 'ok' } },
            },
          },
        }),
      );
      const fields = (name: string) => spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);
      const field = spec.models.find((m) => m.name === 'CreateThingRequest')?.fields.find((f) => f.name === 'f');
      expect(field?.type).toEqual({
        kind: 'union',
        compositionKind: 'oneOf',
        variants: [
          { kind: 'model', name: 'CreateThingRequestF' },
          { kind: 'array', items: { kind: 'model', name: 'CreateThingRequestFItem' } },
        ],
      });
      expect(fields('CreateThingRequestF')).toEqual(['a']);
      expect(fields('CreateThingRequestFItem')).toEqual(['b', 'c']);
    });

    it('steps the array variant past a real sibling named like its context, and reads a nullable wrapper through (Greptile)', async () => {
      const spec = await parseDocument(
        document({
          '/things': {
            post: {
              operationId: 'createThing',
              requestBody: {
                content: {
                  'application/json': {
                    schema: obj({
                      f: { oneOf: [{ type: 'array', items: obj({ b: str, c: str }) }, str] },
                      f_item: obj({ x: str }),
                      g: { oneOf: [{ oneOf: [{ type: 'array', items: obj({ id: str }) }, { type: 'null' }] }, str] },
                    }),
                  },
                },
              },
              responses: { '204': { description: 'ok' } },
            },
          },
        }),
      );
      const body = spec.models.find((m) => m.name === 'CreateThingRequest');
      const fields = (name: string) => spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);
      const names = spec.models.map((m) => m.name);
      // The sibling keeps its own model; the array variant's items step on.
      expect(body?.fields.find((f) => f.name === 'f_item')?.type).toEqual({
        kind: 'model',
        name: 'CreateThingRequestFItem',
      });
      expect(fields('CreateThingRequestFItem')).toEqual(['x']);
      expect(body?.fields.find((f) => f.name === 'f')?.type).toMatchObject({
        variants: [
          { kind: 'array', items: { kind: 'model', name: 'CreateThingRequestFArrayItem' } },
          { kind: 'primitive' },
        ],
      });
      expect(fields('CreateThingRequestFArrayItem')).toEqual(['b', 'c']);
      // A nullable wrapper around the array variant is read through on both sides.
      const g = body?.fields.find((f) => f.name === 'g')?.type;
      for (const name of collectModelRefs(g!)) expect(names).toContain(name);
      expect(g).toMatchObject({
        variants: [
          { kind: 'nullable', inner: { kind: 'array', items: { kind: 'model', name: 'CreateThingRequestGItem' } } },
          { kind: 'primitive' },
        ],
      });
    });

    it('gives two collection variants of one union models of their own', async () => {
      const spec = await parseDocument(
        document({
          '/things': {
            post: {
              operationId: 'createThing',
              requestBody: {
                content: {
                  'application/json': {
                    schema: obj({
                      f: {
                        oneOf: [
                          { type: 'array', items: obj({ id: str }) },
                          { type: 'array', items: obj({ n: str }) },
                          { type: 'object', additionalProperties: obj({ v: str }) },
                        ],
                      },
                    }),
                  },
                },
              },
              responses: { '204': { description: 'ok' } },
            },
          },
        }),
      );
      const fields = (name: string) => spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);
      const f = spec.models.find((m) => m.name === 'CreateThingRequest')?.fields.find((x) => x.name === 'f')?.type;
      expect(f).toMatchObject({
        variants: [
          { kind: 'array', items: { kind: 'model', name: 'CreateThingRequestFItem' } },
          { kind: 'array', items: { kind: 'model', name: 'CreateThingRequestFArrayItem' } },
          { kind: 'map', valueType: { kind: 'model', name: 'CreateThingRequestFValue' } },
        ],
      });
      expect(fields('CreateThingRequestFItem')).toEqual(['id']);
      expect(fields('CreateThingRequestFArrayItem')).toEqual(['n']);
      expect(fields('CreateThingRequestFValue')).toEqual(['v']);
    });

    it('does the same for a request-body field, which dangled the same way before', async () => {
      const spec = await parseDocument(
        document({
          '/things': {
            post: {
              operationId: 'createThing',
              requestBody: { content: { 'application/json': { schema: obj({ f: union }) } } },
              responses: { '204': { description: 'ok' } },
            },
          },
        }),
      );
      const field = spec.models.find((m) => m.name === 'CreateThingRequest')?.fields.find((f) => f.name === 'f');
      const names = spec.models.map((m) => m.name);
      for (const name of collectModelRefs(field!.type)) expect(names).toContain(name);
    });
  });

  describe('naming against every other model', () => {
    const fieldNames = (spec: ApiSpec, name: string) =>
      spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);
    const vendor = (schema: unknown) => ({
      'application/json': { schema: str },
      'application/vnd.shape+json': { schema },
    });

    it(
      'terminates when a title-mapped variant collides with a differently shaped component, qualifying the variant',
      { timeout: 5000 },
      async () => {
        const spec = await parseDocument(
          document(
            { '/shapes': getWith('listShapes', vendor(shapes({ radius: str }))) },
            { Circle: obj({ diameter: str }) },
          ),
        );
        expect(findOp(spec, 'listShapes').responseContents?.[1].type).toMatchInlineSnapshot(`
          {
            "compositionKind": "oneOf",
            "discriminator": {
              "mapping": {
                "circle": "CircleListShapesApplicationVndShapeJsonResponse",
                "square": "Square",
              },
              "property": "kind",
            },
            "kind": "union",
            "variants": [
              {
                "kind": "model",
                "name": "CircleListShapesApplicationVndShapeJsonResponse",
              },
              {
                "kind": "model",
                "name": "Square",
              },
            ],
          }
        `);
        expect(spec.models.filter((m) => m.name === 'Circle')).toHaveLength(1);
        expect(fieldNames(spec, 'Circle')).toEqual(['diameter']);
        expect(fieldNames(spec, 'CircleListShapesApplicationVndShapeJsonResponse')).toEqual(['kind', 'radius']);
        expect(fieldNames(spec, 'Square')).toEqual(['kind', 'side']);
      },
    );

    it(
      "qualifies a variant whose title another operation's primary body uses for a different shape, and shares it for the same shape",
      { timeout: 5000 },
      async () => {
        const spec = await parseDocument(
          document({
            '/a': getWith('getA', { 'application/json': { schema: shapes({ radius: str }) } }),
            '/b': getWith('getB', vendor(shapes({ diameter: str }))),
            '/c': getWith('getC', vendor(shapes({ radius: str }))),
          }),
        );
        expect(spec.models.filter((m) => m.name === 'Circle')).toHaveLength(1);
        expect(fieldNames(spec, 'Circle')).toEqual(['kind', 'radius']);
        expect(findOp(spec, 'getB').responseContents?.[1].type).toMatchObject({
          kind: 'union',
          variants: [
            { kind: 'model', name: 'CircleGetBApplicationVndShapeJsonResponse' },
            { kind: 'model', name: 'Square' },
          ],
        });
        expect(fieldNames(spec, 'CircleGetBApplicationVndShapeJsonResponse')).toEqual(['kind', 'diameter']);
        // The identical shape shares the primary body's model instead.
        expect(findOp(spec, 'getC').responseContents?.[1].type).toMatchObject({
          kind: 'union',
          variants: [
            { kind: 'model', name: 'Circle' },
            { kind: 'model', name: 'Square' },
          ],
        });
        expect(spec.models.filter((m) => m.name.startsWith('CircleGetC'))).toHaveLength(0);
        expect(spec.models.filter((m) => m.name === 'Square')).toHaveLength(1);
      },
    );

    it("keeps a primary body's titled variant when the vendor alternative of the same operation gives the title another shape", async () => {
      const spec = await parseDocument(
        document({
          '/shapes': getWith('listShapes', {
            'application/json': { schema: shapes({ radius: str }) },
            'application/vnd.shape+json': { schema: shapes({ diameter: str }) },
          }),
        }),
      );
      expect(spec.models.filter((m) => m.name === 'Circle')).toHaveLength(1);
      expect(fieldNames(spec, 'Circle')).toEqual(['kind', 'radius']);
      expect(fieldNames(spec, 'CircleListShapesApplicationVndShapeJsonResponse')).toEqual(['kind', 'diameter']);
      expect(findOp(spec, 'listShapes').response).toMatchObject({
        kind: 'union',
        variants: [
          { kind: 'model', name: 'Circle' },
          { kind: 'model', name: 'Square' },
        ],
      });
    });

    it("steps around another operation's primary response model whose name the derived name would take", async () => {
      const spec = await parseDocument(
        document({
          '/a': getWith('getAApplicationVndXJson', { 'application/json': { schema: obj({ primary: str }) } }),
          '/b': getWith('getA', {
            'application/json': { schema: str },
            'application/vnd.x+json': { schema: obj({ secondary: str }) },
          }),
        }),
      );
      expect(fieldNames(spec, 'GetAApplicationVndXJsonResponse')).toEqual(['primary']);
      expect(findOp(spec, 'getA').responseContents?.[1].type).toEqual({
        kind: 'model',
        name: 'GetAApplicationVndXJsonResponse200',
      });
      expect(fieldNames(spec, 'GetAApplicationVndXJsonResponse200')).toEqual(['secondary']);
    });

    it(
      'settles on the first candidate and reports, rather than looping, when a nested title-mapped variant cannot leave a taken name',
      { timeout: 5000 },
      async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const spec = await parseDocument(
          document(
            { '/shapes': getWith('listShapes', vendor(obj({ shape: shapes({ radius: str }) }))) },
            { Circle: obj({ diameter: str }) },
          ),
        );
        // The component keeps its name and shape; the body keeps its plain name.
        expect(fieldNames(spec, 'Circle')).toEqual(['diameter']);
        expect(findOp(spec, 'listShapes').responseContents?.[1].type).toEqual({
          kind: 'model',
          name: 'ListShapesApplicationVndShapeJsonResponse',
        });
        expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(
          '[oagen] Warning: No free model name for application/vnd.shape+json on 200 of listShapes: "Circle" already name a different shape — keeping the existing definition',
        );
      },
    );

    it('types every array, map, nullable and composition form schemaToTypeRef accepts, materializing each inline object', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const item = obj({ id: str });
      const spec = await parseDocument(
        document(
          {
            '/things': getWith('listThings', {
              'application/json': { schema: { $ref: '#/components/schemas/Thing' } },
              'application/vnd.items-no-type+json': { schema: { items: item } },
              'application/vnd.nullable-array+json': { schema: { type: ['array', 'null'], items: item } },
              'application/vnd.nullable-flag-array+json': { schema: { type: 'array', nullable: true, items: item } },
              'application/vnd.map+json': { schema: { type: 'object', additionalProperties: item } },
              'application/vnd.nullable-map+json': { schema: { type: ['object', 'null'], additionalProperties: item } },
              'application/vnd.map-no-type+json': { schema: { additionalProperties: item } },
              'application/vnd.nullable-object+json': { schema: { type: ['object', 'null'], properties: { id: str } } },
              'application/vnd.oneof-null+json': { schema: { oneOf: [item, { type: 'null' }] } },
              'application/vnd.allof-single+json': { schema: { allOf: [item] } },
              'application/vnd.allof-augmented+json': {
                schema: { allOf: [{ $ref: '#/components/schemas/Thing' }, obj({ extra: str })] },
              },
              'application/vnd.anyof-objects+json': { schema: { anyOf: [obj({ a: str }), obj({ b: str })] } },
              'application/vnd.nested+json': {
                schema: obj({
                  owner: obj({ name: str }),
                  tags: { items: obj({ label: str }) },
                  attrs: { type: 'object', additionalProperties: obj({ value: str }) },
                }),
              },
            }),
          },
          { Thing: obj({ id: str }) },
        ),
      );
      const op = findOp(spec, 'listThings');
      const modelNames = new Set(spec.models.map((m) => m.name));
      for (const content of collectAlternateResponseContents(op)) {
        for (const name of collectModelRefs(content.type)) {
          expect(modelNames, `${content.contentType} → ${name}`).toContain(name);
        }
      }
      // validateModelRefs walks every model's fields too, so a nested dangling ref would show here.
      expect(unresolvedWarnings(warn)).toEqual([]);
      expect(op.responseContents?.slice(1).map((c) => [c.contentType, c.type])).toMatchInlineSnapshot(`
        [
          [
            "application/vnd.items-no-type+json",
            {
              "items": {
                "kind": "model",
                "name": "ListThingsApplicationVndItemsNoTypeJsonResponse",
              },
              "kind": "array",
            },
          ],
          [
            "application/vnd.nullable-array+json",
            {
              "inner": {
                "items": {
                  "kind": "model",
                  "name": "ListThingsApplicationVndNullableArrayJsonResponse",
                },
                "kind": "array",
              },
              "kind": "nullable",
            },
          ],
          [
            "application/vnd.nullable-flag-array+json",
            {
              "inner": {
                "items": {
                  "kind": "model",
                  "name": "ListThingsApplicationVndNullableFlagArrayJsonResponse",
                },
                "kind": "array",
              },
              "kind": "nullable",
            },
          ],
          [
            "application/vnd.map+json",
            {
              "kind": "map",
              "valueType": {
                "kind": "model",
                "name": "ListThingsApplicationVndMapJsonResponse",
              },
            },
          ],
          [
            "application/vnd.nullable-map+json",
            {
              "inner": {
                "kind": "map",
                "valueType": {
                  "kind": "model",
                  "name": "ListThingsApplicationVndNullableMapJsonResponse",
                },
              },
              "kind": "nullable",
            },
          ],
          [
            "application/vnd.map-no-type+json",
            {
              "kind": "primitive",
              "type": "unknown",
            },
          ],
          [
            "application/vnd.nullable-object+json",
            {
              "inner": {
                "kind": "model",
                "name": "ListThingsApplicationVndNullableObjectJsonResponse",
              },
              "kind": "nullable",
            },
          ],
          [
            "application/vnd.oneof-null+json",
            {
              "inner": {
                "kind": "model",
                "name": "ListThingsApplicationVndOneofNullJsonResponse",
              },
              "kind": "nullable",
            },
          ],
          [
            "application/vnd.allof-single+json",
            {
              "kind": "model",
              "name": "ListThingsApplicationVndAllofSingleJsonResponse",
            },
          ],
          [
            "application/vnd.allof-augmented+json",
            {
              "kind": "model",
              "name": "ListThingsApplicationVndAllofAugmentedJsonResponse",
            },
          ],
          [
            "application/vnd.anyof-objects+json",
            {
              "compositionKind": "anyOf",
              "kind": "union",
              "variants": [
                {
                  "kind": "model",
                  "name": "ListThingsApplicationVndAnyofObjectsJsonResponse",
                },
                {
                  "kind": "model",
                  "name": "ListThingsApplicationVndAnyofObjectsJsonResponseWithB",
                },
              ],
            },
          ],
          [
            "application/vnd.nested+json",
            {
              "kind": "model",
              "name": "ListThingsApplicationVndNestedJsonResponse",
            },
          ],
        ]
      `);
      expect(
        spec.models.filter((m) => m.name.startsWith('ListThings')).map((m) => [m.name, m.fields.map((f) => f.name)]),
      ).toMatchInlineSnapshot(`
        [
          [
            "ListThingsApplicationVndItemsNoTypeJsonResponse",
            [
              "id",
            ],
          ],
          [
            "ListThingsApplicationVndNullableArrayJsonResponse",
            [
              "id",
            ],
          ],
          [
            "ListThingsApplicationVndNullableFlagArrayJsonResponse",
            [
              "id",
            ],
          ],
          [
            "ListThingsApplicationVndMapJsonResponse",
            [
              "id",
            ],
          ],
          [
            "ListThingsApplicationVndNullableMapJsonResponse",
            [
              "id",
            ],
          ],
          [
            "ListThingsApplicationVndNullableObjectJsonResponse",
            [
              "id",
            ],
          ],
          [
            "ListThingsApplicationVndOneofNullJsonResponse",
            [
              "id",
            ],
          ],
          [
            "ListThingsApplicationVndAllofSingleJsonResponse",
            [
              "id",
            ],
          ],
          [
            "ListThingsApplicationVndAllofAugmentedJsonResponse",
            [
              "id",
              "extra",
            ],
          ],
          [
            "ListThingsApplicationVndAnyofObjectsJsonResponse",
            [
              "a",
            ],
          ],
          [
            "ListThingsApplicationVndAnyofObjectsJsonResponseWithB",
            [
              "b",
            ],
          ],
          [
            "ListThingsApplicationVndNestedJsonResponse",
            [
              "owner",
              "tags",
              "attrs",
            ],
          ],
          [
            "ListThingsApplicationVndNestedJsonResponseOwner",
            [
              "name",
            ],
          ],
          [
            "ListThingsApplicationVndNestedJsonResponseTags",
            [
              "label",
            ],
          ],
          [
            "ListThingsApplicationVndNestedJsonResponseAttr",
            [
              "value",
            ],
          ],
        ]
      `);
    });

    it('renames a nested enum of a secondary body whose name a component enum owns with other values', async () => {
      const spec = await parseDocument(
        document(
          {
            '/reports': getWith('getReport', {
              'application/json': { schema: { $ref: '#/components/schemas/Report' } },
              'application/vnd.api+json': {
                schema: obj({
                  status: { type: 'string', enum: ['x', 'y'] },
                  meta: obj({ level: { type: 'string', enum: ['low', 'high'] } }),
                }),
              },
            }),
          },
          {
            Report: obj({ id: str }),
            GetReportApplicationVndApiJsonResponseStatus: { type: 'string', enum: ['a', 'b'] },
            GetReportApplicationVndApiJsonResponseMetaLevel: { type: 'string', enum: ['one', 'two'] },
          },
        ),
      );
      const fieldType = (model: string, field: string) =>
        spec.models.find((m) => m.name === model)?.fields.find((f) => f.name === field)?.type;
      const values = (name: string) => spec.enums.find((e) => e.name === name)?.values.map((v) => v.value);
      expect(fieldType('GetReportApplicationVndApiJsonResponse', 'status')).toMatchObject({
        kind: 'enum',
        name: 'GetReportApplicationVndApiJsonResponseStatus2',
      });
      expect(fieldType('GetReportApplicationVndApiJsonResponseMeta', 'level')).toMatchObject({
        kind: 'enum',
        name: 'GetReportApplicationVndApiJsonResponseMetaLevel2',
      });
      // The component enums keep their values; the body's get their own names.
      expect(values('GetReportApplicationVndApiJsonResponseStatus')).toEqual(['a', 'b']);
      expect(values('GetReportApplicationVndApiJsonResponseStatus2')).toEqual(['x', 'y']);
      expect(values('GetReportApplicationVndApiJsonResponseMetaLevel')).toEqual(['one', 'two']);
      expect(values('GetReportApplicationVndApiJsonResponseMetaLevel2')).toEqual(['low', 'high']);
    });

    it('renames a nested enum of the primary application/json body the same way (Greptile)', async () => {
      const spec = await parseDocument(
        document(
          {
            '/reports': getWith('getReport', {
              'application/json': { schema: obj({ status: { type: 'string', enum: ['open', 'closed'] } }) },
            }),
          },
          { GetReportResponseStatus: { type: 'string', enum: ['x', 'y'] } },
        ),
      );
      const field = spec.models.find((m) => m.name === 'GetReportResponse')?.fields.find((f) => f.name === 'status');
      expect(field?.type).toMatchObject({ kind: 'enum', name: 'GetReportResponseStatus2' });
      const values = (name: string) => spec.enums.find((e) => e.name === name)?.values.map((v) => v.value);
      expect(values('GetReportResponseStatus')).toEqual(['x', 'y']);
      expect(values('GetReportResponseStatus2')).toEqual(['open', 'closed']);
    });

    it("renames a nested enum of a header's model the same way", async () => {
      // A singular service name, so the component's name survives cleanSchemaName
      // unchanged and genuinely collides with the header model's field enum.
      const spec = await parseDocument(
        document(
          {
            '/inventory': getWith(
              'getInventory',
              { 'application/json': { schema: str } },
              {},
              { 'X-Meta': { schema: obj({ policy: { type: 'string', enum: ['fast', 'slow'] } }) } },
            ),
          },
          { InventoryXMetaPolicy: { type: 'string', enum: ['retry', 'stop'] } },
        ),
      );
      const meta = spec.models.find((m) => m.name === 'InventoryXMeta');
      expect(meta?.fields[0].type).toMatchObject({ kind: 'enum', name: 'InventoryXMetaPolicy2' });
      expect(spec.enums.find((e) => e.name === 'InventoryXMetaPolicy')?.values.map((v) => v.value)).toEqual([
        'retry',
        'stop',
      ]);
      expect(spec.enums.find((e) => e.name === 'InventoryXMetaPolicy2')?.values.map((v) => v.value)).toEqual([
        'fast',
        'slow',
      ]);
    });

    it('keeps separate models for bodies whose fields differ only in their limits', () => {
      const body = (minLength: number) => obj({ name: { type: 'string', minLength } });
      const { operation, inlineModels } = singleOperation({
        '/things': {
          get: {
            operationId: 'listThings',
            responses: {
              '200': { description: 'ok', content: vendor(body(1)) },
              '201': { description: 'ok', content: vendor(body(5)) },
            },
          },
        },
      });
      expect(operation.successResponses!.map((r) => r.contents![1].type)).toEqual([
        { kind: 'model', name: 'ListThingsApplicationVndShapeJsonResponse' },
        { kind: 'model', name: 'ListThingsApplicationVndShapeJsonResponse201' },
      ]);
      expect(inlineModels.map((m) => [m.name, m.fields[0].constraints])).toEqual([
        ['ListThingsApplicationVndShapeJsonResponse', { minLength: 1 }],
        ['ListThingsApplicationVndShapeJsonResponse201', { minLength: 5 }],
      ]);
    });

    it('keeps separate models for bodies that differ only in their own limits', () => {
      const body = (minProperties: number) => obj({ name: str }, { minProperties });
      const { operation, inlineModels } = singleOperation({
        '/things': {
          get: {
            operationId: 'listThings',
            responses: {
              '200': { description: 'ok', content: vendor(body(1)) },
              '201': { description: 'ok', content: vendor(body(2)) },
            },
          },
        },
      });
      expect(operation.successResponses!.map((r) => r.contents![1].type)).toEqual([
        { kind: 'model', name: 'ListThingsApplicationVndShapeJsonResponse' },
        { kind: 'model', name: 'ListThingsApplicationVndShapeJsonResponse201' },
      ]);
      expect(inlineModels.map((m) => [m.name, m.constraints])).toEqual([
        ['ListThingsApplicationVndShapeJsonResponse', { minProperties: 1 }],
        ['ListThingsApplicationVndShapeJsonResponse201', { minProperties: 2 }],
      ]);
    });

    it('keeps separate header models for headers that differ only in their limits', () => {
      const meta = (maxLength: number) => ({ schema: obj({ etag: { type: 'string', maxLength } }) });
      const { operation, inlineModels } = singleOperation({
        '/documents': {
          get: {
            operationId: 'listDocuments',
            responses: {
              '200': { description: 'ok', headers: { 'X-Meta': meta(10) } },
              '429': { description: 'throttled', headers: { 'X-Meta': meta(20) } },
            },
          },
        },
      });
      expect(operation.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta' });
      expect(operation.errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta429' });
      expect(inlineModels.map((m) => [m.name, m.fields[0].constraints])).toEqual([
        ['DocumentsXMeta', { maxLength: 10 }],
        ['DocumentsXMeta429', { maxLength: 20 }],
      ]);
    });

    it('shares one model for bodies whose shapes differ only in documentation', () => {
      const body = (description: string) => obj({ name: { type: 'string', description } });
      const { operation, inlineModels } = singleOperation({
        '/things': {
          get: {
            operationId: 'listThings',
            responses: {
              '200': { description: 'ok', content: vendor(body('The name.')) },
              '201': { description: 'ok', content: vendor(body('Its name.')) },
            },
          },
        },
      });
      expect(operation.successResponses!.map((r) => r.contents![1].type)).toEqual([
        { kind: 'model', name: 'ListThingsApplicationVndShapeJsonResponse' },
        { kind: 'model', name: 'ListThingsApplicationVndShapeJsonResponse' },
      ]);
      expect(inlineModels).toHaveLength(1);
    });
  });

  describe('one precedence for an ambiguous schema', () => {
    /** Each form carries two keywords that could type it; `classifyInlineSchema` picks one for every site. */
    const ambiguous = {
      itemsOneOf: { items: obj({ id: str }), oneOf: [obj({ a: str }), obj({ b: str })] },
      itemsProperties: { items: obj({ id: str }), properties: { name: str } },
      propertiesAdditional: { type: 'object', properties: { name: str }, additionalProperties: obj({ value: str }) },
      oneOfProperties: { properties: { name: str }, oneOf: [obj({ a: str }), obj({ b: str })] },
      allOfOneOf: { allOf: [obj({ base: str })], oneOf: [obj({ a: str }), obj({ b: str })] },
    };

    it('types and materializes each form the same way under a secondary media type and as a component field', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(
        document(
          {
            '/things': getWith('listThings', {
              'application/json': { schema: { $ref: '#/components/schemas/Thing' } },
              'application/vnd.items-oneof+json': { schema: ambiguous.itemsOneOf },
              'application/vnd.items-properties+json': { schema: ambiguous.itemsProperties },
              'application/vnd.properties-additional+json': { schema: ambiguous.propertiesAdditional },
              'application/vnd.oneof-properties+json': { schema: ambiguous.oneOfProperties },
              'application/vnd.allof-oneof+json': { schema: ambiguous.allOfOneOf },
            }),
          },
          // `Puzzle`, not `Ambiguous`: cleanSchemaName would singularize the latter.
          { Thing: obj({ id: str }), Puzzle: obj(ambiguous) },
        ),
      );
      const op = findOp(spec, 'listThings');
      const modelNames = new Set(spec.models.map((m) => m.name));
      for (const content of collectAlternateResponseContents(op)) {
        for (const name of collectModelRefs(content.type)) {
          expect(modelNames, `${content.contentType} → ${name}`).toContain(name);
        }
      }
      const puzzle = spec.models.find((m) => m.name === 'Puzzle');
      expect(puzzle).toBeDefined();
      for (const field of puzzle?.fields ?? []) {
        for (const name of collectModelRefs(field.type))
          expect(modelNames, `Puzzle.${field.name} → ${name}`).toContain(name);
      }
      expect(unresolvedWarnings(warn)).toEqual([]);
      // No two extractors may mint one name for different shapes.
      expect(warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes('Two inline models'))).toEqual([]);

      // `oneOf` wins over `items`: the union's variants are the models, and
      // no item model takes the first variant's name.
      expect(typeOf(op, 'application/vnd.items-oneof+json')).toMatchObject({
        kind: 'union',
        variants: [
          { kind: 'model', name: 'ListThingsApplicationVndItemsOneofJsonResponse' },
          { kind: 'model', name: 'ListThingsApplicationVndItemsOneofJsonResponseWithB' },
        ],
      });
      expect(fieldsOf(spec, 'ListThingsApplicationVndItemsOneofJsonResponse')).toEqual(['a']);
      expect(fieldsOf(spec, 'ListThingsApplicationVndItemsOneofJsonResponseWithB')).toEqual(['b']);
      // `items` wins over `properties`.
      expect(typeOf(op, 'application/vnd.items-properties+json')).toEqual({
        kind: 'array',
        items: { kind: 'model', name: 'ListThingsApplicationVndItemsPropertiesJsonResponse' },
      });
      expect(fieldsOf(spec, 'ListThingsApplicationVndItemsPropertiesJsonResponse')).toEqual(['id']);
      // `properties` wins over `additionalProperties`.
      expect(typeOf(op, 'application/vnd.properties-additional+json')).toEqual({
        kind: 'model',
        name: 'ListThingsApplicationVndPropertiesAdditionalJsonResponse',
      });
      expect(fieldsOf(spec, 'ListThingsApplicationVndPropertiesAdditionalJsonResponse')).toContain('name');
      // `oneOf` wins over `properties`.
      expect(typeOf(op, 'application/vnd.oneof-properties+json')).toMatchObject({ kind: 'union' });
      expect(fieldsOf(spec, 'ListThingsApplicationVndOneofPropertiesJsonResponse')).toEqual(['a']);
      // `allOf` wins over `oneOf`.
      expect(typeOf(op, 'application/vnd.allof-oneof+json')).toEqual({
        kind: 'model',
        name: 'ListThingsApplicationVndAllofOneofJsonResponse',
      });
      expect(fieldsOf(spec, 'ListThingsApplicationVndAllofOneofJsonResponse')).toEqual(['base']);

      // The same forms as fields of a component model, through the component
      // and general extractors — which must agree with each other too.
      const fieldType = (name: string) => puzzle?.fields.find((f) => f.name === name)?.type;
      expect(fieldType('itemsOneOf')).toMatchObject({
        kind: 'union',
        variants: [
          { kind: 'model', name: 'PuzzleItemsOneOf' },
          { kind: 'model', name: 'PuzzleItemsOneOfWithB' },
        ],
      });
      expect(fieldsOf(spec, 'PuzzleItemsOneOf')).toEqual(['a']);
      expect(fieldType('itemsProperties')).toEqual({
        kind: 'array',
        items: { kind: 'model', name: 'PuzzleItemsProperty' },
      });
      expect(fieldsOf(spec, 'PuzzleItemsProperty')).toEqual(['id']);
      expect(fieldType('propertiesAdditional')).toEqual({ kind: 'model', name: 'PuzzlePropertiesAdditional' });
      expect(fieldType('oneOfProperties')).toMatchObject({ kind: 'union' });
      expect(fieldsOf(spec, 'PuzzleOneOfProperty')).toEqual(['a']);
      expect(fieldType('allOfOneOf')).toEqual({ kind: 'model', name: 'PuzzleAllOfOneOf' });
      expect(fieldsOf(spec, 'PuzzleAllOfOneOf')).toEqual(['base']);
    });
  });

  describe('media type essence', () => {
    it('types a secondary media type by its essence — parameters stripped, case folded — and keeps the key as written', () => {
      const { operation, inlineModels } = singleOperation(
        getWithContent({
          'application/json': { schema: str },
          'application/pdf; version=1.7': {},
          'TEXT/PLAIN; charset=utf-8': { schema: obj({ ignored: str }) },
          'Application/JSON': { schema: { $ref: '#/components/schemas/Thing' } },
          'image/PNG': { schema: { type: 'string', format: 'binary' } },
        }),
      );
      expect(operation.responseContentTypes).toEqual([
        'application/json',
        'application/pdf; version=1.7',
        'TEXT/PLAIN; charset=utf-8',
        'Application/JSON',
        'image/PNG',
      ]);
      expect(operation.responseContents?.slice(1).map((c) => c.type)).toEqual([
        { kind: 'primitive', type: 'string', format: 'binary' },
        { kind: 'primitive', type: 'string' },
        { kind: 'model', name: 'Thing' },
        { kind: 'primitive', type: 'string', format: 'binary' },
      ]);
      // The text body's object schema is not read, so no model is minted for it.
      expect(inlineModels).toEqual([]);
    });
  });

  describe('allOf members that only add limits', () => {
    /** The reviewer's schema: an object whose `allOf` carries nothing but limits. */
    const constraintOnly = obj({ id: str }, { allOf: [{ minProperties: 1 }, { maxProperties: 3 }] });
    const refPlusLimits = { allOf: [{ $ref: '#/components/schemas/Thing' }, { minProperties: 1 }] };
    const propsPlusLimits = { allOf: [obj({ a: str }), { minProperties: 1 }] };

    it('types such a schema from its own keywords, carrying the conjoined limits, wherever it appears', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(
        document(
          {
            '/things': getWith('listThings', {
              'application/json': { schema: { $ref: '#/components/schemas/Thing' } },
              'application/vnd.limits+json': { schema: constraintOnly },
              'application/vnd.ref-limits+json': { schema: refPlusLimits },
              'application/vnd.props-limits+json': { schema: propsPlusLimits },
            }),
          },
          {
            Thing: obj({ id: str }),
            Limited: obj({
              constraintOnly,
              lone: obj({ id: str }, { allOf: [{ minProperties: 1 }] }),
              typedMember: obj({ id: str }, { allOf: [{ type: 'object' }, { minProperties: 1 }] }),
              nested: obj({ constraintOnly }),
              list: { type: 'array', items: constraintOnly },
              referenced: refPlusLimits,
              merged: propsPlusLimits,
              text: { type: 'string', allOf: [{ minLength: 1 }, { maxLength: 5 }] },
            }),
          },
        ),
      );
      const model = (name: string) => spec.models.find((m) => m.name === name);
      const op = findOp(spec, 'listThings');

      // Under a secondary media type.
      expect(typeOf(op, 'application/vnd.limits+json')).toEqual({
        kind: 'model',
        name: 'ListThingsApplicationVndLimitsJsonResponse',
      });
      expect(model('ListThingsApplicationVndLimitsJsonResponse')).toMatchObject({
        fields: [{ name: 'id' }],
        constraints: { minProperties: 1, maxProperties: 3 },
      });
      expect(typeOf(op, 'application/vnd.ref-limits+json')).toEqual({ kind: 'model', name: 'Thing' });
      expect(typeOf(op, 'application/vnd.props-limits+json')).toEqual({
        kind: 'model',
        name: 'ListThingsApplicationVndPropsLimitsJsonResponse',
      });
      expect(model('ListThingsApplicationVndPropsLimitsJsonResponse')).toMatchObject({ fields: [{ name: 'a' }] });

      // As component fields, nested, and as array items.
      const limited = model('Limited');
      const field = (name: string) => limited?.fields.find((f) => f.name === name);
      expect(field('constraintOnly')).toMatchObject({
        type: { kind: 'model', name: 'LimitedConstraintOnly' },
        constraints: { minProperties: 1, maxProperties: 3 },
      });
      expect(model('LimitedConstraintOnly')).toMatchObject({
        fields: [{ name: 'id' }],
        constraints: { minProperties: 1, maxProperties: 3 },
      });
      // A lone limits-only member types nothing on its own, so the schema's
      // properties do (main unwrapped it into `unknown`).
      expect(field('lone')).toMatchObject({
        type: { kind: 'model', name: 'LimitedLone' },
        constraints: { minProperties: 1 },
      });
      expect(model('LimitedLone')).toMatchObject({ fields: [{ name: 'id' }] });
      // A bare `type: 'object'` member adds no structure either.
      expect(field('typedMember')).toMatchObject({ type: { kind: 'model', name: 'LimitedTypedMember' } });
      expect(model('LimitedNestedConstraintOnly')).toMatchObject({
        fields: [{ name: 'id' }],
        constraints: { minProperties: 1, maxProperties: 3 },
      });
      expect(field('list')).toMatchObject({ type: { kind: 'array', items: { kind: 'model', name: 'LimitedList' } } });
      expect(model('LimitedList')).toMatchObject({
        fields: [{ name: 'id' }],
        constraints: { minProperties: 1, maxProperties: 3 },
      });
      // A `$ref` member or a member with properties still types the allOf.
      expect(field('referenced')).toMatchObject({
        type: { kind: 'model', name: 'Thing' },
        constraints: { minProperties: 1 },
      });
      expect(field('merged')).toMatchObject({ type: { kind: 'model', name: 'LimitedMerged' } });
      expect(model('LimitedMerged')).toMatchObject({ fields: [{ name: 'a' }] });
      expect(field('text')).toMatchObject({
        type: { kind: 'primitive', type: 'string' },
        constraints: { minLength: 1, maxLength: 5 },
      });

      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages.filter((m) => m.includes('Unknown schema shape'))).toEqual([]);
      expect(messages.filter((m) => m.includes('Unresolved'))).toEqual([]);
    });
  });
});

describe('beside default and range responses', () => {
  const fieldNames = (spec: ApiSpec, name: string) =>
    spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);
  const json = (schema: unknown) => ({ 'application/json': { schema } });

  it(
    'names a fallback body and a secondary body of one operation against each other, in document order',
    { timeout: 5000 },
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // The vendor body comes first in the document, so its `Circle` keeps the
      // title; the default's differently shaped `Circle` takes its
      // context-qualified name and the identical `Square` is shared.
      const spec = await parseDocument(
        document({
          '/shapes': getWith(
            'listShapes',
            { 'application/json': { schema: str }, 'application/vnd.shape+json': { schema: shapes({ radius: str }) } },
            { default: { description: 'd', content: json(shapes({ diameter: str })) } },
          ),
        }),
      );
      const op = findOp(spec, 'listShapes');

      expect(op.responseContents?.[1].type).toMatchObject({
        kind: 'union',
        variants: [
          { kind: 'model', name: 'Circle' },
          { kind: 'model', name: 'Square' },
        ],
      });
      expect(op.defaultResponse).toMatchObject({
        description: 'd',
        type: {
          kind: 'union',
          variants: [
            { kind: 'model', name: 'CircleListShapesDefaultResponse' },
            { kind: 'model', name: 'Square' },
          ],
        },
      });
      expect(fieldNames(spec, 'Circle')).toEqual(['kind', 'radius']);
      expect(fieldNames(spec, 'CircleListShapesDefaultResponse')).toEqual(['kind', 'diameter']);
      expect(spec.models.filter((m) => m.name === 'Square')).toHaveLength(1);
      expect(spec.models.filter((m) => m.name === 'Circle')).toHaveLength(1);
      expect(warn.mock.calls).toEqual([]);
    },
  );

  it('reaches a model declared only under a fallback body through collectResponseBodyTypes, beside a secondary body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(
      document({
        '/things': getWith(
          'listThings',
          { 'application/json': { schema: str }, 'application/vnd.thing+json': { schema: obj({ id: str }) } },
          {
            '4XX': { description: 'rejected', content: json(obj({ code: str })) },
            default: { description: 'd', content: json(obj({ message: str })) },
          },
        ),
      }),
    );
    const op = findOp(spec, 'listThings');

    expect(collectResponseBodyTypes(op)).toEqual([
      {
        type: { kind: 'model', name: 'ListThingsApplicationVndThingJsonResponse' },
        source: 'contents.application/vnd.thing+json',
      },
      { type: { kind: 'model', name: 'ListThingsDefaultResponse' }, source: 'defaultResponse' },
      { type: { kind: 'model', name: 'ListThingsClientErrorResponse' }, source: 'rangeResponses.4XX' },
    ]);
    for (const name of [
      'ListThingsApplicationVndThingJsonResponse',
      'ListThingsDefaultResponse',
      'ListThingsClientErrorResponse',
    ]) {
      expect(fieldNames(spec, name)).toBeDefined();
      expect(assignModelsToServices(spec.models, spec.services).get(name)).toBe('Things');
    }
    expect(warn.mock.calls).toEqual([]);

    // A fallback ref nothing defines is reported under the source `collectResponseBodyTypes` gives it.
    op.rangeResponses![0].type = { kind: 'model', name: 'Missing' };
    validateModelRefs(spec);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unresolved model reference "Missing" (context: Things.listThings.rangeResponses.4XX)'),
    );
  });
});
