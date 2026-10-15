import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { collectInlineEnumsFromOperations } from '../../src/parser/collect-inline-enums.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { collectResponseHeaders, collectModelRefs } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Enum, Model, Operation } from '../../src/ir/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/response-headers.yml');

type ComponentHeaders = Record<string, Record<string, unknown>>;

/** Extract the only operation declared in an inline paths object. */
function singleOperation(paths: Record<string, unknown>, componentHeaders?: ComponentHeaders): Operation {
  const { services } = extractOperations(
    paths as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    componentHeaders,
  );
  const operations = services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return operations[0];
}

/** A GET /documents operation whose 200 declares the given headers (or none). */
function getWithResponses(responses: Record<string, unknown>) {
  return { '/documents': { get: { operationId: 'listDocuments', responses } } };
}

describe('response headers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('through parseSpec (issue #186 repro)', () => {
    it('keeps Content-Disposition on the primary response', async () => {
      const spec = await parseSpec(FIXTURE);
      const op = spec.services.flatMap((s) => s.operations).find((o) => o.path === '/documents/{id}/download')!;

      expect(op.response).toEqual({ kind: 'primitive', type: 'string', format: 'binary' });
      // A single 2xx: successResponses stays unset, so responseHeaders is the only home.
      expect(op.successResponses).toBeUndefined();
      expect(Object.keys(op)).toContain('responseHeaders');
      expect(op.responseHeaders).toMatchInlineSnapshot(`
        [
          {
            "deprecated": undefined,
            "description": "Offers the file as a download named after the document.",
            "name": "Content-Disposition",
            "required": false,
            "type": {
              "kind": "primitive",
              "type": "string",
            },
          },
        ]
      `);
    });

    it('materializes an object-shaped header into spec.models with no unresolved refs', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseSpec(FIXTURE);
      const op = spec.services.flatMap((s) => s.operations).find((o) => o.path === '/documents/{id}/meta')!;

      expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta' });
      const modelFields = (name: string) => spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);
      expect(modelFields('DocumentsXMeta')).toEqual(['etag', 'origin']);
      expect(modelFields('DocumentsXMetaOrigin')).toEqual(['region']);
      const unresolved = warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes('Unresolved'));
      expect(unresolved).toEqual([]);
    });

    it('resolves components/headers refs, including a header declared via content', async () => {
      const spec = await parseSpec(FIXTURE);
      const op = spec.services
        .flatMap((s) => s.operations)
        .find((o) => o.path === '/documents' && o.httpMethod === 'post')!;

      expect(op.responseHeaders).toMatchInlineSnapshot(`
        [
          {
            "deprecated": undefined,
            "description": "URL of the created document.",
            "name": "Location",
            "required": true,
            "type": {
              "format": "uri",
              "kind": "primitive",
              "type": "string",
            },
          },
          {
            "deprecated": undefined,
            "description": "Correlation id for this request.",
            "name": "X-Request-Id",
            "required": false,
            "type": {
              "kind": "primitive",
              "type": "string",
            },
          },
        ]
      `);
      expect(op.errors).toMatchInlineSnapshot(`
        [
          {
            "headers": [
              {
                "deprecated": undefined,
                "description": "Seconds to wait before retrying.",
                "name": "Retry-After",
                "required": false,
                "type": {
                  "kind": "primitive",
                  "type": "integer",
                },
              },
            ],
            "statusCode": 429,
            "type": undefined,
          },
        ]
      `);
    });
  });

  describe('extractOperations', () => {
    it('types a header from its schema and defaults required to false', () => {
      const op = singleOperation(
        getWithResponses({
          '200': {
            description: 'ok',
            headers: {
              ETag: { description: 'Entity tag.', schema: { type: 'string' } },
              'X-Total-Count': { required: true, deprecated: true, schema: { type: 'integer', format: 'int64' } },
            },
          },
        }),
      );

      expect(op.responseHeaders).toMatchInlineSnapshot(`
        [
          {
            "deprecated": undefined,
            "description": "Entity tag.",
            "name": "ETag",
            "required": false,
            "type": {
              "kind": "primitive",
              "type": "string",
            },
          },
          {
            "deprecated": true,
            "description": undefined,
            "name": "X-Total-Count",
            "required": true,
            "type": {
              "format": "int64",
              "kind": "primitive",
              "type": "integer",
            },
          },
        ]
      `);
    });

    it('uses the first media type schema when a header declares content instead of schema', () => {
      const op = singleOperation(
        getWithResponses({
          '200': {
            description: 'ok',
            headers: { 'Retry-After': { content: { 'text/plain': { schema: { type: 'integer' } } } } },
          },
        }),
      );

      expect(op.responseHeaders?.[0].type).toEqual({ kind: 'primitive', type: 'integer' });
    });

    it('falls back to string when a header has neither schema nor content', () => {
      const op = singleOperation(
        getWithResponses({ '200': { description: 'ok', headers: { 'X-Opaque': { description: 'Untyped.' } } } }),
      );

      expect(op.responseHeaders?.[0]).toMatchObject({
        name: 'X-Opaque',
        type: { kind: 'primitive', type: 'string' },
        required: false,
      });
    });

    it('attaches headers to each 2xx entry and mirrors the primary entry on responseHeaders', () => {
      const op = singleOperation(
        getWithResponses({
          '200': {
            description: 'ok',
            headers: { ETag: { schema: { type: 'string' } } },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Document' } } },
          },
          '202': { description: 'accepted', headers: { 'Retry-After': { schema: { type: 'integer' } } } },
          '204': { description: 'no content' },
        }),
      );

      expect(op.successResponses?.map((r) => [r.statusCode, r.headers?.map((h) => h.name)])).toEqual([
        [200, ['ETag']],
        [202, ['Retry-After']],
        [204, undefined],
      ]);
      // The 204 declares no headers, so the key is left off entirely.
      expect('headers' in op.successResponses![2]).toBe(false);
      // Primary = lowest 2xx with a body (200), so responseHeaders is that entry's list.
      expect(op.responseHeaders).toBe(op.successResponses![0].headers);
    });

    it('keeps Location on a 3xx redirect', () => {
      const op = singleOperation(
        getWithResponses({
          '302': { description: 'redirect', headers: { Location: { required: true, schema: { type: 'string' } } } },
        }),
      );

      expect(op.response).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(op.responseHeaders).toEqual([
        { name: 'Location', type: { kind: 'primitive', type: 'string' }, required: true },
      ]);
    });

    it('keeps headers on error responses', () => {
      const op = singleOperation(
        getWithResponses({
          '200': { description: 'ok' },
          '404': { description: 'missing' },
          '429': {
            description: 'throttled',
            headers: { 'Retry-After': { description: 'Seconds to wait.', schema: { type: 'integer' } } },
          },
        }),
      );

      expect(op.errors).toMatchInlineSnapshot(`
        [
          {
            "statusCode": 404,
            "type": undefined,
          },
          {
            "headers": [
              {
                "deprecated": undefined,
                "description": "Seconds to wait.",
                "name": "Retry-After",
                "required": false,
                "type": {
                  "kind": "primitive",
                  "type": "integer",
                },
              },
            ],
            "statusCode": 429,
            "type": undefined,
          },
        ]
      `);
      expect('headers' in op.errors[0]).toBe(false);
    });

    it('leaves the header keys off when a response declares none', () => {
      const op = singleOperation(getWithResponses({ '200': { description: 'ok' }, '500': { description: 'boom' } }));

      expect('responseHeaders' in op).toBe(false);
      expect('headers' in op.errors[0]).toBe(false);
    });

    it('ignores a header named Content-Type, as OpenAPI requires', () => {
      const op = singleOperation(
        getWithResponses({
          '200': {
            description: 'ok',
            headers: { 'content-type': { schema: { type: 'string' } }, ETag: { schema: { type: 'string' } } },
          },
        }),
      );

      expect(op.responseHeaders?.map((h) => h.name)).toEqual(['ETag']);
    });

    it('resolves a components/headers $ref through a chain and JSON pointer escapes', () => {
      const componentHeaders: ComponentHeaders = {
        'Rate/Limit': { description: 'Requests allowed per window.', required: true, schema: { type: 'integer' } },
        LimitAlias: { $ref: '#/components/headers/Rate~1Limit' },
      };
      const op = singleOperation(
        getWithResponses({
          '200': { description: 'ok', headers: { 'X-RateLimit-Limit': { $ref: '#/components/headers/LimitAlias' } } },
        }),
        componentHeaders,
      );

      expect(op.responseHeaders).toEqual([
        {
          name: 'X-RateLimit-Limit',
          type: { kind: 'primitive', type: 'integer' },
          required: true,
          description: 'Requests allowed per window.',
          deprecated: undefined,
        },
      ]);
    });

    it('warns and skips an unresolvable header $ref instead of failing the parse', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const op = singleOperation(
        getWithResponses({
          '200': {
            description: 'ok',
            headers: {
              'X-Missing': { $ref: '#/components/headers/Missing' },
              ETag: { schema: { type: 'string' } },
            },
          },
        }),
        {},
      );

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /^\[oagen\] Warning: Unresolved header \$ref "#\/components\/headers\/Missing" for response header "X-Missing" in listDocuments/,
      );
      // The dangling header is dropped; its siblings survive.
      expect(op.responseHeaders?.map((h) => h.name)).toEqual(['ETag']);
    });

    it('warns and skips a $ref that points outside components/headers', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const op = singleOperation(
        getWithResponses({
          '200': { description: 'ok', headers: { 'X-Id': { $ref: '#/components/parameters/X-Id' } } },
        }),
        { 'X-Id': { schema: { type: 'string' } } },
      );

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/Unresolved header \$ref "#\/components\/parameters\/X-Id"/);
      // Nothing survived, so the key is left off rather than set to [].
      expect('responseHeaders' in op).toBe(false);
    });

    it('warns and skips a circular header $ref chain', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const op = singleOperation(
        getWithResponses({ '200': { description: 'ok', headers: { 'X-Loop': { $ref: '#/components/headers/A' } } } }),
        { A: { $ref: '#/components/headers/B' }, B: { $ref: '#/components/headers/A' } },
      );

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /^\[oagen\] Warning: Circular header \$ref chain starting at "#\/components\/headers\/A"/,
      );
      expect('responseHeaders' in op).toBe(false);
    });

    it('promotes an inline header enum to a top-level enum', () => {
      const { services } = extractOperations(
        getWithResponses({
          '200': {
            description: 'ok',
            headers: { 'X-RateLimit-Policy': { schema: { type: 'string', enum: ['burst', 'sustained'] } } },
          },
        }) as never,
      );
      const enums: Enum[] = [];
      collectInlineEnumsFromOperations(services, enums);

      expect(services[0].operations[0].responseHeaders?.[0].type).toMatchInlineSnapshot(`
        {
          "kind": "enum",
          "name": "DocumentsXRateLimitPolicy",
          "values": [
            "burst",
            "sustained",
          ],
        }
      `);
      expect(enums).toMatchInlineSnapshot(`
        [
          {
            "name": "DocumentsXRateLimitPolicy",
            "values": [
              {
                "description": undefined,
                "name": "BURST",
                "value": "burst",
              },
              {
                "description": undefined,
                "name": "SUSTAINED",
                "value": "sustained",
              },
            ],
          },
        ]
      `);
    });
  });
});

// The describes below spy on console.warn too; restore between every test so
// one test's warnings never leak into the next test's assertions.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('inline header models', () => {
  function extract(responses: Record<string, unknown>): { op: Operation; inlineModels: Model[] } {
    const { services, inlineModels } = extractOperations(getWithResponses(responses) as never);
    return { op: services[0].operations[0], inlineModels };
  }

  /** Every model a header's type names must be among the extracted models. */
  function expectHeaderModelsMaterialized(op: Operation, inlineModels: Model[]): void {
    const names = new Set(inlineModels.map((m) => m.name));
    for (const header of collectResponseHeaders(op)) {
      for (const ref of collectModelRefs(header.type)) {
        expect(names, `${header.name} names ${ref}`).toContain(ref);
      }
    }
  }

  it('materializes an object-shaped header declared via content, nested objects included', () => {
    const { op, inlineModels } = extract({
      '200': {
        description: 'ok',
        headers: {
          'X-Meta': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    etag: { type: 'string' },
                    origin: { type: 'object', properties: { region: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta' });
    expect(inlineModels).toMatchInlineSnapshot(`
      [
        {
          "description": undefined,
          "fields": [
            {
              "default": undefined,
              "deprecated": undefined,
              "description": undefined,
              "example": undefined,
              "name": "etag",
              "readOnly": undefined,
              "required": false,
              "type": {
                "kind": "primitive",
                "type": "string",
              },
              "writeOnly": undefined,
            },
            {
              "default": undefined,
              "deprecated": undefined,
              "description": undefined,
              "example": undefined,
              "name": "origin",
              "readOnly": undefined,
              "required": false,
              "type": {
                "kind": "model",
                "name": "DocumentsXMetaOrigin",
              },
              "writeOnly": undefined,
            },
          ],
          "name": "DocumentsXMeta",
        },
        {
          "description": undefined,
          "fields": [
            {
              "default": undefined,
              "deprecated": undefined,
              "description": undefined,
              "example": undefined,
              "name": "region",
              "readOnly": undefined,
              "required": false,
              "type": {
                "kind": "primitive",
                "type": "string",
              },
              "writeOnly": undefined,
            },
          ],
          "name": "DocumentsXMetaOrigin",
        },
      ]
    `);
    expectHeaderModelsMaterialized(op, inlineModels);
  });

  it('materializes the item model of an array-of-objects header', () => {
    const { op, inlineModels } = extract({
      '200': {
        description: 'ok',
        headers: {
          'X-Tags': {
            schema: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' } } } },
          },
        },
      },
    });

    expect(op.responseHeaders?.[0].type).toEqual({ kind: 'array', items: { kind: 'model', name: 'DocumentsXTags' } });
    expect(inlineModels.map((m) => m.name)).toEqual(['DocumentsXTags']);
    expectHeaderModelsMaterialized(op, inlineModels);
  });

  it('materializes every inline variant of a oneOf header', () => {
    const { op, inlineModels } = extract({
      '200': {
        description: 'ok',
        headers: {
          'X-Owner': {
            schema: {
              oneOf: [
                { type: 'object', properties: { type: { const: 'user' }, user_id: { type: 'string' } } },
                { type: 'object', properties: { type: { const: 'team' }, team_id: { type: 'string' } } },
              ],
            },
          },
        },
      },
    });

    expect(op.responseHeaders?.[0].type).toMatchInlineSnapshot(`
      {
        "compositionKind": "oneOf",
        "discriminator": {
          "mapping": {
            "team": "TeamDocumentsXOwner",
            "user": "DocumentsXOwner",
          },
          "property": "type",
        },
        "kind": "union",
        "variants": [
          {
            "kind": "model",
            "name": "DocumentsXOwner",
          },
          {
            "kind": "model",
            "name": "TeamDocumentsXOwner",
          },
        ],
      }
    `);
    expect(inlineModels.map((m) => m.name)).toMatchInlineSnapshot(`
      [
        "DocumentsXOwner",
        "TeamDocumentsXOwner",
      ]
    `);
    expectHeaderModelsMaterialized(op, inlineModels);
  });

  it('materializes an object-shaped header on an error response', () => {
    const { op, inlineModels } = extract({
      '200': { description: 'ok' },
      '429': {
        description: 'throttled',
        headers: { 'X-Throttle': { schema: { type: 'object', properties: { reset_at: { type: 'integer' } } } } },
      },
    });

    expect(op.errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXThrottle' });
    expect(inlineModels.map((m) => m.name)).toEqual(['DocumentsXThrottle']);
    expectHeaderModelsMaterialized(op, inlineModels);
  });

  it('keeps header models when a later 2xx body replaces the body inline models', () => {
    const { op, inlineModels } = extract({
      '200': {
        description: 'ok',
        headers: { 'X-Meta': { schema: { type: 'object', properties: { etag: { type: 'string' } } } } },
      },
      '201': {
        description: 'created',
        content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
      },
    });

    expect(inlineModels.map((m) => m.name)).toContain('DocumentsXMeta');
    expectHeaderModelsMaterialized(op, inlineModels);
  });

  it('creates no model for a header whose schema is a $ref', () => {
    const { op, inlineModels } = extract({
      '200': { description: 'ok', headers: { 'X-Meta': { schema: { $ref: '#/components/schemas/Meta' } } } },
    });

    expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'Meta' });
    expect(inlineModels).toEqual([]);
  });
});

const baseOperation: Operation = {
  name: 'downloadDocument',
  httpMethod: 'get',
  path: '/documents/{id}/download',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'primitive', type: 'string' },
  errors: [],
  injectIdempotencyKey: false,
};

describe('collectResponseHeaders', () => {
  it('yields primary, alternate-success, and error headers, each list once', () => {
    // The primary list is the same array as its successResponses entry, as the parser builds it.
    const primary = [{ name: 'ETag', type: { kind: 'primitive' as const, type: 'string' as const }, required: false }];
    const op: Operation = {
      ...baseOperation,
      responseHeaders: primary,
      successResponses: [
        { statusCode: 200, type: { kind: 'primitive', type: 'string' }, headers: primary },
        {
          statusCode: 202,
          type: { kind: 'primitive', type: 'unknown' },
          headers: [{ name: 'Retry-After', type: { kind: 'primitive', type: 'integer' }, required: false }],
        },
        { statusCode: 204, type: { kind: 'primitive', type: 'unknown' } },
      ],
      errors: [
        { statusCode: 404 },
        {
          statusCode: 429,
          headers: [{ name: 'X-Throttle', type: { kind: 'model', name: 'ThrottleInfo' }, required: false }],
        },
      ],
    };

    expect(collectResponseHeaders(op).map((h) => h.name)).toEqual(['ETag', 'Retry-After', 'X-Throttle']);
  });

  it('returns nothing for an operation that declares no headers', () => {
    expect(collectResponseHeaders(baseOperation)).toEqual([]);
  });
});

describe('validateModelRefs — response headers', () => {
  it('warns about a dangling model ref in a header with operation and header context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec: ApiSpec = {
      name: 'Test',
      version: '1',
      baseUrl: '',
      services: [
        {
          name: 'Documents',
          operations: [
            {
              ...baseOperation,
              responseHeaders: [{ name: 'X-Meta', type: { kind: 'model', name: 'Missing' }, required: false }],
              errors: [
                {
                  statusCode: 429,
                  headers: [
                    {
                      name: 'X-Throttle',
                      type: { kind: 'array', items: { kind: 'model', name: 'AlsoMissing' } },
                      required: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      models: [],
      enums: [],
      sdk: defaultSdkBehavior(),
    };

    validateModelRefs(spec);

    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      '[oagen] Warning: Unresolved model reference "Missing" (context: Documents.downloadDocument.headers.X-Meta)',
      '[oagen] Warning: Unresolved model reference "AlsoMissing" (context: Documents.downloadDocument.headers.X-Throttle)',
    ]);
  });
});

describe('collapseJsonSuffixModels through parseSpec — response headers', () => {
  it('rewrites a header that referenced the collapsed Json-suffix model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'oagen-response-headers-'));
    const specPath = join(dir, 'collapse.yml');
    writeFileSync(
      specPath,
      `
openapi: '3.1.0'
info:
  title: Collapse
  version: '1'
paths:
  /widgets/{id}:
    get:
      operationId: getWidget
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: ok
          headers:
            X-Meta:
              content:
                application/json:
                  schema:
                    $ref: '#/components/schemas/MetaJson'
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Widget'
components:
  schemas:
    Widget:
      type: object
      properties:
        id:
          type: string
        meta:
          $ref: '#/components/schemas/Meta'
    Meta:
      type: object
      properties:
        etag:
          type: string
    MetaJson:
      type: object
      properties:
        etag:
          type: string
        version:
          type: integer
`,
    );

    try {
      const spec = await parseSpec(specPath);
      const op = spec.services.flatMap((s) => s.operations)[0];
      const messages = warn.mock.calls.map((call) => String(call[0]));

      // MetaJson is a superset of Meta, so it collapses into Meta ...
      expect(messages).toContain('[oagen] Merged "MetaJson" into "Meta" (2 fields, superset)');
      expect(spec.models.map((m) => m.name)).not.toContain('MetaJson');
      // ... and the header follows the rename instead of pointing at a deleted model.
      expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'Meta' });
      expect(messages.filter((m) => m.includes('Unresolved model reference'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
