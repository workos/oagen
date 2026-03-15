import type { ApiSpec } from '../ir/types.js';
import type { Emitter, EmitterContext, GeneratedFile } from './types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { diffSpecs } from '../differ/diff.js';
import { mapChangesToFiles } from '../differ/file-map.js';
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
  };

  const affected = mapChangesToFiles(diff.changes, emitter, ctx);

  // Regenerate affected files from the new spec using full generation,
  // then filter to only the affected paths
  const allFiles = [
    ...emitter.generateModels(newSpec.models, ctx),
    ...emitter.generateEnums(newSpec.enums, ctx),
    ...emitter.generateResources(newSpec.services, ctx),
    ...emitter.generateClient(newSpec, ctx),
    ...emitter.generateErrors(ctx),
    ...emitter.generateConfig(ctx),
    ...emitter.generateTypeSignatures(newSpec, ctx),
    ...emitter.generateTests(newSpec, ctx),
    ...(emitter.generateManifest?.(newSpec, ctx) ?? []),
  ];

  const header = emitter.fileHeader();
  const affectedSet = new Set(affected.regenerate);
  const generated = allFiles
    .filter((f) => affectedSet.has(f.path))
    .map((f) => ({
      ...f,
      content: f.path.endsWith('.json') ? f.content : header + '\n\n' + f.content,
      skipIfExists: f.skipIfExists ?? false,
    }));

  if (!options.dryRun) {
    await writeFiles(generated, options.outputDir);

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
