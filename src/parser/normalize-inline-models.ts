import type { Model, Service } from '../ir/types.js';
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

function rewriteModelRefsInServices(services: Service[], oldName: string, newName: string): void {
  for (const service of services) {
    for (const op of service.operations) {
      walkTypeRef(op.response, {
        model: (r) => {
          if (r.name === oldName) (r as { name: string }).name = newName;
        },
      });
      if (op.requestBody) {
        walkTypeRef(op.requestBody, {
          model: (r) => {
            if (r.name === oldName) (r as { name: string }).name = newName;
          },
        });
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

export function collapseJsonSuffixModels(models: Model[], services: Service[]): Model[] {
  const normalizedModels = [...models];
  const byName = new Map(normalizedModels.map((m) => [m.name, m]));

  for (const model of normalizedModels) {
    if (!model.name.endsWith('Json')) continue;

    const baseName = model.name.slice(0, -4);
    const baseModel = byName.get(baseName);
    if (!baseModel || model.fields.length <= baseModel.fields.length) continue;

    const isSuperset = baseModel.fields.every((f) => model.fields.some((mf) => mf.name === f.name));
    if (!isSuperset) continue;

    baseModel.fields = model.fields;
    const jsonIdx = normalizedModels.indexOf(model);
    if (jsonIdx !== -1) normalizedModels.splice(jsonIdx, 1);
    rewriteModelRefsInServices(services, model.name, baseName);
    console.warn(`[oagen] Warning: Merged "${model.name}" into "${baseName}" (${model.fields.length} fields, superset)`);
  }

  return normalizedModels;
}
