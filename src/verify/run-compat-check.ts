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
import type { OperationResolution } from '../ir/operation-hints.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { buildOverlayLookup } from '../compat/overlay.js';
import { readManifestSync } from '../engine/manifest-reader.js';
import type { CompatCheckResult } from './types.js';

/**
 * The overlay `generate --api-surface` writes the SDK in `outputDir` with:
 * the baseline's own names for the operations the `.oagen-manifest.json`
 * there maps (`buildOverlayLookup`), and nothing without a manifest. The
 * compat scope and the staleness check read it, so a baseline method the
 * overlay keeps (`Animals.fetchAll` for `GET /pets`) stays in scope under
 * the name `generate` wrote.
 */
export function manifestOverlay(baseline: ApiSurface, outputDir: string, spec: ApiSpec, lang: string): OverlayLookup {
  return buildOverlayLookup(baseline, readManifestSync(outputDir), spec, getExtractor(lang).hints);
}

/**
 * Extract the generated SDK in `outputDir` and diff it against `baseline`.
 *
 * With a `spec`, the baseline is scoped to the symbols the spec derives
 * (`specDerivedNames`, `specDerivedMethodPaths`, `filterSurface`), read as
 * `generate` writes them under the `resolution`'s `mountRules`,
 * `operationHints` and `operationNaming` — the settings `generate` resolved
 * the SDK's operations with. Under `mountRules: { Pets: 'Animals' }` the
 * `Animals` class is in scope with the methods its operations resolve to, so
 * a method the SDK lost from it is reported removed; read from the IR as
 * parsed, `Animals` was no name the spec derived and the loss passed. With
 * the `overlay` `generate --api-surface` writes with (see
 * {@link manifestOverlay}; the retry loop passes the one it patches), a
 * baseline method the overlay maps to one of the spec's operations stays in
 * scope under its own name, so an SDK that renamed `Animals.fetchAll` is
 * reported and the retry can restore it.
 */
export async function runCompatCheck(
  baseline: ApiSurface,
  outputDir: string,
  lang: string,
  spec?: ApiSpec,
  policyOverrides?: Partial<CompatPolicyHints>,
  resolution?: OperationResolution,
  overlay?: Pick<OverlayLookup, 'methodByOperation'>,
): Promise<CompatCheckResult> {
  const extractor = getExtractor(lang);
  const candidate = await extractor.extract(outputDir);

  let scopedBaseline = baseline;
  let scopedToSpec = false;
  let scopedSymbolCount: number | undefined;
  if (spec) {
    const allowed = specDerivedNames(spec, extractor.hints, resolution);
    const fieldPaths = specDerivedFieldPaths(spec, extractor.hints);
    const methodPaths = specDerivedMethodPaths(spec, resolution, overlay);
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
