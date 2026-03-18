import { parseSpec } from '../parser/parse.js';
import { generate } from '../engine/orchestrator.js';
import { getEmitter } from '../engine/registry.js';
import { loadOverlayContext } from './overlay-loader.js';
import { expandDocUrls } from '../utils/expand-doc-urls.js';

export async function generateCommand(opts: {
  spec: string;
  lang: string;
  output: string;
  target?: string;
  namespace?: string;
  dryRun?: boolean;
  apiSurface?: string;
  manifest?: string;
  compatCheck?: boolean;
  operationIdTransform?: (id: string) => string;
  docUrl?: string;
}): Promise<void> {
  let ir = await parseSpec(opts.spec, { operationIdTransform: opts.operationIdTransform });
  if (opts.docUrl) {
    ir = expandDocUrls(ir, opts.docUrl);
  }
  const emitter = getEmitter(opts.lang);
  const namespace = opts.namespace ?? ir.name;

  // Build overlay from API surface if provided and not disabled
  let apiSurface;
  let overlayLookup;
  if (opts.apiSurface && opts.compatCheck !== false) {
    const ctx = loadOverlayContext({
      apiSurfacePath: opts.apiSurface,
      manifestPath: opts.manifest,
      outputDir: opts.output,
      lang: opts.lang,
      spec: ir,
    });
    apiSurface = ctx.apiSurface;
    overlayLookup = ctx.overlayLookup;
  }

  const files = await generate(ir, emitter, {
    namespace,
    dryRun: opts.dryRun,
    outputDir: opts.output,
    target: opts.target,
    apiSurface,
    overlayLookup,
  });

  if (opts.dryRun) {
    for (const f of files) {
      console.log(f.path);
    }
  } else {
    console.log(`Generated ${files.length} files in ${opts.output}`);
    if (opts.target) {
      console.log(`Integrated into ${opts.target}`);
    }
  }
}
