import 'dotenv/config';
import { Command } from 'commander';
import { parseCommand } from './parse.js';
import { generateCommand } from './generate.js';
import { diffCommand } from './diff.js';
import { extractCommand } from './extract.js';
import { compatExtractCommand } from './compat-extract.js';
import { compatDiffCommand } from './compat-diff.js';
import { compatSummaryCommand } from './compat-summary.js';
import { verifyCommand } from './verify.js';
import { initCommand } from './init.js';
import { resolveCommand } from './resolve.js';
import { loadConfig } from './config-loader.js';
import { applyConfig } from './plugin-loader.js';
import { CommandError } from '../errors.js';

function handleError(err: unknown): never {
  const exitCode = err instanceof CommandError ? err.exitCode : 1;
  const message = err instanceof Error ? err.message : String(err);
  if (message) console.error(message);
  process.exit(exitCode);
}

// Parse --config before Commander runs so we can load the right config file
// at startup. Commander's parseOptions isn't available before .parse(), so we
// do a simple argv scan.
const configArgIdx = process.argv.indexOf('--config');
const explicitConfigPath = configArgIdx !== -1 ? process.argv[configArgIdx + 1] : undefined;

// Load config at startup so user-provided emitters/extractors are registered
// before any command runs. loadConfig is async (dynamic import), so we use
// top-level await.
let configSmokeRunners: Record<string, string> | undefined;
let configOperationIdTransform: ((id: string) => string) | undefined;
let configSchemaNameTransform: ((name: string) => string) | undefined;
let configDocUrl: string | undefined;
let configOperationHints: Record<string, import('../ir/operation-hints.js').OperationHint> | undefined;
let configMountRules: Record<string, string> | undefined;
let configCompat: import('../compat/config.js').CompatConfig | undefined;
try {
  const config = await loadConfig(explicitConfigPath);
  if (config) {
    applyConfig(config);
    configSmokeRunners = config.smokeRunners;
    configOperationIdTransform = config.operationIdTransform;
    configSchemaNameTransform = config.schemaNameTransform;
    configDocUrl = config.docUrl;
    configOperationHints = config.operationHints;
    configMountRules = config.mountRules;
    configCompat = config.compat;
  }
} catch (err) {
  handleError(err);
}

const program = new Command()
  .name('oagen')
  .description('Framework for building OpenAPI SDK emitters')
  .version('0.0.1')
  .option('--config <path>', 'Path to oagen config file (default: oagen.config.ts in cwd)');

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
  .description('Run a registered emitter against an OpenAPI spec')
  .option('--spec <path>', 'Path to OpenAPI spec file (or set OPENAPI_SPEC_PATH)')
  .requiredOption('--lang <language>', 'Target language')
  .requiredOption('--output <dir>', 'Output directory')
  .option('--target <dir>', 'Target directory for live SDK integration (merged output)')
  .option('--namespace <name>', 'SDK namespace/package name')
  .option('--dry-run', 'Preview files without writing')
  .option('--api-surface <path>', 'Path to baseline API surface JSON for compat overlay')
  .option('--no-compat-check', 'Skip compat overlay even if --api-surface is provided')
  .option('--no-prune', 'Skip deletion of stale files recorded in the previous .oagen-manifest.json')
  .action((opts) => {
    opts.spec ??= process.env.OPENAPI_SPEC_PATH;
    if (!opts.spec) {
      console.error('error: --spec <path> or OPENAPI_SPEC_PATH env var is required');
      process.exit(1);
    }
    generateCommand({
      ...opts,
      operationIdTransform: configOperationIdTransform,
      schemaNameTransform: configSchemaNameTransform,
      docUrl: configDocUrl,
      operationHints: configOperationHints,
      mountRules: configMountRules,
    }).catch(handleError);
  });

program
  .command('diff')
  .description('Compare two OpenAPI specs and output a diff report')
  .requiredOption('--old <path>', 'Path to old spec')
  .requiredOption('--new <path>', 'Path to new spec')
  .action((opts) => {
    diffCommand({
      ...opts,
      operationIdTransform: configOperationIdTransform,
      schemaNameTransform: configSchemaNameTransform,
      docUrl: configDocUrl,
    }).catch(handleError);
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
  .command('compat-extract')
  .description('Extract a compat snapshot from a live SDK and write .oagen-compat-snapshot.json')
  .requiredOption('--sdk-path <path>', 'Path to the live SDK')
  .requiredOption('--lang <language>', 'Target language')
  .requiredOption('--output <dir>', 'Directory to write .oagen-compat-snapshot.json into')
  .option('--spec <path>', 'Path to OpenAPI spec — enriches symbols with operationId, route, and specSha')
  .action((opts) => {
    opts.spec ??= process.env.OPENAPI_SPEC_PATH;
    compatExtractCommand({
      ...opts,
      schemaNameTransform: configSchemaNameTransform,
    }).catch(handleError);
  });

program
  .command('compat-diff')
  .description('Diff two compat snapshot files and produce a classified change report')
  .requiredOption('--baseline <path>', 'Path to the baseline compat snapshot JSON')
  .requiredOption('--candidate <path>', 'Path to the candidate compat snapshot JSON')
  .option('--output <path>', 'Write machine-readable report to this path')
  .option('--fail-on <level>', 'Fail threshold: none, breaking, or soft-risk', 'breaking')
  .option('--explain', 'Include provenance explanations in output')
  .action((opts) => {
    compatDiffCommand(opts).catch(handleError);
  });

program
  .command('compat-summary')
  .description('Format compat report(s) as a markdown PR comment')
  .requiredOption('--report <path...>', 'Path(s) to compat report JSON(s) — pass multiple for cross-language rollup')
  .option('--output <path>', 'Write markdown to this file instead of stdout')
  .action((opts) => {
    compatSummaryCommand(opts).catch(handleError);
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
  .option('--old-spec <path>', 'Previous OpenAPI spec — enables staleness detection for removed/renamed symbols')
  .option('--namespace <name>', 'SDK namespace/package name (used by retry loop for regeneration)')
  .option('--diagnostics', 'Output verify-diagnostics.json with structured violation breakdown')
  .option('--max-retries <n>', 'Max retry iterations for self-correcting overlay loop (default: 3)', '3')
  .option('--compat-report <path>', 'Write machine-readable compat report to this path')
  .option('--compat-fail-on <level>', 'Fail threshold: none, breaking, or soft-risk')
  .option('--compat-baseline <path>', 'Path to baseline compatibility snapshot')
  .option('--compat-explain', 'Include provenance explanations in compat output')
  .action((opts) => {
    opts.spec ??= process.env.OPENAPI_SPEC_PATH;
    // --spec is only required when we need to generate a baseline (no --raw-results
    // and no existing smoke-results-raw.json). Defer the check to verifyCommand.
    // CLI --smoke-runner takes precedence, then per-language smokeRunners map from config
    opts.smokeRunner ??= configSmokeRunners?.[opts.lang];
    verifyCommand({
      ...opts,
      maxRetries: parseInt(opts.maxRetries, 10),
      operationIdTransform: configOperationIdTransform,
      schemaNameTransform: configSchemaNameTransform,
      compatConfig: configCompat,
      compatReport: opts.compatReport,
      compatFailOn: opts.compatFailOn,
      compatBaseline: opts.compatBaseline,
      compatExplain: opts.compatExplain,
    }).catch(handleError);
  });

program
  .command('resolve')
  .description('Resolve operation names from spec and output a review table')
  .option('--spec <path>', 'Path to OpenAPI spec file (or set OPENAPI_SPEC_PATH)')
  .option('--format <format>', 'Output format: table or json', 'table')
  .action((opts) => {
    opts.spec ??= process.env.OPENAPI_SPEC_PATH;
    if (!opts.spec) {
      console.error('error: --spec <path> or OPENAPI_SPEC_PATH env var is required');
      process.exit(1);
    }
    resolveCommand({
      ...opts,
      operationIdTransform: configOperationIdTransform,
      schemaNameTransform: configSchemaNameTransform,
      docUrl: configDocUrl,
      operationHints: configOperationHints,
      mountRules: configMountRules,
    }).catch(handleError);
  });

program
  .command('init')
  .description('Scaffold a new emitter project')
  .requiredOption('--lang <language>', 'Target language')
  .option('--project <dir>', 'Project directory', '.')
  .action((opts) => {
    initCommand(opts).catch(handleError);
  });

program.parse();
