import type { ApiSpec, ExternalDocs } from '../ir/types.js';

/**
 * Walk all description fields in the IR and expand relative URL paths
 * (e.g. `/reference/users/user`) into full URLs using the given base.
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

  // A response's `description` is an optional key that is absent (not
  // undefined) when the document declares none; expand it in place and leave
  // an entry without one untouched so its shape is unchanged.
  function expandResponse<T extends { description?: string }>(response: T): T {
    return response.description ? { ...response, description: expand(response.description) } : response;
  }

  // `externalDocs.description` is CommonMark like every other description, so
  // its relative links are expanded the same way. `url` is a link target, not
  // prose: OpenAPI allows it to be relative to the document's own location,
  // which is not the doc site, so it is left exactly as written. The key is
  // only produced when the node has one, so it stays absent otherwise.
  function expandExternalDocs(node: { externalDocs?: ExternalDocs }): { externalDocs?: ExternalDocs } {
    const docs = node.externalDocs;
    if (!docs) return {};
    const description = expand(docs.description);
    return { externalDocs: description === undefined ? docs : { ...docs, description } };
  }

  return {
    ...spec,
    description: expand(spec.description),
    ...expandExternalDocs(spec),
    services: spec.services.map((service) => ({
      ...service,
      description: expand(service.description),
      ...expandExternalDocs(service),
      operations: service.operations.map((op) => ({
        ...op,
        // `summary` is optional and absent (not undefined) when the document
        // declares none; only expand it when present so the key stays absent.
        ...(op.summary ? { summary: expand(op.summary) } : {}),
        description: expand(op.description),
        ...expandExternalDocs(op),
        // Response descriptions follow the same rule as `summary`: expanded
        // when present, and the keys stay absent otherwise.
        ...(op.responseDescription ? { responseDescription: expand(op.responseDescription) } : {}),
        ...(op.successResponses ? { successResponses: op.successResponses.map(expandResponse) } : {}),
        errors: op.errors.map(expandResponse),
        pathParams: op.pathParams.map((p) => ({ ...p, description: expand(p.description) })),
        queryParams: op.queryParams.map((p) => ({ ...p, description: expand(p.description) })),
        bodyOwnedQueryParams: op.bodyOwnedQueryParams?.map((p) => ({ ...p, description: expand(p.description) })),
        headerParams: op.headerParams.map((p) => ({ ...p, description: expand(p.description) })),
      })),
    })),
    models: spec.models.map((model) => ({
      ...model,
      description: expand(model.description),
      ...expandExternalDocs(model),
      fields: model.fields.map((f) => ({ ...f, description: expand(f.description) })),
    })),
    enums: spec.enums.map((e) => ({
      ...e,
      ...expandExternalDocs(e),
      values: e.values.map((v) => ({ ...v, description: expand(v.description) })),
    })),
  };
}
