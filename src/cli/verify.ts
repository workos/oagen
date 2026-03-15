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
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { getExtractor } from '../compat/extractor-registry.js';
import { diffSurfaces } from '../compat/differ.js';
import type { ApiSurface } from '../compat/types.js';

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
async function runCompatCheckInner(baseline: ApiSurface, outputDir: string, lang: string): Promise<boolean> {
  const extractor = getExtractor(lang);
  const candidate = await extractor.extract(outputDir);
  const diff = diffSurfaces(baseline, candidate);

  const pct = diff.preservationScore;
  const total = diff.totalBaselineSymbols;
  const kept = diff.preservedSymbols;

  console.log(`compat: ${pct}% (${kept}/${total} symbols preserved)`);
  if (diff.violations.length > 0) {
    for (const v of diff.violations) {
      console.log(`  [${v.category}] ${v.severity}: ${v.symbolPath} — ${v.message}`);
    }
    return false;
  }
  if (diff.additions.length > 0) {
    console.log(`  + ${diff.additions.length} new symbols added`);
  }
  return true;
}

export async function verifyCommand(opts: {
  spec?: string;
  lang: string;
  output: string;
  apiSurface?: string;
  rawResults?: string;
  smokeConfig?: string;
  smokeRunner?: string;
}): Promise<void> {
  const { spec, lang, output, apiSurface, rawResults, smokeConfig, smokeRunner } = opts;

  let stepNum = 1;

  // ── Compat verification (only when --api-surface is provided) ──────────
  if (apiSurface) {
    console.log(`\n${separator}`);
    console.log(`Step ${stepNum}: Compat verification`);
    console.log(separator);

    const passed = await runCompatCheckInner(JSON.parse(readFileSync(apiSurface, 'utf-8')) as ApiSurface, output, lang);
    if (passed) {
      console.log('Compat: passed');
    } else {
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
  } catch {
    if (existsSync('smoke-compile-errors.json')) {
      console.error('\nSDK compile errors — read smoke-compile-errors.json for details');
      process.exit(2);
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
