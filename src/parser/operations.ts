import type {
  Service,
  Operation,
  HttpMethod,
  Parameter,
  ParameterGroup,
  TypeRef,
  ErrorResponse,
  SuccessResponse,
  SecurityRequirement,
  Model,
  Field,
  PaginationMeta,
} from '../ir/types.js';
import { toPascalCase, toCamelCase, cleanSchemaName } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import { schemaToTypeRef, buildFieldFromSchema } from './schemas.js';
import { detectPagination } from './pagination.js';
import { classifyAndExtractResponse } from './responses.js';

interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
  trace?: OperationObject;
  parameters?: ParameterObject[];
}

interface ParameterGroupExtension {
  optional: boolean;
  variants: Record<string, string[]>;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  deprecated?: boolean;
  'x-oagen-async'?: boolean;
  security?: Array<Record<string, string[]>>;
  'x-mutually-exclusive-parameter-groups'?: Record<string, ParameterGroupExtension>;
  'x-mutually-exclusive-body-groups'?: Record<string, ParameterGroupExtension>;
}

interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
  deprecated?: boolean;
  example?: unknown;
  style?: string;
  explode?: boolean;
}

interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject }>;
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

export function extractOperations(
  paths: Record<string, PathItem> | undefined,
  operationIdTransform?: (id: string) => string,
): OperationExtractionResult {
  if (!paths) return { services: [], inlineModels: [] };

  const serviceMap = new Map<string, Operation[]>();
  const inlineModels: Model[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    const pathLevelParams = pathItem.parameters ?? [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const serviceName = inferServiceName(path, op.tags?.[0]);

      const { operation, inlineModels: opModels } = buildOperation(
        method,
        path,
        op,
        pathLevelParams,
        operationIdTransform,
        serviceName,
      );
      inlineModels.push(...opModels);
      const ops = serviceMap.get(serviceName) ?? [];
      ops.push(operation);
      serviceMap.set(serviceName, ops);
    }
  }

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

  const services = Array.from(serviceMap.entries()).map(([name, operations]) => ({
    name,
    operations,
  }));

  return { services, inlineModels };
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

function inferOperationName(
  method: HttpMethod,
  path: string,
  operationId?: string,
  operationIdTransform?: (id: string) => string,
): string {
  if (operationId) {
    if (operationIdTransform) {
      return operationIdTransform(operationId);
    }
    return toCamelCase(operationId);
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
 *   /user_management/users → "Users"
 *   /user_management/users/{id} → "User" (singular for item operations)
 *   /user_management/users/{id}/auth_factors → "AuthFactors"
 *   /organizations/{id}/api_keys → "ApiKeys"
 *   /sso/authorize → "Authorize" (action endpoint)
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
function extractBodyParameterGroups(op: OperationObject, operationContext: string): ParameterGroup[] | undefined {
  const raw = op['x-mutually-exclusive-body-groups'];
  if (!raw || typeof raw !== 'object') return undefined;

  // Collect the body schema's oneOf variant fields so we can resolve types.
  // The body schema has been structurally rewritten to allOf: [base, { oneOf: [...] }]
  // by the spec generator; the variant properties live inside oneOf branches.
  const bodySchema = op.requestBody?.content?.['application/json']?.schema;
  const variantFieldSchemas = new Map<string, SchemaObject>();

  if (bodySchema) {
    // Walk allOf → oneOf → variant.properties to find all variant fields
    for (const sub of bodySchema.allOf ?? []) {
      for (const variant of sub.oneOf ?? []) {
        if (variant.properties) {
          for (const [name, fieldSchema] of Object.entries(variant.properties)) {
            if (fieldSchema) variantFieldSchemas.set(name, fieldSchema);
          }
        }
      }
    }
    // Also check top-level oneOf (for inline schemas that aren't wrapped in allOf)
    for (const variant of bodySchema.oneOf ?? []) {
      if (variant.properties) {
        for (const [name, fieldSchema] of Object.entries(variant.properties)) {
          if (fieldSchema) variantFieldSchemas.set(name, fieldSchema);
        }
      }
    }
  }

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
        const fieldSchema = variantFieldSchemas.get(pName);
        const fieldType: TypeRef = fieldSchema
          ? schemaToTypeRef(fieldSchema, toPascalCase(pName))
          : { kind: 'primitive', type: 'string' };
        return {
          name: pName,
          type: fieldType,
          required: false, // group variant fields are always optional at the struct level
          description: fieldSchema?.description,
        };
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

function buildOperation(
  method: HttpMethod,
  path: string,
  op: OperationObject,
  pathLevelParams: ParameterObject[],
  operationIdTransform?: (id: string) => string,
  serviceName?: string,
): { operation: Operation; inlineModels: Model[] } {
  const allParams = [...pathLevelParams, ...(op.parameters ?? [])];

  const hasIdempotencyHeader = allParams.some((p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key');

  // Use the service name as context so inline parameter enums get qualified
  // names. e.g., service "SSO" + param "provider" → "SSOProvider".
  const opContext = serviceName;
  const pathParams = extractParams(allParams, 'path', opContext);
  const queryParams = extractParams(allParams, 'query', opContext);
  const headerParams = extractParams(allParams, 'header', opContext).filter(
    (p) => p.name.toLowerCase() !== 'idempotency-key',
  );
  const cookieParams = extractParams(allParams, 'cookie', opContext);

  const reqBodyModels: Model[] = [];
  const { body: requestBody, encoding: requestBodyEncoding } = extractRequestBody(op.requestBody, op, reqBodyModels);
  const {
    response,
    successResponses,
    errors,
    inlineModels,
    isPaginated,
    dataPath: responseDataPath,
    itemType: responseItemType,
  } = extractResponses(op.responses, op, path, method);
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
    };
  } else if (paginationFromParams) {
    pagination = paginationFromParams;
  }

  // Extract per-operation security overrides
  const security = extractOperationSecurity(op.security);

  // Extract mutually-exclusive parameter groups (query/path/header/cookie)
  const allIRParams = [...pathParams, ...queryParams, ...headerParams, ...cookieParams];
  const opLabel = op.operationId ?? `${method.toUpperCase()} ${path}`;
  const queryParamGroups = extractParameterGroups(op, allIRParams, opLabel);

  // Extract mutually-exclusive body parameter groups
  const bodyParamGroups = extractBodyParameterGroups(op, opLabel);

  // Merge both sources into a single parameterGroups array
  const parameterGroups =
    queryParamGroups || bodyParamGroups ? [...(queryParamGroups ?? []), ...(bodyParamGroups ?? [])] : undefined;

  return {
    operation: {
      name: inferOperationName(method, path, op.operationId, operationIdTransform),
      description: buildDescription(op.summary, op.description),
      httpMethod: method,
      path,
      pathParams,
      queryParams,
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
  };
}

/**
 * Extract per-operation security requirements from an OpenAPI security directive.
 * Returns undefined when the operation uses the spec-level default security.
 *
 * OpenAPI security format: `security: [{ schemeName: [scope1, scope2] }]`
 */
function extractOperationSecurity(
  security: Array<Record<string, string[]>> | undefined,
): SecurityRequirement[] | undefined {
  if (!security || security.length === 0) return undefined;

  const requirements: SecurityRequirement[] = [];
  for (const entry of security) {
    for (const [schemeName, scopes] of Object.entries(entry)) {
      requirements.push({ schemeName, scopes: scopes ?? [] });
    }
  }
  return requirements.length > 0 ? requirements : undefined;
}

function buildDescription(summary: string | undefined, description: string | undefined): string | undefined {
  if (summary && description && summary !== description) {
    return `${summary}\n\n${description}`;
  }
  return description ?? summary;
}

function extractParams(
  params: ParameterObject[],
  location: 'path' | 'query' | 'header' | 'cookie',
  operationContext?: string,
): Parameter[] {
  return params
    .filter((p) => p.in === location)
    .map((p) => ({
      name: p.name,
      type: p.schema
        ? schemaToTypeRef(p.schema, p.name, operationContext ? toPascalCase(operationContext) : undefined)
        : ({ kind: 'primitive', type: 'string' } as TypeRef),
      required: p.required ?? false,
      description: p.description,
      deprecated: p.deprecated || p.schema?.deprecated || undefined,
      default: p.schema?.default,
      example: p.example ?? p.schema?.example,
      style: p.style as Parameter['style'],
      explode: p.explode,
    }));
}

function extractRequestBody(
  body: RequestBodyObject | undefined,
  op: OperationObject | undefined,
  inlineModels: Model[],
): { body?: TypeRef; encoding?: 'json' | 'form-data' | 'form-urlencoded' | 'binary' | 'text' } {
  if (!body?.content) return {};

  // Detect encoding and find schema from content type in priority order
  let encoding: 'json' | 'form-data' | 'form-urlencoded' | 'binary' | 'text' = 'json';
  let schema: SchemaObject | undefined;

  if (body.content['application/json']?.schema) {
    encoding = 'json';
    schema = body.content['application/json']!.schema;
  } else if (body.content['multipart/form-data']?.schema) {
    encoding = 'form-data';
    schema = body.content['multipart/form-data']!.schema;
  } else if (body.content['application/x-www-form-urlencoded']?.schema) {
    encoding = 'form-urlencoded';
    schema = body.content['application/x-www-form-urlencoded']!.schema;
  } else if (body.content['application/octet-stream']) {
    encoding = 'binary';
    schema = body.content['application/octet-stream']!.schema;
  } else if (body.content['text/plain']) {
    encoding = 'text';
    schema = body.content['text/plain']!.schema;
  }

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

  const rawName = op?.operationId ? toPascalCase(op.operationId) + 'Request' : 'RequestBody';
  const contextName = cleanSchemaName(rawName);

  // If the request body is an inline object with properties, extract it as a model
  if (schema.properties && (schema.type === 'object' || !schema.type)) {
    const requiredSet = new Set(schema.required ?? []);
    const fields: Field[] = [];
    for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
      if (!fieldSchema) continue;
      fields.push(buildFieldFromSchema(fieldName, fieldSchema, contextName, requiredSet));
    }
    inlineModels.push({ name: contextName, description: undefined, fields });
    return { body: { kind: 'model', name: contextName }, encoding };
  }

  // If the request body is a oneOf, extract each variant as an inline model
  // and build a union type pointing to them by name.
  if (schema.oneOf) {
    const variants: TypeRef[] = [];

    for (const variant of schema.oneOf) {
      if (variant.$ref) {
        const ref = schemaToTypeRef(variant, contextName);
        variants.push(ref);
      } else if (variant.type === 'null') {
        // skip null variant in union, handle separately
      } else if (variant.properties && (variant.type === 'object' || !variant.type)) {
        const variantName = deriveOneOfVariantName(variant, contextName, inlineModels);
        const requiredSet = new Set(variant.required ?? []);
        const fields: Field[] = [];
        for (const [fieldName, fieldSchema] of Object.entries(variant.properties)) {
          if (!fieldSchema) continue;
          fields.push(buildFieldFromSchema(fieldName, fieldSchema, variantName, requiredSet));
        }
        inlineModels.push({ name: variantName, description: variant.description, fields });
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

/** Derive a unique variant name for a oneOf inline model. */
function deriveOneOfVariantName(variant: SchemaObject, baseName: string, existingModels: Model[]): string {
  // Try to use a distinguishing property (e.g., "grant_type" field's const/enum value)
  if (variant.properties) {
    for (const [, propSchema] of Object.entries(variant.properties)) {
      if (propSchema?.const && typeof propSchema.const === 'string') {
        return toPascalCase(propSchema.const) + baseName.replace(/Request$/, '') + 'Request';
      }
    }
  }
  // Fallback: append a numeric suffix
  const existingNames = new Set(existingModels.map((m) => m.name));
  let name = baseName;
  let suffix = 2;
  while (existingNames.has(name)) {
    name = `${baseName}${suffix}`;
    suffix++;
  }
  return name;
}

function deriveResponseName(op: OperationObject | undefined, path: string, method: HttpMethod): string {
  if (op?.operationId) {
    return cleanSchemaName(toPascalCase(op.operationId) + 'Response');
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
): {
  response: TypeRef;
  successResponses?: SuccessResponse[];
  errors: ErrorResponse[];
  inlineModels: Model[];
  isPaginated: boolean;
  dataPath?: string;
  itemType?: TypeRef;
} {
  const errors: ErrorResponse[] = [];
  let response: TypeRef = { kind: 'primitive', type: 'string' };
  let inlineModels: Model[] = [];
  let isPaginated = false;
  let dataPath: string | undefined;
  let itemType: TypeRef | undefined;

  if (!responses) return { response, errors, inlineModels, isPaginated };

  const allSuccessResponses: SuccessResponse[] = [];

  for (const [statusCode, resp] of Object.entries(responses)) {
    const code = parseInt(statusCode, 10);

    if (code >= 200 && code < 300) {
      let extractedType: TypeRef = { kind: 'primitive', type: 'unknown' };
      const jsonContent = resp.content?.['application/json'];
      if (jsonContent?.schema) {
        const contextName = deriveResponseName(op, path ?? '/', method ?? 'get');
        const result = classifyAndExtractResponse(jsonContent.schema, contextName);
        extractedType = result.response;
        // Keep track of inline models and pagination from the latest 2xx with a schema
        inlineModels = result.inlineModels;
        isPaginated = result.isPaginated;
        dataPath = result.dataPath;
        itemType = result.itemType;
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

  return { response, successResponses, errors, inlineModels, isPaginated, dataPath, itemType };
}
