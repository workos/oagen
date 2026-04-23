import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getExtractor } from '../compat/extractor-registry.js';
import { parseSpec } from '../parser/parse.js';
import type { CompatSnapshot } from '../compat/ir.js';
import type { ApiSpec } from '../ir/types.js';

const SNAPSHOT_FILENAME = '.oagen-compat-snapshot.json';

export async function compatExtractCommand(opts: {
  sdkPath: string;
  lang: string;
  output: string;
  spec?: string;
}): Promise<void> {
  const extractor = getExtractor(opts.lang);
  console.log(`Extracting ${opts.lang} compat snapshot from ${opts.sdkPath}...`);
  const snapshot = await extractor.extractSnapshot(opts.sdkPath);

  // Enrich with spec context if provided
  if (opts.spec) {
    const specContent = readFileSync(opts.spec, 'utf-8');
    snapshot.source.specSha = createHash('sha256').update(specContent).digest('hex');

    const parsedSpec = await parseSpec(opts.spec);
    enrichWithSpecContext(snapshot, parsedSpec);
  }

  const outputPath = resolve(opts.output, SNAPSHOT_FILENAME);
  writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));
  console.log(`Extracted ${snapshot.symbols.length} symbols → ${outputPath}`);
}

/**
 * Enrich snapshot symbols with operationId and route from the parsed spec.
 *
 * Matches callable symbols to spec operations by comparing method names
 * derived from the spec against the symbol's fqName.
 */
function enrichWithSpecContext(snapshot: CompatSnapshot, spec: ApiSpec): void {
  // Build lookup: "ServiceName.methodName" → { operationId, method, path }
  const opLookup = new Map<string, { operationId: string; method: string; path: string }>();
  for (const service of spec.services) {
    for (const op of service.operations) {
      // The symbol fqName is "ClassName.methodName" — match against service + operation name
      const key = `${service.name}.${op.name}`;
      opLookup.set(key, {
        operationId: op.name,
        method: op.httpMethod,
        path: op.path,
      });
    }
  }

  for (const sym of snapshot.symbols) {
    if (sym.kind !== 'callable') continue;
    const match = opLookup.get(sym.fqName);
    if (match) {
      sym.operationId = match.operationId;
      sym.route = { method: match.method, path: match.path };
    }
  }
}
