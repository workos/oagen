/**
 * SDK Behavior IR — language-agnostic runtime policies for generated SDKs.
 *
 * These types capture the "what" of SDK behavior (retry, telemetry, errors, etc.)
 * while emitters provide the "how" (language-specific mechanism).
 *
 * Emitters access these via `ctx.spec.sdk` — always populated, never undefined.
 */

// ── Retry ──────────────────────────────────────────────────────────

/** Retry policy — when and how to retry failed requests. */
export interface RetryPolicy {
  /** HTTP status codes that trigger a retry. */
  retryableStatusCodes: number[];
  /** Maximum number of retry attempts (0 = no retries). */
  maxRetries: number;
  /** Whether to retry on connection errors (DNS failure, TCP reset). */
  retryOnConnectionError: boolean;
  /** Whether to retry on timeout errors. */
  retryOnTimeout: boolean;
  /** Backoff strategy between retries. */
  backoff: BackoffStrategy;
}

/** Exponential backoff configuration.
 *
 * Formula: `delay = min(initialDelay * multiplier^attempt, maxDelay)`
 * With jitter: `delay += delay * jitterFactor * random(0, 1)`
 */
export interface BackoffStrategy {
  /** Initial delay in seconds before the first retry. */
  initialDelay: number;
  /** Multiplier applied to the delay on each subsequent retry. */
  multiplier: number;
  /** Maximum delay in seconds (cap). */
  maxDelay: number;
  /** Jitter factor (0..1). 0.5 means up to 50% random jitter added. */
  jitterFactor: number;
}

// ── Errors ─────────────────────────────────────────────────────────

/** Error mapping — status codes to named exception kinds. */
export interface ErrorPolicy {
  /** Map from HTTP status code to a logical error kind name (e.g. 400 → 'BadRequest').
   *  Emitters append language-specific suffixes (e.g. 'BadRequestException'). */
  statusCodeMap: Record<number, string>;
  /** Catch-all error kind for 5xx status codes not in the map. */
  serverErrorKind: string;
  /** Catch-all error kind for unrecognized status codes. */
  clientErrorKind: string;
  /** URL template for error documentation. Use {code} as placeholder for the API error code.
   *  Example: 'https://workos.com/docs/errors/{code}' */
  errorDocUrlTemplate?: string;
}

// ── Telemetry ──────────────────────────────────────────────────────

/** Telemetry — what request metrics to track and send. */
export interface TelemetryPolicy {
  /** Whether telemetry is enabled by default. Users can opt out via constructor param. */
  enabledByDefault: boolean;
  /** Header name for client telemetry data (previous request's ID + latency). */
  headerName: string;
  /** Response header name for the request ID. */
  requestIdHeader: string;
}

// ── Pagination ─────────────────────────────────────────────────────

/** Pagination behavior defaults. */
export interface PaginationPolicy {
  /** Delay in milliseconds between pages during auto-pagination. 0 = no delay. */
  autoPageDelayMs: number;
}

// ── Idempotency ────────────────────────────────────────────────────

/** Idempotency auto-generation rules. */
export interface IdempotencyPolicy {
  /** Header name for the idempotency key. */
  headerName: string;
  /** Whether to auto-generate a UUID v4 idempotency key for POST requests when retries > 0. */
  autoGenerateForPost: boolean;
}

// ── Logging ────────────────────────────────────────────────────────

/** Logging contract — what to log at which level. */
export interface LoggingPolicy {
  /** Whether structured logging hooks are generated. */
  enabled: boolean;
  /** Log events that the generated client emits. */
  events: LogEvent[];
}

/** A discrete loggable event in the request lifecycle. */
export type LogEvent =
  | 'request.start'
  | 'request.success'
  | 'request.retry'
  | 'request.rate_limited'
  | 'request.error'
  | 'request.connection_error';

// ── User-Agent ─────────────────────────────────────────────────────

/** User-Agent construction rules. */
export interface UserAgentPolicy {
  /** Template for the SDK identifier string.
   *  Placeholders: {name} = spec name, {lang} = emitter language, {version} = SDK version.
   *  Each emitter interpolates with its own language string and casing conventions.
   *  Example: '{name} {lang}/{version}' → 'WorkOS PHP/4.32.0' */
  sdkIdentifierTemplate: string;
  /** Whether to append the runtime/language version (e.g. PHP 8.2, Python 3.12). */
  includeRuntimeVersion: boolean;
  /** Whether to allow app info enrichment via setAppInfo(name, version, url). */
  allowAppInfo: boolean;
  /** AI agent environment variable detection entries. */
  aiAgentEnvVars: AiAgentEnvVar[];
}

/** Maps an environment variable to an AI agent slug for User-Agent enrichment. */
export interface AiAgentEnvVar {
  /** Environment variable to check (e.g. 'CLAUDE_CODE'). */
  envVar: string;
  /** Agent name to append to User-Agent (e.g. 'ClaudeCode'). */
  agentName: string;
}

// ── Request Guards ─────────────────────────────────────────────────

/** Guards that validate request params before sending. */
export interface RequestGuardPolicy {
  /** Keys that should be in RequestOptions, not in params.
   *  If detected in the body or query params, the SDK throws an error. */
  optionKeys: string[];
}

// ── Timeouts ───────────────────────────────────────────────────────

/** Timeout configuration. */
export interface TimeoutPolicy {
  /** Default HTTP request timeout in seconds. */
  defaultTimeoutSeconds: number;
  /** Environment variable name to override the timeout (e.g. 'WORKOS_REQUEST_TIMEOUT'). */
  timeoutEnvVar?: string;
}

// ── Root ───────────────────────────────────────────────────────────

/** Language-agnostic runtime policies for generated SDKs.
 *  Attached to `ApiSpec.sdk` and consumed by emitters via `ctx.spec.sdk`. */
export interface SdkBehavior {
  retry: RetryPolicy;
  errors: ErrorPolicy;
  telemetry: TelemetryPolicy;
  pagination: PaginationPolicy;
  idempotency: IdempotencyPolicy;
  logging: LoggingPolicy;
  userAgent: UserAgentPolicy;
  requestGuard: RequestGuardPolicy;
  timeout: TimeoutPolicy;
}

// ── Defaults ───────────────────────────────────────────────────────

/**
 * Canonical SDK behavior defaults. These match the PHP emitter's current
 * implementation (the most complete). Per-language overrides can be applied
 * via `mergeSdkBehavior()` in each SDK's `oagen.config.ts`.
 *
 * - Retry: exponential backoff with jitter, retries on 429/5xx
 * - Errors: standard HTTP status → exception kind mapping
 * - Telemetry: enabled by default, tracks request ID + latency
 * - Pagination: no inter-page delay (Node overrides to 350ms)
 * - Idempotency: auto-generate UUID v4 for retryable POSTs
 * - Logging: all lifecycle events enabled
 * - User-Agent: SDK identifier + runtime version + app info + AI agent detection
 * - Request guards: detect misplaced RequestOptions keys in params
 * - Timeout: 60s default (Python overrides to 30s)
 */
export function defaultSdkBehavior(): SdkBehavior {
  return {
    retry: {
      retryableStatusCodes: [429, 500, 502, 503, 504],
      maxRetries: 3,
      retryOnConnectionError: true,
      retryOnTimeout: true,
      backoff: {
        initialDelay: 1.0,
        multiplier: 2.0,
        maxDelay: 30.0,
        jitterFactor: 0.5,
      },
    },
    errors: {
      statusCodeMap: {
        400: 'BadRequest',
        401: 'Authentication',
        403: 'Authorization',
        404: 'NotFound',
        409: 'Conflict',
        422: 'UnprocessableEntity',
        429: 'RateLimitExceeded',
      },
      serverErrorKind: 'Server',
      clientErrorKind: 'Api',
      errorDocUrlTemplate: 'https://workos.com/docs/errors/{code}',
    },
    telemetry: {
      enabledByDefault: true,
      headerName: 'X-WorkOS-Client-Telemetry',
      requestIdHeader: 'X-Request-ID',
    },
    pagination: {
      autoPageDelayMs: 0,
    },
    idempotency: {
      headerName: 'Idempotency-Key',
      autoGenerateForPost: true,
    },
    logging: {
      enabled: true,
      events: [
        'request.start',
        'request.success',
        'request.retry',
        'request.rate_limited',
        'request.error',
        'request.connection_error',
      ],
    },
    userAgent: {
      sdkIdentifierTemplate: '{name} {lang}/{version}',
      includeRuntimeVersion: true,
      allowAppInfo: true,
      aiAgentEnvVars: [
        { envVar: 'CLAUDE_CODE', agentName: 'ClaudeCode' },
        { envVar: 'CURSOR_AGENT', agentName: 'Cursor' },
        { envVar: 'CLINE_ACTIVE', agentName: 'Cline' },
        { envVar: 'WINDSURF_ACTIVE', agentName: 'Windsurf' },
        { envVar: 'COPILOT_AGENT', agentName: 'Copilot' },
      ],
    },
    requestGuard: {
      optionKeys: [
        'api_key',
        'apiKey',
        'idempotency_key',
        'idempotencyKey',
        'extra_headers',
        'extraHeaders',
        'max_retries',
        'maxRetries',
        'base_url',
        'baseUrl',
      ],
    },
    timeout: {
      defaultTimeoutSeconds: 60,
    },
  };
}

// ── Merge ──────────────────────────────────────────────────────────

/** Recursive partial type for deep overrides. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[] // Arrays replace entirely (don't concat)
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/**
 * Deep-merge partial overrides into the canonical defaults.
 * Arrays replace entirely (so `retryableStatusCodes: [429]` replaces the full list,
 * rather than appending). Object properties are merged recursively.
 */
export function mergeSdkBehavior(overrides: DeepPartial<SdkBehavior>): SdkBehavior {
  return deepMerge(
    defaultSdkBehavior() as unknown as Record<string, unknown>,
    overrides as unknown as Record<string, unknown>,
  ) as unknown as SdkBehavior;
}

/**
 * Self-contained deep merge (no external imports — ir/ is layer 0).
 * Arrays and primitives from `source` replace those in `target`.
 * Objects are merged recursively.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (sourceVal === undefined) continue;
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}
