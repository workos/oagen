import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
import { collectModelRefs, collectResponseBodyTypes, collectResponseHeaders } from '../../src/ir/types.js';
import type { ApiSpec, Enum, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #305: the `<Name>Json` fold compared the models it would collapse by
 * name alone. A `<Name>Json…` child whose folded name a model already held
 * — a union variant such as `PetJsonWithA` beside `PetWithA`, or a nested
 * object such as `PetJsonToy` beside `PetToy` — was collapsed onto that
 * model whatever its fields, so a field the child added was lost. Now every
 * such child must be admitted by the model that takes its name
 * (`modelAdmits`, every reference read under the fold), a field both models
 * declare must be one the `<Name>Json` model's admits (`fieldAdmits`), and
 * otherwise the `<Name>Json` model is not folded at all: both are kept, with
 * a warning.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-json-suffix-fold-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** The issue's document: `GET /pets` returning `Pet` and `GET /pets/json` returning `PetJson`, around `schemas`. */
const petsDoc = (schemas: Record<string, unknown>) => ({
  openapi: '3.1.0',
  info: { title: 'pets', version: '1' },
  paths: {
    '/pets': {
      get: {
        operationId: 'getPet',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
        },
      },
    },
    '/pets/json': {
      get: {
        operationId: 'getPetJson',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PetJson' } } },
          },
        },
      },
    },
  },
  components: { schemas },
});

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties });

/** The issue's projection of a model: `name {fields} [variants]`. */
const describeModels = (spec: ApiSpec): string[] =>
  spec.models.map(
    ({ fields, name, variants }) =>
      `${name} {${fields.map((f) => f.name)}}${variants ? ` [${variants.map((v) => ('name' in v ? v.name : 'type' in v ? String(v.type) : v.kind))}]` : ''}`,
  );

/** The issue's projection of the operations: `name: response model`. */
const describeResponses = (spec: ApiSpec): string[] =>
  spec.services
    .flatMap(({ operations }) => operations)
    .map(({ name, response }) => `${name}: ${response.kind === 'model' ? response.name : response.kind}`);

/** Every model reference — from operations, model fields, variants and mapping targets — that names no model. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const names = new Set(spec.models.map((m) => m.name));
  const found: string[] = [];
  const check = (owner: string, ref: TypeRef): void => {
    for (const name of collectModelRefs(ref)) if (!names.has(name)) found.push(`${owner} → ${name}`);
  };
  for (const op of spec.services.flatMap((s) => s.operations)) {
    check(`${op.name}.response`, op.response);
    if (op.requestBody) check(`${op.name}.requestBody`, op.requestBody);
    for (const { source, type } of collectResponseBodyTypes(op)) check(`${op.name}.${source}`, type);
    for (const h of collectResponseHeaders(op)) check(`${op.name}.${h.name}`, h.type);
  }
  for (const model of spec.models) {
    for (const field of model.fields) check(`${model.name}.${field.name}`, field.type);
    for (const variant of model.variants ?? []) check(`${model.name}.variants`, variant);
    for (const target of Object.values(model.discriminator?.mapping ?? {})) {
      if (!names.has(target)) found.push(`${model.name}.discriminator → ${target}`);
    }
  }
  return found.sort();
}

/** Every model that is neither a component nor referenced by an operation, a field, a variant or a mapping. */
function orphanedModels(spec: ApiSpec, componentNames: string[]): string[] {
  const referenced = new Set<string>();
  for (const op of spec.services.flatMap((s) => s.operations)) {
    for (const name of collectModelRefs(op.response)) referenced.add(name);
    if (op.requestBody) for (const name of collectModelRefs(op.requestBody)) referenced.add(name);
    for (const { type } of collectResponseBodyTypes(op))
      for (const name of collectModelRefs(type)) referenced.add(name);
  }
  for (const model of spec.models) {
    for (const field of model.fields) for (const name of collectModelRefs(field.type)) referenced.add(name);
    for (const variant of model.variants ?? []) for (const name of collectModelRefs(variant)) referenced.add(name);
    for (const target of Object.values(model.discriminator?.mapping ?? {})) referenced.add(target);
  }
  return spec.models
    .map((m) => m.name)
    .filter((name) => !componentNames.includes(name) && !referenced.has(name))
    .sort();
}

/** Parse `doc`, returning the IR with every warning the parser printed. */
async function parseWithWarnings(name: string, doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const file = await writeSpec(name, doc);
  const warnings: string[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  try {
    return { spec: await parseSpec(file), warnings };
  } finally {
    warn.mockRestore();
  }
}

/** Every model name a model references: its fields, its variants and its mapping targets. */
function referencedBy(model: Model): string[] {
  const names: string[] = [];
  for (const field of model.fields) names.push(...collectModelRefs(field.type));
  for (const variant of model.variants ?? []) names.push(...collectModelRefs(variant));
  names.push(...Object.values(model.discriminator?.mapping ?? {}));
  return names;
}

/**
 * Run `collapseJsonSuffixModels` over `models`, returning the kept models
 * and every warning, and hold the pass to its invariant: afterwards every
 * model reference names a kept model, and every kept model that was
 * referenced before the pass is still referenced, and no two kept models
 * share a name — a fold never leaves a reference dangling, a model it does
 * not fold unreferenced, or two models under one name.
 */
function collapse(models: Model[]): { kept: Model[]; warnings: string[] } {
  const referencedBefore = new Set(models.flatMap(referencedBy));
  const warnings: string[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  let kept: Model[];
  try {
    kept = collapseJsonSuffixModels(models, []);
  } finally {
    warn.mockRestore();
  }
  const names = new Set(kept.map((m) => m.name));
  const referencedAfter = new Set(kept.flatMap(referencedBy));
  expect(
    [...referencedAfter].filter((name) => !names.has(name)),
    'dangling references',
  ).toEqual([]);
  expect(
    kept.map((m) => m.name).filter((name) => referencedBefore.has(name) && !referencedAfter.has(name)),
    'models left unreferenced',
  ).toEqual([]);
  expect(names.size, 'duplicate names').toBe(kept.length);
  return { kept, warnings };
}

const modelRef = (name: string): TypeRef => ({ kind: 'model', name });
/** A model as `name {field,ref:Model,…}`, in field order. */
const describeFolded = (kept: Model[]): string[] =>
  kept.map((m) => `${m.name} {${m.fields.map((f) => `${f.name}${f.type.kind === 'model' ? `:${f.type.name}` : ''}`)}}`);
const string: TypeRef = { kind: 'primitive', type: 'string' };
const integer: TypeRef = { kind: 'primitive', type: 'integer' };
const field = (name: string, type: TypeRef = string, required = false): Model['fields'][number] => ({
  name,
  type,
  required,
});

describe('`<Name>Json` fold — folded children (issue #305)', () => {
  it('keeps a `…Json` union whose variant model adds a field: a variant of another shape is a different variant', async () => {
    // The issue's repro: `Pet: oneOf [{ a }, string]` beside `PetJson: oneOf [{ a, b }, string]`.
    // The variants read alike under the fold (`PetJsonWithA` → `PetWithA`), but `PetWithA`
    // has only `a`, so collapsing `PetJsonWithA` onto it would drop `b` from `getPetJson`.
    const { spec, warnings } = await parseWithWarnings(
      'union.json',
      petsDoc({
        Pet: { oneOf: [obj({ a: str }), str] },
        PetJson: { oneOf: [obj({ a: str, b: str }), str] },
      }),
    );
    expect(warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the union rules of "Pet" — keeping both',
    ]);
    expect(describeModels(spec)).toEqual([
      'Pet {a} [PetWithA,string]',
      'PetWithA {a}',
      'PetJson {a,b} [PetJsonWithA,string]',
      'PetJsonWithA {a,b}',
    ]);
    expect(describeResponses(spec)).toEqual(['getPet: Pet', 'getPetJson: PetJson']);
    expect(unresolvedReferences(spec)).toEqual([]);
    expect(orphanedModels(spec, ['Pet', 'PetJson'])).toEqual([]);
  });

  it('keeps a `…Json` object whose nested object adds a field', async () => {
    // The issue's second repro, which predates the union guard: `Pet { toy: { a } }` beside
    // `PetJson { c, toy: { a, b } }`. `PetJsonToy` would collapse onto `PetToy`, losing `b`.
    const { spec, warnings } = await parseWithWarnings(
      'object.json',
      petsDoc({
        Pet: obj({ toy: obj({ a: str }) }),
        PetJson: obj({ c: str, toy: obj({ a: str, b: str }) }),
      }),
    );
    expect(warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": "PetJsonToy" would fold onto "PetToy", which has a different shape — keeping both',
    ]);
    expect(describeModels(spec)).toEqual(['Pet {toy}', 'PetJson {c,toy}', 'PetJsonToy {a,b}', 'PetToy {a}']);
    expect(describeResponses(spec)).toEqual(['getPet: Pet', 'getPetJson: PetJson']);
    expect(unresolvedReferences(spec)).toEqual([]);
    expect(orphanedModels(spec, ['Pet', 'PetJson'])).toEqual([]);
  });

  it('still folds a `…Json` object whose nested object is admitted by the one that takes its name', async () => {
    const { spec, warnings } = await parseWithWarnings(
      'admitted.json',
      petsDoc({
        Pet: obj({ toy: obj({ a: str }) }),
        PetJson: obj({ c: str, toy: obj({ a: str }) }),
      }),
    );
    expect(warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (2 fields, superset)',
      '[oagen] Collapsed child "PetJsonToy" into existing "PetToy"',
    ]);
    expect(describeModels(spec)).toEqual(['Pet {c,toy}', 'PetToy {a}']);
    expect(describeResponses(spec)).toEqual(['getPet: Pet', 'getPetJson: Pet']);
    expect(unresolvedReferences(spec)).toEqual([]);
    expect(orphanedModels(spec, ['Pet'])).toEqual([]);
  });

  it('collapses a `<Json>…` child onto its namesake only when that model admits it, references read under the fold', () => {
    // `PetJsonWithName` references `PetJsonInner`, which the fold renames to `PetInner`: the
    // child compares as the fold leaves it, so both collapse onto their namesakes.
    const models = (): Model[] => [
      { name: 'Pet', fields: [field('name')], variants: [modelRef('PetWithName')], compositionKind: 'oneOf' },
      { name: 'PetWithName', fields: [field('name'), field('inner', modelRef('PetInner'))] },
      { name: 'PetInner', fields: [field('x')] },
      {
        name: 'PetJson',
        fields: [field('name'), field('tag')],
        variants: [modelRef('PetJsonWithName')],
        compositionKind: 'oneOf',
      },
      { name: 'PetJsonWithName', fields: [field('name'), field('inner', modelRef('PetJsonInner'))] },
      { name: 'PetJsonInner', fields: [field('x')] },
    ];

    const folded = collapse(models());
    expect(folded.kept.map((m) => m.name)).toEqual(['Pet', 'PetWithName', 'PetInner']);
    expect(folded.kept[0]?.fields.map((f) => f.name)).toEqual(['name', 'tag']);
    expect(folded.kept[0]?.variants).toEqual([modelRef('PetWithName')]);
    expect(folded.kept[1]?.fields[1]?.type).toEqual(modelRef('PetInner'));
    expect(folded.warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (2 fields, superset)',
      '[oagen] Collapsed child "PetJsonWithName" into existing "PetWithName"',
      '[oagen] Collapsed child "PetJsonInner" into existing "PetInner"',
    ]);

    // A nested child of another shape refuses the fold: `PetInner` is no variant of `Pet`, so
    // the warning names the shape.
    const retypedInner = models();
    retypedInner[5] = { name: 'PetJsonInner', fields: [field('x', integer)] };
    const refusedInner = collapse(retypedInner);
    expect(refusedInner.kept.map((m) => m.name)).toEqual(retypedInner.map((m) => m.name));
    expect(refusedInner.warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": "PetJsonInner" would fold onto "PetInner", which has a different shape — keeping both',
    ]);

    // The model that takes the name may be looser than the child, never stricter.
    const looserOwner = models();
    looserOwner[4] = {
      name: 'PetJsonWithName',
      fields: [field('name', string, true), field('inner', modelRef('PetJsonInner'))],
    };
    expect(collapse(looserOwner).kept.map((m) => m.name)).toEqual(['Pet', 'PetWithName', 'PetInner']);
    const stricterOwner = models();
    stricterOwner[1] = {
      name: 'PetWithName',
      fields: [field('name', string, true), field('inner', modelRef('PetInner'))],
    };
    const refusedVariant = collapse(stricterOwner);
    expect(refusedVariant.kept.map((m) => m.name)).toEqual(stricterOwner.map((m) => m.name));
    expect(refusedVariant.warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the union rules of "Pet" — keeping both',
    ]);

    // Nothing collapses by name alone, and nothing is renamed by it: a model merely spelled
    // `<Json>…` that the `…Json` model never reaches is no child of the fold (#426), so it keeps
    // its name and has no say in whether the fold goes ahead.
    const stranger = [
      ...models(),
      { name: 'PetJsonExtra', fields: [field('z')] },
      { name: 'PetExtra', fields: [field('y')] },
    ];
    const strangerKept = collapse(stranger);
    expect(describeFolded(strangerKept.kept)).toEqual([
      'Pet {name,tag}',
      'PetWithName {name,inner:PetInner}',
      'PetInner {x}',
      'PetJsonExtra {z}',
      'PetExtra {y}',
    ]);
    expect(strangerKept.warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (2 fields, superset)',
      '[oagen] Collapsed child "PetJsonWithName" into existing "PetWithName"',
      '[oagen] Collapsed child "PetJsonInner" into existing "PetInner"',
    ]);
  });

  it("reads a discriminator mapping's targets under the fold, as the fold renames them", () => {
    // An allOf+oneOf dispatcher with no fields beside a `…Json` dispatcher whose mapping names
    // `PetJsonA`: pass 3 renames it to `PetA`, so the rules agree under the fold and the base
    // keeps dispatching to `PetA`, which admits `PetJsonA`.
    const models: Model[] = [
      {
        name: 'Pet',
        fields: [],
        variants: [modelRef('PetA')],
        compositionKind: 'oneOf',
        discriminator: { property: 'kind', mapping: { a: 'PetA' } },
      },
      { name: 'PetA', fields: [field('kind')] },
      {
        name: 'PetJson',
        fields: [field('kind')],
        variants: [modelRef('PetJsonA')],
        compositionKind: 'oneOf',
        discriminator: { property: 'kind', mapping: { a: 'PetJsonA' } },
      },
      { name: 'PetJsonA', fields: [field('kind')] },
    ];
    const { kept, warnings } = collapse(models);
    expect(kept.map((m) => m.name)).toEqual(['Pet', 'PetA']);
    expect(kept[0]?.variants).toEqual([modelRef('PetA')]);
    expect(kept[0]?.discriminator).toEqual({ property: 'kind', mapping: { a: 'PetA' } });
    expect(warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (1 fields, superset)',
      '[oagen] Collapsed child "PetJsonA" into existing "PetA"',
    ]);
  });

  it('refuses a `…Json` model whose shared field has another shape, since the base takes its fields', () => {
    const widget = (id: Model['fields'][number]): Model => ({ name: 'Widget', fields: [id] });
    const widgetJson = (id: Model['fields'][number]): Model => ({ name: 'WidgetJson', fields: [id, field('name')] });

    const retyped = collapse([widget(field('id')), widgetJson(field('id', integer))]);
    expect(retyped.kept.map((m) => m.name)).toEqual(['Widget', 'WidgetJson']);
    expect(retyped.kept[0]?.fields).toEqual([field('id')]);
    expect(retyped.warnings).toEqual([
      '[oagen] Warning: Json-suffix model "WidgetJson" does not preserve the shape of "Widget": field "id" has a different shape — keeping both',
    ]);

    // The `…Json` model may be looser than the base on requiredness, never stricter.
    const stricter = collapse([widget(field('id')), widgetJson(field('id', string, true))]);
    expect(stricter.kept.map((m) => m.name)).toEqual(['Widget', 'WidgetJson']);
    expect(stricter.warnings).toEqual([
      '[oagen] Warning: Json-suffix model "WidgetJson" does not preserve the shape of "Widget": field "id" has a different shape — keeping both',
    ]);
    const looser = collapse([widget(field('id', string, true)), widgetJson(field('id'))]);
    expect(looser.kept.map((m) => m.name)).toEqual(['Widget']);
    expect(looser.kept[0]?.fields.map((f) => `${f.name}${f.required ? '!' : ''}`)).toEqual(['id', 'name']);

    // A shared field typed by a `<Json>…` child is read under the fold, so it matches the
    // base's field typed by the child's namesake.
    const nested = collapse([
      { name: 'Widget', fields: [field('part', modelRef('WidgetPart'))] },
      { name: 'WidgetPart', fields: [field('x')] },
      { name: 'WidgetJson', fields: [field('part', modelRef('WidgetJsonPart')), field('name')] },
      { name: 'WidgetJsonPart', fields: [field('x')] },
    ]);
    expect(nested.kept.map((m) => m.name)).toEqual(['Widget', 'WidgetPart']);
    expect(nested.kept[0]?.fields.map((f) => f.name)).toEqual(['part', 'name']);
    expect(nested.kept[0]?.fields[0]?.type).toEqual(modelRef('WidgetPart'));
  });
  it('refuses two folds whose children would end under one name with different shapes, in either order (Greptile)', () => {
    // Two prefixes nest: `PetJsonFooBar` (a child of `PetJson`) and `PetFooJsonBar` (a child of
    // `PetFooJson`) both end under `PetFooBar`, and their `inner` children under `PetFooBarInner`.
    // The `inner` pair reads alike at the top but `{ x }` and `{ y }` are not one shape, so the two
    // folds refuse each other and nothing is written — the same in both declaration orders.
    const models = (): Model[] => [
      { name: 'Pet', fields: [field('a')] },
      { name: 'PetJson', fields: [field('a'), field('b'), field('fooBar', modelRef('PetJsonFooBar'))] },
      { name: 'PetJsonFooBar', fields: [field('inner', modelRef('PetJsonFooBarInner'))] },
      { name: 'PetJsonFooBarInner', fields: [field('x')] },
      { name: 'PetFoo', fields: [field('c')] },
      { name: 'PetFooJson', fields: [field('c'), field('d'), field('bar', modelRef('PetFooJsonBar'))] },
      { name: 'PetFooJsonBar', fields: [field('inner', modelRef('PetFooJsonBarInner'))] },
      { name: 'PetFooJsonBarInner', fields: [field('y')] },
    ];
    const warningsOf = {
      pet: '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": "PetJsonFooBarInner" would fold onto "PetFooBarInner" beside "PetFooJsonBarInner", which has a different shape — keeping both',
      petFoo:
        '[oagen] Warning: Json-suffix model "PetFooJson" does not preserve the shape of "PetFoo": "PetFooJsonBarInner" would fold onto "PetFooBarInner" beside "PetJsonFooBarInner", which has a different shape — keeping both',
    };

    const { kept, warnings } = collapse(models());
    expect(describeFolded(kept)).toEqual(describeFolded(models()));
    expect(warnings).toEqual([warningsOf.pet, warningsOf.petFoo]);

    // The mirror: declared the other way round, the same two refusals.
    const mirrored = collapse([...models().slice(4), ...models().slice(0, 4)]);
    expect(describeFolded(mirrored.kept)).toEqual(describeFolded([...models().slice(4), ...models().slice(0, 4)]));
    expect(mirrored.warnings).toEqual([warningsOf.petFoo, warningsOf.pet]);

    // Three levels down the same: the mismatch is read through two parents that read alike.
    const deep = (): Model[] =>
      models().flatMap((m) => {
        if (m.name === 'PetJsonFooBarInner') {
          return [
            { ...m, fields: [field('deep', modelRef('PetJsonFooBarInnerDeep'))] },
            { name: 'PetJsonFooBarInnerDeep', fields: [field('x')] },
          ];
        }
        if (m.name === 'PetFooJsonBarInner') {
          return [
            { ...m, fields: [field('deep', modelRef('PetFooJsonBarInnerDeep'))] },
            { name: 'PetFooJsonBarInnerDeep', fields: [field('y')] },
          ];
        }
        return [m];
      });
    const threeLevels = collapse(deep());
    expect(describeFolded(threeLevels.kept)).toEqual(describeFolded(deep()));
    expect(threeLevels.warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": "PetJsonFooBarInnerDeep" would fold onto "PetFooBarInnerDeep" beside "PetFooJsonBarInnerDeep", which has a different shape — keeping both',
      '[oagen] Warning: Json-suffix model "PetFooJson" does not preserve the shape of "PetFoo": "PetFooJsonBarInnerDeep" would fold onto "PetFooBarInnerDeep" beside "PetJsonFooBarInnerDeep", which has a different shape — keeping both',
    ]);

    // The same subtree of one shape: both fold, the first declared keeps each name and the
    // other collapses onto it.
    const same = models().map((m) => (m.name === 'PetFooJsonBarInner' ? { ...m, fields: [field('x')] } : m));
    const folded = collapse(same);
    expect(describeFolded(folded.kept)).toEqual([
      'Pet {a,b,fooBar:PetFooBar}',
      'PetFooBar {inner:PetFooBarInner}',
      'PetFooBarInner {x}',
      'PetFoo {c,d,bar:PetFooBar}',
    ]);
    expect(folded.warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (3 fields, superset)',
      '[oagen] Renamed child "PetJsonFooBar" → "PetFooBar"',
      '[oagen] Renamed child "PetJsonFooBarInner" → "PetFooBarInner"',
      '[oagen] Merged "PetFooJson" into "PetFoo" (3 fields, superset)',
      '[oagen] Collapsed child "PetFooJsonBar" into existing "PetFooBar"',
      '[oagen] Collapsed child "PetFooJsonBarInner" into existing "PetFooBarInner"',
    ]);
  });

  it('reads a child that folds to a name another child vacates as ending under that child’s name (Greptile)', () => {
    // `PetJsonJsonThing` folds to `PetJsonThing`, the name `PetJsonThing` holds and vacates for
    // `PetThing` in the same fold: both end under `PetThing`, so they must be one shape, and the
    // first declared keeps the name — in either document order of the two children.
    const models = (first: 'thing' | 'jsonThing', jsonThingField: Model['fields'][number] = field('x')): Model[] => {
      const thing: Model = { name: 'PetJsonThing', fields: [field('x')] };
      const jsonThing: Model = { name: 'PetJsonJsonThing', fields: [jsonThingField] };
      return [
        { name: 'Pet', fields: [field('a')] },
        {
          name: 'PetJson',
          fields: [
            field('a'),
            field('b'),
            field('thing', modelRef('PetJsonThing')),
            field('jsonThing', modelRef('PetJsonJsonThing')),
          ],
        },
        ...(first === 'thing' ? [thing, jsonThing] : [jsonThing, thing]),
      ];
    };

    const thingFirst = collapse(models('thing'));
    expect(describeFolded(thingFirst.kept)).toEqual(['Pet {a,b,thing:PetThing,jsonThing:PetThing}', 'PetThing {x}']);
    expect(thingFirst.warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (4 fields, superset)',
      '[oagen] Renamed child "PetJsonThing" → "PetThing"',
      '[oagen] Collapsed child "PetJsonJsonThing" into existing "PetThing"',
    ]);

    const jsonThingFirst = collapse(models('jsonThing'));
    expect(describeFolded(jsonThingFirst.kept)).toEqual([
      'Pet {a,b,thing:PetThing,jsonThing:PetThing}',
      'PetThing {x}',
    ]);
    expect(jsonThingFirst.warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (4 fields, superset)',
      '[oagen] Renamed child "PetJsonJsonThing" → "PetThing"',
      '[oagen] Collapsed child "PetJsonThing" into existing "PetThing"',
    ]);

    // Two shapes under one name refuse the fold, as any pair that ends under one name does.
    const refused = collapse(models('thing', field('y')));
    expect(refused.kept.map((m) => m.name)).toEqual(['Pet', 'PetJson', 'PetJsonThing', 'PetJsonJsonThing']);
    expect(refused.warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": "PetJsonThing" would fold onto "PetThing" beside "PetJsonJsonThing", which has a different shape — keeping both',
    ]);
  });

  it('collapses a child onto a component that vacates its folded name, through parseSpec', async () => {
    // `PetJsonThing` is a component the fold renames to `PetThing`; the inline object of
    // `PetJson.jsonThing` is named `PetJsonJsonThing` and ends under `PetThing` too.
    const { spec, warnings } = await parseWithWarnings(
      'vacated-component.json',
      petsDoc({
        Pet: obj({ a: str }),
        PetJson: obj({
          a: str,
          b: str,
          thing: { $ref: '#/components/schemas/PetJsonThing' },
          jsonThing: obj({ x: str }),
        }),
        PetJsonThing: obj({ x: str }),
      }),
    );
    expect(warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (4 fields, superset)',
      '[oagen] Renamed child "PetJsonThing" → "PetThing"',
      '[oagen] Collapsed child "PetJsonJsonThing" into existing "PetThing"',
    ]);
    expect(describeModels(spec)).toEqual(['Pet {a,b,thing,jsonThing}', 'PetThing {x}']);
    const pet = spec.models.find((m) => m.name === 'Pet');
    expect(pet?.fields.find((f) => f.name === 'thing')?.type).toEqual(modelRef('PetThing'));
    expect(pet?.fields.find((f) => f.name === 'jsonThing')?.type).toEqual(modelRef('PetThing'));
    expect(describeResponses(spec)).toEqual(['getPet: Pet', 'getPetJson: Pet']);
    expect(unresolvedReferences(spec)).toEqual([]);
    expect(orphanedModels(spec, ['Pet'])).toEqual([]);
  });

  it('folds a `…Json` model an earlier fold renamed, reading its names as that fold left them (MichaelDeBoey)', () => {
    // `NoteJsonPetJson` folds onto `NoteJsonPet`, and both are children of `NoteJson`, which
    // folds onto `Note`: `NoteJsonPetJsonToy` is read as `NotePetToy` under both folds, so the
    // identical `…Toy { inner }` / `…ToyInner { x }` subtrees collapse — whichever pair the
    // document declares first.
    const models = (): Model[] => [
      { name: 'Note', fields: [field('a')] },
      { name: 'NoteJson', fields: [field('a'), field('b'), field('pet', modelRef('NoteJsonPet'))] },
      { name: 'NoteJsonPet', fields: [field('c'), field('toy', modelRef('NoteJsonPetToy'))] },
      { name: 'NoteJsonPetToy', fields: [field('inner', modelRef('NoteJsonPetToyInner'))] },
      { name: 'NoteJsonPetToyInner', fields: [field('x')] },
      { name: 'NoteJsonPetJson', fields: [field('c'), field('d'), field('toy', modelRef('NoteJsonPetJsonToy'))] },
      { name: 'NoteJsonPetJsonToy', fields: [field('inner', modelRef('NoteJsonPetJsonToyInner'))] },
      { name: 'NoteJsonPetJsonToyInner', fields: [field('x')] },
    ];
    const expected = [
      'Note {a,b,pet:NotePet}',
      'NotePet {c,d,toy:NotePetToy}',
      'NotePetToy {inner:NotePetToyInner}',
      'NotePetToyInner {x}',
    ];

    const noteFirst = collapse(models());
    expect(describeFolded(noteFirst.kept)).toEqual(expected);
    expect(noteFirst.warnings).toEqual([
      '[oagen] Merged "NoteJson" into "Note" (3 fields, superset)',
      '[oagen] Renamed child "NoteJsonPet" → "NotePet"',
      '[oagen] Renamed child "NoteJsonPetToy" → "NotePetToy"',
      '[oagen] Renamed child "NoteJsonPetToyInner" → "NotePetToyInner"',
      '[oagen] Merged "NoteJsonPetJson" into "NotePet" (3 fields, superset)',
      '[oagen] Collapsed child "NoteJsonPetJsonToy" into existing "NotePetToy"',
      '[oagen] Collapsed child "NoteJsonPetJsonToyInner" into existing "NotePetToyInner"',
    ]);

    const petFirst = collapse([...models().slice(2), ...models().slice(0, 2)]);
    expect([...describeFolded(petFirst.kept)].sort()).toEqual([...expected].sort());
    expect(petFirst.warnings.filter((w) => w.startsWith('[oagen] Merged '))).toEqual([
      '[oagen] Merged "NoteJsonPetJson" into "NotePet" (3 fields, superset)',
      '[oagen] Merged "NoteJson" into "Note" (3 fields, superset)',
    ]);
  });

  it('reads an inline enum under the fold: the same members fold under the base’s enum, other members refuse (MichaelDeBoey)', () => {
    const inlineEnum = (name: string, values: string[] = ['on', 'off']): TypeRef => ({ kind: 'enum', name, values });
    const pet = (status: TypeRef): Model => ({ name: 'Pet', fields: [field('a'), field('status', status)] });
    const petJson = (status: TypeRef, extra: Model['fields'] = []): Model => ({
      name: 'PetJson',
      fields: [field('a'), field('b'), field('status', status), ...extra],
    });

    // `PetJsonStatus` with the members of `PetStatus` reads as `PetStatus`: the fold goes ahead
    // and `Pet.status` keeps the base's own enum name; an enum on a field only the Json model
    // declares, or under a child, is renamed with its model.
    const same = collapse([
      pet(inlineEnum('PetStatus')),
      petJson(inlineEnum('PetJsonStatus'), [
        field('mode', inlineEnum('PetJsonMode', ['a', 'b'])),
        field('toy', modelRef('PetJsonToy')),
      ]),
      { name: 'PetJsonToy', fields: [field('kind', inlineEnum('PetJsonToyKind', ['k']))] },
    ]);
    expect(same.kept.map((m) => m.name)).toEqual(['Pet', 'PetToy']);
    expect(
      same.kept[0]?.fields.map((f) => `${f.name}${f.type.kind === 'enum' ? `:${f.type.name}[${f.type.values}]` : ''}`),
    ).toEqual(['a', 'b', 'status:PetStatus[on,off]', 'mode:PetMode[a,b]', 'toy']);
    expect(same.kept[1]?.fields[0]?.type).toEqual(inlineEnum('PetToyKind', ['k']));
    expect(same.warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (5 fields, superset)',
      '[oagen] Renamed child "PetJsonToy" → "PetToy"',
    ]);

    // Other members are another shape: the base keeps the values its operations accept.
    const other = collapse([pet(inlineEnum('PetStatus')), petJson(inlineEnum('PetJsonStatus', ['on', 'off', 'idle']))]);
    expect(other.kept.map((m) => m.name)).toEqual(['Pet', 'PetJson']);
    expect(other.warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": field "status" has a different shape — keeping both',
    ]);

    // Given the enums the component pass lifted, the fold drops the entry its rename left
    // unreferenced, so one `PetStatus` remains; an entry named by the document stays.
    const lifted = (): Enum[] => [
      {
        name: 'PetStatus',
        values: [
          { name: 'ON', value: 'on' },
          { name: 'OFF', value: 'off' },
        ],
      },
      {
        name: 'PetJsonStatus',
        values: [
          { name: 'ON', value: 'on' },
          { name: 'OFF', value: 'off' },
        ],
      },
    ];
    const dropped = lifted();
    collapseJsonSuffixModels(
      [pet(inlineEnum('PetStatus')), petJson(inlineEnum('PetJsonStatus'))],
      [],
      [],
      dropped,
      new Set(),
    );
    expect(dropped.map((e) => e.name)).toEqual(['PetStatus']);
    const declared = lifted();
    collapseJsonSuffixModels(
      [pet(inlineEnum('PetStatus')), petJson(inlineEnum('PetJsonStatus'))],
      [],
      [],
      declared,
      new Set(['PetJsonStatus']),
    );
    expect(declared.map((e) => e.name)).toEqual(['PetStatus', 'PetJsonStatus']);

    // A component enum reference carries no members and is read by name, so two components
    // refuse the fold even when their members agree (see ir-types.md).
    const components = collapse([
      pet({ kind: 'enum', name: 'PetStatus' }),
      petJson({ kind: 'enum', name: 'PetJsonStatus' }),
    ]);
    expect(components.kept.map((m) => m.name)).toEqual(['Pet', 'PetJson']);
    expect(components.warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": field "status" has a different shape — keeping both',
    ]);
  });

  it('lifts a folded inline enum under the base’s name, through parseSpec', async () => {
    const status = { type: 'string', enum: ['on', 'off'] };
    const { spec, warnings } = await parseWithWarnings(
      'inline-enum.json',
      petsDoc({
        Pet: obj({ a: str, status }),
        PetJson: obj({ a: str, b: str, status, mode: { type: 'string', enum: ['fast', 'slow'] } }),
      }),
    );
    // The component pass lifted `PetJsonStatus` and `PetJsonMode`; the fold leaves them
    // unreferenced and drops them, and the collectors lift the renamed references: `PetStatus`
    // onto the base's own enum, `PetMode` under its new name.
    expect(warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (4 fields, superset)',
      '[oagen] Folded enum "PetJsonStatus" into "PetStatus"',
      '[oagen] Folded enum "PetJsonMode" into "PetMode"',
    ]);
    expect(describeModels(spec)).toEqual(['Pet {a,b,status,mode}']);
    expect(spec.models[0]?.fields.find((f) => f.name === 'status')?.type).toMatchObject({
      kind: 'enum',
      name: 'PetStatus',
    });
    expect(spec.models[0]?.fields.find((f) => f.name === 'mode')?.type).toMatchObject({
      kind: 'enum',
      name: 'PetMode',
    });
    expect(spec.enums.map((e) => [e.name, e.values.map((v) => v.value)])).toEqual([
      ['PetStatus', ['on', 'off']],
      ['PetMode', ['fast', 'slow']],
    ]);
    expect(describeResponses(spec)).toEqual(['getPet: Pet', 'getPetJson: Pet']);
    expect(unresolvedReferences(spec)).toEqual([]);

    // Declared as components, the two enums are read by name and the fold is refused.
    const declared = await parseWithWarnings(
      'component-enum.json',
      petsDoc({
        PetStatus: status,
        PetJsonStatus: status,
        Pet: obj({ a: str, status: { $ref: '#/components/schemas/PetStatus' } }),
        PetJson: obj({ a: str, b: str, status: { $ref: '#/components/schemas/PetJsonStatus' } }),
      }),
    );
    expect(declared.warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": field "status" has a different shape — keeping both',
    ]);
    expect(describeModels(declared.spec)).toEqual(['Pet {a,status}', 'PetJson {a,b,status}']);
    expect(describeResponses(declared.spec)).toEqual(['getPet: Pet', 'getPetJson: PetJson']);
    expect(unresolvedReferences(declared.spec)).toEqual([]);
  });

  it('holds the invariant and reads the same in every declaration order over generated nested `…Json` layouts', () => {
    // A small deterministic generator (mulberry32), so a failing layout is reproducible by its
    // seed. Each layout draws from a pool spelled to collide: `<Name>`/`<Name>Json` pairs whose
    // prefixes nest (`Pet`, `PetFoo`) and a pair spelled under another `…Json` prefix
    // (`PetJsonPet`/`PetJsonPetJson`, read under the `PetJson` fold too), children whose folded
    // names meet each other (`PetJsonJsonThing` folds to `PetJsonThing`), the other pairs' models
    // (`PetJsonFoo` folds to `PetFoo`, `PetJsonFooBar` and `PetFooJsonBar` to `PetFooBar`) and
    // pre-existing holders (`PetThing`, `PetPetToy`); every model has an `x` or `y` field, every
    // child is referenced by its `…Json` model and every holder by its base, with extra references
    // only to models of the layout. Each layout is folded in its own order and in three more
    // shuffles of it: every run holds the invariant and every run reads the same.
    const rng = (seed: number): (() => number) => {
      let t = seed >>> 0;
      return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      };
    };
    const pool: Record<string, { children: string[]; holders: string[] }> = {
      Pet: {
        children: [
          'PetJsonThing',
          'PetJsonJsonThing',
          'PetJsonJsonJsonThing',
          'PetJsonFoo',
          'PetJsonFooBar',
          'PetJsonFooBarInner',
        ],
        holders: ['PetThing', 'PetFooBar', 'PetFooBarInner'],
      },
      PetFoo: {
        children: ['PetFooJsonBar', 'PetFooJsonBarInner', 'PetFooJsonJsonBar', 'PetFooJsonThing'],
        holders: ['PetFooBar', 'PetFooThing'],
      },
      PetJsonPet: {
        children: ['PetJsonPetJsonToy', 'PetJsonPetJsonToyInner', 'PetJsonPetJsonThing'],
        holders: ['PetJsonPetToy', 'PetJsonPetToyInner', 'PetJsonPetThing', 'PetPetToy', 'PetPetThing'],
      },
    };
    const layout = (next: () => number): Model[] => {
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
      const bases = ['Pet', ...(next() < 0.5 ? ['PetFoo'] : []), ...(next() < 0.5 ? ['PetJsonPet'] : [])];
      const chosen = new Map<string, { children: string[]; holders: string[] }>();
      const names = new Set<string>();
      for (const base of bases) {
        const children = pool[base]!.children.filter(() => next() < 0.5);
        const holders = pool[base]!.holders.filter(() => next() < 0.4);
        chosen.set(base, { children, holders });
        for (const name of [base, `${base}Json`, ...children, ...holders]) names.add(name);
      }
      const all = [...names];
      const models = all.map((name): Model => {
        const fields: Model['fields'] = [field(next() < 0.75 ? 'x' : 'y')];
        if (next() < 0.3) {
          const target = pick(all);
          if (target !== name) fields.push(field('ref', modelRef(target)));
        }
        return { name, fields };
      });
      for (const base of bases) {
        const plain = models.find((m) => m.name === base)!;
        const json = models.find((m) => m.name === `${base}Json`)!;
        const { children, holders } = chosen.get(base)!;
        // The Json model is a superset of its base, with the base's fields admitted, and names
        // every child; the base names every holder.
        plain.fields = [field('a'), ...holders.map((n, i) => field(`holder${i}`, modelRef(n)))];
        json.fields = [field('a'), field('b'), ...children.map((n, i) => field(`child${i}`, modelRef(n)))];
      }
      return models;
    };
    const shuffled = (models: Model[], next: () => number): Model[] =>
      structuredClone(models)
        .map((m) => [next(), m] as const)
        .sort(([a], [b]) => a - b)
        .map(([, m]) => m);
    const reading = (kept: Model[]): string[] =>
      kept
        .map(
          (m) =>
            `${m.name} {${m.fields
              .map((f) => `${f.name}:${'name' in f.type ? f.type.name : f.type.kind}`)
              .sort()
              .join(',')}}`,
        )
        .sort();
    let folds = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const next = rng(seed);
      const models = layout(next);
      const runs = [shuffled(models, next), shuffled(models, next), shuffled(models, next), shuffled(models, next)].map(
        (order) => {
          const { kept, warnings } = collapse(order);
          folds += warnings.filter((w) => w.startsWith('[oagen] Merged ')).length;
          return reading(kept);
        },
      );
      for (const run of runs.slice(1)) expect(run, `seed ${seed}`).toEqual(runs[0]);
    }
    // The sweep exercises folds, not only refusals.
    expect(folds).toBeGreaterThan(200);
  });
});

/**
 * Issue #426: the fold read every model name by prefix. A model merely
 * spelled `PetJson…` — one `PetJson` never reaches, or one whose name only
 * starts with the same letters (`PetJsonification`) — was renamed with the
 * fold and could refuse it; a child could be renamed onto a name an enum
 * holds, leaving a model and an enum under one name; the enum note named the
 * name the reference was given rather than the one the collectors settled
 * on; and a folded `PetJson`'s `x-*` keys were dropped.
 */
describe('`<Name>Json` fold — reach, enum names and extensions (issue #426)', () => {
  /** A `pet`-tagged document whose operations `get<Name>` each return one of `returned`, around `schemas`. */
  const returningDoc = (
    schemas: Record<string, unknown>,
    returned: string[],
    parameters: Record<string, unknown[]> = {},
  ) => ({
    openapi: '3.1.0',
    info: { title: 'pets', version: '1' },
    paths: Object.fromEntries(
      returned.map((name) => [
        `/${name}`,
        {
          get: {
            operationId: `get${name}`,
            tags: ['pet'],
            ...(parameters[name] ? { parameters: parameters[name] } : {}),
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
              },
            },
          },
        },
      ]),
    ),
    components: { schemas },
  });

  it('renames no model `PetJson` does not reach, so it keeps its name and has no say in the fold', async () => {
    // The issue's repro: `PetJsonPatch` and `PetJsonification` are components of their own that
    // `PetJson` never references. Read by prefix, they were renamed `PetPatch` and `Petification`.
    const { spec, warnings } = await parseWithWarnings(
      'unreached.json',
      returningDoc(
        {
          Pet: obj({ name: str }),
          PetJson: obj({ name: str, tag: str }),
          PetJsonPatch: obj({ op: str }),
          PetJsonification: obj({ format: str }),
        },
        ['Pet', 'PetJson', 'PetJsonPatch', 'PetJsonification'],
      ),
    );
    expect(warnings).toEqual(['[oagen] Merged "PetJson" into "Pet" (2 fields, superset)']);
    expect(describeModels(spec)).toEqual(['Pet {name,tag}', 'PetJsonPatch {op}', 'PetJsonification {format}']);
    expect(describeResponses(spec)).toEqual([
      'getPet: Pet',
      'getPetJson: Pet',
      'getPetJsonPatch: PetJsonPatch',
      'getPetJsonification: PetJsonification',
    ]);
    expect(unresolvedReferences(spec)).toEqual([]);

    // Beside a `PetPatch` of another shape, the unrelated `PetJsonPatch` refused the whole fold.
    const beside = await parseWithWarnings(
      'beside.json',
      returningDoc(
        {
          Pet: obj({ name: str }),
          PetJson: obj({ name: str, tag: str }),
          PetJsonPatch: obj({ op: str }),
          PetPatch: obj({ path: str }),
        },
        ['Pet', 'PetJson', 'PetJsonPatch', 'PetPatch'],
      ),
    );
    expect(beside.warnings).toEqual(['[oagen] Merged "PetJson" into "Pet" (2 fields, superset)']);
    expect(describeModels(beside.spec)).toEqual(['Pet {name,tag}', 'PetJsonPatch {op}', 'PetPatch {path}']);
    expect(describeResponses(beside.spec)).toEqual([
      'getPet: Pet',
      'getPetJson: Pet',
      'getPetJsonPatch: PetJsonPatch',
      'getPetPatch: PetPatch',
    ]);
    expect(unresolvedReferences(beside.spec)).toEqual([]);
  });

  it('renames a child `PetJson` reaches through any model, and only at a word boundary', () => {
    // `PetJsonPatch` is reached through `Wrapper`, a model of another name, so it is a child and
    // follows the fold; `PetJsonification` is reached too, but `PetJson` + `ification` is not a
    // name under `PetJson`, so it keeps its own. Each note names the child that moved.
    const { kept, warnings } = collapse([
      { name: 'Pet', fields: [field('a')] },
      {
        name: 'PetJson',
        fields: [field('a'), field('wrap', modelRef('Wrapper')), field('format', modelRef('PetJsonification'))],
      },
      { name: 'Wrapper', fields: [field('patch', modelRef('PetJsonPatch'))] },
      { name: 'PetJsonPatch', fields: [field('op')] },
      { name: 'PetJsonification', fields: [field('format')] },
    ]);
    expect(describeFolded(kept)).toEqual([
      'Pet {a,wrap:Wrapper,format:PetJsonification}',
      'Wrapper {patch:PetPatch}',
      'PetPatch {op}',
      'PetJsonification {format}',
    ]);
    expect(warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (3 fields, superset)',
      '[oagen] Renamed child "PetJsonPatch" → "PetPatch"',
    ]);
  });

  it('reads the name a child lands on again only when the fold reaches that name', () => {
    // `PetJsonJsonThing` (the extractor's name for `PetJson.json_thing`) lands on `Pet` + `JsonThing`.
    // A child `PetJsonThing` vacating that name is followed to `PetThing` (see the vacated-name test
    // above); with none, `PetJsonThing` is a name the fold never reaches, so the child stops there
    // rather than lose the `Json` word its own field name carries.
    const { kept, warnings } = collapse([
      { name: 'Pet', fields: [field('a')] },
      { name: 'PetJson', fields: [field('a'), field('jsonThing', modelRef('PetJsonJsonThing'))] },
      { name: 'PetJsonJsonThing', fields: [field('x')] },
    ]);
    expect(describeFolded(kept)).toEqual(['Pet {a,jsonThing:PetJsonThing}', 'PetJsonThing {x}']);
    expect(warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (2 fields, superset)',
      '[oagen] Renamed child "PetJsonJsonThing" → "PetJsonThing"',
    ]);
  });

  it('refuses a fold that would rename a child onto a name an enum holds, wherever the enum sits', async () => {
    const schemas = (extra: Record<string, unknown> = {}) => ({
      Pet: obj({ name: str }),
      PetJson: obj({
        name: str,
        mode: { type: 'string', enum: ['indoor', 'outdoor'] },
        toy: { $ref: '#/components/schemas/PetJsonToy' },
      }),
      PetJsonToy: obj({ label: str }),
      PetMode: obj({ since: str }),
      ...extra,
    });
    const refusal =
      '[oagen] Warning: Json-suffix model "PetJson" is not merged into "Pet": "PetJsonToy" would be renamed "PetToy", and enum "PetToy" owns the name — keeping both';
    const ball = { type: 'string', enum: ['ball', 'rope'] };

    // The issue's repro: beside a component enum `PetToy`, the IR declared a model and an enum
    // `PetToy`.
    const component = await parseWithWarnings(
      'component-enum.json',
      returningDoc(schemas({ PetToy: ball }), ['Pet', 'PetJson', 'PetMode']),
    );
    expect(component.warnings).toEqual([refusal]);
    expect(describeModels(component.spec)).toEqual([
      'Pet {name}',
      'PetJson {name,mode,toy}',
      'PetJsonToy {label}',
      'PetMode {since}',
    ]);
    expect(component.spec.enums.map((e) => e.name).sort()).toEqual(['PetJsonMode', 'PetToy']);
    expect(describeResponses(component.spec)).toEqual(['getPet: Pet', 'getPetJson: PetJson', 'getPetMode: PetMode']);
    expect(unresolvedReferences(component.spec)).toEqual([]);

    // A `toy` query enum of the `pet` service is lifted after the fold: it stepped to `PetToy2`
    // past the renamed child, so the parameter's type depended on the fold. It keeps `PetToy`.
    const query = await parseWithWarnings(
      'query-enum.json',
      returningDoc(schemas(), ['Pet', 'PetJson', 'PetMode'], {
        Pet: [{ name: 'toy', in: 'query', schema: ball }],
      }),
    );
    expect(query.warnings).toEqual([refusal]);
    expect(query.spec.services[0]?.operations[0]?.queryParams[0]?.type).toMatchObject({ kind: 'enum', name: 'PetToy' });
    expect(query.spec.enums.map((e) => e.name).sort()).toEqual(['PetJsonMode', 'PetToy']);
    expect(describeModels(query.spec)).toEqual([
      'Pet {name}',
      'PetJson {name,mode,toy}',
      'PetJsonToy {label}',
      'PetMode {since}',
    ]);

    // With no enum in the way the fold goes ahead, and the note names the enum `mode` ends under:
    // the collectors step `PetMode` past the component model of that name.
    const folded = await parseWithWarnings('no-enum.json', returningDoc(schemas(), ['Pet', 'PetJson', 'PetMode']));
    expect(folded.warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (3 fields, superset)',
      '[oagen] Renamed child "PetJsonToy" → "PetToy"',
      '[oagen] Folded enum "PetJsonMode" into "PetMode2"',
    ]);
    expect(describeModels(folded.spec)).toEqual(['Pet {name,mode,toy}', 'PetToy {label}', 'PetMode {since}']);
    expect(folded.spec.models[0]?.fields.find((f) => f.name === 'mode')?.type).toMatchObject({
      kind: 'enum',
      name: 'PetMode2',
    });
    expect(folded.spec.enums.map((e) => e.name)).toEqual(['PetMode2']);
    expect(unresolvedReferences(folded.spec)).toEqual([]);
  });

  it('refuses a fold that would rename a child onto an inline enum another model carries', () => {
    const models = (): Model[] => [
      { name: 'Pet', fields: [field('a')] },
      { name: 'PetJson', fields: [field('a'), field('toy', modelRef('PetJsonToy'))] },
      { name: 'PetJsonToy', fields: [field('x')] },
      { name: 'Owner', fields: [field('toy', { kind: 'enum', name: 'PetToy', values: ['ball'] })] },
    ];
    const { kept, warnings } = collapse(models());
    expect(describeFolded(kept)).toEqual(describeFolded(models()));
    expect(warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" is not merged into "Pet": "PetJsonToy" would be renamed "PetToy", and enum "PetToy" owns the name — keeping both',
    ]);

    // A model the document keeps under the name holds it as any holder does: the child collapses
    // onto it, so the fold puts no new type under the enum's name.
    const held = collapse([...models(), { name: 'PetToy', fields: [field('x')] }]);
    expect(describeFolded(held.kept)).toEqual(['Pet {a,toy:PetToy}', 'Owner {toy}', 'PetToy {x}']);
    expect(held.warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (2 fields, superset)',
      '[oagen] Collapsed child "PetJsonToy" into existing "PetToy"',
    ]);
  });

  it('carries the `…Json` model’s `x-*` keys onto a base that has none, as it carries its link', async () => {
    // The issue's repro: `createPet` takes `PetJson`, whose keys were dropped with it.
    const doc = (pet: Record<string, unknown> = {}) => ({
      openapi: '3.1.0',
      info: { title: 'pets', version: '1' },
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/PetJson' } } },
            },
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: { ...obj({ name: str }), ...pet },
          PetJson: {
            ...obj({ name: str, age: { type: 'integer' } }),
            externalDocs: { url: 'https://example.com/pets' },
            'x-since': '1.2',
          },
        },
      },
    });
    const project = (spec: ApiSpec) =>
      spec.models.map(({ externalDocs, extensions, fields, name }) => ({
        externalDocs,
        extensions,
        fields: fields.map((f) => f.name),
        name,
      }));

    const { spec, warnings } = await parseWithWarnings('keys.json', doc());
    expect(warnings).toEqual(['[oagen] Merged "PetJson" into "Pet" (2 fields, superset)']);
    expect(project(spec)).toEqual([
      {
        externalDocs: { url: 'https://example.com/pets' },
        extensions: { 'x-since': '1.2' },
        fields: ['name', 'age'],
        name: 'Pet',
      },
    ]);

    // A base with keys and a link of its own keeps both, as it keeps its own description.
    const own = await parseWithWarnings(
      'own-keys.json',
      doc({ externalDocs: { url: 'https://example.com/pet' }, 'x-owner': 'pets-team' }),
    );
    expect(project(own.spec)).toEqual([
      {
        externalDocs: { url: 'https://example.com/pet' },
        extensions: { 'x-owner': 'pets-team' },
        fields: ['name', 'age'],
        name: 'Pet',
      },
    ]);
  });
});
