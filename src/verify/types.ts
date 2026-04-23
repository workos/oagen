import type { Violation } from '../compat/types.js';
import type { CompatDiffResult } from '../compat/differ.js';

export interface VerifyDiagnostics {
  compatCheck?: {
    totalBaselineSymbols: number;
    preservedSymbols: number;
    preservationScore: number;
    violationsByCategory: Record<string, number>;
    violationsBySeverity: Record<string, number>;
    additions: number;
    scopedToSpec: boolean;
    scopedSymbolCount?: number;
  };
  stalenessCheck?: {
    staleSymbolCount: number;
    staleSymbols: string[];
  };
  smokeCheck?: {
    passed: boolean;
    findingsCount?: number;
    compileErrors?: boolean;
  };
  retryLoop?: {
    attempts: number;
    converged: boolean;
    finalScore: number;
    patchedPerIteration: number[];
  };
}

export interface CompatCheckResult {
  passed: boolean;
  diff: CompatDiffResult;
  scopedToSpec: boolean;
  scopedSymbolCount?: number;
}

export interface OverlayRetryResult {
  status: 'passed' | 'max-retries' | 'no-patchable' | 'stalled';
  attempts: number;
  patchedPerIteration: number[];
  compatResult: CompatCheckResult;
}

export interface SmokeCheckResult {
  passed: boolean;
  findingsCount?: number;
  compileErrors?: boolean;
  baselinePath: string;
  generatedBaseline: boolean;
}

export interface StalenessCheckResult {
  violations: Violation[];
}
