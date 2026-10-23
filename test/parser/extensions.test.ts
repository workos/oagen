import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { fieldAdmits, modelAdmits, schemaShapeKey } from '../../src/parser/inline-models.js';
import { withWrapperDocs } from '../../src/parser/schemas.js';
import {
  OPERATION_CONSUMED_EXTENSIONS,
  SCHEMA_CONSUMED_EXTENSIONS,
  extensionsOf,
  operationExtensionsEntry,
  schemaExtensionsEntry,
} from '../../src/parser/extensions.js';
import {
  collectModelRefs,
  collectRequestBodyTypes,
  collectResponseBodyTypes,
  collectResponseHeaders,
  collectWebhookTypeRefs,
} from '../../src/ir/types.js';
import type { ApiSpec, Field, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #352: the `x-*` keys of an operation, a model, a field and an enum
 * never reached the IR — each node was built from the keys the parser
 * knows, and every other extension was dropped. Each now carries them as
 * `extensions`, keys as written and values verbatim, read at the one place
 * each node is built (`buildOperation`, every model literal through
 * `schemaExtensionsEntry`, `buildFieldFromSchema`, `extractEnum` and the
 * inline-enum lift), less the keys the parser already reads into typed
 * fields. Extensions are not shape: no fold, dedupe or differ comparison
 * reads them.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function parseDocument(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-352-'));
  dirs.push(dir);
  const file = path.join(dir, 'repro.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

/** Parse with warnings captured, so a case can pin that none (or one) was printed. */
async function parseQuietly(doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const spec = await parseDocument(doc);
    return { spec, warnings: warn.mock.calls.map(([m]) => String(m)) };
  } finally {
    warn.mockRestore();
  }
}

function byName<T extends { name: string }>(nodes: readonly T[] | undefined, name: string): T {
  const node = nodes?.find((n) => n.name === name);
  if (!node) throw new Error(`no node named ${name} among ${(nodes ?? []).map((n) => n.name).join(', ')}`);
  return node;
}

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

const fieldOf = (model: Model, name: string): Field => byName(model.fields, name);

/** A minimal OpenAPI 3.1 document. */
const document = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'Pets', version: '1.2.0' },
  paths,
  ...extra,
});

const DONE = { '204': { description: 'Done' } };

/** A GET whose 200 body is `schema`. */
const getOp = (operationId: string, schema: unknown, extra: Record<string, unknown> = {}) => ({
  get: {
    operationId,
    ...extra,
    responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
  },
});

/** A POST whose request body is `schema`, with no response body. */
const postOp = (operationId: string, schema: unknown, extra: Record<string, unknown> = {}) => ({
  post: { operationId, ...extra, requestBody: { content: { 'application/json': { schema } } }, responses: DONE },
});

/** Every type reference an operation holds. */
function operationRefs(op: Operation): TypeRef[] {
  const refs: TypeRef[] = [op.response];
  if (op.requestBody) refs.push(op.requestBody);
  for (const { type } of collectRequestBodyTypes(op)) refs.push(type);
  for (const { type } of collectResponseBodyTypes(op)) refs.push(type);
  for (const f of op.pagination?.envelopeFields ?? []) refs.push(f.type);
  if (op.pagination) refs.push(op.pagination.itemType);
  for (const h of collectResponseHeaders(op)) refs.push(h.type);
  for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
    refs.push(p.type);
  }
  return refs;
}

/** Every model reference, from operations, webhooks and model fields alike, that names no model. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const names = new Set(spec.models.map((m) => m.name));
  const found = new Set<string>();
  for (const op of Object.values(opsOf(spec))) {
    for (const ref of operationRefs(op))
      for (const name of collectModelRefs(ref)) if (!names.has(name)) found.add(name);
  }
  for (const hook of spec.webhooks ?? []) {
    for (const ref of collectWebhookTypeRefs(hook))
      for (const name of collectModelRefs(ref)) if (!names.has(name)) found.add(name);
  }
  for (const model of spec.models) {
    for (const field of model.fields) {
      for (const name of collectModelRefs(field.type))
        if (!names.has(name)) found.add(`${model.name}.${field.name} → ${name}`);
    }
    for (const variant of model.variants ?? []) {
      for (const name of collectModelRefs(variant)) if (!names.has(name)) found.add(`${model.name} variant → ${name}`);
    }
  }
  return [...found].sort();
}

/** Every model that is neither a component nor referenced by any operation, webhook, model field or variant. */
function orphanedModels(spec: ApiSpec, componentNames: readonly string[]): string[] {
  const referenced = new Set<string>();
  for (const op of Object.values(opsOf(spec))) {
    for (const ref of operationRefs(op)) for (const name of collectModelRefs(ref)) referenced.add(name);
  }
  for (const hook of spec.webhooks ?? []) {
    for (const ref of collectWebhookTypeRefs(hook)) for (const name of collectModelRefs(ref)) referenced.add(name);
  }
  for (const model of spec.models) {
    for (const field of model.fields) for (const name of collectModelRefs(field.type)) referenced.add(name);
    for (const variant of model.variants ?? []) for (const name of collectModelRefs(variant)) referenced.add(name);
    for (const name of Object.values(model.discriminator?.mapping ?? {})) referenced.add(name);
  }
  return spec.models
    .map((m) => m.name)
    .filter((name) => !componentNames.includes(name) && !referenced.has(name))
    .sort();
}

/** Nothing dangles, nothing is orphaned, every model name is unique. */
function expectSound(spec: ApiSpec, componentNames: readonly string[] = []): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphanedModels(spec, componentNames)).toEqual([]);
  expect(new Set(spec.models.map((m) => m.name)).size).toBe(spec.models.length);
}

/** The issue's repro document, verbatim. */
const REPRO = {
  openapi: '3.1.0',
  info: { title: 'Pets', version: '1.2.0' },
  paths: {
    '/pets/import': {
      post: {
        operationId: 'importPet',
        'x-idempotent': true,
        'x-since': '1.2.0',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { '204': { description: 'Imported' } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        'x-since': '1.0.0',
        properties: {
          name: { type: 'string' },
          species: { $ref: '#/components/schemas/Species' },
          microchip: { type: 'string', 'x-since': '1.1.0' },
        },
        required: ['name'],
      },
      Species: { type: 'string', enum: ['cat', 'dog'], 'x-since': '1.0.0' },
    },
  },
};

describe('x-* extensions reach the IR (issue #352)', () => {
  it("carries the issue's repro: the operation's, the model's, the field's and the enum's keys", async () => {
    const spec = await parseDocument(REPRO);
    const [operation] = spec.services[0]!.operations;
    const pet = byName(spec.models, 'Pet');
    const microchip = fieldOf(pet, 'microchip');
    const species = byName(spec.enums, 'Species');

    // The issue's own projection printed `false` four times.
    const printed = Object.entries({ operation, pet, microchip, species }).map(
      ([label, value]) => `${label} ${JSON.stringify(value).includes('x-')}`,
    );
    expect(printed).toEqual(['operation true', 'pet true', 'microchip true', 'species true']);

    expect(operation!.extensions).toEqual({ 'x-idempotent': true, 'x-since': '1.2.0' });
    expect(pet.extensions).toEqual({ 'x-since': '1.0.0' });
    expect(microchip.extensions).toEqual({ 'x-since': '1.1.0' });
    expect(species.extensions).toEqual({ 'x-since': '1.0.0' });
    // A node without any `x-*` key has no `extensions` key at all; a bare
    // `$ref` field leaves the enum's keys on the enum.
    expect(fieldOf(pet, 'name')).not.toHaveProperty('extensions');
    expect(fieldOf(pet, 'species')).not.toHaveProperty('extensions');
    expectSound(spec, ['Pet']);
  });

  it('keeps every value verbatim — nested objects and arrays, null, false, zero, empty strings — in document order', async () => {
    const extensions = {
      'x-meta': { nested: { list: [1, 'two', null, { deep: true }] } },
      'x-null': null,
      'x-number': 0,
      'x-false': false,
      'x-empty': '',
      'x-list': ['a', 'b'],
    };
    const spec = await parseDocument(
      document(
        { '/pets': postOp('createPet', { $ref: '#/components/schemas/Pet' }, extensions) },
        {
          components: {
            schemas: {
              Pet: {
                type: 'object',
                properties: { name: { type: 'string', ...extensions } },
                ...extensions,
              },
              Species: { type: 'string', enum: ['cat'], ...extensions },
            },
          },
        },
      ),
    );
    const pet = byName(spec.models, 'Pet');
    for (const node of [opsOf(spec).createPet!, pet, fieldOf(pet, 'name'), byName(spec.enums, 'Species')]) {
      expect(node.extensions).toEqual(extensions);
      expect(Object.keys(node.extensions!)).toEqual(Object.keys(extensions));
    }
  });

  it('leaves the key absent, not present-but-undefined, on every node kind that declares none', async () => {
    const spec = await parseDocument(
      document(
        { '/pets': getOp('listPets', { type: 'array', items: { $ref: '#/components/schemas/Pet' } }) },
        {
          components: {
            schemas: {
              Pet: {
                type: 'object',
                properties: { name: { type: 'string' }, species: { $ref: '#/components/schemas/Species' } },
              },
              Species: { type: 'string', enum: ['cat', 'dog'] },
            },
          },
        },
      ),
    );
    const pet = byName(spec.models, 'Pet');
    for (const node of [opsOf(spec).listPets!, pet, ...pet.fields, byName(spec.enums, 'Species')]) {
      expect(node).not.toHaveProperty('extensions');
    }
    expect(JSON.stringify(spec)).not.toContain('"x-');
  });

  describe('the keys the parser already reads into typed fields', () => {
    it('are not repeated on the operation, and keep working: x-pagination, x-oagen-async, the parameter groups', async () => {
      const { spec, warnings } = await parseQuietly(
        document({
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer' } },
                { name: 'name', in: 'query', schema: { type: 'string' } },
                { name: 'tag', in: 'query', schema: { type: 'string' } },
              ],
              'x-pagination': { strategy: 'page', param: 'page' },
              'x-oagen-async': true,
              'x-mutually-exclusive-parameter-groups': {
                filter: { optional: true, variants: { byName: ['name'], byTag: ['tag'] } },
              },
              'x-since': '1.2.0',
              responses: {
                '200': {
                  description: 'OK',
                  content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } },
                },
              },
            },
          },
        }),
      );
      const op = opsOf(spec).listPets!;
      expect(op.pagination).toMatchObject({ strategy: 'page', param: 'page', pageStart: 1 });
      expect(op.async).toBe(true);
      expect(op.parameterGroups?.map((g) => g.name)).toEqual(['filter']);
      expect(op.extensions).toEqual({ 'x-since': '1.2.0' });
      expect(warnings).toEqual([]);
      expect([...OPERATION_CONSUMED_EXTENSIONS].sort()).toEqual([
        'x-mutually-exclusive-body-groups',
        'x-mutually-exclusive-parameter-groups',
        'x-oagen-async',
        'x-pagination',
      ]);
    });

    it('are not repeated on an enum, a model or a field, and still describe the values: x-enum-descriptions, x-enumDescriptions', async () => {
      const spec = await parseDocument(
        document(
          {
            '/pets': getOp('listPets', {
              type: 'object',
              'x-enum-descriptions': { stray: 'not an enum schema' },
              properties: {
                status: {
                  type: 'string',
                  enum: ['open', 'closed'],
                  'x-enumDescriptions': ['Still open', 'Closed for good'],
                  'x-since': '1.1.0',
                },
              },
            }),
          },
          {
            components: {
              schemas: {
                Species: {
                  type: 'string',
                  enum: ['cat', 'dog'],
                  'x-enum-descriptions': { cat: 'A cat', dog: 'A dog' },
                  'x-since': '1.0.0',
                },
              },
            },
          },
        ),
      );
      const species = byName(spec.enums, 'Species');
      expect(species.values.map((v) => v.description)).toEqual(['A cat', 'A dog']);
      expect(species.extensions).toEqual({ 'x-since': '1.0.0' });

      const response = byName(spec.models, 'ListPetsResponse');
      expect(response).not.toHaveProperty('extensions');
      const status = fieldOf(response, 'status');
      expect(status.extensions).toEqual({ 'x-since': '1.1.0' });
      const lifted = byName(spec.enums, 'ListPetsResponseStatus');
      expect(lifted.values.map((v) => v.description)).toEqual(['Still open', 'Closed for good']);
      expect(lifted.extensions).toEqual({ 'x-since': '1.1.0' });
      expect([...SCHEMA_CONSUMED_EXTENSIONS].sort()).toEqual(['x-enum-descriptions', 'x-enumDescriptions']);
      expectSound(spec, ['Species']);
    });

    it('x-* keys under `paths` are still extensions, never path items', async () => {
      const { spec, warnings } = await parseQuietly(
        document({
          'x-internal': { get: { operationId: 'hidden', responses: DONE } },
          '/pets': { get: { operationId: 'listPets', 'x-since': '1', responses: DONE } },
        }),
      );
      expect(Object.keys(opsOf(spec))).toEqual(['listPets']);
      expect(opsOf(spec).listPets!.extensions).toEqual({ 'x-since': '1' });
      expect(warnings).toEqual([]);
    });
  });

  describe('a model built at every site', () => {
    it('an inline request body, an inline response, a oneOf body variant, a nested object and array items', async () => {
      const spec = await parseDocument(
        document({
          '/pets': {
            ...postOp('createPet', {
              type: 'object',
              'x-since': 'body',
              properties: {
                owner: { type: 'object', 'x-since': 'nested', properties: { name: { type: 'string' } } },
                tags: {
                  type: 'array',
                  items: { type: 'object', 'x-since': 'item', properties: { label: { type: 'string' } } },
                },
              },
            }),
            ...getOp('listPets', {
              type: 'object',
              'x-since': 'response',
              properties: { count: { type: 'integer' } },
            }),
          },
          '/adoptions': postOp('adopt', {
            'x-since': 'union',
            oneOf: [
              { type: 'object', 'x-since': 'person', properties: { person: { type: 'string' } }, required: ['person'] },
              { type: 'object', 'x-since': 'family', properties: { family: { type: 'string' } }, required: ['family'] },
            ],
          }),
        }),
      );
      const since = (name: string) => byName(spec.models, name).extensions?.['x-since'];
      expect(since('CreatePetRequest')).toBe('body');
      expect(since('CreatePetRequestOwner')).toBe('nested');
      expect(since('CreatePetRequestTags')).toBe('item');
      expect(since('ListPetsResponse')).toBe('response');
      // A multi-variant union mints a model per variant, each with its own
      // keys; the wrapper's keys stay with the body it types, which no single
      // model carries.
      const adopt = opsOf(spec).adopt!;
      expect(adopt.requestBody?.kind).toBe('union');
      const variants = (adopt.requestBody as { variants: TypeRef[] }).variants.map((v) =>
        v.kind === 'model' ? v.name : v.kind,
      );
      expect(variants.map((name) => since(name))).toEqual(['person', 'family']);
      expectSound(spec);
    });

    it('a component with allOf: the wrapper’s own keys, not a member’s, and a $ref member’s stay on its component', async () => {
      const spec = await parseDocument(
        document(
          { '/pets': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
          {
            components: {
              schemas: {
                Base: { type: 'object', 'x-since': 'base', properties: { id: { type: 'string' } } },
                Pet: {
                  'x-since': 'pet',
                  allOf: [
                    { $ref: '#/components/schemas/Base' },
                    {
                      type: 'object',
                      'x-since': 'member',
                      properties: { name: { type: 'string', 'x-since': 'name' } },
                    },
                  ],
                },
              },
            },
          },
        ),
      );
      expect(byName(spec.models, 'Pet').extensions).toEqual({ 'x-since': 'pet' });
      expect(byName(spec.models, 'Base').extensions).toEqual({ 'x-since': 'base' });
      // A field inherited from a member keeps its own schema's keys.
      expect(fieldOf(byName(spec.models, 'Pet'), 'name').extensions).toEqual({ 'x-since': 'name' });
      expect(fieldOf(byName(spec.models, 'Pet'), 'id')).not.toHaveProperty('extensions');
      expectSound(spec, ['Base', 'Pet']);
    });

    it('an inline allOf field merged into one model: the wrapper’s keys, and a key every conditional declaration agrees on', async () => {
      const spec = await parseDocument(
        document(
          { '/pets': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
          {
            components: {
              schemas: {
                Base: { type: 'object', properties: { id: { type: 'string' } } },
                Pet: {
                  type: 'object',
                  properties: {
                    detail: {
                      'x-merged': true,
                      allOf: [
                        { $ref: '#/components/schemas/Base' },
                        { type: 'object', 'x-since': 'member', properties: { name: { type: 'string' } } },
                        {
                          oneOf: [
                            {
                              type: 'object',
                              properties: { kind: { type: 'string', const: 'a', 'x-since': '1', 'x-only': 1 } },
                            },
                            {
                              type: 'object',
                              properties: { kind: { type: 'integer', 'x-since': '1', 'x-only': 2 } },
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        ),
      );
      const detail = byName(spec.models, 'PetDetail');
      expect(detail.extensions).toEqual({ 'x-merged': true });
      expect(fieldOf(byName(spec.models, 'Pet'), 'detail').extensions).toEqual({ 'x-merged': true });
      // `kind` is declared by two variants of different shapes: the combined
      // declaration carries `x-since`, which both agree on, and not `x-only`.
      expect(fieldOf(detail, 'kind').extensions).toEqual({ 'x-since': '1' });
      expectSound(spec, ['Base', 'Pet']);
    });

    it('a property several variants declare carries a key only when every declaration as written agrees (Greptile round 1)', async () => {
      // Greptile's case: three declarations, the second a repeat of the
      // first's shape that disagrees on `x-since`. Read off the distinct
      // shapes alone the key looked agreed; read off every declaration it is
      // disputed, so it is nobody's. `x-shared` is agreed by all three.
      const variantsOf = (kind: Record<string, unknown>[]) =>
        kind.map((schema) => ({ type: 'object', properties: { kind: schema } }));
      const spec = await parseDocument(
        document({
          '/pets': postOp('createPet', {
            allOf: [
              { type: 'object', properties: { name: { type: 'string' } } },
              {
                oneOf: variantsOf([
                  { type: 'string', 'x-since': '1', 'x-shared': true },
                  { type: 'string', 'x-since': '2', 'x-shared': true },
                  { type: 'integer', 'x-since': '1', 'x-shared': true },
                ]),
              },
            ],
          }),
          '/toys': postOp('createToy', {
            allOf: [
              { type: 'object', properties: { name: { type: 'string' } } },
              {
                // One shape only: the first declaration types the field, but
                // a key the second disputes is still left off, and one both
                // write the same way is kept.
                oneOf: variantsOf([
                  { type: 'string', 'x-since': '1', 'x-shared': { a: 1 } },
                  { type: 'string', 'x-since': '2', 'x-shared': { a: 1 } },
                ]),
              },
            ],
          }),
        }),
      );
      const petKind = fieldOf(byName(spec.models, 'CreatePetRequest'), 'kind');
      expect(petKind.type.kind).toBe('union');
      expect(petKind.extensions).toEqual({ 'x-shared': true });
      const toyKind = fieldOf(byName(spec.models, 'CreateToyRequest'), 'kind');
      expect(toyKind.type).toEqual({ kind: 'primitive', type: 'string' });
      expect(toyKind.extensions).toEqual({ 'x-shared': { a: 1 } });
      expectSound(spec);
    });

    it('a property several allOf members always declare is typed by the first typing declaration, its keys included; a typeless one fills in what it leaves unset', async () => {
      const spec = await parseDocument(
        document({
          '/pets': postOp('createPet', {
            allOf: [
              { type: 'object', properties: { name: { type: 'string', 'x-since': 'first', 'x-only': 1 } } },
              { type: 'object', properties: { name: { type: 'string', 'x-since': 'second', 'x-other': 2 } } },
              { type: 'object', properties: { name: { description: 'Annotated', 'x-since': 'third', 'x-note': 3 } } },
            ],
          }),
        }),
      );
      const name = fieldOf(byName(spec.models, 'CreatePetRequest'), 'name');
      // The second typing declaration is not conjoined (`combineDeclarations`);
      // the typeless third fills in `x-note`, which the first leaves unset.
      expect(name.extensions).toEqual({ 'x-since': 'first', 'x-only': 1, 'x-note': 3 });
      expect(name.description).toBe('Annotated');
      expectSound(spec);
    });

    it('two list-envelope companions of one shape under one name are one model with the first’s keys', async () => {
      const list = (operationId: string, since: string) => ({
        get: {
          operationId,
          tags: ['Pets'],
          parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: { type: 'string' } },
                      list_metadata: {
                        type: 'object',
                        'x-since': since,
                        properties: { after: { type: 'string', 'x-since': since } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      const spec = await parseDocument(
        document({ '/pets': list('listPets', 'first'), '/toys': list('listToys', 'second') }),
      );
      const ops = opsOf(spec);
      const metaOf = (op: Operation) => byName(op.pagination?.envelopeFields, 'list_metadata');
      const petsMeta = metaOf(ops.listPets!);
      const toysMeta = metaOf(ops.listToys!);
      // Each operation's envelope field keeps its own schema's keys...
      expect(petsMeta.extensions).toEqual({ 'x-since': 'first' });
      expect(toysMeta.extensions).toEqual({ 'x-since': 'second' });
      // ...while the one companion model both reference carries the first's.
      expect(petsMeta.type).toEqual(toysMeta.type);
      const companion = petsMeta.type.kind === 'model' ? byName(spec.models, petsMeta.type.name) : undefined;
      expect(companion?.extensions).toEqual({ 'x-since': 'first' });
      expect(fieldOf(companion!, 'after').extensions).toEqual({ 'x-since': 'first' });
      expect(spec.models.filter((m) => m.name === companion!.name)).toHaveLength(1);
      expectSound(spec);
    });

    it('a named union’s inline variants and a discriminated allOf+oneOf’s variants, each with its own keys', async () => {
      const spec = await parseDocument(
        document(
          {
            '/shapes': getOp('getShape', { $ref: '#/components/schemas/Shape' }),
            '/events': getOp('getEvent', { $ref: '#/components/schemas/Event' }),
          },
          {
            components: {
              schemas: {
                Shape: {
                  'x-since': 'shape',
                  oneOf: [
                    { type: 'object', title: 'Circle', 'x-since': 'circle', properties: { r: { type: 'number' } } },
                    { type: 'object', title: 'Square', 'x-since': 'square', properties: { side: { type: 'number' } } },
                  ],
                },
                Event: {
                  'x-since': 'event',
                  allOf: [
                    { type: 'object', properties: { id: { type: 'string' } } },
                    {
                      oneOf: [
                        {
                          type: 'object',
                          title: 'Created',
                          'x-since': 'created',
                          properties: { kind: { type: 'string', const: 'created' } },
                          required: ['kind'],
                        },
                        {
                          type: 'object',
                          title: 'Deleted',
                          'x-since': 'deleted',
                          properties: { kind: { type: 'string', const: 'deleted' } },
                          required: ['kind'],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ),
      );
      const since = (name: string) => byName(spec.models, name).extensions?.['x-since'];
      expect(since('Shape')).toBe('shape');
      expect(since('CircleShape')).toBe('circle');
      expect(since('SquareShape')).toBe('square');
      expect(since('Event')).toBe('event');
      expect(byName(spec.models, 'Event').discriminator?.property).toBe('kind');
      expect(since('EventCreated')).toBe('created');
      expect(since('EventDeleted')).toBe('deleted');
      expectSound(spec, ['Shape', 'Event']);
    });

    it('a discriminated oneOf request body merged into one model, and an allOf response: the wrapper’s keys', async () => {
      const spec = await parseDocument(
        document({
          '/events': {
            ...postOp('createEvent', {
              'x-since': 'wrapper',
              discriminator: { propertyName: 'kind' },
              oneOf: [
                {
                  type: 'object',
                  'x-since': 'a',
                  properties: { kind: { type: 'string', const: 'a' }, a: { type: 'string' } },
                  required: ['kind'],
                },
                {
                  type: 'object',
                  'x-since': 'b',
                  properties: { kind: { type: 'string', const: 'b' }, b: { type: 'string' } },
                  required: ['kind'],
                },
              ],
            }),
            ...getOp('listEvents', {
              'x-since': 'response',
              allOf: [
                { type: 'object', 'x-since': 'member', properties: { id: { type: 'string' } } },
                { type: 'object', properties: { name: { type: 'string' } } },
              ],
            }),
          },
        }),
      );
      expect(byName(spec.models, 'CreateEventRequest').extensions).toEqual({ 'x-since': 'wrapper' });
      expect(byName(spec.models, 'ListEventsResponse').extensions).toEqual({ 'x-since': 'response' });
      expectSound(spec);
    });

    it('a collapsed nullable or single-member allOf wrapper carries its keys onto the model, the wrapper winning', async () => {
      const spec = await parseDocument(
        document(
          { '/pets': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
          {
            components: {
              schemas: {
                Pet: {
                  type: 'object',
                  properties: {
                    home: {
                      'x-wrapper': 1,
                      'x-both': 'wrapper',
                      oneOf: [
                        {
                          type: 'object',
                          'x-branch': 1,
                          'x-both': 'branch',
                          properties: { city: { type: 'string' } },
                        },
                        { type: 'null' },
                      ],
                    },
                    vet: {
                      'x-wrapper': 2,
                      allOf: [{ type: 'object', 'x-member': 2, properties: { name: { type: 'string' } } }],
                    },
                  },
                },
              },
            },
          },
        ),
      );
      const pet = byName(spec.models, 'Pet');
      expect(byName(spec.models, 'PetHome').extensions).toEqual({ 'x-branch': 1, 'x-both': 'wrapper', 'x-wrapper': 1 });
      // The field's schema is the wrapper, so the field carries the wrapper's keys alone.
      expect(fieldOf(pet, 'home').extensions).toEqual({ 'x-wrapper': 1, 'x-both': 'wrapper' });
      expect(byName(spec.models, 'PetVet').extensions).toEqual({ 'x-member': 2, 'x-wrapper': 2 });
      expect(fieldOf(pet, 'vet').extensions).toEqual({ 'x-wrapper': 2 });
      expectSound(spec, ['Pet']);
    });

    describe('nested wrappers compose outermost-first, for every documentation keyword (Greptile round 3)', () => {
      /** A nullable `oneOf` wrapper around `branch` carrying `docs`. */
      const nullable = (branch: Record<string, unknown>, docs: Record<string, unknown>) => ({
        ...docs,
        oneOf: [branch, { type: 'null' }],
      });
      /** A single-member `allOf` wrapper around `member` carrying `docs`. */
      const lone = (member: Record<string, unknown>, docs: Record<string, unknown>) => ({ ...docs, allOf: [member] });
      const object = (docs: Record<string, unknown>) => ({
        type: 'object',
        ...docs,
        properties: { city: { type: 'string' } },
      });
      const enumeration = (docs: Record<string, unknown>) => ({ type: 'string', enum: ['a', 'b'], ...docs });

      /** Each documentation keyword with a value per level, and what the IR node built from the branch shows for it. */
      const keywords: Array<{
        key: 'description' | 'externalDocs' | 'extensions';
        at: (level: string) => Record<string, unknown>;
        shown: (level: string) => unknown;
      }> = [
        { key: 'description', at: (level) => ({ description: level }), shown: (level) => level },
        {
          key: 'externalDocs',
          at: (level) => ({ externalDocs: { url: `https://docs/${level}` } }),
          shown: (level) => ({ url: `https://docs/${level}` }),
        },
        {
          key: 'extensions',
          at: (level) => ({ 'x-both': level, [`x-${level}`]: true }),
          shown: (level) => expect.objectContaining({ 'x-both': level }),
        },
      ];

      for (const { key, at, shown } of keywords) {
        it(`${key}: two and three nullable wrappers, a nullable wrapper around a single-member allOf — outer wins, inner kept where the outer has none`, async () => {
          const spec = await parseDocument(
            document(
              { '/pets': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
              {
                components: {
                  schemas: {
                    Pet: {
                      type: 'object',
                      properties: {
                        // Every level declares the keyword: the outermost wins.
                        twoAll: nullable(nullable(object(at('branch')), at('inner')), at('outer')),
                        threeAll: nullable(
                          nullable(nullable(object(at('branch')), at('inner')), at('middle')),
                          at('outer'),
                        ),
                        // Only the inner wrapper declares it: it reaches the branch through the silent outer.
                        innerOnly: nullable(nullable(object({}), at('inner')), {}),
                        // Only the branch declares it: no wrapper overrides it.
                        branchOnly: nullable(nullable(object(at('branch')), {}), {}),
                        // A nullable wrapper around a single-member allOf: three layers compose.
                        viaAllOf: nullable(lone(object(at('member')), at('allOf')), at('outer')),
                        // The same levels around an inline enum, lifted by the type builder.
                        enumTwoAll: nullable(nullable(enumeration(at('branch')), at('inner')), at('outer')),
                        enumInnerOnly: nullable(nullable(enumeration({}), at('inner')), {}),
                        enumViaAllOf: nullable(lone(enumeration(at('member')), at('allOf')), at('outer')),
                      },
                    },
                  },
                },
              },
            ),
          );
          const model = (name: string) => byName(spec.models, name)[key];
          const anEnum = (name: string) => byName(spec.enums, name)[key];
          expect(model('PetTwoAll'), 'two wrappers').toEqual(shown('outer'));
          expect(model('PetThreeAll'), 'three wrappers').toEqual(shown('outer'));
          expect(model('PetInnerOnly'), 'inner only').toEqual(shown('inner'));
          expect(model('PetBranchOnly'), 'branch only').toEqual(shown('branch'));
          expect(model('PetViaAllOf'), 'nullable around allOf').toEqual(shown('outer'));
          expect(anEnum('PetEnumTwoAll'), 'enum, two wrappers').toEqual(shown('outer'));
          expect(anEnum('PetEnumInnerOnly'), 'enum, inner only').toEqual(shown('inner'));
          expect(anEnum('PetEnumViaAllOf'), 'enum, nullable around allOf').toEqual(shown('outer'));
          if (key === 'extensions') {
            // A key only an inner level declares survives beside the outer's.
            expect(model('PetTwoAll')).toEqual({
              'x-both': 'outer',
              'x-outer': true,
              'x-inner': true,
              'x-branch': true,
            });
            expect(model('PetThreeAll')).toEqual({
              'x-both': 'outer',
              'x-outer': true,
              'x-middle': true,
              'x-inner': true,
              'x-branch': true,
            });
            expect(model('PetViaAllOf')).toEqual({
              'x-both': 'outer',
              'x-outer': true,
              'x-allOf': true,
              'x-member': true,
            });
            expect(anEnum('PetEnumTwoAll')).toEqual({
              'x-both': 'outer',
              'x-outer': true,
              'x-inner': true,
              'x-branch': true,
            });
            // The field carries the outermost wrapper's keys alone: that wrapper is its schema.
            expect(fieldOf(byName(spec.models, 'Pet'), 'twoAll').extensions).toEqual({
              'x-both': 'outer',
              'x-outer': true,
            });
            expect(fieldOf(byName(spec.models, 'Pet'), 'innerOnly')).not.toHaveProperty('extensions');
          }
          expectSound(spec, ['Pet']);
        });
      }
    });
  });

  describe('a field', () => {
    it('carries keys written beside a $ref, none for a bare $ref, and an array component’s for a bare $ref to one', async () => {
      const spec = await parseDocument(
        document(
          { '/pets': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
          {
            components: {
              schemas: {
                Pet: {
                  type: 'object',
                  properties: {
                    species: { $ref: '#/components/schemas/Species', 'x-since': 'field' },
                    bare: { $ref: '#/components/schemas/Species' },
                    tags: { $ref: '#/components/schemas/Tags' },
                    ownTags: { $ref: '#/components/schemas/Tags', 'x-since': 'own' },
                    owner: { $ref: '#/components/schemas/Owner' },
                  },
                },
                Species: { type: 'string', enum: ['cat', 'dog'], 'x-since': 'enum' },
                Tags: { type: 'array', items: { type: 'string' }, 'x-since': 'tags' },
                Owner: { type: 'object', 'x-since': 'owner', properties: { name: { type: 'string' } } },
              },
            },
          },
        ),
      );
      const pet = byName(spec.models, 'Pet');
      expect(fieldOf(pet, 'species').extensions).toEqual({ 'x-since': 'field' });
      expect(fieldOf(pet, 'bare')).not.toHaveProperty('extensions');
      expect(byName(spec.enums, 'Species').extensions).toEqual({ 'x-since': 'enum' });
      // An array component has no model to carry its keys, so the field does.
      expect(fieldOf(pet, 'tags').extensions).toEqual({ 'x-since': 'tags' });
      expect(fieldOf(pet, 'ownTags').extensions).toEqual({ 'x-since': 'own' });
      expect(fieldOf(pet, 'owner')).not.toHaveProperty('extensions');
      expect(byName(spec.models, 'Owner').extensions).toEqual({ 'x-since': 'owner' });
      expectSound(spec, ['Pet', 'Owner']);
    });

    it('a list envelope’s fields carry their keys too', async () => {
      const spec = await parseDocument(
        document({
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { type: 'string' } },
                          list_metadata: {
                            type: 'object',
                            'x-since': 'meta',
                            properties: { after: { type: 'string', 'x-since': 'cursor' } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      );
      const op = opsOf(spec).listPets!;
      expect(op.pagination?.strategy).toBe('cursor');
      const meta = byName(op.pagination?.envelopeFields, 'list_metadata');
      expect(meta.extensions).toEqual({ 'x-since': 'meta' });
      const metaModel = meta.type.kind === 'model' ? byName(spec.models, meta.type.name) : undefined;
      expect(metaModel?.extensions).toEqual({ 'x-since': 'meta' });
      expect(fieldOf(metaModel!, 'after').extensions).toEqual({ 'x-since': 'cursor' });
      expectSound(spec);
    });
  });

  describe('an enum lifted from an inline schema', () => {
    it('carries the schema’s keys from a property, a parameter and a oneOf of consts, as the field or parameter does', async () => {
      const spec = await parseDocument(
        document(
          {
            '/pets': {
              get: {
                operationId: 'listPets',
                parameters: [
                  { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], 'x-since': 'param' } },
                ],
                responses: {
                  '200': {
                    description: 'OK',
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
                  },
                },
              },
            },
          },
          {
            components: {
              schemas: {
                Pet: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['open', 'closed'], 'x-since': 'status' },
                    mood: {
                      'x-since': 'mood',
                      oneOf: [
                        { const: 'happy', description: 'Happy' },
                        { const: 'grumpy', description: 'Grumpy' },
                      ],
                    },
                  },
                },
              },
            },
          },
        ),
      );
      const pet = byName(spec.models, 'Pet');
      expect(byName(spec.enums, 'PetStatus').extensions).toEqual({ 'x-since': 'status' });
      expect(fieldOf(pet, 'status').extensions).toEqual({ 'x-since': 'status' });
      expect(byName(spec.enums, 'PetMood').extensions).toEqual({ 'x-since': 'mood' });
      expect(byName(spec.enums, 'PetMood').values.map((v) => v.description)).toEqual(['Happy', 'Grumpy']);
      expect(byName(spec.enums, 'PetsSort').extensions).toEqual({ 'x-since': 'param' });
      expectSound(spec, ['Pet']);
    });

    it('under a collapsed wrapper, carries the wrapper’s keys over the branch’s, whichever spelling declares null', async () => {
      const spec = await parseDocument(
        document(
          { '/pets': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
          {
            components: {
              schemas: {
                Pet: {
                  type: 'object',
                  properties: {
                    viaOneOf: {
                      'x-wrapper': 1,
                      'x-both': 'wrapper',
                      oneOf: [
                        { type: 'string', enum: ['a', 'b'], 'x-branch': 1, 'x-both': 'branch' },
                        { type: 'null' },
                      ],
                    },
                    viaTypeList: { type: ['string', 'null'], enum: ['a', 'b'], 'x-wrapper': 1, 'x-both': 'wrapper' },
                    viaAllOf: {
                      'x-wrapper': 1,
                      'x-both': 'wrapper',
                      allOf: [{ type: 'string', enum: ['a', 'b'], 'x-branch': 1, 'x-both': 'branch' }],
                    },
                  },
                },
              },
            },
          },
        ),
      );
      expect(byName(spec.enums, 'PetViaOneOf').extensions).toEqual({
        'x-branch': 1,
        'x-both': 'wrapper',
        'x-wrapper': 1,
      });
      expect(byName(spec.enums, 'PetViaTypeList').extensions).toEqual({ 'x-wrapper': 1, 'x-both': 'wrapper' });
      expect(byName(spec.enums, 'PetViaAllOf').extensions).toEqual({
        'x-branch': 1,
        'x-both': 'wrapper',
        'x-wrapper': 1,
      });
      expectSound(spec, ['Pet']);
    });

    it('when two inline schemas lift to one name with the same members, the first lifted gives the keys', async () => {
      const spec = await parseDocument(
        document({
          '/pets': {
            get: {
              operationId: 'listPets',
              tags: ['Pets'],
              parameters: [
                { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], 'x-since': 'first' } },
              ],
              responses: DONE,
            },
          },
          '/pets/{id}/toys': {
            get: {
              operationId: 'listToys',
              tags: ['Pets'],
              parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], 'x-since': 'second' } },
              ],
              responses: DONE,
            },
          },
        }),
      );
      const sorts = spec.enums.filter((e) => e.name === 'PetsSort');
      expect(sorts).toHaveLength(1);
      expect(sorts[0]!.extensions).toEqual({ 'x-since': 'first' });
      // Both parameters reference the one enum; each keeps its own schema's keys.
      const ops = opsOf(spec);
      expect(ops.listPets!.queryParams[0]!.type).toMatchObject({ kind: 'enum', name: 'PetsSort' });
      expect(ops.listToys!.queryParams[0]!.type).toMatchObject({ kind: 'enum', name: 'PetsSort' });
    });
  });

  describe('extensions are not shape', () => {
    it('an inline body that differs from a component only in extensions folds onto it, which keeps its own keys', async () => {
      const { spec, warnings } = await parseQuietly(
        document(
          {
            '/pets/{id}': getOp('getPet', {
              type: 'object',
              'x-since': 'inline',
              properties: { name: { type: 'string', 'x-since': 'inline-field' } },
              required: ['name'],
            }),
          },
          {
            components: {
              schemas: {
                GetPetResponse: {
                  type: 'object',
                  'x-since': 'component',
                  properties: { name: { type: 'string', 'x-since': 'component-field' } },
                  required: ['name'],
                },
              },
            },
          },
        ),
      );
      expect(spec.models.map((m) => m.name)).toEqual(['GetPetResponse']);
      expect(opsOf(spec).getPet!.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      const kept = byName(spec.models, 'GetPetResponse');
      expect(kept.extensions).toEqual({ 'x-since': 'component' });
      expect(fieldOf(kept, 'name').extensions).toEqual({ 'x-since': 'component-field' });
      expect(warnings).toEqual([]);
      expectSound(spec, ['GetPetResponse']);
    });

    it('two inline enums with the same members but different keys are one enum', async () => {
      const spec = await parseDocument(
        document(
          { '/pets': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
          {
            components: {
              schemas: {
                Pet: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['open', 'closed'], 'x-since': 'a' },
                  },
                },
                Toy: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['open', 'closed'], 'x-since': 'b' },
                  },
                },
              },
            },
          },
        ),
      );
      // Each property lifts under its own model's name; the members decide
      // sharing, never the keys, so neither enum is renamed apart.
      expect(spec.enums.map((e) => e.name).sort()).toEqual(['PetStatus', 'ToyStatus']);
      expect(byName(spec.enums, 'PetStatus').extensions).toEqual({ 'x-since': 'a' });
      expect(byName(spec.enums, 'ToyStatus').extensions).toEqual({ 'x-since': 'b' });
    });

    it('modelAdmits, fieldAdmits and schemaShapeKey read past them', () => {
      const field = (extensions?: Record<string, unknown>): Field => ({
        name: 'name',
        type: { kind: 'primitive', type: 'string' },
        required: true,
        ...(extensions ? { extensions } : {}),
      });
      const model = (extensions?: Record<string, unknown>, fieldExtensions?: Record<string, unknown>): Model => ({
        name: 'Pet',
        fields: [field(fieldExtensions)],
        ...(extensions ? { extensions } : {}),
      });
      const plain = model();
      const extended = model({ 'x-since': '1.0.0' }, { 'x-since': '1.1.0' });
      expect(modelAdmits(plain, extended)).toBe(true);
      expect(modelAdmits(extended, plain)).toBe(true);
      expect(modelAdmits(extended, model({ 'x-since': '2' }, { 'x-since': '2' }))).toBe(true);
      expect(fieldAdmits(field(), field({ 'x-since': '1' }))).toBe(true);
      expect(fieldAdmits(field({ 'x-since': '1' }), field({ 'x-since': '2' }))).toBe(true);
      expect(schemaShapeKey({ type: 'string', 'x-since': '1' })).toBe(
        schemaShapeKey({ type: 'string', 'x-since': '2' }),
      );
      expect(schemaShapeKey({ type: 'string', 'x-since': '1' })).toBe(schemaShapeKey({ type: 'string' }));
      // A real shape difference still counts.
      expect(modelAdmits(plain, { ...extended, fields: [{ ...field(), required: false, name: 'other' }] })).toBe(false);
    });
  });

  describe('the helpers', () => {
    it('extensionsOf reads x-* keys only, in order, less the consumed ones, and yields undefined for none', () => {
      const source = { type: 'string', 'x-b': 2, description: 'd', 'x-a': 1, 'x-enum-descriptions': {}, 'X-upper': 3 };
      expect(extensionsOf(source)).toEqual({ 'x-b': 2, 'x-a': 1, 'x-enum-descriptions': {} });
      expect(Object.keys(extensionsOf(source)!)).toEqual(['x-b', 'x-a', 'x-enum-descriptions']);
      expect(extensionsOf(source, SCHEMA_CONSUMED_EXTENSIONS)).toEqual({ 'x-b': 2, 'x-a': 1 });
      expect(extensionsOf({ type: 'string' })).toBeUndefined();
      expect(extensionsOf({ 'x-pagination': {} }, OPERATION_CONSUMED_EXTENSIONS)).toBeUndefined();
      expect(schemaExtensionsEntry({ type: 'string' })).toEqual({});
      expect(schemaExtensionsEntry({ type: 'string', 'x-a': 1 })).toEqual({ extensions: { 'x-a': 1 } });
      expect(operationExtensionsEntry({ 'x-oagen-async': true })).toEqual({});
      expect(operationExtensionsEntry({ 'x-oagen-async': true, 'x-a': 1 })).toEqual({ extensions: { 'x-a': 1 } });
      // A value is the document's own, not a copy.
      const nested = { deep: [1] };
      expect(extensionsOf({ 'x-n': nested })!['x-n']).toBe(nested);
    });

    it('withWrapperDocs carries every documentation keyword of the wrapper over the branch’s, and returns the branch itself when it has none', () => {
      const inner = {
        type: 'string',
        description: 'branch',
        externalDocs: { url: 'https://branch' },
        example: 'branch',
        examples: ['branch'],
        'x-branch': 1,
        'x-both': 'branch',
      };
      expect(withWrapperDocs(inner, { oneOf: [] })).toBe(inner);
      // A wrapper with nothing usable — blank text, a link without a url, an
      // empty examples list, a consumed key — carries nothing.
      expect(
        withWrapperDocs(inner, {
          oneOf: [],
          description: '  ',
          externalDocs: { description: 'no url' },
          examples: [],
          'x-enum-descriptions': ['a'],
        }),
      ).toBe(inner);
      expect(
        withWrapperDocs(inner, {
          oneOf: [],
          description: 'wrapper',
          externalDocs: { url: 'https://wrapper' },
          example: null,
          examples: ['wrapper'],
          'x-wrapper': 1,
          'x-both': 'wrapper',
        }),
      ).toEqual({
        type: 'string',
        description: 'wrapper',
        externalDocs: { url: 'https://wrapper' },
        example: null,
        examples: ['wrapper'],
        'x-branch': 1,
        'x-both': 'wrapper',
        'x-wrapper': 1,
      });
      // Each keyword is carried on its own: a wrapper declaring one leaves the others the branch's.
      for (const [key, value] of Object.entries({
        description: 'wrapper',
        externalDocs: { url: 'https://wrapper' },
        example: 'wrapper',
        examples: ['wrapper'],
        'x-both': 'wrapper',
      })) {
        expect(withWrapperDocs(inner, { oneOf: [], [key]: value }), key).toEqual({ ...inner, [key]: value });
      }
    });
  });
});
