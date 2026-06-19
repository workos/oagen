import type { ApiSpec } from '../ir/types.js';
import { collectReferencedNames } from './generate-files.js';

/**
 * Restrict a parsed spec to a subset of post-mount services, keeping every
 * mount-sibling source service and the models/enums reachable from them.
 *
 * Matching is on the POST-MOUNT service name. Mount resolution does NOT mutate
 * `spec.services` (it produces a separate `ResolvedOperation[]` carrying
 * `mountOn`), so the post-mount name of a source service is derived here as
 * `mountRules[service.name] ?? service.name`. Selecting a target therefore keeps
 * every source service that mounts into it — sibling expansion is implicit, so a
 * resource file that bundles several source tags is always emitted whole.
 *
 * Shared/common models referenced by the selected services are retained via the
 * existing `collectReferencedNames` reachability walk so the scoped output still
 * compiles.
 *
 * @param spec - The parsed, unfiltered API spec.
 * @param selected - Post-mount service names to keep (already normalized/trimmed).
 * @param mountRules - Source-service-name → post-mount-target mappings.
 * @returns A new `ApiSpec` containing only the selected services and their
 *   reachable models/enums. The input spec is not mutated.
 * @throws A `ConfigError` when no service matches, listing the valid post-mount
 *   names — scoped generation never silently emits nothing.
 */
export function filterSpecByServices(spec: ApiSpec, selected: string[], mountRules?: Record<string, string>): ApiSpec {
  const selectedSet = new Set(selected);
  const mounts = mountRules ?? {};
  const postMountName = (name: string): string => mounts[name] ?? name;

  const services = spec.services.filter((s) => selectedSet.has(postMountName(s.name)));

  if (services.length === 0) {
    const valid = [...new Set(spec.services.map((s) => postMountName(s.name)))].sort();
    const err = new Error(
      `No services matched ${[...selectedSet].sort().join(', ')}. ` + `Valid post-mount services: ${valid.join(', ')}`,
    );
    err.name = 'ConfigError';
    throw err;
  }

  // `generateAllFiles` re-derives this same reachable set on the filtered spec,
  // so this walk is technically redundant — but it is idempotent and cheap, and
  // running it here keeps `filterSpecByServices` a self-contained pure transform
  // that returns a spec whose models/enums already match its services.
  const referenced = collectReferencedNames(services, spec.models);
  return {
    ...spec,
    services,
    models: spec.models.filter((m) => referenced.models.has(m.name)),
    enums: spec.enums.filter((e) => referenced.enums.has(e.name)),
  };
}
