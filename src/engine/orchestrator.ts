import { IR_VERSION } from '../ir/types.js';
import type { ApiSpec } from '../ir/types.js';
import type { Emitter, EmitterContext, GeneratedFile } from './types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { toSnakeCase } from '../utils/naming.js';
import { writeFiles } from './writer.js';

export async function generate(
  spec: ApiSpec,
  emitter: Emitter,
  options: {
    namespace: string;
    dryRun?: boolean;
    outputDir: string;
    target?: string;
    apiSurface?: ApiSurface;
    overlayLookup?: OverlayLookup;
  },
): Promise<GeneratedFile[]> {
  const ctx: EmitterContext = {
    namespace: toSnakeCase(options.namespace),
    namespacePascal: options.namespace,
    spec,
    outputDir: options.outputDir,
    apiSurface: options.apiSurface,
    overlayLookup: options.overlayLookup,
    irVersion: IR_VERSION,
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
  const langPrefix = `${emitter.language}/`;
  const withHeaders = files.map((f) => ({
    ...f,
    path: `${langPrefix}${f.path}`,
    content: f.path.endsWith('.json') ? f.content : header + '\n\n' + f.content,
    skipIfExists: f.skipIfExists ?? false,
  }));

  if (options.dryRun) {
    if (options.target) {
      console.log(`\nTarget integration (${options.target}):`);
      for (const f of withHeaders) {
        console.log(`  ${f.path.replace(langPrefix, '')}`);
      }
    }
    return withHeaders;
  }

  const writeResult = await writeFiles(withHeaders, options.outputDir, {
    language: emitter.language,
    header,
  });

  if (writeResult.merged.length > 0) {
    console.log(`Merged into ${writeResult.merged.length} existing files (additive only)`);
  }

  // Target integration pass
  if (options.target) {
    const targetFiles = withHeaders.map((f) => ({
      ...f,
      path: f.path.replace(langPrefix, ''),
    }));

    const targetResult = await writeFiles(targetFiles, options.target, {
      language: emitter.language,
      header,
    });

    if (targetResult.written.length > 0) {
      console.log(`Target: created ${targetResult.written.length} new files`);
    }
    if (targetResult.merged.length > 0) {
      console.log(`Target: merged into ${targetResult.merged.length} existing files (additive only)`);
    }
    if (targetResult.skipped.length > 0) {
      console.log(`Target: skipped ${targetResult.skipped.length} files (no grammar or skipIfExists)`);
    }
  }

  return withHeaders;
}
