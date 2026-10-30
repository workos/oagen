import type { Field, Model, TypeRef } from '../ir/types.js';
import { assertNever, collectModelRefs, renameModelRefs, renameTypeRefModels } from '../ir/types.js';
import {
  deprecatedFoldWarning,
  fieldPropertiesAdmit,
  fieldPropertiesKey,
  flagAdmits,
  looserFields,
  modelPropertiesAdmit,
  modelPropertiesKey,
  type InlineModelBundle,
} from './inline-models.js';
import { enumShapeKey, enumValueShapeKey, enumValuesOf } from './enum-members.js';
import { unionRulesKey, unionShapeKey } from './union-shape.js';

/**
 * A list-envelope companion that was lifted to one or more inline models:
 * `field` is the envelope field (shared by identity with
 * `Operation.pagination.envelopeFields`), `models[0]` is the companion's own
 * model and the rest are models nested inside it. Every model is named under
 * the operation (`ListUsersListMetadata`); `bareNames[i]` is the name
 * `models[i]` would carry if it were named from its property alone
 * (`ListMetadata`).
 */
export interface EnvelopeCompanion {
  field: Field;
  models: Model[];
  bareNames: string[];
}

/**
 * Decide the final name of every lifted companion model, across all list
 * operations at once, and return the models to merge into the IR.
 *
 * The same envelope recurs on every list endpoint of an API, so naming each
 * copy after its operation would mint one identical `ListMetadata` per
 * endpoint. But naming by property alone is only safe while the copies agree:
 * among inline models `mergeInlineResponseModels` keeps the largest model of
 * a name, so a `pagination` with three fields would absorb another endpoint's
 * two-field `pagination`, and one named like a `Pagination` component that
 * does not admit it would be moved to an operation-qualified name by the
 * merge rather than by this pass.
 *
 * So a companion takes its bare name only when that cannot change any other
 * type's shape:
 *
 * Copies are compared structurally — field names, requiredness and each
 * field's shape, with nested models resolved and inline enums compared by
 * value — never by name alone. A copy collapses onto a target shape only when
 * the target *admits* every value the copy can hold: the same fields with the
 * same types, where the target may be looser (a field the copy requires may be
 * optional on the target, a non-null copy field may be nullable there) but
 * never stricter. Widening a response type loses no data a reader can see;
 * narrowing it would promise fields the wire may omit.
 *
 * - When a component model of that name exists — compared after the parser's
 *   own renaming, so `PaginationDto` → `Pagination` is caught — the copies it
 *   admits collapse onto it (the component stays as written); the others keep
 *   their operation-qualified name.
 * - Otherwise the most common exact shape (first declared, on a tie) becomes
 *   the target: it and every copy it admits take the bare name; any other
 *   copy keeps its operation-qualified name.
 * - `deprecated` is part of a copy's shape among copies, so deprecation never
 *   reaches a live operation and never depends on document order: a copy
 *   folds onto another copy's definition only with the same flag, and while
 *   any live copy exists the target is chosen among the live copies, so a
 *   deprecated copy keeps its operation-qualified name
 *   (`ListLegacyUsersListMetadata`). Only when every copy is deprecated does
 *   a deprecated shape take the bare name. Beside a component, the
 *   companion's own flag is read as every declared model reads it
 *   (`flagAdmits`): a live component admits a deprecated companion — the
 *   envelope field keeps the flag the schema wrote (`Field.deprecated`), so
 *   nothing is lost — with the warning the merge passes give such a copy,
 *   and a deprecated component only a deprecated one. A model nested in the
 *   companion still folds only onto a component of the same flag; the
 *   model's own properties beside the flag — its limits (`minProperties`,
 *   `dependentRequired`, …), type parameters, whatever else the IR adds —
 *   are read as every component fold reads them (`modelPropertiesAdmit`):
 *   identical, so a companion declaring `minProperties: 1` never shares a
 *   component declaring `2`, nor the reverse; and every field is read in
 *   everything but its type as `fieldAdmits` reads it
 *   (`fieldPropertiesAdmit`): its own flag must agree in either direction,
 *   the target may be looser on requiredness only, and limits, default,
 *   access flags and every other property must be identical, since the
 *   target's definition is what every site reads after the fold — a
 *   companion whose `next` is deprecated, or allows 64 characters, never
 *   shares a component whose `next` is live, or allows 8, nor the other way
 *   round, flag or no flag on the root. Among copies the same properties are
 *   part of the shape (`modelPropertiesKey`, `fieldPropertiesKey`), so a
 *   copy that deprecates or limits itself or a field as the others do not
 *   keeps its own name.
 *
 * The comparison covers the companion's whole field type, so a `oneOf`
 * companion is judged on every variant, not just the first, and a copy folds
 * among copies only when its lifted models line up name for name with the
 * target's (same variants, same order); onto a component, only a companion
 * whose field references exactly its own lifted model can fold.
 *
 * Only the target's definition survives a collapse. The admitted copies'
 * models are dropped rather than handed to the merge pass, which keeps the
 * first model of a name and would let a stricter copy declared earlier
 * narrow the shared type for everyone; their field references are repointed
 * at the target's models instead.
 *
 * Enums declared inline in a companion stay operation-qualified, exactly like
 * enums declared inline in a parameter.
 *
 * `foldedOnto`, when given, receives every copy that folded onto another
 * companion's definition, keyed to that companion (a copy folded onto a
 * component is not recorded: nothing of it is emitted), so the caller can
 * tell which envelope fields a surviving companion's models serve
 * (`companionBundles`).
 */
export function resolveEnvelopeCompanionNames(
  companions: EnvelopeCompanion[],
  componentModels?: Model[],
  foldedOnto?: Map<EnvelopeCompanion, EnvelopeCompanion>,
): Model[] {
  const byBareName = new Map<string, EnvelopeCompanion[]>();
  /** Copies folded onto another definition; their own models are not emitted. */
  const folded = new Set<EnvelopeCompanion>();
  for (const companion of companions) {
    if (companion.models.length === 0) continue;
    const bare = companion.bareNames[0];
    const group = byBareName.get(bare) ?? [];
    group.push(companion);
    byBareName.set(bare, group);
  }

  const componentMap = new Map((componentModels ?? []).map((m) => [m.name, m]));
  const localMap = (c: EnvelopeCompanion): Map<string, Model> => new Map(c.models.map((m) => [m.name, m]));
  // A folded copy keeps its own field wrapper and only its references move, so
  // whether the envelope field itself is nullable has no bearing on folding.
  const unwrap = (t: TypeRef): TypeRef => (t.kind === 'nullable' ? t.inner : t);

  for (const [bare, group] of byBareName) {
    // What every copy is measured against: a field type, the map its model
    // references resolve through (a component through the other components, a
    // copy through its own models), and the names a folded copy's references
    // are repointed to.
    let folds: (c: EnvelopeCompanion) => boolean;
    let finalNames: string[];
    let owner: EnvelopeCompanion | undefined;

    const component = componentMap.get(bare);
    if (component) {
      const targetType: TypeRef = { kind: 'model', name: component.name };
      finalNames = [component.name];
      folds = (c) => {
        // Only a field that references exactly its own lifted model can be
        // repointed at the component; a union of variants has nowhere to go.
        const own = c.models[0]!;
        const refs = collectModelRefs(c.field.type);
        if (refs.length !== 1 || refs[0] !== own.name) return false;
        // The companion's own flag is read by `flagAdmits`, apart from its
        // shape: a deprecated companion is compared with a live component
        // as if live, since its envelope field keeps the flag. Its nested
        // models are compared with theirs (`admits`), flag included.
        if (!flagAdmits(component, own)) return false;
        const local = localMap(c);
        if (own.deprecated && !component.deprecated) local.set(own.name, { ...own, deprecated: undefined });
        return typeAdmits(targetType, componentMap, unwrap(c.field.type), local, new Set());
      };
    } else {
      const counts = new Map<string, { n: number; first: EnvelopeCompanion }>();
      // The bare name is owned by a live copy while one exists: a deprecated
      // copy keeps its operation-qualified name rather than deprecating the
      // name every live operation shares.
      const live = group.filter((c) => !c.models[0].deprecated);
      const candidates = live.length > 0 ? live : group;
      for (const c of candidates) {
        const key = `${fingerprintType(unwrap(c.field.type), localMap(c), new Set())}|${c.bareNames.join(',')}`;
        const seen = counts.get(key);
        if (seen) seen.n += 1;
        else counts.set(key, { n: 1, first: c });
      }
      let best = { n: 0, first: candidates[0] };
      for (const entry of counts.values()) if (entry.n > best.n) best = entry;
      owner = best.first;
      finalNames = owner.bareNames;
      const ownerType = unwrap(owner.field.type);
      const ownerMap = localMap(owner);
      const ownerNames = owner.bareNames;
      folds = (c) =>
        c.bareNames.length === ownerNames.length &&
        c.bareNames.every((name, i) => name === ownerNames[i]) &&
        typeAdmits(ownerType, ownerMap, unwrap(c.field.type), localMap(c), new Set());
    }

    // Decide every copy before renaming any: renaming the target repoints its
    // nested references to the bare names, which its map no longer resolves.
    const collapsing = group.filter(folds);
    for (const companion of collapsing) {
      // A deprecated copy a live component admits is announced once per
      // companion, as the merge passes announce one (`settleSharedNames`),
      // with what the component, when looser, no longer holds the copy to.
      if (component && !component.deprecated && companion.models[0]!.deprecated) {
        console.warn(deprecatedFoldWarning(component.name, looserThanCompanion(component, componentMap, companion)));
      }
      renameCompanion(companion, finalNames);
      if (companion !== owner) {
        folded.add(companion);
        if (owner) foldedOnto?.set(companion, owner);
      }
    }
  }

  return companions.filter((c) => !folded.has(c)).flatMap((c) => c.models);
}

/**
 * One site (`InlineModelBundle`) per companion that kept its models after
 * `resolveEnvelopeCompanionNames`: the envelope field that lifted it, plus
 * the envelope field of every copy that folded onto it (`foldedOnto`) — those
 * fields were repointed at its models and reference nothing else — so a merge
 * pass that later renames one of its models (a deprecated companion named
 * like a live component field's model, say) repoints every operation that
 * shares it, and nothing else. `survivingModels` is what the resolver
 * returned; a companion is a survivor when its own model is among them.
 * `qualifiers` gives each companion the stem the models of the operation
 * that lifted it are named from (`ListUsers`, or `UsersGet` for `GET /users`
 * without an `operationId`), to prefix a renamed model with.
 */
export function companionBundles(
  companions: EnvelopeCompanion[],
  survivingModels: Model[],
  foldedOnto: ReadonlyMap<EnvelopeCompanion, EnvelopeCompanion>,
  qualifiers: ReadonlyMap<EnvelopeCompanion, string>,
): InlineModelBundle[] {
  const surviving = new Set(survivingModels);
  const bundles: InlineModelBundle[] = [];
  for (const companion of companions) {
    const own = companion.models[0];
    if (!own || !surviving.has(own)) continue;
    const sharers = companions.filter((c) => foldedOnto.get(c) === companion);
    bundles.push({
      qualifier: qualifiers.get(companion) ?? '',
      roots: [companion.field.type, ...sharers.map((c) => c.field.type)],
      models: companion.models,
    });
  }
  return bundles;
}

/**
 * Rename a companion's models to `names` (index-aligned with `models`) and
 * repoint every reference, in its field and inside its models — a union
 * companion's discriminator mapping with its variants (`renameTypeRefModels`).
 */
function renameCompanion(companion: EnvelopeCompanion, names: string[]): void {
  const renames = new Map<string, string>();
  companion.models.forEach((model, i) => {
    const name = names[i];
    if (name !== undefined && model.name !== name) renames.set(model.name, name);
  });
  if (renames.size === 0) return;

  renameTypeRefModels(companion.field.type, renames);
  for (const model of companion.models) {
    model.name = renames.get(model.name) ?? model.name;
    renameModelRefs(model, renames);
  }
}

/**
 * How `component` is looser than `companion`'s own model, which it admits
 * (`admits`), for the warning the fold is announced with
 * (`deprecatedFoldWarning`): what `modelAdmits` would read on the fields
 * themselves (`looserFields`: a field the companion requires, a type it
 * leaves non-null), then each field whose type the component loosens below
 * its own nullable wrapper — a nested model's requiredness or null, an
 * enum's members (`loosens "cursor"`). The component admits each type, so
 * one that admits the component's back (`typeAdmits`, read the other way
 * round) is the same shape. Empty when the two are the same shape but for
 * the flag.
 */
function looserThanCompanion(
  component: Model,
  componentMap: Map<string, Model>,
  companion: EnvelopeCompanion,
): string[] {
  const own = companion.models[0]!;
  const local = new Map(companion.models.map((m) => [m.name, m]));
  const inner = (type: TypeRef): TypeRef => (type.kind === 'nullable' ? type.inner : type);
  const targets = new Map(component.fields.map((field) => [field.name, field]));
  const deeper = own.fields
    .filter((field) => {
      const target = targets.get(field.name);
      return target !== undefined && !typeAdmits(inner(field.type), local, inner(target.type), componentMap, new Set());
    })
    .map((field) => `"${field.name}"`);
  return [...looserFields(component, own), ...(deeper.length > 0 ? [`loosens ${deeper.join(', ')}`] : [])];
}

/**
 * Whether `target` admits every value `copy` can hold: the same field names,
 * each field's type admitted (see `typeAdmits`), and no field the target
 * requires that the copy leaves optional. Nested models resolve through their
 * respective maps and are compared the same way; a model neither map resolves
 * is compared by name.
 */
function admits(
  target: Model,
  targetMap: Map<string, Model>,
  copy: Model,
  copyMap: Map<string, Model>,
  visiting: Set<string>,
): boolean {
  const key = `${target.name}|${copy.name}`;
  if (visiting.has(key)) return true;
  visiting.add(key);
  try {
    // Deprecation is part of the shape among copies: a live target must not
    // absorb a deprecated copy (its flag would vanish), and a deprecated
    // target must not absorb a live one (a live operation would then
    // reference it). Beside a component the caller has already read the
    // root flag by `flagAdmits` and stripped it from the copy.
    if (!!target.deprecated !== !!copy.deprecated) return false;
    // Every other property of the model itself — its limits
    // (`minProperties`, `dependentRequired`, …), type parameters, whatever
    // else the IR adds — is read as every component fold reads it
    // (`modelPropertiesAdmit`): identical, since the target's definition is
    // what every site reads after a fold.
    if (!modelPropertiesAdmit(target, copy)) return false;
    if (target.fields.length !== copy.fields.length) return false;
    const targetFields = new Map(target.fields.map((f) => [f.name, f]));
    for (const field of copy.fields) {
      const expected = targetFields.get(field.name);
      if (!expected) return false;
      // Everything but the type is read as `fieldAdmits` reads it
      // (`fieldPropertiesAdmit`): the flag agrees in either direction, the
      // target is no stricter on requiredness, and limits, default, access
      // flags and every other property are identical — the target's fields
      // are what every site reads after a fold. The type is compared by
      // structure below, since a companion's nested models and inline enums
      // are named per operation.
      if (!fieldPropertiesAdmit(expected, field)) return false;
      if (!typeAdmits(expected.type, targetMap, field.type, copyMap, visiting)) return false;
    }
    // A named union is its variants — the same ones, in the same order —
    // dispatched by the same rules (composition keyword, discriminator).
    if (unionRulesKey(target) !== unionRulesKey(copy)) return false;
    const targetVariants = target.variants ?? [];
    const copyVariants = copy.variants ?? [];
    if (targetVariants.length !== copyVariants.length) return false;
    for (let i = 0; i < copyVariants.length; i++) {
      if (!typeAdmits(targetVariants[i]!, targetMap, copyVariants[i]!, copyMap, visiting)) return false;
    }
    return true;
  } finally {
    visiting.delete(key);
  }
}

/**
 * Whether `target` admits every value of `copy`'s type. A nullable target
 * admits a nullable or a non-null copy; a non-null target admits only a
 * non-null copy. An enum with known values admits a copy whose members are a
 * subset of its own — a member being a value with its deprecation
 * (`enumValueShapeKey`), so a copy deprecating a value the target does not
 * is not admitted. Everything else must match exactly, by fingerprint.
 */
function typeAdmits(
  target: TypeRef,
  targetMap: Map<string, Model>,
  copy: TypeRef,
  copyMap: Map<string, Model>,
  visiting: Set<string>,
): boolean {
  if (target.kind === 'nullable') {
    return typeAdmits(target.inner, targetMap, copy.kind === 'nullable' ? copy.inner : copy, copyMap, visiting);
  }
  if (copy.kind === 'nullable') return false;
  if (target.kind !== copy.kind) return false;
  switch (target.kind) {
    case 'model': {
      const t = targetMap.get(target.name);
      const c = copyMap.get((copy as typeof target).name);
      if (t && c) return admits(t, targetMap, c, copyMap, visiting);
      return target.name === (copy as typeof target).name;
    }
    case 'array':
      return typeAdmits(target.items, targetMap, (copy as typeof target).items, copyMap, visiting);
    case 'enum': {
      const c = copy as typeof target;
      if (target.values && c.values) {
        const allowed = new Set(enumValuesOf(target).map(enumValueShapeKey));
        return enumValuesOf(c).every((v) => allowed.has(enumValueShapeKey(v)));
      }
      return target.name === c.name;
    }
    default:
      return fingerprintType(target, targetMap, new Set()) === fingerprintType(copy, copyMap, new Set());
  }
}

/**
 * Structural fingerprint of a companion model: the model's own properties as
 * `modelPropertiesAdmit` reads them (`modelPropertiesKey`: whether it is
 * deprecated, its limits, its type parameters), its field names, each
 * field's properties as `fieldPropertiesAdmit` reads them
 * (`fieldPropertiesKey`: requiredness, its own deprecation, limits, default,
 * access flags) and each field's shape, with models nested
 * inside the companion compared by shape rather than by (operation-qualified)
 * name, and inline enums compared by their members — each value with its
 * deprecation (`enumValueShapeKey`), so a copy deprecating a value the others
 * do not keeps its own name, as a deprecated copy of a model does. Models
 * outside the companion are compared by name.
 */
function fingerprintModel(model: Model, local: Map<string, Model>, visiting: Set<string>): string {
  if (visiting.has(model.name)) return `rec:${model.name}`;
  visiting.add(model.name);
  const fields = [...model.fields]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}${fieldPropertiesKey(f)}:${fingerprintType(f.type, local, visiting)}`);
  // A named union's variants, in document order, and its dispatch rules are
  // part of its shape.
  const union = unionShapeKey(model, (v) => fingerprintType(v, local, visiting));
  visiting.delete(model.name);
  return `${modelPropertiesKey(model)}{${fields.join(',')}}${union}`;
}

function fingerprintType(ref: TypeRef, local: Map<string, Model>, visiting: Set<string>): string {
  switch (ref.kind) {
    case 'primitive':
      return `p:${ref.type}${ref.format ? `:${ref.format}` : ''}`;
    case 'literal':
      return `l:${typeof ref.value}:${String(ref.value)}`;
    case 'nullable':
      return `n<${fingerprintType(ref.inner, local, visiting)}>`;
    case 'array':
      return `a<${fingerprintType(ref.items, local, visiting)}>`;
    case 'map':
      return `m<${ref.keyType ? `${fingerprintType(ref.keyType, local, visiting)},` : ''}${fingerprintType(ref.valueType, local, visiting)}>`;
    case 'union':
      return `u:${ref.compositionKind ?? ''}<${ref.variants
        .map((v) => fingerprintType(v, local, visiting))
        .sort()
        .join(',')}>`;
    case 'enum':
      return ref.values ? `e<${enumShapeKey(enumValuesOf(ref))}>` : `e:${ref.name}`;
    case 'model': {
      const nested = local.get(ref.name);
      return nested ? fingerprintModel(nested, local, visiting) : `ref:${ref.name}`;
    }
    default:
      return assertNever(ref);
  }
}
