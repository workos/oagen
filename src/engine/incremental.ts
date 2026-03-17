import { IR_VERSION } from '../ir/types.js';
import type { ApiSpec } from '../ir/types.js';
import type { Emitter, EmitterContext, GeneratedFile } from './types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { diffSpecs } from '../differ/diff.js';
import { mapChangesToFiles } from '../differ/file-map.js';
import { generateAllFiles, applyFileHeaders } from './orchestrator.js';
import { toSnakeCase } from '../utils/naming.js';
import { writeFiles } from './writer.js';
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
    apiSurface?: ApiSurface;
    overlayLookup?: OverlayLookup;
  },
): Promise<{ generated: GeneratedFile[]; deleted: string[]; diff: ReturnType<typeof diffSpecs> }> {
  const diff = diffSpecs(oldSpec, newSpec);

  if (diff.changes.length === 0) {
    return { generated: [], deleted: [], diff };
  }

  const ctx: EmitterContext = {
    namespace: toSnakeCase(options.namespace),
    namespacePascal: options.namespace,
    spec: newSpec,
    outputDir: options.outputDir,
    apiSurface: options.apiSurface,
    overlayLookup: options.overlayLookup,
    irVersion: IR_VERSION,
  };

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
    await writeFiles(generated, options.outputDir, {
      language: emitter.language,
      header,
    });

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
