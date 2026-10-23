import { describe, it, expect, afterAll, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { collectModelRefs, collectRequestBodyTypes, collectResponseBodyTypes } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef, Webhook } from '../../src/ir/types.js';

/**
 * Issue #316: a request body can be described twice — by the Request Body
 * Object's own `description` and by its schema's — and the IR kept neither
 * unless the schema was a `$ref` to a component. The Request Body Object's
 * text (else the picked schema's own) is now `requestBodyDescription` on the
 * operation and on the webhook, beside `requestBody`, as `responseDescription`
 * is for the success response; and an inline object body's model carries its
 * schema's `description`, as every other inline model already did.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function parseDocument(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-316-'));
  dirs.push(dir);
  const file = path.join(dir, 'spec.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

const PET = {
  type: 'object',
  description: 'A pet in the shelter.',
  properties: { name: { type: 'string' } },
  required: ['name'],
};

/** An OpenAPI 3.1 document around `paths`, with the `Pet` component and whatever else is given. */
const document = (
  paths: Record<string, unknown>,
  extra: { webhooks?: Record<string, unknown>; requestBodies?: Record<string, unknown> } = {},
) => ({
  openapi: '3.1.0',
  info: { title: 'Pets', version: '1.0.0' },
  paths,
  ...(extra.webhooks ? { webhooks: extra.webhooks } : {}),
  components: {
    schemas: { Pet: PET },
    ...(extra.requestBodies ? { requestBodies: extra.requestBodies } : {}),
  },
});

const DONE = { '204': { description: 'Done' } };

/** A POST with the given raw `requestBody` (an inline object, a `$ref`, or nothing). */
const post = (operationId: string, requestBody: unknown) => ({
  post: { operationId, ...(requestBody !== undefined ? { requestBody } : {}), responses: DONE },
});

/** A Request Body Object with one `application/json` entry of `schema`, and `description` when given. */
const jsonBody = (schema: unknown, description?: string) => ({
  ...(description !== undefined ? { description } : {}),
  content: { 'application/json': { schema } },
});

const inlineObject = (description?: string) => ({
  type: 'object',
  ...(description !== undefined ? { description } : {}),
  properties: { name: { type: 'string' } },
  required: ['name'],
});

const inlineUnion = (description?: string) => ({
  ...(description !== undefined ? { description } : {}),
  oneOf: [
    { type: 'object', properties: { person: { type: 'string' } }, required: ['person'] },
    { type: 'object', properties: { family: { type: 'string' } }, required: ['family'] },
  ],
});

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

const modelsOf = (spec: ApiSpec): Map<string, Model> => new Map(spec.models.map((m) => [m.name, m]));

const webhooksOf = (spec: ApiSpec): Record<string, Webhook> =>
  Object.fromEntries((spec.webhooks ?? []).map((hook) => [hook.name, hook]));

/** The issue's projection of a body type: each model with its description, unions and arrays spelled out. */
function describeType(models: Map<string, Model>, type: TypeRef | undefined): string {
  if (type === undefined) return 'none';
  switch (type.kind) {
    case 'model':
      return `${type.name} (${JSON.stringify(models.get(type.name)?.description ?? null)})`;
    case 'union':
      return `union of ${type.variants.map((v) => describeType(models, v)).join(', ')}`;
    case 'array':
      return `array of ${describeType(models, type.items)}`;
    case 'nullable':
      return `nullable ${describeType(models, type.inner)}`;
    case 'enum':
      return `enum ${type.name}`;
    default:
      return 'type' in type ? `primitive ${type.type}` : type.kind;
  }
}

/** Every type an operation or webhook references: bodies of every media type, responses of every kind, parameters. */
function referencedTypes(spec: ApiSpec): TypeRef[] {
  const refs: TypeRef[] = [];
  for (const op of Object.values(opsOf(spec))) {
    if (op.requestBody) refs.push(op.requestBody);
    refs.push(...collectRequestBodyTypes(op).map(({ type }) => type));
    refs.push(...collectResponseBodyTypes(op).map(({ type }) => type));
    for (const list of [op.pathParams, op.queryParams, op.headerParams, op.cookieParams ?? []]) {
      refs.push(...list.map((p) => p.type));
    }
  }
  for (const hook of spec.webhooks ?? []) {
    if (hook.requestBody) refs.push(hook.requestBody);
    refs.push(...(hook.requestBodyContents ?? []).map(({ type }) => type));
    for (const list of [hook.headerParams, hook.queryParams, hook.cookieParams ?? []]) {
      refs.push(...list.map((p) => p.type));
    }
  }
  return refs;
}

/** Every model reference, from operations, webhooks and model fields alike, that names no model. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const names = new Set(spec.models.map((m) => m.name));
  const found = new Set<string>();
  for (const ref of referencedTypes(spec))
    for (const name of collectModelRefs(ref)) if (!names.has(name)) found.add(name);
  for (const model of spec.models) {
    for (const field of model.fields) {
      for (const name of collectModelRefs(field.type))
        if (!names.has(name)) found.add(`${model.name}.${field.name} → ${name}`);
    }
  }
  return [...found].sort();
}

/** Every model that is neither a component nor referenced by any operation, webhook or model field. */
function orphanedModels(spec: ApiSpec, componentNames: string[] = ['Pet']): string[] {
  const referenced = new Set<string>();
  for (const ref of referencedTypes(spec)) for (const name of collectModelRefs(ref)) referenced.add(name);
  for (const model of spec.models) {
    for (const field of model.fields) for (const name of collectModelRefs(field.type)) referenced.add(name);
  }
  return spec.models
    .map((m) => m.name)
    .filter((name) => !componentNames.includes(name) && !referenced.has(name))
    .sort();
}

/** Nothing dangles and nothing is orphaned: a description never changes which models exist or who points at them. */
function expectSound(spec: ApiSpec): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphanedModels(spec)).toEqual([]);
}

describe('request body descriptions (issue #316)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the Request Body Object's description and an inline object schema's — the issue's exact repro", async () => {
    const spec = await parseDocument(
      document({
        '/pets': post('createPet', jsonBody(inlineObject('A pet, as it arrives.'), 'The pet to add to the shelter.')),
        '/pets/{id}': {
          put: {
            operationId: 'replacePet',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: jsonBody({ $ref: '#/components/schemas/Pet' }, 'The pet that replaces the current one.'),
            responses: DONE,
          },
        },
        '/adoptions': post(
          'adoptPet',
          jsonBody(inlineUnion('An adoption by a person or by a family.'), 'Who adopts which pet.'),
        ),
      }),
    );
    const models = modelsOf(spec);
    const ops = opsOf(spec);

    // The issue's projection, with the body's own description beside each.
    expect(
      ['createPet', 'replacePet', 'adoptPet'].map(
        (name) =>
          `${name}: ${describeType(models, ops[name].requestBody)} — ${JSON.stringify(ops[name].requestBodyDescription)}`,
      ),
    ).toEqual([
      'createPet: CreatePetRequest ("A pet, as it arrives.") — "The pet to add to the shelter."',
      'replacePet: Pet ("A pet in the shelter.") — "The pet that replaces the current one."',
      'adoptPet: union of AdoptPetRequest (null), AdoptPetRequestWithFamily (null) — "Who adopts which pet."',
    ]);
    // Both texts survive serialization, so an emitter that prints the IR sees them.
    expect(JSON.stringify(spec)).toContain('The pet to add to the shelter.');
    expect(JSON.stringify(spec)).toContain('A pet, as it arrives.');
    // Both fields are read from the same body: the primary content entry
    // shares `requestBody`'s TypeRef, so it reads the same model.
    expect(ops.createPet.requestBodyContents?.[0].type).toBe(ops.createPet.requestBody);
    expectSound(spec);
  });

  describe("the Request Body Object's own description", () => {
    it('is carried alone, on an inline object body, a $ref body and a oneOf body', async () => {
      const spec = await parseDocument(
        document({
          '/objects': post('createObject', jsonBody(inlineObject(), 'Body text.')),
          '/refs': post('createRef', jsonBody({ $ref: '#/components/schemas/Pet' }, 'Ref body text.')),
          '/unions': post('createUnion', jsonBody(inlineUnion(), 'Union body text.')),
        }),
      );
      const ops = opsOf(spec);
      const models = modelsOf(spec);

      expect(ops.createObject.requestBodyDescription).toBe('Body text.');
      // The schema said nothing, so the model is undescribed: the body's text is not copied onto it.
      expect(models.get('CreateObjectRequest')?.description).toBeUndefined();
      expect(ops.createRef.requestBodyDescription).toBe('Ref body text.');
      // The component keeps its own text; the body's does not overwrite it.
      expect(models.get('Pet')?.description).toBe('A pet in the shelter.');
      expect(ops.createUnion.requestBodyDescription).toBe('Union body text.');
      expectSound(spec);
    });

    it("wins over the picked schema's description when both have content, and the schema's stays on the model", async () => {
      const spec = await parseDocument(
        document({
          '/pets': post('createPet', jsonBody(inlineObject('Schema text.'), 'Body text.')),
          '/adoptions': post('adoptPet', jsonBody(inlineUnion('Union schema text.'), 'Union body text.')),
        }),
      );
      const ops = opsOf(spec);
      const models = modelsOf(spec);

      expect(ops.createPet.requestBodyDescription).toBe('Body text.');
      expect(models.get('CreatePetRequest')?.description).toBe('Schema text.');
      // A `oneOf` body has no model of its own, so its schema's text has
      // nowhere to go once the body's own text takes the operation field.
      expect(ops.adoptPet.requestBodyDescription).toBe('Union body text.');
      expect(JSON.stringify(spec)).not.toContain('Union schema text.');
      expectSound(spec);
    });

    it('is read after a components/requestBodies $ref is resolved, on an operation and on a webhook', async () => {
      const spec = await parseDocument(
        document(
          { '/pets': post('createPet', { $ref: '#/components/requestBodies/PetBody' }) },
          {
            requestBodies: {
              PetBody: {
                description: 'The shared pet body.',
                content: { 'application/json': { schema: inlineObject('The shared pet schema.') } },
              },
            },
            webhooks: {
              petAdopted: post('petAdopted', { $ref: '#/components/requestBodies/PetBody' }),
            },
          },
        ),
      );
      const ops = opsOf(spec);
      const models = modelsOf(spec);
      const hooks = webhooksOf(spec);

      expect(ops.createPet.requestBodyDescription).toBe('The shared pet body.');
      expect(models.get('CreatePetRequest')?.description).toBe('The shared pet schema.');
      expect(hooks.petAdopted.requestBodyDescription).toBe('The shared pet body.');
      expect(models.get('PetAdoptedPayload')?.description).toBe('The shared pet schema.');
      expectSound(spec);
    });

    it('is carried when none of the body’s media types is read as requestBody, beside the warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(
        document({
          '/pets': post('createPet', {
            description: 'An XML pet.',
            content: { 'application/xml': { schema: inlineObject('The XML schema.') } },
          }),
        }),
      );
      const op = opsOf(spec).createPet;

      expect(op.requestBody).toBeUndefined();
      expect(op.requestBodyDescription).toBe('An XML pet.');
      // The secondary entry's model is described by its own schema, as before.
      expect(modelsOf(spec).get('CreatePetApplicationXmlRequest')?.description).toBe('The XML schema.');
      expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
        expect.stringContaining('Request body of createPet is not read as requestBody'),
      ]);
      expectSound(spec);
    });

    it('is not borrowed from an unread schema: a body read from no media type carries its own text only', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(
        document({
          '/pets': post('createPet', {
            content: { 'application/xml': { schema: inlineObject('The XML schema.') } },
          }),
        }),
      );
      const op = opsOf(spec).createPet;

      expect(op.requestBody).toBeUndefined();
      expect(op).not.toHaveProperty('requestBodyDescription');
      expectSound(spec);
    });
  });

  describe("the picked schema's own description, when the body declares none", () => {
    it('describes an inline object body on the operation and on its model', async () => {
      const spec = await parseDocument(
        document({ '/pets': post('createPet', jsonBody(inlineObject('A pet, as it arrives.'))) }),
      );
      const op = opsOf(spec).createPet;

      expect(op.requestBodyDescription).toBe('A pet, as it arrives.');
      expect(modelsOf(spec).get('CreatePetRequest')?.description).toBe('A pet, as it arrives.');
      expectSound(spec);
    });

    it('describes a oneOf, an array and a primitive body on the operation alone, and an inline enum body on its enum too', async () => {
      const spec = await parseDocument(
        document({
          '/unions': post('createUnion', jsonBody(inlineUnion('Union text.'))),
          '/arrays': post(
            'createArray',
            jsonBody({ type: 'array', description: 'Array text.', items: inlineObject() }),
          ),
          '/texts': post('createText', {
            content: { 'text/plain': { schema: { type: 'string', description: 'Primitive text.' } } },
          }),
          '/modes': post('createMode', jsonBody({ type: 'string', description: 'Enum text.', enum: ['a', 'b'] })),
        }),
      );
      const ops = opsOf(spec);
      const models = modelsOf(spec);

      expect(ops.createUnion.requestBodyDescription).toBe('Union text.');
      expect(describeType(models, ops.createUnion.requestBody)).toBe(
        'union of CreateUnionRequest (null), CreateUnionRequestWithFamily (null)',
      );
      expect(ops.createArray.requestBodyDescription).toBe('Array text.');
      // The items schema said nothing of its own.
      expect(describeType(models, ops.createArray.requestBody)).toBe('array of CreateArrayRequest (null)');
      expect(ops.createText.requestBodyDescription).toBe('Primitive text.');
      expect(ops.createText.requestBody).toEqual({ kind: 'primitive', type: 'string' });
      expect(ops.createMode.requestBodyDescription).toBe('Enum text.');
      expect(ops.createMode.requestBody).toMatchObject({ kind: 'enum', name: 'CreateModeRequest' });
      // The enum lifted from the inline schema carries the schema's text too (issue #351).
      expect(spec.enums.find((e) => e.name === 'CreateModeRequest')?.description).toBe('Enum text.');
      expectSound(spec);
    });

    it('reads a description written beside a $ref, and not the component’s own through a bare one', async () => {
      const spec = await parseDocument(
        document({
          '/sibling': post(
            'createSibling',
            jsonBody({ $ref: '#/components/schemas/Pet', description: 'Sibling text.' }),
          ),
          '/bare': post('createBare', jsonBody({ $ref: '#/components/schemas/Pet' })),
        }),
      );
      const ops = opsOf(spec);

      expect(ops.createSibling.requestBodyDescription).toBe('Sibling text.');
      expect(ops.createSibling.requestBody).toEqual({ kind: 'model', name: 'Pet' });
      // The component's text is on the model, read through `requestBody`.
      expect(ops.createBare).not.toHaveProperty('requestBodyDescription');
      expect(modelsOf(spec).get('Pet')?.description).toBe('A pet in the shelter.');
      expectSound(spec);
    });

    it('keeps a nullable wrapper’s text on the operation and the object branch’s on the model', async () => {
      const spec = await parseDocument(
        document({
          '/pets': post(
            'createPet',
            jsonBody({
              description: 'Wrapper text.',
              oneOf: [inlineObject('Branch text.'), { type: 'null' }],
            }),
          ),
        }),
      );
      const op = opsOf(spec).createPet;
      const models = modelsOf(spec);

      expect(op.requestBodyDescription).toBe('Wrapper text.');
      // The null branch makes the body nullable; the object branch is built as the one variant.
      expect(describeType(models, op.requestBody)).toBe('nullable union of CreatePetRequest ("Branch text.")');
      expectSound(spec);
    });

    it('keeps a flattened discriminated union’s text on the operation and on the flattened model', async () => {
      const spec = await parseDocument(
        document({
          '/pets': post(
            'createPet',
            jsonBody({
              description: 'Either kind of pet.',
              discriminator: { propertyName: 'kind' },
              oneOf: [
                {
                  type: 'object',
                  properties: { kind: { const: 'cat' }, lives: { type: 'integer' } },
                  required: ['kind'],
                },
                {
                  type: 'object',
                  properties: { kind: { const: 'dog' }, tricks: { type: 'integer' } },
                  required: ['kind'],
                },
              ],
            }),
          ),
        }),
      );
      const op = opsOf(spec).createPet;
      const models = modelsOf(spec);

      expect(op.requestBodyDescription).toBe('Either kind of pet.');
      expect(describeType(models, op.requestBody)).toBe('CreatePetRequest ("Either kind of pet.")');
      expect(models.get('CreatePetRequest')?.fields.map((f) => f.name)).toEqual(['kind', 'lives', 'tricks']);
      expectSound(spec);
    });

    it('is read from the picked entry only, never from a secondary media type’s schema', async () => {
      const spec = await parseDocument(
        document({
          '/pets': post('createPet', {
            content: {
              'text/csv': {
                schema: { type: 'object', description: 'CSV text.', properties: { row: { type: 'string' } } },
              },
              'application/json': { schema: inlineObject() },
            },
          }),
        }),
      );
      const op = opsOf(spec).createPet;
      const models = modelsOf(spec);

      // JSON wins the fixed-order pick; its schema says nothing, and the CSV schema's text is not borrowed.
      expect(op.requestBodyContentType).toBe('application/json');
      expect(op).not.toHaveProperty('requestBodyDescription');
      expect(models.get('CreatePetRequest')?.description).toBeUndefined();
      // The secondary entry's model keeps its own schema's text, as before.
      expect(models.get('CreatePetTextCsvRequest')?.description).toBe('CSV text.');
      expectSound(spec);
    });
  });

  describe('absence', () => {
    it('omits the field when neither the body nor its schema has non-whitespace content', async () => {
      const spec = await parseDocument(
        document({
          '/blank': post('createBlank', jsonBody(inlineObject('   '), ' \n')),
          '/empty': post('createEmpty', jsonBody(inlineObject(''), '')),
          '/none': post('createNone', jsonBody(inlineObject())),
          '/bodiless': post('createBodiless', undefined),
        }),
      );
      const ops = opsOf(spec);

      for (const name of ['createBlank', 'createEmpty', 'createNone', 'createBodiless']) {
        expect(ops[name], name).not.toHaveProperty('requestBodyDescription');
      }
      expect(ops.createBodiless.requestBody).toBeUndefined();
      expectSound(spec);
    });

    it('keeps the text verbatim, surrounding whitespace included', async () => {
      const spec = await parseDocument(
        document({ '/pets': post('createPet', jsonBody(inlineObject(), '  The pet.\n')) }),
      );

      expect(opsOf(spec).createPet.requestBodyDescription).toBe('  The pet.\n');
    });
  });

  describe('on a webhook', () => {
    it("carries the payload's Request Body Object description, else its picked schema's, as an operation does", async () => {
      const spec = await parseDocument(
        document(
          {},
          {
            webhooks: {
              petAdopted: post('petAdopted', jsonBody(inlineObject('Payload schema text.'), 'Payload body text.')),
              petLost: post('petLost', jsonBody(inlineUnion('Lost union text.'))),
              petFound: post('petFound', jsonBody(inlineObject('Found schema text.'))),
              petSeen: post('petSeen', jsonBody({ $ref: '#/components/schemas/Pet' })),
              petHeard: post('petHeard', jsonBody(inlineObject())),
            },
          },
        ),
      );
      const hooks = webhooksOf(spec);
      const models = modelsOf(spec);

      expect(hooks.petAdopted.requestBodyDescription).toBe('Payload body text.');
      expect(models.get('PetAdoptedPayload')?.description).toBe('Payload schema text.');
      expect(hooks.petLost.requestBodyDescription).toBe('Lost union text.');
      expect(describeType(models, hooks.petLost.requestBody)).toBe(
        'union of PetLostPayload (null), PetLostPayloadWithFamily (null)',
      );
      expect(hooks.petFound.requestBodyDescription).toBe('Found schema text.');
      expect(models.get('PetFoundPayload')?.description).toBe('Found schema text.');
      expect(hooks.petSeen).not.toHaveProperty('requestBodyDescription');
      expect(hooks.petHeard).not.toHaveProperty('requestBodyDescription');
      expectSound(spec);
    });

    it('describes a secondary media type’s payload model by its own schema and the webhook by the body', async () => {
      const spec = await parseDocument(
        document(
          {},
          {
            webhooks: {
              petAdopted: post('petAdopted', {
                description: 'Webhook body text.',
                content: {
                  'application/json': { schema: inlineObject('JSON payload text.') },
                  'text/csv': {
                    schema: {
                      type: 'object',
                      description: 'CSV payload text.',
                      properties: { row: { type: 'string' } },
                    },
                  },
                },
              }),
            },
          },
        ),
      );
      const hook = webhooksOf(spec).petAdopted;
      const models = modelsOf(spec);

      expect(hook.requestBodyDescription).toBe('Webhook body text.');
      expect(hook.requestBodyContentTypes).toEqual(['application/json', 'text/csv']);
      expect(models.get('PetAdoptedPayload')?.description).toBe('JSON payload text.');
      expect(models.get('PetAdoptedTextCsvPayload')?.description).toBe('CSV payload text.');
      expectSound(spec);
    });
  });
});
