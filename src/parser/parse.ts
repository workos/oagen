import type { ApiSpec, AuthScheme, EnumRef, Model } from '../ir/types.js';
import { defaultSdkBehavior } from '../ir/sdk-behavior.js';
import { foldHttpAuthScheme, isHttpAuthScheme } from '../ir/http-auth-scheme.js';
import { SpecParseError } from '../errors.js';
import { loadAndBundleSpec } from './refs.js';
import {
  extractSchemas,
  extractInlineModelsFromSchemas,
  clearSchemaNameTransform,
  rehearse,
  resolveSchemaName,
} from './schemas.js';
import { attachSharedRefs, extractOperations, type OperationExtractionResult } from './operations.js';
import { sentOnlyComponentNames, type FieldInlineModelGroup } from './inline-models.js';
import { collectExistingEnumNames, collectExistingNames, extractWebhooks, type SharedMinting } from './webhooks.js';
import { extractCallbacks } from './callbacks.js';
import { followReference, siblingDocsMode, type ReferenceObject, type SiblingDocs } from './reference-objects.js';
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
import { settleBases } from './settle-bases.js';
import { resolveSchemaPointers } from './schema-pointers.js';
import { collapseErrorBodies } from './collapse-error-bodies.js';
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
  /**
   * Custom transform for operation IDs. Receives each `operationId` once, as
   * the document spells it with its trailing `[N]` overload markers stripped;
   * returns the operation's name, used as is (no casing conversion). A result
   * with no ASCII letter or digit once such markers are stripped (`''`,
   * `' '`, `'-'`, `'[1]'`), or that is not a string, names nothing: the
   * operation is then read as one without an `operationId` — path-named, its
   * models named from its path, `Operation.operationId` unset — after one
   * warning naming the id and the operation (#570). An `operationId` that
   * itself names nothing is never passed. When omitted, ids are camelCased.
   */
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
   * Fold the models materialized for inline error bodies onto shared models
   * named by shape (`ErrorBody`, `ErrorBodyWithCode`, the enum `ErrorBodyCode`;
   * see `collapseErrorBodies`). A body's shape, and so its name, is its
   * required fields — their names, domain names and types — so an optional
   * field added to a body or to a nested item moves no model (#506, #516),
   * and two shapes never ask for one name (#515): `{ message: string | null }`
   * is `ErrorBodyWithNullableMessage`, `{ code: integer, message }` is
   * `ErrorBodyWithCodeInteger`, `{ status: 404, message }` is
   * `ErrorBodyWithStatus404`, `{ error: integer, error_description }` is
   * `OAuthErrorBodyWithErrorInteger`, `{ message, errors: [{ code, message }] }`
   * is `ErrorBodyWithCodeMessageErrors`, a `{ message }` hinted
   * `message → detail` is `ErrorBodyWithMessageAsDetail`, and a body that
   * requires no field is named from every field under `Optional`
   * (`OptionalErrorBody` for `{ message? }`); what no name can spell — a
   * value pinned inside an array, a discriminator mapping, the component or
   * named enum a field references, a field named like another field's
   * qualifier (`code_integer` beside `code: integer`), a pinned value that
   * spells a family prefix (`code: 'optional'` beside `{ message? }`) —
   * leaves the later shape's models as they are, with a warning; a shape
   * whose name is its field names alone sorts before one a qualifier
   * spelled, so adding the qualified shape moves no model. A component of the shared name takes each
   * body it declares every field, domain name and limit of, and leaves a
   * body it would narrow as it is. An optional field's hint is carried
   * whichever bodies give it, and dropped with a warning when two bodies
   * hint it apart. On by default; `false` keeps one model per operation and
   * status code (`<Op>Error<code>`).
   */
  collapseErrorBodies?: boolean;
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
      callbacks?: Record<string, unknown>;
      securitySchemes?: Record<string, SecuritySchemeObject | ReferenceObject>;
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
  // pass renames the model it was carried onto. The fields of a component
  // the operations only send, read off the document since none is read yet
  // (`sentOnlyComponentNames`), are sites the SDK sends: a field object there
  // shares a component of its name on an identical shape only.
  const fieldInlineModelBundlesBySite = fieldInlineModelBundles(
    fieldInlineModelGroups,
    models,
    sentOnlyComponentNames(transformed),
  );
  // The component schemas' names, resolved while the transform is still
  // active so they match the models': they let every merge pass tell a
  // clash with a component schema from one between two inline models, and
  // tell a component — which admits no copy while deprecated (#441) — from
  // the object the schema pass lifted from one of its fields, which still
  // admits the field extractor's own deprecated copy of that field.
  const componentNames = new Set(
    Object.keys(spec.components?.schemas ?? {}).map((schemaName) => resolveSchemaName(schemaName)),
  );
  const fieldInlineModels = settleFieldInlineModels(models, extractedFieldModels, {
    bundles: fieldInlineModelBundlesBySite,
    reserved: reservedTypeNames(models, enums, [], extractedFieldModels, []),
    enums: enumNames,
    minted: mintedNames,
    mintedFor,
    components: componentNames,
  });

  const receivedComponents = {
    schemas: spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
    parameters: spec.components?.parameters as Record<string, Record<string, unknown>> | undefined,
    requestBodies: spec.components?.requestBodies as Record<string, Record<string, unknown>> | undefined,
    responses: spec.components?.responses as Record<string, Record<string, unknown>> | undefined,
    examples: spec.components?.examples as Record<string, Record<string, unknown>> | undefined,
    pathItems: spec.components?.pathItems as Record<string, Record<string, unknown>> | undefined,
    callbacks: spec.components?.callbacks as Record<string, Record<string, unknown>> | undefined,
  };
  /** What a reading of the operations hands the webhooks and the callbacks: the names they step past, and the callbacks the operations declare. */
  type OperationsReading = Pick<OperationExtractionResult, 'services' | 'inlineModels' | 'declaredCallbacks'>;
  /**
   * The webhooks, read beside a reading of the operations: their models are
   * named against every model and enum decided so far — components, the
   * operations', and the components' own inline field models.
   */
  const readWebhooks = (operations: OperationsReading, mintings: SharedMinting[]) =>
    extractWebhooks(
      spec.webhooks,
      receivedComponents,
      collectExistingNames([...models, ...operations.inlineModels, ...fieldInlineModels], operations.services, enums),
      collectExistingEnumNames(
        [...models, ...operations.inlineModels, ...fieldInlineModels],
        operations.services,
        enums,
      ),
      // Text beside a `$ref` is read by the document's version, as for operations.
      siblingDocsMode(version),
      // A webhook entry may be a `$ref` to a `paths` entry, as to another webhook.
      spec.paths,
      mintings,
    );
  /** The callbacks the operations and the webhooks declare, read after both and named against every name either holds. */
  const readCallbacks = (
    operations: OperationsReading,
    received: ReturnType<typeof readWebhooks>,
    mintings: SharedMinting[],
  ) =>
    extractCallbacks(
      [...operations.declaredCallbacks, ...received.declaredCallbacks],
      receivedComponents,
      collectExistingNames(
        [...models, ...operations.inlineModels, ...fieldInlineModels, ...received.inlineModels],
        operations.services,
        enums,
        received.webhooks,
      ),
      collectExistingEnumNames(
        [...models, ...operations.inlineModels, ...fieldInlineModels, ...received.inlineModels],
        operations.services,
        enums,
        received.webhooks,
      ),
      siblingDocsMode(version),
      spec.paths,
      spec.webhooks,
      mintings,
    );

  const { services, inlineModels, inlineModelBundles, componentSites, declaredCallbacks } = extractOperations(
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
    // Or a `$ref` to a `webhooks` entry, as a webhook's may name a `paths` one.
    spec.webhooks,
    // The webhooks and the callbacks are read after the operations and mint
    // names too, so a name one operation gives up to another (#683) is
    // numbered past the ones they mint beside the operations: read here
    // silently, off the very readings below, into nothing that is kept.
    {
      mintedAfter: (operations) =>
        rehearse(() => {
          const mintings: SharedMinting[] = [];
          const received = readWebhooks(operations, mintings);
          const callbacks = readCallbacks(operations, received, mintings);
          return collectExistingNames(
            [...received.inlineModels, ...callbacks.inlineModels],
            operations.services,
            [],
            received.webhooks,
          );
        }),
    },
  );

  // Webhooks are read while the schema-name transform is still active, like
  // operations, so a payload's `$ref`s resolve to the same names as a field's.
  // Their models are named last, against every model and enum decided so far —
  // components, operations, and the components' own inline field models — so
  // a webhook never takes a name another pass has already minted.
  // What each group of webhooks minted, for the callbacks below: a callback
  // reaching the operation object a webhook was minted from shares that
  // minting rather than minting a copy beside it (#631).
  const webhookMintings: SharedMinting[] = [];
  const received = readWebhooks({ services, inlineModels, declaredCallbacks }, webhookMintings);
  const { webhooks, inlineModels: webhookInlineModels, inlineModelBundles: webhookInlineModelBundles } = received;
  warnOnLegacyWebhooks(spec['x-webhooks']);

  // The callbacks every operation and webhook declares are read last, into
  // `Operation.callbacks` / `Webhook.callbacks`, through the webhook
  // machinery (#382): their models are named against every name decided so
  // far — components, operations, webhooks, the components' field models —
  // and join the webhooks' from here on, since a callback's payload is
  // received exactly as a webhook's is and every later pass reaches it the
  // same way (`collectWebhookTypeRefs`, `collectOperationTypeRefs`). A
  // callback reading the operation object of one of `webhookMintings` under
  // its stem names nothing: it references the webhook's models (#631).
  const { inlineModels: callbackInlineModels, inlineModelBundles: callbackInlineModelBundles } = readCallbacks(
    { services, inlineModels, declaredCallbacks },
    received,
    webhookMintings,
  );
  webhookInlineModels.push(...callbackInlineModels);
  webhookInlineModelBundles.push(...callbackInlineModelBundles);

  // The references a schema `$ref` that names no component left pending —
  // a pointer deeper into a component, `#/components/schemas/Pet/properties/
  // owner` (#539) — are settled now that every model is built and before
  // any merge pass renames one, while the transform is still active so the
  // component a pointer enters is typed as every `$ref` to it is. Each
  // settled reference joins the site of the model it names
  // (`attachSharedRefs` below), so a rename of that model reaches it.
  const settledPointerRefs = resolveSchemaPointers(
    { models: [...models, ...fieldInlineModels, ...inlineModels, ...webhookInlineModels], services, webhooks },
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
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
    components: componentNames,
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
  // model reaches the array too (`attachSharedRefs`); so does a reference a
  // pointer into a component settled to that model (`settledPointerRefs`).
  attachSharedRefs(naming.bundles, componentNames, settledPointerRefs);
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
  // The inline error bodies, one model per operation and status code until here,
  // fold onto shared models named by shape (`ErrorBody`, `ErrorBodyWithCode`),
  // their pinned `code`s gathered into one enum the collectors below lift.
  const collapsedModels =
    options?.collapseErrorBodies === false
      ? finalModels
      : collapseErrorBodies({ services, webhooks, models: finalModels }, { componentNames, componentSites, enums });
  // A hint keyed by a shared model's name (`ErrorBodyWithCode`) applies here;
  // one keyed by a folded model's name was applied above and rode along.
  applyFieldHints(collapsedModels, options?.fieldHints);
  // Each collector steps a renamed enum around every model name as well as
  // every enum's, so the merge passes above (which mint against every enum
  // name an `EnumRef` carries) and the collectors never meet on one name.
  collectInlineEnumsFromModels(collapsedModels, enums);
  collectInlineEnumsFromOperations(services, enums, componentSites, collapsedModels, componentNames);
  // A webhook's callbacks are reached through the webhook; an operation's
  // are lifted here, as received requests, after the operation's own.
  collectInlineEnumsFromWebhooks(webhooks, enums, collapsedModels);
  collectInlineEnumsFromWebhooks(
    services.flatMap((service) => service.operations.flatMap((op) => op.callbacks ?? [])),
    enums,
    collapsedModels,
  );
  // Noted once the collectors have settled the name: `PetJsonMode` renamed
  // to `PetMode` beside a component model `PetMode` is lifted as `PetMode2`.
  for (const [name, ref] of foldedEnums) console.warn(`[oagen] Folded enum "${name}" into "${ref.name}"`);

  // A `$ref` entry's sibling text is read by the document's version, as for operations.
  const auth = extractAuthSchemes(spec.components?.securitySchemes, siblingDocsMode(version));

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
    models: collapsedModels,
    enums,
    auth,
    security: extractSecurityRequirements(spec.security, 'the document'),
    sdk: defaultSdkBehavior(),
  };

  // Needs the finished models and enums: divergence is decided on member
  // shape, so this can only run once every referenced type is resolvable.
  assignParameterGroupWrapperNames(result);

  // `bases` and `inheritedFrom` as the models end: no chain of bases
  // reaching its own model, each base once, no base or inherited field
  // a fold has since changed under the model (#591), and no base the
  // model's own declaration of a field does not fit (#681) — the enums
  // read for a component enum's values.
  settleBases(result.models, result.enums);

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
 * `callbacks`, which have an agreed shape, are read (`extractCallbacks`;
 * #382).
 */
function warnOnLegacyWebhooks(legacy: unknown): void {
  if (typeof legacy !== 'object' || legacy === null) return;
  console.warn(
    '[oagen] Warning: `x-webhooks` is not read. Declare the webhooks under the top-level `webhooks` map (OpenAPI 3.1) to have them parsed.',
  );
}

/**
 * A `components.securitySchemes` entry as it appears in the OpenAPI
 * document, before validation: any key may be missing or of another type,
 * and `extractAuthSchemes` decides what reaches the IR.
 */
interface SecuritySchemeObject {
  type: string;
  description?: string;
  scheme?: string;
  in?: string;
  name?: string;
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
}

/**
 * Extract authentication schemes from OpenAPI securitySchemes.
 *
 * Document order is preserved. Each entry carries its `securitySchemes` key as
 * `schemeName` so emitters can join the requirements under `ApiSpec.security`
 * and `Operation.security` back to it.
 *
 * Every `type` the Security Scheme Object defines is read (#662), whichever
 * 3.x version the document declares: `apiKey` with its `in` and `name`,
 * `oauth2` with its `flows`, `openIdConnect` with its `openIdConnectUrl` as
 * written, `mutualTLS`, and `http` by its `scheme`, matched
 * case-insensitively (RFC 9110 §11.1, `foldHttpAuthScheme`) — `basic` and
 * `bearer` are their own kinds, and any other scheme (`Digest`, `HOBA`,
 * `Negotiate`, …) is `kind: 'http'` with `scheme` as written.
 *
 * What is left has no representation and is omitted with an `Unsupported
 * security scheme "<key>" (<what is wrong>) omitted from spec.auth` warning
 * rather than silently: an entry that is no object — `null`, a string, a
 * number, a boolean, an array — said in words (`null is not a Security
 * Scheme Object`, `a string is not …`, `an array is not …`), where reading
 * it as an object used to fail the parse with a `TypeError`; a `type` that
 * is not one of the specification's five, compared as written, so `saml`
 * and `OpenIdConnect` are none (`type is not apiKey, http, mutualTLS,
 * oauth2 or openIdConnect`), or that is missing (`no type`) or no string
 * (`type is a number, not a string`); and a definition without the field
 * its type is read by — an `http` scheme with no `scheme` (`type: http, no
 * scheme`), one that is no string (`type: http, scheme is a number, not a
 * string`), a blank one (`type: http, scheme is blank`) or one that is not
 * an RFC 9110 token (`type: http, scheme is not a token`;
 * `isHttpAuthScheme`), an `openIdConnect` one with no `openIdConnectUrl`
 * (`type: openIdConnect, no openIdConnectUrl`), one that is no string
 * (`openIdConnectUrl is a number, not a string`) or a blank one
 * (`openIdConnectUrl is blank`), an `apiKey` with no `in` or no `name`
 * (`type: apiKey, no name`), an `oauth2` with no `flows` (`type: oauth2, no
 * flows`). A requirement naming an omitted scheme is kept, so it joins to
 * nothing.
 *
 * A warning names the key and what kind of value it met, never the value
 * (`describeSchemeValue`): this map is where a credential pasted by mistake
 * lands, and a warning goes to a build log.
 *
 * An entry may be a `$ref` to another entry of the map — OAS 3.0.3 and
 * 3.1.0 both allow a Reference Object under `components.securitySchemes` —
 * and is followed, chains included, through `followReference`, the walk
 * every Reference Object takes, so the scheme is read under the REFERENCING
 * key with the target's definition: `petKey: { $ref:
 * '#/components/securitySchemes/sharedKey' }` is `schemeName: 'petKey'`
 * beside `sharedKey`'s own entry, and a requirement naming `petKey` joins to
 * it (#384). A `description` written beside the `$ref` overrides the
 * target's under 3.1 and is ignored under 3.0 (`siblingDocs`). A ref the map
 * does not answer — a pointer into another section, or a `$ref` that is not
 * a string — is omitted with the same warning an unsupported scheme gets:
 * a pointer is named with how the walk ended (`$ref
 * #/components/schemas/Pet unresolved`), and a `$ref` that is no string by
 * what it is (`$ref is a number, not a string`). One that ends on an entry
 * the map holds but that is no object (`sharedKey: null`) says what it
 * found (`$ref #/components/securitySchemes/sharedKey names null, not a
 * Security Scheme Object`), beside that entry's own warning; one that names
 * no component at all, or a cycle of refs, fails the bundle before parsing,
 * as any dangling ref does.
 */
function extractAuthSchemes(
  securitySchemes: Record<string, SecuritySchemeObject | ReferenceObject> | undefined,
  siblingDocs: SiblingDocs,
): AuthScheme[] | undefined {
  if (!securitySchemes) return undefined;
  const schemes: AuthScheme[] = [];
  // Every pointer is `#/components/securitySchemes/<name>`, so the map
  // itself is what a ref resolves against.
  const components = securitySchemes as unknown as Record<string, Record<string, unknown>>;
  for (const [schemeName, entry] of Object.entries(securitySchemes)) {
    // Say what is wrong with an entry that has no IR representation instead
    // of dropping it silently.
    const omit = (detail: string): void =>
      console.warn(`[oagen] Warning: Unsupported security scheme "${schemeName}" (${detail}) omitted from spec.auth`);
    // `null`, a string, a number, a boolean or an array declares no scheme,
    // and is no Reference Object to follow either: say what it is instead
    // of failing the parse on it.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      omit(`${describeSchemeValue(entry)} is not a Security Scheme Object`);
      continue;
    }
    const followed = followReference<SecuritySchemeObject>(entry, 'securitySchemes', components, siblingDocs);
    if (followed.outcome !== 'resolved') {
      if (followed.found !== undefined) {
        // The chain ends on an entry the map holds but that is no object:
        // that same malformed entry behind a pointer, not a missing one.
        omit(`$ref ${followed.ref} names ${describeSchemeValue(followed.found.value)}, not a Security Scheme Object`);
      } else if (followed.outcome === 'malformed') {
        // A `$ref` that is no string is no pointer to print.
        const ref = (followed.value as { $ref?: unknown }).$ref;
        omit(`$ref is ${describeSchemeValue(ref)}, not a string`);
      } else {
        // A pointer the bundle resolved and this map does not answer.
        omit(`$ref ${followed.ref} ${followed.outcome}`);
      }
      continue;
    }
    const scheme = followed.value;
    // Omit `description` entirely (rather than setting it to undefined) when the
    // document does not declare one. An explicit empty string is a declared value
    // and is kept, so consumers can tell "empty" from "missing".
    const common = scheme.description !== undefined ? { schemeName, description: scheme.description } : { schemeName };
    switch (scheme.type) {
      case 'http': {
        // An `http` scheme is its `scheme`, the `auth-scheme` token of an
        // `Authorization` header; without one there is nothing to carry.
        const name: unknown = scheme.scheme;
        if (name === undefined) {
          omit('type: http, no scheme');
          break;
        }
        if (typeof name !== 'string') {
          omit(`type: http, scheme is ${describeSchemeValue(name)}, not a string`);
          break;
        }
        if (name.trim() === '') {
          omit('type: http, scheme is blank');
          break;
        }
        if (!isHttpAuthScheme(name)) {
          omit('type: http, scheme is not a token');
          break;
        }
        // Scheme names are case-insensitive (RFC 9110 §11.1): `Bearer`,
        // `bearer` and `BEARER` are one scheme, and so are `Basic`'s spellings.
        const folded = foldHttpAuthScheme(name);
        if (folded === 'bearer') {
          schemes.push({ kind: 'bearer', ...common });
        } else if (folded === 'basic') {
          schemes.push({ kind: 'basic', ...common });
        } else {
          // Any other scheme (`Digest`, `HOBA`, `Negotiate`, …), as written.
          schemes.push({ kind: 'http', ...common, scheme: name });
        }
        break;
      }
      case 'apiKey': {
        const missing = (['in', 'name'] as const).filter((key) => !scheme[key]);
        if (missing.length > 0) {
          omit(`type: apiKey, no ${missing.join(' or ')}`);
        } else {
          schemes.push({
            kind: 'apiKey',
            ...common,
            in: scheme.in as 'header' | 'query' | 'cookie',
            name: scheme.name as string,
          });
        }
        break;
      }
      case 'oauth2':
        if (scheme.flows) schemes.push({ kind: 'oauth2', ...common, flows: scheme.flows });
        else omit('type: oauth2, no flows');
        break;
      case 'openIdConnect': {
        // An `openIdConnect` scheme is its discovery URL, kept exactly as
        // written, as `externalDocs.url` is: the parser neither resolves nor
        // rewrites it.
        const url: unknown = scheme.openIdConnectUrl;
        if (url === undefined) {
          omit('type: openIdConnect, no openIdConnectUrl');
        } else if (typeof url !== 'string') {
          omit(`type: openIdConnect, openIdConnectUrl is ${describeSchemeValue(url)}, not a string`);
        } else if (url.trim() === '') {
          omit('type: openIdConnect, openIdConnectUrl is blank');
        } else {
          schemes.push({ kind: 'openIdConnect', ...common, openIdConnectUrl: url });
        }
        break;
      }
      case 'mutualTLS':
        // The Security Scheme Object has no field for it beside `description`.
        schemes.push({ kind: 'mutualTLS', ...common });
        break;
      default: {
        // Not one of the specification's five values, which are compared as
        // written: `OpenIdConnect` and `mutualtls` are not types.
        const type: unknown = scheme.type;
        if (type === undefined) omit('no type');
        else if (typeof type !== 'string') omit(`type is ${describeSchemeValue(type)}, not a string`);
        else omit('type is not apiKey, http, mutualTLS, oauth2 or openIdConnect');
      }
    }
  }
  return schemes.length > 0 ? schemes : undefined;
}

/**
 * What a value met where a Security Scheme Object, or one of its fields,
 * was expected is, in words: `null`, `an array`, `an object`, `a string`,
 * `a number`, `a boolean`. `extractAuthSchemes`' warnings say this much and
 * never print the value: `components.securitySchemes` is where a credential
 * pasted by mistake lands (`petAuth: "sk_live_…"`, `scheme: "Bearer
 * sk_live_…"`), and a warning goes to a build log.
 */
function describeSchemeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}
