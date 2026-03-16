import 'dotenv/config';
import { Command } from 'commander';
import { parseCommand } from './parse.js';
import { generateCommand } from './generate.js';
import { diffCommand } from './diff.js';
import { extractCommand } from './extract.js';
import { verifyCommand } from './verify.js';
import { loadConfig } from './config-loader.js';
import { applyConfig } from './plugin-loader.js';

function handleError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}

// Load config synchronously at startup so user-provided emitters/extractors are
// registered before any command runs. loadConfig is async (dynamic import), so
// we use top-level await.
const config = await loadConfig();
let configSmokeRunners: Record<string, string> | undefined;
if (config) {
  applyConfig(config);
  configSmokeRunners = config.smokeRunners;
}

const program = new Command()
  .name('oagen')
  .description('Generate SDKs from OpenAPI 3.1 specifications')
  .version('0.0.1');

program
  .command('parse')
  .description('Parse an OpenAPI spec and output IR as JSON')
  .option('--spec <path>', 'Path to OpenAPI spec file (or set OPENAPI_SPEC_PATH)')
  .action((opts) => {
    opts.spec ??= process.env.OPENAPI_SPEC_PATH;
    if (!opts.spec) {
      console.error('error: --spec <path> or OPENAPI_SPEC_PATH env var is required');
      process.exit(1);
    }
    return parseCommand(opts);
  });

program
  .command('generate')
  .description('Generate SDK code from an OpenAPI spec')
  .option('--spec <path>', 'Path to OpenAPI spec file (or set OPENAPI_SPEC_PATH)')
  .requiredOption('--lang <language>', 'Target language')
  .requiredOption('--output <dir>', 'Output directory')
  .option('--namespace <name>', 'SDK namespace/package name')
  .option('--dry-run', 'Preview files without writing')
  .option('--api-surface <path>', 'Path to baseline API surface JSON for compat overlay')
  .option('--manifest <path>', 'Path to smoke-manifest.json for method overlay')
  .option('--no-compat-check', 'Skip compat overlay even if --api-surface is provided')
  .action((opts) => {
    opts.spec ??= process.env.OPENAPI_SPEC_PATH;
    if (!opts.spec) {
      console.error('error: --spec <path> or OPENAPI_SPEC_PATH env var is required');
      process.exit(1);
    }
    generateCommand(opts).catch(handleError);
  });

program
  .command('diff')
  .description('Incrementally generate from spec changes')
  .requiredOption('--old <path>', 'Path to old spec')
  .requiredOption('--new <path>', 'Path to new spec')
  .option('--lang <language>', 'Target language (required unless --report)')
  .option('--output <dir>', 'Output directory')
  .option('--report', 'Output diff report as JSON')
  .option('--force', 'Allow file deletions without confirmation')
  .option('--api-surface <path>', 'Path to baseline API surface JSON for compat overlay')
  .option('--manifest <path>', 'Path to smoke-manifest.json for method overlay')
  .action((opts) => {
    diffCommand(opts).catch(handleError);
  });

program
  .command('extract')
  .description('Extract public API surface from a live SDK')
  .requiredOption('--sdk-path <path>', 'Path to the live SDK')
  .requiredOption('--lang <language>', 'Target language')
  .option('--output <path>', 'Output file path')
  .action((opts) => {
    opts.output ??= `sdk-${opts.lang}-surface.json`;
    extractCommand(opts).catch(handleError);
  });

program
  .command('verify')
  .description('Run smoke tests (and optional compat check) against an already-generated SDK')
  .option('--spec <path>', 'Path to OpenAPI spec file (or set OPENAPI_SPEC_PATH)')
  .requiredOption('--lang <language>', 'Target language')
  .requiredOption('--output <dir>', 'Path to the generated SDK')
  .option('--api-surface <path>', 'Baseline API surface JSON — enables compat verification')
  .option('--raw-results <path>', 'Path to an existing smoke baseline file to diff against')
  .option('--smoke-config <path>', 'Path to smoke config JSON for skip lists and service mappings')
  .option('--smoke-runner <path>', 'Path to a custom smoke runner script (overrides built-in sdk-test.ts)')
  .option(
    '--scope <mode>',
    'Compat scope: "full" compares all baseline symbols, "spec-only" compares only symbols derivable from the OpenAPI spec (default: spec-only when --spec is provided)',
  )
  .option('--diagnostics', 'Output verify-diagnostics.json with structured violation breakdown')
  .action((opts) => {
    opts.spec ??= process.env.OPENAPI_SPEC_PATH;
    // --spec is only required when we need to generate a baseline (no --raw-results
    // and no existing smoke-results-raw.json). Defer the check to verifyCommand.
    // CLI --smoke-runner takes precedence, then per-language smokeRunners map from config
    opts.smokeRunner ??= configSmokeRunners?.[opts.lang];
    verifyCommand(opts).catch(handleError);
  });

program.parse();
