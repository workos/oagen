import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { CommandError } from '../errors.js';
import type { ApiSpec } from '../ir/types.js';
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

/**
 * Run the smoke step: the spec-only baseline when no raw baseline exists,
 * then the runner (and its diff) against the baseline.
 *
 * The smoke scripts run as subprocesses and take `--spec`, which a script
 * parses bare — without the config's settings, which cannot cross a process
 * boundary. `parsedSpec` is what `--spec` parses to with those settings, as
 * `generate` parses it; it is written to a file for the scripts' lifetime
 * and handed to both as `--ir <path>` beside `--spec`, so the baseline lists
 * the operations `generate` reads (`Pets.list` under an `operationIdTransform`
 * that strips `PetsController_`, no `Pets.get` under a `transformSpec` that
 * drops `/pets/{id}`) and a runner that reads the file plans the same ones
 * (#567). Without `parsedSpec`, each script parses `--spec` as before.
 */
export function runSmokeCheck(opts: {
  spec?: string;
  /** What `--spec` parses to with the config's settings (see above). */
  parsedSpec?: ApiSpec;
  lang: string;
  output: string;
  rawResults?: string;
  smokeConfig?: string;
  smokeRunner?: string;
}): SmokeCheckResult {
  const { spec, parsedSpec, lang, output, rawResults, smokeConfig, smokeRunner } = opts;

  const irDir = parsedSpec ? mkdtempSync(path.join(tmpdir(), 'oagen-verify-')) : undefined;
  const irArgs: string[] = [];
  if (irDir) {
    const irPath = path.join(irDir, 'spec-ir.json');
    writeFileSync(irPath, JSON.stringify(parsedSpec));
    irArgs.push('--ir', irPath);
  }

  try {
    return runSmokeScripts({ spec, lang, output, rawResults, smokeConfig, smokeRunner, irArgs });
  } finally {
    if (irDir) rmSync(irDir, { recursive: true, force: true });
  }
}

function runSmokeScripts(opts: {
  spec?: string;
  lang: string;
  output: string;
  rawResults?: string;
  smokeConfig?: string;
  smokeRunner?: string;
  /** `--ir <path>` when the IR `--spec` parses to was handed over; else empty. */
  irArgs: string[];
}): SmokeCheckResult {
  const { spec, lang, output, rawResults, smokeConfig, smokeRunner, irArgs } = opts;

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
      runPackagedScript('smoke/baseline.ts', ['--spec', spec, ...irArgs]);
    } catch {
      throw new CommandError('Baseline generation failed', '', 1);
    }
    baselinePath = 'smoke-results-spec-baseline.json';
    generatedBaseline = true;
  }

  const smokeArgs = ['--lang', lang, '--sdk-path', output, '--raw-results', baselinePath];
  if (spec) smokeArgs.push('--spec', spec, ...irArgs);
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
