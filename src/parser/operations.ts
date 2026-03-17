import type {
  Service,
  Operation,
  HttpMethod,
  Parameter,
  TypeRef,
  ErrorResponse,
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
  parameters?: ParameterObject[];
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
}

interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
}

interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject }>;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
}

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

export interface OperationExtractionResult {
  services: Service[];
  inlineModels: Model[];
}

export function extractOperations(paths: Record<string, PathItem> | undefined): OperationExtractionResult {
  if (!paths) return { services: [], inlineModels: [] };

  const serviceMap = new Map<string, Operation[]>();
  const inlineModels: Model[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    const serviceName = inferServiceName(path);
    const pathLevelParams = pathItem.parameters ?? [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const { operation, inlineModels: opModels } = buildOperation(method, path, op, pathLevelParams);
      inlineModels.push(...opModels);
      const ops = serviceMap.get(serviceName) ?? [];
      ops.push(operation);
      serviceMap.set(serviceName, ops);
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

function inferServiceName(path: string): string {
  // Extract first meaningful path segment: /widgets/{id}/sub → "Widgets"
  const segments = path.split('/').filter(Boolean);
  const first = segments[0] ?? 'Default';
  // Skip path params
  if (first.startsWith('{')) return 'Default';
  return toPascalCase(first);
}

function inferOperationName(method: HttpMethod, path: string, operationId?: string): string {
  // NestJS operationIds follow the pattern: {Resource}Controller_{action}
  // Extract the action part (after _) which is the actual method name.
  if (operationId) {
    const stripped = operationId.replace(/Controller/g, '');
    const underscoreIdx = stripped.indexOf('_');
    if (underscoreIdx !== -1) {
      const action = stripped.slice(underscoreIdx + 1);
      return toCamelCase(action);
    }
    // No underscore — use the full cleaned operationId
    return toCamelCase(stripped);
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

function buildOperation(
  method: HttpMethod,
  path: string,
  op: OperationObject,
  pathLevelParams: ParameterObject[],
): { operation: Operation; inlineModels: Model[] } {
  const allParams = [...pathLevelParams, ...(op.parameters ?? [])];

  const pathParams = extractParams(allParams, 'path');
  const queryParams = extractParams(allParams, 'query');
  const headerParams = extractParams(allParams, 'header');

  const reqBodyModels: Model[] = [];
  const { body: requestBody, encoding: requestBodyEncoding } = extractRequestBody(op.requestBody, op, reqBodyModels);
  const {
    response,
    errors,
    inlineModels,
    isPaginated,
    dataPath: responseDataPath,
    itemType: responseItemType,
  } = extractResponses(op.responses, op, path, method);
  inlineModels.push(...reqBodyModels);

  // Build structured pagination metadata from response classification and query param detection
  const paginationFromParams = detectPagination(response, queryParams);
  let pagination: PaginationMeta | undefined;
  if (isPaginated) {
    const itemType = responseItemType ?? (response.kind === 'array' ? response.items : response);
    pagination = {
      cursorParam: paginationFromParams?.cursorParam ?? 'after',
      dataPath: responseDataPath ?? 'data',
      itemType,
    };
  } else if (paginationFromParams) {
    pagination = paginationFromParams;
  }

  return {
    operation: {
      name: inferOperationName(method, path, op.operationId),
      description: op.description ?? op.summary,
      httpMethod: method,
      path,
      pathParams,
      queryParams,
      headerParams,
      requestBody,
      requestBodyEncoding,
      response,
      errors,
      pagination,
      idempotent: method === 'post',
    },
    inlineModels,
  };
}

function extractParams(params: ParameterObject[], location: 'path' | 'query' | 'header'): Parameter[] {
  return params
    .filter((p) => p.in === location)
    .map((p) => ({
      name: p.name,
      type: p.schema ? schemaToTypeRef(p.schema, p.name) : ({ kind: 'primitive', type: 'string' } as TypeRef),
      required: p.required ?? false,
      description: p.description,
    }));
}

function extractRequestBody(
  body: RequestBodyObject | undefined,
  op: OperationObject | undefined,
  inlineModels: Model[],
): { body?: TypeRef; encoding?: 'json' | 'form-data' | 'binary' | 'text' } {
  if (!body?.content) return {};

  // Detect encoding and find schema from content type in priority order
  let encoding: 'json' | 'form-data' | 'binary' | 'text' = 'json';
  let schema: SchemaObject | undefined;

  if (body.content['application/json']?.schema) {
    encoding = 'json';
    schema = body.content['application/json']!.schema;
  } else if (body.content['multipart/form-data']?.schema) {
    encoding = 'form-data';
    schema = body.content['multipart/form-data']!.schema;
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

  return { body: schemaToTypeRef(schema, contextName), encoding };
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

  for (const [statusCode, resp] of Object.entries(responses)) {
    const code = parseInt(statusCode, 10);

    if (code >= 200 && code < 300) {
      const jsonContent = resp.content?.['application/json'];
      if (jsonContent?.schema) {
        const contextName = deriveResponseName(op, path ?? '/', method ?? 'get');
        const result = classifyAndExtractResponse(jsonContent.schema, contextName);
        response = result.response;
        inlineModels = result.inlineModels;
        isPaginated = result.isPaginated;
        dataPath = result.dataPath;
        itemType = result.itemType;
      }
    } else if (code >= 400) {
      const jsonContent = resp.content?.['application/json'];
      const type = jsonContent?.schema ? schemaToTypeRef(jsonContent.schema, `Error${code}`) : undefined;
      errors.push({ statusCode: code, type });
    }
  }

  return { response, errors, inlineModels, isPaginated, dataPath, itemType };
}
