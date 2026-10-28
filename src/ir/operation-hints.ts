import type { ApiSpec, Service, Operation, HttpMethod, PaginationEndOfIteration, PaginationStrategy } from './types.js';

/** Minimal snake_case converter for path segments (avoids cross-layer import). */
function toSnake(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toLowerCase();
}

/** One segment of a path template as readPath reads it. */
export interface PathSegment {
  /** A `{param}`, a literal, or the verb of a custom method. */
  text: string;
  /** `true` for a verb written after a colon: `adopt` in `/pets/{petId}:adopt`. */
  customMethod: boolean;
}

/**
 * The segments of a path template, with a custom method split off the
 * segment it is written on. An API in the Google AIP-136 style appends an
 * action to a resource or collection after a colon, so `/pets/{petId}:adopt`
 * and `/pets:batchGet` each end in one URL segment that names both a thing
 * and a verb. Every name read from a path goes through this function (or
 * pathSegments, its text alone) and sees such a segment as the two it stands
 * for — `{petId}` then `adopt`, `pets` then `batchGet` — so a custom method
 * is named like the same action written with a slash (`/pets/{petId}/adopt`,
 * `/pets/batchGet`), and the verb never lands inside a parameter word. The
 * verb is marked `customMethod` for the two readings that treat it apart
 * from a slash-written literal: it never names a service, and it counts
 * against a path's plainness when inline model names collide (see the
 * parser's serviceSegmentIndex and pathDeviation). A colon inside a
 * parameter's braces is part of its name and does not split it. Empty
 * segments — a leading, trailing or doubled slash, or an empty side of a
 * colon — are dropped. The operation's `path` itself is never rewritten: it
 * is the URL the SDK requests.
 */
export function readPath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  for (const segment of path.split('/')) {
    // A parameter's braces are kept whole; only what follows them can carry
    // the colon of a custom method.
    const braces = segment.startsWith('{') ? segment.indexOf('}') + 1 : 0;
    const parts = segment.slice(braces).split(':');
    parts[0] = segment.slice(0, braces) + parts[0];
    parts.forEach((part, i) => {
      if (part) segments.push({ text: part, customMethod: i > 0 });
    });
  }
  return segments;
}

/** The text of each segment readPath reads: `/pets/{petId}:adopt` → `pets`, `{petId}`, `adopt`. */
export function pathSegments(path: string): string[] {
  return readPath(path).map((segment) => segment.text);
}

// ---------------------------------------------------------------------------
// Hint types — consumer-provided overrides for operation resolution
// ---------------------------------------------------------------------------

/** Per-operation override keyed by "METHOD /path" (e.g. "POST /auth/token"). */
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
  /**
   * Marks this operation as a URL builder rather than a real HTTP call. Emitters
   * should generate a method that returns the constructed URL (typically as a
   * string) without performing any I/O. Used for OAuth-style redirect endpoints
   * such as /auth/authorize and /accounts/sessions/logout.
   */
  urlBuilder?: boolean;
  /**
   * Explicit pagination for this operation, applied by the parser (through
   * `ParseOptions.operationHints`) rather than by `resolveOperations`. Same
   * shape as the spec's `x-pagination` Operation Object extension; a field set
   * here wins over the extension, which wins over name-based detection.
   */
  pagination?: PaginationHint;
}

/**
 * Explicit pagination for one operation — the object a spec can carry as
 * `x-pagination` on an Operation Object and that `OperationHint.pagination`
 * accepts from config. Every field is optional and layers over the
 * lower-precedence sources (config hint > `x-pagination` > detection), so
 * `{ strategy: 'page' }` alone keeps the detected `param` and `limitParam`.
 *
 * `strategy: 'none'` turns pagination off for the operation; a list envelope
 * is then kept as a plain response model rather than unwrapped. Any other
 * strategy needs a `param`, from some source, that names one of the
 * operation's query parameters. An override that fails validation — unknown
 * strategy, missing or undeclared parameter, one parameter as both `param`
 * and `limitParam`, a `pageStart` under a strategy other than `page`, a
 * `dataPath` that does not reach an array, an `endOfIteration` whose path
 * does not resolve in the primary response to a field of its kind's type,
 * malformed field — is reported with an `[oagen] Warning:` and ignored,
 * leaving the detected metadata as is.
 */
export interface PaginationHint {
  strategy?: PaginationStrategy | 'none';
  /** Query parameter that selects the page (cursor, offset, or page number). */
  param?: string;
  /** Query parameter that sets the page size; not the one `param` names. */
  limitParam?: string;
  /**
   * First page number the API expects (`page` strategy only; set under
   * another strategy, it makes the override unusable). Defaults to the page
   * parameter's integer `default`, else its `minimum`, else 1.
   */
  pageStart?: number;
  /**
   * Dotted path to the data array inside the response. Resolved against the
   * response, so the array's element type — not the wrapper — becomes
   * `itemType`.
   */
  dataPath?: string;
  /**
   * Response field that ends the iteration. Its `path` must resolve in the
   * primary response to a field whose type fits its `kind` — a boolean for
   * `hasMore`, an integer or number for `totalPages` and `totalCount` — or
   * the override is unusable.
   */
  endOfIteration?: PaginationEndOfIteration;
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
  /**
   * Subset of exposedParams that should be emitted as optional even when the
   * variant model would otherwise mark them required (or when the variant has
   * no addressable model, as happens for inline oneOf branches).
   */
  optionalParams?: string[];
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
  /** Constant defaults injected into query/body at runtime (from operation-level hint). */
  defaults: Record<string, string | number | boolean>;
  /** Fields the SDK reads from client config at runtime (from operation-level hint). */
  inferFromClient: string[];
  /** Marks this operation as a URL builder; emitters should not generate an HTTP call. */
  urlBuilder: boolean;
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
 * 1. Strip path-param segments (`{id}`, `{slug}`, etc.); a custom method
 *    written after a colon (`{id}:verify`, `factors:enroll`) is read as its
 *    segment followed by the verb (see pathSegments), so it is named like
 *    `{id}/verify` and `factors/enroll`
 * 2. If the terminal segment is an action verb, use it as the verb
 * 3. Otherwise, use the CRUD verb for the HTTP method
 * 4. For GET on a collection (no trailing {id}), use "list"; with {id}, use "get"
 * 5. For POST on a resource path, if only one path param, use "create" singular
 * 6. Singularize the resource noun for single-resource operations
 */
export function deriveMethodName(op: Operation, _service: Service): string {
  const segments = pathSegments(op.path);

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
  // e.g. /projects/{id}/roles → "project_roles"
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

  // Singularize when:
  //   * there's a trailing path param (single-resource read/update/delete), or
  //   * the verb itself implies a single-resource operation (e.g. POST → create
  //     always creates one item even when posted to a collection endpoint).
  const isSingleResource = trailingParam || verb === 'create';
  const noun = isSingleResource ? singularize(resource) : resource;

  // For "list" verb, keep plural
  const finalNoun = verb === 'list' ? resource : noun;

  return `${verb}_${finalNoun}`;
}

/**
 * Resolve a service name to its mount target.
 *
 * Rule keys are either exact service names or trailing-`*` prefix patterns
 * (e.g. `UserManagement*`). Precedence:
 *
 *   1. An exact key always wins.
 *   2. Otherwise the wildcard with the longest prefix wins, so
 *      `UserManagementOrganizationMembership*` beats `UserManagement*`.
 *
 * Matching is plain string comparison (`startsWith`) — `*` is only recognised
 * as the final character and no regex is ever built from rule keys.
 *
 * @param name - The IR service name to resolve.
 * @param mounts - Exact-name or trailing-`*` pattern → target service mappings.
 * @returns The mount target, or `name` unchanged when no rule matches.
 */
export function resolveMountTarget(name: string, mounts: Record<string, string>): string {
  const exact = mounts[name];
  if (exact !== undefined) return exact;

  let best: string | undefined;
  let bestLen = -1;
  for (const [pattern, target] of Object.entries(mounts)) {
    if (!pattern.endsWith('*')) continue;
    const prefix = pattern.slice(0, -1);
    if (name.startsWith(prefix) && prefix.length > bestLen) {
      best = target;
      bestLen = prefix.length;
    }
  }
  return best ?? name;
}

/**
 * Where a method name comes from when no `name` hint sets it: `path` derives
 * it from the HTTP method and path (`deriveMethodName`); `operationId` takes
 * the operation's own name when the document declares an `operationId`
 * (`Operation.name`, as the parser spelled it, in snake_case) and derives it
 * from the path only for a path-named operation.
 */
export type OperationNaming = 'path' | 'operationId';

/**
 * Resolve all operations in the spec, applying hints and mount rules.
 *
 * @param spec - The parsed API spec
 * @param hints - Per-operation overrides keyed by "METHOD /path"
 * @param mountRules - Service name → target service mappings; keys may be
 *   exact names or trailing-`*` prefix patterns (see {@link resolveMountTarget})
 * @param operationNaming - Where an unhinted method name comes from; `path`
 *   unless the consumer asks for `operationId` (see {@link OperationNaming})
 * @returns Resolved operations ready for emitter consumption
 */
export function resolveOperations(
  spec: ApiSpec,
  hints?: Record<string, OperationHint>,
  mountRules?: Record<string, string>,
  operationNaming: OperationNaming = 'path',
): ResolvedOperation[] {
  const resolved: ResolvedOperation[] = [];
  const hintMap = hints ?? {};
  const mounts = mountRules ?? {};

  for (const service of spec.services) {
    for (const op of service.operations) {
      const key = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const hint = hintMap[key];

      // Resolve method name: hint > algorithm, or — when the consumer asked
      // for `operationId` naming — hint > operationId > algorithm. An operation
      // the document named then keeps that name (as the parser spelled it, so
      // an operationIdTransform is honoured), snake_cased; only a path-named
      // operation gets a name derived from its method and path.
      const fromOperationId = operationNaming === 'operationId' && op.operationId !== undefined;
      const methodName = hint?.name ?? (fromOperationId ? toSnake(op.name) : deriveMethodName(op, service));

      // Resolve mount target: per-op hint > service mount rule > original service
      const mountOn = hint?.mountOn ?? resolveMountTarget(service.name, mounts);

      // Build wrappers for split operations
      let wrappers: ResolvedWrapper[] | undefined;
      if (hint?.split) {
        wrappers = hint.split.map((sh) => ({
          name: sh.name,
          targetVariant: sh.targetVariant,
          defaults: sh.defaults ?? {},
          inferFromClient: sh.inferFromClient ?? [],
          exposedParams: sh.exposedParams ?? [],
          optionalParams: sh.optionalParams ?? [],
          responseModelName: resolveResponseModelName(op),
        }));
      }

      resolved.push({
        operation: op,
        service,
        methodName,
        mountOn,
        wrappers,
        defaults: hint?.defaults ?? {},
        inferFromClient: hint?.inferFromClient ?? [],
        urlBuilder: hint?.urlBuilder ?? false,
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

/** One pair of distinct paths that resolved to the same `mountOn.methodName`. */
export interface ResolvedMethodCollision {
  /** The shared `Service.method_name` key both paths resolved to. */
  key: string;
  first: { httpMethod: string; path: string };
  second: { httpMethod: string; path: string };
}

/**
 * Find every pair of distinct paths that resolve to the same SDK method name.
 *
 * Emitters already refuse to generate on a collision, but they only run inside
 * the per-language build matrix — so a spec addition that collides fails every
 * matrix job minutes in, with no cheap way to catch it first. Surfacing the same
 * check from `oagen resolve` turns that into a seconds-long precheck.
 *
 * Returns every collision rather than throwing on the first, so a spec that
 * introduces several is fixed in one pass instead of one CI round-trip each.
 *
 * Callers that generate a subset of services must filter to the operations they
 * will actually emit before calling this: a collision between two out-of-scope
 * paths is not that run's problem.
 */
export function findResolvedMethodCollisions(resolved: ResolvedOperation[]): ResolvedMethodCollision[] {
  const seen = new Map<string, { httpMethod: string; path: string }>();
  const collisions: ResolvedMethodCollision[] = [];

  for (const r of resolved) {
    const key = `${r.mountOn}.${r.methodName}`;
    const current = { httpMethod: r.operation.httpMethod.toUpperCase(), path: r.operation.path };
    const existing = seen.get(key);

    // The same path AND method twice is one operation seen through two
    // services, not a collision. Both have to match: two *different* methods
    // on one path (`GET /x` and `POST /x` hinted to the same name) are
    // distinct operations competing for a single SDK method, and a path-only
    // comparison accepts them silently.
    if (existing && (existing.path !== current.path || existing.httpMethod !== current.httpMethod)) {
      collisions.push({ key, first: existing, second: current });
      continue;
    }
    if (!existing) seen.set(key, current);
  }

  return collisions;
}
