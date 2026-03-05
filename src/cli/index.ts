import { Command } from 'commander';
import { parseCommand } from './parse.js';
import { generateCommand } from './generate.js';
import { diffCommand } from './diff.js';

const program = new Command()
  .name('oagen')
  .description('Generate SDKs from OpenAPI 3.1 specifications')
  .version('0.1.0');

program
  .command('parse')
  .description('Parse an OpenAPI spec and output IR as JSON')
  .requiredOption('--spec <path>', 'Path to OpenAPI 3.1 spec file')
  .action(parseCommand);

program
  .command('generate')
  .description('Generate SDK code from an OpenAPI spec')
  .requiredOption('--spec <path>', 'Path to OpenAPI 3.1 spec file')
  .requiredOption('--lang <language>', 'Target language')
  .requiredOption('--output <dir>', 'Output directory')
  .option('--namespace <name>', 'SDK namespace/package name')
  .option('--dry-run', 'Preview files without writing')
  .action(generateCommand);

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
