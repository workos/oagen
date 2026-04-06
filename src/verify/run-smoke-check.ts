import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { CommandError } from '../errors.js';
import type { SmokeCheckResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveScript(scriptRelPath: string): { bin: string; script: string } {
  const distScript = path.resolve(__dirname, '..', '..', 'dist', 'scripts', scriptRelPath.replace(/\.ts$/, '.mjs'));
  if (existsSync(distScript)) {
    return { bin: 'node', script: distScript };
  }
  const srcScript = path.resolve(__dirname, '..', '..', 'scripts', scriptRelPath);
  return { bin: 'npx', script: srcScript };
}

function runPackagedScript(scriptRelPath: string, args: string[]): void {
  const { bin, script } = resolveScript(scriptRelPath);
  const fullArgs = bin === 'npx' ? ['tsx', script, ...args] : [script, ...args];
  execFileSync(bin, fullArgs, { stdio: 'inherit', env: process.env });
}

export function runSmokeCheck(opts: {
  spec?: string;
  lang: string;
  output: string;
  rawResults?: string;
  smokeConfig?: string;
  smokeRunner?: string;
}): SmokeCheckResult {
  const { spec, lang, output, rawResults, smokeConfig, smokeRunner } = opts;

  let baselinePath = rawResults ?? 'smoke-results-raw.json';
  let generatedBaseline = false;

  if (!rawResults && !existsSync('smoke-results-raw.json')) {
    if (!spec) {
      throw new CommandError(
        'error: --spec <path> or OPENAPI_SPEC_PATH env var is required when no raw baseline exists',
        '',
        1,
      );
    }

    try {
      runPackagedScript('smoke/baseline.ts', ['--spec', spec]);
    } catch {
      throw new CommandError('Baseline generation failed', '', 1);
    }
    baselinePath = 'smoke-results-spec-baseline.json';
    generatedBaseline = true;
  }

  const smokeArgs = ['--lang', lang, '--sdk-path', output, '--raw-results', baselinePath];
  if (spec) smokeArgs.push('--spec', spec);
  if (smokeConfig) smokeArgs.push('--smoke-config', smokeConfig);

  try {
    if (smokeRunner) {
      const bin = smokeRunner.endsWith('.ts') ? 'npx' : 'node';
      const fullArgs = bin === 'npx' ? ['tsx', smokeRunner, ...smokeArgs] : [smokeRunner, ...smokeArgs];
      execFileSync(bin, fullArgs, { stdio: 'inherit', env: process.env });
    } else {
      runPackagedScript('smoke/sdk-test.ts', smokeArgs);
    }

    return { passed: true, baselinePath, generatedBaseline };
  } catch {
    if (existsSync('smoke-compile-errors.json')) {
      return { passed: false, compileErrors: true, baselinePath, generatedBaseline };
    }

    const findingsCount = existsSync('smoke-diff-findings.json')
      ? (JSON.parse(readFileSync('smoke-diff-findings.json', 'utf-8')) as unknown[]).length
      : undefined;

    return { passed: false, findingsCount, baselinePath, generatedBaseline };
  }
}
