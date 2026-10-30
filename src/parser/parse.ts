import type { ApiSpec, AuthScheme, EnumRef, Model } from '../ir/types.js';
import { defaultSdkBehavior } from '../ir/sdk-behavior.js';
import { SpecParseError } from '../errors.js';
import { loadAndBundleSpec } from './refs.js';
import {
  extractSchemas,
  extractInlineModelsFromSchemas,
  clearSchemaNameTransform,
  resolveSchemaName,
} from './schemas.js';
import { attachSharedRefs, extractOperations } from './operations.js';
import type { FieldInlineModelGroup } from './inline-models.js';
import { collectExistingEnumNames, collectExistingNames, extractWebhooks } from './webhooks.js';
import { siblingDocsMode } from './reference-objects.js';
import {
  mergeInlineResponseModels,
  collapseJsonSuffixModels,
  mergeFieldInlineModels,
  fieldInlineModelBundles,
  refreshFieldInlineModelBundles,
  reservedNamesByKind,
  reservedTypeNames,
  settleFieldInlineModels,
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
  const extractedFieldModels = extractInlineModelsFromSchemas(
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
    fieldInlineModelGroups,
  );
  // The components' own field models are settled against the components
  // right here, before any operation or webhook is read
  // (`settleFieldInlineModels`): a field object named like a component that
  // does not admit it takes its qualified name now (`PetOwner2`), and one
  // the component admits is dropped for it, so every later reader — the
  // operations' bodies, the shape registry, the webhooks, the merges below —
  // sees each component referencing its children by their final names, and
  // no parent is ever compared with a component on an unsettled child. The
  // names are minted against everything decided so far; a reference an
  // `allOf` merge copies from such a field later is created under the
  // settled name (`recordInheritedModelRefs`). A field object named like
  // one of the document's enums (`enumNames`: the component enums and the
  // enums the component pass lifted) takes its qualified name here too; one
  // named like an enum an operation or webhook carries, which is not known
  // yet, takes it when the merges below settle the fields again against
  // every enum name in play.
  const enumNames: ReadonlySet<string> = new Set(enums.map((e) => e.name));
  // The names every merge pass mints, shared across the passes so a later
  // one can tell a parent whose child an earlier pass renamed
  // (`InlineModelNaming.minted`). Each field's site already holds the object
  // the schema pass lifted from the field's own schema
  // (`fieldInlineModelBundles`, `liftedFieldModelsOf`), so a copy dropped
  // here for it needs no record. The model each name was minted for goes
  // along under the name it left (`InlineModelNaming.mintedFor`), so an
  // operation's copy identical to a field's that left a name here joins the
  // field's model rather than minting another.
  const mintedNames = new Set<string>();
  const mintedFor = new Map<string, Map<Model, number>>();
  // The field sites, kept for the merges below (`refreshFieldInlineModelBundles`):
  // what a fold carries onto a site here must still be there when a later
  // pass renames the model it was carried onto.
  const fieldInlineModelBundlesBySite = fieldInlineModelBundles(fieldInlineModelGroups, models);
  const fieldInlineModels = settleFieldInlineModels(models, extractedFieldModels, {
    bundles: fieldInlineModelBundlesBySite,
    reserved: reservedTypeNames(models, enums, [], extractedFieldModels, []),
    enums: enumNames,
    minted: mintedNames,
    mintedFor,
  });

  const { services, inlineModels, inlineModelBundles, componentSites } = extractOperations(
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
    // The component enums, so no model the operations pass mints — a header,
    // parameter, fallback, error or secondary body's, an array body's items —
    // takes one of their names.
    enums,
    // A `paths` entry may be a `$ref` into this map (OpenAPI 3.1); the
    // webhooks below resolve theirs against the same one.
    spec.components?.pathItems as Record<string, Record<string, unknown>> | undefined,
  );

  // Webhooks are read while the schema-name transform is still active, like
  // operations, so a payload's `$ref`s resolve to the same names as a field's.
  // Their models are named last, against every model and enum decided so far —
  // components, operations, and the components' own inline field models — so
  // a webhook never takes a name another pass has already minted.
  const {
    webhooks,
    inlineModels: webhookInlineModels,
    inlineModelBundles: webhookInlineModelBundles,
  } = extractWebhooks(
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
    collectExistingEnumNames([...models, ...inlineModels, ...fieldInlineModels], services, enums),
    // Text beside a `$ref` is read by the document's version, as for operations.
    siblingDocsMode(version),
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
  // every pass, and every inline enum the collectors below will lift — so a
  // copy a merge pass must rename (a response named like a component that
  // does not admit it, a deprecated response named like a live one) takes a
  // name nothing else has or will have, in either pass; and the enum names
  // among them, which no inline model keeps: a `getPet` body beside a
  // component enum `GetPetResponse` steps to `GetPetResponse2`, and so does
  // a `createPet` body beside a `request` query enum of its service named
  // `CreatePetRequest`, as a `request` parameter object beside that enum
  // steps in the shape registry (`reserveEnumNames`) — the model steps
  // wherever an enum of its name exists, so the IR never declares a model
  // and an enum under one name. An enum the collectors lift after a model
  // of its name that no pass could rename (a component model) steps itself
  // (`collectDistinctEnums`). Every site is here: the operations', the
  // webhooks', and the component fields' — read again, with the references
  // the operations' and webhooks' `allOf` merges have copied from component
  // fields since the fields were settled.
  const reserved = reservedNamesByKind(
    models,
    enums,
    [...inlineModels, ...webhookInlineModels],
    fieldInlineModels,
    services,
    webhooks,
  );
  const naming: InlineModelNaming = {
    bundles: [
      ...inlineModelBundles,
      ...webhookInlineModelBundles,
      // The field sites from the settle, brought up to date: each holds the
      // object the schema pass lifted from the field's own schema, which the
      // extracted copy folded onto at the settle, and whatever a fold carried
      // onto it there, so a rename here reaches all of it; the references a
      // header or fallback body wrote by sharing that object join the site
      // below (`attachSharedRefs`) and follow the rename.
      ...refreshFieldInlineModelBundles(fieldInlineModelBundlesBySite, fieldInlineModelGroups, fieldInlineModels),
    ],
    reserved: reserved.all,
    enums: reserved.enums,
    minted: mintedNames,
    mintedFor,
  };
  // The components' field models, settled above, own their names here as
  // the components do (`declared`), so a nested object of a response named
  // like one is decided against it before its parent is compared — never
  // passed for it by name under a parent the lifted model admits.
  const responseNormalizedModels = mergeInlineResponseModels(
    models,
    [...inlineModels, ...webhookInlineModels],
    naming,
    fieldInlineModels,
  );
  // An operation's array items that share a component field's model
  // (`typeInlineItems`) join that field's site, so a rename of the field's
  // model reaches the array too (`attachSharedRefs`).
  attachSharedRefs(naming.bundles, componentNames);
  const fieldMergedModels = mergeFieldInlineModels(responseNormalizedModels, fieldInlineModels, componentNames, naming);
  // The lifted enums the fold renamed away, each with a reference that now
  // carries the new name.
  const foldedEnums = new Map<string, EnumRef>();
  const finalModels = collapseJsonSuffixModels(
    fieldMergedModels,
    services,
    webhooks,
    enums,
    componentNames,
    foldedEnums,
  );
  applyFieldHints(finalModels, options?.fieldHints);
  // Each collector steps a renamed enum around every model name as well as
  // every enum's, so the merge passes above (which mint against every enum
  // name an `EnumRef` carries) and the collectors never meet on one name.
  collectInlineEnumsFromModels(finalModels, enums);
  collectInlineEnumsFromOperations(services, enums, componentSites, finalModels, componentNames);
  collectInlineEnumsFromWebhooks(webhooks, enums, finalModels);
  // Noted once the collectors have settled the name: `PetJsonMode` renamed
  // to `PetMode` beside a component model `PetMode` is lifted as `PetMode2`.
  for (const [name, ref] of foldedEnums) console.warn(`[oagen] Folded enum "${name}" into "${ref.name}"`);

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
