import { readFileSync } from 'node:fs';
import { parseSpec } from '../parser/parse.js';
import { generate } from '../engine/orchestrator.js';
import { getEmitter, registerEmitter } from '../engine/registry.js';
import { rubyEmitter } from '../emitters/ruby/index.js';
import { nodeEmitter } from '../emitters/node/index.js';
import { buildOverlayLookup } from '../compat/overlay.js';
import type { ApiSurface } from '../compat/types.js';

// Register built-in emitters
registerEmitter(rubyEmitter);
registerEmitter(nodeEmitter);

export async function generateCommand(opts: {
  spec: string;
  lang: string;
  output: string;
  namespace?: string;
  dryRun?: boolean;
  apiSurface?: string;
  compatCheck?: boolean;
}): Promise<void> {
  try {
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
        throw new Error(`API surface file not found: ${opts.apiSurface}. Run \`npm run compat:extract\` first.`);
      }
      try {
        apiSurface = JSON.parse(raw) as ApiSurface;
      } catch (err) {
        throw new Error(`Failed to parse api-surface.json: ${err instanceof Error ? err.message : String(err)}`);
      }
      overlayLookup = buildOverlayLookup(apiSurface);
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
