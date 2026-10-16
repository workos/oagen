import type {
  Service,
  Operation,
  HttpMethod,
  Parameter,
  ParameterGroup,
  TypeRef,
  ErrorResponse,
  SuccessResponse,
  Model,
  Field,
  PaginationMeta,
} from '../ir/types.js';
import { toPascalCase, toCamelCase, cleanSchemaName } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import {
  schemaToTypeRef,
  buildFieldFromSchema,
  nameInlineVariant,
  resolveSchemaName,
  nonEmptyExamples,
  resolveExamples,
  resolveComponentSchemaRef,
} from './schemas.js';
import { collectProperties, extractInlineModelsFromProperties } from './inline-models.js';
import { detectPagination } from './pagination.js';
import { classifyAndExtractResponse } from './responses.js';
import { extractSecurityRequirements, type RawSecurityRequirements } from './security.js';
import { resolveEnvelopeCompanionNames, type EnvelopeCompanion } from './envelope-companion-names.js';

interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
  trace?: OperationObject;
  parameters?: RawParameterObject[];
}

interface ParameterGroupExtension {
  optional: boolean;
  variants: Record<string, string[]>;
  /** Per-variant names that may be omitted when the variant is used. */
  optionalFields?: Record<string, string[]>;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: RawParameterObject[];
  requestBody?: RawRequestBodyObject;
  responses?: Record<string, ResponseObject>;
  deprecated?: boolean;
  'x-oagen-async'?: boolean;
  security?: RawSecurityRequirements;
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

interface ParameterObject {
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
type RawParameterObject = ParameterObject | { $ref: string };

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
function resolveParameterRef(
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

interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject }>;
}

/**
 * A request body as written in the spec: an inline Request Body Object or a
 * Reference Object into `components/requestBodies`. The bundler never inlines
 * those refs (`dereference: false`), so they must be resolved before use.
 */
type RawRequestBodyObject = RequestBodyObject | { $ref: string };

/**
 * Resolve a raw request body to a concrete Request Body Object, following
 * `$ref` chains into `components/requestBodies` with a cycle guard. Throws on
 * an unresolvable ref so a malformed spec fails at parse time instead of
 * silently losing the body — and with it the body-ownership rule that keeps
 * duplicated secrets out of the query string.
 */
function resolveRequestBodyRef(
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

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
}

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

export interface OperationExtractionResult {
  services: Service[];
  inlineModels: Model[];
}

/** A top-level `tags[]` entry as it appears in the OpenAPI document. */
export interface TagObject {
  name?: string;
  description?: string;
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
): OperationExtractionResult {
  if (!paths) return { services: [], inlineModels: [] };

  const serviceMap = new Map<string, Operation[]>();
  const inlineModels: Model[] = [];
  const envelopeCompanions: EnvelopeCompanion[] = [];
  // Service name each tagged operation was grouped under, keyed by operation
  // identity. The path-prefix split below moves operations between services,
  // so this is how a split-off service is traced back to the tag it came from.
  const tagServiceByOperation = new Map<Operation, string>();

  for (const [path, pathItem] of Object.entries(paths)) {
    const pathLevelParams = pathItem.parameters ?? [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const tag = op.tags?.[0];
      const serviceName = inferServiceName(path, tag);

      const {
        operation,
        inlineModels: opModels,
        envelopeCompanions: opCompanions,
      } = buildOperation(
        method,
        path,
        op,
        pathLevelParams,
        operationIdTransform,
        serviceName,
        componentSchemas,
        componentParameters,
        componentRequestBodies,
        componentExamples,
      );
      inlineModels.push(...opModels);
      if (opCompanions) envelopeCompanions.push(...opCompanions);
      // Same truthiness check as inferServiceName: for a tagged operation the
      // service name *is* the normalized tag, so it doubles as the lookup key.
      if (tag) tagServiceByOperation.set(operation, serviceName);
      const ops = serviceMap.get(serviceName) ?? [];
      ops.push(operation);
      serviceMap.set(serviceName, ops);
    }
  }

  // Companion models of list envelopes are named once every list operation is
  // known, so copies of one envelope shape can share a model.
  inlineModels.push(...resolveEnvelopeCompanionNames(envelopeCompanions, componentModels));

  // Split services when a single tag groups operations from multiple path prefixes.
  // Example: /organizations and /organization_domains both tagged "organizations"
  // should become separate services based on their first path segment.
  for (const [serviceName, operations] of serviceMap) {
    const pathGroups = new Map<string, Operation[]>();
    for (const op of operations) {
      const firstSeg = op.path.split('/').filter(Boolean)[0] ?? '';
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
  for (const [, operations] of serviceMap) {
    disambiguateOperationNames(operations);
  }

  const declaredTags = indexDocumentTags(documentTags);
  const services: Service[] = Array.from(serviceMap.entries()).map(([name, operations]) => {
    const description = resolveServiceDescription(name, operations, tagServiceByOperation, declaredTags);
    // Omit the key entirely when no tag describes the service so the IR shape
    // is unchanged for documents without tag descriptions.
    return description === undefined ? { name, operations } : { name, description, operations };
  });

  return { services, inlineModels };
}

/**
 * Index the document's top-level `tags[]` by the service name each tag
 * produces, so a tag spelled `user_management`, `User Management`, or
 * `user-management` all map to the `UserManagement` service. Every named tag
 * is indexed — with its description when it declares a non-blank one, and
 * `undefined` otherwise — because a declared-but-undescribed tag still marks
 * its service as one that must not borrow another tag's wording. When several
 * tags normalize to the same service name, the first described one wins.
 *
 * `parseSpec` ignored `tags` entirely before descriptions were read, so a
 * document with a malformed value — `tags` written as an object, a `null`
 * entry, a numeric `name` — used to parse and must keep parsing. Anything
 * that cannot be matched is skipped rather than thrown on.
 */
function indexDocumentTags(documentTags: unknown): Map<string, string | undefined> {
  const index = new Map<string, string | undefined>();
  if (!Array.isArray(documentTags)) return index;
  for (const tag of documentTags as unknown[]) {
    if (typeof tag !== 'object' || tag === null) continue;
    const { name, description } = tag as TagObject;
    if (typeof name !== 'string' || name === '') continue;
    const serviceName = toPascalCase(name);
    if (index.get(serviceName) !== undefined) continue;
    const described = typeof description === 'string' && description.trim() !== '';
    index.set(serviceName, described ? description : undefined);
  }
  return index;
}

/**
 * Pick a service's description from the document's tags.
 *
 * A service whose own name is a declared tag is described by that tag alone:
 * its description when it has one, nothing otherwise. Another tag's wording is
 * never borrowed for it — operations tagged `api_keys` that the path-prefix
 * split merges into `UserManagement` must not label that service "API keys".
 *
 * A service whose own name is not declared is one the split carved out of a
 * tag (e.g. `OrganizationDomains` from operations tagged `organizations`); it
 * inherits the description of the first described tag its operations carry.
 * Path-named services whose operations have no tag carry nothing and stay
 * undescribed.
 */
function resolveServiceDescription(
  serviceName: string,
  operations: Operation[],
  tagServiceByOperation: Map<Operation, string>,
  declaredTags: Map<string, string | undefined>,
): string | undefined {
  if (declaredTags.has(serviceName)) return declaredTags.get(serviceName);
  for (const op of operations) {
    const tagService = tagServiceByOperation.get(op);
    if (tagService === undefined) continue;
    const description = declaredTags.get(tagService);
    if (description !== undefined) return description;
  }
  return undefined;
}

function inferServiceName(path: string, tag?: string): string {
  // Prefer OpenAPI tag when available — tags represent the logical grouping
  // (e.g., "multi-factor-auth" for /auth/factors/* endpoints).
  if (tag) {
    return toPascalCase(tag);
  }
  // Fallback: extract first meaningful path segment: /widgets/{id}/sub → "Widgets"
  const segments = path.split('/').filter(Boolean);
  const first = segments[0] ?? 'Default';
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

function inferOperationName(
  method: HttpMethod,
  path: string,
  operationId?: string,
  operationIdTransform?: (id: string) => string,
): string {
  if (operationId) {
    const normalized = normalizeOperationIdForNaming(operationId);
    if (operationIdTransform) {
      return operationIdTransform(normalized);
    }
    return toCamelCase(normalized);
  }

  // Fallback when no operationId is available — use method + path to build
  // a descriptive name like "listUsers", "getOrganization", "deleteAuthFactor"
  const verb = inferVerb(method, path);
  const resource = inferResourceFromPath(path);
  return resource ? toCamelCase(`${verb}_${resource}`) : verb;
}

/**
 * Infer the CRUD verb from HTTP method and path shape.
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
 * Uses the last non-param segment (the resource being operated on).
 *
 * Examples:
 *   /accounts/users → "Users"
 *   /accounts/users/{id} → "User" (singular for item operations)
 *   /accounts/users/{id}/auth_factors → "AuthFactors"
 *   /organizations/{id}/api_keys → "ApiKeys"
 *   /auth/authorize → "Authorize" (action endpoint)
 */
function inferResourceFromPath(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 1) return null;

  // Find the last meaningful (non-param) segment
  let resourceSegment: string | null = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i].startsWith('{')) {
      resourceSegment = segments[i];
      break;
    }
  }

  if (!resourceSegment) return null;
  // Skip the service name (first segment) — it would be redundant
  if (resourceSegment === segments[0]) return null;

  return toPascalCase(resourceSegment);
}

/**
 * Detect and resolve name collisions within a service's operations.
 *
 * When multiple operations share the same name (e.g., several "list" from
 * different sub-resources), disambiguate by appending the resource noun
 * from the path. Only renames operations on DIFFERENT paths — same-name
 * operations on the same path (e.g., PUT + PATCH both "update") are left as-is
 * since they represent the same logical resource.
 */
function disambiguateOperationNames(operations: Operation[]): void {
  // Group by name
  const byName = new Map<string, Operation[]>();
  for (const op of operations) {
    const group = byName.get(op.name) ?? [];
    group.push(op);
    byName.set(op.name, group);
  }

  for (const [name, group] of byName) {
    if (group.length <= 1) continue;

    // Check if these are genuinely different resources (different paths)
    // vs the same resource with different methods (PUT + PATCH)
    const uniquePaths = new Set(group.map((op) => op.path));
    if (uniquePaths.size <= 1) continue; // same path, different methods — no disambiguation needed

    for (const op of group) {
      const resource = inferResourceFromPath(op.path);
      if (resource) {
        const newName = toCamelCase(`${name}_${resource}`);
        (op as { name: string }).name = newName;
      }
    }

    // If disambiguation still left collisions (same sub-resource),
    // use the full distinguishing path segment chain
    const renamed = new Map<string, Operation[]>();
    for (const op of group) {
      const rGroup = renamed.get(op.name) ?? [];
      rGroup.push(op);
      renamed.set(op.name, rGroup);
    }
    for (const [, rGroup] of renamed) {
      if (rGroup.length <= 1) continue;
      // Still colliding — different paths map to same resource name.
      // Use deeper path context to disambiguate.
      for (const op of rGroup) {
        const deeper = inferDeeperContext(op.path);
        if (deeper) {
          (op as { name: string }).name = toCamelCase(`${op.name}_${deeper}`);
        }
      }
    }
  }
}

/**
 * Extract a deeper disambiguation context from the path when the last
 * segment isn't unique enough. Uses the second-to-last non-param segment.
 *
 * /users/{id}/auth_factors → already captured as "AuthFactors"
 * /users/external_id/{external_id} → "ExternalId" (special path, not a sub-resource)
 */
function inferDeeperContext(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  const nonParams = segments.filter((s) => !s.startsWith('{'));
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
  operationIdTransform?: (id: string) => string,
  serviceName?: string,
  componentSchemas?: Record<string, SchemaObject>,
  componentParameters?: Record<string, Record<string, unknown>>,
  componentRequestBodies?: Record<string, Record<string, unknown>>,
  componentExamples?: Record<string, Record<string, unknown>>,
): { operation: Operation; inlineModels: Model[]; envelopeCompanions?: EnvelopeCompanion[] } {
  const opLabel = op.operationId ?? `${method.toUpperCase()} ${path}`;
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
    reqBodyModels,
    componentSchemas,
  );
  const {
    response,
    successResponses,
    errors,
    inlineModels,
    isPaginated,
    dataPath: responseDataPath,
    itemType: responseItemType,
    envelopeFields,
    envelopeCompanions,
  } = extractResponses(op.responses, op, path, method, componentSchemas);
  inlineModels.push(...reqBodyModels);

  // Build structured pagination metadata from response classification and query param detection
  const paginationFromParams = detectPagination(response, queryParams, responseDataPath);
  let pagination: PaginationMeta | undefined;
  if (isPaginated) {
    const itemType = responseItemType ?? (response.kind === 'array' ? response.items : response);
    pagination = {
      strategy: paginationFromParams?.strategy ?? 'cursor',
      param: paginationFromParams?.param ?? 'after',
      limitParam: paginationFromParams?.limitParam,
      dataPath: responseDataPath ?? paginationFromParams?.dataPath,
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
      name: inferOperationName(method, path, op.operationId, operationIdTransform),
      // Keep the summary on its own so emitters can tell it apart from the
      // description; the key is omitted (not set to undefined) when absent.
      ...(summary !== undefined ? { summary } : {}),
      description: buildDescription(summary, op.description),
      httpMethod: method,
      path,
      pathParams,
      queryParams,
      bodyOwnedQueryParams: bodyOwnedQueryParams.length > 0 ? bodyOwnedQueryParams : undefined,
      headerParams,
      cookieParams: cookieParams.length > 0 ? cookieParams : undefined,
      requestBody,
      requestBodyEncoding,
      response,
      successResponses,
      errors,
      pagination,
      injectIdempotencyKey: hasIdempotencyHeader,
      deprecated: op.deprecated || undefined,
      async: op['x-oagen-async'],
      security,
      parameterGroups,
    },
    inlineModels,
    envelopeCompanions,
  };
}

/**
 * Combine an operation's `summary` and `description` into one doc text.
 * Empty or whitespace-only text counts as absent, so `summary: "List pets"`
 * with `description: ""` yields `"List pets"` rather than `""`. Text that has
 * content is kept verbatim, surrounding whitespace included.
 */
function buildDescription(summary: string | undefined, description: string | undefined): string | undefined {
  const presentSummary = presentText(summary);
  const presentDescription = presentText(description);
  if (presentSummary && presentDescription && presentSummary !== presentDescription) {
    return `${presentSummary}\n\n${presentDescription}`;
  }
  return presentDescription ?? presentSummary;
}

/** The text itself when it has non-whitespace content, otherwise `undefined`. */
function presentText(text: string | undefined): string | undefined {
  return typeof text === 'string' && text.trim() !== '' ? text : undefined;
}

function extractParams(
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
      return {
        name: p.name,
        type: p.schema
          ? schemaToTypeRef(p.schema, p.name, operationContext ? toPascalCase(operationContext) : undefined)
          : ({ kind: 'primitive', type: 'string' } as TypeRef),
        required: p.required ?? false,
        description: firstDescription(p.description, p.schema?.description, refTarget?.description),
        deprecated: p.deprecated || p.schema?.deprecated || refTarget?.deprecated || undefined,
        default: p.schema?.default ?? refTarget?.default,
        example,
        ...(examples ? { examples } : {}),
        style: p.style as Parameter['style'],
        explode: p.explode,
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

type RequestBodyEncoding = 'json' | 'form-data' | 'form-urlencoded' | 'binary' | 'text';

/** HTTP methods whose request body is the primary parameter carrier. */
const BODY_CARRYING_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['post', 'put', 'patch']);

/**
 * Pick the request body's schema and wire encoding from its content map, in
 * priority order. JSON wins over form encodings; binary and text bodies may
 * legitimately carry no schema at all.
 */
function selectRequestBodyContent(body: RequestBodyObject | undefined): {
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

  const rawName = op?.operationId
    ? toPascalCase(normalizeOperationIdForNaming(op.operationId)) + 'Request'
    : 'RequestBody';
  const contextName = cleanSchemaName(rawName);

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
    inlineModels.push({ name: contextName, description: undefined, fields });
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

    for (const variant of schema.oneOf) {
      if (variant.$ref) {
        const ref = schemaToTypeRef(variant, contextName);
        variants.push(ref);
      } else if (variant.type === 'null') {
        // skip null variant in union, handle separately
      } else if (variant.properties && (variant.type === 'object' || !variant.type)) {
        const named = deriveOneOfVariantName(variant, contextName, inlineModels, inlineObjectVariants, contentNamed);
        const variantName = named.name;
        if (named.fromContent) contentNamed.push(variantName);
        const requiredSet = new Set(variant.required ?? []);
        const siblings = collectProperties(variant);
        const fields: Field[] = [];
        for (const [fieldName, fieldSchema] of Object.entries(variant.properties)) {
          if (!fieldSchema) continue;
          fields.push(
            buildFieldFromSchema(fieldName, fieldSchema, variantName, requiredSet, componentSchemas, siblings),
          );
        }
        inlineModels.push({ name: variantName, description: variant.description, fields });
        extractInlineModelsFromProperties(variant, inlineModels, variantName, componentSchemas);
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
 * one there. A clash with a model minted elsewhere still bumps the counter.
 */
function deriveOneOfVariantName(
  variant: SchemaObject,
  baseName: string,
  existingModels: Model[],
  siblings: readonly SchemaObject[],
  contentNamed: readonly string[],
): { name: string; fromContent: boolean } {
  // Try to use a distinguishing property (e.g., "grant_type" field's const/enum value)
  if (variant.properties) {
    for (const [, propSchema] of Object.entries(variant.properties)) {
      if (propSchema?.const && typeof propSchema.const === 'string') {
        const derivedName = toPascalCase(propSchema.const) + baseName.replace(/Request$/, '') + 'Request';
        // Const-derived request variants are IR models too, so they must use
        // the same project-level naming policy as component schemas.
        return { name: resolveSchemaName(derivedName), fromContent: false };
      }
    }
  }
  const existingNames = new Set(existingModels.map((m) => m.name));
  // Apply the transform before naming so every candidate stays in the same
  // post-schemaNameTransform namespace as the rest of the IR.
  const transformedBaseName = resolveSchemaName(baseName);
  let name = nameInlineVariant(variant, siblings, transformedBaseName, contentNamed, null);
  let suffix = 2;
  while (existingNames.has(name)) {
    name = `${transformedBaseName}${suffix}`;
    suffix++;
  }
  return { name, fromContent: true };
}

function deriveResponseName(op: OperationObject | undefined, path: string, method: HttpMethod): string {
  if (op?.operationId) {
    return cleanSchemaName(toPascalCase(normalizeOperationIdForNaming(op.operationId)) + 'Response');
  }
  const segments = path.split('/').filter(Boolean);
  const resource = segments[0] ?? 'Unknown';
  return toPascalCase(resource) + toPascalCase(method) + 'Response';
}

function extractResponses(
  responses?: Record<string, ResponseObject>,
  op?: OperationObject,
  path?: string,
  method?: HttpMethod,
  componentSchemas?: Record<string, SchemaObject>,
): {
  response: TypeRef;
  successResponses?: SuccessResponse[];
  errors: ErrorResponse[];
  inlineModels: Model[];
  isPaginated: boolean;
  dataPath?: string;
  itemType?: TypeRef;
  envelopeFields?: Field[];
  envelopeCompanions?: EnvelopeCompanion[];
} {
  const errors: ErrorResponse[] = [];
  let response: TypeRef = { kind: 'primitive', type: 'string' };
  let inlineModels: Model[] = [];
  let isPaginated = false;
  let dataPath: string | undefined;
  let itemType: TypeRef | undefined;
  let envelopeFields: Field[] | undefined;
  let envelopeCompanions: EnvelopeCompanion[] | undefined;

  if (!responses) return { response, errors, inlineModels, isPaginated };

  const allSuccessResponses: SuccessResponse[] = [];

  for (const [statusCode, resp] of Object.entries(responses)) {
    const code = parseInt(statusCode, 10);

    if (code >= 200 && code < 300) {
      let extractedType: TypeRef = { kind: 'primitive', type: 'unknown' };
      const jsonContent = resp.content?.['application/json'];
      if (jsonContent?.schema) {
        const contextName = deriveResponseName(op, path ?? '/', method ?? 'get');
        const result = classifyAndExtractResponse(jsonContent.schema, contextName, componentSchemas);
        extractedType = result.response;
        // Keep track of inline models and pagination from the latest 2xx with a schema
        inlineModels = result.inlineModels;
        isPaginated = result.isPaginated;
        dataPath = result.dataPath;
        itemType = result.itemType;
        envelopeFields = result.envelopeFields;
        envelopeCompanions = result.envelopeCompanions;
      } else if (resp.content) {
        // Handle non-JSON response content types (text/plain, binary, XML, etc.)
        if (resp.content['application/octet-stream'] || resp.content['application/pdf']) {
          extractedType = { kind: 'primitive', type: 'string', format: 'binary' };
        } else if (
          resp.content['text/plain'] ||
          resp.content['text/html'] ||
          resp.content['text/xml'] ||
          resp.content['application/xml']
        ) {
          extractedType = { kind: 'primitive', type: 'string' };
        } else {
          // Try the first available content type's schema
          const firstKey = Object.keys(resp.content)[0];
          if (firstKey) {
            const firstContent = resp.content[firstKey];
            if (firstContent?.schema) {
              extractedType = schemaToTypeRef(
                firstContent.schema,
                deriveResponseName(op, path ?? '/', method ?? 'get'),
              );
            }
          }
        }
      }
      allSuccessResponses.push({ statusCode: code, type: extractedType });
    } else if (code >= 300 && code < 400) {
      // 3xx redirects — include so emitter can detect redirect endpoints
      allSuccessResponses.push({ statusCode: code, type: { kind: 'primitive', type: 'unknown' } });
    } else if (code >= 400) {
      const jsonContent = resp.content?.['application/json'];
      const type = jsonContent?.schema ? schemaToTypeRef(jsonContent.schema, `Error${code}`) : undefined;
      errors.push({ statusCode: code, type });
    }
  }

  // Primary response = lowest 2xx with a body schema, falling back to first 2xx
  if (allSuccessResponses.length > 0) {
    const sorted = [...allSuccessResponses].sort((a, b) => a.statusCode - b.statusCode);
    const primary =
      sorted.find((r) => r.type.kind !== 'primitive' || (r.type as { type: string }).type !== 'unknown') ?? sorted[0];
    response = primary.type;
  }

  const successResponses = allSuccessResponses.length > 1 ? allSuccessResponses : undefined;

  return {
    response,
    successResponses,
    errors,
    inlineModels,
    isPaginated,
    dataPath,
    itemType,
    envelopeFields,
    envelopeCompanions,
  };
}
