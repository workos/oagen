import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import {
  extractOperations,
  selectRequestBodyContent,
  schemalessRequestBodyType,
  warnUnreadRequestBody,
} from '../../src/parser/operations.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import { collectModelRefs } from '../../src/ir/types.js';
import type { Model, Operation } from '../../src/ir/types.js';

/**
 * Issue #278: a request body is read from its media type by essence, as a
 * response body is since #240, so `application/json; charset=utf-8`,
 * `APPLICATION/JSON`, a `+json` media type and `multipart/form-data;
 * boundary=x` are no longer dropped — and a body none of whose media types
 * is read is warned about rather than dropped silently. Every pass that asks
 * what the body is (the body extractor, the body-owned query names, the
 * const prefixes, `x-mutually-exclusive-body-groups`, a webhook payload)
 * reads the same pick.
 */

/** The issue's inline object body: `{ name: string }`. */
const NAME_SCHEMA = { type: 'object', properties: { name: { type: 'string' } } };

/** The issue's upload body: `{ name: string, file: binary }`. */
const UPLOAD_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, file: { type: 'string', format: 'binary' } },
};

/** A different inline body, to tell which media type a pick came from. */
const TITLE_SCHEMA = { type: 'object', properties: { title: { type: 'string' } } };

const ok = { '204': { description: 'ok' } };

/** Extract the only operation of a `createPet` POST /pets whose request body declares `content`. */
function createPet(
  content: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): { op: Operation; inlineModels: Model[] } {
  const paths = {
    '/pets': {
      post: { operationId: 'createPet', requestBody: { required: true, content }, responses: ok, ...extra },
    },
  };
  const { services, inlineModels } = extractOperations(paths as never);
  const operations = services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return { op: operations[0], inlineModels };
}

/** The request-body fields an emitter reads together, plus whether the flag key exists at all. */
function bodyFields(op: Operation) {
  return {
    requestBody: op.requestBody,
    requestBodyEncoding: op.requestBodyEncoding,
    requestBodyRequired: op.requestBodyRequired,
    hasFlag: Object.keys(op).includes('requestBodyRequired'),
  };
}

/** Every model the request body references must be one the parser created. */
function expectResolvedBody(op: Operation, inlineModels: Model[]): void {
  const known = new Set(inlineModels.map((m) => m.name));
  expect(op.requestBody).toBeDefined();
  for (const name of collectModelRefs(op.requestBody!)) expect(known).toContain(name);
}

function fieldNames(models: Model[], name: string): string[] | undefined {
  return models.find((m) => m.name === name)?.fields.map((f) => f.name);
}

const DROPPED = (label: string, keys: string) =>
  `[oagen] Warning: Request body of ${label} is not read as requestBody: none of its media types ` +
  `(${keys}) is one the parser reads — application/json or a +json media type, ` +
  `multipart/form-data or application/x-www-form-urlencoded with a schema, application/octet-stream or ` +
  `text/plain with or without one, parameters and case aside. It is carried in requestBodyContents only.`;

describe('request body media types are matched by essence (issue #278)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('through parseSpec (issue repro)', () => {
    let dir: string;
    let specPath: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'oagen-278-'));
      specPath = join(dir, 'repro.json');
      const body = (content: Record<string, unknown>) => ({ required: true, content });
      writeFileSync(
        specPath,
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'repro', version: '1' },
          paths: {
            '/pets': {
              post: {
                operationId: 'createPet',
                requestBody: body({ 'application/json; charset=utf-8': { schema: NAME_SCHEMA } }),
                responses: ok,
              },
            },
            '/pets/{petId}': {
              put: {
                operationId: 'replacePet',
                parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: body({ 'APPLICATION/JSON': { schema: NAME_SCHEMA } }),
                responses: ok,
              },
              patch: {
                operationId: 'updatePet',
                parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: body({ 'application/merge-patch+json': { schema: NAME_SCHEMA } }),
                responses: ok,
              },
            },
            '/notes': {
              post: {
                operationId: 'createNote',
                requestBody: body({ 'application/vnd.api+json': { schema: NAME_SCHEMA } }),
                responses: ok,
              },
            },
            '/widgets': {
              post: {
                operationId: 'uploadWidget',
                requestBody: body({ 'multipart/form-data; boundary=x': { schema: UPLOAD_SCHEMA } }),
                responses: ok,
              },
            },
            '/widgets/{widgetId}': {
              put: {
                operationId: 'replaceWidget',
                parameters: [{ name: 'widgetId', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: body({
                  'application/json': { schema: NAME_SCHEMA },
                  'text/csv': { schema: { type: 'string' } },
                }),
                responses: ok,
              },
            },
          },
          components: {},
        }),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('reads every body, with nothing printed, and leaves no unresolved reference', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseSpec(specPath);
      const projected = spec.services
        .flatMap(({ operations }) => operations)
        .map(({ name, requestBody, requestBodyEncoding, requestBodyRequired }) => ({
          name,
          requestBody,
          requestBodyEncoding,
          requestBodyRequired,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(projected).toEqual([
        {
          name: 'createNote',
          requestBody: { kind: 'model', name: 'CreateNoteRequest' },
          requestBodyEncoding: 'json',
          requestBodyRequired: true,
        },
        {
          name: 'createPet',
          requestBody: { kind: 'model', name: 'CreatePetRequest' },
          requestBodyEncoding: 'json',
          requestBodyRequired: true,
        },
        {
          name: 'replacePet',
          requestBody: { kind: 'model', name: 'ReplacePetRequest' },
          requestBodyEncoding: 'json',
          requestBodyRequired: true,
        },
        {
          name: 'replaceWidget',
          requestBody: { kind: 'model', name: 'ReplaceWidgetRequest' },
          requestBodyEncoding: 'json',
          requestBodyRequired: true,
        },
        {
          name: 'updatePet',
          requestBody: { kind: 'model', name: 'UpdatePetRequest' },
          requestBodyEncoding: 'json',
          requestBodyRequired: true,
        },
        {
          name: 'uploadWidget',
          requestBody: { kind: 'model', name: 'UploadWidgetRequest' },
          requestBodyEncoding: 'form-data',
          requestBodyRequired: true,
        },
      ]);
      expect(spec.models.map(({ name }) => name).sort()).toEqual([
        'CreateNoteRequest',
        'CreatePetRequest',
        'ReplacePetRequest',
        'ReplaceWidgetRequest',
        'UpdatePetRequest',
        'UploadWidgetRequest',
      ]);
      expect(fieldNames(spec.models, 'UploadWidgetRequest')).toEqual(['name', 'file']);
      const known = new Set(spec.models.map((m) => m.name));
      for (const op of spec.services.flatMap((s) => s.operations)) {
        for (const name of collectModelRefs(op.requestBody!)) expect(known).toContain(name);
      }
      // Every body is read, so nothing is printed — the issue's "nothing printed before it" still holds.
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('through parseSpec, a dropped body is reported once per site', () => {
    let dir: string;
    let specPath: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'oagen-278-dropped-'));
      specPath = join(dir, 'dropped.json');
      writeFileSync(
        specPath,
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'dropped', version: '1' },
          paths: {
            '/pets': {
              post: {
                operationId: 'createPet',
                // A POST re-reads the pick for the body-owned query names.
                parameters: [{ name: 'name', in: 'query', schema: { type: 'string' } }],
                requestBody: { required: true, content: { 'application/xml': { schema: NAME_SCHEMA } } },
                responses: ok,
              },
            },
          },
          webhooks: {
            petAdopted: { post: { requestBody: { content: { 'image/png': {} } }, responses: {} } },
          },
          components: {},
        }),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('warns once for the operation and once for the webhook, and sets no body on either', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseSpec(specPath);
      const [op] = spec.services.flatMap((s) => s.operations);
      expect(bodyFields(op)).toEqual({
        requestBody: undefined,
        requestBodyEncoding: undefined,
        requestBodyRequired: undefined,
        hasFlag: false,
      });
      expect(op.queryParams.map((p) => p.name)).toEqual(['name']);
      expect(spec.webhooks?.[0].requestBody).toBeUndefined();
      // The unread XML body is carried in `requestBodyContents`, typed under its media type.
      expect(spec.models.map((m) => m.name)).toEqual(['CreatePetApplicationXmlRequest']);
      expect(op.requestBodyContents?.[0].type).toEqual({ kind: 'model', name: 'CreatePetApplicationXmlRequest' });
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        DROPPED('createPet', 'application/xml'),
        DROPPED('webhooks.petAdopted.post', 'image/png'),
      ]);
    });
  });

  describe('x-mutually-exclusive-body-groups read the body from the same pick (issue repro)', () => {
    const OWNER_BODY = {
      allOf: [
        NAME_SCHEMA,
        {
          oneOf: [
            { type: 'object', properties: { ownerId: { type: 'integer' } }, required: ['ownerId'] },
            {
              type: 'object',
              properties: { ownerEmail: { type: 'string', format: 'email' } },
              required: ['ownerEmail'],
            },
          ],
        },
      ],
    };
    const OWNER_GROUPS = {
      'x-mutually-exclusive-body-groups': {
        owner: { optional: false, variants: { byId: ['ownerId'], byEmail: ['ownerEmail'] } },
      },
    };

    it('types the members from a body under application/json; charset=utf-8, without warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { op } = createPet({ 'application/json; charset=utf-8': { schema: OWNER_BODY } }, OWNER_GROUPS);
      expect(op.parameterGroups).toHaveLength(1);
      const byVariant = Object.fromEntries(
        op.parameterGroups![0].variants.map((v) => [v.name, v.parameters.map((p) => [p.name, p.type])]),
      );
      expect(byVariant).toEqual({
        byId: [['ownerId', { kind: 'primitive', type: 'integer' }]],
        byEmail: [['ownerEmail', { kind: 'primitive', type: 'string', format: 'email' }]],
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('resolves the groups of a +json or upper-cased body exactly as under application/json', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const plain = createPet({ 'application/json': { schema: OWNER_BODY } }, OWNER_GROUPS);
      for (const mediaType of ['application/vnd.api+json', 'APPLICATION/JSON', ' application/json ; charset=utf-8']) {
        const { op } = createPet({ [mediaType]: { schema: OWNER_BODY } }, OWNER_GROUPS);
        expect(op.parameterGroups, mediaType).toEqual(plain.op.parameterGroups);
      }
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('JSON bodies', () => {
    it('reads application/json with a charset parameter as JSON', () => {
      const { op, inlineModels } = createPet({ 'application/json; charset=utf-8': { schema: NAME_SCHEMA } });
      expect(bodyFields(op)).toEqual({
        requestBody: { kind: 'model', name: 'CreatePetRequest' },
        requestBodyEncoding: 'json',
        requestBodyRequired: true,
        hasFlag: true,
      });
      expect(fieldNames(inlineModels, 'CreatePetRequest')).toEqual(['name']);
      expectResolvedBody(op, inlineModels);
    });

    it('matches the media type case-insensitively', () => {
      const { op, inlineModels } = createPet({ 'APPLICATION/JSON': { schema: NAME_SCHEMA } });
      expect(op.requestBody).toEqual({ kind: 'model', name: 'CreatePetRequest' });
      expect(op.requestBodyEncoding).toBe('json');
      expectResolvedBody(op, inlineModels);
    });

    it('ignores whitespace around the essence', () => {
      const { op } = createPet({ ' application/json ; charset=utf-8': { schema: NAME_SCHEMA } });
      expect(op.requestBody).toEqual({ kind: 'model', name: 'CreatePetRequest' });
      expect(op.requestBodyEncoding).toBe('json');
    });

    it('reads a +json media type as JSON', () => {
      for (const mediaType of ['application/vnd.api+json', 'application/merge-patch+json; charset=utf-8']) {
        const { op, inlineModels } = createPet({ [mediaType]: { schema: NAME_SCHEMA } });
        expect(op.requestBody, mediaType).toEqual({ kind: 'model', name: 'CreatePetRequest' });
        expect(op.requestBodyEncoding, mediaType).toBe('json');
        expectResolvedBody(op, inlineModels);
      }
    });

    it('prefers application/json over a +json media type declared before it', () => {
      const { op, inlineModels } = createPet({
        'application/vnd.api+json': { schema: TITLE_SCHEMA },
        'application/json; charset=utf-8': { schema: NAME_SCHEMA },
      });
      expect(op.requestBody).toEqual({ kind: 'model', name: 'CreatePetRequest' });
      expect(fieldNames(inlineModels, 'CreatePetRequest')).toEqual(['name']);
    });

    it('skips a JSON entry without a schema in favour of a +json entry that declares one', () => {
      const { op, inlineModels } = createPet({
        'application/json': {},
        'application/vnd.api+json': { schema: NAME_SCHEMA },
      });
      expect(op.requestBody).toEqual({ kind: 'model', name: 'CreatePetRequest' });
      expect(op.requestBodyEncoding).toBe('json');
      expectResolvedBody(op, inlineModels);
    });

    it('prefers JSON over form, binary and text media types declared before it', () => {
      const { op, inlineModels } = createPet({
        'text/plain; charset=utf-8': { schema: { type: 'string' } },
        'application/octet-stream': {},
        'multipart/form-data; boundary=x': { schema: TITLE_SCHEMA },
        'application/x-www-form-urlencoded': { schema: TITLE_SCHEMA },
        'application/json; charset=utf-8': { schema: NAME_SCHEMA },
      });
      expect(op.requestBody).toEqual({ kind: 'model', name: 'CreatePetRequest' });
      expect(op.requestBodyEncoding).toBe('json');
      expect(fieldNames(inlineModels, 'CreatePetRequest')).toEqual(['name']);
    });

    it('keeps the body of an operation that also offers text/csv', () => {
      const { op } = createPet({
        'application/json': { schema: NAME_SCHEMA },
        'text/csv': { schema: { type: 'string' } },
      });
      expect(op.requestBody).toEqual({ kind: 'model', name: 'CreatePetRequest' });
      expect(op.requestBodyEncoding).toBe('json');
    });
  });

  describe('form bodies', () => {
    it('reads multipart/form-data with a boundary parameter as form-data', () => {
      const { op, inlineModels } = createPet({ 'multipart/form-data; boundary=x': { schema: UPLOAD_SCHEMA } });
      expect(op.requestBody).toEqual({ kind: 'model', name: 'CreatePetRequest' });
      expect(op.requestBodyEncoding).toBe('form-data');
      expect(fieldNames(inlineModels, 'CreatePetRequest')).toEqual(['name', 'file']);
      expectResolvedBody(op, inlineModels);
    });

    it('reads application/x-www-form-urlencoded with a charset parameter as form-urlencoded', () => {
      const { op } = createPet({
        'Application/X-WWW-Form-Urlencoded; charset=utf-8': { schema: NAME_SCHEMA },
      });
      expect(op.requestBody).toEqual({ kind: 'model', name: 'CreatePetRequest' });
      expect(op.requestBodyEncoding).toBe('form-urlencoded');
    });

    it('prefers form-data over form-urlencoded, as before', () => {
      const { op, inlineModels } = createPet({
        'application/x-www-form-urlencoded; charset=utf-8': { schema: TITLE_SCHEMA },
        'multipart/form-data; boundary=x': { schema: NAME_SCHEMA },
      });
      expect(op.requestBodyEncoding).toBe('form-data');
      expect(fieldNames(inlineModels, 'CreatePetRequest')).toEqual(['name']);
    });

    it('does not read a form entry without a schema', () => {
      const { op } = createPet({
        'multipart/form-data; boundary=x': {},
        'application/x-www-form-urlencoded': { schema: NAME_SCHEMA },
      });
      expect(op.requestBodyEncoding).toBe('form-urlencoded');
    });
  });

  describe('binary and text bodies', () => {
    it('types a schema-less application/octet-stream with a parameter as a binary string', () => {
      const { op } = createPet({ 'application/octet-stream; foo=bar': {} });
      expect(bodyFields(op)).toEqual({
        requestBody: { kind: 'primitive', type: 'string', format: 'binary' },
        requestBodyEncoding: 'binary',
        requestBodyRequired: true,
        hasFlag: true,
      });
    });

    it('types a schema-less text/plain with a charset parameter as a string', () => {
      const { op } = createPet({ 'TEXT/PLAIN; charset=utf-8': {} });
      expect(op.requestBody).toEqual({ kind: 'primitive', type: 'string' });
      expect(op.requestBodyEncoding).toBe('text');
    });

    it('types text/plain with a schema from that schema, as before', () => {
      const { op } = createPet({ 'text/plain; charset=utf-8': { schema: { type: 'integer' } } });
      expect(op.requestBody).toEqual({ kind: 'primitive', type: 'integer' });
      expect(op.requestBodyEncoding).toBe('text');
    });

    it('prefers binary over text when both are declared, as before', () => {
      const { op } = createPet({
        'text/plain; charset=utf-8': {},
        'application/octet-stream; foo=bar': {},
      });
      expect(op.requestBodyEncoding).toBe('binary');
    });
  });

  describe('bodies none of whose media types is read', () => {
    it('sets no requestBody for a body under an unread media type and says so once, naming the operation and the key', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { op, inlineModels } = createPet({ 'application/xml': { schema: NAME_SCHEMA } });
      expect(bodyFields(op)).toEqual({
        requestBody: undefined,
        requestBodyEncoding: undefined,
        requestBodyRequired: undefined,
        hasFlag: false,
      });
      // The body is still carried, typed under its media type, in `requestBodyContents`.
      expect(inlineModels.map((m) => m.name)).toEqual(['CreatePetApplicationXmlRequest']);
      expect(op.requestBodyContents?.map((c) => c.type)).toEqual([
        { kind: 'model', name: 'CreatePetApplicationXmlRequest' },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(DROPPED('createPet', 'application/xml'));
    });

    it('lists every declared media type as written', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { op } = createPet({ 'text/csv; header=present': { schema: { type: 'string' } }, 'image/png': {} });
      expect(op.requestBody).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(DROPPED('createPet', 'text/csv; header=present, image/png'));
    });

    it('warns for a JSON entry that declares no schema when nothing else is read', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { op } = createPet({ 'application/json': {} });
      expect(op.requestBody).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(DROPPED('createPet', 'application/json'));
    });

    it('labels a path-named operation by its method and path', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const paths = {
        '/pets': { post: { requestBody: { content: { 'application/xml': { schema: NAME_SCHEMA } } }, responses: ok } },
      };
      extractOperations(paths as never);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(DROPPED('POST /pets', 'application/xml'));
    });

    it('warns once per operation although the pick is re-read by other passes', () => {
      // A POST re-reads the pick for the body-owned query names, the const
      // prefixes and the body groups; a dropped body is still reported once.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { op } = createPet(
        { 'application/xml': { schema: NAME_SCHEMA } },
        {
          parameters: [{ name: 'name', in: 'query', schema: { type: 'string' } }],
          'x-mutually-exclusive-body-groups': { owner: { optional: true, variants: { byId: ['ownerId'] } } },
        },
      );
      expect(op.requestBody).toBeUndefined();
      const dropped = warn.mock.calls.filter((call) => String(call[0]).includes('is not read as requestBody'));
      expect(dropped).toHaveLength(1);
      // With no body read, the query parameter stays a query parameter.
      expect(op.queryParams.map((p) => p.name)).toEqual(['name']);
      expect(op.bodyOwnedQueryParams).toBeUndefined();
    });

    it('stays silent for an operation without a body, or with an empty content map', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const noBody = { '/pets': { post: { operationId: 'createPet', responses: ok } } };
      extractOperations(noBody as never);
      createPet({});
      const { op } = extractOperations({
        '/pets': { post: { operationId: 'createPet', requestBody: {}, responses: ok } },
      } as never).services[0].operations.reduce((_, o) => ({ op: o }), { op: undefined as Operation | undefined });
      expect(op?.requestBody).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('the other passes read the same pick', () => {
    it('owns a query parameter the +json body also declares, as a plain JSON body does', () => {
      const asJson = createPet(
        { 'application/json': { schema: NAME_SCHEMA } },
        { parameters: [{ name: 'name', in: 'query', schema: { type: 'string' } }] },
      );
      expect(asJson.op.queryParams).toEqual([]);
      expect(asJson.op.bodyOwnedQueryParams?.map((p) => p.name)).toEqual(['name']);
      for (const mediaType of ['application/vnd.api+json', 'application/json; charset=utf-8', 'APPLICATION/JSON']) {
        const { op } = createPet(
          { [mediaType]: { schema: NAME_SCHEMA } },
          { parameters: [{ name: 'name', in: 'query', schema: { type: 'string' } }] },
        );
        expect(op.queryParams, mediaType).toEqual([]);
        expect(
          op.bodyOwnedQueryParams?.map((p) => p.name),
          mediaType,
        ).toEqual(['name']);
      }
    });

    it('reads a components/requestBodies ref under a parameterized media type', () => {
      const paths = {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: { $ref: '#/components/requestBodies/Pet' },
            responses: ok,
          },
        },
      };
      const requestBodies = {
        Pet: { required: true, content: { 'application/json; charset=utf-8': { schema: NAME_SCHEMA } } },
      };
      const { services, inlineModels } = extractOperations(
        paths as never,
        undefined,
        undefined,
        undefined,
        requestBodies,
      );
      const [op] = services.flatMap((s) => s.operations);
      expect(bodyFields(op)).toEqual({
        requestBody: { kind: 'model', name: 'CreatePetRequest' },
        requestBodyEncoding: 'json',
        requestBodyRequired: true,
        hasFlag: true,
      });
      expectResolvedBody(op, inlineModels);
    });
  });

  describe('webhook payloads', () => {
    it('reads a payload under a +json or parameterized media type', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { webhooks, inlineModels } = extractWebhooks({
        petAdopted: {
          post: { requestBody: { content: { 'application/vnd.api+json': { schema: NAME_SCHEMA } } }, responses: {} },
        },
        petUploaded: {
          post: {
            requestBody: { content: { 'multipart/form-data; boundary=x': { schema: UPLOAD_SCHEMA } } },
            responses: {},
          },
        },
      });
      expect(webhooks.map((w) => [w.name, w.requestBody, w.requestBodyEncoding])).toEqual([
        ['petAdopted', { kind: 'model', name: 'PetAdoptedPayload' }, 'json'],
        ['petUploaded', { kind: 'model', name: 'PetUploadedPayload' }, 'form-data'],
      ]);
      expect(fieldNames(inlineModels, 'PetUploadedPayload')).toEqual(['name', 'file']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns once, under the webhook label, for a payload none of whose media types is read', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { webhooks } = extractWebhooks({
        petAdopted: { post: { requestBody: { content: { 'image/png': {} } }, responses: {} } },
      });
      expect(webhooks[0].requestBody).toBeUndefined();
      expect(Object.keys(webhooks[0])).not.toContain('requestBody');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(DROPPED('webhooks.petAdopted.post', 'image/png'));
    });
  });

  describe('selectRequestBodyContent', () => {
    it('returns the picked key as written, with its encoding and schema', () => {
      expect(
        selectRequestBodyContent({ content: { ' Application/JSON ; charset=utf-8': { schema: NAME_SCHEMA } } }),
      ).toEqual({
        contentType: ' Application/JSON ; charset=utf-8',
        essence: 'application/json',
        encoding: 'json',
        schema: NAME_SCHEMA,
      });
    });

    it('is undefined without content, with an empty content map, and when nothing is read', () => {
      expect(selectRequestBodyContent(undefined)).toBeUndefined();
      expect(selectRequestBodyContent({})).toBeUndefined();
      expect(selectRequestBodyContent({ content: {} })).toBeUndefined();
      expect(selectRequestBodyContent({ content: { 'application/xml': { schema: NAME_SCHEMA } } })).toBeUndefined();
    });

    it('takes the first key in document order within one tier', () => {
      expect(
        selectRequestBodyContent({
          content: {
            'application/hal+json': { schema: TITLE_SCHEMA },
            'application/vnd.api+json': { schema: NAME_SCHEMA },
          },
        }),
      ).toMatchObject({ contentType: 'application/hal+json', encoding: 'json' });
    });

    it('does not warn on its own, so the passes that re-read the pick stay silent', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      selectRequestBodyContent({ content: { 'application/xml': { schema: NAME_SCHEMA } } });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('warnUnreadRequestBody', () => {
    it('warns only for a body that declares media types none of which is read', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      warnUnreadRequestBody(undefined, 'createPet');
      warnUnreadRequestBody({}, 'createPet');
      warnUnreadRequestBody({ content: {} }, 'createPet');
      warnUnreadRequestBody({ content: { 'application/vnd.api+json': { schema: NAME_SCHEMA } } }, 'createPet');
      warnUnreadRequestBody({ content: { 'application/octet-stream; foo=bar': {} } }, 'createPet');
      expect(warn).not.toHaveBeenCalled();
      warnUnreadRequestBody({ content: { 'application/xml': { schema: NAME_SCHEMA } } }, 'createPet');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(DROPPED('createPet', 'application/xml'));
    });
  });

  describe('schemalessRequestBodyType', () => {
    it('types a binary body as a binary string, a text body as a string, and nothing else', () => {
      expect(schemalessRequestBodyType('binary')).toEqual({ kind: 'primitive', type: 'string', format: 'binary' });
      expect(schemalessRequestBodyType('text')).toEqual({ kind: 'primitive', type: 'string' });
      expect(schemalessRequestBodyType('json')).toBeUndefined();
      expect(schemalessRequestBodyType('form-data')).toBeUndefined();
      expect(schemalessRequestBodyType('form-urlencoded')).toBeUndefined();
    });
  });
});
