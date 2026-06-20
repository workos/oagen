import type { ApiSpec } from '../ir/types.js';
import type { OperationHint } from '../ir/operation-hints.js';
import type { Emitter, GeneratedFile } from './types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { writeFiles } from './writer.js';
import { generateFiles } from './generate-files.js';
import { resolveScopedServices } from './scoped-services.js';
import { integrateGeneratedFiles } from './integrate.js';
import { formatTargetFiles } from './formatter.js';
import {
  computeStalePaths,
  MANIFEST_FILENAME,
  mergeScopedManifestRecords,
  pruneStaleFiles,
  readManifest,
  writeManifest,
} from './manifest.js';

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
    modelHints?: Record<string, string>;
    emitterOptions?: Record<string, unknown>;
    /** When true, skip deletion of files recorded in the previous manifest but not in the current emission. */
    noPrune?: boolean;
    /**
     * Post-mount service names to generate (a `--services` run). When non-empty,
     * the FULL spec is still emitted for models/enums/client/barrels (so shared
     * files stay byte-identical and a brand-new selected service is wired into the
     * client automatically); only per-service resource/test emission is gated to
     * the selection (via `ctx.scopedServices`). Pruning is disabled and the
     * manifest is merged so unselected services' records survive.
     */
    services?: string[];
  },
): Promise<GeneratedFile[]> {
  // Scoped generation: validate + expand the selection to POST-MOUNT names. The
  // spec is NOT filtered — placement/dedup/shared-schemas are computed over the
  // full spec so shared files stay byte-identical; emitters gate only per-service
  // resource/test emission on this set.
  const scopedServices =
    options.services && options.services.length > 0
      ? resolveScopedServices(spec, options.services, options.mountRules)
      : undefined;
  const scoped = scopedServices !== undefined;
  // Scoped mode implies no-prune so unselected services' files survive (FR-1.7).
  const noPrune = options.noPrune === true || scoped;

  // Read previous manifests up front so emitters can mark files the prior run
  // wrote as safe-to-overwrite (vs files a human hand-maintains), and so scoped
  // runs can merge prior records. Skipped only when --no-prune is set on a
  // non-scoped run (opting out of lifecycle tracking). Scoped runs always read,
  // even though they force no-prune, because the merge needs the prior records.
  const skipManifestRead = options.noPrune === true && !scoped;
  const outputPrevManifestForCtx = skipManifestRead ? null : await readManifest(options.outputDir);
  const targetManifestForCtx = options.target && !skipManifestRead ? await readManifest(options.target) : null;
  const priorTargetManifestPaths = targetManifestForCtx
    ? new Set(targetManifestForCtx.files)
    : outputPrevManifestForCtx
      ? new Set(outputPrevManifestForCtx.files)
      : undefined;

  const {
    files: withHeaders,
    header,
    operations,
  } = generateFiles(spec, emitter, {
    ...options,
    priorTargetManifestPaths,
    scopedServices,
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

  // Reuse the manifest read before generation; nothing above writes it.
  const outputPrevManifest = outputPrevManifestForCtx;

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
    noPrune,
    operations,
    scoped,
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
      noPrune,
      operations,
      scoped,
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
  operations?: Record<string, unknown>;
  /** When true, union this scoped run's records with the prior manifest (FR-1.9). */
  scoped?: boolean;
}): Promise<void> {
  // A scoped run only emits the selected services' files, so the manifest is
  // merged with the prior records rather than replaced — otherwise unselected
  // services would be dropped from the manifest and mis-pruned on the next run.
  const records = opts.scoped
    ? mergeScopedManifestRecords(opts.prevManifest, opts.currentPaths, opts.operations)
    : { files: opts.currentPaths, operations: opts.operations };
  const manifestOpts = { language: opts.language, files: records.files, operations: records.operations };
  if (opts.noPrune) {
    // Still refresh the manifest so future runs with pruning enabled have a baseline.
    await writeManifest(opts.dir, manifestOpts);
    return;
  }

  if (!opts.prevManifest) {
    console.log(
      `${opts.label}: no ${MANIFEST_FILENAME} found — skipping prune (this baseline manifest will be written now).`,
    );
    await writeManifest(opts.dir, manifestOpts);
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

  await writeManifest(opts.dir, manifestOpts);
}
