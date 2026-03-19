import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GeneratedFile } from './types.js';
import { writeFiles, type WriteResult } from './writer.js';

export function mapFilesForTargetIntegration(
  files: GeneratedFile[],
  language: string,
  targetDir?: string,
): GeneratedFile[] {
  const langPrefix = `${language}/`;
  return files
    .filter((f) => f.integrateTarget !== false) // integrateTarget: false files are standalone-only
    .map((f) => {
      const stripped = f.path.startsWith(langPrefix) ? f.path.replace(langPrefix, '') : f.path;
      // For files that already exist in the target, only update docstrings
      // and header — don't add new imports, symbols, or members that may
      // conflict with hand-written code.
      const existsInTarget = targetDir ? fs.existsSync(path.join(targetDir, stripped)) : false;
      return {
        ...f,
        skipIfExists: false, // Always merge in target — never hard-skip
        mergeMode: existsInTarget ? ('docstring-only' as const) : ('full' as const),
        path: stripped,
      };
    });
}

export async function integrateGeneratedFiles(opts: {
  files: GeneratedFile[];
  language: string;
  targetDir: string;
  header: string;
}): Promise<WriteResult> {
  return writeFiles(mapFilesForTargetIntegration(opts.files, opts.language, opts.targetDir), opts.targetDir, {
    language: opts.language,
    header: opts.header,
  });
}
