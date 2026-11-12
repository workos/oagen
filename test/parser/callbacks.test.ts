import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractCallbacks } from '../../src/parser/callbacks.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { collectReferencedNames } from '../../src/engine/generate-files.js';
import {
  assignModelsToServices,
  collectModelRefs,
  collectOperationTypeRefs,
  collectWebhookTypeRefs,
} from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import { callbackContext } from '../../src/ir/types.js';
import { numberedName, toPascalCase } from '../../src/utils/naming.js';
import type { ApiSpec, Callback, Operation, Webhook } from '../../src/ir/types.js';

/**
 * Issue #382: an operation's `callbacks` were warned about (#272, #325)
 * but never read. They are now read into `Operation.callbacks` /
 * `Webhook.callbacks` as `Callback` entries — a `Webhook` tied to the
 * operation that registers it, with the runtime expression beside the key
 * — through the webhook machinery, their models named from the owner's
 * stem (`CreatePetPetAdoptedPayload`).
 */

const petIdSchema = { type: 'object', properties: { petId: { type: 'string' } } };

/** A Callback Object: one runtime-expression path item whose POST carries `schema`, with `extra` on the operation. */
function callbackPosting(schema: Record<string, unknown> = petIdSchema, extra: Record<string, unknown> = {}) {
  return {
    '{$request.body#/callbackUrl}': {
      post: {
        ...extra,
        requestBody: { content: { 'application/json': { schema } } },
        responses: { '200': { description: 'OK' } },
      },
    },
  };
}

/** An operation that acknowledges with a bare 200, declaring the given callbacks. */
function opWith(callbacks: unknown, operationId?: string, extra: Record<string, unknown> = {}) {
  return {
    ...(operationId ? { operationId } : {}),
    ...extra,
    responses: { '200': { description: 'OK' } },
    callbacks,
  };
}

/** The issue's repro, verbatim: `createPet` takes `{ callbackUrl }` and declares `petAdopted`, posting `{ petId }` and expecting 204. */
function issueRepro(openapi: string) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { callbackUrl: { type: 'string' } }, required: ['callbackUrl'] },
              },
            },
          },
          responses: { '200': { description: 'OK' } },
          callbacks: {
            petAdopted: {
              '{$request.body#/callbackUrl}': {
                post: {
                  requestBody: { content: { 'application/json': { schema: petIdSchema } } },
                  responses: { '204': { description: 'Acknowledged' } },
                },
              },
            },
          },
        },
      },
    },
  };
}

/** A document with the given paths (and components, webhooks), on `openapi`. */
function documentWith(
  openapi: string,
  paths: Record<string, unknown>,
  rest: { components?: Record<string, unknown>; webhooks?: Record<string, unknown> } = {},
) {
  return { openapi, info: { title: 'repro', version: '1' }, paths, ...rest };
}

/** `name.expression.method` of each callback, nested ones after their parent, prefixed by the depth. */
function callbackKeys(node: { callbacks?: Callback[] }, depth = 0): string[] {
  return (node.callbacks ?? []).flatMap((callback) => [
    `${'>'.repeat(depth)}${callback.name}.${callback.expression}.${callback.httpMethod}`,
    ...callbackKeys(callback, depth + 1),
  ]);
}

/** The payload model each callback references, in `callbackKeys` order. */
function payloadNames(node: { callbacks?: Callback[] }): Array<string | undefined> {
  return (node.callbacks ?? []).flatMap((callback) => [
    callback.requestBody?.kind === 'model' ? callback.requestBody.name : undefined,
    ...payloadNames(callback),
  ]);
}

describe('#382', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-callbacks-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  /** Every `console.warn` message so far, in order. */
  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  const operationNames = (spec: ApiSpec) => spec.services.flatMap((service) => service.operations.map((op) => op.name));
  const operations = (spec: ApiSpec): Operation[] => spec.services.flatMap((service) => service.operations);
  const modelNames = (spec: ApiSpec) => spec.models.map(({ name }) => name);

  /** Every model an operation or webhook references — its callbacks' included — is in `spec.models`. */
  function expectResolved(spec: ApiSpec): void {
    const known = new Set(modelNames(spec));
    for (const op of operations(spec)) {
      for (const ref of collectOperationTypeRefs(op)) {
        for (const name of collectModelRefs(ref)) expect(known.has(name), name).toBe(true);
      }
    }
    for (const webhook of spec.webhooks ?? []) {
      for (const ref of collectWebhookTypeRefs(webhook)) {
        for (const name of collectModelRefs(ref)) expect(known.has(name), name).toBe(true);
      }
    }
  }

  describe.each(['3.0.3', '3.1.0'])('OpenAPI %s', (openapi) => {
    describe('on a `paths` operation', () => {
      it("reads the issue's repro into one Callback on createPet, with its payload model, and warns nothing", async () => {
        const spec = await parseJson(issueRepro(openapi));

        // The output the issue asks for: the callback's body is a model now.
        expect(modelNames(spec)).toEqual(['CreatePetRequest', 'CreatePetPetAdoptedPayload']);
        expect('webhooks' in spec).toBe(false);
        expect(operationNames(spec)).toEqual(['createPet']);

        const [op] = operations(spec);
        expect(op!.callbacks).toHaveLength(1);
        const [callback] = op!.callbacks!;
        expect(callback).toMatchObject({
          name: 'petAdopted',
          expression: '{$request.body#/callbackUrl}',
          httpMethod: 'post',
          headerParams: [],
          queryParams: [],
          requestBody: { kind: 'model', name: 'CreatePetPetAdoptedPayload' },
          requestBodyEncoding: 'json',
          requestBodyContentType: 'application/json',
          requestBodyContentTypes: ['application/json'],
          responses: [{ statusCode: 204, description: 'Acknowledged' }],
        });
        // Not an SDK method: no path, no name, no operationId of its own.
        expect(callback).not.toHaveProperty('path');
        expect(callback).not.toHaveProperty('operationId');
        expect(spec.models.find((m) => m.name === 'CreatePetPetAdoptedPayload')?.fields.map((f) => f.name)).toEqual([
          'petId',
        ]);
        expectResolved(spec);
        expect(warnings()).toEqual([]);
      });

      it('names the payload from the path stem when the operation has no operationId', async () => {
        const spec = await parseJson(
          documentWith(openapi, { '/pets': { post: opWith({ petAdopted: callbackPosting() }) } }),
        );

        expect(operationNames(spec)).toHaveLength(1);
        expect(modelNames(spec)).toEqual(['PetsPostPetAdoptedPayload']);
        expect(callbackKeys(operations(spec)[0]!)).toEqual(['petAdopted.{$request.body#/callbackUrl}.post']);
        expect(payloadNames(operations(spec)[0]!)).toEqual(['PetsPostPetAdoptedPayload']);
        expect(warnings()).toEqual([]);
      });

      it('reads two callbacks with two expressions each as four entries, in document order, each payload named apart', async () => {
        const twoExpressions = {
          ...callbackPosting(),
          '{$request.body#/secondUrl}': callbackPosting()['{$request.body#/callbackUrl}'],
        };
        const spec = await parseJson(
          documentWith(openapi, {
            '/pets': {
              // Methods are read in `HTTP_METHODS` order, so the GET's callbacks come first among the models.
              get: opWith({ petListed: callbackPosting() }, 'listPets'),
              post: opWith({ petAdopted: twoExpressions, petReturned: twoExpressions }, 'createPet'),
            },
            '/owners': { get: { operationId: 'listOwners', responses: { '200': { description: 'OK' } } } },
          }),
        );

        expect(operationNames(spec).sort()).toEqual(['createPet', 'listOwners', 'listPets']);
        const byName = new Map(operations(spec).map((op) => [op.name, op]));
        // Key order, then expression order within each Callback Object: a
        // second expression qualifies the stem with the expression PascalCased.
        expect(callbackKeys(byName.get('createPet')!)).toEqual([
          'petAdopted.{$request.body#/callbackUrl}.post',
          'petAdopted.{$request.body#/secondUrl}.post',
          'petReturned.{$request.body#/callbackUrl}.post',
          'petReturned.{$request.body#/secondUrl}.post',
        ]);
        expect(payloadNames(byName.get('createPet')!)).toEqual([
          'CreatePetPetAdoptedRequestBodyCallbackUrlPayload',
          'CreatePetPetAdoptedRequestBodySecondUrlPayload',
          'CreatePetPetReturnedRequestBodyCallbackUrlPayload',
          'CreatePetPetReturnedRequestBodySecondUrlPayload',
        ]);
        expect(payloadNames(byName.get('listPets')!)).toEqual(['ListPetsPetListedPayload']);
        // An operation without callbacks carries no key at all.
        expect(byName.get('listOwners')).not.toHaveProperty('callbacks');
        expect(modelNames(spec)).toEqual([
          'ListPetsPetListedPayload',
          'CreatePetPetAdoptedRequestBodyCallbackUrlPayload',
          'CreatePetPetAdoptedRequestBodySecondUrlPayload',
          'CreatePetPetReturnedRequestBodyCallbackUrlPayload',
          'CreatePetPetReturnedRequestBodySecondUrlPayload',
        ]);
        expectResolved(spec);
        expect(warnings()).toEqual([]);
      });

      it('follows a `$ref` into components/callbacks, naming the callback by the key it is written as', async () => {
        const spec = await parseJson(
          documentWith(
            openapi,
            { '/pets': { post: opWith({ adopted: { $ref: '#/components/callbacks/petAdopted' } }, 'createPet') } },
            { components: { callbacks: { petAdopted: callbackPosting() } } },
          ),
        );

        expect(callbackKeys(operations(spec)[0]!)).toEqual(['adopted.{$request.body#/callbackUrl}.post']);
        expect(modelNames(spec)).toEqual(['CreatePetAdoptedPayload']);
        expect(warnings()).toEqual([]);
      });

      it('reads colliding paths each under their own path stem, and a null map as no callbacks', async () => {
        // `GET /pets` and `GET /api/pets` flatten to one operation name, yet
        // each names its models from its own path; `callbacks: null` declares nothing.
        const spec = await parseJson(
          documentWith(openapi, {
            '/pets': {
              get: opWith({ petListed: callbackPosting() }),
              post: opWith(null),
            },
            '/api/pets': { get: opWith({ apiPetListed: callbackPosting() }) },
          }),
        );

        expect(operationNames(spec)).toHaveLength(3);
        expect(modelNames(spec)).toEqual(['PetsGetPetListedPayload', 'ApiPetsGetApiPetListedPayload']);
        const [listPets, createPet, listApiPets] = operations(spec);
        expect(payloadNames(listPets!)).toEqual(['PetsGetPetListedPayload']);
        expect(createPet).not.toHaveProperty('callbacks');
        expect(payloadNames(listApiPets!)).toEqual(['ApiPetsGetApiPetListedPayload']);
        expect(warnings()).toEqual([]);
      });

      it('reads nothing, silently, from an empty map, a non-map, and a components/callbacks entry nothing references', async () => {
        const spec = await parseJson(
          documentWith(
            openapi,
            {
              '/pets': { post: opWith({}, 'createPet'), get: opWith('petAdopted', 'listPets') },
              '/owners': { get: opWith([{ petAdopted: {} }], 'listOwners') },
            },
            { components: { callbacks: { petAdopted: callbackPosting() } } },
          ),
        );

        expect(operationNames(spec).sort()).toEqual(['createPet', 'listOwners', 'listPets']);
        expect(spec.models).toEqual([]);
        for (const op of operations(spec)) expect(op).not.toHaveProperty('callbacks');
        expect(warn).not.toHaveBeenCalled();
      });

      it("names the models from the callback operation's operationId when it declares one that names something", async () => {
        const spec = await parseJson(
          documentWith(openapi, {
            '/pets': {
              post: opWith(
                { petAdopted: callbackPosting(petIdSchema, { operationId: 'notifyAdoption' }) },
                'createPet',
              ),
            },
          }),
        );

        expect(modelNames(spec)).toEqual(['NotifyAdoptionPayload']);
        const [callback] = operations(spec)[0]!.callbacks!;
        expect(callback).toMatchObject({ name: 'petAdopted', operationId: 'notifyAdoption' });
        expect(callback!.requestBody).toEqual({ kind: 'model', name: 'NotifyAdoptionPayload' });
        expect(warnings()).toEqual([]);
      });

      it('shares one minting between two operations referencing one components/callbacks entry with an operationId, and mints apart without one', async () => {
        const twoSites = (callbacks: Record<string, unknown>) =>
          documentWith(
            openapi,
            {
              '/pets': { post: opWith({ adopted: { $ref: '#/components/callbacks/petAdopted' } }, 'createPet') },
              '/pets/{id}': { put: opWith({ adopted: { $ref: '#/components/callbacks/petAdopted' } }, 'updatePet') },
            },
            { components: { callbacks } },
          );

        const shared = await parseJson(
          twoSites({ petAdopted: callbackPosting(petIdSchema, { operationId: 'notifyAdoption' }) }),
        );
        expect(modelNames(shared)).toEqual(['NotifyAdoptionPayload']);
        expect(operations(shared).map((op) => payloadNames(op))).toEqual([
          ['NotifyAdoptionPayload'],
          ['NotifyAdoptionPayload'],
        ]);
        // Each site is its own Callback: no IR node is shared.
        const [a, b] = operations(shared).map((op) => op.callbacks![0]!);
        expect(a).not.toBe(b);
        expect(a!.requestBody).not.toBe(b!.requestBody);

        const apart = await parseJson(twoSites({ petAdopted: callbackPosting() }));
        expect(modelNames(apart)).toEqual(['CreatePetAdoptedPayload', 'UpdatePetAdoptedPayload']);
        expect(warnings()).toEqual([]);
      });

      it.each([
        { order: 'direct reference first', nestedFirst: false },
        { order: 'nested reference first', nestedFirst: true },
      ])(
        'mints one model for a components/callbacks entry with an operationId referenced directly and nested, $order (Greptile)',
        async ({ nestedFirst }) => {
          // `createPet` references `notifyAdoption` directly; `updatePet`'s
          // own `petUpdated` callback nests it. One callback operation object
          // at two depths is one group: one stem, one model, each site its
          // own Callback.
          const createPet = {
            post: opWith({ adopted: { $ref: '#/components/callbacks/notifyAdoption' } }, 'createPet'),
          };
          const updatePet = {
            post: opWith(
              {
                petUpdated: callbackPosting(petIdSchema, {
                  callbacks: { confirmed: { $ref: '#/components/callbacks/notifyAdoption' } },
                }),
              },
              'updatePet',
            ),
          };
          const spec = await parseJson(
            documentWith(
              openapi,
              nestedFirst ? { '/owners': updatePet, '/pets': createPet } : { '/pets': createPet, '/owners': updatePet },
              {
                components: {
                  callbacks: { notifyAdoption: callbackPosting(petIdSchema, { operationId: 'notifyAdoption' }) },
                },
              },
            ),
          );

          expect(modelNames(spec).sort()).toEqual(['NotifyAdoptionPayload', 'UpdatePetPetUpdatedPayload']);
          const byName = new Map(operations(spec).map((op) => [op.name, op]));
          expect(payloadNames(byName.get('createPet')!)).toEqual(['NotifyAdoptionPayload']);
          expect(payloadNames(byName.get('updatePet')!)).toEqual([
            'UpdatePetPetUpdatedPayload',
            'NotifyAdoptionPayload',
          ]);
          const direct = byName.get('createPet')!.callbacks![0]!;
          const nested = byName.get('updatePet')!.callbacks![0]!.callbacks![0]!;
          expect(direct).toMatchObject({ name: 'adopted', operationId: 'notifyAdoption' });
          expect(nested).toMatchObject({ name: 'confirmed', operationId: 'notifyAdoption' });
          expect(direct).not.toBe(nested);
          expect(direct.requestBody).not.toBe(nested.requestBody);
          expectResolved(spec);
          expect(warnings()).toEqual([]);
        },
      );

      describe("a key-named callback inside a shared callback operation (Michael's finding 1)", () => {
        // `NoteAdded` (`operationId: onNoteAdded`) declares its own `noteRead`
        // (no operationId, payload `{ read: boolean }`); `createNote`
        // references `NoteAdded`, then `updateNote` too.
        const noteAddedItem = {
          post: {
            operationId: 'onNoteAdded',
            requestBody: {
              content: {
                'application/json': { schema: { type: 'object', properties: { noteId: { type: 'string' } } } },
              },
            },
            responses: { '200': { description: 'OK' } },
            callbacks: {
              noteRead: {
                '{$request.body#/readUrl}': {
                  post: {
                    requestBody: {
                      content: {
                        'application/json': { schema: { type: 'object', properties: { read: { type: 'boolean' } } } },
                      },
                    },
                    responses: { '200': { description: 'OK' } },
                  },
                },
              },
            },
          },
        };
        const reference = { noteAdded: { $ref: '#/components/callbacks/NoteAdded' } };
        const createNote = { post: opWith(reference, 'createNote') };
        const updateNote = { post: opWith(reference, 'updateNote') };
        const components = { callbacks: { NoteAdded: { '{$request.body#/callbackUrl}': noteAddedItem } } };
        const expectShared = (spec: ApiSpec, sites: number) => {
          // One minting for `NoteAdded` and one for its `noteRead`, however many sites.
          expect(modelNames(spec).sort()).toEqual(['OnNoteAddedNoteReadPayload', 'OnNoteAddedPayload']);
          for (const op of operations(spec)) {
            expect(payloadNames(op)).toEqual(['OnNoteAddedPayload', 'OnNoteAddedNoteReadPayload']);
          }
          expect(operations(spec)).toHaveLength(sites);
          expectResolved(spec);
          expect(warnings()).toEqual([]);
        };

        it.each([
          { order: 'createNote first', paths: { '/notes': createNote, '/notes/update': updateNote } },
          { order: 'updateNote first', paths: { '/notes/update': updateNote, '/notes': createNote } },
        ])('mints the nested callback once for both operations, $order', async ({ paths }) => {
          expectShared(await parseJson(documentWith(openapi, { '/notes': createNote }, { components })), 1);
          expectShared(await parseJson(documentWith(openapi, paths, { components })), 2);
        });

        it('mints the nested callback once for two webhooks keys sharing the path item', async () => {
          const spec = await parseJson(
            documentWith(
              openapi,
              {},
              {
                webhooks: {
                  a: { $ref: '#/components/pathItems/NoteAdded' },
                  b: { $ref: '#/components/pathItems/NoteAdded' },
                },
                components: { pathItems: { NoteAdded: noteAddedItem } },
              },
            ),
          );

          expect(modelNames(spec).sort()).toEqual(['OnNoteAddedNoteReadPayload', 'OnNoteAddedPayload']);
          expect(spec.webhooks!.map((webhook) => payloadNames(webhook))).toEqual([
            ['OnNoteAddedNoteReadPayload'],
            ['OnNoteAddedNoteReadPayload'],
          ]);
          // Two sites, two nodes, one model.
          expect(spec.webhooks![0]!.callbacks![0]).not.toBe(spec.webhooks![1]!.callbacks![0]);
          expectResolved(spec);
          expect(warnings()).toEqual([]);
        });

        it('hashes the nested callback from the shared operation, not from whichever site comes first, when its name is taken (Greptile)', async () => {
          // A component holds `OnNoteAddedNoteReadPayload`, so the nested
          // payload is hashed; the hash must not depend on the path order.
          const taken = {
            components: {
              ...components,
              schemas: { OnNoteAddedNoteReadPayload: { type: 'object', properties: { other: { type: 'integer' } } } },
            },
          };
          const first = await parseJson(
            documentWith(openapi, { '/notes': createNote, '/notes/update': updateNote }, taken),
          );
          const reversed = await parseJson(
            documentWith(openapi, { '/notes/update': updateNote, '/notes': createNote }, taken),
          );
          const hashed = (spec: ApiSpec) => operations(spec).map((op) => payloadNames(op)[1]!);

          expect(hashed(first)).toHaveLength(2);
          for (const name of hashed(first)) expect(name).toMatch(/^OnNoteAddedNoteRead[0-9A-Fa-f]{6}Payload$/);
          expect(new Set(hashed(first)).size).toBe(1);
          expect(new Set([...hashed(first), ...hashed(reversed)]).size).toBe(1);
          expect(modelNames(first).sort()).toEqual(modelNames(reversed).sort());
          // The component keeps its name and its field.
          expect(first.models.find((m) => m.name === 'OnNoteAddedNoteReadPayload')!.fields.map((f) => f.name)).toEqual([
            'other',
          ]);
          // The same for two webhooks keys sharing the path item, in either key order.
          const hooks = (keys: Record<string, unknown>) =>
            parseJson(
              documentWith(
                openapi,
                {},
                {
                  webhooks: keys,
                  components: { pathItems: { NoteAdded: noteAddedItem }, schemas: taken.components.schemas },
                },
              ),
            );
          const ab = await hooks({
            a: { $ref: '#/components/pathItems/NoteAdded' },
            b: { $ref: '#/components/pathItems/NoteAdded' },
          });
          const ba = await hooks({
            b: { $ref: '#/components/pathItems/NoteAdded' },
            a: { $ref: '#/components/pathItems/NoteAdded' },
          });
          const hookNames = (spec: ApiSpec) => spec.webhooks!.map((webhook) => payloadNames(webhook)[0]!);
          expect(new Set([...hookNames(ab), ...hookNames(ba)]).size).toBe(1);
          expect(hookNames(ab)[0]).toMatch(/^OnNoteAddedNoteRead[0-9A-Fa-f]{6}Payload$/);
          expect(warnings()).toEqual([]);
        });

        it.each([
          { order: 'parameter before callbacks', parametersFirst: true },
          { order: 'callbacks before parameter', parametersFirst: false },
        ])(
          "names an ancestor before its descendants, so a new nested callback steps around the parent's parameter model, $order (Greptile)",
          async ({ parametersFirst }) => {
            // `petAdopted` has an object query parameter `confirmedPayload`,
            // minting `CreatePetPetAdoptedConfirmedPayload`; a nested
            // `confirmed` callback with an inline body asks for the same name.
            const parameters = [
              {
                name: 'confirmedPayload',
                in: 'query',
                schema: { type: 'object', properties: { at: { type: 'string' } } },
              },
            ];
            const confirmed = callbackPosting({ type: 'object', properties: { ok: { type: 'boolean' } } });
            const petAdopted = (nested: boolean) => ({
              '{$request.body#/callbackUrl}': {
                post: {
                  ...(parametersFirst ? { parameters } : {}),
                  ...(nested ? { callbacks: { confirmed } } : {}),
                  ...(parametersFirst ? {} : { parameters }),
                  requestBody: { content: { 'application/json': { schema: petIdSchema } } },
                  responses: { '200': { description: 'OK' } },
                },
              },
            });
            const document = (nested: boolean) =>
              documentWith(openapi, { '/pets': { post: opWith({ petAdopted: petAdopted(nested) }, 'createPet') } });
            const parent = (spec: ApiSpec) => operations(spec)[0]!.callbacks![0]!;

            const without = await parseJson(document(false));
            expect(parent(without).queryParams[0]!.type).toMatchObject({
              kind: 'model',
              name: 'CreatePetPetAdoptedConfirmedPayload',
            });
            expect(modelNames(without).sort()).toEqual([
              'CreatePetPetAdoptedConfirmedPayload',
              'CreatePetPetAdoptedPayload',
            ]);

            const withNested = await parseJson(document(true));
            // The parent's parameter and payload models keep their names; the
            // new payload, named after them, steps around the parameter's.
            expect(parent(withNested).queryParams[0]!.type).toMatchObject({
              kind: 'model',
              name: 'CreatePetPetAdoptedConfirmedPayload',
            });
            expect(parent(withNested).requestBody).toMatchObject({ kind: 'model', name: 'CreatePetPetAdoptedPayload' });
            const nestedPayload = payloadNames(parent(withNested))[0]!;
            expect(nestedPayload).toMatch(/^CreatePetPetAdoptedConfirmed[0-9A-Fa-f]{6}Payload$/);
            expect(modelNames(withNested).sort()).toEqual(
              ['CreatePetPetAdoptedConfirmedPayload', 'CreatePetPetAdoptedPayload', nestedPayload].sort(),
            );
            expect(
              withNested.models
                .find((m) => m.name === 'CreatePetPetAdoptedConfirmedPayload')!
                .fields.map((f) => f.name),
            ).toEqual(['at']);
            expectResolved(withNested);
            expect(warnings()).toEqual([]);
          },
        );

        it.each([
          { order: 'path operation first', eventsFirst: true },
          { order: 'nesting operation first', eventsFirst: false },
        ])(
          'mints one model for a callback a path operation references directly and a callback operation of the same stem nests, $order (Greptile)',
          async ({ eventsFirst }) => {
            // `registerEvent` (POST /events) references `Read` directly; the
            // callback operation `register_event` under `createPet`'s `events`
            // nests the same reference. Both stems are `RegisterEvent`, so
            // `read` is one group across depths and mints once.
            const read = {
              '{$request.body#/readUrl}': {
                post: {
                  requestBody: {
                    content: {
                      'application/json': { schema: { type: 'object', properties: { read: { type: 'boolean' } } } },
                    },
                  },
                  responses: { '200': { description: 'OK' } },
                },
              },
            };
            const reference = { read: { $ref: '#/components/callbacks/Read' } };
            const events = { post: opWith(reference, 'registerEvent') };
            const createPet = {
              post: opWith(
                { events: callbackPosting(petIdSchema, { operationId: 'register_event', callbacks: reference }) },
                'createPet',
              ),
            };
            const paths = eventsFirst
              ? { '/events': events, '/pets': createPet }
              : { '/pets': createPet, '/events': events };
            const spec = await parseJson(documentWith(openapi, paths, { components: { callbacks: { Read: read } } }));

            expect(modelNames(spec).sort()).toEqual(['RegisterEventPayload', 'RegisterEventReadPayload']);
            const byName = new Map(operations(spec).map((op) => [op.name, op]));
            expect(payloadNames(byName.get('registerEvent')!)).toEqual(['RegisterEventReadPayload']);
            expect(payloadNames(byName.get('createPet')!)).toEqual([
              'RegisterEventPayload',
              'RegisterEventReadPayload',
            ]);
            expectResolved(spec);
            expect(warnings()).toEqual([]);
          },
        );

        it.each([
          { order: 'direct callback first', directFirst: true },
          { order: 'nesting operation first', directFirst: false },
        ])(
          'hashes two groups whose stems coincide across depths from the start, so a reference added directly renames nothing, $order (Greptile)',
          async ({ directFirst }) => {
            // `createPet`'s `petAdopted` declares `operationId: notify_adoption`
            // (depth 0); `registerPet`'s `registered` nests the shared component
            // `Adopted`, whose operation declares `operationId: notifyAdoption`
            // (depth 1). Both stems are `NotifyAdoption`.
            const adopted = callbackPosting(
              { type: 'object', properties: { adopted: { type: 'boolean' } } },
              { operationId: 'notifyAdoption' },
            );
            const reference = { adopted: { $ref: '#/components/callbacks/Adopted' } };
            const pets = {
              post: opWith(
                { petAdopted: callbackPosting(petIdSchema, { operationId: 'notify_adoption' }) },
                'createPet',
              ),
            };
            const registrations = {
              post: opWith({ registered: callbackPosting(petIdSchema, { callbacks: reference }) }, 'registerPet'),
            };
            const document = (direct: boolean) =>
              documentWith(
                openapi,
                {
                  ...(directFirst
                    ? { '/pets': pets, '/registrations': registrations }
                    : { '/registrations': registrations, '/pets': pets }),
                  ...(direct ? { '/adoptions': { post: opWith(reference, 'adoptPet') } } : {}),
                },
                { components: { callbacks: { Adopted: adopted } } },
              );
            const byName = (spec: ApiSpec) => new Map(operations(spec).map((op) => [op.name, op]));

            const nestedOnly = await parseJson(document(false));
            const [direct] = payloadNames(byName(nestedOnly).get('createPet')!);
            const [registered, nested] = payloadNames(byName(nestedOnly).get('registerPet')!);
            // Both hash from the start — the stems are settled across every
            // depth, symmetrically — never alike, the hashes from their
            // operationIds.
            expect(direct).toMatch(/^NotifyAdoption[0-9A-Fa-f]{6}Payload$/);
            expect(nested).toMatch(/^NotifyAdoption[0-9A-Fa-f]{6}Payload$/);
            expect(direct).not.toBe(nested);
            expect(registered).toBe('RegisterPetRegisteredPayload');
            expect(modelNames(nestedOnly).sort()).toEqual([direct, nested, registered].sort());

            // A direct reference to `Adopted` renames nothing: the same two
            // names, the direct site reading the nested one's model.
            const both = await parseJson(document(true));
            expect(payloadNames(byName(both).get('createPet')!)).toEqual([direct]);
            expect(payloadNames(byName(both).get('registerPet')!)).toEqual([registered, nested]);
            expect(payloadNames(byName(both).get('adoptPet')!)).toEqual([nested]);
            expect(modelNames(both).sort()).toEqual([direct, nested, registered].sort());
            for (const spec of [nestedOnly, both]) expectResolved(spec);
            expect(warnings()).toEqual([]);
          },
        );

        it.each([
          { order: 'first callback first', firstFirst: true },
          { order: 'second callback first', firstFirst: false },
        ])(
          'keeps two directly referenced callbacks of one stem hashed when the second is nested inside the first too, $order (Greptile)',
          async ({ firstFirst }) => {
            // `createPet`'s `petAdopted` declares `operationId: notify_adoption`;
            // `adoptPet`'s `adopted` references the component `Adopted`, whose
            // operation declares `operationId: notifyAdoption`. Both stems are
            // `NotifyAdoption`, both referenced directly.
            const adopted = callbackPosting(
              { type: 'object', properties: { adopted: { type: 'boolean' } } },
              { operationId: 'notifyAdoption' },
            );
            const reference = { adopted: { $ref: '#/components/callbacks/Adopted' } };
            const document = (nested: boolean) => {
              const pets = {
                post: opWith(
                  {
                    petAdopted: callbackPosting(petIdSchema, {
                      operationId: 'notify_adoption',
                      ...(nested ? { callbacks: reference } : {}),
                    }),
                  },
                  'createPet',
                ),
              };
              const adoptions = { post: opWith(reference, 'adoptPet') };
              return documentWith(
                openapi,
                firstFirst ? { '/pets': pets, '/adoptions': adoptions } : { '/adoptions': adoptions, '/pets': pets },
                { components: { callbacks: { Adopted: adopted } } },
              );
            };
            const byName = (spec: ApiSpec) => new Map(operations(spec).map((op) => [op.name, op]));

            const direct = await parseJson(document(false));
            const [first] = payloadNames(byName(direct).get('createPet')!);
            const [second] = payloadNames(byName(direct).get('adoptPet')!);
            expect(first).toMatch(/^NotifyAdoption[0-9A-Fa-f]{6}Payload$/);
            expect(second).toMatch(/^NotifyAdoption[0-9A-Fa-f]{6}Payload$/);
            expect(first).not.toBe(second);
            expect(modelNames(direct).sort()).toEqual([first, second].sort());

            // Nesting `Adopted` inside `petAdopted` as well renames nothing:
            // the second is the first's peer in the stem set, nested or not.
            const nested = await parseJson(document(true));
            expect(payloadNames(byName(nested).get('createPet')!)).toEqual([first, second]);
            expect(payloadNames(byName(nested).get('adoptPet')!)).toEqual([second]);
            expect(modelNames(nested).sort()).toEqual([first, second].sort());
            for (const spec of [direct, nested]) expectResolved(spec);
            expect(warnings()).toEqual([]);
          },
        );

        it.each([
          { order: 'petEvent first', petEventFirst: true },
          { order: 'returnedPetEvent first', petEventFirst: false },
        ])(
          'keeps the payloads of two shared callbacks that nest each other apart, each with its own fields, $order (Greptile)',
          async ({ petEventFirst }) => {
            // `PetEvent`'s union mints `ReturnedPetEventPayload` for its
            // `returned` variant; `ReturnedPetEvent`'s body wants that name
            // too. Each nests a reference to the other, so the two groups are
            // ancestors of each other — peers, both hashed — and the cycle
            // guard stops each walk one level down, with a warning each.
            const union = {
              oneOf: [
                { type: 'object', properties: { kind: { const: 'adopted' }, pet_id: { type: 'string' } } },
                { type: 'object', properties: { kind: { const: 'returned' }, pet_id: { type: 'string' } } },
              ],
              discriminator: { propertyName: 'kind' },
            };
            const callbacks = {
              PetEvent: callbackPosting(union, {
                operationId: 'petEvent',
                callbacks: { returnedPetEvent: { $ref: '#/components/callbacks/ReturnedPetEvent' } },
              }),
              ReturnedPetEvent: callbackPosting(
                { type: 'object', properties: { reason: { type: 'string' } } },
                {
                  operationId: 'returnedPetEvent',
                  callbacks: { petEvent: { $ref: '#/components/callbacks/PetEvent' } },
                },
              ),
            };
            const petEvent = { $ref: '#/components/callbacks/PetEvent' };
            const returnedPetEvent = { $ref: '#/components/callbacks/ReturnedPetEvent' };
            const spec = await parseJson(
              documentWith(
                openapi,
                {
                  '/pets': {
                    post: opWith(
                      petEventFirst ? { petEvent, returnedPetEvent } : { returnedPetEvent, petEvent },
                      'createPet',
                    ),
                  },
                },
                { components: { callbacks } },
              ),
            );

            const [first, second] = operations(spec)[0]!.callbacks!;
            const [petEventNode, returnedNode] = petEventFirst ? [first!, second!] : [second!, first!];
            const unionOf = (node: Callback) => {
              expect(node.requestBody).toMatchObject({ kind: 'union' });
              return (node.requestBody as { variants: Array<{ name: string }> }).variants.map((v) => v.name);
            };
            const [adoptedName, returnedVariant] = unionOf(petEventNode);
            const returnedPayload = (returnedNode.requestBody as { name: string }).name;
            expect(adoptedName).toMatch(/^PetEvent[0-9A-Fa-f]{6}Payload$/);
            expect(returnedVariant).toMatch(/^ReturnedPetEvent[0-9A-Fa-f]{6}Payload$/);
            expect(returnedPayload).toMatch(/^ReturnedPetEvent[0-9A-Fa-f]{6}Payload$/);
            expect(returnedVariant).not.toBe(returnedPayload);
            const fieldsOf = (name: string) => spec.models.find((m) => m.name === name)!.fields.map((f) => f.name);
            expect(fieldsOf(returnedVariant)).toEqual(['kind', 'pet_id']);
            expect(fieldsOf(returnedPayload)).toEqual(['reason']);
            expect(modelNames(spec).sort()).toEqual([adoptedName, returnedVariant, returnedPayload].sort());
            // The nested sites reference the same models as the direct ones.
            expect(unionOf(returnedNode.callbacks![0]!)).toEqual([adoptedName, returnedVariant]);
            expect(petEventNode.callbacks![0]!.requestBody).toEqual({ kind: 'model', name: returnedPayload });
            expectResolved(spec);
            // The cycle guard's two warnings, and no "more than one definition".
            expect(warnings()).toHaveLength(2);
            for (const warning of warnings()) expect(warning).toContain('refers back to a callback it sits in');
          },
        );
      });

      describe('two callbacks whose title-mapped variants share a name, which no stem hash moves', () => {
        // Both payloads are title-mapped unions — every variant titled and
        // pinning `kind` — carrying a variant titled `Shape`: a context-free
        // name the stem resolution ignores, since no hash would move it.
        const titled = (title: string, own: Record<string, unknown>) => ({
          title,
          type: 'object',
          properties: { kind: { type: 'string', const: title.toLowerCase() }, ...own },
        });
        const shaped = (own: Record<string, unknown>, other: string) => ({
          oneOf: [titled('Shape', own), titled(other, { text: { type: 'string' } })],
        });
        const variants = (node: Callback) =>
          (node.requestBody as { variants: Array<{ name: string }> }).variants.map((v) => v.name);
        const shapes = (spec: ApiSpec) =>
          new Map(operations(spec)[0]!.callbacks!.map((node) => [node.name, variants(node)[0]!]));
        const fieldsOf = (spec: ApiSpec, name: string) =>
          spec.models.find((m) => m.name === name)!.fields.map((f) => f.name);
        const document = (
          returned: Record<string, unknown>,
          adoptedFirst: boolean,
          extra: Record<string, unknown> = {},
          rest: Record<string, unknown> = {},
        ) => {
          const callbacks = {
            petAdopted: callbackPosting(shaped({ sides: { type: 'integer' } }, 'Note')),
            petReturned: callbackPosting(shaped(returned, 'Memo'), extra),
          };
          const { petAdopted, petReturned } = callbacks;
          return documentWith(
            openapi,
            {
              '/pets': {
                post: opWith(adoptedFirst ? { petAdopted, petReturned } : { petReturned, petAdopted }, 'createPet'),
              },
            },
            rest,
          );
        };

        it.each([true, false])(
          'parts two shapes under each stem, whichever is declared first (adoptedFirst %s)',
          async (adoptedFirst) => {
            const spec = await parseJson(document({ radius: { type: 'number' } }, adoptedFirst));
            // Every group minting `Shape` moves, each under its own stem.
            expect(shapes(spec)).toEqual(
              new Map([
                ['petAdopted', 'CreatePetPetAdoptedShape'],
                ['petReturned', 'CreatePetPetReturnedShape'],
              ]),
            );
            expect(fieldsOf(spec, 'CreatePetPetAdoptedShape')).toEqual(['kind', 'sides']);
            expect(fieldsOf(spec, 'CreatePetPetReturnedShape')).toEqual(['kind', 'radius']);
            expect(modelNames(spec).sort()).toEqual([
              'CreatePetPetAdoptedShape',
              'CreatePetPetReturnedShape',
              'Memo',
              'Note',
            ]);
            expectResolved(spec);
            expect(warnings()).toEqual([]);
          },
        );

        it.each([true, false])(
          'shares one shape under the one name, as two webhooks do (adoptedFirst %s) (Greptile)',
          async (adoptedFirst) => {
            const spec = await parseJson(document({ sides: { type: 'integer' } }, adoptedFirst));
            // Identical shapes are the merge's to share: one `Shape`, both unions referencing it.
            expect(shapes(spec)).toEqual(
              new Map([
                ['petAdopted', 'Shape'],
                ['petReturned', 'Shape'],
              ]),
            );
            expect(fieldsOf(spec, 'Shape')).toEqual(['kind', 'sides']);
            expect(modelNames(spec).sort()).toEqual(['Memo', 'Note', 'Shape']);
            expectResolved(spec);
            expect(warnings()).toEqual([]);
          },
        );

        it("leaves a parameter's union over component schemas, and its mapping, on the components (Greptile)", async () => {
          // `petReturned` takes a query parameter whose union references the
          // component schemas `Shape` and `Other`, mapped by `kind`. The
          // rename of the payload's inline `Shape` must not reach them.
          const component = (value: string, own: Record<string, unknown>) => ({
            type: 'object',
            properties: { kind: { type: 'string', const: value }, ...own },
          });
          const figure = {
            name: 'figure',
            in: 'query',
            schema: {
              oneOf: [{ $ref: '#/components/schemas/Shape' }, { $ref: '#/components/schemas/Other' }],
              discriminator: {
                propertyName: 'kind',
                mapping: { shape: '#/components/schemas/Shape', other: '#/components/schemas/Other' },
              },
            },
          };
          const spec = await parseJson(
            document(
              { radius: { type: 'number' } },
              true,
              { parameters: [figure] },
              {
                components: {
                  schemas: {
                    Shape: component('shape', { area: { type: 'number' } }),
                    Other: component('other', { note: { type: 'string' } }),
                  },
                },
              },
            ),
          );

          const [adopted, returned] = operations(spec)[0]!.callbacks!;
          expect(variants(adopted!)).toEqual(['CreatePetPetAdoptedShape', 'Note']);
          expect(variants(returned!)).toEqual(['CreatePetPetReturnedShape', 'Memo']);
          // The parameter's union and mapping still target the components.
          const [param] = returned!.queryParams;
          expect(param!.name).toBe('figure');
          expect(param!.type).toMatchObject({
            kind: 'union',
            variants: [
              { kind: 'model', name: 'Shape' },
              { kind: 'model', name: 'Other' },
            ],
            discriminator: { property: 'kind', mapping: { shape: 'Shape', other: 'Other' } },
          });
          expect(fieldsOf(spec, 'Shape')).toEqual(['kind', 'area']);
          expect(fieldsOf(spec, 'CreatePetPetReturnedShape')).toEqual(['kind', 'radius']);
          expectResolved(spec);
          expect(warnings()).toEqual([]);
        });
      });

      it.each([
        { order: 'a, b, c, d', abFirst: true },
        { order: 'c, d, a, b', abFirst: false },
      ])(
        'decides every contested name together, so a name other callbacks vacate is taken alike in either order: $order (Greptile)',
        async ({ abFirst }) => {
          // `a` and `b` carry differing variants titled `Shape`; `c` and `d`
          // differing variants titled `CreatePetAShape` — the name `a`'s
          // rename asks for. `c` and `d` leave it this round, so `a` takes
          // it whichever pair comes first, never `CreatePetAShape2`.
          const titled = (title: string, value: string, own: Record<string, unknown>) => ({
            title,
            type: 'object',
            properties: { kind: { type: 'string', const: value }, ...own },
          });
          const union = (title: string, own: Record<string, unknown>, other: string) => ({
            oneOf: [titled(title, 'first', own), titled(other, 'second', { text: { type: 'string' } })],
          });
          const a = callbackPosting(union('Shape', { sides: { type: 'integer' } }, 'Note'));
          const b = callbackPosting(union('Shape', { radius: { type: 'number' } }, 'Memo'));
          const c = callbackPosting(union('CreatePetAShape', { width: { type: 'number' } }, 'Tag'));
          const d = callbackPosting(union('CreatePetAShape', { height: { type: 'number' } }, 'Label'));
          const spec = await parseJson(
            documentWith(openapi, {
              '/pets': { post: opWith(abFirst ? { a, b, c, d } : { c, d, a, b }, 'createPet') },
            }),
          );

          const first = (node: Callback) =>
            (node.requestBody as { variants: Array<{ name: string }> }).variants[0]!.name;
          const byKey = new Map(operations(spec)[0]!.callbacks!.map((node) => [node.name, first(node)]));
          expect(byKey).toEqual(
            new Map([
              ['a', 'CreatePetAShape'],
              ['b', 'CreatePetBShape'],
              ['c', 'CreatePetCCreatePetAShape'],
              ['d', 'CreatePetDCreatePetAShape'],
            ]),
          );
          const fieldsOf = (name: string) => spec.models.find((m) => m.name === name)!.fields.map((f) => f.name);
          expect(fieldsOf('CreatePetAShape')).toEqual(['kind', 'sides']);
          expect(fieldsOf('CreatePetCCreatePetAShape')).toEqual(['kind', 'width']);
          expect(modelNames(spec).sort()).toEqual(
            [
              'CreatePetAShape',
              'CreatePetBShape',
              'CreatePetCCreatePetAShape',
              'CreatePetDCreatePetAShape',
              'Label',
              'Memo',
              'Note',
              'Tag',
            ].sort(),
          );
          expectResolved(spec);
          expect(warnings()).toEqual([]);
        },
      );

      it.each([
        { order: 'a, b, c, d', abFirst: true },
        { order: 'c, d, a, b', abFirst: false },
      ])(
        "steps around the names reserved before the batch and those still minted, never a later wave's old snapshot: $order with a callback nested under d (Greptile)",
        async ({ abFirst }) => {
          // As above, with a callback `e` nested under `d`: minted in a later
          // wave, whose reserved snapshot still holds the `CreatePetAShape`
          // `c` and `d` minted before. That snapshot must not keep the name
          // occupied once `c` and `d` vacate it: `a` still takes it.
          const titled = (title: string, value: string, own: Record<string, unknown>) => ({
            title,
            type: 'object',
            properties: { kind: { type: 'string', const: value }, ...own },
          });
          const union = (title: string, own: Record<string, unknown>, other: string) => ({
            oneOf: [titled(title, 'first', own), titled(other, 'second', { text: { type: 'string' } })],
          });
          const a = callbackPosting(union('Shape', { sides: { type: 'integer' } }, 'Note'));
          const b = callbackPosting(union('Shape', { radius: { type: 'number' } }, 'Memo'));
          const c = callbackPosting(union('CreatePetAShape', { width: { type: 'number' } }, 'Tag'));
          const d = callbackPosting(union('CreatePetAShape', { height: { type: 'number' } }, 'Label'), {
            callbacks: { e: callbackPosting({ type: 'object', properties: { seen: { type: 'boolean' } } }) },
          });
          const spec = await parseJson(
            documentWith(openapi, {
              '/pets': { post: opWith(abFirst ? { a, b, c, d } : { c, d, a, b }, 'createPet') },
            }),
          );

          const first = (node: Callback) =>
            (node.requestBody as { variants: Array<{ name: string }> }).variants[0]!.name;
          const byKey = new Map(operations(spec)[0]!.callbacks!.map((node) => [node.name, first(node)]));
          expect(byKey).toEqual(
            new Map([
              ['a', 'CreatePetAShape'],
              ['b', 'CreatePetBShape'],
              ['c', 'CreatePetCCreatePetAShape'],
              ['d', 'CreatePetDCreatePetAShape'],
            ]),
          );
          const nested = operations(spec)[0]!.callbacks!.find((node) => node.name === 'd')!.callbacks!;
          expect(nested.map((node) => [node.name, (node.requestBody as { name: string }).name])).toEqual([
            ['e', 'CreatePetDePayload'],
          ]);
          expect(modelNames(spec)).toContain('CreatePetDePayload');
          expectResolved(spec);
          expect(warnings()).toEqual([]);
        },
      );

      it("renames a group's contested names as one map, so a replacement that spells another never merges two union references (Greptile)", async () => {
        // `x`'s second variant is titled with `x`'s own stem carrying all forty
        // characters of its identity's hash, so the resolution hashes `x`
        // to exhaustion — the title embeds every prefix — and `x` keeps that
        // stem, `S`. `y` carries differing variants of the same two titles.
        // Under `updatePet`, whose stem sorts after `Shape`, `x`'s `Shape` is
        // renamed first, to `<S>Shape` — the name `x` and `y` vacate — and
        // its `<S>Shape` to `<S><S>Shape`: two models, each union reference
        // on its own, never both on the second.
        const identity = callbackContext('updatePet', {
          name: 'x',
          expression: '{$request.body#/callbackUrl}',
          httpMethod: 'post',
        });
        const hash = createHash('sha1').update(identity).digest('hex');
        const base = 'UpdatePetX';
        // The stem as `plainStem` spells it, cased once more as every name
        // minted under it is (`XC7` reads as one word, `Xc7`).
        const S = toPascalCase(toPascalCase([base, numberedName(base, hash).slice(base.length)].join('_')));
        const titled = (title: string, value: string, own: Record<string, unknown>) => ({
          title,
          type: 'object',
          properties: { kind: { type: 'string', const: value }, ...own },
        });
        const union = (shape: Record<string, unknown>, long: Record<string, unknown>) => ({
          oneOf: [titled('Shape', 'first', shape), titled(`${S}Shape`, 'second', long)],
        });
        const spec = await parseJson(
          documentWith(openapi, {
            '/pets': {
              post: opWith(
                {
                  x: callbackPosting(union({ sides: { type: 'integer' } }, { width: { type: 'number' } })),
                  y: callbackPosting(union({ radius: { type: 'number' } }, { height: { type: 'number' } })),
                },
                'updatePet',
              ),
            },
          }),
        );

        const variants = (node: Callback) =>
          (node.requestBody as { variants: Array<{ name: string }> }).variants.map((v) => v.name);
        const [x, y] = operations(spec)[0]!.callbacks!;
        expect(variants(x!)).toEqual([`${S}Shape`, `${S}${S}Shape`]);
        expect(variants(y!)).toEqual(['UpdatePetYShape', `UpdatePetY${S}Shape`]);
        const fieldsOf = (name: string) => spec.models.find((m) => m.name === name)!.fields.map((f) => f.name);
        expect(fieldsOf(`${S}Shape`)).toEqual(['kind', 'sides']);
        expect(fieldsOf(`${S}${S}Shape`)).toEqual(['kind', 'width']);
        expect(fieldsOf('UpdatePetYShape')).toEqual(['kind', 'radius']);
        expect(fieldsOf(`UpdatePetY${S}Shape`)).toEqual(['kind', 'height']);
        expect(modelNames(spec).sort()).toEqual(
          [`${S}Shape`, `${S}${S}Shape`, 'UpdatePetYShape', `UpdatePetY${S}Shape`].sort(),
        );
        expectResolved(spec);
        expect(warnings()).toEqual([]);
      });

      it('names the callbacks of two owners whose operationIds clean to one stem apart, each with its own payload (Greptile)', async () => {
        // `createPet` and `create_pet` both clean to `CreatePet`; each
        // declares `petAdopted` under the same expression.
        // Michael's documents: `POST /pets` and `POST /pet-drafts`, payloads
        // `{ petId: string }` and `{ draftId: integer }`.
        const owners = (second: Record<string, unknown>, otherId = 'create_pet') =>
          documentWith(openapi, {
            '/pets': { post: opWith({ petAdopted: callbackPosting(petIdSchema) }, 'createPet') },
            '/pet-drafts': { post: opWith({ petAdopted: callbackPosting(second) }, otherId) },
          });
        const draft = { type: 'object', properties: { draftId: { type: 'integer' } } };

        const differing = await parseJson(owners(draft));
        const [first, second] = operations(differing).map((op) => payloadNames(op)[0]!);
        // `createPet` is spelled as the stem and keeps it; `create_pet` is
        // path-named (#627), so the two callbacks' stems differ, neither is
        // hashed (before #627 both plain stems were `CreatePetPetAdopted`
        // and both were hashed from their site labels), and each callback
        // references its own model with its own field type.
        expect([first, second]).toEqual(['CreatePetPetAdoptedPayload', 'PetDraftsPostPetAdoptedPayload']);
        const fieldOf = (spec: ApiSpec, name: string) => spec.models.find((m) => m.name === name)!.fields[0]!;
        expect(fieldOf(differing, first)).toMatchObject({ name: 'petId', type: { kind: 'primitive', type: 'string' } });
        expect(fieldOf(differing, second)).toMatchObject({
          name: 'draftId',
          type: { kind: 'primitive', type: 'integer' },
        });
        expect(modelNames(differing).sort()).toEqual([first, second].sort());
        expectResolved(differing);
        // No "more than one definition" warning: nothing was merged away.
        expect(warnings()).toEqual([]);

        // `CreatePet` instead of `create_pet` cleans to the same stem and parts the same way.
        const cased = await parseJson(owners(draft, 'CreatePet'));
        const casedNames = operations(cased).map((op) => payloadNames(op)[0]!);
        expect(casedNames).toEqual([first, second]);
        expect(fieldOf(cased, casedNames[1]!)).toMatchObject({
          name: 'draftId',
          type: { kind: 'primitive', type: 'integer' },
        });
        expect(warnings()).toEqual([]);

        // Identical payloads part the same way: the names depend on the
        // owners' ids alone, never on the payloads' shapes.
        const identical = await parseJson(owners(petIdSchema));
        expect(modelNames(identical).sort()).toEqual([first, second].sort());
        expect(operations(identical).map((op) => payloadNames(op)[0]!)).toEqual([first, second]);
        expect(warnings()).toEqual([]);
      });

      it('hashes the stem of a callback whose payload name a component already holds, and never renames the component', async () => {
        const spec = await parseJson(
          documentWith(
            openapi,
            { '/pets': { post: opWith({ petAdopted: callbackPosting() }, 'createPet') } },
            {
              components: {
                schemas: { CreatePetPetAdoptedPayload: { type: 'object', properties: { other: { type: 'integer' } } } },
              },
            },
          ),
        );

        // The component keeps its name and its field; the callback steps to a
        // hashed stem, as a webhook's does, and references the hashed model.
        expect(modelNames(spec)).toEqual(['CreatePetPetAdoptedPayload', 'CreatePetPetAdopted2Fac84Payload']);
        expect(spec.models[0]!.fields.map((f) => f.name)).toEqual(['other']);
        expect(spec.models[1]!.fields.map((f) => f.name)).toEqual(['petId']);
        expect(payloadNames(operations(spec)[0]!)).toEqual(['CreatePetPetAdopted2Fac84Payload']);
        expectResolved(spec);
        expect(warnings()).toEqual([]);
      });

      it('reads a nested callback under its parent, named from the parent callback stem', async () => {
        const spec = await parseJson(
          documentWith(openapi, {
            '/pets': {
              post: opWith(
                {
                  petAdopted: callbackPosting(petIdSchema, {
                    callbacks: {
                      confirmed: callbackPosting({ type: 'object', properties: { ok: { type: 'boolean' } } }),
                    },
                  }),
                },
                'createPet',
              ),
            },
          }),
        );

        expect(callbackKeys(operations(spec)[0]!)).toEqual([
          'petAdopted.{$request.body#/callbackUrl}.post',
          '>confirmed.{$request.body#/callbackUrl}.post',
        ]);
        expect(payloadNames(operations(spec)[0]!)).toEqual([
          'CreatePetPetAdoptedPayload',
          'CreatePetPetAdoptedConfirmedPayload',
        ]);
        expect(modelNames(spec)).toEqual(['CreatePetPetAdoptedPayload', 'CreatePetPetAdoptedConfirmedPayload']);
        // The nested callback's models are reached through the operation.
        expectResolved(spec);
        expect(warnings()).toEqual([]);
      });

      it('skips a callback that refers back to one it sits in, with one warning, and ends the parse', async () => {
        const spec = await parseJson(
          documentWith(
            openapi,
            { '/pets': { post: opWith({ petAdopted: { $ref: '#/components/callbacks/self' } }, 'createPet') } },
            {
              components: {
                callbacks: {
                  self: callbackPosting(petIdSchema, { callbacks: { again: { $ref: '#/components/callbacks/self' } } }),
                },
              },
            },
          ),
        );

        // The outer callback is read; its own `again` is the one it sits in.
        expect(callbackKeys(operations(spec)[0]!)).toEqual(['petAdopted.{$request.body#/callbackUrl}.post']);
        expect(operations(spec)[0]!.callbacks![0]).not.toHaveProperty('callbacks');
        expect(modelNames(spec)).toEqual(['CreatePetPetAdoptedPayload']);
        expect(warnings()).toEqual([
          '[oagen] Warning: Callback "createPet.callbacks.petAdopted.{$request.body#/callbackUrl}.post.callbacks.again" ' +
            'refers back to a callback it sits in; skipping it.',
        ]);
      });

      it("skips a callback whose path item is the declaring operation's own, which would recurse through it", async () => {
        const spec = await parseJson(
          documentWith(openapi, {
            '/pets': {
              post: opWith({ petAdopted: { '{$request.body#/callbackUrl}': { $ref: '#/paths/~1pets' } } }, 'createPet'),
            },
          }),
        );

        // The callback is `createPet` itself (named from its operationId);
        // its `petAdopted` is the callback being read.
        const [callback] = operations(spec)[0]!.callbacks!;
        expect(callback).toMatchObject({ name: 'petAdopted', httpMethod: 'post', operationId: 'createPet' });
        expect(callback).not.toHaveProperty('callbacks');
        expect(warnings()).toEqual([
          '[oagen] Warning: Callback "createPet.callbacks.petAdopted.{$request.body#/callbackUrl}.post.callbacks.petAdopted" ' +
            'refers back to a callback it sits in; skipping it.',
        ]);
      });

      it('reads parameters, docs, deprecation, tags, security, the body flag and every media type as a webhook does, and drops a path parameter', async () => {
        const spec = await parseJson(
          documentWith(openapi, {
            '/pets': {
              post: opWith(
                {
                  petAdopted: {
                    '{$request.body#/callbackUrl}': {
                      summary: 'Item summary',
                      description: 'Item description',
                      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
                      post: {
                        deprecated: true,
                        tags: ['events'],
                        security: [{ sig: [] }],
                        parameters: [
                          { name: 'X-Signature', in: 'header', required: true, schema: { type: 'string' } },
                          { name: 'attempt', in: 'query', schema: { type: 'integer' } },
                          { name: 'session', in: 'cookie', schema: { type: 'string' } },
                          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['a', 'b'] } },
                        ],
                        requestBody: {
                          required: true,
                          description: 'The adoption',
                          content: {
                            'application/json': { schema: petIdSchema },
                            'text/csv': { schema: { type: 'object', properties: { row: { type: 'string' } } } },
                          },
                        },
                        responses: { '204': { description: 'Done' }, '2XX': { description: 'range' } },
                      },
                    },
                  },
                },
                'createPet',
              ),
            },
          }),
        );

        const [callback] = operations(spec)[0]!.callbacks!;
        expect(callback).toMatchObject({
          summary: 'Item summary',
          description: 'Item description',
          deprecated: true,
          tags: ['events'],
          // Read as `Operation.security` is: one alternative per requirement object.
          security: [[{ schemeName: 'sig', scopes: [] }]],
          requestBody: { kind: 'model', name: 'CreatePetPetAdoptedPayload' },
          requestBodyRequired: true,
          requestBodyDescription: 'The adoption',
          requestBodyContentTypes: ['application/json', 'text/csv'],
          requestBodyContents: [
            { contentType: 'application/json', type: { kind: 'model', name: 'CreatePetPetAdoptedPayload' } },
            { contentType: 'text/csv', type: { kind: 'model', name: 'CreatePetPetAdoptedTextCsvPayload' } },
          ],
          // Three-digit codes only: the range is not carried.
          responses: [{ statusCode: 204, description: 'Done' }],
        });
        expect(callback!.headerParams.map((p) => [p.name, p.required])).toEqual([['X-Signature', true]]);
        expect(callback!.queryParams.map((p) => p.name)).toEqual(['attempt', 'kind']);
        expect(callback!.cookieParams?.map((p) => p.name)).toEqual(['session']);
        // The inline query enum is qualified with the stem and lifted.
        expect(callback!.queryParams[1]!.type).toMatchObject({ kind: 'enum', name: 'CreatePetPetAdoptedKind' });
        expect(spec.enums.map((e) => e.name)).toEqual(['CreatePetPetAdoptedKind']);
        expect(modelNames(spec)).toEqual(['CreatePetPetAdoptedPayload', 'CreatePetPetAdoptedTextCsvPayload']);
        expectResolved(spec);
        expect(warnings()).toEqual([
          '[oagen] Warning: Parameter "petId" (in: path) on createPet.callbacks.petAdopted.{$request.body#/callbackUrl}.post ' +
            'ignored: a callback has no path to place it in.',
        ]);
      });

      it('repoints a callback payload the `…Json` fold merges onto its base model', async () => {
        const spec = await parseJson(
          documentWith(
            openapi,
            {
              '/pets': {
                post: opWith({ petAdopted: callbackPosting({ $ref: '#/components/schemas/PetJson' }) }, 'createPet'),
              },
            },
            {
              components: {
                schemas: {
                  Pet: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
                  PetJson: {
                    type: 'object',
                    properties: { id: { type: 'string' }, at: { type: 'string' } },
                    required: ['id'],
                  },
                },
              },
            },
          ),
        );

        expect(modelNames(spec)).toEqual(['Pet']);
        expect(payloadNames(operations(spec)[0]!)).toEqual(['Pet']);
        expectResolved(spec);
        expect(warnings()).toEqual(['[oagen] Merged "PetJson" into "Pet" (2 fields, superset)']);
      });

      it('keeps a callback payload out of the error-body collapse, still referenced, while the error body folds', async () => {
        const messageSchema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
        const spec = await parseJson(
          documentWith(openapi, {
            '/pets': {
              post: {
                operationId: 'createPet',
                responses: {
                  '200': { description: 'OK' },
                  '400': { description: 'Bad', content: { 'application/json': { schema: messageSchema } } },
                },
                callbacks: { petAdopted: callbackPosting(messageSchema) },
              },
            },
          }),
        );

        // The error body is error-only and folds; the callback payload is
        // reached from the callback and stays, under its own name.
        expect(modelNames(spec)).toEqual(['CreatePetPetAdoptedPayload', 'ErrorBody']);
        expect(operations(spec)[0]!.errors[0]!.type).toEqual({ kind: 'model', name: 'ErrorBody' });
        expect(payloadNames(operations(spec)[0]!)).toEqual(['CreatePetPetAdoptedPayload']);
        expectResolved(spec);
        validateModelRefs(spec);
        expect(warnings()).toEqual([]);
      });

      it("assigns a callback's payload to the operation's service, and reaches it for emission", async () => {
        const spec = await parseJson(issueRepro(openapi));

        expect(assignModelsToServices(spec.models, spec.services).get('CreatePetPetAdoptedPayload')).toBe('Pets');
        const reached = collectReferencedNames(spec.services, spec.models, { webhooks: spec.webhooks });
        expect(reached.models.has('CreatePetPetAdoptedPayload')).toBe(true);
      });
    });

    describe('on a `webhooks` operation', () => {
      it("reads the webhook's callbacks into Webhook.callbacks, named from the webhook's stem", async () => {
        const spec = await parseJson(
          documentWith(
            openapi,
            {},
            {
              webhooks: {
                petAdopted: {
                  post: {
                    requestBody: { content: { 'application/json': { schema: petIdSchema } } },
                    responses: { '200': { description: 'OK' } },
                    callbacks: { adoptionConfirmed: callbackPosting() },
                  },
                },
              },
            },
          ),
        );

        expect(spec.webhooks?.map(({ name, httpMethod }) => `${name}.${httpMethod}`)).toEqual(['petAdopted.post']);
        // The webhook's own payload first, then the callback's.
        expect(modelNames(spec)).toEqual(['PetAdoptedPayload', 'PetAdoptedAdoptionConfirmedPayload']);
        expect(callbackKeys(spec.webhooks![0]!)).toEqual(['adoptionConfirmed.{$request.body#/callbackUrl}.post']);
        expect(payloadNames(spec.webhooks![0]!)).toEqual(['PetAdoptedAdoptionConfirmedPayload']);
        expectResolved(spec);
        expect(warnings()).toEqual([]);
      });

      it('reads the callbacks of every (key, method) entry, two keys sharing one components/pathItems entry included', async () => {
        const spec = await parseJson(
          documentWith(
            openapi,
            {},
            {
              webhooks: {
                petUpdated: {
                  put: { responses: { '200': { description: 'OK' } }, callbacks: { putDone: callbackPosting() } },
                  post: { responses: { '200': { description: 'OK' } }, callbacks: { postDone: callbackPosting() } },
                },
                petQuiet: { post: { responses: { '200': { description: 'OK' } } } },
                // Two keys resolving to one operation object are two sites: each gets the callbacks.
                sharedA: { $ref: '#/components/pathItems/shared' },
                sharedB: { $ref: '#/components/pathItems/shared' },
              },
              components: {
                pathItems: {
                  shared: {
                    post: { responses: { '200': { description: 'OK' } }, callbacks: { shared: callbackPosting() } },
                  },
                },
              },
            },
          ),
        );

        expect(spec.webhooks?.map(({ name, httpMethod }) => `${name}.${httpMethod}`)).toEqual([
          'petUpdated.put',
          'petUpdated.post',
          'petQuiet.post',
          'sharedA.post',
          'sharedB.post',
        ]);
        expect(spec.webhooks!.map((webhook) => payloadNames(webhook))).toEqual([
          ['PetUpdatedPutPutDonePayload'],
          ['PetUpdatedPostPostDonePayload'],
          [],
          ['SharedASharedPayload'],
          ['SharedBSharedPayload'],
        ]);
        expect(spec.webhooks![2]).not.toHaveProperty('callbacks');
        expect(modelNames(spec)).toEqual([
          'PetUpdatedPutPutDonePayload',
          'PetUpdatedPostPostDonePayload',
          'SharedASharedPayload',
          'SharedBSharedPayload',
        ]);
        expectResolved(spec);
        expect(warnings()).toEqual([]);
      });
    });
  });

  describe('extractCallbacks', () => {
    /** A hand-built owner with nothing on it. */
    const owner = (): Webhook => ({ name: 'x', httpMethod: 'post', headerParams: [], queryParams: [], responses: [] });

    it.each([
      { what: 'undefined', callbacks: undefined },
      { what: 'null', callbacks: null },
      { what: 'a string', callbacks: 'petAdopted' },
      { what: 'an array', callbacks: [{ petAdopted: {} }] },
      { what: 'an empty map', callbacks: {} },
      { what: 'a map of empty Callback Objects', callbacks: { petAdopted: {} } },
    ])('reads nothing, silently, from $what', ({ callbacks }) => {
      const node = owner();
      const result = extractCallbacks(
        [{ owner: node, callbacks, label: 'webhooks.x.post', stem: 'X' }],
        {},
        [],
        [],
        'override',
      );

      expect(result).toEqual({ inlineModels: [], inlineModelBundles: [] });
      expect(node).not.toHaveProperty('callbacks');
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns once per callback it cannot read, naming the site, and reads the rest', () => {
      const node = owner();
      const result = extractCallbacks(
        [
          {
            owner: node,
            callbacks: {
              b: 'nope',
              a: { $ref: '#/components/callbacks/missing' },
              c: { $ref: 42 },
              d: { $ref: '#/components/callbacks/loopA' },
              event: { '{$request.body#/url}': 'not a path item', 'x-note': { post: {} }, ...callbackPosting() },
            },
            label: 'webhooks.x.post',
            stem: 'Hook',
          },
        ],
        {
          callbacks: {
            loopA: { $ref: '#/components/callbacks/loopB' },
            loopB: { $ref: '#/components/callbacks/loopA' },
          },
        },
        [],
        [],
        'override',
      );

      // The Callback Object declares two expressions (the `x-` key is an
      // extension, not one), so the stem is qualified by the expression even
      // though the other expression's path item could not be read.
      expect(result.inlineModels.map((m) => m.name)).toEqual(['HookEventRequestBodyCallbackUrlPayload']);
      expect(callbackKeys(node)).toEqual(['event.{$request.body#/callbackUrl}.post']);
      expect(warnings()).toEqual([
        '[oagen] Warning: Callback "webhooks.x.post.callbacks.b" is not a Callback Object; skipping it.',
        '[oagen] Warning: Unresolved callback $ref "#/components/callbacks/missing" for callback "webhooks.x.post.callbacks.a": ' +
          'no matching entry under components/callbacks. Skipping the callback.',
        '[oagen] Warning: Callback "webhooks.x.post.callbacks.c" has a non-string $ref; skipping it.',
        '[oagen] Warning: Circular callback $ref chain starting at "#/components/callbacks/loopA" for callback ' +
          '"webhooks.x.post.callbacks.d"; skipping it.',
        '[oagen] Warning: Callback "webhooks.x.post.callbacks.event.{$request.body#/url}" is not a path item object; skipping it.',
      ]);
    });

    it('steps a key-derived stem around every reserved name and the other callbacks of the batch', () => {
      const node = owner();
      const result = extractCallbacks(
        [
          {
            owner: node,
            callbacks: { petAdopted: callbackPosting(), pet_adopted: callbackPosting() },
            label: 'webhooks.x.post',
            stem: 'X',
          },
        ],
        {},
        ['XPetAdoptedPayload'],
        [],
        'override',
      );

      // Both keys flatten to `XPetAdopted`, and the name is reserved too, so
      // both are hashed — from each callback's site label (owner, key,
      // expression and method), so neither takes the other's hash.
      expect(result.inlineModels.map((m) => m.name)).toEqual(['XPetAdoptedFfca5CPayload', 'XPetAdopted30De9DPayload']);
      expect(payloadNames(node)).toEqual(['XPetAdoptedFfca5CPayload', 'XPetAdopted30De9DPayload']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('validateModelRefs reports an unresolved callback reference under its site', () => {
      const node = owner();
      node.callbacks = [
        {
          name: 'confirmed',
          expression: '{$request.body#/url}',
          httpMethod: 'post',
          headerParams: [{ name: 'X-Meta', type: { kind: 'model', name: 'MissingMeta' }, required: false }],
          queryParams: [],
          requestBody: { kind: 'model', name: 'MissingPayload' },
          responses: [],
        },
      ];
      const spec: ApiSpec = {
        name: 'Test',
        version: '1',
        baseUrl: '',
        services: [],
        webhooks: [node],
        models: [],
        enums: [],
        sdk: defaultSdkBehavior(),
      };

      validateModelRefs(spec);

      expect(warnings()).toEqual([
        '[oagen] Warning: Unresolved model reference "MissingMeta" (context: webhooks.x.post.callbacks.confirmed.{$request.body#/url}.post.X-Meta)',
        '[oagen] Warning: Unresolved model reference "MissingPayload" (context: webhooks.x.post.callbacks.confirmed.{$request.body#/url}.post.requestBody)',
      ]);
    });
  });
});
