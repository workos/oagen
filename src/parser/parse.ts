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
  const deduplicatedInlineModels = inlineModels.filter((m) => !schemaModelNames.has(m.name));
  const allModels = [...models, ...deduplicatedInlineModels];

  // Extract inline models from model field definitions (objects/arrays with properties)
  const fieldInlineModels = extractInlineModelsFromSchemas(
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
  );
  const allModelNames = new Set(allModels.map((m) => m.name));
  const deduplicatedFieldModels = fieldInlineModels.filter((m) => !allModelNames.has(m.name));
  const finalModels = [...allModels, ...deduplicatedFieldModels];

  // Collect inline enums from all models (including inline models from responses)
  const enumNames = new Set(enums.map(e => e.name));
  for (const model of finalModels) {
    for (const field of model.fields) {
      collectInlineEnumsFromTypeRef(field.type, enums, enumNames);
    }
  }

  return {
    name: spec.info?.title ?? 'Unknown API',
    version: spec.info?.version ?? '0.0.0',
    description: spec.info?.description,
    baseUrl: spec.servers?.[0]?.url ?? '',
    services,
    models: finalModels,
    enums,
  };
}

function collectInlineEnumsFromTypeRef(ref: TypeRef, enums: Enum[], seen: Set<string>): void {
  if (ref.kind === 'enum' && ref.values && !seen.has(ref.name)) {
    seen.add(ref.name);
    enums.push({
      name: ref.name,
      values: ref.values.map(v => ({
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
  }
}
