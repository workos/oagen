import type { Field, Model, TypeRef } from '../ir/types.js';
import { assertNever, walkTypeRef } from '../ir/types.js';
import type { SchemaObject } from './schemas.js';

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
 * - When a component schema of that name exists, the copies whose field names
 *   match the component's collapse onto it (the component stays as written);
 *   the others keep their operation-qualified name.
 * - Otherwise the copies are fingerprinted structurally. The most common shape
 *   (first declared, on a tie) takes the bare name and the merge pass folds the
 *   identical copies onto one model; any copy with a different shape keeps its
 *   operation-qualified name.
 *
 * Enums declared inline in a companion stay operation-qualified, exactly like
 * enums declared inline in a parameter.
 */
export function resolveEnvelopeCompanionNames(
  companions: EnvelopeCompanion[],
  componentSchemas?: Record<string, SchemaObject>,
): Model[] {
  const byBareName = new Map<string, EnvelopeCompanion[]>();
  for (const companion of companions) {
    if (companion.models.length === 0) continue;
    const bare = companion.bareNames[0];
    const group = byBareName.get(bare) ?? [];
    group.push(companion);
    byBareName.set(bare, group);
  }

  for (const [bare, group] of byBareName) {
    const component = componentSchemas?.[bare];
    const componentFields = component ? componentFieldNames(component) : undefined;

    let takesBareName: (companion: EnvelopeCompanion) => boolean;
    if (component) {
      // Unknown component shape (built from $refs) → never collapse onto it.
      takesBareName = (c) =>
        componentFields !== undefined && sameSet(new Set(c.models[0].fields.map((f) => f.name)), componentFields);
    } else {
      const counts = new Map<string, number>();
      const fingerprints = new Map<EnvelopeCompanion, string>();
      for (const c of group) {
        const fp = fingerprintModel(c.models[0], new Map(c.models.map((m) => [m.name, m])), new Set());
        fingerprints.set(c, fp);
        counts.set(fp, (counts.get(fp) ?? 0) + 1);
      }
      let winner = '';
      let best = 0;
      for (const [fp, n] of counts) {
        if (n > best) [winner, best] = [fp, n];
      }
      takesBareName = (c) => fingerprints.get(c) === winner;
    }

    for (const companion of group) {
      if (takesBareName(companion)) renameCompanion(companion);
    }
  }

  return companions.flatMap((c) => c.models);
}

/** Rename a companion's models to their bare names and repoint every reference. */
function renameCompanion(companion: EnvelopeCompanion): void {
  const renames = new Map<string, string>();
  companion.models.forEach((model, i) => {
    if (model.name !== companion.bareNames[i]) renames.set(model.name, companion.bareNames[i]);
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
 * Field names a component declares directly or through inline `allOf`
 * branches; `undefined` when a `$ref` branch makes the shape unknowable here.
 */
function componentFieldNames(schema: SchemaObject): Set<string> | undefined {
  const names = new Set<string>(Object.keys(schema.properties ?? {}));
  for (const sub of schema.allOf ?? []) {
    if (sub.$ref) return undefined;
    for (const name of Object.keys(sub.properties ?? {})) names.add(name);
  }
  return names;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
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
  visiting.delete(model.name);
  return `{${fields.join(',')}}`;
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
