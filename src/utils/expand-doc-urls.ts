import type { ApiSpec } from '../ir/types.js';

/**
 * Walk all description fields in the IR and expand relative URL paths
 * (e.g. `/reference/authkit/user`) into full URLs using the given base.
 *
 * Matches markdown-style links: `[text](/path)` → `[text](https://example.com/path)`
 * and bare parenthetical refs: `(/path)` → `(https://example.com/path)`
 */
export function expandDocUrls(spec: ApiSpec, docUrl: string): ApiSpec {
  // Normalize: strip trailing slash so joins are clean
  const base = docUrl.replace(/\/+$/, '');

  function expand(description: string | undefined): string | undefined {
    if (!description) return description;
    // Match markdown links and bare parenthetical paths with a leading slash
    return description.replace(/\(\/([^)]*)\)/g, `(${base}/$1)`);
  }

  return {
    ...spec,
    description: expand(spec.description),
    services: spec.services.map((service) => ({
      ...service,
      description: expand(service.description),
      operations: service.operations.map((op) => ({
        ...op,
        description: expand(op.description),
        pathParams: op.pathParams.map((p) => ({ ...p, description: expand(p.description) })),
        queryParams: op.queryParams.map((p) => ({ ...p, description: expand(p.description) })),
        headerParams: op.headerParams.map((p) => ({ ...p, description: expand(p.description) })),
      })),
    })),
    models: spec.models.map((model) => ({
      ...model,
      description: expand(model.description),
      fields: model.fields.map((f) => ({ ...f, description: expand(f.description) })),
    })),
    enums: spec.enums.map((e) => ({
      ...e,
      values: e.values.map((v) => ({ ...v, description: expand(v.description) })),
    })),
  };
}
