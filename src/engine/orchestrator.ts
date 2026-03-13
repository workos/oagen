import type { ApiSpec } from '../ir/types.js';
import type { Emitter, EmitterContext, GeneratedFile } from './types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { toSnakeCase } from '../utils/naming.js';
import { writeFiles } from './writer.js';

export async function generate(
  spec: ApiSpec,
  emitter: Emitter,
  options: { namespace: string; dryRun?: boolean; outputDir: string; apiSurface?: ApiSurface; overlayLookup?: OverlayLookup },
): Promise<GeneratedFile[]> {
  const ctx: EmitterContext = {
    namespace: toSnakeCase(options.namespace),
    namespacePascal: options.namespace,
    spec,
    outputDir: options.outputDir,
    apiSurface: options.apiSurface,
    overlayLookup: options.overlayLookup,
  };

  const files: GeneratedFile[] = [
    ...emitter.generateModels(spec.models, ctx),
    ...emitter.generateEnums(spec.enums, ctx),
    ...emitter.generateResources(spec.services, ctx),
    ...emitter.generateClient(spec, ctx),
    ...emitter.generateErrors(ctx),
    ...emitter.generateConfig(ctx),
    ...emitter.generateTypeSignatures(spec, ctx),
    ...emitter.generateTests(spec, ctx),
    ...(emitter.generateManifest?.(spec, ctx) ?? []),
  ];

  const header = emitter.fileHeader();
  const withHeaders = files.map((f) => ({
    ...f,
    content: f.path.endsWith('.json') ? f.content : header + '\n\n' + f.content,
    skipIfExists: f.skipIfExists ?? true,
  }));

  if (options.dryRun) {
    return withHeaders;
  }

  await writeFiles(withHeaders, options.outputDir);
  return withHeaders;
}
