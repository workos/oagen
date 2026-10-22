import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { collectReferencedNames } from '../../src/engine/generate-files.js';
import { specDerivedNames } from '../../src/compat/spec-filter.js';
import { nodeHints } from '../../src/compat/language-hints.js';
import { buildDirectionIndex, directionOf } from '../../src/differ/direction.js';
import {
  assignModelsToServices,
  collectAlternateRequestBodyContents,
  collectModelRefs,
  collectRequestBodyModels,
  collectRequestBodyTypes,
  collectWebhookTypeRefs,
} from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #278, fourth bullet: a request body offering several media types
 * keeps them all — `requestBodyContentTypes` / `requestBodyContents`, the
 * entry the pick read sharing `requestBody`'s TypeRef — as a response does
 * since #233, so `replaceWidget` does not lose its `text/csv` beside
 * `application/json`; `requestBodyContentType` is the picked media type's
 * essence, what an emitter sends as Content-Type.
 */

/** Parse an inline OpenAPI document through the whole pipeline (models, enums, ref validation). */
async function parseDocument(document: Record<string, unknown>): Promise<ApiSpec> {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-278-contents-'));
  try {
    const file = join(dir, 'spec.json');
    writeFileSync(file, JSON.stringify(document));
    return await parseSpec(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An OpenAPI 3.1 document with the given paths, component schemas and webhooks. */
function document(
  paths: Record<string, unknown>,
  schemas: Record<string, unknown> = {},
  webhooks?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Test', version: '1' },
    paths,
    ...(webhooks ? { webhooks } : {}),
    components: { schemas },
  };
}

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties });
const NAME = obj({ name: str });
const TITLE = obj({ title: str });
const ok = { '204': { description: 'ok' } };

/** The issue's `replaceWidget`: PUT /widgets/{widgetId} with the given request body `content`. */
function replaceWidget(content: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '/widgets/{widgetId}': {
      put: {
        operationId: 'replaceWidget',
        parameters: [{ name: 'widgetId', in: 'path', required: true, schema: str }],
        requestBody: { required: true, content },
        responses: ok,
        ...extra,
      },
    },
  };
}

/** Extract the only operation declared in an inline paths object. */
function singleOperation(paths: Record<string, unknown>): { operation: Operation; inlineModels: Model[] } {
  const { services, inlineModels } = extractOperations(paths as never);
  const operations = services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return { operation: operations[0], inlineModels };
}

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

const fieldNames = (models: Model[], name: string): string[] | undefined =>
  models.find((m) => m.name === name)?.fields.map((f) => f.name);

/** Every model the operation's bodies reference, and every model's fields reference, must be one the parser created. */
function expectClosed(operation: Operation, models: Model[]): void {
  const known = new Set(models.map((m) => m.name));
  const refs: TypeRef[] = [operation.response, ...(operation.requestBodyContents ?? []).map((c) => c.type)];
  if (operation.requestBody) refs.push(operation.requestBody);
  for (const model of models) for (const field of model.fields) refs.push(field.type);
  for (const ref of refs) for (const name of collectModelRefs(ref)) expect(known).toContain(name);
}

describe('request bodies keep every media type (issue #278)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('through parseSpec (issue repro: replaceWidget keeps text/csv)', () => {
    it('carries both media types, the JSON entry sharing requestBody, with nothing printed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(
        document(replaceWidget({ 'application/json': { schema: NAME }, 'text/csv': { schema: str } })),
      );
      const op = opsOf(spec).replaceWidget;

      expect(op.requestBody).toEqual({ kind: 'model', name: 'ReplaceWidgetRequest' });
      expect(op.requestBodyEncoding).toBe('json');
      expect(op.requestBodyContentType).toBe('application/json');
      expect(op.requestBodyRequired).toBe(true);
      expect(op.requestBodyContentTypes).toEqual(['application/json', 'text/csv']);
      expect(op.requestBodyContents).toEqual([
        { contentType: 'application/json', type: { kind: 'model', name: 'ReplaceWidgetRequest' } },
        { contentType: 'text/csv', type: { kind: 'primitive', type: 'string' } },
      ]);
      // The picked entry carries the very same TypeRef as `requestBody`.
      expect(op.requestBodyContents?.[0].type).toBe(op.requestBody);
      expect(collectRequestBodyTypes(op)).toEqual([
        { type: { kind: 'primitive', type: 'string' }, source: 'requestBodyContents.text/csv' },
      ]);
      expect(spec.models.map((m) => m.name)).toEqual(['ReplaceWidgetRequest']);
      expectClosed(op, spec.models);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('requestBodyContentType is the picked media type by essence', () => {
    it('keeps a +json type and drops parameters and case, on an operation', () => {
      const cases: Array<[string, string]> = [
        ['application/merge-patch+json', 'application/merge-patch+json'],
        ['application/json; charset=utf-8', 'application/json'],
        ['APPLICATION/JSON', 'application/json'],
        ['multipart/form-data; boundary=x', 'multipart/form-data'],
        ['Application/X-WWW-Form-Urlencoded; charset=utf-8', 'application/x-www-form-urlencoded'],
      ];
      for (const [key, essence] of cases) {
        const { operation } = singleOperation(replaceWidget({ [key]: { schema: NAME } }));
        expect(operation.requestBodyContentType, key).toBe(essence);
        expect(operation.requestBodyContentTypes, key).toEqual([key]);
        expect(operation.requestBodyContents?.[0].contentType, key).toBe(key);
        expect(operation.requestBodyContents?.[0].type, key).toBe(operation.requestBody);
      }
      const schemaless = singleOperation(replaceWidget({ 'TEXT/PLAIN; charset=utf-8': {} }));
      expect(schemaless.operation.requestBodyContentType).toBe('text/plain');
      expect(schemaless.operation.requestBody).toEqual({ kind: 'primitive', type: 'string' });
    });

    it('is absent without a body and when no media type is read', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const none = singleOperation({ '/widgets': { post: { operationId: 'createWidget', responses: ok } } });
      expect(Object.keys(none.operation)).not.toContain('requestBodyContentType');
      expect(Object.keys(none.operation)).not.toContain('requestBodyContentTypes');
      expect(Object.keys(none.operation)).not.toContain('requestBodyContents');
      const unread = singleOperation(replaceWidget({ 'application/xml': { schema: NAME } }));
      expect(Object.keys(unread.operation)).not.toContain('requestBodyContentType');
      expect(unread.operation.requestBodyContentTypes).toEqual(['application/xml']);
    });

    it('keeps a +json type and drops parameters, on a webhook', () => {
      const { webhooks } = extractWebhooks({
        patched: {
          post: { requestBody: { content: { 'application/merge-patch+json': { schema: NAME } } }, responses: {} },
        },
        charset: {
          post: { requestBody: { content: { 'application/json; charset=utf-8': { schema: NAME } } }, responses: {} },
        },
      });
      expect(webhooks.map((w) => [w.requestBodyContentType, w.requestBodyEncoding])).toEqual([
        ['application/merge-patch+json', 'json'],
        ['application/json', 'json'],
      ]);
      expect(webhooks[1].requestBodyContentTypes).toEqual(['application/json; charset=utf-8']);
      expect(webhooks[1].requestBodyContents?.[0].type).toBe(webhooks[1].requestBody);
    });
  });

  describe('secondary media types are typed as they would be alone', () => {
    it('keeps a $ref as a reference to the component', async () => {
      const spec = await parseDocument(
        document(
          replaceWidget({
            'application/json': { schema: NAME },
            'application/xml': { schema: { $ref: '#/components/schemas/XmlWidget' } },
          }),
          { XmlWidget: obj({ id: str }) },
        ),
      );
      const op = opsOf(spec).replaceWidget;
      expect(op.requestBodyContents?.[1]).toEqual({
        contentType: 'application/xml',
        type: { kind: 'model', name: 'XmlWidget' },
      });
      expect(spec.models.map((m) => m.name).sort()).toEqual(['ReplaceWidgetRequest', 'XmlWidget']);
      expectClosed(op, spec.models);
    });

    it('materializes an inline object as <Op><MediaType>Request, nested models and enums under it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(
        document(
          replaceWidget({
            'application/json': { schema: NAME },
            'application/xml': {
              schema: obj({ owner: obj({ email: str }), mode: { type: 'string', enum: ['draft', 'live'] } }),
            },
          }),
        ),
      );
      const op = opsOf(spec).replaceWidget;
      expect(op.requestBodyContents?.[1].type).toEqual({ kind: 'model', name: 'ReplaceWidgetApplicationXmlRequest' });
      expect(fieldNames(spec.models, 'ReplaceWidgetApplicationXmlRequest')).toEqual(['owner', 'mode']);
      expect(fieldNames(spec.models, 'ReplaceWidgetApplicationXmlRequestOwner')).toEqual(['email']);
      const mode = spec.models.find((m) => m.name === 'ReplaceWidgetApplicationXmlRequest')?.fields[1];
      expect(mode?.type).toMatchObject({ kind: 'enum', name: 'ReplaceWidgetApplicationXmlRequestMode' });
      expect(spec.enums.map((e) => e.name)).toEqual(['ReplaceWidgetApplicationXmlRequestMode']);
      expectClosed(op, spec.models);
      expect(warn).not.toHaveBeenCalled();
    });

    it('types a schema-less entry by its media type', () => {
      const { operation } = singleOperation(
        replaceWidget({
          'application/json': { schema: NAME },
          'application/octet-stream; foo=bar': {},
          'TEXT/PLAIN': {},
          'text/csv': {},
          'application/x-www-form-urlencoded': {},
        }),
      );
      expect(operation.requestBodyContents?.map((c) => c.type)).toEqual([
        { kind: 'model', name: 'ReplaceWidgetRequest' },
        { kind: 'primitive', type: 'string', format: 'binary' },
        { kind: 'primitive', type: 'string' },
        { kind: 'primitive', type: 'unknown' },
        // A form media type is read only with a schema, so without one it is unknown.
        { kind: 'primitive', type: 'unknown' },
      ]);
    });

    it('types a primitive schema from the schema and an array of inline objects under the body', async () => {
      const spec = await parseDocument(
        document(
          replaceWidget({
            'application/json': { schema: NAME },
            'text/csv': { schema: { type: 'integer' } },
            'application/x-ndjson': { schema: { type: 'array', items: obj({ line: str }) } },
          }),
        ),
      );
      const op = opsOf(spec).replaceWidget;
      expect(op.requestBodyContents?.[1].type).toEqual({ kind: 'primitive', type: 'integer' });
      const ndjson = op.requestBodyContents?.[2].type;
      expect(ndjson?.kind).toBe('array');
      const [item] = collectModelRefs(ndjson!);
      expect(item.startsWith('ReplaceWidgetApplicationXNdjsonRequest')).toBe(true);
      expect(fieldNames(spec.models, item)).toEqual(['line']);
      expectClosed(op, spec.models);
    });

    it('names a path-named operation from its path-derived prefix', () => {
      const { operation, inlineModels } = singleOperation({
        '/pets': {
          post: {
            requestBody: { content: { 'application/json': { schema: NAME }, 'application/xml': { schema: TITLE } } },
            responses: ok,
          },
        },
      });
      const primary = operation.requestBody as { kind: 'model'; name: string };
      expect(primary.name.endsWith('Request')).toBe(true);
      expect(operation.requestBodyContents?.[1].type).toEqual({
        kind: 'model',
        name: `${primary.name.replace(/Request$/, '')}ApplicationXmlRequest`,
      });
      expectClosed(operation, inlineModels);
    });
  });

  describe('naming through the shape registry', () => {
    it('tells two spellings of one media type apart by their parameters; a case-only third shape steps to the next free name', async () => {
      const spec = await parseDocument(
        document(
          replaceWidget({
            'application/json': { schema: NAME },
            'application/json; charset=utf-8': { schema: TITLE },
            'Application/JSON': { schema: obj({ age: { type: 'integer' } }) },
          }),
        ),
      );
      const op = opsOf(spec).replaceWidget;
      expect(op.requestBody).toEqual({ kind: 'model', name: 'ReplaceWidgetRequest' });
      expect(op.requestBodyContents?.map((c) => c.type)).toEqual([
        { kind: 'model', name: 'ReplaceWidgetRequest' },
        { kind: 'model', name: 'ReplaceWidgetApplicationJsonCharsetUtf8Request' },
        { kind: 'model', name: 'ReplaceWidgetApplicationJsonRequest' },
      ]);
      expect(fieldNames(spec.models, 'ReplaceWidgetApplicationJsonCharsetUtf8Request')).toEqual(['title']);
      expect(fieldNames(spec.models, 'ReplaceWidgetApplicationJsonRequest')).toEqual(['age']);
      expectClosed(op, spec.models);
    });

    it('steps to a numeric suffix when a component owns the name with a different shape', async () => {
      const spec = await parseDocument(
        document(replaceWidget({ 'application/json': { schema: NAME }, 'text/csv': { schema: obj({ row: str }) } }), {
          ReplaceWidgetTextCsvRequest: obj({ other: str }),
        }),
      );
      const op = opsOf(spec).replaceWidget;
      expect(op.requestBodyContents?.[1].type).toEqual({ kind: 'model', name: 'ReplaceWidgetTextCsvRequest2' });
      expect(fieldNames(spec.models, 'ReplaceWidgetTextCsvRequest')).toEqual(['other']);
      expect(fieldNames(spec.models, 'ReplaceWidgetTextCsvRequest2')).toEqual(['row']);
      expectClosed(op, spec.models);
    });

    it('shares the name when a component owns it with an identical shape', async () => {
      const spec = await parseDocument(
        document(replaceWidget({ 'application/json': { schema: NAME }, 'text/csv': { schema: obj({ row: str }) } }), {
          ReplaceWidgetTextCsvRequest: obj({ row: str }),
        }),
      );
      const op = opsOf(spec).replaceWidget;
      expect(op.requestBodyContents?.[1].type).toEqual({ kind: 'model', name: 'ReplaceWidgetTextCsvRequest' });
      expect(spec.models.filter((m) => m.name === 'ReplaceWidgetTextCsvRequest')).toHaveLength(1);
      expectClosed(op, spec.models);
    });
  });

  describe('a body none of whose media types is read', () => {
    it('is carried in requestBodyContents alone, typed, with one warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(
        document({
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: { required: true, content: { 'application/xml': { schema: NAME } } },
              responses: ok,
            },
          },
        }),
      );
      const op = opsOf(spec).createPet;
      expect(op.requestBody).toBeUndefined();
      expect(op.requestBodyEncoding).toBeUndefined();
      // Set exactly when `requestBody` is, so neither key exists here.
      for (const key of ['requestBodyContentType', 'requestBodyRequired']) {
        expect(Object.keys(op), key).not.toContain(key);
      }
      expect(op.requestBodyContentTypes).toEqual(['application/xml']);
      expect(op.requestBodyContents).toEqual([
        { contentType: 'application/xml', type: { kind: 'model', name: 'CreatePetApplicationXmlRequest' } },
      ]);
      expect(fieldNames(spec.models, 'CreatePetApplicationXmlRequest')).toEqual(['name']);
      expect(collectAlternateRequestBodyContents(op)).toHaveLength(1);
      expectClosed(op, spec.models);
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('Request body of createPet is not read as requestBody');
      expect(messages[0]).toContain('It is carried in requestBodyContents only.');
    });
  });

  describe('every walker reaches a secondary request body', () => {
    const XML_REF = { $ref: '#/components/schemas/XmlWidget' };

    it('through reachability, assignment, the compat filter, the direction index and ref validation', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(
        document(replaceWidget({ 'application/json': { schema: NAME }, 'application/xml': { schema: XML_REF } }), {
          XmlWidget: obj({ id: str, links: obj({ self: str }) }),
        }),
      );
      const op = opsOf(spec).replaceWidget;
      const [service] = spec.services;

      expect([...collectRequestBodyModels(spec.services)].sort()).toEqual(['ReplaceWidgetRequest', 'XmlWidget']);
      const assigned = assignModelsToServices(spec.models, spec.services);
      // Every model in the document — the nested `links` object included — is reachable from this one service.
      expect(spec.models.length).toBeGreaterThan(2);
      for (const model of spec.models) expect(assigned.get(model.name), model.name).toBe(service.name);
      const referenced = collectReferencedNames(spec.services, spec.models);
      for (const model of spec.models) expect(referenced.models.has(model.name), model.name).toBe(true);
      expect(specDerivedNames(spec, nodeHints).has('XmlWidget')).toBe(true);
      expect(directionOf(buildDirectionIndex(spec), 'XmlWidget')).toBe('request');
      expect(directionOf(buildDirectionIndex(spec), 'ReplaceWidgetRequest')).toBe('request');

      validateModelRefs(spec);
      expect(warn).not.toHaveBeenCalled();
      // A dangling reference under a secondary media type is reported with its media type.
      op.requestBodyContents![1].type = { kind: 'model', name: 'Gone' };
      validateModelRefs(spec);
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        `[oagen] Warning: Unresolved model reference "Gone" (context: ${service.name}.replaceWidget.requestBodyContents.application/xml)`,
      ]);
    });
  });

  describe('webhooks', () => {
    it('carry every media type, the picked one sharing requestBody', () => {
      const { webhooks } = extractWebhooks({
        petAdopted: {
          post: {
            requestBody: { content: { 'application/json': { schema: NAME }, 'text/csv': { schema: str } } },
            responses: {},
          },
        },
      });
      const [webhook] = webhooks;
      expect(webhook.requestBody).toEqual({ kind: 'model', name: 'PetAdoptedPayload' });
      expect(webhook.requestBodyContentType).toBe('application/json');
      expect(webhook.requestBodyContentTypes).toEqual(['application/json', 'text/csv']);
      expect(webhook.requestBodyContents).toEqual([
        { contentType: 'application/json', type: { kind: 'model', name: 'PetAdoptedPayload' } },
        { contentType: 'text/csv', type: { kind: 'primitive', type: 'string' } },
      ]);
      expect(webhook.requestBodyContents?.[0].type).toBe(webhook.requestBody);
    });

    it('mint an inline object under a secondary media type as <Stem><MediaType>Payload', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(
        document(
          {},
          {},
          {
            petAdopted: {
              post: {
                requestBody: {
                  content: {
                    'application/json': { schema: NAME },
                    'application/xml; charset=utf-8': { schema: TITLE },
                  },
                },
                responses: {},
              },
            },
          },
        ),
      );
      const [webhook] = spec.webhooks ?? [];
      expect(webhook.requestBodyContents?.[1].type).toEqual({ kind: 'model', name: 'PetAdoptedApplicationXmlPayload' });
      expect(fieldNames(spec.models, 'PetAdoptedApplicationXmlPayload')).toEqual(['title']);
      expect(collectWebhookTypeRefs(webhook)).toEqual([
        { kind: 'model', name: 'PetAdoptedPayload' },
        { kind: 'model', name: 'PetAdoptedApplicationXmlPayload' },
      ]);
      expect(spec.models.map((m) => m.name).sort()).toEqual(['PetAdoptedApplicationXmlPayload', 'PetAdoptedPayload']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('carry an unread payload in requestBodyContents alone, with one warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { webhooks } = extractWebhooks({
        petAdopted: { post: { requestBody: { content: { 'image/png': {} } }, responses: {} } },
      });
      const [webhook] = webhooks;
      expect(Object.keys(webhook)).not.toContain('requestBody');
      expect(Object.keys(webhook)).not.toContain('requestBodyContentType');
      expect(webhook.requestBodyContentTypes).toEqual(['image/png']);
      expect(webhook.requestBodyContents).toEqual([
        { contentType: 'image/png', type: { kind: 'primitive', type: 'unknown' } },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('move the stem when a secondary payload name is taken by a component', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(
        document(
          {},
          { PetAdoptedApplicationXmlPayload: obj({ other: str }) },
          {
            petAdopted: {
              post: {
                requestBody: {
                  content: { 'application/json': { schema: NAME }, 'application/xml': { schema: TITLE } },
                },
                responses: {},
              },
            },
          },
        ),
      );
      const [webhook] = spec.webhooks ?? [];
      const secondary = webhook.requestBodyContents?.[1].type as { kind: 'model'; name: string };
      expect(secondary.name).not.toBe('PetAdoptedApplicationXmlPayload');
      expect(secondary.name.startsWith('PetAdopted')).toBe(true);
      expect(fieldNames(spec.models, secondary.name)).toEqual(['title']);
      expect(fieldNames(spec.models, 'PetAdoptedApplicationXmlPayload')).toEqual(['other']);
      const known = new Set(spec.models.map((m) => m.name));
      for (const ref of collectWebhookTypeRefs(webhook)) {
        for (const name of collectModelRefs(ref)) expect(known).toContain(name);
      }
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('Unresolved'))).toEqual([]);
    });
  });
});
