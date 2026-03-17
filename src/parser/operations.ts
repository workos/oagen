import type { Service, Operation, HttpMethod, Parameter, TypeRef, ErrorResponse, Model, Field } from '../ir/types.js';
import { toPascalCase, toCamelCase, cleanSchemaName } from '../utils/naming.js';
import { schemaToTypeRef } from './schemas.js';
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

  // Fallback when no operationId is available
  const segments = path.split('/').filter(Boolean);
  const hasTrailingParam = segments.length > 0 && segments[segments.length - 1].startsWith('{');
  const isCollectionPath = !hasTrailingParam;

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
      return method;
  }
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
  const requestBody = extractRequestBody(op.requestBody, op, reqBodyModels);
  const { response, errors, inlineModels, isPaginated } = extractResponses(op.responses, op, path, method);
  inlineModels.push(...reqBodyModels);

  const paginated = isPaginated || detectPagination(response, queryParams);

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
      response,
      errors,
      paginated,
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
      type: p.schema
        ? schemaToTypeRef(p.schema as Record<string, unknown>, p.name)
        : ({ kind: 'primitive', type: 'string' } as TypeRef),
      required: p.required ?? false,
      description: p.description,
    }));
}

function extractRequestBody(
  body: RequestBodyObject | undefined,
  op: OperationObject | undefined,
  inlineModels: Model[],
): TypeRef | undefined {
  if (!body?.content) return undefined;

  const jsonContent = body.content['application/json'];
  if (!jsonContent?.schema) return undefined;

  const schema = jsonContent.schema as Record<string, unknown>;
  const rawName = op?.operationId ? toPascalCase(op.operationId) + 'Request' : 'RequestBody';
  const contextName = cleanSchemaName(rawName);

  // If the request body is an inline object with properties, extract it as a model
  if (schema.properties && (schema.type === 'object' || !schema.type)) {
    const requiredSet = new Set((schema.required as string[] | undefined) ?? []);
    const fields: Field[] = [];
    for (const [fieldName, fieldSchema] of Object.entries(
      schema.properties as Record<string, Record<string, unknown>>,
    )) {
      fields.push({
        name: fieldName,
        type: schemaToTypeRef(fieldSchema, fieldName, contextName),
        required: requiredSet.has(fieldName),
        description: (fieldSchema.description as string) ?? undefined,
      });
    }
    inlineModels.push({ name: contextName, description: undefined, fields });
    return { kind: 'model', name: contextName };
  }

  return schemaToTypeRef(schema, contextName);
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
): { response: TypeRef; errors: ErrorResponse[]; inlineModels: Model[]; isPaginated: boolean } {
  const errors: ErrorResponse[] = [];
  let response: TypeRef = { kind: 'primitive', type: 'string' };
  let inlineModels: Model[] = [];
  let isPaginated = false;

  if (!responses) return { response, errors, inlineModels, isPaginated };

  for (const [statusCode, resp] of Object.entries(responses)) {
    const code = parseInt(statusCode, 10);

    if (code >= 200 && code < 300) {
      const jsonContent = resp.content?.['application/json'];
      if (jsonContent?.schema) {
        const contextName = deriveResponseName(op, path ?? '/', method ?? 'get');
        const result = classifyAndExtractResponse(jsonContent.schema as Record<string, unknown>, contextName);
        response = result.response;
        inlineModels = result.inlineModels;
        isPaginated = result.isPaginated;
      }
    } else if (code >= 400) {
      const jsonContent = resp.content?.['application/json'];
      const type = jsonContent?.schema
        ? schemaToTypeRef(jsonContent.schema as Record<string, unknown>, `Error${code}`)
        : undefined;
      errors.push({ statusCode: code, type });
    }
  }

  return { response, errors, inlineModels, isPaginated };
}
