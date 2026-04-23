import { writeFileSync } from 'node:fs';
import type { VerifyDiagnostics, CompatCheckResult } from './types.js';

export function summarizeCompatCheck(result: CompatCheckResult): NonNullable<VerifyDiagnostics['compatCheck']> {
  const violationsByCategory: Record<string, number> = {};
  const violationsBySeverity: Record<string, number> = {};
  for (const c of result.diff.changes) {
    violationsByCategory[c.category] = (violationsByCategory[c.category] ?? 0) + 1;
    violationsBySeverity[c.severity] = (violationsBySeverity[c.severity] ?? 0) + 1;
  }

  const { breaking, softRisk, additive } = result.diff.summary;
  const totalChanges = breaking + softRisk + additive;
  const totalBaselineSymbols = totalChanges + additive; // approximate; additive are new
  const preservedSymbols = totalBaselineSymbols - breaking - softRisk;
  const preservationScore =
    totalBaselineSymbols > 0 ? Math.round((preservedSymbols / totalBaselineSymbols) * 100) : 100;

  return {
    totalBaselineSymbols,
    preservedSymbols,
    preservationScore,
    violationsByCategory,
    violationsBySeverity,
    additions: additive,
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
