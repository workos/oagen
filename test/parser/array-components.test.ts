import { describe, it, expect, afterAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec, type ParseOptions } from '../../src/parser/parse.js';
import {
  clearSchemaNameTransform,
  extractSchemas,
  isArrayComponentRef,
  isArrayComponentSchema,
  schemaToTypeRef,
} from '../../src/parser/schemas.js';
import {
  collectEnumRefs,
  collectModelRefs,
  collectResponseBodyTypes,
  collectResponseHeaders,
  collectWebhookTypeRefs,
} from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #284: a `components/schemas` entry whose schema is an array became a
 * `Model` with no fields, and every `$ref` to it was typed as that model —
 * an empty class, and a list typed as a single empty object. An array
 * component is now no model at all: a `$ref` to it resolves to the array it
 * declares, and what its items reference is extracted under the component's
 * name (`<Component>Item…`), at every reference site alike.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});
const warnings = (): string[] => warn.mock.calls.map(([m]) => String(m));

async function parse(doc: unknown, options?: ParseOptions): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-array-components-'));
  dirs.push(dir);
  const file = path.join(dir, 'spec.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file, options);
}

/** A minimal document around `schemas` and `paths`. */
const specDoc = (
  schemas: Record<string, unknown>,
  paths: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  openapi: '3.1.0',
  info: { title: 'arrays', version: '1' },
  paths,
  components: { schemas },
  ...extra,
});

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** A GET whose 200 body is `schema`. */
const getOp = (operationId: string, schema: unknown, extra: Record<string, unknown> = {}) => ({
  get: {
    operationId,
    ...extra,
    responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
  },
});

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

const fieldType = (spec: ApiSpec, model: string, field: string): TypeRef | undefined =>
  spec.models.find((m) => m.name === model)?.fields.find((f) => f.name === field)?.type;

const array = (items: TypeRef): TypeRef => ({ kind: 'array', items });
const model = (name: string): TypeRef => ({ kind: 'model', name });
const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
const string: TypeRef = { kind: 'primitive', type: 'string' };

/** Every type reference an operation holds, labelled by where it sits. */
function operationRefs(op: Operation): Array<[string, TypeRef]> {
  const refs: Array<[string, TypeRef]> = [[`${op.name}.response`, op.response]];
  if (op.requestBody) refs.push([`${op.name}.requestBody`, op.requestBody]);
  for (const r of op.successResponses ?? []) refs.push([`${op.name}.${r.statusCode}`, r.type]);
  for (const e of op.errors) if (e.type) refs.push([`${op.name}.${e.statusCode}`, e.type]);
  for (const { type, source } of collectResponseBodyTypes(op)) refs.push([`${op.name}.${source}`, type]);
  for (const f of op.pagination?.envelopeFields ?? []) refs.push([`${op.name}.${f.name}`, f.type]);
  if (op.pagination) refs.push([`${op.name}.items`, op.pagination.itemType]);
  for (const h of collectResponseHeaders(op)) refs.push([`${op.name}.${h.name}`, h.type]);
  for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
    refs.push([`${op.name}(${p.name})`, p.type]);
  }
  return refs;
}

/** Every reference, from operations, webhooks, model fields and union variants, that names no model or enum. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const models = new Set(spec.models.map((m) => m.name));
  const enums = new Set(spec.enums.map((e) => e.name));
  const found: string[] = [];
  const check = (owner: string, ref: TypeRef): void => {
    for (const name of collectModelRefs(ref)) if (!models.has(name)) found.push(`${owner} → model ${name}`);
    for (const name of collectEnumRefs(ref)) if (!enums.has(name)) found.push(`${owner} → enum ${name}`);
  };
  for (const op of Object.values(opsOf(spec))) for (const [owner, ref] of operationRefs(op)) check(owner, ref);
  for (const hook of spec.webhooks ?? []) for (const ref of collectWebhookTypeRefs(hook)) check(hook.name, ref);
  for (const m of spec.models) {
    for (const f of m.fields) check(`${m.name}.${f.name}`, f.type);
    for (const v of m.variants ?? []) check(`${m.name}.variants`, v);
  }
  return found.sort();
}

/** Every model that is neither an object component nor referenced by any operation, webhook, field or variant. */
function orphanedModels(spec: ApiSpec, componentNames: string[]): string[] {
  const referenced = new Set<string>();
  for (const op of Object.values(opsOf(spec))) {
    for (const [, ref] of operationRefs(op)) for (const name of collectModelRefs(ref)) referenced.add(name);
  }
  for (const hook of spec.webhooks ?? []) {
    for (const ref of collectWebhookTypeRefs(hook)) for (const name of collectModelRefs(ref)) referenced.add(name);
  }
  for (const m of spec.models) {
    for (const f of m.fields) for (const name of collectModelRefs(f.type)) referenced.add(name);
    for (const v of m.variants ?? []) for (const name of collectModelRefs(v)) referenced.add(name);
  }
  return spec.models
    .map((m) => m.name)
    .filter((name) => !componentNames.includes(name) && !referenced.has(name))
    .sort();
}

/** Nothing dangles, nothing is orphaned, no model is named like an enum, and no array component became a model. */
function expectSound(spec: ApiSpec, componentNames: string[], arrayComponents: string[]): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphanedModels(spec, componentNames)).toEqual([]);
  const enumNames = new Set(spec.enums.map((e) => e.name));
  expect(spec.models.map((m) => m.name).filter((name) => enumNames.has(name))).toEqual([]);
  for (const name of arrayComponents) {
    expect(spec.models.map((m) => m.name)).not.toContain(name);
    expect(spec.enums.map((e) => e.name)).not.toContain(name);
  }
}

describe('an array component (issue #284 repro)', () => {
  // The issue's components, verbatim: an array of inline objects and an array of `$ref`s.
  const schemas = {
    Owner: { type: 'object', properties: { pets: ref('Pets'), widgets: ref('WidgetList') } },
    Pets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
    Widget: { type: 'object', properties: { id: { type: 'string' } } },
    WidgetList: { type: 'array', items: ref('Widget') },
  };
  const paths = {
    '/pets': getOp('listPets', ref('Pets')),
    '/widgets': getOp('listWidgets', ref('WidgetList')),
    '/owners/{id}': getOp('getOwner', ref('Owner'), {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    }),
  };

  /** The issue's projection: `Name { field: type }` per model and `name: type` per operation. */
  const project = (spec: ApiSpec) => ({
    models: spec.models.map(
      ({ fields, name }) =>
        `${name} { ${fields.map(({ name, type }) => `${name}: ${JSON.stringify(type)}`).join(', ')} }`,
    ),
    responses: spec.services
      .flatMap(({ operations }) => operations)
      .map(({ name, response }) => `${name}: ${JSON.stringify(response)}`),
  });

  it('types every reference as the array, creates the item model, and emits no empty model', async () => {
    const spec = await parse(specDoc(schemas, paths));
    expect(project(spec)).toEqual({
      models: [
        'Owner { pets: {"kind":"array","items":{"kind":"model","name":"PetsItem"}}, widgets: {"kind":"array","items":{"kind":"model","name":"Widget"}} }',
        'PetsItem { name: {"kind":"primitive","type":"string"} }',
        'Widget { id: {"kind":"primitive","type":"string"} }',
      ],
      responses: [
        'listPets: {"kind":"array","items":{"kind":"model","name":"PetsItem"}}',
        'listWidgets: {"kind":"array","items":{"kind":"model","name":"Widget"}}',
        'getOwner: {"kind":"model","name":"Owner"}',
      ],
    });
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Owner', 'Widget'], ['Pets', 'WidgetList']);
  });

  it('reads `items` without `type` as the same array', async () => {
    const untyped = {
      ...schemas,
      Pets: { items: schemas.Pets.items },
      WidgetList: { items: ref('Widget') },
    };
    const spec = await parse(specDoc(untyped, paths));
    expect(project(spec)).toEqual(project(await parse(specDoc(schemas, paths))));
    expect(warnings()).toEqual([]);
  });

  it('ignores `components/schemas` order', async () => {
    const reversed = Object.fromEntries(Object.entries(schemas).reverse());
    const spec = await parse(specDoc(reversed, paths));
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(array(model('PetsItem')));
    expect(fieldType(spec, 'Owner', 'widgets')).toEqual(array(model('Widget')));
    expect(spec.models.map((m) => m.name).sort()).toEqual(['Owner', 'PetsItem', 'Widget']);
    expect(warnings()).toEqual([]);
  });
});

describe('the component’s own nullability travels on the reference', () => {
  const owner = (pets: unknown = ref('Pets')) => ({ type: 'object', properties: { pets } });
  const items = { type: 'object', properties: { name: { type: 'string' } } };

  it.each([
    ['an OAS 3.1 type list', '3.1.0', { type: ['array', 'null'], items }],
    ['an OAS 3.1 type list, null first', '3.1.0', { type: ['null', 'array'], items }],
    ['an OAS 3.0 nullable flag', '3.0.3', { type: 'array', nullable: true, items }],
  ])('wraps a `$ref` to a component nullable through %s', async (_form, openapi, Pets) => {
    const spec = await parse({
      ...specDoc({ Owner: owner(), Pets }, { '/pets': getOp('listPets', ref('Pets')) }),
      openapi,
    });
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(nullable(array(model('PetsItem'))));
    expect(opsOf(spec).listPets.response).toEqual(nullable(array(model('PetsItem'))));
    expect(spec.models.find((m) => m.name === 'PetsItem')?.fields.map((f) => f.name)).toEqual(['name']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Owner'], ['Pets']);
  });

  it.each([
    ['a oneOf with a null variant', { oneOf: [ref('Pets'), { type: 'null' }] }],
    ['an anyOf with a null variant', { anyOf: [{ type: 'null' }, ref('Pets')] }],
  ])('wraps a nullable reference to a non-nullable component once, through %s', async (_form, pets) => {
    const spec = await parse(specDoc({ Owner: owner(pets), Pets: { type: 'array', items } }));
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(nullable(array(model('PetsItem'))));
    expect(warnings()).toEqual([]);
  });

  it('wraps a nullable reference to a nullable component once', async () => {
    const spec = await parse(
      specDoc({ Owner: owner({ oneOf: [ref('Pets'), { type: 'null' }] }), Pets: { type: ['array', 'null'], items } }),
    );
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(nullable(array(model('PetsItem'))));
  });
});

describe('what the items are', () => {
  const owner = { type: 'object', properties: { pets: ref('Pets') } };
  const cases: Array<[string, Record<string, unknown>, TypeRef, string[], string[]]> = [
    ['a primitive', { Pets: { type: 'array', items: { type: 'string' } } }, array(string), [], []],
    [
      'a `$ref` to an enum component',
      { Pets: { type: 'array', items: ref('Color') }, Color: { type: 'string', enum: ['red', 'green'] } },
      array({ kind: 'enum', name: 'Color' }),
      [],
      ['Color'],
    ],
    [
      'a `$ref` to a nullable enum component',
      { Pets: { type: 'array', items: ref('Color') }, Color: { type: ['string', 'null'], enum: ['red', null] } },
      array(nullable({ kind: 'enum', name: 'Color' })),
      [],
      ['Color'],
    ],
    [
      'a `$ref` to a nullable named union',
      {
        Pets: { type: 'array', items: ref('Shape') },
        Shape: { oneOf: [ref('Circle'), ref('Square'), { type: 'null' }] },
        Circle: { type: 'object', properties: { r: { type: 'number' } } },
        Square: { type: 'object', properties: { s: { type: 'number' } } },
      },
      array(nullable(model('Shape'))),
      ['Circle', 'Shape', 'Square'],
      [],
    ],
    [
      'a `$ref` to another array component',
      {
        Pets: { type: 'array', items: ref('WidgetList') },
        WidgetList: { type: 'array', items: ref('Widget') },
        Widget: { type: 'object', properties: { id: { type: 'string' } } },
      },
      array(array(model('Widget'))),
      ['Widget'],
      [],
    ],
    [
      'a `$ref` to a nullable array component',
      {
        Pets: { type: 'array', items: ref('WidgetList') },
        WidgetList: { type: ['array', 'null'], items: ref('Widget') },
        Widget: { type: 'object', properties: { id: { type: 'string' } } },
      },
      array(nullable(array(model('Widget')))),
      ['Widget'],
      [],
    ],
    [
      'an inline enum',
      { Pets: { type: 'array', items: { type: 'string', enum: ['cat', 'dog'] } } },
      array({ kind: 'enum', name: 'PetsItem', values: ['cat', 'dog'] }),
      [],
      ['PetsItem'],
    ],
    [
      'a nested array of inline objects',
      {
        Pets: {
          type: 'array',
          items: { type: 'array', items: { type: 'object', properties: { n: { type: 'string' } } } },
        },
      },
      array(array(model('PetsItem'))),
      ['PetsItem'],
      [],
    ],
    [
      'a map of inline objects',
      {
        Pets: {
          type: 'array',
          items: { type: 'object', additionalProperties: { type: 'object', properties: { n: { type: 'string' } } } },
        },
      },
      array({ kind: 'map', valueType: model('PetsItem') }),
      ['PetsItem'],
      [],
    ],
    [
      'a nullable inline object',
      { Pets: { type: 'array', items: { type: ['object', 'null'], properties: { n: { type: 'string' } } } } },
      array(nullable(model('PetsItem'))),
      ['PetsItem'],
      [],
    ],
    [
      'an inline object holding a nested object',
      {
        Pets: {
          type: 'array',
          items: { type: 'object', properties: { owner: { type: 'object', properties: { n: { type: 'string' } } } } },
        },
      },
      array(model('PetsItem')),
      ['PetsItem', 'PetsItemOwner'],
      [],
    ],
    [
      'a union of inline objects',
      {
        Pets: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'object', properties: { radius: { type: 'number' } } },
              { type: 'object', properties: { side: { type: 'number' } } },
            ],
          },
        },
      },
      array({ kind: 'union', variants: [model('PetsItem'), model('PetsItemWithSide')], compositionKind: 'oneOf' }),
      ['PetsItem', 'PetsItemWithSide'],
      [],
    ],
    [
      'an `allOf` of a component and an inline object',
      {
        Pets: {
          type: 'array',
          items: { allOf: [ref('Widget'), { type: 'object', properties: { extra: { type: 'string' } } }] },
        },
        Widget: { type: 'object', properties: { id: { type: 'string' } } },
      },
      array(model('PetsItem')),
      ['PetsItem', 'Widget'],
      [],
    ],
  ];

  it.each(cases)(
    'types %s the way an inline array of them is typed, and creates what they reference',
    async (_shape, schemas, expected, models, enums) => {
      const spec = await parse(specDoc({ Owner: owner, ...schemas }, { '/pets': getOp('listPets', ref('Pets')) }));
      expect(fieldType(spec, 'Owner', 'pets')).toEqual(expected);
      expect(opsOf(spec).listPets.response).toEqual(expected);
      expect(spec.models.map((m) => m.name).sort()).toEqual(['Owner', ...models].sort());
      expect(spec.enums.map((e) => e.name).sort()).toEqual(enums.sort());
      expect(warnings()).toEqual([]);
      const components = Object.keys(schemas).filter((name) => !isArrayComponentSchema(schemas[name] as never));
      expectSound(spec, ['Owner', ...components], ['Pets']);

      // The same array written inline on the field has the same shape, its
      // models and enums named from the field (`OwnerPet`, `OwnerPets`)
      // instead of the component, and nothing dangles there either.
      const { Pets: _pets, ...rest } = schemas;
      const inline = await parse(specDoc({ Owner: { type: 'object', properties: { pets: schemas.Pets } }, ...rest }));
      const shapeOf = (type: TypeRef): unknown =>
        JSON.parse(JSON.stringify(type, (key, value: unknown) => (key === 'name' ? '*' : value)));
      expect(shapeOf(fieldType(inline, 'Owner', 'pets')!)).toEqual(shapeOf(expected));
      expect(unresolvedReferences(inline)).toEqual([]);
    },
  );

  it('lifts an inline item enum, and keeps an inline item model, of a component nothing references', async () => {
    const spec = await parse(
      specDoc({
        Palette: { type: 'array', items: { type: 'string', enum: ['red', 'green'] } },
        Pets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
      }),
    );
    expect(spec.enums.map((e) => [e.name, e.values.map((v) => v.value)])).toEqual([['PaletteItem', ['red', 'green']]]);
    expect(spec.models.map((m) => m.name)).toEqual(['PetsItem']);
    expect(warnings()).toEqual([]);
  });

  it('keeps the item model’s own documentation, flag and limits', async () => {
    const spec = await parse(
      specDoc({
        Pets: {
          type: 'array',
          description: 'Every pet',
          items: {
            type: 'object',
            description: 'One pet',
            deprecated: true,
            minProperties: 1,
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      }),
    );
    expect(spec.models).toEqual([
      {
        name: 'PetsItem',
        description: 'One pet',
        deprecated: true,
        fields: [
          {
            name: 'name',
            type: string,
            required: true,
            description: undefined,
            default: undefined,
            example: undefined,
          },
        ],
        constraints: { minProperties: 1 },
      },
    ]);
  });
});

describe('a cycle through the items', () => {
  it('types the inner reference as unknown and warns once per component, however often it is referenced', async () => {
    const spec = await parse(
      specDoc(
        {
          Tree: { type: 'array', items: ref('Tree') },
          Forest: { type: 'object', properties: { a: ref('Tree'), b: ref('Tree') } },
        },
        { '/trees': getOp('listTrees', ref('Tree')) },
      ),
    );
    const unknown: TypeRef = { kind: 'primitive', type: 'unknown' };
    expect(fieldType(spec, 'Forest', 'a')).toEqual(array(unknown));
    expect(fieldType(spec, 'Forest', 'b')).toEqual(array(unknown));
    expect(opsOf(spec).listTrees.response).toEqual(array(unknown));
    expect(spec.models.map((m) => m.name)).toEqual(['Forest']);
    expect(warnings()).toEqual([
      '[oagen] Warning: Array component "Tree" refers to itself through its items — the inner reference is typed as unknown',
    ]);
  });

  it('cuts a cycle through another array component at the component that closes it', async () => {
    const spec = await parse(
      specDoc({
        A: { type: 'array', items: ref('B') },
        B: { type: 'array', items: ref('A') },
        Holder: { type: 'object', properties: { a: ref('A'), b: ref('B') } },
      }),
    );
    const unknown: TypeRef = { kind: 'primitive', type: 'unknown' };
    expect(fieldType(spec, 'Holder', 'a')).toEqual(array(array(unknown)));
    expect(fieldType(spec, 'Holder', 'b')).toEqual(array(array(unknown)));
    expect(warnings()).toEqual([
      '[oagen] Warning: Array component "A" refers to itself through its items — the inner reference is typed as unknown',
      '[oagen] Warning: Array component "B" refers to itself through its items — the inner reference is typed as unknown',
    ]);
  });
});

describe('a name the items would mint that a component already owns', () => {
  const items = { type: 'object', properties: { name: { type: 'string' } } };
  const owner = { type: 'object', properties: { pets: ref('Pets'), item: ref('PetsItem') } };

  it('steps the items past a component of another shape, as a named union’s variant steps', async () => {
    const spec = await parse(
      specDoc({
        Owner: owner,
        Pets: { type: 'array', items },
        PetsItem: { type: 'object', properties: { id: { type: 'integer' } } },
      }),
    );
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(array(model('PetsItemItem')));
    expect(fieldType(spec, 'Owner', 'item')).toEqual(model('PetsItem'));
    expect(spec.models.find((m) => m.name === 'PetsItem')?.fields.map((f) => f.name)).toEqual(['id']);
    expect(spec.models.find((m) => m.name === 'PetsItemItem')?.fields.map((f) => f.name)).toEqual(['name']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Owner', 'PetsItem'], ['Pets']);
  });

  it('shares a component of the identical shape', async () => {
    const spec = await parse(specDoc({ Owner: owner, Pets: { type: 'array', items }, PetsItem: items }));
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(array(model('PetsItem')));
    expect(spec.models.map((m) => m.name).sort()).toEqual(['Owner', 'PetsItem']);
    expect(warnings()).toEqual([]);
  });

  it('steps an inline item enum past a component enum of other members', async () => {
    const spec = await parse(
      specDoc({
        Owner: owner,
        Pets: { type: 'array', items: { type: 'string', enum: ['cat', 'dog'] } },
        PetsItem: { type: 'string', enum: ['fish'] },
      }),
    );
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(
      array({ kind: 'enum', name: 'PetsItemItem', values: ['cat', 'dog'] }),
    );
    expect(spec.enums.map((e) => [e.name, e.values.map((v) => v.value)])).toEqual([
      ['PetsItem', ['fish']],
      ['PetsItemItem', ['cat', 'dog']],
    ]);
    expect(warnings()).toEqual([]);
  });

  it('steps past a named union’s titled variant of another shape', async () => {
    const spec = await parse(
      specDoc({
        Owner: owner,
        Pets: { type: 'array', items },
        PetsItem: { type: 'object', properties: { id: { type: 'integer' } } },
        Shape: {
          oneOf: [
            { title: 'PetsItem', type: 'object', properties: { kind: { const: 'pet' }, legs: { type: 'integer' } } },
            { title: 'Rock', type: 'object', properties: { kind: { const: 'rock' }, mass: { type: 'number' } } },
          ],
        },
      }),
    );
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(array(model('PetsItemItem')));
    expect(spec.models.find((m) => m.name === 'PetsItemItem')?.fields.map((f) => f.name)).toEqual(['name']);
    expect(unresolvedReferences(spec)).toEqual([]);
  });
});

describe('every reference site', () => {
  const items = { type: 'object', properties: { name: { type: 'string' } } };
  const schemas = {
    Pets: { type: 'array', items },
    PetsOrNone: { type: ['array', 'null'], items: ref('Pet') },
    Pet: { type: 'object', properties: { id: { type: 'string' } } },
    Owner: {
      type: 'object',
      properties: {
        pets: ref('Pets'),
        viaAllOf: { allOf: [ref('Pets')] },
        viaAllOfWithLimits: { allOf: [ref('Pets'), { minItems: 1 }] },
      },
    },
    Choice: { oneOf: [ref('Pets'), ref('Pet')] },
  };
  const param = (name: string, location: string, schema: unknown = ref('Pets')) => ({ name, in: location, schema });
  const doc = specDoc(
    schemas,
    {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [param('filter', 'query'), param('X-Pets', 'header'), param('session', 'cookie')],
          responses: {
            '200': {
              description: 'OK',
              headers: { 'X-Seen': { schema: ref('Pets') } },
              content: { 'application/json': { schema: ref('Pets') } },
            },
            '404': { description: 'Missing', content: { 'application/json': { schema: ref('Pets') } } },
            '5XX': { description: 'Down', content: { 'application/json': { schema: ref('PetsOrNone') } } },
            default: { description: 'Other', content: { 'application/json': { schema: ref('Pets') } } },
          },
        },
        post: {
          operationId: 'createPets',
          requestBody: { required: true, content: { 'application/json': { schema: ref('Pets') } } },
          responses: {
            '201': { description: 'Created', content: { 'application/json': { schema: ref('PetsOrNone') } } },
          },
        },
      },
      '/pets/{ids}': getOp('getPets', ref('Pet'), {
        parameters: [{ name: 'ids', in: 'path', required: true, schema: ref('Pets') }],
      }),
    },
    {
      webhooks: {
        petsAdopted: {
          post: {
            operationId: 'petsAdopted',
            parameters: [param('X-Adopted', 'header')],
            requestBody: { content: { 'application/json': { schema: ref('Pets') } } },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    },
  );

  it('resolves to the array at every site, and no site minted a model of its own', async () => {
    const spec = await parse(doc);
    const pets = array(model('PetsItem'));
    const ops = opsOf(spec);
    const list = ops.listPets;
    expect(list.response).toEqual(pets);
    expect(list.queryParams.map((p) => [p.name, p.type])).toEqual([['filter', pets]]);
    expect(list.headerParams.map((p) => [p.name, p.type])).toEqual([['X-Pets', pets]]);
    expect(list.cookieParams?.map((p) => [p.name, p.type])).toEqual([['session', pets]]);
    expect(collectResponseHeaders(list).map((h) => [h.name, h.type])).toEqual([['X-Seen', pets]]);
    expect(list.errors.map((e) => [e.statusCode, e.type])).toEqual([[404, pets]]);
    expect(list.rangeResponses?.map((r) => [r.range, r.type])).toEqual([['5XX', nullable(array(model('Pet')))]]);
    expect(list.defaultResponse?.type).toEqual(pets);
    expect(ops.createPets.requestBody).toEqual(pets);
    expect(ops.createPets.response).toEqual(nullable(array(model('Pet'))));
    expect(ops.getPets.pathParams.map((p) => [p.name, p.type])).toEqual([['ids', pets]]);
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(pets);
    expect(fieldType(spec, 'Owner', 'viaAllOf')).toEqual(pets);
    expect(fieldType(spec, 'Owner', 'viaAllOfWithLimits')).toEqual(pets);
    expect(spec.models.find((m) => m.name === 'Choice')?.variants).toEqual([pets, model('Pet')]);
    const hook = spec.webhooks?.find((w) => w.name === 'petsAdopted');
    expect(hook?.requestBody).toEqual(pets);
    expect(hook?.headerParams.map((p) => [p.name, p.type])).toEqual([['X-Adopted', pets]]);

    expect(spec.models.map((m) => m.name).sort()).toEqual(['Choice', 'Owner', 'Pet', 'PetsItem']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Owner', 'Pet', 'Choice'], ['Pets', 'PetsOrNone']);
  });

  it('reads a parameter’s documentation and limits from the component, as a parameter always has', async () => {
    const spec = await parse(
      specDoc(
        {
          Pets: {
            type: 'array',
            description: 'Pet names',
            deprecated: true,
            minItems: 1,
            maxItems: 10,
            items: { type: 'string' },
          },
          Owner: { type: 'object', properties: { pets: { ...ref('Pets'), description: 'Theirs' } } },
        },
        {
          '/pets': getOp(
            'listPets',
            { type: 'string' },
            {
              parameters: [{ name: 'names', in: 'query', schema: { ...ref('Pets'), minItems: 2 } }],
            },
          ),
        },
      ),
    );
    const [names] = opsOf(spec).listPets.queryParams;
    expect(names).toMatchObject({
      type: array(string),
      description: 'Pet names',
      deprecated: true,
      constraints: { minItems: 2, maxItems: 10 },
    });
    // A field reads its own schema only: the sibling text is its own, and a
    // bare `$ref` declares no limits, as before.
    const pets = spec.models.find((m) => m.name === 'Owner')?.fields[0];
    expect(pets).toMatchObject({ type: array(string), description: 'Theirs' });
    expect(pets).not.toHaveProperty('constraints');
    expect(pets).not.toHaveProperty('deprecated', true);
  });
});

describe('a list envelope whose data array is a `$ref`', () => {
  const items = { type: 'object', properties: { name: { type: 'string' } } };
  const envelope = (data: unknown) => ({
    type: 'object',
    properties: { data, list_metadata: { type: 'object', properties: { after: { type: 'string' } } } },
    required: ['data', 'list_metadata'],
  });
  const listPets = (data: unknown, schemas: Record<string, unknown>) =>
    specDoc(schemas, {
      '/pets': getOp('listPets', envelope(data), {
        parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
      }),
    });

  it('is read as the list it is, iterating the component’s items', async () => {
    const spec = await parse(listPets(ref('Pets'), { Pets: { type: 'array', items } }));
    const op = opsOf(spec).listPets;
    expect(op.response).toEqual(array(model('PetsItem')));
    expect(op.pagination).toMatchObject({ dataPath: 'data', itemType: model('PetsItem') });
    expect(op.pagination?.envelopeFields?.map((f) => f.name)).toEqual(['list_metadata']);
    expect(spec.models.map((m) => m.name).sort()).toEqual(['ListMetadata', 'PetsItem']);
    expect(warnings()).toEqual([]);
    expectSound(spec, [], ['Pets']);

    // Exactly as the same array written inline is read, its items named
    // from the operation instead.
    const inline = opsOf(await parse(listPets({ type: 'array', items }, {}))).listPets;
    expect(inline.pagination).toMatchObject({ dataPath: 'data', itemType: model('ListPetsItem') });
    expect(inline.pagination?.envelopeFields).toEqual(op.pagination?.envelopeFields);
  });

  it.each([
    ['the component', ref('Pets'), { type: ['array', 'null'], items }],
    ['a oneOf around the reference', { oneOf: [ref('Pets'), { type: 'null' }] }, { type: 'array', items }],
    ['an anyOf around the reference', { anyOf: [{ type: 'null' }, ref('Pets')] }, { type: 'array', items }],
  ])('keeps the null when %s is nullable', async (_form, data, Pets) => {
    const op = opsOf(await parse(listPets(data, { Pets }))).listPets;
    expect(op.response).toEqual(nullable(array(model('PetsItem'))));
    expect(op.pagination).toMatchObject({ dataPath: 'data', itemType: model('PetsItem') });
    expect(warnings()).toEqual([]);
  });

  it('is not an envelope when the reference is to an object component', async () => {
    const op = opsOf(
      await parse(listPets(ref('Pets'), { Pets: { type: 'object', properties: { n: { type: 'string' } } } })),
    ).listPets;
    expect(op.response).toEqual(model('ListPetsResponse'));
    // The `after` parameter alone still makes a cursor iterator; no data array was found.
    expect(op.pagination).toMatchObject({ strategy: 'cursor', itemType: model('ListPetsResponse') });
    expect(op.pagination?.dataPath).toBeUndefined();
  });
});

describe('with a schemaNameTransform', () => {
  it('names the items from the transformed component name, and the references follow', async () => {
    const spec = await parse(
      specDoc(
        {
          pet_list: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
          owner_dto: { type: 'object', properties: { pets: ref('pet_list') } },
        },
        { '/pets': getOp('listPets', ref('pet_list')) },
      ),
      { schemaNameTransform: (name) => name.replace(/Dto$/, '').replace(/^PetList$/, 'PetCollection') },
    );
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(array(model('PetCollectionItem')));
    expect(opsOf(spec).listPets.response).toEqual(array(model('PetCollectionItem')));
    expect(spec.models.map((m) => m.name).sort()).toEqual(['Owner', 'PetCollectionItem']);
    expect(warnings()).toEqual([]);
  });
});

describe('what is not an array component', () => {
  it('keeps the fieldless model of an array without `items`, with the warning the inline form gets', async () => {
    const spec = await parse(
      specDoc({ Pets: { type: 'array' }, Owner: { type: 'object', properties: { pets: ref('Pets') } } }),
    );
    expect(fieldType(spec, 'Owner', 'pets')).toEqual(model('Pets'));
    expect(spec.models.map((m) => m.name).sort()).toEqual(['Owner', 'Pets']);
  });

  it('reads an `enum:` list beside `type: array` as an enum, and a oneOf beside `items` as a named union, as before', async () => {
    const spec = await parse(
      specDoc({
        Tags: { type: 'array', enum: [['a'], ['b']] },
        Either: {
          items: { type: 'string' },
          oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'integer' }],
        },
        Owner: { type: 'object', properties: { tags: ref('Tags'), either: ref('Either') } },
      }),
    );
    expect(fieldType(spec, 'Owner', 'tags')).toEqual({ kind: 'enum', name: 'Tags' });
    expect(fieldType(spec, 'Owner', 'either')).toEqual(model('Either'));
    expect(spec.models.find((m) => m.name === 'Either')?.compositionKind).toBe('oneOf');
  });
});

describe('isArrayComponentSchema', () => {
  const items = { type: 'string' };
  it('accepts every spelling schemaToTypeRef types as an array that declares items', () => {
    expect(isArrayComponentSchema({ type: 'array', items })).toBe(true);
    expect(isArrayComponentSchema({ items })).toBe(true);
    expect(isArrayComponentSchema({ type: ['array', 'null'], items })).toBe(true);
    expect(isArrayComponentSchema({ type: 'array', nullable: true, items })).toBe(true);
    expect(isArrayComponentSchema({ type: 'array', items: {} })).toBe(true);
    expect(isArrayComponentSchema({ type: 'array', items, allOf: [{ minItems: 1 }] })).toBe(true);
  });

  it('rejects an array without items and everything that is not an array', () => {
    expect(isArrayComponentSchema({ type: 'array' })).toBe(false);
    expect(isArrayComponentSchema({ type: 'array', items, enum: ['a', 'b'] })).toBe(false);
    expect(isArrayComponentSchema({ items, oneOf: [{ type: 'array', items }, { type: 'null' }] })).toBe(false);
    expect(isArrayComponentSchema({ items, allOf: [{ $ref: '#/components/schemas/List' }] })).toBe(false);
    expect(isArrayComponentSchema({ type: ['array', 'string'], items })).toBe(false);
    expect(isArrayComponentSchema({ type: 'object', properties: { items } })).toBe(false);
    expect(isArrayComponentSchema({ $ref: '#/components/schemas/Pets' })).toBe(false);
  });
});

describe('isArrayComponentRef', () => {
  const schemas = {
    Pets: { type: 'array', items: { type: 'string' } },
    Pet: { type: 'object', properties: { id: { type: 'string' } } },
  };

  it('answers for a reference as schemaToTypeRef types it, during an extraction only', () => {
    expect(isArrayComponentRef(ref('Pets'))).toBe(false);
    expect(schemaToTypeRef(ref('Pets'))).toEqual(model('Pets'));
    extractSchemas(schemas as never);
    try {
      expect(isArrayComponentRef(ref('Pets'))).toBe(true);
      expect(isArrayComponentRef({ oneOf: [ref('Pets'), { type: 'null' }] })).toBe(true);
      expect(isArrayComponentRef({ anyOf: [{ type: 'null' }, ref('Pets')] })).toBe(true);
      expect(isArrayComponentRef(ref('Pet'))).toBe(false);
      expect(isArrayComponentRef(ref('Missing'))).toBe(false);
      expect(isArrayComponentRef({ type: 'array', items: { type: 'string' } })).toBe(false);
      expect(isArrayComponentRef(undefined)).toBe(false);
      expect(schemaToTypeRef(ref('Pets'))).toEqual(array(string));
    } finally {
      clearSchemaNameTransform();
    }
    expect(isArrayComponentRef(ref('Pets'))).toBe(false);
    expect(schemaToTypeRef(ref('Pets'))).toEqual(model('Pets'));
  });
});

describe('a named union’s array variant (the shared stepping rule)', () => {
  it('steps a bare-items or nullable array variant with `_item`, and shares a claimant of the items’ shape', async () => {
    const item = { type: 'object', properties: { name: { type: 'string' } } };
    const spec = await parse(
      specDoc({
        Pet: {
          oneOf: [
            { items: item },
            { type: ['array', 'null'], items: { type: 'object', properties: { id: { type: 'string' } } } },
          ],
        },
        PetVariant1: { type: 'object', properties: { other: { type: 'integer' } } },
        PetVariant2: { type: 'object', properties: { id: { type: 'string' } } },
      }),
    );
    const pet = spec.models.find((m) => m.name === 'Pet');
    expect(pet?.variants).toEqual([array(model('PetVariant1Item')), nullable(array(model('PetVariant2')))]);
    expect(spec.models.map((m) => m.name).sort()).toEqual(['Pet', 'PetVariant1', 'PetVariant1Item', 'PetVariant2']);
    expect(warnings()).toEqual([]);
  });
});
