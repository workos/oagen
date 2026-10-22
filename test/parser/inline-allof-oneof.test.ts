import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';
import { extractSchemas, schemaToTypeRef, type SchemaObject } from '../../src/parser/schemas.js';
import {
  declaresInlineProperties,
  extractInlineModelsFromProperties,
  isInlineAllOfMember,
  mergeAllOfMembers,
  mintedInlineNameEntries,
} from '../../src/parser/inline-models.js';
import {
  collectModelRefs,
  collectResponseBodyTypes,
  collectResponseHeaders,
  collectWebhookTypeRefs,
  type ApiSpec,
  type Model,
  type Operation,
  type TypeRef,
} from '../../src/ir/types.js';

/**
 * workos/oagen#283: an inline schema written as `allOf: [object, { oneOf:
 * [...] }]` — a base object plus mutually exclusive groups of fields — was
 * read differently depending on where it appeared. As a component it became
 * one model with the base and variant fields; inline, the variant fields
 * were dropped without a warning (and, before the inline `allOf` paths were
 * routed through the field extractor, a request body pointed at a model
 * nothing created). Every inline site now merges the schema through
 * `mergeAllOfMembers`, so it reads like the component: `{ name, ownerId?,
 * shelterId? }`.
 */

const str = { kind: 'primitive', type: 'string' };
const model = (name: string) => ({ kind: 'model', name });

/** The issue's schema: a required `name` plus either `ownerId` or `shelterId`. */
const basePlusVariants: SchemaObject = {
  allOf: [
    { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    {
      oneOf: [
        { type: 'object', properties: { ownerId: { type: 'string' } } },
        { type: 'object', properties: { shelterId: { type: 'string' } } },
      ],
    },
  ],
};

/** The issue's projection of a model: each field as `name: type`, `?` when optional. */
const fieldsOf = (m: Model | undefined): string[] | undefined =>
  m?.fields.map(({ name, required, type }) => {
    const shown = 'name' in type ? type.name : 'type' in type ? type.type : type.kind;
    return `${name}${required ? '' : '?'}: ${shown}`;
  });

const modelsByName = (spec: ApiSpec): Record<string, Model> => Object.fromEntries(spec.models.map((m) => [m.name, m]));

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

/** Every type reference an operation holds, labelled by where it sits. */
function operationRefs(op: Operation): Array<[string, TypeRef]> {
  const refs: Array<[string, TypeRef]> = [[`${op.name}.response`, op.response]];
  if (op.requestBody) refs.push([`${op.name}.requestBody`, op.requestBody]);
  for (const r of op.successResponses ?? []) refs.push([`${op.name}.${r.statusCode}`, r.type]);
  for (const e of op.errors) if (e.type) refs.push([`${op.name}.${e.statusCode}`, e.type]);
  for (const b of collectResponseBodyTypes(op)) refs.push([`${op.name}.${b.source}`, b.type]);
  for (const h of collectResponseHeaders(op)) refs.push([`${op.name}.${h.name}`, h.type]);
  for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
    refs.push([`${op.name}(${p.name})`, p.type]);
  }
  return refs;
}

/** Every reference from an operation, a webhook or a model field, labelled by owner. */
function allRefs(spec: ApiSpec): Array<[string, TypeRef]> {
  const refs: Array<[string, TypeRef]> = [];
  for (const op of Object.values(opsOf(spec))) refs.push(...operationRefs(op));
  for (const w of spec.webhooks ?? [])
    for (const ref of collectWebhookTypeRefs(w)) refs.push([`webhook ${w.name}`, ref]);
  for (const m of spec.models) for (const f of m.fields) refs.push([`${m.name}.${f.name}`, f.type]);
  return refs;
}

/** The invariants every case holds: every model reference resolves, and every model other than a component is referenced. */
function expectSound(spec: ApiSpec, componentNames: string[]): void {
  const names = new Set(spec.models.map((m) => m.name));
  const referenced = new Set<string>();
  const unresolved: string[] = [];
  for (const [owner, ref] of allRefs(spec)) {
    for (const name of collectModelRefs(ref)) {
      referenced.add(name);
      if (!names.has(name)) unresolved.push(`${owner} → ${name}`);
    }
  }
  expect(unresolved).toEqual([]);
  expect([...names].filter((name) => !componentNames.includes(name) && !referenced.has(name)).sort()).toEqual([]);
}

async function parseTempSpec(spec: Record<string, unknown>): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-inline-allof-oneof-'));
  const file = path.join(dir, 'spec.json');
  try {
    await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
    return await parseSpec(file);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/** Parse, asserting that nothing was warned about. */
async function parseWithoutWarnings(spec: Record<string, unknown>): Promise<ApiSpec> {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parseTempSpec(spec);
    expect(warnSpy.mock.calls).toEqual([]);
    return ir;
  } finally {
    warnSpy.mockRestore();
  }
}

const info = { title: 'allOf with a oneOf member', version: '1' };
const jsonBody = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const jsonResponse = (schema: unknown, extra: Record<string, unknown> = {}) => ({
  description: 'ok',
  ...extra,
  content: { 'application/json': { schema } },
});

describe('an inline allOf with a oneOf member (workos/oagen#283)', () => {
  it('reads the reported request body and response like the component, with nothing dangling', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            tags: ['Pets'],
            requestBody: jsonBody(basePlusVariants),
            responses: { '200': jsonResponse(basePlusVariants) },
          },
        },
      },
      components: {
        schemas: {
          NewPet: basePlusVariants,
          Holder: { type: 'object', properties: { pet: basePlusVariants } },
        },
      },
    });
    const models = modelsByName(ir);
    const op = opsOf(ir)['createPet']!;
    const expected = ['name: string', 'ownerId?: string', 'shelterId?: string'];

    // The issue's output: `CreatePetRequest { name }`, `CreatePetResponse { name }`, `HolderPet { name }`.
    expect(fieldsOf(models['CreatePetRequest'])).toEqual(expected);
    expect(fieldsOf(models['CreatePetResponse'])).toEqual(expected);
    expect(fieldsOf(models['HolderPet'])).toEqual(expected);
    // The component read this way all along; it still does.
    expect(fieldsOf(models['NewPet'])).toEqual(expected);
    expect(op.requestBody).toEqual(model('CreatePetRequest'));
    expect(op.response).toEqual(model('CreatePetResponse'));
    expect(ir.models.map((m) => m.name).sort()).toEqual([
      'CreatePetRequest',
      'CreatePetResponse',
      'Holder',
      'HolderPet',
      'NewPet',
    ]);
    expectSound(ir, ['Holder', 'NewPet']);
  });

  it('merges the same way at every other inline site: items, map values, a $ref augmentation, a header, every response kind, a webhook payload', async () => {
    const anyOfVariants: SchemaObject = {
      allOf: [
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        {
          anyOf: [
            { type: 'object', properties: { ownerId: { type: 'string' } } },
            { type: 'object', properties: { shelterId: { type: 'string' } } },
          ],
        },
      ],
    };
    const refPlusVariants: SchemaObject = {
      allOf: [{ $ref: '#/components/schemas/Base' }, basePlusVariants.allOf![1]!],
    };
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            tags: ['Pets'],
            requestBody: jsonBody({
              type: 'object',
              properties: {
                items: { type: 'array', items: basePlusVariants },
                byKey: { type: 'object', additionalProperties: anyOfVariants },
                withRef: refPlusVariants,
              },
            }),
            responses: {
              '200': {
                description: 'ok',
                headers: { 'X-Meta': { schema: basePlusVariants } },
                content: {
                  'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
                  'application/vnd.pet+json': { schema: basePlusVariants },
                },
              },
              '404': jsonResponse(basePlusVariants, { description: 'missing' }),
              default: jsonResponse(basePlusVariants, { description: 'other' }),
            },
          },
        },
      },
      webhooks: {
        petAdopted: {
          post: {
            operationId: 'petAdopted',
            requestBody: { content: { 'application/json': { schema: basePlusVariants } } },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      components: {
        schemas: {
          Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          Holder: { type: 'object', properties: { pet: refPlusVariants } },
        },
      },
    });
    const models = modelsByName(ir);
    const op = opsOf(ir)['createPet']!;
    const expected = ['name: string', 'ownerId?: string', 'shelterId?: string'];

    expect(fieldsOf(models['CreatePetRequest'])).toEqual([
      'items?: array',
      'byKey?: map',
      'withRef?: CreatePetRequestWithRef',
    ]);
    expect(fieldsOf(models['CreatePetRequestItem'])).toEqual(expected);
    expect(fieldsOf(models['CreatePetRequestByKey'])).toEqual(expected);
    // `allOf: [{ $ref }, { oneOf: [...] }]` was typed as the bare `Base`,
    // the variants' fields dropped; a `oneOf` member with inline object
    // variants is an augmentation like a `properties` member is.
    expect(fieldsOf(models['CreatePetRequestWithRef'])).toEqual([
      'id: string',
      'ownerId?: string',
      'shelterId?: string',
    ]);
    expect(fieldsOf(models['HolderPet'])).toEqual(['id: string', 'ownerId?: string', 'shelterId?: string']);
    expect(collectResponseHeaders(op).map((h) => [h.name, h.type])).toEqual([['X-Meta', model('PetsXMeta')]]);
    expect(fieldsOf(models['PetsXMeta'])).toEqual(expected);
    expect(fieldsOf(models['CreatePetApplicationVndPetJsonResponse'])).toEqual(expected);
    expect(op.errors.map((e) => [e.statusCode, e.type])).toEqual([[404, model('CreatePetError404')]]);
    expect(fieldsOf(models['CreatePetError404'])).toEqual(expected);
    expect(op.defaultResponse?.type).toEqual(model('CreatePetDefaultResponse'));
    expect(fieldsOf(models['CreatePetDefaultResponse'])).toEqual(expected);
    expect(ir.webhooks?.map((w) => w.requestBody)).toEqual([model('PetAdoptedPayload')]);
    expect(fieldsOf(models['PetAdoptedPayload'])).toEqual(expected);
    expectSound(ir, ['Base', 'Holder']);
  });

  it('materializes what a variant property references under the merged model, and reads a variant through its own allOf and nested union', async () => {
    const schema: SchemaObject = {
      allOf: [
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        {
          oneOf: [
            {
              // A variant written as an `allOf` itself, with a nested union.
              allOf: [
                { type: 'object', properties: { owner: { type: 'object', properties: { id: { type: 'string' } } } } },
                {
                  oneOf: [{ properties: { phone: { type: 'string' } } }, { properties: { email: { type: 'string' } } }],
                },
              ],
            },
            { type: 'object', properties: { shelter: { type: 'object', properties: { code: { type: 'string' } } } } },
            { type: 'null' },
          ],
        },
      ],
    };
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: jsonBody(schema),
            responses: { '200': jsonResponse(schema) },
          },
        },
      },
      components: { schemas: { Holder: { type: 'object', properties: { pet: schema } } } },
    });
    const models = modelsByName(ir);
    for (const [name, child] of [
      ['CreatePetRequest', 'CreatePetRequest'],
      ['CreatePetResponse', 'CreatePetResponse'],
      ['HolderPet', 'HolderPet'],
    ]) {
      expect(fieldsOf(models[name!])).toEqual([
        'name: string',
        `owner?: ${child}Owner`,
        'phone?: string',
        'email?: string',
        `shelter?: ${child}Shelter`,
      ]);
      expect(fieldsOf(models[`${child}Owner`])).toEqual(['id?: string']);
      expect(fieldsOf(models[`${child}Shelter`])).toEqual(['code?: string']);
    }
    expectSound(ir, ['Holder']);
  });

  it("keeps a variant's required list off the merged model, and the base's on it", async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: jsonBody({
              allOf: [
                { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                {
                  oneOf: [
                    { type: 'object', properties: { ownerId: { type: 'string' } }, required: ['ownerId'] },
                    { type: 'object', properties: { shelterId: { type: 'string' } }, required: ['shelterId'] },
                  ],
                },
              ],
              required: ['name'],
            }),
            responses: { '204': { description: 'done' } },
          },
        },
      },
    });
    expect(fieldsOf(modelsByName(ir)['CreatePetRequest'])).toEqual([
      'name: string',
      'ownerId?: string',
      'shelterId?: string',
    ]);
    expectSound(ir, []);
  });

  it('takes the first declaration of a property several variants declare, and leaves a $ref variant to its component', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: jsonBody({
              allOf: [
                { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                {
                  oneOf: [
                    {
                      type: 'object',
                      properties: { kind: { type: 'string', const: 'owned' }, ownerId: { type: 'string' } },
                    },
                    {
                      type: 'object',
                      properties: { kind: { type: 'string', const: 'sheltered' }, shelterId: { type: 'string' } },
                    },
                  ],
                },
              ],
            }),
            responses: {
              '200': jsonResponse({
                allOf: [
                  { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                  { oneOf: [{ $ref: '#/components/schemas/Owner' }, { $ref: '#/components/schemas/Shelter' }] },
                ],
              }),
            },
          },
        },
      },
      components: {
        schemas: {
          Owner: { type: 'object', properties: { ownerId: { type: 'string' } } },
          Shelter: { type: 'object', properties: { shelterId: { type: 'string' } } },
        },
      },
    });
    const models = modelsByName(ir);
    const request = models['CreatePetRequest']!;
    expect(request.fields.map((f) => f.name)).toEqual(['name', 'kind', 'ownerId', 'shelterId']);
    expect(request.fields.find((f) => f.name === 'kind')).toMatchObject({
      required: false,
      type: { kind: 'literal', value: 'owned' },
    });
    // The `$ref` variants are not flattened: their components keep their fields.
    expect(fieldsOf(models['CreatePetResponse'])).toEqual(['name: string']);
    expectSound(ir, ['Owner', 'Shelter']);
  });

  it('merges a field nested under a discriminated component variant the same way', () => {
    const { models } = extractSchemas({
      Event: {
        allOf: [
          {
            type: 'object',
            properties: { id: { type: 'string' }, event: { type: 'string' } },
            required: ['id', 'event'],
          },
          {
            oneOf: [
              {
                type: 'object',
                properties: { event: { type: 'string', const: 'pet.created' }, data: basePlusVariants },
                required: ['event', 'data'],
              },
              {
                type: 'object',
                properties: {
                  event: { type: 'string', const: 'pet.deleted' },
                  data: { type: 'object', properties: { id: { type: 'string' } } },
                },
                required: ['event', 'data'],
              },
            ],
          },
        ],
      },
    });
    const byName = Object.fromEntries(models.map((m) => [m.name, m]));
    expect(byName['Event']?.discriminator).toEqual({
      property: 'event',
      mapping: { 'pet.created': 'PetCreated', 'pet.deleted': 'PetDeleted' },
    });
    expect(fieldsOf(byName['PetCreated'])).toEqual(['id: string', 'event: literal', 'data: PetCreatedData']);
    expect(fieldsOf(byName['PetCreatedData'])).toEqual(['name: string', 'ownerId?: string', 'shelterId?: string']);
  });

  it('merges a union variant that is itself such an allOf under the context the union gives it', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: jsonBody({
              type: 'object',
              properties: { pet: { oneOf: [{ type: 'string' }, basePlusVariants] } },
            }),
            responses: { '204': { description: 'done' } },
          },
        },
      },
    });
    const models = modelsByName(ir);
    const pet = models['CreatePetRequest']?.fields.find((f) => f.name === 'pet')?.type;
    expect(pet).toEqual({ kind: 'union', compositionKind: 'oneOf', variants: [str, model('CreatePetRequestPet')] });
    expect(fieldsOf(models['CreatePetRequestPet'])).toEqual(['name: string', 'ownerId?: string', 'shelterId?: string']);
    expectSound(ir, []);
  });
});

describe('the one reading of an inline allOf', () => {
  const base: SchemaObject = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
  const union: SchemaObject = {
    oneOf: [
      { type: 'object', properties: { ownerId: { type: 'string' } }, required: ['ownerId'] },
      { allOf: [{ properties: { shelterId: { type: 'string' } } }] },
      { $ref: '#/components/schemas/Other' },
      { type: 'null' },
    ],
  };
  const components: Record<string, SchemaObject> = {
    Base: {
      allOf: [{ $ref: '#/components/schemas/Root' }, { properties: { id: { type: 'string' } } }],
      required: ['id'],
    },
    Root: { type: 'object', properties: { root: { type: 'string' } }, required: ['root'] },
    Other: { type: 'object', properties: { other: { type: 'string' } } },
    Union: { oneOf: [{ properties: { fromUnion: { type: 'string' } } }] },
  };

  it('declaresInlineProperties sees properties through nested allOf members and union variants, never through a $ref', () => {
    expect(declaresInlineProperties(base)).toBe(true);
    expect(declaresInlineProperties(union)).toBe(true);
    expect(declaresInlineProperties({ allOf: [{ allOf: [base] }] })).toBe(true);
    expect(declaresInlineProperties({ anyOf: [{ type: 'string' }, { allOf: [union] }] })).toBe(true);
    expect(declaresInlineProperties({ $ref: '#/components/schemas/Base' })).toBe(false);
    expect(declaresInlineProperties({ oneOf: [{ $ref: '#/components/schemas/Other' }, { type: 'null' }] })).toBe(false);
    expect(declaresInlineProperties({ type: 'object' })).toBe(false);
    expect(declaresInlineProperties({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe(false);
    // `type: 'object'` alone makes an inline member, not a declaration of properties.
    expect(isInlineAllOfMember({ type: 'object' })).toBe(true);
    expect(isInlineAllOfMember(union)).toBe(true);
    expect(isInlineAllOfMember({ $ref: '#/components/schemas/Base', properties: { x: {} } })).toBe(false);
  });

  it('mergeAllOfMembers reads members, $ref chains, variants and their own allOf members in order, required from always-applying members only', () => {
    const merged = mergeAllOfMembers(
      {
        allOf: [{ $ref: '#/components/schemas/Base' }, base, union, { $ref: '#/components/schemas/Missing' }],
        properties: { own: { type: 'string' } },
        required: ['own'],
        description: 'wrapper',
        deprecated: true,
        minProperties: 1,
      },
      components,
    );
    expect(merged.properties.map((p) => `${p.name}${p.origin ? ` (${p.origin.name})` : ''}`)).toEqual([
      'own',
      'root (Base)',
      'id (Base)',
      'name',
      'ownerId',
      'shelterId',
    ]);
    // A component's own `required` is read before its `allOf` chain's, as its properties are.
    expect(merged.required).toEqual(['own', 'id', 'root', 'name']);
    expect(merged.resolvedRefs).toEqual(['#/components/schemas/Base', '#/components/schemas/Root']);
    expect(merged.unresolvedRefs).toEqual(['#/components/schemas/Missing']);
    expect(merged).toMatchObject({ description: 'wrapper', deprecated: true, constraints: { minProperties: 1 } });
  });

  it('mergeAllOfMembers leaves a union a $ref member carries to that component, and lists an unresolved $ref once', () => {
    const merged = mergeAllOfMembers(
      {
        allOf: [
          { $ref: '#/components/schemas/Union' },
          { $ref: '#/components/schemas/Missing' },
          { $ref: '#/components/schemas/Missing' },
          base,
        ],
      },
      components,
    );
    expect(merged.properties.map((p) => p.name)).toEqual(['name']);
    expect(merged.unresolvedRefs).toEqual(['#/components/schemas/Missing']);
  });

  it('schemaToTypeRef, mintedInlineNameEntries and the field extractor agree that a oneOf member mints the merged model', () => {
    const refPlusUnion: SchemaObject = { allOf: [{ $ref: '#/components/schemas/Base' }, union] };
    const unionPlusLimits: SchemaObject = { allOf: [union, { maxProperties: 3 }] };
    for (const schema of [basePlusVariants, refPlusUnion, unionPlusLimits]) {
      expect(schemaToTypeRef(schema, 'pet', 'Holder')).toEqual(model('HolderPet'));
      expect(mintedInlineNameEntries('pet', schema, 'Holder').map((e) => e.name)).toEqual(['HolderPet']);
      const results: Model[] = [];
      extractInlineModelsFromProperties({ properties: { pet: schema } }, results, 'Holder', components);
      expect(results.map((m) => m.name)).toEqual(['HolderPet']);
    }
    // A `$ref` member beside members that declare nothing inline stays a reference.
    const refOnly: SchemaObject = { allOf: [{ $ref: '#/components/schemas/Base' }, { description: 'doc' }] };
    expect(schemaToTypeRef(refOnly, 'pet', 'Holder')).toEqual(model('Base'));
    expect(mintedInlineNameEntries('pet', refOnly, 'Holder')).toEqual([]);
  });

  it('classifyAndExtractResponse builds the merged response model from the same reading', () => {
    const result = classifyAndExtractResponse(
      { allOf: [{ $ref: '#/components/schemas/Base' }, union] },
      'CreatePetResponse',
      components,
    );
    expect(result.response).toEqual(model('CreatePetResponse'));
    expect(fieldsOf(result.inlineModels[0])).toEqual([
      'root: string',
      'id: string',
      'ownerId?: string',
      'shelterId?: string',
    ]);
  });
});
