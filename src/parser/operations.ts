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
  DefaultResponse,
  RangeResponse,
  StatusRange,
  Model,
  Field,
  PaginationMeta,
  ExternalDocs,
  ServerEntry,
} from '../ir/types.js';
import { serverListsEqual } from '../ir/server-url.js';
import { createHash } from 'node:crypto';
import {
  toPascalCase,
  toCamelCase,
  splitWords,
  cleanSchemaName,
  stripListItemMarkers,
  singularizePathSegment,
} from '../utils/naming.js';
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
} from './schemas.js';
import { collectProperties, extractInlineModelsFromProperties } from './inline-models.js';
import { detectPagination, paginatedItemType } from './pagination.js';
import { classifyAndExtractResponse, STATUS_RANGE_LABELS } from './responses.js';
import type { ResponseExtractionResult } from './responses.js';
import { resolveResponseRef, type ReferenceObject } from './response-refs.js';
import {
  materializeInlineSchema,
  modelFingerprint,
  type InlineModelRegistry,
  type InlineModelOwner,
} from './materialize-inline.js';
import { extractSecurityRequirements, type RawSecurityRequirements } from './security.js';
import { extractServerList } from './servers.js';
import { resolveEnvelopeCompanionNames, type EnvelopeCompanion } from './envelope-companion-names.js';
import { externalDocsEntry, readExternalDocs, type RawExternalDocs } from './external-docs.js';

export interface PathItem {
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
  security?: RawSecurityRequirements;
  /** The operation's own `servers`, narrowed entry by entry by `extractServerList`. */
  servers?: unknown;
  'x-mutually-exclusive-parameter-groups'?: Record<string, ParameterGroupExtension>;
  'x-mutually-exclusive-body-groups'?: Record<string, ParameterGroupExtension>;
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

export interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
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
 * it carries either `schema` or a single-entry `content` map, never both.
 */
interface HeaderObject {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: SchemaObject;
  content?: Record<string, { schema?: SchemaObject }>;
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

export interface OperationExtractionResult {
  services: Service[];
  inlineModels: Model[];
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
): OperationExtractionResult {
  if (!paths) return { services: [], inlineModels: [] };

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
    paths,
    componentModels,
    componentRequestBodies,
    componentResponseNaming,
  );
  // An API root the untagged paths sit under (`/api`, `/v1`) tells the
  // services apart no better than nothing, so untagged operations skip it
  // when their service and fallback name are taken from the path (see
  // documentApiRoot). Tagged operations are named exactly as before.
  const apiRoot = documentApiRoot(paths);

  const serviceMap = new Map<string, Operation[]>();
  const inlineModels: Model[] = [];
  const envelopeCompanions: EnvelopeCompanion[] = [];
  // Service name each tagged operation was grouped under, keyed by operation
  // identity. The path-prefix split below moves operations between services,
  // so this is how a split-off service is traced back to the tag it came from.
  const tagServiceByOperation = new Map<Operation, string>();
  // Operations named from the method and path rather than an operationId.
  // Only these may be renamed when names collide within a service (see
  // disambiguateOperationNames); a name taken from an operationId is kept as is.
  const pathNamed = new Set<Operation>();
  // Header, secondary-body, fallback-body and error-body schemas are typed
  // only after this loop, once every primary model is known
  // (`resolveDeferredInlineTypes`): their names must not collide with a
  // differently shaped component, request body or primary response of any
  // operation, or the later merge would overwrite the first. `operationOf`
  // remembers which operation minted each primary model, so a clash within
  // one operation can be told from one across two.
  const deferred: DeferredInlineType[] = [];
  const operationOf = new Map<Model, string>();

  for (const [path, pathItem] of Object.entries(paths)) {
    const pathLevelParams = pathItem.parameters ?? [];
    // Read once per Path Item so a problem in its `servers` is reported once,
    // not once per operation. The operations that inherit it share the array,
    // the way `responseHeaders` shares its list with `successResponses`.
    const pathLevelServers = extractServerList(pathItem.servers, `path item ${path}`);

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const tag = op.tags?.[0];
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
        envelopeCompanions: opCompanions,
        operationQualifier,
      } = buildOperation(
        method,
        path,
        op,
        pathLevelParams,
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
      );
      inlineModels.push(...opModels);
      for (const model of opModels) operationOf.set(model, operationQualifier);
      if (opCompanions) envelopeCompanions.push(...opCompanions);
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
  inlineModels.push(...resolveEnvelopeCompanionNames(envelopeCompanions, componentModels));

  // Headers, secondary bodies, fallback bodies and error bodies are named
  // last, in document order, against every name above — the component models,
  // the inline models the components' own fields mint (a nested object, a
  // map's values; not among `componentModels`, see parseSpec), every request
  // body, primary response and companion model — so none of them takes a name
  // one of those owns, whichever comes first in the document.
  inlineModels.push(
    ...resolveDeferredInlineTypes(
      deferred,
      [...(componentModels ?? []), ...(componentFieldModels ?? [])],
      inlineModels,
      operationOf,
    ),
  );

  // The API root each operation's path sits under, for every step below: none
  // for a tagged operation, whose service is its tag.
  const rootLengthOf = (op: Operation) => (tagServiceByOperation.has(op) ? 0 : apiRootLengthOf(op.path, apiRoot));

  // Split services when a single tag groups operations from multiple path prefixes.
  // Example: /organizations and /organization_domains both tagged "organizations"
  // should become separate services based on their first path segment.
  // The segment compared is the one the service would be named from without
  // the tag (see serviceSegmentIndex): the first for a tagged operation, the
  // first past the API root for an untagged one, so `/notes` and
  // `/api/v1/notes` stay together in `Notes` rather than the latter being
  // moved to `Api` after its name was shortened for `Notes`.
  for (const [serviceName, operations] of serviceMap) {
    const pathGroups = new Map<string, Operation[]>();
    for (const op of operations) {
      const segments = op.path.split('/').filter(Boolean);
      const firstSeg = segments[serviceSegmentIndex(segments, rootLengthOf(op))] ?? '';
      const groupKey = firstSeg.startsWith('{') ? serviceName : toPascalCase(firstSeg);
      const group = pathGroups.get(groupKey) ?? [];
      group.push(op);
      pathGroups.set(groupKey, group);
    }
    // Only split if there are multiple distinct path-prefix groups AND
    // at least one group name differs from the current service name
    if (pathGroups.size > 1) {
      const needsSplit = [...pathGroups.keys()].some((k) => k !== serviceName);
      if (needsSplit) {
        serviceMap.delete(serviceName);
        for (const [groupName, groupOps] of pathGroups) {
          const existing = serviceMap.get(groupName) ?? [];
          existing.push(...groupOps);
          serviceMap.set(groupName, existing);
        }
      }
    }
  }

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

  return { services, inlineModels };
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
    // Same truthiness check as inferServiceName: a first tag names the service.
    const hasUntaggedOperation = HTTP_METHODS.some((method) => {
      const op = pathItem[method];
      return Boolean(op) && !op?.tags?.[0];
    });
    if (!hasUntaggedOperation) continue;
    const segments = path.split('/').filter(Boolean);
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
  const segments = path.split('/').filter(Boolean);
  return sharedPrefixLength(apiRoot, segments.slice(0, pathRootLength(segments)));
}

/**
 * Index of the segment a path-named service takes its name from. Under an
 * API root it is the first literal segment after the root, so `/v1/notes` and
 * `/v1/{teamId}/notes` both name `Notes`; when nothing literal follows the
 * root, the first segment, so `/api` and `/api/{id}` name `Api` as they
 * always did rather than `Default`. The fallback operation name skips the
 * same segment (see inferResourceFromPath), so it is never echoed as
 * `Api.getApi`.
 *
 * Without a root (`apiRootLength` of 0: a root-less document, a path outside
 * the root, or a tagged operation) it is always the first segment, parameter
 * or not, so every such operation is named exactly as before this rule
 * existed: an untagged `/{tenant}/users` stays `Default.listUsers`.
 */
function serviceSegmentIndex(segments: readonly string[], apiRootLength: number): number {
  if (apiRootLength === 0) return 0;
  const index = segments.findIndex((segment, i) => i >= apiRootLength && !segment.startsWith('{'));
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
 */
function inferServiceName(path: string, tag: string | undefined, apiRootLength: number): string {
  // Prefer OpenAPI tag when available — tags represent the logical grouping
  // (e.g., "multi-factor-auth" for /auth/factors/* endpoints).
  if (tag) {
    return toPascalCase(tag);
  }
  const segments = path.split('/').filter(Boolean);
  const first = segments[serviceSegmentIndex(segments, apiRootLength)] ?? 'Default';
  // Skip path params
  if (first.startsWith('{')) return 'Default';
  return toPascalCase(first);
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
  // or "adoptPet" for a POST action on one item.
  return fallbackOperationName(method, path, apiRootLength);
}

/**
 * The `<verb><Resource>` name of an operation without an `operationId`: the
 * CRUD verb (inferVerb) plus the resource noun (inferResourceFromPath),
 * singular for an item operation — `GET /store/pets/{id}` is `getPet` — or,
 * for a POST action on one item (inferPostAction), the action verb plus the
 * singular parent: `POST /store/pets/{id}/adopt` is `adoptPet`. The verb
 * alone when the path names no resource past the service segment:
 * `GET /pets/{id}` in `Pets` is `get`.
 */
function fallbackOperationName(method: HttpMethod, path: string, apiRootLength: number): string {
  const action = method === 'post' ? inferPostAction(path, apiRootLength) : null;
  if (action) return appendQualifier(toCamelCase(action.verb), action.resource);
  const verb = inferVerb(method, path);
  const resource = inferResourceFromPath(path, apiRootLength);
  return resource ? toCamelCase(`${verb}_${resource}`) : verb;
}

/**
 * The name fallbackOperationName gave an item operation before its resource
 * was singularised: the resource as the path spells it, `getPets` for
 * `GET /store/pets/{id}`. `null` for a POST action, whose name is a verb with
 * no plural, and for an operation whose resource is not singularised — a
 * collection, a path with no resource, a segment that does not look plural —
 * so a non-null result always differs from the singular name.
 * disambiguateOperationNames falls back to it before a numeric suffix when
 * the singular name is an operationId's.
 */
function pluralFallbackName(method: HttpMethod, path: string, apiRootLength: number): string | null {
  if (method === 'post' && inferPostAction(path, apiRootLength)) return null;
  const resource = inferResourceFromPath(path, apiRootLength, false);
  if (resource === null || resource === inferResourceFromPath(path, apiRootLength)) return null;
  return toCamelCase(`${inferVerb(method, path)}_${resource}`);
}

/**
 * Infer the CRUD verb from HTTP method and path shape. A POST is `create`
 * unless `inferPostAction` recognised it as an action first.
 */
function inferVerb(method: HttpMethod, path: string): string {
  const segments = path.split('/').filter(Boolean);
  const hasTrailingParam = segments.length > 0 && segments[segments.length - 1].startsWith('{');

  switch (method) {
    case 'get':
      return hasTrailingParam ? 'get' : 'list';
    case 'post':
      return 'create';
    case 'put':
    case 'patch':
      return 'update';
    case 'delete':
      return 'delete';
    case 'head':
      return 'check';
    case 'options':
      return 'options';
    case 'trace':
      return 'trace';
    default:
      return method;
  }
}

/**
 * Extract a resource noun from the path for operation naming.
 * Uses the last non-param segment (the resource being operated on). An item
 * operation — the last literal segment is followed by a path parameter —
 * addresses one entity, so its noun is singularised (`singularizePathSegment`).
 *
 * Examples:
 *   /accounts/users → "Users"
 *   /accounts/users/{id} → "User" (singular for item operations)
 *   /accounts/users/{id}/auth_factors → "AuthFactors"
 *   /accounts/users/{id}/auth_factors/{factor_id} → "AuthFactor"
 *   /organizations/{id}/api_keys → "ApiKeys"
 *   /auth/authorize → "Authorize" (action endpoint)
 *
 * `apiRootLength` is the document's API root the path sits under (see
 * documentApiRoot); the service segment is the first literal one after it.
 * `singularItem` false keeps an item's noun as the path spells it (`Users`
 * for `/accounts/users/{id}`), for pluralFallbackName.
 */
function inferResourceFromPath(path: string, apiRootLength = 0, singularItem = true): string | null {
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 1) return null;

  // Find the last meaningful (non-param) segment past the API root, so a
  // root word is never the resource: /api/v1/{id} is Api.delete, not deleteV1.
  let resourceSegment: string | null = null;
  let isItem = false;
  for (let i = segments.length - 1; i >= apiRootLength; i--) {
    if (!segments[i].startsWith('{')) {
      resourceSegment = segments[i];
      isItem = i < segments.length - 1;
      break;
    }
  }

  if (!resourceSegment) return null;
  // Skip the service name (the segment the service was named from) — it
  // would be redundant: /api/notes is Notes.list, not Notes.listNotes.
  if (resourceSegment === segments[serviceSegmentIndex(segments, apiRootLength)]) return null;

  return toPascalCase(isItem && singularItem ? singularizePathSegment(resourceSegment) : resourceSegment);
}

/**
 * Recognise a POST action on one item: `/pets/{petId}/adopt`,
 * `/owners/{o}/pets/{p}/vaccinate`. The last segment is a literal that follows
 * a path parameter, so it names something done to that item rather than a
 * collection to create into. The verb is the segment itself and the resource
 * is the singular parent (`adopt` + `Pet`): the nearest literal before the
 * parameter that is past the document's API root (`apiRootLength`, see
 * documentApiRoot) and is not an API marker (isApiMarkerSegment) — the marker
 * check also covers a tagged operation, which has no root — so
 * `/api/v1/{companyId}/sendDocument` has no parent and is the bare verb
 * `sendDocument` rather than `sendDocumentV1`. The parent is kept even when it
 * is the service segment so that `/pets/{id}/archive` and `/users/{id}/archive`
 * under one tag do not both become `archive`; the caller leaves it off when
 * the verb already ends with it (`restart-id-verification` under
 * `verification` is `restartIdVerification`, see appendQualifier).
 *
 * Not an action, so still a `create`: a literal ending in `s` after the
 * parameter, which is read as a nested collection (`/orgs/{id}/api_keys`,
 * and conservatively `/orders/{id}/status`), and a literal with no parameter
 * before it, which is indistinguishable from a nested collection
 * (`/pets/search` looks like `/accounts/users/auth_factors`). A singleton
 * noun after the parameter (`/users/{id}/avatar`) is misread as a verb; give
 * it an `operationId`.
 */
function inferPostAction(path: string, apiRootLength = 0): { verb: string; resource: string | null } | null {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const last = segments[segments.length - 1];
  if (last.startsWith('{') || !segments[segments.length - 2].startsWith('{')) return null;
  if (last.toLowerCase().endsWith('s')) return null;

  for (let i = segments.length - 3; i >= apiRootLength; i--) {
    if (!segments[i].startsWith('{') && !isApiMarkerSegment(segments[i])) {
      return { verb: last, resource: toPascalCase(singularizePathSegment(segments[i])) };
    }
  }
  return { verb: last, resource: null };
}

/**
 * Detect and resolve name collisions within a service's operations.
 *
 * A name taken from an `operationId` is the author's choice and is never
 * rewritten here. A name derived from the method and path (inferOperationName)
 * is only as unique as the path words it was built from, so when operations on
 * different paths share one, the path-named operations are qualified until
 * every path in the service has a name of its own. Same-name operations on
 * the same path (PUT + PATCH both "update") are left as-is since they
 * represent the same logical resource.
 *
 * `apiRootLengthOf` gives the API root each operation's path sits under (see
 * documentApiRoot), so neither the resource nor the deeper context echoes the
 * root or the service segment into a name: `DELETE /api/v1/notes/all` in
 * `Notes` is `deleteAll`, never `deleteAllV1Notes`. A POST action's resource
 * and deeper context are read from its path without the action segment (see
 * qualifierPath), so a second `adoptPet` is qualified by what sets its path
 * apart and never by repeating `Adopt`.
 *
 * Qualifiers are tried in order, each on every group still colliding after
 * the one before. A qualifier never puts the same word twice in a row into a
 * name, whether the name already ends with it (`listNotes` never becomes
 * `listNotesNotes`) or the qualifier repeats it itself
 * (`/api/analytics/analytics/teams` → `listTeamsAnalytics`), compared word by
 * word on the camelCase boundary rather than as a substring:
 *
 *   1. the resource noun (inferResourceFromPath);
 *   2. the path segments between the service and the resource
 *      (inferDeeperContext): `GET /users/{id}/sso/factors` next to
 *      `GET /users/{id}/factors` → `listFactorsSso`;
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
 *      could tell from an operationId — `GET /store/pets/{id}` is `getPet`,
 *      and so is `operationId: getPet` on `/store/featured/{id}` — the plural
 *      name it had before item resources were singularised, `getPets`
 *      (pluralFallbackName), when no operation in the service has it. The
 *      plural still says which collection is read, and it is the name every
 *      SDK generated from such a document already exposes, where a number
 *      says nothing. Two path-named operations never need it: their paths
 *      differ, so a qualifier above tells them apart. A name a qualifier has
 *      already extended, and an action, go straight to the suffix;
 *   7. a numeric suffix (`listNotes2`, `listNotes3`, …), so an emitter never
 *      sees two methods with one name in one class. An operationId-named
 *      operation keeps the plain name over a path-named one; then the path
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
  const byPath = (a: Operation, b: Operation) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const qualifiers: Array<(group: Operation[]) => void> = [
    (group) => {
      for (const op of group) {
        if (!pathNamed.has(op)) continue;
        const root = apiRootLengthOf(op);
        rename(op, appendQualifier(op.name, inferResourceFromPath(qualifierPath(op, root), root)));
      }
    },
    (group) => {
      for (const op of group) {
        if (!pathNamed.has(op)) continue;
        const root = apiRootLengthOf(op);
        rename(op, appendQualifier(op.name, inferDeeperContext(qualifierPath(op, root), root)));
      }
    },
    (group) => {
      // Parameters only help when they differ between the colliding paths,
      // so one every path carries is left out — `/api/notes/{noteId}` and
      // `/api/{teamId}/notes/{noteId}` are told apart by `teamId` alone —
      // and when none does the pass is skipped: `/v1/{id}/notes` and
      // `/v1/{id}/Notes` would both gain `ById` and still collide, further
      // from the plain name. Every path-named operation takes part, under an
      // API root or not: a service must not hand an emitter two methods with
      // one name.
      const shared = sharedPathParams(group.map((op) => op.path));
      const suffixes = group.map((op) => inferByParamsSuffix(op.path, shared));
      if (new Set(suffixes).size <= 1) return;
      group.forEach((op, i) => {
        if (pathNamed.has(op)) rename(op, appendQualifier(op.name, suffixes[i]));
      });
    },
    (group) => {
      // Paths under the document root that skipped different lengths of it
      // differ by a version or mount word the plain name left off: `/api/notes`
      // beside `/api/v1/notes` in `Notes`. The words a path skipped beyond the
      // root the rooted paths all share are what tell them apart (`listV1`),
      // the one place a root word belongs in a name. A root-less path — outside
      // the root, or tagged — is named as if the document had none and takes
      // no part; it keeps the plain name in the numeric pass instead.
      const roots = group.map((op) => op.path.split('/').filter(Boolean).slice(0, apiRootLengthOf(op)));
      const rooted = roots.filter((root) => root.length > 0);
      if (rooted.length === 0) return;
      let shared = rooted[0];
      for (const root of rooted) shared = shared.slice(0, sharedPrefixLength(shared, root));
      const words = roots.map((root) => (root.length === 0 ? '' : toPascalCase(root.slice(shared.length).join('_'))));
      if (new Set(words).size <= 1) return;
      group.forEach((op, i) => {
        if (pathNamed.has(op)) rename(op, appendQualifier(op.name, words[i]));
      });
    },
    (group) => {
      // The plain name leaves off the resource noun that names the service
      // (`GET /api/notes` in `Notes` is `list`); it is restored when it is
      // what tells the group apart. An operationId-named operation is never
      // renamed, so it contributes nothing here: next to `operationId: list`
      // on `/api/{teamId}/notes`, path-named `/api/notes` becomes
      // `listNotes`. When every path drops the same noun (`/notes` and
      // `/api/v1/notes`), restoring it would only move the collision.
      const nouns = group.map((op) =>
        pathNamed.has(op) ? (inferServiceNoun(op.path, apiRootLengthOf(op)) ?? '') : '',
      );
      if (new Set(nouns).size <= 1) return;
      group.forEach((op, i) => {
        if (pathNamed.has(op)) rename(op, appendQualifier(op.name, nouns[i]));
      });
    },
  ];

  for (const qualify of qualifiers) {
    for (const group of collidingGroups(operations)) qualify(group);
  }

  // The plural pass and the numeric pass below both draw names from one pool
  // per service. Groups come in name order and members are sorted by path,
  // so the names are allocated in an order that depends only on the data.
  const inUse = new Set(operations.map((op) => op.name));
  for (const group of collidingGroups(operations)) {
    // Only next to an operationId: two path-named operations have different
    // paths, and the qualifiers above are what tell those apart.
    if (group.every((op) => pathNamed.has(op))) continue;
    const pluralByPath = new Map<string, string>();
    for (const op of group.filter((member) => pathNamed.has(member)).sort(byPath)) {
      let plural = pluralByPath.get(op.path);
      if (plural === undefined) {
        const root = apiRootLengthOf(op);
        const candidate = pluralFallbackName(op.httpMethod, op.path, root);
        // The name must still be the one the operation was built with — no
        // qualifier above has extended it — and the plural must be free.
        const untouched = op.name === fallbackOperationName(op.httpMethod, op.path, root);
        if (candidate === null || !untouched || inUse.has(candidate)) continue;
        plural = candidate;
        inUse.add(plural);
        pluralByPath.set(op.path, plural);
      }
      rename(op, plural);
    }
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
      (a, b) =>
        rank(a) - rank(b) ||
        apiRootLengthOf(a) - apiRootLengthOf(b) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    const keeper = ordered[0];
    const nameByPath = new Map<string, string>([[keeper.path, name]]);
    let n = 2;
    for (const op of ordered) {
      let next = nameByPath.get(op.path);
      if (next === undefined) {
        while (taken.has(`${name}${n}`)) n++;
        next = `${name}${n}`;
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
 * The groups of operations that share a name but not a path, in name order.
 * A name shared only by operations on one path (PUT + PATCH) is not a
 * collision and is excluded.
 *
 * Name order, not document order: the numeric pass draws suffixed names from
 * one pool per service, and two groups can reach the same one (`listNotes` +
 * `12` and `listNotes1` + `2`), so whichever is served first decides. Names
 * are unique per group, so this is a total order, and with the members of a
 * group also sorted the whole assignment depends only on the paths.
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

/**
 * Append a qualifier to an operation name without repeating what the name
 * already says. A qualifier never contributes the same word twice in a row:
 * the deeper context of `/api/analytics/analytics/teams` is
 * `AnalyticsAnalytics`, which joins as `listTeamsAnalytics`. The words that
 * remain are then joined where they overlap the end of the name: `listNotes`
 * + `Notes` and `listOAuth2Tokens` + `OAuth2Tokens` stay as they are, and
 * `listTeams` + `TeamsAnalytics` is `listTeamsAnalytics`. Words are compared
 * case-insensitively on the camelCase boundary, so `listNotes` + `Note` does
 * not overlap and is appended whole. The name's own words are never touched.
 */
function appendQualifier(name: string, qualifier: string | null): string {
  if (!qualifier) return name;
  const have = splitWords(name).map((w) => w.toLowerCase());
  const words = splitWords(qualifier).filter((w, i, all) => i === 0 || w.toLowerCase() !== all[i - 1].toLowerCase());
  const want = words.map((w) => w.toLowerCase());
  // The longest run of words that both ends the name and starts the qualifier.
  let overlap = Math.min(have.length, want.length);
  while (overlap > 0 && !want.slice(0, overlap).every((w, i) => w === have[have.length - overlap + i])) overlap--;
  const rest = words.slice(overlap);
  return rest.length === 0 ? name : toCamelCase([name, ...rest].join('_'));
}

/**
 * The path a colliding operation's resource and deeper context are read
 * from. For a POST action it is the path without the action segment: the
 * name already ends with the parent (`adoptPet`), so the qualifiers see that
 * parent, which appendQualifier leaves alone, rather than the verb, which
 * would come back as `adoptPetAdopt`. Every other operation is read whole.
 */
function qualifierPath(op: Operation, apiRootLength: number): string {
  if (op.httpMethod !== 'post' || !inferPostAction(op.path, apiRootLength)) return op.path;
  return '/' + op.path.split('/').filter(Boolean).slice(0, -1).join('/');
}

/**
 * The path parameters in path order, each as the PascalCase word that
 * `By<Param>` spells it with. Mirrors derivePathModelBaseName's spelling of a
 * parameter segment, so `{team_id}` and `{teamId}` read alike.
 */
function pathParamWords(path: string): string[] {
  return path
    .split('/')
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
 * segment the service was named from: `Notes` for `/api/notes`,
 * `/api/notes/{id}` and `/api/{teamId}/notes` under an `/api` root, and for a
 * root-less `/notes`. Null when the last literal segment past the API root is
 * a different word (`/api/notes/{id}/tags`, whose `Tags` the plain name
 * already carries) or when nothing literal follows the root (`/api/v1/{id}`).
 */
function inferServiceNoun(path: string, apiRootLength: number): string | null {
  const segments = path.split('/').filter(Boolean);
  let last = segments.length - 1;
  while (last >= apiRootLength && segments[last].startsWith('{')) last--;
  if (last < apiRootLength || last !== serviceSegmentIndex(segments, apiRootLength)) return null;
  return toPascalCase(segments[last]);
}

/**
 * Extract a deeper disambiguation context from the path when the last
 * segment isn't unique enough. Uses the second-to-last non-param segment.
 *
 * /users/{id}/auth_factors → already captured as "AuthFactors"
 * /users/external_id/{external_id} → "ExternalId" (special path, not a sub-resource)
 *
 * The API root the path sits under (`apiRootLength`, see documentApiRoot) is
 * left out along with the service segment that follows it, so
 * /api/v1/core/auth/permissions in `Core` contributes "Auth", not "V1CoreAuth".
 */
function inferDeeperContext(path: string, apiRootLength = 0): string | null {
  const segments = path.split('/').filter(Boolean);
  const nonParams = segments.slice(apiRootLength).filter((s) => !s.startsWith('{'));
  // Skip first (service) and last (already used) — use the middle ones
  if (nonParams.length >= 3) {
    return toPascalCase(nonParams.slice(1, -1).join('_'));
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
  const bodySchema = requestBody?.content?.['application/json']?.schema;
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

function buildOperation(
  method: HttpMethod,
  path: string,
  op: OperationObject,
  pathLevelParams: RawParameterObject[],
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
): {
  operation: Operation;
  inlineModels: Model[];
  envelopeCompanions?: EnvelopeCompanion[];
  /** What the shape registry records as the owner of this operation's models (see `headerOperationQualifier`). */
  operationQualifier: string;
} {
  const opLabel = operationLabel(op, path, method);
  const operationName = inferOperationName(method, path, op.operationId, operationIdTransform, apiRootLength);
  // Resolve a `components/requestBodies` ref up front so body extraction, body
  // parameter groups, and the body-ownership rule below all read one object.
  const requestBodyObject = resolveRequestBodyRef(op.requestBody, componentRequestBodies, opLabel);
  // An operation-level parameter overrides a path-level one with the same
  // (name, in) identity rather than adding a second entry. Operation params come
  // last, so last-write-wins; Map.set keeps the original insertion position, so
  // path-level parameter ordering is preserved.
  const paramsByIdentity = new Map<string, ParameterObject>();
  for (const raw of [...pathLevelParams, ...(op.parameters ?? [])]) {
    const param = resolveParameterRef(raw, componentParameters, opLabel);
    paramsByIdentity.set(`${param.in}:${param.name}`, param);
  }
  const allParams = [...paramsByIdentity.values()];

  const hasIdempotencyHeader = allParams.some((p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key');

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
    const bodySchema = selectRequestBodyContent(requestBodyObject).schema;
    for (const name of collectBodyPropertyNames(bodySchema, componentSchemas)) {
      if (!groupedQueryNames.has(name)) bodyOwnedNames.add(name);
    }
  }
  const wireParams =
    bodyOwnedNames.size > 0 ? allParams.filter((p) => !(p.in === 'query' && bodyOwnedNames.has(p.name))) : allParams;

  // Use the service name as context so inline parameter enums get qualified
  // names. e.g., service "Auth" + param "provider" → "AuthProvider".
  const opContext = serviceName;
  const pathParams = extractParams(wireParams, 'path', opContext, componentSchemas, componentExamples, opLabel);
  const queryParams = extractParams(wireParams, 'query', opContext, componentSchemas, componentExamples, opLabel);
  const headerParams = extractParams(
    wireParams,
    'header',
    opContext,
    componentSchemas,
    componentExamples,
    opLabel,
  ).filter((p) => p.name.toLowerCase() !== 'idempotency-key');
  const cookieParams = extractParams(wireParams, 'cookie', opContext, componentSchemas, componentExamples, opLabel);
  // Keep the body-owned declarations on the operation so downstream passes
  // (inline-enum collection, the compat surface) still see what the spec
  // declared, even though no emitter serializes them to the URL.
  const bodyOwnedQueryParams =
    bodyOwnedNames.size > 0
      ? extractParams(
          allParams.filter((p) => p.in === 'query' && bodyOwnedNames.has(p.name)),
          'query',
          opContext,
          componentSchemas,
          componentExamples,
          opLabel,
        )
      : [];

  const reqBodyModels: Model[] = [];
  const { body: requestBody, encoding: requestBodyEncoding } = extractRequestBody(
    requestBodyObject,
    op,
    pathModelBaseName,
    reqBodyModels,
    componentSchemas,
  );
  // Read off the resolved body so a `components/requestBodies` ref's flag
  // counts. Only `true` makes the body required: OpenAPI defaults the flag
  // to `false`, and a non-boolean value is not a declaration of requiredness.
  // Set exactly when a body is, so the two fields can be read together.
  const requestBodyRequired = requestBody !== undefined ? requestBodyObject?.required === true : undefined;
  // Names this operation's models in the shape registry, and qualifies a
  // deferred model's name when one of them is taken across operations.
  const operationQualifier = headerOperationQualifier(op, operationName, pathModelBaseName, opContext);
  const {
    response,
    responseHeaders,
    responseContentTypes,
    responseContents,
    responseDescription,
    successResponses,
    errors,
    defaultResponse,
    rangeResponses,
    inlineModels,
    isPaginated,
    dataPath: responseDataPath,
    dataDescription: responseDataDescription,
    itemType: responseItemType,
    envelopeFields,
    envelopeCompanions,
  } = extractResponses(op.responses, op, pathModelBaseName, path, method, componentSchemas, {
    componentHeaders,
    componentSchemas,
    componentResponses,
    serviceName: opContext,
    operationQualifier,
    deferred,
    refSiblingDescriptions,
    componentResponseModelNames,
  });
  inlineModels.push(...reqBodyModels);

  // Build structured pagination metadata from response classification and query param detection
  const paginationFromParams = detectPagination(response, queryParams, responseDataPath);
  let pagination: PaginationMeta | undefined;
  if (isPaginated) {
    const itemType = responseItemType ?? paginatedItemType(response);
    pagination = {
      strategy: paginationFromParams?.strategy ?? 'cursor',
      param: paginationFromParams?.param ?? 'after',
      limitParam: paginationFromParams?.limitParam,
      dataPath: responseDataPath ?? paginationFromParams?.dataPath,
      ...(responseDataDescription !== undefined && { dataDescription: responseDataDescription }),
      itemType,
      envelopeFields,
    };
  } else if (paginationFromParams) {
    pagination = paginationFromParams;
  }

  // Per-operation security requirements; undefined means "inherit ApiSpec.security"
  const security = extractSecurityRequirements(op.security, opLabel);

  // Extract mutually-exclusive parameter groups (query/path/header/cookie)
  const allIRParams = [...pathParams, ...queryParams, ...headerParams, ...cookieParams];
  const queryParamGroups = extractParameterGroups(op, allIRParams, opLabel);

  // Extract mutually-exclusive body parameter groups
  const bodyParamGroups = extractBodyParameterGroups(op, requestBodyObject, opLabel, componentSchemas);

  // Merge both sources into a single parameterGroups array
  const parameterGroups =
    queryParamGroups || bodyParamGroups ? [...(queryParamGroups ?? []), ...(bodyParamGroups ?? [])] : undefined;

  // An empty or whitespace-only summary counts as absent, so it neither gets
  // its own field nor leaks into the description as a blank first paragraph.
  const summary = presentText(op.summary);

  return {
    operation: {
      name: operationName,
      // Keep the summary on its own so emitters can tell it apart from the
      // description; the key is omitted (not set to undefined) when absent.
      ...(summary !== undefined ? { summary } : {}),
      description: buildDescription(summary, op.description),
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
      // Added only when the operation has a body so bodiless operations keep
      // their shape.
      ...(requestBodyRequired !== undefined && { requestBodyRequired }),
      response,
      // Added only when present so operations without headers keep their shape.
      ...(responseHeaders && { responseHeaders }),
      ...(responseContentTypes && { responseContentTypes, responseContents }),
      // Likewise only when the primary response declares a description.
      ...(responseDescription && { responseDescription }),
      successResponses,
      errors,
      // Added only when the document declares them so operations without
      // fallback responses keep their shape.
      ...(defaultResponse && { defaultResponse }),
      ...(rangeResponses && { rangeResponses }),
      pagination,
      injectIdempotencyKey: hasIdempotencyHeader,
      deprecated: op.deprecated || undefined,
      async: op['x-oagen-async'],
      security,
      parameterGroups,
    },
    inlineModels,
    envelopeCompanions,
    operationQualifier,
  };
}

/**
 * The qualifier that tells one operation's header models from another's
 * (`materializeDeferredType`'s `byOperation` candidate), and that the shape
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
      const refTarget = resolveComponentSchemaRef(p.schema, componentSchemas);
      // Each level is resolved on its own — the parameter's declaration, its
      // inline schema, then the component the schema refs — so a schema-level
      // `example` can't mask the parameter's own `examples` map, and an
      // explicit `null` at any level is kept rather than fallen through.
      const { example, examples } = resolveExamples([
        {
          example: p.example,
          examples: exampleObjectValues(
            p.examples,
            componentExamples,
            `parameter "${p.name}" in ${opLabel ?? location}`,
          ),
        },
        { example: p.schema?.example, examples: nonEmptyExamples(p.schema?.examples) },
        { example: refTarget?.example, examples: nonEmptyExamples(refTarget?.examples) },
      ]);
      // Like default/example, fall back per value: the `$ref` target's keywords
      // sit under the parameter's own, so `{ $ref: Limit, minimum: 5 }` narrows
      // one bound without discarding the target's others. The alias also becomes
      // a fieldless model, but a parameter should be readable on its own.
      const own = p.schema ? extractConstraints(p.schema) : undefined;
      const inherited = refTarget ? extractConstraints(refTarget) : undefined;
      const constraints = own && inherited ? { ...inherited, ...own } : (own ?? inherited);
      // The schema's link, else the `$ref` target's — the same fallback chain
      // `description` and `deprecated` follow, with an unusable entry at one
      // level falling through to the next as an empty description does. A
      // Parameter Object declares no `externalDocs` of its own.
      const externalDocs = readExternalDocs(p.schema?.externalDocs) ?? readExternalDocs(refTarget?.externalDocs);
      return {
        name: p.name,
        type: p.schema
          ? schemaToTypeRef(p.schema, p.name, operationContext ? toPascalCase(operationContext) : undefined)
          : ({ kind: 'primitive', type: 'string' } as TypeRef),
        required: p.required ?? false,
        description: firstDescription(p.description, p.schema?.description, refTarget?.description),
        deprecated: p.deprecated || p.schema?.deprecated || refTarget?.deprecated || undefined,
        ...(externalDocs ? { externalDocs } : {}),
        default: p.schema?.default ?? refTarget?.default,
        example,
        ...(examples ? { examples } : {}),
        style: p.style as Parameter['style'],
        explode: p.explode,
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
 * Pick the request body's schema and wire encoding from its content map, in
 * priority order. JSON wins over form encodings; binary and text bodies may
 * legitimately carry no schema at all.
 */
export function selectRequestBodyContent(body: RequestBodyObject | undefined): {
  encoding: RequestBodyEncoding;
  schema?: SchemaObject;
} {
  const content = body?.content;
  if (!content) return { encoding: 'json' };
  if (content['application/json']?.schema) {
    return { encoding: 'json', schema: content['application/json'].schema };
  }
  if (content['multipart/form-data']?.schema) {
    return { encoding: 'form-data', schema: content['multipart/form-data'].schema };
  }
  if (content['application/x-www-form-urlencoded']?.schema) {
    return { encoding: 'form-urlencoded', schema: content['application/x-www-form-urlencoded'].schema };
  }
  if (content['application/octet-stream']) {
    return { encoding: 'binary', schema: content['application/octet-stream'].schema };
  }
  if (content['text/plain']) {
    return { encoding: 'text', schema: content['text/plain'].schema };
  }
  return { encoding: 'json' };
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

function extractRequestBody(
  body: RequestBodyObject | undefined,
  op: OperationObject | undefined,
  pathModelBaseName: string,
  inlineModels: Model[],
  componentSchemas?: Record<string, SchemaObject>,
): { body?: TypeRef; encoding?: RequestBodyEncoding } {
  if (!body?.content) return {};

  const selected = selectRequestBodyContent(body);
  const encoding = selected.encoding;
  let schema = selected.schema;

  if (!schema) {
    // For binary/text, a schema is optional — produce a primitive TypeRef
    if (encoding === 'binary') {
      return { body: { kind: 'primitive', type: 'string', format: 'binary' }, encoding };
    }
    if (encoding === 'text') {
      return { body: { kind: 'primitive', type: 'string' }, encoding };
    }
    return {};
  }

  // Without an operationId, name the body from the operation's path-derived
  // prefix (see derivePathModelBaseName) so two operations don't share one
  // inline body model. Every operationId-less body used to be `RequestBody`,
  // and only the largest survived deduplication — every other operation was
  // left pointing at a model with someone else's fields.
  const contextName = op?.operationId ? operationIdModelName(op.operationId, 'Request') : pathModelBaseName + 'Request';

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

  // If the request body is an inline object with properties, extract it as a model
  if (schema.properties && (schema.type === 'object' || !schema.type)) {
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
    return { body: { kind: 'model', name: contextName }, encoding };
  }

  // If the request body is a oneOf, extract each variant as an inline model
  // and build a union type pointing to them by name.
  if (schema.oneOf) {
    const variants: TypeRef[] = [];
    // The inline object variants of this union and the names its const-less
    // variants have taken so far, for `deriveOneOfVariantName`.
    const inlineObjectVariants = schema.oneOf.filter(
      (v) => !v.$ref && v.properties && (v.type === 'object' || !v.type),
    );
    const contentNamed: string[] = [];
    // A nullable body (`oneOf: [object, null]`) is one schema: the model built
    // from its object branch takes the wrapper's `deprecated` and limits, as
    // every other nullable unwrap gives it (`collapsedNullableBranch`). The
    // null branch still makes the body nullable below. A multi-variant union,
    // nullable or not, is not collapsed: every variant is built as written.
    const branch = collapsedNullableBranch(schema);

    for (const variant of schema.oneOf) {
      if (variant.$ref) {
        const ref = schemaToTypeRef(variant, contextName);
        variants.push(ref);
      } else if (variant.type === 'null') {
        // skip null variant in union, handle separately
      } else if (variant.properties && (variant.type === 'object' || !variant.type)) {
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
        const source = branch ?? variant;
        const requiredSet = new Set(source.required ?? []);
        const siblings = collectProperties(source);
        const fields: Field[] = [];
        for (const [fieldName, fieldSchema] of Object.entries(source.properties ?? {})) {
          if (!fieldSchema) continue;
          fields.push(
            buildFieldFromSchema(fieldName, fieldSchema, variantName, requiredSet, componentSchemas, siblings),
          );
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
        variants.push({ kind: 'model', name: variantName });
      } else {
        variants.push(schemaToTypeRef(variant, contextName));
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
    const body = hasNull ? ({ kind: 'nullable', inner: union } as TypeRef) : union;
    return { body, encoding };
  }

  return { body: schemaToTypeRef(schema, contextName), encoding };
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
 * document's. Precedence is applied before the comparison, so an operation
 * that restates the document's servers under a Path Item that diverges
 * inherits, not the Path Item's. A document without `servers` compares as an
 * empty list, so any usable list at either level is kept.
 */
function operationServers(
  own: ServerEntry[] | undefined,
  pathLevel: ServerEntry[] | undefined,
  documentServers: ServerEntry[] | undefined,
): ServerEntry[] | undefined {
  const effective = own ?? pathLevel;
  if (!effective) return undefined;
  return serverListsEqual(effective, documentServers ?? []) ? undefined : effective;
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
  kind: 'header' | 'content' | 'fallback' | 'error';
  schema: SchemaObject;
  /**
   * The bare name the models derive from: the header name, the response stem
   * + media type + role, a fallback body's `<Op><Label>Response` or an error
   * body's `<Op>Error<code>`.
   */
  name: string;
  /** A status code, or the label of a fallback response (`Default`, `ClientError`). */
  statusCode: number | string;
  /** Qualifies a name taken across operations (see `headerOperationQualifier`). */
  operationQualifier: string;
  /** Qualifies a header's names (`Documents` + `X-Meta` → `DocumentsXMeta`); a body has none. */
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
  /** Qualifies header model and enum names: `Documents` + `X-Meta` → `DocumentsXMeta`. */
  serviceName?: string;
  /** Qualifies a name taken across operations (see `headerOperationQualifier`). */
  operationQualifier: string;
  /** Collects every schema whose models are named after the operations loop. */
  deferred: DeferredInlineType[];
}

/**
 * Name and materialize every deferred header, secondary-body, fallback-body
 * and error-body schema, now that every primary model is known. The registry
 * holds the component models first (with the inline models their fields
 * mint), then every inline model the operations minted — request bodies,
 * primary response bodies with their nested objects and union variants,
 * envelope companions — so no deferred schema can take one of their names
 * for a different shape, whichever operation minted it; each resolved
 * schema's own models join it in turn, in document order (path order, then
 * the response keys as written; a response's headers before its error body
 * and its secondary bodies, a fallback's body before its headers), so the
 * first owner of a name keeps it. Returns the models materialized, having set
 * each target's `type`.
 */
function resolveDeferredInlineTypes(
  deferred: readonly DeferredInlineType[],
  componentModels: readonly Model[],
  inlineModels: readonly Model[],
  operationOf: ReadonlyMap<Model, string>,
): Model[] {
  const registry: ModelShapeRegistry = new Map();
  for (const model of componentModels) {
    if (!registry.has(model.name)) registry.set(model.name, { fingerprint: modelFingerprint(model) });
  }
  for (const model of inlineModels) {
    if (registry.has(model.name)) continue;
    registry.set(model.name, { fingerprint: modelFingerprint(model), operation: operationOf.get(model) });
  }
  const models: Model[] = [];
  for (const item of deferred) {
    const type = materializeDeferredType(item, registry, models);
    for (const target of item.targets) target.type = type;
  }
  return models;
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
 * `RenderPetCardTextHtmlResponse`; a fallback body from the stem and the
 * response's label, `ListPetsDefaultResponse`; an error body from the stem
 * and its status code, `GetPetError404` (`deriveErrorModelName`). Any of them
 * is a name a component schema, a model nested in one (`GetPet.error404` owns
 * `GetPetError404`), a primary body, the same header on a 429 or another
 * operation may already own with a different shape. Left alone, the later
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
 *   fallback  1. the bare name                `ListPetsDefaultResponse`
 *             2. a numeric suffix             `ListPetsDefaultResponse2`, `…3`, …
 *   error     1. the bare name                `GetPetError404`
 *             2. a `Body` suffix              `GetPetError404Body`
 *             3. a numbered `Body` suffix     `GetPetError404Body2`, `…Body3`, …
 *
 * Both the type and the models come from the same property name, so nested
 * models (`DocumentsXMeta429Origin`) line up by construction. A shape
 * identical to the name's current owner shares it and materializes nothing
 * new, which is also how a header reuses a matching component model. A
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
function materializeDeferredType(item: DeferredInlineType, registry: ModelShapeRegistry, models: Model[]): TypeRef {
  return materializeInlineSchema(item.schema, {
    stem: deferredNamingStem(item),
    parentName: item.parentName,
    componentSchemas: item.componentSchemas,
    registry,
    operation: item.operationQualifier,
    models,
  });
}

/** The candidate property names of a deferred schema, by kind (see `materializeDeferredType`). */
function deferredNamingStem(item: DeferredInlineType): (index: number, firstClashOwners: InlineModelOwner[]) => string {
  const { name, statusCode, operationQualifier } = item;
  const byStatus = `${name}${statusCode}`;
  const byOperation = `${operationQualifier}${name}`;
  const byBoth = `${operationQualifier}${name}${statusCode}`;
  const numbered = (index: number): string => `${name}${index + 2}`;
  switch (item.kind) {
    case 'header':
      // Decide the preference between candidates 2 and 3 from the bare
      // name's owners: a clash within this operation reads best by status
      // code, one with a component, a primary body or another operation by
      // operation name.
      return (index, firstClashOwners) => {
        const withinOperation = firstClashOwners.every((owner) => owner.operation === operationQualifier);
        const candidates = withinOperation
          ? [name, byStatus, byOperation, byBoth]
          : [name, byOperation, byStatus, byBoth];
        return index < candidates.length ? candidates[index] : numbered(index - candidates.length);
      };
    case 'content':
      return (index) => (index === 0 ? name : index === 1 ? byStatus : numbered(index - 2));
    case 'fallback':
      return (index) => (index === 0 ? name : numbered(index - 1));
    case 'error':
      return (index) => (index === 0 ? name : index === 1 ? `${name}Body` : `${name}Body${index}`);
  }
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
 * schema is deferred and its `type` filled in then.
 */
function extractResponseHeaders(
  headers: Record<string, RawHeaderObject> | undefined,
  operationLabel: string,
  // A status code, or the label of a fallback response (`Default`, `ClientError`).
  statusCode: number | string,
  ctx: ResponseTypingContext,
): ResponseHeader[] | undefined {
  if (!headers) return undefined;

  const result: ResponseHeader[] = [];
  for (const [name, raw] of Object.entries(headers)) {
    // OAS 3.x: a response header named `Content-Type` SHALL be ignored; the
    // media type is already carried by the response's `content` map.
    if (name.toLowerCase() === 'content-type') continue;

    const header = resolveHeaderRef(raw, ctx.componentHeaders, name, operationLabel);
    if (!header) continue;

    // A Header Object declares `schema` or a single-entry `content` map; with
    // `content`, the first (only) media type's schema types the header.
    const contentSchema = header.content ? Object.values(header.content)[0]?.schema : undefined;
    const schema = header.schema ?? contentSchema;
    const entry: ResponseHeader = {
      name,
      type: { kind: 'primitive', type: 'string' },
      required: header.required ?? false,
      description: header.description,
      deprecated: header.deprecated || undefined,
      // The header schema's own link — a Header Object has none — read from
      // whichever of `schema` and `content` types the header, as the type is.
      ...externalDocsEntry(schema?.externalDocs),
    };
    if (schema) {
      ctx.deferred.push({
        kind: 'header',
        schema,
        name,
        statusCode,
        operationQualifier: ctx.operationQualifier,
        parentName: ctx.serviceName ? toPascalCase(ctx.serviceName) : undefined,
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
 * `/notes/by-id` and `/notes/{id}`, `/notes` and `/notes/` all flatten to the
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
  const segments = path.split('/').filter(Boolean);
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
  let bestScore: [number, number] | undefined;
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

/**
 * How far a raw path's spelling is from the plain prefix it flattens to:
 * `[trailing slash, literal segments with any character outside a-z0-9]`,
 * compared lexicographically. `/notes` scores [0, 0] and `/notes/` [1, 0];
 * `/notes/{id}` scores [0, 0] and `/notes/by-id` [0, 1].
 */
function pathDeviation(rawPath: string): [number, number] {
  const trailingSlash = rawPath.length > 1 && rawPath.endsWith('/') ? 1 : 0;
  const irregularSegments = rawPath
    .split('/')
    .filter(Boolean)
    .filter((segment) => !segment.startsWith('{') && /[^a-z0-9]/.test(segment)).length;
  return [trailingSlash, irregularSegments];
}

function compareDeviation(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
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
  collectConstPrefixes(selectRequestBodyContent(body).schema, prefixes, 0);
  for (const [statusCode, response] of Object.entries(op.responses ?? {})) {
    const code = parseInt(statusCode, 10);
    if (code < 200 || code >= 300) continue;
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
 * `<Component>Response`: the inline body of a response declared once under
 * `components/responses` and referenced from each operation that returns it.
 * It is named after the component, not the operation, so every referrer
 * shares one model (`PetFound` → `PetFoundResponse`) instead of minting a
 * `<Op>Response` copy each; the suffix is not doubled when the component is
 * already named `…Response`. Cleaned like an operationId-derived name, so
 * the stem (`componentResponseModelBase`) prefixes everything derived from
 * it — a list's `<Component>Item`, nested `<Component>Response…` models.
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
 * operationIdModelBase for the argument). Reserved by resolvePathModelBaseNames
 * so no path-derived name takes it.
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
  /** The operation's response-model stem, e.g. `RenderPetCard`; with the response's label for a fallback, `ListPetsDefault`. */
  base: string;
  /** `Response` for a success or fallback entry, `Error` for an error entry. */
  suffix: string;
  /** A status code, or the label of a fallback response (`Default`, `ClientError`). */
  statusCode: number | string;
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
        : typeSecondaryContent(contentType, content[contentType]?.schema, naming, ctx, entry);
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
 * its media type as well: `RenderPetCardTextHtmlResponse`. That naming waits
 * for every primary model (`resolveDeferredInlineTypes`), so a schema is
 * deferred and `target.type` — returned here as a placeholder — filled in
 * then.
 */
function typeSecondaryContent(
  contentType: string,
  schema: SchemaObject | undefined,
  naming: ContentModelNaming,
  ctx: ResponseTypingContext,
  target: ResponseContent,
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
    name: `${naming.base}${mediaTypeToken(contentType)}${naming.suffix}`,
    statusCode: naming.statusCode,
    operationQualifier: ctx.operationQualifier,
    componentSchemas: ctx.componentSchemas,
    targets: [target],
  });
  return target.type;
}

/**
 * The PascalCase token that qualifies an inline model minted for a secondary
 * media type: `text/html` → `TextHtml`, `application/vnd.api+json` →
 * `ApplicationVndApiJson`. Parameters are part of it (`application/json;
 * charset=utf-8` → `ApplicationJsonCharsetUtf8`) so two parameterizations of
 * one type never share a model, and a wildcard segment reads as `Any`
 * (`application/*` → `ApplicationAny`) since the caser would drop the `*`.
 */
function mediaTypeToken(contentType: string): string {
  const token = toPascalCase(contentType.split('*').join('Any'));
  return token.length > 0 ? token : 'Content';
}

/**
 * A media type's essence — `type/subtype` without parameters, trimmed and
 * lower-cased — which is what decides how its body is typed (RFC 9110
 * §8.3.1). The content keys themselves stay as written.
 */
function mediaTypeEssence(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * `<Op>DefaultResponse`, `<Op>ClientErrorResponse`: a fallback body's inline
 * model, named like the primary body's `<Op>Response` with the response's
 * label (`Default`, or the word for its range) in between. Starts with the
 * operation's stem, so `operationIdModelBase` reserves it with the rest.
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

/** The range a key names, uppercased (`4xx` → `4XX`), or undefined when it names none. */
function statusRangeOf(key: string): StatusRange | undefined {
  const upper = key.toUpperCase();
  const isRange = upper.length === 3 && upper.endsWith('XX') && upper[0] >= '1' && upper[0] <= '5';
  return isRange ? (upper as StatusRange) : undefined;
}

/**
 * Read a Responses Object key that is not a status code into `sink`, and
 * say whether it was consumed: `default` and a range are kept; an `x-` key
 * is a specification extension and carries no response; anything else
 * OpenAPI does not define is warned about, then ignored, instead of being
 * dropped silently. A numeric key returns false so the caller reads it as
 * before — `parseInt` keeps `200`, `201 ` and the like exactly as they were.
 */
function readFallbackResponse(
  key: string,
  resp: ResponseObject | ReferenceObject,
  sink: FallbackResponseSink,
): boolean {
  if (key.startsWith('x-')) return true;
  const range = statusRangeOf(key);
  if (key === 'default' || range) {
    if (range && sink.rangeResponses.some((entry) => entry.range === range)) {
      // `4XX` and `4xx` side by side: JSON allows the pair, OpenAPI does not.
      console.warn(`[oagen] Warning: Duplicate "${range}" response on ${sink.opLabel}; keeping the first`);
      return true;
    }
    // The bundler leaves `$ref: '#/components/responses/…'` in place, and a
    // Reference Object has no `headers` or `content` of its own to read.
    const resolved = resolveResponseRef<ResponseObject>(
      resp,
      sink.ctx.componentResponses,
      `${key} response of ${sink.opLabel}`,
      sink.ctx.refSiblingDescriptions,
    );
    // The entry is filled in place: a deferred body's `type` lands on this
    // very object once every operation has been read.
    if (range) {
      const entry: RangeResponse = { range };
      fillFallbackResponse(entry, resolved, STATUS_RANGE_LABELS[range], sink);
      sink.rangeResponses.push(entry);
    } else {
      const entry: DefaultResponse = {};
      fillFallbackResponse(entry, resolved, 'Default', sink);
      sink.defaultResponse = entry;
    }
    return true;
  }
  if (Number.isNaN(parseInt(key, 10))) {
    console.warn(
      `[oagen] Warning: Ignoring response key "${key}" on ${sink.opLabel}: not a status code, a 1XX–5XX range, or "default"`,
    );
    return true;
  }
  return false;
}

/**
 * Read the body, media types and headers of one fallback response onto
 * `entry`; a key is left off when absent. The body is read before the
 * headers so its deferred models are named first, as they were when every
 * fallback body was typed ahead of every header. The media types are read
 * exactly as a success entry's: every one declared, the one `type` was read
 * from sharing its TypeRef, each other typed on its own — an inline object
 * under `text/plain` of the `default` response is `<Op>DefaultTextPlainResponse`.
 */
function fillFallbackResponse(
  entry: DefaultResponse | RangeResponse,
  resp: ResponseObject,
  label: string,
  sink: FallbackResponseSink,
): void {
  const contextName = deriveFallbackResponseName(sink.op, sink.pathModelBaseName, label);
  const json = jsonResponseSchema(resp);
  // Shared by reference with the deferred body, so the content entry of the
  // media type `type` was read from can join it once it exists.
  const targets: Array<{ type?: TypeRef }> = [entry];
  if (json) entry.type = typeFallbackBody(json.schema, contextName, label, sink, targets);
  const contents = extractResponseContents(
    resp.content,
    json?.contentType,
    entry.type,
    { base: contextName.replace(/Response$/, ''), suffix: 'Response', statusCode: label },
    sink.ctx,
  );
  if (contents) {
    entry.contentTypes = contents.contentTypes;
    entry.contents = contents.contents;
    const own = contents.contents.find((content) => content.contentType === json?.contentType);
    if (own) targets.push(own);
  }
  const headers = extractResponseHeaders(resp.headers, sink.opLabel, label, sink.ctx);
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
 * `…3`), nested models and ref together. List envelope and resource-wrapper
 * detection are skipped on purpose: a fallback body is not what the SDK
 * method returns, so it must not drive pagination. Returns the placeholder
 * the resolution replaces on `target`.
 */
function typeFallbackBody(
  schema: SchemaObject,
  contextName: string,
  label: string,
  sink: FallbackResponseSink,
  targets: Array<{ type?: TypeRef }>,
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
 * body already owns with a different shape moves the whole body to the next
 * free name (`GetPetError404Body`, `…Body2`), nested models and ref together;
 * an identical shape shares it. A titled variant that clashes (`Circle`) is
 * reserved and qualified (`CircleGetPetError400`), as under any deferred
 * kind. A body that is itself an inline enum, or an array of one, mints no
 * model and is promoted to `spec.enums` by `collectInlineEnumsFromOperations`.
 * List envelope and resource-wrapper detection are skipped on purpose, as for
 * a fallback body. Returns the placeholder the resolution replaces on every
 * target.
 */
function typeErrorBody(
  schema: SchemaObject,
  contextName: string,
  code: number,
  ctx: ResponseTypingContext,
  targets: Array<{ type?: TypeRef }>,
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
  const match =
    entries.find(([mediaType]) => mediaTypeEssence(mediaType) === 'application/json') ??
    entries.find(([mediaType]) => mediaTypeEssence(mediaType).endsWith('+json'));
  return match && match[1].schema ? { contentType: match[0], schema: match[1].schema } : undefined;
}

function extractResponses(
  responses: Record<string, ResponseObject> | undefined,
  op: OperationObject | undefined,
  pathModelBaseName: string,
  path?: string,
  method?: HttpMethod,
  componentSchemas?: Record<string, SchemaObject>,
  ctx: ResponseTypingContext = { operationQualifier: '', deferred: [] },
): {
  response: TypeRef;
  responseHeaders?: ResponseHeader[];
  responseContentTypes?: string[];
  responseContents?: ResponseContent[];
  responseDescription?: string;
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
  envelopeCompanions?: EnvelopeCompanion[];
} {
  const errors: ErrorResponse[] = [];
  let response: TypeRef = { kind: 'primitive', type: 'string' };
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
  let envelopeCompanions: EnvelopeCompanion[] | undefined;

  if (!responses) return { response, errors, inlineModels, isPaginated };

  const allSuccessResponses: SuccessResponse[] = [];
  const opLabel = operationLabel(op, path ?? '/', method ?? 'get');
  // Every 2xx body's classification, by status code. The models of all of
  // them are kept — `successResponses` references each — while the paging
  // fields are read from the status chosen as primary once every status code
  // has been read.
  const bodyResults = new Map<number, ResponseExtractionResult>();
  // Names the inline body a secondary media type declares: this stem, the
  // media type and the entry's role (`RenderPetCard` + `TextHtml` + `Response`).
  const contentModelBase = deriveResponseName(op, pathModelBaseName).replace(/Response$/, '');
  const fallback: FallbackResponseSink = { op, pathModelBaseName, opLabel, ctx, rangeResponses: [] };

  for (const [statusCode, rawResponse] of Object.entries(responses)) {
    // `default` and `1XX`–`5XX` never parse as a status code (`parseInt('2XX')`
    // is 2), so they are routed to their own fields before the numeric branches.
    if (readFallbackResponse(statusCode, rawResponse, fallback)) continue;
    const code = parseInt(statusCode, 10);
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
    // named after the component, shared by every operation that returns it.
    const componentName = code >= 200 ? componentResponseNameOf(rawResponse) : undefined;
    const componentModelName =
      componentName === undefined
        ? undefined
        : ctx.componentResponseModelNames
          ? ctx.componentResponseModelNames.get(componentName)
          : componentResponseModelName(componentName);
    // Headers belong to the status code they are declared on, success or
    // error alike: `Location` on a 201/302, `Retry-After` on a 429. A 1xx
    // response, which no branch below keeps, declares none worth
    // materializing models for; a fallback response's were read above.
    const headers = code >= 200 ? extractResponseHeaders(resp.headers, opLabel, code, ctx) : undefined;
    // The response's own `description`, success or error alike. Blank text
    // counts as absent, the way an operation's summary is read, and the key is
    // only added when there is something to keep. A `$ref` into
    // `components/responses` was resolved above, so the component's own
    // `description` is read; a sibling written next to the `$ref` wins in an
    // OAS 3.1 document and is ignored in 3.0 (`ctx.refSiblingDescriptions`).
    const description = presentText(resp.description);

    if (code >= 200 && code < 300) {
      let extractedType: TypeRef = { kind: 'primitive', type: 'unknown' };
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
        const result = classifyAndExtractResponse(bodySchema, contextName, componentSchemas);
        extractedType = result.response;
        bodyResults.set(code, result);
      }
      const contents = extractResponseContents(
        resp.content,
        primaryContentType,
        extractedType,
        { base: contentModelBase, suffix: 'Response', statusCode: code },
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
        { base: contentModelBase, suffix: 'Response', statusCode: code },
        ctx,
      );
      allSuccessResponses.push({
        statusCode: code,
        type: { kind: 'primitive', type: 'unknown' },
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
          )
        : undefined;
      entry.type = type;
      const contents = extractResponseContents(
        resp.content,
        json?.contentType,
        type,
        { base: contentModelBase, suffix: 'Error', statusCode: code },
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
  // no 2xx). With no 2xx or 3xx at all, `response` keeps its initial `string`;
  // a `2XX` range or `default` body is never promoted into it.
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
    envelopeCompanions = primaryBody.envelopeCompanions;
  }

  // Keep the models of every 2xx body: `successResponses` references each of
  // them, so keeping only one body's would leave the others dangling. Every
  // status derives the same `<Op>Response` context name, so on a name clash
  // the primary's definition — the one `response` points at — goes first and
  // wins; the other bodies follow in status order.
  // A dropped model whose shape differs from the kept one is warned about,
  // since its status then points at a shape it did not declare.
  const bodiesByPrimacy = [...bodyResults.entries()].sort(([a], [b]) => {
    if (a === primaryStatus) return -1;
    if (b === primaryStatus) return 1;
    return a - b;
  });
  const keptByName = new Map<string, { model: Model; status: number }>();
  for (const [status, result] of bodiesByPrimacy) {
    for (const model of result.inlineModels) {
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

  const successResponses = allSuccessResponses.length > 1 ? allSuccessResponses : undefined;

  return {
    response,
    responseHeaders,
    responseContentTypes,
    responseContents,
    responseDescription,
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
    envelopeCompanions,
  };
}

/**
 * Shared with the inline-model merge passes, which decide whether two
 * same-named inline models are the same shape but for `deprecated` by it.
 */
export { modelFingerprint };
