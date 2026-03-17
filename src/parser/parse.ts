import type { ApiSpec, Enum, TypeRef } from '../ir/types.js';
import { toUpperSnakeCase } from '../utils/naming.js';
import { loadAndBundleSpec } from './refs.js';
import { extractSchemas, extractInlineModelsFromSchemas } from './schemas.js';
import { extractOperations } from './operations.js';

export async function parseSpec(specPath: string): Promise<ApiSpec> {
  const { parsed } = await loadAndBundleSpec(specPath);

  const spec = parsed as {
    openapi?: string;
    info?: { title?: string; version?: string; description?: string };
    servers?: Array<{ url?: string }>;
    paths?: Record<string, unknown>;
    components?: { schemas?: Record<string, unknown> };
  };

  // Validate OpenAPI version
  const version = spec.openapi ?? '';
  if (!version.startsWith('3.')) {
    throw new Error(`Unsupported OpenAPI version: ${version}. oagen requires OpenAPI 3.x`);
  }

  const { models, enums } = extractSchemas(
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
  );

  const { services, inlineModels } = extractOperations(
    spec.paths as Record<string, Record<string, unknown>> | undefined,
  );

  // Merge inline response models with component schema models.
  // When both exist with same name: prefer whichever has MORE fields, since
  // component schemas are often request DTOs with fewer fields than the
  // full response model extracted from endpoint definitions.
  const schemaModelNames = new Set(models.map((m) => m.name));
  const schemaModelsByName = new Map(models.map((m) => [m.name, m]));
  const deduplicatedInlineModels = inlineModels.filter((m) => {
    if (!schemaModelNames.has(m.name)) return true;
    const existing = schemaModelsByName.get(m.name)!;
    const existingFieldNames = new Set(existing.fields.map((f) => f.name));
    const inlineFieldNames = new Set(m.fields.map((f) => f.name));
    const hasDifference =
      m.fields.some((f) => !existingFieldNames.has(f.name)) ||
      existing.fields.some((f) => !inlineFieldNames.has(f.name));
    if (hasDifference && m.fields.length > existing.fields.length) {
      // Inline response model has more fields — replace the component schema
      const idx = models.indexOf(existing);
      if (idx !== -1) models[idx] = m;
      schemaModelsByName.set(m.name, m);
      console.warn(
        `[oagen] Warning: Inline model "${m.name}" has more fields than component schema (${m.fields.length} vs ${existing.fields.length}) — using inline response model`,
      );
    } else if (hasDifference) {
      console.warn(
        `[oagen] Warning: Inline model "${m.name}" has different fields than component schema — using component schema`,
      );
    }
    return false;
  });
  // Deduplicate inline models against each other — when multiple responses produce
  // models with the same name, keep the one with the most fields (most complete).
  const inlineByName = new Map<string, (typeof deduplicatedInlineModels)[0]>();
  for (const m of deduplicatedInlineModels) {
    const existing = inlineByName.get(m.name);
    if (!existing || m.fields.length > existing.fields.length) {
      inlineByName.set(m.name, m);
    }
  }
  const uniqueInlineModels = [...inlineByName.values()];

  const allModels = [...models, ...uniqueInlineModels];

  // Merge FooJson models into Foo when FooJson is a superset of Foo.
  // Component schemas sometimes split request DTOs (Foo) from response schemas (FooJson).
  // When FooJson has strictly more fields, replace Foo with FooJson's fields under the Foo name.
  const allModelsByNameForJson = new Map(allModels.map((m) => [m.name, m]));
  for (const model of allModels) {
    if (model.name.endsWith('Json')) {
      const baseName = model.name.slice(0, -4);
      const baseModel = allModelsByNameForJson.get(baseName);
      if (baseModel && model.fields.length > baseModel.fields.length) {
        const isSuperset = baseModel.fields.every((f) => model.fields.some((mf) => mf.name === f.name));
        if (isSuperset) {
          // Replace Foo's fields with FooJson's fields, keep the Foo name
          baseModel.fields = model.fields;
          // Remove the FooJson model from the array
          const jsonIdx = allModels.indexOf(model);
          if (jsonIdx !== -1) allModels.splice(jsonIdx, 1);
          // Rewrite any TypeRef pointing to FooJson → Foo in operations
          for (const service of services) {
            for (const op of service.operations) {
              rewriteModelRefs(op.response, model.name, baseName);
              if (op.requestBody) rewriteModelRefs(op.requestBody, model.name, baseName);
            }
          }
          console.warn(
            `[oagen] Warning: Merged "${model.name}" into "${baseName}" (${model.fields.length} fields, superset)`,
          );
        }
      }
    }
  }

  // Extract inline models from model field definitions (objects/arrays with properties)
  const fieldInlineModels = extractInlineModelsFromSchemas(
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
  );
  const allModelNames = new Set(allModels.map((m) => m.name));
  const allModelsByName = new Map(allModels.map((m) => [m.name, m]));
  const deduplicatedFieldModels = fieldInlineModels.filter((m) => {
    if (!allModelNames.has(m.name)) return true;
    // Warn if field-extracted inline model has different fields than existing model
    const existing = allModelsByName.get(m.name)!;
    const existingFieldNames = new Set(existing.fields.map((f) => f.name));
    const inlineFieldNames = new Set(m.fields.map((f) => f.name));
    const hasDifference =
      m.fields.some((f) => !existingFieldNames.has(f.name)) ||
      existing.fields.some((f) => !inlineFieldNames.has(f.name));
    if (hasDifference) {
      console.warn(
        `[oagen] Warning: Inline model "${m.name}" has different fields than component schema — using component schema`,
      );
    }
    return false;
  });
  // Deduplicate field-extracted models against each other
  const fieldByName = new Map<string, (typeof deduplicatedFieldModels)[0]>();
  for (const m of deduplicatedFieldModels) {
    const existing = fieldByName.get(m.name);
    if (!existing || m.fields.length > existing.fields.length) {
      fieldByName.set(m.name, m);
    }
  }
  const uniqueFieldModels = [...fieldByName.values()];

  const finalModels = [...allModels, ...uniqueFieldModels];

  // Collect inline enums from all models (including inline models from responses)
  const enumNames = new Set(enums.map((e) => e.name));
  for (const model of finalModels) {
    for (const field of model.fields) {
      collectInlineEnumsFromTypeRef(field.type, enums, enumNames);
    }
  }

  const result: ApiSpec = {
    name: spec.info?.title ?? 'Unknown API',
    version: spec.info?.version ?? '0.0.0',
    description: spec.info?.description,
    baseUrl: spec.servers?.[0]?.url ?? '',
    services,
    models: finalModels,
    enums,
  };

  validateModelRefs(result);

  return result;
}

/** Recursively rewrite model references from oldName to newName in a TypeRef tree. */
function rewriteModelRefs(ref: TypeRef, oldName: string, newName: string): void {
  switch (ref.kind) {
    case 'model':
      if (ref.name === oldName) (ref as { name: string }).name = newName;
      break;
    case 'array':
      rewriteModelRefs(ref.items, oldName, newName);
      break;
    case 'nullable':
      rewriteModelRefs(ref.inner, oldName, newName);
      break;
    case 'union':
      for (const v of ref.variants) rewriteModelRefs(v, oldName, newName);
      break;
    case 'map':
      rewriteModelRefs(ref.valueType, oldName, newName);
      break;
    case 'enum':
    case 'primitive':
    case 'literal':
      break;
  }
}

function collectInlineEnumsFromTypeRef(ref: TypeRef, enums: Enum[], seen: Set<string>): void {
  if (ref.kind === 'enum' && ref.values && !seen.has(ref.name)) {
    seen.add(ref.name);
    enums.push({
      name: ref.name,
      values: ref.values.map((v) => ({
        name: toUpperSnakeCase(v),
        value: v,
        description: undefined,
      })),
    });
  } else if (ref.kind === 'array') {
    collectInlineEnumsFromTypeRef(ref.items, enums, seen);
  } else if (ref.kind === 'nullable') {
    collectInlineEnumsFromTypeRef(ref.inner, enums, seen);
  } else if (ref.kind === 'union') {
    for (const v of ref.variants) {
      collectInlineEnumsFromTypeRef(v, enums, seen);
    }
  } else if (ref.kind === 'map') {
    collectInlineEnumsFromTypeRef(ref.valueType, enums, seen);
  }
}

/**
 * Walk all TypeRefs in the spec and warn about ModelRef nodes that point to
 * model/enum names that don't exist. This catches refs broken by name cleaning.
 */
function validateModelRefs(spec: ApiSpec): void {
  const knownNames = new Set<string>();
  for (const m of spec.models) knownNames.add(m.name);
  for (const e of spec.enums) knownNames.add(e.name);

  function walkRef(ref: TypeRef, context: string): void {
    switch (ref.kind) {
      case 'model':
        if (!knownNames.has(ref.name)) {
          console.warn(`[oagen] Warning: Unresolved model reference "${ref.name}" (context: ${context})`);
        }
        break;
      case 'array':
        walkRef(ref.items, context);
        break;
      case 'nullable':
        walkRef(ref.inner, context);
        break;
      case 'union':
        for (const v of ref.variants) walkRef(v, context);
        break;
      case 'map':
        walkRef(ref.valueType, context);
        break;
      case 'enum':
      case 'primitive':
      case 'literal':
        break;
    }
  }

  for (const model of spec.models) {
    for (const field of model.fields) {
      walkRef(field.type, `${model.name}.${field.name}`);
    }
  }

  for (const service of spec.services) {
    for (const op of service.operations) {
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
        walkRef(p.type, `${service.name}.${op.name}.${p.name}`);
      }
      if (op.requestBody) walkRef(op.requestBody, `${service.name}.${op.name}.requestBody`);
      walkRef(op.response, `${service.name}.${op.name}.response`);
    }
  }
}
