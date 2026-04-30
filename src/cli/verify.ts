import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CommandError } from '../errors.js';
import { parseSpec, type OpenApiDocument } from '../parser/parse.js';
import type { ApiSurface } from '../compat/types.js';
import type { CompatConfig, CompatFailLevel } from '../compat/config.js';
import { severityMeetsThreshold } from '../compat/config.js';
import { generateReport, formatHumanSummary } from '../compat/report.js';
import { unapprovedChanges } from '../compat/approvals.js';
import type { LanguageId } from '../compat/ir.js';
import { runCompatCheck } from '../verify/run-compat-check.js';
import { runOverlayRetryLoop } from '../verify/run-overlay-retry-loop.js';
import { runStalenessCheck } from '../verify/run-staleness-check.js';
import { runSmokeCheck } from '../verify/run-smoke-check.js';
import { summarizeCompatCheck, setRetryDiagnostics, writeDiagnostics } from '../verify/write-diagnostics.js';
import type { VerifyDiagnostics } from '../verify/types.js';

export type { VerifyDiagnostics } from '../verify/types.js';

const separator = '='.repeat(60);

function printCompatResult(result: ReturnType<typeof summarizeCompatCheck>, baseline: ApiSurface): void {
  if (result.scopedToSpec) {
    const totalBefore =
      Object.keys(baseline.interfaces).length +
      Object.keys(baseline.classes).length +
      Object.keys(baseline.typeAliases).length +
      Object.keys(baseline.enums).length;
    console.log(`(scoped to spec: ${result.scopedSymbolCount}/${totalBefore} baseline symbols in scope)`);
  }

  console.log(
    `compat: ${result.preservationScore}% (${result.preservedSymbols}/${result.totalBaselineSymbols} symbols preserved)`,
  );
}

export async function verifyCommand(opts: {
  spec?: string;
  oldSpec?: string;
  lang: string;
  output: string;
  apiSurface?: string;
  rawResults?: string;
  smokeConfig?: string;
  smokeRunner?: string;
  scope?: 'full' | 'spec-only';
  diagnostics?: boolean;
  maxRetries?: number;
  operationIdTransform?: (id: string) => string;
  schemaNameTransform?: (name: string) => string;
  transformSpec?: (spec: OpenApiDocument) => OpenApiDocument;
  namespace?: string;
  compatConfig?: CompatConfig;
  compatReport?: string;
  compatFailOn?: string;
  compatBaseline?: string;
  compatExplain?: boolean;
}): Promise<void> {
  const {
    spec,
    oldSpec,
    lang,
    output,
    apiSurface,
    rawResults,
    smokeConfig,
    smokeRunner,
    scope,
    diagnostics,
    operationIdTransform,
    schemaNameTransform,
    transformSpec,
    compatConfig,
    compatReport,
    compatExplain,
  } = opts;
  const maxRetries = opts.maxRetries ?? 3;
  const diagData: VerifyDiagnostics = {};

  // Resolve compat options: CLI flags take precedence over config
  const effectiveFailOn: CompatFailLevel =
    (opts.compatFailOn as CompatFailLevel | undefined) ?? compatConfig?.failOn ?? 'breaking';
  const effectiveReportPath = compatReport ?? compatConfig?.reportPath;
  const effectiveExplain = compatExplain ?? compatConfig?.explain ?? false;

  let stepNum = 1;
  const baseline: ApiSurface | undefined = apiSurface
    ? (JSON.parse(readFileSync(apiSurface, 'utf-8')) as ApiSurface)
    : undefined;

  if (apiSurface && baseline) {
    console.log(`\n${separator}`);
    console.log(`Step ${stepNum}: Compat verification`);
    console.log(separator);

    const effectiveScope = scope ?? (spec ? 'spec-only' : 'full');
    let parsedSpec;
    if (effectiveScope === 'spec-only' && spec) {
      parsedSpec = await parseSpec(spec, { operationIdTransform, schemaNameTransform, transformSpec });
    } else if (effectiveScope === 'spec-only') {
      throw new CommandError('error: --scope spec-only requires --spec <path>', '', 1);
    }

    const compatFlow =
      parsedSpec && maxRetries > 0
        ? await runOverlayRetryLoop({
            baseline,
            parsedSpec,
            outputDir: output,
            lang,
            maxRetries,
            namespace: opts.namespace,
            onRetry: (attemptNumber, retryLimit, patchableCount) => {
              console.log(`\nRetry ${attemptNumber}/${retryLimit}: patching ${patchableCount} violation(s)...`);
            },
          })
        : {
            status: 'passed' as const,
            attempts: 0,
            patchedPerIteration: [],
            compatResult: await runCompatCheck(baseline, output, lang, parsedSpec),
          };

    const compatSummary = summarizeCompatCheck(compatFlow.compatResult);
    printCompatResult(compatSummary, baseline);
    const classifiedDiff = compatFlow.compatResult.diff;
    for (const c of classifiedDiff.changes) {
      if (c.severity !== 'additive') {
        console.log(`  [${c.category}] ${c.severity}: ${c.symbol} — ${c.message}`);
      }
    }
    const additiveCount = classifiedDiff.summary.additive;
    if (additiveCount > 0) {
      console.log(`  + ${additiveCount} new symbols added`);
    }

    if (diagnostics) {
      diagData.compatCheck = compatSummary;
      if (parsedSpec && maxRetries > 0) {
        setRetryDiagnostics(
          diagData,
          compatFlow.attempts,
          compatFlow.status === 'passed',
          compatSummary.preservationScore,
          compatFlow.patchedPerIteration,
        );
      }
    }

    if (compatFlow.status === 'passed' && compatFlow.compatResult.passed) {
      if (compatFlow.attempts > 0) {
        console.log(`Compat: converged after ${compatFlow.attempts} retry iteration(s)`);
      } else {
        console.log('Compat: passed');
      }
    } else {
      if (diagnostics) {
        writeDiagnostics(diagData);
        console.log('Diagnostics written to verify-diagnostics.json');
      }

      if (compatFlow.status === 'no-patchable') {
        console.log(
          'No patchable violations — cannot self-correct. Remaining violations require emitter code changes.',
        );
      } else if (compatFlow.status === 'stalled') {
        console.log(`Stalled — overlay patching is not making progress.`);
      }

      throw new CommandError('\nCompat violations found — fix the emitter and re-run `oagen verify`.', '', 1);
    }

    // Classified compat analysis — approvals, reports, and explanations
    // The diff is already classified from runCompatCheck/runOverlayRetryLoop
    if (effectiveReportPath || effectiveExplain || (compatConfig?.allow?.length ?? 0) > 0) {
      const langId = lang as LanguageId;
      const approvals = compatConfig?.allow ?? [];
      const remaining = unapprovedChanges(classifiedDiff.changes, approvals, langId);
      const hasFailure = remaining.some((c) => severityMeetsThreshold(c.severity, effectiveFailOn));

      if (effectiveExplain) {
        console.log('');
        console.log(formatHumanSummary(classifiedDiff, { explain: true }));
      }

      if (effectiveReportPath) {
        const report = generateReport(classifiedDiff);
        writeFileSync(effectiveReportPath, JSON.stringify(report, null, 2) + '\n');
        console.log(`Compat report written to ${effectiveReportPath}`);
      }

      if (hasFailure && effectiveFailOn !== 'none') {
        const unapprovedBreaking = remaining.filter((c) => severityMeetsThreshold(c.severity, effectiveFailOn));
        console.log(`\n${unapprovedBreaking.length} unapproved change(s) at or above '${effectiveFailOn}' threshold`);
      }
    }

    stepNum++;
  }

  if (oldSpec && spec && apiSurface && baseline) {
    console.log(`\n${separator}`);
    console.log(`Step ${stepNum}: Staleness detection`);
    console.log(separator);

    const oldParsedSpec = await parseSpec(oldSpec, { operationIdTransform, schemaNameTransform, transformSpec });
    const newParsedSpec = await parseSpec(spec, { operationIdTransform, schemaNameTransform, transformSpec });
    const stalenessResult = runStalenessCheck(baseline, oldParsedSpec, newParsedSpec, lang);

    if (stalenessResult.violations.length > 0) {
      console.log(`Found ${stalenessResult.violations.length} stale symbol(s):`);
      for (const v of stalenessResult.violations) {
        console.log(`  [${v.category}] ${v.severity}: ${v.symbolPath} — ${v.message}`);
      }
    } else {
      console.log('No stale symbols detected.');
    }

    if (diagnostics) {
      diagData.stalenessCheck = {
        staleSymbolCount: stalenessResult.violations.length,
        staleSymbols: stalenessResult.violations.map((v) => v.symbolPath),
      };
    }

    stepNum++;
  }

  const needsBaselineStep = !rawResults && !existsSync('smoke-results-raw.json');
  if (needsBaselineStep) {
    console.log(`\n${separator}`);
    console.log(`Step ${stepNum}: Generating spec-only baseline (no raw baseline found)`);
    console.log(separator);
    stepNum++;
  }

  console.log(`\n${separator}`);
  console.log(`Step ${stepNum}: Smoke test + diff`);
  console.log(separator);

  const smokeResult = runSmokeCheck({
    spec,
    lang,
    output,
    rawResults,
    smokeConfig,
    smokeRunner,
  });

  if (diagnostics) {
    diagData.smokeCheck = {
      passed: smokeResult.passed,
      ...(smokeResult.findingsCount !== undefined ? { findingsCount: smokeResult.findingsCount } : {}),
      ...(smokeResult.compileErrors ? { compileErrors: true } : {}),
    };
    writeDiagnostics(diagData);
    console.log('Diagnostics written to verify-diagnostics.json');
  }

  if (!smokeResult.passed) {
    if (smokeResult.compileErrors) {
      throw new CommandError('\nSDK compile errors — read smoke-compile-errors.json for details', '', 2);
    }

    throw new CommandError(
      '\nSmoke test findings — read smoke-diff-findings.json for details\n\n' +
        `Remediation guide (by finding type):
  "HTTP method differs"               → fix ${lang} emitter resources.ts (in emitter project)
  "Request path structure differs"     → fix ${lang} emitter resources.ts (in emitter project)
  "Query parameters differ"            → fix ${lang} emitter resources.ts (in emitter project)
  "Request body key sets differ"       → fix ${lang} emitter models.ts or resources.ts (in emitter project)
  "Skipped in SDK"                     → fix smoke/sdk-${lang}.ts (in emitter project)
  "Missing from SDK"                   → fix smoke/sdk-${lang}.ts (in emitter project)`,
      '',
      1,
    );
  }

  console.log('\nVerify: all checks passed');
}
