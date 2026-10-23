import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import { resolveComponentRef, resolvePathItemRef } from '../../src/parser/path-item-refs.js';
import { collectReferencedNames } from '../../src/engine/generate-files.js';
import { collectResponseHeaders, collectWebhookTypeRefs, walkTypeRef } from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #300: a `paths` entry written as a `$ref` into `components/pathItems`
 * (OpenAPI 3.1) is resolved before anything is read from it — chains
 * included, fields beside the `$ref` ignored — through `resolvePathItemRef`,
 * the one resolver a `webhooks` entry goes through too, so the referenced
 * Path Item's operations, `parameters`, `servers`, `summary` and
 * `description` reach the IR exactly as an inline Path Item's do. An entry
 * that cannot be resolved is warned about once and skipped.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function parseDocument(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-300-'));
  dirs.push(dir);
  const file = path.join(dir, 'repro.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

const responses = { '200': { description: 'OK' } };

type ComponentPathItems = Record<string, Record<string, unknown>>;

/** `extractOperations` on `paths`, resolving `$ref` entries against `pathItems`. */
function operationsOf(paths: Record<string, unknown>, pathItems?: ComponentPathItems) {
  return extractOperations(
    paths as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pathItems,
  );
}

/** Every operation of every service, in order. */
function allOperations(spec: Pick<ApiSpec, 'services'>): Operation[] {
  return spec.services.flatMap((s) => s.operations);
}

/** Every type reference an operation holds. */
function operationRefs(op: Operation): TypeRef[] {
  const params = [
    ...op.pathParams,
    ...op.queryParams,
    ...(op.bodyOwnedQueryParams ?? []),
    ...op.headerParams,
    ...(op.cookieParams ?? []),
  ];
  return [
    op.response,
    ...(op.requestBody ? [op.requestBody] : []),
    ...(op.successResponses ?? []).map((r) => r.type),
    ...op.errors.flatMap((e) => (e.type ? [e.type] : [])),
    ...(op.pagination ? [op.pagination.itemType, ...(op.pagination.envelopeFields ?? []).map((f) => f.type)] : []),
    ...collectResponseHeaders(op).map((h) => h.type),
    ...params.map((p) => p.type),
  ];
}

/**
 * Every model and enum reference — from operations, webhooks and model
 * fields — names a model or enum of the spec, and no model or enum is
 * orphaned once operations and webhooks seed reachability.
 */
function expectResolvedAndReferenced(spec: ApiSpec): void {
  const models = new Set(spec.models.map((m) => m.name));
  const enums = new Set(spec.enums.map((e) => e.name));
  const refs: TypeRef[] = [
    ...allOperations(spec).flatMap(operationRefs),
    ...(spec.webhooks ?? []).flatMap((hook) => [...collectWebhookTypeRefs(hook)]),
    ...spec.models.flatMap((m) => m.fields.map((f) => f.type)),
  ];
  for (const ref of refs) {
    walkTypeRef(ref, {
      model: (r) => expect(models.has(r.name), r.name).toBe(true),
      enum: (r) => expect(enums.has(r.name), r.name).toBe(true),
    });
  }
  const referenced = collectReferencedNames(spec.services, spec.models, { webhooks: spec.webhooks });
  for (const model of spec.models) expect(referenced.models.has(model.name), model.name).toBe(true);
  for (const e of spec.enums) expect(referenced.enums.has(e.name), e.name).toBe(true);
}

describe('path items written as a $ref (issue #300)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every `[oagen] Warning:` emitted so far. */
  function warnings(): string[] {
    const messages = warn.mock.calls.map((call: unknown[]) => String(call[0]));
    for (const message of messages) expect(message).toContain('[oagen] Warning:');
    return messages;
  }

  describe('the issue repro, through parseSpec', () => {
    // The issue's `pets.json`, verbatim: the document's servers, `/pets`
    // written as a `$ref`, and the referenced item carrying its own servers.
    const pets = {
      servers: [{ url: 'https://pets.example.com' }],
      get: { operationId: 'listPets' },
    };
    const repro = {
      openapi: '3.1.0',
      info: { title: 'pets', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: { '/pets': { $ref: '#/components/pathItems/Pets' } },
      components: { pathItems: { Pets: pets } },
    };

    it("extracts listPets from the referenced Path Item, its servers included (the issue's expected output)", async () => {
      const spec = await parseDocument(repro);

      expect(spec.services.map((s) => s.name)).toEqual(['Pets']);
      const [listPets] = allOperations(spec);
      expect(listPets.name).toBe('listPets');
      expect(listPets.path).toBe('/pets');
      expect(listPets.servers).toEqual([{ url: 'https://pets.example.com' }]);
      // The document's own list is untouched.
      expect(spec.servers).toEqual([{ url: 'https://api.example.com' }]);
      expect(warnings().filter((m) => m.includes('path item'))).toEqual([]);
      expectResolvedAndReferenced(spec);
    });

    it('gives the same IR as the same Path Item written inline under /pets', async () => {
      const viaRef = await parseDocument(repro);
      const refWarnings = warnings();
      warn.mockClear();
      const inline = await parseDocument({ ...repro, paths: { '/pets': pets }, components: {} });

      expect(viaRef.services).toEqual(inline.services);
      expect(viaRef.models).toEqual(inline.models);
      expect(viaRef.enums).toEqual(inline.enums);
      expect(refWarnings).toEqual(warnings());
    });
  });

  describe('what the referenced Path Item carries', () => {
    const target = {
      summary: 'A pet',
      description: 'One pet by id.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      servers: [{ url: 'https://pets.example.com' }],
      get: { operationId: 'getPet', responses },
    };

    it('reads parameters, servers, summary and description through a chain of refs, as for an inline item', () => {
      const viaRef = operationsOf(
        { '/pets/{id}': { $ref: '#/components/pathItems/A' } },
        { A: { $ref: '#/components/pathItems/B~1C' }, 'B/C': target },
      );
      const inline = operationsOf({ '/pets/{id}': target });

      expect(viaRef).toEqual(inline);
      const [getPet] = allOperations(viaRef);
      expect(getPet.pathParams.map((p) => p.name)).toEqual(['id']);
      expect(getPet.servers).toEqual([{ url: 'https://pets.example.com' }]);
      expect(getPet.summary).toBe('A pet');
      expect(getPet.description).toBe('A pet\n\nOne pet by id.');
      expect(warn).not.toHaveBeenCalled();
    });

    it('takes the referenced item whole: fields written beside the $ref are not read, and are reported once', () => {
      const { services } = operationsOf(
        {
          '/pets/{id}': {
            $ref: '#/components/pathItems/Pet',
            summary: 'Beside the ref',
            parameters: [{ name: 'beside', in: 'query', schema: { type: 'string' } }],
            servers: [{ url: 'https://beside.example.com' }],
            post: { operationId: 'besideTheRef', responses },
          },
        },
        { Pet: target },
      );

      const ops = allOperations({ services });
      expect(ops.map((op) => op.name)).toEqual(['getPet']);
      expect(ops[0].summary).toBe('A pet');
      expect(ops[0].queryParams).toEqual([]);
      expect(ops[0].servers).toEqual([{ url: 'https://pets.example.com' }]);
      // Reported once, naming the keys: the `post` beside the ref is not lost silently.
      expect(warnings()).toEqual([
        '[oagen] Warning: Path "/pets/{id}" has fields beside its $ref ("summary", "parameters", "servers", "post") that are not read: the referenced path item is taken whole.',
      ]);
    });

    it('resolves the entry before the API-root and model-name passes read it, as for an inline item', () => {
      // Untagged, operationId-less operations: the service and operation
      // names come from the path under the document's API root, and the
      // inline model names from the path prefix — two paths that flatten to
      // one prefix get one disambiguated.
      const notes = {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': { schema: { type: 'object', properties: { title: { type: 'string' } } } },
              },
            },
          },
        },
      };
      const body = {
        post: {
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } } } } },
          },
          responses,
        },
      };
      const viaRef = operationsOf(
        {
          '/api/v1/notes': { $ref: '#/components/pathItems/Notes' },
          '/foo-bar': { $ref: '#/components/pathItems/Body' },
          '/foo/bar': { $ref: '#/components/pathItems/Body' },
        },
        { Notes: notes, Body: body },
      );
      const inline = operationsOf({ '/api/v1/notes': notes, '/foo-bar': body, '/foo/bar': body });

      expect(viaRef).toEqual(inline);
      expect(viaRef.services.map((s) => [s.name, s.operations.map((op) => op.name)])).toEqual([
        ['Notes', ['list']],
        ['FooBar', ['create']],
        ['Foo', ['createBar']],
      ]);
      expect(viaRef.inlineModels.map((m) => m.name)).toEqual(inline.inlineModels.map((m) => m.name));
      expect(new Set(viaRef.inlineModels.map((m) => m.name)).size).toBe(viaRef.inlineModels.length);
    });
  });

  describe('two paths that $ref one entry', () => {
    const pets = { get: { operationId: 'listPets', responses } };

    it('are two operations read from one Operation Object, named as a reused operationId is within one service', () => {
      const { services } = operationsOf(
        { '/pets': { $ref: '#/components/pathItems/Pets' }, '/pets/all': { $ref: '#/components/pathItems/Pets' } },
        { Pets: pets },
      );

      expect(services.map((s) => [s.name, s.operations.map((op) => [op.name, op.path])])).toEqual([
        [
          'Pets',
          [
            ['listPets', '/pets'],
            ['listPets2', '/pets/all'],
          ],
        ],
      ]);
      expect(warnings()).toMatchInlineSnapshot(`
        [
          "[oagen] Warning: Operations GET /pets and GET /pets/all in service Pets both take the name "listPets" from their operationId; the latter is renamed "listPets2" — give each a distinct operationId",
        ]
      `);
    });

    it('keep one name each when they land in different services', () => {
      const { services } = operationsOf(
        { '/pets': { $ref: '#/components/pathItems/Pets' }, '/animals': { $ref: '#/components/pathItems/Pets' } },
        { Pets: pets },
      );

      expect(services.map((s) => [s.name, s.operations.map((op) => op.name)])).toEqual([
        ['Pets', ['listPets']],
        ['Animals', ['listPets']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('entries the resolver rejects', () => {
    it('warns once per entry, naming the path, and keeps every other path', () => {
      const { services } = operationsOf(
        {
          '/not-an-object': 'get',
          '/null': null,
          '/non-string-ref': { $ref: 42 },
          '/elsewhere': { $ref: '#/components/schemas/Pet' },
          '/another-path': { $ref: '#/paths/~1kept' },
          '/dangling': { $ref: '#/components/pathItems/Missing' },
          '/loop': { $ref: '#/components/pathItems/Loop' },
          '/kept': { get: { operationId: 'kept', responses } },
          '/kept-by-ref': { $ref: '#/components/pathItems/Kept' },
        },
        { Loop: { $ref: '#/components/pathItems/Loop' }, Kept: { get: { operationId: 'keptByRef', responses } } },
      );

      expect(allOperations({ services }).map((op) => [op.name, op.path])).toEqual([
        ['kept', '/kept'],
        ['keptByRef', '/kept-by-ref'],
      ]);
      expect(warnings()).toMatchInlineSnapshot(`
        [
          "[oagen] Warning: Path "/not-an-object" is not a path item object; skipping it.",
          "[oagen] Warning: Path "/null" is not a path item object; skipping it.",
          "[oagen] Warning: Path "/non-string-ref" has a non-string $ref; skipping it.",
          "[oagen] Warning: Unresolved path item $ref "#/components/schemas/Pet" for path "/elsewhere": no matching entry under components/pathItems. Skipping the path.",
          "[oagen] Warning: Unresolved path item $ref "#/paths/~1kept" for path "/another-path": no matching entry under components/pathItems. Skipping the path.",
          "[oagen] Warning: Unresolved path item $ref "#/components/pathItems/Missing" for path "/dangling": no matching entry under components/pathItems. Skipping the path.",
          "[oagen] Warning: Circular path item $ref chain starting at "#/components/pathItems/Loop" for path "/loop"; skipping it.",
        ]
      `);
    });

    it('does not resolve a $ref when the document declares no components/pathItems', () => {
      const { services } = operationsOf({ '/pets': { $ref: '#/components/pathItems/Pets' } });

      expect(services).toEqual([]);
      expect(warnings()).toEqual([
        '[oagen] Warning: Unresolved path item $ref "#/components/pathItems/Pets" for path "/pets": no matching entry under components/pathItems. Skipping the path.',
      ]);
    });
  });

  describe('x- keys, which are specification extensions and never path items', () => {
    const pets = { get: { operationId: 'listPets', responses } };
    const adopted = { post: { operationId: 'adopted', responses } };

    it('steps over a scalar extension beside a path, without a warning', () => {
      const { services } = operationsOf({ 'x-internal': true, '/pets': pets });

      expect(allOperations({ services }).map((op) => [op.name, op.path])).toEqual([['listPets', '/pets']]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('steps over an object-valued extension beside a path, even one shaped like a path item or a ref', () => {
      // `x-alias` resolves to a real item: still an extension, never an `XAlias` service.
      const { services } = operationsOf(
        {
          'x-group': { get: { operationId: 'notAnOperation', responses } },
          'x-alias': { $ref: '#/components/pathItems/Pets' },
          'x-ref': { $ref: '#/components/pathItems/Missing' },
          '/pets': pets,
        },
        { Pets: pets },
      );

      expect(services.map((s) => s.name)).toEqual(['Pets']);
      expect(allOperations({ services }).map((op) => [op.name, op.path])).toEqual([['listPets', '/pets']]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('steps over a scalar extension beside a webhook, without a warning', () => {
      const { webhooks } = extractWebhooks({ 'x-internal': true, petAdopted: adopted });

      expect(webhooks.map((w) => [w.name, w.operationId])).toEqual([['petAdopted', 'adopted']]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('steps over an object-valued extension beside a webhook, even one shaped like a path item or a ref', () => {
      const { webhooks } = extractWebhooks(
        {
          'x-event': { post: { operationId: 'notAWebhook', responses } },
          'x-alias': { $ref: '#/components/pathItems/Adopted' },
          'x-ref': { $ref: '#/components/pathItems/Missing' },
          petAdopted: adopted,
        },
        { pathItems: { Adopted: adopted } },
      );

      expect(webhooks.map((w) => [w.name, w.operationId])).toEqual([['petAdopted', 'adopted']]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps the extensions out of the IR through parseSpec, paths and webhooks alike', async () => {
      const spec = await parseDocument({
        openapi: '3.1.0',
        info: { title: 'ext', version: '1' },
        paths: {
          'x-internal': true,
          'x-group': { get: { operationId: 'notAnOperation', responses } },
          'x-alias': { $ref: '#/components/pathItems/Pets' },
          '/pets': pets,
        },
        webhooks: {
          'x-note': 'text',
          'x-event': { post: { operationId: 'notAWebhook', responses } },
          'x-alias': { $ref: '#/components/pathItems/Adopted' },
          petAdopted: adopted,
        },
        components: { pathItems: { Pets: pets, Adopted: adopted } },
      });

      expect(spec.services.map((s) => s.name)).toEqual(['Pets']);
      expect(allOperations(spec).map((op) => [op.name, op.path])).toEqual([['listPets', '/pets']]);
      expect(spec.webhooks?.map((w) => [w.name, w.operationId])).toEqual([['petAdopted', 'adopted']]);
      expect(warn).not.toHaveBeenCalled();
      expectResolvedAndReferenced(spec);
    });
  });

  describe('one resolver for paths and webhooks', () => {
    it('reads one components/pathItems entry as both an operation and a webhook', async () => {
      const spec = await parseDocument({
        openapi: '3.1.0',
        info: { title: 'shared', version: '1' },
        paths: { '/pet-events': { $ref: '#/components/pathItems/PetEvent' } },
        webhooks: { petEvent: { $ref: '#/components/pathItems/PetEvent' } },
        components: {
          pathItems: {
            PetEvent: {
              post: {
                operationId: 'petEvent',
                requestBody: {
                  content: {
                    'application/json': { schema: { type: 'object', properties: { pet_id: { type: 'string' } } } },
                  },
                },
                responses,
              },
            },
          },
        },
      });

      expect(allOperations(spec).map((op) => [op.name, op.path, op.requestBody])).toEqual([
        ['petEvent', '/pet-events', { kind: 'model', name: 'PetEventRequest' }],
      ]);
      expect(spec.webhooks?.map((w) => [w.name, w.httpMethod, w.operationId, w.requestBody])).toEqual([
        ['petEvent', 'post', 'petEvent', { kind: 'model', name: 'PetEventPayload' }],
      ]);
      expect(warn).not.toHaveBeenCalled();
      expectResolvedAndReferenced(spec);
    });

    it('labels the same failures by their site: a path, or a webhook', () => {
      const entries: Record<string, unknown> = {
        notAnObject: 'post',
        elsewhere: { $ref: '#/components/schemas/Pet' },
        loop: { $ref: '#/components/pathItems/Loop' },
      };
      const pathItems: ComponentPathItems = { Loop: { $ref: '#/components/pathItems/Loop' } };

      for (const key of Object.keys(entries)) {
        expect(resolvePathItemRef(entries[key], pathItems, { kind: 'path', key })).toBeUndefined();
        expect(resolvePathItemRef(entries[key], pathItems, { kind: 'webhook', key })).toBeUndefined();
      }
      expect(warnings()).toMatchInlineSnapshot(`
        [
          "[oagen] Warning: Path "notAnObject" is not a path item object; skipping it.",
          "[oagen] Warning: Webhook "notAnObject" is not a path item object; skipping it.",
          "[oagen] Warning: Unresolved path item $ref "#/components/schemas/Pet" for path "elsewhere": no matching entry under components/pathItems. Skipping the path.",
          "[oagen] Warning: Unresolved path item $ref "#/components/schemas/Pet" for webhook "elsewhere": no matching entry under components/pathItems. Skipping the webhook.",
          "[oagen] Warning: Circular path item $ref chain starting at "#/components/pathItems/Loop" for path "loop"; skipping it.",
          "[oagen] Warning: Circular path item $ref chain starting at "#/components/pathItems/Loop" for webhook "loop"; skipping it.",
        ]
      `);
    });

    it('reports fields beside a $ref once per entry, chain links included and extensions aside, for a path and a webhook', () => {
      const pathItems: ComponentPathItems = {
        A: { $ref: '#/components/pathItems/B', description: 'On the link', 'x-link': true },
        B: { get: { operationId: 'getPet', responses } },
      };
      const entry = { $ref: '#/components/pathItems/A', summary: 'Beside', 'x-internal': true };

      expect(resolvePathItemRef(entry, pathItems, { kind: 'path', key: '/pets' })).toBe(pathItems.B);
      expect(resolvePathItemRef(entry, pathItems, { kind: 'webhook', key: 'petAdopted' })).toBe(pathItems.B);
      expect(warnings()).toEqual([
        '[oagen] Warning: Path "/pets" has fields beside its $ref ("summary", "description") that are not read: the referenced path item is taken whole.',
        '[oagen] Warning: Webhook "petAdopted" has fields beside its $ref ("summary", "description") that are not read: the referenced path item is taken whole.',
      ]);
    });

    it('warns, through extractWebhooks, about a webhook whose fields beside the $ref are not read', () => {
      const { webhooks } = extractWebhooks(
        { petAdopted: { $ref: '#/components/pathItems/Adopted', summary: 'Beside the ref', post: { responses } } },
        { pathItems: { Adopted: { summary: 'Pet adopted', post: { operationId: 'adopted', responses } } } },
      );

      expect(webhooks.map((w) => [w.name, w.operationId, w.summary])).toEqual([
        ['petAdopted', 'adopted', 'Pet adopted'],
      ]);
      expect(warnings()).toEqual([
        '[oagen] Warning: Webhook "petAdopted" has fields beside its $ref ("summary", "post") that are not read: the referenced path item is taken whole.',
      ]);
    });

    it('still resolves a webhook entry through a chain, as before', () => {
      const { webhooks } = extractWebhooks(
        { petAdopted: { $ref: '#/components/pathItems/A' } },
        {
          pathItems: {
            A: { $ref: '#/components/pathItems/B~1C' },
            'B/C': { post: { operationId: 'adopted', responses } },
          },
        },
      );

      expect(webhooks.map((w) => [w.name, w.operationId])).toEqual([['petAdopted', 'adopted']]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('resolvePathItemRef', () => {
    it('returns an entry without a $ref as itself', () => {
      const item: Record<string, unknown> = { get: { operationId: 'x', responses } };
      expect(resolvePathItemRef(item, undefined, { kind: 'path', key: '/x' })).toBe(item);
    });

    it('follows a chain, unescaping JSON Pointer tokens in each name', () => {
      const target: Record<string, unknown> = { get: { operationId: 'x', responses } };
      const resolved = resolvePathItemRef(
        { $ref: '#/components/pathItems/A' },
        { A: { $ref: '#/components/pathItems/b~1c~0d' }, 'b/c~d': target },
        { kind: 'path', key: '/x' },
      );
      expect(resolved).toBe(target);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('resolveComponentRef', () => {
    it('matches the whole pointer, so a ref into another section never resolves off a same-named entry', () => {
      const components = { Pet: { description: 'a pet' } };
      expect(resolveComponentRef('#/components/pathItems/Pet', 'pathItems', components)).toBe(components.Pet);
      expect(resolveComponentRef('#/components/responses/Pet', 'pathItems', components)).toBeUndefined();
      expect(resolveComponentRef('#/components/pathItems/', 'pathItems', components)).toBeUndefined();
      expect(resolveComponentRef('#/components/pathItems/Pet', 'pathItems', undefined)).toBeUndefined();
    });
  });
});
