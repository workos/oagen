import { describe, expect, it } from 'vitest';
import { defaultSdkBehavior, mergeSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { SdkBehavior } from '../../src/ir/sdk-behavior.js';

describe('defaultSdkBehavior', () => {
  it('returns a fully populated object', () => {
    const sdk = defaultSdkBehavior();

    // Every top-level key is present
    expect(sdk.retry).toBeDefined();
    expect(sdk.errors).toBeDefined();
    expect(sdk.telemetry).toBeDefined();
    expect(sdk.pagination).toBeDefined();
    expect(sdk.idempotency).toBeDefined();
    expect(sdk.logging).toBeDefined();
    expect(sdk.userAgent).toBeDefined();
    expect(sdk.requestGuard).toBeDefined();
    expect(sdk.timeout).toBeDefined();
  });

  it('has expected retry defaults', () => {
    const sdk = defaultSdkBehavior();
    expect(sdk.retry.retryableStatusCodes).toEqual([429, 500, 502, 503, 504]);
    expect(sdk.retry.maxRetries).toBe(3);
    expect(sdk.retry.retryOnConnectionError).toBe(true);
    expect(sdk.retry.retryOnTimeout).toBe(true);
    expect(sdk.retry.backoff.initialDelay).toBe(1.0);
    expect(sdk.retry.backoff.multiplier).toBe(2.0);
    expect(sdk.retry.backoff.maxDelay).toBe(30.0);
    expect(sdk.retry.backoff.jitterFactor).toBe(0.5);
  });

  it('has expected error defaults', () => {
    const sdk = defaultSdkBehavior();
    expect(sdk.errors.statusCodeMap[400]).toBe('BadRequest');
    expect(sdk.errors.statusCodeMap[401]).toBe('Authentication');
    expect(sdk.errors.statusCodeMap[429]).toBe('RateLimitExceeded');
    expect(sdk.errors.serverErrorKind).toBe('Server');
    expect(sdk.errors.clientErrorKind).toBe('Api');
    expect(sdk.errors.errorDocUrlTemplate).toBe('https://workos.com/docs/errors/{code}');
  });

  it('has expected telemetry defaults', () => {
    const sdk = defaultSdkBehavior();
    expect(sdk.telemetry.enabledByDefault).toBe(true);
    expect(sdk.telemetry.headerName).toBe('X-WorkOS-Client-Telemetry');
    expect(sdk.telemetry.requestIdHeader).toBe('X-Request-ID');
  });

  it('has expected user-agent defaults', () => {
    const sdk = defaultSdkBehavior();
    expect(sdk.userAgent.sdkIdentifierTemplate).toBe('{name} {lang}/{version}');
    expect(sdk.userAgent.aiAgentEnvVars).toHaveLength(5);
    expect(sdk.userAgent.aiAgentEnvVars[0]).toEqual({ envVar: 'CLAUDE_CODE', agentName: 'ClaudeCode' });
  });

  it('returns a new object each call (no shared state)', () => {
    const a = defaultSdkBehavior();
    const b = defaultSdkBehavior();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.retry.maxRetries = 99;
    expect(b.retry.maxRetries).toBe(3);
  });
});

describe('mergeSdkBehavior', () => {
  it('returns defaults when given empty overrides', () => {
    const merged = mergeSdkBehavior({});
    expect(merged).toEqual(defaultSdkBehavior());
  });

  it('overrides a top-level scalar', () => {
    const merged = mergeSdkBehavior({ retry: { maxRetries: 5 } });
    expect(merged.retry.maxRetries).toBe(5);
    // Other retry fields preserved
    expect(merged.retry.retryableStatusCodes).toEqual([429, 500, 502, 503, 504]);
    expect(merged.retry.backoff.initialDelay).toBe(1.0);
  });

  it('overrides a deeply nested scalar', () => {
    const merged = mergeSdkBehavior({ retry: { backoff: { maxDelay: 10 } } });
    expect(merged.retry.backoff.maxDelay).toBe(10);
    // Other backoff fields preserved
    expect(merged.retry.backoff.initialDelay).toBe(1.0);
    expect(merged.retry.backoff.multiplier).toBe(2.0);
    expect(merged.retry.backoff.jitterFactor).toBe(0.5);
  });

  it('replaces arrays entirely (does not concat)', () => {
    const merged = mergeSdkBehavior({ retry: { retryableStatusCodes: [429] } });
    expect(merged.retry.retryableStatusCodes).toEqual([429]);
  });

  it('replaces AI agent env vars array', () => {
    const merged = mergeSdkBehavior({
      userAgent: { aiAgentEnvVars: [{ envVar: 'MY_AGENT', agentName: 'MyAgent' }] },
    });
    expect(merged.userAgent.aiAgentEnvVars).toEqual([{ envVar: 'MY_AGENT', agentName: 'MyAgent' }]);
  });

  it('overrides error doc URL template', () => {
    const merged = mergeSdkBehavior({
      errors: { errorDocUrlTemplate: 'https://example.com/errors/{code}' },
    });
    expect(merged.errors.errorDocUrlTemplate).toBe('https://example.com/errors/{code}');
    // Other error fields preserved
    expect(merged.errors.statusCodeMap[400]).toBe('BadRequest');
  });

  it('overrides timeout with env var', () => {
    const merged = mergeSdkBehavior({
      timeout: { defaultTimeoutSeconds: 30, timeoutEnvVar: 'WORKOS_REQUEST_TIMEOUT' },
    });
    expect(merged.timeout.defaultTimeoutSeconds).toBe(30);
    expect(merged.timeout.timeoutEnvVar).toBe('WORKOS_REQUEST_TIMEOUT');
  });

  it('can override multiple top-level policies at once', () => {
    const merged = mergeSdkBehavior({
      retry: { maxRetries: 5 },
      pagination: { autoPageDelayMs: 350 },
      timeout: { defaultTimeoutSeconds: 30 },
    });
    expect(merged.retry.maxRetries).toBe(5);
    expect(merged.pagination.autoPageDelayMs).toBe(350);
    expect(merged.timeout.defaultTimeoutSeconds).toBe(30);
    // Untouched policies preserved
    expect(merged.telemetry.enabledByDefault).toBe(true);
  });

  it('produces a valid SdkBehavior type', () => {
    const merged: SdkBehavior = mergeSdkBehavior({ retry: { maxRetries: 1 } });
    // TypeScript compilation is the real test; runtime check for completeness
    expect(merged.retry).toBeDefined();
    expect(merged.errors).toBeDefined();
    expect(merged.telemetry).toBeDefined();
    expect(merged.pagination).toBeDefined();
    expect(merged.idempotency).toBeDefined();
    expect(merged.logging).toBeDefined();
    expect(merged.userAgent).toBeDefined();
    expect(merged.requestGuard).toBeDefined();
    expect(merged.timeout).toBeDefined();
  });
});
