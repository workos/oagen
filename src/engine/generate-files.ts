import { IR_VERSION } from '../ir/types.js';
import type { ApiSpec } from '../ir/types.js';
import type { Emitter, EmitterContext, GeneratedFile } from './types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { toSnakeCase } from '../utils/naming.js';

export function buildEmitterContext(
  spec: ApiSpec,
  options: {
    namespace: string;
    outputDir: string;
    apiSurface?: ApiSurface;
    overlayLookup?: OverlayLookup;
  },
): EmitterContext {
  return {
    namespace: toSnakeCase(options.namespace),
    namespacePascal: options.namespace,
    spec,
    outputDir: options.outputDir,
    apiSurface: options.apiSurface,
    overlayLookup: options.overlayLookup,
    irVersion: IR_VERSION,
  };
}

/** Collect all generated files from an emitter (no headers, no path prefixes). */
export function generateAllFiles(spec: ApiSpec, emitter: Emitter, ctx: EmitterContext): GeneratedFile[] {
  return [
    ...emitter.generateModels(spec.models, ctx),
    ...emitter.generateEnums(spec.enums, ctx),
    ...emitter.generateResources(spec.services, ctx),
    ...emitter.generateClient(spec, ctx),
    ...emitter.generateErrors(ctx),
    ...emitter.generateConfig(ctx),
    ...(emitter.generateTypeSignatures?.(spec, ctx) ?? []),
    ...emitter.generateTests(spec, ctx),
    ...(emitter.generateManifest?.(spec, ctx) ?? []),
  ];
}

/** Apply file header to generated files, respecting headerPlacement and JSON files. */
export function applyFileHeaders(files: GeneratedFile[], header: string): GeneratedFile[] {
  return files.map((f) => ({
    ...f,
    content: f.path.endsWith('.json') || f.headerPlacement === 'skip' ? f.content : header + '\n\n' + f.content,
    skipIfExists: f.skipIfExists ?? false,
  }));
}

export function generateFiles(
  spec: ApiSpec,
  emitter: Emitter,
  options: {
    namespace: string;
    outputDir: string;
    apiSurface?: ApiSurface;
    overlayLookup?: OverlayLookup;
  },
): { files: GeneratedFile[]; ctx: EmitterContext; header: string } {
  const ctx = buildEmitterContext(spec, options);
  const files = generateAllFiles(spec, emitter, ctx);
  const header = emitter.fileHeader();
  return { files: applyFileHeaders(files, header), ctx, header };
}
