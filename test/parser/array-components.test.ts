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

  // Greptile (#335, round 1): only the item model's own name was checked, so
  // the owner object nested under `Pets`'s items and a component
  // `PetsItemOwner` reached the model map under one name, and whichever was
  // declared first silently replaced the other's fields.
  const nested = {
    type: 'object',
    properties: { owner: { type: 'object', properties: { name: { type: 'string' } } } },
  };
  const holder = { type: 'object', properties: { pets: ref('Pets'), o: ref('PetsItemOwner') } };
  const idModel = { type: 'object', properties: { id: { type: 'integer' } } };

  it.each([
    ['the array component first', { Holder: holder, Pets: { type: 'array', items: nested }, PetsItemOwner: idModel }],
    ['the component first', { Holder: holder, PetsItemOwner: idModel, Pets: { type: 'array', items: nested } }],
  ])(
    'steps the whole tree past a component that an object nested under the items would be named like, with %s',
    async (_order, schemas) => {
      const spec = await parse(specDoc(schemas));
      expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItemItem')));
      expect(fieldType(spec, 'Holder', 'o')).toEqual(model('PetsItemOwner'));
      expect(spec.models.find((m) => m.name === 'PetsItemOwner')?.fields.map((f) => f.name)).toEqual(['id']);
      expect(fieldType(spec, 'PetsItemItem', 'owner')).toEqual(model('PetsItemItemOwner'));
      expect(spec.models.find((m) => m.name === 'PetsItemItemOwner')?.fields.map((f) => f.name)).toEqual(['name']);
      expect(spec.models.map((m) => m.name).sort()).toEqual([
        'Holder',
        'PetsItemItem',
        'PetsItemItemOwner',
        'PetsItemOwner',
      ]);
      expect(warnings()).toEqual([]);
      expectSound(spec, ['Holder', 'PetsItemOwner'], ['Pets']);
    },
  );

  it('shares a component of the identical shape that an object nested under the items would be named like', async () => {
    const spec = await parse(
      specDoc({ Holder: holder, Pets: { type: 'array', items: nested }, PetsItemOwner: nested.properties.owner }),
    );
    expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItem')));
    expect(fieldType(spec, 'PetsItem', 'owner')).toEqual(model('PetsItemOwner'));
    expect(spec.models.map((m) => m.name).sort()).toEqual(['Holder', 'PetsItem', 'PetsItemOwner']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder', 'PetsItemOwner'], ['Pets']);
  });

  it.each([
    [
      'other members',
      ['x'],
      'PetsItemItem',
      'PetsItemItemStatus',
      [
        ['PetsItemItemStatus', ['on', 'off']],
        ['PetsItemStatus', ['x']],
      ],
    ],
    ['the same members', ['on', 'off'], 'PetsItem', 'PetsItemStatus', [['PetsItemStatus', ['on', 'off']]]],
  ] as const)(
    'reads an enum a nested field holds against a component enum of %s',
    async (_members, claimant, itemName, enumName, expectedEnums) => {
      const spec = await parse(
        specDoc({
          Holder: { type: 'object', properties: { pets: ref('Pets'), s: ref('PetsItemStatus') } },
          Pets: {
            type: 'array',
            items: { type: 'object', properties: { status: { type: 'string', enum: ['on', 'off'] } } },
          },
          PetsItemStatus: { type: 'string', enum: claimant },
        }),
      );
      expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model(itemName)));
      expect(fieldType(spec, itemName, 'status')).toEqual({ kind: 'enum', name: enumName, values: ['on', 'off'] });
      expect(fieldType(spec, 'Holder', 's')).toEqual({ kind: 'enum', name: 'PetsItemStatus' });
      expect(spec.enums.map((e) => [e.name, e.values.map((v) => v.value)]).sort()).toEqual(expectedEnums);
      expect(warnings()).toEqual([]);
      expectSound(spec, ['Holder'], ['Pets']);
    },
  );

  // Two trees that mint one nested name: `Pets`'s items hold `cat_item_owner`
  // and `PetsItemCat`'s items hold `owner`, and both are `PetsItemCatItemOwner`.
  const petsTree = (owner: unknown) => ({
    type: 'array',
    items: { type: 'object', properties: { cat_item_owner: owner } },
  });
  const catTree = (owner: unknown) => ({ type: 'array', items: { type: 'object', properties: { owner } } });
  const nameOwner = { type: 'object', properties: { name: { type: 'string' } } };
  const twoTrees = (entries: Array<[string, unknown]>) =>
    specDoc({
      Holder: { type: 'object', properties: { pets: ref('Pets'), cats: ref('PetsItemCat') } },
      ...Object.fromEntries(entries),
    });
  const bothOrders = (entries: Array<[string, unknown]>): Array<[string, Array<[string, unknown]>]> => [
    [`${entries[0][0]} first`, entries],
    [`${entries[1][0]} first`, [...entries].reverse()],
  ];

  it.each(
    bothOrders([
      ['Pets', petsTree(nameOwner)],
      ['PetsItemCat', catTree(idModel)],
    ]),
  )(
    'steps the tree decided first past the other when two mint one nested name for different shapes, with %s',
    async (_order, entries) => {
      // Plans are decided by key order (`Pets` before `PetsItemCat`), never
      // document order: `Pets` steps around `PetsItemCat`'s names under
      // `item`, and `PetsItemCat`, decided against `Pets`'s settled names, is
      // then free to keep `item`.
      const spec = await parse(twoTrees(entries));
      expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItemItem')));
      expect(fieldType(spec, 'PetsItemItem', 'cat_item_owner')).toEqual(model('PetsItemItemCatItemOwner'));
      expect(fieldType(spec, 'Holder', 'cats')).toEqual(array(model('PetsItemCatItem')));
      expect(fieldType(spec, 'PetsItemCatItem', 'owner')).toEqual(model('PetsItemCatItemOwner'));
      expect(spec.models.find((m) => m.name === 'PetsItemItemCatItemOwner')?.fields.map((f) => f.name)).toEqual([
        'name',
      ]);
      expect(spec.models.find((m) => m.name === 'PetsItemCatItemOwner')?.fields.map((f) => f.name)).toEqual(['id']);
      expect(spec.models.map((m) => m.name).sort()).toEqual([
        'Holder',
        'PetsItemCatItem',
        'PetsItemCatItemOwner',
        'PetsItemItem',
        'PetsItemItemCatItemOwner',
      ]);
      expect(warnings()).toEqual([]);
      expectSound(spec, ['Holder'], ['Pets', 'PetsItemCat']);
    },
  );

  // Greptile (#335, round 2): a plan read the other trees' names under
  // `item` only, so two trees that both stepped could land on one name:
  // here both nested owners became `PetsItemItemCatItemItemOwner`.
  const greptile2 = (owners: [unknown, unknown]): Array<[string, unknown]> => [
    ['Pets', { type: 'array', items: { type: 'object', properties: { cat_item_item_owner: owners[0] } } }],
    ['PetsItemItemCat', { type: 'array', items: { type: 'object', properties: { owner: owners[1] } } }],
    ['PetsItem', { type: 'object', properties: { q: { type: 'string' } } }],
    ['PetsItemItemCatItem', { type: 'object', properties: { r: { type: 'string' } } }],
  ];
  const greptile2Doc = (entries: Array<[string, unknown]>) =>
    specDoc({
      Holder: { type: 'object', properties: { pets: ref('Pets'), cats: ref('PetsItemItemCat') } },
      ...Object.fromEntries(entries),
    });

  it.each([
    ['as written', greptile2([nameOwner, idModel])],
    ['reversed', [...greptile2([nameOwner, idModel])].reverse()],
  ])('never lets two stepped trees land on one nested name, with the document %s', async (_order, entries) => {
    const spec = await parse(greptile2Doc(entries));
    // `Pets`, decided first, steps once; `PetsItemItemCat` steps past the
    // component and then past `Pets`'s settled `PetsItemItemCatItemItemOwner`.
    expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItemItem')));
    expect(fieldType(spec, 'PetsItemItem', 'cat_item_item_owner')).toEqual(model('PetsItemItemCatItemItemOwner'));
    expect(fieldType(spec, 'Holder', 'cats')).toEqual(array(model('PetsItemItemCatItemArrayItem')));
    expect(fieldType(spec, 'PetsItemItemCatItemArrayItem', 'owner')).toEqual(
      model('PetsItemItemCatItemArrayItemOwner'),
    );
    expect(spec.models.find((m) => m.name === 'PetsItemItemCatItemItemOwner')?.fields.map((f) => f.name)).toEqual([
      'name',
    ]);
    expect(spec.models.find((m) => m.name === 'PetsItemItemCatItemArrayItemOwner')?.fields.map((f) => f.name)).toEqual([
      'id',
    ]);
    expect(spec.models.find((m) => m.name === 'PetsItem')?.fields.map((f) => f.name)).toEqual(['q']);
    expect(spec.models.find((m) => m.name === 'PetsItemItemCatItem')?.fields.map((f) => f.name)).toEqual(['r']);
    expect(spec.models).toHaveLength(7);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder', 'PetsItem', 'PetsItemItemCatItem'], ['Pets', 'PetsItemItemCat']);
  });

  it.each([
    ['as written', false],
    ['reversed', true],
  ])(
    'decides a chain of three trees whose names nest into each other, with the document %s',
    async (_order, reversed) => {
      const owner = (field: string) => ({ type: 'object', properties: { [field]: { type: 'string' } } });
      const tree = (field: string) => ({
        type: 'array',
        items: { type: 'object', properties: { owner: owner(field) } },
      });
      const entries: Array<[string, unknown]> = [
        ['Pets', tree('a')],
        ['PetsItem', tree('b')],
        ['PetsItemItem', tree('c')],
      ];
      const spec = await parse(
        specDoc({
          Holder: { type: 'object', properties: { a: ref('Pets'), b: ref('PetsItem'), c: ref('PetsItemItem') } },
          ...Object.fromEntries(reversed ? [...entries].reverse() : entries),
        }),
      );
      // Each tree's `item` name is the next component's key, and its `item_item`
      // names are the next tree's names under `item`, so the first two land on
      // `item_array_item` and the last keeps `item`.
      expect(fieldType(spec, 'Holder', 'a')).toEqual(array(model('PetsItemArrayItem')));
      expect(fieldType(spec, 'Holder', 'b')).toEqual(array(model('PetsItemItemArrayItem')));
      expect(fieldType(spec, 'Holder', 'c')).toEqual(array(model('PetsItemItemItem')));
      expect(fieldType(spec, 'PetsItemArrayItemOwner', 'a')).toEqual(string);
      expect(fieldType(spec, 'PetsItemItemArrayItemOwner', 'b')).toEqual(string);
      expect(fieldType(spec, 'PetsItemItemItemOwner', 'c')).toEqual(string);
      expect(spec.models).toHaveLength(7);
      expect(warnings()).toEqual([]);
      expectSound(spec, ['Holder'], ['Pets', 'PetsItem', 'PetsItemItem']);
    },
  );

  it.each(
    bothOrders([
      ['Pets', petsTree(nameOwner)],
      ['PetsItemCat', catTree(nameOwner)],
    ]),
  )('lets two trees that mint one nested name for the identical shape share it, with %s', async (_order, entries) => {
    const spec = await parse(twoTrees(entries));
    expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItem')));
    expect(fieldType(spec, 'PetsItem', 'cat_item_owner')).toEqual(model('PetsItemCatItemOwner'));
    expect(fieldType(spec, 'Holder', 'cats')).toEqual(array(model('PetsItemCatItem')));
    expect(fieldType(spec, 'PetsItemCatItem', 'owner')).toEqual(model('PetsItemCatItemOwner'));
    expect(spec.models.map((m) => m.name).sort()).toEqual([
      'Holder',
      'PetsItem',
      'PetsItemCatItem',
      'PetsItemCatItemOwner',
    ]);
    expect(spec.models.find((m) => m.name === 'PetsItemCatItemOwner')?.fields.map((f) => f.name)).toEqual(['name']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder'], ['Pets', 'PetsItemCat']);
  });

  it.each(
    bothOrders([
      ['Pets', { type: 'array', items: nameOwner }],
      ['PetsItem', { type: 'array', items: idModel }],
    ]),
  )(
    'steps a tree whose item model would be named like another array component, which keeps its own names, with %s',
    async (_order, entries) => {
      const spec = await parse(
        specDoc({
          Holder: { type: 'object', properties: { pets: ref('Pets'), items: ref('PetsItem') } },
          ...Object.fromEntries(entries),
        }),
      );
      // `PetsItem` is taken by the component's name, `PetsItemItem` by the
      // other tree's item model, so the tree lands on `item_array_item`.
      expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItemArrayItem')));
      expect(fieldType(spec, 'Holder', 'items')).toEqual(array(model('PetsItemItem')));
      expect(spec.models.find((m) => m.name === 'PetsItemArrayItem')?.fields.map((f) => f.name)).toEqual(['name']);
      expect(spec.models.find((m) => m.name === 'PetsItemItem')?.fields.map((f) => f.name)).toEqual(['id']);
      expect(spec.models.map((m) => m.name).sort()).toEqual(['Holder', 'PetsItemArrayItem', 'PetsItemItem']);
      expect(warnings()).toEqual([]);
      expectSound(spec, ['Holder'], ['Pets', 'PetsItem']);
    },
  );

  it('prints a warning the items deserve once, not once more per rehearsal of their names', async () => {
    const spec = await parse(
      specDoc({
        Holder: { type: 'object', properties: { pets: ref('Pets') } },
        Pets: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, tags: { type: 'array' } },
            oneOf: [ref('Cat'), { type: 'object', properties: { name: { type: 'string' } } }],
          },
        },
        Cat: { type: 'object', properties: { meow: { type: 'boolean' } } },
      }),
    );
    expect(unresolvedReferences(spec)).toEqual([]);
    // The fold warning (once per union) and the unknown-shape warning for
    // the item-less `tags` array, each printed by the extraction that keeps
    // the models and by nothing else.
    expect(warnings().filter((w) => w.includes('`properties` beside `oneOf`'))).toHaveLength(1);
    expect(warnings().filter((w) => w.includes('Unknown schema shape'))).toHaveLength(1);
    expect(warnings()).toHaveLength(2);
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
    // A field keeps its own text over the component's, takes the component's
    // flag (there is no model to carry it; see the next describe), and a
    // bare `$ref` declares no limits, as before.
    const pets = spec.models.find((m) => m.name === 'Owner')?.fields[0];
    expect(pets).toMatchObject({ type: array(string), description: 'Theirs', deprecated: true });
    expect(pets).not.toHaveProperty('constraints');
  });
});

describe('the component’s documentation and flag (MichaelDeBoey)', () => {
  // No model carries an array component's `description`, `deprecated` and
  // `externalDocs`, so a field that names it with a bare `$ref` takes them
  // when it declares none of its own, as it takes the component's `example`.
  const pets = {
    type: 'array',
    description: 'All pets',
    deprecated: true,
    externalDocs: { url: 'https://x/pets' },
    items: { type: 'string' },
  };

  it('reaches a bare `$ref` field, every path that builds a field included', async () => {
    const spec = await parse(
      specDoc({
        Pets: pets,
        Owner: { type: 'object', properties: { pets: ref('Pets') } },
        Base: { type: 'object', properties: { pets: ref('Pets') } },
        Derived: { allOf: [ref('Base'), { type: 'object', properties: { more: { type: 'string' } } }] },
      }),
    );
    for (const owner of ['Owner', 'Base', 'Derived']) {
      expect(spec.models.find((m) => m.name === owner)?.fields.find((f) => f.name === 'pets')).toMatchObject({
        type: array(string),
        description: 'All pets',
        deprecated: true,
        externalDocs: { url: 'https://x/pets' },
      });
    }
    expect(warnings()).toEqual([]);
  });

  it('yields to the field’s own text and link, and reads the flag from either side', async () => {
    const spec = await parse(
      specDoc({
        Pets: pets,
        Live: { type: 'array', items: { type: 'string' } },
        Owner: {
          type: 'object',
          properties: {
            own: { ...ref('Pets'), description: 'Mine', externalDocs: { url: 'https://x/own' } },
            flagged: { ...ref('Live'), deprecated: true },
          },
        },
      }),
    );
    const field = (name: string) => spec.models.find((m) => m.name === 'Owner')?.fields.find((f) => f.name === name);
    expect(field('own')).toMatchObject({
      description: 'Mine',
      deprecated: true,
      externalDocs: { url: 'https://x/own' },
    });
    expect(field('flagged')).toMatchObject({ deprecated: true });
    expect(field('flagged')?.description).toBeUndefined();
    expect(field('flagged')).not.toHaveProperty('externalDocs');
  });

  it('is not read through a wrapper, nor from a component that keeps a model or an enum', async () => {
    const spec = await parse(
      specDoc({
        Pets: pets,
        Widget: { type: 'object', description: 'W', deprecated: true, properties: { id: { type: 'string' } } },
        Color: { type: 'string', description: 'C', deprecated: true, enum: ['red'] },
        Owner: {
          type: 'object',
          properties: {
            wrapped: { oneOf: [ref('Pets'), { type: 'null' }] },
            merged: { allOf: [ref('Pets')] },
            w: ref('Widget'),
            c: ref('Color'),
          },
        },
      }),
    );
    for (const name of ['wrapped', 'merged', 'w', 'c']) {
      const field = spec.models.find((m) => m.name === 'Owner')?.fields.find((f) => f.name === name);
      expect(field?.description).toBeUndefined();
      expect(field?.deprecated).toBeUndefined();
      expect(field).not.toHaveProperty('externalDocs');
    }
    expect(spec.models.find((m) => m.name === 'Widget')).toMatchObject({ description: 'W', deprecated: true });
    expect(spec.enums.find((e) => e.name === 'Color')).toMatchObject({ description: 'C', deprecated: true });
  });
});

describe('two keys that resolve to one name (MichaelDeBoey)', () => {
  // `cleanSchemaName` singularizes the leading word, so `Note` and `Notes`
  // are both `Note` in the IR. A plan is keyed by the key a `$ref` names,
  // and the object keeps its model.
  const note = { type: 'object', properties: { text: { type: 'string' } } };
  const notes = { type: 'array', items: ref('Note') };
  const paths = { '/notes': getOp('listNotes', ref('Notes')), '/notes/{id}': getOp('getNote', ref('Note')) };

  it.each([
    ['Note first', { Note: note, Notes: notes }],
    ['Notes first', { Notes: notes, Note: note }],
  ])('keeps the object a model and makes the array the list of it, with %s', async (_order, schemas) => {
    const spec = await parse(specDoc(schemas, paths));
    expect(opsOf(spec).getNote.response).toEqual(model('Note'));
    expect(opsOf(spec).listNotes.response).toEqual(array(model('Note')));
    expect(spec.models).toEqual([
      { name: 'Note', description: undefined, fields: [expect.objectContaining({ name: 'text' })] },
    ]);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Note'], ['Notes']);
  });

  it('types a `$ref` by its key when the other key is an enum', async () => {
    const spec = await parse(
      specDoc({
        Notes: { type: 'array', items: { type: 'string' } },
        Note: { type: 'string', enum: ['a'] },
        Holder: { type: 'object', properties: { x: ref('Note'), y: ref('Notes') } },
      }),
    );
    expect(fieldType(spec, 'Holder', 'x')).toEqual({ kind: 'enum', name: 'Note' });
    expect(fieldType(spec, 'Holder', 'y')).toEqual(array(string));
    expect(spec.enums.map((e) => e.name)).toEqual(['Note']);
    expect(warnings()).toEqual([]);
  });

  it.each([
    ['Note first', false],
    ['Notes first', true],
  ])('names the items of two array components resolving to one name apart, with %s', async (_order, reversed) => {
    const entries: Array<[string, unknown]> = [
      ['Note', { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } }],
      ['Notes', { type: 'array', items: { type: 'object', properties: { b: { type: 'string' } } } }],
    ];
    const spec = await parse(
      specDoc({
        Holder: { type: 'object', properties: { x: ref('Note'), y: ref('Notes') } },
        ...Object.fromEntries(reversed ? [...entries].reverse() : entries),
      }),
    );
    // Both trees mint `NoteItem`; `Note`, decided first by key order, steps.
    expect(fieldType(spec, 'Holder', 'x')).toEqual(array(model('NoteItemItem')));
    expect(fieldType(spec, 'Holder', 'y')).toEqual(array(model('NoteItem')));
    expect(spec.models.find((m) => m.name === 'NoteItemItem')?.fields.map((f) => f.name)).toEqual(['a']);
    expect(spec.models.find((m) => m.name === 'NoteItem')?.fields.map((f) => f.name)).toEqual(['b']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder'], ['Note', 'Notes']);
  });
});

describe('an alias of an array component (MichaelDeBoey)', () => {
  const items = { type: 'object', properties: { name: { type: 'string' } } };

  it('resolves a bare `$ref` or an `allOf` of a `$ref` to the array, through aliases of aliases', async () => {
    const spec = await parse(
      specDoc(
        {
          Pets: { type: 'array', items },
          PetsAlias: { allOf: [ref('Pets')] },
          PetsLimited: { allOf: [ref('Pets'), { maxItems: 10 }] },
          PetsRef: ref('Pets'),
          Chain: ref('PetsRef'),
          Holder: {
            type: 'object',
            properties: { a: ref('PetsAlias'), b: ref('PetsLimited'), c: ref('PetsRef'), d: ref('Chain') },
          },
        },
        { '/pets': getOp('listPets', ref('Chain')) },
      ),
    );
    for (const name of ['a', 'b', 'c', 'd']) expect(fieldType(spec, 'Holder', name)).toEqual(array(model('PetsItem')));
    expect(opsOf(spec).listPets.response).toEqual(array(model('PetsItem')));
    expect(spec.models.map((m) => m.name).sort()).toEqual(['Holder', 'PetsItem']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder'], ['Pets', 'PetsAlias', 'PetsLimited', 'PetsRef', 'Chain']);
  });

  it('reads an `allOf` of one member as that member, an array or an alias of one', async () => {
    const spec = await parse(
      specDoc({
        Pets: { type: 'array', items },
        Wrapped: { allOf: [{ type: 'array', items }] },
        WrappedRef: { allOf: [ref('Pets')], description: 'Also pets' },
        Holder: { type: 'object', properties: { w: ref('Wrapped'), r: ref('WrappedRef') } },
      }),
    );
    // The wrapped inline array names its own items; the wrapped `$ref` resolves to `Pets`'s.
    expect(fieldType(spec, 'Holder', 'w')).toEqual(array(model('WrappedItem')));
    expect(fieldType(spec, 'Holder', 'r')).toEqual(array(model('PetsItem')));
    expect(spec.models.map((m) => m.name).sort()).toEqual(['Holder', 'PetsItem', 'WrappedItem']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder'], ['Pets', 'Wrapped', 'WrappedRef']);
  });

  it('leaves an alias of an object component, and an `allOf` that adds properties, the models they were', async () => {
    const spec = await parse(
      specDoc({
        Pets: { type: 'array', items },
        Widget: { type: 'object', properties: { x: { type: 'string' } } },
        WidgetAlias: { allOf: [ref('Widget')] },
        Augmented: { allOf: [ref('Pets'), { type: 'object', properties: { extra: { type: 'string' } } }] },
        Holder: { type: 'object', properties: { w: ref('WidgetAlias'), g: ref('Augmented') } },
      }),
    );
    expect(fieldType(spec, 'Holder', 'w')).toEqual(model('WidgetAlias'));
    expect(fieldType(spec, 'Holder', 'g')).toEqual(model('Augmented'));
    expect(spec.models.find((m) => m.name === 'WidgetAlias')?.fields.map((f) => f.name)).toEqual(['x']);
    expect(spec.models.find((m) => m.name === 'Augmented')?.fields.map((f) => f.name)).toEqual(['extra']);
    expect(warnings()).toEqual([]);
  });

  it('cuts a cycle that runs through an alias', async () => {
    const spec = await parse(
      specDoc({
        Pets: { type: 'array', items: ref('PetsAlias') },
        PetsAlias: { allOf: [ref('Pets')] },
        Holder: { type: 'object', properties: { p: ref('Pets'), a: ref('PetsAlias') } },
      }),
    );
    const unknown: TypeRef = { kind: 'primitive', type: 'unknown' };
    expect(fieldType(spec, 'Holder', 'p')).toEqual(array(unknown));
    expect(fieldType(spec, 'Holder', 'a')).toEqual(array(unknown));
    // Each entry reaches itself through the other, so each warns once, under
    // the key the document writes.
    expect(warnings()).toEqual([
      '[oagen] Warning: Array component "Pets" refers to itself through its items — the inner reference is typed as unknown',
      '[oagen] Warning: Array component "PetsAlias" refers to itself through its items — the inner reference is typed as unknown',
    ]);
  });
});

describe('a name another component’s extraction mints (Greptile round 3)', () => {
  // Claims come from a rehearsal of every pass that extracts a component:
  // the discriminated allOf+oneOf variants, the named-union variants, the
  // field pass, their nested objects and lifted enums.
  const petsOf = (items: unknown) => ({ type: 'array', items });
  const nameItems = { type: 'object', properties: { name: { type: 'string' } } };
  const event = {
    allOf: [
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      {
        oneOf: [
          { type: 'object', properties: { type: { const: 'pets_item' }, value: { type: 'integer' } } },
          { type: 'object', properties: { type: { const: 'other_thing' }, flag: { type: 'boolean' } } },
        ],
      },
    ],
  };
  const holder = (refs: Record<string, string>) => ({
    type: 'object',
    properties: Object.fromEntries(Object.entries(refs).map(([field, target]) => [field, ref(target)])),
  });
  const both = (entries: Array<[string, unknown]>): Array<[string, Array<[string, unknown]>]> => [
    ['as written', entries],
    ['reversed', [...entries].reverse()],
  ];

  it.each(
    both([
      ['Pets', petsOf(nameItems)],
      ['Event', event],
    ]),
  )(
    "steps the items past a discriminated variant named from its const (Greptile's shape), with the document %s",
    async (_order, entries) => {
      const spec = await parse(
        specDoc({ Holder: holder({ pets: 'Pets', event: 'Event' }), ...Object.fromEntries(entries) }),
      );
      expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItemItem')));
      expect(spec.models.find((m) => m.name === 'PetsItemItem')?.fields.map((f) => f.name)).toEqual(['name']);
      // The event's variant keeps its name and its three fields, and dispatches to it.
      expect(spec.models.find((m) => m.name === 'PetsItem')?.fields.map((f) => f.name)).toEqual([
        'id',
        'type',
        'value',
      ]);
      expect(spec.models.find((m) => m.name === 'Event')?.discriminator).toEqual({
        property: 'type',
        mapping: { pets_item: 'PetsItem', other_thing: 'OtherThing' },
      });
      expect(warnings()).toEqual([]);
      expectSound(spec, ['Holder', 'Event', 'PetsItem', 'OtherThing'], ['Pets']);
    },
  );

  it('steps past an object nested under a discriminated variant', async () => {
    // The base member's `owner` is merged into every variant, so the variant
    // `PetsItem` mints `PetsItemOwner` (and the dispatcher `EventOwner`).
    const nestedEvent = {
      allOf: [
        {
          type: 'object',
          properties: { id: { type: 'string' }, owner: { type: 'object', properties: { id: { type: 'integer' } } } },
        },
        { oneOf: [{ type: 'object', properties: { type: { const: 'pets_item' }, value: { type: 'integer' } } }] },
      ],
    };
    const spec = await parse(
      specDoc({
        Holder: holder({ pets: 'Pets', event: 'Event' }),
        Pets: petsOf({ type: 'object', properties: { owner: nameItems } }),
        Event: nestedEvent,
      }),
    );
    // `Pets`'s tree would mint `PetsItem` and `PetsItemOwner`; both are the variant's.
    expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItemItem')));
    expect(fieldType(spec, 'PetsItemItem', 'owner')).toEqual(model('PetsItemItemOwner'));
    expect(fieldType(spec, 'PetsItem', 'owner')).toEqual(model('PetsItemOwner'));
    expect(spec.models.find((m) => m.name === 'PetsItemOwner')?.fields.map((f) => f.name)).toEqual(['id']);
    expect(spec.models.find((m) => m.name === 'PetsItemItemOwner')?.fields.map((f) => f.name)).toEqual(['name']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder', 'Event', 'PetsItem'], ['Pets']);
  });

  it.each(
    both([
      ['Pets', petsOf(nameItems)],
      [
        'Pet',
        { type: 'object', properties: { pets_item: { type: 'object', properties: { id: { type: 'integer' } } } } },
      ],
    ]),
  )('steps past an object a component’s field mints, with the document %s', async (_order, entries) => {
    // `Pet.pets_item` is `PetsItem`: the field name already starts with the parent.
    const spec = await parse(specDoc({ Holder: holder({ pets: 'Pets', pet: 'Pet' }), ...Object.fromEntries(entries) }));
    expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItemItem')));
    expect(fieldType(spec, 'Pet', 'pets_item')).toEqual(model('PetsItem'));
    expect(spec.models.find((m) => m.name === 'PetsItem')?.fields.map((f) => f.name)).toEqual(['id']);
    expect(spec.models.find((m) => m.name === 'PetsItemItem')?.fields.map((f) => f.name)).toEqual(['name']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder', 'Pet'], ['Pets']);
  });

  it.each([
    ['other members', ['x', 'y'], 'PetsItemItem'],
    ['the same members', ['on', 'off'], 'PetsItem'],
  ] as const)('reads an enum a component’s field lifts, of %s', async (_members, members, enumName) => {
    const spec = await parse(
      specDoc({
        Holder: holder({ pets: 'Pets', pet: 'Pet' }),
        Pets: petsOf({ type: 'string', enum: ['on', 'off'] }),
        Pet: { type: 'object', properties: { pets_item: { type: 'string', enum: members } } },
      }),
    );
    expect(fieldType(spec, 'Holder', 'pets')).toEqual(array({ kind: 'enum', name: enumName, values: ['on', 'off'] }));
    expect(fieldType(spec, 'Pet', 'pets_item')).toEqual({ kind: 'enum', name: 'PetsItem', values: members });
    expect(spec.enums.find((e) => e.name === 'PetsItem')?.values.map((v) => v.value)).toEqual(members);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder', 'Pet'], ['Pets']);
  });

  it('steps past what a named union’s `variant_<n>` member mints', async () => {
    // The union's first variant, an array of inline objects, would mint
    // `PetVariant1`; that is the array component's key, so the member steps
    // to `variant_1_item` and mints `PetVariant1Item` — the very name the
    // array component's items would take. The array tree steps in turn.
    const spec = await parse(
      specDoc({
        Holder: holder({ pets: 'PetVariant1', pet: 'Pet' }),
        PetVariant1: petsOf(nameItems),
        Pet: {
          oneOf: [{ type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } }, ref('Cat')],
        },
        Cat: { type: 'object', properties: { meow: { type: 'boolean' } } },
      }),
    );
    expect(spec.models.find((m) => m.name === 'Pet')?.variants).toEqual([
      array(model('PetVariant1Item')),
      model('Cat'),
    ]);
    expect(spec.models.find((m) => m.name === 'PetVariant1Item')?.fields.map((f) => f.name)).toEqual(['id']);
    expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetVariant1ItemItem')));
    expect(spec.models.find((m) => m.name === 'PetVariant1ItemItem')?.fields.map((f) => f.name)).toEqual(['name']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder', 'Pet', 'Cat'], ['PetVariant1']);
  });
});

describe('shapes compared as the real pass types them (Greptile round 4)', () => {
  // `Note` and `Notes` both resolve to `Note`; a rehearsal that typed every
  // `$ref` as a model reference read `{ value: { $ref: Notes } }` and
  // `{ value: { $ref: Note } }` as one shape, shared the name, and the real
  // extraction dropped one of two models with equal field counts.
  const note = { type: 'object', properties: { text: { type: 'string' } } };
  const notes = { type: 'array', items: ref('Note') };
  const holder = { type: 'object', properties: { pets: ref('Pets'), item: ref('PetsItem') } };
  const both = (entries: Array<[string, unknown]>): Array<[string, Array<[string, unknown]>]> => [
    ['as written', entries],
    ['reversed', [...entries].reverse()],
  ];

  it.each(
    both([
      ['Note', note],
      ['Notes', notes],
      ['Pets', { type: 'array', items: { type: 'object', properties: { value: ref('Note') } } }],
      ['PetsItem', { type: 'object', properties: { value: ref('Notes') } }],
    ]),
  )(
    "tells a `$ref` to an array component from one to the object it lists (Greptile's shape), with the document %s",
    async (_order, entries) => {
      const spec = await parse(specDoc({ Holder: holder, ...Object.fromEntries(entries) }));
      expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItemItem')));
      expect(fieldType(spec, 'PetsItemItem', 'value')).toEqual(model('Note'));
      expect(fieldType(spec, 'Holder', 'item')).toEqual(model('PetsItem'));
      expect(fieldType(spec, 'PetsItem', 'value')).toEqual(array(model('Note')));
      expect(spec.models.map((m) => m.name).sort()).toEqual(['Holder', 'Note', 'PetsItem', 'PetsItemItem']);
      expect(warnings()).toEqual([]);
      expectSound(spec, ['Holder', 'Note', 'PetsItem'], ['Notes', 'Pets']);
    },
  );

  it.each(
    both([
      ['Note', note],
      ['Notes', notes],
      [
        'Pets',
        {
          type: 'array',
          items: { type: 'object', properties: { inner: { type: 'object', properties: { value: ref('Note') } } } },
        },
      ],
      ['PetsItem', { type: 'object', properties: { inner: { type: 'object', properties: { value: ref('Notes') } } } }],
    ]),
  )('reads the difference two levels down, with the document %s', async (_order, entries) => {
    // `PetsItem` itself reads alike on both sides (one `inner` field of one
    // name); the nested `PetsItemInner` does not, and the whole tree steps.
    const spec = await parse(specDoc({ Holder: holder, ...Object.fromEntries(entries) }));
    expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItemItem')));
    expect(fieldType(spec, 'PetsItemItem', 'inner')).toEqual(model('PetsItemItemInner'));
    expect(fieldType(spec, 'PetsItemItemInner', 'value')).toEqual(model('Note'));
    expect(fieldType(spec, 'PetsItem', 'inner')).toEqual(model('PetsItemInner'));
    expect(fieldType(spec, 'PetsItemInner', 'value')).toEqual(array(model('Note')));
    expect(spec.models.map((m) => m.name).sort()).toEqual([
      'Holder',
      'Note',
      'PetsItem',
      'PetsItemInner',
      'PetsItemItem',
      'PetsItemItemInner',
    ]);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder', 'Note', 'PetsItem'], ['Notes', 'Pets']);
  });

  it('shares a component whose field is the same `$ref` to an array component', async () => {
    const spec = await parse(
      specDoc({
        Holder: holder,
        Note: note,
        Notes: notes,
        Pets: { type: 'array', items: { type: 'object', properties: { value: ref('Notes') } } },
        PetsItem: { type: 'object', properties: { value: ref('Notes') } },
      }),
    );
    expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItem')));
    expect(fieldType(spec, 'PetsItem', 'value')).toEqual(array(model('Note')));
    expect(spec.models.map((m) => m.name).sort()).toEqual(['Holder', 'Note', 'PetsItem']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder', 'Note', 'PetsItem'], ['Notes', 'Pets']);
  });

  it('never counts the enum another component’s items hold as the tree’s own, so a contested tree steps once', async () => {
    const spec = await parse(
      specDoc({
        Holder: { type: 'object', properties: { pets: ref('Pets'), o: ref('PetsItemOwner') } },
        Colors: { type: 'array', items: { type: 'string', enum: ['red', 'green'] } },
        Pets: {
          type: 'array',
          items: {
            type: 'object',
            properties: { colors: ref('Colors'), owner: { type: 'object', properties: { name: { type: 'string' } } } },
          },
        },
        PetsItemOwner: { type: 'object', properties: { id: { type: 'integer' } } },
      }),
    );
    // Were `ColorItem` read as `Pets`'s own, no candidate context could free
    // it and the tree would run to the attempt cap instead of `item_item`.
    expect(fieldType(spec, 'Holder', 'pets')).toEqual(array(model('PetsItemItem')));
    expect(fieldType(spec, 'PetsItemItem', 'colors')).toEqual(
      array({ kind: 'enum', name: 'ColorItem', values: ['red', 'green'] }),
    );
    expect(fieldType(spec, 'PetsItemItem', 'owner')).toEqual(model('PetsItemItemOwner'));
    expect(spec.enums.map((e) => e.name)).toEqual(['ColorItem']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder', 'PetsItemOwner'], ['Colors', 'Pets']);
  });
});

describe('two keys that resolve to one name with different shapes', () => {
  it('keeps one definition and says so, rather than dropping the other silently', async () => {
    const spec = await parse(
      specDoc({
        Note: { type: 'object', properties: { a: { type: 'string' } } },
        note: { type: 'object', properties: { b: { type: 'integer' } } },
        Holder: { type: 'object', properties: { n: ref('Note') } },
      }),
    );
    expect(spec.models.find((m) => m.name === 'Note')?.fields.map((f) => f.name)).toEqual(['a']);
    expect(warnings()).toEqual([
      '[oagen] Warning: Model "Note" has more than one definition under components/schemas with different fields or field types (1 vs 1) — keeping the first definition',
    ]);
  });

  it('stays silent when the two definitions agree', async () => {
    const spec = await parse(
      specDoc({
        Note: { type: 'object', properties: { a: { type: 'string' } } },
        note: { type: 'object', properties: { a: { type: 'string' } } },
        Holder: { type: 'object', properties: { n: ref('Note') } },
      }),
    );
    expect(spec.models.filter((m) => m.name === 'Note')).toHaveLength(1);
    expect(warnings()).toEqual([]);
  });
});

describe('a name an operation mints too (MichaelDeBoey)', () => {
  // A component `ListPets` names its items `ListPetsItem`, exactly as
  // `operationId: listPets` names an inline array response's items. The
  // component's name is settled first, and the operation's items are
  // settled against the spec-wide registry of model shapes (#333): a name a
  // component-pass model owns with another shape sends them to
  // `<Op>ResponseItem`; an identical shape shares the model.
  const component = {
    ListPets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
    Holder: { type: 'object', properties: { l: ref('ListPets') } },
  };
  const listPets = (items: unknown) => ({ '/pets': getOp('listPets', { type: 'array', items }) });

  it('steps the operation’s items past the component’s when the shapes differ', async () => {
    const spec = await parse(specDoc(component, listPets({ type: 'object', properties: { id: { type: 'string' } } })));
    expect(opsOf(spec).listPets.response).toEqual(array(model('ListPetsResponseItem')));
    expect(fieldType(spec, 'Holder', 'l')).toEqual(array(model('ListPetsItem')));
    expect(spec.models.find((m) => m.name === 'ListPetsItem')?.fields.map((f) => f.name)).toEqual(['name']);
    expect(spec.models.find((m) => m.name === 'ListPetsResponseItem')?.fields.map((f) => f.name)).toEqual(['id']);
    expect(warnings()).toEqual([]);
    expectSound(spec, ['Holder'], ['ListPets']);
  });

  it('shares one model when the shapes agree', async () => {
    const spec = await parse(
      specDoc(component, listPets({ type: 'object', properties: { name: { type: 'string' } } })),
    );
    expect(opsOf(spec).listPets.response).toEqual(array(model('ListPetsItem')));
    expect(spec.models.map((m) => m.name).sort()).toEqual(['Holder', 'ListPetsItem']);
    expect(warnings()).toEqual([]);
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
