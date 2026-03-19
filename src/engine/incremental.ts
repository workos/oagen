import type { ApiSpec } from '../ir/types.js';
import type { Emitter, GeneratedFile } from './types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { diffSpecs } from '../differ/diff.js';
import { mapChangesToFiles } from '../differ/file-map.js';
import { buildEmitterContext, generateAllFiles, applyFileHeaders } from './generate-files.js';
import { writeFiles } from './writer.js';
import { integrateGeneratedFiles } from './integrate.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function generateIncremental(
  oldSpec: ApiSpec,
  newSpec: ApiSpec,
  emitter: Emitter,
  options: {
    namespace: string;
    outputDir: string;
    dryRun?: boolean;
    force?: boolean;
    target?: string;
    apiSurface?: ApiSurface;
    overlayLookup?: OverlayLookup;
  },
): Promise<{ generated: GeneratedFile[]; deleted: string[]; diff: ReturnType<typeof diffSpecs> }> {
  const diff = diffSpecs(oldSpec, newSpec);

  if (diff.changes.length === 0) {
    return { generated: [], deleted: [], diff };
  }

  const ctx = buildEmitterContext(newSpec, options);

  const affected = mapChangesToFiles(diff.changes, emitter, ctx);

  // Regenerate affected files from the new spec using full generation,
  // then filter to only the affected paths
  const allFiles = generateAllFiles(newSpec, emitter, ctx);

  const header = emitter.fileHeader();
  const affectedSet = new Set(affected.regenerate);
  const generated = applyFileHeaders(
    allFiles.filter((f) => affectedSet.has(f.path)),
    header,
  );

  if (!options.dryRun) {
    const writeResult = await writeFiles(generated, options.outputDir, {
      language: emitter.language,
      header,
    });
    if (writeResult.ignored.length > 0) {
      console.log(`Ignored ${writeResult.ignored.length} files (@oagen-ignore-file)`);
    }

    // Target integration pass — strip language prefix and write to live SDK
    if (options.target) {
      const targetResult = await integrateGeneratedFiles({
        files: generated,
        language: emitter.language,
        targetDir: options.target,
        header,
      });

      if (targetResult.written.length > 0) {
        console.log(`Target: created ${targetResult.written.length} new files`);
      }
      if (targetResult.merged.length > 0) {
        console.log(`Target: merged into ${targetResult.merged.length} existing files (additive only)`);
      }
      if (targetResult.skipped.length > 0) {
        console.log(`Target: skipped ${targetResult.skipped.length} files (excluded or no grammar)`);
      }
      if (targetResult.ignored.length > 0) {
        console.log(`Target: ignored ${targetResult.ignored.length} files (@oagen-ignore-file)`);
      }
    }

    if (options.force) {
      for (const filePath of affected.delete) {
        const fullPath = path.join(options.outputDir, filePath);
        await fs.rm(fullPath, { force: true });
      }
    }
  }

  return {
    generated,
    deleted: options.force ? affected.delete : [],
    diff,
  };
}
