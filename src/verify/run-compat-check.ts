import { getExtractor } from '../compat/extractor-registry.js';
import {
  diffSnapshots,
  specDerivedNames,
  specDerivedFieldPaths,
  specDerivedMethodPaths,
  specDerivedEnumValues,
  filterSurface,
} from '../compat/differ.js';
import { apiSurfaceToSnapshot } from '../compat/ir.js';
import type { LanguageId } from '../compat/ir.js';
import { getDefaultPolicy, mergePolicy } from '../compat/policy.js';
import type { CompatPolicyHints } from '../compat/policy.js';
import type { ApiSpec } from '../ir/types.js';
import type { ApiSurface } from '../compat/types.js';
import type { CompatCheckResult } from './types.js';

export async function runCompatCheck(
  baseline: ApiSurface,
  outputDir: string,
  lang: string,
  spec?: ApiSpec,
  policyOverrides?: Partial<CompatPolicyHints>,
): Promise<CompatCheckResult> {
  const extractor = getExtractor(lang);
  const candidate = await extractor.extract(outputDir);

  let scopedBaseline = baseline;
  let scopedToSpec = false;
  let scopedSymbolCount: number | undefined;
  if (spec) {
    const allowed = specDerivedNames(spec, extractor.hints);
    const fieldPaths = specDerivedFieldPaths(spec, extractor.hints);
    const methodPaths = specDerivedMethodPaths(spec);
    const enumVals = specDerivedEnumValues(spec);
    scopedBaseline = filterSurface(baseline, allowed, { fieldPaths, methodPaths, enumValues: enumVals });
    scopedToSpec = true;
    scopedSymbolCount =
      Object.keys(scopedBaseline.interfaces).length +
      Object.keys(scopedBaseline.classes).length +
      Object.keys(scopedBaseline.typeAliases).length +
      Object.keys(scopedBaseline.enums).length;
  }

  const baseSnap = apiSurfaceToSnapshot(scopedBaseline);
  const candSnap = apiSurfaceToSnapshot(candidate);

  const langId = lang as LanguageId;
  const policy = policyOverrides ? mergePolicy(getDefaultPolicy(langId), policyOverrides) : getDefaultPolicy(langId);

  const diff = diffSnapshots(baseSnap, candSnap, policy);
  const passed = diff.changes.every((c) => c.severity !== 'breaking');

  return { passed, diff, scopedToSpec, scopedSymbolCount };
}
