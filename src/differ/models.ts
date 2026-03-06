import type { Model, TypeRef } from '../ir/types.js';
import type { Change, FieldChange } from './types.js';
import { classifyFieldChange } from './classify.js';

export function diffModels(oldModels: Model[], newModels: Model[]): Change[] {
  const changes: Change[] = [];
  const oldByName = new Map(oldModels.map((m) => [m.name, m]));
  const newByName = new Map(newModels.map((m) => [m.name, m]));

  for (const [name, model] of newByName) {
    if (!oldByName.has(name)) {
      changes.push({ kind: 'model-added', name, classification: 'additive' });
    }
  }

  for (const [name, model] of oldByName) {
    if (!newByName.has(name)) {
      changes.push({ kind: 'model-removed', name, classification: 'breaking' });
    }
  }

  for (const [name, newModel] of newByName) {
    const oldModel = oldByName.get(name);
    if (!oldModel) continue;

    const fieldChanges = diffFields(oldModel, newModel);
    if (fieldChanges.length > 0) {
      const hasBreaking = fieldChanges.some((fc) => fc.classification === 'breaking');
      changes.push({
        kind: 'model-modified',
        name,
        fieldChanges,
        classification: hasBreaking ? 'breaking' : 'additive',
      });
    }
  }

  return changes;
}

function diffFields(oldModel: Model, newModel: Model): FieldChange[] {
  const changes: FieldChange[] = [];
  const oldByName = new Map(oldModel.fields.map((f) => [f.name, f]));
  const newByName = new Map(newModel.fields.map((f) => [f.name, f]));

  for (const [name, field] of newByName) {
    if (!oldByName.has(name)) {
      changes.push(classifyFieldChange('field-added', name, field.required));
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
      changes.push({
        kind: 'field-type-changed',
        fieldName: name,
        classification: 'breaking',
        details: `type changed`,
      });
    }

    if (oldField.required !== newField.required) {
      changes.push(classifyFieldChange('field-required-changed', name, newField.required));
    }
  }

  return changes;
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
      return aKeys.every(
        (k, i) => k === bKeys[i] && a.discriminator!.mapping[k] === b.discriminator!.mapping[k],
      );
    }
  }
}
