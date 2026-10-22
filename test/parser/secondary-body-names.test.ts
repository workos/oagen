import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import { collectModelRefs } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';
import { expectNameInvariants } from './name-invariants.test.js';

/**
 * Round 2 on #278, one class: a name minted for a secondary body is checked
 * against everything that owns a name — the other spellings of one media
 * type declared beside it, every enum (component or minted) when the
 * deferred registry names a model, and every model when an inline enum is
 * promoted — so no two public symbols ever share one name and no entry ever
 * points at a model with another entry's fields.
 */

/** Parse an inline OpenAPI document through the whole pipeline. */
async function parseDocument(document: Record<string, unknown>): Promise<ApiSpec> {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-278-names-'));
  try {
    const file = join(dir, 'spec.json');
    writeFileSync(file, JSON.stringify(document));
    return await parseSpec(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
const OTHER = obj({ other: { type: 'integer' } });
const MODE = { type: 'string', enum: ['draft', 'live'] };
const ok = { '204': { description: 'ok' } };

/** PUT /widgets/{widgetId} as `replaceWidget` with the given request body `content` (and extras). */
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

/** GET /widgets/{widgetId} as `getWidget` with the given responses. */
function getWidget(responses: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '/widgets/{widgetId}': {
      get: {
        operationId: 'getWidget',
        parameters: [{ name: 'widgetId', in: 'path', required: true, schema: str }],
        responses,
        ...extra,
      },
    },
  };
}

/**
 * GET /widget/{widgetId} as `getWidget`, under the singular service `Widget`:
 * a header or parameter enum and a header model are named from the service
 * (`WidgetXMeta`, `WidgetMode`), and a component schema keeps a singular
 * name through `cleanSchemaName` (`Widgets…` would become `Widget…`), so a
 * component declared under that very name clashes with them.
 */
function getOneWidget(
  responses: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    '/widget/{widgetId}': {
      get: {
        operationId: 'getWidget',
        parameters: [{ name: 'widgetId', in: 'path', required: true, schema: str }],
        responses,
        ...extra,
      },
    },
  };
}

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

const fieldNames = (models: Model[], name: string): string[] | undefined =>
  models.find((m) => m.name === name)?.fields.map((f) => f.name);

const modelName = (type: TypeRef | undefined): string => {
  const [name] = collectModelRefs(type!);
  return name;
};

describe('secondary-body names step around every owner (issue #278, round 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('two spellings of one media type declared side by side', () => {
    const XML_TITLE = { 'application/xml': { schema: TITLE } };
    const XML_OTHER_CHARSET = { 'APPLICATION/XML; charset=utf-8': { schema: OTHER } };

    it('take names from their parameters, whatever their order, on an operation', async () => {
      for (const content of [
        { 'application/json': { schema: NAME }, ...XML_TITLE, ...XML_OTHER_CHARSET },
        { 'application/json': { schema: NAME }, ...XML_OTHER_CHARSET, ...XML_TITLE },
      ]) {
        const spec = await parseDocument(document(replaceWidget(content)));
        const op = opsOf(spec).replaceWidget;
        const byKey = Object.fromEntries(op.requestBodyContents!.map((c) => [c.contentType, modelName(c.type)]));
        expect(byKey['application/xml']).toBe('ReplaceWidgetApplicationXmlRequest');
        expect(byKey['APPLICATION/XML; charset=utf-8']).toBe('ReplaceWidgetApplicationXmlCharsetUtf8Request');
        expect(fieldNames(spec.models, 'ReplaceWidgetApplicationXmlRequest')).toEqual(['title']);
        expect(fieldNames(spec.models, 'ReplaceWidgetApplicationXmlCharsetUtf8Request')).toEqual(['other']);
        expectNameInvariants(spec);
      }
    });

    it('case-only spellings with different shapes step to a numeric suffix, in document order', async () => {
      const spec = await parseDocument(
        document(
          replaceWidget({
            'application/json': { schema: NAME },
            'Application/XML': { schema: TITLE },
            'APPLICATION/XML': { schema: OTHER },
          }),
        ),
      );
      const op = opsOf(spec).replaceWidget;
      expect(op.requestBodyContents?.map((c) => modelName(c.type))).toEqual([
        'ReplaceWidgetRequest',
        'ReplaceWidgetApplicationXmlRequest',
        'ReplaceWidgetApplicationXmlRequest2',
      ]);
      expect(fieldNames(spec.models, 'ReplaceWidgetApplicationXmlRequest')).toEqual(['title']);
      expect(fieldNames(spec.models, 'ReplaceWidgetApplicationXmlRequest2')).toEqual(['other']);
      expectNameInvariants(spec);
    });

    it('case-only spellings with one shape share one model', async () => {
      const spec = await parseDocument(
        document(
          replaceWidget({
            'application/json': { schema: NAME },
            'Application/XML': { schema: TITLE },
            'APPLICATION/XML': { schema: TITLE },
          }),
        ),
      );
      const op = opsOf(spec).replaceWidget;
      expect(op.requestBodyContents?.map((c) => modelName(c.type))).toEqual([
        'ReplaceWidgetRequest',
        'ReplaceWidgetApplicationXmlRequest',
        'ReplaceWidgetApplicationXmlRequest',
      ]);
      expect(spec.models.filter((m) => m.name.startsWith('ReplaceWidgetApplicationXml'))).toHaveLength(1);
      expectNameInvariants(spec);
    });

    it('take names from their parameters on a webhook', () => {
      const { webhooks, inlineModels } = extractWebhooks({
        petAdopted: {
          post: {
            requestBody: { content: { 'application/json': { schema: NAME }, ...XML_TITLE, ...XML_OTHER_CHARSET } },
            responses: {},
          },
        },
      });
      const [webhook] = webhooks;
      expect(webhook.requestBodyContents?.map((c) => modelName(c.type))).toEqual([
        'PetAdoptedPayload',
        'PetAdoptedApplicationXmlPayload',
        'PetAdoptedApplicationXmlCharsetUtf8Payload',
      ]);
      expect(fieldNames(inlineModels, 'PetAdoptedApplicationXmlPayload')).toEqual(['title']);
      expect(fieldNames(inlineModels, 'PetAdoptedApplicationXmlCharsetUtf8Payload')).toEqual(['other']);
    });

    it('case-only spellings on a webhook: different shapes take separate names, one shape shares', () => {
      const differing = extractWebhooks({
        petAdopted: {
          post: {
            requestBody: {
              content: {
                'application/json': { schema: NAME },
                'application/xml': { schema: TITLE },
                'APPLICATION/XML': { schema: OTHER },
              },
            },
            responses: {},
          },
        },
      });
      const [webhook] = differing.webhooks;
      expect(webhook.requestBodyContents?.map((c) => modelName(c.type))).toEqual([
        'PetAdoptedPayload',
        'PetAdoptedApplicationXmlPayload',
        'PetAdoptedApplicationXmlPayload2',
      ]);
      expect(fieldNames(differing.inlineModels, 'PetAdoptedApplicationXmlPayload')).toEqual(['title']);
      expect(fieldNames(differing.inlineModels, 'PetAdoptedApplicationXmlPayload2')).toEqual(['other']);

      const same = extractWebhooks({
        petAdopted: {
          post: {
            requestBody: {
              content: {
                'application/json': { schema: NAME },
                'application/xml': { schema: TITLE },
                'APPLICATION/XML': { schema: TITLE },
              },
            },
            responses: {},
          },
        },
      });
      expect(same.webhooks[0].requestBodyContents?.map((c) => modelName(c.type))).toEqual([
        'PetAdoptedPayload',
        'PetAdoptedApplicationXmlPayload',
        'PetAdoptedApplicationXmlPayload',
      ]);
      expect(same.inlineModels.map((m) => m.name)).toEqual(['PetAdoptedPayload', 'PetAdoptedApplicationXmlPayload']);
    });
  });

  describe('the deferred registry reserves every enum name', () => {
    it('a secondary request body steps off a component enum of its name', async () => {
      const spec = await parseDocument(
        document(replaceWidget({ 'application/json': { schema: NAME }, 'text/csv': { schema: obj({ row: str }) } }), {
          ReplaceWidgetTextCsvRequest: MODE,
        }),
      );
      const op = opsOf(spec).replaceWidget;
      expect(modelName(op.requestBodyContents?.[1].type)).toBe('ReplaceWidgetTextCsvRequest2');
      expect(fieldNames(spec.models, 'ReplaceWidgetTextCsvRequest2')).toEqual(['row']);
      expect(spec.enums.map((e) => e.name)).toContain('ReplaceWidgetTextCsvRequest');
      expectNameInvariants(spec);
    });

    it('a secondary request body steps off an inline enum a component field minted', async () => {
      const spec = await parseDocument(
        document(replaceWidget({ 'application/json': { schema: NAME }, 'text/csv': { schema: obj({ row: str }) } }), {
          ReplaceWidget: obj({ text_csv_request: MODE }),
        }),
      );
      const op = opsOf(spec).replaceWidget;
      const minted = modelName(op.requestBodyContents?.[1].type);
      expect(spec.enums.map((e) => e.name)).toContain('ReplaceWidgetTextCsvRequest');
      expect(minted).not.toBe('ReplaceWidgetTextCsvRequest');
      expect(fieldNames(spec.models, minted)).toEqual(['row']);
      expectNameInvariants(spec);
    });

    it('a secondary response body steps off a component enum of its name', async () => {
      const spec = await parseDocument(
        document(
          getWidget({
            '200': {
              description: 'ok',
              content: {
                'application/json': { schema: NAME },
                'application/x-ndjson': { schema: obj({ line: str }) },
              },
            },
          }),
          { GetWidgetApplicationXNdjsonResponse: MODE },
        ),
      );
      const op = opsOf(spec).getWidget;
      const minted = modelName(op.responseContents?.[1].type);
      expect(minted).not.toBe('GetWidgetApplicationXNdjsonResponse');
      expect(fieldNames(spec.models, minted)).toEqual(['line']);
      expect(spec.enums.map((e) => e.name)).toContain('GetWidgetApplicationXNdjsonResponse');
      expectNameInvariants(spec);
    });

    it('a response header model steps off a component enum of its name', async () => {
      const spec = await parseDocument(
        document(
          getOneWidget({
            '200': {
              description: 'ok',
              headers: { 'X-Meta': { schema: obj({ origin: str }) } },
              content: { 'application/json': { schema: NAME } },
            },
          }),
          { WidgetXMeta: MODE },
        ),
      );
      const op = opsOf(spec).getWidget;
      const header = op.responseHeaders?.find((h) => h.name === 'X-Meta');
      const minted = modelName(header?.type);
      expect(spec.enums.map((e) => e.name)).toContain('WidgetXMeta');
      expect(minted).not.toBe('WidgetXMeta');
      expect(fieldNames(spec.models, minted)).toEqual(['origin']);
      expectNameInvariants(spec);
    });
  });

  describe('an inline enum never takes a model name', () => {
    const enumOf = (spec: ApiSpec, type: TypeRef | undefined): string => {
      let found: string | undefined;
      for (const e of spec.enums) if (JSON.stringify(type).includes(`"${e.name}"`)) found = e.name;
      expect(found, JSON.stringify(type)).toBeDefined();
      return found!;
    };

    it('under a secondary request media type', async () => {
      const spec = await parseDocument(
        document(replaceWidget({ 'application/json': { schema: NAME }, 'text/csv': { schema: MODE } }), {
          ReplaceWidgetTextCsvRequest: obj({ other: str }),
        }),
      );
      const op = opsOf(spec).replaceWidget;
      const name = enumOf(spec, op.requestBodyContents?.[1].type);
      expect(name).not.toBe('ReplaceWidgetTextCsvRequest');
      expect(fieldNames(spec.models, 'ReplaceWidgetTextCsvRequest')).toEqual(['other']);
      expect(spec.enums.find((e) => e.name === name)?.values.map((v) => v.value)).toEqual(['draft', 'live']);
      expectNameInvariants(spec);
    });

    it('on a response header', async () => {
      const spec = await parseDocument(
        document(
          getOneWidget({
            '200': {
              description: 'ok',
              headers: { 'X-Mode': { schema: MODE } },
              content: { 'application/json': { schema: NAME } },
            },
          }),
          { WidgetXMode: obj({ other: str }) },
        ),
      );
      const header = opsOf(spec).getWidget.responseHeaders?.find((h) => h.name === 'X-Mode');
      const name = enumOf(spec, header?.type);
      expect(name).not.toBe('WidgetXMode');
      expect(fieldNames(spec.models, 'WidgetXMode')).toEqual(['other']);
      expectNameInvariants(spec);
    });

    it('as an error body', async () => {
      const spec = await parseDocument(
        document(
          getWidget({
            '200': { description: 'ok', content: { 'application/json': { schema: NAME } } },
            '404': { description: 'missing', content: { 'application/json': { schema: MODE } } },
          }),
          { GetWidgetError404: obj({ other: str }) },
        ),
      );
      const error = opsOf(spec).getWidget.errors.find((e) => e.statusCode === 404);
      const name = enumOf(spec, error?.type);
      expect(name).not.toBe('GetWidgetError404');
      expect(fieldNames(spec.models, 'GetWidgetError404')).toEqual(['other']);
      expectNameInvariants(spec);
    });

    it('on a query parameter', async () => {
      const spec = await parseDocument(
        document(
          getOneWidget(
            { '200': { description: 'ok', content: { 'application/json': { schema: NAME } } } },
            {
              parameters: [
                { name: 'widgetId', in: 'path', required: true, schema: str },
                { name: 'mode', in: 'query', schema: MODE },
              ],
            },
          ),
          { WidgetMode: obj({ other: str }) },
        ),
      );
      const param = opsOf(spec).getWidget.queryParams.find((p) => p.name === 'mode');
      const name = enumOf(spec, param?.type);
      expect(name).not.toBe('WidgetMode');
      expect(fieldNames(spec.models, 'WidgetMode')).toEqual(['other']);
      expectNameInvariants(spec);
    });
  });
});
