/**
 * Smoke verify-and-fix loop: generate SDK → smoke test → diff, in one command.
 *
 * Designed for autonomous agent workflows. The agent runs this, reads
 * smoke-diff-findings.json on failure, fixes emitter code, and re-runs.
 *
 * Exit codes:
 *   0 — clean: no CRITICAL findings, no missing SDK operations
 *   1 — findings: CRITICAL mismatches or missing operations (see smoke-diff-findings.json)
 *   2 — compile error: SDK failed type check (see smoke-compile-errors.json)
 *
 * Usage:
 *   npm run smoke:loop -- --lang node --sdk-path ./generated-sdk --spec openapi.yml --namespace WorkOS
 *   npm run smoke:loop -- --lang node --sdk-path ./generated-sdk --raw-results smoke-results-spec-baseline.json
 *
 * If --raw-results is not provided and no smoke-results-raw.json exists,
 * a spec-only baseline is generated automatically.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);

function extractArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || !args[idx + 1]) return undefined;
  return args[idx + 1];
}

const lang = extractArg('--lang');
const sdkPath = extractArg('--sdk-path');
const spec = extractArg('--spec') ?? process.env.OPENAPI_SPEC_PATH;
const namespace = extractArg('--namespace');
const rawResults = extractArg('--raw-results');
const smokeConfig = extractArg('--smoke-config') ?? process.env.SMOKE_CONFIG;

if (!lang) {
  console.error('error: --lang is required');
  process.exit(1);
}
if (!sdkPath) {
  console.error('error: --sdk-path is required');
  process.exit(1);
}
if (!spec) {
  console.error('error: --spec or OPENAPI_SPEC_PATH is required');
  process.exit(1);
}

// Step 1: Generate the SDK
console.log(`\n${'='.repeat(60)}`);
console.log(`Generating SDK: lang=${lang} output=${sdkPath}`);
console.log('='.repeat(60));

const generateArgs = ['src/cli/index.ts', 'generate', '--lang', lang, '--spec', spec, '--output', sdkPath];
if (namespace) generateArgs.push('--namespace', namespace);

try {
  execFileSync('npx', ['tsx', ...generateArgs], { stdio: 'inherit', env: process.env });
} catch {
  console.error('SDK generation failed');
  process.exit(1);
}

// Step 2: Ensure a baseline exists
let baselinePath = rawResults ?? 'smoke-results-raw.json';
if (!rawResults && !existsSync('smoke-results-raw.json')) {
  console.log(`\n${'='.repeat(60)}`);
  console.log('No baseline found — generating spec-only baseline');
  console.log('='.repeat(60));

  try {
    execFileSync('npx', ['tsx', 'scripts/smoke/baseline.ts'], { stdio: 'inherit', env: process.env });
  } catch {
    console.error('Baseline generation failed');
    process.exit(1);
  }
  baselinePath = 'smoke-results-spec-baseline.json';
}

// Step 3: Run smoke test + diff (sdk-test.ts handles type check, SDK runner, and diff)
console.log(`\n${'='.repeat(60)}`);
console.log('Running smoke test + diff');
console.log('='.repeat(60));

const smokeArgs = [
  'tsx',
  'scripts/smoke/sdk-test.ts',
  '--lang',
  lang,
  '--sdk-path',
  sdkPath,
  '--raw-results',
  baselinePath,
];
if (smokeConfig) smokeArgs.push('--smoke-config', smokeConfig);

try {
  execFileSync('npx', smokeArgs, { stdio: 'inherit', env: process.env });
} catch {
  // sdk-test.ts exits 2 for compile errors, 1 for diff findings
  // Both write structured JSON files for agent consumption
  if (existsSync('smoke-compile-errors.json')) {
    console.error('\nSDK compile errors — read smoke-compile-errors.json for details');
    process.exit(2);
  }
  console.error('\nSmoke test findings — read smoke-diff-findings.json for details');

  console.error(`
Remediation guide (by finding type):
  "HTTP method differs"               → fix method generation in ${lang} emitter resources.ts (in emitter project)
  "Request path structure differs"     → fix path interpolation in ${lang} emitter resources.ts (in emitter project)
  "Query parameters differ"            → fix query param serialization in ${lang} emitter resources.ts (in emitter project)
  "Request body key sets differ"       → fix model serialization in ${lang} emitter models.ts or resources.ts (in emitter project)
  "Skipped in SDK"                     → fix method resolution in smoke/sdk-${lang}.ts (in emitter project)
  "Missing from SDK"                   → add SDK method mapping in smoke/sdk-${lang}.ts (in emitter project)`);

  process.exit(1);
}

console.log('\nSmoke loop: all clear');
