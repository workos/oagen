import type {
  ArrayType,
  Constraints,
  Enum,
  EnumRef,
  Field,
  LiteralType,
  MapType,
  Model,
  ModelRef,
  NullableType,
  PrimitiveType,
  TypeRef,
  UnionType,
} from '../ir/types.js';
import { assertNever, walkTypeRef } from '../ir/types.js';
import { shapeWithEnumFlags } from './enum-members.js';
import { stableStringify } from './inline-models.js';
import { isComponentModelRef } from './schemas.js';

/**
 * Settle every model's `bases` and its fields' `inheritedFrom` once every
 * pass that builds, folds or renames a model has run — the last pass of
 * `parseSpec` — so the two keys describe the models as they end (#591,
 * Greptile review), `fields` untouched throughout:
 *
 * 1. No model's chain of bases reaches itself. A base whose own chain of
 *    bases, read through `models` by name, reaches the model — in a cyclic
 *    document (`A: { allOf: [{ $ref: B }] }`, `B: { allOf: [{ $ref: A }] }`),
 *    or once a `…Json` fold collapsed a base onto a kept model of the same
 *    shape (`PetJsonChild` onto `PetChild: { allOf: [{ $ref: PetJsonChild }]
 *    }` as `PetJson` folds onto `Pet`, directly or through a chain) — is
 *    dropped, and the fields it lent are the model's own. Decided on the
 *    graph as it stands before anything is dropped, so the models' order
 *    plays no part.
 * 2. A base named twice is one base, the first kept: a rename can send two
 *    bases to one name (`Bar` beside a `BarJson` folded onto it).
 * 3. A base is a base only while every field it ends with is on the model
 *    as the same field or as a declaration of the model's own that fits
 *    it, so the model is its own fields plus its bases', `interface Pet
 *    extends Base { … }` compiles, and that spelling and an intersection
 *    of the bases with the model's own fields both type every field as
 *    `fields` does.
 *    - The same field (`sameField`): same keys, same values, the type read
 *      as its final shape, an inline model built under either model
 *      (`PetMeta`, `AnimalMeta`) as it ends, a union's variants and mapping
 *      targets the same way, an inline enum by its values, a component by
 *      name. A field the model takes from one base (`inheritedFrom`) has
 *      to be the same field on every other base that declares it: the
 *      model does not write it, and `interface Pet extends Kinded, Tagged
 *      {}` does not compile when the two type `tag` apart.
 *    - A declaration of the model's own — a field with no `inheritedFrom`
 *      — fits a base's when it admits no value the base's does not
 *      (`fieldFits`, #681): required wherever the base requires the field,
 *      its type within the base's, its limits at least as tight. What it
 *      says beside that — its text, a flag, a default, an example, its
 *      extensions — is the model's to override, as `overrides.json`'s
 *      `name` (the enum `PetName`, required, over `Animal`'s optional
 *      string) overrides and keeps `Animal`. One that admits more does
 *      not: `Pet: { allOf: [{ $ref: Animal }], properties: { species: {
 *      type: 'string' } } }` over `Animal.species: enum [cat, dog]` ends
 *      with `Animal` no base and `name` `Pet`'s own, since `interface Pet
 *      extends Animal { species?: string }` does not compile and `Animal &
 *      { species?: string }` types `species` as the enum. Any declaration
 *      of the model's own used to keep the base.
 *
 *    Two bases declaring one property differently keep only those the
 *    model's field is the same as or fits: `Pet: { allOf: [{ $ref: Tagged
 *    }, { $ref: Kinded }] }` with `Tagged.tag: string` and `Kinded.tag:
 *    enum [cat, dog]` ends `Pet { tag?: string, kind? }` on `Tagged`
 *    alone, `kind` its own (#591 review: `Tagged & Kinded` types `tag` as
 *    the enum, and `interface Pet extends Tagged, Kinded {}` does not
 *    compile), and so it ends with `required: [tag]` beside the `allOf`
 *    or a `description` on `tag`, which make `tag: string` the model's
 *    own: it fits `Tagged`'s and not `Kinded`'s (#681). The other way
 *    round, on `Kinded` alone with `tag: PetTag`; requiring `tag` there
 *    makes the enum the model's own, which fits both (`interface Pet
 *    extends Kinded, Tagged { tag: PetTag }` compiles), so both stay, and
 *    a declaration that fits neither (`tag: integer`) leaves none.
 *    A base that is a named union or a dispatcher is one of its variants
 *    to an emitter that writes the union (`Shape & { … }`), so beside its
 *    own `fields` — the merge of a named union's inline variants, none
 *    for `$ref` variants — it is read through the fields its variants
 *    declare (`unionVariants`), and stays while two things hold. One
 *    variant agrees with the model on every field the two share, each the
 *    same field or a declaration of the model's own that fits it: that
 *    variant's branch of `Shape & { … }` then types every field as
 *    `fields` does, and every other branch types a part of it. And every
 *    field a variant declares that the model carries too is agreed by one
 *    of the variants that declare it, so a union of `$ref` variants reads
 *    as the merge of an inline one's does. `Pet: { allOf: [{ $ref: Shape
 *    }], required: [kind], properties: { kind: { const: 'cat' } } }` over
 *    `Shape: { oneOf: [{ $ref: Cat }, { $ref: Dog }] }`, whose variants
 *    pin and require `kind`, stays on `Shape`: it is the `Cat` of it.
 *    With `kind: { type: 'string' }` it does not (`Shape & { kind?: string
 *    }` types `kind` as `'cat' | 'dog'`), and with `extra` in place of
 *    `kind` it does. A field agreed by one variant and another by another
 *    is not enough: `kind: 'cat'` fits `Cat` alone, and a `name: string`
 *    that fits `Dog.name` alone, over `Cat.name: 'tom'`, is typed `'tom'`,
 *    the `Dog` branch admitting nothing. A named union with no variant at
 *    all is no base.
 *    A fold that loosens a base after the model took its fields —
 *    `AnimalJson` declaring `name` optional beside `extra`, folded onto an
 *    `Animal` requiring `name`, under `Pet: { allOf: [{ $ref: Animal }] }`
 *    — leaves `Pet.name` required, so `Animal` is no base of `Pet` as it
 *    ends and `name` is `Pet`'s own. A field carries `inheritedFrom` only
 *    while its base stays. Every base is decided on the model as it
 *    stands before any is dropped here, from `fields` alone, so neither
 *    the order of the bases nor the order of the models plays a part.
 *
 * `enums` is the document's enums, read for the values of a reference to
 * a component enum, which carries none.
 *
 * A base no model carries (a dangling reference) is left for
 * `validateModelRefs` to report.
 */
export function settleBases(models: readonly Model[], enums: readonly Enum[] = []): void {
  const byName = new Map(models.map((model) => [model.name, model]));
  const enumValues = new Map(enums.map((entry) => [entry.name, entry.values.map((member) => member.value)]));
  // A named union is written as the union of its variants by one emitter
  // and, from `fields` alone, as their merge by another, or as whichever
  // it carries: a fit has to hold under each reading (`FitContext.reading`).
  const readings: FitContext[] = (['variants', 'fields', 'fieldsFirst'] as const).map((reading) => ({
    reading,
    byName,
    enumValues,
    leaves: new Map(),
    decided: new Map(),
  }));
  dropCircularBases(models, byName);
  for (const model of models) {
    if (!model.bases) continue;
    dedupeBases(model);
    // The model's field of each name, and whether it is the model's own
    // (no origin) or taken from a base, as the model stands before any
    // base is dropped here, so the outcome does not depend on the order
    // of the bases.
    const fields = new Map<string, Field>();
    for (const field of model.fields) if (!fields.has(field.name)) fields.set(field.name, field);
    const origins = new Map(
      model.fields.map((field) => [
        field.name,
        field.inheritedFrom?.kind === 'model' ? field.inheritedFrom.name : null,
      ]),
    );
    // Whether the model carries a base's field, or a variant's: decided
    // once per field, however many bases and variants are read through it.
    const verdicts = new Map<Field, boolean>();
    const carried = (field: Field): boolean => {
      let verdict = verdicts.get(field);
      if (verdict === undefined) {
        const own = fields.get(field.name);
        verdict =
          own !== undefined &&
          (sameField(own, field, byName, new Map()) ||
            (origins.get(field.name) === null && readings.every((context) => fieldFits(own, field, context))));
        verdicts.set(field, verdict);
      }
      return verdict;
    };
    // A base that is a union is one of its variants: one of them has to
    // agree with the model on every field the two share, and every such
    // field has to be agreed by a variant that declares it.
    const variantsAgree = (target: Model): boolean => {
      const variants = unionVariants(target, byName);
      if (!variants) return true;
      const shared = variants.map((declared) => declared.filter((field) => fields.has(field.name)));
      if (!shared.some((declared) => declared.every(carried))) return false;
      const declarations = new Map<string, Field[]>();
      for (const field of shared.flat()) declarations.set(field.name, [...(declarations.get(field.name) ?? []), field]);
      return [...declarations.values()].every((declared) => declared.some(carried));
    };
    const dropped: string[] = [];
    for (const base of model.bases) {
      const target = base.kind === 'model' ? byName.get(base.name) : undefined;
      if (target && !(target.fields.every(carried) && variantsAgree(target))) dropped.push(target.name);
    }
    for (const name of dropped) dropBase(model, name);
    // A field inherited from no base that stays is the model's own.
    const remaining = new Set(model.bases.flatMap((ref) => (ref.kind === 'model' ? [ref.name] : [])));
    for (const field of model.fields) {
      if (field.inheritedFrom?.kind === 'model' && !remaining.has(field.inheritedFrom.name)) delete field.inheritedFrom;
    }
    if (model.bases.length === 0) delete model.bases;
  }
}

/** Step 1: drop, from every model, each base whose chain of bases reaches the model, with the `inheritedFrom` of the fields it lent. */
function dropCircularBases(models: readonly Model[], byName: ReadonlyMap<string, Model>): void {
  const reaches = (from: string, target: string, visiting: Set<string>): boolean => {
    if (from === target) return true;
    if (visiting.has(from)) return false;
    visiting.add(from);
    return (byName.get(from)?.bases ?? []).some((ref) => ref.kind === 'model' && reaches(ref.name, target, visiting));
  };
  const circular = new Map<Model, string[]>();
  for (const model of models) {
    const names: string[] = [];
    for (const ref of model.bases ?? []) {
      if (ref.kind === 'model' && reaches(ref.name, model.name, new Set())) names.push(ref.name);
    }
    if (names.length > 0) circular.set(model, names);
  }
  for (const [model, names] of circular) for (const name of names) dropBase(model, name);
}

/** Step 2: keep the first of two bases that name one model. */
function dedupeBases(model: Model): void {
  const bases = model.bases ?? [];
  const named = new Set<string>();
  const distinct = bases.filter((ref) => {
    if (ref.kind !== 'model') return true;
    if (named.has(ref.name)) return false;
    named.add(ref.name);
    return true;
  });
  if (distinct.length !== bases.length) bases.splice(0, bases.length, ...distinct);
}

/** Remove the base `name` from `model.bases`, in place, and the `inheritedFrom` of every field it lent. */
function dropBase(model: Model, name: string): void {
  const bases = model.bases ?? [];
  const kept = bases.filter((ref) => !(ref.kind === 'model' && ref.name === name));
  if (kept.length !== bases.length) bases.splice(0, bases.length, ...kept);
  for (const field of model.fields) {
    if (field.inheritedFrom?.kind === 'model' && field.inheritedFrom.name === name) delete field.inheritedFrom;
  }
}

/**
 * What a base that is a union is one of (step 3), each variant as the
 * fields it declares: a named union's variants, or — for a dispatcher,
 * which carries none — the models its mapping names; a model's fields, a
 * union among them read in turn (a named one once, an inline one through
 * its own variants, a nullable one through what it wraps), and no field
 * for a variant that names no model (a primitive, an array), which
 * declares none. A name no model carries is passed over. `undefined` for
 * a model that is no union, or a dispatcher none of whose targets is
 * found: nothing to read but its own `fields`.
 */
function unionVariants(
  union: Model,
  byName: ReadonlyMap<string, Model>,
  seen = new Set<Model>(),
): Field[][] | undefined {
  if (!union.variants && !union.discriminator) return undefined;
  if (seen.has(union)) return [];
  seen.add(union);
  const declared: Field[][] = [];
  const read = (variant: TypeRef): void => {
    if (variant.kind === 'nullable') return read(variant.inner);
    if (variant.kind === 'union') return variant.variants.forEach(read);
    if (variant.kind !== 'model') return void declared.push([]);
    const model = byName.get(variant.name);
    if (!model) return;
    declared.push(...(unionVariants(model, byName, seen) ?? [model.fields]));
  };
  if (union.variants) union.variants.forEach(read);
  else for (const name of Object.values(union.discriminator?.mapping ?? {})) read({ kind: 'model', name });
  return union.variants || declared.length > 0 ? declared : undefined;
}

/**
 * Whether two fields are one field (step 3): every key but `inheritedFrom`
 * the same, and the type the same final shape (`sameType`) — a reference
 * to an inline model built under either model (`PetMeta`, `AnimalMeta`)
 * standing for that model as it ends, compared the same way in turn
 * (`sameModel`: its fields each by this test, its own keys beside them,
 * a pair of models met again on the way taken as one), a reference to a
 * component by name (`isComponentModelRef`: the same model on both sides),
 * an inline enum by its values and their flags alone, a component enum
 * by name — so a fold that changes a nested model under the base
 * (`AnimalMetaJson` onto `AnimalMeta`) is told from a name that only
 * differs by the model it was built under, and an unchanged inline enum
 * (`PetStatus` beside `AnimalStatus`) compares equal (Greptile review,
 * round six). Compared as values, never through a serialized key that
 * embeds a child's — which grew with each level of nesting (round seven).
 */
function sameField(a: Field, b: Field, byName: ReadonlyMap<string, Model>, seen: ComparedPairs): boolean {
  const { inheritedFrom: _originA, type: typeA, ...restA } = a;
  const { inheritedFrom: _originB, type: typeB, ...restB } = b;
  return stableStringify(restA) === stableStringify(restB) && sameType(typeA, typeB, byName, seen);
}

/** The pairs of models `sameModel` has entered, by identity: a pair met again on the way is one being compared, and is taken as one. */
type ComparedPairs = Map<Model, Set<Model>>;

/** Whether two types are one final shape, as `sameField` reads them. */
function sameType(a: TypeRef, b: TypeRef, byName: ReadonlyMap<string, Model>, seen: ComparedPairs): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'primitive':
    case 'literal':
      return stableStringify(a) === stableStringify(b);
    case 'array': {
      const other = b as ArrayType;
      return sameLimits(a.constraints, other.constraints) && sameType(a.items, other.items, byName, seen);
    }
    case 'nullable':
      return sameType(a.inner, (b as NullableType).inner, byName, seen);
    case 'map': {
      const other = b as MapType;
      if (!sameLimits(a.constraints, other.constraints)) return false;
      if ((a.keyType === undefined) !== (other.keyType === undefined)) return false;
      if (a.keyType && other.keyType && !sameType(a.keyType, other.keyType, byName, seen)) return false;
      return sameType(a.valueType, other.valueType, byName, seen);
    }
    case 'union': {
      const other = b as UnionType;
      const { variants: _va, discriminator: discriminatorA, ...restA } = a;
      const { variants: _vb, discriminator: discriminatorB, ...restB } = other;
      if (stableStringify(restA) !== stableStringify(restB)) return false;
      if (!sameDiscriminator(discriminatorA, discriminatorB, a.variants, other.variants, byName, seen)) return false;
      return sameTypes(a.variants, other.variants, byName, seen);
    }
    case 'enum': {
      const other = b as EnumRef;
      if (a.values === undefined && other.values === undefined) return a.name === other.name;
      return stableStringify(enumMembers(a)) === stableStringify(enumMembers(other));
    }
    case 'model': {
      const other = b as ModelRef;
      if (isComponentModelRef(a) || isComponentModelRef(other)) return a.name === other.name;
      const modelA = byName.get(a.name);
      const modelB = byName.get(other.name);
      if (!modelA || !modelB) return a.name === other.name;
      return sameModel(modelA, modelB, byName, seen);
    }
    default:
      return assertNever(a);
  }
}

/** Whether two type lists are one, pairwise. */
function sameTypes(
  a: readonly TypeRef[],
  b: readonly TypeRef[],
  byName: ReadonlyMap<string, Model>,
  seen: ComparedPairs,
): boolean {
  return a.length === b.length && a.every((type, index) => sameType(type, b[index]!, byName, seen));
}

/** A `discriminator` as a union or a model carries it. */
type Discriminator = NonNullable<UnionType['discriminator']>;

/**
 * Whether two discriminators dispatch alike: the same property and the
 * same keys, each key's target the same final shape — an inline variant
 * built under either model (`PetMeta` beside `AnimalMeta`, `DogPetMeta`
 * beside `DogAnimalMeta`) as it ends (`sameModel`), a component by name
 * (`componentNames`: the component references among the variants) — so a
 * mapping that names its targets by the model they were built under
 * compares as the variants do, not as strings (Greptile review, on the
 * merge after the maintainer's round).
 */
function sameDiscriminator(
  a: Discriminator | undefined,
  b: Discriminator | undefined,
  variantsA: readonly TypeRef[],
  variantsB: readonly TypeRef[],
  byName: ReadonlyMap<string, Model>,
  seen: ComparedPairs,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.property !== b.property) return false;
  const keys = Object.keys(a.mapping).sort();
  if (stableStringify(keys) !== stableStringify(Object.keys(b.mapping).sort())) return false;
  const components = new Set([...componentNames(variantsA), ...componentNames(variantsB)]);
  return keys.every((key) => {
    const nameA = a.mapping[key]!;
    const nameB = b.mapping[key]!;
    if (nameA === nameB) return true;
    if (components.has(nameA) || components.has(nameB)) return false;
    const modelA = byName.get(nameA);
    const modelB = byName.get(nameB);
    return modelA !== undefined && modelB !== undefined && sameModel(modelA, modelB, byName, seen);
  });
}

/** The names of the component models referenced among `variants`, under any wrapper. */
function componentNames(variants: readonly TypeRef[]): string[] {
  const names: string[] = [];
  for (const variant of variants) {
    walkTypeRef(variant, {
      model: (ref) => {
        if (isComponentModelRef(ref)) names.push(ref.name);
      },
    });
  }
  return names;
}

/** Whether two sets of limits are one. */
function sameLimits(a: unknown, b: unknown): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

/** An inline enum's members as `sameType` compares them: its values and, among them, the deprecated ones (`shapeWithEnumFlags`), its name set aside. */
function enumMembers(ref: EnumRef): unknown {
  const { name: _name, ...members } = shapeWithEnumFlags(ref) as EnumRef & { deprecatedValues?: unknown };
  return members;
}

/**
 * Whether two inline models are one final shape: their own keys but the
 * name and the bases the same, the same field names, each field one by
 * `sameField`, and the same variants in order. A pair entered again on
 * the way — a model that reaches itself through a field — is taken as
 * one, so the walk ends; a difference found anywhere still answers for
 * the whole.
 */
function sameModel(a: Model, b: Model, byName: ReadonlyMap<string, Model>, seen: ComparedPairs): boolean {
  if (a === b) return true;
  let pairs = seen.get(a);
  if (pairs?.has(b)) return true;
  if (!pairs) seen.set(a, (pairs = new Set()));
  pairs.add(b);
  const {
    name: _nameA,
    bases: _basesA,
    fields: fieldsA,
    variants: variantsA,
    discriminator: discriminatorA,
    ...restA
  } = a;
  const {
    name: _nameB,
    bases: _basesB,
    fields: fieldsB,
    variants: variantsB,
    discriminator: discriminatorB,
    ...restB
  } = b;
  if (stableStringify(restA) !== stableStringify(restB)) return false;
  if (!sameDiscriminator(discriminatorA, discriminatorB, variantsA ?? [], variantsB ?? [], byName, seen)) return false;
  if (fieldsA.length !== fieldsB.length) return false;
  const byField = new Map(fieldsB.map((field) => [field.name, field]));
  for (const field of fieldsA) {
    const other = byField.get(field.name);
    if (!other || !sameField(field, other, byName, seen)) return false;
  }
  if ((variantsA === undefined) !== (variantsB === undefined)) return false;
  return !variantsA || !variantsB || sameTypes(variantsA, variantsB, byName, seen);
}

/** A value a `const` pins or an enum lists. */
type Value = LiteralType['value'];

/**
 * One side of a comparison `settled` keeps a verdict for, by identity: a
 * model — whichever reference names it — or, for a type that names none,
 * the type itself.
 */
type Side = Model | TypeRef;

/** A verdict per comparison, by the identity of its two sides: what would fit, then what it would fit. */
type Verdicts = Map<Side, Map<Side, boolean>>;

/** A comparison being settled (`settled`): its two sides, how to read it, its verdict so far, and the comparisons whose own verdict was reached reading it. */
interface Pair {
  own: Side;
  base: Side;
  read: () => boolean;
  fits: boolean;
  readers: Set<Pair>;
}

/** The comparisons `settled` is deciding together: each by its two sides, those still to be read, and the one being read. */
interface Settling {
  pairs: Map<Side, Map<Side, Pair>>;
  pending: Pair[];
  reading?: Pair;
}

/**
 * What the fit reads beside the two declarations: how a named union is
 * read (`reading`), the models by name, each enum's values by name — for
 * a reference to a component enum, which carries none — each named
 * union's variants read through the unions among them (`leaves`, kept by
 * `unionLeaves`), and what `settled` has decided (`decided`) and is
 * deciding (`settling`) about the comparisons that can be asked more than
 * once.
 *
 * `Model.fields` of a named union keeps the merge of its inline variants,
 * "so an emitter that does not read `variants` sees the same model as
 * before", which leaves an emitter three ways to write one: as the union
 * of its `variants` (`variants`), as the model its `fields` are
 * (`fields`), or as that model when it has any field and as the union
 * when it has none, which a union of `$ref` or primitive variants has
 * (`fieldsFirst`). A fit proved one way can fail `tsc` another, and two
 * unions under one field can each be read differently by the third, so a
 * fit is asked under each reading, every named union in it read that way.
 */
interface FitContext {
  reading: 'variants' | 'fields' | 'fieldsFirst';
  byName: ReadonlyMap<string, Model>;
  enumValues: ReadonlyMap<string, readonly Value[]>;
  leaves: Map<Model, readonly TypeRef[]>;
  decided: Verdicts;
  settling?: Settling;
}

/**
 * Whether `own`, a declaration of the model's own, fits `base`, the field
 * of that name a base ends with (step 3, #681): it admits no value the
 * base's does not, as far as the IR can tell, so `interface Pet extends
 * Base { own }` compiles and `Base & { own }` types the field as `own`
 * does.
 *
 * - The same property: a field the SDK exposes under another name than the
 *   base does (`domainName`, from `fieldHints`) is another one.
 * - Required wherever the base requires it. Required over the base's
 *   optional fits (`tag: string` over `Tagged.tag?: string`); optional
 *   over required does not.
 * - Its type within the base's (`typeFits`).
 * - Its limits at least as tight as the base's, keyword by keyword
 *   (`limitsFit`) — so a declaration that only requires or documents the
 *   base's field fits, whatever the limits are — or, for an enum or a
 *   pinned value that does not repeat them, each value within them
 *   (`valueWithin`). The type carries its own at every level; the field's
 *   are read here too, since a reference to a model or an enum carries
 *   none.
 *
 * Every other key — `description`, `externalDocs`, `deprecated`,
 * `readOnly`, `writeOnly`, `default`, `example`, `examples`, `extensions`
 * — says nothing about the values admitted, and is the model's own to
 * override.
 */
function fieldFits(own: Field, base: Field, context: FitContext): boolean {
  if (own.domainName !== base.domainName) return false;
  if (base.required && !own.required) return false;
  if (!typeFits(own.type, base.type, context, own.constraints)) return false;
  if (limitsFit(own.constraints, base.constraints)) return true;
  const values = valuesOf(underNullable(own.type), context);
  return values !== undefined && values.every((value) => valueWithin(value, base.constraints));
}

/**
 * Whether every value `own` admits `base` admits too, read structurally
 * and one way only — whatever this cannot tell is no fit, since a base
 * that is dropped costs an emitter nothing and one kept wrongly does not
 * compile:
 *
 * - The same final shape (`sameType`) fits, and anything fits an untyped
 *   schema (`unknown` with no limits).
 * - A nullable type fits only a type that admits `null` (`admitsNull`),
 *   its inner type fitting in turn; a non-nullable one fits a nullable
 *   base through its inner type. `string | null` does not fit `string`.
 * - A union fits when every variant does; a type fits a union when it
 *   fits one variant, and an enum when each of its values fits one. A
 *   union that carries limits of its own (an OAS 3.1 type list) is read
 *   as itself alone: its variants carry none. A union of nothing fits
 *   nothing.
 * - A reference to a named union is read each way an emitter may write
 *   it, and has to fit under all of them (`FitContext.reading`): as its
 *   variants, read through the unions among them (`unionLeaves`), like an
 *   inline union; and as a model with the merge of them its `fields`
 *   carry (`modelFits`). `pet: { $ref: Cat }` fits `pet: { $ref: Shape }`
 *   over `Shape: { oneOf: [{ $ref: Cat }, { $ref: Dog }] }`; an `Other {
 *   r?: string, w?: string }` does not fit a `Shape` of the inline
 *   variants `{ r?: string }` and `{ w?: integer }`, though it fits the
 *   first, since the merge types `w` as an integer. A named union is a
 *   component any number of types can name, so each comparison with one
 *   is settled once (`settled`).
 * - A primitive fits the same primitive, and `integer` fits `number`,
 *   with the same `format` and limits at least as tight. A `format` under
 *   none, or under another, is no fit: a target language may type the two
 *   apart (`Date` beside `string`).
 * - A pinned value or an enum fits a primitive without a `format` whose
 *   type each value is of (`valueTyped`) and whose limits the declaration
 *   repeats, at least as tight, or each value is within (`valueWithin`);
 *   a pinned value that is each of its values; and an enum that lists
 *   each — an inline enum by its `values`, a component enum by the
 *   document's (`valuesOf`). A primitive never fits an enum or a pinned
 *   value: `string` does not fit `enum [cat, dog]`.
 * - A map fits a map with the same keys, by its limits and its values.
 *   An array fits an array of the same items with limits at least as
 *   tight, and no other: `Base & { tags?: 'cat'[] }` over `tags?:
 *   string[]` types `tags` as `string[] & 'cat'[]`, whose `map` and
 *   `find` read the base's element, so an array narrowed in its element
 *   is not typed as `fields` types it under an intersection.
 * - A reference to a model fits a reference to a model it carries every
 *   field of (`modelFits`).
 *
 * `limits` is what the declaration writes around a type that carries no
 * limits itself: a field's own, for a reference to an enum.
 */
function typeFits(own: TypeRef, base: TypeRef, context: FitContext, limits?: Constraints): boolean {
  if (sameType(own, base, context.byName, new Map())) return true;
  if (isUntyped(base)) return true;
  if (own.kind === 'nullable') return admitsNull(base) && typeFits(own.inner, base, context, limits);
  if (own.kind === 'union') {
    const variants = inlineVariants(own);
    return variants !== undefined && variants.every((variant) => typeFits(variant, base, context));
  }
  const mine = own.kind === 'model' ? context.byName.get(own.name) : undefined;
  if (mine && readAsUnion(mine, context)) {
    const leaves = unionLeaves(mine, context);
    if (!leaves) return false;
    return settled(mine, sideOf(base, context), context, () => leaves.every((leaf) => typeFits(leaf, base, context)));
  }
  switch (base.kind) {
    case 'nullable':
      return (own.kind === 'literal' && own.value === null) || typeFits(own, base.inner, context, limits);
    case 'union': {
      const variants = inlineVariants(base);
      return variants !== undefined && fitsOneOf(own, variants, context, limits);
    }
    case 'primitive': {
      if (own.kind === 'primitive') {
        const typed = own.type === base.type || (own.type === 'integer' && base.type === 'number');
        return typed && own.format === base.format && limitsFit(own.constraints, base.constraints);
      }
      const values = valuesOf(own, context);
      if (!values || base.format !== undefined || !values.every((value) => valueTyped(value, base))) return false;
      const declared = (own.kind === 'literal' ? own.constraints : undefined) ?? limits;
      return limitsFit(declared, base.constraints) || values.every((value) => valueWithin(value, base.constraints));
    }
    case 'literal': {
      const values = valuesOf(own, context);
      return values !== undefined && values.every((value) => value === base.value);
    }
    case 'enum': {
      const admitted = valuesOf(base, context);
      const values = valuesOf(own, context);
      return admitted !== undefined && values !== undefined && values.every((value) => admitted.includes(value));
    }
    case 'array':
      return (
        own.kind === 'array' &&
        limitsFit(own.constraints, base.constraints) &&
        sameType(own.items, base.items, context.byName, new Map())
      );
    case 'map': {
      if (own.kind !== 'map' || !limitsFit(own.constraints, base.constraints)) return false;
      if ((own.keyType === undefined) !== (base.keyType === undefined)) return false;
      if (own.keyType && base.keyType && !sameType(own.keyType, base.keyType, context.byName, new Map())) return false;
      return typeFits(own.valueType, base.valueType, context);
    }
    case 'model': {
      const theirs = context.byName.get(base.name);
      if (theirs && readAsUnion(theirs, context)) {
        const leaves = unionLeaves(theirs, context);
        if (!leaves) return false;
        return settled(mine ?? own, theirs, context, () => fitsOneOf(own, leaves, context, limits));
      }
      return mine !== undefined && theirs !== undefined && modelFits(mine, theirs, context);
    }
    default:
      return assertNever(base);
  }
}

/** Whether `own` fits one of `variants` (`typeFits`) or, for an enum, each of its values fits one: `enum [a, 1]` under `string | integer`. */
function fitsOneOf(own: TypeRef, variants: readonly TypeRef[], context: FitContext, limits?: Constraints): boolean {
  if (variants.some((variant) => typeFits(own, variant, context, limits))) return true;
  const values = own.kind === 'enum' ? valuesOf(own, context) : undefined;
  return (
    values !== undefined &&
    values.every((value) => variants.some((variant) => typeFits({ kind: 'literal', value }, variant, context, limits)))
  );
}

/** Whether the reading writes the named union `model` as the union of its variants, not as the model its `fields` are (`FitContext.reading`). */
function readAsUnion(model: Model, context: FitContext): boolean {
  if (!model.variants || context.reading === 'fields') return false;
  return context.reading === 'variants' || model.fields.length === 0;
}

/** The variants an inline union is read through (`typeFits`): none for one that carries limits of its own, which its variants do not, or for a union of nothing. */
function inlineVariants(union: UnionType): readonly TypeRef[] | undefined {
  return union.constraints === undefined && union.variants.length > 0 ? union.variants : undefined;
}

/**
 * The variants a named union is read through (`typeFits`), in a reading
 * that writes it as a union: its own, with every union among them — an
 * inline one, a named one the reading writes as a union too
 * (`readAsUnion`), either under a nullable wrapper, which adds `null` —
 * replaced by that union's in turn, so what is left names no union to
 * read further and a union that names itself, or another that names it
 * back, is read once. A union among them that carries limits of its own
 * stays as it is, to be read as itself alone. None (`undefined`) for a
 * named union that carries limits of its own or comes to nothing. Kept
 * per union (`FitContext.leaves`): unions that share their variants (`U0:
 * anyOf [U1, U2]`, `U1: anyOf [U2, U3]`, …) are each walked once, not
 * once per path that reaches them.
 */
function unionLeaves(union: Model, context: FitContext): readonly TypeRef[] | undefined {
  let leaves = context.leaves.get(union);
  if (!leaves) {
    const found: TypeRef[] = [];
    const seen = new Set<Model>([union]);
    let nullable = false;
    // What a variant is read through when it is a union to read further; `null` for one already read.
    const within = (variant: TypeRef): readonly TypeRef[] | null | undefined => {
      if (variant.kind === 'union') return inlineVariants(variant);
      const nested = variant.kind === 'model' ? context.byName.get(variant.name) : undefined;
      if (!nested?.variants || !readAsUnion(nested, context) || nested.constraints !== undefined) return undefined;
      if (seen.has(nested)) return null;
      seen.add(nested);
      return nested.variants;
    };
    const pending = union.constraints === undefined ? [...(union.variants ?? [])].reverse() : [];
    for (let variant = pending.pop(); variant; variant = pending.pop()) {
      const inner = underNullable(variant);
      const variants = within(inner);
      if (variants === undefined) {
        found.push(variant);
        continue;
      }
      if (inner !== variant) nullable = true;
      for (let index = (variants?.length ?? 0) - 1; index >= 0; index--) pending.push(variants![index]!);
    }
    if (nullable && found.length > 0) found.push({ kind: 'literal', value: null });
    context.leaves.set(union, (leaves = found));
  }
  return leaves.length > 0 ? leaves : undefined;
}

/** The side of a comparison `type` stands for (`settled`): the model it names, or the type itself when it names none. */
function sideOf(type: TypeRef, context: FitContext): Side {
  return (type.kind === 'model' ? context.byName.get(type.name) : undefined) ?? type;
}

/**
 * Whether an instance of `own` is one of `base` (`typeFits`): `own`
 * carries every field `base` ends with (`carriesEveryField`) — the test a
 * base itself passes, so a model built on `base` fits it, and so does the
 * conjunction the merge builds when the model and its base each declare
 * the property as an object, while its fields fit (`data: { $ref: Dog }`
 * over `Envelope.data: { $ref: Animal }` is a `PetData` with the fields
 * of both; see Several declarations of one property). Settled once per
 * pair of models (`settled`).
 */
function modelFits(own: Model, base: Model, context: FitContext): boolean {
  return own === base || settled(own, base, context, () => carriesEveryField(own, base, context));
}

/**
 * The verdict on a comparison any number of types can ask for — a model
 * under a model, a named union under a type, a type under a named union:
 * components, which a document names from wherever it likes — read by
 * `read`, once.
 *
 * Such a comparison can depend on others, and on itself (a model that
 * reaches itself through a field, a union through a map of itself), so
 * the comparisons one question reaches are decided together: each is
 * taken to fit until its own reading says otherwise, and one that turns
 * out not to fit sends the comparisons that read it back to be read
 * again, which leaves exactly those that fit given one another. A
 * comparison never reaches itself without passing a field or a map's
 * values (`unionLeaves` reads a union that names itself once), so taking
 * it to fit meanwhile decides nothing by itself. None is read inside
 * another — a chain of any length is walked without recursing, and
 * shared ones are not read again along every path that reaches them —
 * and a verdict, once reached, is kept for the whole run
 * (`FitContext.decided`), by the identity of its two sides.
 */
function settled(own: Side, base: Side, context: FitContext, read: () => boolean): boolean {
  const decided = context.decided.get(own)?.get(base);
  if (decided !== undefined) return decided;
  if (context.settling) return assumedToFit(context.settling, own, base, read).fits;
  const settling: Settling = { pairs: new Map(), pending: [] };
  context.settling = settling;
  try {
    const asked = assumedToFit(settling, own, base, read);
    for (let pair = settling.pending.pop(); pair; pair = settling.pending.pop()) {
      if (!pair.fits) continue;
      settling.reading = pair;
      if (pair.read()) continue;
      pair.fits = false;
      for (const reader of pair.readers) if (reader.fits) settling.pending.push(reader);
    }
    for (const [mine, pairs] of settling.pairs) {
      let known = context.decided.get(mine);
      if (!known) context.decided.set(mine, (known = new Map()));
      for (const [theirs, pair] of pairs) known.set(theirs, pair.fits);
    }
    return asked.fits;
  } finally {
    context.settling = undefined;
  }
}

/** The comparison of `own` with `base` among those being settled (`settled`): taken to fit, and noted to be read, when first met; the comparison being read is noted as one of its readers. */
function assumedToFit(settling: Settling, own: Side, base: Side, read: () => boolean): Pair {
  let pairs = settling.pairs.get(own);
  if (!pairs) settling.pairs.set(own, (pairs = new Map()));
  let pair = pairs.get(base);
  if (!pair) {
    pairs.set(base, (pair = { own, base, read, fits: true, readers: new Set() }));
    settling.pending.push(pair);
  }
  if (settling.reading) pair.readers.add(settling.reading);
  return pair;
}

/**
 * Whether `own` carries every field `base` ends with, as the same field
 * (`sameField`) or one that fits it (`fieldFits`), with model limits at
 * least as tight — one pair's own say in `modelFits`, every other pair
 * read through `settled`. A dispatcher, on either side, is read as itself alone:
 * its `fields` are not the whole of a variant, and it carries no
 * `variants` to read instead. A named union reaches here only in the
 * reading that writes it from its `fields`, as the merge of its variants
 * (`typeFits` reads its variants in the other).
 */
function carriesEveryField(own: Model, base: Model, context: FitContext): boolean {
  if ((own.discriminator && !own.variants) || (base.discriminator && !base.variants)) return false;
  if (own.typeParams || base.typeParams) return false;
  if (!limitsFit(own.constraints, base.constraints)) return false;
  const fields = new Map<string, Field>();
  for (const field of own.fields) if (!fields.has(field.name)) fields.set(field.name, field);
  return base.fields.every((field) => {
    const mine = fields.get(field.name);
    if (!mine) return false;
    return sameField(mine, field, context.byName, new Map()) || fieldFits(mine, field, context);
  });
}

/** `type` under every nullable wrapper around it (a site settled from a nullable pointer to a nullable schema wears two; #545). */
function underNullable(type: TypeRef): TypeRef {
  let inner = type;
  while (inner.kind === 'nullable') inner = inner.inner;
  return inner;
}

/** Whether `type` is an untyped schema with no limits (`{}`): the type every value is an instance of. */
function isUntyped(type: TypeRef): boolean {
  return (
    type.kind === 'primitive' && type.type === 'unknown' && type.format === undefined && type.constraints === undefined
  );
}

/** Whether `type` admits `null`: a nullable wrapper, a pinned `null`, an untyped schema, or a union with a variant that does. */
function admitsNull(type: TypeRef): boolean {
  switch (type.kind) {
    case 'nullable':
      return true;
    case 'literal':
      return type.value === null;
    case 'primitive':
      return isUntyped(type);
    case 'union':
      return type.variants.some(admitsNull);
    case 'array':
    case 'map':
    case 'enum':
    case 'model':
      return false;
    default:
      return assertNever(type);
  }
}

/**
 * The values `type` admits, when it admits a known list of them: a pinned
 * value's one, an enum's — the reference's own `values` for an inline
 * enum, the document's for a component enum (`FitContext.enumValues`) —
 * and a union's of such types together. `undefined` for any other type,
 * for an enum whose values nothing gives, and for a list of none: a type
 * that admits no value is not read as fitting.
 */
function valuesOf(type: TypeRef, context: FitContext): readonly Value[] | undefined {
  const values = listedValues(type, context);
  return values && values.length > 0 ? values : undefined;
}

/** The list `valuesOf` reads, an empty one included. */
function listedValues(type: TypeRef, context: FitContext): readonly Value[] | undefined {
  switch (type.kind) {
    case 'literal':
      return [type.value];
    case 'enum':
      return type.values ?? context.enumValues.get(type.name);
    case 'union': {
      const values: Value[] = [];
      for (const variant of type.variants) {
        const own = listedValues(variant, context);
        if (!own) return undefined;
        values.push(...own);
      }
      return values;
    }
    case 'primitive':
    case 'array':
    case 'map':
    case 'nullable':
    case 'model':
      return undefined;
    default:
      return assertNever(type);
  }
}

/** Whether `value` is of the primitive `base`'s type: a string of `string`, an integer of `integer` and of `number`, any value of an untyped schema. */
function valueTyped(value: Value, base: PrimitiveType): boolean {
  if (base.type === 'unknown') return true;
  if (base.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === base.type;
}

/**
 * Whether `value` is within `limits`: a string's length (in characters,
 * as JSON Schema counts them) within `minLength` and `maxLength`, a
 * number within the four bounds. Any other keyword — `pattern`, which
 * would have to be compiled from the document's text, `multipleOf`, a
 * keyword of another type — is not evaluated, and is no fit.
 */
function valueWithin(value: Value, limits: Constraints | undefined): boolean {
  if (!limits) return true;
  return (Object.keys(limits) as Array<keyof Constraints>).every((key) => {
    const limit = limits[key];
    if (limit === undefined) return true;
    if (typeof limit !== 'number') return false;
    if (typeof value === 'string') {
      if (key === 'minLength') return [...value].length >= limit;
      if (key === 'maxLength') return [...value].length <= limit;
    }
    if (typeof value === 'number') {
      if (key === 'minimum') return value >= limit;
      if (key === 'maximum') return value <= limit;
      if (key === 'exclusiveMinimum') return value > limit;
      if (key === 'exclusiveMaximum') return value < limit;
    }
    return false;
  });
}

/** The keywords that bound a value from above, and from below, by one number: the tighter bound is the lower, and the higher. */
const UPPER_LIMITS: ReadonlySet<keyof Constraints> = new Set(['maxLength', 'maxItems', 'maxProperties']);
const LOWER_LIMITS: ReadonlySet<keyof Constraints> = new Set(['minLength', 'minItems', 'minProperties']);

/**
 * Whether the limits `own` are at least as tight as `base`: every keyword
 * `base` declares is on `own` with a bound no looser — `maxLength: 3`
 * under `maxLength: 5`; an inclusive bound beside an exclusive one read
 * as the interval it leaves, so `maximum: 5` fits `exclusiveMaximum: 6`
 * and `maximum: 6` does not — or, for a keyword that is no single bound
 * (`pattern`, `multipleOf`, `uniqueItems`, `minContains`, `maxContains`,
 * `dependentRequired`), with the same value. A keyword only `own`
 * declares narrows, and fits.
 */
function limitsFit(own: Constraints | undefined, base: Constraints | undefined): boolean {
  if (!base) return true;
  const mine: Constraints = own ?? {};
  const atMost = (bound: number | undefined, limit: number) => bound !== undefined && bound <= limit;
  const atLeast = (bound: number | undefined, limit: number) => bound !== undefined && bound >= limit;
  return (Object.keys(base) as Array<keyof Constraints>).every((key) => {
    const limit = base[key];
    if (limit === undefined) return true;
    if (typeof limit === 'number') {
      if (key === 'maximum') return atMost(mine.maximum, limit) || atMost(mine.exclusiveMaximum, limit);
      if (key === 'exclusiveMaximum') {
        return atMost(mine.exclusiveMaximum, limit) || (mine.maximum !== undefined && mine.maximum < limit);
      }
      if (key === 'minimum') return atLeast(mine.minimum, limit) || atLeast(mine.exclusiveMinimum, limit);
      if (key === 'exclusiveMinimum') {
        return atLeast(mine.exclusiveMinimum, limit) || (mine.minimum !== undefined && mine.minimum > limit);
      }
      if (UPPER_LIMITS.has(key)) return atMost(mine[key] as number | undefined, limit);
      if (LOWER_LIMITS.has(key)) return atLeast(mine[key] as number | undefined, limit);
    }
    return stableStringify(mine[key]) === stableStringify(limit);
  });
}
