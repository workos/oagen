import { getExtractor } from '../compat/extractor-registry.js';
import { detectStaleSymbols } from '../compat/staleness.js';
import type { ApiSpec } from '../ir/types.js';
import type { OperationResolution } from '../ir/operation-hints.js';
import type { ApiSurface } from '../compat/types.js';
import type { StalenessCheckResult } from './types.js';

/**
 * Find the symbols of `baseline` the old spec derived and the new spec no
 * longer does (`detectStaleSymbols`), both read as `generate` writes them
 * under the `resolution`'s `mountRules`, `operationHints` and
 * `operationNaming`, so a remounted service and its methods are found stale
 * on the class `generate` wrote them to.
 */
export function runStalenessCheck(
  baseline: ApiSurface,
  oldSpec: ApiSpec,
  newSpec: ApiSpec,
  lang: string,
  resolution?: OperationResolution,
): StalenessCheckResult {
  const extractor = getExtractor(lang);
  const violations = detectStaleSymbols(baseline, oldSpec, newSpec, extractor.hints, resolution);
  return { violations };
}
