import { getExtractor } from '../compat/extractor-registry.js';
import { detectStaleSymbols } from '../compat/staleness.js';
import type { ApiSpec } from '../ir/types.js';
import type { ApiSurface } from '../compat/types.js';
import type { StalenessCheckResult } from './types.js';

export function runStalenessCheck(
  baseline: ApiSurface,
  oldSpec: ApiSpec,
  newSpec: ApiSpec,
  lang: string,
): StalenessCheckResult {
  const extractor = getExtractor(lang);
  const violations = detectStaleSymbols(baseline, oldSpec, newSpec, extractor.hints);
  return { violations };
}
