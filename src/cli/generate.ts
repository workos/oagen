import { parseSpec, type OpenApiDocument } from '../parser/parse.js';
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
  /**
   * Post-mount service names to generate (from `--services`, a CSV string, or an
   * array via config). When set, only these services + their mount-siblings +
   * reachable shared models are emitted; the rest of the SDK tree is left intact.
   */
  services?: string | string[];
  operationIdTransform?: (id: string) => string;
  schemaNameTransform?: (name: string) => string;
  transformSpec?: (spec: OpenApiDocument) => OpenApiDocument;
  docUrl?: string;
  operationHints?: Record<string, OperationHint>;
  mountRules?: Record<string, string>;
  modelHints?: Record<string, string>;
  fieldHints?: Record<string, Record<string, string>>;
  emitterOptions?: Record<string, unknown>;
}): Promise<void> {
  let ir = await parseSpec(opts.spec, {
    operationIdTransform: opts.operationIdTransform,
    schemaNameTransform: opts.schemaNameTransform,
    transformSpec: opts.transformSpec,
    fieldHints: opts.fieldHints,
  });
  if (opts.docUrl) {
    ir = expandDocUrls(ir, opts.docUrl);
  }
  const emitter = getEmitter(opts.lang);
  const namespace = opts.namespace ?? ir.name;

  // Normalize the scoped-service selection. Accept a CSV string (CLI) or an
  // array (config); trim and drop empties so a blank `--services` is treated as
  // a full generation rather than "match nothing".
  const rawServices = Array.isArray(opts.services) ? opts.services : opts.services?.split(',');
  const services = rawServices?.map((s) => s.trim()).filter(Boolean);

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
    modelHints: opts.modelHints,
    emitterOptions: opts.emitterOptions,
    noPrune: opts.prune === false,
    services: services && services.length > 0 ? services : undefined,
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
