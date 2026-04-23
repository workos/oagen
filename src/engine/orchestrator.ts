import type { ApiSpec } from '../ir/types.js';
import type { OperationHint } from '../ir/operation-hints.js';
import type { Emitter, GeneratedFile } from './types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { writeFiles } from './writer.js';
import { generateFiles } from './generate-files.js';
import { integrateGeneratedFiles } from './integrate.js';
import { formatTargetFiles } from './formatter.js';
import { computeStalePaths, MANIFEST_FILENAME, pruneStaleFiles, readManifest, writeManifest } from './manifest.js';

export async function generate(
  spec: ApiSpec,
  emitter: Emitter,
  options: {
    namespace: string;
    dryRun?: boolean;
    outputDir: string;
    target?: string;
    apiSurface?: ApiSurface;
    overlayLookup?: OverlayLookup;
    operationHints?: Record<string, OperationHint>;
    mountRules?: Record<string, string>;
    /** When true, skip deletion of files recorded in the previous manifest but not in the current emission. */
    noPrune?: boolean;
  },
): Promise<GeneratedFile[]> {
  // Read the target's previous manifest up front so emitters can mark files
  // the prior run wrote as safe-to-overwrite (vs files a human hand-maintains).
  // Skipped when --no-prune is set so users opting out of lifecycle tracking
  // also opt out of overwrite-on-regen behavior.
  const targetManifestForCtx = options.target && !options.noPrune ? await readManifest(options.target) : null;
  const priorTargetManifestPaths = targetManifestForCtx ? new Set(targetManifestForCtx.files) : undefined;

  const { files: withHeaders, header } = generateFiles(spec, emitter, {
    ...options,
    priorTargetManifestPaths,
  });

  if (options.dryRun) {
    if (options.target) {
      console.log(`\nTarget integration (${options.target}):`);
      for (const f of withHeaders) {
        console.log(`  ${f.path}`);
      }
    }
    return withHeaders;
  }

  // Read previous manifest BEFORE writing so a manifest overwrite can't alter the diff.
  const outputPrevManifest = options.noPrune ? null : await readManifest(options.outputDir);

  const writeResult = await writeFiles(withHeaders, options.outputDir, {
    language: emitter.language,
    header,
  });

  if (writeResult.merged.length > 0) {
    console.log(`Merged into ${writeResult.merged.length} existing files (additive only)`);
  }
  if (writeResult.ignored.length > 0) {
    console.log(`Ignored ${writeResult.ignored.length} files (@oagen-ignore-file)`);
  }

  const outputEmittedPaths = withHeaders.map((f) => f.path);
  await applyManifestPrune({
    dir: options.outputDir,
    label: 'Output',
    prevManifest: outputPrevManifest,
    currentPaths: outputEmittedPaths,
    language: emitter.language,
    header,
    noPrune: options.noPrune,
  });

  // Format output files so the emitter's formatter runs even without --target.
  const allOutputFiles = [...writeResult.written, ...writeResult.merged];
  if (allOutputFiles.length > 0) {
    await formatTargetFiles(emitter, options.outputDir, allOutputFiles);
  }

  // Target integration pass
  if (options.target) {
    // Reuse the manifest we already read to build the emitter context.  This
    // is correct because nothing between the two reads writes the manifest.
    const targetPrevManifest = targetManifestForCtx;

    const targetResult = await integrateGeneratedFiles({
      files: withHeaders,
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

    await applyManifestPrune({
      dir: options.target,
      label: 'Target',
      prevManifest: targetPrevManifest,
      currentPaths: targetResult.emittedPaths,
      language: emitter.language,
      header,
      noPrune: options.noPrune,
    });

    // Run the emitter's formatter on all written/merged/identical files
    const allTargetFiles = [...targetResult.written, ...targetResult.merged, ...targetResult.identical];
    if (allTargetFiles.length > 0) {
      await formatTargetFiles(emitter, options.target, allTargetFiles);
    }
  }

  return withHeaders;
}

/**
 * Prune files recorded in the previous manifest but absent from the current emission,
 * then write the fresh manifest.  Safe on first adoption (no previous manifest).
 */
async function applyManifestPrune(opts: {
  dir: string;
  label: string;
  prevManifest: Awaited<ReturnType<typeof readManifest>>;
  currentPaths: string[];
  language: string;
  header: string;
  noPrune?: boolean;
}): Promise<void> {
  if (opts.noPrune) {
    // Still refresh the manifest so future runs with pruning enabled have a baseline.
    await writeManifest(opts.dir, { language: opts.language, files: opts.currentPaths });
    return;
  }

  if (!opts.prevManifest) {
    console.log(
      `${opts.label}: no ${MANIFEST_FILENAME} found — skipping prune (this baseline manifest will be written now).`,
    );
    await writeManifest(opts.dir, { language: opts.language, files: opts.currentPaths });
    return;
  }

  const stale = computeStalePaths(opts.prevManifest, opts.currentPaths);
  if (stale.length > 0) {
    const { pruned, preserved } = await pruneStaleFiles(opts.dir, stale, { header: opts.header });
    if (pruned.length > 0) {
      console.log(`${opts.label}: pruned ${pruned.length} stale file${pruned.length === 1 ? '' : 's'}`);
    }
    if (preserved.length > 0) {
      console.log(
        `${opts.label}: preserved ${preserved.length} file${preserved.length === 1 ? '' : 's'} in previous manifest but lacking the auto-generated header (possibly hand-edited).`,
      );
      for (const p of preserved) console.log(`  ${p}`);
    }
  }

  await writeManifest(opts.dir, { language: opts.language, files: opts.currentPaths });
}
