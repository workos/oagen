/**
 * Compat verification script.
 *
 * Extracts the generated output's API surface, diffs against a baseline,
 * and reports a preservation score with structured violations.
 *
 * Usage:
 *   npx tsx scripts/verify-compat.ts --surface api-surface.json --output ../workos-node --lang node
 *   npx tsx scripts/verify-compat.ts --surface api-surface.json --output ../workos-node --lang node --loop --spec openapi.yml
 */

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { getExtractor } from '../src/compat/extractor-registry.js';
import { diffSurfaces } from '../src/compat/differ.js';
import { buildOverlayLookup, patchOverlay } from '../src/compat/overlay.js';
import type { ManifestEntry } from '../src/compat/overlay.js';
import type { ApiSurface, DiffResult } from '../src/compat/types.js';
import { parseSpec } from '../src/parser/parse.js';
import { generate } from '../src/engine/orchestrator.js';
import { getEmitter } from '../src/engine/registry.js';
import { loadConfig } from '../src/cli/config-loader.js';
import { applyConfig } from '../src/cli/plugin-loader.js';

const config = await loadConfig();
if (config) applyConfig(config);

const { values } = parseArgs({
  options: {
    surface: { type: 'string' },
    output: { type: 'string' },
    lang: { type: 'string' },
    loop: { type: 'boolean', default: false },
    'max-retries': { type: 'string', default: '3' },
    spec: { type: 'string' },
    namespace: { type: 'string' },
  },
});

async function verify(baseline: ApiSurface, outputPath: string, lang: string): Promise<DiffResult> {
  const extractor = getExtractor(lang);
  const candidate = await extractor.extract(outputPath);
  return diffSurfaces(baseline, candidate);
}

function reportResult(diff: DiffResult): void {
  const pct = diff.preservationScore;
  const total = diff.totalBaselineSymbols;
  const kept = diff.preservedSymbols;

  console.log(`compat: ${pct}% (${kept}/${total} symbols preserved)`);
  if (diff.violations.length > 0) {
    for (const v of diff.violations) {
      console.log(`  [${v.category}] ${v.severity}: ${v.symbolPath} — ${v.message}`);
    }
  }
  if (diff.additions.length > 0) {
    console.log(`  + ${diff.additions.length} new symbols added`);
  }
}

async function regenerateWithOverlay(
  specPath: string,
  lang: string,
  outputDir: string,
  overlay: ReturnType<typeof buildOverlayLookup>,
  baseline: ApiSurface,
  namespace?: string,
): Promise<void> {
  const spec = await parseSpec(specPath);
  const emitter = getEmitter(lang);
  const ns = namespace ?? spec.name;
  await generate(spec, emitter, {
    namespace: ns,
    outputDir,
    apiSurface: baseline,
    overlayLookup: overlay,
  });
}

async function runOnce(): Promise<void> {
  if (!values.surface || !values.output || !values.lang) {
    console.error('error: --surface, --output, and --lang are required');
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(values.surface, 'utf-8')) as ApiSurface;
  const diff = await verify(baseline, values.output, values.lang);
  reportResult(diff);
  process.exit(diff.violations.length > 0 ? 1 : 0);
}

async function runLoop(): Promise<void> {
  if (!values.surface || !values.output || !values.lang) {
    console.error('error: --surface, --output, and --lang are required');
    process.exit(1);
  }
  if (!values.spec) {
    console.error('Loop mode requires --spec flag to re-generate');
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(values.surface, 'utf-8')) as ApiSurface;
  const maxRetries = parseInt(values['max-retries']!, 10);
  let overlay = buildOverlayLookup(baseline);
  let previousScore = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await regenerateWithOverlay(values.spec, values.lang, values.output, overlay, baseline, values.namespace);

    // Reload manifest if the emitter generated one — enables method-level overlay
    const manifestPath = path.join(values.output, 'smoke-manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
        overlay = buildOverlayLookup(baseline, manifest);
      } catch {
        /* keep existing overlay */
      }
    }

    const diff = await verify(baseline, values.output, values.lang);

    if (diff.violations.length === 0) {
      reportResult(diff);
      return; // exit 0
    }

    if (attempt === maxRetries) {
      console.log(`compat: ${diff.preservationScore}% after ${maxRetries} retries — unfixable violations:`);
      reportResult(diff);
      process.exit(1);
    }

    // Report progress
    const delta = diff.preservationScore - previousScore;
    const arrow = delta > 0 ? '\u2191' : delta === 0 ? '\u2192' : '\u2193';
    console.log(
      `retry ${attempt + 1}/${maxRetries}: ${diff.preservationScore}% ${arrow} (${diff.violations.length} violations remaining)`,
    );
    previousScore = diff.preservationScore;

    // Stall detection: if score hasn't improved, stop early
    if (attempt > 0 && delta === 0) {
      console.log(`compat: stalled at ${diff.preservationScore}% — violations are unfixable by overlay`);
      reportResult(diff);
      process.exit(1);
    }

    // Patch overlay with violations and retry
    overlay = patchOverlay(overlay, diff.violations, baseline);
  }
}

async function main(): Promise<void> {
  if (values.loop) {
    await runLoop();
  } else {
    await runOnce();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
