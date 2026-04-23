import { writeFileSync } from 'node:fs';
import { getExtractor } from '../compat/extractor-registry.js';

export async function compatExtractCommand(opts: {
  sdkPath: string;
  lang: string;
  output: string;
  sdkName?: string;
}): Promise<void> {
  const extractor = getExtractor(opts.lang);
  console.log(`Extracting ${opts.lang} compat snapshot from ${opts.sdkPath}...`);
  const snapshot = await extractor.extractSnapshot(opts.sdkPath);

  // Enrich with CLI-provided metadata
  if (opts.sdkName) {
    snapshot.sdkName = opts.sdkName;
  }

  writeFileSync(opts.output, JSON.stringify(snapshot, null, 2));
  console.log(`Extracted ${snapshot.symbols.length} symbols → ${opts.output}`);
}
