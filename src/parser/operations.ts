import type { Service, Operation, HttpMethod, Parameter, TypeRef, ErrorResponse } from '../ir/types.js';
import { toPascalCase, toCamelCase } from '../utils/naming.js';
import { schemaToTypeRef } from './schemas.js';
import { detectPagination } from './pagination.js';

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
  schema?: Record<string, unknown>;
}

interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

export function extractOperations(paths: Record<string, PathItem> | undefined): Service[] {
  if (!paths) return [];

  const serviceMap = new Map<string, Operation[]>();

  for (const [path, pathItem] of Object.entries(paths)) {
    const serviceName = inferServiceName(path);
    const pathLevelParams = pathItem.parameters ?? [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const operation = buildOperation(method, path, op, pathLevelParams);
      const ops = serviceMap.get(serviceName) ?? [];
      ops.push(operation);
      serviceMap.set(serviceName, ops);
    }
  }

  return Array.from(serviceMap.entries()).map(([name, operations]) => ({
    name,
    operations,
  }));
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
  const segments = path.split('/').filter(Boolean);
  const hasTrailingParam = segments.length > 0 && segments[segments.length - 1].startsWith('{');
  const isCollectionPath = !hasTrailingParam;

  // Check for nested resource patterns like /widgets/{id}/sub
  const nonParamSegments = segments.filter((s) => !s.startsWith('{'));
  if (nonParamSegments.length > 1) {
    // Nested resource: use operationId if available
    if (operationId) return toCamelCase(operationId);
  }

  switch (method) {
    case 'get':
      return isCollectionPath ? 'list' : 'retrieve';
    case 'post':
      return 'create';
    case 'put':
    case 'patch':
      return 'update';
    case 'delete':
      return 'delete';
    default:
      return operationId ? toCamelCase(operationId) : method;
  }
}

function buildOperation(
  method: HttpMethod,
  path: string,
  op: OperationObject,
  pathLevelParams: ParameterObject[],
): Operation {
  const allParams = [...pathLevelParams, ...(op.parameters ?? [])];

  const pathParams = extractParams(allParams, 'path');
  const queryParams = extractParams(allParams, 'query');
  const headerParams = extractParams(allParams, 'header');

  const requestBody = extractRequestBody(op.requestBody, op);
  const { response, errors } = extractResponses(op.responses, op, path, method);

  const paginated = detectPagination(response, queryParams);

  return {
    name: inferOperationName(method, path, op.operationId),
    description: op.description ?? op.summary,
    httpMethod: method,
    path,
    pathParams,
    queryParams,
    headerParams,
    requestBody,
    response,
    errors,
    paginated,
    idempotent: method === 'post',
  };
}

function extractParams(params: ParameterObject[], location: 'path' | 'query' | 'header'): Parameter[] {
  return params
    .filter((p) => p.in === location)
    .map((p) => ({
      name: p.name,
      type: p.schema
        ? schemaToTypeRef(p.schema as Record<string, unknown>, p.name)
        : ({ kind: 'primitive', type: 'string' } as TypeRef),
      required: p.required ?? false,
      description: p.description,
    }));
}

function extractRequestBody(body?: RequestBodyObject, op?: OperationObject): TypeRef | undefined {
  if (!body?.content) return undefined;

  const jsonContent = body.content['application/json'];
  if (!jsonContent?.schema) return undefined;

  const contextName = op?.operationId
    ? toPascalCase(op.operationId) + 'Request'
    : 'RequestBody';
  return schemaToTypeRef(jsonContent.schema as Record<string, unknown>, contextName);
}

function deriveResponseName(op: OperationObject | undefined, path: string, method: HttpMethod): string {
  if (op?.operationId) {
    return toPascalCase(op.operationId) + 'Response';
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
): { response: TypeRef; errors: ErrorResponse[] } {
  const errors: ErrorResponse[] = [];
  let response: TypeRef = { kind: 'primitive', type: 'string' };

  if (!responses) return { response, errors };

  for (const [statusCode, resp] of Object.entries(responses)) {
    const code = parseInt(statusCode, 10);

    if (code >= 200 && code < 300) {
      const jsonContent = resp.content?.['application/json'];
      if (jsonContent?.schema) {
        const contextName = deriveResponseName(op, path ?? '/', method ?? 'get');
        response = schemaToTypeRef(jsonContent.schema as Record<string, unknown>, contextName);
      }
    } else if (code >= 400) {
      const jsonContent = resp.content?.['application/json'];
      const type = jsonContent?.schema
        ? schemaToTypeRef(jsonContent.schema as Record<string, unknown>, `Error${code}`)
        : undefined;
      errors.push({ statusCode: code, type });
    }
  }

  return { response, errors };
}
