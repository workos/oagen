import { readFileSync, writeFileSync } from 'node:fs';
import { validateSnapshot } from '../compat/schema.js';
import { diffSnapshots } from '../compat/differ.js';
import { generateReport, formatHumanSummary } from '../compat/report.js';
import { severityMeetsThreshold } from '../compat/config.js';
import type { CompatFailLevel } from '../compat/config.js';
import type { CompatSnapshot } from '../compat/ir.js';

export async function compatDiffCommand(opts: {
  baseline: string;
  candidate: string;
  output?: string;
  failOn?: string;
  explain?: boolean;
}): Promise<void> {
  const baselineData = JSON.parse(readFileSync(opts.baseline, 'utf-8'));
  const candidateData = JSON.parse(readFileSync(opts.candidate, 'utf-8'));

  if (!validateSnapshot(baselineData)) {
    throw new Error(`Invalid baseline snapshot: ${opts.baseline}`);
  }
  if (!validateSnapshot(candidateData)) {
    throw new Error(`Invalid candidate snapshot: ${opts.candidate}`);
  }

  const baseline = baselineData as CompatSnapshot;
  const candidate = candidateData as CompatSnapshot;

  const diff = diffSnapshots(baseline, candidate);

  // Human-readable output to terminal
  console.log(formatHumanSummary(diff, { explain: opts.explain }));

  // Machine-readable output to file
  if (opts.output) {
    const report = generateReport(diff);
    writeFileSync(opts.output, JSON.stringify(report, null, 2));
    console.log(`Report written to ${opts.output}`);
  }

  // Fail if threshold exceeded
  const failOn = (opts.failOn ?? 'breaking') as CompatFailLevel;
  const hasFailure = diff.changes.some((c) => severityMeetsThreshold(c.severity, failOn));
  if (hasFailure) {
    process.exitCode = 1;
  }
}
