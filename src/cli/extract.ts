import { writeFileSync } from 'node:fs';
import { getExtractor } from '../compat/extractor-registry.js';

export async function extractCommand(opts: { sdkPath: string; lang: string; output: string }): Promise<void> {
  const extractor = getExtractor(opts.lang);
  console.log(`Extracting ${opts.lang} API surface from ${opts.sdkPath}...`);
  const surface = await extractor.extract(opts.sdkPath);
  writeFileSync(opts.output, JSON.stringify(surface, null, 2));
  const symbolCount =
    Object.keys(surface.classes).length +
    Object.keys(surface.interfaces).length +
    Object.keys(surface.typeAliases).length +
    Object.keys(surface.enums).length;
  console.log(`Extracted ${symbolCount} symbols → ${opts.output}`);
}
