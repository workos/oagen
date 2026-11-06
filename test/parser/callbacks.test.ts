import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

      it('names the callbacks of two owners whose operationIds clean to one stem apart, each with its own payload (Greptile)', async () => {
        // `createPet` and `create_pet` both name their models from `CreatePet`;
        // each declares `petAdopted` under the same expression.
        const owners = (second: Record<string, unknown>) =>
          documentWith(openapi, {
            '/pets': { post: opWith({ petAdopted: callbackPosting(petIdSchema) }, 'createPet') },
            '/animals': { post: opWith({ petAdopted: callbackPosting(second) }, 'create_pet') },
          });

        const differing = await parseJson(owners({ type: 'object', properties: { petId: { type: 'integer' } } }));
        const [first, second] = operations(differing).map((op) => payloadNames(op)[0]!);
        // Both plain stems are `CreatePetPetAdopted`, so both are hashed —
        // from each callback's site label, never alike — and each callback
        // references its own model with its own field type.
        expect(first).not.toBe(second);
        for (const name of [first, second]) expect(name).toMatch(/^CreatePetPetAdopted[0-9A-Fa-f]{6}Payload$/);
        const typeOf = (name: string) => differing.models.find((m) => m.name === name)!.fields[0]!.type;
        expect(typeOf(first)).toMatchObject({ kind: 'primitive', type: 'string' });
        expect(typeOf(second)).toMatchObject({ kind: 'primitive', type: 'integer' });
        expect(modelNames(differing).sort()).toEqual([first, second].sort());
        expectResolved(differing);
        expect(warnings()).toEqual([]);

        // Identical payloads part the same way: neither owner is more
        // canonical, as neither of two webhook keys that flatten to one stem is.
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
