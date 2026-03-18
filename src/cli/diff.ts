import { parseSpec } from '../parser/parse.js';
import { diffSpecs } from '../differ/diff.js';
import { generateIncremental } from '../engine/incremental.js';
import { getEmitter } from '../engine/registry.js';
import { loadOverlayContext } from './overlay-loader.js';
import { CommandError } from '../errors.js';
import { expandDocUrls } from '../utils/expand-doc-urls.js';

export async function diffCommand(opts: {
  old: string;
  new: string;
  lang?: string;
  output?: string;
  report?: boolean;
  force?: boolean;
  target?: string;
  apiSurface?: string;
  manifest?: string;
  operationIdTransform?: (id: string) => string;
  docUrl?: string;
}): Promise<void> {
  const parseOptions = { operationIdTransform: opts.operationIdTransform };
  let oldSpec = await parseSpec(opts.old, parseOptions);
  let newSpec = await parseSpec(opts.new, parseOptions);
  if (opts.docUrl) {
    oldSpec = expandDocUrls(oldSpec, opts.docUrl);
    newSpec = expandDocUrls(newSpec, opts.docUrl);
  }

  if (opts.report) {
    const diff = diffSpecs(oldSpec, newSpec);
    console.log(JSON.stringify(diff, null, 2));
    throw new CommandError(
      '',
      '',
      diff.summary.breaking > 0
        ? 2
        : diff.summary.modified > 0 || diff.summary.removed > 0
          ? 1
          : diff.summary.added > 0
            ? 1
            : 0,
    );
  }

  if (!opts.lang || !opts.output) {
    throw new CommandError('--lang and --output are required for incremental generation', '', 1);
  }

  // Build overlay from API surface if provided
  let apiSurface;
  let overlayLookup;
  if (opts.apiSurface) {
    const ctx = loadOverlayContext({
      apiSurfacePath: opts.apiSurface,
      manifestPath: opts.manifest,
      outputDir: opts.output,
      lang: opts.lang,
    });
    apiSurface = ctx.apiSurface;
    overlayLookup = ctx.overlayLookup;
  }

  const emitter = getEmitter(opts.lang);
  const result = await generateIncremental(oldSpec, newSpec, emitter, {
    namespace: newSpec.name,
    outputDir: opts.output,
    force: opts.force,
    target: opts.target,
    apiSurface,
    overlayLookup,
  });

  if (result.diff.changes.length === 0) {
    console.log('No changes detected');
  } else {
    console.log(`Regenerated ${result.generated.length} files`);
    if (result.deleted.length > 0) {
      console.log(`Deleted ${result.deleted.length} files`);
    }
    if (!opts.force && result.diff.changes.some((c) => c.kind.endsWith('-removed'))) {
      console.log('Use --force to delete files for removed schemas');
    }
  }
}
