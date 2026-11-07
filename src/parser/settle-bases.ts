import type {
  ArrayType,
  EnumRef,
  Field,
  MapType,
  Model,
  ModelRef,
  NullableType,
  TypeRef,
  UnionType,
} from '../ir/types.js';
import { assertNever } from '../ir/types.js';
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
 * 3. A base is a base only while every field it ends with is on the model,
 *    and a field carries `inheritedFrom` only while the base's field is the
 *    one the model carries: same keys, same values, the type read as its
 *    final shape — an inline model built under either model (`PetMeta`,
 *    `AnimalMeta`) as it ends, an inline enum by its values, a component
 *    by name (`sameField`). A fold that loosens a base after the
 *    model took its fields — `AnimalJson` declaring `name` optional beside
 *    `extra`, folded onto an `Animal` requiring `name`, under `Pet: { allOf:
 *    [{ $ref: Animal }] }` — leaves `Pet.name` required and `Pet` without
 *    `extra`, so `Animal` is no base of `Pet` as it ends and `name` is
 *    `Pet`'s own; an emitter writing `Pet extends Animal` would otherwise
 *    make `name` optional and add `extra`.
 *
 * A base no model carries (a dangling reference) is left for
 * `validateModelRefs` to report.
 */
export function settleBases(models: readonly Model[]): void {
  const byName = new Map(models.map((model) => [model.name, model]));
  dropCircularBases(models, byName);
  for (const model of models) {
    if (!model.bases) continue;
    dedupeBases(model);
    const entries = model.bases.slice();
    for (const base of entries) {
      const target = base.kind === 'model' ? byName.get(base.name) : undefined;
      if (!target) continue;
      if (target.fields.some((field) => !model.fields.some((own) => own.name === field.name))) {
        dropBase(model, target.name);
        continue;
      }
      for (const field of model.fields) {
        if (field.inheritedFrom?.kind !== 'model' || field.inheritedFrom.name !== target.name) continue;
        const inherited = target.fields.find((own) => own.name === field.name);
        if (!inherited || !sameField(field, inherited, byName, new Map())) {
          delete field.inheritedFrom;
        }
      }
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
      const { variants: _va, ...restA } = a;
      const { variants: _vb, ...restB } = other;
      if (stableStringify(restA) !== stableStringify(restB)) return false;
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
  const { name: _nameA, bases: _basesA, fields: fieldsA, variants: variantsA, ...restA } = a;
  const { name: _nameB, bases: _basesB, fields: fieldsB, variants: variantsB, ...restB } = b;
  if (stableStringify(restA) !== stableStringify(restB)) return false;
  if (fieldsA.length !== fieldsB.length) return false;
  const byField = new Map(fieldsB.map((field) => [field.name, field]));
  for (const field of fieldsA) {
    const other = byField.get(field.name);
    if (!other || !sameField(field, other, byName, seen)) return false;
  }
  if ((variantsA === undefined) !== (variantsB === undefined)) return false;
  return !variantsA || !variantsB || sameTypes(variantsA, variantsB, byName, seen);
}
