import type { GeneratedFile } from './types.js';
import { writeFiles, type WriteResult } from './writer.js';

export function mapFilesForTargetIntegration(files: GeneratedFile[], language: string): GeneratedFile[] {
  const langPrefix = `${language}/`;
  return files
    .filter((f) => f.integrateTarget !== false) // integrateTarget: false files are standalone-only
    .map((f) => {
      const stripped = f.path.startsWith(langPrefix) ? f.path.replace(langPrefix, '') : f.path;
      return {
        ...f,
        skipIfExists: false, // Always merge in target — never hard-skip
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
  return writeFiles(mapFilesForTargetIntegration(opts.files, opts.language), opts.targetDir, {
    language: opts.language,
    header: opts.header,
  });
}
