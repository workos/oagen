import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { parseSpec } from '../parser/parse.js';
import { generate } from '../engine/orchestrator.js';
import { getEmitter } from '../engine/registry.js';
import { buildOverlayLookup } from '../compat/overlay.js';
import type { ManifestEntry } from '../compat/overlay.js';
import type { ApiSurface } from '../compat/types.js';

export async function generateCommand(opts: {
  spec: string;
  lang: string;
  output: string;
  namespace?: string;
  dryRun?: boolean;
  apiSurface?: string;
  manifest?: string;
  compatCheck?: boolean;
}): Promise<void> {
  const ir = await parseSpec(opts.spec);
  const emitter = getEmitter(opts.lang);
  const namespace = opts.namespace ?? ir.name;

  // Build overlay from API surface if provided and not disabled
  let apiSurface: ApiSurface | undefined;
  let overlayLookup;
  if (opts.apiSurface && opts.compatCheck !== false) {
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
    const manifestPath = opts.manifest ?? path.join(opts.output, 'smoke-manifest.json');
    if (opts.manifest || existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
      } catch {
        if (opts.manifest) {
          throw new Error(`Failed to read manifest: ${manifestPath}`);
        }
        // Auto-discovered manifest failed to parse — skip silently
      }
    }

    overlayLookup = buildOverlayLookup(apiSurface, manifest, ir);
  }

  const files = await generate(ir, emitter, {
    namespace,
    dryRun: opts.dryRun,
    outputDir: opts.output,
    apiSurface,
    overlayLookup,
  });

  if (opts.dryRun) {
    for (const f of files) {
      console.log(f.path);
    }
  } else {
    console.log(`Generated ${files.length} files in ${opts.output}`);
  }
}
