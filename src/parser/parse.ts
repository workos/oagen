import type { ApiSpec, AuthScheme } from '../ir/types.js';
import { defaultSdkBehavior } from '../ir/sdk-behavior.js';
import { SpecParseError } from '../errors.js';
import { loadAndBundleSpec } from './refs.js';
import {
  extractSchemas,
  extractInlineModelsFromSchemas,
  clearSchemaNameTransform,
  resolveSchemaName,
} from './schemas.js';
import { extractOperations } from './operations.js';
import type { FieldInlineModelGroup } from './inline-models.js';
import { collectExistingNames, extractWebhooks } from './webhooks.js';
import {
  mergeInlineResponseModels,
  collapseJsonSuffixModels,
  mergeFieldInlineModels,
  fieldInlineModelBundles,
  reservedTypeNames,
  type InlineModelNaming,
} from './normalize-inline-models.js';
import {
  collectInlineEnumsFromModels,
  collectInlineEnumsFromOperations,
  collectInlineEnumsFromWebhooks,
} from './collect-inline-enums.js';
import { assignParameterGroupWrapperNames } from './parameter-group-names.js';
import { validateModelRefs } from './normalize-model-refs.js';
import { extractSecurityRequirements, type RawSecurityRequirements } from './security.js';
import { extractServers, type RawServerObject } from './servers.js';
import { externalDocsEntry, type RawExternalDocs } from './external-docs.js';
import type { SchemaNameTransform } from './schemas.js';
import type { OperationHint } from '../ir/operation-hints.js';

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
  /**
   * Custom transform for schema (model/enum) names. Receives the cleaned
   * PascalCase name and, for component schemas, the original name as spelled
   * in the document. Returning `originalName` opts out of normalization.
   * See `SchemaExtractionOptions.schemaNameTransform`.
   */
  schemaNameTransform?: SchemaNameTransform;
  /**
   * Domain-facing field-name overrides, keyed by IR model name then wire field
   * name: `{ Connection: { connection_type: 'type' } }`. Sets `Field.domainName`
   * so emitters expose the field under the friendlier name while keeping the
   * wire key. Language-agnostic — honored by any emitter that reads `domainName`.
   */
  fieldHints?: Record<string, Record<string, string>>;
  /**
   * Per-operation overrides keyed by "METHOD /path" — the same map
   * `resolveOperations` reads. The parser applies only each hint's
   * `pagination`, which wins over the operation's `x-pagination` extension
   * and over name-based detection (see `PaginationHint`).
   */
  operationHints?: Record<string, OperationHint>;
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
    servers?: RawServerObject[];
    security?: RawSecurityRequirements;
    tags?: Array<{ name?: string; description?: string; externalDocs?: RawExternalDocs }>;
    externalDocs?: RawExternalDocs;
    paths?: Record<string, unknown>;
    webhooks?: unknown;
    'x-webhooks'?: unknown;
    components?: {
      schemas?: Record<string, unknown>;
      parameters?: Record<string, unknown>;
      requestBodies?: Record<string, unknown>;
      responses?: Record<string, unknown>;
      examples?: Record<string, unknown>;
      headers?: Record<string, unknown>;
      pathItems?: Record<string, unknown>;
      securitySchemes?: Record<string, SecuritySchemeObject>;
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

  // The whole document goes along so the rules that read every inline schema
  // of a root at once see the operations' and webhooks' schemas too, not
  // only the components' (`SchemaExtractionOptions.document`).
  const { models, enums } = extractSchemas(
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
    { schemaNameTransform: options?.schemaNameTransform, document: transformed },
  );

  // Before the operations: an operation carries its own `servers` only when
  // they differ from the document's, so the document's list is needed first.
  const { servers, baseUrl } = extractServers(spec.servers);

  // Extract inline models from model field definitions (objects/arrays with properties).
  // schemaNameTransform is kept active so inline child names use the
  // transformed parent name (e.g. AuditLogSchemaJson→AuditLogSchema yields
  // AuditLogSchemaTarget, not AuditLogSchemaJsonTarget). Read before the
  // operations and the webhooks so the names those mint — header and
  // fallback models, webhook payloads — are reserved against these too: a
  // map's values or a nested object a component field mints (`ReportDetail`)
  // is not among `models`, and a titled fallback variant would otherwise take
  // its name and the field merge below drop the component's definition.
  // Each field's site is recorded too, so a merge pass that must rename one
  // of these models can repoint exactly the references that mint it.
  const fieldInlineModelGroups: FieldInlineModelGroup[] = [];
  const fieldInlineModels = extractInlineModelsFromSchemas(
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
    fieldInlineModelGroups,
  );

  const { services, inlineModels, inlineModelBundles } = extractOperations(
    spec.paths as Record<string, Record<string, unknown>> | undefined,
    options?.operationIdTransform,
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
    spec.components?.parameters as Record<string, Record<string, unknown>> | undefined,
    spec.components?.requestBodies as Record<string, Record<string, unknown>> | undefined,
    models,
    spec.tags,
    spec.components?.examples as Record<string, Record<string, unknown>> | undefined,
    spec.components?.headers as Record<string, Record<string, unknown>> | undefined,
    spec.components?.responses as Record<string, Record<string, unknown>> | undefined,
    fieldInlineModels,
    servers,
    version,
    options?.operationHints,
  );

  // Webhooks are read while the schema-name transform is still active, like
  // operations, so a payload's `$ref`s resolve to the same names as a field's.
  // Their models are named last, against every model and enum decided so far —
  // components, operations, and the components' own inline field models — so
  // a webhook never takes a name another pass has already minted.
  const { webhooks, inlineModels: webhookInlineModels } = extractWebhooks(
    spec.webhooks,
    {
      schemas: spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
      parameters: spec.components?.parameters as Record<string, Record<string, unknown>> | undefined,
      requestBodies: spec.components?.requestBodies as Record<string, Record<string, unknown>> | undefined,
      responses: spec.components?.responses as Record<string, Record<string, unknown>> | undefined,
      examples: spec.components?.examples as Record<string, Record<string, unknown>> | undefined,
      pathItems: spec.components?.pathItems as Record<string, Record<string, unknown>> | undefined,
    },
    collectExistingNames([...models, ...inlineModels, ...fieldInlineModels], services, enums),
  );
  warnOnLegacyWebhooks(spec['x-webhooks']);

  // Resolved while the transform is still active so the names match the
  // models'; lets the merge tell a clash with a component schema from one
  // between two inline models.
  const componentNames = new Set(
    Object.keys(spec.components?.schemas ?? {}).map((schemaName) => resolveSchemaName(schemaName)),
  );
  clearSchemaNameTransform();

  // Every name in play — component models and enums, every inline model of
  // either pass, and every inline enum the collectors below will lift — so a
  // copy a merge pass must rename (a deprecated response named like a live
  // one) takes a name nothing else has or will have, in either pass.
  const naming: InlineModelNaming = {
    bundles: [...inlineModelBundles],
    reserved: reservedTypeNames(
      models,
      enums,
      [...inlineModels, ...webhookInlineModels],
      fieldInlineModels,
      services,
      webhooks,
    ),
  };
  const responseNormalizedModels = mergeInlineResponseModels(models, [...inlineModels, ...webhookInlineModels], naming);
  // The field models' sites, resolved now that the response merge may have
  // replaced a component's fields.
  naming.bundles.push(...fieldInlineModelBundles(fieldInlineModelGroups, responseNormalizedModels));
  const fieldMergedModels = mergeFieldInlineModels(responseNormalizedModels, fieldInlineModels, componentNames, naming);
  const finalModels = collapseJsonSuffixModels(fieldMergedModels, services, webhooks);
  applyFieldHints(finalModels, options?.fieldHints);
  // Each collector steps a renamed enum around every model name as well as
  // every enum's, so the merge passes above (which mint against every enum
  // name an `EnumRef` carries) and the collectors never meet on one name.
  collectInlineEnumsFromModels(finalModels, enums);
  collectInlineEnumsFromOperations(services, enums, finalModels, componentNames);
  collectInlineEnumsFromWebhooks(webhooks, enums, finalModels);

  const auth = extractAuthSchemes(spec.components?.securitySchemes);

  const result: ApiSpec = {
    name: spec.info?.title ?? 'Unknown API',
    version: spec.info?.version ?? '0.0.0',
    description: spec.info?.description,
    // The document's own link; the key stays absent when it declares none.
    ...externalDocsEntry(spec.externalDocs),
    baseUrl,
    servers,
    services,
    // Omitted, not an empty list, for a document without webhooks so its IR
    // keeps the shape it had before the key existed.
    ...(webhooks.length > 0 ? { webhooks } : {}),
    models: finalModels,
    enums,
    auth,
    security: extractSecurityRequirements(spec.security, 'the document'),
    sdk: defaultSdkBehavior(),
  };

  // Needs the finished models and enums: divergence is decided on member
  // shape, so this can only run once every referenced type is resolvable.
  assignParameterGroupWrapperNames(result);

  validateModelRefs(result);

  return result;
}
/**
 * Apply `fieldHints` onto the built models, setting `Field.domainName` for each
 * matching (model name, wire field name) pair. Serialization still uses
 * `Field.name`; only the domain-facing identifier changes.
 */
function applyFieldHints(
  models: import('../ir/types.js').Model[],
  fieldHints: Record<string, Record<string, string>> | undefined,
): void {
  if (!fieldHints) return;
  for (const model of models) {
    const hints = fieldHints[model.name];
    if (!hints) continue;
    for (const field of model.fields) {
      const domainName = hints[field.name];
      if (domainName) field.domainName = domainName;
    }
  }
}

/**
 * `x-webhooks` is the extension some OpenAPI 3.0 documents use for what 3.1
 * standardized as the top-level `webhooks` map. The parser deliberately reads
 * the standard key only: an extension has no agreed shape to parse, and
 * reading it silently would make the IR depend on a convention the document
 * never declared. A document that carries one is told so, once, so the
 * omission is a visible choice rather than a quiet loss. An operation's
 * `callbacks`, which are not read either, are reported per operation by
 * `warnOnIgnoredCallbacks` at the sites that read Operation Objects.
 */
function warnOnLegacyWebhooks(legacy: unknown): void {
  if (typeof legacy !== 'object' || legacy === null) return;
  console.warn(
    '[oagen] Warning: `x-webhooks` is not read. Declare the webhooks under the top-level `webhooks` map (OpenAPI 3.1) to have them parsed.',
  );
}

/** A `components.securitySchemes` entry as it appears in the OpenAPI document. */
interface SecuritySchemeObject {
  type: string;
  description?: string;
  scheme?: string;
  in?: string;
  name?: string;
  flows?: Record<string, unknown>;
}

/**
 * Extract authentication schemes from OpenAPI securitySchemes.
 *
 * Document order is preserved. Each entry carries its `securitySchemes` key as
 * `schemeName` so emitters can join the requirements under `ApiSpec.security`
 * and `Operation.security` back to it.
 * Schemes the IR cannot represent are omitted with a warning rather than silently.
 */
function extractAuthSchemes(securitySchemes?: Record<string, SecuritySchemeObject>): AuthScheme[] | undefined {
  if (!securitySchemes) return undefined;
  const schemes: AuthScheme[] = [];
  for (const [schemeName, scheme] of Object.entries(securitySchemes)) {
    // Omit `description` entirely (rather than setting it to undefined) when the
    // document does not declare one. An explicit empty string is a declared value
    // and is kept, so consumers can tell "empty" from "missing".
    const common = scheme.description !== undefined ? { schemeName, description: scheme.description } : { schemeName };
    // HTTP authentication scheme names are case-insensitive (RFC 9110 §11.1).
    const httpScheme = scheme.type === 'http' ? scheme.scheme?.toLowerCase() : undefined;
    if (httpScheme === 'bearer') {
      schemes.push({ kind: 'bearer', ...common });
    } else if (httpScheme === 'basic') {
      schemes.push({ kind: 'basic', ...common });
    } else if (scheme.type === 'apiKey' && scheme.in && scheme.name) {
      schemes.push({ kind: 'apiKey', ...common, in: scheme.in as 'header' | 'query' | 'cookie', name: scheme.name });
    } else if (scheme.type === 'oauth2' && scheme.flows) {
      schemes.push({ kind: 'oauth2', ...common, flows: scheme.flows });
    } else {
      // Other http schemes (digest, ...), openIdConnect, mutualTLS, and malformed
      // entries have no IR representation; say so instead of dropping them silently.
      const detail = scheme.type === 'http' ? `type: http, scheme: ${scheme.scheme}` : `type: ${scheme.type}`;
      console.warn(`[oagen] Warning: Unsupported security scheme "${schemeName}" (${detail}) omitted from spec.auth`);
    }
  }
  return schemes.length > 0 ? schemes : undefined;
}
