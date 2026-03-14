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
 *   oagen verify --lang node --output ./sdk --spec openapi.yml --api-surface api-surface.json
 *   oagen verify --lang node --output ./sdk --raw-results smoke-results-raw.json
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptsDir = path.resolve(__dirname, '..', '..', 'scripts');

const separator = '='.repeat(60);

export async function verifyCommand(opts: {
  spec: string;
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

    try {
      execFileSync(
        'npx',
        ['tsx', path.join(scriptsDir, 'verify-compat.ts'), '--surface', apiSurface, '--output', output, '--lang', lang],
        { stdio: 'inherit', env: process.env },
      );
      console.log('Compat: passed');
    } catch {
      console.error('\nCompat violations found — fix the emitter and re-run `oagen verify`.');
      process.exit(1);
    }
    stepNum++;
  }

  // ── Ensure a smoke baseline exists ─────────────────────────────────────
  let baselinePath = rawResults ?? 'smoke-results-raw.json';

  if (!rawResults && !existsSync('smoke-results-raw.json')) {
    console.log(`\n${separator}`);
    console.log(`Step ${stepNum}: Generating spec-only baseline (no raw baseline found)`);
    console.log(separator);

    try {
      execFileSync('npx', ['tsx', path.join(scriptsDir, 'smoke', 'baseline.ts'), '--spec', spec], {
        stdio: 'inherit',
        env: process.env,
      });
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

  const smokeScript = smokeRunner ?? path.join(scriptsDir, 'smoke', 'sdk-test.ts');
  const smokeArgs = [
    'tsx',
    smokeScript,
    '--lang',
    lang,
    '--sdk-path',
    output,
    '--raw-results',
    baselinePath,
  ];
  if (smokeConfig) smokeArgs.push('--smoke-config', smokeConfig);

  try {
    execFileSync('npx', smokeArgs, { stdio: 'inherit', env: process.env });
  } catch {
    if (existsSync('smoke-compile-errors.json')) {
      console.error('\nSDK compile errors — read smoke-compile-errors.json for details');
      process.exit(2);
    }

    console.error('\nSmoke test findings — read smoke-diff-findings.json for details');
    console.error(`
Remediation guide (by finding type):
  "HTTP method differs"               → fix src/emitters/${lang}/resources.ts
  "Request path structure differs"     → fix src/emitters/${lang}/resources.ts
  "Query parameters differ"            → fix src/emitters/${lang}/resources.ts
  "Request body key sets differ"       → fix src/emitters/${lang}/models.ts or resources.ts
  "Skipped in SDK"                     → fix scripts/smoke/sdk-${lang}.ts
  "Missing from SDK"                   → fix scripts/smoke/sdk-${lang}.ts`);
    process.exit(1);
  }

  console.log('\nVerify: all checks passed');
}
