import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';
import {
  classifyInlineSchema,
  extractSchemas,
  schemaToTypeRef,
  typesAsUnknown,
  unwrapCollapsedWrappers,
  type SchemaObject,
} from '../../src/parser/schemas.js';
import { resolveBareSchema } from '../../src/parser/pagination.js';
import {
  allOfTypingMember,
  allOfWrapperLayer,
  annotatingAllOfMembers,
  combineDeclarations,
  declaresInlineProperties,
  declaresType,
  extractInlineModelsFromProperties,
  isInlineAllOfMember,
  mergeAllOfMembers,
  mintedInlineNameEntries,
  readInlineAllOf,
  unwrappedAllOfMember,
} from '../../src/parser/inline-models.js';
import {
  collectModelRefs,
  collectResponseBodyTypes,
  collectResponseHeaders,
  collectWebhookTypeRefs,
  type ApiSpec,
  type Field,
  type Model,
  type Operation,
  type TypeRef,
} from '../../src/ir/types.js';
// These tests pin the per-operation error body naming (`<Op>Error<code>`) that
// the collapse pass folds onto shared models by default
// (src/parser/collapse-error-bodies.ts); they parse with
// `collapseErrorBodies: false` to keep exercising it.

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
  for (const m of spec.models) {
    for (const f of m.fields) refs.push([`${m.name}.${f.name}`, f.type]);
    // A named union references its variant models through `variants`.
    for (const [i, variant] of (m.variants ?? []).entries()) refs.push([`${m.name} variant ${i}`, variant]);
  }
  return refs;
}

/**
 * The invariants every case holds: every model reference resolves, and every
 * model other than a component is referenced — through a type, or as the
 * target of a dispatcher's `discriminator.mapping`.
 */
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
  for (const m of spec.models) {
    for (const name of Object.values(m.discriminator?.mapping ?? {})) {
      referenced.add(name);
      if (!names.has(name)) unresolved.push(`${m.name}.discriminator → ${name}`);
    }
  }
  expect(unresolved).toEqual([]);
  expect([...names].filter((name) => !componentNames.includes(name) && !referenced.has(name)).sort()).toEqual([]);
}

/** Parse `spec` from a temp JSON file; `transformSpec` edits the loaded document first, as a consumer's hook would. */
async function parseTempSpec(
  spec: Record<string, unknown>,
  transformSpec?: (doc: Record<string, unknown>) => Record<string, unknown>,
): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-inline-allof-oneof-'));
  const file = path.join(dir, 'spec.json');
  try {
    await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
    return await parseSpec(file, { collapseErrorBodies: false, ...(transformSpec ? { transformSpec } : {}) });
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
            parameters: [{ name: 'filter', in: 'query', style: 'deepObject', schema: basePlusVariants }],
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
    expect(op.queryParams.map((p) => [p.name, p.type])).toEqual([['filter', model('PetsFilter')]]);
    expect(fieldsOf(models['PetsFilter'])).toEqual(expected);
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

  it("types a property variants pin to different consts as an enum of them, and flattens a $ref variant's component in (#398)", async () => {
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
    // Not `kind?: 'owned'`, the first variant's value alone: a `dog` body
    // would not type-check. The distinct declarations are read as the
    // `oneOf` of string consts they are, so the field is an inline enum.
    expect(request.fields.find((f) => f.name === 'kind')).toMatchObject({
      required: false,
      type: { kind: 'enum', name: 'CreatePetRequestKind' },
    });
    expect(ir.enums.find((e) => e.name === 'CreatePetRequestKind')?.values.map((v) => v.value)).toEqual([
      'owned',
      'sheltered',
    ]);
    // The `$ref` variants are flattened in as inline ones are, their
    // components keeping their own fields (#398: they were left out).
    expect(fieldsOf(models['CreatePetResponse'])).toEqual(['name: string', 'ownerId?: string', 'shelterId?: string']);
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
      // The `$ref` variant's component, flattened in as a branch (#398).
      'other',
    ]);
    // A component's own `required` is read before its `allOf` chain's, as its properties are.
    expect(merged.required).toEqual(['own', 'id', 'root', 'name']);
    expect(merged.resolvedRefs).toEqual(['#/components/schemas/Base', '#/components/schemas/Root']);
    expect(merged.unresolvedRefs).toEqual(['#/components/schemas/Missing']);
    expect(merged).toMatchObject({ description: 'wrapper', deprecated: true, constraints: { minProperties: 1 } });
  });

  it("mergeAllOfMembers flattens a union a $ref member's component carries, as its model does (#429), and lists an unresolved $ref once", () => {
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
    expect(merged.properties.map((p) => p.name)).toEqual(['fromUnion', 'name']);
    expect(merged.unresolvedRefs).toEqual(['#/components/schemas/Missing']);
  });

  it('reads a nullable union member as its one variant, applying as the member does, in the merge and in a component (MichaelDeBoey)', () => {
    const nullOf = (variant: SchemaObject): SchemaObject => ({ oneOf: [variant, { type: 'null' }] });
    const baseRef: SchemaObject = { $ref: '#/components/schemas/Base' };
    const flag: SchemaObject = { type: 'object', properties: { flag: { type: 'boolean' } }, required: ['flag'] };
    // The variant's `$ref` is followed, its `required` read, its properties always-applying.
    const merged = mergeAllOfMembers({ allOf: [nullOf(baseRef), nullOf(flag), base] }, components);
    expect(merged.properties.map((p) => `${p.name}${p.origin ? ` (${p.origin.name})` : ''}`)).toEqual([
      'root (Base)',
      'id (Base)',
      'flag',
      'name',
    ]);
    expect(merged.required).toEqual(['id', 'root', 'flag', 'name']);
    expect(merged.resolvedRefs).toEqual(['#/components/schemas/Base', '#/components/schemas/Root']);
    // A union with more than one non-null variant is still read as branches,
    // its `$ref` variant's component flattened in (#398) and its `required`
    // unread — the component's own included.
    const branches = mergeAllOfMembers(
      {
        allOf: [
          { oneOf: [baseRef, { properties: { x: { type: 'string' } }, required: ['x'] }, { type: 'null' }] },
          base,
        ],
      },
      components,
    );
    expect(branches.properties.map((p) => p.name)).toEqual(['root', 'id', 'x', 'name']);
    expect(branches.required).toEqual(['name']);
    // The component model of the same shape carries the same fields.
    const data: SchemaObject = { type: 'array', items: { type: 'string' } };
    const { models } = extractSchemas({
      Root: components.Root!,
      Base: components.Base!,
      Wrap: { allOf: [nullOf(baseRef), { type: 'object', properties: { data } }] },
    });
    expect(models.find((m) => m.name === 'Wrap')?.fields.map((f) => `${f.name}${f.required ? '' : '?'}`)).toEqual([
      'root',
      'id',
      'data?',
    ]);
  });

  it('types a name two members declare from the first declaration that declares a type, annotated by a typeless one (Greptile)', () => {
    const typed: SchemaObject = { type: 'object', properties: { x: { type: 'string' } } };
    const doc: SchemaObject = { type: 'object', properties: { x: { description: 'doc' } } };
    // Whichever is read first, `x` is a described string.
    for (const members of [
      [typed, doc],
      [doc, typed],
    ]) {
      const merged = mergeAllOfMembers({ allOf: members }, components);
      expect(merged.properties.map((p) => p.name)).toEqual(['x']);
      expect(merged.properties[0]!.schema).toEqual({ type: 'string', description: 'doc' });
    }
    // Two typing declarations keep the first, as written.
    const two = mergeAllOfMembers(
      { allOf: [typed, { type: 'object', properties: { x: { type: 'integer' } } }] },
      components,
    );
    expect(two.properties[0]!.schema).toBe(typed.properties!.x);
    // A component declaring the name typeless beside an `allOf` member that
    // types it — and the reverse — is a described string field either way.
    const { models } = extractSchemas({
      DocFirst: { properties: { x: { description: 'doc' } }, allOf: [typed] },
      TypeFirst: { properties: { x: { type: 'string' } }, allOf: [doc] },
    });
    for (const name of ['DocFirst', 'TypeFirst']) {
      const [field] = models.find((m) => m.name === name)!.fields;
      expect(field, name).toMatchObject({ name: 'x', type: { kind: 'primitive', type: 'string' }, description: 'doc' });
    }
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
      'other?: string',
    ]);
  });
});

describe('round 1: recursive components, shared schemas, conflicting variant declarations', () => {
  const ownerOrShelter: SchemaObject = {
    oneOf: [
      { type: 'object', properties: { ownerId: { type: 'string' } } },
      { type: 'object', properties: { shelterId: { type: 'string' } } },
    ],
  };
  /** A discriminated component whose `node.created` variant carries `data`. */
  const eventWithData = (data: SchemaObject): SchemaObject => ({
    allOf: [
      { type: 'object', properties: { id: { type: 'string' }, event: { type: 'string' } }, required: ['id', 'event'] },
      {
        oneOf: [
          {
            type: 'object',
            properties: { event: { type: 'string', const: 'node.created' }, data },
            required: ['event', 'data'],
          },
          {
            type: 'object',
            properties: {
              event: { type: 'string', const: 'node.deleted' },
              data: { type: 'object', properties: { id: { type: 'string' } } },
            },
            required: ['event', 'data'],
          },
        ],
      },
    ],
  });
  const withEvent = (schemas: Record<string, SchemaObject>, data: SchemaObject) => ({
    openapi: '3.1.0',
    info,
    paths: {
      '/events': {
        get: { operationId: 'getEvent', responses: { '200': jsonResponse({ $ref: '#/components/schemas/Event' }) } },
      },
    },
    components: { schemas: { ...schemas, Event: eventWithData(data) } },
  });

  it('terminates on a component that extends itself through a field, typing the inherited field as the model that exists', async () => {
    const ir = await parseWithoutWarnings(
      withEvent(
        {
          Node: {
            type: 'object',
            properties: {
              depth: { type: 'integer' },
              child: { allOf: [{ $ref: '#/components/schemas/Node' }, { properties: { note: { type: 'string' } } }] },
            },
          },
        },
        { allOf: [{ $ref: '#/components/schemas/Node' }, ownerOrShelter] },
      ),
    );
    const models = modelsByName(ir);
    expect(fieldsOf(models['NodeCreatedData'])).toEqual([
      'depth?: integer',
      'child?: NodeChild',
      'ownerId?: string',
      'shelterId?: string',
    ]);
    expect(fieldsOf(models['NodeChild'])).toEqual(['depth?: integer', 'child?: NodeChild', 'note?: string']);
    expect(models['NodeCreatedDataChild']).toBeUndefined();
    expectSound(ir, ['Event', 'Node']);
  });

  it('terminates on two components that extend each other, and reads a $ref chain three deep', async () => {
    const ir = await parseWithoutWarnings(
      withEvent(
        {
          A: {
            type: 'object',
            properties: {
              b: { allOf: [{ $ref: '#/components/schemas/B' }, { properties: { x: { type: 'string' } } }] },
            },
          },
          B: {
            type: 'object',
            properties: {
              a: { allOf: [{ $ref: '#/components/schemas/A' }, { properties: { y: { type: 'string' } } }] },
            },
          },
          C1: { type: 'object', properties: { c1: { type: 'string' } }, required: ['c1'] },
          C2: { allOf: [{ $ref: '#/components/schemas/C1' }, { properties: { c2: { type: 'string' } } }] },
          C3: {
            allOf: [{ $ref: '#/components/schemas/C2' }, { properties: { c3: { type: 'string' } } }],
            required: ['c3'],
          },
        },
        { allOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/C3' }, ownerOrShelter] },
      ),
    );
    const models = modelsByName(ir);
    // Members are read in order: `C3`'s `$ref` to `C2` — `C1`'s `c1`, then
    // `C2`'s own `c2` — before `C3`'s inline `c3` member; `required` is read
    // at every level (`c1` from `C1`, `c3` from `C3`'s own list).
    expect(fieldsOf(models['NodeCreatedData'])).toEqual([
      'b?: AB',
      'c1: string',
      'c2?: string',
      'c3: string',
      'ownerId?: string',
      'shelterId?: string',
    ]);
    expect(fieldsOf(models['AB'])).toEqual(['a?: BA', 'x?: string']);
    expect(fieldsOf(models['BA'])).toEqual(['b?: AB', 'y?: string']);
    expectSound(ir, ['A', 'B', 'C1', 'C2', 'C3', 'Event']);
  });

  it('keeps an inherited nested object typed as its component types it under a discriminated variant', async () => {
    const ir = await parseWithoutWarnings(
      withEvent(
        { Base: { type: 'object', properties: { meta: { type: 'object', properties: { tag: { type: 'string' } } } } } },
        { allOf: [{ $ref: '#/components/schemas/Base' }, ownerOrShelter] },
      ),
    );
    const models = modelsByName(ir);
    expect(fieldsOf(models['NodeCreatedData'])).toEqual(['meta?: BaseMeta', 'ownerId?: string', 'shelterId?: string']);
    expect(fieldsOf(models['BaseMeta'])).toEqual(['tag?: string']);
    expect(models['NodeCreatedDataMeta']).toBeUndefined();
    expectSound(ir, ['Base', 'Event']);
  });

  /** The base object reused, as a variant and as a member, in either order. */
  const sharedBody = (order: 'variant first' | 'member first'): SchemaObject => {
    const shared: SchemaObject = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    const union: SchemaObject = { oneOf: [shared, { type: 'object', properties: { other: { type: 'string' } } }] };
    return { allOf: order === 'variant first' ? [union, shared] : [shared, union] };
  };

  it.each(['variant first', 'member first'] as const)(
    'reads a schema object shared between a variant and a member once in each capacity (%s)',
    async (order) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // JSON cannot share an object, so `transformSpec` puts the shared one in.
        const ir = await parseTempSpec(
          {
            openapi: '3.1.0',
            info,
            paths: {
              '/pets': {
                post: {
                  operationId: 'createPet',
                  requestBody: jsonBody({ type: 'object' }),
                  responses: { '204': { description: 'done' } },
                },
              },
            },
          },
          (doc) => {
            const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
            paths['/pets']!['post']!['requestBody'] = jsonBody(sharedBody(order));
            return doc;
          },
        );
        expect(warnSpy.mock.calls).toEqual([]);
        // `id` is required: the member's reading is not skipped because the
        // same object was already read as a variant, or the other way round.
        expect(fieldsOf(modelsByName(ir)['CreatePetRequest'])).toEqual(['id: string', 'other?: string']);
        expectSound(ir, []);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it('reads a YAML anchor shared between a variant and a member once in each capacity', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-inline-allof-oneof-yaml-'));
    const file = path.join(dir, 'spec.yaml');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fs.writeFile(
        file,
        [
          'openapi: 3.1.0',
          'info: { title: anchors, version: "1" }',
          'paths:',
          '  /pets:',
          '    post:',
          '      operationId: createPet',
          '      requestBody:',
          '        required: true',
          '        content:',
          '          application/json:',
          '            schema:',
          '              allOf:',
          '                - oneOf:',
          '                    - &note',
          '                      type: object',
          '                      properties: { id: { type: string } }',
          '                      required: [id]',
          '                    - type: object',
          '                      properties: { other: { type: string } }',
          '                - *note',
          '      responses:',
          '        "204": { description: done }',
          '',
        ].join('\n'),
        'utf-8',
      );
      const ir = await parseSpec(file, { collapseErrorBodies: false });
      expect(warnSpy.mock.calls).toEqual([]);
      expect(fieldsOf(modelsByName(ir)['CreatePetRequest'])).toEqual(['id: string', 'other?: string']);
      expectSound(ir, []);
    } finally {
      warnSpy.mockRestore();
      await fs.rm(dir, { recursive: true });
    }
  });

  it('follows a $ref written under a variant when the same object is reached again as a member', () => {
    const ref: SchemaObject = { $ref: '#/components/schemas/Base' };
    const components: Record<string, SchemaObject> = {
      Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    };
    const union: SchemaObject = { oneOf: [ref, { properties: { other: { type: 'string' } } }] };
    for (const members of [
      [union, ref],
      [ref, union],
    ]) {
      const merged = mergeAllOfMembers({ allOf: members }, components);
      expect(merged.properties.map((p) => `${p.name}${p.origin ? ` (${p.origin.name})` : ''}`).sort()).toEqual([
        'id (Base)',
        'other',
      ]);
      expect(merged.required).toEqual(['id']);
      expect(merged.resolvedRefs).toEqual(['#/components/schemas/Base']);
    }
  });

  it("keeps an always-applying member's declaration over a variant's, whichever comes first", () => {
    const base: SchemaObject = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const union: SchemaObject = {
      oneOf: [{ properties: { name: { type: 'string', const: 'x' } } }, { properties: { size: { type: 'integer' } } }],
    };
    for (const members of [
      [base, union],
      [union, base],
    ]) {
      const merged = mergeAllOfMembers({ allOf: members }, undefined);
      expect(merged.properties.map((p) => [p.name, p.schema])).toEqual([
        ['name', { type: 'string' }],
        ['size', { type: 'integer' }],
      ]);
      expect(merged.required).toEqual(['name']);
    }
  });

  it('types a property variants declare the same way from one declaration, and differently as the union of them', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: jsonBody({
              allOf: [
                { type: 'object', properties: { name: { type: 'string' } } },
                {
                  oneOf: [
                    {
                      properties: {
                        same: { type: 'string', description: 'first' },
                        flag: { type: 'boolean', const: true },
                        shape: { type: 'object', properties: { radius: { type: 'number' } } },
                      },
                    },
                    {
                      properties: {
                        same: { type: 'string', description: 'second' },
                        flag: { type: 'boolean', const: false },
                        shape: { type: 'object', properties: { side: { type: 'number' } } },
                      },
                    },
                  ],
                },
              ],
            }),
            responses: { '204': { description: 'done' } },
          },
        },
      },
    });
    const models = modelsByName(ir);
    const request = models['CreatePetRequest']!;
    const typeOf = (field: string): TypeRef | undefined => request.fields.find((f) => f.name === field)?.type;
    // Documentation does not make a second shape: one declaration types the
    // field, without the description the two disagree on (#397).
    expect(request.fields.find((f) => f.name === 'same')).toMatchObject({ type: str });
    expect(request.fields.find((f) => f.name === 'same')?.description).toBeUndefined();
    // Two literals: a union of them, never the first alone.
    expect(typeOf('flag')).toEqual({
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [
        { kind: 'literal', value: true },
        { kind: 'literal', value: false },
      ],
    });
    // Two inline objects: a union of two variant models, named as any union
    // under a field is and materialized under those names.
    expect(typeOf('shape')).toEqual({
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [model('CreatePetRequestShape'), model('CreatePetRequestShapeWithSide')],
    });
    expect(fieldsOf(models['CreatePetRequestShape'])).toEqual(['radius?: number']);
    expect(fieldsOf(models['CreatePetRequestShapeWithSide'])).toEqual(['side?: number']);
    expectSound(ir, []);
  });
});

describe('round 2: keywords the declarations of a combined property agree on', () => {
  const createPet = (variants: SchemaObject[]) => ({
    openapi: '3.1.0',
    info,
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: jsonBody({
            allOf: [
              { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
              { oneOf: variants },
            ],
          }),
          responses: { '204': { description: 'done' } },
        },
      },
    },
  });

  it('lifts the flags, documentation and limits every declaration shares onto the combined field', async () => {
    const shared = { readOnly: true, description: 'The kind', deprecated: true, default: 'cat', maxLength: 3 };
    const ir = await parseWithoutWarnings(
      createPet([
        {
          properties: {
            kind: { type: 'string', const: 'cat', ...shared },
            secret: { type: 'string', const: 'a', writeOnly: true, example: 'a' },
          },
        },
        {
          properties: {
            kind: { type: 'string', const: 'dog', ...shared },
            secret: { type: 'integer', const: 1, writeOnly: true, example: 'a' },
          },
        },
      ]),
    );
    const request = modelsByName(ir)['CreatePetRequest']!;
    const kind = request.fields.find((f) => f.name === 'kind');
    // An enum of both consts — and read-only, deprecated, documented, defaulted
    // and limited as both declarations say, not a bare union of them.
    expect(kind).toMatchObject({
      type: { kind: 'enum', name: 'CreatePetRequestKind' },
      required: false,
      readOnly: true,
      deprecated: true,
      description: 'The kind',
      default: 'cat',
      constraints: { maxLength: 3 },
    });
    expect(kind?.writeOnly).toBeUndefined();
    expect(ir.enums.find((e) => e.name === 'CreatePetRequestKind')?.values.map((v) => v.value)).toEqual(['cat', 'dog']);
    expect(request.fields.find((f) => f.name === 'secret')).toMatchObject({
      type: {
        kind: 'union',
        compositionKind: 'oneOf',
        variants: [
          { kind: 'literal', value: 'a' },
          { kind: 'literal', value: 1 },
        ],
      },
      writeOnly: true,
      example: 'a',
    });
    expectSound(ir, []);
  });

  it('keeps a field read-only when both declarations say so but differ in type, with no const to make an enum', async () => {
    // Review on #338: `value` declared `readOnly: true` as a string in one
    // variant and as an integer in the other becomes a bare `oneOf` of the
    // two primitives; the flag both declare must sit on the combined field,
    // which is what the request builder reads, not only inside the branches.
    const ir = await parseWithoutWarnings(
      createPet([
        { properties: { value: { type: 'string', readOnly: true } } },
        { properties: { value: { type: 'integer', readOnly: true } } },
      ]),
    );
    const value = modelsByName(ir)['CreatePetRequest']!.fields.find((f) => f.name === 'value');
    expect(value).toMatchObject({
      type: {
        kind: 'union',
        compositionKind: 'oneOf',
        variants: [
          { kind: 'primitive', type: 'string' },
          { kind: 'primitive', type: 'integer' },
        ],
      },
      required: false,
      readOnly: true,
    });
    expect(value?.writeOnly).toBeUndefined();
    expectSound(ir, []);
  });

  it('leaves off a keyword the declarations disagree on, or only some declare', async () => {
    const ir = await parseWithoutWarnings(
      createPet([
        {
          properties: {
            mode: { type: 'string', const: 'x', readOnly: true },
            note: { type: 'string', const: 'p', description: 'first' },
            level: { type: 'integer', const: 1, deprecated: true, minimum: 1 },
            hidden: { type: 'string', const: 'h1', writeOnly: true },
          },
        },
        {
          properties: {
            mode: { type: 'string', const: 'y' },
            note: { type: 'string', const: 'q', description: 'second' },
            level: { type: 'integer', const: 2, deprecated: false, minimum: 2 },
            hidden: { type: 'string', const: 'h2', writeOnly: false },
          },
        },
      ]),
    );
    const request = modelsByName(ir)['CreatePetRequest']!;
    const field = (name: string) => request.fields.find((f) => f.name === name)!;
    expect(field('mode')).toMatchObject({ type: { kind: 'enum', name: 'CreatePetRequestMode' } });
    expect(field('mode').readOnly).toBeUndefined();
    expect(field('note').description).toBeUndefined();
    expect(field('level').deprecated).toBeUndefined();
    expect(field('level').constraints).toBeUndefined();
    expect(field('hidden').writeOnly).toBeUndefined();
    expectSound(ir, []);
  });

  it('moves a null admission any declaration makes, in either spelling, onto the combined field', async () => {
    const ir = await parseWithoutWarnings(
      createPet([
        {
          properties: {
            tag: { type: ['string', 'null'], const: 'a' },
            half: { type: ['string', 'null'], const: 'a' },
          },
        },
        {
          properties: {
            tag: { type: 'string', nullable: true, const: 'b' },
            half: { type: 'string', const: 'b' },
          },
        },
      ]),
    );
    const request = modelsByName(ir)['CreatePetRequest']!;
    const typeOf = (name: string) => request.fields.find((f) => f.name === name)?.type;
    // Both admit null: a nullable enum of both consts.
    expect(typeOf('tag')).toMatchObject({ kind: 'nullable', inner: { kind: 'enum', name: 'CreatePetRequestTag' } });
    expect(ir.enums.find((e) => e.name === 'CreatePetRequestTag')?.values.map((v) => v.value)).toEqual(['a', 'b']);
    // One admits null: the union admits it too — the enum the consts collapse
    // to would otherwise lose the `null` that branch allows.
    expect(typeOf('half')).toMatchObject({ kind: 'nullable', inner: { kind: 'enum', name: 'CreatePetRequestHalf' } });
    expect(ir.enums.find((e) => e.name === 'CreatePetRequestHalf')?.values.map((v) => v.value)).toEqual(['a', 'b']);
    expectSound(ir, []);
  });

  it('keeps every declaration as written inside the combined schema', () => {
    const cat: SchemaObject = { type: 'string', const: 'cat', readOnly: true, description: 'Kind' };
    const dog: SchemaObject = { type: 'string', const: 'dog', readOnly: true, description: 'Kind' };
    const merged = mergeAllOfMembers(
      { allOf: [{ oneOf: [{ properties: { kind: cat } }, { properties: { kind: dog } }] }] },
      undefined,
    );
    expect(merged.properties).toEqual([
      {
        name: 'kind',
        origin: null,
        schema: { readOnly: true, description: 'Kind', oneOf: [cat, dog] },
        conditional: true,
      },
    ]);
  });
});

describe('declarations that differ only in a keyword the field reads by agreement are one shape (#397)', () => {
  /** The issue's `POST /pets` 200 body: a required `name`, and `kind` declared once by each variant. */
  const createPet = (...kinds: SchemaObject[]) => ({
    openapi: '3.1.0',
    info,
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          responses: {
            '200': jsonResponse({
              allOf: [
                { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                { oneOf: kinds.map((kind) => ({ type: 'object', properties: { kind } })) },
              ],
            }),
          },
        },
      },
    },
  });
  const kindOf = (ir: ApiSpec) => modelsByName(ir)['CreatePetResponse']?.fields.find((f) => f.name === 'kind');

  it("types the issue's documents as one string with no keyword the declarations dispute, so none of them changes the field", async () => {
    const first: SchemaObject = { type: 'string', description: 'A' };
    const same = await parseWithoutWarnings(createPet(first, { type: 'string', description: 'B' }));
    // `A` and `B` disagree, so the description is nobody's.
    expect(kindOf(same)).toEqual({ name: 'kind', type: str, required: false });
    for (const second of [
      { type: 'string', readOnly: true },
      { type: 'string', writeOnly: true },
      { type: 'string', default: 'b' },
      { type: 'string', deprecated: true },
      { type: 'string', maxLength: 5 },
      { type: 'string', example: 'b' },
    ]) {
      const ir = await parseWithoutWarnings(createPet(first, second));
      // Not `(string | string)`, and without what only one declaration says.
      expect(kindOf(ir), JSON.stringify(second)).toEqual({ name: 'kind', type: str, required: false });
      // `oagen diff --old same.json --new <this>`: nothing changed.
      expect(diffSpecs(same, ir).changes, JSON.stringify(second)).toEqual([]);
    }
    expectSound(same, []);
  });

  it('keeps on one shape every keyword the declarations write the same way, as a union of shapes does', async () => {
    const shared = { description: 'The kind', readOnly: true, default: 'cat', deprecated: true, maxLength: 3 };
    const ir = await parseWithoutWarnings(
      createPet({ type: 'string', ...shared }, { type: 'string', ...shared, example: 'dog' }),
    );
    expect(kindOf(ir)).toEqual({
      name: 'kind',
      // The agreed limit is the type's too (#545).
      type: { ...str, constraints: { maxLength: 3 } },
      required: false,
      description: 'The kind',
      readOnly: true,
      default: 'cat',
      deprecated: true,
      constraints: { maxLength: 3 },
    });
    expectSound(ir, []);
  });

  it('gives an inline enum or object of one shape only what its declarations agree on, as one enum or model', async () => {
    const values = ['a', 'b'];
    const enumOf = (ir: ApiSpec) => ir.enums.find((e) => e.name === 'CreatePetResponseKind');
    const kindEnum = { kind: 'enum', name: 'CreatePetResponseKind', values };
    // The text and the `x-since` the two declarations dispute are neither the
    // field's nor the enum's.
    const disputed = await parseWithoutWarnings(
      createPet(
        { type: 'string', enum: values, description: 'A', 'x-since': '1.0' },
        { type: 'string', enum: values, description: 'B', 'x-since': '2.0' },
      ),
    );
    expect(kindOf(disputed)).toEqual({ name: 'kind', type: kindEnum, required: false });
    expect(enumOf(disputed)).not.toHaveProperty('description');
    expect(enumOf(disputed)).not.toHaveProperty('extensions');
    expect(enumOf(disputed)?.values.map((v) => v.value)).toEqual(values);
    // Text both write is both the field's and the enum's.
    const agreed = await parseWithoutWarnings(
      createPet(
        { type: 'string', enum: values, description: 'Kinds' },
        { type: 'string', enum: values, description: 'Kinds', readOnly: true },
      ),
    );
    expect(kindOf(agreed)).toEqual({ name: 'kind', type: kindEnum, required: false, description: 'Kinds' });
    expect(enumOf(agreed)?.description).toBe('Kinds');
    expectSound(disputed, []);

    // An object deprecated on one branch only is one live model, not a
    // deprecated `CreatePetResponseKind` beside a live `CreatePetResponseKind2`.
    const size = { type: 'object', properties: { size: { type: 'integer' } } };
    const objects = await parseWithoutWarnings(createPet({ ...size, deprecated: true, description: 'A' }, size));
    expect(kindOf(objects)).toEqual({ name: 'kind', type: model('CreatePetResponseKind'), required: false });
    expect(objects.models.map((m) => m.name).sort()).toEqual(['CreatePetResponse', 'CreatePetResponseKind']);
    expect(modelsByName(objects)['CreatePetResponseKind']).toEqual({
      name: 'CreatePetResponseKind',
      fields: [{ name: 'size', type: { kind: 'primitive', type: 'integer' }, required: false }],
    });
    expectSound(objects, []);
  });

  it('reads each shape once in a union of shapes, whatever keyword the field reads its repeats differ in', async () => {
    const ir = await parseWithoutWarnings(
      createPet(
        { type: 'string', readOnly: true },
        { type: 'string', default: 'b' },
        { type: 'integer', readOnly: true },
      ),
    );
    expect(kindOf(ir)).toEqual({
      name: 'kind',
      type: { kind: 'union', compositionKind: 'oneOf', variants: [str, { kind: 'primitive', type: 'integer' }] },
      required: false,
    });
    expectSound(ir, []);
  });

  it('keeps a shape deprecated in a union of shapes only when every declaration of the shape is (#484 review)', async () => {
    const live: SchemaObject = { type: 'object', properties: { t: { type: 'string' } } };
    const deprecated: SchemaObject = { ...live, deprecated: true };
    const integer: SchemaObject = { type: 'integer' };
    const kindModel = model('CreatePetResponseKind');
    const union = {
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [kindModel, { kind: 'primitive', type: 'integer' }],
    };
    // Beside a third shape, the union branch: one live `CreatePetResponseKind`
    // whichever object comes first, and no `CreatePetResponseKind2`.
    const deprecatedFirst = await parseWithoutWarnings(createPet(deprecated, live, integer));
    const liveFirst = await parseWithoutWarnings(createPet(live, deprecated, integer));
    for (const ir of [deprecatedFirst, liveFirst]) {
      expect(kindOf(ir)).toEqual({ name: 'kind', type: union, required: false });
      expect(ir.models.map((m) => m.name).sort()).toEqual(['CreatePetResponse', 'CreatePetResponseKind']);
      expect(modelsByName(ir)['CreatePetResponseKind']).not.toHaveProperty('deprecated');
      expectSound(ir, []);
    }
    // `oagen diff` between the two orders: nothing changed.
    expect(diffSpecs(deprecatedFirst, liveFirst).changes).toEqual([]);
    // Without the third shape, the single-shape branch reads the same way.
    const deprecatedFirstAlone = await parseWithoutWarnings(createPet(deprecated, live));
    const liveFirstAlone = await parseWithoutWarnings(createPet(live, deprecated));
    for (const ir of [deprecatedFirstAlone, liveFirstAlone]) {
      expect(kindOf(ir)).toEqual({ name: 'kind', type: kindModel, required: false });
      expect(modelsByName(ir)['CreatePetResponseKind']).not.toHaveProperty('deprecated');
    }
    expect(diffSpecs(deprecatedFirstAlone, liveFirstAlone).changes).toEqual([]);
    // Every declaration of the shape deprecated: so is its variant model.
    const both = await parseWithoutWarnings(createPet(deprecated, { ...deprecated, description: 'Old' }, integer));
    expect(kindOf(both)).toEqual({ name: 'kind', type: union, required: false });
    expect(modelsByName(both)['CreatePetResponseKind']?.deprecated).toBe(true);
  });

  it('keeps an enum member deprecated only when every declaration of its const is (#484 review)', async () => {
    const cat: SchemaObject = { type: 'string', const: 'cat' };
    const deprecatedCat: SchemaObject = { ...cat, deprecated: true };
    const dog: SchemaObject = { type: 'string', const: 'dog' };
    const membersOf = (ir: ApiSpec) =>
      ir.enums
        .find((e) => e.name === 'CreatePetResponseKind')
        ?.values.map((v) => `${v.value}${v.deprecated ? ' (deprecated)' : ''}`);
    const deprecatedFirst = await parseWithoutWarnings(createPet(deprecatedCat, cat, dog));
    const liveFirst = await parseWithoutWarnings(createPet(cat, deprecatedCat, dog));
    for (const ir of [deprecatedFirst, liveFirst]) {
      expect(kindOf(ir)).toEqual({
        name: 'kind',
        type: { kind: 'enum', name: 'CreatePetResponseKind', values: ['cat', 'dog'] },
        required: false,
      });
      expect(membersOf(ir)).toEqual(['cat', 'dog']);
    }
    expect(diffSpecs(deprecatedFirst, liveFirst).changes).toEqual([]);
    const both = await parseWithoutWarnings(createPet(deprecatedCat, deprecatedCat, dog));
    expect(membersOf(both)).toEqual(['cat (deprecated)', 'dog']);
    // At the schema level, with and without the third declaration: the first
    // declaration of the shape, less the `deprecated` the shape disputes.
    const mergedKind = (...kinds: SchemaObject[]) =>
      mergeAllOfMembers({ allOf: [{ oneOf: kinds.map((kind) => ({ properties: { kind } })) }] }, undefined)
        .properties[0]?.schema;
    expect(mergedKind(deprecatedCat, cat, dog)).toEqual({ oneOf: [cat, dog] });
    expect(mergedKind(cat, deprecatedCat, dog)).toEqual({ oneOf: [cat, dog] });
    expect(mergedKind(deprecatedCat, cat)).toEqual(cat);
    expect(mergedKind(cat, deprecatedCat)).toEqual(cat);
    expect(mergedKind(deprecatedCat, deprecatedCat, dog)).toEqual({ oneOf: [deprecatedCat, dog] });
  });

  it('ignores the lifted keywords inside array items and map values, where the IR carries none (#484 review)', async () => {
    const strings: SchemaObject = { type: 'array', items: { type: 'string' } };
    const stringArray = { kind: 'array', items: str };
    const plain = await parseWithoutWarnings(createPet(strings, strings));
    expect(kindOf(plain)).toEqual({ name: 'kind', type: stringArray, required: false });
    for (const items of [
      { type: 'string', readOnly: true },
      { type: 'string', maxLength: 5 },
      { type: 'string', default: 'a', description: 'One' },
    ]) {
      const other: SchemaObject = { type: 'array', items };
      for (const declarations of [
        [strings, other],
        [other, strings],
      ]) {
        const ir = await parseWithoutWarnings(createPet(...declarations));
        // Not `(string[] | string[])`.
        expect(kindOf(ir), JSON.stringify(declarations)).toEqual({ name: 'kind', type: stringArray, required: false });
        // `oagen diff` against the two plain declarations: nothing changed.
        expect(diffSpecs(plain, ir).changes, JSON.stringify(declarations)).toEqual([]);
      }
    }
    // At any depth.
    const nested = await parseWithoutWarnings(
      createPet(
        { type: 'array', items: strings },
        { type: 'array', items: { type: 'array', items: { type: 'string', readOnly: true } } },
      ),
    );
    expect(kindOf(nested)?.type).toEqual({ kind: 'array', items: stringArray });
    // Map values the same way.
    const map: SchemaObject = { type: 'object', additionalProperties: { type: 'string' } };
    const maps = await parseWithoutWarnings(createPet(map, map));
    const readOnlyValues = await parseWithoutWarnings(
      createPet(map, { type: 'object', additionalProperties: { type: 'string', readOnly: true } }),
    );
    expect(kindOf(maps)).toEqual({ name: 'kind', type: { kind: 'map', valueType: str }, required: false });
    expect(kindOf(readOnlyValues)).toEqual(kindOf(maps));
    expect(diffSpecs(maps, readOnlyValues).changes).toEqual([]);
    // Items of an object shape deprecated on one branch only: one live
    // model, whichever declaration comes first.
    const object: SchemaObject = { type: 'object', properties: { t: { type: 'string' } } };
    const deprecatedFirst = await parseWithoutWarnings(
      createPet({ type: 'array', items: { ...object, deprecated: true } }, { type: 'array', items: object }),
    );
    const liveFirst = await parseWithoutWarnings(
      createPet({ type: 'array', items: object }, { type: 'array', items: { ...object, deprecated: true } }),
    );
    for (const ir of [deprecatedFirst, liveFirst]) {
      expect(kindOf(ir)?.type).toEqual({ kind: 'array', items: model('CreatePetResponseKind') });
      expect(modelsByName(ir)['CreatePetResponseKind']).not.toHaveProperty('deprecated');
      expectSound(ir, []);
    }
    expect(diffSpecs(deprecatedFirst, liveFirst).changes).toEqual([]);
    // Inside `properties` a field reads them, so there they still make a shape.
    const withT = (t: SchemaObject): SchemaObject => ({ type: 'object', properties: { t } });
    const fields = await parseWithoutWarnings(
      createPet(withT({ type: 'string' }), withT({ type: 'string', readOnly: true })),
    );
    expect(fields.models.map((m) => m.name).sort()).toEqual([
      'CreatePetResponse',
      'CreatePetResponseKind',
      'CreatePetResponseKind2',
    ]);
    expectSound(fields, []);
  });

  it('drops from one shape only the lifted keywords the declarations dispute, and still tells apart what types them', () => {
    const mergedKind = (...kinds: SchemaObject[]) =>
      mergeAllOfMembers({ allOf: [{ oneOf: kinds.map((kind) => ({ properties: { kind } })) }] }, undefined).properties;
    expect(
      mergedKind(
        { type: 'string', format: 'uuid', readOnly: true, description: 'A' },
        { type: 'string', format: 'uuid', readOnly: true, description: 'B', default: 'x' },
      ),
    ).toEqual([
      { name: 'kind', origin: null, schema: { type: 'string', format: 'uuid', readOnly: true }, conditional: true },
    ]);
    // A `format` types the declaration, as a `const` or an `enum` does: still two shapes.
    const uuid: SchemaObject = { type: 'string', format: 'uuid', readOnly: true };
    const plain: SchemaObject = { type: 'string', readOnly: true, description: 'Plain' };
    expect(mergedKind(uuid, plain)).toEqual([
      { name: 'kind', origin: null, schema: { readOnly: true, oneOf: [uuid, plain] }, conditional: true },
    ]);
  });
});

describe('a const only a variant declares names no inline allOf response body (#396)', () => {
  /** The issue's `POST /pets` 200 body: the `allOf` of `members`, beside `schemas` as components. */
  const createPet = (members: SchemaObject[], schemas?: Record<string, SchemaObject>) => ({
    openapi: '3.1.0',
    info,
    paths: {
      '/pets': {
        post: { operationId: 'createPet', responses: { '200': jsonResponse({ allOf: members }) } },
      },
    },
    ...(schemas && { components: { schemas } }),
  });
  const object = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', properties });
  const text = (value?: string): SchemaObject => ({ type: 'string', ...(value !== undefined && { const: value }) });
  /** The issue's always-applying member: a required `name`. */
  const base: SchemaObject = { ...object({ name: text() }), required: ['name'] };
  const responseOf = (ir: ApiSpec) => opsOf(ir)['createPet']!.response;

  it("names the issue's documents after the operation, so a const another variant adds renames nothing", async () => {
    // object.json: was `CreatePetPet`, renamed off the component `Pet` with a warning.
    const pet = await parseWithoutWarnings(
      createPet([base, { oneOf: [object({ object: text('pet') }), object({ x: text() })] }], {
        Pet: object({ other: text() }),
      }),
    );
    expect(responseOf(pet)).toEqual(model('CreatePetResponse'));
    expect(pet.models.map((m) => m.name)).toEqual(['Pet', 'CreatePetResponse']);
    expect(fieldsOf(modelsByName(pet)['CreatePetResponse'])).toEqual([
      'name: string',
      'object?: literal',
      'x?: string',
    ]);
    expectSound(pet, ['Pet']);
    // kind-old.json was `Cat`; kind-new.json, `dog` added to the other variant, `CreatePetResponse`.
    const cat = object({ kind: text('cat'), meow: text() });
    const kindOld = await parseWithoutWarnings(createPet([base, { oneOf: [cat, object({ bark: text() })] }]));
    const kindNew = await parseWithoutWarnings(
      createPet([base, { oneOf: [cat, object({ kind: text('dog'), bark: text() })] }]),
    );
    for (const ir of [kindOld, kindNew]) {
      expect(responseOf(ir)).toEqual(model('CreatePetResponse'));
      expect(ir.models.map((m) => m.name)).toEqual(['CreatePetResponse']);
      expect(modelsByName(ir)['CreatePetResponse']?.fields.map((f) => f.name)).toEqual([
        'name',
        'kind',
        'meow',
        'bark',
      ]);
      expectSound(ir, []);
    }
    // `oagen diff --old kind-old.json --new kind-new.json`: the operation is
    // unchanged and its model is modified, not removed (`Cat`) beside one
    // added; the model's `kind` widens from the literal `cat` to an enum of both.
    expect(diffSpecs(kindOld, kindNew).changes).toMatchObject([
      { kind: 'model-modified', name: 'CreatePetResponse', fieldChanges: [{ fieldName: 'kind' }] },
      { kind: 'enum-added', name: 'CreatePetResponseKind' },
    ]);
  });

  it('still names the body after a const every instance carries, and reads the list envelope off every property', async () => {
    const cat = object({ kind: text('cat') });
    const bark = object({ bark: text() });
    // An always-applying member's const, before or after the variants, and a
    // nullable member's one variant's, which applies as the member does.
    for (const members of [
      [{ ...base, properties: { ...base.properties, object: text('pet') } }, { oneOf: [cat, bark] }],
      [{ oneOf: [cat, bark] }, object({ object: text('pet') }), base],
      [base, { oneOf: [object({ object: text('pet') }), { type: 'null' }] }, { oneOf: [cat, bark] }],
    ]) {
      const ir = await parseWithoutWarnings(createPet(members));
      expect(responseOf(ir)).toEqual(model('Pet'));
      const names = modelsByName(ir)['Pet']?.fields.map((f) => f.name);
      expect(names?.sort()).toEqual(['bark', 'kind', 'name', 'object']);
      expectSound(ir, []);
    }
    // A const every variant declares alike still holds on a branch only: a
    // variant added without it would rename the body.
    const both = await parseWithoutWarnings(
      createPet([
        base,
        { oneOf: [object({ object: text('pet'), a: text() }), object({ object: text('pet'), b: text() })] },
      ]),
    );
    expect(responseOf(both)).toEqual(model('CreatePetResponse'));
    expect(fieldsOf(modelsByName(both)['CreatePetResponse'])).toEqual([
      'name: string',
      'object?: literal',
      'a?: string',
      'b?: string',
    ]);
    // A member's `object: list` beside a data array and a stop field only
    // variants declare is a list envelope's kind, never the body's name (#418).
    const page = object({ data: { type: 'array', items: text() }, has_more: { type: 'boolean' } });
    const list = await parseWithoutWarnings(createPet([object({ object: text('list') }), { oneOf: [page, bark] }]));
    expect(responseOf(list)).toEqual(model('CreatePetResponse'));
  });

  it('marks a property only variants declare as conditional, and one a member declares as not', () => {
    const union: SchemaObject = { oneOf: [object({ name: text('x'), kind: text('cat') }), object({ bark: text() })] };
    for (const members of [
      [base, union],
      [union, base],
    ]) {
      const merged = mergeAllOfMembers({ allOf: members }, undefined);
      expect(merged.properties.map((p) => `${p.name}${p.conditional ? ' (conditional)' : ''}`).sort()).toEqual([
        'bark (conditional)',
        'kind (conditional)',
        'name',
      ]);
    }
  });
});

describe('properties are matched by own name', () => {
  it('keeps a property named constructor, toString or __proto__ through the merge, from a member or a variant', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: jsonBody({
              allOf: [
                { type: 'object', properties: { constructor: { type: 'string' } }, required: ['constructor'] },
                {
                  oneOf: [
                    { properties: { toString: { type: 'string' } } },
                    // A computed key: the plain `__proto__: …` spelling would set the literal's prototype.
                    { properties: { ['__proto__']: { type: 'object', properties: { x: { type: 'string' } } } } },
                  ],
                },
              ],
            }),
            responses: { '204': { description: 'done' } },
          },
        },
      },
    });
    const models = modelsByName(ir);
    expect(fieldsOf(models['CreatePetRequest'])).toEqual([
      'constructor: string',
      'toString?: string',
      '__proto__?: CreatePetRequestProto',
    ]);
    expect(fieldsOf(models['CreatePetRequestProto'])).toEqual(['x?: string']);
    expectSound(ir, []);
  });
});

describe('round 3: a model is built exactly when the reading names one', () => {
  const emptyObject: SchemaObject = { type: 'object', properties: {} };
  /** The reported shape: a union member whose only variant is an empty object, beside a documentation-only member. */
  const emptyUnionPlusDoc: SchemaObject = { allOf: [{ oneOf: [emptyObject] }, { description: 'Pet' }] };
  const base: SchemaObject = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

  it('builds the empty model an allOf with only an empty properties: {} names, at every depth', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: jsonBody({
              type: 'object',
              properties: {
                // The empty object as the sole variant: the base's fields only.
                sole: { allOf: [base, { oneOf: [emptyObject] }] },
                // Beside a `$ref` variant, flattened in as the empty object is (#398).
                besideRef: { allOf: [base, { oneOf: [{ $ref: '#/components/schemas/Owner' }, emptyObject] }] },
                // Nested two deep: the inner empty model is built too.
                outer: { allOf: [{ oneOf: [{ properties: { inner: emptyUnionPlusDoc } }] }, { description: 'Outer' }] },
              },
            }),
            responses: { '200': jsonResponse(emptyUnionPlusDoc) },
          },
        },
      },
      components: {
        schemas: {
          Owner: { type: 'object', properties: { ownerId: { type: 'string' } } },
          Holder: { type: 'object', properties: { pet: emptyUnionPlusDoc } },
        },
      },
    });
    const models = modelsByName(ir);
    expect(fieldsOf(models['Holder'])).toEqual(['pet?: HolderPet']);
    // Built with no fields; the `description` is the member's, which declares
    // no type and so is part of the wrapper, as the model reads it (#555 review).
    expect(models['HolderPet']).toMatchObject({ fields: [], description: 'Pet' });
    expect(fieldsOf(models['CreatePetRequest'])).toEqual([
      'sole?: CreatePetRequestSole',
      'besideRef?: CreatePetRequestBesideRef',
      'outer?: CreatePetRequestOuter',
    ]);
    expect(fieldsOf(models['CreatePetRequestSole'])).toEqual(['name: string']);
    expect(fieldsOf(models['CreatePetRequestBesideRef'])).toEqual(['name: string', 'ownerId?: string']);
    expect(fieldsOf(models['CreatePetRequestOuter'])).toEqual(['inner?: CreatePetRequestOuterInner']);
    expect(models['CreatePetRequestOuterInner']?.fields).toEqual([]);
    expect(opsOf(ir)['createPet']?.response).toEqual(model('CreatePetResponse'));
    expect(models['CreatePetResponse']?.fields).toEqual([]);
    expectSound(ir, ['Holder', 'Owner']);
  });

  /** A discriminated component whose `node.created` variant carries `data`. */
  const eventWithData = (data: SchemaObject): SchemaObject => ({
    allOf: [
      { type: 'object', properties: { id: { type: 'string' }, event: { type: 'string' } }, required: ['id', 'event'] },
      {
        oneOf: [
          {
            type: 'object',
            properties: { event: { type: 'string', const: 'node.created' }, data },
            required: ['event', 'data'],
          },
          {
            type: 'object',
            properties: {
              event: { type: 'string', const: 'node.deleted' },
              data: { type: 'object', properties: { id: { type: 'string' } } },
            },
            required: ['event', 'data'],
          },
        ],
      },
    ],
  });
  const withEvent = (schemas: Record<string, SchemaObject>, data: SchemaObject) => ({
    openapi: '3.1.0',
    info,
    paths: {
      '/events': {
        get: { operationId: 'getEvent', responses: { '200': jsonResponse({ $ref: '#/components/schemas/Event' }) } },
      },
    },
    components: { schemas: { ...schemas, Event: eventWithData(data) } },
  });
  const baseComponent: Record<string, SchemaObject> = {
    Base: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] },
  };

  it('mints nothing under a discriminated variant for an allOf of $ref members only', async () => {
    for (const data of [
      { allOf: [{ $ref: '#/components/schemas/Base' }] },
      { allOf: [{ $ref: '#/components/schemas/Base' }, { description: 'documented' }] },
    ] as SchemaObject[]) {
      const ir = await parseWithoutWarnings(withEvent(baseComponent, data));
      const models = modelsByName(ir);
      expect(fieldsOf(models['NodeCreated'])).toEqual(['id: string', 'event: literal', 'data: Base']);
      expect(models['NodeCreatedData']).toBeUndefined();
      expectSound(ir, ['Base', 'Event']);
    }
  });

  it('leaves a declared component named like the nested field untouched when the field is a plain reference', async () => {
    const ir = await parseWithoutWarnings(
      withEvent(
        { ...baseComponent, NodeCreatedData: { type: 'object', properties: { only: { type: 'string' } } } },
        { allOf: [{ $ref: '#/components/schemas/Base' }] },
      ),
    );
    const models = modelsByName(ir);
    expect(fieldsOf(models['NodeCreated'])).toEqual(['id: string', 'event: literal', 'data: Base']);
    // Fewer fields than `Base`: an unused merged copy would have replaced it.
    expect(fieldsOf(models['NodeCreatedData'])).toEqual(['only?: string']);
    expectSound(ir, ['Base', 'Event', 'NodeCreatedData']);
  });

  it('still mints the merged model for a $ref augmented by an inline object, and unwraps a lone inline member', async () => {
    const augmented = await parseWithoutWarnings(
      withEvent(baseComponent, {
        allOf: [{ $ref: '#/components/schemas/Base' }, { properties: { x: { type: 'string' } } }],
      }),
    );
    expect(fieldsOf(modelsByName(augmented)['NodeCreated'])).toEqual([
      'id: string',
      'event: literal',
      'data: NodeCreatedData',
    ]);
    expect(fieldsOf(modelsByName(augmented)['NodeCreatedData'])).toEqual(['a: string', 'b?: string', 'x?: string']);
    expectSound(augmented, ['Base', 'Event']);

    const lone = await parseWithoutWarnings(
      withEvent(baseComponent, { allOf: [{ type: 'object', properties: { y: { type: 'string' } }, required: ['y'] }] }),
    );
    expect(fieldsOf(modelsByName(lone)['NodeCreated'])).toEqual([
      'id: string',
      'event: literal',
      'data: NodeCreatedData',
    ]);
    expect(fieldsOf(modelsByName(lone)['NodeCreatedData'])).toEqual(['y: string']);
    expectSound(lone, ['Base', 'Event']);
  });

  it('readInlineAllOf is the one reading', () => {
    const ref: SchemaObject = { $ref: '#/components/schemas/Base' };
    expect(readInlineAllOf([ref])).toBe('reference');
    expect(readInlineAllOf([ref, { description: 'doc' }])).toBe('reference');
    expect(readInlineAllOf([ref, { type: 'object' }])).toBe('merged');
    expect(readInlineAllOf([ref, { oneOf: [emptyObject] }])).toBe('merged');
    expect(readInlineAllOf([base])).toBe('unwrapped');
    expect(readInlineAllOf([{ oneOf: [emptyObject] }, { description: 'Pet' }])).toBe('merged');
    expect(readInlineAllOf([{ minProperties: 1 }, { description: 'doc' }])).toBe('reference');
    expect(schemaToTypeRef({ allOf: [ref, { description: 'doc' }] }, 'pet', 'Holder')).toEqual(model('Base'));
    expect(schemaToTypeRef(emptyUnionPlusDoc, 'pet', 'Holder')).toEqual(model('HolderPet'));
    const results: Model[] = [];
    extractInlineModelsFromProperties({ properties: { pet: emptyUnionPlusDoc } }, results, 'Holder', {});
    expect(results.map((m) => [m.name, m.fields.length])).toEqual([['HolderPet', 0]]);
  });
});

describe('round 4: every shape under a discriminated variant is built as the field extractor builds it', () => {
  /** The reported shape: a `$ref` augmented by a `oneOf` member, as array items or map values. */
  const refPlusVariant: SchemaObject = {
    allOf: [{ $ref: '#/components/schemas/Base' }, { oneOf: [{ properties: { x: { type: 'string' } } }] }],
  };
  const eventWithData = (data: SchemaObject): SchemaObject => ({
    allOf: [
      { type: 'object', properties: { id: { type: 'string' }, event: { type: 'string' } }, required: ['id', 'event'] },
      {
        oneOf: [
          {
            type: 'object',
            properties: { event: { type: 'string', const: 'node.created' }, data },
            required: ['event', 'data'],
          },
          {
            type: 'object',
            properties: {
              event: { type: 'string', const: 'node.deleted' },
              data: { type: 'object', properties: { id: { type: 'string' } } },
            },
            required: ['event', 'data'],
          },
        ],
      },
    ],
  });
  const withEvent = (data: SchemaObject) => ({
    openapi: '3.1.0',
    info,
    paths: {
      '/events': {
        get: { operationId: 'getEvent', responses: { '200': jsonResponse({ $ref: '#/components/schemas/Event' }) } },
      },
    },
    components: {
      schemas: {
        Base: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        Event: eventWithData(data),
      },
    },
  });

  it('builds the merged model array items and map values reference, nested two deep', async () => {
    const ir = await parseWithoutWarnings(
      withEvent({
        type: 'object',
        properties: {
          items: { type: 'array', items: refPlusVariant },
          byKey: { type: 'object', additionalProperties: refPlusVariant },
          deeper: {
            type: 'object',
            properties: { items: { type: 'array', items: refPlusVariant } },
          },
        },
      }),
    );
    const models = modelsByName(ir);
    expect(fieldsOf(models['NodeCreatedData'])).toEqual([
      'items?: array',
      'byKey?: map',
      'deeper?: NodeCreatedDataDeeper',
    ]);
    const typeOf = (name: string) => models['NodeCreatedData']?.fields.find((f) => f.name === name)?.type;
    expect(typeOf('items')).toEqual({ kind: 'array', items: model('NodeCreatedDataItem') });
    expect(typeOf('byKey')).toEqual({ kind: 'map', valueType: model('NodeCreatedDataByKey') });
    expect(fieldsOf(models['NodeCreatedDataItem'])).toEqual(['a: string', 'x?: string']);
    expect(fieldsOf(models['NodeCreatedDataByKey'])).toEqual(['a: string', 'x?: string']);
    expect(fieldsOf(models['NodeCreatedDataDeeper'])).toEqual(['items?: array']);
    expect(fieldsOf(models['NodeCreatedDataDeeperItem'])).toEqual(['a: string', 'x?: string']);
    expectSound(ir, ['Base', 'Event']);
  });

  it('builds the merged model a union variant and an untyped nested object reference', async () => {
    const ir = await parseWithoutWarnings(
      withEvent({
        type: 'object',
        properties: {
          owner: { oneOf: [{ type: 'string' }, refPlusVariant] },
          // No `type`: still an inline object, as `schemaToTypeRef` types it.
          plain: { properties: { y: { type: 'string' } } },
          nullableItems: { type: ['array', 'null'], items: { oneOf: [refPlusVariant, { type: 'null' }] } },
        },
      }),
    );
    const models = modelsByName(ir);
    const typeOf = (name: string) => models['NodeCreatedData']?.fields.find((f) => f.name === name)?.type;
    expect(typeOf('owner')).toEqual({
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [str, model('NodeCreatedDataOwner')],
    });
    expect(fieldsOf(models['NodeCreatedDataOwner'])).toEqual(['a: string', 'x?: string']);
    expect(typeOf('plain')).toEqual(model('NodeCreatedDataPlain'));
    expect(fieldsOf(models['NodeCreatedDataPlain'])).toEqual(['y?: string']);
    expect(typeOf('nullableItems')).toEqual({
      kind: 'nullable',
      inner: { kind: 'array', items: { kind: 'nullable', inner: model('NodeCreatedDataNullableItem') } },
    });
    expect(fieldsOf(models['NodeCreatedDataNullableItem'])).toEqual(['a: string', 'x?: string']);
    expectSound(ir, ['Base', 'Event']);
  });
});

describe('a dispatcher detected through a nullable member builds its variants (Greptile, #308 merge round)', () => {
  const tagged = (tag: string): SchemaObject => ({
    type: 'object',
    properties: { kind: { type: 'string', const: tag }, [tag]: { type: 'string' } },
    required: ['kind'],
  });
  const base: SchemaObject = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  const union = (keyword: 'oneOf' | 'anyOf'): SchemaObject => ({ [keyword]: [tagged('a'), tagged('b')] });
  const nullable = (keyword: 'oneOf' | 'anyOf', inner: SchemaObject): SchemaObject => ({
    [keyword]: [inner, { type: 'null' }],
  });

  const expectDispatcher = (ir: ApiSpec, components: string[]) => {
    const models = modelsByName(ir);
    const event = models['Event']!;
    expect(event.discriminator?.property).toBe('kind');
    expect(Object.keys(event.discriminator?.mapping ?? {}).sort()).toEqual(['a', 'b']);
    for (const tag of ['a', 'b']) {
      const variant = models[event.discriminator!.mapping[tag]!];
      expect(variant, `variant for ${tag}`).toBeDefined();
      expect(fieldsOf(variant)).toEqual(['id: string', 'kind: literal', `${tag}?: string`]);
    }
    expectSound(ir, components);
  };

  it.each([
    ['oneOf', 'oneOf'],
    ['oneOf', 'anyOf'],
    ['anyOf', 'oneOf'],
    ['anyOf', 'anyOf'],
  ] as const)("Greptile's case, the wrapper spelled %s around a %s", async (wrapper, inner) => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: { schemas: { Event: { allOf: [base, nullable(wrapper, union(inner))] } } },
    });
    expectDispatcher(ir, ['Event']);
  });

  it('finds the axis through a $ref member to a nullable-wrapped union component, and through a chain to one', async () => {
    const Axis = nullable('oneOf', union('oneOf'));
    const direct = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: { schemas: { Axis, Event: { allOf: [base, { $ref: '#/components/schemas/Axis' }] } } },
    });
    expectDispatcher(direct, ['Event', 'Axis']);
    const chained = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Axis,
          Hop: { $ref: '#/components/schemas/Axis' },
          Event: { allOf: [base, { $ref: '#/components/schemas/Hop' }] },
        },
      },
    });
    expectDispatcher(chained, ['Event', 'Axis', 'Hop']);
  });
});

describe('two typing declarations of one name conjoin as JSON Schema applies both (Greptile, #308 merge round)', () => {
  const obj = (properties: Record<string, SchemaObject>, required: string[] = []): SchemaObject => ({
    type: 'object',
    properties,
    ...(required.length > 0 && { required }),
  });
  const items = obj({ items: { type: 'array', items: { type: 'string' } } }, ['items']);
  const total = obj({ total_pages: { type: 'integer' } });

  it('merges two inline objects, a name both declare by the same rule, and unites their required', () => {
    for (const members of [
      [obj({ result: items }), obj({ result: total })],
      [obj({ result: total }), obj({ result: items })],
    ]) {
      const merged = mergeAllOfMembers({ allOf: members }, undefined);
      const [result] = merged.properties;
      expect(result?.name).toBe('result');
      expect(Object.keys(result!.schema.properties ?? {}).sort()).toEqual(['items', 'total_pages']);
      expect(result!.schema.required).toEqual(['items']);
    }
    // A name both objects declare is settled inside the conjunction too: the
    // typing declaration, annotated by the typeless one.
    const typed = obj({ meta: obj({ page: { type: 'integer' } }) });
    const described = obj({ meta: obj({ page: { description: 'Page number' } }) });
    const merged = mergeAllOfMembers({ allOf: [described, typed] }, undefined);
    expect(merged.properties[0]!.schema.properties?.page).toEqual({ type: 'integer', description: 'Page number' });
  });

  it('keeps the items that say something when two arrays meet, in either order; two primitives keep the first', () => {
    const typedArray: SchemaObject = { type: 'array', items: { $ref: '#/components/schemas/User' } };
    const bounded: SchemaObject = { type: ['array', 'null'], minItems: 1 };
    for (const members of [
      [obj({ data: typedArray }), obj({ data: bounded })],
      [obj({ data: bounded }), obj({ data: typedArray })],
    ]) {
      const merged = mergeAllOfMembers({ allOf: members }, undefined);
      expect(merged.properties[0]!.schema).toEqual({
        type: ['array', 'null'],
        items: { $ref: '#/components/schemas/User' },
        minItems: 1,
      });
    }
    const first = mergeAllOfMembers(
      { allOf: [obj({ n: { type: 'string' } }), obj({ n: { type: 'integer' } })] },
      undefined,
    );
    expect(first.properties[0]!.schema).toEqual({ type: 'string' });
  });

  it('combines the items of two arrays as two declarations of a property, in either order (#431)', async () => {
    const arrayOf = (itemSchema: SchemaObject): SchemaObject => ({ type: 'array', items: itemSchema });
    // The issue's `PetPage`: the second member only describes the items of
    // `data`, declares `tags` again as `integer[]`, and gives the items of
    // `owners` and the object `owner` a property each.
    const first = obj({
      data: arrayOf({ $ref: '#/components/schemas/Pet' }),
      tags: arrayOf({ type: 'string' }),
      owners: arrayOf(obj({ name: { type: 'string' } })),
      owner: obj({ name: { type: 'string' } }),
    });
    const second = obj({
      data: { ...arrayOf({ description: 'A pet' }), description: 'The pets on this page' },
      tags: arrayOf({ type: 'integer' }),
      owners: arrayOf(obj({ email: { type: 'string' } })),
      owner: obj({ email: { type: 'string' } }),
    });
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Pet: obj({ name: { type: 'string' } }),
          PetPage: { allOf: [first, second] },
          PagePet: { allOf: [second, first] },
        },
      },
    });
    const models = modelsByName(ir);
    const typeOf = (model: string, field: string) => models[model]?.fields.find((f) => f.name === field)?.type;
    const arrayOfType = (items: unknown) => ({ kind: 'array', items });
    for (const [name, ownerFields] of [
      ['PetPage', ['name?: string', 'email?: string']],
      ['PagePet', ['email?: string', 'name?: string']],
    ] as const) {
      // A typeless `items` only annotates the typed one.
      expect(typeOf(name, 'data'), name).toEqual(arrayOfType(model('Pet')));
      // Two typed primitives keep the first.
      expect(typeOf(name, 'tags'), name).toEqual(
        arrayOfType({ kind: 'primitive', type: name === 'PetPage' ? 'string' : 'integer' }),
      );
      // Two inline objects conjoin, as the same two objects as a property do,
      // so the items are the very shape of `owner` and share its model.
      expect(typeOf(name, 'owner'), name).toEqual(model(`${name}Owner`));
      expect(fieldsOf(models[`${name}Owner`]), name).toEqual(ownerFields);
      expect(typeOf(name, 'owners'), name).toEqual(arrayOfType(model(`${name}Owner`)));
    }
    expectSound(ir, ['Pet', 'PetPage', 'PagePet']);
  });

  it("builds a conjoined object as the merged model's own and the component's own, so the field names a model that has both parts", async () => {
    const A = obj({ result: items });
    const B = obj({ result: total });
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          A,
          B,
          // Conjoined across two components: no component model nests the
          // whole, so it is the merged model's own.
          Holder: obj({ value: { allOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }] } }),
          // Conjoined within one component: its own model nests the whole.
          Page: { allOf: [A, B] },
        },
      },
    });
    const models = modelsByName(ir);
    expect(fieldsOf(models['HolderValue'])).toEqual(['result?: HolderValueResult']);
    expect(fieldsOf(models['HolderValueResult'])).toEqual(['items: array', 'total_pages?: integer']);
    expect(fieldsOf(models['Page'])).toEqual(['result?: PageResult']);
    expect(fieldsOf(models['PageResult'])).toEqual(['items: array', 'total_pages?: integer']);
    expectSound(ir, ['A', 'B', 'Holder', 'Page']);
  });

  it('conjoins a $ref to an object component and an inline object as the allOf of both, in either order (#432)', async () => {
    const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
    const page = ref('PetPage');
    const more = obj({ has_more: { type: 'boolean' } });
    // A component that is no object: the inline object beside it does not
    // make it one, so the first declaration types the property, as before.
    const pets = ref('Pets');
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Pet: obj({ name: { type: 'string' } }),
          PetPage: obj({ items: { type: 'array', items: ref('Pet') }, owner: obj({ name: { type: 'string' } }) }),
          Pets: { type: 'array', items: ref('Pet') },
          RefFirst: { allOf: [obj({ result: page }), obj({ result: total })] },
          InlineFirst: { allOf: [obj({ result: total }), obj({ result: page })] },
          // A third declaration conjoins with the conjunction, wherever the `$ref` sits.
          RefThenTwo: { allOf: [obj({ result: page }), obj({ result: total }), obj({ result: more })] },
          RefBetween: { allOf: [obj({ result: total }), obj({ result: page }), obj({ result: more })] },
          // The flags and documentation a declaration gives the field stay the field's.
          Documented: {
            allOf: [obj({ result: { ...total, description: 'The page', readOnly: true } }), obj({ result: page })],
          },
          ArrayFirst: { allOf: [obj({ result: pets }), obj({ result: total })] },
          ArrayLast: { allOf: [obj({ result: total }), obj({ result: pets })] },
          // A declaration inherited through a `$ref` member conjoins the same way.
          RefHolder: obj({ result: page }),
          Extended: { allOf: [ref('RefHolder'), obj({ result: total })] },
          // An inline `allOf` merge reads the same declaration.
          Holder: obj({ value: { allOf: [obj({ result: total }), obj({ result: page })] } }),
          // So do the items of two arrays (#431).
          Listed: {
            allOf: [
              obj({ data: { type: 'array', items: ref('Pet') } }),
              obj({ data: { type: 'array', items: obj({ extra: { type: 'string' } }) } }),
            ],
          },
        },
      },
    });
    const models = modelsByName(ir);
    const pageFields = ['items?: array', 'owner?: PetPageOwner'];
    for (const [name, resultFields] of [
      ['RefFirst', [...pageFields, 'total_pages?: integer']],
      ['InlineFirst', ['total_pages?: integer', ...pageFields]],
      ['RefThenTwo', [...pageFields, 'total_pages?: integer', 'has_more?: boolean']],
      ['RefBetween', ['total_pages?: integer', ...pageFields, 'has_more?: boolean']],
      ['Documented', ['total_pages?: integer', ...pageFields]],
      ['Extended', [...pageFields, 'total_pages?: integer']],
      ['HolderValue', ['total_pages?: integer', ...pageFields]],
    ] as const) {
      // `result` is a `PetPage` that also has `total_pages`: the fields it
      // inherits are typed as `PetPage` types them (`PetPageOwner`).
      expect(fieldsOf(models[name]), name).toEqual([`result?: ${name}Result`]);
      expect(fieldsOf(models[`${name}Result`]), name).toEqual(resultFields);
    }
    const documented = models['Documented']!.fields[0]!;
    expect([documented.description, documented.readOnly]).toEqual(['The page', true]);
    expect(models['ArrayFirst']!.fields[0]!.type).toEqual({ kind: 'array', items: model('Pet') });
    expect(fieldsOf(models['ArrayLast'])).toEqual(['result?: ArrayLastResult']);
    expect(fieldsOf(models['ArrayLastResult'])).toEqual(['total_pages?: integer']);
    expect(models['Listed']!.fields[0]!.type).toEqual({ kind: 'array', items: model('ListedData') });
    expect(fieldsOf(models['ListedData'])).toEqual(['name?: string', 'extra?: string']);
    expectSound(ir, [
      'Pet',
      'PetPage',
      'Pets',
      'RefFirst',
      'InlineFirst',
      'RefThenTwo',
      'RefBetween',
      'Documented',
      'ArrayFirst',
      'ArrayLast',
      'RefHolder',
      'Extended',
      'Holder',
      'Listed',
    ]);
  });
});

describe('the origin of an inherited field is the component whose model carries it (Greptile, #308 round 4)', () => {
  const meta: SchemaObject = { type: 'object', properties: { page: { type: 'integer' } } };
  const Base: SchemaObject = { type: 'object', properties: { meta }, required: ['meta'] };
  const nullOf = (variant: SchemaObject): SchemaObject => ({ oneOf: [variant, { type: 'null' }] });
  const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
  const inline: SchemaObject = { type: 'object', properties: { x: { type: 'string' } } };
  const holder = (member: SchemaObject) => ({ type: 'object', properties: { value: { allOf: [member, inline] } } });
  const doc = (schemas: Record<string, SchemaObject>) => ({
    openapi: '3.1.0',
    info,
    paths: {},
    components: { schemas: { Base, ...schemas } },
  });

  it("types a field inherited through a nullable alias under the component that declares it (Greptile's case)", async () => {
    // `Alias` declares nothing and builds no model, so `HolderValue.meta` is
    // `BaseMeta` — the model `Base` builds — never `AliasMeta`.
    const Alias = nullOf(ref('Base'));
    const merged = mergeAllOfMembers({ allOf: [ref('Alias'), inline] }, { Base, Alias });
    expect(merged.properties.map((p) => `${p.name} (${p.origin?.name ?? 'own'})`)).toEqual(['meta (Base)', 'x (own)']);
    const ir = await parseWithoutWarnings(doc({ Alias, Holder: holder(ref('Alias')) }));
    expect(fieldsOf(modelsByName(ir)['HolderValue'])).toEqual(['meta: BaseMeta', 'x?: string']);
    expectSound(ir, ['Base', 'Alias', 'Holder']);
  });

  it('follows a two-hop alias — a bare $ref to a nullable alias — to the declaring component', async () => {
    const Alias = nullOf(ref('Base'));
    const Hop = ref('Alias');
    const merged = mergeAllOfMembers({ allOf: [ref('Hop'), inline] }, { Base, Alias, Hop });
    expect(merged.properties.map((p) => `${p.name} (${p.origin?.name ?? 'own'})`)).toEqual(['meta (Base)', 'x (own)']);
    const ir = await parseWithoutWarnings(doc({ Alias, Hop, Holder: holder(ref('Hop')) }));
    expect(fieldsOf(modelsByName(ir)['HolderValue'])).toEqual(['meta: BaseMeta', 'x?: string']);
    expectSound(ir, ['Base', 'Alias', 'Hop', 'Holder']);
  });

  it('keeps an allOf component as the origin when the alias is one of its members: its own model carries the field', async () => {
    // `Comp` inherits through the alias, so its model types `meta` as
    // `CompMeta` and builds it; a merge naming `Comp` references that.
    const Alias = nullOf(ref('Base'));
    const Comp: SchemaObject = { allOf: [ref('Alias'), { type: 'object', properties: { y: { type: 'string' } } }] };
    const merged = mergeAllOfMembers({ allOf: [ref('Comp'), inline] }, { Base, Alias, Comp });
    expect(merged.properties.map((p) => `${p.name} (${p.origin?.name ?? 'own'})`)).toEqual([
      'meta (Comp)',
      'y (Comp)',
      'x (own)',
    ]);
    const ir = await parseWithoutWarnings(doc({ Alias, Comp, Holder: holder(ref('Comp')) }));
    const models = modelsByName(ir);
    expect(fieldsOf(models['Comp'])).toEqual(['meta: CompMeta', 'y?: string']);
    expect(fieldsOf(models['HolderValue'])).toEqual(['meta: CompMeta', 'y?: string', 'x?: string']);
    expectSound(ir, ['Base', 'Alias', 'Comp', 'Holder']);
  });
});

describe('merge round 1: a schema read through a $ref and again as an inline member', () => {
  /** One object, declared as a component and reused as an inline member, as a `transformSpec` hook can. */
  const shared = (): SchemaObject => ({
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    oneOf: [{ properties: { ownerId: { type: 'string' } } }, { properties: { shelterId: { type: 'string' } } }],
  });

  it.each(['ref first', 'inline first'] as const)(
    'reads the inline member in full after the $ref reading (%s)',
    (order) => {
      const Shared = shared();
      const ref: SchemaObject = { $ref: '#/components/schemas/Shared' };
      const merged = mergeAllOfMembers({ allOf: order === 'ref first' ? [ref, Shared] : [Shared, ref] }, { Shared });
      // The `$ref` reading leaves the union to the component; the inline
      // reading of the very same object still contributes it.
      expect(merged.properties.map((p) => `${p.name}${p.origin ? ` (${p.origin.name})` : ''}`)).toEqual(
        order === 'ref first' ? ['id (Shared)', 'ownerId', 'shelterId'] : ['id', 'ownerId', 'shelterId'],
      );
      expect(merged.required).toEqual(['id']);
      expect(merged.resolvedRefs).toEqual(['#/components/schemas/Shared']);
    },
  );

  it('keeps the variants through the parser when the component object is the inline member', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(
        {
          openapi: '3.1.0',
          info,
          paths: {
            '/pets': {
              post: {
                operationId: 'createPet',
                requestBody: jsonBody({ type: 'object' }),
                responses: { '204': { description: 'done' } },
              },
            },
          },
          components: { schemas: { Shared: shared() } },
        },
        (doc) => {
          const components = doc['components'] as { schemas: Record<string, SchemaObject> };
          const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
          paths['/pets']!['post']!['requestBody'] = jsonBody({
            allOf: [{ $ref: '#/components/schemas/Shared' }, components.schemas['Shared']!],
          });
          return doc;
        },
      );
      expect(fieldsOf(modelsByName(ir)['CreatePetRequest'])).toEqual([
        'id: string',
        'ownerId?: string',
        'shelterId?: string',
      ]);
      expectSound(ir, ['Shared']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still stops a component that extends itself, read through a $ref', () => {
    const components: Record<string, SchemaObject> = {};
    components['Node'] = {
      type: 'object',
      properties: { depth: { type: 'integer' } },
      allOf: [{ $ref: '#/components/schemas/Node' }],
    };
    const merged = mergeAllOfMembers(
      { allOf: [{ $ref: '#/components/schemas/Node' }, { properties: { note: { type: 'string' } } }] },
      components,
    );
    expect(merged.properties.map((p) => p.name)).toEqual(['depth', 'note']);
  });
});

/**
 * workos/oagen#555: a property written as `allOf: [{ type: 'string', enum:
 * [...] }, { description }]` — one member that types it beside one that
 * only documents it — was `unknown` with a warning, and the member's text
 * was lost with it: `allOfTypesSchema` let an `allOf` type the schema only
 * through a `$ref` member, a member with properties, or a lone member. A
 * member that declares no type (`declaresType`) is now part of the wrapper
 * (`annotatingAllOfMembers`): the one typing member is unwrapped as a lone
 * member is (`allOfTypingMember`, `readInlineAllOf`: `'unwrapped'`), the
 * annotating members' documentation and `deprecated` ride onto it as the
 * wrapper's own do (`allOfWrapperLayer`), their limits conjoin as they
 * already did (`extractConstraints`), and a field, parameter or header
 * reads its text, flags, default, examples and `x-*` keys from them
 * whatever the other members — beside a `$ref` too (the review: `allOf:
 * [{ $ref: Kind }, { deprecated: true }]` dropped the flag).
 */
describe('an allOf of one typing member beside members that only annotate or limit it (workos/oagen#555)', () => {
  const kindEnum: SchemaObject = { type: 'string', enum: ['cat', 'dog'] };
  const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
  const components: Record<string, SchemaObject> = {
    Kind: kindEnum,
    PetId: { type: 'string', maxLength: 36, pattern: '^pet_' },
    Owner: { type: 'object', properties: { name: { type: 'string' } } },
  };
  const int = { kind: 'primitive', type: 'integer' };
  const petKind = { kind: 'enum', name: 'PetKind', values: ['cat', 'dog'] };

  /** `GET /pets/{petId}` returning `Pet`, whose properties are `properties`, all required. */
  const petDoc = (openapi: string, properties: Record<string, SchemaObject>): Record<string, unknown> => ({
    openapi,
    info,
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': jsonResponse(ref('Pet')) },
        },
      },
    },
    components: {
      schemas: { ...components, Pet: { type: 'object', required: Object.keys(properties), properties } },
    },
  });
  const fieldOf = (ir: ApiSpec, name: string): Field => modelsByName(ir)['Pet']!.fields.find((f) => f.name === name)!;
  /** The issue's projection of a field: its type and whatever it documents. */
  const shown = (field: Field): Record<string, unknown> => {
    const { constraints, deprecated, description, readOnly, type } = field;
    return {
      type,
      ...(constraints !== undefined && { constraints }),
      ...(deprecated !== undefined && { deprecated }),
      ...(description !== undefined && { description }),
      ...(readOnly !== undefined && { readOnly }),
    };
  };
  const enumOf = (ir: ApiSpec, name: string) => ir.enums.find((e) => e.name === name);

  it.each(['3.1.0', '3.0.3'])("types the issue's Pet as the lone-member spelling does (OAS %s)", async (openapi) => {
    const annotated = petDoc(openapi, {
      kind: { allOf: [kindEnum, { description: 'The kind of pet.' }] },
      name: { allOf: [{ type: 'string' }, { description: 'The name of the pet.' }] },
      size: { allOf: [{ type: 'string', enum: ['large', 'small'] }], description: 'The size of the pet.' },
    });
    const ir = await parseWithoutWarnings(annotated);
    expect(shown(fieldOf(ir, 'kind'))).toEqual({ type: petKind, description: 'The kind of pet.' });
    expect(shown(fieldOf(ir, 'name'))).toEqual({ type: str, description: 'The name of the pet.' });
    expect(shown(fieldOf(ir, 'size'))).toEqual({
      type: { kind: 'enum', name: 'PetSize', values: ['large', 'small'] },
      description: 'The size of the pet.',
    });
    // The inline enum lifted from the typing member is documented by the
    // annotating member, as `PetSize` is by its wrapper.
    expect(enumOf(ir, 'PetKind')).toMatchObject({ description: 'The kind of pet.' });
    expect(enumOf(ir, 'PetKind')?.values.map((v) => v.value)).toEqual(['cat', 'dog']);
    expect(enumOf(ir, 'PetSize')).toMatchObject({ description: 'The size of the pet.' });
    expectSound(ir, ['Kind', 'Owner', 'Pet']);

    // `oagen diff` between the two spellings reports nothing.
    const lone = await parseWithoutWarnings(
      petDoc(openapi, {
        kind: { allOf: [kindEnum], description: 'The kind of pet.' },
        name: { allOf: [{ type: 'string' }], description: 'The name of the pet.' },
        size: { allOf: [{ type: 'string', enum: ['large', 'small'] }], description: 'The size of the pet.' },
      }),
    );
    expect(diffSpecs(lone, ir).changes).toEqual([]);
  });

  it.each(['3.1.0', '3.0.3'])('documents and flags a field from a member beside a $ref (OAS %s)', async (openapi) => {
    const ir = await parseWithoutWarnings(
      petDoc(openapi, {
        ref: { allOf: [ref('Kind'), { description: 'A referenced kind.' }] },
        kind: { allOf: [ref('Kind'), { deprecated: true }] },
        size: { allOf: [ref('Kind'), { readOnly: true }] },
        tag: { allOf: [ref('Kind')], deprecated: true, readOnly: true },
        owner: { allOf: [ref('Owner'), { description: 'The owner.', deprecated: true }] },
        pid: { allOf: [ref('PetId'), { description: 'A described id.' }] },
      }),
    );
    const kind = { kind: 'enum', name: 'Kind' };
    expect(shown(fieldOf(ir, 'ref'))).toEqual({ type: kind, description: 'A referenced kind.' });
    expect(shown(fieldOf(ir, 'kind'))).toEqual({ type: kind, deprecated: true });
    expect(shown(fieldOf(ir, 'size'))).toEqual({ type: kind, readOnly: true });
    expect(shown(fieldOf(ir, 'tag'))).toEqual({ type: kind, deprecated: true, readOnly: true });
    expect(shown(fieldOf(ir, 'owner'))).toEqual({ type: model('Owner'), description: 'The owner.', deprecated: true });
    // A primitive component's limits conjoin through the reference, as before, on the type too (#545).
    expect(shown(fieldOf(ir, 'pid'))).toEqual({
      type: { ...str, constraints: { maxLength: 36, pattern: '^pet_' } },
      constraints: { maxLength: 36, pattern: '^pet_' },
      description: 'A described id.',
    });
    // The component keeps its own documentation and flag: the member documents the field.
    expect(enumOf(ir, 'Kind')?.description).toBeUndefined();
    expect(modelsByName(ir)['Owner']?.description).toBeUndefined();
    expect(modelsByName(ir)['Owner']?.deprecated).toBeUndefined();
    expectSound(ir, ['Kind', 'Owner', 'Pet']);
  });

  it('reads a nullable wrapper as the typing member, with the limits of the component it wraps (the review)', async () => {
    const ir = await parseWithoutWarnings(
      petDoc('3.1.0', {
        id: { allOf: [{ oneOf: [ref('PetId'), { type: 'null' }] }, { description: 'The pet.' }] },
        typed: { allOf: [{ type: ['string', 'null'], enum: ['a', 'b', null] }, { description: 'Nullable enum.' }] },
      }),
    );
    expect(shown(fieldOf(ir, 'id'))).toEqual({
      // The limits are the inner type's too (#545).
      type: { kind: 'nullable', inner: { ...str, constraints: { maxLength: 36, pattern: '^pet_' } } },
      constraints: { maxLength: 36, pattern: '^pet_' },
      description: 'The pet.',
    });
    expect(shown(fieldOf(ir, 'typed'))).toEqual({
      type: { kind: 'nullable', inner: { kind: 'enum', name: 'PetTyped', values: ['a', 'b'] } },
      description: 'Nullable enum.',
    });
    expect(enumOf(ir, 'PetTyped')).toMatchObject({ description: 'Nullable enum.' });

    // OAS 3.0: `nullable: true` on the typing member; and a wrapper written
    // `{ oneOf: [{ $ref }], nullable: true }` reads exactly as it does on its own.
    const wrapper30: SchemaObject = { oneOf: [ref('PetId')], nullable: true };
    const ir30 = await parseWithoutWarnings(
      petDoc('3.0.3', {
        typed: { allOf: [{ type: 'string', nullable: true, enum: ['a', 'b'] }, { description: 'Nullable enum.' }] },
        bare: wrapper30,
        id: { allOf: [wrapper30, { description: 'The pet.' }] },
      }),
    );
    expect(shown(fieldOf(ir30, 'typed'))).toEqual({
      type: { kind: 'nullable', inner: { kind: 'enum', name: 'PetTyped', values: ['a', 'b'] } },
      description: 'Nullable enum.',
    });
    expect(shown(fieldOf(ir30, 'id'))).toEqual({ ...shown(fieldOf(ir30, 'bare')), description: 'The pet.' });
  });

  it("conjoins a member that only limits, with the wrapper's own limits and the typing member's", async () => {
    const ir = await parseWithoutWarnings(
      petDoc('3.1.0', {
        limited: { allOf: [{ type: 'string' }, { maxLength: 3 }] },
        both: {
          allOf: [
            { type: 'string', maxLength: 5, minLength: 1 },
            { maxLength: 3, pattern: '^a' },
          ],
          minLength: 2,
        },
        items: {
          allOf: [
            { type: 'array', items: { type: 'string' } },
            { minItems: 1, description: 'Tags.' },
          ],
        },
      }),
    );
    // The conjoined limits are the type's too (#545).
    expect(shown(fieldOf(ir, 'limited'))).toEqual({
      type: { ...str, constraints: { maxLength: 3 } },
      constraints: { maxLength: 3 },
    });
    expect(shown(fieldOf(ir, 'both'))).toEqual({
      type: { ...str, constraints: { minLength: 2, maxLength: 3, pattern: '^a' } },
      constraints: { minLength: 2, maxLength: 3, pattern: '^a' },
    });
    expect(shown(fieldOf(ir, 'items'))).toEqual({
      type: { kind: 'array', items: str, constraints: { minItems: 1 } },
      constraints: { minItems: 1 },
      description: 'Tags.',
    });
  });

  it("reads every annotation keyword from such members, the schema's own first, then the first member's", async () => {
    const ir = await parseWithoutWarnings(
      petDoc('3.1.0', {
        count: {
          allOf: [
            { type: 'integer' },
            {
              title: 'Count',
              deprecated: true,
              readOnly: true,
              default: 1,
              example: 3,
              externalDocs: { url: 'https://example.com/count' },
              'x-internal': true,
            },
          ],
        },
        first: { allOf: [{ type: 'string', description: 'Member.' }, { description: 'A' }, { description: 'B' }] },
        own: { allOf: [{ type: 'string' }, { description: 'A', 'x-k': 'member' }], description: 'Own.', 'x-k': 'own' },
        blank: { allOf: [{ type: 'string' }, { description: '  ' }, { description: 'B' }], description: '' },
        written: { allOf: [{ type: 'boolean' }, { writeOnly: true }] },
      }),
    );
    expect(fieldOf(ir, 'count')).toMatchObject({
      type: int,
      deprecated: true,
      readOnly: true,
      default: 1,
      example: 3,
      externalDocs: { url: 'https://example.com/count' },
      extensions: { 'x-internal': true },
    });
    expect(fieldOf(ir, 'count').description).toBeUndefined();
    // The typing member's own text documents the enum or model built from
    // it, never the field — as a lone member's does not — so the first
    // annotating member's is the field's.
    expect(shown(fieldOf(ir, 'first'))).toEqual({ type: str, description: 'A' });
    expect(fieldOf(ir, 'own')).toMatchObject({ type: str, description: 'Own.', extensions: { 'x-k': 'own' } });
    // A blank text on the schema itself is read as it is read today: it is
    // the schema's own, and `description` is the first level that declares one.
    expect(fieldOf(ir, 'blank').description).toBe('');
    expect(fieldOf(ir, 'written')).toMatchObject({ type: { kind: 'primitive', type: 'boolean' }, writeOnly: true });
  });

  it('leaves every other allOf shape as it was', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(
        petDoc('3.1.0', {
          pair: {
            allOf: [
              { type: 'object', properties: { a: { type: 'string' } } },
              { properties: { b: { type: 'integer' } } },
            ],
          },
          aug: {
            allOf: [
              ref('Owner'),
              { type: 'object', properties: { b: { type: 'integer' } } },
              { description: 'Augmented.' },
            ],
          },
          obj: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { description: 'An object.' }] },
          two: { allOf: [{ type: 'string' }, { type: 'integer' }] },
          own: { type: 'string', allOf: [{ minLength: 1 }, { description: 'Own type.' }] },
          none: { allOf: [{ description: 'Only text.' }] },
          mapped: {
            allOf: [{ type: 'object', additionalProperties: { type: 'integer' } }, { description: 'Counts.' }],
          },
        }),
      );
      // Two inline objects merge; a `$ref` beside an inline object augments
      // it — a member beside either that declares no type documents the field.
      expect(shown(fieldOf(ir, 'pair'))).toEqual({ type: model('PetPair') });
      expect(fieldsOf(modelsByName(ir)['PetPair'])).toEqual(['a?: string', 'b?: integer']);
      expect(shown(fieldOf(ir, 'aug'))).toEqual({ type: model('PetAug'), description: 'Augmented.' });
      expect(fieldsOf(modelsByName(ir)['PetAug'])).toEqual(['name?: string', 'b?: integer']);
      expect(shown(fieldOf(ir, 'obj'))).toEqual({ type: model('PetObj'), description: 'An object.' });
      expect(fieldsOf(modelsByName(ir)['PetObj'])).toEqual(['a?: string']);
      // Two typing members, neither of them properties, are read as neither.
      expect(shown(fieldOf(ir, 'two'))).toEqual({ type: { kind: 'primitive', type: 'unknown' } });
      // An `allOf` of bare limits beside the schema's own `type` leaves it that type.
      expect(shown(fieldOf(ir, 'own'))).toEqual({
        type: { ...str, constraints: { minLength: 1 } },
        constraints: { minLength: 1 },
        description: 'Own type.',
      });
      expect(shown(fieldOf(ir, 'none'))).toEqual({
        type: { kind: 'primitive', type: 'unknown' },
        description: 'Only text.',
      });
      expect(shown(fieldOf(ir, 'mapped'))).toEqual({ type: { kind: 'map', valueType: int }, description: 'Counts.' });
      expect(warnSpy.mock.calls.map(([m]) => String(m))).toEqual([
        '[oagen] Warning: Unknown schema shape treated as unknown (context: two)',
        '[oagen] Warning: Unknown schema shape treated as unknown (context: none)',
      ]);
      expectSound(ir, ['Kind', 'Owner', 'Pet']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('is one reading at every site: parameter, request body, response body, array items, map values, header', async () => {
    const annotatedKind: SchemaObject = { allOf: [kindEnum, { description: 'The kind of pet.', deprecated: true }] };
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'kind', in: 'query', schema: annotatedKind }],
            responses: {
              '200': {
                ...jsonResponse({ allOf: [{ type: 'string' }, { description: 'The names.' }] }),
                headers: { 'X-Kind': { schema: { allOf: [ref('Kind'), { deprecated: true }] } } },
              },
            },
          },
          post: {
            operationId: 'createPet',
            requestBody: jsonBody({ allOf: [ref('Pet'), { description: 'The pet to add.' }] }),
            responses: { '201': jsonResponse(ref('Pet')) },
          },
        },
        '/pets/mode': {
          put: {
            operationId: 'setMode',
            requestBody: jsonBody({ allOf: [{ type: 'string', enum: ['on', 'off'] }, { description: 'The mode.' }] }),
            responses: { '204': { description: 'done' } },
          },
        },
      },
      components: {
        schemas: {
          ...components,
          Pet: {
            type: 'object',
            properties: {
              tags: { type: 'array', items: { allOf: [kindEnum, { description: 'A tag.' }] } },
              counts: {
                type: 'object',
                additionalProperties: { allOf: [{ type: 'integer' }, { description: 'A count.' }] },
              },
            },
          },
        },
      },
    });
    const ops = opsOf(ir);
    const kind = ops['listPets']!.queryParams.find((p) => p.name === 'kind')!;
    expect(kind).toMatchObject({
      type: { kind: 'enum', values: ['cat', 'dog'] },
      description: 'The kind of pet.',
      deprecated: true,
    });
    expect(ops['listPets']!.response).toEqual(str);
    expect(collectResponseHeaders(ops['listPets']!).map((h) => [h.name, h.type, h.deprecated])).toEqual([
      ['X-Kind', { kind: 'enum', name: 'Kind' }, true],
    ]);
    expect(ops['createPet']!.requestBody).toEqual(model('Pet'));
    expect(ops['createPet']!.requestBodyDescription).toBe('The pet to add.');
    expect(ops['setMode']!.requestBody).toMatchObject({ kind: 'enum', values: ['on', 'off'] });
    expect(ops['setMode']!.requestBodyDescription).toBe('The mode.');
    expect(shown(fieldOf(ir, 'tags'))).toEqual({
      type: { kind: 'array', items: { kind: 'enum', name: 'PetTags', values: ['cat', 'dog'] } },
    });
    expect(enumOf(ir, 'PetTags')).toMatchObject({ description: 'A tag.' });
    expect(shown(fieldOf(ir, 'counts'))).toEqual({ type: { kind: 'map', valueType: int } });
    expectSound(ir, ['Kind', 'Owner', 'Pet']);
  });

  it('composes with the wrappers around and inside it, outermost first', async () => {
    const ir = await parseWithoutWarnings(
      petDoc('3.1.0', {
        under: { oneOf: [{ allOf: [kindEnum, { description: 'Inner.' }] }, { type: 'null' }] },
        nested: { allOf: [{ allOf: [kindEnum, { description: 'Inner.' }] }, { deprecated: true }] },
        outer: { allOf: [{ allOf: [kindEnum, { description: 'Inner.' }] }, { description: 'Outer.' }] },
      }),
    );
    // The wrapper that is the field's schema documents the field; an inner
    // layer's text reaches the enum lifted from the member, as a lone
    // member's wrapper's does.
    expect(shown(fieldOf(ir, 'under'))).toEqual({
      type: { kind: 'nullable', inner: { ...petKind, name: 'PetUnder' } },
    });
    expect(enumOf(ir, 'PetUnder')).toMatchObject({ description: 'Inner.' });
    expect(shown(fieldOf(ir, 'nested'))).toEqual({ type: { ...petKind, name: 'PetNested' }, deprecated: true });
    expect(enumOf(ir, 'PetNested')).toMatchObject({ description: 'Inner.' });
    expect(shown(fieldOf(ir, 'outer'))).toEqual({ type: { ...petKind, name: 'PetOuter' }, description: 'Outer.' });
    expect(enumOf(ir, 'PetOuter')).toMatchObject({ description: 'Outer.' });
  });

  it('is decided once, by the readers every site shares', () => {
    const text: SchemaObject = { description: 'd' };
    expect(readInlineAllOf([{ type: 'string' }, text])).toBe('unwrapped');
    expect(readInlineAllOf([text, { maxLength: 3 }, kindEnum, { deprecated: true }])).toBe('unwrapped');
    expect(readInlineAllOf([{ oneOf: [ref('PetId'), { type: 'null' }] }, text])).toBe('unwrapped');
    expect(readInlineAllOf([ref('Kind'), text])).toBe('reference');
    expect(readInlineAllOf([{ type: 'string' }, { type: 'integer' }])).toBe('reference');
    expect(readInlineAllOf([{ type: 'object', properties: {} }, text])).toBe('merged');

    expect(allOfTypingMember([text, kindEnum, { maxLength: 3 }])).toBe(kindEnum);
    expect(allOfTypingMember([{ type: 'string' }, { type: 'integer' }])).toBeUndefined();
    expect(allOfTypingMember([text, { minLength: 1 }])).toBeUndefined();
    expect(annotatingAllOfMembers({ allOf: [ref('Kind'), text, { title: 'T' }] })).toEqual([text, { title: 'T' }]);
    expect(annotatingAllOfMembers({ allOf: [{ type: 'string' }, { type: 'integer' }] })).toEqual([]);
    expect(annotatingAllOfMembers({ type: 'string' })).toEqual([]);

    expect(classifyInlineSchema({ allOf: [{ type: 'string' }, text] })).toBe('allOf');
    expect(classifyInlineSchema({ allOf: [{ type: 'string' }, { type: 'integer' }] })).toBe('other');
    expect(classifyInlineSchema({ type: 'string', allOf: [{ minLength: 1 }, text] })).toBe('other');
    expect(typesAsUnknown({ allOf: [{ type: 'string' }, text] })).toBe(false);
    expect(typesAsUnknown({ allOf: [{}, text] })).toBe(true);
    expect(typesAsUnknown({ allOf: [{ type: 'string' }, { type: 'integer' }] })).toBe(true);

    // The wrapper layer: the wrapper's own documentation over the first
    // annotating member's over the next; `deprecated` from any of them.
    const layered: SchemaObject = {
      allOf: [
        { description: 'A', example: 1 },
        { type: 'string' },
        { description: 'B', 'x-k': 'b', example: 2, deprecated: true },
      ],
      description: '',
      minLength: 1,
    };
    expect(allOfWrapperLayer(layered)).toEqual({
      ...layered,
      description: 'A',
      example: 1,
      'x-k': 'b',
      deprecated: true,
    });
    expect(allOfWrapperLayer({ ...layered, description: 'own' }).description).toBe('own');
    expect(allOfWrapperLayer({ type: 'string' })).toEqual({ type: 'string' });
    expect(
      unwrappedAllOfMember({
        allOf: [{ description: 'A' }, { type: 'string', maxLength: 5 }, { maxLength: 3, deprecated: true }],
        minLength: 1,
      }),
    ).toEqual({
      type: 'string',
      maxLength: 3,
      minLength: 1,
      description: 'A',
      deprecated: true,
    });

    // The type builder and the request body's text reader read the same layer.
    expect(schemaToTypeRef({ allOf: [kindEnum, text] }, 'kind', 'Pet')).toMatchObject(petKind);
    expect(schemaToTypeRef({ allOf: [ref('Kind'), text] }, 'kind', 'Pet')).toEqual(
      schemaToTypeRef(ref('Kind'), 'kind', 'Pet'),
    );
    expect(unwrapCollapsedWrappers({ allOf: [ref('Kind'), text] }).description).toBe('d');
    expect(unwrapCollapsedWrappers({ allOf: [{ type: 'string', description: 'member' }, text] }).description).toBe('d');
    expect(
      unwrapCollapsedWrappers({ allOf: [{ type: 'string', description: 'member' }, text], description: 'own' })
        .description,
    ).toBe('own');
    expect(mintedInlineNameEntries('kind', { allOf: [kindEnum, text] }, 'Pet').map((e) => e.name)).toEqual(['PetKind']);

    // A stop field or data path behind the same wrapper is read the same way.
    expect(resolveBareSchema({ allOf: [{ type: 'boolean' }, text] })).toEqual({ type: 'boolean' });
    expect(resolveBareSchema({ allOf: [ref('Flag'), text] }, { Flag: { type: 'boolean' } })).toEqual({
      type: 'boolean',
    });
  });

  // The review (workos/oagen#587): the docs say an annotating member is part
  // of the wrapper, but the model built from the schema — a component
  // `allOf` (`extractAllOfModel`) or an inline merge (`mergeAllOfMembers`) —
  // read the wrapper's own keys alone, so `Owner: { allOf: [{ $ref: Base },
  // { properties }, { description: 'An owner.', deprecated: true }] }` was a
  // model with neither while the same keys beside the `allOf` were its own,
  // and `oagen diff` between the spellings reported `deprecatedChanged`.
  it.each(['3.1.0', '3.0.3'])(
    'documents and flags the model built from the schema by its annotating members, as the field (the review, OAS %s)',
    async (openapi) => {
      const Base: SchemaObject = { type: 'object', properties: { id: { type: 'string' } } };
      const named: SchemaObject = { type: 'object', properties: { name: { type: 'string' } } };
      const lettered: SchemaObject = { type: 'object', properties: { a: { type: 'string' } } };
      const annotation: SchemaObject = {
        description: 'An owner.',
        deprecated: true,
        externalDocs: { url: 'https://example.com/owner' },
        'x-internal': true,
      };
      const docOf = (
        schemas: Record<string, SchemaObject>,
        pet: Record<string, SchemaObject>,
        body: SchemaObject,
      ): Record<string, unknown> => {
        const spec = petDoc(openapi, pet) as { paths: Record<string, unknown>; components: { schemas: object } };
        return {
          ...spec,
          paths: {
            ...spec.paths,
            '/owners': { get: { operationId: 'getOwner', responses: { '200': jsonResponse(body) } } },
          },
          components: { schemas: { ...spec.components.schemas, Base, ...schemas } },
        };
      };
      const member = await parseWithoutWarnings(
        docOf(
          {
            Owner: { allOf: [ref('Base'), named, annotation] },
            // The wrapper's own text wins; a blank one declares none, as under every wrapper.
            Own: { allOf: [ref('Base'), named, { description: 'Member.' }], description: 'Own.' },
            Blank: { allOf: [ref('Base'), named, { description: 'Member.' }], description: '' },
            // `deprecated` from any annotating member; the text from the first that has one.
            Flagged: { allOf: [ref('Base'), named, { description: 'A' }, { deprecated: true }, { description: 'B' }] },
            // A typing member's own keys stay on that member.
            Typed: { allOf: [ref('Base'), { ...named, description: 'The name part.', deprecated: true }] },
          },
          {
            owner: ref('Owner'),
            own: ref('Own'),
            blank: ref('Blank'),
            flagged: ref('Flagged'),
            typed: ref('Typed'),
            x: { allOf: [lettered, { description: 'D', deprecated: true, 'x-k': 'm' }] },
          },
          { allOf: [named, { deprecated: true, 'x-k': 'r' }] },
        ),
      );
      const models = modelsByName(member);
      expect(models['Owner']).toMatchObject({
        description: 'An owner.',
        deprecated: true,
        externalDocs: { url: 'https://example.com/owner' },
        extensions: { 'x-internal': true },
      });
      expect(fieldsOf(models['Owner'])).toEqual(['id?: string', 'name?: string']);
      expect(models['Own']?.description).toBe('Own.');
      expect(models['Blank']?.description).toBe('Member.');
      expect(models['Flagged']).toMatchObject({ description: 'A', deprecated: true });
      expect(models['Typed']?.description).toBeUndefined();
      expect(models['Typed']?.deprecated).toBeUndefined();
      // The inline merge: the field and the model it names read the member alike.
      expect(shown(fieldOf(member, 'x'))).toEqual({ type: model('PetX'), description: 'D', deprecated: true });
      expect(models['PetX']).toMatchObject({ description: 'D', deprecated: true, extensions: { 'x-k': 'm' } });
      expect(fieldsOf(models['PetX'])).toEqual(['a?: string']);
      // A merged response body carries the member's flag and keys as a component `allOf` does.
      expect(opsOf(member)['getOwner']?.response).toEqual(model('GetOwnerResponse'));
      expect(models['GetOwnerResponse']).toMatchObject({ deprecated: true, extensions: { 'x-k': 'r' } });
      expectSound(member, ['Base', 'Blank', 'Flagged', 'Kind', 'Own', 'Owner', 'Pet', 'PetId', 'Typed']);

      // `oagen diff` between the two spellings reports nothing, either way.
      const beside = await parseWithoutWarnings(
        docOf(
          {
            Owner: { allOf: [ref('Base'), named], ...annotation },
            Own: { allOf: [ref('Base'), named], description: 'Own.' },
            Blank: { allOf: [ref('Base'), named], description: 'Member.' },
            Flagged: { allOf: [ref('Base'), named], description: 'A', deprecated: true },
            Typed: { allOf: [ref('Base'), named] },
          },
          {
            owner: ref('Owner'),
            own: ref('Own'),
            blank: ref('Blank'),
            flagged: ref('Flagged'),
            typed: ref('Typed'),
            x: { allOf: [lettered], description: 'D', deprecated: true, 'x-k': 'm' },
          },
          { allOf: [named], deprecated: true, 'x-k': 'r' },
        ),
      );
      expect(diffSpecs(beside, member).changes).toEqual([]);
      expect(diffSpecs(member, beside).changes).toEqual([]);
    },
  );

  // The review: `declaresType` counted `items`, so `{ items: { description }
  // }` beside an array was a second typing member and the schema `unknown`
  // with a warning, while `{ allOf: [array], items: { description } }` was
  // the array. Items that declare no type themselves declare none for the
  // member, and document the typing member's items as the same two
  // declarations of one property do (#431).
  it.each(['3.1.0', '3.0.3'])(
    "reads a member whose items only document the array's items as annotating (the review, OAS %s)",
    async (openapi) => {
      const owners: SchemaObject = { type: 'array', items: ref('Owner') };
      const itemsDoc: SchemaObject = { items: { description: 'An owner.' } };
      const ir = await parseWithoutWarnings(
        petDoc(openapi, {
          owners: { allOf: [owners, itemsDoc] },
          tags: { allOf: [{ type: 'array', items: kindEnum }, { items: { description: 'A tag.' } }, { minItems: 1 }] },
          names: {
            allOf: [
              { type: 'array', items: { type: 'string', description: 'Own.' } },
              { items: { description: 'Member.' }, description: 'The names.' },
            ],
          },
        }),
      );
      expect(shown(fieldOf(ir, 'owners'))).toEqual({ type: { kind: 'array', items: model('Owner') } });
      expect(shown(fieldOf(ir, 'tags'))).toEqual({
        // The agreed limit is the array's too (#545).
        type: {
          kind: 'array',
          items: { kind: 'enum', name: 'PetTags', values: ['cat', 'dog'] },
          constraints: { minItems: 1 },
        },
        constraints: { minItems: 1 },
      });
      // The items' documentation rides onto the items: the enum lifted from them carries it.
      expect(enumOf(ir, 'PetTags')).toMatchObject({ description: 'A tag.' });
      expect(shown(fieldOf(ir, 'names'))).toEqual({ type: { kind: 'array', items: str }, description: 'The names.' });
      expectSound(ir, ['Kind', 'Owner', 'Pet']);

      // `oagen diff` against the wrapper spelling reports nothing.
      const beside = await parseWithoutWarnings(
        petDoc(openapi, {
          owners: { allOf: [owners], ...itemsDoc },
          tags: { allOf: [{ type: 'array', items: kindEnum }], minItems: 1 },
          names: {
            allOf: [{ type: 'array', items: { type: 'string', description: 'Own.' } }],
            description: 'The names.',
          },
        }),
      );
      expect(diffSpecs(beside, ir).changes).toEqual([]);
    },
  );

  it('decides items that declare no type once, for an allOf member and for two declarations of a property alike', () => {
    const owners: SchemaObject = { type: 'array', items: ref('Owner') };
    const itemsDoc: SchemaObject = { items: { description: 'An owner.' } };
    const typedItems: SchemaObject = { items: { type: 'string' } };
    expect(declaresType(itemsDoc)).toBe(false);
    expect(declaresType({ items: {} })).toBe(false);
    expect(declaresType(typedItems)).toBe(true);
    expect(declaresType({ items: ref('Owner') })).toBe(true);
    expect(declaresType({ type: 'array' })).toBe(true);

    expect(allOfTypingMember([owners, itemsDoc])).toBe(owners);
    expect(annotatingAllOfMembers({ allOf: [owners, itemsDoc] })).toEqual([itemsDoc]);
    expect(readInlineAllOf([owners, itemsDoc])).toBe('unwrapped');
    expect(classifyInlineSchema({ allOf: [owners, itemsDoc] })).toBe('allOf');
    expect(typesAsUnknown({ allOf: [owners, itemsDoc] })).toBe(false);
    expect(schemaToTypeRef({ allOf: [owners, itemsDoc] }, 'owners', 'Pet')).toEqual({
      kind: 'array',
      items: model('Owner'),
    });
    // Items that declare a type make a second typing member, read as neither, as before.
    expect(allOfTypingMember([owners, typedItems])).toBeUndefined();
    expect(readInlineAllOf([owners, typedItems])).toBe('reference');
    expect(classifyInlineSchema({ allOf: [owners, typedItems] })).toBe('other');
    expect(typesAsUnknown({ allOf: [owners, typedItems] })).toBe(true);

    // The member's items carry what the annotating members' items write and
    // they leave unset, the first member's first; a member with no items of
    // its own takes none.
    const later: SchemaObject = { items: { description: 'Later.', 'x-k': 'm' } };
    expect(unwrappedAllOfMember({ allOf: [owners, itemsDoc, later] })).toEqual({
      type: 'array',
      items: { ...ref('Owner'), description: 'An owner.', 'x-k': 'm' },
    });
    expect(unwrappedAllOfMember({ allOf: [{ type: 'string' }, itemsDoc] })).toEqual({ type: 'string' });
    expect(unwrappedAllOfMember({ allOf: [{ type: 'array' }, itemsDoc] })).toEqual({ type: 'array' });

    // Two declarations of one property read the same pair the same way, in either order (#431).
    const typed: SchemaObject = { type: 'array', items: { type: 'string', enum: ['a'] } };
    const documented: SchemaObject = { items: { description: 'D' } };
    const expected = { type: 'array', items: { type: 'string', enum: ['a'], description: 'D' } };
    expect(combineDeclarations(typed, documented)).toEqual(expected);
    expect(combineDeclarations(documented, typed)).toEqual(expected);
    expect(combineDeclarations(typed, { ...documented, description: 'Outer' })).toEqual({
      ...expected,
      description: 'Outer',
    });
    expect(combineDeclarations({ type: 'string' }, documented)).toEqual({ type: 'string' });
    expect(combineDeclarations(documented, { type: 'string' })).toEqual({ type: 'string' });
    // A lone declaration keeps its identity when nothing is added.
    expect(combineDeclarations(typed, { items: {} })).toBe(typed);
  });

  // Greptile on #587: the annotating members were folded as limit levels of
  // their own, although `extractConstraints` already conjoins their limits
  // with the schema's; folded first, a member's `pattern` or `multipleOf`
  // won over the schema's own, which `combineConstraints` keeps.
  it("keeps the schema's own pattern and multipleOf over a conflicting member's, as the base branch did (Greptile)", async () => {
    const ir = await parseWithoutWarnings(
      petDoc('3.1.0', {
        pattern: { type: 'string', pattern: '^a', allOf: [{ pattern: 'b$' }] },
        multiple: { type: 'integer', multipleOf: 2, allOf: [{ multipleOf: 3 }] },
        described: { type: 'string', pattern: '^a', allOf: [{ pattern: 'b$' }, { description: 'Q' }] },
        bounds: { type: 'string', minLength: 1, maxLength: 5, allOf: [{ minLength: 2, maxLength: 3 }] },
        // Between members, document order: the typing member's first.
        typing: {
          allOf: [
            { type: 'string', pattern: '^a' },
            { pattern: 'b$', description: 'T' },
          ],
        },
      }),
    );
    // The field's reading is its type's too (#545), the schema's own keyword winning on both.
    const limited = (type: object, constraints: Record<string, unknown>) => ({ ...type, constraints });
    expect(shown(fieldOf(ir, 'pattern'))).toEqual({
      type: limited(str, { pattern: '^a' }),
      constraints: { pattern: '^a' },
    });
    expect(shown(fieldOf(ir, 'multiple'))).toEqual({
      type: limited(int, { multipleOf: 2 }),
      constraints: { multipleOf: 2 },
    });
    expect(shown(fieldOf(ir, 'described'))).toEqual({
      type: limited(str, { pattern: '^a' }),
      constraints: { pattern: '^a' },
      description: 'Q',
    });
    expect(shown(fieldOf(ir, 'bounds'))).toEqual({
      type: limited(str, { minLength: 2, maxLength: 3 }),
      constraints: { minLength: 2, maxLength: 3 },
    });
    expect(shown(fieldOf(ir, 'typing'))).toEqual({
      type: limited(str, { pattern: '^a' }),
      constraints: { pattern: '^a' },
      description: 'T',
    });
  });

  // Greptile on #587, second round: two typeless declarations of one
  // property were merged by `annotateDeclaration`, which drops the
  // annotating declaration's `items` as supplying none — before any typing
  // declaration had items to annotate — so `{ description: 'Tags' }`, then
  // `{ items: { description: 'A tag' } }`, then the array lost "A tag",
  // while the array first kept it.
  it.each(['3.1.0', '3.0.3'])(
    'keeps the items annotation of two typeless declarations for the array that follows, in either order (Greptile, OAS %s)',
    async (openapi) => {
      const text: SchemaObject = { description: 'Tags' };
      const itemsDoc: SchemaObject = { items: { description: 'A tag' } };
      const array: SchemaObject = { type: 'array', items: { type: 'string', enum: ['a', 'b'] } };
      const declaring = (tags: SchemaObject): SchemaObject => ({ type: 'object', properties: { tags } });
      const docOf = (members: SchemaObject[]): Record<string, unknown> => {
        const spec = petDoc(openapi, { list: ref('TagList') }) as { components: { schemas: object } };
        return {
          ...spec,
          components: { schemas: { ...spec.components.schemas, TagList: { allOf: members.map(declaring) } } },
        };
      };
      const tagsOf = (ir: ApiSpec) => {
        const field = modelsByName(ir)['TagList']!.fields.find((f) => f.name === 'tags')!;
        return { type: field.type, description: field.description, items: enumOf(ir, 'TagListTags')?.description };
      };
      const expected = {
        type: { kind: 'array', items: { kind: 'enum', name: 'TagListTags', values: ['a', 'b'] } },
        description: 'Tags',
        items: 'A tag',
      };
      const orders: [string, SchemaObject[]][] = [
        ['annotations first', [text, itemsDoc, array]],
        ['items annotation first', [itemsDoc, text, array]],
        ['array between', [text, array, itemsDoc]],
        ['array first', [array, text, itemsDoc]],
      ];
      for (const [label, members] of orders) {
        const ir = await parseWithoutWarnings(docOf(members));
        expect(tagsOf(ir), label).toEqual(expected);
        expectSound(ir, ['Kind', 'Owner', 'Pet', 'TagList']);
      }
      const [first, ...rest] = await Promise.all(orders.map(([, members]) => parseWithoutWarnings(docOf(members))));
      for (const other of rest) expect(diffSpecs(first!, other).changes).toEqual([]);

      // The pair of typeless declarations keeps both their keys and items for the typing one.
      expect(combineDeclarations(text, itemsDoc)).toEqual({ description: 'Tags', items: { description: 'A tag' } });
      expect(combineDeclarations(itemsDoc, text)).toEqual({ description: 'Tags', items: { description: 'A tag' } });
      expect(combineDeclarations({ items: { description: 'A' } }, { items: { description: 'B', 'x-k': 'm' } })).toEqual(
        {
          items: { description: 'A', 'x-k': 'm' },
        },
      );
      expect(combineDeclarations(combineDeclarations(text, itemsDoc), array)).toEqual({
        ...array,
        description: 'Tags',
        items: { ...array.items, description: 'A tag' },
      });
      // A lone typeless declaration keeps its identity when nothing is added.
      expect(combineDeclarations(text, { description: 'Other' })).toBe(text);
    },
  );
});

/**
 * workos/oagen#398: an `allOf` combined with a `oneOf`/`anyOf` read less
 * than the base and the variants, and read the same schema differently at
 * different sites. One reading now, at every site, however the two are
 * written: the base's fields plus each union's variant properties as
 * optional fields, a property the variants type differently typed as their
 * union, nested unions and `allOf`-wrapped variants read through, `$ref`
 * variants followed.
 */
describe('#398', () => {
  const str = { type: 'string' };
  const int = { type: 'integer' };
  const bool = { type: 'boolean' };
  const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
    type: 'object',
    properties,
    ...extra,
  });
  const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
  const base = obj({ name: str }, { required: ['name'] });
  const ownerVariants = [obj({ ownerId: str }), obj({ shelterId: str })];
  const getOp = (operationId: string, schema: unknown) => ({
    get: { operationId, responses: { '200': jsonResponse(schema) } },
  });
  const doc = (openapi: string, schemas: Record<string, unknown>, paths: Record<string, unknown>) => ({
    openapi,
    info,
    paths,
    components: { schemas },
  });
  /** `POST /pets` taking and returning `schema`, with `schema` as the component `NewPet` and as `Holder.pet`. */
  const sites = (openapi: string, schema: SchemaObject) =>
    doc(
      openapi,
      { NewPet: schema, Holder: obj({ pet: schema }) },
      {
        '/pets': {
          post: { operationId: 'createPet', requestBody: jsonBody(schema), responses: { '200': jsonResponse(schema) } },
        },
        '/new-pets': getOp('getNewPet', ref('NewPet')),
        '/holders': getOp('getHolder', ref('Holder')),
      },
    );
  const typed = (m: Model | undefined) =>
    m?.fields.map(({ name, required, type }) => `${name}${required ? '' : '?'}: ${show(type)}`);
  const show = (type: TypeRef): string =>
    type.kind === 'union'
      ? `(${type.variants.map(show).join(' | ')})`
      : type.kind === 'literal'
        ? JSON.stringify(type.value)
        : 'name' in type
          ? type.name
          : 'type' in type
            ? type.type
            : type.kind;
  const openapis = ['3.1.0', '3.0.3'];
  const keywords = ['oneOf', 'anyOf'] as const;
  const cases = openapis.flatMap((openapi) => keywords.map((keyword) => [openapi, keyword] as const));

  it.each(cases)(
    'case 1 (OAS %s, %s beside allOf): the base and the union at the component, the field, the request body and the response',
    async (openapi, keyword) => {
      const beside: SchemaObject = { allOf: [base], [keyword]: ownerVariants };
      const ir = await parseWithoutWarnings(sites(openapi, beside));
      const models = modelsByName(ir);
      const expected = ['name: string', 'ownerId?: string', 'shelterId?: string'];
      expect(fieldsOf(models['NewPet'])).toEqual(expected);
      expect(fieldsOf(models['HolderPet'])).toEqual(expected);
      expect(fieldsOf(models['CreatePetResponse'])).toEqual(expected);
      // One merged model, not a union of the variants without `name`.
      expect(opsOf(ir)['createPet']?.requestBody).toEqual(model('CreatePetRequest'));
      expect(fieldsOf(models['CreatePetRequest'])).toEqual(expected);
      expect(models['CreatePetRequestWithShelterId']).toBeUndefined();
      expectSound(ir, ['NewPet', 'Holder']);
      // The one reading: `oagen diff` between the union written beside the
      // `allOf` and written as its member reports nothing.
      const asMember = await parseWithoutWarnings(sites(openapi, { allOf: [base, { [keyword]: ownerVariants }] }));
      expect(diffSpecs(asMember, ir).changes).toEqual([]);
    },
  );

  it.each(cases)(
    'case 1 (OAS %s, %s beside a $ref member): the response is the merge of the component and the variants',
    async (openapi, keyword) => {
      const ir = await parseWithoutWarnings(
        doc(
          openapi,
          { Pet: base },
          { '/pets/{id}': getOp('getPet', { allOf: [ref('Pet')], [keyword]: ownerVariants }) },
        ),
      );
      const models = modelsByName(ir);
      expect(opsOf(ir)['getPet']?.response).toEqual(model('GetPetResponse'));
      expect(fieldsOf(models['GetPetResponse'])).toEqual(['name: string', 'ownerId?: string', 'shelterId?: string']);
      // The component keeps its own fields.
      expect(fieldsOf(models['Pet'])).toEqual(['name: string']);
      expectSound(ir, ['Pet']);
    },
  );

  it.each(openapis)(
    'case 2 (OAS %s): a component reads a nested union, a typed property and a wrapped variant as its inline twin does',
    async (openapi) => {
      const nested: SchemaObject = {
        allOf: [base, { oneOf: [{ oneOf: [obj({ a: str }), obj({ b: str })] }, obj({ c: str })] }],
      };
      const typedSchema: SchemaObject = { allOf: [base, { oneOf: [obj({ kind: str }), obj({ kind: int })] }] };
      const wrapped: SchemaObject = {
        allOf: [base, { oneOf: [{ allOf: [obj({ a: str })] }, { allOf: [obj({ b: str })] }] }],
      };
      const ir = await parseWithoutWarnings(
        doc(
          openapi,
          {
            Nested: nested,
            Typed: typedSchema,
            Wrapped: wrapped,
            Holder: obj({ nested, typed: typedSchema, wrapped }),
          },
          {
            '/nested': getOp('getNested', ref('Nested')),
            '/typed': getOp('getTyped', ref('Typed')),
            '/wrapped': getOp('getWrapped', ref('Wrapped')),
            '/holders': getOp('getHolder', ref('Holder')),
          },
        ),
      );
      const models = modelsByName(ir);
      expect(typed(models['Nested'])).toEqual(['name: string', 'a?: string', 'b?: string', 'c?: string']);
      expect(typed(models['Typed'])).toEqual(['name: string', 'kind?: (string | integer)']);
      expect(typed(models['Wrapped'])).toEqual(['name: string', 'a?: string', 'b?: string']);
      for (const name of ['Nested', 'Typed', 'Wrapped']) {
        expect(typed(models[`Holder${name}`]), name).toEqual(typed(models[name]));
      }
      expectSound(ir, ['Nested', 'Typed', 'Wrapped', 'Holder']);
    },
  );

  it.each(openapis)(
    'case 3 (OAS %s): a member carrying both a oneOf and an anyOf is one of the first and any of the second',
    async (openapi) => {
      const both: SchemaObject = {
        allOf: [base, { oneOf: ownerVariants, anyOf: [obj({ vetId: str }), obj({ clinicId: str })] }],
      };
      const ir = await parseWithoutWarnings(
        doc(
          openapi,
          { Both: both, Holder: obj({ both }) },
          {
            '/pets': {
              post: { operationId: 'createPet', requestBody: jsonBody(both), responses: { '200': jsonResponse(both) } },
            },
            '/both': getOp('getBoth', ref('Both')),
            '/holders': getOp('getHolder', ref('Holder')),
          },
        ),
      );
      const models = modelsByName(ir);
      const expected = [
        'name: string',
        'ownerId?: string',
        'shelterId?: string',
        'vetId?: string',
        'clinicId?: string',
      ];
      for (const name of ['Both', 'CreatePetRequest', 'CreatePetResponse', 'HolderBoth']) {
        expect(fieldsOf(models[name]), name).toEqual(expected);
      }
      expectSound(ir, ['Both', 'Holder']);
    },
  );

  describe('a component allOf whose union has $ref variants (the comment)', () => {
    const pin = (openapi: string, value: string): SchemaObject =>
      openapi === '3.1.0' ? { type: 'string', const: value } : { type: 'string', enum: [value] };
    const animals = (openapi: string): Record<string, SchemaObject> => ({
      Base: obj({ id: str }, { required: ['id'] }),
      Cat: obj({ kind: pin(openapi, 'cat'), lives: str }, { required: ['kind'] }),
      Dog: obj({ kind: pin(openapi, 'dog'), breed: str }, { required: ['kind'] }),
      Bird: obj({ kind: pin(openapi, 'bird'), wingspan: str }, { required: ['kind'] }),
    });
    const petDoc = (openapi: string, pet: SchemaObject) =>
      doc(openapi, { ...animals(openapi), Pet: pet }, { '/pets/{id}': getOp('getPet', ref('Pet')) });
    const refs = (names: string[]) => names.map(ref);
    /** The three spellings of the dispatcher: the keyword beside the `allOf`, on the inner union with a mapping, and no keyword at all. */
    const spellings = (variants: string[]): Array<[string, SchemaObject]> => [
      [
        'beside the allOf',
        { allOf: [ref('Base'), { oneOf: refs(variants) }], discriminator: { propertyName: 'kind' } },
      ],
      [
        'on the inner oneOf, with a mapping',
        {
          allOf: [
            ref('Base'),
            {
              oneOf: refs(variants),
              discriminator: {
                propertyName: 'kind',
                mapping: Object.fromEntries(variants.map((v) => [v.toLowerCase(), `#/components/schemas/${v}`])),
              },
            },
          ],
        },
      ],
      ['implicit, from the consts', { allOf: [ref('Base'), { oneOf: refs(variants) }] }],
    ];

    it.each(openapis)(
      'is a dispatcher whose mapping names the components, built for nothing again (OAS %s)',
      async (openapi) => {
        for (const [label, pet] of spellings(['Cat', 'Dog'])) {
          const ir = await parseWithoutWarnings(petDoc(openapi, pet));
          const models = modelsByName(ir);
          expect(models['Pet']?.discriminator, label).toEqual({
            property: 'kind',
            mapping: { cat: 'Cat', dog: 'Dog' },
          });
          expect(fieldsOf(models['Pet']), label).toEqual(['id: string']);
          expect(Object.keys(models).sort(), label).toEqual(['Base', 'Bird', 'Cat', 'Dog', 'Pet']);
          expectSound(ir, ['Base', 'Cat', 'Dog', 'Bird', 'Pet']);
        }
      },
    );

    it.each(openapis)('reports a $ref variant added as additive and removed as breaking (OAS %s)', async (openapi) => {
      const twoOf = spellings(['Cat', 'Dog']);
      const threeOf = spellings(['Cat', 'Dog', 'Bird']);
      for (const [index, [label, two]] of twoOf.entries()) {
        const [, three] = threeOf[index]!;
        const oldSpec = await parseWithoutWarnings(petDoc(openapi, two));
        const newSpec = await parseWithoutWarnings(petDoc(openapi, three));
        expect(modelsByName(newSpec)['Pet']?.discriminator?.mapping, label).toEqual({
          cat: 'Cat',
          dog: 'Dog',
          bird: 'Bird',
        });
        expect(diffSpecs(oldSpec, newSpec).changes, label).toEqual([
          expect.objectContaining({
            kind: 'model-modified',
            name: 'Pet',
            classification: 'additive',
            variantChanges: [
              {
                kind: 'variant-added',
                variant: 'Bird',
                classification: 'additive',
                details: "mapping added for 'bird'",
              },
            ],
          }),
        ]);
        expect(diffSpecs(newSpec, oldSpec).changes, label).toEqual([
          expect.objectContaining({
            kind: 'model-modified',
            name: 'Pet',
            classification: 'breaking',
            variantChanges: [
              {
                kind: 'variant-removed',
                variant: 'Bird',
                classification: 'breaking',
                details: "mapping removed for 'bird'",
              },
            ],
          }),
        ]);
      }
    });

    it.each(openapis)(
      "flattens $ref variants that pin no const into the model, as inline variants are, at every site (OAS %s; #527's shape)",
      async (openapi) => {
        const trace = obj({ trace_id: str });
        const meta: SchemaObject = { allOf: [{ oneOf: [ref('CursorMeta'), ref('PageMeta')] }, trace] };
        const ir = await parseWithoutWarnings(
          doc(
            openapi,
            {
              CursorMeta: obj({ has_more: bool, next_after: str }),
              PageMeta: obj({ has_more: bool, next_page: int }),
              Meta: meta,
              Holder: obj({ meta }),
            },
            {
              '/meta': getOp('getMeta', ref('Meta')),
              '/meta/inline': getOp('getMetaInline', meta),
              '/holders': getOp('getHolder', ref('Holder')),
            },
          ),
        );
        const models = modelsByName(ir);
        const expected = ['has_more?: boolean', 'next_after?: string', 'next_page?: integer', 'trace_id?: string'];
        for (const name of ['Meta', 'GetMetaInlineResponse', 'HolderMeta']) {
          expect(fieldsOf(models[name]), name).toEqual(expected);
          expect(models[name]?.discriminator, name).toBeUndefined();
        }
        expectSound(ir, ['CursorMeta', 'PageMeta', 'Meta', 'Holder']);
      },
    );
  });

  describe('review', () => {
    // Round 1 (MichaelDeBoey, finding 1): a union beside the `allOf` whose
    // `$ref` variant is the component the field sits in. The merge reaches
    // `Note.reply` again through the variant, so the extractor's guard
    // (#566) must meet the same folded schema on every re-entry:
    // `foldSiblingProperties` folds a schema to one object (it made a new
    // copy on every fold, and the re-entry never ended).
    const noteDoc = (openapi: string, reply: SchemaObject) =>
      doc(
        openapi,
        { Note: obj({ id: str, reply }, { required: ['id'] }) },
        { '/notes': getOp('getNote', ref('Note')) },
      );
    const selfOrOther = (keyword: 'oneOf' | 'anyOf'): SchemaObject => ({
      [keyword]: [ref('Note'), obj({ other: str })],
    });
    const sortedFields = (ir: ApiSpec): Record<string, string[]> =>
      Object.fromEntries(ir.models.map((m) => [m.name, [...(fieldsOf(m) ?? [])].sort()]));

    it.each(cases)(
      'a union beside an allOf whose $ref variant is the component the field sits in ends where the member spelling ends (OAS %s, %s)',
      async (openapi, keyword) => {
        const depth = obj({ depth: int });
        const beside: SchemaObject = { allOf: [depth], ...selfOrOther(keyword) };
        const member: SchemaObject = { allOf: [depth, selfOrOther(keyword)] };
        const asMember = await parseWithoutWarnings(noteDoc(openapi, member));
        const expected = ['depth?: integer', 'id?: string', 'reply?: NoteReply', 'other?: string'];
        expect(fieldsOf(modelsByName(asMember)['NoteReply'])).toEqual(expected);
        const asBeside = await parseWithoutWarnings(noteDoc(openapi, beside));
        expect(fieldsOf(modelsByName(asBeside)['NoteReply'])).toEqual(expected);
        expect(diffSpecs(asMember, asBeside).changes).toEqual([]);
        expectSound(asBeside, ['Note']);
        // As array items and as map values alike.
        for (const wrap of [
          (reply: SchemaObject): SchemaObject => ({ type: 'array', items: reply }),
          (reply: SchemaObject): SchemaObject => ({ type: 'object', additionalProperties: reply }),
        ]) {
          const wrappedMember = await parseWithoutWarnings(noteDoc(openapi, wrap(member)));
          const wrappedBeside = await parseWithoutWarnings(noteDoc(openapi, wrap(beside)));
          expect(sortedFields(wrappedBeside)).toEqual(sortedFields(wrappedMember));
          expect(diffSpecs(wrappedMember, wrappedBeside).changes).toEqual([]);
          expectSound(wrappedBeside, ['Note']);
        }
      },
    );

    it.each(openapis)(
      'properties beside an allOf that reaches the field again end where the member spelling ends (OAS %s; predates the PR)',
      async (openapi) => {
        // #566's shape with the inline member's properties written beside
        // the `allOf`: folded as the member, so the re-entry ends at the
        // conjunction it already built (it overflowed on the base too).
        const own = { quoted: str, reply: obj({ depth: int }) };
        const asMember = await parseWithoutWarnings(noteDoc(openapi, { allOf: [ref('Note'), obj(own)] }));
        expect(fieldsOf(modelsByName(asMember)['NoteReplyReply'])).toEqual([
          'id: string',
          'reply?: NoteReplyReply',
          'quoted?: string',
          'depth?: integer',
        ]);
        const asBeside = await parseWithoutWarnings(noteDoc(openapi, { allOf: [ref('Note')], properties: own }));
        expect(sortedFields(asBeside)).toEqual(sortedFields(asMember));
        expect(diffSpecs(asMember, asBeside).changes).toEqual([]);
        expectSound(asBeside, ['Note']);
      },
    );

    it.each(cases)(
      'under a nullable wrapper, a union beside the allOf that reaches the field again ends where the member spelling ends (OAS %s, %s)',
      async (openapi, keyword) => {
        // Left to #596's review at round 1: every unwrap of the wrapper made
        // a copy the guard had never seen. The fold's copy stands for the
        // declaration it was spread from (`derivedCopy`), as the unwrap's
        // does, so the guard meets one key through both and the re-entry
        // ends here as it does without the wrapper.
        const nullable: SchemaObject =
          openapi === '3.1.0' ? { type: ['object', 'null'] } : { type: 'object', nullable: true };
        const depth = obj({ depth: int });
        const member: SchemaObject = { ...nullable, allOf: [depth, selfOrOther(keyword)] };
        const beside: SchemaObject = { ...nullable, allOf: [depth], ...selfOrOther(keyword) };
        const asMember = await parseWithoutWarnings(noteDoc(openapi, member));
        const asBeside = await parseWithoutWarnings(noteDoc(openapi, beside));
        const expected = ['depth?: integer', 'id?: string', 'reply?: nullable', 'other?: string'];
        expect(fieldsOf(modelsByName(asMember)['NoteReply'])).toEqual(expected);
        expect(fieldsOf(modelsByName(asBeside)['NoteReply'])).toEqual(expected);
        for (const ir of [asMember, asBeside]) {
          const reply = (name: string) => modelsByName(ir)[name]?.fields.find((f) => f.name === 'reply')?.type;
          expect(reply('Note')).toEqual({ kind: 'nullable', inner: model('NoteReply') });
          expect(reply('NoteReply')).toEqual({ kind: 'nullable', inner: model('NoteReply') });
        }
        expect(diffSpecs(asMember, asBeside).changes).toEqual([]);
        expectSound(asBeside, ['Note']);
      },
    );

    // Round 1 (MichaelDeBoey, finding 2; Greptile): a member writing a
    // nullable `oneOf` beside an `anyOf`. The wrapper is decided per keyword
    // (`nullableAxisBranch`), so the `anyOf` is flattened as it is when the
    // two keywords are two members, or the union sits beside the `allOf`
    // (the member was read by one keyword, and `b`, `c` were lost).
    it.each(openapis)(
      'a nullable oneOf beside an anyOf on one member keeps the anyOf, as two members and the union beside the allOf do (OAS %s)',
      async (openapi) => {
        const unions = { oneOf: [obj({ a: str }), { type: 'null' }], anyOf: [obj({ b: str }), obj({ c: str })] };
        const spellings: Record<string, SchemaObject> = {
          'one member': { allOf: [base, { ...unions }] },
          'two members': { allOf: [base, { oneOf: unions.oneOf }, { anyOf: unions.anyOf }] },
          'beside the allOf': { allOf: [base], ...unions },
        };
        const expected = ['name: string', 'a?: string', 'b?: string', 'c?: string'];
        const parsed: Record<string, ApiSpec> = {};
        for (const [label, schema] of Object.entries(spellings)) {
          const ir = await parseWithoutWarnings(sites(openapi, schema));
          parsed[label] = ir;
          const models = modelsByName(ir);
          for (const name of ['NewPet', 'HolderPet', 'CreatePetResponse', 'CreatePetRequest']) {
            expect(fieldsOf(models[name]), `${label} ${name}`).toEqual(expected);
          }
          expect(opsOf(ir)['createPet']?.requestBody, label).toEqual(model('CreatePetRequest'));
          expectSound(ir, ['NewPet', 'Holder']);
        }
        expect(diffSpecs(parsed['two members']!, parsed['one member']!).changes).toEqual([]);
        expect(diffSpecs(parsed['two members']!, parsed['beside the allOf']!).changes).toEqual([]);
        // The mirror: a nullable `anyOf` beside a `oneOf`.
        const mirror: SchemaObject = {
          allOf: [base, { anyOf: [obj({ a: str }), { type: 'null' }], oneOf: [obj({ b: str }), obj({ c: str })] }],
        };
        const mirrored = await parseWithoutWarnings(sites(openapi, mirror));
        expect(fieldsOf(modelsByName(mirrored)['NewPet'])).toEqual([
          'name: string',
          'b?: string',
          'c?: string',
          'a?: string',
        ]);
        expect(fieldsOf(modelsByName(mirrored)['HolderPet'])).toEqual(fieldsOf(modelsByName(mirrored)['NewPet']));
      },
    );

    // Round 1 (Greptile): declarations inside one variant's `allOf` apply
    // together. The variant is read as the one conjunction it is
    // (`declareVariant`, through `readVariant`), so documenting a field in
    // a second member does not widen it (each member's declaration was a
    // branch of its own, and `value` was `string | unknown`).
    it.each(cases)(
      "declarations inside one variant's allOf conjoin before the variant joins the union (OAS %s, %s)",
      async (openapi, keyword) => {
        const documented: SchemaObject = { allOf: [obj({ value: str }), obj({ value: { description: 'doc' } })] };
        const expected = ['name: string', 'value?: string', 'other?: string'];
        for (const schema of [
          { allOf: [base, { [keyword]: [documented, obj({ other: str })] }] },
          { allOf: [base], [keyword]: [documented, obj({ other: str })] },
        ] as SchemaObject[]) {
          const ir = await parseWithoutWarnings(sites(openapi, schema));
          const models = modelsByName(ir);
          for (const name of ['NewPet', 'HolderPet', 'CreatePetResponse', 'CreatePetRequest']) {
            expect(fieldsOf(models[name]), name).toEqual(expected);
            expect(models[name]?.fields.find((f) => f.name === 'value')?.description, name).toBe('doc');
          }
          expectSound(ir, ['NewPet', 'Holder']);
        }
        // Through a `$ref` variant to a component written so, the same.
        const viaRef = await parseWithoutWarnings(
          doc(
            openapi,
            {
              Documented: documented,
              NewPet: { allOf: [base, { [keyword]: [ref('Documented'), obj({ other: str })] }] },
            },
            { '/new-pets': getOp('getNewPet', ref('NewPet')) },
          ),
        );
        expect(fieldsOf(modelsByName(viaRef)['NewPet'])).toEqual(expected);
        expect(modelsByName(viaRef)['NewPet']?.fields.find((f) => f.name === 'value')?.description).toBe('doc');
        expect(fieldsOf(modelsByName(viaRef)['Documented'])).toEqual(['value?: string']);
        expectSound(viaRef, ['Documented', 'NewPet']);
        // A union nested in the variant still makes alternatives of what its
        // own variants declare, beside what the variant always declares.
        const nested: SchemaObject = {
          allOf: [
            base,
            {
              [keyword]: [
                { allOf: [obj({ value: str })], oneOf: [obj({ x: str }), obj({ x: int })] },
                obj({ other: str }),
              ],
            },
          ],
        };
        const withNested = await parseWithoutWarnings(sites(openapi, nested));
        expect(typed(modelsByName(withNested)['NewPet'])).toEqual([
          'name: string',
          'value?: string',
          'x?: (string | integer)',
          'other?: string',
        ]);
      },
    );

    // Round 1 (Greptile): a stop field behind a union a `$ref` member's
    // component dispatches. The merge leaves the union to the component
    // (#429), so `Meta` carries the base fields and no variant's; the
    // override check reads the unions the model carries the fields of
    // (`unionCounts`), and rejects the path (every union counted, and the
    // iterator was told to read a field the model lacks).
    it.each(openapis)(
      "rejects an endOfIteration behind a union a $ref member's component dispatches, which the model leaves to it (OAS %s)",
      async (openapi) => {
        const cursorMeta = obj({ kind: { type: 'string', const: 'cursor' }, has_more: bool, next_after: str });
        const pageMeta = obj({ kind: { type: 'string', const: 'page' }, has_more: bool, next_page: int });
        const union = { oneOf: [ref('CursorMeta'), ref('PageMeta')] };
        const declared = { ...union, discriminator: { propertyName: 'kind' } };
        const endOfIteration = { kind: 'hasMore', path: 'meta.has_more' };
        const listPets = (meta: SchemaObject) => ({
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [{ name: 'after', in: 'query', schema: str }],
              responses: { '200': jsonResponse(obj({ data: { type: 'array', items: str }, meta })) },
              'x-pagination': { endOfIteration },
            },
          },
        });
        for (const axis of [union, declared]) {
          const schemas = {
            CursorMeta: cursorMeta,
            PageMeta: pageMeta,
            MetaDispatcher: { allOf: [obj({ base: str }), axis] },
          };
          const meta: SchemaObject = { allOf: [ref('MetaDispatcher'), obj({ trace_id: str })] };
          for (const [label, site, components] of [
            ['inline', meta, schemas],
            ['component', ref('Meta'), { ...schemas, Meta: meta }],
          ] as const) {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            try {
              const ir = await parseTempSpec(doc(openapi, components, listPets(site)));
              expect(opsOf(ir)['listPets']?.pagination?.endOfIteration, label).toBeUndefined();
              expect(
                warn.mock.calls.map(([m]) => String(m)),
                label,
              ).toEqual([expect.stringContaining('endOfIteration path "meta.has_more" does not resolve to a field')]);
              const models = modelsByName(ir);
              expect(fieldsOf(models['Meta']), label).toEqual(['base?: string', 'trace_id?: string']);
              expect(models['Meta']?.discriminator, label).toBeUndefined();
              expect(models['MetaDispatcher']?.discriminator, label).toEqual({
                property: 'kind',
                mapping: { cursor: 'CursorMeta', page: 'PageMeta' },
              });
            } finally {
              warn.mockRestore();
            }
          }
          // `meta` typed as the dispatcher itself, bare or as a lone `allOf`
          // member: every variant model has the field, and the path resolves.
          for (const site of [ref('MetaDispatcher'), { allOf: [ref('MetaDispatcher')] }] as SchemaObject[]) {
            const ir = await parseWithoutWarnings(doc(openapi, schemas, listPets(site)));
            expect(opsOf(ir)['listPets']?.pagination?.endOfIteration).toEqual(endOfIteration);
          }
        }
      },
    );

    // Round 2 (Greptile): a dispatching axis beside a nullable one on one
    // member. The member reader decides the wrapper per keyword and
    // dispatches the other axis; the variant builder must find that axis
    // the same way (`memberUnions`), so every mapping target names a model
    // it built (it collapsed the nullable `oneOf` for the whole member and
    // built neither variant).
    it.each(openapis)(
      'builds the variant models a dispatching axis beside a nullable one on one member maps to (OAS %s)',
      async (openapi) => {
        const cat = obj({ kind: { type: 'string', const: 'cat' }, lives: str }, { required: ['kind'] });
        const dogVariant = obj({ kind: { type: 'string', const: 'dog' }, breed: str }, { required: ['kind'] });
        const nullable = [obj({ a: str }), { type: 'null' }];
        for (const member of [
          { oneOf: nullable, anyOf: [cat, dogVariant] },
          { anyOf: nullable, oneOf: [cat, dogVariant] },
        ] as SchemaObject[]) {
          const ir = await parseWithoutWarnings(
            doc(openapi, { Pet: { allOf: [base, member] } }, { '/pets': getOp('getPet', ref('Pet')) }),
          );
          const models = modelsByName(ir);
          expect(models['Pet']?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'PetCat', dog: 'PetDog' } });
          expect(fieldsOf(models['Pet'])).toEqual(['name: string', 'a?: string']);
          // Every mapping target names a built model, carrying the base and
          // the nullable branch's field alike.
          expect(typed(models['PetCat'])).toEqual(['name: string', 'a?: string', 'kind: "cat"', 'lives?: string']);
          expect(typed(models['PetDog'])).toEqual(['name: string', 'a?: string', 'kind: "dog"', 'breed?: string']);
          expectSound(ir, ['Pet']);
        }
      },
    );

    // Round 3 (Greptile): `$ref` variants whose tag is not written on the
    // variant itself — inherited through an `allOf` `$ref` member, or a
    // `$ref` to a const schema. The detection now reads the tags through
    // the component map (#568's lookups), so the union dispatches and
    // `oagen diff` sees a variant added or removed (it was flattened, and
    // the diff saw a field change).
    it.each(openapis)(
      'dispatches $ref variants whose tag is inherited through an allOf $ref member, or is a $ref to a const schema, as tags written directly (OAS %s)',
      async (openapi) => {
        const tag = (value: string) => obj({ kind: { type: 'string', const: value } });
        const spellings: Array<[string, Record<string, SchemaObject>]> = [
          [
            'inherited through an allOf $ref member',
            {
              CatTag: tag('cat'),
              DogTag: tag('dog'),
              BirdTag: tag('bird'),
              Cat: { allOf: [ref('CatTag'), obj({ lives: str })] },
              Dog: { allOf: [ref('DogTag'), obj({ breed: str })] },
              Bird: { allOf: [ref('BirdTag'), obj({ wings: str })] },
            },
          ],
          [
            'a $ref to a const schema',
            {
              CatKind: { type: 'string', const: 'cat' },
              DogKind: { type: 'string', const: 'dog' },
              BirdKind: { type: 'string', const: 'bird' },
              Cat: obj({ kind: ref('CatKind'), lives: str }),
              Dog: obj({ kind: ref('DogKind'), breed: str }),
              Bird: obj({ kind: ref('BirdKind'), wings: str }),
            },
          ],
        ];
        const petDoc = (schemas: Record<string, SchemaObject>, variants: SchemaObject[]) =>
          doc(
            openapi,
            {
              Base: obj({ id: str }, { required: ['id'] }),
              ...schemas,
              Pet: { allOf: [ref('Base'), { oneOf: variants }] },
            },
            { '/pets': getOp('getPet', ref('Pet')) },
          );
        for (const [label, schemas] of spellings) {
          const { Bird: _bird, ...without } = schemas;
          const ir = await parseWithoutWarnings(petDoc(without, [ref('Cat'), ref('Dog')]));
          const models = modelsByName(ir);
          expect(models['Pet']?.discriminator, label).toEqual({
            property: 'kind',
            mapping: { cat: 'Cat', dog: 'Dog' },
          });
          expect(fieldsOf(models['Pet']), label).toEqual(['id: string']);
          expectSound(ir, Object.keys(without).concat('Base', 'Pet'));
          const withBird = await parseWithoutWarnings(petDoc(schemas, [ref('Cat'), ref('Dog'), ref('Bird')]));
          expect(modelsByName(withBird)['Pet']?.discriminator?.mapping, label).toEqual({
            cat: 'Cat',
            dog: 'Dog',
            bird: 'Bird',
          });
          const added = diffSpecs(ir, withBird).changes.find((c) => c.kind === 'model-modified' && c.name === 'Pet');
          expect(added, label).toMatchObject({
            classification: 'additive',
            variantChanges: [{ kind: 'variant-added', variant: 'Bird', classification: 'additive' }],
          });
          const removed = diffSpecs(withBird, ir).changes.find((c) => c.kind === 'model-modified' && c.name === 'Pet');
          expect(removed, label).toMatchObject({
            classification: 'breaking',
            variantChanges: [{ kind: 'variant-removed', variant: 'Bird', classification: 'breaking' }],
          });
        }
        // An inline variant inheriting its tag the same way is named by it
        // (`deriveDiscriminatedVariantName` reads through the map too), so
        // the union dispatches and both variant models are built.
        const inline = await parseWithoutWarnings(
          petDoc({ CatTag: tag('cat'), DogTag: tag('dog') }, [
            { allOf: [ref('CatTag'), obj({ lives: str })] },
            { allOf: [ref('DogTag'), obj({ breed: str })] },
          ]),
        );
        const inlineModels = modelsByName(inline);
        expect(inlineModels['Pet']?.discriminator).toEqual({
          property: 'kind',
          mapping: { cat: 'PetCat', dog: 'PetDog' },
        });
        // The variant model carries the base and the variant's own members, as
        // before: a `$ref` member among a dispatched inline variant's `allOf` is
        // not flattened into it (nor is `Extra.color` beside a direct tag).
        expect(typed(inlineModels['PetCat'])).toEqual(['id: string', 'lives?: string']);
        expect(typed(inlineModels['PetDog'])).toEqual(['id: string', 'breed?: string']);
        expectSound(inline, ['CatTag', 'DogTag', 'Base', 'Pet']);
      },
    );

    // Round 3 (Greptile): a member writing both keywords in the pagination
    // walk. The model reads both axes (round 1), so the walk collects one
    // union per keyword and reads a nullable axis beside the other as its
    // one variant, one more member (it collected the member as one union
    // read by its `oneOf`, so a stop field only the `anyOf`'s variants
    // declare, which the model has, resolved to no field).
    it.each(openapis)(
      'keeps an endOfIteration behind either keyword of a member writing both, as the model reads both (OAS %s)',
      async (openapi) => {
        const cursor = obj({ has_more: bool, next_after: str });
        const page = obj({ has_more: bool, next_page: int });
        const endOfIteration = { kind: 'hasMore', path: 'meta.has_more' };
        const listPets = (meta: SchemaObject, path = 'meta.has_more') => ({
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [{ name: 'after', in: 'query', schema: str }],
              responses: { '200': jsonResponse(obj({ data: { type: 'array', items: str }, meta })) },
              'x-pagination': { endOfIteration: { kind: 'hasMore', path } },
            },
          },
        });
        const metaBase = obj({ base: str });
        const members: Array<[string, SchemaObject]> = [
          ['one member', { oneOf: [obj({ a: str }), obj({ b: str })], anyOf: [cursor, page] }],
          ['anyOf first', { anyOf: [obj({ a: str }), obj({ b: str })], oneOf: [cursor, page] }],
          ['nullable oneOf beside the anyOf', { oneOf: [obj({ a: str }), { type: 'null' }], anyOf: [cursor, page] }],
          ['nullable anyOf beside the oneOf', { anyOf: [obj({ a: str }), { type: 'null' }], oneOf: [cursor, page] }],
        ];
        for (const [label, member] of members) {
          const ir = await parseWithoutWarnings(doc(openapi, {}, listPets({ allOf: [metaBase, member] })));
          expect(opsOf(ir)['listPets']?.pagination?.endOfIteration, label).toEqual(endOfIteration);
          expect(fieldsOf(modelsByName(ir)['Meta']), label).toContain('has_more?: boolean');
        }
        // The two keywords as two members read the same.
        const split = await parseWithoutWarnings(
          doc(
            openapi,
            {},
            listPets({ allOf: [metaBase, { oneOf: [obj({ a: str }), obj({ b: str })] }, { anyOf: [cursor, page] }] }),
          ),
        );
        expect(opsOf(split)['listPets']?.pagination?.endOfIteration).toEqual(endOfIteration);
        // A field one of the `anyOf`'s variants lacks still resolves to none.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const ir = await parseTempSpec(
            doc(openapi, {}, listPets({ allOf: [metaBase, members[0]![1]] }, 'meta.next_after')),
          );
          expect(opsOf(ir)['listPets']?.pagination?.endOfIteration).toBeUndefined();
          expect(warn.mock.calls.map(([m]) => String(m))).toEqual([
            expect.stringContaining('endOfIteration path "meta.next_after" does not resolve to a field'),
          ]);
        } finally {
          warn.mockRestore();
        }
      },
    );

    // Round 2 (Greptile): two variants inheriting one component. Each
    // variant is a conjunction of its own, with a cycle guard of its own, so
    // the component declares into both (the guard was shared across the
    // variants, and the second variant read its own member alone).
    it.each(cases)(
      "reads a component two variants name into each variant's conjunction (OAS %s, %s)",
      async (openapi, keyword) => {
        const variants = [
          { allOf: [ref('C'), obj({ payload: obj({ b: str }) })] },
          { allOf: [ref('C'), obj({ payload: obj({ c: str }) })] },
        ];
        const pet: SchemaObject = { allOf: [base, { [keyword]: variants }] };
        const ir = await parseWithoutWarnings(
          doc(
            openapi,
            { C: obj({ payload: obj({ a: str }) }), Pet: pet, Holder: obj({ pet }) },
            { '/pets': getOp('getPet', pet), '/holders': getOp('getHolder', ref('Holder')) },
          ),
        );
        const models = modelsByName(ir);
        for (const name of ['Pet', 'HolderPet', 'GetPetResponse']) {
          expect(typed(models[name]), name).toEqual([
            'name: string',
            `payload?: (${name}Payload | ${name}PayloadWithC)`,
          ]);
          expect(fieldsOf(models[`${name}Payload`]), name).toEqual(['a?: string', 'b?: string']);
          expect(fieldsOf(models[`${name}PayloadWithC`]), name).toEqual(['a?: string', 'c?: string']);
        }
        expectSound(ir, ['C', 'Pet', 'Holder']);
      },
    );
  });
});
