import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffCommand } from '../../src/cli/diff.js';
import { CommandError } from '../../src/errors.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { assignModelsToServices } from '../../src/ir/types.js';
import type { ApiSpec, Callback, TypeRef, Webhook } from '../../src/ir/types.js';

/**
 * Issue #631: a `webhooks` entry and a callback that reach one path item
 * minted two payload models — the webhooks were named first and the
 * callback's models stepped around the names the webhook took — so with an
 * `operationId` the callback's payload was a hashed copy of the webhook's
 * (`OnPetAdoptedF9960APayload` beside `OnPetAdoptedPayload`), and adding the
 * webhook to a document whose callback already read the path item renamed
 * the callback's payload. A callback that reads the operation object of a
 * webhook's minting under the stem that minting took now shares it.
 */

type Document = Record<string, unknown>;

const EXPRESSION = '{$request.body#/callbackUrl}';
const COMPONENT = '#/components/pathItems/PetAdopted';
const info = { title: 'repro', version: '1' };
const json = (schema: unknown) => ({ 'application/json': { schema } });
const petId = { type: 'object', required: ['petId'], properties: { petId: { type: 'string' } } };
const flag = (name: string) => ({ type: 'object', properties: { [name]: { type: 'boolean' } } });

/** A received operation: a required JSON body of `schema` answered with a bare 204, with `extra` on the operation. */
function receiving(extra: Record<string, unknown> = {}, schema: unknown = petId) {
  return {
    ...extra,
    requestBody: { required: true, content: json(schema) },
    responses: { '204': { description: 'No content' } },
  };
}

/** A path item whose `post` is `receiving(extra, schema)`. */
function posting(extra: Record<string, unknown> = {}, schema: unknown = petId) {
  return { post: receiving(extra, schema) };
}

/** A path item whose `post` takes `{ callbackUrl }`, answers 201 and declares `callbacks`. */
function registering(operationId: string | undefined, callbacks: Record<string, unknown>) {
  return {
    post: {
      ...(operationId ? { operationId } : {}),
      requestBody: { content: json({ type: 'object', properties: { callbackUrl: { type: 'string' } } }) },
      responses: { '201': { description: 'Created' } },
      callbacks,
    },
  };
}

/** A Callback Object whose one expression is a `$ref` to `ref`. */
const under = (ref: string) => ({ [EXPRESSION]: { $ref: ref } });

/** The issue's `components.pathItems.PetAdopted`: a `post` taking `{ petId: string }` (required) and answering 204. */
const petAdoptedItem = (operationId: boolean) => posting(operationId ? { operationId: 'onPetAdopted' } : {});

/** The issue's `POST /pets` (`createPet`), declaring the callback `petAdopted` as a `$ref` to `ref`. */
const createPet = (ref: string = COMPONENT) => ({ '/pets': registering('createPet', { petAdopted: under(ref) }) });

/** The issue's `old.json`: the callback reads the component path item, and no webhook does. */
function oldDocument(openapi: string, operationId = true): Document {
  return { openapi, info, paths: createPet(), components: { pathItems: { PetAdopted: petAdoptedItem(operationId) } } };
}

/** The issue's `new.json`: `old.json` plus `webhooks.petAdopted` as a `$ref` to the same path item. */
function newDocument(openapi: string, operationId = true): Document {
  return { ...oldDocument(openapi, operationId), webhooks: { petAdopted: { $ref: COMPONENT } } };
}

/** A type reference as one word: a model's or enum's name, a union's variants, a primitive's type. */
function typeName(ref: TypeRef | undefined): string {
  if (!ref) return '-';
  switch (ref.kind) {
    case 'model':
    case 'enum':
      return ref.name;
    case 'union':
      return ref.variants.map(typeName).join(' | ');
    case 'array':
      return `${typeName(ref.items)}[]`;
    case 'nullable':
      return `${typeName(ref.inner)}?`;
    case 'primitive':
      return ref.type;
    default:
      return ref.kind;
  }
}

/** What a webhook or callback references, nested callbacks included. */
function site(node: Webhook | Callback): Record<string, unknown> {
  const params = [...node.headerParams, ...node.queryParams, ...(node.cookieParams ?? [])];
  const contents = (node.requestBodyContents ?? []).filter(({ type }) => type !== node.requestBody);
  return {
    site: ['expression' in node ? `${node.name} ${node.expression}` : node.name, node.httpMethod].join(' '),
    payload: typeName(node.requestBody),
    ...(params.length > 0 ? { params: params.map((param) => `${param.name}: ${typeName(param.type)}`) } : {}),
    ...(contents.length > 0
      ? { contents: contents.map(({ contentType, type }) => `${contentType}: ${typeName(type)}`) }
      : {}),
    ...(node.callbacks ? { callbacks: node.callbacks.map(site) } : {}),
  };
}

/** Every model with its fields, every enum, and what each webhook and each operation's callbacks reference. */
function summary(spec: ApiSpec) {
  return {
    models: spec.models.map(({ name, fields }) => `${name} { ${fields.map((field) => field.name).join(', ')} }`),
    enums: spec.enums.map(({ name, values }) => `${name}: ${values.map(({ value }) => value).join(' | ')}`),
    webhooks: (spec.webhooks ?? []).map(site),
    callbacks: spec.services.flatMap(({ operations }) =>
      operations.flatMap((operation) => (operation.callbacks ?? []).map(site)),
    ),
  };
}

/** Every callback of every operation, in document order. */
function callbacksOf(spec: ApiSpec): Callback[] {
  return spec.services.flatMap(({ operations }) => operations.flatMap((operation) => operation.callbacks ?? []));
}

describe('#631 a callback and a webhook reaching one operation object share one minting', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let files = 0;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-callback-webhook-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    log.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function write(doc: Document | string): Promise<string> {
    const yaml = typeof doc === 'string';
    const file = path.join(tmpDir, `spec-${files++}.${yaml ? 'yaml' : 'json'}`);
    await fs.writeFile(file, yaml ? doc : JSON.stringify(doc), 'utf-8');
    return file;
  }

  /** Parse a document, validating that every reference names a model or enum the IR declares. */
  async function parse(doc: Document | string): Promise<ApiSpec> {
    const spec = await parseSpec(await write(doc));
    validateModelRefs(spec);
    return spec;
  }

  /** `oagen diff --old <before> --new <after>`: its exit code and each change as `kind name (classification)`. */
  async function diff(before: Document, after: Document): Promise<{ exit: number; changes: string[] }> {
    const [oldFile, newFile] = [await write(before), await write(after)];
    log.mockClear();
    const error = await diffCommand({ old: oldFile, new: newFile }).catch((thrown: unknown) => thrown);
    if (!(error instanceof CommandError)) throw error;
    const report = JSON.parse(String(log.mock.calls.at(-1)![0])) as {
      changes: Array<{ kind: string; name?: string; classification: string }>;
    };
    return {
      exit: error.exitCode,
      changes: report.changes.map(({ kind, name, classification }) => `${kind} ${name} (${classification})`),
    };
  }

  describe.each(['3.0.3', '3.1.0'])('OpenAPI %s', (openapi) => {
    /** The issue's script: the callback's payload, every model with its fields, the webhook's payload. */
    function issueOutput({ models, services, webhooks = [] }: ApiSpec) {
      const [operation] = services.flatMap(({ operations }) => operations);
      return {
        callback: (operation?.callbacks ?? []).map(({ requestBody }) => typeName(requestBody)),
        models: models.map(({ fields, name }) => `${name} { ${fields.map((field) => field.name).join(', ')} }`),
        webhook: webhooks.map(({ requestBody }) => typeName(requestBody)),
      };
    }

    it("the issue's repro: the webhook and the callback reference one OnPetAdoptedPayload", async () => {
      expect(issueOutput(await parse(oldDocument(openapi)))).toEqual({
        callback: ['OnPetAdoptedPayload'],
        models: ['CreatePetRequest { callbackUrl }', 'OnPetAdoptedPayload { petId }'],
        webhook: [],
      });
      expect(issueOutput(await parse(newDocument(openapi)))).toEqual({
        callback: ['OnPetAdoptedPayload'],
        models: ['CreatePetRequest { callbackUrl }', 'OnPetAdoptedPayload { petId }'],
        webhook: ['OnPetAdoptedPayload'],
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("the issue's diff: adding the webhook is additive, exit 1", async () => {
      expect(await diff(oldDocument(openapi), newDocument(openapi))).toEqual({
        exit: 1,
        changes: ['webhook-added petAdopted (additive)'],
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('adding the callback to a document whose webhook already reads the path item is additive too', async () => {
      const webhookOnly = { ...newDocument(openapi), paths: {} };
      expect(await diff(webhookOnly, newDocument(openapi))).toEqual({
        exit: 1,
        changes: ['model-added CreatePetRequest (additive)', 'service-added Pets (additive)'],
      });
    });

    it.each([
      ['a `$ref` to the component path item', { petAdopted: { $ref: COMPONENT } }, true],
      ['the path item itself, inline', { petAdopted: petAdoptedItem(true) }, false],
    ])('a callback `$ref`ing `#/webhooks/petAdopted` shares it too: the webhook is %s', async (_, webhooks, shared) => {
      const after: Document = {
        openapi,
        info,
        paths: createPet('#/webhooks/petAdopted'),
        webhooks,
        ...(shared ? { components: { pathItems: { PetAdopted: petAdoptedItem(true) } } } : {}),
      };
      expect(issueOutput(await parse(after))).toEqual({
        callback: ['OnPetAdoptedPayload'],
        models: ['CreatePetRequest { callbackUrl }', 'OnPetAdoptedPayload { petId }'],
        webhook: ['OnPetAdoptedPayload'],
      });
      expect(await diff(oldDocument(openapi), after)).toEqual({
        exit: 1,
        changes: ['webhook-added petAdopted (additive)'],
      });
    });

    it('without an operationId each site keeps its own stem, and adding either is additive', async () => {
      const before = oldDocument(openapi, false);
      const after = newDocument(openapi, false);
      expect(issueOutput(await parse(before))).toEqual({
        callback: ['CreatePetPetAdoptedPayload'],
        models: ['CreatePetRequest { callbackUrl }', 'CreatePetPetAdoptedPayload { petId }'],
        webhook: [],
      });
      expect(issueOutput(await parse(after))).toEqual({
        callback: ['CreatePetPetAdoptedPayload'],
        models: [
          'CreatePetRequest { callbackUrl }',
          'PetAdoptedPayload { petId }',
          'CreatePetPetAdoptedPayload { petId }',
        ],
        webhook: ['PetAdoptedPayload'],
      });
      expect(await diff(before, after)).toEqual({
        exit: 1,
        changes: ['model-added PetAdoptedPayload (additive)', 'webhook-added petAdopted (additive)'],
      });
      expect(await diff({ ...after, paths: {} }, after)).toEqual({
        exit: 1,
        changes: [
          'model-added CreatePetRequest (additive)',
          'model-added CreatePetPetAdoptedPayload (additive)',
          'service-added Pets (additive)',
        ],
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('the outcome does not depend on where the document declares the webhook, the path or the component', async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const webhooks = { petAdopted: { $ref: COMPONENT } };
      const paths = createPet();
      const expected = await parse({ openapi, info, paths, webhooks, components });
      for (const reordered of [
        { openapi, info, webhooks, paths, components },
        { openapi, info, components, webhooks, paths },
        { openapi, info, components, paths, webhooks },
      ]) {
        expect(await parse(reordered)).toEqual(expected);
      }
    });

    it('two callbacks and one webhook reference the one model, whichever owner is declared first', async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const pets = registering('createPet', { petAdopted: under(COMPONENT) });
      const dogs = registering('createDog', { dogAdopted: under(COMPONENT) });
      const webhooks = { petAdopted: { $ref: COMPONENT } };
      const before = { openapi, info, paths: { '/pets': pets, '/dogs': dogs }, components };
      const after = { ...before, webhooks };
      const reversed = { openapi, info, webhooks, paths: { '/dogs': dogs, '/pets': pets }, components };

      const spec = await parse(after);
      expect(summary(spec)).toEqual({
        models: [
          'CreatePetRequest { callbackUrl }',
          'CreateDogRequest { callbackUrl }',
          'OnPetAdoptedPayload { petId }',
        ],
        enums: [],
        webhooks: [{ site: 'petAdopted post', payload: 'OnPetAdoptedPayload' }],
        callbacks: [
          { site: `petAdopted ${EXPRESSION} post`, payload: 'OnPetAdoptedPayload' },
          { site: `dogAdopted ${EXPRESSION} post`, payload: 'OnPetAdoptedPayload' },
        ],
      });
      expect(await diff(before, after)).toEqual({ exit: 1, changes: ['webhook-added petAdopted (additive)'] });
      expect(await diff(after, reversed)).toEqual({ exit: 0, changes: [] });
      const names = (parsed: ApiSpec) => parsed.models.map(({ name }) => name).sort();
      expect(names(await parse(reversed))).toEqual(names(spec));
    });

    it('two `webhooks` keys and a callback reference the one model, whichever key is declared first', async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const keys = { petAdopted: { $ref: COMPONENT }, petRehomed: { $ref: '#/webhooks/petAdopted' } };
      const after = { openapi, info, paths: createPet(), webhooks: keys, components };
      const reversed = {
        ...after,
        webhooks: { petRehomed: { $ref: COMPONENT }, petAdopted: { $ref: '#/webhooks/petRehomed' } },
      };
      const expected = {
        models: ['CreatePetRequest { callbackUrl }', 'OnPetAdoptedPayload { petId }'],
        enums: [],
        callbacks: [{ site: `petAdopted ${EXPRESSION} post`, payload: 'OnPetAdoptedPayload' }],
      };
      expect(summary(await parse(after))).toEqual({
        ...expected,
        webhooks: [
          { site: 'petAdopted post', payload: 'OnPetAdoptedPayload' },
          { site: 'petRehomed post', payload: 'OnPetAdoptedPayload' },
        ],
      });
      expect(summary(await parse(reversed))).toEqual({
        ...expected,
        webhooks: [
          { site: 'petRehomed post', payload: 'OnPetAdoptedPayload' },
          { site: 'petAdopted post', payload: 'OnPetAdoptedPayload' },
        ],
      });
      expect(await diff(oldDocument(openapi), after)).toEqual({
        exit: 1,
        changes: ['webhook-added petAdopted (additive)', 'webhook-added petRehomed (additive)'],
      });
      expect(await diff(after, reversed)).toEqual({ exit: 0, changes: [] });
    });

    it('a `paths` entry a webhook and a callback both `$ref` is one minting, beside the operation it also is', async () => {
      const hooks = { '/hooks': petAdoptedItem(true) };
      const before = { openapi, info, paths: { ...hooks, ...createPet('#/paths/~1hooks') } };
      const after = { ...before, webhooks: { petAdopted: { $ref: '#/paths/~1hooks' } } };
      expect(summary(await parse(after))).toEqual({
        models: ['OnPetAdoptedRequest { petId }', 'CreatePetRequest { callbackUrl }', 'OnPetAdoptedPayload { petId }'],
        enums: [],
        webhooks: [{ site: 'petAdopted post', payload: 'OnPetAdoptedPayload' }],
        callbacks: [{ site: `petAdopted ${EXPRESSION} post`, payload: 'OnPetAdoptedPayload' }],
      });
      expect(await diff(before, after)).toEqual({ exit: 1, changes: ['webhook-added petAdopted (additive)'] });
    });
  });

  describe('everything the operation mints is minted once', () => {
    const openapi = '3.1.0';
    const payload = {
      type: 'object',
      required: ['petId'],
      properties: {
        petId: { type: 'string' },
        status: { type: 'string', enum: ['adopted', 'returned'] },
        owner: { type: 'object', properties: { name: { type: 'string' } } },
        detail: {
          oneOf: [
            { type: 'object', properties: { kind: { type: 'string', const: 'cat' }, lives: { type: 'integer' } } },
            { type: 'object', properties: { kind: { type: 'string', const: 'dog' }, tricks: { type: 'integer' } } },
          ],
          discriminator: { propertyName: 'kind' },
        },
      },
    };
    const operation = {
      operationId: 'onPetAdopted',
      summary: 'A pet was adopted',
      tags: ['adoptions'],
      parameters: [
        { name: 'X-Meta', in: 'header', schema: { type: 'object', properties: { trace: { type: 'string' } } } },
        { name: 'mode', in: 'query', schema: { type: 'string', enum: ['live', 'test'] } },
        { name: 'session', in: 'cookie', schema: { type: 'object', properties: { id: { type: 'string' } } } },
      ],
      requestBody: {
        required: true,
        description: 'The adoption',
        content: {
          ...json(payload),
          'text/csv': { schema: { type: 'object', properties: { row: { type: 'string' } } } },
        },
      },
      responses: { '204': { description: 'No content' }, '410': { description: 'Gone' } },
    };
    const components = {
      pathItems: {
        PetAdopted: {
          parameters: [{ name: 'X-Delivery', in: 'header', schema: { type: 'string' } }],
          post: operation,
        },
      },
    };
    const before: Document = { openapi, info, paths: createPet(), components };
    const after: Document = { ...before, webhooks: { petAdopted: { $ref: COMPONENT } } };

    it('the payload, its nested models and enums, the parameter models and the secondary media type', async () => {
      const spec = await parse(after);
      expect(summary(spec)).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "contents": [
                "text/csv: OnPetAdoptedTextCsvPayload",
              ],
              "params": [
                "X-Delivery: string",
                "X-Meta: OnPetAdoptedXMeta",
                "mode: OnPetAdoptedMode",
                "session: OnPetAdoptedSession",
              ],
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [
            "OnPetAdoptedPayloadStatus: adopted | returned",
            "OnPetAdoptedMode: live | test",
          ],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "OnPetAdoptedPayload { petId, status, owner, detail }",
            "OnPetAdoptedPayloadOwner { name }",
            "OnPetAdoptedPayloadDetail { kind, lives }",
            "DogOnPetAdoptedPayloadDetail { kind, tricks }",
            "OnPetAdoptedTextCsvPayload { row }",
            "OnPetAdoptedXMeta { trace }",
            "OnPetAdoptedSession { id }",
          ],
          "webhooks": [
            {
              "contents": [
                "text/csv: OnPetAdoptedTextCsvPayload",
              ],
              "params": [
                "X-Delivery: string",
                "X-Meta: OnPetAdoptedXMeta",
                "mode: OnPetAdoptedMode",
                "session: OnPetAdoptedSession",
              ],
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      // Exactly the models and enums the callback alone mints, under the same names.
      const alone = await parse(before);
      expect(summary(spec).models).toEqual(summary(alone).models);
      expect(summary(spec).enums).toEqual(summary(alone).enums);
      expect(summary(spec).callbacks).toEqual(summary(alone).callbacks);
      expect(await diff(before, after)).toEqual({ exit: 1, changes: ['webhook-added petAdopted (additive)'] });
      expect(warn).not.toHaveBeenCalled();
    });

    it('the callback is the webhook under its own key and expression, on IR nodes of its own', async () => {
      const spec = await parse(after);
      const [webhook] = spec.webhooks!;
      const [callback] = callbacksOf(spec);
      const { name, expression, ...rest } = callback!;
      expect({ name, expression }).toEqual({ name: 'petAdopted', expression: EXPRESSION });
      // Parameters, payload, content entries, responses, docs, tags: all the webhook's.
      const { name: key, ...webhookRest } = webhook!;
      expect(key).toBe('petAdopted');
      expect(rest).toEqual(webhookRest);
      expect(rest.responses).toEqual([
        { statusCode: 204, description: 'No content' },
        { statusCode: 410, description: 'Gone' },
      ]);
      // No two nodes share a reference object: a pass that rewrites one in place never rewrites the other.
      expect(callback!.requestBody).not.toBe(webhook!.requestBody);
      expect(callback!.headerParams[0]!.type).not.toBe(webhook!.headerParams[0]!.type);
      expect(callback!.requestBodyContents![1]!.type).not.toBe(webhook!.requestBodyContents![1]!.type);
      // A content entry that is the payload stays the payload's own reference on each node.
      expect(callback!.requestBodyContents![0]!.type).toBe(callback!.requestBody);
    });

    it("the shared models belong to the callback's service, as any model an operation's callback references", async () => {
      const spec = await parse(after);
      const assigned = assignModelsToServices(spec.models, spec.services);
      expect(Object.fromEntries(assigned)).toMatchInlineSnapshot(`
        {
          "CreatePetRequest": "Pets",
          "DogOnPetAdoptedPayloadDetail": "Pets",
          "OnPetAdoptedPayload": "Pets",
          "OnPetAdoptedPayloadDetail": "Pets",
          "OnPetAdoptedPayloadOwner": "Pets",
          "OnPetAdoptedSession": "Pets",
          "OnPetAdoptedTextCsvPayload": "Pets",
          "OnPetAdoptedXMeta": "Pets",
        }
      `);
    });

    it('a rename a merge pass makes reaches the callback as it reaches the webhook', async () => {
      // A payload variant titled like a component of another shape is renamed
      // under the stem by the model merge; every node sharing the minting follows.
      const titled = (title: string, value: string, fields: Record<string, unknown>) => ({
        title,
        type: 'object',
        properties: { kind: { type: 'string', const: value }, ...fields },
      });
      const union = {
        oneOf: [titled('Shape', 'shape', { sides: { type: 'integer' } }), titled('Note', 'note', { text: {} })],
      };
      const doc: Document = {
        openapi,
        info,
        paths: {
          ...createPet(),
          '/dogs': registering('createDog', { dogAdopted: under(COMPONENT) }),
          '/shapes': {
            get: {
              operationId: 'getShape',
              responses: { '200': { description: 'OK', content: json({ $ref: '#/components/schemas/Shape' }) } },
            },
          },
        },
        webhooks: { petAdopted: { $ref: COMPONENT }, petRehomed: { $ref: COMPONENT } },
        components: {
          schemas: { Shape: { type: 'object', properties: { radius: { type: 'number' } } } },
          pathItems: { PetAdopted: posting({ operationId: 'onPetAdopted' }, union) },
        },
      };
      expect(summary(await parse(doc))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "OnPetAdoptedShape | Note",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
            {
              "payload": "OnPetAdoptedShape | Note",
              "site": "dogAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "Shape { radius }",
            "CreatePetRequest { callbackUrl }",
            "CreateDogRequest { callbackUrl }",
            "OnPetAdoptedShape { kind, sides }",
            "Note { kind, text }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdoptedShape | Note",
              "site": "petAdopted post",
            },
            {
              "payload": "OnPetAdoptedShape | Note",
              "site": "petRehomed post",
            },
          ],
        }
      `);
    });
  });

  describe('the stem the minting took', () => {
    const openapi = '3.1.0';

    it('a stem a component hashes is hashed once: the callback references the name it had before the webhook', async () => {
      const components = {
        schemas: { OnPetAdoptedPayload: { type: 'object', properties: { other: { type: 'string' } } } },
        pathItems: { PetAdopted: petAdoptedItem(true) },
      };
      const paths = {
        ...createPet(),
        '/payloads': {
          get: {
            operationId: 'getPayload',
            responses: {
              '200': { description: 'OK', content: json({ $ref: '#/components/schemas/OnPetAdoptedPayload' }) },
            },
          },
        },
      };
      const before = { openapi, info, paths, components };
      const after = { ...before, webhooks: { petAdopted: { $ref: COMPONENT } } };
      expect(summary(await parse(before))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "OnPetAdoptedF9960APayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "OnPetAdoptedPayload { other }",
            "CreatePetRequest { callbackUrl }",
            "OnPetAdoptedF9960APayload { petId }",
          ],
          "webhooks": [],
        }
      `);
      expect(summary(await parse(after))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "OnPetAdoptedF9960APayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "OnPetAdoptedPayload { other }",
            "CreatePetRequest { callbackUrl }",
            "OnPetAdoptedF9960APayload { petId }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdoptedF9960APayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      expect(await diff(before, after)).toEqual({ exit: 1, changes: ['webhook-added petAdopted (additive)'] });
    });

    it('a second webhook of the same plain stem hashes both webhooks, and the callback follows its own', async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const other = { on_pet_adopted: posting({}, flag('other')) };
      const before = { openapi, info, paths: createPet(), webhooks: other, components };
      const after = { ...before, webhooks: { ...other, petAdopted: { $ref: COMPONENT } } };
      // Before the webhook, the callback steps around the other webhook's name.
      expect(summary(await parse(before))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "OnPetAdoptedF9960APayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "OnPetAdoptedPayload { other }",
            "OnPetAdoptedF9960APayload { petId }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "on_pet_adopted post",
            },
          ],
        }
      `);
      // With it, two webhooks ask for one stem and both hash, as the `webhooks`
      // map always decides; the callback keeps the name it had.
      expect(summary(await parse(after))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "OnPetAdoptedF9960APayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "OnPetAdopted49Cb63Payload { other }",
            "OnPetAdoptedF9960APayload { petId }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdopted49Cb63Payload",
              "site": "on_pet_adopted post",
            },
            {
              "payload": "OnPetAdoptedF9960APayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      // The other webhook's rename is the `webhooks` map's own rule; the callback is not touched.
      expect(await diff(before, after)).toMatchInlineSnapshot(`
        {
          "changes": [
            "model-added OnPetAdopted49Cb63Payload (additive)",
            "model-removed OnPetAdoptedPayload (breaking)",
            "webhook-added petAdopted (additive)",
            "webhook-modified on_pet_adopted (additive)",
          ],
          "exit": 2,
        }
      `);
    });

    it("another callback of the same plain stem hashes alone: the webhook's stem is settled first", async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const rival = { [EXPRESSION]: posting({ operationId: 'on_pet_adopted' }, flag('other')) };
      const dogs = { '/dogs': registering('createDog', { dogAdopted: rival }) };
      const webhooks = { petAdopted: { $ref: COMPONENT } };
      const shared = { openapi, info, paths: createPet(), webhooks, components };
      const webhookAndRival = { openapi, info, paths: dogs, webhooks, components };
      const all = { openapi, info, paths: { ...createPet(), ...dogs }, webhooks, components };
      expect(summary(await parse(all))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
            {
              "payload": "OnPetAdopted49Cb63Payload",
              "site": "dogAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "CreateDogRequest { callbackUrl }",
            "OnPetAdoptedPayload { petId }",
            "OnPetAdopted49Cb63Payload { other }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      // Adding the rival callback, or the sharing one, renames nothing.
      expect(await diff(shared, all)).toMatchInlineSnapshot(`
        {
          "changes": [
            "model-added CreateDogRequest (additive)",
            "model-added OnPetAdopted49Cb63Payload (additive)",
            "service-added Dogs (additive)",
          ],
          "exit": 1,
        }
      `);
      expect(await diff(webhookAndRival, all)).toMatchInlineSnapshot(`
        {
          "changes": [
            "model-added CreatePetRequest (additive)",
            "service-added Pets (additive)",
          ],
          "exit": 1,
        }
      `);
    });

    it('the exception: a webhook added to an operation two callbacks had hashed apart gives it its plain stem', async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const rival = { [EXPRESSION]: posting({ operationId: 'on_pet_adopted' }, flag('other')) };
      const paths = { ...createPet(), '/dogs': registering('createDog', { dogAdopted: rival }) };
      const before = { openapi, info, paths, components };
      const after = { ...before, webhooks: { petAdopted: { $ref: COMPONENT } } };
      expect(summary(await parse(before)).models).toMatchInlineSnapshot(`
        [
          "CreatePetRequest { callbackUrl }",
          "CreateDogRequest { callbackUrl }",
          "OnPetAdoptedF9960APayload { petId }",
          "OnPetAdopted49Cb63Payload { other }",
        ]
      `);
      expect(summary(await parse(after)).models).toMatchInlineSnapshot(`
        [
          "CreatePetRequest { callbackUrl }",
          "CreateDogRequest { callbackUrl }",
          "OnPetAdoptedPayload { petId }",
          "OnPetAdopted49Cb63Payload { other }",
        ]
      `);
      expect(await diff(before, after)).toMatchInlineSnapshot(`
        {
          "changes": [
            "model-added OnPetAdoptedPayload (additive)",
            "model-removed OnPetAdoptedF9960APayload (breaking)",
            "callback-modified petAdopted (additive)",
            "webhook-added petAdopted (additive)",
          ],
          "exit": 2,
        }
      `);
    });

    it('an operationId starting with a digit takes the noun of the map it is read in, so each site keeps its own', async () => {
      const components = { pathItems: { PetAdopted: posting({ operationId: '2faEnabled' }) } };
      const before = { openapi, info, paths: createPet(), components };
      const after = { ...before, webhooks: { petAdopted: { $ref: COMPONENT } } };
      expect(summary(await parse(after))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "Callback2FaEnabledPayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "Webhook2FaEnabledPayload { petId }",
            "Callback2FaEnabledPayload { petId }",
          ],
          "webhooks": [
            {
              "payload": "Webhook2FaEnabledPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      expect(await diff(before, after)).toMatchInlineSnapshot(`
        {
          "changes": [
            "model-added Webhook2FaEnabledPayload (additive)",
            "webhook-added petAdopted (additive)",
          ],
          "exit": 1,
        }
      `);
    });

    it('a stem hashed with its source in front (#580) is shared at that hash', async () => {
      // A key and an operationId of one text hash `key:petAdopted` and
      // `operationId:petAdopted`; the callback, named from the operationId, hashes as its webhook does.
      const components = { pathItems: { NoteAdded: posting({ operationId: 'petAdopted' }, flag('note')) } };
      const webhooks = {
        petAdopted: posting({}, flag('pet')),
        noteAdded: { $ref: '#/components/pathItems/NoteAdded' },
      };
      const paths = { '/notes': registering('createNote', { noteAdded: under('#/components/pathItems/NoteAdded') }) };
      const before = { openapi, info, paths: {}, webhooks, components };
      const after = { ...before, paths };
      expect(summary(await parse(after))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "PetAdoptedB0Ca6APayload",
              "site": "noteAdded {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreateNoteRequest { callbackUrl }",
            "PetAdopted15Fe0FPayload { pet }",
            "PetAdoptedB0Ca6APayload { note }",
          ],
          "webhooks": [
            {
              "payload": "PetAdopted15Fe0FPayload",
              "site": "petAdopted post",
            },
            {
              "payload": "PetAdoptedB0Ca6APayload",
              "site": "noteAdded post",
            },
          ],
        }
      `);
      expect(await diff(before, after)).toEqual({
        exit: 1,
        changes: ['model-added CreateNoteRequest (additive)', 'service-added Notes (additive)'],
      });
    });

    it('key-named stems that coincide on one operation object share; on two objects the callback hashes', async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(false) } };
      const paths = { '/pets': registering('subscribe', { petAdopted: under(COMPONENT) }) };
      const before = { openapi, info, paths, components };
      const sameObject = { ...before, webhooks: { subscribePetAdopted: { $ref: COMPONENT } } };
      const otherObject = { ...before, webhooks: { subscribePetAdopted: petAdoptedItem(false) } };
      expect(summary(await parse(sameObject))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "SubscribePetAdoptedPayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "SubscribeRequest { callbackUrl }",
            "SubscribePetAdoptedPayload { petId }",
          ],
          "webhooks": [
            {
              "payload": "SubscribePetAdoptedPayload",
              "site": "subscribePetAdopted post",
            },
          ],
        }
      `);
      expect(await diff(before, sameObject)).toEqual({
        exit: 1,
        changes: ['webhook-added subscribePetAdopted (additive)'],
      });
      // Two objects under one stem are a collision, decided as any callback's with a webhook's name is.
      expect(summary(await parse(otherObject))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "SubscribePetAdoptedEa8243Payload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "SubscribeRequest { callbackUrl }",
            "SubscribePetAdoptedPayload { petId }",
            "SubscribePetAdoptedEa8243Payload { petId }",
          ],
          "webhooks": [
            {
              "payload": "SubscribePetAdoptedPayload",
              "site": "subscribePetAdopted post",
            },
          ],
        }
      `);
    });

    it('key-named stems that coincide but hash apart keep a minting each, and adding the webhook renames nothing', async () => {
      const components = {
        schemas: { SubscribePetAdoptedPayload: { type: 'object', properties: { other: { type: 'string' } } } },
        pathItems: { PetAdopted: petAdoptedItem(false) },
      };
      const paths = {
        '/pets': registering('subscribe', { petAdopted: under(COMPONENT) }),
        '/payloads': {
          get: {
            operationId: 'getPayload',
            responses: {
              '200': { description: 'OK', content: json({ $ref: '#/components/schemas/SubscribePetAdoptedPayload' }) },
            },
          },
        },
      };
      const before = { openapi, info, paths, components };
      const after = { ...before, webhooks: { subscribePetAdopted: { $ref: COMPONENT } } };
      expect(summary(await parse(after))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "SubscribePetAdoptedEa8243Payload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "SubscribePetAdoptedPayload { other }",
            "SubscribeRequest { callbackUrl }",
            "SubscribePetAdopted34A885Payload { petId }",
            "SubscribePetAdoptedEa8243Payload { petId }",
          ],
          "webhooks": [
            {
              "payload": "SubscribePetAdopted34A885Payload",
              "site": "subscribePetAdopted post",
            },
          ],
        }
      `);
      expect(await diff(before, after)).toMatchInlineSnapshot(`
        {
          "changes": [
            "model-added SubscribePetAdopted34A885Payload (additive)",
            "webhook-added subscribePetAdopted (additive)",
          ],
          "exit": 1,
        }
      `);
    });
  });

  describe('which entries read one operation object', () => {
    const openapi = '3.1.0';

    it('each method of a shared path item shares its own operation', async () => {
      const item = (operationIds: boolean) => ({
        post: receiving(operationIds ? { operationId: 'onPetAdopted' } : {}),
        put: receiving(operationIds ? { operationId: 'onPetReadopted' } : {}, flag('again')),
      });
      const document = (operationIds: boolean, webhook: boolean) => ({
        openapi,
        info,
        paths: createPet(),
        ...(webhook ? { webhooks: { petAdopted: { $ref: COMPONENT } } } : {}),
        components: { pathItems: { PetAdopted: item(operationIds) } },
      });
      expect(summary(await parse(document(true, true)))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
            {
              "payload": "OnPetReadoptedPayload",
              "site": "petAdopted {$request.body#/callbackUrl} put",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "OnPetAdoptedPayload { petId }",
            "OnPetReadoptedPayload { again }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
            {
              "payload": "OnPetReadoptedPayload",
              "site": "petAdopted put",
            },
          ],
        }
      `);
      expect(await diff(document(true, false), document(true, true))).toEqual({
        exit: 1,
        changes: ['webhook-added petAdopted (additive)', 'webhook-added petAdopted (additive)'],
      });
      // Without operationIds every site and method keeps its own stem.
      expect(summary(await parse(document(false, true)))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "CreatePetPetAdoptedPostPayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
            {
              "payload": "CreatePetPetAdoptedPutPayload",
              "site": "petAdopted {$request.body#/callbackUrl} put",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "PetAdoptedPostPayload { petId }",
            "PetAdoptedPutPayload { again }",
            "CreatePetPetAdoptedPostPayload { petId }",
            "CreatePetPetAdoptedPutPayload { again }",
          ],
          "webhooks": [
            {
              "payload": "PetAdoptedPostPayload",
              "site": "petAdopted post",
            },
            {
              "payload": "PetAdoptedPutPayload",
              "site": "petAdopted put",
            },
          ],
        }
      `);
      expect(await diff(document(false, false), document(false, true))).toMatchInlineSnapshot(`
        {
          "changes": [
            "model-added PetAdoptedPostPayload (additive)",
            "model-added PetAdoptedPutPayload (additive)",
            "webhook-added petAdopted (additive)",
            "webhook-added petAdopted (additive)",
          ],
          "exit": 1,
        }
      `);
    });

    it("the shared operation's own callback is minted once, under the webhook and under the callback", async () => {
      const confirmed = { confirmed: { [EXPRESSION]: posting({}, flag('ok')) } };
      const components = {
        pathItems: { PetAdopted: posting({ operationId: 'onPetAdopted', callbacks: confirmed }) },
      };
      const before = { openapi, info, paths: createPet(), components };
      const after = { ...before, webhooks: { petAdopted: { $ref: COMPONENT } } };
      expect(summary(await parse(after))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "callbacks": [
                {
                  "payload": "OnPetAdoptedConfirmedPayload",
                  "site": "confirmed {$request.body#/callbackUrl} post",
                },
              ],
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "OnPetAdoptedPayload { petId }",
            "OnPetAdoptedConfirmedPayload { ok }",
          ],
          "webhooks": [
            {
              "callbacks": [
                {
                  "payload": "OnPetAdoptedConfirmedPayload",
                  "site": "confirmed {$request.body#/callbackUrl} post",
                },
              ],
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      expect(await diff(before, after)).toEqual({ exit: 1, changes: ['webhook-added petAdopted (additive)'] });
      expect(await diff({ ...after, paths: {} }, after)).toEqual({
        exit: 1,
        changes: ['model-added CreatePetRequest (additive)', 'service-added Pets (additive)'],
      });
    });

    it("under a hashed shared stem the operation's own callback is minted per stem: the webhook's settled, the callback's plain", async () => {
      const confirmed = { confirmed: { [EXPRESSION]: posting({}, flag('ok')) } };
      const components = {
        schemas: { OnPetAdoptedPayload: { type: 'object', properties: { other: { type: 'string' } } } },
        pathItems: { PetAdopted: posting({ operationId: 'onPetAdopted', callbacks: confirmed }) },
      };
      const payloads = {
        '/payloads': {
          get: {
            operationId: 'getPayload',
            responses: {
              '200': { description: 'OK', content: json({ $ref: '#/components/schemas/OnPetAdoptedPayload' }) },
            },
          },
        },
      };
      const before = { openapi, info, paths: { ...createPet(), ...payloads }, components };
      const after = { ...before, webhooks: { petAdopted: { $ref: COMPONENT } } };
      expect(summary(await parse(after))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "callbacks": [
                {
                  "payload": "OnPetAdoptedConfirmedPayload",
                  "site": "confirmed {$request.body#/callbackUrl} post",
                },
              ],
              "payload": "OnPetAdoptedF9960APayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "OnPetAdoptedPayload { other }",
            "CreatePetRequest { callbackUrl }",
            "OnPetAdoptedF9960APayload { petId }",
            "OnPetAdoptedF9960AConfirmedPayload { ok }",
            "OnPetAdoptedConfirmedPayload { ok }",
          ],
          "webhooks": [
            {
              "callbacks": [
                {
                  "payload": "OnPetAdoptedF9960AConfirmedPayload",
                  "site": "confirmed {$request.body#/callbackUrl} post",
                },
              ],
              "payload": "OnPetAdoptedF9960APayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      // Each site's nested callback keeps the name it has without the other site.
      expect(await diff(before, after)).toEqual({
        exit: 1,
        changes: ['model-added OnPetAdoptedF9960AConfirmedPayload (additive)', 'webhook-added petAdopted (additive)'],
      });
      expect(await diff({ ...after, paths: payloads }, after)).toEqual({
        exit: 1,
        changes: [
          'model-added CreatePetRequest (additive)',
          'model-added OnPetAdoptedConfirmedPayload (additive)',
          'service-added Pets (additive)',
        ],
      });
    });

    it('every expression and every key of a callback reaching the path item shares it', async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const both = { [EXPRESSION]: { $ref: COMPONENT }, '{$request.body#/secondUrl}': { $ref: COMPONENT } };
      const paths = { '/pets': registering('createPet', { petAdopted: both, petRehomed: under(COMPONENT) }) };
      const before = { openapi, info, paths, components };
      const after = { ...before, webhooks: { petAdopted: { $ref: COMPONENT } } };
      expect(summary(await parse(after))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted {$request.body#/secondUrl} post",
            },
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petRehomed {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "OnPetAdoptedPayload { petId }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      expect(await diff(before, after)).toEqual({ exit: 1, changes: ['webhook-added petAdopted (additive)'] });
    });

    it('a `components/callbacks` entry reaching the webhook shares it at every operation that references it', async () => {
      const components = {
        callbacks: { Adopted: under('#/webhooks/petAdopted') },
        pathItems: { PetAdopted: petAdoptedItem(true) },
      };
      const reference = { $ref: '#/components/callbacks/Adopted' };
      const doc = {
        openapi,
        info,
        paths: {
          '/pets': registering('createPet', { petAdopted: reference }),
          '/dogs': registering('createDog', { dogAdopted: reference }),
        },
        webhooks: { petAdopted: { $ref: COMPONENT } },
        components,
      };
      expect(summary(await parse(doc))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
            {
              "payload": "OnPetAdoptedPayload",
              "site": "dogAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "CreateDogRequest { callbackUrl }",
            "OnPetAdoptedPayload { petId }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
    });

    it('a payload that is a component is referenced by both, and nothing is minted', async () => {
      const components = {
        schemas: { Adoption: petId },
        pathItems: {
          PetAdopted: posting({ operationId: 'onPetAdopted' }, { $ref: '#/components/schemas/Adoption' }),
        },
      };
      const before = { openapi, info, paths: createPet(), components };
      const after = { ...before, webhooks: { petAdopted: { $ref: COMPONENT } } };
      expect(summary(await parse(after))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "Adoption",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "Adoption { petId }",
            "CreatePetRequest { callbackUrl }",
          ],
          "webhooks": [
            {
              "payload": "Adoption",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      expect(await diff(before, after)).toEqual({ exit: 1, changes: ['webhook-added petAdopted (additive)'] });
    });

    it('a callback nested in another callback shares the webhook it reaches', async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const registered = { [EXPRESSION]: posting({ callbacks: { petAdopted: under(COMPONENT) } }, flag('ok')) };
      const before = { openapi, info, paths: { '/pets': registering('createPet', { registered }) }, components };
      const after = { ...before, webhooks: { petAdopted: { $ref: COMPONENT } } };
      expect(summary(await parse(after))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "callbacks": [
                {
                  "payload": "OnPetAdoptedPayload",
                  "site": "petAdopted {$request.body#/callbackUrl} post",
                },
              ],
              "payload": "CreatePetRegisteredPayload",
              "site": "registered {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "OnPetAdoptedPayload { petId }",
            "CreatePetRegisteredPayload { ok }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      expect(await diff(before, after)).toEqual({ exit: 1, changes: ['webhook-added petAdopted (additive)'] });
    });

    it("a webhook's own callback shares the webhook it reaches: another one, or the very webhook declaring it", async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const another = {
        openapi,
        info,
        paths: {},
        webhooks: {
          petReturned: posting({ callbacks: { again: under(COMPONENT) } }, flag('returned')),
          petAdopted: { $ref: COMPONENT },
        },
        components,
      };
      expect(summary(await parse(another))).toMatchInlineSnapshot(`
        {
          "callbacks": [],
          "enums": [],
          "models": [
            "PetReturnedPayload { returned }",
            "OnPetAdoptedPayload { petId }",
          ],
          "webhooks": [
            {
              "callbacks": [
                {
                  "payload": "OnPetAdoptedPayload",
                  "site": "again {$request.body#/callbackUrl} post",
                },
              ],
              "payload": "PetReturnedPayload",
              "site": "petReturned post",
            },
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      expect(warn).not.toHaveBeenCalled();

      const itself = {
        openapi,
        info,
        paths: {},
        webhooks: {
          petAdopted: posting({ operationId: 'onPetAdopted', callbacks: { again: under('#/webhooks/petAdopted') } }),
        },
      };
      expect(summary(await parse(itself))).toMatchInlineSnapshot(`
        {
          "callbacks": [],
          "enums": [],
          "models": [
            "OnPetAdoptedPayload { petId }",
          ],
          "webhooks": [
            {
              "callbacks": [
                {
                  "payload": "OnPetAdoptedPayload",
                  "site": "again {$request.body#/callbackUrl} post",
                },
              ],
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      // The callback's operation declares the callback again: the cycle guard stops there, as it always has.
      expect(warn.mock.calls.map((call: unknown[]) => String(call[0]))).toMatchInlineSnapshot(`
        [
          "[oagen] Warning: Callback "webhooks.petAdopted.post.callbacks.again.{$request.body#/callbackUrl}.post.callbacks.again" refers back to a callback it sits in; skipping it.",
        ]
      `);
    });

    it('an operationId two callback operations declare names neither, so the callback keeps its key-named minting', async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const duplicate = { [EXPRESSION]: posting({ operationId: 'onPetAdopted' }, flag('other')) };
      const doc = {
        openapi,
        info,
        paths: { ...createPet(), '/dogs': registering('createDog', { dogAdopted: duplicate }) },
        webhooks: { petAdopted: { $ref: COMPONENT } },
        components,
      };
      expect(summary(await parse(doc))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "CreatePetPetAdoptedPayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
            {
              "payload": "CreateDogDogAdoptedPayload",
              "site": "dogAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreatePetRequest { callbackUrl }",
            "CreateDogRequest { callbackUrl }",
            "OnPetAdoptedPayload { petId }",
            "CreatePetPetAdoptedPayload { petId }",
            "CreateDogDogAdoptedPayload { other }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
      expect(warn.mock.calls.map((call: unknown[]) => String(call[0]))).toMatchInlineSnapshot(`
        [
          "[oagen] Warning: operationId "onPetAdopted" is declared by more than one callback operation (createPet.callbacks.petAdopted.{$request.body#/callbackUrl}.post, createDog.callbacks.dogAdopted.{$request.body#/callbackUrl}.post); naming their models from the callback keys instead.",
        ]
      `);
    });

    it('a different callback operation declaring the webhook operationId is another object, and hashes', async () => {
      const components = { pathItems: { PetAdopted: petAdoptedItem(true) } };
      const other = { [EXPRESSION]: posting({ operationId: 'onPetAdopted' }, flag('other')) };
      const doc = {
        openapi,
        info,
        paths: { '/dogs': registering('createDog', { dogAdopted: other }) },
        webhooks: { petAdopted: { $ref: COMPONENT } },
        components,
      };
      expect(summary(await parse(doc))).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "payload": "OnPetAdoptedF9960APayload",
              "site": "dogAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "CreateDogRequest { callbackUrl }",
            "OnPetAdoptedPayload { petId }",
            "OnPetAdoptedF9960APayload { other }",
          ],
          "webhooks": [
            {
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
    });

    it('one Operation Object a YAML alias puts under two path items is read with each path item, never shared', async () => {
      // The webhook's path item and the callback's declare different
      // parameters around the one aliased operation: sharing the webhook's
      // minting would give the callback the webhook's header.
      const spec = await parse(`openapi: 3.1.0
info: { title: alias, version: '1' }
webhooks:
  petAdopted:
    parameters:
      - { name: X-From-Webhook, in: header, schema: { type: object, properties: { a: { type: string } } } }
    post: &shared
      operationId: onPetAdopted
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { petId: { type: string } } }
      responses: { '204': { description: No content } }
paths:
  /pets:
    post:
      operationId: createPet
      responses: { '201': { description: Created } }
      callbacks:
        petAdopted:
          '{$request.body#/callbackUrl}':
            parameters:
              - { name: X-From-Callback, in: header, schema: { type: object, properties: { b: { type: string } } } }
            post: *shared
`);
      expect(summary(spec)).toMatchInlineSnapshot(`
        {
          "callbacks": [
            {
              "params": [
                "X-From-Callback: OnPetAdoptedF9960AXFromCallback",
              ],
              "payload": "OnPetAdoptedF9960APayload",
              "site": "petAdopted {$request.body#/callbackUrl} post",
            },
          ],
          "enums": [],
          "models": [
            "OnPetAdoptedPayload { petId }",
            "OnPetAdoptedXFromWebhook { a }",
            "OnPetAdoptedF9960APayload { petId }",
            "OnPetAdoptedF9960AXFromCallback { b }",
          ],
          "webhooks": [
            {
              "params": [
                "X-From-Webhook: OnPetAdoptedXFromWebhook",
              ],
              "payload": "OnPetAdoptedPayload",
              "site": "petAdopted post",
            },
          ],
        }
      `);
    });
  });
  describe.each(['3.0.3', '3.1.0'])(
    'OpenAPI %s: a callback model named like one a webhook minted for another shape',
    (openapi) => {
      const titled = (title: string, value: string, fields: Record<string, unknown>) => ({
        title,
        type: 'object',
        properties: { kind: { type: 'string', const: value }, ...fields },
      });
      /** A union whose first variant is titled `Shape` and holds `own`, beside a `Note`. */
      const shaped = (own: Record<string, unknown>) => ({
        oneOf: [titled('Shape', 'shape', own), titled('Note', 'note', { text: { type: 'string' } })],
      });
      const sides = shaped({ sides: { type: 'integer' } });
      const radius = shaped({ radius: { type: 'number' } });
      /** The webhook `petAdopted`, whose operation `onPetAdopted` posts a `Shape` with `sides`. */
      const webhooks = { petAdopted: { $ref: COMPONENT } };
      const components = { pathItems: { PetAdopted: posting({ operationId: 'onPetAdopted' }, sides) } };
      /** `createPet`'s callback, reading the webhook's operation. */
      const pets = createPet();
      /** A callback of `operationId`'s operation on an operation object of its own, posting `schema`. */
      const unrelated = (operationId: string, key: string, schema: unknown) =>
        registering(operationId, { [key]: { [EXPRESSION]: posting({}, schema) } });
      /** `createDog`'s callback `dogAdopted`: an operation of its own, posting a `Shape` with `radius`. */
      const dogs = { '/dogs': unrelated('createDog', 'dogAdopted', radius) };

      const parted = {
        models: [
          'CreateDogRequest { callbackUrl }',
          'Shape { kind, sides }',
          'Note { kind, text }',
          'CreateDogDogAdoptedShape { kind, radius }',
        ],
        enums: [],
        webhooks: [{ site: 'petAdopted post', payload: 'Shape | Note' }],
        callbacks: [{ site: `dogAdopted ${EXPRESSION} post`, payload: 'CreateDogDogAdoptedShape | Note' }],
      };

      it('a webhook and an unrelated callback: the callback model is renamed under its stem, never merged', async () => {
        // The callback's `Shape` used to be merged into the webhook's with a
        // "more than one definition" warning, its `radius` variant lost.
        const doc = { openapi, info, paths: dogs, webhooks, components };
        const spec = await parse(doc);
        expect(summary(spec)).toEqual(parted);
        expect(warn).not.toHaveBeenCalled();
        // Whichever of `paths` and `webhooks` the document declares first.
        expect(await parse({ openapi, info, webhooks, components, paths: dogs })).toEqual(spec);
        expect(await parse({ openapi, info, components, paths: dogs, webhooks })).toEqual(spec);
      });

      it('the webhook, a callback sharing its minting and the unrelated callback: the same, in every order', async () => {
        const doc = { openapi, info, paths: { ...pets, ...dogs }, webhooks, components };
        const spec = await parse(doc);
        expect(summary(spec)).toEqual({
          models: ['CreatePetRequest { callbackUrl }', ...parted.models],
          enums: [],
          webhooks: parted.webhooks,
          callbacks: [{ site: `petAdopted ${EXPRESSION} post`, payload: 'Shape | Note' }, ...parted.callbacks],
        });
        expect(warn).not.toHaveBeenCalled();
        expect(await parse({ openapi, info, webhooks, components, paths: { ...pets, ...dogs } })).toEqual(spec);
        // The unrelated callback's owner declared before the sharing one's.
        const reversed = await parse({ openapi, info, webhooks, paths: { ...dogs, ...pets }, components });
        expect(summary(reversed)).toEqual({
          models: ['CreateDogRequest { callbackUrl }', 'CreatePetRequest { callbackUrl }', ...parted.models.slice(1)],
          enums: [],
          webhooks: parted.webhooks,
          callbacks: [...parted.callbacks, { site: `petAdopted ${EXPRESSION} post`, payload: 'Shape | Note' }],
        });
        expect(await diff(doc, { openapi, info, webhooks, paths: { ...dogs, ...pets }, components })).toEqual({
          exit: 0,
          changes: [],
        });
        expect(warn).not.toHaveBeenCalled();
      });

      it('adding the sharing callback, or the unrelated one, renames nothing', async () => {
        const all = { openapi, info, paths: { ...pets, ...dogs }, webhooks, components };
        expect(await diff({ openapi, info, paths: dogs, webhooks, components }, all)).toEqual({
          exit: 1,
          changes: ['model-added CreatePetRequest (additive)', 'service-added Pets (additive)'],
        });
        expect(await diff({ openapi, info, paths: pets, webhooks, components }, all)).toEqual({
          exit: 1,
          changes: [
            'model-added CreateDogRequest (additive)',
            'model-added CreateDogDogAdoptedShape (additive)',
            'service-added Dogs (additive)',
          ],
        });
      });

      it('adding the webhook to the document of the two callbacks: the unrelated callback keeps its model', async () => {
        // Callbacks only, the two part each other's `Shape`, each under its
        // stem. The webhook's minting is named where the webhooks are, so the
        // callback sharing it follows the webhook's `Shape` (the exception
        // above, for a title-mapped variant); the unrelated callback's model
        // is the one it had.
        const before = { openapi, info, paths: { ...pets, ...dogs }, components };
        const after = { ...before, webhooks };
        expect(summary(await parse(before))).toEqual({
          models: [
            'CreatePetRequest { callbackUrl }',
            'CreateDogRequest { callbackUrl }',
            'OnPetAdoptedShape { kind, sides }',
            'Note { kind, text }',
            'CreateDogDogAdoptedShape { kind, radius }',
          ],
          enums: [],
          webhooks: [],
          callbacks: [
            { site: `petAdopted ${EXPRESSION} post`, payload: 'OnPetAdoptedShape | Note' },
            { site: `dogAdopted ${EXPRESSION} post`, payload: 'CreateDogDogAdoptedShape | Note' },
          ],
        });
        expect(await diff(before, after)).toMatchInlineSnapshot(`
          {
            "changes": [
              "model-added Shape (additive)",
              "model-removed OnPetAdoptedShape (breaking)",
              "callback-modified petAdopted (additive)",
              "webhook-added petAdopted (additive)",
            ],
            "exit": 2,
          }
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('adding the webhook to the document of the unrelated callback alone moves the callback model under its stem', async () => {
        // The callback alone holds `Shape`; a webhook minting `Shape` for
        // another shape takes the name, as a webhook takes any name a callback
        // held, and the callback's model keeps its fields under its own stem.
        const before = { openapi, info, paths: dogs, components };
        const after = { ...before, webhooks };
        expect(summary(await parse(before)).models).toEqual([
          'CreateDogRequest { callbackUrl }',
          'Shape { kind, radius }',
          'Note { kind, text }',
        ]);
        expect(await diff(before, after)).toMatchInlineSnapshot(`
          {
            "changes": [
              "model-added CreateDogDogAdoptedShape (additive)",
              "model-modified Shape (breaking)",
              "callback-modified dogAdopted (additive)",
              "webhook-added petAdopted (additive)",
            ],
            "exit": 2,
          }
        `);
      });

      it('one shape under the name is still one model, shared by the webhook and the callback', async () => {
        const same = { '/dogs': unrelated('createDog', 'dogAdopted', sides) };
        const spec = await parse({ openapi, info, paths: same, webhooks, components });
        expect(summary(spec)).toEqual({
          models: ['CreateDogRequest { callbackUrl }', 'Shape { kind, sides }', 'Note { kind, text }'],
          enums: [],
          webhooks: [{ site: 'petAdopted post', payload: 'Shape | Note' }],
          callbacks: [{ site: `dogAdopted ${EXPRESSION} post`, payload: 'Shape | Note' }],
        });
        expect(warn).not.toHaveBeenCalled();
      });

      it("a callback of the webhook's shape keeps the name while one of another shape moves, in either order", async () => {
        const same = { '/dogs': unrelated('createDog', 'dogAdopted', sides) };
        const other = { '/cats': unrelated('createCat', 'catAdopted', radius) };
        const before = { openapi, info, paths: same, webhooks, components };
        const after = { openapi, info, paths: { ...same, ...other }, webhooks, components };
        const reversed = { openapi, info, paths: { ...other, ...same }, webhooks, components };
        const callbacks = (spec: ApiSpec) =>
          Object.fromEntries(callbacksOf(spec).map(({ name, requestBody }) => [name, typeName(requestBody)]));
        const expected = { dogAdopted: 'Shape | Note', catAdopted: 'CreateCatCatAdoptedShape | Note' };
        expect(callbacks(await parse(after))).toEqual(expected);
        expect(callbacks(await parse(reversed))).toEqual(expected);
        expect(await diff(before, after)).toEqual({
          exit: 1,
          changes: [
            'model-added CreateCatRequest (additive)',
            'model-added CreateCatCatAdoptedShape (additive)',
            'service-added Cats (additive)',
          ],
        });
        expect(await diff(after, reversed)).toEqual({ exit: 0, changes: [] });
        expect(warn).not.toHaveBeenCalled();
      });

      it('a model nested in the variant is parted first, and the variant holding it follows', async () => {
        // The two `Shape`s differ only in the object under `detail`, which both mint as `ShapeDetail`.
        const detailed = (own: Record<string, unknown>) => shaped({ detail: { type: 'object', properties: own } });
        const doc = {
          openapi,
          info,
          paths: { '/dogs': unrelated('createDog', 'dogAdopted', detailed({ radius: { type: 'number' } })) },
          webhooks,
          components: {
            pathItems: {
              PetAdopted: posting({ operationId: 'onPetAdopted' }, detailed({ sides: { type: 'integer' } })),
            },
          },
        };
        expect(summary(await parse(doc))).toMatchInlineSnapshot(`
          {
            "callbacks": [
              {
                "payload": "CreateDogDogAdoptedShape | Note",
                "site": "dogAdopted {$request.body#/callbackUrl} post",
              },
            ],
            "enums": [],
            "models": [
              "CreateDogRequest { callbackUrl }",
              "Shape { kind, detail }",
              "ShapeDetail { sides }",
              "Note { kind, text }",
              "CreateDogDogAdoptedShape { kind, detail }",
              "CreateDogDogAdoptedShapeDetail { radius }",
            ],
            "webhooks": [
              {
                "payload": "Shape | Note",
                "site": "petAdopted post",
              },
            ],
          }
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it("a parameter's variant named like the webhook's payload variant is parted the same way", async () => {
        const filter = { name: 'filter', in: 'query', schema: radius };
        const doc = {
          openapi,
          info,
          paths: {
            '/dogs': registering('createDog', {
              dogAdopted: { [EXPRESSION]: posting({ parameters: [filter] }, flag('ok')) },
            }),
          },
          webhooks,
          components,
        };
        expect(summary(await parse(doc))).toMatchInlineSnapshot(`
          {
            "callbacks": [
              {
                "params": [
                  "filter: CreateDogDogAdoptedShape | Note",
                ],
                "payload": "CreateDogDogAdoptedPayload",
                "site": "dogAdopted {$request.body#/callbackUrl} post",
              },
            ],
            "enums": [],
            "models": [
              "CreateDogRequest { callbackUrl }",
              "Shape { kind, sides }",
              "Note { kind, text }",
              "CreateDogDogAdoptedPayload { ok }",
              "CreateDogDogAdoptedShape { kind, radius }",
            ],
            "webhooks": [
              {
                "payload": "Shape | Note",
                "site": "petAdopted post",
              },
            ],
          }
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it("a webhook's own callback, and a shared operation's, are parted from the webhook's model the same way", async () => {
        const confirmed = { confirmed: { [EXPRESSION]: posting({}, radius) } };
        const own = {
          openapi,
          info,
          paths: {},
          webhooks: { petAdopted: posting({ callbacks: confirmed }, sides) },
        };
        expect(summary(await parse(own))).toEqual({
          models: ['Shape { kind, sides }', 'Note { kind, text }', 'PetAdoptedConfirmedShape { kind, radius }'],
          enums: [],
          webhooks: [
            {
              site: 'petAdopted post',
              payload: 'Shape | Note',
              callbacks: [{ site: `confirmed ${EXPRESSION} post`, payload: 'PetAdoptedConfirmedShape | Note' }],
            },
          ],
          callbacks: [],
        });

        // Declared by the shared operation: read under the webhook and under the callback sharing it, minted once.
        const nested = [{ site: `confirmed ${EXPRESSION} post`, payload: 'OnPetAdoptedConfirmedShape | Note' }];
        const shared = {
          openapi,
          info,
          paths: pets,
          webhooks,
          components: {
            pathItems: { PetAdopted: posting({ operationId: 'onPetAdopted', callbacks: confirmed }, sides) },
          },
        };
        expect(summary(await parse(shared))).toEqual({
          models: [
            'CreatePetRequest { callbackUrl }',
            'Shape { kind, sides }',
            'Note { kind, text }',
            'OnPetAdoptedConfirmedShape { kind, radius }',
          ],
          enums: [],
          webhooks: [{ site: 'petAdopted post', payload: 'Shape | Note', callbacks: nested }],
          callbacks: [{ site: `petAdopted ${EXPRESSION} post`, payload: 'Shape | Note', callbacks: nested }],
        });
        expect(warn).not.toHaveBeenCalled();
      });

      it('where two webhooks disagree on the name, the callback model is still its own', async () => {
        // Two webhooks minting `Shape` for two shapes are the `webhooks` map's
        // own to settle, as they always were; a callback is merged into neither.
        const width = shaped({ width: { type: 'number' } });
        const doc = {
          openapi,
          info,
          paths: dogs,
          webhooks: { ...webhooks, petMeasured: posting({}, width) },
          components,
        };
        const spec = await parse(doc);
        expect(callbacksOf(spec).map(({ requestBody }) => typeName(requestBody))).toEqual([
          'CreateDogDogAdoptedShape | Note',
        ]);
        expect(summary(spec).models).toContain('CreateDogDogAdoptedShape { kind, radius }');

        // Not even a callback with the shape of one of the two: which of the
        // webhooks' shapes the name ends on is not the callback's to rely on.
        const second = await parse({
          ...doc,
          paths: { '/dogs': unrelated('createDog', 'dogAdopted', width) },
        });
        expect(callbacksOf(second).map(({ requestBody }) => typeName(requestBody))).toEqual([
          'CreateDogDogAdoptedShape | Note',
        ]);
        expect(summary(second).models).toContain('CreateDogDogAdoptedShape { kind, width }');
      });
    },
  );
});
