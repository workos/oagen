import type { Field, Model, TypeRef } from '../ir/types.js';
import { assertNever, collectModelRefs, walkTypeRef } from '../ir/types.js';

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
 * `mergeInlineResponseModels` keeps the largest model of a name, so a
 * `pagination` with three fields would silently replace an unrelated
 * `Pagination` component, or absorb another endpoint's two-field `pagination`.
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
 */
export function resolveEnvelopeCompanionNames(companions: EnvelopeCompanion[], componentModels?: Model[]): Model[] {
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
        const refs = collectModelRefs(c.field.type);
        if (refs.length !== 1 || refs[0] !== c.models[0].name) return false;
        return typeAdmits(targetType, componentMap, unwrap(c.field.type), localMap(c), new Set());
      };
    } else {
      const counts = new Map<string, { n: number; first: EnvelopeCompanion }>();
      for (const c of group) {
        const key = `${fingerprintType(unwrap(c.field.type), localMap(c), new Set())}|${c.bareNames.join(',')}`;
        const seen = counts.get(key);
        if (seen) seen.n += 1;
        else counts.set(key, { n: 1, first: c });
      }
      let best = { n: 0, first: group[0] };
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
      renameCompanion(companion, finalNames);
      if (companion !== owner) folded.add(companion);
    }
  }

  return companions.filter((c) => !folded.has(c)).flatMap((c) => c.models);
}

/**
 * Rename a companion's models to `names` (index-aligned with `models`) and
 * repoint every reference, in its field and inside its models.
 */
function renameCompanion(companion: EnvelopeCompanion, names: string[]): void {
  const renames = new Map<string, string>();
  companion.models.forEach((model, i) => {
    const name = names[i];
    if (name !== undefined && model.name !== name) renames.set(model.name, name);
  });
  if (renames.size === 0) return;

  const repoint = (ref: TypeRef): void => {
    walkTypeRef(ref, {
      model: (r) => {
        const renamed = renames.get(r.name);
        if (renamed !== undefined) (r as { name: string }).name = renamed;
      },
    });
  };
  repoint(companion.field.type);
  for (const model of companion.models) {
    model.name = renames.get(model.name) ?? model.name;
    for (const field of model.fields) repoint(field.type);
  }
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
    if (target.fields.length !== copy.fields.length) return false;
    const targetFields = new Map(target.fields.map((f) => [f.name, f]));
    for (const field of copy.fields) {
      const expected = targetFields.get(field.name);
      if (!expected) return false;
      if (expected.required && !field.required) return false;
      if (!typeAdmits(expected.type, targetMap, field.type, copyMap, visiting)) return false;
    }
    // A named union is its variants: the same ones, in the same order.
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
 * non-null copy. An enum with known values admits a copy whose values are a
 * subset of its own. Everything else must match exactly, by fingerprint.
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
        const allowed = new Set(target.values.map((v) => `${typeof v}:${String(v)}`));
        return c.values.every((v) => allowed.has(`${typeof v}:${String(v)}`));
      }
      return target.name === c.name;
    }
    default:
      return fingerprintType(target, targetMap, new Set()) === fingerprintType(copy, copyMap, new Set());
  }
}

/**
 * Structural fingerprint of a companion model: field names, requiredness, and
 * each field's shape, with models nested inside the companion compared by
 * shape rather than by (operation-qualified) name, and inline enums compared
 * by their values. Models outside the companion are compared by name.
 */
function fingerprintModel(model: Model, local: Map<string, Model>, visiting: Set<string>): string {
  if (visiting.has(model.name)) return `rec:${model.name}`;
  visiting.add(model.name);
  const fields = [...model.fields]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}${f.required ? '!' : '?'}:${fingerprintType(f.type, local, visiting)}`);
  // A named union's variants are part of its shape, in document order.
  const variants = (model.variants ?? []).map((v) => fingerprintType(v, local, visiting));
  visiting.delete(model.name);
  return `{${fields.join(',')}}${variants.length > 0 ? `|${model.compositionKind ?? ''}<${variants.join(',')}>` : ''}`;
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
      return ref.values
        ? `e<${[...ref.values]
            .map((v) => `${typeof v}:${String(v)}`)
            .sort()
            .join('|')}>`
        : `e:${ref.name}`;
    case 'model': {
      const nested = local.get(ref.name);
      return nested ? fingerprintModel(nested, local, visiting) : `ref:${ref.name}`;
    }
    default:
      return assertNever(ref);
  }
}
