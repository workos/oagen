import { readFileSync, writeFileSync } from 'node:fs';
import type { CompatReport, CompatReportChange } from '../compat/report.js';

/**
 * Format a compat report as a markdown PR comment.
 *
 * Output is designed to be piped to `gh pr comment`:
 *   oagen compat-summary --report report.json | gh pr comment --body-file -
 */
export async function compatSummaryCommand(opts: { report: string; output?: string }): Promise<void> {
  const data = JSON.parse(readFileSync(opts.report, 'utf-8')) as CompatReport;
  const md = formatMarkdownSummary(data);

  if (opts.output) {
    writeFileSync(opts.output, md);
    console.log(`Summary written to ${opts.output}`);
  } else {
    process.stdout.write(md);
  }
}

function formatMarkdownSummary(report: CompatReport): string {
  const lines: string[] = [];
  const { breaking, softRisk, additive } = report.summary;
  const total = breaking + softRisk + additive;

  // Header with status
  if (breaking > 0) {
    lines.push(`## :x: Compat check failed — ${report.language}`);
  } else if (softRisk > 0) {
    lines.push(`## :warning: Compat check has warnings — ${report.language}`);
  } else {
    lines.push(`## :white_check_mark: Compat check passed — ${report.language}`);
  }

  lines.push('');

  // Summary counts
  lines.push(`| Severity | Count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Breaking | ${breaking} |`);
  lines.push(`| Soft-risk | ${softRisk} |`);
  lines.push(`| Additive | ${additive} |`);
  lines.push(`| **Total** | **${total}** |`);

  if (total === 0) {
    lines.push('');
    lines.push('No compatibility changes detected.');
    return lines.join('\n') + '\n';
  }

  // Breaking changes (always shown)
  const breakingChanges = report.changes.filter((c) => c.severity === 'breaking');
  if (breakingChanges.length > 0) {
    lines.push('');
    lines.push('### Breaking changes');
    lines.push('');
    lines.push(formatChangesTable(breakingChanges));
  }

  // Soft-risk changes
  const softRiskChanges = report.changes.filter((c) => c.severity === 'soft-risk');
  if (softRiskChanges.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>Soft-risk changes (${softRiskChanges.length})</summary>`);
    lines.push('');
    lines.push(formatChangesTable(softRiskChanges));
    lines.push('</details>');
  }

  // Additive changes (collapsed)
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
