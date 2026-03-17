import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { parseSpec } from '../parser/parse.js';
import { diffSpecs } from '../differ/diff.js';
import { generateIncremental } from '../engine/incremental.js';
import { getEmitter } from '../engine/registry.js';
import { buildOverlayLookup } from '../compat/overlay.js';
import type { ManifestEntry } from '../compat/overlay.js';
import type { ApiSurface, LanguageHints } from '../compat/types.js';
import { nodeHints } from '../compat/language-hints.js';
import { getExtractor } from '../compat/extractor-registry.js';

export async function diffCommand(opts: {
  old: string;
  new: string;
  lang?: string;
  output?: string;
  report?: boolean;
  force?: boolean;
  apiSurface?: string;
  manifest?: string;
}): Promise<void> {
  const oldSpec = await parseSpec(opts.old);
  const newSpec = await parseSpec(opts.new);

  if (opts.report) {
    const diff = diffSpecs(oldSpec, newSpec);
    console.log(JSON.stringify(diff, null, 2));
    process.exit(
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
    console.error('--lang and --output are required for incremental generation');
    process.exit(1);
  }

  // Build overlay from API surface if provided
  let apiSurface: ApiSurface | undefined;
  let overlayLookup;
  if (opts.apiSurface) {
    let raw: string;
    try {
      raw = readFileSync(opts.apiSurface, 'utf-8');
    } catch {
      throw new Error(`API surface file not found: ${opts.apiSurface}. Run \`oagen extract\` first.`);
    }
    try {
      apiSurface = JSON.parse(raw) as ApiSurface;
    } catch (err) {
      throw new Error(`Failed to parse API surface JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Load manifest: explicit flag, or auto-discover in output directory
    let manifest: ManifestEntry[] | undefined;
    const manifestPath = opts.manifest ?? (opts.output ? path.join(opts.output, 'smoke-manifest.json') : undefined);
    if (manifestPath && (opts.manifest || existsSync(manifestPath))) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
      } catch {
        if (opts.manifest) {
          throw new Error(`Failed to read manifest: ${manifestPath}`);
        }
      }
    }

    let hints: LanguageHints = nodeHints;
    if (opts.lang) {
      try {
        hints = getExtractor(opts.lang).hints;
      } catch {
        // no extractor registered — use nodeHints fallback
      }
    }
    overlayLookup = buildOverlayLookup(apiSurface, manifest, undefined, hints);
  }

  const emitter = getEmitter(opts.lang);
  const result = await generateIncremental(oldSpec, newSpec, emitter, {
    namespace: newSpec.name,
    outputDir: opts.output,
    force: opts.force,
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
