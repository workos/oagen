/**
 * Report generation for compatibility verification.
 *
 * Produces machine-readable JSON reports, human-readable terminal summaries,
 * and conceptual cross-language summaries.
 */

import type { LanguageId } from './ir.js';
import type { CompatChangeSeverity, CompatChangeCategory, CompatProvenance } from './config.js';
import type { CompatDiffResult } from './differ.js';
import { buildConceptualRollup, highestSeverity, summarizeConceptualChanges } from './concepts.js';

// ---------------------------------------------------------------------------
// Machine-readable report
// ---------------------------------------------------------------------------

/** Machine-readable compat report for a single language. */
export interface CompatReport {
  schemaVersion: string;
  language: string;
  summary: {
    breaking: number;
    softRisk: number;
    additive: number;
  };
  changes: CompatReportChange[];
}

/** A single change entry in the machine-readable report. */
export interface CompatReportChange {
  severity: CompatChangeSeverity;
  category: CompatChangeCategory;
  symbol: string;
  conceptualChangeId: string;
  provenance: CompatProvenance;
  old: Record<string, string>;
  new: Record<string, string>;
  message?: string;
}

/** Generate a machine-readable compat report from a diff result. */
export function generateReport(diff: CompatDiffResult, language?: string): CompatReport {
  return {
    schemaVersion: '1',
    language: language ?? 'unknown',
    summary: diff.summary,
    changes: diff.changes.map((c) => ({
      severity: c.severity,
      category: c.category,
      symbol: c.symbol,
      conceptualChangeId: c.conceptualChangeId,
      provenance: c.provenance,
      old: c.old,
      new: c.new,
      ...(c.message ? { message: c.message } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Human-readable terminal summary
// ---------------------------------------------------------------------------

/** Generate a human-readable summary string for terminal output. */
export function formatHumanSummary(diff: CompatDiffResult, opts?: { explain?: boolean; language?: string }): string {
  const lines: string[] = [];

  lines.push(`Compat report${opts?.language ? ` for ${opts.language}` : ''}:`);
  lines.push(
    `  ${diff.summary.breaking} breaking, ${diff.summary.softRisk} soft-risk, ${diff.summary.additive} additive`,
  );

  if (diff.changes.length === 0) {
    lines.push('  No compatibility changes detected.');
    return lines.join('\n');
  }

  // Group by severity for display
  const breaking = diff.changes.filter((c) => c.severity === 'breaking');
  const softRisk = diff.changes.filter((c) => c.severity === 'soft-risk');
  const additive = diff.changes.filter((c) => c.severity === 'additive');

  if (breaking.length > 0) {
    lines.push('');
    lines.push('  Breaking:');
    for (const c of breaking) {
      lines.push(`    [${c.category}] ${c.symbol} — ${c.message}`);
      if (opts?.explain && c.provenance !== 'unknown') {
        lines.push(`      provenance: ${c.provenance}`);
      }
    }
  }

  if (softRisk.length > 0) {
    lines.push('');
    lines.push('  Soft-risk:');
    for (const c of softRisk) {
      lines.push(`    [${c.category}] ${c.symbol} — ${c.message}`);
      if (opts?.explain && c.provenance !== 'unknown') {
        lines.push(`      provenance: ${c.provenance}`);
      }
    }
  }

  if (additive.length > 0) {
    lines.push('');
    lines.push(`  Additive: ${additive.length} new symbol(s)`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Conceptual cross-language summary
// ---------------------------------------------------------------------------

/** Conceptual cross-language report. */
export interface ConceptualReport {
  conceptualChanges: {
    id: string;
    symbol: string;
    category: CompatChangeCategory;
    impact: Partial<Record<LanguageId, CompatChangeSeverity>>;
  }[];
}

/** Generate a conceptual cross-language report from multiple per-language results. */
export function generateConceptualReport(
  perLanguageResults: Array<{ diff: CompatDiffResult; language: LanguageId }>,
): ConceptualReport {
  const rollup = buildConceptualRollup(perLanguageResults);
  return {
    conceptualChanges: rollup.conceptualChanges.map((c) => ({
      id: c.id,
      symbol: c.symbol,
      category: c.category,
      impact: c.impact,
    })),
  };
}

/** Format a conceptual cross-language summary for terminal output. */
export function formatConceptualSummary(
  perLanguageResults: Array<{ diff: CompatDiffResult; language: LanguageId }>,
): string {
  const rollup = buildConceptualRollup(perLanguageResults);
  const summary = summarizeConceptualChanges(rollup);
  const lines: string[] = [];

  lines.push('Cross-language conceptual summary:');
  lines.push(`  ${summary.breaking} breaking, ${summary.softRisk} soft-risk, ${summary.additive} additive`);

  if (rollup.conceptualChanges.length === 0) {
    lines.push('  No cross-language changes.');
    return lines.join('\n');
  }

  for (const change of rollup.conceptualChanges) {
    const sev = highestSeverity(change);
    const impactStr = Object.entries(change.impact)
      .map(([lang, s]) => `${lang}: ${s}`)
      .join(', ');
    lines.push(`  [${sev}] ${change.category}: ${change.symbol}`);
    lines.push(`    impact: ${impactStr}`);
  }

  return lines.join('\n');
}
