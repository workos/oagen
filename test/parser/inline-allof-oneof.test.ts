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
  readInlineAllOf,
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
    return await parseSpec(file, transformSpec ? { transformSpec } : undefined);
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

  it('types a property variants pin to different consts as an enum of them, and leaves a $ref variant to its component', async () => {
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
    // its `$ref` variant left to its component and its `required` unread.
    const branches = mergeAllOfMembers(
      {
        allOf: [
          { oneOf: [baseRef, { properties: { x: { type: 'string' } }, required: ['x'] }, { type: 'null' }] },
          base,
        ],
      },
      components,
    );
    expect(branches.properties.map((p) => p.name)).toEqual(['x', 'name']);
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
      const ir = await parseSpec(file);
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
    // Documentation does not make a second shape: the first declaration stands.
    expect(request.fields.find((f) => f.name === 'same')).toMatchObject({ type: str, description: 'first' });
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
      { name: 'kind', origin: null, schema: { readOnly: true, description: 'Kind', oneOf: [cat, dog] } },
    ]);
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
                // Beside a `$ref` variant, which is not flattened: the base's fields only.
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
    // Built with no fields; the `description` is a member's own, not the wrapper's, so the model carries none.
    expect(models['HolderPet']).toMatchObject({ fields: [], description: undefined });
    expect(fieldsOf(models['CreatePetRequest'])).toEqual([
      'sole?: CreatePetRequestSole',
      'besideRef?: CreatePetRequestBesideRef',
      'outer?: CreatePetRequestOuter',
    ]);
    expect(fieldsOf(models['CreatePetRequestSole'])).toEqual(['name: string']);
    expect(fieldsOf(models['CreatePetRequestBesideRef'])).toEqual(['name: string']);
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
