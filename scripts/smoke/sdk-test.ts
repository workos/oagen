/**
 * Runs an SDK smoke test + diff against an existing raw baseline.
 *
 * Usage:
 *   npm run smoke -- --lang node --sdk-path path/to/workos-node
 *   npm run smoke -- --lang ruby --sdk-path path/to/workos-ruby
 *   npm run smoke -- --lang node --sdk-path path/to/workos-node --raw-results custom-baseline.json
 *
 * Requires OPENAPI_SPEC env var (or --spec <path>) pointing to the OpenAPI spec.
 * The --lang flag is required and selects which SDK runner to use
 * (e.g. "node" → scripts/smoke/sdk-node.ts).
 */

import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);

// Extract --lang <name> (required)
const langIdx = args.indexOf('--lang');
const forwardedArgs = [...args];

if (langIdx === -1 || !args[langIdx + 1]) {
  console.error('--lang is required (e.g. --lang node, --lang ruby)');
  process.exit(1);
}

const lang = args[langIdx + 1];
forwardedArgs.splice(langIdx, 2);

// Extract --raw-results <path>
const rawResultsIdx = forwardedArgs.indexOf('--raw-results');
let rawResultsPath = 'smoke-results-raw.json';

if (rawResultsIdx !== -1 && forwardedArgs[rawResultsIdx + 1]) {
  rawResultsPath = forwardedArgs[rawResultsIdx + 1];
  forwardedArgs.splice(rawResultsIdx, 2);
}

// Resolve the SDK runner script
const sdkScript = `scripts/smoke/sdk-${lang}.ts`;
if (!existsSync(sdkScript)) {
  console.error(`No smoke runner found for language "${lang}" (expected ${sdkScript})`);
  console.error(`Available runners:`);
  // List available runners by convention
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync('scripts/smoke')) {
    const match = f.match(/^sdk-(.+)\.ts$/);
    if (match && match[1] !== 'test') {
      console.error(`  --lang ${match[1]}`);
    }
  }
  process.exit(1);
}

const sdkResultsPath = `smoke-results-sdk-${lang}.json`;

const diffArgs = ['--raw', rawResultsPath, '--sdk', sdkResultsPath];

// Pre-flight: tsc compile check on SDK if tsconfig.json exists
const sdkPathIdx = forwardedArgs.indexOf('--sdk-path');
const sdkPathValue = sdkPathIdx !== -1 && forwardedArgs[sdkPathIdx + 1] ? forwardedArgs[sdkPathIdx + 1] : undefined;

if (sdkPathValue) {
  const tsconfigPath = resolve(sdkPathValue, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Type-checking SDK at ${sdkPathValue}`);
    console.log('='.repeat(60));

    try {
      execFileSync('npx', ['tsc', '--noEmit', '--project', sdkPathValue], {
        stdio: 'pipe',
        env: process.env,
      });
      console.log('  Type check passed');
    } catch (err) {
      const output = (err as { stdout?: Buffer; stderr?: Buffer }).stdout?.toString() ?? '';
      const findings = parseTscOutput(output);
      writeFileSync('smoke-compile-errors.json', JSON.stringify(findings, null, 2));
      console.error(`  Type check failed (${findings.length} errors). See smoke-compile-errors.json`);
      process.exit(2);
    }
  }
}

const steps: [string, string[]][] = [
  [sdkScript, forwardedArgs],
  ['scripts/smoke/diff.ts', diffArgs],
];

for (const [script, scriptArgs] of steps) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running ${script}`);
  console.log('='.repeat(60));

  try {
    execFileSync('npx', ['tsx', script, ...scriptArgs], {
      stdio: 'inherit',
      env: process.env,
    });
  } catch {
    process.exit(1);
  }
}

function parseTscOutput(output: string): Array<{ file: string; line: number; code: string; message: string }> {
  const errors: Array<{ file: string; line: number; code: string; message: string }> = [];
  const re = /^(.+)\((\d+),\d+\): error (TS\d+): (.+)$/gm;
  let match;
  while ((match = re.exec(output)) !== null) {
    errors.push({
      file: match[1],
      line: Number(match[2]),
      code: match[3],
      message: match[4],
    });
  }
  return errors;
}
