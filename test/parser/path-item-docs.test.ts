import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations, resolveOperationDocs } from '../../src/parser/operations.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import { collectReferencedNames } from '../../src/engine/generate-files.js';
import { collectResponseHeaders, collectWebhookTypeRefs, walkTypeRef } from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef, Webhook } from '../../src/ir/types.js';

/**
 * Issue #270: an operation's `summary` and `description` are its own or, for
 * each it declares none for, its Path Item's — OpenAPI applies a Path Item's
 * to every operation on it — for SDK operations and webhooks alike, through
 * one read (`resolveOperationDocs`); and a webhook carries its operation's
 * `externalDocs` as an operation does.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function parseDocument(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-270-'));
  dirs.push(dir);
  const file = path.join(dir, 'repro.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

const responses = { '200': { description: 'OK' } };

/** The doc fields of an operation or webhook, with which of the two keys the node has. */
function docs(node: Operation | Webhook): {
  summary: string | undefined;
  description: string | undefined;
  keys: string[];
} {
  return {
    summary: node.summary,
    description: node.description,
    keys: ['summary', 'description'].filter((key) => key in node),
  };
}

const withBoth = ['summary', 'description'];

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
    ...spec.services.flatMap((s) => s.operations.flatMap(operationRefs)),
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

describe('path item summary and description, webhook externalDocs (issue #270)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the issue repro, through parseSpec', () => {
    // The issue's document, verbatim.
    const repro = {
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': {
          summary: 'Pets',
          description: 'Every pet in the store.',
          get: {
            operationId: 'listPets',
            externalDocs: { url: 'https://example.com/pets' },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      webhooks: {
        petAdopted: {
          summary: 'Pet adopted',
          description: 'Sent when a pet is adopted.',
          post: {
            externalDocs: { url: 'https://example.com/adopted' },
            requestBody: {
              content: {
                'application/json': { schema: { type: 'object', properties: { petId: { type: 'string' } } } },
              },
            },
            responses: { '200': { description: 'Acknowledged' } },
          },
        },
      },
    };

    it("gives the operation and the webhook their path item's summary and description, and both their externalDocs", async () => {
      const spec = await parseDocument(repro);
      const [
        {
          operations: [op],
        },
      ] = spec.services;
      const [hook] = spec.webhooks!;

      // The issue's own projection of the two nodes. `description` is the
      // combined form every operation carries, built from the path item's
      // two texts exactly as it is from an operation's own.
      expect({
        operation: { description: op.description, externalDocs: op.externalDocs, summary: op.summary },
        webhook: { description: hook.description, externalDocs: hook.externalDocs, summary: hook.summary },
      }).toEqual({
        operation: {
          description: 'Pets\n\nEvery pet in the store.',
          externalDocs: { url: 'https://example.com/pets' },
          summary: 'Pets',
        },
        webhook: {
          description: 'Pet adopted\n\nSent when a pet is adopted.',
          externalDocs: { url: 'https://example.com/adopted' },
          summary: 'Pet adopted',
        },
      });
      expect(warn).not.toHaveBeenCalled();
      expectResolvedAndReferenced(spec);
    });
  });

  describe('resolveOperationDocs', () => {
    it.each([
      // op.summary, op.description, pathItem.summary, pathItem.description → summary, description
      [undefined, undefined, 'Pets', 'Every pet.', 'Pets', 'Pets\n\nEvery pet.'],
      ['List', undefined, 'Pets', 'Every pet.', 'List', 'List\n\nEvery pet.'],
      [undefined, 'All pets.', 'Pets', 'Every pet.', 'Pets', 'Pets\n\nAll pets.'],
      ['List', 'All pets.', 'Pets', 'Every pet.', 'List', 'List\n\nAll pets.'],
      ['', '   ', 'Pets', 'Every pet.', 'Pets', 'Pets\n\nEvery pet.'],
      [undefined, undefined, 'Pets', undefined, 'Pets', 'Pets'],
      [undefined, undefined, undefined, 'Every pet.', undefined, 'Every pet.'],
      [undefined, 'Pets', 'Pets', undefined, 'Pets', 'Pets'],
      // A path item summary identical to its own description is not repeated.
      [undefined, undefined, 'Pets', 'Pets', 'Pets', 'Pets'],
      [undefined, undefined, '', '   ', undefined, undefined],
      [undefined, undefined, undefined, undefined, undefined, undefined],
    ])(
      'op %j/%j on a path item %j/%j resolves to %j and %j',
      (opSummary, opDescription, itemSummary, itemDescription, summary, description) => {
        expect(
          resolveOperationDocs(
            { summary: opSummary, description: opDescription, responses },
            { summary: itemSummary, description: itemDescription },
          ),
        ).toEqual({ summary, description });
      },
    );
  });

  describe('through extractOperations', () => {
    const operationsOf = (paths: Parameters<typeof extractOperations>[0]) =>
      Object.fromEntries(
        extractOperations(paths)
          .services.flatMap((s) => s.operations)
          .map((op) => [op.name, docs(op)]),
      );

    it("gives every operation on a path item the item's summary and description when it declares none", () => {
      const ops = operationsOf({
        '/pets': {
          summary: 'Pets',
          description: 'Every pet in the store.',
          get: { operationId: 'listPets', responses },
          post: { operationId: 'createPet', responses },
        },
      });
      const inherited = { summary: 'Pets', description: 'Pets\n\nEvery pet in the store.', keys: withBoth };
      expect(ops).toEqual({ listPets: inherited, createPet: inherited });
    });

    it("keeps an operation's own text where it has some, field by field", () => {
      const ops = operationsOf({
        '/pets': {
          summary: 'Pets',
          description: 'Every pet in the store.',
          get: { operationId: 'listPets', summary: 'List pets', responses },
          post: { operationId: 'createPet', description: 'Adds a pet.', responses },
          put: { operationId: 'replacePets', summary: 'Replace', description: 'Replaces them all.', responses },
        },
      });
      expect(ops).toEqual({
        listPets: { summary: 'List pets', description: 'List pets\n\nEvery pet in the store.', keys: withBoth },
        createPet: { summary: 'Pets', description: 'Pets\n\nAdds a pet.', keys: withBoth },
        replacePets: { summary: 'Replace', description: 'Replace\n\nReplaces them all.', keys: withBoth },
      });
    });

    it('treats blank text as absent at either level, and keeps the keys as before when nothing has content', () => {
      const ops = operationsOf({
        '/pets': {
          summary: 'Pets',
          description: '   ',
          get: { operationId: 'listPets', summary: '', description: '', responses },
        },
        '/toys': { summary: ' ', description: '', get: { operationId: 'listToys', responses } },
      });
      expect(ops).toEqual({
        listPets: { summary: 'Pets', description: 'Pets', keys: withBoth },
        // `summary` is omitted and `description` present-but-undefined, the
        // shape an operation without any doc text has always had.
        listToys: { summary: undefined, description: undefined, keys: ['description'] },
      });
    });

    it('treats text that is not a string as absent at either level', () => {
      const paths: Record<string, unknown> = {
        '/pets': {
          summary: 42,
          description: 'Every pet in the store.',
          get: { operationId: 'listPets', summary: ['List pets'], description: null, responses },
        },
      };
      const ops = operationsOf(paths as Parameters<typeof extractOperations>[0]);
      // Neither level has a string summary; the operation's null description
      // falls through to the path item's string.
      expect(ops.listPets).toEqual({
        summary: undefined,
        description: 'Every pet in the store.',
        keys: ['description'],
      });
    });

    it('does not repeat a path item summary identical to the operation description', () => {
      const ops = operationsOf({
        '/pets': { summary: 'Pets', get: { operationId: 'listPets', description: 'Pets', responses } },
      });
      expect(ops.listPets).toEqual({ summary: 'Pets', description: 'Pets', keys: withBoth });
    });

    it('never reads externalDocs from the path item, which OpenAPI gives none', () => {
      const paths: Record<string, unknown> = {
        '/pets': { externalDocs: { url: 'https://example.com/pets' }, get: { operationId: 'listPets', responses } },
      };
      const [service] = extractOperations(paths as Parameters<typeof extractOperations>[0]).services;
      expect('externalDocs' in service.operations[0]).toBe(false);
    });
  });

  describe('through extractWebhooks', () => {
    const webhooksOf = (webhooks: unknown, components?: Parameters<typeof extractWebhooks>[1]) =>
      Object.fromEntries(
        extractWebhooks(webhooks, components).webhooks.map((hook) => [`${hook.httpMethod} ${hook.name}`, docs(hook)]),
      );

    it("gives every method on a webhook's path item the item's summary and description when it declares none", () => {
      const hooks = webhooksOf({
        petAdopted: {
          summary: 'Pet adopted',
          description: 'Sent when a pet is adopted.',
          post: { responses },
          put: { summary: 'Pet re-adopted', responses },
        },
      });
      expect(hooks).toEqual({
        'post petAdopted': {
          summary: 'Pet adopted',
          description: 'Pet adopted\n\nSent when a pet is adopted.',
          keys: withBoth,
        },
        'put petAdopted': {
          summary: 'Pet re-adopted',
          description: 'Pet re-adopted\n\nSent when a pet is adopted.',
          keys: withBoth,
        },
      });
    });

    it('reads them from the components/pathItems entry a $ref leads to, not from text beside the $ref', () => {
      const hooks = webhooksOf(
        { petAdopted: { $ref: '#/components/pathItems/Adopted', summary: 'Beside the ref' } },
        {
          pathItems: {
            Adopted: { summary: 'Pet adopted', description: 'Sent when a pet is adopted.', post: { responses } },
          },
        },
      );
      expect(hooks['post petAdopted']).toEqual({
        summary: 'Pet adopted',
        description: 'Pet adopted\n\nSent when a pet is adopted.',
        keys: withBoth,
      });
      // The text beside the ref is not read, and that is said once (#350).
      expect(warn.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
        '[oagen] Warning: Webhook "petAdopted" has fields beside its $ref ("summary") that are not read: the referenced path item is taken whole.',
      ]);
    });

    it('follows a $ref chain to the component, and two keys sharing one component each carry its text over one payload model', () => {
      const { webhooks, inlineModels } = extractWebhooks(
        { a: { $ref: '#/components/pathItems/A' }, b: { $ref: '#/components/pathItems/A' } },
        {
          pathItems: {
            A: { $ref: '#/components/pathItems/B' },
            B: {
              summary: 'Pet adopted',
              description: 'Sent when a pet is adopted.',
              post: {
                operationId: 'shared',
                requestBody: {
                  content: {
                    'application/json': { schema: { type: 'object', properties: { petId: { type: 'string' } } } },
                  },
                },
                responses,
              },
            },
          },
        },
      );
      const expected = [
        'Pet adopted',
        'Pet adopted\n\nSent when a pet is adopted.',
        { kind: 'model', name: 'SharedPayload' },
      ];
      expect(webhooks.map((hook) => [hook.name, hook.summary, hook.description, hook.requestBody])).toEqual([
        ['a', ...expected],
        ['b', ...expected],
      ]);
      expect(inlineModels.map((m) => m.name)).toEqual(['SharedPayload']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('treats text that is not a string as absent at either level', () => {
      const hooks = webhooksOf({
        petAdopted: {
          summary: 42,
          description: 'Sent when a pet is adopted.',
          post: { summary: null, description: { text: 'Adopted' }, responses },
        },
      });
      expect(hooks['post petAdopted']).toEqual({
        summary: undefined,
        description: 'Sent when a pet is adopted.',
        keys: ['description'],
      });
    });

    it('omits both keys when neither the operation nor the path item has text with content', () => {
      const hooks = webhooksOf({ petAdopted: { summary: '', post: { description: '   ', responses } } });
      expect(hooks['post petAdopted']).toEqual({ summary: undefined, description: undefined, keys: [] });
    });
  });

  describe('Webhook.externalDocs', () => {
    const link = { url: 'https://example.com/adopted', description: 'Adoption events' };

    it("carries the operation's externalDocs, description included, as an operation does", () => {
      const { webhooks } = extractWebhooks({ petAdopted: { post: { externalDocs: link, responses } } });
      expect(webhooks[0].externalDocs).toEqual(link);
    });

    it('leaves the key absent when the operation declares none or a malformed one', () => {
      const { webhooks } = extractWebhooks({
        none: { post: { responses } },
        noUrl: { post: { externalDocs: { description: 'no url' }, responses } },
        blankUrl: { post: { externalDocs: { url: '   ' }, responses } },
        notAnObject: { post: { externalDocs: 'https://example.com/adopted', responses } },
      });
      expect(webhooks.map((hook) => hook.name)).toEqual(['none', 'noUrl', 'blankUrl', 'notAnObject']);
      for (const hook of webhooks) expect('externalDocs' in hook, hook.name).toBe(false);
    });

    it('never reads externalDocs from the path item, which OpenAPI gives none', () => {
      const { webhooks } = extractWebhooks({ petAdopted: { externalDocs: link, post: { responses } } });
      expect('externalDocs' in webhooks[0]).toBe(false);
    });
  });
});
