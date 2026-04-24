import { readFileSync } from 'node:fs';
import { ConfigError } from '../errors.js';
import { buildOverlayLookup } from '../compat/overlay.js';
import type { ApiSurface, LanguageHints, OverlayLookup } from '../compat/types.js';
import type { ApiSpec } from '../ir/types.js';
import { nodeHints } from '../compat/language-hints.js';
import { getExtractor } from '../compat/extractor-registry.js';
import { readManifestSync } from '../engine/manifest-reader.js';

export interface OverlayContext {
  apiSurface: ApiSurface;
  overlayLookup: OverlayLookup;
}

/**
 * Load an API surface from disk, discover/load the manifest, resolve
 * language hints, and build the overlay lookup. Shared by diff and generate.
 */
export function loadOverlayContext(opts: {
  apiSurfacePath: string;
  outputDir: string;
  lang: string;
  spec?: ApiSpec;
}): OverlayContext {
  let raw: string;
  try {
    raw = readFileSync(opts.apiSurfacePath, 'utf-8');
  } catch {
    throw new ConfigError(
      `API surface file not found: ${opts.apiSurfacePath}. Run \`oagen extract\` first.`,
      `Generate the API surface file by running \`oagen extract --lang ${opts.lang} --sdk-path <path-to-sdk>\` before running this command.`,
    );
  }
  let apiSurface: ApiSurface;
  try {
    apiSurface = JSON.parse(raw) as ApiSurface;
  } catch (err) {
    throw new ConfigError(
      `Failed to parse API surface JSON: ${err instanceof Error ? err.message : String(err)}`,
      `Ensure "${opts.apiSurfacePath}" contains valid JSON. Re-run \`oagen extract\` to regenerate it.`,
    );
  }

  // Load operations from .oagen-manifest.json in output directory
  const manifest = readManifestSync(opts.outputDir);

  let hints: LanguageHints = nodeHints;
  try {
    hints = getExtractor(opts.lang).hints;
  } catch {
    // no extractor registered — use nodeHints fallback
  }

  const overlayLookup = buildOverlayLookup(apiSurface, manifest, opts.spec, hints);
  return { apiSurface, overlayLookup };
}
