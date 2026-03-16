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

  // Merge inline models with component schema models, component schemas take precedence
  const schemaModelNames = new Set(models.map((m) => m.name));
  const schemaModelsByName = new Map(models.map((m) => [m.name, m]));
  const deduplicatedInlineModels = inlineModels.filter((m) => {
    if (!schemaModelNames.has(m.name)) return true;
    // Warn if inline model has different fields than component schema model
    const existing = schemaModelsByName.get(m.name)!;
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
  const allModels = [...models, ...deduplicatedInlineModels];

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
  const finalModels = [...allModels, ...deduplicatedFieldModels];

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
