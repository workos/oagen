import { readFileSync, writeFileSync } from 'node:fs';
import type { CompatReport, CompatReportChange } from '../compat/report.js';
import type { CompatDiffResult } from '../compat/differ.js';
import type { LanguageId } from '../compat/ir.js';
import type { CompatChangeSeverity } from '../compat/config.js';
import { buildConceptualRollup, highestSeverity, summarizeConceptualChanges } from '../compat/concepts.js';

/**
 * Format compat report(s) as a markdown PR comment.
 *
 * Single report:
 *   oagen compat-summary --report node-report.json | gh pr comment --body-file -
 *
 * Multiple reports (cross-language rollup):
 *   oagen compat-summary --report php.json --report python.json --report go.json
 */
export async function compatSummaryCommand(opts: { report: string | string[]; output?: string }): Promise<void> {
  const paths = Array.isArray(opts.report) ? opts.report : [opts.report];
  const reports = paths.map((p) => JSON.parse(readFileSync(p, 'utf-8')) as CompatReport);

  const md = reports.length === 1 ? formatSingleReport(reports[0]) : formatCrossLanguageRollup(reports);

  if (opts.output) {
    writeFileSync(opts.output, md);
    console.log(`Summary written to ${opts.output}`);
  } else {
    process.stdout.write(md);
  }
}

// ---------------------------------------------------------------------------
// Single-language report
// ---------------------------------------------------------------------------

function formatSingleReport(report: CompatReport): string {
  const lines: string[] = [];
  const { breaking, softRisk, additive } = report.summary;
  const total = breaking + softRisk + additive;

  if (breaking > 0) {
    lines.push(`## :x: Compat check failed — ${report.language}`);
  } else if (softRisk > 0) {
    lines.push(`## :warning: Compat check has warnings — ${report.language}`);
  } else {
    lines.push(`## :white_check_mark: Compat check passed — ${report.language}`);
  }

  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Breaking | ${breaking} |`);
  lines.push(`| Soft-risk | ${softRisk} |`);
  lines.push(`| Additive | ${additive} |`);
  lines.push(`| **Total** | **${total}** |`);

  if (total === 0) {
    lines.push('');
    lines.push('No compatibility changes detected.');
    return lines.join('\n') + '\n';
  }

  const breakingChanges = report.changes.filter((c) => c.severity === 'breaking');
  if (breakingChanges.length > 0) {
    lines.push('');
    lines.push('### Breaking changes');
    lines.push('');
    lines.push(formatChangesTable(breakingChanges));
  }

  const softRiskChanges = report.changes.filter((c) => c.severity === 'soft-risk');
  if (softRiskChanges.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>Soft-risk changes (${softRiskChanges.length})</summary>`);
    lines.push('');
    lines.push(formatChangesTable(softRiskChanges));
    lines.push('</details>');
  }

  const additiveChanges = report.changes.filter((c) => c.severity === 'additive');
  if (additiveChanges.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>Additive changes (${additiveChanges.length})</summary>`);
    lines.push('');
    lines.push(formatChangesTable(additiveChanges));
    lines.push('</details>');
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Cross-language rollup
// ---------------------------------------------------------------------------

function formatCrossLanguageRollup(reports: CompatReport[]): string {
  const languages = reports.map((r) => r.language);

  // Convert reports to the shape buildConceptualRollup expects
  const perLanguage = reports.map((r) => ({
    diff: { changes: r.changes, summary: r.summary } as CompatDiffResult,
    language: r.language as LanguageId,
  }));
  const rollup = buildConceptualRollup(perLanguage);
  const summary = summarizeConceptualChanges(rollup);

  const lines: string[] = [];

  // Header
  if (summary.breaking > 0) {
    lines.push(`## :x: Compat check failed — ${summary.breaking} breaking across ${languages.length} languages`);
  } else if (summary.softRisk > 0) {
    lines.push(
      `## :warning: Compat check has warnings — ${summary.softRisk} soft-risk across ${languages.length} languages`,
    );
  } else {
    lines.push(`## :white_check_mark: Compat check passed — ${languages.length} languages`);
  }

  lines.push('');

  // Per-language summary table
  lines.push('| Language | Breaking | Soft-risk | Additive |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of reports) {
    lines.push(`| ${r.language} | ${r.summary.breaking} | ${r.summary.softRisk} | ${r.summary.additive} |`);
  }

  if (rollup.conceptualChanges.length === 0) {
    lines.push('');
    lines.push('No compatibility changes detected.');
    return lines.join('\n') + '\n';
  }

  // Conceptual changes table with per-language severity
  const breakingConcepts = rollup.conceptualChanges.filter((c) => highestSeverity(c) === 'breaking');
  if (breakingConcepts.length > 0) {
    lines.push('');
    lines.push('### Breaking changes');
    lines.push('');
    lines.push(formatConceptualTable(breakingConcepts, languages));
  }

  const softRiskConcepts = rollup.conceptualChanges.filter((c) => highestSeverity(c) === 'soft-risk');
  if (softRiskConcepts.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>Soft-risk changes (${softRiskConcepts.length})</summary>`);
    lines.push('');
    lines.push(formatConceptualTable(softRiskConcepts, languages));
    lines.push('</details>');
  }

  const additiveConcepts = rollup.conceptualChanges.filter((c) => highestSeverity(c) === 'additive');
  if (additiveConcepts.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>Additive changes (${additiveConcepts.length})</summary>`);
    lines.push('');
    lines.push(formatConceptualTable(additiveConcepts, languages));
    lines.push('</details>');
  }

  return lines.join('\n') + '\n';
}

function formatConceptualTable(
  concepts: Array<{ symbol: string; category: string; impact: Partial<Record<string, CompatChangeSeverity>> }>,
  languages: string[],
): string {
  const lines: string[] = [];
  const langHeaders = languages.map((l) => l).join(' | ');
  lines.push(`| Symbol | Category | ${langHeaders} |`);
  lines.push(`| --- | --- | ${languages.map(() => '---').join(' | ')} |`);
  for (const c of concepts) {
    const severities = languages.map((l) => severityIcon(c.impact[l])).join(' | ');
    lines.push(`| \`${c.symbol}\` | \`${c.category}\` | ${severities} |`);
  }
  return lines.join('\n');
}

function severityIcon(severity: CompatChangeSeverity | undefined): string {
  if (!severity) return '—';
  switch (severity) {
    case 'breaking':
      return ':x: breaking';
    case 'soft-risk':
      return ':warning: soft-risk';
    case 'additive':
      return ':white_check_mark: additive';
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function formatChangesTable(changes: CompatReportChange[]): string {
  const lines: string[] = [];
  lines.push('| Category | Symbol | Detail |');
  lines.push('| --- | --- | --- |');
  for (const c of changes) {
    const detail = c.message ?? formatOldNew(c.old, c.new);
    lines.push(`| \`${c.category}\` | \`${c.symbol}\` | ${escapeMarkdown(detail)} |`);
  }
  return lines.join('\n');
}

function formatOldNew(old: Record<string, string>, updated: Record<string, string>): string {
  const parts: string[] = [];
  for (const key of Object.keys(old)) {
    if (updated[key] && old[key] !== updated[key]) {
      parts.push(`${key}: \`${old[key]}\` → \`${updated[key]}\``);
    }
  }
  return parts.length > 0 ? parts.join(', ') : '';
}

function escapeMarkdown(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
