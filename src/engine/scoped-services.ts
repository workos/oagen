import type { ApiSpec } from '../ir/types.js';

/**
 * Validate a `--services` selection and return it as a set of POST-MOUNT service
 * names for emitters to scope on.
 *
 * Scoped generation does NOT filter the IR: model placement, dedup/aliasing, and
 * shared-schema decisions are global computations over the full service/model set
 * (filtering them churns shared `common/` files). Instead the full spec flows to
 * the emitters unchanged and this set is passed as `ctx.scopedServices`; each
 * emitter gates only its per-service resource/test emission on it.
 *
 * Matching is on the POST-MOUNT name. Mount resolution never mutates
 * `spec.services` — the post-mount target lives on `ResolvedOperation.mountOn`
 * (`mountOn = hint?.mountOn ?? mountRules[service.name] ?? service.name`) — so the
 * post-mount name of a source service is derived here as
 * `mountRules[service.name] ?? service.name`. Selecting a target (e.g.
 * `DirectorySync`) is valid because every source tag that mounts into it
 * (`DirectoryUsers`, `DirectoryGroups`, …) shares that post-mount name, and the
 * emitters group resources by mount, so all siblings emit together.
 *
 * @param spec - The parsed API spec (never mutated; never filtered).
 * @param selected - Post-mount service names from `--services` (normalized/trimmed).
 * @param mountRules - Source-service-name → post-mount-target mappings.
 * @returns The validated selection as a `Set` of post-mount names.
 * @throws A `ConfigError` listing valid post-mount names when a selection is
 *   unknown — scoped generation never silently emits the wrong set.
 */
/**
 * Canonicalize a service name to a casing/separator-insensitive key so that
 * `MultiFactorAuth` (post-mount IR name), `multi_factor_auth` (snake-cased
 * manifest record), and `multiFactorAuth` (camel-cased manifest record) all
 * collapse to `multifactorauth`. Used to match a spec service against the
 * services a prior manifest recorded as already on disk, where the casing of
 * the recorded `service` field varies per emitter.
 */
export function canonicalServiceKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function resolveScopedServices(
  spec: ApiSpec,
  selected: string[],
  mountRules?: Record<string, string>,
): Set<string> {
  const mounts = mountRules ?? {};
  const postMountName = (name: string): string => mounts[name] ?? name;
  const validPostMount = new Set(spec.services.map((s) => postMountName(s.name)));
  const selectedSet = new Set(selected);

  const unknown = [...selectedSet].filter((s) => !validPostMount.has(s));
  if (unknown.length > 0) {
    const err = new Error(
      `Unknown --services: ${unknown.sort().join(', ')}. ` +
        `Valid post-mount services: ${[...validPostMount].sort().join(', ')}`,
    );
    err.name = 'ConfigError';
    throw err;
  }

  return selectedSet;
}
