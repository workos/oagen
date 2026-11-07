import type { Field, Model } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';
import { stableStringify, typeShapeKey } from './inline-models.js';
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
 *    one the model carries: same keys, same values, the type read with the
 *    inheriting model's name standing for the base's where an inline model
 *    is built under it (`PetMeta` for `AnimalMeta`; a reference to a
 *    component is read as written). A fold that loosens a base after the
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
        if (!inherited || fieldKey(field, model.name, target.name) !== fieldKey(inherited, target.name, target.name)) {
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
 * A field as it compares with the base's (step 3): every key but
 * `inheritedFrom`, the type read with `under` — the model the field sits
 * on — standing for `as` in the name of every inline model built under it
 * (`PetMeta` read as `AnimalMeta`), a reference to a component kept as
 * written (`isComponentModelRef`).
 */
function fieldKey(field: Field, under: string, as: string): string {
  const { inheritedFrom: _origin, type, ...rest } = field;
  const components = new Set<string>();
  walkTypeRef(type, {
    model: (ref) => {
      if (isComponentModelRef(ref)) components.add(ref.name);
    },
  });
  const readModelName = (name: string): string =>
    !components.has(name) && name.startsWith(under) ? `${as}${name.slice(under.length)}` : name;
  return stableStringify({ ...rest, type: typeShapeKey(type, { readModelName }) });
}
