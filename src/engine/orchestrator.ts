import type { ApiSpec } from '../ir/types.js';
import type { Emitter, GeneratedFile } from './types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { writeFiles } from './writer.js';
import { generateFiles } from './generate-files.js';
import { integrateGeneratedFiles } from './integrate.js';

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
  const { files: withHeaders, header } = generateFiles(spec, emitter, options);

  if (options.dryRun) {
    if (options.target) {
      console.log(`\nTarget integration (${options.target}):`);
      for (const f of withHeaders) {
        console.log(`  ${f.path}`);
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
    const targetResult = await integrateGeneratedFiles({
      files: withHeaders,
      language: emitter.language,
      targetDir: options.target,
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
