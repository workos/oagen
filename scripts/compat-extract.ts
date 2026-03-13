/**
 * Compat surface extractor.
 *
 * Extracts the public API surface of an SDK into a canonical JSON format
 * that the differ can compare against a generated SDK's surface.
 *
 * Usage:
 *   tsx scripts/compat-extract.ts --sdk-path path/to/sdk --lang node --output api-surface.json
 */

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { registerExtractor, getExtractor } from '../src/compat/extractor-registry.js';
import { nodeExtractor } from '../src/compat/extractors/node.js';

registerExtractor(nodeExtractor);

async function main() {
  const { values } = parseArgs({
    options: {
      'sdk-path': { type: 'string' },
      lang: { type: 'string' },
      output: { type: 'string', default: 'api-surface.json' },
    },
  });

  if (!values['sdk-path']) throw new Error('--sdk-path is required');
  if (!values.lang) throw new Error('--lang is required');

  const extractor = getExtractor(values.lang);
  console.log(`Extracting ${values.lang} API surface from ${values['sdk-path']}...`);

  const surface = await extractor.extract(values['sdk-path']);
  writeFileSync(values.output!, JSON.stringify(surface, null, 2));

  const symbolCount =
    Object.keys(surface.classes).length +
    Object.keys(surface.interfaces).length +
    Object.keys(surface.typeAliases).length +
    Object.keys(surface.enums).length;

  console.log(`Extracted ${symbolCount} symbols`);
  console.log(`Written to ${values.output}`);
}

main().catch((err) => {
  console.error('Extraction failed:', err);
  process.exit(1);
});
