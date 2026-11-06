import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import { collectInlineEnumsFromWebhooks } from '../../src/parser/collect-inline-enums.js';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { collectReferencedNames } from '../../src/engine/generate-files.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { assignModelsToServices, collectModelRefs, collectWebhookTypeRefs } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Enum, Model, TypeRef, Webhook } from '../../src/ir/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');

/** A webhook entry whose POST carries the given inline JSON payload schema. */
function postWith(schema: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    post: {
      ...extra,
      requestBody: { content: { 'application/json': { schema } } },
      responses: { '200': { description: 'ok' } },
    },
  };
}

const petSchema = { type: 'object', properties: { pet_id: { type: 'string' } } };

/** An ApiSpec with the given models and webhooks and nothing else. */
function specWith(models: Model[], webhooks: Webhook[], enums: Enum[] = []): ApiSpec {
  return {
    name: 'Test',
    version: '1',
    baseUrl: '',
    services: [],
    ...(webhooks.length > 0 ? { webhooks } : {}),
    models,
    enums,
    sdk: defaultSdkBehavior(),
  };
}

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return { name: 'x', httpMethod: 'post', headerParams: [], queryParams: [], responses: [], ...overrides };
}

/**
 * Every model a webhook references exists, `validateModelRefs` has nothing
 * to say, and every model and enum of the spec is reachable (nothing is
 * orphaned) once the webhooks seed reachability.
 */
function expectResolvedAndReferenced(spec: ApiSpec, warn: { mock: { calls: unknown[][] } }): void {
  const modelNames = new Set(spec.models.map((m) => m.name));
  for (const hook of spec.webhooks ?? []) {
    for (const ref of collectWebhookTypeRefs(hook)) {
      for (const name of collectModelRefs(ref)) expect(modelNames.has(name), name).toBe(true);
    }
  }
  validateModelRefs(spec);
  expect(warn.mock.calls).toEqual([]);

  const referenced = collectReferencedNames(spec.services, spec.models, { webhooks: spec.webhooks });
  for (const model of spec.models) expect(referenced.models.has(model.name), model.name).toBe(true);
  for (const e of spec.enums) expect(referenced.enums.has(e.name), e.name).toBe(true);
}

/** The fields of the model a reference points at. */
function fieldsOf(spec: ApiSpec, ref: unknown): string[] {
  const name = (ref as { name: string }).name;
  const model = spec.models.find((m) => m.name === name);
  expect(model, name).toBeDefined();
  return model!.fields.map((f) => f.name);
}

describe('webhooks', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('through parseSpec (issue #218 repro)', () => {
    it('keeps the webhooks on ApiSpec, each with its payload', async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);

      expect(Object.keys(spec)).toContain('webhooks');
      expect(JSON.stringify(spec)).toContain('petAdopted');
      expect(spec.models.map((m) => m.name)).toContain('AdoptionEvent');

      const petAdopted = spec.webhooks!.find((w) => w.name === 'petAdopted')!;
      expect(petAdopted.operationId).toBe('petAdopted');
      expect(petAdopted.httpMethod).toBe('post');
      expect(petAdopted.description).toBe('Sent when a pet is adopted.');
      expect(petAdopted.requestBody).toEqual({ kind: 'model', name: 'AdoptionEvent' });
      expect(petAdopted.requestBodyEncoding).toBe('json');
      expect(petAdopted.responses).toEqual([{ statusCode: 200, description: 'Acknowledged' }]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('places webhooks after services in the IR and yields one entry per method, in document order', async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);

      expect(Object.keys(spec)).toMatchInlineSnapshot(`
        [
          "name",
          "version",
          "description",
          "baseUrl",
          "servers",
          "services",
          "webhooks",
          "models",
          "enums",
          "auth",
          "security",
          "sdk",
        ]
      `);
      expect(spec.webhooks!.map((w) => `${w.httpMethod} ${w.name}`)).toEqual([
        'post petAdopted',
        'post pet.returned',
        'post shelterClosed',
        'post petEvent',
        'post petUpdated',
        'put petUpdated',
      ]);
    });

    it('carries summary, description, deprecation, tags, security, the body requirement, and three-digit responses', async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);
      const returned = spec.webhooks!.find((w) => w.name === 'pet.returned')!;

      expect(returned).toMatchInlineSnapshot(`
        {
          "deprecated": true,
          "description": "Sent when an adopted pet is returned to the shelter.",
          "headerParams": [
            {
              "default": undefined,
              "deprecated": undefined,
              "description": "HMAC of the body.",
              "example": undefined,
              "explode": undefined,
              "name": "X-Signature",
              "required": true,
              "style": undefined,
              "type": {
                "kind": "primitive",
                "type": "string",
              },
            },
            {
              "default": undefined,
              "deprecated": undefined,
              "description": undefined,
              "example": undefined,
              "explode": undefined,
              "name": "X-Event-Type",
              "required": false,
              "style": undefined,
              "type": {
                "kind": "enum",
                "name": "PetReturnedXEventType",
                "values": [
                  "pet.returned",
                  "pet.returned.v2",
                ],
              },
            },
          ],
          "httpMethod": "post",
          "name": "pet.returned",
          "queryParams": [],
          "requestBody": {
            "kind": "model",
            "name": "PetReturnedPayload",
          },
          "requestBodyContentType": "application/json",
          "requestBodyContentTypes": [
            "application/json",
          ],
          "requestBodyContents": [
            {
              "contentType": "application/json",
              "type": {
                "kind": "model",
                "name": "PetReturnedPayload",
              },
            },
          ],
          "requestBodyEncoding": "json",
          "requestBodyRequired": true,
          "responses": [
            {
              "description": "Acknowledged",
              "statusCode": 200,
            },
            {
              "description": "Malformed; not retried",
              "statusCode": 400,
            },
          ],
          "security": [
            [
              {
                "schemeName": "webhookSecret",
                "scopes": [],
              },
            ],
          ],
          "summary": "Pet returned",
          "tags": [
            "pets",
          ],
        }
      `);
    });

    it('materializes an inline payload as <Stem>Payload, nested objects and enums under it', async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);

      const payload = spec.models.find((m) => m.name === 'PetReturnedPayload')!;
      expect(payload.fields.map((f) => [f.name, f.required])).toEqual([
        ['reason', false],
        ['pet', true],
      ]);
      expect(payload.fields[1].type).toEqual({ kind: 'model', name: 'PetReturnedPayloadPet' });
      expect(spec.models.find((m) => m.name === 'PetReturnedPayloadPet')!.fields.map((f) => f.name)).toEqual(['id']);
      // The field enum is promoted through the model; the header enum through the webhook.
      expect(spec.enums.map((e) => e.name)).toEqual(['PetReturnedPayloadReason', 'PetReturnedXEventType']);
    });

    it('keeps a discriminated oneOf payload as a union with every variant materialized', async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);
      const event = spec.webhooks!.find((w) => w.name === 'petEvent')!;

      expect(event.requestBody).toEqual({
        kind: 'union',
        variants: [
          { kind: 'model', name: 'PetEventPayload' },
          { kind: 'model', name: 'ReturnedPetEventPayload' },
        ],
        compositionKind: 'oneOf',
        discriminator: {
          property: 'kind',
          mapping: { adopted: 'PetEventPayload', returned: 'ReturnedPetEventPayload' },
        },
      });
      for (const variant of ['PetEventPayload', 'ReturnedPetEventPayload']) {
        expect(spec.models.find((m) => m.name === variant)!.fields.map((f) => f.name)).toEqual(['kind', 'pet_id']);
      }
    });

    it("names each method's payload apart when one key declares several methods", async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);
      const [post, put] = spec.webhooks!.filter((w) => w.name === 'petUpdated');

      expect(post.requestBody).toEqual({ kind: 'model', name: 'PetUpdatedPostPayload' });
      expect(put.requestBody).toEqual({ kind: 'model', name: 'PetUpdatedPutPayload' });
      expect(spec.models.find((m) => m.name === 'PetUpdatedPostPayload')!.fields).toHaveLength(1);
      expect(spec.models.find((m) => m.name === 'PetUpdatedPutPayload')!.fields).toHaveLength(2);
    });

    it('resolves a components/pathItems reference, path-item-level parameters included', async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);
      const closed = spec.webhooks!.find((w) => w.name === 'shelterClosed')!;

      expect(closed.operationId).toBe('shelterClosed');
      expect(closed.headerParams.map((p) => [p.name, p.required])).toEqual([
        ['X-Delivery-Id', true],
        ['X-Meta', false],
      ]);
      expect(closed.requestBody).toBeUndefined();
      expect(Object.keys(closed)).not.toContain('requestBody');
      expect(closed.responses).toEqual([{ statusCode: 204, description: 'ok' }]);
    });

    it('materializes an object-shaped parameter under the name the parameter references', async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);
      const closed = spec.webhooks!.find((w) => w.name === 'shelterClosed')!;

      expect(closed.headerParams[1].type).toEqual({ kind: 'model', name: 'ShelterClosedXMeta' });
      expect(spec.models.find((m) => m.name === 'ShelterClosedXMeta')!.fields.map((f) => f.name)).toEqual(['etag']);
    });

    it('follows a components/responses reference for the description', async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);
      const event = spec.webhooks!.find((w) => w.name === 'petEvent')!;

      expect(event.responses).toEqual([{ statusCode: 202, description: 'Queued for delivery' }]);
    });

    it('does not turn a webhook into a service or an operation', async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);

      expect(spec.services.map((s) => [s.name, s.operations.map((o) => o.name)])).toEqual([['Pets', ['listPets']]]);
      // Payload models belong to no service: a webhook is not one, so they
      // stay unassigned unless a service reaches them or a hint pins them.
      const assigned = assignModelsToServices(spec.models, spec.services);
      expect([...assigned.keys()]).toEqual([]);
    });

    it('resolves every model a webhook references and orphans none of their models', async () => {
      const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);

      expectResolvedAndReferenced(spec, warn);
      // Without the webhooks, every one of them would be pruned as an orphan.
      expect(collectReferencedNames(spec.services, spec.models).models.size).toBe(0);
    });
  });

  describe('documents without webhooks', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-webhooks-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function parseJson(doc: unknown): Promise<ApiSpec> {
      const specFile = path.join(tmpDir, 'spec.json');
      await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
      return parseSpec(specFile);
    }

    it('omits the key entirely for a document that declares none', async () => {
      const spec = await parseSpec(`${FIXTURES}/minimal.yml`);
      expect('webhooks' in spec).toBe(false);
    });

    it('does not read x-webhooks, and says so', async () => {
      const spec = await parseJson({
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: {},
        'x-webhooks': { petAdopted: postWith(petSchema) },
      });

      expect('webhooks' in spec).toBe(false);
      expect(spec.models).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('`x-webhooks` is not read');
    });

    it("never takes a name a component's inline field model needs, map values included", async () => {
      // Greptile's case: `Event.payload` is a map of inline objects, whose
      // value model is `EventPayload` — the name a webhook keyed `event` would
      // also mint. The component's model must keep its own fields.
      const mapOfObjects = {
        type: 'object',
        additionalProperties: { type: 'object', properties: { id: { type: 'string' } } },
      };
      const spec = await parseJson({
        openapi: '3.1.0',
        info: { title: 't', version: '1' },
        paths: {},
        webhooks: { event: postWith(petSchema) },
        components: { schemas: { Event: { type: 'object', properties: { payload: mapOfObjects } } } },
      });

      expect(spec.models.find((m) => m.name === 'EventPayload')!.fields.map((f) => f.name)).toEqual(['id']);
      const payloadName = (spec.webhooks![0].requestBody as { name: string }).name;
      expect(payloadName).toMatchInlineSnapshot(`"Event5006EdPayload"`);
      expect(spec.models.find((m) => m.name === payloadName)!.fields.map((f) => f.name)).toEqual(['pet_id']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never takes a name a component needs for a nested inline model either', async () => {
      // Only the nested name coincides: `Order.payload_item` is `OrderPayloadItem`,
      // which the webhook's `item` property under `OrderPayload` would also mint.
      const item = { type: 'object', properties: { qty: { type: 'integer' } } };
      const payloadItem = { type: 'object', properties: { sku: { type: 'string' } } };
      const spec = await parseJson({
        openapi: '3.1.0',
        info: { title: 't', version: '1' },
        paths: {},
        webhooks: { order: postWith({ type: 'object', properties: { item } }) },
        components: { schemas: { Order: { type: 'object', properties: { payload_item: payloadItem } } } },
      });

      expect(spec.models.find((m) => m.name === 'OrderPayloadItem')!.fields.map((f) => f.name)).toEqual(['sku']);
      expect(spec.models.map((m) => m.name)).toMatchInlineSnapshot(`
        [
          "Order",
          "OrderPayloadItem",
          "OrderCce55EPayload",
          "OrderCce55EPayloadItem",
        ]
      `);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never takes the name of a component enum for an inline parameter enum', async () => {
      const header = { name: 'X-Source', in: 'header', schema: { type: 'string', enum: ['app', 'web'] } };
      const spec = await parseJson({
        openapi: '3.1.0',
        info: { title: 't', version: '1' },
        paths: {},
        webhooks: { petAdopted: { post: { parameters: [header], responses: {} } } },
        components: { schemas: { PetAdoptedXSource: { type: 'string', enum: ['legacy'] } } },
      });

      const headerEnum = spec.webhooks![0].headerParams[0].type as { name: string };
      expect(headerEnum.name).toMatchInlineSnapshot(`"PetAdoptedB4A950XSource"`);
      expect(spec.enums.map((e) => [e.name, e.values.map((v) => v.value)])).toEqual([
        ['PetAdoptedXSource', ['legacy']],
        [headerEnum.name, ['app', 'web']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps a parameter named like the payload apart from the body, each typed with its own fields', async () => {
      // Greptile's case: a query parameter `payload` would mint the body's
      // `<Stem>Payload`; a header `X-Meta` beside a query `x_meta` would mint
      // `<Stem>XMeta` twice.
      const spec = await parseJson({
        openapi: '3.1.0',
        info: { title: 't', version: '1' },
        paths: {},
        webhooks: {
          petAdopted: postWith(petSchema, {
            parameters: [
              { name: 'payload', in: 'query', schema: { type: 'object', properties: { id: { type: 'string' } } } },
              { name: 'X-Meta', in: 'header', schema: { type: 'object', properties: { etag: { type: 'string' } } } },
              { name: 'x_meta', in: 'query', schema: { type: 'object', properties: { trace: { type: 'string' } } } },
            ],
          }),
        },
      });

      const [hook] = spec.webhooks!;
      expect(hook.requestBody).toEqual({ kind: 'model', name: 'PetAdoptedPayload' });
      expect(fieldsOf(spec, hook.requestBody)).toEqual(['pet_id']);
      expect(hook.queryParams.map((p) => p.type)).toEqual([
        { kind: 'model', name: 'PetAdoptedQueryPayload' },
        { kind: 'model', name: 'PetAdoptedQueryXMeta' },
      ]);
      expect(fieldsOf(spec, hook.queryParams[0].type)).toEqual(['id']);
      expect(fieldsOf(spec, hook.queryParams[1].type)).toEqual(['trace']);
      expect(hook.headerParams[0].type).toEqual({ kind: 'model', name: 'PetAdoptedXMeta' });
      expect(fieldsOf(spec, hook.headerParams[0].type)).toEqual(['etag']);
      expectResolvedAndReferenced(spec, warn);
    });

    it('lets two keys that reference one path item share its stem and its payload model', async () => {
      // The reviewer's case: `a` and `b` both `$ref` `S`, so both carry
      // `operationId: shared` and must share one `SharedPayload`, not collide.
      const spec = await parseJson({
        openapi: '3.1.0',
        info: { title: 't', version: '1' },
        paths: {},
        webhooks: {
          a: { $ref: '#/components/pathItems/S' },
          other: postWith({ type: 'object', properties: { note: { type: 'string' } } }),
          b: { $ref: '#/components/pathItems/S' },
        },
        components: {
          pathItems: {
            S: postWith(petSchema, {
              operationId: 'shared',
              parameters: [{ name: 'X-Sig', in: 'header', required: true, schema: { type: 'string' } }],
            }),
          },
        },
      });

      expect(spec.webhooks!.map((w) => [w.name, w.operationId, w.requestBody])).toEqual([
        ['a', 'shared', { kind: 'model', name: 'SharedPayload' }],
        ['other', undefined, { kind: 'model', name: 'OtherPayload' }],
        ['b', 'shared', { kind: 'model', name: 'SharedPayload' }],
      ]);
      // Minted once, in the order of each stem's first key.
      expect(spec.models.map((m) => m.name)).toEqual(['SharedPayload', 'OtherPayload']);
      expect(fieldsOf(spec, spec.webhooks![0].requestBody)).toEqual(['pet_id']);
      expect(spec.webhooks![2].headerParams.map((p) => p.name)).toEqual(['X-Sig']);
      // Each webhook owns its IR nodes.
      expect(spec.webhooks![0].requestBody).not.toBe(spec.webhooks![2].requestBody);
      expectResolvedAndReferenced(spec, warn);
    });

    it('reads a webhooks map on any 3.x document, since the key is unambiguous', async () => {
      const spec = await parseJson({
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: {},
        webhooks: { petAdopted: postWith(petSchema) },
      });

      expect(spec.webhooks!.map((w) => w.name)).toEqual(['petAdopted']);
      expect(spec.models.map((m) => m.name)).toEqual(['PetAdoptedPayload']);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('extractWebhooks', () => {
    it('returns nothing for an absent map, and warns about one that is not an object', () => {
      // `declaredCallbacks` — the `callbacks` maps the webhooks' operations
      // declare, for `extractCallbacks` — joined the result in #382.
      expect(extractWebhooks(undefined)).toEqual({
        webhooks: [],
        inlineModels: [],
        inlineModelBundles: [],
        declaredCallbacks: [],
      });
      expect(warn).not.toHaveBeenCalled();

      expect(extractWebhooks([postWith(petSchema)])).toEqual({
        webhooks: [],
        inlineModels: [],
        inlineModelBundles: [],
        declaredCallbacks: [],
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('`webhooks` is not an object');
    });

    describe('model stems', () => {
      it('hashes both keys when two flatten to one stem, whatever their order', () => {
        const forward = extractWebhooks({ pet_adopted: postWith(petSchema), petAdopted: postWith(petSchema) });
        const backward = extractWebhooks({ petAdopted: postWith(petSchema), pet_adopted: postWith(petSchema) });

        expect(forward.inlineModels.map((m) => m.name)).toMatchInlineSnapshot(`
          [
            "PetAdoptedF79708Payload",
            "PetAdoptedB4A950Payload",
          ]
        `);
        expect(backward.inlineModels.map((m) => m.name).sort()).toEqual(forward.inlineModels.map((m) => m.name).sort());
        expect(forward.webhooks.map((w) => w.requestBody)).toEqual(
          forward.inlineModels.map((m) => ({ kind: 'model', name: m.name })),
        );
      });

      it('hashes a stem when a reserved name is one it would mint, and returns to the plain stem once free', () => {
        const reserved = extractWebhooks({ orderShipped: postWith(petSchema) }, {}, ['OrderShippedPayload']);
        expect(reserved.inlineModels.map((m) => m.name)).toEqual(['OrderShippedA13Ec8Payload']);

        // A reserved name the webhook does not mint is no collision, however it is spelled.
        const free = extractWebhooks({ orderShipped: postWith(petSchema) }, {}, ['OrderShippedPayloadItem']);
        expect(free.inlineModels.map((m) => m.name)).toEqual(['OrderShippedPayload']);
      });

      it('hashes a stem when a reserved name is one of its nested or parameter models', () => {
        const nested = extractWebhooks({ order: postWith({ type: 'object', properties: { item: petSchema } }) }, {}, [
          'OrderPayloadItem',
        ]);
        expect(nested.inlineModels.map((m) => m.name)).toMatchInlineSnapshot(`
          [
            "OrderCce55EPayload",
            "OrderCce55EPayloadItem",
          ]
        `);

        const param = extractWebhooks(
          { order: { post: { parameters: [{ name: 'X-Meta', in: 'header', schema: petSchema }], responses: {} } } },
          {},
          ['OrderXMeta'],
        );
        expect(param.inlineModels.map((m) => m.name)).toMatchInlineSnapshot(`
          [
            "OrderCce55EXMeta",
          ]
        `);
      });

      it('hashes a stem one of its const-prefixed variant names would collide on', () => {
        const union = {
          oneOf: [
            { type: 'object', properties: { kind: { const: 'adopted' }, pet_id: { type: 'string' } } },
            { type: 'object', properties: { kind: { const: 'returned' }, pet_id: { type: 'string' } } },
          ],
          discriminator: { propertyName: 'kind' },
        };
        const { webhooks, inlineModels } = extractWebhooks({ petEvent: postWith(union) }, {}, [
          'ReturnedPetEventPayload',
        ]);

        expect(inlineModels.map((m) => m.name)).toEqual(['PetEvent59656FPayload', 'ReturnedPetEvent59656FPayload']);
        expect(webhooks[0].requestBody).toMatchObject({
          kind: 'union',
          discriminator: { mapping: { adopted: 'PetEvent59656FPayload', returned: 'ReturnedPetEvent59656FPayload' } },
        });
      });

      it('hashes both webhooks when one mints a name the other also mints, const prefixes included', () => {
        // Greptile's case: the `returned` variant of `petEvent` is named
        // `ReturnedPetEventPayload`, which is also the payload name of a
        // webhook keyed `returnedPetEvent`.
        const union = {
          oneOf: [
            { type: 'object', properties: { kind: { const: 'adopted' }, pet_id: { type: 'string' } } },
            { type: 'object', properties: { kind: { const: 'returned' }, pet_id: { type: 'string' } } },
          ],
          discriminator: { propertyName: 'kind' },
        };
        const { webhooks, inlineModels } = extractWebhooks({
          petEvent: postWith(union),
          returnedPetEvent: postWith({ type: 'object', properties: { reason: { type: 'string' } } }),
        });

        expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toMatchInlineSnapshot(`
          [
            [
              "PetEvent59656FPayload",
              [
                "kind",
                "pet_id",
              ],
            ],
            [
              "ReturnedPetEvent59656FPayload",
              [
                "kind",
                "pet_id",
              ],
            ],
            [
              "ReturnedPetEvent978BcdPayload",
              [
                "reason",
              ],
            ],
          ]
        `);
        expect(webhooks.map((w) => w.requestBody)).toMatchInlineSnapshot(`
          [
            {
              "compositionKind": "oneOf",
              "discriminator": {
                "mapping": {
                  "adopted": "PetEvent59656FPayload",
                  "returned": "ReturnedPetEvent59656FPayload",
                },
                "property": "kind",
              },
              "kind": "union",
              "variants": [
                {
                  "kind": "model",
                  "name": "PetEvent59656FPayload",
                },
                {
                  "kind": "model",
                  "name": "ReturnedPetEvent59656FPayload",
                },
              ],
            },
            {
              "kind": "model",
              "name": "ReturnedPetEvent978BcdPayload",
            },
          ]
        `);
      });

      it('does not hash a stem merely because another stem starts with it', () => {
        const { inlineModels } = extractWebhooks({
          petAdopted: postWith({ type: 'object', properties: { pet: petSchema } }),
          petAdoptedPayloadPet: postWith(petSchema),
        });

        expect(inlineModels.map((m) => m.name)).toEqual([
          'PetAdoptedPayload',
          'PetAdoptedPayloadPet',
          'PetAdoptedPayloadPetPayload',
        ]);
      });

      it("names from the operationId when present, cleaned like an operation's own models", () => {
        const { webhooks, inlineModels } = extractWebhooks({
          anything: postWith(petSchema, { operationId: 'adoptions_created[0]' }),
        });

        expect(webhooks[0].operationId).toBe('adoptions_created[0]');
        expect(inlineModels.map((m) => m.name)).toEqual(['AdoptionCreatedPayload']);
      });

      it('does not qualify an operationId-derived stem with the method, since operationIds are unique', () => {
        const { inlineModels } = extractWebhooks({
          petUpdated: {
            post: postWith(petSchema, { operationId: 'petCreated' }).post,
            put: postWith(petSchema, { operationId: 'petChanged' }).post,
            delete: postWith(petSchema).post,
          },
        });

        expect(inlineModels.map((m) => m.name)).toEqual([
          'PetCreatedPayload',
          'PetChangedPayload',
          'PetUpdatedDeletePayload',
        ]);
      });

      it('qualifies inline parameter enums with the stem', () => {
        const { webhooks } = extractWebhooks({
          petAdopted: {
            post: {
              parameters: [{ name: 'X-Source', in: 'header', schema: { type: 'string', enum: ['app', 'web'] } }],
              responses: {},
            },
          },
        });

        expect(webhooks[0].headerParams[0].type).toEqual({
          kind: 'enum',
          name: 'PetAdoptedXSource',
          values: ['app', 'web'],
        });
      });

      it('puts Webhook in front of a stem that would start with a digit or be empty', () => {
        const { inlineModels } = extractWebhooks({ '2fa.enabled': postWith(petSchema), '---': postWith(petSchema) });
        expect(inlineModels.map((m) => m.name)).toEqual(['Webhook2FaEnabledPayload', 'WebhookPayload']);
      });
    });

    describe('path items', () => {
      it('follows a chain of components/pathItems references', () => {
        const { webhooks } = extractWebhooks(
          { petAdopted: { $ref: '#/components/pathItems/A' } },
          {
            pathItems: {
              A: { $ref: '#/components/pathItems/B~1C' },
              'B/C': { post: { operationId: 'adopted', responses: { '200': { description: 'ok' } } } },
            },
          },
        );

        expect(webhooks.map((w) => [w.name, w.operationId])).toEqual([['petAdopted', 'adopted']]);
        expect(warn).not.toHaveBeenCalled();
      });

      it('skips, with a warning each, an entry that is not an object, a ref outside pathItems, a dangling ref, and a cycle', () => {
        const { webhooks } = extractWebhooks(
          {
            notAnObject: 'post',
            elsewhere: { $ref: '#/components/schemas/Pet' },
            dangling: { $ref: '#/components/pathItems/Missing' },
            loop: { $ref: '#/components/pathItems/Loop' },
            kept: postWith(petSchema),
          },
          { pathItems: { Loop: { $ref: '#/components/pathItems/Loop' } } },
        );

        expect(webhooks.map((w) => w.name)).toEqual(['kept']);
        expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toMatchInlineSnapshot(`
          [
            "[oagen] Warning: Webhook "notAnObject" is not a path item object; skipping it.",
            "[oagen] Warning: Unresolved path item $ref "#/components/schemas/Pet" for webhook "elsewhere": no matching entry under components/pathItems. Skipping the webhook.",
            "[oagen] Warning: Unresolved path item $ref "#/components/pathItems/Missing" for webhook "dangling": no matching entry under components/pathItems. Skipping the webhook.",
            "[oagen] Warning: Circular path item $ref chain starting at "#/components/pathItems/Loop" for webhook "loop"; skipping it.",
          ]
        `);
      });

      it('keeps key-derived stems for keys that share a path item without an operationId', () => {
        const { webhooks, inlineModels } = extractWebhooks(
          { a: { $ref: '#/components/pathItems/S' }, b: { $ref: '#/components/pathItems/S' } },
          { pathItems: { S: postWith(petSchema) } },
        );

        expect(webhooks.map((w) => w.requestBody)).toEqual([
          { kind: 'model', name: 'APayload' },
          { kind: 'model', name: 'BPayload' },
        ]);
        expect(inlineModels.map((m) => m.name)).toEqual(['APayload', 'BPayload']);
        expect(warn).not.toHaveBeenCalled();
      });

      it('falls back to key-derived stems, with a warning, when different operations declare one operationId', () => {
        const { webhooks, inlineModels } = extractWebhooks({
          a: postWith(petSchema, { operationId: 'dup' }),
          b: postWith({ type: 'object', properties: { other: { type: 'string' } } }, { operationId: 'dup' }),
        });

        expect(webhooks.map((w) => [w.operationId, w.requestBody])).toEqual([
          ['dup', { kind: 'model', name: 'APayload' }],
          ['dup', { kind: 'model', name: 'BPayload' }],
        ]);
        expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
          ['APayload', ['pet_id']],
          ['BPayload', ['other']],
        ]);
        expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
          '[oagen] Warning: operationId "dup" is declared by more than one webhook operation (webhooks.a.post, webhooks.b.post); naming their models from the webhook keys instead.',
        ]);
      });

      it("carries the operation's externalDocs, and the path item's summary and description where the operation has none (issue #270)", () => {
        const { webhooks } = extractWebhooks({
          petAdopted: {
            summary: 'Pet adopted',
            description: 'Sent when a pet is adopted.',
            post: { externalDocs: { url: 'https://example.com/adopted' }, responses: { '200': { description: 'ok' } } },
            put: { summary: 'Pet re-adopted', responses: { '200': { description: 'ok' } } },
          },
        });
        expect(webhooks.map((w) => [w.httpMethod, w.summary, w.description, w.externalDocs])).toEqual([
          ['post', 'Pet adopted', 'Sent when a pet is adopted.', { url: 'https://example.com/adopted' }],
          ['put', 'Pet re-adopted', 'Sent when a pet is adopted.', undefined],
        ]);
        expect('externalDocs' in webhooks[1]).toBe(false);
        expect(warn).not.toHaveBeenCalled();
      });

      it('drops a whitespace-only tag, as an operation does, and keeps one with no name (issue #412)', () => {
        const { webhooks } = extractWebhooks({
          petAdopted: { post: { tags: [' ', 'Pets', '\t', '-'], responses: {} } },
          petUpdated: { post: { tags: [' '], responses: {} } },
        });
        expect(webhooks[0].tags).toEqual(['Pets', '-']);
        expect(webhooks[1]).not.toHaveProperty('tags');
      });

      it('yields one webhook per method and skips a method that is not an object', () => {
        const { webhooks } = extractWebhooks({
          petUpdated: { post: { responses: {} }, put: null, delete: { responses: {} } },
        });
        expect(webhooks.map((w) => w.httpMethod)).toEqual(['post', 'delete']);
      });

      it('keeps the methods in document order, not HTTP_METHODS order (Greptile)', () => {
        const { webhooks } = extractWebhooks({
          petUpdated: { summary: 'x', put: { responses: {} }, post: { responses: {} } },
        });
        expect(webhooks.map((w) => w.httpMethod)).toEqual(['put', 'post']);
      });

      it('lets an operation-level parameter override a path-item-level one, and drops path parameters', () => {
        const { webhooks } = extractWebhooks({
          petAdopted: {
            parameters: [
              { name: 'X-Signature', in: 'header', schema: { type: 'string' } },
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ],
            post: {
              parameters: [
                { name: 'X-Signature', in: 'header', required: true, schema: { type: 'string' } },
                { name: 'attempt', in: 'query', schema: { type: 'integer' } },
                { name: 'session', in: 'cookie', schema: { type: 'string' } },
              ],
              responses: {},
            },
          },
        });

        const [hook] = webhooks;
        expect(hook.headerParams.map((p) => [p.name, p.required])).toEqual([['X-Signature', true]]);
        expect(hook.queryParams.map((p) => p.name)).toEqual(['attempt']);
        expect(hook.cookieParams!.map((p) => p.name)).toEqual(['session']);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toBe(
          '[oagen] Warning: Parameter "id" (in: path) on webhooks.petAdopted.post ignored: a webhook has no path to place it in.',
        );
      });

      it('materializes inline object and array-of-object parameters under the names they reference', () => {
        const { webhooks, inlineModels } = extractWebhooks({
          petAdopted: {
            post: {
              parameters: [
                { name: 'X-Meta', in: 'header', schema: { type: 'object', properties: { etag: { type: 'string' } } } },
                { name: 'filters', in: 'query', schema: { type: 'array', items: petSchema } },
                { name: 'session', in: 'cookie', schema: { type: 'object', properties: { id: { type: 'string' } } } },
              ],
              responses: {},
            },
          },
        });

        const [hook] = webhooks;
        expect(hook.headerParams[0].type).toEqual({ kind: 'model', name: 'PetAdoptedXMeta' });
        expect(hook.queryParams[0].type).toEqual({ kind: 'array', items: { kind: 'model', name: 'PetAdoptedFilter' } });
        expect(hook.cookieParams![0].type).toEqual({ kind: 'model', name: 'PetAdoptedSession' });
        expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
          ['PetAdoptedXMeta', ['etag']],
          ['PetAdoptedFilter', ['pet_id']],
          ['PetAdoptedSession', ['id']],
        ]);
      });

      it('moves a parameter off a name the payload or an earlier parameter minted, nested names and enums included', () => {
        const { webhooks, inlineModels } = extractWebhooks({
          petAdopted: postWith(
            {
              type: 'object',
              properties: { pet: petSchema, reason: { type: 'string', enum: ['allergy', 'moved'] } },
            },
            {
              parameters: [
                // Would mint the body's nested `PetAdoptedPayloadPet`.
                {
                  name: 'payload_pet',
                  in: 'header',
                  schema: { type: 'object', properties: { id: { type: 'string' } } },
                },
                // Would mint the body's field enum `PetAdoptedPayloadReason`.
                { name: 'payload_reason', in: 'query', schema: { type: 'string', enum: ['moved', 'other'] } },
                // Takes `PetAdoptedQueryPayload` first, in document order ...
                {
                  name: 'query_payload',
                  in: 'query',
                  schema: { type: 'object', properties: { a: { type: 'string' } } },
                },
                // ... so `payload` steps past both `Payload` and `QueryPayload`.
                { name: 'payload', in: 'query', schema: { type: 'object', properties: { b: { type: 'string' } } } },
                // Mints nothing: keeps its own name, whatever is taken.
                { name: 'Payload', in: 'cookie', schema: { type: 'string' } },
              ],
            },
          ),
        });

        const [hook] = webhooks;
        expect(hook.headerParams[0].type).toEqual({ kind: 'model', name: 'PetAdoptedHeaderPayloadPet' });
        expect(hook.queryParams.map((p) => p.type)).toEqual([
          { kind: 'enum', name: 'PetAdoptedQueryPayloadReason', values: ['moved', 'other'] },
          { kind: 'model', name: 'PetAdoptedQueryPayload' },
          { kind: 'model', name: 'PetAdoptedQueryPayload2' },
        ]);
        expect(hook.cookieParams![0].type).toEqual({ kind: 'primitive', type: 'string' });
        expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
          ['PetAdoptedPayload', ['pet', 'reason']],
          ['PetAdoptedPayloadPet', ['pet_id']],
          ['PetAdoptedHeaderPayloadPet', ['id']],
          ['PetAdoptedQueryPayload', ['a']],
          ['PetAdoptedQueryPayload2', ['b']],
        ]);
      });

      it('fails the parse on a parameter or request body ref it cannot resolve, as an operation does', () => {
        expect(() =>
          extractWebhooks({ petAdopted: { post: { parameters: [{ $ref: '#/components/parameters/Nope' }] } } }),
        ).toThrow('Unresolved parameter $ref "#/components/parameters/Nope" in webhooks.petAdopted.post');
        expect(() =>
          extractWebhooks({ petAdopted: { post: { requestBody: { $ref: '#/components/requestBodies/Nope' } } } }),
        ).toThrow('Unresolved request body $ref "#/components/requestBodies/Nope" in webhooks.petAdopted.post');
      });
    });

    describe('payloads', () => {
      it('types a schemaless binary or text body as a primitive, and a body with no usable content as absent', () => {
        const { webhooks } = extractWebhooks({
          binary: { post: { requestBody: { content: { 'application/octet-stream': {} } }, responses: {} } },
          text: { post: { requestBody: { content: { 'text/plain': {} } }, responses: {} } },
          unknown: { post: { requestBody: { content: { 'image/png': {} } }, responses: {} } },
          empty: { post: { requestBody: {}, responses: {} } },
        });

        expect(webhooks.map((w) => [w.requestBody, w.requestBodyEncoding])).toEqual([
          [{ kind: 'primitive', type: 'string', format: 'binary' }, 'binary'],
          [{ kind: 'primitive', type: 'string' }, 'text'],
          [undefined, undefined],
          [undefined, undefined],
        ]);
        expect(Object.keys(webhooks[2])).not.toContain('requestBody');
      });

      it('carries requestBodyRequired only when the document marks the body required', () => {
        const { webhooks } = extractWebhooks({
          required: {
            post: {
              requestBody: { required: true, content: { 'application/json': { schema: petSchema } } },
              responses: {},
            },
          },
          optional: postWith(petSchema),
        });

        expect(webhooks[0].requestBodyRequired).toBe(true);
        expect(Object.keys(webhooks[1])).not.toContain('requestBodyRequired');
      });

      it('promotes a payload that is itself an inline enum, and an array of inline objects', () => {
        const { webhooks, inlineModels } = extractWebhooks({
          status: postWith({ type: 'string', enum: ['up', 'down'] }),
          batch: postWith({ type: 'array', items: petSchema }),
        });

        expect(webhooks[0].requestBody).toEqual({ kind: 'enum', name: 'StatusPayload', values: ['up', 'down'] });
        expect(webhooks[1].requestBody).toEqual({ kind: 'array', items: { kind: 'model', name: 'BatchPayload' } });
        expect(inlineModels.map((m) => m.name)).toEqual(['BatchPayload']);

        const enums: Enum[] = [];
        collectInlineEnumsFromWebhooks(webhooks, enums);
        expect(enums).toEqual([
          {
            name: 'StatusPayload',
            values: [
              { name: 'UP', value: 'up', description: undefined },
              { name: 'DOWN', value: 'down', description: undefined },
            ],
          },
        ]);
      });

      it('follows components/responses references for descriptions, the outermost description winning', () => {
        const { webhooks } = extractWebhooks(
          {
            petAdopted: {
              post: {
                responses: {
                  '200': { $ref: '#/components/responses/Ack' },
                  '202': { $ref: '#/components/responses/Alias' },
                  '204': { $ref: '#/components/responses/Ack', description: 'Sibling wins' },
                  '400': { $ref: '#/components/responses/Loop' },
                  '404': { $ref: '#/components/responses/Missing' },
                  '410': { $ref: '#/components/schemas/Ack' },
                },
              },
            },
          },
          {
            responses: {
              Ack: { description: 'Acknowledged' },
              Alias: { $ref: '#/components/responses/Ack' },
              Loop: { $ref: '#/components/responses/Loop' },
            },
          },
        );

        expect(webhooks[0].responses).toEqual([
          { statusCode: 200, description: 'Acknowledged' },
          { statusCode: 202, description: 'Acknowledged' },
          { statusCode: 204, description: 'Sibling wins' },
          { statusCode: 400 },
          { statusCode: 404 },
          { statusCode: 410 },
        ]);
        expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toMatchInlineSnapshot(`
          [
            "[oagen] Warning: Circular or malformed response $ref for status 400 in webhooks.petAdopted.post; keeping the status code only.",
            "[oagen] Warning: Unresolved response $ref "#/components/responses/Missing" for status 404 in webhooks.petAdopted.post: no matching entry under components/responses. Keeping the status code only.",
            "[oagen] Warning: Unresolved response $ref "#/components/schemas/Ack" for status 410 in webhooks.petAdopted.post: no matching entry under components/responses. Keeping the status code only.",
          ]
        `);
      });

      it('carries only three-digit response codes, each with its description when it has one', () => {
        const { webhooks } = extractWebhooks({
          petAdopted: {
            post: {
              responses: {
                '200': { description: 'ok' },
                '204': { description: '   ' },
                '2XX': { description: 'any success' },
                default: { description: 'retried' },
                '400': { description: 'bad' },
              },
            },
          },
        });

        expect(webhooks[0].responses).toEqual([
          { statusCode: 200, description: 'ok' },
          { statusCode: 204 },
          { statusCode: 400, description: 'bad' },
        ]);
      });

      it('reads a status code only from a three-digit 100–599 key, and warns about any key OpenAPI does not define (issue #275)', () => {
        const { webhooks } = extractWebhooks({
          petAdopted: {
            post: {
              responses: {
                '200': { description: 'ok' },
                '600': { description: 'not a status code' },
                '6XX': { description: 'not a range' },
                '4XXX': { description: 'neither' },
                '20X': { description: 'neither' },
                '099': { description: 'below 100' },
                '200 ': { description: 'a trailing space' },
                error: { description: 'not a key OpenAPI knows' },
                'x-internal': true,
                '2XX': { description: 'any success' },
                default: { description: 'retried' },
              },
            },
          },
        });

        expect(webhooks[0].responses).toEqual([{ statusCode: 200, description: 'ok' }]);
        const ignored = (key: string): string =>
          `[oagen] Warning: Ignoring response key "${key}" on webhooks.petAdopted.post: not a status code (three digits, 100–599), a 1XX–5XX range, or "default"`;
        expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(
          ['600', '6XX', '4XXX', '20X', '099', '200 ', 'error'].map(ignored),
        );
      });
    });
  });

  describe('downstream passes', () => {
    it('collapseJsonSuffixModels rewrites a webhook payload reference to the merged model', () => {
      const models: Model[] = [
        { name: 'Event', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
        {
          name: 'EventJson',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'at', type: { kind: 'primitive', type: 'string' }, required: false },
          ],
        },
      ];
      const hook = webhook({ requestBody: { kind: 'array', items: { kind: 'model', name: 'EventJson' } } });

      const collapsed = collapseJsonSuffixModels(models, [], [hook]);

      expect(collapsed.map((m) => m.name)).toEqual(['Event']);
      expect(hook.requestBody).toEqual({ kind: 'array', items: { kind: 'model', name: 'Event' } });
    });

    it('validateModelRefs reports an unresolved webhook reference with its context', () => {
      const hook = webhook({
        name: 'petAdopted',
        headerParams: [{ name: 'X-Meta', type: { kind: 'model', name: 'MissingMeta' }, required: false }],
        requestBody: { kind: 'nullable', inner: { kind: 'model', name: 'MissingPayload' } },
      });

      validateModelRefs(specWith([], [hook]));

      expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
        '[oagen] Warning: Unresolved model reference "MissingMeta" (context: webhooks.petAdopted.post.X-Meta)',
        '[oagen] Warning: Unresolved model reference "MissingPayload" (context: webhooks.petAdopted.post.requestBody)',
      ]);
    });

    it('collectInlineEnumsFromWebhooks promotes parameter enums once', () => {
      const hook = webhook({
        headerParams: [{ name: 'X-Source', type: { kind: 'enum', name: 'Source', values: ['app'] }, required: false }],
        queryParams: [{ name: 'source', type: { kind: 'enum', name: 'Source', values: ['app'] }, required: false }],
      });
      const enums: Enum[] = [{ name: 'Existing', values: [] }];

      collectInlineEnumsFromWebhooks([hook], enums);

      expect(enums.map((e) => e.name)).toEqual(['Existing', 'Source']);
    });

    it('collectInlineEnumsFromWebhooks renames an enum whose name is taken by different values, shares one with the same', () => {
      const hook = webhook({
        headerParams: [
          { name: 'X-Source', type: { kind: 'enum', name: 'Source', values: ['x', 'y'] }, required: false },
        ],
        queryParams: [{ name: 'kind', type: { kind: 'enum', name: 'Kind', values: ['b', 'a'] }, required: false }],
        requestBody: { kind: 'enum', name: 'Source', values: ['x', 'y'] },
      });
      const enums: Enum[] = [
        { name: 'Source', values: [{ name: 'APP', value: 'app' }] },
        {
          name: 'Kind',
          values: [
            { name: 'A', value: 'a' },
            { name: 'B', value: 'b' },
          ],
        },
      ];

      collectInlineEnumsFromWebhooks([hook], enums);

      // Both refs to the clashing set are renamed to the one distinct name; the
      // identical-valued set (order aside) is shared under the existing name.
      expect(hook.headerParams[0].type).toMatchObject({ kind: 'enum', name: 'Source2' });
      expect(hook.requestBody).toMatchObject({ kind: 'enum', name: 'Source2' });
      expect(hook.queryParams[0].type).toMatchObject({ kind: 'enum', name: 'Kind' });
      expect(enums.map((e) => [e.name, e.values.map((v) => v.value)])).toEqual([
        ['Source', ['app']],
        ['Kind', ['a', 'b']],
        ['Source2', ['x', 'y']],
      ]);
    });
  });
});

/**
 * Covers issue #444: a webhook response written as a `$ref` nothing under
 * `components/responses` answers kept the `description` written beside it,
 * as an operation's does, while the warning said it kept the status code
 * only. The text now follows the document's version — read in a 3.1
 * document, ignored in a 3.0 one, as beside every ref — and the warning says
 * which the status code keeps.
 */
describe('a webhook response whose $ref resolves to nothing (#444)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-webhooks-444-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** The issue's document: `petAdopted` takes `Pet` and answers 200 with a ref into `components/schemas`. */
  async function parseRepro(openapi: string): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'repro.json');
    const doc = {
      openapi,
      info: { title: 'Pets', version: '1' },
      paths: {},
      webhooks: {
        petAdopted: {
          post: {
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
            responses: { '200': { $ref: '#/components/schemas/Pet', description: 'Not adopted yet.' } },
          },
        },
      },
      components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } } },
    };
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  it('keeps the text in an OAS 3.1 document and says so (the issue’s repro)', async () => {
    const { webhooks } = await parseRepro('3.1.0');

    expect(webhooks![0].responses).toEqual([{ statusCode: 200, description: 'Not adopted yet.' }]);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      '[oagen] Warning: Unresolved response $ref "#/components/schemas/Pet" for status 200 in webhooks.petAdopted.post: no matching entry under components/responses. Keeping the status code and the description beside the $ref.',
    ]);
  });

  it('ignores the text in an OAS 3.0 document, keeping the status code only', async () => {
    const { webhooks } = await parseRepro('3.0.3');

    // Used to be `[{ statusCode: 200, description: 'Not adopted yet.' }]`.
    expect(webhooks![0].responses).toEqual([{ statusCode: 200 }]);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      '[oagen] Warning: Unresolved response $ref "#/components/schemas/Pet" for status 200 in webhooks.petAdopted.post: no matching entry under components/responses. Keeping the status code only.',
    ]);
  });

  it('reads a circular chain or a $ref that is not a string by the same rule', () => {
    const webhooks = {
      petAdopted: {
        post: {
          responses: {
            '400': { $ref: '#/components/responses/Loop', description: 'Beside a loop.' },
            '422': { $ref: 42, description: 'Beside a number.' },
          },
        },
      },
    };
    const components = { responses: { Loop: { $ref: '#/components/responses/Loop', description: 'Inner text.' } } };
    const read = (mode: 'override' | 'ignore') =>
      extractWebhooks(webhooks, components, [], [], mode).webhooks[0].responses;

    expect(read('override')).toEqual([
      { statusCode: 400, description: 'Beside a loop.' },
      { statusCode: 422, description: 'Beside a number.' },
    ]);
    expect(read('ignore')).toEqual([{ statusCode: 400 }, { statusCode: 422 }]);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toMatchInlineSnapshot(`
      [
        "[oagen] Warning: Circular or malformed response $ref for status 400 in webhooks.petAdopted.post; keeping the status code and the description beside the $ref.",
        "[oagen] Warning: Circular or malformed response $ref for status 422 in webhooks.petAdopted.post; keeping the status code and the description beside the $ref.",
        "[oagen] Warning: Circular or malformed response $ref for status 400 in webhooks.petAdopted.post; keeping the status code only.",
        "[oagen] Warning: Circular or malformed response $ref for status 422 in webhooks.petAdopted.post; keeping the status code only.",
      ]
    `);
  });
});

/**
 * Covers issue #421: since #350 a `webhooks` key starting with `x-` was
 * stepped over as a specification extension, its payload model with it, so
 * adding or removing one was no change to `oagen diff`. OpenAPI gives the
 * `webhooks` map no extensions, unlike `paths`: every key is a webhook.
 */
describe('#421', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-webhooks-421-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** The issue's webhook entry: a POST whose body is an inline `{ id: string }`. */
  const petEvent = postWith({ type: 'object', properties: { id: { type: 'string' } } });

  /** The issue's document, `old.json` or `new.json`, with the given `webhooks`. */
  async function parseWebhooks(file: string, webhooks: Record<string, unknown>): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, file);
    const doc = { openapi: '3.1.0', info: { title: 'Pets', version: '1' }, paths: {}, webhooks };
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  it('reads `x-pet-returned` as a webhook with its payload model (the issue’s repro)', async () => {
    const spec = await parseWebhooks('new.json', { petAdopted: petEvent, 'x-pet-returned': petEvent });

    expect(spec.webhooks!.map(({ httpMethod, name }) => `${name} ${httpMethod}`)).toEqual([
      'petAdopted post',
      'x-pet-returned post',
    ]);
    expect(spec.models.map(({ name }) => name)).toEqual(['PetAdoptedPayload', 'XPetReturnedPayload']);
    expect(spec.webhooks![1]!.requestBody).toEqual({ kind: 'model', name: 'XPetReturnedPayload' });
    expect(fieldsOf(spec, spec.webhooks![1]!.requestBody)).toEqual(['id']);
    expectResolvedAndReferenced(spec, warn);
  });

  it('reports adding it to `oagen diff` as additive, and removing it as breaking', async () => {
    const oldSpec = await parseWebhooks('old.json', { petAdopted: petEvent });
    const newSpec = await parseWebhooks('new.json', { petAdopted: petEvent, 'x-pet-returned': petEvent });

    expect(diffSpecs(oldSpec, newSpec).changes).toEqual([
      { kind: 'model-added', name: 'XPetReturnedPayload', classification: 'additive' },
      { kind: 'webhook-added', name: 'x-pet-returned', httpMethod: 'post', classification: 'additive' },
    ]);
    expect(diffSpecs(newSpec, oldSpec).changes).toEqual([
      { kind: 'model-removed', name: 'XPetReturnedPayload', classification: 'breaking' },
      { kind: 'webhook-removed', name: 'x-pet-returned', httpMethod: 'post', classification: 'breaking' },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('#565', () => {
  // A webhook's model stem is named through the operation normalizer, so a
  // webhook declaring `operationId: '[1][2]'` got a `Webhook1Payload` from the
  // same one-marker strip; `petAdopted[1][2]` got `PetAdopted1Payload`.
  it('names the payload with every trailing marker stripped, as with one marker', () => {
    for (const operationId of ['petAdopted[1]', 'petAdopted[1][2]', 'petAdopted[2] [3]', 'petAdopted[1] [2] ']) {
      const { webhooks, inlineModels } = extractWebhooks({ anything: postWith(petSchema, { operationId }) });

      expect(webhooks[0].operationId).toBe(operationId);
      expect(inlineModels.map((m) => m.name)).toEqual(['PetAdoptedPayload']);
      expect(webhooks[0].requestBody).toEqual({ kind: 'model', name: 'PetAdoptedPayload' });
    }
  });

  it('names the payload of an operationId of nothing but markers as it names one with one marker', () => {
    const oneMarker = extractWebhooks({ petAdopted: postWith(petSchema, { operationId: '[1]' }) });
    expect(oneMarker.inlineModels.map((m) => m.name)).not.toContain('Webhook1Payload');

    for (const operationId of ['[1][2]', '[1] [2]', '[1][2] ', '[0][1][2]']) {
      const { webhooks, inlineModels } = extractWebhooks({ petAdopted: postWith(petSchema, { operationId }) });

      expect(inlineModels).toEqual(oneMarker.inlineModels);
      expect(webhooks[0].requestBody).toEqual(oneMarker.webhooks[0].requestBody);
    }
  });
});

describe('#564', () => {
  // A webhook's `operationId` that names nothing — no ASCII letter or digit
  // once its trailing overload markers are stripped — still named the stem:
  // `plainStem` cleaned it to nothing and fell back to `Webhook`, so a lone
  // webhook declaring `'-'` got a `WebhookPayload`, two declaring `'-'` and
  // `' '` got the hashed `Webhook3Bc15CPayload` and `B858CbPayload`, two
  // declaring `'-'` were warned about as a duplicate, and `Webhook.operationId`
  // kept the id. An operation's has counted as absent since #547.
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-webhooks-564-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** The issue's webhook: a `POST` whose request body is an inline `{ id: string }`, with `operationId` when given. */
  function post(operationId?: string) {
    return {
      post: {
        ...(operationId !== undefined ? { operationId } : {}),
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
        },
        responses: { '200': { description: 'ok' } },
      },
    };
  }

  async function parseRepro(openapi: string, webhooks: Record<string, unknown>): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'repro.json');
    const doc = { openapi, info: { title: 'Pets', version: '1' }, paths: {}, webhooks };
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  /** Each webhook's key, `operationId` and payload model name, as the issue prints them. */
  function summarize(spec: ApiSpec): string[] {
    return (spec.webhooks ?? []).map(
      ({ name, operationId, requestBody }) =>
        `${name} ${JSON.stringify(operationId)} ${requestBody?.kind === 'model' ? requestBody.name : String(requestBody)}`,
    );
  }

  for (const openapi of ['3.0.3', '3.1.0']) {
    describe(`OpenAPI ${openapi}`, () => {
      it('names the payloads from the keys when the operationIds name nothing, as when none is declared', async () => {
        const none = await parseRepro(openapi, { petAdopted: post(), petReturned: post() });
        const blank = await parseRepro(openapi, { petAdopted: post('-'), petReturned: post(' ') });
        const same = await parseRepro(openapi, { petAdopted: post('-'), petReturned: post('-') });

        expect(summarize(none)).toEqual([
          'petAdopted undefined PetAdoptedPayload',
          'petReturned undefined PetReturnedPayload',
        ]);
        expect(none.models.map((m) => m.name)).toEqual(['PetAdoptedPayload', 'PetReturnedPayload']);
        for (const spec of [blank, same]) {
          expect(summarize(spec)).toEqual(summarize(none));
          expect(spec.models).toEqual(none.models);
          expect(spec.webhooks).toEqual(none.webhooks);
        }
        expect(warn).not.toHaveBeenCalled();
      });

      it('names a lone webhook from its key, with no operationId, whatever names-nothing id it declares', async () => {
        for (const operationId of ['', ' ', '-', '[1]', '[1][2]', '[1] [2] ']) {
          const spec = await parseRepro(openapi, { petAdopted: post(operationId) });
          expect(summarize(spec), JSON.stringify(operationId)).toEqual(['petAdopted undefined PetAdoptedPayload']);
          expect(
            spec.models.map((m) => m.name),
            JSON.stringify(operationId),
          ).toEqual(['PetAdoptedPayload']);
          expect('operationId' in spec.webhooks![0], JSON.stringify(operationId)).toBe(false);
        }
        expect(warn).not.toHaveBeenCalled();
      });

      it('still names the stem from an operationId that names something, its trailing markers stripped', async () => {
        const spec = await parseRepro(openapi, { anything: post('petAdopted[1][2]') });
        expect(summarize(spec)).toEqual(['anything "petAdopted[1][2]" PetAdoptedPayload']);
        expect(warn).not.toHaveBeenCalled();
      });

      it('still warns about an operationId that names something and two operations declare', async () => {
        const spec = await parseRepro(openapi, { petAdopted: post('petEvent'), petReturned: post('petEvent') });
        expect(summarize(spec)).toEqual([
          'petAdopted "petEvent" PetAdoptedPayload',
          'petReturned "petEvent" PetReturnedPayload',
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(
          'operationId "petEvent" is declared by more than one webhook operation (webhooks.petAdopted.post, webhooks.petReturned.post)',
        );
      });
    });
  }

  it('reads a names-nothing operationId as absent in the extractor, so the stem comes from the key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const operationId of [' ', '-', '[1]', '[1][2]']) {
      const { webhooks, inlineModels } = extractWebhooks({ petAdopted: postWith(petSchema, { operationId }) });
      expect('operationId' in webhooks[0], operationId).toBe(false);
      expect(
        inlineModels.map((m) => m.name),
        operationId,
      ).toEqual(['PetAdoptedPayload']);
      expect(webhooks[0].requestBody, operationId).toEqual({ kind: 'model', name: 'PetAdoptedPayload' });
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('#382 guard: webhook naming is unchanged from main', () => {
  // A document without callbacks parses to the IR origin/main (2ec18701)
  // produced, webhook names included: `buildReceivedRequests` settles the
  // stems in the one resolution `resolveWebhookModelStems` always was —
  // reserved-name hits and collisions decided together — and the minting
  // wave the `webhooks` map is cannot move a settled stem. Each signature
  // below — every model and enum name in order, each webhook's method,
  // payload and parameter types, and how many warnings the parse printed —
  // was captured by running main's parser on the same document. The ninth
  // is Greptile's regression on #626: a settle pass that let only a group
  // of the same plain stem move another's hashed `petEvent` alone, for the
  // component, and `returnedPetEvent` lost its hash.
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-webhooks-guard-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const idSchema = { type: 'object', properties: { id: { type: 'string' } } };
  const reason = { type: 'object', properties: { reason: { type: 'string' } } };
  const union = {
    oneOf: [
      { type: 'object', properties: { kind: { const: 'adopted' }, pet_id: { type: 'string' } } },
      { type: 'object', properties: { kind: { const: 'returned' }, pet_id: { type: 'string' } } },
    ],
    discriminator: { propertyName: 'kind' },
  };

  /** A reference's names: a model's or enum's, a union's variants', an array's items'; a primitive's kind and type. */
  function refName(ref: TypeRef | undefined): string {
    if (ref === undefined) return '-';
    switch (ref.kind) {
      case 'model':
      case 'enum':
        return ref.name;
      case 'union':
        return `union(${ref.variants.map(refName).join('|')})`;
      case 'array':
        return `array(${refName(ref.items)})`;
      case 'map':
        return `map(${refName(ref.valueType)})`;
      case 'nullable':
        return `nullable(${refName(ref.inner)})`;
      case 'primitive':
        return `primitive:${ref.type}`;
      default:
        return ref.kind;
    }
  }

  /** What the guard pins of a parse: the names, and what each webhook references. */
  function signature(spec: ApiSpec) {
    return {
      models: spec.models.map((m) => m.name),
      enums: spec.enums.map((e) => e.name),
      webhooks: (spec.webhooks ?? []).map((w) =>
        [
          w.name,
          w.httpMethod,
          refName(w.requestBody),
          ...[...w.headerParams, ...w.queryParams, ...(w.cookieParams ?? [])].map(
            (p) => `${p.name}:${refName(p.type)}`,
          ),
        ].join(' '),
      ),
      warnings: warn.mock.calls.length,
    };
  }

  type Document = {
    webhooks: Record<string, unknown>;
    components?: Record<string, unknown>;
    paths?: Record<string, unknown>;
  };
  type Signature = ReturnType<typeof signature>;

  const cases: Array<[string, Document, Signature]> = [
    [
      'two keys flatten to one stem',
      { webhooks: { pet_adopted: postWith(petSchema), petAdopted: postWith(petSchema) } },
      {
        models: ['PetAdoptedF79708Payload', 'PetAdoptedB4A950Payload'],
        enums: [],
        webhooks: ['pet_adopted post PetAdoptedF79708Payload', 'petAdopted post PetAdoptedB4A950Payload'],
        warnings: 0,
      },
    ],
    [
      'a reserved name the stem would mint',
      { webhooks: { orderShipped: postWith(petSchema) }, components: { schemas: { OrderShippedPayload: idSchema } } },
      {
        models: ['OrderShippedPayload', 'OrderShippedA13Ec8Payload'],
        enums: [],
        webhooks: ['orderShipped post OrderShippedA13Ec8Payload'],
        warnings: 0,
      },
    ],
    [
      'a reserved name the stem would not mint',
      {
        webhooks: { orderShipped: postWith(petSchema) },
        components: { schemas: { OrderShippedPayloadItem: idSchema } },
      },
      {
        models: ['OrderShippedPayloadItem', 'OrderShippedPayload'],
        enums: [],
        webhooks: ['orderShipped post OrderShippedPayload'],
        warnings: 0,
      },
    ],
    [
      'a reserved name of a nested model',
      {
        webhooks: { order: postWith({ type: 'object', properties: { item: petSchema } }) },
        components: { schemas: { OrderPayloadItem: idSchema } },
      },
      {
        models: ['OrderPayloadItem', 'OrderCce55EPayload', 'OrderCce55EPayloadItem'],
        enums: [],
        webhooks: ['order post OrderCce55EPayload'],
        warnings: 0,
      },
    ],
    [
      "a component's nested inline model",
      {
        webhooks: { order: postWith({ type: 'object', properties: { item: petSchema } }) },
        components: {
          schemas: {
            Order: {
              type: 'object',
              properties: { payload_item: { type: 'object', properties: { sku: { type: 'string' } } } },
            },
          },
        },
      },
      {
        models: ['Order', 'OrderPayloadItem', 'OrderCce55EPayload', 'OrderCce55EPayloadItem'],
        enums: [],
        webhooks: ['order post OrderCce55EPayload'],
        warnings: 0,
      },
    ],
    [
      'a reserved name of a parameter model',
      {
        webhooks: {
          order: {
            post: {
              parameters: [{ name: 'X-Meta', in: 'header', schema: petSchema }],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
        components: { schemas: { OrderXMeta: idSchema } },
      },
      {
        models: ['OrderXMeta', 'OrderCce55EXMeta'],
        enums: [],
        webhooks: ['order post - X-Meta:OrderCce55EXMeta'],
        warnings: 0,
      },
    ],
    [
      'a reserved name a const-prefixed variant would collide on',
      { webhooks: { petEvent: postWith(union) }, components: { schemas: { ReturnedPetEventPayload: idSchema } } },
      {
        models: ['ReturnedPetEventPayload', 'PetEvent59656FPayload', 'ReturnedPetEvent59656FPayload'],
        enums: [],
        webhooks: ['petEvent post union(PetEvent59656FPayload|ReturnedPetEvent59656FPayload)'],
        warnings: 0,
      },
    ],
    [
      'two webhooks minting one name, const prefixes included',
      { webhooks: { petEvent: postWith(union), returnedPetEvent: postWith(reason) } },
      {
        models: ['PetEvent59656FPayload', 'ReturnedPetEvent59656FPayload', 'ReturnedPetEvent978BcdPayload'],
        enums: [],
        webhooks: [
          'petEvent post union(PetEvent59656FPayload|ReturnedPetEvent59656FPayload)',
          'returnedPetEvent post ReturnedPetEvent978BcdPayload',
        ],
        warnings: 0,
      },
    ],
    [
      "Greptile's: both minting one name beside a component naming the first's payload",
      {
        webhooks: { petEvent: postWith(union), returnedPetEvent: postWith(reason) },
        components: { schemas: { PetEventPayload: idSchema } },
      },
      {
        models: [
          'PetEventPayload',
          'PetEvent59656FPayload',
          'ReturnedPetEvent59656FPayload',
          'ReturnedPetEvent978BcdPayload',
        ],
        enums: [],
        webhooks: [
          'petEvent post union(PetEvent59656FPayload|ReturnedPetEvent59656FPayload)',
          'returnedPetEvent post ReturnedPetEvent978BcdPayload',
        ],
        warnings: 0,
      },
    ],
    [
      'a stem another stem starts with',
      {
        webhooks: {
          petAdopted: postWith({ type: 'object', properties: { pet: petSchema } }),
          petAdoptedPayloadPet: postWith(petSchema),
        },
      },
      {
        models: ['PetAdoptedPayload', 'PetAdoptedPayloadPet', 'PetAdoptedPayloadPetPayload'],
        enums: [],
        webhooks: ['petAdopted post PetAdoptedPayload', 'petAdoptedPayloadPet post PetAdoptedPayloadPetPayload'],
        warnings: 0,
      },
    ],
    [
      "a component's map-of-objects field model",
      {
        webhooks: { event: postWith(petSchema) },
        components: {
          schemas: {
            Event: { type: 'object', properties: { payload: { type: 'object', additionalProperties: idSchema } } },
          },
        },
      },
      {
        models: ['Event', 'Event5006EdPayload', 'EventPayload'],
        enums: [],
        webhooks: ['event post Event5006EdPayload'],
        warnings: 0,
      },
    ],
    [
      'a component enum named like a parameter enum',
      {
        webhooks: {
          petAdopted: {
            post: {
              parameters: [{ name: 'X-Source', in: 'header', schema: { type: 'string', enum: ['app', 'web'] } }],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
        components: { schemas: { PetAdoptedXSource: { type: 'string', enum: ['legacy'] } } },
      },
      {
        models: [],
        enums: ['PetAdoptedXSource', 'PetAdoptedB4A950XSource'],
        webhooks: ['petAdopted post - X-Source:PetAdoptedB4A950XSource'],
        warnings: 0,
      },
    ],
    [
      'parameters named like the payload and like each other',
      {
        webhooks: {
          petAdopted: postWith(petSchema, {
            parameters: [
              { name: 'payload', in: 'query', schema: idSchema },
              { name: 'X-Meta', in: 'header', schema: { type: 'object', properties: { etag: { type: 'string' } } } },
              { name: 'x_meta', in: 'query', schema: { type: 'object', properties: { trace: { type: 'string' } } } },
            ],
          }),
        },
      },
      {
        models: ['PetAdoptedPayload', 'PetAdoptedQueryPayload', 'PetAdoptedXMeta', 'PetAdoptedQueryXMeta'],
        enums: [],
        webhooks: [
          'petAdopted post PetAdoptedPayload X-Meta:PetAdoptedXMeta payload:PetAdoptedQueryPayload x_meta:PetAdoptedQueryXMeta',
        ],
        warnings: 0,
      },
    ],
    [
      'two keys referencing one path item with an operationId',
      {
        webhooks: {
          a: { $ref: '#/components/pathItems/S' },
          other: postWith(reason),
          b: { $ref: '#/components/pathItems/S' },
        },
        components: {
          pathItems: {
            S: postWith(petSchema, {
              operationId: 'shared',
              parameters: [{ name: 'X-Sig', in: 'header', required: true, schema: { type: 'string' } }],
            }),
          },
        },
      },
      {
        models: ['SharedPayload', 'OtherPayload'],
        enums: [],
        webhooks: [
          'a post SharedPayload X-Sig:primitive:string',
          'other post OtherPayload',
          'b post SharedPayload X-Sig:primitive:string',
        ],
        warnings: 0,
      },
    ],
    [
      'a stem named from an operationId with trailing markers',
      { webhooks: { anything: postWith(idSchema, { operationId: 'petAdopted[1][2]' }) } },
      { models: ['PetAdoptedPayload'], enums: [], webhooks: ['anything post PetAdoptedPayload'], warnings: 0 },
    ],
    [
      'one operationId two webhook operations declare',
      {
        webhooks: {
          petAdopted: postWith(idSchema, { operationId: 'petEvent' }),
          petReturned: postWith(idSchema, { operationId: 'petEvent' }),
        },
      },
      {
        models: ['PetAdoptedPayload', 'PetReturnedPayload'],
        enums: [],
        webhooks: ['petAdopted post PetAdoptedPayload', 'petReturned post PetReturnedPayload'],
        warnings: 1,
      },
    ],
    [
      'operationIds that name nothing',
      {
        webhooks: {
          petAdopted: postWith(idSchema, { operationId: '-' }),
          petReturned: postWith(idSchema, { operationId: ' ' }),
        },
      },
      {
        models: ['PetAdoptedPayload', 'PetReturnedPayload'],
        enums: [],
        webhooks: ['petAdopted post PetAdoptedPayload', 'petReturned post PetReturnedPayload'],
        warnings: 0,
      },
    ],
    [
      'one key declaring several methods',
      {
        webhooks: {
          petEvent: {
            ...postWith(petSchema),
            put: {
              requestBody: { content: { 'application/json': { schema: reason } } },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
      {
        models: ['PetEventPostPayload', 'PetEventPutPayload'],
        enums: [],
        webhooks: ['petEvent post PetEventPostPayload', 'petEvent put PetEventPutPayload'],
        warnings: 0,
      },
    ],
    [
      'a stem that would start with a digit',
      { webhooks: { '2fa_enabled': postWith(petSchema) } },
      {
        models: ['Webhook2FaEnabledPayload'],
        enums: [],
        webhooks: ['2fa_enabled post Webhook2FaEnabledPayload'],
        warnings: 0,
      },
    ],
    [
      'an inline enum payload and an array of inline objects',
      {
        webhooks: {
          status: postWith({ type: 'string', enum: ['on', 'off'] }),
          batch: postWith({ type: 'array', items: petSchema }),
        },
      },
      {
        models: ['BatchPayload'],
        enums: ['StatusPayload'],
        webhooks: ['status post StatusPayload', 'batch post array(BatchPayload)'],
        warnings: 0,
      },
    ],
    [
      "webhook stems beside an operation's inline models",
      {
        paths: {
          '/pets': {
            post: {
              operationId: 'petAdopted',
              requestBody: {
                content: { 'application/json': { schema: { type: 'object', properties: { payload: idSchema } } } },
              },
              responses: {
                '200': {
                  description: 'ok',
                  content: { 'application/json': { schema: { type: 'object', properties: { payload: petSchema } } } },
                },
              },
            },
          },
        },
        webhooks: { petAdopted: postWith(petSchema), petAdoptedRequest: postWith(reason) },
      },
      {
        models: [
          'PetAdoptedResponse',
          'PetAdoptedResponsePayload',
          'PetAdoptedRequest',
          'PetAdoptedRequestPayload',
          'PetAdoptedPayload',
          'PetAdoptedRequestF06F0FPayload',
        ],
        enums: [],
        webhooks: ['petAdopted post PetAdoptedPayload', 'petAdoptedRequest post PetAdoptedRequestF06F0FPayload'],
        warnings: 0,
      },
    ],
  ];

  async function parseDocument(openapi: string, { webhooks, components, paths }: Document): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'guard.json');
    const doc = {
      openapi,
      info: { title: 't', version: '1' },
      paths: paths ?? {},
      webhooks,
      ...(components ? { components } : {}),
    };
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  for (const openapi of ['3.0.3', '3.1.0']) {
    describe(`OpenAPI ${openapi}`, () => {
      it.each(cases)('names %s as main does', async (_name, document, expected) => {
        expect(signature(await parseDocument(openapi, document))).toEqual(expected);
      });

      it("keeps both stems hashed in Greptile's document, the component's fields its own", async () => {
        const spec = await parseDocument(openapi, {
          webhooks: { petEvent: postWith(union), returnedPetEvent: postWith(reason) },
          components: { schemas: { PetEventPayload: idSchema } },
        });
        expect(spec.models.map((m) => m.name)).toEqual([
          'PetEventPayload',
          'PetEvent59656FPayload',
          'ReturnedPetEvent59656FPayload',
          'ReturnedPetEvent978BcdPayload',
        ]);
        expect(fieldsOf(spec, { name: 'PetEventPayload' })).toEqual(['id']);
        expect(spec.webhooks![1].requestBody).toEqual({ kind: 'model', name: 'ReturnedPetEvent978BcdPayload' });
        expect(fieldsOf(spec, spec.webhooks![1].requestBody)).toEqual(['reason']);
        // The component is unreferenced here, so only the references are checked.
        validateModelRefs(spec);
        expect(warn).not.toHaveBeenCalled();
      });
    });
  }

  it('names the webhooks fixture as main does', async () => {
    const spec = await parseSpec(`${FIXTURES}/webhooks.yml`);
    expect(spec.models.map((m) => m.name)).toEqual([
      'AdoptionEvent',
      'PetReturnedPayload',
      'PetReturnedPayloadPet',
      'ShelterClosedXMeta',
      'PetEventPayload',
      'ReturnedPetEventPayload',
      'PetUpdatedPostPayload',
      'PetUpdatedPutPayload',
    ]);
    expect(spec.enums.map((e) => e.name)).toEqual(['PetReturnedPayloadReason', 'PetReturnedXEventType']);
    expect(spec.webhooks!.map((w) => `${w.name} ${w.httpMethod} ${refName(w.requestBody)}`)).toEqual([
      'petAdopted post AdoptionEvent',
      'pet.returned post PetReturnedPayload',
      'shelterClosed post -',
      'petEvent post union(PetEventPayload|ReturnedPetEventPayload)',
      'petUpdated post PetUpdatedPostPayload',
      'petUpdated put PetUpdatedPutPayload',
    ]);
  });
});
