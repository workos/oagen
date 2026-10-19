import type { Model, TypeRef } from '../ir/types.js';
import { assertNever } from '../ir/types.js';
import type { Change, FieldChange, VariantChange } from './types.js';
import { classifyFieldChange } from './classify.js';
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
    if (fieldChanges.length > 0 || variantChanges.length > 0) {
      const hasBreaking = [...fieldChanges, ...variantChanges].some((c) => c.classification === 'breaking');
      changes.push({
        kind: 'model-modified',
        name,
        fieldChanges,
        ...(variantChanges.length > 0 ? { variantChanges } : {}),
        classification: hasBreaking ? 'breaking' : 'additive',
      });
    }
  }

  return changes;
}

/**
 * Changes to a named union's `variants` and `discriminator`. A variant is
 * matched by type equality (`typeRefsEqual`), not by position, so reordering
 * reports nothing. An added variant is additive, like a new enum value — a
 * value the API may now produce or accept; a removed variant is breaking,
 * since callers may construct or match it. Any discriminator change (the
 * property, or an entry of its mapping) is breaking: it changes how a
 * payload is dispatched to a variant. A model that gains or loses `variants`
 * altogether reports each variant added or removed.
 */
function diffVariants(oldModel: Model, newModel: Model): VariantChange[] {
  const changes: VariantChange[] = [];
  const oldVariants = oldModel.variants ?? [];
  const newVariants = newModel.variants ?? [];

  for (const variant of newVariants) {
    if (!oldVariants.some((v) => typeRefsEqual(v, variant))) {
      changes.push({ kind: 'variant-added', variant: variantLabel(variant), classification: 'additive' });
    }
  }
  for (const variant of oldVariants) {
    if (!newVariants.some((v) => typeRefsEqual(v, variant))) {
      changes.push({ kind: 'variant-removed', variant: variantLabel(variant), classification: 'breaking' });
    }
  }

  const oldDisc = oldModel.discriminator;
  const newDisc = newModel.discriminator;
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
    } else {
      const keys = new Set([...Object.keys(oldDisc.mapping), ...Object.keys(newDisc.mapping)]);
      const differing = [...keys].filter((k) => oldDisc.mapping[k] !== newDisc.mapping[k]).sort();
      if (differing.length > 0) {
        changes.push({
          kind: 'discriminator-changed',
          variant: newDisc.property,
          classification: 'breaking',
          details: `mapping changed for ${differing.map((k) => `'${k}'`).join(', ')}`,
        });
      }
    }
  }

  return changes;
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
