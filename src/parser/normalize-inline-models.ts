import type { Model, Service, TypeRef } from '../ir/types.js';
import { walkTypeRef, collectResponseHeaders, collectResponseBodyTypes } from '../ir/types.js';

function keepLargestByName(models: Model[]): Model[] {
  const byName = new Map<string, Model>();
  for (const model of models) {
    const existing = byName.get(model.name);
    if (existing && !haveSameFields(existing, model)) {
      // Two inline models resolved to one name but describe different shapes
      // (e.g. two operationIds that PascalCase to the same word). Only one can
      // survive, so say which, instead of silently handing every other
      // reference a model with someone else's fields.
      const kept =
        model.fields.length === existing.fields.length
          ? 'keeping the first definition'
          : 'keeping the one with more fields';
      console.warn(
        `[oagen] Warning: Inline model "${model.name}" has more than one definition with different fields or field types (${model.fields.length} vs ${existing.fields.length}) — ${kept}`,
      );
    }
    if (!existing || model.fields.length > existing.fields.length) {
      byName.set(model.name, model);
    }
  }
  return [...byName.values()];
}

/**
 * Same field names with the same types, in any order. Types are compared by
 * their JSON serialization: the parser builds a given shape's TypeRef with the
 * same key order every time, so equal shapes serialize identically.
 */
function haveSameFields(a: Model, b: Model): boolean {
  const signatures = (m: Model) => new Set(m.fields.map((f) => `${f.name}:${JSON.stringify(f.type)}`));
  const aSignatures = signatures(a);
  const bSignatures = signatures(b);
  return aSignatures.size === bSignatures.size && [...aSignatures].every((s) => bSignatures.has(s));
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
      for (const field of op.pagination?.envelopeFields ?? []) {
        rewriteModelRef(field.type, oldName, newName);
      }
      for (const header of collectResponseHeaders(op)) {
        rewriteModelRef(header.type, oldName, newName);
      }
      for (const { type } of collectResponseBodyTypes(op)) {
        rewriteModelRef(type, oldName, newName);
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

/**
 * Fold the field extractor's inline models into the models gathered so far,
 * keeping the earlier definition on a name clash. `componentNames` tells a
 * clash with a real component schema apart from one between two inline
 * models, so the warning can say which happened and name both shapes.
 */
export function mergeFieldInlineModels(
  existingModels: Model[],
  fieldInlineModels: Model[],
  componentNames?: Set<string>,
): Model[] {
  const modelNames = new Set(existingModels.map((m) => m.name));
  const modelsByName = new Map(existingModels.map((m) => [m.name, m]));
  const fieldList = (m: Model): string => m.fields.map((f) => f.name).join(', ') || '(no fields)';

  const deduplicatedFieldModels = fieldInlineModels.filter((model) => {
    if (!modelNames.has(model.name)) return true;

    const existing = modelsByName.get(model.name)!;
    const existingFieldNames = new Set(existing.fields.map((f) => f.name));
    const inlineFieldNames = new Set(model.fields.map((f) => f.name));
    const hasDifference =
      model.fields.some((f) => !existingFieldNames.has(f.name)) ||
      existing.fields.some((f) => !inlineFieldNames.has(f.name));

    if (hasDifference) {
      if (componentNames && !componentNames.has(model.name)) {
        console.warn(
          `[oagen] Warning: Two inline models are named "${model.name}" (fields: ${fieldList(existing)} | ${fieldList(model)}) — keeping the first, the second is dropped`,
        );
      } else {
        console.warn(
          `[oagen] Warning: Inline model "${model.name}" has different fields than component schema — using component schema`,
        );
      }
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
    // The base model now describes the Json schema's shape, so carry that
    // schema's own limits (minProperties, dependentRequired, ...) with the
    // fields; the base's keywords fill in wherever the Json model is silent.
    if (jsonModel.constraints || baseModel.constraints) {
      baseModel.constraints = { ...baseModel.constraints, ...jsonModel.constraints };
    }
    toRemove.add(jsonModel.name);
    rewriteModelRefs(normalizedModels, services, jsonModel.name, baseModel.name);
    console.warn(
      `[oagen] Merged "${jsonModel.name}" into "${baseModel.name}" (${jsonModel.fields.length} fields, superset)`,
    );
  }

  // Pass 3: cascade renames to inline children of collapsed Json-suffix models.
  // e.g. when AuditLogSchemaJson → AuditLogSchema, also rename
  // AuditLogSchemaJsonTarget → AuditLogSchemaTarget.
  for (const { jsonModel, baseModel } of mergeCandidates) {
    const jsonPrefix = jsonModel.name;
    const basePrefix = baseModel.name;

    for (const model of normalizedModels) {
      if (toRemove.has(model.name)) continue;
      if (model.name.length <= jsonPrefix.length) continue;
      if (!model.name.startsWith(jsonPrefix)) continue;

      const newName = basePrefix + model.name.slice(jsonPrefix.length);
      const existing = byName.get(newName);

      if (existing && !toRemove.has(existing.name)) {
        toRemove.add(model.name);
        rewriteModelRefs(normalizedModels, services, model.name, newName);
        console.warn(`[oagen] Collapsed child "${model.name}" into existing "${newName}"`);
      } else {
        rewriteModelRefs(normalizedModels, services, model.name, newName);
        model.name = newName;
        byName.set(newName, model);
        console.warn(`[oagen] Renamed child "${jsonPrefix}…" → "${newName}"`);
      }
    }
  }

  return normalizedModels.filter((m) => !toRemove.has(m.name));
}
