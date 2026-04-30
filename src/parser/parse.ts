import type { ApiSpec, AuthScheme, ServerEntry } from '../ir/types.js';
import { defaultSdkBehavior } from '../ir/sdk-behavior.js';
import { SpecParseError } from '../errors.js';
import { loadAndBundleSpec } from './refs.js';
import { extractSchemas, extractInlineModelsFromSchemas, clearSchemaNameTransform } from './schemas.js';
import { extractOperations } from './operations.js';
import {
  mergeInlineResponseModels,
  collapseJsonSuffixModels,
  mergeFieldInlineModels,
} from './normalize-inline-models.js';
import { collectInlineEnumsFromModels, collectInlineEnumsFromOperations } from './collect-inline-enums.js';
import { validateModelRefs } from './normalize-model-refs.js';

/**
 * A bundled OpenAPI document, post-`$ref` resolution but pre-IR extraction.
 *
 * This is the shape the spec author wrote, with external refs inlined and
 * internal refs left intact. It is intentionally loose (`Record<string,
 * unknown>`) so `transformSpec` can reach arbitrary spec extensions without
 * fighting types — narrow with `as` at use sites.
 */
export type OpenApiDocument = Record<string, unknown>;

export interface ParseOptions {
  operationIdTransform?: (id: string) => string;
  schemaNameTransform?: (name: string) => string;
  /**
   * Pre-IR overlay applied to the bundled OpenAPI document before any IR
   * extraction runs. Use this when the upstream spec can't be changed but you
   * need to patch around a spec quirk that would otherwise emit a breaking SDK
   * change — e.g. rewriting a path's response `$ref` back to its prior schema,
   * merging the new fields onto the prior schema, and dropping the fork.
   *
   * The function may mutate the document in place and return it, or return a
   * new object; the returned value is what the rest of oagen sees.
   *
   * Runs once, after `$ref` bundling and before schema/operation extraction.
   * If you need to inspect the resulting IR instead, post-process the
   * `ApiSpec` returned by `parseSpec`.
   */
  transformSpec?: (spec: OpenApiDocument) => OpenApiDocument;
}

export async function parseSpec(specPath: string, options?: ParseOptions): Promise<ApiSpec> {
  const { parsed } = await loadAndBundleSpec(specPath);
  const transformed = options?.transformSpec ? options.transformSpec(parsed) : parsed;

  const spec = transformed as {
    openapi?: string;
    info?: { title?: string; version?: string; description?: string };
    servers?: Array<{ url?: string; description?: string }>;
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
    { schemaNameTransform: options?.schemaNameTransform },
  );

  const { services, inlineModels } = extractOperations(
    spec.paths as Record<string, Record<string, unknown>> | undefined,
    options?.operationIdTransform,
  );

  // schemaNameTransform is kept active through extractOperations so that
  // $ref-based TypeRefs in operations resolve to the same transformed names.
  // Now that all extraction is done, clear it.
  clearSchemaNameTransform();

  const responseNormalizedModels = mergeInlineResponseModels(models, inlineModels);

  // Extract inline models from model field definitions (objects/arrays with properties)
  const fieldInlineModels = extractInlineModelsFromSchemas(
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
  );
  const fieldMergedModels = mergeFieldInlineModels(responseNormalizedModels, fieldInlineModels);
  const finalModels = collapseJsonSuffixModels(fieldMergedModels, services);
  collectInlineEnumsFromModels(finalModels, enums);
  collectInlineEnumsFromOperations(services, enums);

  const auth = extractAuthSchemes(spec.components?.securitySchemes);

  const serverEntries: ServerEntry[] = (spec.servers ?? [])
    .map((s) => ({ url: s.url ?? '', description: s.description }))
    .filter((s) => s.url);

  const result: ApiSpec = {
    name: spec.info?.title ?? 'Unknown API',
    version: spec.info?.version ?? '0.0.0',
    description: spec.info?.description,
    baseUrl: serverEntries[0]?.url ?? '',
    servers: serverEntries.length > 0 ? serverEntries : undefined,
    services,
    models: finalModels,
    enums,
    auth,
    sdk: defaultSdkBehavior(),
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
      schemes.push({ kind: 'apiKey', in: scheme.in as 'header' | 'query' | 'cookie', name: scheme.name });
    } else if (scheme.type === 'oauth2' && scheme.flows) {
      schemes.push({ kind: 'oauth2', flows: scheme.flows });
    }
  }
  return schemes.length > 0 ? schemes : undefined;
}
