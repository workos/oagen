import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
import { collectModelRefs, collectResponseBodyTypes, collectResponseHeaders } from '../../src/ir/types.js';
import type { ApiSpec, Model, TypeRef } from '../../src/ir/types.js';

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
 * referenced before the pass is still referenced — a fold never leaves a
 * reference dangling or a model it does not fold unreferenced.
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
  return { kept, warnings };
}

const modelRef = (name: string): TypeRef => ({ kind: 'model', name });
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

    // Nothing collapses by name alone: a model merely spelled `<Json>…` that the `…Json`
    // model never references is read as a child too, and refuses the fold the same way.
    const stranger = [
      ...models(),
      { name: 'PetJsonExtra', fields: [field('z')] },
      { name: 'PetExtra', fields: [field('y')] },
    ];
    const refusedStranger = collapse(stranger);
    expect(refusedStranger.kept.map((m) => m.name)).toEqual(stranger.map((m) => m.name));
    expect(refusedStranger.warnings).toEqual([
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": "PetJsonExtra" would fold onto "PetExtra", which has a different shape — keeping both',
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
  it("decides a fold's whole subtree against the folds before it: a refused nested child refuses the parent (Greptile)", () => {
    // Two prefixes nest: `PetJsonFooBar` (a child of `PetJson`) and `PetFooJsonBar` (a child of
    // `PetFooJson`) both fold to `PetFooBar`, and their `inner` children both to `PetFooBarInner`,
    // which no model holds when the candidates are chosen. The first fold seats `PetFooBar` and
    // `PetFooBarInner { x }`; the second reads alike at the top (`PetFooJsonBar.inner` folds to
    // `PetFooBarInner`) but its `PetFooJsonBarInner { y }` is not admitted — so none of it is
    // applied: `PetFooJson` keeps its name and `bar.inner` still exposes `y`.
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
    const describe = (kept: Model[]): string[] =>
      kept.map(
        (m) => `${m.name} {${m.fields.map((f) => `${f.name}${f.type.kind === 'model' ? `:${f.type.name}` : ''}`)}}`,
      );

    const { kept, warnings } = collapse(models());
    expect(describe(kept)).toEqual([
      'Pet {a,b,fooBar:PetFooBar}',
      'PetFooBar {inner:PetFooBarInner}',
      'PetFooBarInner {x}',
      'PetFoo {c}',
      'PetFooJson {c,d,bar:PetFooJsonBar}',
      'PetFooJsonBar {inner:PetFooJsonBarInner}',
      'PetFooJsonBarInner {y}',
    ]);
    expect(warnings).toEqual([
      '[oagen] Merged "PetJson" into "Pet" (3 fields, superset)',
      '[oagen] Renamed child "PetJson…" → "PetFooBar"',
      '[oagen] Renamed child "PetJson…" → "PetFooBarInner"',
      '[oagen] Warning: Json-suffix model "PetFooJson" does not preserve the shape of "PetFoo": "PetFooJsonBarInner" would fold onto "PetFooBarInner", which has a different shape — keeping both',
    ]);

    // The mirror: declared the other way round, the first fold seats `PetFooBarInner { y }` and
    // the `PetJson` fold is the one refused, whole.
    const mirrored = collapse([...models().slice(4), ...models().slice(0, 4)]);
    expect(describe(mirrored.kept)).toEqual([
      'PetFoo {c,d,bar:PetFooBar}',
      'PetFooBar {inner:PetFooBarInner}',
      'PetFooBarInner {y}',
      'Pet {a}',
      'PetJson {a,b,fooBar:PetJsonFooBar}',
      'PetJsonFooBar {inner:PetJsonFooBarInner}',
      'PetJsonFooBarInner {x}',
    ]);
    expect(mirrored.warnings.at(-1)).toBe(
      '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": "PetJsonFooBarInner" would fold onto "PetFooBarInner", which has a different shape — keeping both',
    );

    // Three levels down the same: the mismatch is read through two admitted parents.
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
    expect(threeLevels.kept.map((m) => m.name)).toEqual([
      'Pet',
      'PetFooBar',
      'PetFooBarInner',
      'PetFooBarInnerDeep',
      'PetFoo',
      'PetFooJson',
      'PetFooJsonBar',
      'PetFooJsonBarInner',
      'PetFooJsonBarInnerDeep',
    ]);
    expect(threeLevels.kept.find((m) => m.name === 'PetFooJsonBarInnerDeep')?.fields).toEqual([field('y')]);
    expect(threeLevels.warnings.at(-1)).toBe(
      '[oagen] Warning: Json-suffix model "PetFooJson" does not preserve the shape of "PetFoo": "PetFooJsonBarInnerDeep" would fold onto "PetFooBarInnerDeep", which has a different shape — keeping both',
    );

    // The same subtree of one shape collapses onto the seated names, as any admitted child does.
    const same = models().map((m) => (m.name === 'PetFooJsonBarInner' ? { ...m, fields: [field('x')] } : m));
    const folded = collapse(same);
    expect(describe(folded.kept)).toEqual([
      'Pet {a,b,fooBar:PetFooBar}',
      'PetFooBar {inner:PetFooBarInner}',
      'PetFooBarInner {x}',
      'PetFoo {c,d,bar:PetFooBar}',
    ]);
    expect(folded.warnings.slice(-3)).toEqual([
      '[oagen] Merged "PetFooJson" into "PetFoo" (3 fields, superset)',
      '[oagen] Collapsed child "PetFooJsonBar" into existing "PetFooBar"',
      '[oagen] Collapsed child "PetFooJsonBarInner" into existing "PetFooBarInner"',
    ]);
  });
});
