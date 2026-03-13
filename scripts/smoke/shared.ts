/**
 * Shared infrastructure for smoke tests.
 *
 * Types, operation planning, payload generation, ID registry, and capture format
 * used by both raw HTTP and SDK smoke test scripts.
 */

import 'dotenv/config';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';
import { toSnakeCase, toCamelCase } from '../../src/utils/naming.js';

// ---------------------------------------------------------------------------
// Capture format
// ---------------------------------------------------------------------------

export interface ExchangeProvenance {
  resolutionTier: 'exact' | 'crud-prefix' | 'fuzzy' | 'manifest';
  resolutionConfidence: number;
  sdkMethodName: string;
  captureIndex: number;
  totalCaptures: number;
}

export interface CapturedExchange {
  operationId: string;
  service: string;
  operationName: string;
  request: {
    method: string;
    path: string;
    queryParams: Record<string, string>;
    body: unknown | null;
  };
  response: {
    status: number;
    body: unknown | null;
  };
  outcome: 'success' | 'api-error' | 'skipped';
  error?: string;
  /** True when the response status code is not declared in the OpenAPI spec for this operation */
  unexpectedStatus?: boolean;
  /** Status codes declared in the OpenAPI spec (success + error codes) */
  expectedStatusCodes?: number[];
  durationMs: number;
  /** How the SDK method was resolved and which capture was selected */
  provenance?: ExchangeProvenance;
}

export interface SmokeResults {
  source: 'raw' | 'spec-baseline' | `sdk-${string}`;
  timestamp: string;
  specVersion: string;
  exchanges: CapturedExchange[];
}

// ---------------------------------------------------------------------------
// Operation planning
// ---------------------------------------------------------------------------

export interface PlannedOperation {
  service: string;
  operation: Operation;
}

export interface PlannedGroup {
  service: string;
  operations: PlannedOperation[];
}

/** Operations that require complex preconditions and can't be auto-tested */
export const SKIP_OPERATIONS = new Set([
  'authenticateWithPassword',
  'authenticateWithCode',
  'authenticateWithMagicAuth',
  'authenticateWithEmailVerification',
  'authenticateWithTotp',
  'authenticateWithOrganizationSelection',
  'getAuthorizationUrl',
  'getProfileAndToken',
  'createMagicAuth',
  'enrollAuthFactor',
  'resetPassword',
  'createPasswordReset',
  'getToken',
  'check',
  'batchCheck',
  'query',
  'getJwksUrl',
  'getLogoutUrl',
  'revokeSession',
]);

/** Services to skip entirely */
export const SKIP_SERVICES = new Set(['Pipes', 'Mfa', 'Passwordless', 'Widgets', 'FGA', 'Actions']);

/**
 * Services that produce IDs other services depend on should run first.
 * Lower number = runs earlier. Unlisted services default to 50.
 */
const SERVICE_PRIORITY: Record<string, number> = {
  Organizations: 10,
  Connections: 15,
  Directories: 15,
  DirectoryGroups: 16,
  DirectoryUsers: 16,
  OrganizationDomains: 20,
  UserManagement: 25,
  // Authorization, FeatureFlags, etc. depend on the above
};

/**
 * Assign a numeric sort key to an operation so that ID-producing operations
 * (parameterless creates and lists) run before ID-consuming ones.
 */
function operationSortKey(op: Operation): number {
  const hasParams = op.pathParams.length > 0;
  const method = op.httpMethod;

  if (method === 'post' && !hasParams) return 0; // top-level create
  if (method === 'get' && !hasParams && op.paginated) return 1; // top-level list
  if (method === 'get' && !hasParams) return 2; // top-level singular GET
  if (method === 'post' && hasParams) return 3; // sub-entity create
  if (method === 'get' && hasParams && op.paginated) return 4; // sub-entity list
  if (method === 'get' && hasParams) return 5; // singular GET by ID
  if (method === 'put' || method === 'patch') return 6; // update
  if (method === 'delete') return 7; // delete
  return 99;
}

export function planOperations(spec: ApiSpec): PlannedGroup[] {
  const groups: PlannedGroup[] = [];

  for (const service of spec.services) {
    if (SKIP_SERVICES.has(service.name)) continue;

    const ops: PlannedOperation[] = [];
    for (const op of service.operations) {
      if (SKIP_OPERATIONS.has(op.name)) continue;

      ops.push({ service: service.name, operation: op });
    }

    if (ops.length === 0) continue;

    // Sort to maximize ID availability:
    //   1. Parameterless POSTs (create new top-level entities → produce IDs)
    //   2. Parameterless list GETs (discover existing IDs)
    //   3. Parameterized POSTs (create sub-entities, need parent IDs)
    //   4. Parameterized list GETs
    //   5. Parameterized singular GETs (retrieve by ID)
    //   6. PUT/PATCH (update)
    //   7. DELETE
    ops.sort((a, b) => {
      return operationSortKey(a.operation) - operationSortKey(b.operation);
    });

    groups.push({ service: service.name, operations: ops });
  }

  // Sort service groups so ID-producing services run first
  groups.sort((a, b) => {
    const aPri = SERVICE_PRIORITY[a.service] ?? 50;
    const bPri = SERVICE_PRIORITY[b.service] ?? 50;
    return aPri - bPri;
  });

  return groups;
}

// ---------------------------------------------------------------------------
// Payload generation
// ---------------------------------------------------------------------------

export function generateFixtureValue(typeRef: TypeRef, fieldName: string, spec: ApiSpec): unknown {
  switch (typeRef.kind) {
    case 'primitive':
      return generatePrimitiveFixture(typeRef.type, typeRef.format, fieldName);
    case 'array':
      return [generateFixtureValue(typeRef.items, fieldName, spec)];
    case 'model': {
      const model = spec.models.find((m) => m.name === typeRef.name);
      if (model) {
        const obj: Record<string, unknown> = {};
        for (const field of model.fields) {
          if (field.required) {
            obj[toSnakeCase(field.name)] = generateFixtureValue(field.type, field.name, spec);
          }
        }
        return obj;
      }
      return {};
    }
    case 'enum': {
      const e = spec.enums.find((en) => en.name === typeRef.name);
      return e?.values[0]?.value ?? 'unknown';
    }
    case 'nullable':
      return generateFixtureValue(typeRef.inner, fieldName, spec);
    case 'union':
      if (typeRef.variants.length > 0) {
        return generateFixtureValue(typeRef.variants[0], fieldName, spec);
      }
      return null;
  }
}

function generatePrimitiveFixture(type: string, format: string | undefined, fieldName: string): unknown {
  if (type === 'string') {
    if (format === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
    if (format === 'date') return '2024-01-01';
    if (format === 'date-time') return '2024-01-01T00:00:00Z';
    if (format === 'email') return 'test@example.com';
    if (format === 'uri' || format === 'url') return 'https://example.com';
    return `test_${toSnakeCase(fieldName)}`;
  }
  if (type === 'integer') return 1;
  if (type === 'number') return 1.0;
  if (type === 'boolean') return true;
  return null;
}

/** Generate a snake_case request body payload from an operation's requestBody type */
export function generatePayload(op: Operation, spec: ApiSpec): Record<string, unknown> | null {
  if (!op.requestBody) return null;

  const bodyType = op.requestBody;
  if (bodyType.kind === 'model') {
    const model = spec.models.find((m) => m.name === bodyType.name);
    if (!model) return {};

    const payload: Record<string, unknown> = {};
    for (const field of model.fields) {
      if (!field.required) continue;
      const key = toSnakeCase(field.name);
      let value = generateFixtureValue(field.type, field.name, spec);

      // Inject uniqueness markers for name/slug fields
      if ((key === 'name' || key === 'slug') && typeof value === 'string') {
        value = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      payload[key] = value;
    }
    return payload;
  }

  // Fallback for non-model body types
  return {};
}

/** Generate a fixture value with SDK-friendly types (e.g. Date objects for date-time) */
function generateSDKFixtureValue(typeRef: TypeRef, fieldName: string, spec: ApiSpec): unknown {
  const value = generateFixtureValue(typeRef, fieldName, spec);
  // SDK methods expect Date objects for date-time fields, not ISO strings
  if (typeRef.kind === 'primitive' && typeRef.format === 'date-time' && typeof value === 'string') {
    return new Date(value);
  }
  return value;
}

/** Generate a camelCase payload for SDK method calls */
export function generateCamelPayload(op: Operation, spec: ApiSpec): Record<string, unknown> | null {
  if (!op.requestBody) return null;

  const bodyType = op.requestBody;
  if (bodyType.kind === 'model') {
    const model = spec.models.find((m) => m.name === bodyType.name);
    if (!model) return {};

    const payload: Record<string, unknown> = {};
    for (const field of model.fields) {
      if (!field.required) continue;
      const key = toCamelCase(field.name);
      let value = generateSDKFixtureValue(field.type, field.name, spec);

      if ((field.name === 'name' || field.name === 'slug') && typeof value === 'string') {
        value = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      payload[key] = value;
    }
    return payload;
  }

  return {};
}

/** Generate query params for an operation (required params only, plus limit=1 for lists) */
export function generateQueryParams(op: Operation, spec: ApiSpec): Record<string, string> {
  const params: Record<string, string> = {};

  if (op.paginated) {
    params['limit'] = '1';
  }

  for (const p of op.queryParams) {
    if (!p.required) continue;
    const value = generateFixtureValue(p.type, p.name, spec);
    params[toSnakeCase(p.name)] = String(value);
  }

  // Sort by key
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(params).sort()) {
    sorted[key] = params[key];
  }
  return sorted;
}

/** Generate camelCase query params for SDK method calls */
export function generateCamelQueryParams(op: Operation, spec: ApiSpec): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  if (op.paginated) {
    params['limit'] = 1;
  }

  for (const p of op.queryParams) {
    if (!p.required) continue;
    const value = generateFixtureValue(p.type, p.name, spec);
    params[toCamelCase(p.name)] = value;
  }

  return params;
}

// ---------------------------------------------------------------------------
// ID Registry
// ---------------------------------------------------------------------------

export class IdRegistry {
  private ids = new Map<string, string>();

  set(service: string, field: string, value: string): void {
    this.ids.set(`${service}.${field}`, value);
  }

  get(service: string, field: string): string | undefined {
    return this.ids.get(`${service}.${field}`);
  }

  /**
   * Map from path param names to the service whose `id` they reference.
   * e.g. "organizationId" → "Organizations", so we look up Organizations.id
   */
  private static PARAM_SERVICE_MAP: Record<string, string> = {
    organizationId: 'Organizations',
    organization_id: 'Organizations',
    connectionId: 'Connections',
    connection_id: 'Connections',
    directoryId: 'Directories',
    directory_id: 'Directories',
    organization_membership_id: 'OrganizationMemberships',
    auditLogExportId: 'AuditLogs',
    audit_log_export_id: 'AuditLogs',
  };

  /** Resolve path parameters for an operation using stored IDs */
  resolvePathParams(op: Operation, service: string): Record<string, string> | null {
    const resolved: Record<string, string> = {};
    for (const p of op.pathParams) {
      const value =
        this.get(service, p.name) ||
        this.get(service, 'id') ||
        this.findAcrossServices(p.name) ||
        this.resolveFromParamName(p.name);

      if (!value) return null;
      resolved[p.name] = value;
    }
    return resolved;
  }

  /** Try to find a param value across all services */
  private findAcrossServices(field: string): string | undefined {
    for (const [key, value] of Array.from(this.ids.entries())) {
      if (key.endsWith(`.${field}`)) return value;
    }
    return undefined;
  }

  /**
   * Resolve a path param like "organizationId" by mapping it to the
   * service that stores that entity's ID (e.g. Organizations.id).
   * Also handles snake_case suffixed with _id by stripping the suffix
   * and looking up the pluralized service name.
   */
  private resolveFromParamName(paramName: string): string | undefined {
    // Check explicit mapping first
    const mappedService = IdRegistry.PARAM_SERVICE_MAP[paramName];
    if (mappedService) {
      return this.get(mappedService, 'id') || this.get(mappedService, 'slug');
    }

    // Infer from param name: "resource_id" → "Resources", "role_assignment_id" → "RoleAssignments"
    // Handle snake_case: strip trailing _id, PascalCase+pluralize the rest
    if (paramName.endsWith('_id')) {
      const base = paramName.slice(0, -3); // e.g. "resource_type" from "resource_type_id"
      const pascal = base
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
      const plural = pascal.endsWith('s') ? pascal : pascal + 's';
      const val = this.get(plural, 'id') || this.get(plural, 'slug');
      if (val) return val;
    }

    // Handle camelCase: "resourceId" → strip "Id", pluralize → "Resources"
    if (paramName.endsWith('Id') && paramName.length > 2) {
      const base = paramName.slice(0, -2); // e.g. "organization"
      const pascal = base.charAt(0).toUpperCase() + base.slice(1);
      const plural = pascal.endsWith('s') ? pascal : pascal + 's';
      const val = this.get(plural, 'id') || this.get(plural, 'slug');
      if (val) return val;
    }

    return undefined;
  }

  /**
   * Extract IDs from a response body and store them.
   * @param isTopLevel - true for operations without path params (their `id` belongs to this service).
   *                     false for sub-resource operations (their `id` is a child entity, don't overwrite).
   */
  extractAndStore(service: string, responseBody: unknown, isTopLevel = true): void {
    if (!responseBody || typeof responseBody !== 'object') return;

    const body = responseBody as Record<string, unknown>;

    // Only store direct ID from top-level operations to avoid overwriting
    // e.g. Organizations.id with an API key ID from /organizations/{id}/api_keys
    if (isTopLevel) {
      if (typeof body.id === 'string') {
        this.set(service, 'id', body.id);
      }

      // List response: extract from first item
      if (Array.isArray(body.data) && body.data.length > 0) {
        const first = body.data[0] as Record<string, unknown> | undefined;
        if (first && typeof first === 'object') {
          if (typeof first.id === 'string') {
            this.set(service, 'id', first.id);
          }
          this.extractNestedIds(service, first);
        }
      }

      if (typeof body.slug === 'string') this.set(service, 'slug', body.slug);
      if (typeof body.key === 'string') this.set(service, 'key', body.key);
    }

    // Always extract nested reference IDs (e.g. organization_id, connection_id)
    this.extractNestedIds(service, body);
    if (Array.isArray(body.data) && body.data.length > 0) {
      const first = body.data[0] as Record<string, unknown> | undefined;
      if (first && typeof first === 'object') {
        this.extractNestedIds(service, first);
      }
    }
  }

  /** Extract fields ending in _id or Id and store them for cross-service resolution */
  private extractNestedIds(service: string, obj: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'string') continue;
      if (key === 'id') continue; // already handled
      // Store fields like "organization_id", "connection_id" directly
      if (key.endsWith('_id') || (key.endsWith('Id') && key.length > 2)) {
        this.set(service, key, value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Status code checking
// ---------------------------------------------------------------------------

/** Get the set of status codes declared in the spec for an operation (success + errors) */
export function getExpectedStatusCodes(op: Operation): number[] {
  const codes: number[] = [];
  // The success response code is implied by HTTP method if not explicit in errors
  // Common defaults: POST→201, GET→200, PUT→200, PATCH→200, DELETE→204
  const defaultSuccess: Record<string, number> = {
    post: 201,
    get: 200,
    put: 200,
    patch: 200,
    delete: 204,
  };
  codes.push(defaultSuccess[op.httpMethod] ?? 200);
  // Add declared error codes from the spec
  for (const err of op.errors) {
    if (!codes.includes(err.statusCode)) {
      codes.push(err.statusCode);
    }
  }
  return codes.sort((a, b) => a - b);
}

/** Check if a status code is unexpected (not declared in the spec) */
export function isUnexpectedStatus(status: number, op: Operation): boolean {
  if (status === 0) return false; // skipped or network error, not a status mismatch
  const expected = getExpectedStatusCodes(op);
  return !expected.includes(status);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function resolvePath(op: Operation, pathParams: Record<string, string>): string {
  let path = op.path;
  for (const [name, value] of Object.entries(pathParams)) {
    path = path.replace(`{${name}}`, value);
  }
  return path;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseCliArgs(): { spec: string; sdkPath?: string } {
  const args = process.argv.slice(2);
  const specIdx = args.indexOf('--spec');
  const spec = specIdx !== -1 && args[specIdx + 1] ? args[specIdx + 1] : process.env.OPENAPI_SPEC;
  if (!spec) {
    console.error('OpenAPI spec path is required. Set OPENAPI_SPEC env var or pass --spec <path>.');
    process.exit(1);
  }
  const sdkPathIdx = args.indexOf('--sdk-path');
  const sdkPath = sdkPathIdx !== -1 && args[sdkPathIdx + 1] ? args[sdkPathIdx + 1] : undefined;
  return { spec, sdkPath };
}
