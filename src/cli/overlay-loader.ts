import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { buildOverlayLookup } from '../compat/overlay.js';
import type { ManifestEntry } from '../compat/overlay.js';
import type { ApiSurface, LanguageHints, OverlayLookup } from '../compat/types.js';
import type { ApiSpec } from '../ir/types.js';
import { nodeHints } from '../compat/language-hints.js';
import { getExtractor } from '../compat/extractor-registry.js';

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
  manifestPath?: string;
  outputDir: string;
  lang: string;
  spec?: ApiSpec;
}): OverlayContext {
  let raw: string;
  try {
    raw = readFileSync(opts.apiSurfacePath, 'utf-8');
  } catch {
    throw new Error(`API surface file not found: ${opts.apiSurfacePath}. Run \`oagen extract\` first.`);
  }
  let apiSurface: ApiSurface;
  try {
    apiSurface = JSON.parse(raw) as ApiSurface;
  } catch (err) {
    throw new Error(`Failed to parse API surface JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Load manifest: explicit flag, or auto-discover in output directory
  let manifest: ManifestEntry[] | undefined;
  const resolvedManifestPath = opts.manifestPath ?? path.join(opts.outputDir, 'smoke-manifest.json');
  if (opts.manifestPath || existsSync(resolvedManifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(resolvedManifestPath, 'utf-8'));
      if (Array.isArray(parsed)) {
        manifest = parsed as ManifestEntry[];
      } else if (typeof parsed === 'object' && parsed !== null) {
        // Convert object-format manifest { "METHOD /path": { sdkMethod, service } }
        // into ManifestEntry[] for buildOverlayLookup
        manifest = Object.entries(parsed).map(([httpKey, value]) => {
          const spaceIdx = httpKey.indexOf(' ');
          const httpMethod = httpKey.slice(0, spaceIdx);
          const httpPath = httpKey.slice(spaceIdx + 1);
          const v = value as { sdkMethod?: string; service?: string };
          return {
            operationId: '',
            sdkResourceProperty: v.service ?? '',
            sdkMethodName: v.sdkMethod ?? '',
            httpMethod,
            path: httpPath,
            pathParams: [],
            bodyFields: [],
            queryFields: [],
          };
        });
      }
    } catch {
      if (opts.manifestPath) {
        throw new Error(`Failed to read manifest: ${resolvedManifestPath}`);
      }
    }
  }

  let hints: LanguageHints = nodeHints;
  try {
    hints = getExtractor(opts.lang).hints;
  } catch {
    // no extractor registered — use nodeHints fallback
  }

  const overlayLookup = buildOverlayLookup(apiSurface, manifest, opts.spec, hints);
  return { apiSurface, overlayLookup };
}
