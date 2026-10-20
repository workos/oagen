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
import { assignModelsToServices, collectModelRefs, collectWebhookTypeRefs } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Enum, Model, Webhook } from '../../src/ir/types.js';

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
          "description": "Pet returned

        Sent when an adopted pet is returned to the shelter.",
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
      expect(extractWebhooks(undefined)).toEqual({ webhooks: [], inlineModels: [] });
      expect(warn).not.toHaveBeenCalled();

      expect(extractWebhooks([postWith(petSchema)])).toEqual({ webhooks: [], inlineModels: [] });
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
