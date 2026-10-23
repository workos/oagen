import type {
  Service,
  Operation,
  HttpMethod,
  Parameter,
  ParameterGroup,
  TypeRef,
  ErrorResponse,
  SuccessResponse,
  ResponseHeader,
  ResponseContent,
  RequestBodyContent,
  Enum,
  DefaultResponse,
  RangeResponse,
  Model,
  Field,
  PaginationMeta,
  PaginationEndOfIteration,
  ExternalDocs,
  ServerEntry,
} from '../ir/types.js';
import { pathSegments, readPath, type OperationHint } from '../ir/operation-hints.js';
import { isDefaultServerList, serverListsEqual } from '../ir/server-url.js';
import { foldHeaderName, foldParameterName, parameterKey } from '../ir/parameter-key.js';
import { createHash } from 'node:crypto';
import {
  toPascalCase,
  toCamelCase,
  splitWords,
  cleanSchemaName,
  stripListItemMarkers,
  singularizePathSegment,
} from '../utils/naming.js';
import { isJsonMediaType, isPlainJsonMediaType, mediaTypeEssence, mediaTypeNameFragment } from '../utils/media-type.js';
import type { SchemaObject } from './schemas.js';
import {
  schemaToTypeRef,
  buildFieldFromSchema,
  nameInlineVariant,
  resolveSchemaName,
  nonEmptyExamples,
  resolveExamples,
  resolveComponentSchemaRef,
  extractConstraints,
  constraintsEntry,
  deprecatedEntry,
  collapsedNullableBranch,
  foldSiblingProperties,
  isInlineObjectSchema,
  nonObjectVariantContexts,
  unwrapNullableField,
  warnOnUncarriedProperties,
} from './schemas.js';
import {
  collectResponseHeaders,
  collectModelRefs,
  collectModelTypeRefs,
  collectEnumRefs,
  collectOperationTypeRefs,
} from '../ir/types.js';
import { collectProperties, extractInlineModelsFromProperties, type InlineModelBundle } from './inline-models.js';
import {
  detectPagination,
  derivePageStart,
  paginatedItemType,
  resolvePaginationOverride,
  resolveOverrideParams,
  applyPaginationOverride,
  resolveDataPathItemType,
} from './pagination.js';
import {
  classifyAndExtractResponse,
  composedWithoutFields,
  classifyResponseKey,
  resolveDataPathFromSchema,
  STATUS_RANGE_LABELS,
  warnUnrecognizedResponseKey,
} from './responses.js';
import type { ResponseKey } from './responses.js';
import type { ItemSettlement, ResponseExtractionResult } from './responses.js';
import { resolveResponseRef, type ReferenceObject } from './response-refs.js';
import {
  materializeInlineSchema,
  modelFingerprint,
  registerInlineModels,
  reserveEnumNames,
  type InlineModelRegistry,
  type InlineModelOwner,
  type SiblingSites,
} from './materialize-inline.js';
import { extractSecurityRequirements, type RawSecurityRequirements } from './security.js';
import { extractServerList } from './servers.js';
import { resolveEnvelopeCompanionNames, companionBundles, type EnvelopeCompanion } from './envelope-companion-names.js';
import { externalDocsEntry, readExternalDocs, type RawExternalDocs } from './external-docs.js';
import { warnOnIgnoredCallbacks } from './callbacks.js';
import { resolvePathItemRef } from './path-item-refs.js';

export interface PathItem {
  /**
   * A reference to another Path Item, which OpenAPI 3.1 lets a `paths` entry
   * be written as (`$ref: '#/components/pathItems/Pets'`). Resolved by
   * `resolvePathItems` before anything else is read from the entry, so no
   * item the passes of `extractOperations` read carries one.
   */
  $ref?: string;
  /**
   * The Path Item's own `summary`, which OpenAPI applies to every operation
   * on it; read for an operation that declares none (`resolveOperationDocs`).
   */
  summary?: string;
  /** The Path Item's own `description`, applied to its operations the same way. */
  description?: string;
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
  trace?: OperationObject;
  parameters?: RawParameterObject[];
  /** The Path Item's own `servers`, narrowed entry by entry by `extractServerList`. */
  servers?: unknown;
}

interface ParameterGroupExtension {
  optional: boolean;
  variants: Record<string, string[]>;
  /** Per-variant names that may be omitted when the variant is used. */
  optionalFields?: Record<string, string[]>;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  externalDocs?: RawExternalDocs;
  parameters?: RawParameterObject[];
  requestBody?: RawRequestBodyObject;
  responses?: Record<string, ResponseObject>;
  deprecated?: boolean;
  'x-oagen-async'?: boolean;
  /** Explicit pagination override; validated by `applyPaginationOverrides`. */
  'x-pagination'?: unknown;
  security?: RawSecurityRequirements;
  /** The operation's own `servers`, narrowed entry by entry by `extractServerList`. */
  servers?: unknown;
  'x-mutually-exclusive-parameter-groups'?: Record<string, ParameterGroupExtension>;
  'x-mutually-exclusive-body-groups'?: Record<string, ParameterGroupExtension>;
  /** Not read; `warnOnIgnoredCallbacks` reports an operation that declares any. */
  callbacks?: unknown;
}

/**
 * An OAS Example Object, as the entries of a parameter's `examples` map and
 * of `components.examples`. Only `value` is read: a `$ref` entry is first
 * resolved against `components.examples` (see `resolveExampleRef`), and an
 * entry that carries `externalValue` instead has no inline value to surface.
 */
interface ExampleObject {
  summary?: string;
  description?: string;
  value?: unknown;
  externalValue?: string;
  $ref?: string;
}

/**
 * The Media Type Object a Parameter Object's or Header Object's `content`
 * map holds under a media type: the schema that types the value and the
 * examples beside it. `encoding` is not read.
 */
export interface ParameterMediaTypeObject {
  schema?: SchemaObject;
  example?: unknown;
  /** Media-type-level examples: a map of Example Objects, as the parameter's own `examples` is. */
  examples?: Record<string, ExampleObject>;
}

/**
 * What a Parameter Object or Header Object types its value with: a
 * `schema`, or a `content` map in its place — per OAS one or the other,
 * never both, and the map holds one entry. `parameterTyping` resolves the
 * schema either way.
 */
export interface SchemaOrContent {
  schema?: SchemaObject;
  content?: Record<string, ParameterMediaTypeObject>;
}

export interface ParameterObject extends SchemaOrContent {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  example?: unknown;
  /** Parameter-level examples: a map of Example Objects, not a JSON Schema list. */
  examples?: Record<string, ExampleObject>;
  style?: string;
  explode?: boolean;
}

/**
 * A parameter entry as it appears in an operation's (or path item's) raw
 * `parameters` array: either an inline Parameter Object, or a Reference
 * Object (`{ $ref: '#/components/parameters/X' }`). The bundler
 * (`refs.ts`) runs with `dereference: false`, so refs to
 * `components/parameters` are never inlined — they arrive here exactly as
 * written in the spec and must be resolved before use.
 */
export type RawParameterObject = ParameterObject | { $ref: string };

/**
 * Resolve a raw parameter entry to a concrete Parameter Object, following
 * `$ref`s into `components/parameters` when present. Follows chains of refs
 * (a component that itself is a `$ref` to another component), with a cycle
 * guard for a spec that refs itself.
 *
 * Throws when a `$ref` can't be resolved so a malformed spec fails loudly at
 * parse time instead of silently losing the parameter (see `extractParams`,
 * which used to drop any entry with no `in` field — every `$ref` object has
 * none).
 */
export function resolveParameterRef(
  raw: RawParameterObject,
  componentParameters: Record<string, Record<string, unknown>> | undefined,
  operationContext: string,
): ParameterObject {
  const seenRefs = new Set<string>();
  let current: RawParameterObject = raw;

  while ('$ref' in current) {
    if (seenRefs.has(current.$ref)) {
      throw new Error(`Circular parameter $ref chain starting at "${current.$ref}" in ${operationContext}.`);
    }
    seenRefs.add(current.$ref);

    // Match the whole pointer, not just its last token: a ref into any other
    // section must not resolve off a same-named parameter component.
    const match = /^#\/components\/parameters\/(.+)$/.exec(current.$ref);
    // JSON Pointer escapes (RFC 6901 §4): `~1` -> `/`, then `~0` -> `~`, in that order.
    const refName = match?.[1].replace(/~1/g, '/').replace(/~0/g, '~');
    const resolved = refName ? componentParameters?.[refName] : undefined;
    if (!resolved) {
      throw new Error(
        `Unresolved parameter $ref "${current.$ref}" in ${operationContext}: no matching entry under components/parameters.`,
      );
    }
    current = resolved as unknown as RawParameterObject;
  }

  return current;
}

export interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject }>;
}

/**
 * A request body as written in the spec: an inline Request Body Object or a
 * Reference Object into `components/requestBodies`. The bundler never inlines
 * those refs (`dereference: false`), so they must be resolved before use.
 */
export type RawRequestBodyObject = RequestBodyObject | { $ref: string };

/**
 * Resolve a raw request body to a concrete Request Body Object, following
 * `$ref` chains into `components/requestBodies` with a cycle guard. Throws on
 * an unresolvable ref so a malformed spec fails at parse time instead of
 * silently losing the body — and with it the body-ownership rule that keeps
 * duplicated secrets out of the query string.
 */
export function resolveRequestBodyRef(
  raw: RawRequestBodyObject | undefined,
  componentRequestBodies: Record<string, Record<string, unknown>> | undefined,
  operationContext: string,
): RequestBodyObject | undefined {
  if (!raw) return undefined;
  const seenRefs = new Set<string>();
  let current: RawRequestBodyObject = raw;

  while ('$ref' in current) {
    if (seenRefs.has(current.$ref)) {
      throw new Error(`Circular request body $ref chain starting at "${current.$ref}" in ${operationContext}.`);
    }
    seenRefs.add(current.$ref);

    const match = /^#\/components\/requestBodies\/(.+)$/.exec(current.$ref);
    // JSON Pointer escapes (RFC 6901 §4): `~1` -> `/`, then `~0` -> `~`, in that order.
    const refName = match?.[1].replace(/~1/g, '/').replace(/~0/g, '~');
    const resolved = refName ? componentRequestBodies?.[refName] : undefined;
    if (!resolved) {
      throw new Error(
        `Unresolved request body $ref "${current.$ref}" in ${operationContext}: no matching entry under components/requestBodies.`,
      );
    }
    current = resolved as unknown as RawRequestBodyObject;
  }

  return current;
}

/**
 * A Header Object as it appears in a Response Object's `headers` map. Per OAS
 * it carries either `schema` or a single-entry `content` map, never both;
 * the schema that types it is resolved as a parameter's is
 * (`parameterTyping`).
 */
interface HeaderObject extends SchemaOrContent {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
}

/**
 * A header entry as written in the spec: an inline Header Object or a
 * Reference Object into `components/headers`. The bundler never inlines those
 * refs (`dereference: false`), so they must be resolved before use. In OAS 3.1
 * a Reference Object may carry its own `description`, which overrides the
 * referenced component's.
 */
type RawHeaderObject = HeaderObject | { $ref: string; description?: string };

/**
 * Resolve a raw response header to a concrete Header Object, following `$ref`
 * chains into `components/headers` with a cycle guard.
 *
 * Unlike parameters and request bodies, a header that cannot be resolved is
 * warned about and dropped rather than failing the parse: a response header
 * is informational, so losing one costs an emitter a typed accessor, not a
 * wire contract, and should not block generating the rest of the SDK.
 */
function resolveHeaderRef(
  raw: RawHeaderObject,
  componentHeaders: Record<string, Record<string, unknown>> | undefined,
  headerName: string,
  operationContext: string,
): HeaderObject | undefined {
  const seenRefs = new Set<string>();
  let current: RawHeaderObject = raw;
  // Each ref in a chain overrides whatever it points at, so the outermost
  // sibling `description` wins over any inner one and over the component's.
  let description: string | undefined;

  while ('$ref' in current) {
    if (description === undefined && typeof current.description === 'string') description = current.description;
    if (seenRefs.has(current.$ref)) {
      console.warn(
        `[oagen] Warning: Circular header $ref chain starting at "${current.$ref}" for response header ` +
          `"${headerName}" in ${operationContext}. Skipping the header.`,
      );
      return undefined;
    }
    seenRefs.add(current.$ref);

    // Match the whole pointer, not just its last token: a ref into any other
    // section must not resolve off a same-named header component.
    const match = /^#\/components\/headers\/(.+)$/.exec(current.$ref);
    // JSON Pointer escapes (RFC 6901 §4): `~1` -> `/`, then `~0` -> `~`, in that order.
    const refName = match?.[1].replace(/~1/g, '/').replace(/~0/g, '~');
    const resolved = refName ? componentHeaders?.[refName] : undefined;
    if (!resolved) {
      console.warn(
        `[oagen] Warning: Unresolved header $ref "${current.$ref}" for response header "${headerName}" ` +
          `in ${operationContext}: no matching entry under components/headers. Skipping the header.`,
      );
      return undefined;
    }
    current = resolved as unknown as RawHeaderObject;
  }

  return description === undefined ? current : { ...current, description };
}

export interface ResponseObject {
  description?: string;
  headers?: Record<string, RawHeaderObject>;
  content?: Record<string, { schema?: SchemaObject }>;
}

export const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

/**
 * The `paths` map with every entry resolved to the Path Item it denotes —
 * the entry itself, or the `components/pathItems` item its `$ref` leads to
 * (OpenAPI 3.1) — in document order, through `resolvePathItemRef`, the
 * resolver a `webhooks` entry goes through too. A key starting with `x-` is
 * a specification extension of the Paths Object, not a path, and is
 * stepped over without a warning whatever its value, as
 * `collectWebhookEntries` steps over one under `webhooks`. Resolved once,
 * before any
 * pass reads the map, so the model-name reservation
 * (`resolvePathModelBaseNames`), the API root (`documentApiRoot`) and the
 * operation loop all see the same items, and a referenced item's
 * operations, `parameters`, `servers`, `summary` and `description` are read
 * exactly as an inline item's (fields written beside the `$ref` are not, and
 * the resolver reports them). An entry the resolver rejects — not an
 * object, a non-string `$ref`, a ref outside `components/pathItems`, a
 * dangling ref, a cycle — is warned about once, naming the path, and left
 * out. Two paths that `$ref` one entry map to one object, read once per
 * path.
 */
function resolvePathItems(
  paths: Record<string, PathItem>,
  componentPathItems: Record<string, Record<string, unknown>> | undefined,
): Record<string, PathItem> {
  const resolved: Record<string, PathItem> = {};
  for (const [path, raw] of Object.entries(paths)) {
    // A specification extension of the Paths Object, never a path item:
    // stepped over whatever its value, before the resolver can warn about it.
    if (path.startsWith('x-')) continue;
    const pathItem = resolvePathItemRef(raw, componentPathItems, { kind: 'path', key: path });
    if (pathItem) resolved[path] = pathItem as PathItem;
  }
  return resolved;
}

export interface OperationExtractionResult {
  services: Service[];
  inlineModels: Model[];
  /**
   * Where the operations' inline models came from — one bundle per response
   * and per request body that produced any — so a merge pass can rename a
   * copy that must not share its name and repoint exactly that operation's
   * references. List-envelope companions are not bundled:
   * `resolveEnvelopeCompanionNames` settles their names once and for all.
   */
  inlineModelBundles: InlineModelBundle[];
}

/** A top-level `tags[]` entry as it appears in the OpenAPI document. */
export interface TagObject {
  name?: string;
  description?: string;
  externalDocs?: RawExternalDocs;
}

export function extractOperations(
  paths: Record<string, PathItem> | undefined,
  operationIdTransform?: (id: string) => string,
  componentSchemas?: Record<string, SchemaObject>,
  componentParameters?: Record<string, Record<string, unknown>>,
  componentRequestBodies?: Record<string, Record<string, unknown>>,
  componentModels?: Model[],
  documentTags?: TagObject[],
  componentExamples?: Record<string, Record<string, unknown>>,
  componentHeaders?: Record<string, Record<string, unknown>>,
  componentResponses?: Record<string, Record<string, unknown>>,
  componentFieldModels?: Model[],
  documentServers?: ServerEntry[],
  openapiVersion?: string,
  operationHints?: Record<string, OperationHint>,
  /** The component enums, whose names no deferred or item model may take (see `reserveEnumNames`). */
  componentEnums?: readonly Enum[],
  componentPathItems?: Record<string, Record<string, unknown>>,
): OperationExtractionResult {
  if (!paths) return { services: [], inlineModels: [], inlineModelBundles: [] };

  // Every pass below reads the resolved map: each entry as itself, or as the
  // `components/pathItems` item its `$ref` leads to, with an entry that
  // resolves to nothing left out after one warning (see resolvePathItems).
  const resolvedPaths = resolvePathItems(paths, componentPathItems);

  // OAS 3.0 ignores properties beside a `$ref`; 3.1 lets a sibling
  // `description` override the referenced response's. Unknown is read as 3.1.
  const refSiblingDescriptions = openapiVersion?.startsWith('3.0') ? 'ignore' : 'override';

  // Operations without an operationId name their inline models from the
  // path, and two distinct paths — or a path and an operationId, component
  // schema or component response — can produce the same name, so the prefix
  // for every such operation is decided up front (see resolvePathModelBaseNames).
  // The model name each component response's inline body takes, decided once
  // for every operation that returns it (see resolveComponentResponseModelNames).
  const componentResponseNaming = resolveComponentResponseModelNames(
    componentResponses,
    [...(componentModels ?? []), ...(componentFieldModels ?? [])],
    componentSchemas,
  );
  const componentResponseModelNames = new Map(
    [...componentResponseNaming].map(([componentName, naming]) => [componentName, naming.name]),
  );
  const pathModelBaseNames = resolvePathModelBaseNames(
    resolvedPaths,
    componentModels,
    componentRequestBodies,
    componentResponseNaming,
  );
  // An API root the untagged paths sit under (`/api`, `/v1`) tells the
  // services apart no better than nothing, so untagged operations skip it
  // when their service and fallback name are taken from the path (see
  // documentApiRoot). Tagged operations are named exactly as before.
  const apiRoot = documentApiRoot(resolvedPaths);

  const serviceMap = new Map<string, Operation[]>();
  const inlineModels: Model[] = [];
  const inlineModelBundles: InlineModelBundle[] = [];
  const envelopeCompanions: EnvelopeCompanion[] = [];
  /** The PascalCase operation name each companion was lifted under, to qualify it should a merge pass rename it. */
  const companionQualifiers = new Map<EnvelopeCompanion, string>();
  // Service name each tagged operation was grouped under, keyed by operation
  // identity. The path-prefix split below moves operations between services,
  // so this is how a split-off service is traced back to the tag it came from.
  const tagServiceByOperation = new Map<Operation, string>();
  // Operations named from the method and path rather than an operationId.
  // Only these may be renamed when names collide within a service (see
  // disambiguateOperationNames); a name taken from an operationId is kept as is.
  const pathNamed = new Set<Operation>();
  // Header, secondary-body, fallback-body, error-body and parameter schemas
  // are typed only after this loop, once every primary model is known
  // (`resolveDeferredInlineTypes`): their names must not collide with a
  // differently shaped component, request body or primary response of any
  // operation, or the later merge would overwrite the first. The registry
  // records which operation minted each model, and which operation's own
  // reference carries each enum name (`qualifierOf`), so a clash within one
  // operation can be told from one across two.
  const deferred: DeferredInlineType[] = [];
  const qualifierOf = new Map<Operation, string>();
  // The spec-wide registry of model shapes (`InlineModelRegistry`), seeded
  // with every name decided before the operations — the component models
  // and enums, the components' field models (a nested object, a map's
  // values; not among `componentModels`, see parseSpec) and the enums their
  // fields mint — and filled as the operations are read: each operation's
  // models once it is built, its array items as they are typed
  // (`typeInlineItems` settles them against it), the envelope companions
  // once named, and every enum the operations mint. The deferred schemas are
  // named against all of it last.
  const registry: ModelShapeRegistry = new Map();
  const registeredModels = [...(componentModels ?? []), ...(componentFieldModels ?? [])];
  // Each seeded with the model itself: a declared model shares its name with
  // every shape it admits (`ownerShares`), an operation's with an identical
  // one only.
  for (const model of registeredModels) {
    if (!registry.has(model.name)) registry.set(model.name, { fingerprint: modelFingerprint(model), model });
  }
  // Every enum name decided so far, held as names no model may take
  // (`reserveEnumNames`): the component enums', and every enum the component
  // models and the components' field models reference (an inline enum's
  // `EnumRef`, named before the enum collector may rename it; a `$ref` to a
  // component enum names one already held). None is an operation's. The
  // operations' own join once they are read, below.
  const enumRefsOf = (model: Model): string[] => collectModelTypeRefs(model).flatMap(collectEnumRefs);
  reserveEnumNames(registry, [...(componentEnums ?? []).map((e) => e.name), ...registeredModels.flatMap(enumRefsOf)]);

  for (const [path, pathItem] of Object.entries(resolvedPaths)) {
    // Everything read at path-item level — `parameters`, `servers`, and the
    // `summary`/`description` an operation falls back to — comes from this one
    // object: the entry itself, or the `components/pathItems` item its `$ref`
    // leads to, resolved by `resolvePathItems` above (issue #300).
    const pathLevelParams = pathItem.parameters ?? [];
    // Read once per Path Item so a problem in its `servers` is reported once,
    // not once per operation. The operations that inherit it share the array,
    // the way `responseHeaders` shares its list with `successResponses`.
    const pathLevelServers = extractServerList(pathItem.servers, `path item ${path}`);

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      // The first usable tag — `Operation.tags[0]`, read by the same helper —
      // so the service and the list the IR carries never disagree, and an
      // entry that is not a string (`42`) never reaches PascalCasing.
      const tag = extractTags(op.tags)?.[0];
      const apiRootLength = tag ? 0 : apiRootLengthOf(path, apiRoot);
      const serviceName = inferServiceName(path, tag, apiRootLength);
      const pathModelBaseName = pathModelBaseNames.get(`${method} ${path}`) ?? derivePathModelBaseName(path, method);
      const servers = operationServers(
        extractServerList(op.servers, `operation ${operationLabel(op, path, method)}`),
        pathLevelServers,
        documentServers,
      );

      const {
        operation,
        inlineModels: opModels,
        inlineModelBundles: opBundles,
        envelopeCompanions: opCompanions,
        operationQualifier,
      } = buildOperation(
        method,
        path,
        op,
        pathLevelParams,
        pathItem,
        pathModelBaseName,
        operationIdTransform,
        serviceName,
        componentSchemas,
        componentParameters,
        componentRequestBodies,
        componentExamples,
        componentHeaders,
        componentResponses,
        deferred,
        apiRootLength,
        servers,
        refSiblingDescriptions,
        componentResponseModelNames,
        // Same "METHOD /path" key the operation resolver uses for the rest of the hint.
        operationHints?.[`${method.toUpperCase()} ${path}`]?.pagination,
        componentModels,
        registry,
      );
      inlineModels.push(...opModels);
      // The operation's models join the registry under its qualifier, so a
      // later operation's items and every deferred schema step around them;
      // its settled item models are already there (`typeInlineItems`).
      registerInlineModels(registry, opModels, operationQualifier);
      qualifierOf.set(operation, operationQualifier);
      inlineModelBundles.push(...opBundles);
      if (opCompanions) {
        envelopeCompanions.push(...opCompanions);
        for (const companion of opCompanions) companionQualifiers.set(companion, toPascalCase(operation.name));
      }
      // Same truthiness check as inferServiceName: for a tagged operation the
      // service name *is* the normalized tag, so it doubles as the lookup key.
      if (tag) tagServiceByOperation.set(operation, serviceName);
      if (!op.operationId) pathNamed.add(operation);
      const ops = serviceMap.get(serviceName) ?? [];
      ops.push(operation);
      serviceMap.set(serviceName, ops);
    }
  }

  // Companion models of list envelopes are named once every list operation is
  // known, so copies of one envelope shape can share a model. They take their
  // final names before any deferred schema is named, so a fallback variant
  // titled `ListMetadata` steps around the companion a primary response's
  // `list_metadata` becomes, instead of the later merge keeping whichever has
  // more fields under one name.
  const companionFolds = new Map<EnvelopeCompanion, EnvelopeCompanion>();
  const companionModels = resolveEnvelopeCompanionNames(envelopeCompanions, componentModels, companionFolds);
  inlineModels.push(...companionModels);
  // Each companion that kept its models is a site of its own, owning its
  // envelope field and the envelope field of every operation whose copy
  // folded onto it, so a merge pass that must rename one of its models (a
  // deprecated companion named like a live component field's model, say)
  // repoints every operation sharing it and nothing else.
  inlineModelBundles.push(
    ...companionBundles(envelopeCompanions, companionModels, companionFolds, companionQualifiers),
  );

  // Headers, secondary bodies, fallback bodies, error bodies and parameters
  // are named last, in document order, against every name in the registry —
  // the component models and enums, the components' field models, every
  // request body, primary response, item and companion model — and against
  // every enum name decided so far: the component enums, and every enum
  // those models' fields or the operations' references — a parameter in any
  // location, a body, a response of any kind, a response header, the
  // pagination item type and envelope fields (`collectOperationTypeRefs`) —
  // carry (an inline enum's `EnumRef`, named before the enum collector may
  // rename it). An enum one of an operation's own references carries is
  // registered as that operation's, so a deferred model of the operation
  // that derives the name is qualified by location, as one that clashes
  // with the operation's models is; a model's field enums are its
  // operation's, a companion's no one's. So none of them takes a name one
  // of those owns, whichever comes first in the document, and no model is
  // ever named like an enum.
  registerInlineModels(registry, companionModels);
  for (const model of inlineModels) reserveEnumNames(registry, enumRefsOf(model), registry.get(model.name)?.operation);
  for (const [op, qualifier] of qualifierOf) {
    reserveEnumNames(registry, collectOperationTypeRefs(op).flatMap(collectEnumRefs), qualifier);
  }
  const deferredTypes = resolveDeferredInlineTypes(deferred, registry);
  inlineModels.push(...deferredTypes.models);
  // Each deferred schema is a site of its own (the references it wrote, the
  // models it minted), and a reference it wrote by sharing another site's
  // model — the registry matched the shape of a primary body's model or a
  // companion's — joins that site's roots, so a merge pass that renames the
  // model (a deprecated copy named like a live one) repoints the `default`
  // response or header that shares it along with the site's own references.
  inlineModelBundles.push(...deferredTypes.bundles);
  attachSharedDeferredRefs(
    deferredTypes.bundles,
    inlineModelBundles,
    new Set(registeredModels.map((model) => model.name)),
  );

  // The API root each operation's path sits under, for every step below: none
  // for a tagged operation, whose service is its tag.
  const rootLengthOf = (op: Operation) => (tagServiceByOperation.has(op) ? 0 : apiRootLengthOf(op.path, apiRoot));

  // Split a tagged service whose tag groups operations from several first
  // path segments — `/organizations` and `/organization_domains` both tagged
  // `organizations` — into one service per segment. Decided over the tagged
  // operations alone, so an untagged operation the service picked up by path
  // never moves its tagged siblings (see splitTaggedServices).
  splitTaggedServices(serviceMap, tagServiceByOperation);

  // Disambiguate operation names within each service.
  // Multiple operations can get the same name (e.g., several "list" endpoints
  // in UserManagement for users, invitations, auth factors, etc.).
  for (const [serviceName, operations] of serviceMap) {
    disambiguateOperationNames(operations, pathNamed, serviceName, rootLengthOf);
  }

  const declaredTags = indexDocumentTags(documentTags);
  const services: Service[] = Array.from(serviceMap.entries()).map(([name, operations]) => {
    const { description, externalDocs } = resolveServiceDocs(name, operations, tagServiceByOperation, declaredTags);
    // Omit each key entirely when no tag gives it so the IR shape is
    // unchanged for documents without tag descriptions or links.
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      ...(externalDocs !== undefined ? { externalDocs } : {}),
      operations,
    };
  });

  return { services, inlineModels, inlineModelBundles };
}

/**
 * What a document tag contributes to the service it names. Both keys are
 * absent when the tag declares neither, so a declared-but-undocumented tag is
 * an empty record — still an entry in the index, which is what marks its
 * service as one that must not borrow another tag's wording.
 */
interface TagDocs {
  description?: string;
  externalDocs?: ExternalDocs;
}

/**
 * `base` with each doc field it lacks filled in from `extra`; a field `base`
 * already has is kept. The one rule for combining tag docs — among duplicate
 * tags in the index and among the tags a split-off service inherits from —
 * so `description` and `externalDocs` cannot resolve by different rules.
 */
function fillMissingTagDocs(base: TagDocs, extra: TagDocs): TagDocs {
  return { ...extra, ...base };
}

/**
 * Index the document's top-level `tags[]` by the service name each tag
 * produces, so a tag spelled `user_management`, `User Management`, or
 * `user-management` all map to the `UserManagement` service. Every named tag
 * is indexed — with its description when it declares a non-blank one, with
 * its `externalDocs` when it declares a usable one, and as an empty record
 * otherwise — because a declared-but-undocumented tag still marks its service
 * as one that must not borrow another tag's wording. When several tags
 * normalize to the same service name, each field is taken from the first of
 * them that gives it, so adding a link to one spelling never changes which
 * description the service shows.
 *
 * `parseSpec` ignored `tags` entirely before descriptions were read, so a
 * document with a malformed value — `tags` written as an object, a `null`
 * entry, a numeric `name` — used to parse and must keep parsing. Anything
 * that cannot be matched is skipped rather than thrown on, and a malformed
 * `externalDocs` is dropped the same way (see `readExternalDocs`).
 */
function indexDocumentTags(documentTags: unknown): Map<string, TagDocs> {
  const index = new Map<string, TagDocs>();
  if (!Array.isArray(documentTags)) return index;
  for (const tag of documentTags as unknown[]) {
    if (typeof tag !== 'object' || tag === null) continue;
    const { name, description, externalDocs } = tag as TagObject;
    if (typeof name !== 'string' || name === '') continue;
    const serviceName = toPascalCase(name);
    const described = typeof description === 'string' && description.trim() !== '';
    const docs: TagDocs = { ...(described ? { description } : {}), ...externalDocsEntry(externalDocs) };
    index.set(serviceName, fillMissingTagDocs(index.get(serviceName) ?? {}, docs));
  }
  return index;
}

/**
 * Pick a service's docs — its `description` and `externalDocs` — from the
 * document's tags. Both fields go through this one path so they cannot
 * resolve to different tags by different rules.
 *
 * A service whose own name is a declared tag is documented by that tag alone:
 * its description and link when it has them, nothing otherwise. Another tag's
 * wording is never borrowed for it — operations tagged `api_keys` that the
 * path-prefix split merges into `UserManagement` must not label that service
 * "API keys".
 *
 * A service whose own name is not declared is one the split carved out of a
 * tag (e.g. `OrganizationDomains` from operations tagged `organizations`); it
 * inherits each field on its own from the first tag its operations carry that
 * gives it: the description of the first described tag, the link of the first
 * linked one, which need not be the same tag. Path-named services whose
 * operations have no tag carry nothing and stay undocumented.
 */
function resolveServiceDocs(
  serviceName: string,
  operations: Operation[],
  tagServiceByOperation: Map<Operation, string>,
  declaredTags: Map<string, TagDocs>,
): TagDocs {
  const declared = declaredTags.get(serviceName);
  if (declared !== undefined) return declared;
  let docs: TagDocs = {};
  for (const op of operations) {
    const tagService = tagServiceByOperation.get(op);
    if (tagService === undefined) continue;
    const inherited = declaredTags.get(tagService);
    if (inherited !== undefined) docs = fillMissingTagDocs(docs, inherited);
  }
  return docs;
}

/**
 * Words that mark where an API is mounted rather than naming a resource.
 * Deliberately tiny: `mountRules` regroup whatever this does not cover.
 */
const API_MARKER_SEGMENTS: ReadonlySet<string> = new Set(['api', 'rest']);

/**
 * Whether a path segment marks the API root rather than naming a resource:
 * one of API_MARKER_SEGMENTS in any case, or a version such as `v1`,
 * `v2beta`, `1.0` or `2010-04-01`.
 */
function isApiMarkerSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return API_MARKER_SEGMENTS.has(lower) || /^v\d/.test(lower) || /^\d+([.-]\d+)*$/.test(lower);
}

/** Leading literal segments of a path through its last API marker; `0` without one. */
function pathRootLength(segments: readonly string[]): number {
  let length = 0;
  for (let i = 0; i < segments.length && !segments[i].startsWith('{'); i++) {
    if (isApiMarkerSegment(segments[i])) length = i + 1;
  }
  return length;
}

/**
 * The API root the document's untagged operations sit under, as path
 * segments: `['api', 'v1']` for a document whose untagged paths all start
 * with `/api/v1/`, `[]` when there is none. Untagged operations skip it when
 * their service and fallback name are taken from the path.
 *
 * Each untagged operation's path contributes its own root — its leading
 * literal segments through the last API marker (see isApiMarkerSegment), so
 * `/api/v1/notes` contributes `api/v1`, `/wiki/rest/api/content` contributes
 * `wiki/rest/api`, `/api/user_management/users` contributes `api` alone and
 * `/api/{tenant}/notes` contributes `api`, a parameter ending the run. The
 * document root is the longest marker-terminated prefix shared, compared
 * verbatim, by every contribution that no other contribution extends:
 * `/api/v1/…` beside `/api/v2/…` gives `api`, and `/v1/…` beside `/v2/…`
 * gives nothing, so the two versions stay apart instead of merging into one
 * service per resource. A contribution that is a prefix of another —
 * `/api/openapi.json` or `/api/admin/users` beside `/api/v1/notes` — does not
 * shorten the root to `api` for every path: it skips only its own `api`
 * (see apiRootLengthOf), and `/api/v1/notes` stays `Notes` rather than
 * landing in `V1`. Only a second version disagrees with the first, and that
 * alone is what needs the shorter root.
 *
 * A path with no marker at all (`/health`, `/openapi.json`) contributes
 * nothing: it sits outside any root and keeps its own first segment, and it
 * does not switch the root off for the rest of the document (see
 * apiRootLengthOf). A shared prefix without a marker is therefore kept whole
 * — `/user_management/users` and `/user_management/invitations` stay one
 * `UserManagement` service — because a module prefix every path shares is
 * the service, not noise, and nothing but the word tells it from `/api`.
 * Tagged operations never take part, since only path-named services use the
 * root; nor do path items that declare no operation.
 */
function documentApiRoot(paths: Record<string, PathItem>): string[] {
  const contributions: string[][] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    // Same read as the service naming above: a first usable tag names the service.
    const hasUntaggedOperation = HTTP_METHODS.some((method) => {
      const op = pathItem[method];
      return Boolean(op) && extractTags(op?.tags) === undefined;
    });
    if (!hasUntaggedOperation) continue;
    const segments = pathSegments(path);
    const own = segments.slice(0, pathRootLength(segments));
    if (own.length > 0) contributions.push(own);
  }
  // Every strict prefix of a contribution, so a contribution another one
  // extends can be left out. Segments never contain `/`, so the join is exact.
  const extended = new Set<string>();
  for (const own of contributions) {
    for (let length = 1; length < own.length; length++) extended.add(own.slice(0, length).join('/'));
  }
  let root: string[] | undefined;
  for (const own of contributions) {
    if (extended.has(own.join('/'))) continue;
    if (root === undefined) {
      root = own;
      continue;
    }
    root = root.slice(0, sharedPrefixLength(root, own));
  }
  if (root === undefined) return [];
  return root.slice(0, pathRootLength(root));
}

/** How many leading segments two paths share, compared verbatim. */
function sharedPrefixLength(a: readonly string[], b: readonly string[]): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared;
}

/**
 * How many leading segments of a path are the document's API root: as much
 * of the path's own root (pathRootLength) as the document root shares,
 * compared verbatim. For a path that starts with the whole root that is the
 * root's length; for one that stops short of it — `/api/openapi.json` under a
 * root of `api/v1` — it is the path's own `api`, skipped for that path alone;
 * and `0` for a path outside the root, which is named as if the document had
 * none. The two roots are prefixes of one contribution whenever the path is
 * untagged, so what they share always ends on a marker.
 */
function apiRootLengthOf(path: string, apiRoot: readonly string[]): number {
  const segments = pathSegments(path);
  return sharedPrefixLength(apiRoot, segments.slice(0, pathRootLength(segments)));
}

/**
 * Index of the segment a path-named service takes its name from, among the
 * segments readPath reads. Under an API root it is the first literal segment
 * after the root, so `/v1/notes` and `/v1/{teamId}/notes` both name `Notes`;
 * when nothing literal follows the root, the first segment, so `/api` and
 * `/api/{id}` name `Api` as they always did rather than `Default`. The
 * fallback operation name skips the same segment (see inferResourceFromPath),
 * so it is never echoed as `Api.getApi`.
 *
 * The verb of a custom method is not a resource and never names a service:
 * `/v1/{name}:cancel` stays in `V1` beside `/v1/{name}`, and `/api/v1:reset`
 * lands in `Api`, where the slash-written `/v1/{name}/cancel` names
 * `Cancel`. The resource it is written on is still found first when there is
 * one, so `/v1/pets:batchGet` names `Pets` like `/v1/pets`.
 *
 * Without a root (`apiRootLength` of 0: a root-less document, a path outside
 * the root, or a tagged operation) it is always the first segment, parameter
 * or not, so every such operation is named exactly as before this rule
 * existed: an untagged `/{tenant}/users` stays `Default.listUsers`.
 */
function serviceSegmentIndex(path: string, apiRootLength: number): number {
  if (apiRootLength === 0) return 0;
  const index = readPath(path).findIndex(
    (segment, i) => i >= apiRootLength && !segment.text.startsWith('{') && !segment.customMethod,
  );
  return index === -1 ? 0 : index;
}

/**
 * The service an operation belongs to: its first tag, else a path segment.
 *
 * The path fallback takes the first literal segment after the API root the
 * document sits under (`apiRootLength`, see documentApiRoot): `/widgets/{id}/sub`
 * is `Widgets`, and so are `/api/widgets` and `/api/{tenant}/widgets` when the
 * root is `/api`, instead of the whole API collapsing into one `Api` service.
 * When nothing literal follows the root — the path is the root itself, or
 * only parameters come next — the first segment names the service as it
 * always did, so `/api` and `/api/{id}` land in `Api` rather than in `Default`.
 * The verb of a custom method is read past (see serviceSegmentIndex), so
 * `/v1/{name}:cancel` lands in `V1` as well.
 */
function inferServiceName(path: string, tag: string | undefined, apiRootLength: number): string {
  // Prefer OpenAPI tag when available — tags represent the logical grouping
  // (e.g., "multi-factor-auth" for /auth/factors/* endpoints).
  if (tag) {
    return toPascalCase(tag);
  }
  const first = pathSegments(path)[serviceSegmentIndex(path, apiRootLength)] ?? 'Default';
  // Skip path params
  if (first.startsWith('{')) return 'Default';
  return toPascalCase(first);
}

/**
 * The service a tagged operation is split off to, named from its first path
 * segment: `/organization_domains/{id}` → `OrganizationDomains`. A path whose
 * first segment is a parameter, or that has no segment at all (`/`), has
 * nothing to be split on and names the service it is already in, so
 * `/{tenant}/notes` beside `/notes` under one tag stays put.
 */
function splitSegmentService(op: Operation, serviceName: string): string {
  const first = pathSegments(op.path)[0];
  return first === undefined || first.startsWith('{') ? serviceName : toPascalCase(first);
}

/**
 * The service an operation lands in once the service it was grouped under
 * (`serviceName`: its tag, else the segment its path named) is known in full.
 *
 * A tagged operation moves to the service its own first segment names (see
 * splitSegmentService) only when the operations carrying its tag sit under
 * more than one first segment — `segmentServices`, the first-segment services
 * of that service's tagged operations alone. A tag whose operations all share
 * one first segment keeps them together even when that segment is not the
 * tag: `/api/v1/notes` tagged `notes` stays in `Notes`, not `Api`.
 *
 * An untagged operation keeps the service its path named: the segment it
 * would be split on is the one it was named from, so it can neither cause
 * nor prevent a split, nor be moved by one.
 */
function resolveServiceName(
  op: Operation,
  serviceName: string,
  tagged: boolean,
  segmentServices: ReadonlySet<string>,
): string {
  if (!tagged || segmentServices.size <= 1) return serviceName;
  return splitSegmentService(op, serviceName);
}

/**
 * Split each service whose tag groups operations from several first path
 * segments into one service per segment: `/organizations` and
 * `/organization_domains` both tagged `organizations` become `Organizations`
 * and `OrganizationDomains`. A part named like a service that already exists
 * — another tag's, or one named from a path — joins it.
 *
 * Every operation's destination is decided by resolveServiceName from the
 * grouping as it stands before any service is split, over each service's
 * tagged operations alone. So an untagged operation a tagged service picked
 * up by path — `/api/v1/notes/{noteId}/export` beside `/api/v1/notes` tagged
 * `notes` — does not add a second segment to the tag's set and move the
 * tagged operations into `Api` (issue #287), and operations a split moves
 * into another tag's service do not add a segment to that tag's set either,
 * whichever service the document lists first.
 *
 * Mutates `serviceMap`: a split service is removed and each of its parts is
 * appended under its own name, or merged into the existing service of that
 * name, in the order the parts first appear.
 */
function splitTaggedServices(
  serviceMap: Map<string, Operation[]>,
  tagServiceByOperation: ReadonlyMap<Operation, string>,
): void {
  const plan = new Map<string, ServiceSplit>();
  for (const [serviceName, operations] of serviceMap) {
    const segmentServices = new Set<string>();
    for (const op of operations) {
      if (tagServiceByOperation.has(op)) segmentServices.add(splitSegmentService(op, serviceName));
    }
    const parts = new Map<string, Operation[]>();
    for (const op of operations) {
      const name = resolveServiceName(op, serviceName, tagServiceByOperation.has(op), segmentServices);
      const part = parts.get(name) ?? [];
      part.push(op);
      parts.set(name, part);
    }
    plan.set(serviceName, { operations, own: operations.length, parts });
  }
  for (const [serviceName, { operations, own, parts }] of plan) {
    if (parts.size <= 1) continue;
    // Parts of services split before this one that joined it were appended to
    // its array after the plan was read. They resolved to this service's name,
    // so they stay in the part that keeps it instead of going with the array.
    const joined = operations.slice(own);
    if (joined.length > 0) parts.set(serviceName, [...(parts.get(serviceName) ?? []), ...joined]);
    serviceMap.delete(serviceName);
    for (const [name, ops] of parts) {
      const existing = serviceMap.get(name) ?? [];
      existing.push(...ops);
      serviceMap.set(name, existing);
    }
  }
}

/** One service's split, planned from the grouping before any service is split (see splitTaggedServices). */
interface ServiceSplit {
  /** The service's operations: the array `serviceMap` holds, which parts of services split earlier may join. */
  operations: Operation[];
  /** How many of `operations` the plan was read from; any beyond them joined since. */
  own: number;
  /** The service each operation moves to, with its operations in document order; one entry when nothing moves. */
  parts: Map<string, Operation[]>;
}

/**
 * Strip overload indices (e.g. NestJS emits `Foo_bar[0]` when a controller
 * method handles multiple routes) from an operationId so derived names never
 * leak the bracketed digit. Without this, `authenticate[0]` would surface as
 * `authenticate0` in method names and `Authenticate0Request` in body model
 * names. Brackets at the end (or with trailing whitespace) are common in
 * NestJS-style backends; this regex is intentionally narrow to avoid eating
 * legitimate digits like `oauth2`.
 */
function normalizeOperationIdForNaming(operationId: string): string {
  return operationId.replace(/\[\d+\]\s*$/, '');
}

/**
 * The inline request body, response or error body model name of an operation
 * that has an `operationId`. The single source of that name: extractRequestBody,
 * deriveResponseName, deriveFallbackResponseName and deriveErrorModelName use
 * it to name, resolvePathModelBaseNames to reserve.
 */
function operationIdModelName(operationId: string, suffix: string): string {
  return cleanSchemaName(toPascalCase(normalizeOperationIdForNaming(operationId)) + suffix);
}

/**
 * The stem every model derived from an `operationId` starts with: its
 * `Request`, `Response` and `Error<code>` models, a list's `Item`, nested
 * inline models under those (`…ResponseOwner`) and envelope companions
 * (`…ListMetadata`). Every step of cleanSchemaName is a global replace or acts
 * on the leading word, so this is a true prefix of each of those names. Used
 * to reserve them all.
 */
export function operationIdModelBase(operationId: string): string {
  return cleanSchemaName(toPascalCase(normalizeOperationIdForNaming(operationId)));
}

function inferOperationName(
  method: HttpMethod,
  path: string,
  operationId?: string,
  operationIdTransform?: (id: string) => string,
  apiRootLength = 0,
): string {
  if (operationId) {
    const normalized = normalizeOperationIdForNaming(operationId);
    if (operationIdTransform) {
      return operationIdTransform(normalized);
    }
    return toCamelCase(normalized);
  }

  // Fallback when no operationId is available — use method + path to build
  // a descriptive name like "listUsers", "getOrganization", "deleteAuthFactor",
  // "getPetStatus" for a singleton of one item, or "adoptPet" for an action.
  return fallbackOperationName(method, path, apiRootLength);
}

/**
 * The name of an operation without an `operationId`, built from its method
 * and path. Three shapes, tried in this order:
 *
 *   - an action (inferAction): the action segment is the verb phrase and
 *     its resource follows — `POST /store/pets/{id}/adopt` is `adoptPet`,
 *     `DELETE /store/pets/bulk-delete` is `bulkDeletePets`, and
 *     `DELETE /pets/bulk-delete` in `Pets` is the bare `bulkDelete`;
 *   - a singleton of one item (inferSingleton): the method's item verb
 *     (inferVerb), the singular parent and the segment —
 *     `GET /store/pets/{id}/status` is `getPetStatus`;
 *   - otherwise the CRUD verb (inferVerb) plus the resource noun
 *     (inferResourceFromPath), singular for an item operation —
 *     `GET /store/pets/{id}` is `getPet` — or the verb alone when the path
 *     names no resource past the service segment: `GET /pets/{id}` in `Pets`
 *     is `get`.
 *
 * The parts of an action or singleton name are joined by appendQualifier,
 * so a word is never repeated across a join:
 * `GET /companies/verification/{id}/verification-status` is
 * `getVerificationStatus`.
 *
 * `actions` false skips the first shape, for an operation that gave an
 * action name up to another method on its path (demoteSamePathNames):
 * `POST /pets/bulk-delete` is then `createBulkDelete`.
 */
function fallbackOperationName(method: HttpMethod, path: string, apiRootLength: number, actions = true): string {
  const action = actions ? inferAction(method, path, apiRootLength) : null;
  if (action) return appendQualifier(toCamelCase(action.verb), action.resource);
  const singleton = inferSingleton(path, apiRootLength);
  if (singleton) {
    return appendQualifier(appendQualifier(inferVerb(method, path), singleton.parent), singleton.resource);
  }
  const verb = inferVerb(method, path);
  const resource = inferResourceFromPath(path, apiRootLength);
  return resource ? toCamelCase(`${verb}_${resource}`) : verb;
}

/**
 * The name fallbackOperationName gave an item operation before its resource
 * was singularised: the resource as the path spells it, `getPets` for
 * `GET /store/pets/{id}`. `null` for an action (inferAction) and for a
 * singleton (inferSingleton), whose names are not built from a singularised
 * resource, and for an operation whose resource is not singularised — a
 * collection, a path with no resource, a segment that does not look plural —
 * so a non-null result always differs from the singular name.
 * disambiguateOperationNames falls back to it before a numeric suffix when
 * the singular name is an operationId's, or another path-named operation's
 * whose path differs only by that plural. `actions` is fallbackOperationName's.
 */
function pluralFallbackName(method: HttpMethod, path: string, apiRootLength: number, actions = true): string | null {
  if ((actions && inferAction(method, path, apiRootLength)) || inferSingleton(path, apiRootLength)) return null;
  const resource = inferResourceFromPath(path, apiRootLength, false);
  if (resource === null || resource === inferResourceFromPath(path, apiRootLength)) return null;
  return toCamelCase(`${inferVerb(method, path)}_${resource}`);
}

/**
 * The CRUD verb each HTTP method takes on one item and on a collection. Only
 * GET's differ: `get` for one item, `list` for a collection.
 */
const METHOD_VERBS: Record<HttpMethod, { readonly item: string; readonly collection: string }> = {
  get: { item: 'get', collection: 'list' },
  post: { item: 'create', collection: 'create' },
  put: { item: 'update', collection: 'update' },
  patch: { item: 'update', collection: 'update' },
  delete: { item: 'delete', collection: 'delete' },
  head: { item: 'check', collection: 'check' },
  options: { item: 'options', collection: 'options' },
  trace: { item: 'trace', collection: 'trace' },
};

/**
 * The verbs a POST on a literal with no parameter before it is read as an
 * action phrase by, when one of them is the segment's last word
 * (inferAction): the CRUD verbs of METHOD_VERBS. `options` and `trace` are
 * left out, since `/settings/display-options` names a collection.
 */
const CRUD_VERBS: ReadonlySet<string> = new Set(['get', 'list', 'create', 'update', 'delete', 'check']);

/**
 * The verbs that count as a method's own only as the first word of a segment
 * (segmentCarriesVerb): `list-all` and `check-health` do something, while as
 * a later word `list` and `check` name a thing — `wish-list`, `allow-list`,
 * `health-check`. Every other verb counts in any position: `bulk-delete`,
 * `batch-get`, `force-update`, `auto-create`.
 */
const LEADING_ONLY_VERBS: ReadonlySet<string> = new Set(['list', 'check']);

/**
 * Infer the CRUD verb from the HTTP method and the path shape (METHOD_VERBS):
 * the item verb when the path addresses one item — it ends in a path
 * parameter, or in a singleton of the item before it (isSingletonSegment) —
 * and the collection verb otherwise. `GET /pets/{id}` and
 * `GET /pets/{id}/status` are `get`; `GET /pets` and `GET /pets/{id}/photos`
 * are `list`. Not consulted for an action (inferAction), whose verb is the
 * action segment itself.
 */
function inferVerb(method: HttpMethod, path: string): string {
  const segments = pathSegments(path);
  const last = segments[segments.length - 1];
  const item = last !== undefined && (last.startsWith('{') || isSingletonSegment(segments));
  return item ? METHOD_VERBS[method].item : METHOD_VERBS[method].collection;
}

/** The verbs inferVerb can give a method: `get` and `list` for GET, one verb for every other. */
function methodVerbs(method: HttpMethod): string[] {
  const verbs = METHOD_VERBS[method];
  return verbs.item === verbs.collection ? [verbs.item] : [verbs.item, verbs.collection];
}

/**
 * Whether the last segment of a path is a literal whose words include one of
 * the method's own verbs (methodVerbs): `bulk-delete` for a DELETE, `list-all`
 * and `batch-get` for a GET, `update-password` for a PUT or PATCH, and not
 * `bulk-delete` for a POST. `list` and `check` count only as the first word
 * (LEADING_ONLY_VERBS), so `wish-list`, `allow-list` and `health-check` carry
 * no verb. Such a segment is the action for that method (inferAction) and
 * keeps the action name when another method on the path would take it too
 * (demoteSamePathNames).
 */
function segmentCarriesVerb(method: HttpMethod, path: string): boolean {
  const segments = pathSegments(path);
  const last = segments[segments.length - 1];
  if (last === undefined || last.startsWith('{')) return false;
  const words = splitWords(last).map((w) => w.toLowerCase());
  return methodVerbs(method).some((verb) => (LEADING_ONLY_VERBS.has(verb) ? words[0] === verb : words.includes(verb)));
}

/** Whether a path segment looks plural: singularizePathSegment would change it. */
function looksPlural(segment: string): boolean {
  return singularizePathSegment(segment) !== segment;
}

/**
 * Whether the last segment is a singleton of the item before it: a literal
 * that follows a path parameter and does not look plural (looksPlural), so it
 * names one thing about that item — `status` in `/pets/{id}/status`, `avatar`
 * in `/users/{id}/avatar` — rather than a nested collection of it
 * (`/pets/{id}/photos`, `/orgs/{id}/api_keys`).
 */
function isSingletonSegment(segments: readonly string[]): boolean {
  if (segments.length < 2) return false;
  const last = segments[segments.length - 1];
  return !last.startsWith('{') && segments[segments.length - 2].startsWith('{') && !looksPlural(last);
}

/**
 * The noun a literal path segment contributes to an operation name. A
 * segment a path parameter follows addresses one item of its collection, so
 * it is singular (`singularizePathSegment`): `pets` in `/store/pets/{id}` is
 * `pet`. Any other segment is kept as the path spells it: `pets` in
 * `/store/pets`, `legacy` in `/users/{id}/legacy/factors`. The one rule for
 * the resource (inferResourceFromPath), the segments between the service and
 * the resource (inferDeeperContext) and the service noun a name restores
 * (inferServiceNoun), so `/store/cats/{id}/toys/{toyId}` and
 * `/api/notes/{noteId}` read `Cat` and `Note`, as `/store/pets/{id}` reads
 * `Pet`. The parent of an action or a singleton (inferItemParent) is singular
 * by that function's own rule, which does not look at the segment after it.
 */
function pathSegmentNoun(segments: readonly string[], index: number): string {
  const segment = segments[index];
  return segments[index + 1]?.startsWith('{') ? singularizePathSegment(segment) : segment;
}

/**
 * Extract a resource noun from the path for operation naming.
 * Uses the last non-param segment (the resource being operated on). An item
 * operation — the last literal segment is followed by a path parameter —
 * addresses one entity, so its noun is singularised (pathSegmentNoun).
 *
 * Examples:
 *   /accounts/users → "Users"
 *   /accounts/users/{id} → "User" (singular for item operations)
 *   /accounts/users/{id}/auth_factors → "AuthFactors"
 *   /accounts/users/{id}/auth_factors/{factor_id} → "AuthFactor"
 *   /organizations/{id}/api_keys → "ApiKeys"
 *   /auth/authorize → "Authorize" (action endpoint)
 *   /teams/{id}/teams → "Teams" (the teams under one team, in `Teams`)
 *   /teams → null (the segment the service was named from)
 *
 * `apiRootLength` is the document's API root the path sits under (see
 * documentApiRoot); the service segment is the first literal one after it.
 * `singularItem` false keeps an item's noun as the path spells it (`Users`
 * for `/accounts/users/{id}`), for pluralFallbackName.
 */
function inferResourceFromPath(path: string, apiRootLength = 0, singularItem = true): string | null {
  const segments = pathSegments(path);
  if (segments.length <= 1) return null;

  // Find the last meaningful (non-param) segment past the API root, so a
  // root word is never the resource: /api/v1/{id} is Api.delete, not deleteV1.
  let resourceIndex = -1;
  for (let i = segments.length - 1; i >= apiRootLength; i--) {
    if (!segments[i].startsWith('{')) {
      resourceIndex = i;
      break;
    }
  }

  if (resourceIndex < 0) return null;
  // Skip the segment the service was named from, compared by position — it
  // would be redundant: /api/notes is Notes.list, not Notes.listNotes. A
  // later segment that spells the same word names a resource of its own:
  // /teams/{id}/teams in Teams is listTeams, the teams under one team, and
  // never the bare `list` that reads as the service collection.
  if (resourceIndex === serviceSegmentIndex(path, apiRootLength)) return null;

  return toPascalCase(singularItem ? pathSegmentNoun(segments, resourceIndex) : segments[resourceIndex]);
}

/**
 * Index of the parent of a path's last segment, when that segment follows a
 * path parameter: the nearest literal before the parameter that is past the
 * document's API root (`apiRootLength`, see documentApiRoot) and is not an
 * API marker (isApiMarkerSegment) — the marker check also covers a tagged
 * operation, which has no root. `pets` in `/pets/{petId}/adopt` and in
 * `/owners/{o}/pets/{p}/vaccinate`; `-1` when no such literal exists, as in
 * `/api/v1/{companyId}/sendDocument` and `/{id}/adopt`. The parent is kept
 * even when it is the service segment: `/pets/{id}/archive` in `Pets` is
 * `archivePet` and `/pets/{id}/status` is `getPetStatus`, the names they
 * have under `/admin` in `Admin` too, so a name never depends on where the
 * service boundary falls.
 */
function itemParentIndex(segments: readonly string[], apiRootLength: number): number {
  for (let i = segments.length - 3; i >= apiRootLength; i--) {
    if (!segments[i].startsWith('{') && !isApiMarkerSegment(segments[i])) return i;
  }
  return -1;
}

/**
 * The parent of a path's last segment (itemParentIndex) as a noun, singular
 * since the parameter addresses one of it: `Pet` for `/pets/{petId}/adopt`.
 * `null` when there is none.
 */
function inferItemParent(segments: readonly string[], apiRootLength: number): string | null {
  const index = itemParentIndex(segments, apiRootLength);
  return index < 0 ? null : toPascalCase(singularizePathSegment(segments[index]));
}

/**
 * Recognise a singleton of one item (isSingletonSegment) and the two nouns
 * its name is built from: the singular parent (inferItemParent) and the
 * segment itself, `Pet` and `Status` for `/pets/{id}/status`, which
 * fallbackOperationName joins after the method's item verb: `getPetStatus`,
 * `updatePetStatus`, `deletePetStatus`, `checkPetStatus`, and
 * `createOrderStatus` for `POST /orders/{id}/status`. A POST on a singleton
 * that does not end in `s` is an action instead (inferAction), so
 * `/users/{id}/avatar` is `getUserAvatar` for a GET but `avatarUser` for a
 * POST; give the POST an `operationId`.
 */
function inferSingleton(path: string, apiRootLength = 0): { parent: string | null; resource: string } | null {
  const segments = pathSegments(path);
  if (!isSingletonSegment(segments)) return null;
  return {
    parent: inferItemParent(segments, apiRootLength),
    resource: toPascalCase(segments[segments.length - 1]),
  };
}

/**
 * Recognise an action: the last segment is a literal that names what the
 * operation does rather than a resource, so it is the whole verb phrase of
 * the name and the method's CRUD verb is left off. Three shapes:
 *
 *   - a POST on a literal that follows a path parameter and does not end in
 *     `s`: `/pets/{petId}/adopt`, `/owners/{o}/pets/{p}/vaccinate`. A literal
 *     ending in `s` after the parameter is a nested collection to create into
 *     (`/orgs/{id}/api_keys`) or a singleton of the item (`/orders/{id}/status`,
 *     see inferSingleton), and keeps `create`;
 *   - for any method, a literal that carries the method's own verb
 *     (segmentCarriesVerb), which the name would otherwise repeat:
 *     `bulk-delete` on a DELETE, `list-all` on a GET, `update-password` on a
 *     PUT after a parameter. A literal that carries another method's verb is
 *     not: after a parameter it is a singleton, `GET /users/{id}/last-update`
 *     is `getUserLastUpdate`, and before none it is a collection,
 *     `GET /pets/update` is `listUpdate` and `GET /pets/last-update` is
 *     `listLastUpdate`;
 *   - a POST on a literal with no parameter before it whose last word is any
 *     CRUD verb (CRUD_VERBS): `POST /pets/bulk-delete`, `POST /users/bulk-update`,
 *     `POST /v1/pets:batchGet`. Such a literal is otherwise read as a
 *     collection (`/pets/search` is `createSearch`), which would make it
 *     `createBulkDelete`. The last word only, so `/pets/delete-candidates`
 *     stays a collection, and a POST only, since a verb that is not the
 *     method's own is not what the method does.
 *
 * The verb is the segment itself. The resource is the singular parent
 * (inferItemParent) when the segment follows a parameter — `adopt` + `Pet` —
 * and otherwise the collection the segment sits under, as
 * inferResourceFromPath reads the path without the segment, so
 * `/pets/bulk-delete` in `Pets` is the bare `bulkDelete` and
 * `/store/pets/bulk-delete` is `bulkDeletePets`. The caller leaves the
 * resource off when the verb already ends with it (`restart-id-verification`
 * under `verification` is `restartIdVerification`, see appendQualifier).
 *
 * A custom method written after a colon is read as the segment it is written
 * on followed by the verb (see pathSegments): `/pets/{petId}:adopt` is
 * `{petId}` then `adopt`, so it is the action `adoptPet` exactly as
 * `/pets/{petId}/adopt` is; `/pets:bulkDelete` is read as `/pets/bulkDelete`
 * and is `bulkDelete`; `/pets:search` is read as `/pets/search` and stays a
 * `create`.
 */
function inferAction(
  method: HttpMethod,
  path: string,
  apiRootLength = 0,
): { verb: string; resource: string | null } | null {
  const segments = pathSegments(path);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  if (last.startsWith('{')) return null;
  const afterParam = segments.length >= 2 && segments[segments.length - 2].startsWith('{');
  const words = splitWords(last).map((w) => w.toLowerCase());
  const postAction = method === 'post' && afterParam && !last.toLowerCase().endsWith('s');
  const ownVerb = segmentCarriesVerb(method, path);
  const verbPhrase = method === 'post' && !afterParam && words.length > 0 && CRUD_VERBS.has(words[words.length - 1]);
  if (!postAction && !ownVerb && !verbPhrase) return null;

  const resource = afterParam
    ? inferItemParent(segments, apiRootLength)
    : inferResourceFromPath('/' + segments.slice(0, -1).join('/'), apiRootLength);
  return { verb: last, resource };
}

/**
 * Detect and resolve name collisions within a service's operations.
 *
 * A name taken from an `operationId` is the author's choice and is never
 * rewritten here. A name derived from the method and path (inferOperationName)
 * is only as unique as the path words it was built from, so when operations on
 * different paths share one, the path-named operations are qualified until
 * every path in the service has a name of its own. Operations on one path
 * share a name only when both are path-named and their methods take the same
 * CRUD verb (PUT and PATCH both `update`); any other sharing on one path is
 * resolved first (demoteSamePathNames), before the qualifiers below, since
 * every consumer that keys a service's operations by name — the differ among
 * them — would otherwise see one of the two. An action that shares a name
 * with a path-named operation of another shape yields next
 * (yieldActionNames), so `update` stays with `PUT /pets/{id}` and
 * `POST /pets/update` is `updatePets`.
 *
 * `apiRootLengthOf` gives the API root each operation's path sits under (see
 * documentApiRoot), so neither the resource nor the deeper context echoes the
 * root or the service segment into a name: `DELETE /api/v1/notes/all` in
 * `Notes` is `deleteAll`, never `deleteAllV1Notes`. An action's resource and
 * deeper context are read from its path without the action segment, and a
 * singleton's without its parent (see qualifierPath), so a second `adoptPet`
 * or `getPetStatus` is qualified by what sets its path apart and never by
 * repeating `Adopt` or `Pet`.
 *
 * Qualifiers are tried in order, each on every group still colliding after
 * the one before, and every pass — the qualifiers, the plural and nothing
 * else — goes through one rule, qualifyGroup: a pass renames a group's
 * path-named members only when the names it proposes tell the group apart,
 * and a context two paths write alike is spelled alike for both (see the
 * deeper-context qualifier), so a qualifier the colliding paths all carry —
 * `Teams` in `/org/teams/members` and `/org/teams/{teamId}/members`, written
 * once, singular after `{teamId}` — is never added, and the next pass tells
 * them apart: `listMembers` and `listMembersByTeamId`; a proposal
 * another operation already has is not taken, so a pass never hands a member
 * a name another operation had with the number then landing on it
 * (`/org/members/archived` beside `/org/archived_members` is never
 * `listArchivedMembers2`, and `/api/notes` beside `operationId: listNotes` is
 * never `listNotes2`) — unless every operation that has it is path-named and
 * names the same noun, which the member then joins (nameIsFree): `/notes`
 * restoring `Notes` beside `/notes/{noteId}/notes` is `listNotes` with the
 * nested collection `listNotesByNoteId`; and members whose proposals say the
 * same thing take one spelling and stay one group for the next pass, numbered
 * on it when nothing after tells them apart. A qualifier never puts the
 * same word twice in a row into a name, whether the name already ends with it
 * (`listNotes` never becomes `listNotesNotes`) or the qualifier repeats it
 * itself (`/api/analytics/analytics/teams` → `listTeamsAnalytics`), compared
 * word by word on the camelCase boundary rather than as a substring:
 *
 *   1. the resource noun (inferResourceFromPath); for the service's own
 *      path, whose plain name left that noun off, the service noun
 *      (inferServiceNoun) when a path-named operation outside the group
 *      already carries it under the name it would make, so that `/notes`
 *      beside `operationId: list` joins `/notes/{noteId}/notes` at
 *      `listNotes` and the parameter then tells them apart;
 *   2. the path segments between the service and the resource
 *      (inferDeeperContext), each singular when a path parameter follows it
 *      (pathSegmentNoun): `GET /users/{id}/legacy/factors` next to
 *      `GET /users/{id}/factors` → `listFactorsLegacy`, and
 *      `GET /store/cats/{id}/toys/{toyId}` next to
 *      `GET /store/dogs/{id}/toys/{toyId}` → `getToyCat` and `getToyDog`.
 *      A path whose singular spelling would take the name of an operation
 *      outside the group, or of another path in the group that the
 *      spelling as written sets apart, keeps the segments as written, the
 *      plural being what tells them apart: `/store/pets/{id}/toys/{toyId}`
 *      next to `/store/pet/{id}/toys/{toyId}` → `getToyPets` and
 *      `getToyPet`, and `/store/cats/{id}/toys/{toyId}` next to
 *      `operationId: getToyCat` → `getToyCats`;
 *   3. `By<Param>` for each path parameter the colliding paths do not all
 *      share, in path order, when those are what tell the paths apart:
 *      `GET /v1/notes` keeps `list` while `GET /v1/{teamId}/notes` becomes
 *      `listByTeamId`, with no root `GET /users/teams` keeps `listTeams` while
 *      `GET /users/{id}/teams` becomes `listTeamsById`, and
 *      `GET /api/notes/{noteId}` keeps `get` while
 *      `GET /api/{teamId}/notes/{noteId}` becomes `getByTeamId`, the shared
 *      `noteId` adding nothing;
 *   4. the API root words a path skipped beyond those the colliding rooted
 *      paths all skipped, when the paths sit under different lengths of the
 *      document root: `GET /api/notes` keeps `list` while `GET /api/v1/notes`
 *      becomes `listV1`. A root-less path takes no part;
 *   5. the resource noun the plain name left off because it names the
 *      service (inferServiceNoun), when the colliding paths do not all drop
 *      the same one. This is what tells a path-named operation from an
 *      operationId it collides with, which is never renamed and which the
 *      parameters above cannot touch: `GET /api/notes` beside
 *      `operationId: list` on `GET /api/{teamId}/notes` is `listNotes`;
 *   6. for a path-named item operation whose singular name none of those
 *      could tell apart — `GET /store/pets/{id}` is `getPet`, and so is
 *      `operationId: getPet` on `/store/featured/{id}`, or path-named
 *      `GET /store/pet/{id}`, whose path differs only by the plural the
 *      singular erased — the plural name it had before item resources were
 *      singularised, `getPets` (pluralFallbackName), when no operation
 *      outside the group has it. The plural still says which collection is
 *      read, and it is the name every SDK generated from such a document
 *      already exposes, where a number says nothing. Like the qualifiers
 *      above it runs only when it tells the group apart: an operationId-named
 *      operation, an action, a singleton and a name a qualifier has already
 *      extended have no plural, so any member that has one differs from
 *      them, while a group whose members would all take the same plural
 *      (`/store/Pets/{id}` beside `/store/pets/{id}`) goes straight to the
 *      suffix, since `getPets` beside `getPet` would say nothing about
 *      which is which. Members that share a plural some other member does
 *      not take it together and are numbered on it: beside `/store/pet/{id}`
 *      or an operationId's `getPet`, those two are `getPets` and `getPets2`,
 *      each a variant of its twin rather than of the operationId;
 *   7. a numeric suffix (`listNotes2`, `listNotes3`, …), when no pass above
 *      has a free name that tells the group apart, so an emitter never
 *      sees two methods with one name in one class. A name that already
 *      ends in a digit — the version the root words gave it (`listV1`), a
 *      path word (`listTop10`), an operationId (`getV2`) — takes the number
 *      behind `No` (numberedName): `GET /api/v1` beside `GET /api/v1/` is
 *      `listV1` and `listV1No2`, never `listV12`, which reads as version
 *      12. An operationId-named operation keeps the plain name over a
 *      path-named one; then the path
 *      that skipped the shorter root, so `/health` or a tagged `/notes` keeps
 *      `list` over `/api/health` or `/api/v1/notes`; otherwise the lexically
 *      first path keeps it, whatever the document order. The suffix is silent
 *      for a path-derived name, like a hashed inline model name; it comes
 *      with a warning when the document reuses an operationId, since that
 *      changes a name the author chose.
 *
 * Each qualifier depends only on the paths in the group, never on their
 * document order, and each runs once, so the result is deterministic.
 */
function disambiguateOperationNames(
  operations: Operation[],
  pathNamed: ReadonlySet<Operation>,
  serviceName: string,
  apiRootLengthOf: (op: Operation) => number,
): void {
  const rename = (op: Operation, name: string) => {
    (op as { name: string }).name = name;
  };
  // The noun an operation's path names: its resource, or, for the service's
  // own path, the service noun the plain name left off (`Notes` for `/notes`
  // and for `/notes/{noteId}/notes` alike, `Note` for their items). What
  // nameIsFree compares when another path-named operation holds a proposal.
  const nounOf = (op: Operation): string | null => {
    const root = apiRootLengthOf(op);
    return inferResourceFromPath(op.path, root) ?? inferServiceNoun(op.path, root);
  };
  /** The names every operation of the service outside `group` has right now, operationIds included. */
  const namesOutside = (group: Operation[]): ReadonlySet<string> => {
    const members = new Set(group);
    return new Set(operations.filter((op) => !members.has(op)).map((op) => op.name));
  };
  /** One pass on one group, through the rule every pass shares (qualifyGroup). */
  const qualify = (group: Operation[], proposal: (op: Operation) => string) =>
    qualifyGroup(group, operations, pathNamed, nounOf, proposal, rename);

  // One path first: the qualifiers below tell paths apart and leave a name
  // shared on one path alone, so that sharing is settled before they run.
  const demoted = demoteSamePathNames(operations, pathNamed, serviceName, apiRootLengthOf, rename);
  // Then an action beside a CRUD or singleton operation of its name: the
  // plain name stays with the latter, which the qualifiers would rename.
  for (const op of yieldActionNames(operations, pathNamed, demoted, apiRootLengthOf, rename)) demoted.add(op);

  // Each qualifier, given the group, is the word or words a path-named
  // member would add to its name: `null` or `''` when its path has none.
  const qualifiers: Array<(group: Operation[]) => (op: Operation) => string | null> = [
    (group) => (op) => {
      const root = apiRootLengthOf(op);
      const resource = inferResourceFromPath(qualifierPath(op, root, !demoted.has(op)), root);
      if (resource !== null) return resource;
      // The service's own path left its noun off the plain name (`list` for
      // `/notes`). It is proposed here, ahead of the service-noun pass, when a
      // path-named operation outside the group already carries it under the
      // name it would make — the nested collection of the same word,
      // `/notes/{noteId}/notes` as `listNotes` — so the two take one spelling
      // (nameIsFree) and the parameters tell them apart, `listNotes` and
      // `listNotesByNoteId`, rather than the nested collection keeping the
      // name the service's own path restores beside an operationId.
      const noun = inferServiceNoun(op.path, root);
      if (noun === null) return null;
      const name = appendQualifier(op.name, noun);
      const held = operations.some((other) => !group.includes(other) && pathNamed.has(other) && other.name === name);
      return held && nameIsFree(group, operations, pathNamed, nounOf, op, name) ? noun : null;
    },
    (group) => {
      // Singular, like the resource of an item operation, unless that
      // spelling gives a path the name of an operation outside the group or
      // of another path in the group whose spelling as written differs: the
      // plural is then what tells them apart, so the path takes its context
      // as written. `/store/pets/{id}/toys/{toyId}` beside
      // `/store/pet/{id}/toys/{toyId}` is `getToyPets` and `getToyPet`, and
      // `/store/cats/{id}/toys/{toyId}` beside `operationId: getToyCat` is
      // `getToyCats`. As written, too, when another path in the group
      // writes the same words but singularises them differently — `teams`
      // in `/org/teams/members` and in `/org/teams/{teamId}/members` — so
      // one spelling in the paths is one spelling in the names, `Teams` for
      // both, which tells nothing apart (qualifyGroup) and leaves the
      // parameters to do it: `listMembers` and `listMembersByTeamId`, never
      // `listMembersTeams` beside `listMembersTeam` (issue #288). Two paths
      // whose contexts agree in both spellings (`/orgs/teams/{id}/members`
      // and `/orgs/{orgId}/teams/{id}/members`) stay singular and go on to
      // the parameters together. Both spellings are read before any member
      // is renamed, so the outcome does not depend on document order.
      const outside = namesOutside(group);
      const spelled = new Map(
        group
          .filter((op) => pathNamed.has(op))
          .map((op) => {
            const root = apiRootLengthOf(op);
            const path = qualifierPath(op, root, !demoted.has(op));
            return [
              op,
              {
                singular: inferDeeperContext(path, root),
                written: inferDeeperContext(path, root, false),
                singularName: appendQualifier(op.name, inferDeeperContext(path, root)),
                writtenName: appendQualifier(op.name, inferDeeperContext(path, root, false)),
              },
            ] as const;
          }),
      );
      return (op) => {
        const own = spelled.get(op);
        if (own === undefined) return null;
        const asWritten =
          own.writtenName !== own.singularName &&
          (outside.has(own.singularName) ||
            [...spelled].some(
              ([other, spelling]) =>
                other.path !== op.path &&
                (spelling.singularName === own.singularName) !== (spelling.writtenName === own.writtenName),
            ));
        return asWritten ? own.written : own.singular;
      };
    },
    (group) => {
      // Parameters only help when they differ between the colliding paths,
      // so one every path carries is left out — `/api/notes/{noteId}` and
      // `/api/{teamId}/notes/{noteId}` are told apart by `teamId` alone —
      // and when none does, every proposal reads alike and qualifyGroup
      // skips the pass: `/v1/{id}/notes` and `/v1/{id}/Notes` would both
      // gain `ById` and still collide, further from the plain name. Every
      // path-named operation takes part, under an API root or not: a service
      // must not hand an emitter two methods with one name.
      const shared = sharedPathParams(group.map((op) => op.path));
      return (op) => inferByParamsSuffix(op.path, shared);
    },
    (group) => {
      // Paths under the document root that skipped different lengths of it
      // differ by a version or mount word the plain name left off: `/api/notes`
      // beside `/api/v1/notes` in `Notes`. The words a path skipped beyond the
      // root the rooted paths all share are what tell them apart (`listV1`),
      // the one place a root word belongs in a name. A root-less path — outside
      // the root, or tagged — is named as if the document had none and takes
      // no part; it keeps the plain name in the numeric pass instead.
      const rooted = group.map((op) => pathSegments(op.path).slice(0, apiRootLengthOf(op))).filter((r) => r.length > 0);
      let shared = rooted[0] ?? [];
      for (const root of rooted) shared = shared.slice(0, sharedPrefixLength(shared, root));
      return (op) => toPascalCase(pathSegments(op.path).slice(shared.length, apiRootLengthOf(op)).join('_'));
    },
    () => (op) => {
      // The plain name leaves off the resource noun that names the service
      // (`GET /api/notes` in `Notes` is `list`); it is restored when it is
      // what tells the group apart. An operationId-named operation is never
      // renamed, so it contributes nothing here: next to `operationId: list`
      // on `/api/{teamId}/notes`, path-named `/api/notes` becomes
      // `listNotes`. When every path drops the same noun (`/notes` and
      // `/api/v1/notes`), restoring it would only move the collision, and
      // qualifyGroup skips the pass.
      return inferServiceNoun(op.path, apiRootLengthOf(op));
    },
  ];

  for (const qualifier of qualifiers) {
    for (const group of collidingGroups(operations)) {
      const words = qualifier(group);
      qualify(group, (op) => appendQualifier(op.name, words(op)));
    }
  }

  // The plural a member could take back: none for an operationId-named
  // operation, and for a path-named one only while its name is still the one
  // it was built with — no qualifier above has extended it. Like every pass,
  // only when it tells the group apart: beside an operationId, which has no
  // plural, or beside a path that spells the resource singular
  // (`/store/pet/{id}`). The plural is compared as written, since its number
  // is the whole point; members that would all take the same plural are left
  // to the numeric suffix.
  const pluralOf = (op: Operation): string | null => {
    const root = apiRootLengthOf(op);
    const actions = !demoted.has(op);
    if (op.name !== fallbackOperationName(op.httpMethod, op.path, root, actions)) return null;
    return pluralFallbackName(op.httpMethod, op.path, root, actions);
  };
  for (const group of collidingGroups(operations)) {
    // Like every qualifier, only when it tells the group apart: beside an
    // operationId, which has no plural, or beside a path that spells the
    // resource singular (`/store/pet/{id}`). Members that would all take the
    // same plural are left to the numeric suffix. A plural is blocked only by
    // a name outside the group (`operationId: getPets`); members that share
    // one some other member does not (`/store/Pets/{id}` and
    // `/store/pets/{id}` beside `/store/pet/{id}`) take it together and are
    // numbered below, `getPets` and `getPets2` — the names such a document
    // produced before item resources were singularised. Two groups never
    // share a plural: it is the group's singular name with the resource as
    // written, so one plural means one singular name, and one group.
    qualify(group, (op) => pluralOf(op) ?? op.name);
  }

  const taken = new Set(operations.map((op) => op.name));
  for (const group of collidingGroups(operations)) {
    const name = group[0].name;
    // An operationId-named operation outranks a path-named one for the plain
    // name; then the path that skipped the shorter API root, so a root-less
    // path (`/health`, or a tagged `/notes`) keeps the name it has always had
    // over `/api/health` or `/api/v1/notes`; within that the lexically first
    // path wins. The outcome never depends on document order, and operations
    // on one path share it.
    const rank = (op: Operation) => (pathNamed.has(op) ? 1 : 0);
    const ordered = [...group].sort(
      (a, b) => rank(a) - rank(b) || apiRootLengthOf(a) - apiRootLengthOf(b) || comparePaths(a, b),
    );
    const keeper = ordered[0];
    const nameByPath = new Map<string, string>([[keeper.path, name]]);
    let n = 2;
    for (const op of ordered) {
      let next = nameByPath.get(op.path);
      if (next === undefined) {
        while (taken.has(numberedName(name, n))) n++;
        next = numberedName(name, n);
        taken.add(next);
        nameByPath.set(op.path, next);
        // A path-derived name is the parser's own and is refined silently,
        // like a hashed inline model name. A name the document chose is only
        // changed when the document reuses it, which is worth saying.
        if (!pathNamed.has(op)) {
          console.warn(
            `[oagen] Warning: Operations ${keeper.httpMethod.toUpperCase()} ${keeper.path} and ` +
              `${op.httpMethod.toUpperCase()} ${op.path} in service ${serviceName} both take the name ` +
              `"${name}" from their operationId; the latter is renamed "${next}" — give each a distinct operationId`,
          );
        }
      }
      rename(op, next);
    }
  }
}

/**
 * Give operations on one path distinct names when their methods take
 * different CRUD verbs. Two operations on one path share a name only when
 * both are path-named and their methods take the same verb (inferVerb): PUT
 * and PATCH are both `update`, so `/pets/{id}` has one `updatePet` for the
 * two, as it always has. Any other sharing hides one of the two from every
 * consumer that keys a service's operations by name, such as the differ, and
 * an action name is where it arises: `bulk-delete` is the action of a DELETE
 * (its own verb) and of a POST (a CRUD verb last), so both would be
 * `bulkDelete`.
 *
 * The name stays with one verb, and every path-named operation of another
 * verb takes the name it has without the action rule (fallbackOperationName
 * with `actions` false): `POST /pets/bulk-delete` beside a DELETE is
 * `createBulkDelete`, and `POST /users/{id}/update-password` beside a PUT is
 * the singleton `createUserUpdatePassword`. The verb that keeps the name: an
 * operationId-named operation's, since that name is the author's and a
 * path-named sibling steps aside whatever its verb; else the verb the segment
 * carries (segmentCarriesVerb), `delete` for `bulk-delete`, the first
 * method's in HTTP_METHODS order when it carries two; else `create`, POST
 * being the only other method an action is read on (inferAction); else, for
 * a shared name that is no action (PUT and PATCH `updatePet`), the verb of
 * the first method in HTTP_METHODS order. When the name an operation falls back to is
 * still held on the path by an operationId or by another verb — path-named
 * PATCH `updatePet` beside `operationId: updatePet` on the PUT has no action
 * to drop — a numeric suffix free in the service is added, silently, as the
 * numeric pass adds one and spelled as it spells it (numberedName:
 * `updatePet2`, and `updateTop10No2` for a PATCH on `/store/top10/{id}`
 * beside `operationId: updateTop10`). Two operationId-named operations on
 * one path with one name are the document reusing an operationId: the first
 * in HTTP_METHODS order keeps it and the rest are numbered with the warning
 * the numeric pass gives that case. Paths are visited in lexical order and
 * their operations in HTTP_METHODS order, so the result depends only on the
 * document's paths and methods.
 *
 * Returns the path-named operations that gave an action name up, whose
 * qualifiers and plural read their path as the shape they fell back to.
 */
function demoteSamePathNames(
  operations: Operation[],
  pathNamed: ReadonlySet<Operation>,
  serviceName: string,
  apiRootLengthOf: (op: Operation) => number,
  rename: (op: Operation, name: string) => void,
): Set<Operation> {
  const demoted = new Set<Operation>();
  const taken = new Set(operations.map((op) => op.name));
  const verbOf = (op: Operation) => inferVerb(op.httpMethod, op.path);
  const methodOrder = (a: Operation, b: Operation) =>
    HTTP_METHODS.indexOf(a.httpMethod) - HTTP_METHODS.indexOf(b.httpMethod);
  // The verb that keeps a shared action name among path-named operations.
  const claim = (op: Operation) => (segmentCarriesVerb(op.httpMethod, op.path) ? 0 : op.httpMethod === 'post' ? 1 : 2);
  const freeSuffixed = (base: string) => {
    let n = 2;
    while (taken.has(numberedName(base, n))) n++;
    return numberedName(base, n);
  };

  const byPath = new Map<string, Operation[]>();
  for (const op of operations) byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);
  for (const path of [...byPath.keys()].sort()) {
    const onPath = (byPath.get(path) ?? []).sort(methodOrder);
    const byName = new Map<string, Operation[]>();
    for (const op of onPath) byName.set(op.name, [...(byName.get(op.name) ?? []), op]);
    for (const [name, sharing] of byName) {
      if (sharing.length < 2) continue;
      const explicit = sharing.filter((op) => !pathNamed.has(op));
      for (const op of explicit.slice(1)) {
        const next = freeSuffixed(name);
        console.warn(
          `[oagen] Warning: Operations ${explicit[0].httpMethod.toUpperCase()} ${explicit[0].path} and ` +
            `${op.httpMethod.toUpperCase()} ${op.path} in service ${serviceName} both take the name ` +
            `"${name}" from their operationId; the latter is renamed "${next}" — give each a distinct operationId`,
        );
        rename(op, next);
        taken.add(next);
      }
      const keeper =
        explicit.length > 0 ? null : [...sharing].sort((a, b) => claim(a) - claim(b) || methodOrder(a, b))[0];
      const keptVerb = keeper === null ? null : verbOf(keeper);
      for (const op of sharing) {
        if (!pathNamed.has(op) || verbOf(op) === keptVerb) continue;
        const base = fallbackOperationName(op.httpMethod, op.path, apiRootLengthOf(op), false);
        // Still held on the path by an operationId or another verb? Number it.
        const held = onPath.some(
          (other) => other !== op && other.name === base && (!pathNamed.has(other) || verbOf(other) !== verbOf(op)),
        );
        const next = held ? freeSuffixed(base) : base;
        if (next !== op.name) {
          rename(op, next);
          taken.add(next);
        }
        demoted.add(op);
      }
    }
  }
  return demoted;
}

/**
 * Keep the plain CRUD name with the CRUD operation when an action takes it.
 * `POST /pets/update` is the action `update` — its collection `pets` is the
 * service segment, which a name leaves off — and so is `PUT /pets/{id}`. Left
 * to the qualifiers, the pair would be told apart by `By<Param>`, which
 * renames the PUT to `updateById`, and code calling `update` would then
 * reach `POST /pets/update`. So before the qualifiers run, a path-named
 * action that shares its name with a path-named operation of another shape —
 * a CRUD operation or a singleton, for which inferAction is null, a demoted
 * action among them — is renamed alone. It takes back the collection it
 * dropped, the service noun of the path the action segment sits on
 * (inferServiceNoun of qualifierPath): `updatePets`, `createPets` for
 * `POST /pets/create` beside `POST /pets`, `listAllPets` for
 * `GET /pets/list-all` beside `GET /pets/all`. When that adds nothing —
 * the name already ends with it (`POST /store/pets/{id}/create` is
 * `createPet`, as `POST /store/pets/{id}` is) or there is none
 * (`POST /store/pets/update` is `updatePets`, as `PUT /store/pets` is) — it
 * takes the name it has without the action rule (`createPetCreate`,
 * `createUpdate`) and is read from then on
 * as that shape, like a demoted action (demoteSamePathNames). An action
 * beside an operationId of its name is left to the numeric pass
 * (`adoptPet2`), and two actions of one name to the qualifiers
 * (`adoptPetRescue`). Groups come in name order and the renames depend only
 * on each operation's own path, so the result is deterministic. Returns the
 * operations that fell back to their non-action name.
 */
function yieldActionNames(
  operations: Operation[],
  pathNamed: ReadonlySet<Operation>,
  demoted: ReadonlySet<Operation>,
  apiRootLengthOf: (op: Operation) => number,
  rename: (op: Operation, name: string) => void,
): Operation[] {
  const fellBack: Operation[] = [];
  const isAction = (op: Operation) =>
    pathNamed.has(op) && !demoted.has(op) && inferAction(op.httpMethod, op.path, apiRootLengthOf(op)) !== null;
  for (const group of collidingGroups(operations)) {
    if (!group.some((op) => pathNamed.has(op) && !isAction(op))) continue;
    for (const op of group.filter(isAction)) {
      const root = apiRootLengthOf(op);
      const qualified = appendQualifier(op.name, inferServiceNoun(qualifierPath(op, root), root));
      if (qualified !== op.name) {
        rename(op, qualified);
      } else {
        rename(op, fallbackOperationName(op.httpMethod, op.path, root, false));
        fellBack.push(op);
      }
    }
  }
  return fellBack;
}

/**
 * The groups of operations that share a name but not a path, in name order.
 * A name shared only by operations on one path is not a collision and is
 * excluded: after demoteSamePathNames such operations are path-named and
 * their methods take one verb (PUT + PATCH).
 *
 * Name order, not document order: the numeric pass draws suffixed names from
 * one pool per service, and two groups can reach the same one (`listNotes1`
 * + `No2` and `listNotes1No` + `2`, see numberedName), so whichever is
 * served first decides. Names are unique per group, so this is a total
 * order, and with the members of a group also sorted the whole assignment
 * depends only on the paths.
 */
function collidingGroups(operations: Operation[]): Operation[][] {
  const byName = new Map<string, Operation[]>();
  for (const op of operations) {
    const group = byName.get(op.name) ?? [];
    group.push(op);
    byName.set(op.name, group);
  }
  return [...byName.entries()]
    .filter(([, group]) => new Set(group.map((op) => op.path)).size > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => group);
}

/** Operations in path order, by code unit, the one tie-break every pass of disambiguateOperationNames uses. */
function comparePaths(a: Operation, b: Operation): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * One pass of disambiguateOperationNames on one colliding group: the group's
 * path-named members take the names the pass proposes for them when the pass
 * tells the group apart, and only names no operation outside the group has.
 * An operationId-named member is never renamed and stands at its own name.
 *
 * `proposal` is the name a path-named member would take, compared as
 * written: a pass that must not part two paths on a word's number alone
 * spells it alike for both before proposing (the deeper context of
 * `/org/teams/members` and `/org/teams/{teamId}/members` is `Teams` for
 * both, never `Teams` beside `Team`), and a pass whose number is the point
 * (the plural, `getPets` beside `getPet`) proposes it as it is. Three rules
 * follow, each on this one place:
 *
 *   - The pass is skipped for the group when every proposal is one name. A
 *     qualifier the colliding paths all carry — `Teams` above — would move
 *     the collision further from the plain name and tell nothing apart; the
 *     next pass (`ByTeamId`) is what does.
 *   - A proposal an operation outside the group already has is not taken
 *     (nameIsFree): the member keeps its name for this pass and the next pass
 *     is tried, so `/org/members/archived` beside `/org/archived_members`,
 *     whose name is `listArchivedMembers`, is never `listArchivedMembers2`,
 *     which reads as a variant of a path it is unrelated to; a number is for
 *     when no pass is left. Its colliding twin `/org/teams/archived` still
 *     takes `listArchivedTeams`, and `listArchived` is then its own.
 *   - Members with one proposal stay one group for the next pass: they take
 *     it together — `/orgs/{orgId}/groups/members` and
 *     `/orgs/{orgId}/groups/{groupId}/members` beside `/orgs/teams/members`
 *     are `listMembersGroups` both, told apart next by `ByGroupId` — and are
 *     numbered on it when nothing after tells them apart. Members on one path
 *     (PUT + PATCH) share a name by the same rule.
 *
 * Which names are taken is read when the group is reached, so groups a pass
 * served earlier — in name order (collidingGroups) — hold their new names
 * against it, and the outcome depends only on the paths.
 */
function qualifyGroup(
  group: readonly Operation[],
  operations: readonly Operation[],
  pathNamed: ReadonlySet<Operation>,
  nounOf: (op: Operation) => string | null,
  proposal: (op: Operation) => string,
  rename: (op: Operation, name: string) => void,
): void {
  const proposals = new Map(group.map((op) => [op, pathNamed.has(op) ? proposal(op) : op.name]));
  const clusters = new Map<string, Operation[]>();
  for (const op of [...group].sort(comparePaths)) {
    const name = proposals.get(op) ?? op.name;
    clusters.set(name, [...(clusters.get(name) ?? []), op]);
  }
  if (clusters.size <= 1) return;
  for (const [name, members] of clusters) {
    if (!members.every((op) => nameIsFree(group, operations, pathNamed, nounOf, op, name))) continue;
    for (const op of members) {
      if (pathNamed.has(op)) rename(op, name);
    }
  }
}

/**
 * Whether `name` is free for `op`, a member of `group`: no operation outside
 * the group has it, or every operation that has it is path-named and names
 * the noun `op` names (`nounOf`, compared as sameNoun compares) — the nested
 * collection of the service's own word, `/notes/{noteId}/notes` as
 * `listNotes` beside `/notes`. Such a name the member takes and joins the
 * group of, and the passes after tell the two apart by what does differ
 * between their paths: `listNotes` and `listNotesByNoteId`, `getNote` and
 * `getNoteByChildId`. A name an operationId-named operation has is never
 * free, nor is one a path-named operation of another noun has:
 * `listArchivedMembers` on `/org/archived_members` beside the `Archived` of
 * `/org/members/archived`, which nothing after could tell apart.
 */
function nameIsFree(
  group: readonly Operation[],
  operations: readonly Operation[],
  pathNamed: ReadonlySet<Operation>,
  nounOf: (op: Operation) => string | null,
  op: Operation,
  name: string,
): boolean {
  const noun = nounOf(op);
  return operations.every((other) => {
    if (group.includes(other) || other.name !== name) return true;
    const otherNoun = pathNamed.has(other) ? nounOf(other) : null;
    return noun !== null && otherNoun !== null && sameNoun(otherNoun.toLowerCase(), noun.toLowerCase());
  });
}

/**
 * `name` with the numeric suffix `n`, the last resort of
 * disambiguateOperationNames across paths and of demoteSamePathNames on one
 * path: `list` + 2 is `list2`. A name that already
 * ends in a digit takes the number behind `No`, so that it cannot be read
 * as part of the number the name ends with: `listV1` + 2 is `listV1No2`,
 * never `listV12`, which reads as version 12 of the API, and `listTop10` +
 * 2 is `listTop10No2`. An underscore would not do: splitWords reads a digit
 * run as a word of its own, so `listV1_2` re-cased by toPascalCase or
 * toCamelCase is `ListV12` or `listV12` again.
 */
function numberedName(name: string, n: number): string {
  return /\d$/.test(name) ? `${name}No${n}` : `${name}${n}`;
}

/**
 * Append a qualifier to an operation name without repeating what the name
 * already says. A qualifier never contributes the same word twice in a row:
 * the deeper context of `/api/analytics/analytics/teams` is
 * `AnalyticsAnalytics`, which joins as `listTeamsAnalytics`. The words that
 * remain are then joined where they overlap the end of the name: `listNotes`
 * + `Notes` and `listOAuth2Tokens` + `OAuth2Tokens` stay as they are, and
 * `listTeams` + `TeamsAnalytics` is `listTeamsAnalytics`. Words are compared
 * on the camelCase boundary, case-insensitively and as nouns (sameNoun), so
 * a noun the name ends with is not repeated in the other number either:
 * `listNotes` + `Note` and `listAliases` + `Alias`, the deeper contexts of
 * `/orgs/notes/{id}/notes` and `/org/aliases/{id}/aliases`, stay `listNotes`
 * and `listAliases`. The name's own words are never touched.
 */
function appendQualifier(name: string, qualifier: string | null): string {
  if (!qualifier) return name;
  const have = splitWords(name).map((w) => w.toLowerCase());
  const words = splitWords(qualifier).filter(
    (w, i, all) => i === 0 || !sameNoun(w.toLowerCase(), all[i - 1].toLowerCase()),
  );
  const want = words.map((w) => w.toLowerCase());
  // The longest run of words that both ends the name and starts the qualifier.
  let overlap = Math.min(have.length, want.length);
  while (overlap > 0 && !want.slice(0, overlap).every((w, i) => sameNoun(w, have[have.length - overlap + i]))) {
    overlap--;
  }
  const rest = words.slice(overlap);
  return rest.length === 0 ? name : toCamelCase([name, ...rest].join('_'));
}

/**
 * Whether two lowercase words name one noun: they are the same word, or
 * their singular forms (singularizePathSegment) are — `notes` and `note`,
 * `aliases` and `alias`, `analyses` and `analysis`. singularizePathSegment
 * is idempotent, so a word that is already singular is its own singular
 * form and is never shortened a second time on one side only (`alias`
 * compares as `alias`, not `alia`, against the `alias` that `aliases`
 * becomes). Two words the stemmer cannot relate, `canvases` and `canvas`,
 * are different nouns here, as they are everywhere else.
 */
function sameNoun(a: string, b: string): boolean {
  return a === b || singularizePathSegment(a) === singularizePathSegment(b);
}

/**
 * The path a colliding operation's resource and deeper context are read
 * from: the path without the segments whose words the name already carries
 * ahead of its last word, so that what remains ends with the word the name
 * ends with, which appendQualifier leaves alone, and the rest is what sets
 * the colliding paths apart.
 *
 * For an action (inferAction) it is the path without the action segment:
 * `adoptPet` on `/shop/rescue/pets/{id}/adopt` is read as
 * `/shop/rescue/pets/{id}`, whose resource `Pet` the name ends with and whose
 * deeper context `Rescue` tells it from `/shop/pets/{id}/adopt`, rather than
 * the verb coming back as `adoptPetAdopt`. For a singleton (inferSingleton)
 * it is the path without the parent (itemParentIndex) and the parameter
 * before the segment: `getPetStatus` on `/shop/rescue/pets/{id}/status` is
 * read as `/shop/rescue/status`, whose resource `Status` the name ends with,
 * so the same `Rescue` tells it from `/shop/pets/{id}/status` rather than
 * `Pet` coming back as `getPetStatusPet`. Every other operation is read
 * whole, as is an action that gave its name up on its path
 * (demoteSamePathNames; `actions` false), whose name is the next shape's.
 */
function qualifierPath(op: Operation, apiRootLength: number, actions = true): string {
  const segments = pathSegments(op.path);
  if (actions && inferAction(op.httpMethod, op.path, apiRootLength)) return '/' + segments.slice(0, -1).join('/');
  if (inferSingleton(op.path, apiRootLength)) {
    const parent = itemParentIndex(segments, apiRootLength);
    return '/' + segments.filter((_, i) => i !== parent && i !== segments.length - 2).join('/');
  }
  return op.path;
}

/**
 * The path parameters in path order, each as the PascalCase word that
 * `By<Param>` spells it with. Mirrors derivePathModelBaseName's spelling of a
 * parameter segment, so `{team_id}` and `{teamId}` read alike. A parameter
 * that carries a custom method (`{petId}:adopt`) is the parameter alone,
 * `PetId`, since pathSegments has split the verb off.
 */
function pathParamWords(path: string): string[] {
  return pathSegments(path)
    .filter((segment) => segment.startsWith('{'))
    .map((segment) => toPascalCase(segment.replace(/[{}]/g, '')));
}

/** The parameter words (pathParamWords) that every one of the paths carries. */
function sharedPathParams(paths: readonly string[]): ReadonlySet<string> {
  const words = paths.map((path) => new Set(pathParamWords(path)));
  return new Set([...(words[0] ?? [])].filter((word) => words.every((set) => set.has(word))));
}

/**
 * `By<Param>` for each path parameter not in `shared`, in path order, as one
 * qualifier: `/v1/{teamId}/notes` → `ByTeamId`, `/a/{x}/b/{y}/c` → `ByXByY`,
 * and `/api/{teamId}/notes/{noteId}` → `ByTeamId` when the colliding paths
 * all carry `noteId`. Empty for a path with no parameter of its own.
 */
function inferByParamsSuffix(path: string, shared: ReadonlySet<string>): string {
  return pathParamWords(path)
    .filter((word) => !shared.has(word))
    .map((word) => 'By' + word)
    .join('');
}

/**
 * The resource noun inferResourceFromPath leaves off because it is the
 * segment the service was named from, spelled as that function would have
 * spelled it (pathSegmentNoun): `Notes` for `/api/notes` and
 * `/api/{teamId}/notes` under an `/api` root and for a root-less `/notes`,
 * `Note` for the item `/api/notes/{id}`. Null when the last literal segment
 * past the API root is a different word (`/api/notes/{id}/tags`, whose `Tags`
 * the plain name already carries) or when nothing literal follows the root
 * (`/api/v1/{id}`).
 */
function inferServiceNoun(path: string, apiRootLength: number): string | null {
  const segments = pathSegments(path);
  let last = segments.length - 1;
  while (last >= apiRootLength && segments[last].startsWith('{')) last--;
  if (last < apiRootLength || last !== serviceSegmentIndex(path, apiRootLength)) return null;
  return toPascalCase(pathSegmentNoun(segments, last));
}

/**
 * Extract a deeper disambiguation context from the path when the resource
 * noun isn't unique enough: the literal segments between the service segment
 * and the resource, joined in path order, each spelled as pathSegmentNoun
 * spells it — singular when a path parameter follows it, since the segment
 * then addresses one item, and as written otherwise.
 *
 * /users/{id}/legacy/factors → "Legacy"
 * /store/cats/{id}/toys/{toyId} → "Cat" (one cat's toys), so `getToyCat` beside `/store/dogs/{id}/toys/{toyId}`
 * /store/cats/toys/{toyId} → "Cats" (no one cat), so `getToyCats` beside `/store/dogs/toys/{toyId}`
 * /org/analytics/analytics/teams → "AnalyticsAnalytics" (appendQualifier collapses the repeat)
 * /users/{id}/auth_factors → null: nothing lies between the service and the resource
 *
 * `Cat` and `Cats` are one noun, so beside each other the two cat paths are
 * not told apart by it (qualifyGroup): `/store/cats/{id}/toys/{toyId}` and
 * `/store/cats/toys/{toyId}` are `getToyById` and `getToy`, by the
 * parameter that does tell them apart.
 *
 * The API root the path sits under (`apiRootLength`, see documentApiRoot) is
 * left out along with the service segment that follows it, so
 * /api/v1/core/auth/permissions in `Core` contributes "Auth", not "V1CoreAuth".
 * `singularItem` false keeps every segment as the path spells it (`Pets` for
 * `/store/pets/{id}/toys/{toyId}`), for the qualifier that falls back to the
 * plural when the singular does not tell two paths apart (see
 * disambiguateOperationNames). The stemmer's limits reach every segment it
 * singularises: `/messages/sms/{smsId}/attachments` contributes "Sm".
 */
function inferDeeperContext(path: string, apiRootLength = 0, singularItem = true): string | null {
  const segments = pathSegments(path);
  const nouns: string[] = [];
  for (let i = apiRootLength; i < segments.length; i++) {
    if (!segments[i].startsWith('{')) nouns.push(singularItem ? pathSegmentNoun(segments, i) : segments[i]);
  }
  // Skip first (service) and last (already used) — use the middle ones
  if (nouns.length >= 3) {
    return toPascalCase(nouns.slice(1, -1).join('_'));
  }
  return null;
}

/**
 * Extract mutually-exclusive parameter groups from the `x-mutually-exclusive-parameter-groups`
 * operation extension. Cross-references grouped parameter names against the already-extracted
 * IR parameter arrays so emitters get object-identity references.
 */
function extractParameterGroups(
  op: OperationObject,
  allIRParams: Parameter[],
  operationContext: string,
): ParameterGroup[] | undefined {
  const raw = op['x-mutually-exclusive-parameter-groups'];
  if (!raw || typeof raw !== 'object') return undefined;

  const paramByName = new Map<string, Parameter>();
  for (const p of allIRParams) {
    paramByName.set(p.name, p);
  }

  const groups: ParameterGroup[] = [];

  for (const [groupName, groupDef] of Object.entries(raw)) {
    if (!groupDef || typeof groupDef !== 'object') {
      throw new Error(
        `Malformed x-mutually-exclusive-parameter-groups.${groupName} in ${operationContext}: expected an object with "optional" and "variants".`,
      );
    }

    if (typeof groupDef.optional !== 'boolean') {
      throw new Error(
        `Malformed x-mutually-exclusive-parameter-groups.${groupName}.optional in ${operationContext}: expected a boolean.`,
      );
    }

    if (!groupDef.variants || typeof groupDef.variants !== 'object') {
      throw new Error(
        `Malformed x-mutually-exclusive-parameter-groups.${groupName}.variants in ${operationContext}: expected an object mapping variant names to parameter name arrays.`,
      );
    }

    if (Object.keys(groupDef.variants).length === 0) {
      throw new Error(
        `Malformed x-mutually-exclusive-parameter-groups.${groupName} in ${operationContext}: group has zero variants.`,
      );
    }

    const variants = Object.entries(groupDef.variants).map(([variantName, paramNames]) => {
      if (!Array.isArray(paramNames) || paramNames.length === 0) {
        throw new Error(
          `Malformed x-mutually-exclusive-parameter-groups.${groupName}.variants.${variantName} in ${operationContext}: expected a non-empty array of parameter names.`,
        );
      }
      const parameters: Parameter[] = paramNames.map((pName) => {
        const irParam = paramByName.get(pName);
        if (!irParam) {
          throw new Error(
            `x-mutually-exclusive-parameter-groups.${groupName}.variants.${variantName} references parameter "${pName}" which does not exist in the operation's parameters[] (${operationContext}).`,
          );
        }
        return irParam;
      });
      return { name: variantName, parameters };
    });

    groups.push({
      name: groupName,
      optional: groupDef.optional,
      variants,
    });
  }

  return groups.length > 0 ? groups : undefined;
}

/**
 * Extract mutually-exclusive body parameter groups from the
 * `x-mutually-exclusive-body-groups` operation extension. Unlike query
 * parameter groups (whose parameters live in operation.queryParams), body
 * group parameters are synthetic — built from the oneOf variant schemas in
 * the request body. Emitters use the group's presence to generate sum-type
 * interfaces and custom JSON marshalling instead of flat optional fields.
 */
function extractBodyParameterGroups(
  op: OperationObject,
  requestBody: RequestBodyObject | undefined,
  operationContext: string,
  componentSchemas?: Record<string, SchemaObject>,
): ParameterGroup[] | undefined {
  const raw = op['x-mutually-exclusive-body-groups'];
  if (!raw || typeof raw !== 'object') return undefined;

  // Collect the body schema's oneOf variant fields so we can resolve types.
  // The body schema has been structurally rewritten to allOf: [base, { oneOf: [...] }]
  // by the spec generator; the variant properties live inside oneOf branches.
  // Read from the same pick `requestBody` is typed from, so a body under
  // `application/json; charset=utf-8` or a `+json` media type resolves its
  // members like one under plain `application/json`.
  const bodySchema = selectRequestBodyContent(requestBody)?.schema;
  const variantFieldSchemas = collectVariantFieldSchemas(bodySchema, componentSchemas);

  const groups: ParameterGroup[] = [];

  for (const [groupName, groupDef] of Object.entries(raw)) {
    if (!groupDef || typeof groupDef !== 'object') continue;
    if (typeof groupDef.optional !== 'boolean') continue;
    if (!groupDef.variants || typeof groupDef.variants !== 'object') continue;
    if (Object.keys(groupDef.variants).length === 0) continue;

    const variants = Object.entries(groupDef.variants).map(([variantName, paramNames]) => {
      if (!Array.isArray(paramNames) || paramNames.length === 0) {
        throw new Error(
          `Malformed x-mutually-exclusive-body-groups.${groupName}.variants.${variantName} in ${operationContext}: expected a non-empty array of parameter names.`,
        );
      }
      const parameters: Parameter[] = paramNames.map((pName) => {
        const entry = variantFieldSchemas.get(pName);
        const fieldSchema = entry?.schema;
        // No schema found means the body's oneOf branches don't declare this
        // member. Falling back to `string` silently produces an SDK that
        // type-checks against itself but misrepresents the wire contract
        // (object-valued members become plain strings), so say so loudly.
        if (!fieldSchema) {
          console.warn(
            `[oagen] Warning: x-mutually-exclusive-body-groups.${groupName}.variants.${variantName} ` +
              `references "${pName}" in ${operationContext}, but no oneOf branch of the request body ` +
              `declares that property. Falling back to type: string.`,
          );
        }
        const fieldType: TypeRef = fieldSchema
          ? schemaToTypeRef(fieldSchema, toPascalCase(pName), entry?.owner)
          : { kind: 'primitive', type: 'string' };
        return {
          name: pName,
          type: fieldType,
          required: false, // group variant fields are always optional at the struct level
          description: fieldSchema?.description,
        };
      });

      // Optional variant membership: fields the caller may omit when using
      // this variant. Only names that actually belong to the variant count —
      // anything else in the extension is ignored rather than fatal.
      const rawOptionalFields =
        groupDef.optionalFields && typeof groupDef.optionalFields === 'object'
          ? groupDef.optionalFields[variantName]
          : undefined;
      const optionalParameters = Array.isArray(rawOptionalFields)
        ? rawOptionalFields.filter((name): name is string => typeof name === 'string' && paramNames.includes(name))
        : [];

      return {
        name: variantName,
        parameters,
        ...(optionalParameters.length > 0 ? { optionalParameters } : {}),
      };
    });

    groups.push({
      name: groupName,
      optional: groupDef.optional,
      variants,
    });
  }

  return groups.length > 0 ? groups : undefined;
}

/** A response placeholder for detecting a strategy from the query parameters alone. */
const UNKNOWN_RESPONSE: TypeRef = { kind: 'primitive', type: 'unknown' };

function buildOperation(
  method: HttpMethod,
  path: string,
  op: OperationObject,
  pathLevelParams: RawParameterObject[],
  pathItemDocs: PathItemDocs,
  pathModelBaseName: string,
  operationIdTransform?: (id: string) => string,
  serviceName?: string,
  componentSchemas?: Record<string, SchemaObject>,
  componentParameters?: Record<string, Record<string, unknown>>,
  componentRequestBodies?: Record<string, Record<string, unknown>>,
  componentExamples?: Record<string, Record<string, unknown>>,
  componentHeaders?: Record<string, Record<string, unknown>>,
  componentResponses?: Record<string, Record<string, unknown>>,
  deferred: DeferredInlineType[] = [],
  apiRootLength = 0,
  servers?: ServerEntry[],
  refSiblingDescriptions: 'override' | 'ignore' = 'override',
  componentResponseModelNames?: ReadonlyMap<string, string>,
  paginationHint?: unknown,
  componentModels?: Model[],
  registry?: ModelShapeRegistry,
): {
  operation: Operation;
  inlineModels: Model[];
  inlineModelBundles: InlineModelBundle[];
  envelopeCompanions?: EnvelopeCompanion[];
  /** What the shape registry records as the owner of this operation's models (see `headerOperationQualifier`). */
  operationQualifier: string;
} {
  const opLabel = operationLabel(op, path, method);
  warnOnIgnoredCallbacks(op.callbacks, opLabel);
  const operationName = inferOperationName(method, path, op.operationId, operationIdTransform, apiRootLength);
  // Resolve a `components/requestBodies` ref up front so body extraction, body
  // parameter groups, and the body-ownership rule below all read one object.
  const requestBodyObject = resolveRequestBodyRef(op.requestBody, componentRequestBodies, opLabel);
  // An operation-level parameter overrides a path-level one with the same
  // identity — `parameterKey`: location and name, a header's name
  // case-folded, so a path-level `X-Pet-Token` and an operation-level
  // `x-pet-token` are one header (#295) — rather than adding a second entry.
  // Operation params come last, so last-write-wins; Map.set keeps the
  // original insertion position, so path-level parameter ordering is
  // preserved.
  const paramsByIdentity = new Map<string, ParameterObject>();
  for (const raw of [...pathLevelParams, ...(op.parameters ?? [])]) {
    const param = resolveParameterRef(raw, componentParameters, opLabel);
    paramsByIdentity.set(parameterKey(param.in, param.name), param);
  }
  const allParams = [...paramsByIdentity.values()];

  const hasIdempotencyHeader = allParams.some((p) => p.in === 'header' && foldHeaderName(p.name) === 'idempotency-key');
  // Reported here, once per parameter the operation types: `extractParams`
  // runs per location, and the passes that re-read a parameter's schema
  // stay silent. The idempotency header is not typed (see `extract` below),
  // so a `content` map on it is not reported.
  for (const param of allParams) {
    if (param.in === 'header' && foldHeaderName(param.name) === 'idempotency-key') continue;
    warnUnreadParameterContent(param, `Parameter "${param.name}" (in: ${param.in}) on ${opLabel}`);
  }

  // A parameter the spec declares both as `in: query` and as a request-body
  // property is one value with two wire locations. On a body-carrying method
  // it travels in the body only: duplicating it into the URL puts body-grade
  // material (OAuth codes, client secrets) into access logs and exception
  // traces, and emitters that surface both copies grow a second public
  // parameter for the same field. RFC 6749 §4.1.3 puts token-request
  // parameters in the body for the same reason. GET/DELETE keep every
  // declared query parameter — they have no body to prefer.
  //
  // One carve-out: a query parameter named by `x-mutually-exclusive-parameter-groups`
  // stays a parameter. The extension models it as one, the group resolver
  // below looks it up in the parameter arrays, and emitters already route
  // groups into the body on body-carrying methods, so nothing reaches the URL.
  const groupedQueryNames = collectParameterGroupMemberNames(op);
  const bodyOwnedNames = new Set<string>();
  if (BODY_CARRYING_METHODS.has(method)) {
    const bodySchema = selectRequestBodyContent(requestBodyObject)?.schema;
    for (const name of collectBodyPropertyNames(bodySchema, componentSchemas)) {
      if (!groupedQueryNames.has(name)) bodyOwnedNames.add(name);
    }
  }
  const wireParams =
    bodyOwnedNames.size > 0 ? allParams.filter((p) => !(p.in === 'query' && bodyOwnedNames.has(p.name))) : allParams;

  // Use the service name as context so inline parameter enums get qualified
  // names. e.g., service "Auth" + param "provider" → "AuthProvider".
  const opContext = serviceName;
  // Names this operation's models in the shape registry, and qualifies a
  // deferred model's name when one of them is taken across operations.
  const operationQualifier = headerOperationQualifier(op, operationName, pathModelBaseName, opContext);
  // What the typing of a parameter, a response header or a secondary,
  // fallback or error body reads from the operation and the spec; a schema
  // deferred through it is typed once every operation has been read
  // (`resolveDeferredInlineTypes`).
  const typing: ResponseTypingContext = {
    componentHeaders,
    componentSchemas,
    componentResponses,
    serviceName: opContext,
    operationQualifier,
    deferred,
    refSiblingDescriptions,
    componentResponseModelNames,
    registry,
  };
  // One location's parameters, typed by `extractParams`. A parameter whose
  // inline schema mints a model is deferred once the responses have been
  // read (`deferParameterModels`, after `extractResponses` below), so the
  // model is created under a name nothing else owns and a response header
  // the operation types keeps the name it has.
  const pendingParams: Array<[raw: ParameterObject[], typed: Parameter[], location: ParameterObject['in']]> = [];
  const extract = (location: ParameterObject['in'], source: ParameterObject[] = wireParams): Parameter[] => {
    const params = extractParams(source, location, opContext, componentSchemas, componentExamples, opLabel);
    pendingParams.push([source.filter((p) => p.in === location), params, location]);
    return params;
  };
  const pathParams = extract('path');
  const queryParams = extract('query');
  // The idempotency header is the SDK's to inject (`injectIdempotencyKey`), not a parameter to type.
  const headerParams = extract(
    'header',
    wireParams.filter((p) => !(p.in === 'header' && foldHeaderName(p.name) === 'idempotency-key')),
  );
  const cookieParams = extract('cookie');
  // Keep the body-owned declarations on the operation so downstream passes
  // (inline-enum collection, the compat surface) still see what the spec
  // declared, even though no emitter serializes them to the URL.
  const bodyOwnedQueryParams =
    bodyOwnedNames.size > 0
      ? extract(
          'query',
          allParams.filter((p) => p.in === 'query' && bodyOwnedNames.has(p.name)),
        )
      : [];

  const reqBodyModels: Model[] = [];
  const {
    body: requestBody,
    encoding: requestBodyEncoding,
    contentType: requestBodyContentType,
    contentTypes: requestBodyContentTypes,
    contents: requestBodyContents,
  } = extractRequestBody(requestBodyObject, op, pathModelBaseName, reqBodyModels, componentSchemas, opLabel, {
    deferred,
    operationQualifier,
    componentSchemas,
  });
  // Read off the resolved body so a `components/requestBodies` ref's flag
  // counts. Only `true` makes the body required: OpenAPI defaults the flag
  // to `false`, and a non-boolean value is not a declaration of requiredness.
  // Set exactly when a body is, so the two fields can be read together.
  const requestBodyRequired = requestBody !== undefined ? requestBodyObject?.required === true : undefined;

  // The page parameter's first value is read from its schema as written —
  // `schema`, else the picked `content` entry's (`parameterTyping`) — so a
  // `default`/`minimum` behind `allOf: [{ $ref }]` or a nullable wrapper —
  // which the IR parameter's own `default` does not carry — still counts.
  const querySchemas = new Map(
    wireParams.filter((p) => p.in === 'query').map((p) => [p.name, parameterSchema(p)] as const),
  );
  const pageStartOf = (param: Parameter | undefined): number =>
    derivePageStart(param, param && querySchemas.get(param.name), componentSchemas);

  // The explicit pagination override — config hint over `x-pagination` — is
  // validated before the response is classified: `strategy: 'none'` must keep
  // a list envelope from being unwrapped into a bare array, and an explicit
  // `dataPath` is resolved against the response while its schema is at hand.
  let paginationOverride = resolvePaginationOverride({ extension: op['x-pagination'], hint: paginationHint }, opLabel);
  const paginationDisabled = paginationOverride?.hint.strategy === 'none';
  // Whether the override can apply is decided here, before the response is
  // read: one that would be rejected (a `param` the operation does not
  // declare, no strategy from anywhere) must not keep an envelope as a
  // wrapper that detection then reads as the list. What it is checked
  // against is the pagination the query parameters alone yield — the
  // envelope fallback's invented `after` never makes an override usable.
  if (paginationOverride && !paginationDisabled) {
    const resolved = resolveOverrideParams(
      detectPagination(UNKNOWN_RESPONSE, queryParams, undefined, { pageStartOf }) ?? undefined,
      paginationOverride.hint,
      queryParams,
    );
    if ('problem' in resolved) {
      console.warn(`[oagen] Warning: ${paginationOverride.source} on ${opLabel}${resolved.problem}`);
      paginationOverride = undefined;
    }
  }
  const {
    response,
    responseHeaders,
    responseContentTypes,
    responseContents,
    responseDescription,
    responseStatusCode,
    successResponses,
    errors,
    defaultResponse,
    rangeResponses,
    inlineModels: responseModels,
    isPaginated,
    dataPath: responseDataPath,
    dataDescription: responseDataDescription,
    itemType: responseItemType,
    envelopeFields,
    endOfIteration: responseEndOfIteration,
    overrideItemType,
    envelopeCompanions,
  } = extractResponses(op.responses, op, pathModelBaseName, path, method, componentSchemas, typing, {
    disabled: paginationDisabled,
    dataPath: paginationDisabled ? undefined : paginationOverride?.hint.dataPath,
    componentModels,
  });
  const inlineModels = [...responseModels, ...reqBodyModels];

  // The parameters' deferred sites follow the responses' in the registry, so
  // a response header the operation typed keeps its name (`PetsXMeta`) and a
  // header parameter of the same name takes the location-qualified one
  // (`PetsHeaderXMeta`), never the reverse.
  for (const [raw, typed, location] of pendingParams) deferParameterModels(raw, typed, location, typing);

  // An explicit `dataPath` that does not reach an array cannot type the
  // iterator's items, so the whole override falls back to detection, as
  // every other unusable override does.
  if (
    paginationOverride &&
    !paginationDisabled &&
    paginationOverride.hint.dataPath !== undefined &&
    !overrideItemType
  ) {
    console.warn(
      `[oagen] Warning: ${paginationOverride.source} on ${opLabel}: dataPath "${paginationOverride.hint.dataPath}" ` +
        'does not resolve to an array in the response — ignoring the override',
    );
    paginationOverride = undefined;
  }

  // Build structured pagination metadata from response classification and
  // query param detection, then let the override correct or disable it.
  const paginationFromParams = detectPagination(response, queryParams, responseDataPath, { pageStartOf });
  let detectedPagination: PaginationMeta | undefined;
  if (isPaginated) {
    const itemType = responseItemType ?? paginatedItemType(response);
    detectedPagination = {
      strategy: paginationFromParams?.strategy ?? 'cursor',
      param: paginationFromParams?.param ?? 'after',
      limitParam: paginationFromParams?.limitParam,
      ...(paginationFromParams?.pageStart !== undefined && { pageStart: paginationFromParams.pageStart }),
      dataPath: responseDataPath ?? paginationFromParams?.dataPath,
      ...(responseDataDescription !== undefined && { dataDescription: responseDataDescription }),
      itemType,
      envelopeFields,
      ...(responseEndOfIteration && { endOfIteration: responseEndOfIteration }),
    };
  } else if (paginationFromParams) {
    // A stop field is also read from an envelope kept as a wrapper under an
    // explicit `dataPath` (see `ResponseClassificationOptions.dataPathOverride`).
    detectedPagination = {
      ...paginationFromParams,
      ...(responseEndOfIteration && { endOfIteration: responseEndOfIteration }),
    };
  }
  const pagination = applyPaginationOverride(detectedPagination, paginationOverride, queryParams, response, opLabel, {
    overrideItemType,
    // Read from the response above, so an override that creates the iterator
    // where detection found none still stops on it.
    endOfIteration: responseEndOfIteration,
    pageStartOf,
  });

  // Per-operation security requirements; undefined means "inherit ApiSpec.security"
  const security = extractSecurityRequirements(op.security, opLabel);
  const tags = extractTags(op.tags);

  // Extract mutually-exclusive parameter groups (query/path/header/cookie)
  const allIRParams = [...pathParams, ...queryParams, ...headerParams, ...cookieParams];
  const queryParamGroups = extractParameterGroups(op, allIRParams, opLabel);

  // Extract mutually-exclusive body parameter groups
  const bodyParamGroups = extractBodyParameterGroups(op, requestBodyObject, opLabel, componentSchemas);

  // Merge both sources into a single parameterGroups array
  const parameterGroups =
    queryParamGroups || bodyParamGroups ? [...(queryParamGroups ?? []), ...(bodyParamGroups ?? [])] : undefined;

  // The operation's own `summary` and `description`, or its Path Item's for
  // each it declares none for (`resolveOperationDocs`). An empty or
  // whitespace-only text counts as absent at either level, so it neither gets
  // its own field nor leaks into the description as a blank first paragraph.
  const { summary, description } = resolveOperationDocs(op, pathItemDocs);

  const operation: Operation = {
    name: operationName,
    // Keep the summary on its own so emitters can tell it apart from the
    // description; the key is omitted (not set to undefined) when absent.
    ...(summary !== undefined ? { summary } : {}),
    description,
    // Same conditional shape as `summary`: present only when the document
    // declares a usable link, absent (not undefined) otherwise.
    ...externalDocsEntry(op.externalDocs),
    httpMethod: method,
    path,
    // Present only when the operation's effective servers differ from the
    // document's (see operationServers); absent, not undefined, otherwise.
    ...(servers && { servers }),
    pathParams,
    queryParams,
    bodyOwnedQueryParams: bodyOwnedQueryParams.length > 0 ? bodyOwnedQueryParams : undefined,
    headerParams,
    cookieParams: cookieParams.length > 0 ? cookieParams : undefined,
    requestBody,
    requestBodyEncoding,
    // The picked media type's essence, what an emitter sends as Content-Type;
    // set exactly when the body is.
    ...(requestBodyContentType && { requestBodyContentType }),
    // Added only when the operation has a body so bodiless operations keep
    // their shape.
    ...(requestBodyRequired !== undefined && { requestBodyRequired }),
    // Every media type the body declares, present only when there is one —
    // the request-side twin of `responseContentTypes` / `responseContents`.
    ...(requestBodyContentTypes && { requestBodyContentTypes, requestBodyContents }),
    response,
    // Added only when present so operations without headers keep their shape.
    ...(responseHeaders && { responseHeaders }),
    ...(responseContentTypes && { responseContentTypes, responseContents }),
    // Likewise only when the primary response declares a description.
    ...(responseDescription && { responseDescription }),
    // And only when a 2xx or 3xx response is declared at all, so the status
    // code is present exactly when `response` was read from one.
    ...(responseStatusCode !== undefined && { responseStatusCode }),
    successResponses,
    errors,
    // Added only when the document declares them so operations without
    // fallback responses keep their shape.
    ...(defaultResponse && { defaultResponse }),
    ...(rangeResponses && { rangeResponses }),
    pagination,
    injectIdempotencyKey: hasIdempotencyHeader,
    deprecated: op.deprecated === true || undefined,
    async: op['x-oagen-async'],
    security,
    parameterGroups,
    // Present only when the document declares at least one usable tag, as on
    // a webhook; absent, not undefined, otherwise.
    ...(tags && { tags }),
  };

  // Where the models came from, so a merge pass that must rename one — a
  // deprecated response named like a live one, say — can qualify it by this
  // operation and repoint only this operation's references: the response
  // bundle owns the success bodies, the list envelope and the response
  // headers; the request bundle owns the body. Qualified as a header model or
  // list-envelope companion is (`GetLegacyWidgetWidget`).
  const qualifier = toPascalCase(operationName);
  const inlineModelBundles: InlineModelBundle[] = [];
  if (responseModels.length > 0) {
    inlineModelBundles.push({ qualifier, roots: responseTypeRefs(operation), models: responseModels });
  }
  if (reqBodyModels.length > 0 && requestBody) {
    inlineModelBundles.push({ qualifier, roots: [requestBody], models: reqBodyModels, sent: true });
  }

  return { operation, inlineModels, inlineModelBundles, envelopeCompanions, operationQualifier };
}

/**
 * The type references an operation's responses own: the primary and every
 * alternate success body, the list envelope's fields and item type, and
 * every response header. Error bodies are left out: a `$ref` body names a
 * component, which a rename never touches, and an inline one is typed
 * through the deferred registry, where it is a site of its own
 * (`resolveDeferredInlineTypes`), so a rename reaches it from there.
 */
function responseTypeRefs(op: Operation): TypeRef[] {
  return [
    op.response,
    ...(op.successResponses ?? []).map((r) => r.type),
    ...(op.pagination?.envelopeFields ?? []).map((f) => f.type),
    ...(op.pagination ? [op.pagination.itemType] : []),
    ...collectResponseHeaders(op).map((h) => h.type),
  ];
}

/**
 * The qualifier that tells one operation's header models from another's
 * (`deferredNamingStem`'s `byOperationName` candidate), and that the shape
 * registry records as the owner of its models. An `operationId` names the
 * operation. A path-named operation uses the path-derived stem its request
 * and response models are built from, so the model name depends only on the
 * method and path and never on the derived operation name — a verb or
 * singular change in inferOperationName must not rename a generated type.
 * The stem's leading service word is dropped when it ends on a word boundary,
 * since the model name already starts with the service:
 * `Notes` + `ByIdPinPost` + `XMeta`, beside `NotesByIdPinPostResponse`.
 */
function headerOperationQualifier(
  op: OperationObject,
  operationName: string,
  pathModelBaseName: string,
  serviceName: string | undefined,
): string {
  if (op.operationId) return toPascalCase(operationName);
  const parent = serviceName ? toPascalCase(serviceName) : '';
  const rest = pathModelBaseName.slice(parent.length);
  return parent && pathModelBaseName.startsWith(parent) && /^[A-Z0-9]/.test(rest) ? rest : pathModelBaseName;
}

/** The Path Item fields an operation's doc text is read against (see `resolveOperationDocs`). */
export type PathItemDocs = Pick<PathItem, 'summary' | 'description'>;

/** An operation's doc text as the IR carries it, under the names `Operation` and `Webhook` share. */
export interface OperationDocs {
  /** The resolved `summary` alone; `undefined` when neither level has one with content. */
  summary: string | undefined;
  /** The combined form `buildDescription` makes of the two resolved texts; `undefined` when neither has content. */
  description: string | undefined;
}

/**
 * The `summary` and `description` of an operation — an SDK operation's or a
 * webhook's — read from the Operation Object and, for each field it declares
 * no content for, from the Path Item it sits on: OpenAPI defines a Path
 * Item's `summary` and `description` as applying to every operation on it.
 * The two fields fall back one by one, so an operation with a `summary` of
 * its own and no `description` shows its own `summary` over the Path Item's
 * `description`. Text with content wins at either level; a value that is not
 * a string, or is blank, counts as absent at either level (`presentText`), so
 * `summary: ""` on the operation still takes the Path Item's. Either field is
 * `undefined` when
 * neither level gives it; the caller decides whether the key is then omitted
 * (`Webhook`) or present (`Operation.description`).
 */
export function resolveOperationDocs(op: OperationObject, pathItem: PathItemDocs): OperationDocs {
  const summary = presentText(op.summary) ?? presentText(pathItem.summary);
  const description = presentText(op.description) ?? presentText(pathItem.description);
  return { summary, description: buildDescription(summary, description) };
}

/**
 * Combine an operation's `summary` and `description` into one doc text.
 * Empty or whitespace-only text counts as absent, so `summary: "List pets"`
 * with `description: ""` yields `"List pets"` rather than `""`. Text that has
 * content is kept verbatim, surrounding whitespace included.
 */
export function buildDescription(summary: string | undefined, description: string | undefined): string | undefined {
  const presentSummary = presentText(summary);
  const presentDescription = presentText(description);
  if (presentSummary && presentDescription && presentSummary !== presentDescription) {
    return `${presentSummary}\n\n${presentDescription}`;
  }
  return presentDescription ?? presentSummary;
}

/** The text itself when it has non-whitespace content, otherwise `undefined`. */
export function presentText(text: string | undefined): string | undefined {
  return typeof text === 'string' && text.trim() !== '' ? text : undefined;
}

/**
 * An operation's `tags` as the IR carries them, on an `Operation` and on a
 * `Webhook` alike: the list in document order with every entry that is not a
 * non-empty string dropped and a repeated entry folded onto its first
 * occurrence, or `undefined` when nothing remains (or the keyword is not a
 * list), so the key is omitted rather than set to `[]`. The service an
 * operation is grouped under is named from `[0]` of this same list.
 */
export function extractTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const kept: string[] = [];
  for (const tag of tags) {
    if (typeof tag === 'string' && tag !== '' && !kept.includes(tag)) kept.push(tag);
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * The media types a parameter's or response header's `content` map is read
 * from, in the order the pick tries them (`selectParameterContent`). Each is
 * matched by essence — `type/subtype` with parameters stripped and case
 * folded (`mediaTypeEssence`), so `application/json; charset=utf-8` and
 * `APPLICATION/JSON` read as `application/json` — and a `+json` media type
 * is JSON. A JSON entry is read only when it declares a schema; a
 * `text/plain` entry is read with or without one, a text value the document
 * does not describe being a string. Any other media type is not read.
 */
const PARAMETER_CONTENT_MEDIA_TYPES: ReadonlyArray<{
  matches: (essence: string) => boolean;
  schemaRequired: boolean;
}> = [
  { matches: (essence) => essence === 'application/json', schemaRequired: true },
  { matches: (essence) => essence.endsWith('+json'), schemaRequired: true },
  { matches: (essence) => essence === 'text/plain', schemaRequired: false },
];

/** The `content` entry a parameter or response header is read from: the key as written and its Media Type Object. */
export interface SelectedParameterContent {
  /** The `content` key the entry was read from, exactly as written (`application/json; charset=utf-8`). */
  contentType: string;
  media: ParameterMediaTypeObject;
}

/**
 * Pick the `content` entry a parameter or response header is typed from, by
 * media type essence in the fixed order of `PARAMETER_CONTENT_MEDIA_TYPES`:
 * `application/json`, then a `+json` media type — each only with a schema —
 * then `text/plain`. Within one tier the first matching key in document
 * order wins. OAS allows the map one entry, so the order decides only for a
 * document that declares more. `undefined` when there is no map, or none of
 * its media types is read; `warnUnreadParameterContent` reports the latter.
 */
export function selectParameterContent(
  content: Record<string, ParameterMediaTypeObject> | undefined,
): SelectedParameterContent | undefined {
  if (!content) return undefined;
  const entries = Object.entries(content);
  for (const { matches, schemaRequired } of PARAMETER_CONTENT_MEDIA_TYPES) {
    const match = entries.find(
      ([contentType, media]) => matches(mediaTypeEssence(contentType)) && (!schemaRequired || media?.schema),
    );
    if (match) return { contentType: match[0], media: match[1] ?? {} };
  }
  return undefined;
}

/** What types a parameter or response header: its schema, and the Media Type Object the schema was read from under `content`. */
export interface ParameterTyping {
  /** Absent when the declaration types nothing: the value is a string. */
  schema?: SchemaObject;
  /** The picked `content` entry, only when the declaration has no `schema` and the map is read. */
  media?: ParameterMediaTypeObject;
  /** The `content` key `media` sits under, as written; set exactly when `media` is. */
  contentType?: string;
}

/**
 * The schema that types a parameter or response header: the declaration's
 * `schema` when it has one, else the schema of the `content` entry
 * `selectParameterContent` picks, with that entry's Media Type Object
 * beside it for the examples it may carry. `schema` is absent — and the
 * value a string — when the declaration has neither, when the picked
 * `text/plain` entry declares no schema, or when nothing in the map is read.
 * A `schema` beside a `content` map wins and the map is not consulted.
 * Every pass that asks what a parameter's schema is reads it through this
 * one resolution: the typing (`extractParams`), the model deferral
 * (`deferParameterModels`), the page-start read, a webhook's parameter mint
 * and a response header's typing (`extractResponseHeaders`) — so a
 * parameter declared either way is typed, and mints, by one rule.
 */
export function parameterTyping(declaration: SchemaOrContent): ParameterTyping {
  if (declaration.schema) return { schema: declaration.schema };
  const picked = selectParameterContent(declaration.content);
  return picked ? { schema: picked.media.schema, media: picked.media, contentType: picked.contentType } : {};
}

/** The schema `parameterTyping` resolves, alone. */
export function parameterSchema(declaration: SchemaOrContent): SchemaObject | undefined {
  return parameterTyping(declaration).schema;
}

/**
 * Warn that a parameter's or response header's `content` map is not read:
 * it declares no `schema`, at least one media type, and
 * `selectParameterContent` picks none, so the value is typed as a string.
 * Called once per site — for each operation parameter where the operation's
 * parameters are resolved (`buildOperation`), for each webhook parameter
 * where the webhook's entry is built (the mint itself runs twice), and for
 * each response header as it is typed — while `extractParams` and the
 * passes that re-read the schema stay silent. An empty map declares nothing
 * and is not reported; a map beside a `schema` is not consulted and not
 * reported either.
 */
export function warnUnreadParameterContent(declaration: SchemaOrContent, subject: string): void {
  if (declaration.schema) return;
  const declared = Object.keys(declaration.content ?? {});
  if (declared.length === 0 || selectParameterContent(declaration.content)) return;
  console.warn(
    `[oagen] Warning: ${subject} is typed as a string: none of its content media types (${declared.join(', ')}) ` +
      `is read. A parameter or response header declared with content is read from application/json or a +json ` +
      `media type when the entry declares a schema, and from text/plain with or without one, parameters and ` +
      `case aside.`,
  );
}

export function extractParams(
  params: ParameterObject[],
  location: 'path' | 'query' | 'header' | 'cookie',
  operationContext?: string,
  componentSchemas?: Record<string, SchemaObject>,
  componentExamples?: Record<string, Record<string, unknown>>,
  opLabel?: string,
): Parameter[] {
  return params
    .filter((p) => p.in === location)
    .map((p) => {
      // The schema that types the parameter — `schema`, else the picked
      // `content` entry's (`parameterTyping`) — and that entry's Media Type
      // Object for the examples it may carry. Every read below goes through
      // `schema`, so a parameter declared either way is typed by one rule.
      const { schema, media, contentType } = parameterTyping(p);
      const refTarget = resolveComponentSchemaRef(schema, componentSchemas);
      const exampleContext = `parameter "${p.name}" in ${opLabel ?? location}`;
      // Each level is resolved on its own — the parameter's declaration, the
      // Media Type Object its schema was read from (when it was), the schema,
      // then the component the schema refs — so a schema-level `example`
      // can't mask the parameter's own `examples` map, and an explicit `null`
      // at any level is kept rather than fallen through.
      const { example, examples } = resolveExamples([
        { example: p.example, examples: exampleObjectValues(p.examples, componentExamples, exampleContext) },
        ...(media
          ? [
              {
                example: media.example,
                examples: exampleObjectValues(media.examples, componentExamples, exampleContext),
              },
            ]
          : []),
        { example: schema?.example, examples: nonEmptyExamples(schema?.examples) },
        { example: refTarget?.example, examples: nonEmptyExamples(refTarget?.examples) },
      ]);
      // Like default/example, fall back per value: the `$ref` target's keywords
      // sit under the parameter's own, so `{ $ref: Limit, minimum: 5 }` narrows
      // one bound without discarding the target's others. The alias also becomes
      // a fieldless model, but a parameter should be readable on its own.
      const own = schema ? extractConstraints(schema) : undefined;
      const inherited = refTarget ? extractConstraints(refTarget) : undefined;
      const constraints = own && inherited ? { ...inherited, ...own } : (own ?? inherited);
      // The schema's link, else the `$ref` target's — the same fallback chain
      // `description` and `deprecated` follow, with an unusable entry at one
      // level falling through to the next as an empty description does. A
      // Parameter Object declares no `externalDocs` of its own.
      const externalDocs = readExternalDocs(schema?.externalDocs) ?? readExternalDocs(refTarget?.externalDocs);
      return {
        name: p.name,
        // Typed under the name the parameter is compared by (`foldParameterName`:
        // a header's lower-cased), so the inline enum or model its schema mints
        // keeps its name when the header's case changes (#295); `name` above
        // stays as written.
        type: schema
          ? schemaToTypeRef(
              schema,
              foldParameterName(p.in, p.name),
              operationContext ? toPascalCase(operationContext) : undefined,
            )
          : ({ kind: 'primitive', type: 'string' } as TypeRef),
        required: p.required ?? false,
        description: firstDescription(p.description, schema?.description, refTarget?.description),
        deprecated: p.deprecated === true || schema?.deprecated === true || refTarget?.deprecated === true || undefined,
        ...(externalDocs ? { externalDocs } : {}),
        default: schema?.default ?? refTarget?.default,
        example,
        ...(examples ? { examples } : {}),
        style: p.style as Parameter['style'],
        explode: p.explode,
        // The media type the value is serialized in, for a parameter read
        // from `content`; a `schema` parameter is serialized by style/explode.
        ...(contentType !== undefined ? { contentType } : {}),
        ...(constraints ? { constraints } : {}),
      };
    });
}

/**
 * First non-empty description in precedence order. A parameter that declares
 * `description: ""` is treated as undocumented so its schema's text still
 * surfaces, and the result is `undefined` rather than `""` when nothing in
 * the chain is documented.
 */
function firstDescription(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0);
}

/**
 * Flatten a parameter's `examples` map of Example Objects to the inline
 * values it carries, in document order. A `$ref` entry is resolved against
 * `components.examples` first (see `resolveExampleRef`). Entries that point
 * elsewhere (`externalValue`) or have no `value` are skipped; `null` is a
 * legitimate value and kept. Returns undefined when nothing remains so the
 * caller can fall through to the schema's `examples`.
 */
function exampleObjectValues(
  examples: Record<string, ExampleObject> | undefined,
  componentExamples: Record<string, Record<string, unknown>> | undefined,
  context: string,
): unknown[] | undefined {
  if (!examples || typeof examples !== 'object' || Array.isArray(examples)) return undefined;
  const values: unknown[] = [];
  for (const raw of Object.values(examples)) {
    const entry = resolveExampleRef(raw, componentExamples, context);
    if (!entry || typeof entry !== 'object') continue;
    if (entry.externalValue !== undefined || entry.value === undefined) continue;
    values.push(entry.value);
  }
  return values.length > 0 ? values : undefined;
}

/**
 * Follow an Example Object's `$ref` into `components.examples`, including a
 * component that is itself a `$ref`, with a cycle guard. The bundler keeps
 * refs (`dereference: false`), so without this every `$ref` entry would be
 * dropped and a map made only of refs would silently yield nothing — the
 * parameter would then take its `examples` from the schema instead of the
 * values the document points at. A ref that can't be resolved is skipped
 * with a warning rather than failing the parse: a missing example is a doc
 * gap, not a broken API surface.
 */
function resolveExampleRef(
  raw: ExampleObject | undefined,
  componentExamples: Record<string, Record<string, unknown>> | undefined,
  context: string,
): ExampleObject | undefined {
  const seenRefs = new Set<string>();
  let current = raw;
  while (current && typeof current === 'object' && current.$ref !== undefined) {
    const ref = current.$ref;
    if (seenRefs.has(ref)) {
      console.warn(`[oagen] Warning: Circular example $ref chain starting at "${ref}" on ${context}; skipping`);
      return undefined;
    }
    seenRefs.add(ref);
    const match = /^#\/components\/examples\/(.+)$/.exec(ref);
    // JSON Pointer escapes (RFC 6901 §4): `~1` -> `/`, then `~0` -> `~`, in that order.
    const refName = match?.[1].replace(/~1/g, '/').replace(/~0/g, '~');
    const resolved = refName ? componentExamples?.[refName] : undefined;
    if (!resolved) {
      console.warn(`[oagen] Warning: Unresolved example $ref "${ref}" on ${context}; skipping`);
      return undefined;
    }
    current = resolved as ExampleObject;
  }
  return current;
}

/**
 * Collect the property schemas of every `oneOf` branch reachable from a request
 * body schema, keyed by property name. These are the candidate members of a
 * mutually-exclusive body group.
 *
 * The bundler runs with `dereference: false`, so the body schema is very often
 * a bare `{ $ref: '#/components/schemas/XDto' }` and the `allOf`/`oneOf`
 * composition that actually declares the variant properties lives on the
 * component. Walking without resolving refs finds nothing, and every group
 * member then falls back to `string` — an SDK that compiles but types
 * object-valued members (e.g. a connection's `saml_options`) as plain strings.
 *
 * Composition keywords nest and may themselves be refs, so resolve and recurse
 * at each level. `seen` guards against a schema that (directly or transitively)
 * refs itself.
 */
function collectVariantFieldSchemas(
  schema: SchemaObject | undefined,
  componentSchemas: Record<string, SchemaObject> | undefined,
  owner: string | undefined = undefined,
  out: Map<string, VariantFieldSchema> = new Map(),
  seen: Set<string> = new Set(),
): Map<string, VariantFieldSchema> {
  if (!schema) return out;

  const ref = (schema as { $ref?: string }).$ref;
  if (ref) {
    if (seen.has(ref)) return out;
    seen.add(ref);
    const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
    const target = match && componentSchemas ? componentSchemas[match[1]] : undefined;
    // Descending into a component makes it the owner of everything below, so
    // inline members get the same synthesized names the model emitter gives
    // them (`CreateUser` + `password_hash_type` -> CreateUserPasswordHashType).
    const nextOwner = match ? resolveSchemaName(match[1]) : owner;
    return collectVariantFieldSchemas(target, componentSchemas, nextOwner, out, seen);
  }

  // A `oneOf` branch is the group-variant carrier: its properties are the
  // members. Record them, then keep descending — branches nest in real specs.
  for (const variant of schema.oneOf ?? []) {
    const variantRef = (variant as { $ref?: string }).$ref;
    const refMatch = variantRef ? /^#\/components\/schemas\/(.+)$/.exec(variantRef) : null;
    const resolved = resolveSchemaRefObject(variant, componentSchemas) ?? variant;
    const variantOwner = refMatch ? resolveSchemaName(refMatch[1]) : owner;
    for (const [name, fieldSchema] of Object.entries(resolved.properties ?? {})) {
      if (fieldSchema) out.set(name, { schema: fieldSchema, owner: variantOwner });
    }
    collectVariantFieldSchemas(variant, componentSchemas, owner, out, seen);
  }

  for (const sub of schema.allOf ?? []) collectVariantFieldSchemas(sub, componentSchemas, owner, out, seen);
  for (const sub of schema.anyOf ?? []) collectVariantFieldSchemas(sub, componentSchemas, owner, out, seen);

  return out;
}

/** A group member's schema plus the component that owns it, for inline naming. */
interface VariantFieldSchema {
  schema: SchemaObject;
  owner: string | undefined;
}

/** Resolve `{ $ref: '#/components/schemas/X' }` to its component, else undefined. */
function resolveSchemaRefObject(
  schema: SchemaObject | undefined,
  componentSchemas: Record<string, SchemaObject> | undefined,
): SchemaObject | undefined {
  if (!schema || !componentSchemas) return undefined;
  const ref = (schema as { $ref?: string }).$ref;
  if (!ref) return undefined;
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!match) return undefined;
  return componentSchemas[match[1]];
}

export type RequestBodyEncoding = 'json' | 'form-data' | 'form-urlencoded' | 'binary' | 'text';

/** HTTP methods whose request body is the primary parameter carrier. */
const BODY_CARRYING_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['post', 'put', 'patch']);

/**
 * The media types a request body is read from, in the order the pick tries
 * them (`selectRequestBodyContent`). Each is matched by essence — `type/subtype`
 * with parameters stripped and case folded (`mediaTypeEssence`), so
 * `application/json; charset=utf-8`, `APPLICATION/JSON` and
 * `multipart/form-data; boundary=x` read as their bare types — and a `+json`
 * media type (`application/vnd.api+json`, `application/merge-patch+json`) is
 * JSON. A JSON or form body is read only when it declares a schema, so an
 * `application/json` entry without one yields to a later media type that has
 * one; a binary or text body may legitimately declare none.
 */
const REQUEST_BODY_MEDIA_TYPES: ReadonlyArray<{
  matches: (essence: string) => boolean;
  encoding: RequestBodyEncoding;
  schemaRequired: boolean;
}> = [
  // The one JSON rule requests and responses share (`isJsonMediaType`), in
  // the order `jsonResponseSchema` applies it: `application/json` itself
  // first, then any `+json` type.
  { matches: isPlainJsonMediaType, encoding: 'json', schemaRequired: true },
  {
    matches: (essence) => isJsonMediaType(essence) && !isPlainJsonMediaType(essence),
    encoding: 'json',
    schemaRequired: true,
  },
  { matches: (essence) => essence === 'multipart/form-data', encoding: 'form-data', schemaRequired: true },
  {
    matches: (essence) => essence === 'application/x-www-form-urlencoded',
    encoding: 'form-urlencoded',
    schemaRequired: true,
  },
  { matches: (essence) => essence === 'application/octet-stream', encoding: 'binary', schemaRequired: false },
  { matches: (essence) => essence === 'text/plain', encoding: 'text', schemaRequired: false },
];

/** The wire encoding a media type implies by essence (`REQUEST_BODY_MEDIA_TYPES`); `undefined` for one the pick never reads. */
function requestBodyEncodingOf(contentType: string): RequestBodyEncoding | undefined {
  const essence = mediaTypeEssence(contentType);
  return REQUEST_BODY_MEDIA_TYPES.find(({ matches }) => matches(essence))?.encoding;
}

/**
 * The type of a request content entry that declares no schema, by media type
 * essence: a binary string for `application/octet-stream`, a string for
 * `text/plain` (`schemalessRequestBodyType`), and `unknown` for anything
 * else — a JSON or form media type included, since the pick reads those only
 * with a schema. How a secondary entry of `requestBodyContents` is typed, on
 * an operation and on a webhook alike.
 */
export function schemalessRequestContentType(contentType: string): TypeRef {
  const encoding = requestBodyEncodingOf(contentType);
  return (encoding && schemalessRequestBodyType(encoding)) ?? { kind: 'primitive', type: 'unknown' };
}

/** The content entry a request body is read from: the key as written, its essence, its wire encoding and its schema. */
export interface SelectedRequestBodyContent {
  /** The `content` key the body was read from, exactly as written (`application/json; charset=utf-8`). */
  contentType: string;
  /** The essence of `contentType` (`application/json`): what an emitter sends as the `Content-Type` (`Operation.requestBodyContentType`). */
  essence: string;
  encoding: RequestBodyEncoding;
  /** Absent only for a binary or text body that declares none. */
  schema?: SchemaObject;
}

/**
 * Pick the content entry a request body is read from, by media type essence
 * in the fixed order of `REQUEST_BODY_MEDIA_TYPES`: `application/json`, then
 * a `+json` media type, then `multipart/form-data`, then
 * `application/x-www-form-urlencoded` — each only with a schema — then
 * `application/octet-stream`, then `text/plain`. Within one tier the first
 * matching key in document order wins. `undefined` when the body declares no
 * content, or none of its media types is read; `warnUnreadRequestBody`
 * reports the latter. Every pass that asks what the body is — the body
 * extractor, the body-owned query names, the const prefixes, the body
 * parameter groups, a webhook payload — reads it through this one pick.
 */
export function selectRequestBodyContent(body: RequestBodyObject | undefined): SelectedRequestBodyContent | undefined {
  const content = body?.content;
  if (!content) return undefined;
  const entries = Object.entries(content);
  for (const { matches, encoding, schemaRequired } of REQUEST_BODY_MEDIA_TYPES) {
    const match = entries.find(
      ([contentType, media]) => matches(mediaTypeEssence(contentType)) && (!schemaRequired || media?.schema),
    );
    if (match) {
      return { contentType: match[0], essence: mediaTypeEssence(match[0]), encoding, schema: match[1]?.schema };
    }
  }
  return undefined;
}

/**
 * Warn that a request body is not read as `requestBody`: it declares at
 * least one media type and `selectRequestBodyContent` reads none, so
 * `requestBody` and `requestBodyEncoding` stay unset and the body reaches an
 * emitter through `requestBodyContents` alone. Called once per operation
 * (`extractRequestBody`) and once per webhook (where its entry is built: a
 * webhook is minted twice, so the mint itself must not report), while the
 * passes that re-read the pick for an operation (the body-owned query names,
 * the const prefixes, the body parameter groups) stay silent — so such a
 * body is reported once, and never silently. A body with no `content`, or an
 * empty map, declares nothing and is not reported.
 */
export function warnUnreadRequestBody(body: RequestBodyObject | undefined, label: string): void {
  const declared = Object.keys(body?.content ?? {});
  if (declared.length === 0 || selectRequestBodyContent(body)) return;
  console.warn(
    `[oagen] Warning: Request body of ${label} is not read as requestBody: none of its media types ` +
      `(${declared.join(', ')}) is one the parser reads — application/json or a +json media type, ` +
      `multipart/form-data or application/x-www-form-urlencoded with a schema, application/octet-stream or ` +
      `text/plain with or without one, parameters and case aside. It is carried in requestBodyContents only.`,
  );
}

/**
 * The type of a picked request body that declares no schema: a binary body is
 * a binary string, a text body a string. A JSON or form body is picked only
 * with a schema (`REQUEST_BODY_MEDIA_TYPES`), so for those encodings this is
 * never reached and returns `undefined`.
 */
export function schemalessRequestBodyType(encoding: RequestBodyEncoding): TypeRef | undefined {
  if (encoding === 'binary') return { kind: 'primitive', type: 'string', format: 'binary' };
  if (encoding === 'text') return { kind: 'primitive', type: 'string' };
  return undefined;
}

/** Parameter names referenced by any `x-mutually-exclusive-parameter-groups` variant. */
function collectParameterGroupMemberNames(op: OperationObject): Set<string> {
  const names = new Set<string>();
  const raw = op['x-mutually-exclusive-parameter-groups'];
  if (!raw || typeof raw !== 'object') return names;
  // Malformed shapes are left for extractParameterGroups to report.
  for (const groupDef of Object.values(raw)) {
    const variants = groupDef && typeof groupDef === 'object' ? groupDef.variants : undefined;
    if (!variants || typeof variants !== 'object') continue;
    for (const members of Object.values(variants)) {
      if (!Array.isArray(members)) continue;
      for (const member of members) if (typeof member === 'string') names.add(member);
    }
  }
  return names;
}

/**
 * Every property name a request body is guaranteed to accept, following
 * `$ref`s and descending through composition. `allOf` members all apply, so
 * their properties union. `oneOf` / `anyOf` alternatives are choices, so only
 * a property every non-null alternative declares counts — otherwise a caller
 * on another branch would have no slot for the value in either the body or
 * the query. Used to decide which `in: query` declarations are body-owned.
 */
function collectBodyPropertyNames(
  schema: SchemaObject | undefined,
  componentSchemas: Record<string, SchemaObject> | undefined,
  seen: ReadonlySet<string> = new Set(),
): Set<string> {
  if (!schema) return new Set();

  const ref = (schema as { $ref?: string }).$ref;
  if (ref) {
    // Cycle guard is per path: the same component may legitimately appear in
    // sibling branches and must count for each of them.
    if (seen.has(ref)) return new Set();
    return collectBodyPropertyNames(
      resolveSchemaRefObject(schema, componentSchemas),
      componentSchemas,
      new Set([...seen, ref]),
    );
  }

  const names = new Set(Object.keys(schema.properties ?? {}));
  for (const sub of schema.allOf ?? []) {
    for (const name of collectBodyPropertyNames(sub, componentSchemas, seen)) names.add(name);
  }
  for (const alternatives of [schema.oneOf, schema.anyOf]) {
    const branches = (alternatives ?? []).filter((alt) => alt.type !== 'null');
    if (branches.length === 0) continue;
    let common: Set<string> | undefined;
    for (const branch of branches) {
      const branchNames = collectBodyPropertyNames(branch, componentSchemas, seen);
      common = common ? new Set([...common].filter((name) => branchNames.has(name))) : branchNames;
    }
    for (const name of common ?? []) names.add(name);
  }
  return names;
}

/** What request body typing needs beyond the body: where deferred schemas go and how their names are qualified. */
interface RequestTypingContext {
  /** Collects every secondary-body schema, named after the operations loop (`resolveDeferredInlineTypes`). */
  deferred: DeferredInlineType[];
  /** Qualifies a name taken across operations (see `headerOperationQualifier`). */
  operationQualifier: string;
  /** Lets inline models resolve `$ref` siblings and augmentations the way fields do. */
  componentSchemas?: Record<string, SchemaObject>;
}

/** The request body an operation carries: the picked entry typed, and every declared media type with its type. */
interface ExtractedRequestBody {
  body?: TypeRef;
  encoding?: RequestBodyEncoding;
  /** The picked entry's essence (`Operation.requestBodyContentType`); set exactly when `body` is. */
  contentType?: string;
  contentTypes?: string[];
  contents?: RequestBodyContent[];
}

/**
 * The name an operation's inline request body is materialized under:
 * `<Op>Request` from the `operationId` (`operationIdModelName`), else the
 * path-derived prefix plus `Request` (see derivePathModelBaseName) so two
 * operations without an `operationId` never share one inline body model —
 * every operationId-less body used to be `RequestBody`, and only the largest
 * survived deduplication, leaving every other operation pointing at a model
 * with someone else's fields.
 */
function requestModelName(op: OperationObject | undefined, pathModelBaseName: string): string {
  return op?.operationId ? operationIdModelName(op.operationId, 'Request') : pathModelBaseName + 'Request';
}

/**
 * The stem a secondary request body's model is named from: the primary
 * body's name without its `Request` suffix, followed by the media type and
 * `Request` — `ReplaceWidgetTextCsvRequest` beside `ReplaceWidgetRequest` —
 * the way a secondary response body's stem is the primary response's name
 * without `Response`.
 */
function requestModelStem(op: OperationObject | undefined, pathModelBaseName: string): string {
  return requestModelName(op, pathModelBaseName).replace(/Request$/, '');
}

/**
 * Read an operation's request body: the content entry the pick chooses
 * (`selectRequestBodyContent`) typed as `body` with its `encoding`, and every
 * media type the body declares as `contentTypes` / `contents`, the picked
 * entry sharing `body`'s TypeRef (`extractRequestBodyContents`). A body none
 * of whose media types is read is reported once and carried in `contents`
 * alone.
 */
function extractRequestBody(
  body: RequestBodyObject | undefined,
  op: OperationObject | undefined,
  pathModelBaseName: string,
  inlineModels: Model[],
  componentSchemas: Record<string, SchemaObject> | undefined,
  opLabel: string,
  ctx: RequestTypingContext,
): ExtractedRequestBody {
  const selected = selectRequestBodyContent(body);
  if (!selected) warnUnreadRequestBody(body, opLabel);
  const primary = selected ? typeRequestBody(selected, op, pathModelBaseName, inlineModels, componentSchemas) : {};
  const contents = extractRequestBodyContents(
    body?.content,
    selected?.contentType,
    primary.body,
    requestModelStem(op, pathModelBaseName),
    ctx,
  );
  return { ...primary, ...contents };
}

/**
 * Read a request body's `content` map into the media types it declares — in
 * document order and verbatim, parameters and vendor suffixes included — with
 * a type for each, as `extractResponseContents` reads a response's. The entry
 * for `primaryContentType` (the one the pick read `primaryType` from) carries
 * that very TypeRef; every other entry goes through
 * `typeSecondaryRequestContent`. `undefined` when the body declares no media
 * type at all, so the caller leaves both keys off.
 */
function extractRequestBodyContents(
  content: Record<string, { schema?: SchemaObject }> | undefined,
  primaryContentType: string | undefined,
  primaryType: TypeRef | undefined,
  stem: string,
  ctx: RequestTypingContext,
): { contentTypes: string[]; contents: RequestBodyContent[] } | undefined {
  if (!content) return undefined;
  const contentTypes = Object.keys(content);
  if (contentTypes.length === 0) return undefined;
  const contents = contentTypes.map((contentType) => {
    const entry: RequestBodyContent = { contentType, type: { kind: 'primitive', type: 'unknown' } };
    entry.type =
      primaryType !== undefined && contentType === primaryContentType
        ? primaryType
        : typeSecondaryRequestContent(contentType, content[contentType]?.schema, stem, ctx, entry, contentTypes);
    return entry;
  });
  return { contentTypes, contents };
}

/**
 * Type a media type the request body pick did not choose, as it would be
 * typed were it the only one declared: from its schema when it has one — an
 * inline object materialized as `<Op><MediaType>Request`
 * (`ReplaceWidgetTextCsvRequest`), named once every primary model is known
 * (`resolveDeferredInlineTypes`), so the schema is deferred and the
 * placeholder returned here is filled in then — else as
 * `schemalessRequestContentType` types it. The media type's fragment is
 * decided among its `siblings`, the body's content keys
 * (`mediaTypeNameFragment`): two spellings of one media type declared side
 * by side take separate names by their parameters, and case-only spellings
 * that derive one name are told apart by the registry.
 */
function typeSecondaryRequestContent(
  contentType: string,
  schema: SchemaObject | undefined,
  stem: string,
  ctx: RequestTypingContext,
  target: RequestBodyContent,
  siblings: readonly string[],
): TypeRef {
  if (!schema) return schemalessRequestContentType(contentType);
  ctx.deferred.push({
    kind: 'request',
    schema,
    name: `${stem}${mediaTypeNameFragment(contentType, siblings)}Request`,
    operationQualifier: ctx.operationQualifier,
    componentSchemas: ctx.componentSchemas,
    targets: [target],
  });
  return target.type;
}

/**
 * The picked content entry typed as `Operation.requestBody`, with its
 * encoding and its essence (`Operation.requestBodyContentType`), and its
 * inline models pushed to `inlineModels`.
 */
function typeRequestBody(
  selected: SelectedRequestBodyContent,
  op: OperationObject | undefined,
  pathModelBaseName: string,
  inlineModels: Model[],
  componentSchemas: Record<string, SchemaObject> | undefined,
): { body?: TypeRef; encoding?: RequestBodyEncoding; contentType?: string } {
  const typed = typePickedRequestBody(selected, op, pathModelBaseName, inlineModels, componentSchemas);
  return typed ? { body: typed, encoding: selected.encoding, contentType: selected.essence } : {};
}

/** The picked content entry's type: a primitive for a schema-less binary or text body, else typed from its schema. */
function typePickedRequestBody(
  selected: SelectedRequestBodyContent,
  op: OperationObject | undefined,
  pathModelBaseName: string,
  inlineModels: Model[],
  componentSchemas: Record<string, SchemaObject> | undefined,
): TypeRef | undefined {
  let schema = selected.schema;

  // Only a binary or text pick comes without a schema; it is a primitive.
  if (!schema) return schemalessRequestBodyType(selected.encoding);

  const contextName = requestModelName(op, pathModelBaseName);

  // `properties` written beside a typing `allOf`/`oneOf`/`anyOf` are folded
  // into the composition, as `schemaToTypeRef` and the field extractor read
  // them (`foldSiblingProperties`), so the body is read the one way a field
  // of the same schema is: the object branch below reads `properties` first
  // and would otherwise drop the composition. The variants that cannot take
  // the properties are reported on the body as written, under the body's
  // name, since the fold leaves `schemaToTypeRef` nothing to report.
  warnOnUncarriedProperties(schema, contextName, undefined);
  schema = foldSiblingProperties(schema);

  // A discriminated-union request body (`oneOf` + an explicit `discriminator`)
  // compiles to a `oneOf` that code generators can't spread into named method
  // arguments — the caller is handed an opaque union and the generated snippets
  // carry no body fields. When every variant is an inline object pinned by a
  // string-const discriminator, the union is equivalent to a single object, so
  // fold it into that object and let the normal object path below emit
  // ergonomic, spread-able arguments. See flattenDiscriminatedUnionBody.
  if (schema.oneOf && schema.discriminator) {
    const merged = flattenDiscriminatedUnionBody(schema);
    if (merged) schema = merged;
  }

  // If the request body is an inline object with properties, extract it as a
  // model. An empty `properties: {}` beside a composition that types the
  // body is not its object (`composedWithoutFields`): the `oneOf` branch or
  // the fall-through reads the composition, as for a response body.
  if (schema.properties && !composedWithoutFields(schema) && (schema.type === 'object' || !schema.type)) {
    const requiredSet = new Set(schema.required ?? []);
    const siblings = collectProperties(schema);
    const fields: Field[] = [];
    for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
      if (!fieldSchema) continue;
      fields.push(buildFieldFromSchema(fieldName, fieldSchema, contextName, requiredSet, componentSchemas, siblings));
    }
    inlineModels.push({
      name: contextName,
      description: undefined,
      ...externalDocsEntry(schema.externalDocs),
      fields,
      ...deprecatedEntry(schema),
      ...constraintsEntry(schema),
    });
    // Nested inline objects (e.g. a `user` property that is itself an inline
    // object) are referenced by name from the fields above but are not emitted
    // by this branch. Recurse to materialize them, matching how component
    // schemas are handled in extractInlineModelsFromSchemas — otherwise the
    // generated body model references a model that never gets generated.
    extractInlineModelsFromProperties(schema, inlineModels, contextName, componentSchemas);
    return { kind: 'model', name: contextName };
  }

  // A nullable body (`oneOf: [object, null]`) is one schema: the model built
  // from its object branch takes the wrapper's `deprecated` and limits, as
  // every other nullable unwrap gives it (`collapsedNullableBranch`). The
  // null branch still makes the body nullable below. A multi-variant union,
  // nullable or not, is not collapsed: every variant is built as written. A
  // nullable wrapper around one branch that is not an inline object — an
  // array (`oneOf: [{ items }, { type: 'null' }]`), a `$ref`, a primitive —
  // is not a union to build: it takes the fall-through, where
  // `schemaToTypeRef` types it as it types the same wrapper on a field or a
  // parameter (`nullable<CreatePetsRequest[]>`, `nullable<Pet>`) and the
  // array's inline items are named from the body (`CreatePetsRequest`), the
  // way `type: ['array', 'null']` and `nullable: true` already are.
  const branch = collapsedNullableBranch(schema);

  // If the request body is a oneOf, extract each variant as an inline model
  // and build a union type pointing to them by name.
  if (schema.oneOf && (branch === undefined || isInlineObjectSchema(branch))) {
    const variants: TypeRef[] = [];
    // The inline object variants of this union and the names its const-less
    // variants have taken so far, for `deriveOneOfVariantName`.
    const inlineObjectVariants = schema.oneOf.filter(
      (v) => !v.$ref && v.properties && (v.type === 'object' || !v.type),
    );
    const contentNamed: string[] = [];

    // The inline object variants are named and built first, in order, so the
    // other variants' contexts can step around their names and their
    // children's (`nonObjectVariantContexts`).
    const objectVariantNames = new Map<SchemaObject, string>();
    for (const variant of inlineObjectVariants) {
      const named = deriveOneOfVariantName(
        variant,
        contextName,
        inlineModels,
        inlineObjectVariants,
        contentNamed,
        Boolean(op?.operationId),
      );
      const variantName = named.name;
      if (named.fromContent) contentNamed.push(variantName);
      objectVariantNames.set(variant, variantName);
      const source = branch ?? variant;
      const requiredSet = new Set(source.required ?? []);
      const siblings = collectProperties(source);
      const fields: Field[] = [];
      for (const [fieldName, fieldSchema] of Object.entries(source.properties ?? {})) {
        if (!fieldSchema) continue;
        fields.push(buildFieldFromSchema(fieldName, fieldSchema, variantName, requiredSet, componentSchemas, siblings));
      }
      inlineModels.push({
        name: variantName,
        description: source.description,
        ...externalDocsEntry(source.externalDocs),
        fields,
        ...deprecatedEntry(source),
        ...constraintsEntry(source),
      });
      extractInlineModelsFromProperties(source, inlineModels, variantName, componentSchemas);
    }
    // Every other variant that mints a name — an array or map, a nested
    // union, a nullable wrapper around an object, an `allOf`, an inline enum
    // — is typed under the context `nonObjectVariantContexts` gives it, apart
    // from the object variants' names, and materialized by the field
    // extractor under that context, so the body never references a model the
    // parser did not create: the variants of a union nested under the body's
    // second variant are `CreateThingRequestVariant2`,
    // `BCreateThingRequestVariant2`, never `CreateThingRequest` again.
    const variantContexts = nonObjectVariantContexts(
      contextName,
      schema.oneOf,
      undefined,
      undefined,
      objectVariantNames,
    );
    for (const [variant, { context, reserved }] of variantContexts) {
      extractInlineModelsFromProperties(
        { properties: { [context]: unwrapNullableField(variant) } },
        inlineModels,
        undefined,
        componentSchemas,
        undefined,
        reserved,
      );
    }

    for (const variant of schema.oneOf) {
      if (variant.$ref) {
        const ref = schemaToTypeRef(variant, contextName);
        variants.push(ref);
      } else if (variant.type === 'null') {
        // skip null variant in union, handle separately
      } else {
        const variantName = objectVariantNames.get(variant);
        const entry = variantContexts.get(variant);
        variants.push(
          variantName !== undefined
            ? { kind: 'model', name: variantName }
            : entry
              ? schemaToTypeRef(variant, entry.context, undefined, undefined, entry.reserved)
              : schemaToTypeRef(variant, contextName),
        );
      }
    }

    const hasNull = schema.oneOf.some(
      (v: SchemaObject) => v.type === 'null' || (Array.isArray(v.type) && v.type.includes('null')),
    );
    const union: TypeRef = {
      kind: 'union',
      variants,
      ...(schema.discriminator
        ? {
            discriminator: { property: schema.discriminator.propertyName, mapping: schema.discriminator.mapping ?? {} },
          }
        : {}),
    };
    return hasNull ? ({ kind: 'nullable', inner: union } as TypeRef) : union;
  }

  // Anything else is typed by `schemaToTypeRef` (a primitive, an `anyOf`, an
  // array, a map, a nullable object, a nullable wrapper around an array, a
  // `$ref` or a primitive, …). Such a TypeRef can still reach inline models
  // — the inline object variants of an `anyOf`, an array's inline items or
  // the variants of an `items.oneOf`, a map's inline values, and whatever is
  // nested under any of them, a union under a variant included — so
  // materialize them the way an inline response does: as a property of this
  // name under no parent, which names every nested model exactly as the
  // TypeRef references it.
  extractInlineModelsFromProperties(
    { properties: { [contextName]: schema } },
    inlineModels,
    undefined,
    componentSchemas,
  );
  return schemaToTypeRef(schema, contextName);
}

/**
 * Fold a discriminated-union request body into the equivalent single object so
 * its fields can be spread into method arguments instead of forcing callers to
 * construct an opaque union.
 *
 * The result is the union of every variant's properties: the discriminator is
 * collapsed to an enum of the pinned const values, and any field that isn't
 * present-and-required in *every* variant becomes optional (it varies by
 * branch, so it can't be unconditionally required). The discriminator itself is
 * always required. This mirrors what a spec author would write by hand to model
 * the same shape as a flat object.
 *
 * Returns null — leaving the union intact — unless the body is a clean
 * inline-object discriminated union: a variant that is a `$ref`, a non-object,
 * or that doesn't pin the discriminator to a string const can't be safely
 * merged. Gating on an *explicit* `discriminator` keeps undiscriminated `oneOf`
 * bodies untouched.
 */
function flattenDiscriminatedUnionBody(schema: SchemaObject): SchemaObject | null {
  const discProp = schema.discriminator?.propertyName;
  if (!discProp || !Array.isArray(schema.oneOf) || schema.oneOf.length === 0) return null;

  const variants = schema.oneOf as SchemaObject[];
  const discValues: string[] = [];
  let discPropSchema: SchemaObject | undefined;

  for (const variant of variants) {
    // Every variant must be an inline object that pins the discriminator to a
    // string const (or single-value enum); anything else can't be merged.
    if (variant.$ref || !variant.properties || !(variant.type === 'object' || variant.type === undefined)) {
      return null;
    }
    const dp = variant.properties[discProp] as SchemaObject | undefined;
    const constVal =
      typeof dp?.const === 'string'
        ? dp.const
        : Array.isArray(dp?.enum) && dp.enum.length === 1 && typeof dp.enum[0] === 'string'
          ? dp.enum[0]
          : undefined;
    if (constVal === undefined) return null;
    if (!discValues.includes(constVal)) discValues.push(constVal);
    if (!discPropSchema) discPropSchema = dp;
  }

  const variantCount = variants.length;
  const mergedProps: Record<string, SchemaObject> = {};
  const requiredCounts: Record<string, number> = {};
  const order: string[] = [discProp]; // discriminator leads the merged object

  for (const variant of variants) {
    const required = new Set(variant.required ?? []);
    for (const [name, propSchema] of Object.entries(variant.properties!)) {
      if (name === discProp || !propSchema) continue;
      if (!(name in mergedProps)) {
        mergedProps[name] = propSchema as SchemaObject;
        order.push(name);
      }
      if (required.has(name)) requiredCounts[name] = (requiredCounts[name] ?? 0) + 1;
    }
  }

  // The discriminator collapses to an enum of the pinned values.
  mergedProps[discProp] = {
    type: 'string',
    enum: discValues,
    ...(discPropSchema?.description ? { description: discPropSchema.description } : {}),
  };

  const properties: Record<string, SchemaObject> = {};
  for (const name of order) properties[name] = mergedProps[name];

  // Required only when required in every variant; the discriminator is always
  // required.
  const requiredFields = order.filter((name) => name === discProp || requiredCounts[name] === variantCount);

  return {
    type: 'object',
    properties,
    required: requiredFields,
    ...(schema.description ? { description: schema.description } : {}),
    // The wrapper's deprecation is the body's; a variant's is not carried,
    // since its fields are merged away into the one body model.
    ...deprecatedEntry(schema),
    // The wrapper's link is the body's, like its description.
    ...externalDocsEntry(schema.externalDocs),
    // The wrapper's own keywords bind every branch, so they ride along; the
    // variants' keywords are alternatives and are not carried.
    ...extractConstraints(schema),
  };
}

/**
 * Derive a unique variant name for a request-body `oneOf` inline model.
 *
 * A variant with a string-const property is named after it
 * (`RadarEmailChallengeCodeSessionAuthenticateRequest`). Any other variant is
 * named from its content by the same rule every inline union variant follows
 * (`nameInlineVariant`): the first const-less variant keeps the body's name
 * (or its title, when every inline variant of the union is titled), and each
 * later one takes its title, a distinguishing property
 * (`CreateThingRequestWithB`) or, when its property set repeats an earlier
 * variant's, the position counter (`CreateThingRequest2`). `siblings` are the
 * union's inline object variants and `contentNamed` the names its const-less
 * variants have taken so far; `fromContent` tells the caller to record this
 * one there. A clash with a model minted elsewhere still bumps the counter:
 * on the base for a content-named variant (`CreateThingRequest2`), on the
 * const-derived name for a const-named one (`FooCreateThingRequest2`) — so a
 * variant titled `Foo` and a later one pinning `kind: foo` in the same body
 * never share a model.
 *
 * `fromOperationId` says where `baseName` came from. An operationId-derived
 * base is already in cleanSchemaName form and its variants go through
 * resolveSchemaName, so they follow the same project-level naming policy as
 * component schemas. A path-derived base is used verbatim: it is deliberately
 * not cleaned (see derivePathModelBaseName) and resolvePathModelBaseNames
 * reserves names by that exact prefix, so cleaning a variant here would let it
 * slip past the reservation — `NotesPostRequest` became `NotePostRequest` and
 * collided with a component of that name.
 */
function deriveOneOfVariantName(
  variant: SchemaObject,
  baseName: string,
  existingModels: Model[],
  siblings: readonly SchemaObject[],
  contentNamed: readonly string[],
  fromOperationId: boolean,
): { name: string; fromContent: boolean } {
  const finalize = (name: string): string => (fromOperationId ? resolveSchemaName(name) : name);
  const existingNames = new Set(existingModels.map((m) => m.name));
  // `name`, or `<stem><n>` counting from 2 while a model of that name exists.
  const unique = (name: string, stem: string): string => {
    let candidate = name;
    for (let suffix = 2; existingNames.has(candidate); suffix++) candidate = `${stem}${suffix}`;
    return candidate;
  };
  // Try to use a distinguishing property (e.g., "grant_type" field's const/enum value)
  if (variant.properties) {
    for (const [, propSchema] of Object.entries(variant.properties)) {
      if (propSchema?.const && typeof propSchema.const === 'string') {
        const derivedName = finalize(toPascalCase(propSchema.const) + baseName.replace(/Request$/, '') + 'Request');
        return { name: unique(derivedName, derivedName), fromContent: false };
      }
    }
  }
  // Finalize before naming so every candidate stays in the same namespace as
  // the rest of the IR.
  const finalBaseName = finalize(baseName);
  const name = unique(nameInlineVariant(variant, siblings, finalBaseName, contentNamed, null), finalBaseName);
  return { name, fromContent: true };
}

/** Human-readable label for an operation in diagnostics: its operationId, else `METHOD /path`. */
function operationLabel(op: OperationObject | undefined, path: string, method: HttpMethod): string {
  return op?.operationId ?? `${method.toUpperCase()} ${path}`;
}

/**
 * The servers an operation carries as `Operation.servers`: its own `servers`,
 * else its Path Item's (OpenAPI precedence: the operation overrides the Path
 * Item, which overrides the document), and only when that list differs from
 * the document's by `serverListsEqual`. `undefined` means the operation
 * inherits `ApiSpec.servers` — nothing usable is declared at either level
 * (`servers: []` and all-unusable entries included, since `extractServerList`
 * already reads both as undeclared), or the winning list restates the
 * document's — a restatement whose URLs differ only in scheme or host case,
 * a default port or a `/` after a bare authority included, since
 * `serverListsEqual` compares URLs through `normalizeServerUrl`. Precedence
 * is applied before the comparison, so an operation that restates the
 * document's servers under a Path Item that diverges inherits, not the Path
 * Item's.
 *
 * OpenAPI's default server is one thing however it is spelled (#291): a list
 * that means it — no servers, `servers: []`, or nothing but `/`, by
 * `isDefaultServerList`, description and variables aside (the default server
 * has neither, and `/` references no variable, so one declared on it changes
 * nothing — #292) — under a document whose list means it too is inherited as
 * well. So an operation or Path Item that writes `/` out under a document
 * that declares nothing inherits, the entry's description and variables
 * included. Any other list is compared
 * entry for entry as written, `/` entries included, because position decides
 * the default host: `/` under a document that names a host is kept, a named
 * host under a document that writes `/` out is kept, and a named host alone
 * under a document that lists `/` before that host is kept.
 */
function operationServers(
  own: ServerEntry[] | undefined,
  pathLevel: ServerEntry[] | undefined,
  documentServers: ServerEntry[] | undefined,
): ServerEntry[] | undefined {
  const effective = own ?? pathLevel;
  if (!effective) return undefined;
  if (serverListsEqual(effective, documentServers ?? [])) return undefined;
  return isDefaultServerList(effective) && isDefaultServerList(documentServers) ? undefined : effective;
}

/**
 * The spec-wide registry of inline model shapes (see `InlineModelRegistry`):
 * the component models and the inline models their fields mint, every inline
 * model the operations mint for request bodies and primary responses, the
 * envelope companions, and each deferred model materialized so far. The value
 * carries the model's shape fingerprint, so a schema whose shape matches can
 * share the name, and the operation that minted it (none for a component or
 * a shared envelope companion), so a collision inside one operation can be
 * told apart from one across operations.
 */
type ModelShapeRegistry = InlineModelRegistry;

/**
 * A header, secondary-body, fallback-body or error-body schema whose inline
 * models are named only once every primary model of every operation is known
 * (`resolveDeferredInlineTypes`), which then fills in `target.type`. Until
 * then the target carries a placeholder.
 */
interface DeferredInlineType {
  kind: 'header' | 'content' | 'request' | 'fallback' | 'error' | 'param';
  schema: SchemaObject;
  /**
   * The bare name the models derive from: the header name, the response stem
   * + media type + role, a secondary request body's `<Op><MediaType>Request`,
   * a fallback body's `<Op><Label>Response`, an error body's
   * `<Op>Error<code>`, a parameter's name, or `<Component>Response` for a
   * fallback or error body a `components/responses` entry declares.
   */
  name: string;
  /**
   * Set for a fallback or error body a `components/responses` entry declares,
   * named after the component (`<Component>Response`) wherever the component
   * is returned — a 404 of one operation, the `default` or a range of another
   * — so every such site is a sibling of every other whatever its kind and
   * steps by number alike, and all settle on one name.
   */
  componentBody?: boolean;
  /**
   * What tells this site from another of the same name within one operation:
   * a status code, the label of a fallback response (`Default`,
   * `ClientError`), or a parameter's location (`query`); a request body has
   * none.
   */
  statusCode?: number | string;
  /** Qualifies a name taken across operations (see `headerOperationQualifier`). */
  operationQualifier: string;
  /**
   * Qualifies a header's names: the service for a header of an inline
   * response (`Documents` + `X-Meta` → `DocumentsXMeta`), the component's
   * stem for one of a response shared through `components/responses`
   * (`Card` + `X-Meta` → `CardXMeta`); a body has none.
   */
  parentName?: string;
  componentSchemas?: Record<string, SchemaObject>;
  /**
   * Everything the resolved type is written to: the header or content entry,
   * and for a fallback or error body both the response entry and the content
   * entry of the media type it was read from, which share one TypeRef as a
   * success entry's do.
   */
  targets: Array<{ type?: TypeRef }>;
}

/** What response header and body typing needs from the operation and the spec. */
interface ResponseTypingContext {
  componentHeaders?: Record<string, Record<string, unknown>>;
  /** Lets inline models resolve `$ref` siblings and augmentations the way fields do. */
  componentSchemas?: Record<string, SchemaObject>;
  /** `components/responses`, for a response written as a Reference Object. */
  componentResponses?: Record<string, Record<string, unknown>>;
  /**
   * Whether a `description` written beside a response `$ref` overrides the
   * component's (OAS 3.1) or is ignored (OAS 3.0); see `resolveResponseRef`.
   */
  refSiblingDescriptions?: 'override' | 'ignore';
  /**
   * The model name each component response's inline body is shared under
   * (`resolveComponentResponseModelNames`). Absent, every component keeps
   * `componentResponseModelName`.
   */
  componentResponseModelNames?: ReadonlyMap<string, string>;
  /**
   * Qualifies the header model and enum names of an inline response:
   * `Documents` + `X-Meta` → `DocumentsXMeta`. A response shared through
   * `components/responses` qualifies its headers by the component instead
   * (`responseModelSite`).
   */
  serviceName?: string;
  /** Qualifies a name taken across operations (see `headerOperationQualifier`). */
  operationQualifier: string;
  /** Collects every schema whose models are named after the operations loop. */
  deferred: DeferredInlineType[];
  /**
   * The spec-wide registry of model shapes the operations fill as they are
   * read (see `extractOperations`); with it, the primary body's array items
   * are settled against every name it holds (`typeInlineItems`). Absent for
   * a dry run that only reads the names a body would mint.
   */
  registry?: ModelShapeRegistry;
}

/**
 * Name and materialize every deferred header, secondary request-body,
 * secondary response-body, fallback-body, error-body and parameter schema,
 * now that every primary model is known. The registry comes filled from
 * `extractOperations`: the component models first (with the inline models
 * their fields mint), each seeded with the model itself so it shares its
 * name with every shape it admits (`ownerShares`), then every inline model
 * the operations minted — request bodies, primary response bodies with
 * their nested objects, union variants and settled array items, envelope
 * companions — shared on an identical shape only, so no deferred schema
 * can take one of their names for a shape the owner does not share,
 * whichever operation minted it; each resolved schema's own models join it
 * in turn, in document order (path order, then an operation's secondary
 * request bodies in content order, then the response keys as written; a
 * response's headers before its error body and its secondary bodies, a
 * fallback's body before its headers), so the first owner of a name keeps
 * it. Every enum name decided before this pass, component or minted, is
 * held too, as a name no model may take (`reserveEnumNames`): a deferred
 * schema that derives one steps to its next candidate, so a component enum
 * `ReplaceWidgetTextCsvRequest` sends the `text/csv` body's model to
 * `ReplaceWidgetTextCsvRequest2`. The sites that derive from one bare name
 * — one kind, parent and name: the same header on several status codes or
 * operations, one media type's body on several status codes, a component
 * response's header or secondary body from every operation that returns it;
 * or one component response's body, whether the site is an error or a
 * fallback entry (`componentBody`) — share a record of the stems they settled on and
 * the renames made under them, so a later one shares an identical shape
 * under whichever name the earlier took (`materializeInlineSchema`).
 *
 * Two precedences decide a name a model and an enum both derive. An enum
 * typed as an operation is built — one a parameter, a request body, a
 * success body, a pagination field carries — is in the registry before this
 * pass and keeps its name wherever the document declares it: a `status`
 * query enum on a later operation sends an earlier operation's `status`
 * parameter object to `PetsListPetsStatus`, and the same operation's to
 * `PetsQueryStatus`. Among the sites named here — response headers, error
 * bodies, secondary and fallback bodies, parameter models — document order
 * decides: each site registers the enums it types (a body that is itself an
 * enum, an enum nested in a model it minted) as it is resolved, so the
 * earlier site keeps the name and a later one that derives it steps (an
 * `X-Mode` header parameter object after an earlier operation's `X-Mode`
 * response-header enum is `PetsGetPetXMode`; `getPet`'s object 404 after
 * `get-pet`'s enum 404 is `GetPetError404Body`), while an enum typed after
 * a model of its name steps in the collectors instead
 * (`collectDistinctEnums`, `GetPetError404Body` when the object 404 comes
 * first). So the IR never declares a model and an enum under one name.
 * Returns the models materialized, having set each target's `type`.
 */
function resolveDeferredInlineTypes(
  deferred: readonly DeferredInlineType[],
  registry: ModelShapeRegistry,
): { models: Model[]; bundles: InlineModelBundle[] } {
  const models: Model[] = [];
  const bundles: InlineModelBundle[] = [];
  const siblingsByBareName = new Map<string, SiblingSites>();
  for (const item of deferred) {
    // A component response's body is one site wherever the component is
    // returned, so its record is keyed by the component's name alone, not
    // by whether the site is an error or a fallback entry.
    const bareName = item.componentBody
      ? `component\u0000\u0000${item.name}`
      : `${item.kind}\u0000${item.parentName ?? ''}\u0000${item.name}`;
    let siblings = siblingsByBareName.get(bareName);
    if (!siblings) siblingsByBareName.set(bareName, (siblings = []));
    const minted = models.length;
    const type = materializeDeferredType(item, registry, models, siblings);
    // An enum this site typed — a body that is itself an enum, one nested in
    // a model it minted — owns its name from here on, as the site's models do.
    reserveEnumNames(
      registry,
      [type, ...models.slice(minted).flatMap(collectModelTypeRefs)].flatMap(collectEnumRefs),
      item.operationQualifier,
    );
    for (const target of item.targets) target.type = type;
    // The one TypeRef every target shares is the site's root; the models
    // minted for it are the site's own (a shape that shared another site's
    // model minted nothing here, see `attachSharedDeferredRefs`).
    bundles.push({
      qualifier: item.operationQualifier,
      roots: [type],
      models: models.slice(minted),
      ...(isSentSite(item) ? { sent: true } : {}),
    });
  }
  return { models, bundles };
}

/**
 * Give each reference a deferred schema wrote by sharing another site's model
 * to that site. A deferred shape identical to a name's owner — a primary
 * body's model, a companion's, an earlier deferred model — takes the name and
 * mints nothing, so its reference is not among the owner's roots, and a merge
 * pass that renames the owner (a deprecated copy named like a live one,
 * `settleSharedNames`) would leave the `default` response or header on
 * the old name, which the live copy then takes. The first site to mint a
 * name owns it, as the registry decided; the references the deferred site's
 * roots and its own models' fields make to that name are added to the
 * owner's roots, so they are repointed with the owner's own. A component is
 * never renamed, so a reference to one is left alone.
 */
function attachSharedDeferredRefs(
  deferredBundles: readonly InlineModelBundle[],
  bundles: readonly InlineModelBundle[],
  componentNames: ReadonlySet<string>,
): void {
  const siteOf = new Map<string, InlineModelBundle>();
  for (const bundle of bundles) {
    for (const model of bundle.models) if (!siteOf.has(model.name)) siteOf.set(model.name, bundle);
  }
  for (const bundle of deferredBundles) {
    const refs = [...bundle.roots, ...bundle.models.flatMap((model) => collectModelTypeRefs(model))];
    for (const ref of refs) {
      for (const name of collectModelRefs(ref)) {
        if (componentNames.has(name)) continue;
        const site = siteOf.get(name);
        if (site && site !== bundle && !site.roots.includes(ref)) site.roots.push(ref);
      }
    }
  }
}

/**
 * Type a deferred schema and materialize the inline models it names, under a
 * property name that does not collide with a different shape anywhere in the
 * spec — through `materializeInlineSchema`, the one retry loop every such
 * schema goes through.
 *
 * A header model is named from the service and header name alone, so an
 * inline `X-Meta` on a `Documents` operation is `DocumentsXMeta`; a secondary
 * body from the operation's response stem and media type,
 * `RenderPetCardTextHtmlResponse`; either, on a response shared through
 * `components/responses`, from the component's stem instead (`CardXMeta`,
 * `CardApplicationYamlResponse`; see `responseModelSite`); a fallback body
 * from the stem and the response's label, `ListPetsDefaultResponse`; an
 * error body from the stem and its status code, `GetPetError404`
 * (`deriveErrorModelName`); a parameter from the service and parameter
 * name, `PetsFilter`. Any of them
 * is a name a component schema, a model nested in one (`GetPet.error404` owns
 * `GetPetError404`), a primary body, the same header on a 429 or another
 * operation may already own with a different shape, or an enum — a
 * component's, or one a parameter or field lifts — may own outright
 * (`reserveEnumNames`). Left alone, the later
 * merge keeps one definition for the name and every other reference silently
 * gets the wrong fields (a request body using the component would even change
 * type without any emitter reading headers).
 *
 * The first owner of a name keeps it (see `resolveDeferredInlineTypes`), and
 * a later schema with a different shape — at any depth, a nested object that
 * differs counts — is re-derived under the first free candidate of its kind
 * (`deferredNamingStem`):
 *
 *   header    1. the bare name                `DocumentsXMeta`
 *             2. when the name is taken inside this operation, the status
 *                code (`DocumentsXMeta429`); when taken by a component or
 *                another operation, the operation (`DocumentsCreateDocumentXMeta`)
 *             3. the other of those two
 *             4. operation and status code    `DocumentsCreateDocumentXMeta429`
 *             5. a numeric suffix             `DocumentsXMeta2`, `DocumentsXMeta3`, …
 *   content   1. the bare name                `RenderPetCardTextHtmlResponse`
 *             2. the status code              `RenderPetCardTextHtmlResponse201`
 *             3. a numeric suffix             `…Response2`, `…Response3`, …
 *   request   1. the bare name                `ReplaceWidgetTextCsvRequest`
 *             2. a numeric suffix             `ReplaceWidgetTextCsvRequest2`, `…3`, …
 *   fallback  1. the bare name                `ListPetsDefaultResponse`
 *             2. a numeric suffix             `ListPetsDefaultResponse2`, `…3`, …
 *   error     1. the bare name                `GetPetError404`
 *             2. a `Body` suffix              `GetPetError404Body`
 *             3. a numbered `Body` suffix     `GetPetError404Body2`, `…Body3`, …
 *   a fallback or error body a `components/responses` entry declares
 *   (`componentBody`), whichever of the two kinds the site is:
 *             1. the bare name                `ProblemResponse`
 *             2. a numeric suffix             `ProblemResponse2`, `…3`, …
 *
 * Between the bare name and the kind's own qualifiers come the stems the
 * earlier sites of the same kind, parent and bare name settled on
 * (`siblings`, kept by `resolveDeferredInlineTypes`): the `X-Meta` header of
 * a 429 tries the `DocumentsXMeta200` its 200 took before `DocumentsXMeta429`,
 * and the `application/vnd.pet+json` body of a 201 tries the `…Response200`
 * its 200 took before `…Response201`, so an identical shape shares the
 * earlier site's model under whichever name that site settled on, and a
 * different shape steps past it to its own qualifier. A fallback body named
 * from the operation carries the response's label in its bare name and an
 * error body named from it its status code, so within an operation each has
 * a bare name of its own and no sibling to try. A component response's body
 * carries the component's name wherever the component is returned, so the
 * 404 of one operation and the `default` of another are siblings, and an
 * identical shape — the component's own, every time — shares the first
 * site's model under whichever name it settled on.
 *
 * Both the type and the models come from the same property name, so nested
 * models (`DocumentsXMeta429Origin`) line up by construction. A shape the
 * name's current owner shares — identical to an operation's model, or one a
 * component admits (`ownerShares`) — takes the name and materializes nothing
 * new, which is how a header reuses a component model. A
 * title-mapped union variant (`Circle`) is named from its title whatever the
 * property name, so `materializeInlineSchema` reserves every taken name and
 * such a variant falls back to its context-qualified name
 * (`CircleDocumentsXMeta`, see `nameInlineVariants`). A clash neither a
 * candidate nor a reservation can clear — a titled variant nested below the
 * top level — is not looped on: the clashing models are renamed under the
 * schema's root (`RenderPetCardTextHtmlResponseCircle`) with every reference
 * rewritten, whatever the kind.
 *
 * Treating the schema as a one-property object reuses the field-level
 * extractor, whose names come from the same `qualifyInlineModelName(name,
 * parent)` rule `schemaToTypeRef` applies — the trick the inline request-body
 * path uses.
 */
function materializeDeferredType(
  item: DeferredInlineType,
  registry: ModelShapeRegistry,
  models: Model[],
  siblings: SiblingSites,
): TypeRef {
  return materializeInlineSchema(item.schema, {
    stem: deferredNamingStem(item),
    siblings,
    parentName: item.parentName,
    componentSchemas: item.componentSchemas,
    registry,
    operation: item.operationQualifier,
    sent: isSentSite(item),
    models,
  });
}

/** Whether a deferred schema is one the SDK sends — a secondary request body or a parameter — rather than receives. */
function isSentSite(item: DeferredInlineType): boolean {
  return item.kind === 'request' || item.kind === 'param';
}

/** The candidate property names of a deferred schema, by kind (see `materializeDeferredType`). */
function deferredNamingStem(item: DeferredInlineType): (index: number, firstClashOwners: InlineModelOwner[]) => string {
  const { name, statusCode = '', operationQualifier } = item;
  const byStatus = `${name}${statusCode}`;
  const numbered = (index: number): string => `${name}${index + 2}`;
  const byNumber = (index: number): string => (index === 0 ? name : numbered(index - 1));
  // A component response's body steps the same way at a 404, at `default`
  // and in a range — by number, as the pre-pass that named it steps
  // (`resolveComponentResponseModelNames`) — so every site that returns the
  // component reaches the same name.
  if (item.componentBody) return byNumber;
  switch (item.kind) {
    case 'header': {
      // Decide the preference between candidates 2 and 3 from the bare
      // name's owners: a clash within this operation reads best by status
      // code, one with a component, a primary body or another operation by
      // operation name. Joined with `_`, as a parameter's are, since the
      // bare name is the lower-cased header name (`ListDocuments_x-meta` →
      // `ListDocumentsXMeta`, not `ListDocumentsxMeta`).
      const byOperationName = `${operationQualifier}_${name}`;
      const byOperationAndStatus = `${operationQualifier}_${name}${statusCode}`;
      return (index, firstClashOwners) => {
        const withinOperation = firstClashOwners.every((owner) => owner.operation === operationQualifier);
        const candidates = withinOperation
          ? [name, byStatus, byOperationName, byOperationAndStatus]
          : [name, byOperationName, byStatus, byOperationAndStatus];
        return index < candidates.length ? candidates[index] : numbered(index - candidates.length);
      };
    }
    case 'content':
      return (index) => (index === 0 ? name : index === 1 ? byStatus : numbered(index - 2));
    case 'request':
    case 'fallback':
      return byNumber;
    case 'error':
      return (index) => (index === 0 ? name : index === 1 ? `${name}Body` : `${name}Body${index}`);
    case 'param': {
      // Named like a header, with the location where a header has its
      // status code: a clash within this operation (one name in two
      // locations) reads best by location, one with a component, a primary
      // body or another operation by operation name. Joined with `_` so a
      // lower-case parameter name still starts a word (`ListPets_filter` →
      // `ListPetsFilter`).
      const byLocation = `${statusCode}_${name}`;
      const byOperationName = `${operationQualifier}_${name}`;
      const byOperationAndLocation = `${operationQualifier}_${statusCode}_${name}`;
      return (index, firstClashOwners) => {
        const withinOperation = firstClashOwners.every((owner) => owner.operation === operationQualifier);
        const candidates = withinOperation
          ? [name, byLocation, byOperationName, byOperationAndLocation]
          : [name, byOperationName, byLocation, byOperationAndLocation];
        return index < candidates.length ? candidates[index] : numbered(index - candidates.length);
      };
    }
  }
}

/**
 * Defer the typing of every parameter of one location whose inline schema
 * mints a model — an object (`style: deepObject`), an array or map of
 * objects, a union with an inline object variant, a nullable wrapper around
 * one, at any depth — so the model is created, as a response header's is,
 * once every primary model is known (`resolveDeferredInlineTypes`), under a
 * name nothing else owns: `<Service><Param>` (`PetsFilter`), else the
 * location-, operation- or number-qualified candidates `deferredNamingStem`
 * lists; a name an enum has or will have — a component enum's, or the name
 * another parameter's or a field's inline enum is lifted under (`PetsKind`)
 * — is reserved in the registry, so the model steps to the
 * operation-qualified name (`PetsSearchPetsKind`). Called after the
 * operation's responses have been read, so a parameter's site follows the
 * response headers' in the registry: a response header the operation
 * already typed keeps its name (`PetsXMeta`), and a header parameter of the
 * same name takes the location-qualified one (`PetsHeaderXMeta`).
 * `extractParams` typed the parameter as the property of its name under the
 * service, and the trial extraction here reads the same synthetic property,
 * so the deferred site's first candidate is the name the parameter already
 * references and a parameter that mints no model — a primitive, a `$ref`,
 * an inline enum, an array of either — keeps the type it has and is not
 * deferred. `raw` and `typed` are the location's parameters in document
 * order, `typed[i]` built from `raw[i]` (`extractParams` maps the filtered
 * list one to one).
 */
function deferParameterModels(
  raw: readonly ParameterObject[],
  typed: readonly Parameter[],
  location: ParameterObject['in'],
  ctx: ResponseTypingContext,
): void {
  const parentName = ctx.serviceName ? toPascalCase(ctx.serviceName) : undefined;
  raw.forEach((param, index) => {
    const target = typed[index];
    // The schema `extractParams` typed the parameter from: `schema`, else the
    // picked `content` entry's (`parameterTyping`).
    const schema = parameterSchema(param);
    if (!schema || !target) return;
    // The name the models derive from is the one `extractParams` typed the
    // parameter under — a header's lower-cased (`foldParameterName`) — so the
    // reference and the model agree, and neither moves with the header's case.
    const name = foldParameterName(location, param.name);
    const trial: Model[] = [];
    extractInlineModelsFromProperties({ properties: { [name]: schema } }, trial, parentName, ctx.componentSchemas);
    if (trial.length === 0) return;
    ctx.deferred.push({
      kind: 'param',
      schema,
      name,
      statusCode: location,
      operationQualifier: ctx.operationQualifier,
      parentName,
      componentSchemas: ctx.componentSchemas,
      targets: [target],
    });
  });
}

/**
 * Read a Response Object's `headers` map into IR response headers, resolving
 * `components/headers` refs. Returns `undefined` rather than `[]` when nothing
 * survives so callers can leave the `headers` key off entirely.
 *
 * An object-shaped header schema (directly, inside an array, or as a oneOf
 * variant) becomes a `ModelRef`, so the model it names must be materialized
 * — otherwise the ref would dangle with nothing to emit. That naming waits
 * for every primary model (`resolveDeferredInlineTypes`), so a header with a
 * schema is deferred and its `type` filled in then, qualified by
 * `parentName`: the service for a header of an inline response (`Notes` +
 * `X-Meta` → `NotesXMeta`), the component's stem for one of a response
 * shared through `components/responses` (`Card` + `X-Meta` → `CardXMeta`),
 * as `responseModelSite` decides.
 *
 * Header names are case-insensitive (RFC 9110 §5.1; OpenAPI says so of this
 * map), so two keys that differ in case alone (`X-Request-Id` beside
 * `x-request-id`) declare one header: the later declaration is kept, in the
 * earlier one's position, with a warning — the way an operation-level
 * parameter replaces a path-level one, except that the document gave these
 * two no precedence (#295).
 */
function extractResponseHeaders(
  headers: Record<string, RawHeaderObject> | undefined,
  operationLabel: string,
  // A status code, or the label of a fallback response (`Default`, `ClientError`).
  statusCode: number | string,
  ctx: ResponseTypingContext,
  parentName: string | undefined,
): ResponseHeader[] | undefined {
  if (!headers) return undefined;

  const declarations = new Map<string, { name: string; raw: RawHeaderObject }>();
  for (const [name, raw] of Object.entries(headers)) {
    const folded = foldHeaderName(name);
    const earlier = declarations.get(folded);
    if (earlier) {
      console.warn(
        `[oagen] Warning: Response header "${name}" on ${operationLabel} ${statusCode} is also declared as "${earlier.name}"; header names are case-insensitive, so the later declaration is used.`,
      );
    }
    declarations.set(folded, { name, raw });
  }

  const result: ResponseHeader[] = [];
  for (const [folded, { name, raw }] of declarations) {
    // OAS 3.x: a response header named `Content-Type` SHALL be ignored; the
    // media type is already carried by the response's `content` map.
    if (folded === 'content-type') continue;

    const header = resolveHeaderRef(raw, ctx.componentHeaders, name, operationLabel);
    if (!header) continue;

    // A Header Object declares `schema` or a single-entry `content` map; the
    // schema that types the header is resolved as a parameter's is
    // (`parameterTyping`): `schema`, else the picked `content` entry's. A map
    // none of whose media types is read leaves the header a string, with a
    // warning — once, here, as the header is typed.
    const schema = parameterSchema(header);
    warnUnreadParameterContent(header, `Response header "${name}" (${statusCode}) in ${operationLabel}`);
    const entry: ResponseHeader = {
      name,
      type: { kind: 'primitive', type: 'string' },
      required: header.required ?? false,
      description: header.description,
      deprecated: header.deprecated === true || undefined,
      // The header schema's own link — a Header Object has none — read from
      // whichever of `schema` and `content` types the header, as the type is.
      ...externalDocsEntry(schema?.externalDocs),
    };
    if (schema) {
      // Named from the lower-cased header name, as a header parameter's inline
      // type is, so the model or enum a header mints keeps its name when the
      // header's case changes; `entry.name` stays as written.
      ctx.deferred.push({
        kind: 'header',
        schema,
        name: folded,
        statusCode,
        operationQualifier: ctx.operationQualifier,
        parentName,
        componentSchemas: ctx.componentSchemas,
        targets: [entry],
      });
    }
    result.push(entry);
  }

  return result.length > 0 ? result : undefined;
}

/**
 * Build the prefix (`NotesByIdPinPost`) that names both inline models — the
 * request body (`…Request`) and the response (`…Response`) — of an operation
 * that has no `operationId`, from the only thing that identifies it: its path
 * and method.
 *
 * Every non-parameter segment is PascalCased in order and every parameter
 * segment becomes `By` + PascalCase(param name); then the optional
 * disambiguator and the method are appended. The whole is normalized with
 * toPascalCase so it is a fixed point of that function: responses.ts re-cases
 * the response name in `deriveModelName`, and without this step `POST /a/b`
 * named its body `ABPostRequest` but its response `AbPostResponse`.
 *
 *   GET  /widgets                   → WidgetsGet
 *   POST /notes                     → NotesPost
 *   POST /notes/{id}/pin            → NotesByIdPinPost
 *   GET  /users/{user_id}/sessions  → UsersByUserIdSessionsGet
 *
 * This tells the common path shapes apart (list vs. item, sibling and nested
 * sub-resources) but is not unique by construction: `/foo-bar` and `/foo/bar`,
 * `/notes/by-id` and `/notes/{id}`, `/notes` and `/notes/`, and a custom
 * method beside its slash form, `/pets/{id}:adopt` and `/pets/{id}/adopt`
 * (pathSegments reads the first as `{id}` then `adopt`), all flatten to the
 * same words. `resolvePathModelBaseNames` detects such collisions: the path
 * spelled most plainly keeps the plain name and every other one gets a
 * `disambiguator` derived from its raw path.
 *
 * A single-segment path keeps the name the old first-segment rule produced.
 * The result is deliberately not passed through cleanSchemaName (the old
 * fallback wasn't either): the segments are the resource names as the API
 * spells them.
 */
export function derivePathModelBaseName(path: string, method: HttpMethod, disambiguator = ''): string {
  const segments = pathSegments(path);
  const parts = segments.map((segment) =>
    segment.startsWith('{') ? 'By' + toPascalCase(segment.replace(/[{}]/g, '')) : toPascalCase(segment),
  );
  const resource = parts.length > 0 ? parts.join('') : 'Unknown';
  // `_` separators guarantee a word boundary on each side of the disambiguator
  // and the method, whatever the resource ends with; splitWords drops them.
  return toPascalCase([resource, disambiguator, method].filter(Boolean).join('_'));
}

/** `derivePathModelBaseName` plus the `Request` / `Response` suffix. */
export function derivePathBasedName(
  path: string,
  method: HttpMethod,
  suffix: 'Request' | 'Response',
  disambiguator = '',
): string {
  return derivePathModelBaseName(path, method, disambiguator) + suffix;
}

/**
 * Decide the path-derived model prefix of every operation that has no
 * `operationId`, keyed by `${method} ${path}`.
 *
 * A prefix collides when two distinct raw paths with the same method flatten
 * to it (see derivePathModelBaseName), or when a reserved name starts with
 * it. The reserved names are every resolved component model name and, for
 * every operation with an `operationId`, its model stem
 * (operationIdModelBase). A prefix is the stem of several emitted names —
 * `…Request`, `…Response`, a list's `…Item`, nested inline models such as
 * `…ResponseOwner`, envelope companions such as `…ListMetadata` — so the
 * check is on the stem, not on an enumeration of suffixes: an unnamed
 * `GET /audit/events` must not overwrite `components/schemas/AuditEventsGetItem`
 * any more than an unnamed `POST /audit/events` may overwrite the models of
 * a `POST /legacy-audit` whose operationId is `auditEventsPost`. Reserved
 * names never change.
 *
 * This is deliberately a superset: a component named `AuditEventsGetter`, or
 * an operationId `auditEventsGetSummary`, also pushes `GET /audit/events`
 * onto a hashed name although no emitted name would coincide. Determinism
 * and never sharing a name wrongly matter more than the rare extra hash, and
 * the reservation is unconditional — an inline body is never merged into a
 * same-named component even when the shapes agree — so the rule stays
 * simple and order-free. Every name derived from a path-based prefix uses it
 * verbatim (body `oneOf` variants included; see deriveOneOfVariantName), and
 * as a second line of defence the check also runs on the cleaned spellings
 * of the prefix (see prefixSpellings), so `GET /notes` yields to a component
 * `NoteGetItem` although its own item model is `NotesGetItem`. Names that
 * embed the prefix behind a const value — a body `oneOf` variant pinning
 * `kind: email` is `EmailTagsPostRequest`, a nested variant
 * `<Const><Parent><Field>` — are checked too, with each const the operation
 * can mint prepended to every spelling (see collectOperationConstPrefixes);
 * the hash then lands inside those names as well (`EmailTags151Dd5PostRequest`).
 *
 * These names are types SDK users read and import, so a collision costs the
 * plain name only where it must. Within a group of paths that flatten to one
 * prefix, the path spelled most plainly (see pathDeviation: no trailing
 * slash, `{id}` rather than a literal `by-id`) is canonical and keeps the
 * plain prefix; every other path gets a six-character disambiguator, the
 * start of the SHA-1 of its raw path, inserted before the method
 * (`POST /foo-bar` next to `POST /foo/bar` → `FooBar546F12Post`). When two
 * paths tie for plainest, or the prefix is reserved, nobody is canonical and
 * every path in the group is disambiguated. The outcome depends only on the
 * document's paths, operationIds and component names, never on their order,
 * and a path that stops colliding returns to its plain name.
 */
function resolvePathModelBaseNames(
  paths: Record<string, PathItem>,
  componentModels?: Model[],
  componentRequestBodies?: Record<string, Record<string, unknown>>,
  componentResponseNaming: ReadonlyMap<string, ComponentResponseNaming> = new Map(),
): Map<string, string> {
  const candidates: Array<{ key: string; path: string; method: HttpMethod; plain: string }> = [];
  const rawPathsByPlainName = new Map<string, Set<string>>();
  const constPrefixesByPlainName = new Map<string, Set<string>>();
  const reservedNames = new Set<string>();

  for (const model of componentModels ?? []) {
    reservedNames.add(model.name);
  }
  // A shared response names its inline body after the component, not the
  // operation (see componentResponseModelName), so its stem is reserved like
  // an operationId's — and so is every name that body mints, the model and
  // everything nested under it (`OwnerCardResponseAddressGetResponse` for an
  // `address_get_response` object in `OwnerCard`): a path stem that merely
  // extends the component's (`GET /owner/card/response/address` →
  // `OwnerCardResponseAddressGet`) starts with none of the stems above, yet
  // its `…Response` is exactly such a nested name, and the later merge would
  // keep one shape for both. The names are the ones
  // `resolveComponentResponseModelNames` read with the extractor the
  // operation will use, under the same context name, so they agree by
  // construction.
  for (const [componentName, naming] of componentResponseNaming) {
    reservedNames.add(componentResponseModelBase(componentName));
    reservedNames.add(naming.name);
    for (const name of naming.minted) reservedNames.add(name);
  }

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (op.operationId) {
        reservedNames.add(operationIdModelBase(op.operationId));
        continue;
      }
      const plain = derivePathModelBaseName(path, method);
      candidates.push({ key: `${method} ${path}`, path, method, plain });
      const rawPaths = rawPathsByPlainName.get(plain) ?? new Set<string>();
      rawPaths.add(path);
      rawPathsByPlainName.set(plain, rawPaths);
      const constPrefixes = constPrefixesByPlainName.get(plain) ?? new Set<string>();
      for (const prefix of collectOperationConstPrefixes(
        op,
        componentRequestBodies,
        operationLabel(op, path, method),
      )) {
        constPrefixes.add(prefix);
      }
      constPrefixesByPlainName.set(plain, constPrefixes);
    }
  }

  const reservedList = [...reservedNames];
  const canonicalByPlainName = new Map<string, string | undefined>();
  for (const [plain, rawPaths] of rawPathsByPlainName) {
    // Every stem a name minted from this prefix can start with: the prefix in
    // each of its cleaned spellings, and each const value the operation can
    // prepend to it (`EmailTagsPostRequest` is `Email` + `TagsPost…`).
    const spellings = prefixSpellings(plain);
    const constPrefixes = ['', ...(constPrefixesByPlainName.get(plain) ?? [])];
    const stems = constPrefixes.flatMap((constPrefix) => spellings.map((spelling) => constPrefix + spelling));
    const reserved = stems.some((stem) => reservedList.some((name) => name.startsWith(stem)));
    canonicalByPlainName.set(plain, reserved ? undefined : canonicalPath(rawPaths));
  }

  const resolved = new Map<string, string>();
  for (const { key, path, method, plain } of candidates) {
    const keepsPlainName = canonicalByPlainName.get(plain) === path;
    resolved.set(key, keepsPlainName ? plain : derivePathModelBaseName(path, method, pathDisambiguator(path)));
  }
  return resolved;
}

/**
 * The one path in a group that is spelled most plainly by pathDeviation, or
 * undefined when two or more tie for it, so the choice never depends on the
 * order the paths were written in.
 */
function canonicalPath(rawPaths: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore: PathDeviation | undefined;
  let tied = false;
  for (const path of rawPaths) {
    const score = pathDeviation(path);
    const cmp = bestScore ? compareDeviation(score, bestScore) : -1;
    if (cmp < 0) {
      best = path;
      bestScore = score;
      tied = false;
    } else if (cmp === 0) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

/** See pathDeviation. */
type PathDeviation = [trailingSlash: number, customMethods: number, irregularSegments: number];

/**
 * How far a raw path's spelling is from the plain prefix it flattens to:
 * `[trailing slash, custom methods written after a colon, literal segments
 * with any character outside a-z0-9]`, compared lexicographically. `/notes`
 * scores [0, 0, 0] and `/notes/` [1, 0, 0]; `/notes/{id}` scores [0, 0, 0]
 * and `/notes/by-id` [0, 0, 1]. A custom method is counted on its own rather
 * than as an irregular segment, so the slash form wins whatever the verb's
 * spelling: `/pets/{id}:adopt` scores [0, 1, 0] against `/pets/{id}/adopt`
 * at [0, 0, 0], and `/pets/{id}:batchAdopt` [0, 1, 1] against
 * `/pets/{id}/batchAdopt` at [0, 0, 1]. A parameter segment is never
 * irregular, whatever follows its braces, so a path without a colon scores
 * as it did before custom methods were read: `/tags/{tag}.json` and
 * `/tags/{tag}/json` still tie.
 */
function pathDeviation(rawPath: string): PathDeviation {
  const trailingSlash = rawPath.length > 1 && rawPath.endsWith('/') ? 1 : 0;
  const segments = readPath(rawPath);
  const customMethods = segments.filter((segment) => segment.customMethod).length;
  const irregularSegments = segments.filter(
    (segment) => !segment.text.startsWith('{') && /[^a-z0-9]/.test(segment.text),
  ).length;
  return [trailingSlash, customMethods, irregularSegments];
}

function compareDeviation(a: PathDeviation, b: PathDeviation): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The first six hex characters of the SHA-1 of a raw path. */
function pathDisambiguator(rawPath: string): string {
  return createHash('sha1').update(rawPath).digest('hex').slice(0, 6);
}

/**
 * The spellings a path-based prefix could take if a name derived from it were
 * run through one of the parser's cleaning steps: the prefix itself (every
 * path-derived name uses it verbatim), cleanSchemaName's form (lead-word
 * singularization plus backend and ListItem-marker stripping),
 * resolveSchemaName's form (the same plus the project's schemaNameTransform),
 * and stripListItemMarkers alone, which nested-model and inline-enum
 * qualification apply to a parent name. Reserving by every spelling is the
 * second line of defence behind "use the base verbatim": a cleaning step added
 * later cannot let a derived name slip past the reservation. Empty spellings
 * are dropped so a degenerate prefix cannot match every reserved name.
 */
function prefixSpellings(prefix: string): string[] {
  const spellings = [prefix, cleanSchemaName(prefix), resolveSchemaName(prefix), stripListItemMarkers(prefix)];
  return [...new Set(spellings)].filter((spelling) => spelling.length > 0);
}

/**
 * The PascalCase const values an operationId-less operation can prepend to a
 * name minted from its prefix, read from the schemas its request body and 2xx
 * responses declare inline. A body `oneOf` variant pinning `kind: email`
 * yields `EmailTagsPostRequest` (deriveOneOfVariantName); a nested
 * `oneOf`/`anyOf` object variant yields `<Const><Parent><Field>`
 * (nameOneOfVariant, nameVariantModel). Every string const or single-value
 * enum of every inline object variant is collected, top level and nested — a
 * superset of whichever property each of those picks as the discriminator, so
 * the reservation can never be narrower than the naming. `$ref` targets are
 * components with names of their own and are not followed. A request body
 * `$ref` that cannot be resolved is left for buildOperation to report.
 *
 * Names that do not embed the prefix at all — a response `oneOf` variant
 * named from its bare const (`Email`, see deriveModelName in responses.ts)
 * or a `title`-mapped variant — are outside what a disambiguator can
 * separate and are not reserved here.
 */
function collectOperationConstPrefixes(
  op: OperationObject,
  componentRequestBodies: Record<string, Record<string, unknown>> | undefined,
  opLabel: string,
): Set<string> {
  const prefixes = new Set<string>();
  let body: RequestBodyObject | undefined;
  try {
    body = resolveRequestBodyRef(op.requestBody, componentRequestBodies, opLabel);
  } catch {
    body = undefined;
  }
  collectConstPrefixes(selectRequestBodyContent(body)?.schema, prefixes, 0);
  for (const [statusCode, response] of Object.entries(op.responses ?? {})) {
    // Only a key `extractResponses` reads as a 2xx status code: a range, a
    // fallback or a key OpenAPI does not define reserves nothing.
    const responseKey = classifyResponseKey(statusCode);
    if (responseKey.kind !== 'status' || responseKey.code < 200 || responseKey.code >= 300) continue;
    // A `$ref` into `components/responses` has no `content` here and is not
    // followed either: its inline body is named after the component, so the
    // consts it pins never prefix a path-derived name.
    for (const media of Object.values(response.content ?? {})) {
      collectConstPrefixes(media?.schema, prefixes, 0);
    }
  }
  return prefixes;
}

function collectConstPrefixes(schema: SchemaObject | undefined, out: Set<string>, depth: number): void {
  if (!schema || schema.$ref || depth > 16) return;
  for (const variants of [schema.oneOf, schema.anyOf]) {
    for (const variant of variants ?? []) {
      if (variant.$ref || !variant.properties) continue;
      for (const property of Object.values(variant.properties)) {
        const value = constStringOf(property);
        const prefix = value === null ? '' : toPascalCase(value);
        if (prefix) out.add(prefix);
      }
    }
  }
  const children: Array<SchemaObject | undefined> = [
    ...(schema.oneOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.allOf ?? []),
    schema.items,
    ...Object.values(schema.properties ?? {}),
    typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined,
  ];
  for (const child of children) {
    collectConstPrefixes(child, out, depth + 1);
  }
}

/** A property's pinned string value: a string `const`, or a single-value string `enum`. */
function constStringOf(property: SchemaObject | undefined): string | null {
  if (!property) return null;
  if (typeof property.const === 'string') return property.const;
  if (Array.isArray(property.enum) && property.enum.length === 1 && typeof property.enum[0] === 'string') {
    return property.enum[0];
  }
  return null;
}

function deriveResponseName(op: OperationObject | undefined, pathModelBaseName: string): string {
  if (op?.operationId) {
    return operationIdModelName(op.operationId, 'Response');
  }
  return pathModelBaseName + 'Response';
}

/**
 * Element type of the array an overridden `dataPath` names in one response
 * body. The IR answers first — the detected data array itself, an envelope
 * companion's field (companion models included, so the parser's own item
 * model is reused and follows any later renaming), or the response model's
 * fields — and the document (`schema`, classified under `contextName`)
 * answers when the path crosses a model the parser has not materialized,
 * minting inline items under a path-derived name.
 */
function resolveOverrideItemType(
  result: ResponseExtractionResult,
  schema: SchemaObject,
  contextName: string,
  dataPath: string,
  componentModels: Model[],
  componentSchemas?: Record<string, SchemaObject>,
  settle?: ItemSettlement,
): { itemType: TypeRef; inlineModels: Model[] } | undefined {
  if (dataPath === result.dataPath && result.itemType) return { itemType: result.itemType, inlineModels: [] };

  const pool = [
    ...result.inlineModels,
    ...(result.envelopeCompanions ?? []).flatMap((companion) => companion.models),
    ...componentModels,
  ];
  let fromIr: TypeRef | undefined;
  if (result.envelopeFields) {
    // The envelope was unwrapped, so its companions — not `result.response`,
    // which is already the data array — are where the path starts.
    const [head, ...rest] = dataPath.split('.');
    const companion = result.envelopeFields.find((field) => field.name === head);
    if (companion) fromIr = resolveDataPathItemType(companion.type, rest.join('.'), pool);
  } else {
    fromIr = resolveDataPathItemType(result.response, dataPath, pool);
  }
  if (fromIr) return { itemType: fromIr, inlineModels: [] };

  return resolveDataPathFromSchema(schema, dataPath, contextName, componentSchemas, settle);
}

/** What the explicit pagination override asks of response extraction. */
interface PaginationExtractionOptions {
  /** `strategy: 'none'`: keep a list envelope as a plain response model instead of unwrapping it. */
  disabled?: boolean;
  /** An explicit `dataPath` to resolve to the element type of the array it names. */
  dataPath?: string;
  /** Component models, so the IR walk can follow a `$ref` wrapper's fields. */
  componentModels?: Model[];
}

/**
 * The `components/responses` entry a response is written as a `$ref` to, or
 * undefined for an inline response. Only the outermost ref counts: it is the
 * name the operation uses, and the name a chain resolves through
 * (`resolveResponseRef`) stays the component's own business. The pointer is
 * matched whole and JSON Pointer escapes (RFC 6901 §4) undone, exactly as the
 * resolver does, so the name agrees with what it resolved.
 */
function componentResponseNameOf(resp: ResponseObject | ReferenceObject): string | undefined {
  if (!('$ref' in resp) || typeof resp.$ref !== 'string') return undefined;
  const match = /^#\/components\/responses\/(.+)$/.exec(resp.$ref);
  return match?.[1].replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * The model name a response's inline body is shared under when the response
 * is written as a `$ref` into `components/responses`: the name
 * `resolveComponentResponseModelNames` settled on for the component, or
 * `componentResponseModelName` when no map was built. Undefined for a
 * response written inline, and for a ref no component answers — the
 * operation then names the body as it names an inline one, and the resolver
 * has already warned about the ref. The one answer for every place a
 * response can be written (workos/oagen#301): an explicit status code,
 * success or error, `default` and a `1XX`–`5XX` range read it alike, so a
 * component returned at a 404 by one operation and as `default` by another
 * names one model.
 */
function sharedResponseModelName(
  resp: ResponseObject | ReferenceObject,
  ctx: ResponseTypingContext,
): string | undefined {
  const componentName = componentResponseNameOf(resp);
  if (componentName === undefined) return undefined;
  return ctx.componentResponseModelNames
    ? ctx.componentResponseModelNames.get(componentName)
    : componentResponseModelName(componentName);
}

/**
 * `<Component>Response`: the inline body of a response declared once under
 * `components/responses` and referenced from each operation that returns it.
 * It is named after the component, not the operation, so every referrer
 * shares one model (`PetFound` → `PetFoundResponse`) instead of minting a
 * `<Op>Response` copy each; the suffix is not doubled when the component is
 * already named `…Response`. Cleaned like an operationId-derived name, so
 * the stem (`componentResponseModelBase`) prefixes everything derived from
 * it — a list's `<Component>Item`, nested `<Component>Response…` models,
 * and the component's secondary bodies and headers
 * (`<Component><MediaType>Response`, `<Component><Header>`; see
 * `responseModelSite`).
 */
function componentResponseModelName(componentName: string): string {
  const base = toPascalCase(componentName);
  return cleanSchemaName(base.endsWith('Response') ? base : base + 'Response');
}

/** What a component response's inline body is named, and every model name it mints under that name. */
interface ComponentResponseNaming {
  name: string;
  /** The root model and everything nested under it, envelope companions included; empty for a body without a schema. */
  minted: readonly string[];
}

/**
 * The model name each component response's inline body is shared under,
 * decided once for the document: `componentResponseModelName`, stepped to the
 * first numbered form (`OwnerCardResponse2`, `…3`) under which neither it nor
 * any model the body mints — a nested object (`OwnerCardResponse2Detail`),
 * array items, union variants, envelope companions — is a name a component
 * schema (or a model a component field mints) or an earlier component
 * response already owns: `OwnerCard` beside a schema `OwnerCardResponse`, or
 * beside a schema `OwnerCardResponse2Detail`, or beside a component response
 * `OwnerCardResponse`. A shared name of another shape would otherwise be
 * folded by the later merge, which compares field names, onto a model with
 * other field types, silently; and naming such a body per operation instead
 * would hand two shared bodies of one operation (`OwnerCard` at 200,
 * `NewOwner` at 201) the same `<Op>Response`. The names are read with the
 * extractor the operation will use, under the candidate name, so the whole
 * body moves together and the reference and the models agree by
 * construction; a chain of refs is followed to the body silently, since the
 * operation declaring the ref reports a bad one when it reads it. A clash the
 * stem does not reach — a titled variant, named the same under any stem —
 * stops the stepping, and the merge passes settle it as for any operation
 * body. A component already named like its derived name
 * (`OwnerCardResponse` → `OwnerCardResponse`) keeps it ahead of one that
 * only derives it; the rest are decided in document order, so the outcome
 * never depends on which operation is read first. Every component ends up in
 * the map, so every operation that returns it shares the one model.
 */
function resolveComponentResponseModelNames(
  componentResponses: Record<string, Record<string, unknown>> | undefined,
  takenModels: readonly Model[],
  componentSchemas?: Record<string, SchemaObject>,
): ReadonlyMap<string, ComponentResponseNaming> {
  const taken = new Set(takenModels.map((model) => model.name));
  const componentNames = Object.keys(componentResponses ?? {});
  const exact = componentNames.filter((name) => componentResponseModelName(name) === name);
  const ordered = [...exact, ...componentNames.filter((name) => !exact.includes(name))];
  const names = new Map<string, ComponentResponseNaming>();
  for (const componentName of ordered) {
    const schema = componentResponseBodySchema(componentName, componentResponses ?? {});
    const mintedUnder = (name: string): string[] => (schema ? bodyModelNames(schema, name, componentSchemas) : []);
    const base = componentResponseModelName(componentName);
    let name = base;
    let minted = mintedUnder(name);
    let previous: string[] | undefined;
    // Unbounded on purpose: `taken` is finite and every step is a new
    // numbered stem, so a free one is always reached; only a clash the stem
    // does not reach (`stuck`) ends the search without one.
    for (let n = 2; ; n++) {
      const clashing = [name, ...minted].filter((candidate) => taken.has(candidate));
      if (clashing.length === 0) break;
      const stuck =
        previous !== undefined && clashing.length === previous.length && clashing.every((c) => previous!.includes(c));
      if (stuck) break;
      previous = clashing;
      name = `${base}${n}`;
      minted = mintedUnder(name);
    }
    taken.add(name);
    for (const minted_ of minted) taken.add(minted_);
    names.set(componentName, { name, minted });
  }
  return names;
}

/** The schema a component response's body is read from, through a chain of refs, silently; undefined without one. */
function componentResponseBodySchema(
  componentName: string,
  componentResponses: Record<string, Record<string, unknown>>,
): SchemaObject | undefined {
  const component = componentResponses[componentName];
  if (!component) return undefined;
  const resolved = resolveResponseRef<ResponseObject>(
    component as ResponseObject | ReferenceObject,
    componentResponses,
    `components/responses/${componentName}`,
    'override',
    'silent',
  );
  return primaryBodySchema(resolved).schema;
}

/** Every model name a response body mints under `contextName`: the extractor's models and its envelope companions'. */
function bodyModelNames(
  schema: SchemaObject,
  contextName: string,
  componentSchemas: Record<string, SchemaObject> | undefined,
): string[] {
  const body = classifyAndExtractResponse(schema, contextName, componentSchemas);
  return [
    ...body.inlineModels.map((model) => model.name),
    ...(body.envelopeCompanions ?? []).flatMap((companion) => companion.models.map((model) => model.name)),
  ];
}

/**
 * The stem every model derived from a component response starts with (see
 * operationIdModelBase for the argument): the body (`CardResponse`, or the
 * `CardResponse2` it steps to) and the models nested under it, an inline
 * body under another media type (`CardApplicationYamlResponse`) and an
 * object-shaped header (`CardXMeta`), the last two named from the shared
 * body name less its `Response` (`responseModelSite`), which starts with
 * this stem. Reserved by resolvePathModelBaseNames so no path-derived name
 * takes it.
 */
function componentResponseModelBase(componentName: string): string {
  return cleanSchemaName(toPascalCase(componentName).replace(/Response$/, ''));
}

/**
 * Media types the fixed-order response pick types as a plain string without
 * reading their schema, in the order it checks them.
 */
const TEXT_RESPONSE_MEDIA_TYPES: readonly string[] = ['text/plain', 'text/html', 'text/xml', 'application/xml'];

/** Where an inline body declared for a secondary media type gets its name. */
interface ContentModelNaming {
  /** The stem: the operation's (`RenderPetCard`; with the response's label for a fallback, `ListPetsDefault`) or a component response's (`Card`). */
  base: string;
  /** `Response` for a success or fallback entry, `Error` for an error entry; `Response` for a component response wherever it is mounted. */
  suffix: string;
  /** A status code, or the label of a fallback response (`Default`, `ClientError`). */
  statusCode: number | string;
}

/**
 * Where the models a response declares besides its primary body — an inline
 * object under another media type, an object-shaped header — get their
 * names (`responseModelSite`). The primary body's own name is decided
 * elsewhere (`componentResponseModelName`, `deriveResponseName`,
 * `deriveErrorModelName`, `deriveFallbackResponseName`).
 */
interface ResponseModelSite {
  /**
   * The stem every such model starts with: the component's
   * (`componentResponseModelBase`: `Card`) for a response written as a
   * `$ref` into `components/responses`, else the operation's response stem
   * (`GetNote`; with the response's label for a fallback, `ListPetsDefault`).
   */
  stem: string;
  /**
   * Set for a component response: its models are named from the component
   * alone, so the same names come out of every operation that returns it, at
   * whatever status code or fallback key, and the shape registry shares one
   * model among them.
   */
  shared: boolean;
  /** What qualifies a header's models: `stem` for a component response, the service for an inline one; none without a service. */
  headerParent: string | undefined;
}

/**
 * Decide where everything a response declares besides its primary body is
 * named from. A response written as a `$ref` into `components/responses` is
 * one thing however many operations return it and whatever key each mounts
 * it at, so an inline object under another media type and an object-shaped
 * header are named from the stem of the model its body is shared under
 * (`componentModelName`, see `sharedResponseModelName`) — that name less its
 * `Response`, the way the operation's stem is `deriveResponseName` less its
 * `Response`: `Card` + `ApplicationYaml` + `Response` for the body under
 * `application/yaml`, `Card` + `XMeta` for an `X-Meta` header, and
 * `CardResponse2…` when the body stepped to `CardResponse2` — the same names
 * from `GET /notes` at 200, from `GET /pets` at 404 and from a `default` or
 * `4XX` that refs it, so every operation shares one model of each
 * (workos/oagen#302). An inline response's are named after the operation:
 * the response stem, media type and the entry's role
 * (`GetNoteApplicationYamlResponse`, `GetNoteApplicationYamlError`,
 * `ListPetsDefaultTextPlainResponse`) and the service plus header name
 * (`NotesXMeta`). The names of either kind go through the shape registry as
 * before (`resolveDeferredInlineTypes`), so one a component schema or
 * another site owns with a shape it does not share steps to the kind's next
 * candidate.
 */
function responseModelSite(
  componentModelName: string | undefined,
  operationStem: string,
  ctx: ResponseTypingContext,
): ResponseModelSite {
  if (componentModelName !== undefined) {
    const stem = componentModelName.replace(/Response$/, '');
    return { stem, shared: true, headerParent: stem };
  }
  return {
    stem: operationStem,
    shared: false,
    headerParent: ctx.serviceName ? toPascalCase(ctx.serviceName) : undefined,
  };
}

/**
 * The naming of an inline body under a secondary media type of one response
 * entry: the site's stem, then the entry's role — `Error` for an error
 * entry, `Response` otherwise — except that a component response's bodies
 * are `Response` at any key, as its primary body is `<Component>Response`
 * whether an operation mounts it at 200 or 404.
 */
function contentModelNaming(
  site: ResponseModelSite,
  role: 'Response' | 'Error',
  statusCode: number | string,
): ContentModelNaming {
  return { base: site.stem, suffix: site.shared ? 'Response' : role, statusCode };
}

/**
 * Read a response's `content` map into the media types it declares — in
 * document order and verbatim, parameters, vendor suffixes and wildcards
 * included — with a type for each. A media type is typed the way `response`
 * is when it is the only one declared, so the entry for `primaryContentType`
 * (the one the fixed-order pick read `primaryType` from) carries that very
 * TypeRef and every other entry goes through `typeSecondaryContent`. Returns
 * `undefined` when the response declares no media type at all, so the caller
 * leaves both keys off.
 */
function extractResponseContents(
  content: Record<string, { schema?: SchemaObject }> | undefined,
  primaryContentType: string | undefined,
  primaryType: TypeRef | undefined,
  naming: ContentModelNaming,
  ctx: ResponseTypingContext,
): { contentTypes: string[]; contents: ResponseContent[] } | undefined {
  if (!content) return undefined;
  const contentTypes = Object.keys(content);
  if (contentTypes.length === 0) return undefined;
  const contents = contentTypes.map((contentType) => {
    const entry: ResponseContent = { contentType, type: { kind: 'primitive', type: 'unknown' } };
    entry.type =
      primaryType !== undefined && contentType === primaryContentType
        ? primaryType
        : typeSecondaryContent(contentType, content[contentType]?.schema, naming, ctx, entry, contentTypes);
    return entry;
  });
  return { contentTypes, contents };
}

/**
 * Type a media type the fixed-order pick did not choose, exactly as it would
 * have been typed had it been the only one declared: `application/octet-stream`
 * and `application/pdf` are binary and the text and XML types are strings
 * whatever their schema says, any other media type is typed from its schema,
 * and one without a schema is `unknown`. The one addition is that an inline
 * object under such a media type is materialized — the primary pick's
 * `...Response` name belongs to the primary body, so this one is named after
 * its media type as well, from the stem `naming` carries —
 * `RenderPetCardTextHtmlResponse` for an inline response,
 * `CardApplicationYamlResponse` for one shared through `components/responses`
 * (`responseModelSite`) — with the media type's fragment taken from its
 * essence among its `siblings` (the response's content keys), so a
 * key keeps its model name however it is spelled and two spellings of one
 * essence side by side are told apart by their parameters
 * (`mediaTypeNameFragment`). That naming waits for every primary model
 * (`resolveDeferredInlineTypes`), so a schema is deferred and `target.type`
 * — returned here as a placeholder — filled in then.
 */
function typeSecondaryContent(
  contentType: string,
  schema: SchemaObject | undefined,
  naming: ContentModelNaming,
  ctx: ResponseTypingContext,
  target: ResponseContent,
  siblings: readonly string[],
): TypeRef {
  // Parameters and case do not change what a body is: `application/pdf;
  // version=1.7` is as binary as `application/pdf`, `TEXT/PLAIN; charset=utf-8`
  // as much a string as `text/plain`. The key itself stays as written.
  const essence = mediaTypeEssence(contentType);
  if (essence === 'application/octet-stream' || essence === 'application/pdf') {
    return { kind: 'primitive', type: 'string', format: 'binary' };
  }
  if (TEXT_RESPONSE_MEDIA_TYPES.includes(essence)) return { kind: 'primitive', type: 'string' };
  if (!schema) return { kind: 'primitive', type: 'unknown' };
  ctx.deferred.push({
    kind: 'content',
    schema,
    name: `${naming.base}${mediaTypeNameFragment(contentType, siblings)}${naming.suffix}`,
    statusCode: naming.statusCode,
    operationQualifier: ctx.operationQualifier,
    componentSchemas: ctx.componentSchemas,
    targets: [target],
  });
  return target.type;
}

/**
 * `<Op>DefaultResponse`, `<Op>ClientErrorResponse`: a fallback body's inline
 * model, named like the primary body's `<Op>Response` with the response's
 * label (`Default`, or the word for its range) in between. Starts with the
 * operation's stem, so `operationIdModelBase` reserves it with the rest. A
 * fallback written as a `$ref` into `components/responses` is named after
 * the component instead (`sharedResponseModelName`); this name then only
 * prefixes the inline bodies of its secondary media types.
 */
function deriveFallbackResponseName(op: OperationObject | undefined, pathModelBaseName: string, label: string): string {
  if (op?.operationId) {
    return operationIdModelName(op.operationId, `${label}Response`);
  }
  return `${pathModelBaseName}${label}Response`;
}

/**
 * The model name an inline error body is materialized under: the operation's
 * stem plus `Error<code>` (`GetPetError404`), so two operations' inline 404s
 * never share one model, nor do two status codes of one operation. Built by
 * the rule `deriveResponseName` uses for `<Op>Response`: `operationIdModelName`
 * when the operation has an `operationId`, else the path-derived prefix
 * (`PetsByPetIdGetError404`), which `resolvePathModelBaseNames` already keeps
 * clear of every component schema name.
 */
function deriveErrorModelName(op: OperationObject | undefined, pathModelBaseName: string, code: number): string {
  if (op?.operationId) {
    return operationIdModelName(op.operationId, `Error${code}`);
  }
  return `${pathModelBaseName}Error${code}`;
}

/**
 * Where the fallback responses (`default`, `1XX`–`5XX`) of one operation
 * land while its responses are read, with what typing their bodies and
 * headers needs. An entry is attached as its key is read; a body with an
 * inline schema is deferred like a header's (`typeFallbackBody`) and its
 * `type` filled in once every operation has been read.
 */
interface FallbackResponseSink {
  op: OperationObject | undefined;
  pathModelBaseName: string;
  opLabel: string;
  ctx: ResponseTypingContext;
  defaultResponse?: DefaultResponse;
  /** In document order. */
  rangeResponses: RangeResponse[];
}

/**
 * Read a Responses Object key that is not a status code into `sink`:
 * `default` and a range are kept; an `x-` key is a specification extension
 * and carries no response; a key OpenAPI does not define (`error`, `6XX`,
 * `600` — see `classifyResponseKey`) is warned about, then ignored, instead
 * of being dropped silently. A status code never reaches here: the caller
 * reads it into `successResponses` or `errors`.
 */
function readFallbackResponse(
  responseKey: Exclude<ResponseKey, { kind: 'status' }>,
  key: string,
  resp: ResponseObject | ReferenceObject,
  sink: FallbackResponseSink,
): void {
  if (responseKey.kind === 'extension') return;
  if (responseKey.kind === 'unrecognized') {
    warnUnrecognizedResponseKey(key, sink.opLabel);
    return;
  }
  const range = responseKey.kind === 'range' ? responseKey.range : undefined;
  if (range && sink.rangeResponses.some((entry) => entry.range === range)) {
    // `4XX` and `4xx` side by side: JSON allows the pair, OpenAPI does not.
    console.warn(`[oagen] Warning: Duplicate "${range}" response on ${sink.opLabel}; keeping the first`);
    return;
  }
  // The bundler leaves `$ref: '#/components/responses/…'` in place, and a
  // Reference Object has no `headers` or `content` of its own to read.
  const resolved = resolveResponseRef<ResponseObject>(
    resp,
    sink.ctx.componentResponses,
    `${key} response of ${sink.opLabel}`,
    sink.ctx.refSiblingDescriptions,
  );
  // A ref into `components/responses` names the body after the component,
  // as it does at a status code, so every operation that returns the
  // component — at any status, `default` or a range — shares one model; its
  // secondary bodies and headers follow the same name (`responseModelSite`).
  const componentModelName = sharedResponseModelName(resp, sink.ctx);
  // The entry is filled in place: a deferred body's `type` lands on this
  // very object once every operation has been read.
  if (range) {
    const entry: RangeResponse = { range };
    fillFallbackResponse(entry, resolved, STATUS_RANGE_LABELS[range], sink, componentModelName);
    sink.rangeResponses.push(entry);
  } else {
    const entry: DefaultResponse = {};
    fillFallbackResponse(entry, resolved, 'Default', sink, componentModelName);
    sink.defaultResponse = entry;
  }
}

/**
 * Read the body, media types and headers of one fallback response onto
 * `entry`; a key is left off when absent. The body is named after the
 * operation and the response's label (`deriveFallbackResponseName`) or, when
 * the response is a `$ref` into `components/responses`, after the component
 * (`componentModelName`, see `sharedResponseModelName`), the name every
 * operation returning the component shares. The body is read before the
 * headers so its deferred models are named first, as they were when every
 * fallback body was typed ahead of every header. The media types are read
 * exactly as a success entry's: every one declared, the one `type` was read
 * from sharing its TypeRef, each other typed on its own — an inline object
 * under `text/plain` of the `default` response is `<Op>DefaultTextPlainResponse`.
 * The secondary bodies and headers of a response written as a `$ref` into
 * `components/responses` are named from the component's shared body name
 * (`responseModelSite`), as an explicit status code's are.
 */
function fillFallbackResponse(
  entry: DefaultResponse | RangeResponse,
  resp: ResponseObject,
  label: string,
  sink: FallbackResponseSink,
  componentModelName: string | undefined,
): void {
  const operationName = deriveFallbackResponseName(sink.op, sink.pathModelBaseName, label);
  const contextName = componentModelName ?? operationName;
  const site = responseModelSite(componentModelName, operationName.replace(/Response$/, ''), sink.ctx);
  const json = jsonResponseSchema(resp);
  // Shared by reference with the deferred body, so the content entry of the
  // media type `type` was read from can join it once it exists.
  const targets: Array<{ type?: TypeRef }> = [entry];
  if (json) {
    entry.type = typeFallbackBody(json.schema, contextName, label, sink, targets, componentModelName !== undefined);
  }
  const contents = extractResponseContents(
    resp.content,
    json?.contentType,
    entry.type,
    contentModelNaming(site, 'Response', label),
    sink.ctx,
  );
  if (contents) {
    entry.contentTypes = contents.contentTypes;
    entry.contents = contents.contents;
    const own = contents.contents.find((content) => content.contentType === json?.contentType);
    if (own) targets.push(own);
  }
  const headers = extractResponseHeaders(resp.headers, sink.opLabel, label, sink.ctx, site.headerParent);
  if (headers) entry.headers = headers;
  // The response's own `description`, read as for a success or error entry —
  // a sibling beside a `$ref` included, since `resolveResponseRef` kept it.
  const description = presentText(resp.description);
  if (description) entry.description = description;
}

/**
 * Type a fallback body and materialize every model it names, under a name no
 * other model owns. A `$ref` is the referenced model. An inline schema is
 * deferred like a header's or a secondary body's: once every operation has
 * been read (`resolveDeferredInlineTypes`) it is extracted as if it were a
 * field named `contextName` of a parent with no name, through the extractor
 * every field goes through — so every shape a field can take (a nullable
 * object, an array or map of objects, `oneOf`/`anyOf` variants, an `allOf`
 * merge, nested objects) is materialized under the name `schemaToTypeRef`
 * references it by, by construction — and checked against the spec-wide
 * registry, so a component, or another operation's body, that happens to be
 * named like the fallback is never overwritten by `mergeInlineResponseModels`:
 * a clash moves the whole body to the next free name (`<Op>DefaultResponse2`,
 * `…3`), nested models and ref together. A body a `components/responses`
 * entry declares (`componentBody`) is named after the component
 * (`<Component>Response`) and shares the model of every other site that
 * returns the component, whatever its kind. List envelope and
 * resource-wrapper detection are skipped on purpose: a fallback body is not
 * what the SDK method returns, so it must not drive pagination. Returns the
 * placeholder the resolution replaces on `target`.
 */
function typeFallbackBody(
  schema: SchemaObject,
  contextName: string,
  label: string,
  sink: FallbackResponseSink,
  targets: Array<{ type?: TypeRef }>,
  componentBody: boolean,
): TypeRef {
  if (schema.$ref) return schemaToTypeRef(schema, contextName);
  sink.ctx.deferred.push({
    kind: 'fallback',
    schema,
    name: contextName,
    statusCode: label,
    operationQualifier: sink.ctx.operationQualifier,
    componentSchemas: sink.ctx.componentSchemas,
    targets,
    ...(componentBody && { componentBody }),
  });
  return { kind: 'primitive', type: 'unknown' };
}

/**
 * Type an error response's JSON body and materialize every model it names,
 * under a name no other model owns (workos/oagen#236: `schemaToTypeRef` alone
 * named a model — `Error404` — that nothing created). A `$ref` is the
 * referenced model. An inline schema is deferred exactly like a fallback
 * body's (`typeFallbackBody`): once every operation has been read
 * (`resolveDeferredInlineTypes`) it is extracted as if it were a field named
 * `contextName` of a parent with no name, so every shape a field can take — a
 * plain or nullable object, an array or map of objects, `oneOf`/`anyOf`
 * variants (`GetPetError400`, `GetPetError400WithCode`,
 * `AuthGetPetError400`), an `allOf` merge with `$ref` branches, nested
 * objects (`GetPetError404Details`) — is materialized under the name
 * `schemaToTypeRef` references it by, by construction, and checked against
 * the spec-wide registry: a name a component schema, a model nested in one
 * (`GetPet.error404` owns `GetPetError404`), a header or another operation's
 * body already owns with a shape it does not share moves the whole body to
 * the next free name (`GetPetError404Body`, `…Body2`), nested models and ref
 * together; a shape the owner shares (`ownerShares`) takes the name. A
 * titled variant that clashes (`Circle`) is
 * reserved and qualified (`CircleGetPetError400`), as under any deferred
 * kind. A body that is itself an inline enum, or an array of one, mints no
 * model and is promoted to `spec.enums` by `collectInlineEnumsFromOperations`.
 * A body a `components/responses` entry declares (`componentBody`) is named
 * after the component (`<Component>Response`) and steps by number
 * (`<Component>Response2`) rather than by `Body`, the way the same
 * component's body steps at a `default` or range site, so every site that
 * returns the component settles on one model. List envelope and
 * resource-wrapper detection are skipped on purpose, as for a fallback body.
 * Returns the placeholder the resolution replaces on every target.
 */
function typeErrorBody(
  schema: SchemaObject,
  contextName: string,
  code: number,
  ctx: ResponseTypingContext,
  targets: Array<{ type?: TypeRef }>,
  componentBody: boolean,
): TypeRef {
  if (schema.$ref) return schemaToTypeRef(schema, contextName);
  ctx.deferred.push({
    kind: 'error',
    schema,
    name: contextName,
    statusCode: code,
    operationQualifier: ctx.operationQualifier,
    componentSchemas: ctx.componentSchemas,
    targets,
    ...(componentBody && { componentBody }),
  });
  return { kind: 'primitive', type: 'unknown' };
}

/**
 * The fixed-order pick of a success response's body: the JSON schema when a
 * JSON media type is declared (`application/json` by essence, then `+json`);
 * else a binary (`application/octet-stream`, `application/pdf`) or text
 * (`TEXT_RESPONSE_MEDIA_TYPES`) media type, typed as a string without reading
 * its schema; else the first media type that declares a schema; else the
 * first declared, which reads as `unknown`. Media types are compared by
 * essence (`application/pdf; foo=bar` is as binary as `application/pdf`,
 * `TEXT/PLAIN; charset=utf-8` as much a string as `text/plain`) and
 * `contentType` is the key as written. `extractResponses` reads a 2xx body
 * through this, and `resolvePathModelBaseNames` asks the same question of a
 * component response, so the names it reserves are the ones the operation
 * will mint, whatever media type the body is declared under.
 */
function primaryBodySchema(resp: ResponseObject): { contentType?: string; schema?: SchemaObject; type?: TypeRef } {
  const json = jsonResponseSchema(resp);
  if (json) return { contentType: json.contentType, schema: json.schema };
  const content = resp.content;
  if (!content) return {};
  const keyWithEssence = (essence: string): string | undefined =>
    Object.keys(content).find((contentType) => mediaTypeEssence(contentType) === essence);
  const binaryKey = keyWithEssence('application/octet-stream') ?? keyWithEssence('application/pdf');
  if (binaryKey) return { contentType: binaryKey, type: { kind: 'primitive', type: 'string', format: 'binary' } };
  const textKey = TEXT_RESPONSE_MEDIA_TYPES.map(keyWithEssence).find((key) => key !== undefined);
  if (textKey) return { contentType: textKey, type: { kind: 'primitive', type: 'string' } };
  // The first media type that declares a schema; when none does, the first
  // declared is the primary and reads as unknown.
  const entries = Object.entries(content);
  const first = entries.find(([, media]) => media?.schema) ?? entries[0];
  return first ? { contentType: first[0], schema: first[1]?.schema } : {};
}

/**
 * The schema of a response's JSON body, with the media type it was declared
 * under as written: `application/json` first, else a `+json` media type
 * (`application/problem+json` is the usual shape of a `default` error),
 * matched by essence — parameters (`; charset=utf-8`) stripped, case folded.
 * Other media types type nothing, for an error entry as for a fallback.
 */
function jsonResponseSchema(resp: ResponseObject): { contentType: string; schema: SchemaObject } | undefined {
  const entries = Object.entries(resp.content ?? {}).filter(([, media]) => media?.schema);
  // The one JSON rule requests and responses share (`isJsonMediaType`):
  // `application/json` itself first, then any `+json` type.
  const match =
    entries.find(([mediaType]) => isPlainJsonMediaType(mediaType)) ??
    entries.find(([mediaType]) => isJsonMediaType(mediaType));
  return match && match[1].schema ? { contentType: match[0], schema: match[1].schema } : undefined;
}

/**
 * The type of a body the document does not describe:
 * `{ kind: 'primitive', type: 'unknown' }`. A 3xx entry's `type` is always
 * this; a 2xx entry's is this until a media-type rule types it; and an
 * operation's `response` is this when the operation declares no 2xx or 3xx
 * response at all — only `default`, ranges or errors, an empty `responses`
 * map, or no `responses` key — so an emitter never types a return value the
 * document does not describe. Each call returns a new object.
 */
function undescribedBodyType(): TypeRef {
  return { kind: 'primitive', type: 'unknown' };
}

function extractResponses(
  responses: Record<string, ResponseObject> | undefined,
  op: OperationObject | undefined,
  pathModelBaseName: string,
  path?: string,
  method?: HttpMethod,
  componentSchemas?: Record<string, SchemaObject>,
  ctx: ResponseTypingContext = { operationQualifier: '', deferred: [] },
  pagination: PaginationExtractionOptions = {},
): {
  response: TypeRef;
  responseHeaders?: ResponseHeader[];
  responseContentTypes?: string[];
  responseContents?: ResponseContent[];
  responseDescription?: string;
  /** The status code of the entry `response` was read from; undefined when no 2xx/3xx is declared. */
  responseStatusCode?: number;
  successResponses?: SuccessResponse[];
  errors: ErrorResponse[];
  /** The `default` response, when the operation declares one. */
  defaultResponse?: DefaultResponse;
  /** The `1XX`–`5XX` range responses in declaration order, when the operation declares any. */
  rangeResponses?: RangeResponse[];
  inlineModels: Model[];
  isPaginated: boolean;
  dataPath?: string;
  dataDescription?: string;
  itemType?: TypeRef;
  envelopeFields?: Field[];
  endOfIteration?: PaginationEndOfIteration;
  /** Element type of the array the override's `dataPath` names; unset when it does not resolve. */
  overrideItemType?: TypeRef;
  envelopeCompanions?: EnvelopeCompanion[];
} {
  const errors: ErrorResponse[] = [];
  let response: TypeRef = undescribedBodyType();
  let responseHeaders: ResponseHeader[] | undefined;
  let responseContentTypes: string[] | undefined;
  let responseContents: ResponseContent[] | undefined;
  let responseDescription: string | undefined;
  let inlineModels: Model[] = [];
  let isPaginated = false;
  let dataPath: string | undefined;
  let dataDescription: string | undefined;
  let itemType: TypeRef | undefined;
  let envelopeFields: Field[] | undefined;
  let endOfIteration: PaginationEndOfIteration | undefined;
  let overrideItemType: TypeRef | undefined;
  let envelopeCompanions: EnvelopeCompanion[] | undefined;

  // An operation without a `responses` object declares no success response,
  // so `response` is `unknown` here as it is for one that declares only
  // `default`, ranges or errors.
  if (!responses) return { response, errors, inlineModels, isPaginated };

  const allSuccessResponses: SuccessResponse[] = [];
  const opLabel = operationLabel(op, path ?? '/', method ?? 'get');
  // Every 2xx body's classification, by status code. The models of all of
  // them are kept — `successResponses` references each — while the paging
  // fields are read from the status chosen as primary once every status code
  // has been read.
  const bodyResults = new Map<number, ResponseExtractionResult>();
  // The operation's response stem, which names an inline response's
  // secondary bodies (`RenderPetCard` + `TextHtml` + `Response`) — a
  // component response's are named from the component instead
  // (`responseModelSite`).
  const operationStem = deriveResponseName(op, pathModelBaseName).replace(/Response$/, '');
  const fallback: FallbackResponseSink = { op, pathModelBaseName, opLabel, ctx, rangeResponses: [] };
  // Each classified body's schema, for resolving an overridden `dataPath`
  // through the document when the IR cannot answer.
  const bodySchemas = new Map<number, SchemaObject>();

  for (const [statusCode, rawResponse] of Object.entries(responses)) {
    // The whole key decides what it names (`classifyResponseKey`): `default`
    // and `1XX`–`5XX` are routed to their own fields, an `x-` extension is
    // skipped, and a key OpenAPI does not define (`6XX`, `600`) is warned
    // about and ignored. Only a three-digit 100–599 key reaches the branches
    // below, so no digit-prefixed key is ever read as a status code.
    const responseKey = classifyResponseKey(statusCode);
    if (responseKey.kind !== 'status') {
      readFallbackResponse(responseKey, statusCode, rawResponse, fallback);
      continue;
    }
    const code = responseKey.code;
    // The bundler leaves `$ref: '#/components/responses/…'` in place, and a
    // Reference Object has no `headers` or `content` of its own to read, so
    // the ref is resolved before either is. Only a status code one of the
    // branches below reads is resolved: `default`, a `2XX` range and an `x-`
    // extension are left as written, as nothing here reads them.
    const resp =
      code >= 200
        ? resolveResponseRef<ResponseObject>(
            rawResponse,
            ctx.componentResponses,
            `${statusCode} response of ${opLabel}`,
            ctx.refSiblingDescriptions,
          )
        : rawResponse;
    // Set when the response came from a component: its inline body is then
    // named after the component, shared by every operation that returns it —
    // at a status code, as `default` or in a range (`readFallbackResponse`
    // asks the same helper).
    const componentModelName = code >= 200 ? sharedResponseModelName(rawResponse, ctx) : undefined;
    // Where this response's secondary bodies and headers are named from: the
    // component's shared body name for a `$ref` into `components/responses`,
    // else the operation.
    const site = responseModelSite(componentModelName, operationStem, ctx);
    // Headers belong to the status code they are declared on, success or
    // error alike: `Location` on a 201/302, `Retry-After` on a 429. A 1xx
    // response, which no branch below keeps, declares none worth
    // materializing models for; a fallback response's were read above.
    const headers =
      code >= 200 ? extractResponseHeaders(resp.headers, opLabel, code, ctx, site.headerParent) : undefined;
    // The response's own `description`, success or error alike. Blank text
    // counts as absent, the way an operation's summary is read, and the key is
    // only added when there is something to keep. A `$ref` into
    // `components/responses` was resolved above, so the component's own
    // `description` is read; a sibling written next to the `$ref` wins in an
    // OAS 3.1 document and is ignored in 3.0 (`ctx.refSiblingDescriptions`).
    const description = presentText(resp.description);

    if (code >= 200 && code < 300) {
      let extractedType: TypeRef = undescribedBodyType();
      // The body schema to classify: the JSON one when a JSON media type is
      // declared (`application/json` by essence, then `+json`), else — past
      // the binary and text media types typed below without a schema — the
      // first other media type that declares one. Either way it goes through
      // `classifyAndExtractResponse`, so its inline models are created and
      // the response never references a model the parser did not emit.
      // The fixed-order pick (`primaryBodySchema`): `primaryContentType` is
      // the media type `extractedType` is read from, as written, so its
      // `contents` entry can share that TypeRef instead of re-deriving it.
      const pick = primaryBodySchema(resp);
      const bodySchema = pick.schema;
      const primaryContentType = pick.contentType;
      if (pick.type) extractedType = pick.type;
      if (bodySchema) {
        const contextName = componentModelName ?? deriveResponseName(op, pathModelBaseName);
        // An explicit `dataPath` is handed to classification only when it
        // reaches an array in this body; one that does not is left for the
        // override's own warning, and detection stands.
        const dataPathOverride =
          pagination.disabled ||
          pagination.dataPath === undefined ||
          !resolveDataPathFromSchema(bodySchema, pagination.dataPath, contextName, componentSchemas)
            ? undefined
            : pagination.dataPath;
        // The primary body's array items are settled against the registry
        // (`typeInlineItems`); the dry run that reads a component response's
        // names (`bodyModelNames`) passes none and mints nothing into it.
        const result = classifyAndExtractResponse(bodySchema, contextName, componentSchemas, {
          paginationDisabled: pagination.disabled,
          dataPathOverride,
          ...(ctx.registry && { settle: { registry: ctx.registry, operation: ctx.operationQualifier } }),
        });
        extractedType = result.response;
        bodyResults.set(code, result);
        bodySchemas.set(code, bodySchema);
      }
      const contents = extractResponseContents(
        resp.content,
        primaryContentType,
        extractedType,
        contentModelNaming(site, 'Response', code),
        ctx,
      );
      allSuccessResponses.push({
        statusCode: code,
        type: extractedType,
        ...(headers && { headers }),
        ...(description && { description }),
        ...contents,
      });
    } else if (code >= 300 && code < 400) {
      // 3xx redirects — include so emitter can detect redirect endpoints. The
      // type is not read from any media type, so every content entry is typed
      // on its own.
      const contents = extractResponseContents(
        resp.content,
        undefined,
        undefined,
        contentModelNaming(site, 'Response', code),
        ctx,
      );
      allSuccessResponses.push({
        statusCode: code,
        type: undescribedBodyType(),
        ...(headers && { headers }),
        ...(description && { description }),
        ...contents,
      });
    } else if (code >= 400) {
      const json = jsonResponseSchema(resp);
      // The entry is filled in place: an inline body is materialized under an
      // operation-qualified name — or the component's, for a `$ref` response
      // — once every operation has been read, and its `type` lands on this
      // very object (`typeErrorBody`). The content entry the body was read
      // from shares that TypeRef, so it joins the targets below.
      const entry: ErrorResponse = { statusCode: code, type: undefined };
      const targets: Array<{ type?: TypeRef }> = [entry];
      const type = json
        ? typeErrorBody(
            json.schema,
            componentModelName ?? deriveErrorModelName(op, pathModelBaseName, code),
            code,
            ctx,
            targets,
            componentModelName !== undefined,
          )
        : undefined;
      entry.type = type;
      const contents = extractResponseContents(
        resp.content,
        json?.contentType,
        type,
        contentModelNaming(site, 'Error', code),
        ctx,
      );
      // An error's `type` is its JSON body by definition — `application/json`,
      // else a `+json` media type (`jsonResponseSchema`) — so the lists are kept
      // only when they say something `type` does not: another media type, a
      // JSON body `type` could not be read from, or a JSON media type that is
      // not the plain `application/json` a reader would otherwise assume. The
      // common lone `application/json` with a schema keeps its shape.
      const beyondType =
        contents &&
        (json?.contentType !== 'application/json' || contents.contents.some((content) => content.type !== type))
          ? contents
          : undefined;
      if (headers) entry.headers = headers;
      if (description) entry.description = description;
      if (beyondType) {
        entry.contentTypes = beyondType.contentTypes;
        entry.contents = beyondType.contents;
        const own = beyondType.contents.find((content) => content.contentType === json?.contentType);
        if (own) targets.push(own);
      }
      errors.push(entry);
    }
  }

  // Primary response = lowest status code whose type is not `unknown` (the
  // lowest 2xx with a typed body; a 3xx entry is always `unknown`), falling
  // back to the lowest declared code (an untyped 2xx, or a 3xx when there is
  // no 2xx). With no 2xx or 3xx at all, `response` stays `unknown` — the type
  // of a body the document does not describe — with no headers, description
  // or media types; a `2XX` range or `default` body is never promoted into it.
  let primaryStatus: number | undefined;
  if (allSuccessResponses.length > 0) {
    const sorted = [...allSuccessResponses].sort((a, b) => a.statusCode - b.statusCode);
    const primary =
      sorted.find((r) => r.type.kind !== 'primitive' || (r.type as { type: string }).type !== 'unknown') ?? sorted[0];
    response = primary.type;
    responseHeaders = primary.headers;
    primaryStatus = primary.statusCode;
    responseContentTypes = primary.contentTypes;
    responseContents = primary.contents;
    // The operation-level description is the primary response's — the same
    // entry `response` and `responseHeaders` come from.
    responseDescription = primary.description;
  }

  // The paging fields describe `response`, so they come from the primary's
  // body — not from whichever 2xx body happened to be read last.
  const primaryBody = primaryStatus === undefined ? undefined : bodyResults.get(primaryStatus);
  if (primaryBody) {
    isPaginated = primaryBody.isPaginated;
    dataPath = primaryBody.dataPath;
    dataDescription = primaryBody.dataDescription;
    itemType = primaryBody.itemType;
    envelopeFields = primaryBody.envelopeFields;
    endOfIteration = primaryBody.endOfIteration;
    envelopeCompanions = primaryBody.envelopeCompanions;
  }

  // Keep the models of every 2xx body: `successResponses` references each of
  // them, so keeping only one body's would leave the others dangling. Every
  // status derives the same `<Op>Response` context name, so on a name clash
  // the primary's definition — the one `response` points at — goes first and
  // wins; the other bodies follow in status order.
  // A dropped model whose shape differs from the kept one is warned about,
  // since its status then points at a shape it did not declare. The models
  // only that dropped copy referenced go with it (`reachedModels`): the
  // primary's models are all read — `response`, the paging fields and their
  // companions — while another status is read only through its
  // `successResponses` entry, so of its models only those the entry's type
  // still reaches are kept; `CreatePetResponseOwner` under a 201
  // `CreatePetResponse` the 200's `{ id }` replaced is not, rather than kept
  // with nothing referencing it.
  const bodiesByPrimacy = [...bodyResults.entries()].sort(([a], [b]) => {
    if (a === primaryStatus) return -1;
    if (b === primaryStatus) return 1;
    return a - b;
  });
  const keptByName = new Map<string, { model: Model; status: number }>();
  for (const [status, result] of bodiesByPrimacy) {
    const reached =
      status === primaryStatus ? undefined : reachedModels(result.response, result.inlineModels, keptByName);
    for (const model of result.inlineModels) {
      if (reached && !reached.has(model)) continue;
      const kept = keptByName.get(model.name);
      if (!kept) {
        keptByName.set(model.name, { model, status });
        inlineModels.push(model);
      } else if (modelFingerprint(kept.model) !== modelFingerprint(model)) {
        console.warn(
          `[oagen] Warning: Inline model "${model.name}" from the ${status} response has different fields than the ${kept.status} response's — using the ${kept.status} response's`,
        );
      }
    }
  }

  // An explicit `dataPath` names the array the iterator yields from, so its
  // element type — not the wrapper — must become `itemType`. It is resolved
  // against the primary body, whose models (companions included) are the
  // ones retained above, so the item type it selects always has its model.
  const primarySchema = primaryStatus === undefined ? undefined : bodySchemas.get(primaryStatus);
  if (
    primaryStatus !== undefined &&
    primaryBody &&
    primarySchema &&
    pagination.dataPath !== undefined &&
    !pagination.disabled
  ) {
    const resolved = resolveOverrideItemType(
      primaryBody,
      primarySchema,
      deriveResponseName(op, pathModelBaseName),
      pagination.dataPath,
      pagination.componentModels ?? [],
      componentSchemas,
      ctx.registry && { registry: ctx.registry, operation: ctx.operationQualifier },
    );
    if (resolved) {
      overrideItemType = resolved.itemType;
      for (const model of resolved.inlineModels) {
        if (keptByName.has(model.name)) continue;
        keptByName.set(model.name, { model, status: primaryStatus });
        inlineModels.push(model);
      }
    }
  }

  const successResponses = allSuccessResponses.length > 1 ? allSuccessResponses : undefined;

  return {
    response,
    responseHeaders,
    responseContentTypes,
    responseContents,
    responseDescription,
    responseStatusCode: primaryStatus,
    successResponses,
    errors,
    defaultResponse: fallback.defaultResponse,
    rangeResponses: fallback.rangeResponses.length > 0 ? fallback.rangeResponses : undefined,
    inlineModels,
    isPaginated,
    dataPath,
    dataDescription,
    itemType,
    envelopeFields,
    endOfIteration,
    overrideItemType,
    envelopeCompanions,
  };
}

/**
 * The models of `own` — one 2xx body's — that `root`, the body's type, still
 * reaches once every name an earlier status kept resolves to that status's
 * model. A reached name's own model is in the set whatever the name's
 * fate, so a copy another status's model replaces is still compared with it
 * (and warned about when the shapes differ); the walk then continues through
 * the model the name resolves to — the kept one when there is one, since its
 * fields are what the reference reads — so a model only the replaced copy
 * referenced is not reached. A name no body minted is a component's and is
 * not followed; every own model of a name is read, so two of one name would
 * both be reached.
 */
function reachedModels(root: TypeRef, own: readonly Model[], kept: ReadonlyMap<string, { model: Model }>): Set<Model> {
  const ownByName = new Map<string, Model[]>();
  for (const model of own) {
    const models = ownByName.get(model.name);
    if (models) models.push(model);
    else ownByName.set(model.name, [model]);
  }
  const reached = new Set<Model>();
  const visited = new Set<string>();
  const queue = collectModelRefs(root);
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const ownModels = ownByName.get(name) ?? [];
    for (const model of ownModels) reached.add(model);
    const resolved = kept.get(name)?.model ?? ownModels[0];
    if (!resolved) continue;
    for (const field of resolved.fields) queue.push(...collectModelRefs(field.type));
  }
  return reached;
}

/**
 * Shared with the inline-model merge passes, which decide whether two
 * same-named inline models are the same shape but for `deprecated` by it.
 */
export { modelFingerprint };
