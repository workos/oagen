import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { collectInlineEnumsFromOperations } from '../../src/parser/collect-inline-enums.js';
import type { Enum, Operation } from '../../src/ir/types.js';

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
