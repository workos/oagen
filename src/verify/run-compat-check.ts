import { getExtractor } from '../compat/extractor-registry.js';
import { diffSurfaces, specDerivedNames, specDerivedFieldPaths, filterSurface } from '../compat/differ.js';
import type { ApiSpec } from '../ir/types.js';
import type { ApiSurface } from '../compat/types.js';
import type { CompatCheckResult } from './types.js';

export async function runCompatCheck(
  baseline: ApiSurface,
  outputDir: string,
  lang: string,
  spec?: ApiSpec,
): Promise<CompatCheckResult> {
  const extractor = getExtractor(lang);
  const candidate = await extractor.extract(outputDir);

  let scopedBaseline = baseline;
  let scopedToSpec = false;
  let scopedSymbolCount: number | undefined;
  if (spec) {
    const allowed = specDerivedNames(spec, extractor.hints);
    const fieldPaths = specDerivedFieldPaths(spec, extractor.hints);
    scopedBaseline = filterSurface(baseline, allowed, fieldPaths);
    scopedToSpec = true;
    scopedSymbolCount =
      Object.keys(scopedBaseline.interfaces).length +
      Object.keys(scopedBaseline.classes).length +
      Object.keys(scopedBaseline.typeAliases).length +
      Object.keys(scopedBaseline.enums).length;
  }

  const diff = diffSurfaces(scopedBaseline, candidate, extractor.hints);
  const passed = diff.violations.every((v) => v.severity !== 'breaking');

  return { passed, diff, scopedToSpec, scopedSymbolCount };
}
