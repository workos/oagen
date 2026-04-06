import type { ApiSpec, Service, Operation, HttpMethod } from './types.js';

/** Minimal snake_case converter for path segments (avoids cross-layer import). */
function toSnake(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Hint types — consumer-provided overrides for operation resolution
// ---------------------------------------------------------------------------

/** Per-operation override keyed by "METHOD /path" (e.g. "POST /sso/token"). */
export interface OperationHint {
  /** Override the algorithm-derived method name. */
  name?: string;
  /** Remount this operation to a different service/namespace (PascalCase). */
  mountOn?: string;
  /** Split a union-body operation into N typed wrapper methods. */
  split?: SplitHint[];
  /** Inject constant body defaults (e.g. { grant_type: 'password' }). */
  defaults?: Record<string, string | number | boolean>;
  /** Fields the SDK reads from client config at runtime (e.g. ['client_id']). */
  inferFromClient?: string[];
}

export interface SplitHint {
  /** Wrapper method name (snake_case). */
  name: string;
  /** The discriminated union variant model name (e.g. 'PasswordSessionAuthenticateRequest'). */
  targetVariant: string;
  /** Constant body fields injected by the wrapper. */
  defaults?: Record<string, string | number | boolean>;
  /** Fields the SDK reads from client config at runtime. */
  inferFromClient?: string[];
  /** Only these body fields are exposed as method params. If omitted, all non-default/non-inferred fields are exposed. */
  exposedParams?: string[];
}

// ---------------------------------------------------------------------------
// Resolved output — consumed by emitters
// ---------------------------------------------------------------------------

export interface ResolvedOperation {
  /** The original IR operation (preserves description, params, types, etc.). */
  operation: Operation;
  /** The original IR service that owns this operation. */
  service: Service;
  /** Resolved snake_case method name (emitters convert to their convention). */
  methodName: string;
  /** Resolved target service/namespace (PascalCase). */
  mountOn: string;
  /** For split operations: one wrapper per union variant. */
  wrappers?: ResolvedWrapper[];
}

export interface ResolvedWrapper {
  /** Wrapper method name (snake_case). */
  name: string;
  /** The discriminated union variant model name. */
  targetVariant: string;
  /** Constant body defaults injected by the wrapper. */
  defaults: Record<string, string | number | boolean>;
  /** Fields read from client config at runtime. */
  inferFromClient: string[];
  /** Body fields exposed as method params. */
  exposedParams: string[];
  /** Optional body fields (not required in the variant). */
  optionalParams: string[];
  /** Response model name (if any). */
  responseModelName: string | null;
}

// ---------------------------------------------------------------------------
// Algorithm
// ---------------------------------------------------------------------------

/**
 * Action verbs recognised at the terminal path segment.
 * When a path ends with one of these, we use it as the verb instead of
 * deriving a CRUD verb from the HTTP method.
 */
const ACTION_VERBS = new Set([
  'accept',
  'activate',
  'authorize',
  'challenge',
  'check',
  'complete',
  'confirm',
  'deactivate',
  'disable',
  'enable',
  'enroll',
  'generate',
  'reactivate',
  'resend',
  'revoke',
  'send',
  'verify',
]);

/** Map HTTP method → default CRUD verb. */
const CRUD_VERB: Record<HttpMethod, string> = {
  get: 'list',
  post: 'create',
  put: 'update',
  patch: 'update',
  delete: 'delete',
  head: 'get',
  options: 'list',
  trace: 'list',
};

/**
 * Naive singularization: strips trailing "s" with common-sense exceptions.
 * Good enough for API resource nouns; not a general-purpose English stemmer.
 */
function singularize(word: string): string {
  if (word.length <= 2) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (
    word.endsWith('ses') ||
    word.endsWith('zes') ||
    word.endsWith('xes') ||
    word.endsWith('ches') ||
    word.endsWith('shes')
  ) {
    return word.slice(0, -2);
  }
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * Derive a snake_case method name from an operation's HTTP method and path.
 *
 * Rules:
 * 1. Strip path-param segments (`{id}`, `{slug}`, etc.)
 * 2. If the terminal segment is an action verb, use it as the verb
 * 3. Otherwise, use the CRUD verb for the HTTP method
 * 4. For GET on a collection (no trailing {id}), use "list"; with {id}, use "get"
 * 5. For POST on a resource path, if only one path param, use "create" singular
 * 6. Singularize the resource noun for single-resource operations
 */
export function deriveMethodName(op: Operation, _service: Service): string {
  const segments = op.path.split('/').filter(Boolean);

  // Separate static segments from param segments
  const staticSegments: string[] = [];
  let trailingParam = false;
  for (const seg of segments) {
    if (seg.startsWith('{') && seg.endsWith('}')) {
      trailingParam = true;
    } else {
      staticSegments.push(seg);
      trailingParam = false;
    }
  }

  if (staticSegments.length === 0) {
    return `${CRUD_VERB[op.httpMethod] ?? 'get'}_root`;
  }

  const terminal = toSnake(staticSegments[staticSegments.length - 1]);

  // Check if terminal is an action verb
  if (ACTION_VERBS.has(terminal)) {
    // Resource context from preceding segments
    const context = staticSegments.slice(0, -1).filter((s) => !s.startsWith('{'));
    const resource = context.length > 0 ? toSnake(singularize(context[context.length - 1])) : '';
    if (resource) {
      return `${terminal}_${resource}`;
    }
    return terminal;
  }

  // Determine verb from HTTP method
  let verb = CRUD_VERB[op.httpMethod] ?? 'get';

  // GET with trailing {id} → "get" instead of "list"
  if (op.httpMethod === 'get' && trailingParam) {
    verb = 'get';
  }

  // Build resource name from static segments.
  // When path params separate static segments, include the penultimate static
  // segment (singularized) as a parent-context prefix to disambiguate nested paths.
  // e.g. /authorization/organizations/{id}/roles → "organization_roles"
  let resource = toSnake(terminal);
  if (staticSegments.length >= 2) {
    const penultimate = staticSegments[staticSegments.length - 2];
    // Check if a path param appears between the penultimate and terminal segments
    // in the original path by finding both positions and looking for {…} between them.
    const penIdx = segments.lastIndexOf(penultimate);
    const termIdx = segments.lastIndexOf(staticSegments[staticSegments.length - 1]);
    const hasParamBetween = segments.slice(penIdx + 1, termIdx).some((s) => s.startsWith('{'));
    if (hasParamBetween) {
      const prefix = toSnake(singularize(penultimate));
      resource = `${prefix}_${resource}`;
    }
  }

  // Singularize only when there is a trailing path param (single-resource operation).
  // POST/PUT/DELETE to collection endpoints keep plural nouns.
  const isSingleResource = trailingParam;
  const noun = isSingleResource ? singularize(resource) : resource;

  // For "list" verb, keep plural
  const finalNoun = verb === 'list' ? resource : noun;

  return `${verb}_${finalNoun}`;
}

/**
 * Resolve all operations in the spec, applying hints and mount rules.
 *
 * @param spec - The parsed API spec
 * @param hints - Per-operation overrides keyed by "METHOD /path"
 * @param mountRules - Service name → target service mappings
 * @returns Resolved operations ready for emitter consumption
 */
export function resolveOperations(
  spec: ApiSpec,
  hints?: Record<string, OperationHint>,
  mountRules?: Record<string, string>,
): ResolvedOperation[] {
  const resolved: ResolvedOperation[] = [];
  const hintMap = hints ?? {};
  const mounts = mountRules ?? {};

  for (const service of spec.services) {
    for (const op of service.operations) {
      const key = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const hint = hintMap[key];

      // Resolve method name: hint > algorithm
      const methodName = hint?.name ?? deriveMethodName(op, service);

      // Resolve mount target: per-op hint > service mount rule > original service
      const mountOn = hint?.mountOn ?? mounts[service.name] ?? service.name;

      // Build wrappers for split operations
      let wrappers: ResolvedWrapper[] | undefined;
      if (hint?.split) {
        wrappers = hint.split.map((sh) => ({
          name: sh.name,
          targetVariant: sh.targetVariant,
          defaults: sh.defaults ?? {},
          inferFromClient: sh.inferFromClient ?? [],
          exposedParams: sh.exposedParams ?? [],
          optionalParams: [],
          responseModelName: resolveResponseModelName(op),
        }));
      }

      resolved.push({
        operation: op,
        service,
        methodName,
        mountOn,
        wrappers,
      });
    }
  }

  return resolved;
}

/** Extract the response model name from an operation (for wrapper metadata). */
function resolveResponseModelName(op: Operation): string | null {
  if (op.httpMethod === 'delete') return null;
  const ref = op.response;
  if (ref.kind === 'model') return ref.name;
  if (ref.kind === 'nullable' && ref.inner.kind === 'model') return ref.inner.name;
  return null;
}
