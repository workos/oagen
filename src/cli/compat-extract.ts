import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getExtractor } from '../compat/extractor-registry.js';

const SNAPSHOT_FILENAME = '.oagen-compat-snapshot.json';

export async function compatExtractCommand(opts: { sdkPath: string; lang: string; output: string }): Promise<void> {
  const extractor = getExtractor(opts.lang);
  console.log(`Extracting ${opts.lang} compat snapshot from ${opts.sdkPath}...`);
  const snapshot = await extractor.extractSnapshot(opts.sdkPath);

  const outputPath = resolve(opts.output, SNAPSHOT_FILENAME);
  writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));
  console.log(`Extracted ${snapshot.symbols.length} symbols → ${outputPath}`);
}
