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
import type { ApiSpec, Enum, Field, Model, Operation } from '../../src/ir/types.js';

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
            "description": "throttled",
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
            "description": "missing",
            "statusCode": 404,
            "type": undefined,
          },
          {
            "description": "throttled",
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

    it('prefers a description written next to the $ref over the component’s', () => {
      const componentHeaders: ComponentHeaders = {
        RequestId: { description: 'Correlation id for this request.', schema: { type: 'string' } },
      };
      const op = singleOperation(
        getWithResponses({
          '200': {
            description: 'ok',
            headers: {
              'X-Request-Id': { $ref: '#/components/headers/RequestId', description: 'Echoed back for support.' },
              'X-Trace-Id': { $ref: '#/components/headers/RequestId' },
            },
          },
        }),
        componentHeaders,
      );

      expect(op.responseHeaders?.map((h) => [h.name, h.description])).toEqual([
        ['X-Request-Id', 'Echoed back for support.'],
        ['X-Trace-Id', 'Correlation id for this request.'],
      ]);
    });

    it('lets the outermost $ref description win along a chain', () => {
      const componentHeaders: ComponentHeaders = {
        RequestId: { description: 'From the component.', schema: { type: 'string' } },
        RequestIdAlias: { $ref: '#/components/headers/RequestId', description: 'From the alias.' },
      };
      const op = singleOperation(
        getWithResponses({
          '200': {
            description: 'ok',
            headers: {
              'X-Outer': { $ref: '#/components/headers/RequestIdAlias', description: 'From the header entry.' },
              'X-Inner': { $ref: '#/components/headers/RequestIdAlias' },
            },
          },
        }),
        componentHeaders,
      );

      expect(op.responseHeaders?.map((h) => [h.name, h.description])).toEqual([
        ['X-Outer', 'From the header entry.'],
        ['X-Inner', 'From the alias.'],
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
                "name": "BURST",
                "value": "burst",
              },
              {
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

  it('materializes a header model on the default response, which is kept apart from the primary (#214)', () => {
    const { op, inlineModels } = extract({
      '200': { description: 'ok' },
      default: {
        description: 'anything else',
        headers: { 'X-Meta': { schema: { type: 'object', properties: { etag: { type: 'string' } } } } },
      },
    });

    expect('responseHeaders' in op).toBe(false);
    expect(op.defaultResponse?.headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta' });
    expect(inlineModels.map((m) => m.name)).toEqual(['DocumentsXMeta']);
    expectHeaderModelsMaterialized(op, inlineModels);
  });

  it('a titled oneOf variant clashing with a differently shaped component terminates and takes its qualified name', () => {
    // Used to loop forever: the variant is named from its `title`, which no
    // retry of the header's property name could move off the component.
    const titled = (title: string, kind: string, properties: Record<string, unknown>) => ({
      type: 'object',
      title,
      properties: { kind: { type: 'string', const: kind }, ...properties },
    });
    const circle: Model = {
      name: 'Circle',
      fields: [{ name: 'radius', type: { kind: 'primitive', type: 'number' }, required: false }],
    };
    const { services, inlineModels } = extractOperations(
      getWithResponses({
        '200': {
          description: 'ok',
          headers: {
            'X-Shape': {
              schema: {
                oneOf: [
                  titled('Circle', 'circle', { diameter: { type: 'number' } }),
                  titled('Square', 'square', { side: { type: 'number' } }),
                ],
              },
            },
          },
        },
      }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      [circle],
    );
    const op = services[0].operations[0];

    expect(op.responseHeaders?.[0].type).toEqual({
      kind: 'union',
      variants: [
        { kind: 'model', name: 'CircleDocumentsXShape' },
        { kind: 'model', name: 'Square' },
      ],
      compositionKind: 'oneOf',
      discriminator: { property: 'kind', mapping: { circle: 'CircleDocumentsXShape', square: 'Square' } },
    });
    expect(inlineModels.map((m) => m.name).sort()).toEqual(['CircleDocumentsXShape', 'Square']);
    expectHeaderModelsMaterialized(op, inlineModels);
  }, 5_000);

  it('moves a header model whose nested titled child differs from a same-named component, child following', () => {
    // The header's parent matches component `DocumentsXShape` until its
    // nested `Circle` is renamed off component `Circle{radius}`; it must then
    // move too (to the header's next candidate) instead of being dropped at
    // commit, which would leave the header typed as the component.
    const titled = (title: string, kind: string, properties: Record<string, unknown>) => ({
      type: 'object',
      title,
      properties: { kind: { type: 'string', const: kind }, ...properties },
    });
    const union = (circle: string) => ({
      kind: 'union' as const,
      variants: [
        { kind: 'model' as const, name: circle },
        { kind: 'model' as const, name: 'Square' },
      ],
      compositionKind: 'oneOf' as const,
      discriminator: { property: 'kind', mapping: { circle, square: 'Square' } },
    });
    const num = { kind: 'primitive' as const, type: 'number' as const };
    const componentModels: Model[] = [
      { name: 'DocumentsXShape', fields: [{ name: 'shape', type: union('Circle'), required: false }] },
      {
        name: 'Circle',
        fields: [
          { name: 'kind', type: { kind: 'literal', value: 'circle' }, required: false },
          { name: 'radius', type: num, required: false },
        ],
      },
      {
        name: 'Square',
        fields: [
          { name: 'kind', type: { kind: 'literal', value: 'square' }, required: false },
          { name: 'side', type: num, required: false },
        ],
      },
    ];
    const shapes = {
      oneOf: [
        titled('Circle', 'circle', { diameter: { type: 'number' } }),
        titled('Square', 'square', { side: { type: 'number' } }),
      ],
    };
    const { services, inlineModels } = extractOperations(
      getWithResponses({
        '200': {
          description: 'ok',
          headers: { 'X-Shape': { schema: { type: 'object', properties: { shape: shapes } } } },
        },
      }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      componentModels,
    );
    const op = services[0].operations[0];
    const fields = (name: string) =>
      Object.fromEntries(inlineModels.find((m) => m.name === name)!.fields.map((f) => [f.name, f.type]));

    expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'DocumentsListDocumentsXShape' });
    expect(fields('DocumentsListDocumentsXShape')).toEqual({ shape: union('DocumentsListDocumentsXShapeCircle') });
    expect(fields('DocumentsListDocumentsXShapeCircle')).toEqual({
      kind: { kind: 'literal', value: 'circle' },
      diameter: num,
    });
    expect(inlineModels.map((m) => m.name).sort()).toEqual([
      'DocumentsListDocumentsXShape',
      'DocumentsListDocumentsXShapeCircle',
    ]);
    // The component models were handed in, not materialized, and are untouched.
    expect(componentModels[0].fields[0].type).toEqual(union('Circle'));
    expectHeaderModelsMaterialized(op, inlineModels);
  }, 5_000);

  it('moving a header model keeps a child matching a component shared, even one the header also $refs', () => {
    // Mirror of the fallback case: the header's `detail` is identical to
    // component `CatalogXShapeDetail`, which `original` references. Only the
    // parent and its clashing `Circle` move; `detail` stays the component's.
    // (A singular service name, since `cleanSchemaName` singularizes the
    // leading word of a `$ref` target: `Documents…` would become `Document…`.)
    const titled = (title: string, kind: string, properties: Record<string, unknown>) => ({
      type: 'object',
      title,
      properties: { kind: { type: 'string', const: kind }, ...properties },
    });
    const union = (circle: string) => ({
      kind: 'union' as const,
      variants: [
        { kind: 'model' as const, name: circle },
        { kind: 'model' as const, name: 'Square' },
      ],
      compositionKind: 'oneOf' as const,
      discriminator: { property: 'kind', mapping: { circle, square: 'Square' } },
    });
    const num = { kind: 'primitive' as const, type: 'number' as const };
    const str = { kind: 'primitive' as const, type: 'string' as const };
    const detailRef = { kind: 'model' as const, name: 'CatalogXShapeDetail' };
    const detail = { type: 'object', properties: { field: { type: 'string' } } };
    const componentModels: Model[] = [
      {
        name: 'CatalogXShape',
        fields: [
          { name: 'shape', type: union('Circle'), required: false },
          { name: 'detail', type: detailRef, required: false },
          { name: 'original', type: detailRef, required: false },
        ],
      },
      { name: 'CatalogXShapeDetail', fields: [{ name: 'field', type: str, required: false }] },
      {
        name: 'Circle',
        fields: [
          { name: 'kind', type: { kind: 'literal', value: 'circle' }, required: false },
          { name: 'radius', type: num, required: false },
        ],
      },
      {
        name: 'Square',
        fields: [
          { name: 'kind', type: { kind: 'literal', value: 'square' }, required: false },
          { name: 'side', type: num, required: false },
        ],
      },
    ];
    const shapes = {
      oneOf: [
        titled('Circle', 'circle', { diameter: { type: 'number' } }),
        titled('Square', 'square', { side: { type: 'number' } }),
      ],
    };
    const { services, inlineModels } = extractOperations(
      {
        '/catalog': {
          get: {
            operationId: 'listCatalog',
            responses: {
              '200': {
                description: 'ok',
                headers: {
                  'X-Shape': {
                    schema: {
                      type: 'object',
                      properties: {
                        shape: shapes,
                        detail,
                        original: { $ref: '#/components/schemas/CatalogXShapeDetail' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      } as never,
      undefined,
      { CatalogXShapeDetail: detail },
      undefined,
      undefined,
      componentModels,
    );
    const op = services[0].operations[0];
    const fields = (name: string) =>
      Object.fromEntries(inlineModels.find((m) => m.name === name)!.fields.map((f) => [f.name, f.type]));

    expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'CatalogListCatalogXShape' });
    expect(fields('CatalogListCatalogXShape')).toEqual({
      shape: union('CatalogListCatalogXShapeCircle'),
      detail: detailRef,
      original: detailRef,
    });
    expect(fields('CatalogListCatalogXShapeCircle')).toEqual({
      kind: { kind: 'literal', value: 'circle' },
      diameter: num,
    });
    // `detail` was not materialized again: it is the component's.
    expect(inlineModels.map((m) => m.name).sort()).toEqual([
      'CatalogListCatalogXShape',
      'CatalogListCatalogXShapeCircle',
    ]);
    expect(componentModels[0].fields.map((f) => f.type)).toEqual([union('Circle'), detailRef, detailRef]);
    expectHeaderModelsMaterialized(op, inlineModels);
  }, 5_000);

  describe('same header name, different shapes', () => {
    const object = (properties: Record<string, unknown>) => ({ schema: { type: 'object', properties } });
    const fieldsOf = (models: Model[], name: string) => models.find((m) => m.name === name)?.fields.map((f) => f.name);

    it('gives the 429 header a status-qualified model when its shape differs from the 200', () => {
      const { op, inlineModels } = extract({
        '200': { description: 'ok', headers: { 'X-Meta': object({ etag: { type: 'string' } }) } },
        '429': { description: 'throttled', headers: { 'X-Meta': object({ reset_at: { type: 'integer' } }) } },
      });

      expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta' });
      expect(op.errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta429' });
      expect(fieldsOf(inlineModels, 'DocumentsXMeta')).toEqual(['etag']);
      expect(fieldsOf(inlineModels, 'DocumentsXMeta429')).toEqual(['reset_at']);
      expectHeaderModelsMaterialized(op, inlineModels);
    });

    it('shares one model when the shapes are identical', () => {
      const { op, inlineModels } = extract({
        '200': { description: 'ok', headers: { 'X-Meta': object({ etag: { type: 'string' } }) } },
        '202': { description: 'accepted', headers: { 'X-Meta': object({ etag: { type: 'string' } }) } },
        '429': { description: 'throttled', headers: { 'X-Meta': object({ etag: { type: 'string' } }) } },
      });

      expect(op.successResponses?.map((r) => r.headers?.[0].type)).toEqual([
        { kind: 'model', name: 'DocumentsXMeta' },
        { kind: 'model', name: 'DocumentsXMeta' },
      ]);
      expect(op.errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta' });
      expect(inlineModels.map((m) => m.name)).toEqual(['DocumentsXMeta']);
    });

    it('renames nested models along with the header that owns them', () => {
      const { op, inlineModels } = extract({
        '200': { description: 'ok', headers: { 'X-Meta': object({ etag: { type: 'string' } }) } },
        '429': {
          description: 'throttled',
          headers: {
            'X-Meta': object({ origin: { type: 'object', properties: { zone: { type: 'string' } } } }),
          },
        },
      });

      expect(op.errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta429' });
      expect(inlineModels.find((m) => m.name === 'DocumentsXMeta429')?.fields[0].type).toEqual({
        kind: 'model',
        name: 'DocumentsXMeta429Origin',
      });
      expect(fieldsOf(inlineModels, 'DocumentsXMeta429Origin')).toEqual(['zone']);
      expectHeaderModelsMaterialized(op, inlineModels);
    });

    it('treats a difference buried in a nested object as a different shape', () => {
      const { op, inlineModels } = extract({
        '200': {
          description: 'ok',
          headers: {
            'X-Meta': object({ origin: { type: 'object', properties: { region: { type: 'string' } } } }),
          },
        },
        '429': {
          description: 'throttled',
          headers: {
            'X-Meta': object({ origin: { type: 'object', properties: { zone: { type: 'string' } } } }),
          },
        },
      });

      expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta' });
      expect(op.errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta429' });
      expect(fieldsOf(inlineModels, 'DocumentsXMetaOrigin')).toEqual(['region']);
      expect(fieldsOf(inlineModels, 'DocumentsXMeta429Origin')).toEqual(['zone']);
      expectHeaderModelsMaterialized(op, inlineModels);
    });

    it('gives the 429 header the distinct name even when it is declared first', () => {
      // Integer-like keys iterate in ascending order, so the 200 is visited
      // first and keeps the bare name no matter where the 429 appears.
      const { op, inlineModels } = extract({
        '429': { description: 'throttled', headers: { 'X-Meta': object({ reset_at: { type: 'integer' } }) } },
        '200': { description: 'ok', headers: { 'X-Meta': object({ etag: { type: 'string' } }) } },
      });

      expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta' });
      expect(op.errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta429' });
      expect(fieldsOf(inlineModels, 'DocumentsXMeta')).toEqual(['etag']);
      expect(fieldsOf(inlineModels, 'DocumentsXMeta429')).toEqual(['reset_at']);
    });

    it('qualifies by the operation when the status-qualified name is taken by another shape', () => {
      // A header literally named `X-Meta429` on the 200 occupies `DocumentsXMeta429`.
      const { op, inlineModels } = extract({
        '200': {
          description: 'ok',
          headers: {
            'X-Meta': object({ etag: { type: 'string' } }),
            'X-Meta429': object({ taken: { type: 'boolean' } }),
          },
        },
        '429': { description: 'throttled', headers: { 'X-Meta': object({ reset_at: { type: 'integer' } }) } },
      });

      expect(op.errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentsListDocumentsXMeta' });
      expect(fieldsOf(inlineModels, 'DocumentsListDocumentsXMeta')).toEqual(['reset_at']);
      expect(fieldsOf(inlineModels, 'DocumentsXMeta429')).toEqual(['taken']);
      expectHeaderModelsMaterialized(op, inlineModels);
    });

    describe('when a model of this operation owns the bare name (issue #280)', () => {
      // A title-mapped variant of the 200 body is named from its title, so
      // one titled `DocumentXMeta` owns the name the `X-Meta` header of the
      // `Document` service derives, inside this operation: the 200's header
      // steps to `DocumentXMeta200`, and the 429's tries that stem before its
      // own `DocumentXMeta429`.
      const titled = (title: string, kind: string, properties: Record<string, unknown>) => ({
        title,
        type: 'object',
        properties: { kind: { const: kind }, ...properties },
      });
      const body = {
        oneOf: [
          titled('DocumentXMeta', 'meta', { taken: { type: 'boolean' } }),
          titled('DocumentXOther', 'other', { label: { type: 'string' } }),
        ],
      };
      const getDocument = (headerOn429: Record<string, unknown>) => {
        const { services, inlineModels } = extractOperations({
          '/document': {
            get: {
              operationId: 'getDocument',
              responses: {
                '200': {
                  description: 'ok',
                  headers: { 'X-Meta': object({ etag: { type: 'string' } }) },
                  content: { 'application/json': { schema: body } },
                },
                '429': { description: 'throttled', headers: { 'X-Meta': object(headerOn429) } },
              },
            },
          },
        } as never);
        return { op: services[0].operations[0], inlineModels };
      };

      it('shares one model under the name the 200 header settled on when the 429 header has its shape', () => {
        const { op, inlineModels } = getDocument({ etag: { type: 'string' } });

        expect(fieldsOf(inlineModels, 'DocumentXMeta')).toEqual(['kind', 'taken']);
        expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'DocumentXMeta200' });
        expect(op.errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentXMeta200' });
        expect(fieldsOf(inlineModels, 'DocumentXMeta200')).toEqual(['etag']);
        expect(inlineModels.map((m) => m.name)).not.toContain('DocumentXMeta429');
        expectHeaderModelsMaterialized(op, inlineModels);
      });

      it('still gives the 429 header its own name when its shape differs', () => {
        const { op, inlineModels } = getDocument({ reset_at: { type: 'integer' } });

        expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'DocumentXMeta200' });
        expect(op.errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentXMeta429' });
        expect(fieldsOf(inlineModels, 'DocumentXMeta200')).toEqual(['etag']);
        expect(fieldsOf(inlineModels, 'DocumentXMeta429')).toEqual(['reset_at']);
        expectHeaderModelsMaterialized(op, inlineModels);
      });
    });

    it('shares one model across two operations of the service under the name the first settled on (issue #280)', () => {
      // A component owns `PetXMeta` with another shape, so the first
      // operation's header steps to its operation-qualified name; the second
      // operation's identical header tries that stem and shares it.
      const componentModels: Model[] = [
        { name: 'PetXMeta', fields: [{ name: 'other', type: { kind: 'primitive', type: 'string' }, required: false }] },
      ];
      const header = { 'X-Meta': object({ etag: { type: 'string' } }) };
      const { services, inlineModels } = extractOperations(
        {
          '/pets': {
            get: {
              operationId: 'listPets',
              tags: ['Pet'],
              responses: { '200': { description: 'ok', headers: header } },
            },
            post: {
              operationId: 'createPet',
              tags: ['Pet'],
              responses: { '201': { description: 'created', headers: header } },
            },
          },
        } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        componentModels,
      );
      const [listPets, createPet] = services[0].operations;

      expect(listPets.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'PetListPetsXMeta' });
      expect(createPet.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'PetListPetsXMeta' });
      expect(inlineModels.map((m) => m.name)).toEqual(['PetListPetsXMeta']);
      expect(fieldsOf(inlineModels, 'PetListPetsXMeta')).toEqual(['etag']);
      expectHeaderModelsMaterialized(listPets, inlineModels);
      expectHeaderModelsMaterialized(createPet, inlineModels);
    });
  });
});

describe('header models across the spec', () => {
  const object = (properties: Record<string, unknown>) => ({ schema: { type: 'object', properties } });
  const stringField = (name: string): Field => ({ name, type: { kind: 'primitive', type: 'string' }, required: false });
  const fieldsOf = (models: Model[], name: string) => models.find((m) => m.name === name)?.fields.map((f) => f.name);
  const modelNameOf = (type: unknown) => (type as { name: string }).name;

  function extractAll(paths: Record<string, unknown>, componentModels: Model[] = []) {
    const { services, inlineModels } = extractOperations(
      paths as never,
      undefined,
      undefined,
      undefined,
      undefined,
      componentModels,
    );
    return { ops: services.flatMap((s) => s.operations), inlineModels };
  }

  it("qualifies a path-named operation's header model by its path stem, not by its derived name", () => {
    const ok = (meta: Record<string, unknown>) => ({
      '200': { description: 'ok', headers: { 'X-Meta': object(meta) } },
    });
    const { ops, inlineModels } = extractAll({
      '/notes': { get: { responses: ok({ etag: { type: 'string' } }) } },
      '/notes/{id}/pin': {
        post: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: ok({ pinned_at: { type: 'integer' } }),
        },
      },
    });
    const [list, pin] = ops;
    expect(list.name).toBe('list');
    expect(pin.name).toBe('pinNote');

    // The second shape needs a qualifier. It is the same path-derived stem the
    // operation's body and response models use, so the model name depends only
    // on the method and path: a verb or singular change in the operation name
    // must never rename a generated type.
    expect(modelNameOf(list.responseHeaders?.[0].type)).toBe('NotesXMeta');
    expect(modelNameOf(pin.responseHeaders?.[0].type)).toBe('NotesByIdPinPostXMeta');
    expect(fieldsOf(inlineModels, 'NotesXMeta')).toEqual(['etag']);
    expect(fieldsOf(inlineModels, 'NotesByIdPinPostXMeta')).toEqual(['pinned_at']);
  });

  const jsonBody = (properties: Record<string, unknown>) => ({
    content: { 'application/json': { schema: { type: 'object', properties } } },
  });
  const uniqueNames = (models: Model[]) => {
    const names = models.map((m) => m.name);
    expect(new Set(names).size, `duplicate model names in ${names.join(', ')}`).toBe(names.length);
  };

  it('never gives a header model the name of a response body model', () => {
    // A header named `Response` on a path-named POST: the operation-qualified
    // candidate spells the operation's own response body name.
    const ok = (header: Record<string, unknown>, body: Record<string, unknown>) => ({
      '200': { description: 'ok', headers: { Response: object(header) }, ...jsonBody(body) },
    });
    const { ops, inlineModels } = extractAll({
      '/notes': { get: { responses: ok({ etag: { type: 'string' } }, { a: { type: 'string' } }) } },
      '/notes/{id}/pin': {
        post: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: ok({ pinned_at: { type: 'integer' } }, { b: { type: 'string' } }),
        },
      },
    });
    const [list, pin] = ops;

    expect(modelNameOf(pin.response)).toBe('NotesByIdPinPostResponse');
    expect(modelNameOf(list.responseHeaders?.[0].type)).toBe('NotesResponse');
    // The body owns `NotesByIdPinPostResponse`, so the header falls through to
    // the status-qualified candidate.
    expect(modelNameOf(pin.responseHeaders?.[0].type)).toBe('NotesResponse200');
    expect(fieldsOf(inlineModels, 'NotesByIdPinPostResponse')).toEqual(['b']);
    expect(fieldsOf(inlineModels, 'NotesResponse200')).toEqual(['pinned_at']);
    uniqueNames(inlineModels);
  });

  it('never gives a header model the name of a response body model named from an operationId', () => {
    // With the service from a tag, service + header spells operationId + Response.
    const { ops, inlineModels } = extractAll({
      '/notes': {
        get: {
          operationId: 'getNotes',
          tags: ['get'],
          responses: {
            '200': {
              description: 'ok',
              headers: { 'Notes-Response': object({ etag: { type: 'string' } }) },
              ...jsonBody({ a: { type: 'string' } }),
            },
          },
        },
      },
    });

    expect(modelNameOf(ops[0].response)).toBe('GetNotesResponse');
    expect(modelNameOf(ops[0].responseHeaders?.[0].type)).not.toBe('GetNotesResponse');
    expect(fieldsOf(inlineModels, 'GetNotesResponse')).toEqual(['a']);
    expect(fieldsOf(inlineModels, modelNameOf(ops[0].responseHeaders?.[0].type))).toEqual(['etag']);
    uniqueNames(inlineModels);
  });

  // A singular service: `cleanSchemaName` singularizes a component's leading
  // word, so a component can only share a header model's name when the
  // service name is already singular (`Profile` + `X-Meta` → `ProfileXMeta`).
  const createWithHeader = (headerProperties: Record<string, unknown>) => ({
    '/profile': {
      post: {
        operationId: 'createProfile',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ProfileXMeta' } } },
        },
        responses: { '201': { description: 'created', headers: { 'X-Meta': object(headerProperties) } } },
      },
    },
  });

  it('qualifies a header model by its operation when a same-named component has a different shape', () => {
    const componentModels: Model[] = [{ name: 'ProfileXMeta', fields: [stringField('note')] }];
    const { ops, inlineModels } = extractAll(
      createWithHeader({ etag: { type: 'string' }, version: { type: 'integer' } }),
      componentModels,
    );

    // The request body still names the component, and the component is untouched.
    expect(ops[0].requestBody).toEqual({ kind: 'model', name: 'ProfileXMeta' });
    expect(componentModels[0].fields.map((f) => f.name)).toEqual(['note']);
    // The header gets its own model under an operation-qualified name.
    expect(ops[0].responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'ProfileCreateProfileXMeta' });
    expect(inlineModels.map((m) => m.name)).toEqual(['ProfileCreateProfileXMeta']);
    expect(fieldsOf(inlineModels, 'ProfileCreateProfileXMeta')).toEqual(['etag', 'version']);
  });

  it('shares a same-named component whose shape is identical and materializes nothing new', () => {
    const componentModels: Model[] = [{ name: 'ProfileXMeta', fields: [stringField('etag')] }];
    const { ops, inlineModels } = extractAll(createWithHeader({ etag: { type: 'string' } }), componentModels);

    expect(ops[0].responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'ProfileXMeta' });
    expect(inlineModels).toEqual([]);
  });

  it('keeps same-named headers with different shapes on two operations apart, whichever path comes first', () => {
    const list = {
      get: {
        operationId: 'listDocuments',
        responses: { '200': { description: 'ok', headers: { 'X-Meta': object({ total: { type: 'integer' } }) } } },
      },
    };
    const get = {
      get: {
        operationId: 'getDocument',
        responses: { '200': { description: 'ok', headers: { 'X-Meta': object({ etag: { type: 'string' } }) } } },
      },
    };

    const listFirst = extractAll({ '/documents': list, '/documents/{id}': get });
    const getFirst = extractAll({ '/documents/{id}': get, '/documents': list });

    for (const { ops, inlineModels } of [listFirst, getFirst]) {
      const names = Object.fromEntries(ops.map((op) => [op.name, modelNameOf(op.responseHeaders?.[0].type)]));
      expect(names.listDocuments).not.toBe(names.getDocument);
      expect(fieldsOf(inlineModels, names.listDocuments)).toEqual(['total']);
      expect(fieldsOf(inlineModels, names.getDocument)).toEqual(['etag']);
    }
    // The operation visited first keeps the bare name; the other is qualified by its operation.
    expect(listFirst.ops.map((op) => modelNameOf(op.responseHeaders?.[0].type))).toEqual([
      'DocumentsXMeta',
      'DocumentsGetDocumentXMeta',
    ]);
    expect(getFirst.ops.map((op) => modelNameOf(op.responseHeaders?.[0].type))).toEqual([
      'DocumentsXMeta',
      'DocumentsListDocumentsXMeta',
    ]);
  });

  it('falls back to a numeric suffix when every qualified name is taken by another shape', () => {
    const componentModels: Model[] = [
      { name: 'DocumentsXMeta', fields: [stringField('a')] },
      { name: 'DocumentsXMeta429', fields: [stringField('b')] },
      { name: 'DocumentsListDocumentsXMeta', fields: [stringField('c')] },
      { name: 'DocumentsListDocumentsXMeta429', fields: [stringField('d')] },
    ];
    const { ops, inlineModels } = extractAll(
      {
        '/documents': {
          get: {
            operationId: 'listDocuments',
            responses: {
              '200': { description: 'ok' },
              '429': { description: 'throttled', headers: { 'X-Meta': object({ reset_at: { type: 'integer' } }) } },
            },
          },
        },
      },
      componentModels,
    );

    expect(ops[0].errors[0].headers?.[0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta2' });
    expect(fieldsOf(inlineModels, 'DocumentsXMeta2')).toEqual(['reset_at']);
  });

  it('leaves a same-named component untouched through parseSpec', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'oagen-response-headers-'));
    const specPath = join(dir, 'component-collision.yml');
    writeFileSync(
      specPath,
      `
openapi: '3.1.0'
info:
  title: Collision
  version: '1'
paths:
  /profile:
    post:
      operationId: createProfile
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ProfileXMeta'
      responses:
        '201':
          description: created
          headers:
            X-Meta:
              schema:
                type: object
                properties:
                  etag:
                    type: string
                  version:
                    type: integer
components:
  schemas:
    ProfileXMeta:
      type: object
      properties:
        note:
          type: string
`,
    );

    try {
      const spec = await parseSpec(specPath);
      const op = spec.services.flatMap((s) => s.operations)[0];
      const modelFields = (name: string) => spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);

      // The component keeps its own field; nothing merged the header's shape over it.
      expect(modelFields('ProfileXMeta')).toEqual(['note']);
      expect(op.requestBody).toEqual({ kind: 'model', name: 'ProfileXMeta' });
      expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'ProfileCreateProfileXMeta' });
      expect(modelFields('ProfileCreateProfileXMeta')).toEqual(['etag', 'version']);
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages.filter((m) => m.includes('ProfileXMeta'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('inline header enums', () => {
  function extractWithEnums(paths: Record<string, unknown>, seed: Enum[] = []): { op: Operation; enums: Enum[] } {
    const { services } = extractOperations(paths as never);
    const enums = [...seed];
    collectInlineEnumsFromOperations(services, enums);
    return { op: services[0].operations[0], enums };
  }
  const policy = (values: string[]) => ({ schema: { type: 'string', enum: values } });
  const valuesOf = (enums: Enum[], name: string) => enums.find((e) => e.name === name)?.values.map((v) => v.value);

  it('keeps a 200 and a 429 header enum with different values apart', () => {
    const { op, enums } = extractWithEnums(
      getWithResponses({
        '200': { description: 'ok', headers: { 'X-Policy': policy(['fast', 'slow']) } },
        '429': { description: 'throttled', headers: { 'X-Policy': policy(['retry', 'stop']) } },
      }),
    );

    expect(op.responseHeaders?.[0].type).toEqual({ kind: 'enum', name: 'DocumentsXPolicy', values: ['fast', 'slow'] });
    // Qualified by the status code it was declared on, and the ref follows the rename.
    expect(op.errors[0].headers?.[0].type).toEqual({
      kind: 'enum',
      name: 'DocumentsXPolicy429',
      values: ['retry', 'stop'],
    });
    expect(valuesOf(enums, 'DocumentsXPolicy')).toEqual(['fast', 'slow']);
    expect(valuesOf(enums, 'DocumentsXPolicy429')).toEqual(['retry', 'stop']);
  });

  it('keeps a header enum apart from a request parameter enum of the same name', () => {
    const { op, enums } = extractWithEnums({
      '/documents': {
        get: {
          operationId: 'listDocuments',
          parameters: [{ name: 'X-Policy', in: 'header', schema: { type: 'string', enum: ['a', 'b'] } }],
          responses: { '200': { description: 'ok', headers: { 'X-Policy': policy(['c', 'd']) } } },
        },
      },
    });

    expect(op.headerParams[0].type).toEqual({ kind: 'enum', name: 'DocumentsXPolicy', values: ['a', 'b'] });
    // A lone 2xx carries no status code in the IR, so the fallback is a numeric suffix.
    expect(op.responseHeaders?.[0].type).toEqual({ kind: 'enum', name: 'DocumentsXPolicy2', values: ['c', 'd'] });
    expect(valuesOf(enums, 'DocumentsXPolicy')).toEqual(['a', 'b']);
    expect(valuesOf(enums, 'DocumentsXPolicy2')).toEqual(['c', 'd']);
  });

  it('shares one enum when the value sets are identical, regardless of order', () => {
    const { op, enums } = extractWithEnums(
      getWithResponses({
        '200': { description: 'ok', headers: { 'X-Policy': policy(['fast', 'slow']) } },
        '202': { description: 'accepted', headers: { 'X-Policy': policy(['slow', 'fast']) } },
        '429': { description: 'throttled', headers: { 'X-Policy': policy(['fast', 'slow']) } },
      }),
    );

    const nameOf = (type: unknown) => (type as { name: string }).name;
    expect(op.successResponses?.map((r) => nameOf(r.headers?.[0].type))).toEqual([
      'DocumentsXPolicy',
      'DocumentsXPolicy',
    ]);
    expect(nameOf(op.errors[0].headers?.[0].type)).toBe('DocumentsXPolicy');
    expect(enums.map((e) => e.name)).toEqual(['DocumentsXPolicy']);
  });

  it('renames through array and nullable wrappers, with a numeric suffix when the code-qualified name is taken', () => {
    const seed: Enum[] = [
      { name: 'DocumentsXPolicy', values: [{ name: 'A', value: 'a' }] },
      { name: 'DocumentsXPolicy429', values: [{ name: 'X', value: 'x' }] },
    ];
    const { op, enums } = extractWithEnums(
      getWithResponses({
        '200': { description: 'ok' },
        '429': {
          description: 'throttled',
          headers: {
            'X-Policy': { schema: { type: 'array', items: { type: ['string', 'null'], enum: ['retry', 'stop'] } } },
          },
        },
      }),
      seed,
    );

    expect(op.errors[0].headers?.[0].type).toEqual({
      kind: 'array',
      items: { kind: 'nullable', inner: { kind: 'enum', name: 'DocumentsXPolicy2', values: ['retry', 'stop'] } },
    });
    expect(valuesOf(enums, 'DocumentsXPolicy2')).toEqual(['retry', 'stop']);
    expect(valuesOf(enums, 'DocumentsXPolicy429')).toEqual(['x']);
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
