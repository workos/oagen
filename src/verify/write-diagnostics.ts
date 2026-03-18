import { writeFileSync } from 'node:fs';
import type { VerifyDiagnostics, CompatCheckResult } from './types.js';

export function summarizeCompatCheck(result: CompatCheckResult): NonNullable<VerifyDiagnostics['compatCheck']> {
  const violationsByCategory: Record<string, number> = {};
  const violationsBySeverity: Record<string, number> = {};
  for (const v of result.diff.violations) {
    violationsByCategory[v.category] = (violationsByCategory[v.category] ?? 0) + 1;
    violationsBySeverity[v.severity] = (violationsBySeverity[v.severity] ?? 0) + 1;
  }

  return {
    totalBaselineSymbols: result.diff.totalBaselineSymbols,
    preservedSymbols: result.diff.preservedSymbols,
    preservationScore: result.diff.preservationScore,
    violationsByCategory,
    violationsBySeverity,
    additions: result.diff.additions.length,
    scopedToSpec: result.scopedToSpec,
    ...(result.scopedSymbolCount !== undefined ? { scopedSymbolCount: result.scopedSymbolCount } : {}),
  };
}

export function setRetryDiagnostics(
  diagData: VerifyDiagnostics,
  attempt: number,
  converged: boolean,
  finalScore: number,
  patchedPerIteration: number[],
): void {
  diagData.retryLoop = { attempts: attempt, converged, finalScore, patchedPerIteration };
}

export function writeDiagnostics(data: VerifyDiagnostics, filePath: string = 'verify-diagnostics.json'): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}
