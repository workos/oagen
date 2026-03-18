import { buildOverlayLookup, patchOverlay } from '../compat/overlay.js';
import type { ApiSurface, ViolationCategory } from '../compat/types.js';
import type { ApiSpec } from '../ir/types.js';
import { getEmitter } from '../engine/registry.js';
import { generate } from '../engine/orchestrator.js';
import { runCompatCheck } from './run-compat-check.js';
import type { OverlayRetryResult } from './types.js';

const PATCHABLE_CATEGORIES: Set<ViolationCategory> = new Set(['public-api', 'export-structure']);

export async function runOverlayRetryLoop(opts: {
  baseline: ApiSurface;
  parsedSpec: ApiSpec;
  outputDir: string;
  lang: string;
  maxRetries: number;
  onRetry?: (attemptNumber: number, maxRetries: number, patchableCount: number) => void;
}): Promise<OverlayRetryResult> {
  const { baseline, parsedSpec, outputDir, lang, maxRetries, onRetry } = opts;

  let overlay = buildOverlayLookup(baseline, undefined, parsedSpec);
  let prevScore = -1;
  const patchedPerIteration: number[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const compatResult = await runCompatCheck(baseline, outputDir, lang, parsedSpec);
    if (compatResult.passed) {
      return {
        status: 'passed',
        attempts: attempt,
        patchedPerIteration,
        compatResult,
      };
    }

    if (attempt === maxRetries) {
      return {
        status: 'max-retries',
        attempts: attempt,
        patchedPerIteration,
        compatResult,
      };
    }

    const patchable = compatResult.diff.violations.filter((v) => PATCHABLE_CATEGORIES.has(v.category));
    if (patchable.length === 0) {
      return {
        status: 'no-patchable',
        attempts: attempt,
        patchedPerIteration,
        compatResult,
      };
    }

    const currentScore = compatResult.diff.preservationScore;
    if (attempt > 0 && currentScore <= prevScore) {
      return {
        status: 'stalled',
        attempts: attempt,
        patchedPerIteration,
        compatResult,
      };
    }
    prevScore = currentScore;
    patchedPerIteration.push(patchable.length);
    onRetry?.(attempt + 1, maxRetries, patchable.length);

    overlay = patchOverlay(overlay, patchable, baseline);

    const emitter = getEmitter(lang);
    await generate(parsedSpec, emitter, {
      namespace: parsedSpec.name,
      outputDir,
      overlayLookup: overlay,
      apiSurface: baseline,
    });
  }

  const compatResult = await runCompatCheck(baseline, outputDir, lang, parsedSpec);
  return {
    status: 'max-retries',
    attempts: maxRetries,
    patchedPerIteration,
    compatResult,
  };
}
