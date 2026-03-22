import type { Model, Service, TypeRef } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';

function keepLargestByName(models: Model[]): Model[] {
  const byName = new Map<string, Model>();
  for (const model of models) {
    const existing = byName.get(model.name);
    if (!existing || model.fields.length > existing.fields.length) {
      byName.set(model.name, model);
    }
  }
  return [...byName.values()];
}

function rewriteModelRef(ref: TypeRef, oldName: string, newName: string): void {
  walkTypeRef(ref, {
    model: (r) => {
      if (r.name === oldName) (r as { name: string }).name = newName;
    },
  });
}

function rewriteModelRefs(models: Model[], services: Service[], oldName: string, newName: string): void {
  for (const model of models) {
    for (const field of model.fields) {
      rewriteModelRef(field.type, oldName, newName);
    }
  }
  for (const service of services) {
    for (const op of service.operations) {
      rewriteModelRef(op.response, oldName, newName);
      if (op.requestBody) {
        rewriteModelRef(op.requestBody, oldName, newName);
      }
    }
  }
}

export function mergeInlineResponseModels(schemaModels: Model[], inlineModels: Model[]): Model[] {
  const mergedSchemaModels = [...schemaModels];
  const schemaModelNames = new Set(mergedSchemaModels.map((m) => m.name));
  const schemaModelsByName = new Map(mergedSchemaModels.map((m) => [m.name, m]));

  const deduplicatedInlineModels = inlineModels.filter((model) => {
    if (!schemaModelNames.has(model.name)) return true;

    const existing = schemaModelsByName.get(model.name)!;
    const existingFieldNames = new Set(existing.fields.map((f) => f.name));
    const inlineFieldNames = new Set(model.fields.map((f) => f.name));
    const hasDifference =
      model.fields.some((f) => !existingFieldNames.has(f.name)) ||
      existing.fields.some((f) => !inlineFieldNames.has(f.name));

    if (hasDifference && model.fields.length > existing.fields.length) {
      const idx = mergedSchemaModels.indexOf(existing);
      if (idx !== -1) mergedSchemaModels[idx] = model;
      schemaModelsByName.set(model.name, model);
      console.warn(
        `[oagen] Warning: Inline model "${model.name}" has more fields than component schema (${model.fields.length} vs ${existing.fields.length}) — using inline response model`,
      );
    } else if (hasDifference) {
      console.warn(
        `[oagen] Warning: Inline model "${model.name}" has different fields than component schema — using component schema`,
      );
    }

    return false;
  });

  return [...mergedSchemaModels, ...keepLargestByName(deduplicatedInlineModels)];
}

export function mergeFieldInlineModels(existingModels: Model[], fieldInlineModels: Model[]): Model[] {
  const modelNames = new Set(existingModels.map((m) => m.name));
  const modelsByName = new Map(existingModels.map((m) => [m.name, m]));

  const deduplicatedFieldModels = fieldInlineModels.filter((model) => {
    if (!modelNames.has(model.name)) return true;

    const existing = modelsByName.get(model.name)!;
    const existingFieldNames = new Set(existing.fields.map((f) => f.name));
    const inlineFieldNames = new Set(model.fields.map((f) => f.name));
    const hasDifference =
      model.fields.some((f) => !existingFieldNames.has(f.name)) ||
      existing.fields.some((f) => !inlineFieldNames.has(f.name));

    if (hasDifference) {
      console.warn(
        `[oagen] Warning: Inline model "${model.name}" has different fields than component schema — using component schema`,
      );
    }

    return false;
  });

  return [...existingModels, ...keepLargestByName(deduplicatedFieldModels)];
}

function hasModelConstDiscriminant(model: Model): boolean {
  return model.fields.some(
    (f) => (f.name === 'object' || f.name === 'type') && f.type.kind === 'literal' && typeof f.type.value === 'string',
  );
}

function isModelReferencedByOthers(name: string, models: Model[], excludeNames: Set<string>): boolean {
  for (const model of models) {
    if (excludeNames.has(model.name)) continue;
    for (const field of model.fields) {
      let found = false;
      walkTypeRef(field.type, {
        model: (r) => {
          if (r.name === name) found = true;
        },
      });
      if (found) return true;
    }
  }
  return false;
}

export function collapseJsonSuffixModels(models: Model[], services: Service[]): Model[] {
  const normalizedModels = [...models];
  const byName = new Map(normalizedModels.map((m) => [m.name, m]));

  // Pass 1: collect merge candidates
  const mergeCandidates: Array<{ jsonModel: Model; baseModel: Model }> = [];
  for (const model of normalizedModels) {
    if (!model.name.endsWith('Json')) continue;

    const baseName = model.name.slice(0, -4);
    const baseModel = byName.get(baseName);
    if (!baseModel || model.fields.length <= baseModel.fields.length) continue;

    const isSuperset = baseModel.fields.every((f) => model.fields.some((mf) => mf.name === f.name));
    if (!isSuperset) continue;

    // Guard: both models have a const discriminant — they are distinct entities
    if (hasModelConstDiscriminant(model) && hasModelConstDiscriminant(baseModel)) continue;

    // Guard: a third model explicitly references the Json-suffix model
    if (isModelReferencedByOthers(model.name, normalizedModels, new Set([model.name, baseName]))) continue;

    mergeCandidates.push({ jsonModel: model, baseModel });
  }

  // Pass 2: apply merges
  const toRemove = new Set<string>();
  for (const { jsonModel, baseModel } of mergeCandidates) {
    baseModel.fields = jsonModel.fields;
    toRemove.add(jsonModel.name);
    rewriteModelRefs(normalizedModels, services, jsonModel.name, baseModel.name);
    console.warn(
      `[oagen] Merged "${jsonModel.name}" into "${baseModel.name}" (${jsonModel.fields.length} fields, superset)`,
    );
  }

  return normalizedModels.filter((m) => !toRemove.has(m.name));
}
