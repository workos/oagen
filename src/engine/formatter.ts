/**
 * Post-integration formatter.
 *
 * After generating and merging files into a target directory, runs the
 * emitter-provided format command on all written/merged files so that
 * generated code matches the target project's style conventions.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { Emitter } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Run the emitter's format command on the given target files.
 * Silently skips if the emitter has no formatCommand or returns null.
 */
export async function formatTargetFiles(emitter: Emitter, targetDir: string, filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) return;
  if (!emitter.formatCommand) return;

  const formatCmd = emitter.formatCommand(targetDir);
  if (!formatCmd) return;

  const absolutePaths = filePaths.map((f) => path.resolve(targetDir, f));
  const batchSize = formatCmd.batchSize ?? 100;

  process.stderr.write(
    `[oagen] formatting ${absolutePaths.length} file(s) with ${formatCmd.cmd} (batch ${batchSize})\n`,
  );

  for (let i = 0; i < absolutePaths.length; i += batchSize) {
    const batch = absolutePaths.slice(i, i + batchSize);
    try {
      await execFileAsync(formatCmd.cmd, [...formatCmd.args, ...batch], {
        cwd: targetDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      });
    } catch (err) {
      // Formatter failed on this batch — continue with remaining batches.
      // Surface the failure on stderr so misconfigured commands don't silently
      // leave generated code unformatted every regen.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[oagen] formatter batch failed: ${msg}\n`);
    }
  }
}
