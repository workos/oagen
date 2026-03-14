import { readFileSync } from 'node:fs';
import { parseSpec } from '../parser/parse.js';
import { diffSpecs } from '../differ/diff.js';
import { generateIncremental } from '../engine/incremental.js';
import { getEmitter, registerEmitter } from '../engine/registry.js';
import { rubyEmitter } from '../emitters/ruby/index.js';
import { nodeEmitter } from '../emitters/node/index.js';
import { buildOverlayLookup } from '../compat/overlay.js';
import type { ApiSurface } from '../compat/types.js';

registerEmitter(rubyEmitter);
registerEmitter(nodeEmitter);

export async function diffCommand(opts: {
  old: string;
  new: string;
  lang?: string;
  output?: string;
  report?: boolean;
  force?: boolean;
  apiSurface?: string;
}): Promise<void> {
  const oldSpec = await parseSpec(opts.old);
  const newSpec = await parseSpec(opts.new);

  if (opts.report) {
    const diff = diffSpecs(oldSpec, newSpec);
    console.log(JSON.stringify(diff, null, 2));
    process.exit(diff.summary.breaking > 0 ? 2 : diff.summary.added > 0 ? 1 : 0);
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
      throw new Error(`API surface file not found: ${opts.apiSurface}. Run \`npm run compat:extract\` first.`);
    }
    try {
      apiSurface = JSON.parse(raw) as ApiSurface;
    } catch (err) {
      throw new Error(`Failed to parse api-surface.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    overlayLookup = buildOverlayLookup(apiSurface);
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
