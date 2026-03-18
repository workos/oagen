import type { ApiSpec, AuthScheme } from '../ir/types.js';
import { SpecParseError } from '../errors.js';
import { loadAndBundleSpec } from './refs.js';
import { extractSchemas, extractInlineModelsFromSchemas } from './schemas.js';
import { extractOperations } from './operations.js';
import {
  mergeInlineResponseModels,
  collapseJsonSuffixModels,
  mergeFieldInlineModels,
} from './normalize-inline-models.js';
import { collectInlineEnumsFromModels } from './collect-inline-enums.js';
import { validateModelRefs } from './normalize-model-refs.js';

export interface ParseOptions {
  operationIdTransform?: (id: string) => string;
}

export async function parseSpec(specPath: string, options?: ParseOptions): Promise<ApiSpec> {
  const { parsed } = await loadAndBundleSpec(specPath);

  const spec = parsed as {
    openapi?: string;
    info?: { title?: string; version?: string; description?: string };
    servers?: Array<{ url?: string }>;
    paths?: Record<string, unknown>;
    components?: {
      schemas?: Record<string, unknown>;
      securitySchemes?: Record<
        string,
        { type: string; scheme?: string; in?: string; name?: string; flows?: Record<string, unknown> }
      >;
    };
  };

  // Validate OpenAPI version
  const version = spec.openapi ?? '';
  if (!version.startsWith('3.')) {
    throw new SpecParseError(
      `Unsupported OpenAPI version: ${version}. oagen requires OpenAPI 3.x`,
      `Update the spec to OpenAPI 3.0 or 3.1. If you are using Swagger 2.x, convert it first with \`npx swagger2openapi ${specPath}\`.`,
    );
  }

  const { models, enums } = extractSchemas(
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
  );

  const { services, inlineModels } = extractOperations(
    spec.paths as Record<string, Record<string, unknown>> | undefined,
    options?.operationIdTransform,
  );

  const responseNormalizedModels = mergeInlineResponseModels(models, inlineModels);
  const jsonCollapsedModels = collapseJsonSuffixModels(responseNormalizedModels, services);

  // Extract inline models from model field definitions (objects/arrays with properties)
  const fieldInlineModels = extractInlineModelsFromSchemas(
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
  );
  const finalModels = mergeFieldInlineModels(jsonCollapsedModels, fieldInlineModels);
  collectInlineEnumsFromModels(finalModels, enums);

  const auth = extractAuthSchemes(spec.components?.securitySchemes);

  const result: ApiSpec = {
    name: spec.info?.title ?? 'Unknown API',
    version: spec.info?.version ?? '0.0.0',
    description: spec.info?.description,
    baseUrl: spec.servers?.[0]?.url ?? '',
    services,
    models: finalModels,
    enums,
    auth,
  };

  validateModelRefs(result);

  return result;
}
/** Extract authentication schemes from OpenAPI securitySchemes. */
function extractAuthSchemes(
  securitySchemes?: Record<
    string,
    { type: string; scheme?: string; in?: string; name?: string; flows?: Record<string, unknown> }
  >,
): AuthScheme[] | undefined {
  if (!securitySchemes) return undefined;
  const schemes: AuthScheme[] = [];
  for (const [, scheme] of Object.entries(securitySchemes)) {
    if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      schemes.push({ kind: 'bearer' });
    } else if (scheme.type === 'apiKey' && scheme.in && scheme.name) {
      schemes.push({ kind: 'apiKey', in: scheme.in as 'header' | 'query', name: scheme.name });
    } else if (scheme.type === 'oauth2' && scheme.flows) {
      schemes.push({ kind: 'oauth2', flows: scheme.flows });
    }
  }
  return schemes.length > 0 ? schemes : undefined;
}
