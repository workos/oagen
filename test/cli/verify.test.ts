import { describe, it, expect } from 'vitest';
import type { VerifyDiagnostics } from '../../src/cli/verify.js';

describe('VerifyDiagnostics', () => {
  it('has the expected shape for compat-only diagnostics', () => {
    const diag: VerifyDiagnostics = {
      compatCheck: {
        totalBaselineSymbols: 50,
        preservedSymbols: 45,
        preservationScore: 90,
        violationsByCategory: { 'public-api': 3, signature: 2 },
        violationsBySeverity: { breaking: 4, warning: 1 },
        additions: 5,
        scopedToSpec: true,
        scopedSymbolCount: 40,
      },
    };

    expect(diag.compatCheck!.preservationScore).toBe(90);
    expect(diag.compatCheck!.violationsByCategory['public-api']).toBe(3);
    expect(diag.compatCheck!.scopedToSpec).toBe(true);
    expect(diag.smokeCheck).toBeUndefined();
  });

  it('has the expected shape for smoke-only diagnostics', () => {
    const diag: VerifyDiagnostics = {
      smokeCheck: {
        passed: false,
        findingsCount: 7,
      },
    };

    expect(diag.smokeCheck!.passed).toBe(false);
    expect(diag.smokeCheck!.findingsCount).toBe(7);
    expect(diag.compatCheck).toBeUndefined();
  });

  it('has the expected shape for full diagnostics', () => {
    const diag: VerifyDiagnostics = {
      compatCheck: {
        totalBaselineSymbols: 100,
        preservedSymbols: 100,
        preservationScore: 100,
        violationsByCategory: {},
        violationsBySeverity: {},
        additions: 3,
        scopedToSpec: false,
      },
      smokeCheck: {
        passed: true,
      },
    };

    expect(diag.compatCheck!.preservationScore).toBe(100);
    expect(diag.smokeCheck!.passed).toBe(true);

    // Verify JSON serialization round-trips correctly
    const json = JSON.stringify(diag, null, 2);
    const parsed = JSON.parse(json) as VerifyDiagnostics;
    expect(parsed.compatCheck!.totalBaselineSymbols).toBe(100);
    expect(parsed.smokeCheck!.passed).toBe(true);
  });

  it('handles compile error smoke result', () => {
    const diag: VerifyDiagnostics = {
      smokeCheck: {
        passed: false,
        compileErrors: true,
      },
    };

    expect(diag.smokeCheck!.compileErrors).toBe(true);
    expect(diag.smokeCheck!.findingsCount).toBeUndefined();
  });

  it('has the expected shape for retryLoop diagnostics when converged', () => {
    const diag: VerifyDiagnostics = {
      compatCheck: {
        totalBaselineSymbols: 10,
        preservedSymbols: 10,
        preservationScore: 100,
        violationsByCategory: {},
        violationsBySeverity: {},
        additions: 0,
        scopedToSpec: true,
      },
      retryLoop: {
        attempts: 2,
        converged: true,
        finalScore: 100,
        patchedPerIteration: [3, 1],
      },
    };

    expect(diag.retryLoop!.converged).toBe(true);
    expect(diag.retryLoop!.attempts).toBe(2);
    expect(diag.retryLoop!.finalScore).toBe(100);
    expect(diag.retryLoop!.patchedPerIteration).toEqual([3, 1]);
  });

  it('has the expected shape for retryLoop diagnostics when not converged', () => {
    const diag: VerifyDiagnostics = {
      retryLoop: {
        attempts: 3,
        converged: false,
        finalScore: 60,
        patchedPerIteration: [5, 4, 3],
      },
    };

    expect(diag.retryLoop!.converged).toBe(false);
    expect(diag.retryLoop!.attempts).toBe(3);
    expect(diag.retryLoop!.patchedPerIteration).toHaveLength(3);

    // Verify JSON round-trip
    const json = JSON.stringify(diag, null, 2);
    const parsed = JSON.parse(json) as VerifyDiagnostics;
    expect(parsed.retryLoop!.patchedPerIteration).toEqual([5, 4, 3]);
  });

  it('retryLoop is optional and undefined by default', () => {
    const diag: VerifyDiagnostics = {
      smokeCheck: { passed: true },
    };

    expect(diag.retryLoop).toBeUndefined();
  });
});
