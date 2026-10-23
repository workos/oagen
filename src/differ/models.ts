import type { Model, TypeRef } from '../ir/types.js';
import { assertNever } from '../ir/types.js';
import type { Change, FieldChange, VariantChange } from './types.js';
import { classifyFieldChange, deprecationDetails, deprecationFlip, extensionsShift } from './classify.js';
import type { DirectionIndex, ModelDirection } from './direction.js';
import { directionOf } from './direction.js';

/**
 * `directions` (from `buildDirectionIndex`) lets requiredness changes be judged
 * against the side of the wire each model is used on. Omit it and every model is
 * treated as unknown-direction, i.e. the conservative classification.
 */
export function diffModels(oldModels: Model[], newModels: Model[], directions?: DirectionIndex): Change[] {
  const changes: Change[] = [];
  const oldByName = new Map(oldModels.map((m) => [m.name, m]));
  const newByName = new Map(newModels.map((m) => [m.name, m]));

  for (const [name] of newByName) {
    if (!oldByName.has(name)) {
      changes.push({ kind: 'model-added', name, classification: 'additive' });
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push({ kind: 'model-removed', name, classification: 'breaking' });
    }
  }

  for (const [name, newModel] of newByName) {
    const oldModel = oldByName.get(name);
    if (!oldModel) continue;

    const fieldChanges = diffFields(oldModel, newModel, directionOf(directions, name));
    const variantChanges = diffVariants(oldModel, newModel);
    // A flipped flag alone is a change: nothing the model's callers compile
    // against moves, but a changelog has to say it.
    const deprecation = deprecationFlip(oldModel, newModel);
    // So is a change to the model's own extensions, which are not shape
    // either; the flag is present only when they differ (`extensionsShift`).
    const extensions = extensionsShift(oldModel, newModel);
    if (fieldChanges.length > 0 || variantChanges.length > 0 || deprecation || extensions) {
      const hasBreaking = [...fieldChanges, ...variantChanges].some((c) => c.classification === 'breaking');
      changes.push({
        kind: 'model-modified',
        name,
        fieldChanges,
        ...(variantChanges.length > 0 ? { variantChanges } : {}),
        deprecatedChanged: deprecation !== undefined,
        ...deprecation,
        ...(extensions ? { extensionsChanged: true, ...extensions } : {}),
        classification: hasBreaking ? 'breaking' : 'additive',
      });
    }
  }

  return changes;
}

/**
 * Changes to a named union's `variants` and `discriminator`. A variant is
 * matched by type equality (`typeRefsEqual`), not by position, so reordering
 * reports nothing. A model whose `variants` is absent while its discriminator
 * mapping names its variants (an allOf+oneOf dispatcher) is read as a union of
 * the mapping's targets (`dispatchedVariants`), so both forms report alike.
 *
 * An added variant is additive, like a new enum value, from either side of the
 * wire: a caller may now construct it but need not, and a reader may now
 * receive it as it may a new enum value; a required field the union model
 * itself gains is judged by `diffFields` on its own, by direction. A removed
 * variant is breaking, since callers may construct or match it.
 *
 * A mapping entry that comes with an added variant — a new key whose target is
 * a model no variant of the old union names, under any wrapper — or goes with
 * a removed one is part of that variant's change: it is carried as the variant
 * entry's `details` (`mapping added for 'bird'`, `mapping removed for 'dog'`),
 * not reported on its own, so a variant added to a discriminated union is
 * additive whether the spec writes the `mapping` or the parser derives it
 * (`diffMapping`). Every other discriminator change is breaking, since it
 * changes how an existing payload is dispatched: the discriminator added,
 * removed or moved to another property, a key retargeted, a key added for a
 * model the old union already dispatched to (bare or wrapped: `nullable<Cat>`
 * added beside `Cat` brings no new model, so a key for `Cat` added with it is
 * an alias) or for no variant, or a key removed while its model stays. So is a
 * change of composition keyword between two unions (`anyOf` → `oneOf` rejects
 * values that match more than one branch; the reverse loosens what callers may
 * receive). A model that gains or loses `variants` altogether reports each
 * variant added or removed, not a composition change.
 */
function diffVariants(oldModel: Model, newModel: Model): VariantChange[] {
  const changes: VariantChange[] = [];
  const oldVariants = dispatchedVariants(oldModel);
  const newVariants = dispatchedVariants(newModel);

  if (oldModel.compositionKind && newModel.compositionKind && oldModel.compositionKind !== newModel.compositionKind) {
    changes.push({
      kind: 'composition-changed',
      variant: newModel.compositionKind,
      classification: 'breaking',
      details: `composition changed from '${oldModel.compositionKind}' to '${newModel.compositionKind}'`,
    });
  }

  const added = newVariants.filter((variant) => !oldVariants.some((v) => typeRefsEqual(v, variant)));
  const removed = oldVariants.filter((variant) => !newVariants.some((v) => typeRefsEqual(v, variant)));

  const oldDisc = oldModel.discriminator;
  const newDisc = newModel.discriminator;
  // The mapping is compared entry by entry only while both sides dispatch on
  // the same property; a discriminator added, removed or moved is one change.
  const mapping =
    oldDisc && newDisc && oldDisc.property === newDisc.property
      ? diffMapping(oldDisc.mapping, newDisc.mapping, oldVariants, newVariants)
      : { added: new Map<string, string[]>(), removed: new Map<string, string[]>(), changed: [] };

  for (const variant of added) {
    changes.push({
      kind: 'variant-added',
      variant: variantLabel(variant),
      classification: 'additive',
      ...mappingDetails('added', mapping.added, variant),
    });
  }
  for (const variant of removed) {
    changes.push({
      kind: 'variant-removed',
      variant: variantLabel(variant),
      classification: 'breaking',
      ...mappingDetails('removed', mapping.removed, variant),
    });
  }

  if (oldDisc || newDisc) {
    if (!oldDisc || !newDisc) {
      changes.push({
        kind: 'discriminator-changed',
        variant: (newDisc ?? oldDisc)!.property,
        classification: 'breaking',
        details: newDisc ? 'discriminator added' : 'discriminator removed',
      });
    } else if (oldDisc.property !== newDisc.property) {
      changes.push({
        kind: 'discriminator-changed',
        variant: newDisc.property,
        classification: 'breaking',
        details: `property changed from '${oldDisc.property}' to '${newDisc.property}'`,
      });
    } else if (mapping.changed.length > 0) {
      changes.push({
        kind: 'discriminator-changed',
        variant: newDisc.property,
        classification: 'breaking',
        details: `mapping changed for ${quoteKeys(mapping.changed)}`,
      });
    }
  }

  return changes;
}

/**
 * The variants a model dispatches to: its `variants` when it has them, else —
 * for an allOf+oneOf dispatcher, whose `variants` is absent and whose
 * `discriminator.mapping` alone names them — one model ref per distinct
 * mapping target, in mapping order. A model with neither has none.
 */
function dispatchedVariants(model: Model): TypeRef[] {
  if (model.variants) return model.variants;
  const names = new Set(Object.values(model.discriminator?.mapping ?? {}));
  return [...names].map((name) => ({ kind: 'model', name }));
}

/**
 * The model names a discriminator mapping can dispatch `ref` to: the model
 * itself, or the models under a nullable or multi-type variant's wrapper (the
 * parser keeps the wrapper around the model it extracts for such a variant).
 * A primitive, enum, literal, array or map variant is never a mapping target.
 */
function variantModelNames(ref: TypeRef): string[] {
  switch (ref.kind) {
    case 'model':
      return [ref.name];
    case 'nullable':
      return variantModelNames(ref.inner);
    case 'union':
      return ref.variants.flatMap(variantModelNames);
    case 'primitive':
    case 'enum':
    case 'literal':
    case 'array':
    case 'map':
      return [];
  }
  return assertNever(ref);
}

/** How the two mappings of one discriminator property differ, each key read once. */
interface MappingDiff {
  /** Keys the new mapping adds for a model no old variant names, by that model's name. */
  added: Map<string, string[]>;
  /** Keys the old mapping had for a model no new variant names, by that model's name. */
  removed: Map<string, string[]>;
  /** Keys added, removed or retargeted on their own, sorted: each changes how an existing payload is dispatched. */
  changed: string[];
}

/**
 * Compare two mappings key by key and sort each differing key into the
 * variant addition or removal it belongs to, or into `changed`. Whether a
 * model is new is decided on its name after every wrapper is flattened on both
 * sides (`variantModelNames`), not on the variant's type: `nullable<Cat>`
 * added beside a kept `Cat` is a new variant but no new model, so a key for
 * `Cat` added with it is an alias and `changed`. A key only the new mapping has
 * belongs to an addition when its target names a model no old variant names;
 * a key only the old mapping has belongs to a removal when its target names a
 * model no new variant names; a key on both sides with different targets, or
 * on one side for a model the other side still dispatches to (or for no
 * variant), is `changed`. Keys are visited sorted, so the lists are
 * deterministic whatever the document order.
 */
function diffMapping(
  oldMapping: Record<string, string>,
  newMapping: Record<string, string>,
  oldVariants: readonly TypeRef[],
  newVariants: readonly TypeRef[],
): MappingDiff {
  const oldNames = new Set(oldVariants.flatMap(variantModelNames));
  const newNames = new Set(newVariants.flatMap(variantModelNames));
  const addedNames = new Set([...newNames].filter((name) => !oldNames.has(name)));
  const removedNames = new Set([...oldNames].filter((name) => !newNames.has(name)));
  const diff: MappingDiff = { added: new Map(), removed: new Map(), changed: [] };
  const push = (into: Map<string, string[]>, name: string, key: string): void => {
    into.set(name, [...(into.get(name) ?? []), key]);
  };
  // Own keys only, so a value spelled like an inherited property
  // (`constructor`) on one side is compared against nothing, not against
  // `Object.prototype`'s.
  const own = (mapping: Record<string, string>, key: string): string | undefined =>
    Object.hasOwn(mapping, key) ? mapping[key] : undefined;
  const keys = [...new Set([...Object.keys(oldMapping), ...Object.keys(newMapping)])].sort();
  for (const key of keys) {
    const oldTarget = own(oldMapping, key);
    const newTarget = own(newMapping, key);
    if (oldTarget === newTarget) continue;
    if (oldTarget === undefined && newTarget !== undefined && addedNames.has(newTarget)) {
      push(diff.added, newTarget, key);
    } else if (newTarget === undefined && oldTarget !== undefined && removedNames.has(oldTarget)) {
      push(diff.removed, oldTarget, key);
    } else {
      diff.changed.push(key);
    }
  }
  return diff;
}

/**
 * The `details` a `variant-added` / `variant-removed` entry carries when
 * mapping keys came or went with the variant (`mapping added for 'bird'`,
 * `mapping removed for 'dog'`); nothing when none did, so an undiscriminated
 * union's entries carry no `details` key. The keys of every model the variant
 * names are listed once each, sorted, so a multi-type variant's text does not
 * depend on the order of its members.
 */
function mappingDetails(
  change: 'added' | 'removed',
  keysByName: ReadonlyMap<string, string[]>,
  variant: TypeRef,
): { details: string } | Record<string, never> {
  const keys = [...new Set(variantModelNames(variant).flatMap((name) => keysByName.get(name) ?? []))].sort();
  return keys.length > 0 ? { details: `mapping ${change} for ${quoteKeys(keys)}` } : {};
}

function quoteKeys(keys: readonly string[]): string {
  return keys.map((k) => `'${k}'`).join(', ');
}

/** A short, human-readable label for a union variant in a change report. */
function variantLabel(ref: TypeRef): string {
  switch (ref.kind) {
    case 'model':
    case 'enum':
      return ref.name;
    case 'primitive':
      return ref.format ? `${ref.type}:${ref.format}` : ref.type;
    case 'literal':
      return `literal:${String(ref.value)}`;
    case 'nullable':
      return `nullable<${variantLabel(ref.inner)}>`;
    case 'array':
      return `array<${variantLabel(ref.items)}>`;
    case 'map':
      return `map<${variantLabel(ref.valueType)}>`;
    case 'union':
      return `union<${ref.variants.map(variantLabel).join('|')}>`;
  }
  return assertNever(ref);
}

function diffFields(oldModel: Model, newModel: Model, direction: ModelDirection = 'unknown'): FieldChange[] {
  const changes: FieldChange[] = [];
  const oldByName = new Map(oldModel.fields.map((f) => [f.name, f]));
  const newByName = new Map(newModel.fields.map((f) => [f.name, f]));

  for (const [name, field] of newByName) {
    if (!oldByName.has(name)) {
      // Only `field-added` consults direction today. `field-required-changed`
      // deliberately stays direction-blind: downstream changelog tooling reads
      // its `breaking` classification as "made required", so downgrading it
      // would invert the wording rather than just soften the severity.
      changes.push(classifyFieldChange('field-added', name, field.required, direction));
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push(classifyFieldChange('field-removed', name));
    }
  }

  for (const [name, newField] of newByName) {
    const oldField = oldByName.get(name);
    if (!oldField) continue;

    if (!typeRefsEqual(oldField.type, newField.type)) {
      if (primitivesDifferOnlyByFormat(oldField.type, newField.type)) {
        changes.push({
          ...classifyFieldChange('field-format-changed', name),
          details: formatChangeDetails(oldField.type, newField.type),
        });
      } else {
        changes.push({
          kind: 'field-type-changed',
          fieldName: name,
          classification: 'breaking',
          details: `type changed`,
        });
      }
    }

    if (oldField.required !== newField.required) {
      changes.push(classifyFieldChange('field-required-changed', name, newField.required));
    }

    if (!!oldField.readOnly !== !!newField.readOnly || !!oldField.writeOnly !== !!newField.writeOnly) {
      changes.push(classifyFieldChange('field-access-changed', name));
    }

    const deprecation = deprecationFlip(oldField, newField);
    if (deprecation) {
      changes.push({
        ...classifyFieldChange('field-deprecated-changed', name),
        ...deprecation,
        details: deprecationDetails(deprecation.newDeprecated),
      });
    }

    // The field's own extensions are not shape either; reported beside, not
    // instead of, whatever else changed about the field.
    const extensions = extensionsShift(oldField, newField);
    if (extensions) {
      changes.push({ ...classifyFieldChange('field-extensions-changed', name), ...extensions });
    }
  }

  return changes;
}

/**
 * True when both refs are primitives with the same base `type` but different
 * `format`. Used to downgrade format-only diffs from breaking type changes to
 * additive `field-format-changed` / `param-format-changed` events: the wire
 * base type is unchanged, so the diff is a hint to language emitters rather
 * than a source-level break.
 */
export function primitivesDifferOnlyByFormat(a: TypeRef, b: TypeRef): boolean {
  if (a.kind !== 'primitive' || b.kind !== 'primitive') return false;
  if (a.type !== b.type) return false;
  return (a.format ?? '') !== (b.format ?? '');
}

export function formatChangeDetails(a: TypeRef, b: TypeRef): string {
  const oldFmt = a.kind === 'primitive' ? a.format : undefined;
  const newFmt = b.kind === 'primitive' ? b.format : undefined;
  return `format ${oldFmt ?? '<unset>'} → ${newFmt ?? '<unset>'}`;
}

export function typeRefsEqual(a: TypeRef, b: TypeRef): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case 'primitive':
      return b.kind === 'primitive' && a.type === b.type && (a.format ?? '') === ((b as typeof a).format ?? '');
    case 'array':
      return b.kind === 'array' && typeRefsEqual(a.items, b.items);
    case 'model':
      return b.kind === 'model' && a.name === b.name;
    case 'enum':
      return b.kind === 'enum' && a.name === b.name;
    case 'literal':
      return b.kind === 'literal' && a.value === b.value;
    case 'nullable':
      return b.kind === 'nullable' && typeRefsEqual(a.inner, b.inner);
    case 'union': {
      if (b.kind !== 'union') return false;
      if (a.variants.length !== b.variants.length) return false;
      if (!a.variants.every((v, i) => typeRefsEqual(v, b.variants[i]))) return false;
      // Compare discriminator
      if (!a.discriminator && !b.discriminator) return true;
      if (!a.discriminator || !b.discriminator) return false;
      if (a.discriminator.property !== b.discriminator.property) return false;
      const aKeys = Object.keys(a.discriminator.mapping).sort();
      const bKeys = Object.keys(b.discriminator.mapping).sort();
      if (aKeys.length !== bKeys.length) return false;
      return aKeys.every((k, i) => k === bKeys[i] && a.discriminator!.mapping[k] === b.discriminator!.mapping[k]);
    }
    case 'map':
      return b.kind === 'map' && typeRefsEqual(a.valueType, b.valueType);
  }
  return assertNever(a);
}
