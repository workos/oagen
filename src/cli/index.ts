import { Command } from 'commander';
import { parseCommand } from './parse.js';
import { generateCommand } from './generate.js';
import { diffCommand } from './diff.js';

const program = new Command()
  .name('oagen')
  .description('Generate SDKs from OpenAPI 3.1 specifications')
  .version('0.0.1');

program
  .command('parse')
  .description('Parse an OpenAPI spec and output IR as JSON')
  .option('--spec <path>', 'Path to OpenAPI spec file (or set OPENAPI_SPEC)')
  .action((opts) => {
    opts.spec ??= process.env.OPENAPI_SPEC;
    if (!opts.spec) {
      console.error('error: --spec <path> or OPENAPI_SPEC env var is required');
      process.exit(1);
    }
    return parseCommand(opts);
  });

program
  .command('generate')
  .description('Generate SDK code from an OpenAPI spec')
  .option('--spec <path>', 'Path to OpenAPI spec file (or set OPENAPI_SPEC)')
  .requiredOption('--lang <language>', 'Target language')
  .requiredOption('--output <dir>', 'Output directory')
  .option('--namespace <name>', 'SDK namespace/package name')
  .option('--dry-run', 'Preview files without writing')
  .option('--api-surface <path>', 'Path to baseline API surface JSON for compat overlay')
  .option('--no-compat-check', 'Skip compat overlay even if --api-surface is provided')
  .action((opts) => {
    opts.spec ??= process.env.OPENAPI_SPEC;
    if (!opts.spec) {
      console.error('error: --spec <path> or OPENAPI_SPEC env var is required');
      process.exit(1);
    }
    return generateCommand(opts);
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
  .action(diffCommand);

program.parse();
