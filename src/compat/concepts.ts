/**
 * Conceptual change grouping for cross-language compatibility analysis.
 *
 * Groups related changes across languages into a single conceptual change
 * with per-language severity. This allows reports to say "parameter rename
 * on Authorization.check is breaking in PHP, Python, Kotlin, and .NET but
 * soft-risk in Go" rather than treating these as unrelated per-language findings.
 */

import type { LanguageId } from './ir.js';
import type { CompatChangeSeverity, CompatChangeCategory } from './config.js';
import type { CompatDiffResult } from './differ.js';

/** A conceptual change with per-language severity. */
export interface ConceptualChange {
  /** Deterministic ID from symbol + category + match details. */
  id: string;
  /** IR-level symbol path (language-neutral). */
  symbol: string;
  /** The kind of change. */
  category: CompatChangeCategory;
  /** Per-language severity mapping. */
  impact: Partial<Record<LanguageId, CompatChangeSeverity>>;
  /** Human-readable description (from first language that reported it). */
  message: string;
  /** Old state details. */
  old: Record<string, string>;
  /** New state details. */
  new: Record<string, string>;
}

/** Cross-language conceptual rollup. */
export interface ConceptualRollup {
  conceptualChanges: ConceptualChange[];
}

/**
 * Group classified changes from multiple languages into conceptual changes.
 *
 * Changes are grouped by their `conceptualChangeId` — a deterministic ID
 * derived from the symbol, category, and match details. Changes with the
 * same ID across different languages represent the same conceptual change.
 */
export function buildConceptualRollup(perLanguageResults: CompatDiffResult[]): ConceptualRollup {
  const grouped = new Map<string, ConceptualChange>();

  for (const result of perLanguageResults) {
    const language = result.language as LanguageId;

    for (const change of result.changes) {
      const existing = grouped.get(change.conceptualChangeId);
      if (existing) {
        existing.impact[language] = change.severity;
      } else {
        grouped.set(change.conceptualChangeId, {
          id: change.conceptualChangeId,
          symbol: change.symbol,
          category: change.category,
          impact: { [language]: change.severity },
          message: change.message,
          old: change.old,
          new: change.new,
        });
      }
    }
  }

  return {
    conceptualChanges: [...grouped.values()],
  };
}

/** Get the highest severity across all languages for a conceptual change. */
export function highestSeverity(change: ConceptualChange): CompatChangeSeverity {
  const severities = Object.values(change.impact);
  if (severities.includes('breaking')) return 'breaking';
  if (severities.includes('soft-risk')) return 'soft-risk';
  return 'additive';
}

/** Count conceptual changes by highest severity. */
export function summarizeConceptualChanges(rollup: ConceptualRollup): {
  breaking: number;
  softRisk: number;
  additive: number;
} {
  let breaking = 0;
  let softRisk = 0;
  let additive = 0;
  for (const change of rollup.conceptualChanges) {
    const sev = highestSeverity(change);
    if (sev === 'breaking') breaking++;
    else if (sev === 'soft-risk') softRisk++;
    else additive++;
  }
  return { breaking, softRisk, additive };
}
