/**
 * Verify command: run smoke tests (and optional compat check) against an already-generated SDK.
 *
 * Does NOT generate — use `oagen generate` first. This command only verifies.
 *
 * Exit codes:
 *   0 — clean: all checks passed
 *   1 — findings: CRITICAL smoke mismatches, compat violations, or missing operations
 *       (see smoke-diff-findings.json)
 *   2 — compile error: SDK failed type check (see smoke-compile-errors.json)
 *
 * Usage:
 *   oagen verify --lang node --output ./sdk --spec openapi.yml
 *   oagen verify --lang node --output ./sdk --spec openapi.yml --api-surface sdk-node-surface.json
 *   oagen verify --lang node --output ./sdk --raw-results smoke-results-raw.json
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { getExtractor } from '../compat/extractor-registry.js';
import { diffSurfaces, specDerivedNames, specDerivedFieldPaths, filterSurface } from '../compat/differ.js';
import { parseSpec } from '../parser/parse.js';
import type { ApiSpec } from '../ir/types.js';
import type { ApiSurface, DiffResult } from '../compat/types.js';

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
  smokeCheck?: {
    passed: boolean;
    findingsCount?: number;
    compileErrors?: boolean;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const separator = '='.repeat(60);

/**
 * Resolve a smoke script path. Prefers compiled JS in dist/ (npm consumer),
 * falls back to TS source (dev mode).
 */
function resolveScript(scriptRelPath: string): { bin: string; script: string } {
  // Check for compiled JS in dist/scripts/ relative to the package root
  const distScript = path.resolve(__dirname, '..', '..', 'dist', 'scripts', scriptRelPath.replace(/\.ts$/, '.js'));
  if (existsSync(distScript)) {
    return { bin: 'node', script: distScript };
  }
  // Fall back to TS source via tsx
  const srcScript = path.resolve(__dirname, '..', '..', 'scripts', scriptRelPath);
  return { bin: 'npx', script: srcScript };
}

function runScript(scriptRelPath: string, args: string[]): void {
  const { bin, script } = resolveScript(scriptRelPath);
  const fullArgs = bin === 'npx' ? ['tsx', script, ...args] : [script, ...args];
  execFileSync(bin, fullArgs, { stdio: 'inherit', env: process.env });
}

/**
 * Run compat check directly (no subprocess). Uses the extractor registry
 * which is already populated by config-loader at CLI startup.
 */
interface CompatCheckResult {
  passed: boolean;
  diff: DiffResult;
  scopedToSpec: boolean;
  scopedSymbolCount?: number;
}

async function runCompatCheckInner(
  baseline: ApiSurface,
  outputDir: string,
  lang: string,
  spec?: ApiSpec,
): Promise<CompatCheckResult> {
  const extractor = getExtractor(lang);
  const candidate = await extractor.extract(outputDir);

  // If spec is provided, scope the comparison to only spec-derived symbols
  let scopedBaseline = baseline;
  let scopedToSpec = false;
  let scopedSymbolCount: number | undefined;
  if (spec) {
    const allowed = specDerivedNames(spec, extractor.hints);
    const fieldPaths = specDerivedFieldPaths(spec, extractor.hints);
    scopedBaseline = filterSurface(baseline, allowed, fieldPaths);
    scopedToSpec = true;
    const totalBefore =
      Object.keys(baseline.interfaces).length +
      Object.keys(baseline.classes).length +
      Object.keys(baseline.typeAliases).length +
      Object.keys(baseline.enums).length;
    scopedSymbolCount =
      Object.keys(scopedBaseline.interfaces).length +
      Object.keys(scopedBaseline.classes).length +
      Object.keys(scopedBaseline.typeAliases).length +
      Object.keys(scopedBaseline.enums).length;
    console.log(`(scoped to spec: ${scopedSymbolCount}/${totalBefore} baseline symbols in scope)`);
  }

  const diff = diffSurfaces(scopedBaseline, candidate, extractor.hints);

  const pct = diff.preservationScore;
  const total = diff.totalBaselineSymbols;
  const kept = diff.preservedSymbols;

  console.log(`compat: ${pct}% (${kept}/${total} symbols preserved)`);
  if (diff.violations.length > 0) {
    for (const v of diff.violations) {
      console.log(`  [${v.category}] ${v.severity}: ${v.symbolPath} — ${v.message}`);
    }
    // Only fail on breaking violations — warnings are backwards-compatible
    const breakingViolations = diff.violations.filter((v) => v.severity === 'breaking');
    if (breakingViolations.length > 0) {
      return { passed: false, diff, scopedToSpec, scopedSymbolCount };
    }
  }
  if (diff.additions.length > 0) {
    console.log(`  + ${diff.additions.length} new symbols added`);
  }
  return { passed: true, diff, scopedToSpec, scopedSymbolCount };
}

export async function verifyCommand(opts: {
  spec?: string;
  lang: string;
  output: string;
  apiSurface?: string;
  rawResults?: string;
  smokeConfig?: string;
  smokeRunner?: string;
  scope?: 'full' | 'spec-only';
  diagnostics?: boolean;
}): Promise<void> {
  const { spec, lang, output, apiSurface, rawResults, smokeConfig, smokeRunner, scope, diagnostics } = opts;
  const diagData: VerifyDiagnostics = {};

  let stepNum = 1;

  // ── Compat verification (only when --api-surface is provided) ──────────
  if (apiSurface) {
    console.log(`\n${separator}`);
    console.log(`Step ${stepNum}: Compat verification`);
    console.log(separator);

    // Determine compat scope: spec-only (default when --spec given) or full
    const effectiveScope = scope ?? (spec ? 'spec-only' : 'full');
    let parsedSpec: ApiSpec | undefined;
    if (effectiveScope === 'spec-only' && spec) {
      parsedSpec = await parseSpec(spec);
    } else if (effectiveScope === 'spec-only' && !spec) {
      console.error('error: --scope spec-only requires --spec <path>');
      process.exit(1);
    }

    const compatResult = await runCompatCheckInner(
      JSON.parse(readFileSync(apiSurface, 'utf-8')) as ApiSurface,
      output,
      lang,
      parsedSpec,
    );

    if (diagnostics) {
      const violationsByCategory: Record<string, number> = {};
      const violationsBySeverity: Record<string, number> = {};
      for (const v of compatResult.diff.violations) {
        violationsByCategory[v.category] = (violationsByCategory[v.category] ?? 0) + 1;
        violationsBySeverity[v.severity] = (violationsBySeverity[v.severity] ?? 0) + 1;
      }
      diagData.compatCheck = {
        totalBaselineSymbols: compatResult.diff.totalBaselineSymbols,
        preservedSymbols: compatResult.diff.preservedSymbols,
        preservationScore: compatResult.diff.preservationScore,
        violationsByCategory,
        violationsBySeverity,
        additions: compatResult.diff.additions.length,
        scopedToSpec: compatResult.scopedToSpec,
        ...(compatResult.scopedSymbolCount !== undefined ? { scopedSymbolCount: compatResult.scopedSymbolCount } : {}),
      };
    }

    if (compatResult.passed) {
      console.log('Compat: passed');
    } else {
      if (diagnostics) {
        writeDiagnostics(diagData);
      }
      console.error('\nCompat violations found — fix the emitter and re-run `oagen verify`.');
      process.exit(1);
    }
    stepNum++;
  }

  // ── Ensure a smoke baseline exists ─────────────────────────────────────
  let baselinePath = rawResults ?? 'smoke-results-raw.json';

  if (!rawResults && !existsSync('smoke-results-raw.json')) {
    if (!spec) {
      console.error('error: --spec <path> or OPENAPI_SPEC_PATH env var is required when no raw baseline exists');
      process.exit(1);
    }

    console.log(`\n${separator}`);
    console.log(`Step ${stepNum}: Generating spec-only baseline (no raw baseline found)`);
    console.log(separator);

    try {
      runScript('smoke/baseline.ts', ['--spec', spec]);
    } catch {
      console.error('Baseline generation failed');
      process.exit(1);
    }
    baselinePath = 'smoke-results-spec-baseline.json';
    stepNum++;
  }

  // ── Run smoke test + diff ──────────────────────────────────────────────
  console.log(`\n${separator}`);
  console.log(`Step ${stepNum}: Smoke test + diff`);
  console.log(separator);

  const smokeArgs = ['--lang', lang, '--sdk-path', output, '--raw-results', baselinePath];
  if (spec) smokeArgs.push('--spec', spec);
  if (smokeConfig) smokeArgs.push('--smoke-config', smokeConfig);

  try {
    if (smokeRunner) {
      // Custom smoke runner — run directly
      const bin = smokeRunner.endsWith('.ts') ? 'npx' : 'node';
      const fullArgs = bin === 'npx' ? ['tsx', smokeRunner, ...smokeArgs] : [smokeRunner, ...smokeArgs];
      execFileSync(bin, fullArgs, { stdio: 'inherit', env: process.env });
    } else {
      runScript('smoke/sdk-test.ts', smokeArgs);
    }

    if (diagnostics) {
      diagData.smokeCheck = { passed: true };
      writeDiagnostics(diagData);
    }
  } catch {
    if (existsSync('smoke-compile-errors.json')) {
      if (diagnostics) {
        diagData.smokeCheck = { passed: false, compileErrors: true };
        writeDiagnostics(diagData);
      }
      console.error('\nSDK compile errors — read smoke-compile-errors.json for details');
      process.exit(2);
    }

    const findingsCount = existsSync('smoke-diff-findings.json')
      ? (JSON.parse(readFileSync('smoke-diff-findings.json', 'utf-8')) as unknown[]).length
      : undefined;

    if (diagnostics) {
      diagData.smokeCheck = { passed: false, findingsCount };
      writeDiagnostics(diagData);
    }

    console.error('\nSmoke test findings — read smoke-diff-findings.json for details');
    console.error(`
Remediation guide (by finding type):
  "HTTP method differs"               → fix ${lang} emitter resources.ts (in emitter project)
  "Request path structure differs"     → fix ${lang} emitter resources.ts (in emitter project)
  "Query parameters differ"            → fix ${lang} emitter resources.ts (in emitter project)
  "Request body key sets differ"       → fix ${lang} emitter models.ts or resources.ts (in emitter project)
  "Skipped in SDK"                     → fix smoke/sdk-${lang}.ts (in emitter project)
  "Missing from SDK"                   → fix smoke/sdk-${lang}.ts (in emitter project)`);
    process.exit(1);
  }

  console.log('\nVerify: all checks passed');
}

function writeDiagnostics(data: VerifyDiagnostics): void {
  writeFileSync('verify-diagnostics.json', JSON.stringify(data, null, 2) + '\n');
  console.log('Diagnostics written to verify-diagnostics.json');
}
