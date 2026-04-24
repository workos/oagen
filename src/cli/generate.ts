import { parseSpec } from '../parser/parse.js';
import { generate } from '../engine/orchestrator.js';
import { getEmitter } from '../engine/registry.js';
import { loadOverlayContext } from './overlay-loader.js';
import { expandDocUrls } from '../utils/expand-doc-urls.js';
import type { OperationHint } from '../ir/operation-hints.js';

export async function generateCommand(opts: {
  spec: string;
  lang: string;
  output: string;
  target?: string;
  namespace?: string;
  dryRun?: boolean;
  apiSurface?: string;
  compatCheck?: boolean;
  /** From `--no-prune`. When false, manifest-driven stale-file pruning is skipped. */
  prune?: boolean;
  operationIdTransform?: (id: string) => string;
  schemaNameTransform?: (name: string) => string;
  docUrl?: string;
  operationHints?: Record<string, OperationHint>;
  mountRules?: Record<string, string>;
}): Promise<void> {
  let ir = await parseSpec(opts.spec, {
    operationIdTransform: opts.operationIdTransform,
    schemaNameTransform: opts.schemaNameTransform,
  });
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
    operationHints: opts.operationHints,
    mountRules: opts.mountRules,
    noPrune: opts.prune === false,
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
