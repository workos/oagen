import type {
  ApiSpec,
  ExternalDocs,
  Field,
  Operation,
  PaginationMeta,
  Parameter,
  ParameterGroup,
  ResponseHeader,
} from '../ir/types.js';

/**
 * Walk every documentation field in the IR and expand relative URL paths
 * (e.g. `/reference/users/user`) into full URLs using the given base.
 *
 * Matches markdown-style links: `[text](/path)` → `[text](https://example.com/path)`
 * and bare parenthetical refs: `(/path)` → `(https://example.com/path)`
 *
 * Two kinds of text are walked, each by one rule: a node's prose — its
 * `description`, and on an operation also `summary`, `responseDescription`
 * and `pagination.dataDescription` — and the `description` of a node's
 * `externalDocs`, whose `url` is left exactly as written (OpenAPI allows it
 * to be relative to the document's own location, which is not the doc site).
 * The nodes are every one that carries them — the spec, its services,
 * operations, parameters, response headers, models, fields, enums and enum
 * values — reached through every collection that holds them: each parameter
 * list, the mutually exclusive parameter groups, the headers of the primary,
 * of each alternate success and of each error response, and the list
 * envelope's companion fields. A key a node does not have stays absent.
 *
 * The IR shares some nodes by identity: a grouped parameter is the same
 * object in `queryParams` and in its `parameterGroups` variant, and the
 * primary response's header list is the same array as its `successResponses`
 * entry. Each node and list is therefore expanded once and that copy reused
 * wherever the input is shared, so the result shares exactly what the input
 * shared.
 */
export function expandDocUrls(spec: ApiSpec, docUrl: string): ApiSpec {
  // Normalize: strip trailing slash so joins are clean
  const base = docUrl.replace(/\/+$/, '');

  function expand(text: string | undefined): string | undefined {
    if (!text) return text;
    // Match markdown links and bare parenthetical paths with a leading slash
    return text.replace(/\(\/([^)]*)\)/g, `(${base}/$1)`);
  }

  /**
   * `{ [key]: expanded }` when `node` has the key — present-but-undefined
   * included — and `{}` otherwise, so spreading it leaves the key's presence
   * exactly as the parser set it.
   */
  function expandText<K extends string>(node: { [P in K]?: string }, key: K): { [P in K]?: string } {
    return key in node ? ({ [key]: expand(node[key]) } as { [P in K]?: string }) : {};
  }

  // `externalDocs.description` is CommonMark like every other description, so
  // its relative links are expanded the same way. `url` is a link target, not
  // prose, and is kept verbatim. The key is only produced when the node has
  // one, so it stays absent otherwise.
  function expandExternalDocs(node: { externalDocs?: ExternalDocs }): { externalDocs?: ExternalDocs } {
    const docs = node.externalDocs;
    if (!docs) return {};
    const description = expand(docs.description);
    return { externalDocs: description === undefined ? docs : { ...docs, description } };
  }

  // One expanded copy per input node or list, reused wherever the input is
  // shared (see above). Keyed by identity; the map holds nothing else.
  const copies = new WeakMap<object, object>();
  function once<T extends object>(input: T, build: () => T): T {
    const copy = copies.get(input);
    if (copy) return copy as T;
    const built = build();
    copies.set(input, built);
    return built;
  }

  /** A parameter, field or response header: prose and link by the two rules above. */
  function documented<T extends { description?: string; externalDocs?: ExternalDocs }>(node: T): T {
    return once(node, () => ({ ...node, ...expandText(node, 'description'), ...expandExternalDocs(node) }));
  }
  const parameters = (list: Parameter[]): Parameter[] => once(list, () => list.map(documented));
  const fields = (list: Field[]): Field[] => once(list, () => list.map(documented));
  const headers = (list: ResponseHeader[]): ResponseHeader[] => once(list, () => list.map(documented));

  // A response's `description` and `headers` are optional keys, absent (not
  // undefined) when the document declares none; both stay absent.
  function response<T extends { description?: string; headers?: ResponseHeader[] }>(entry: T): T {
    return {
      ...entry,
      ...expandText(entry, 'description'),
      ...(entry.headers ? { headers: headers(entry.headers) } : {}),
    };
  }

  // A variant's parameters are the operation's own parameter objects, so
  // `documented` hands back the copies the parameter lists already hold.
  function parameterGroup(group: ParameterGroup): ParameterGroup {
    return {
      ...group,
      variants: group.variants.map((variant) => ({ ...variant, parameters: parameters(variant.parameters) })),
    };
  }

  function pagination(meta: PaginationMeta): PaginationMeta {
    return {
      ...meta,
      ...expandText(meta, 'dataDescription'),
      ...(meta.envelopeFields ? { envelopeFields: fields(meta.envelopeFields) } : {}),
    };
  }

  function operation(op: Operation): Operation {
    return {
      ...op,
      // `summary` and `responseDescription` are optional and absent (not
      // undefined) when the document declares none; `expandText` keeps that.
      ...expandText(op, 'summary'),
      ...expandText(op, 'description'),
      ...expandExternalDocs(op),
      ...expandText(op, 'responseDescription'),
      pathParams: parameters(op.pathParams),
      queryParams: parameters(op.queryParams),
      ...(op.bodyOwnedQueryParams ? { bodyOwnedQueryParams: parameters(op.bodyOwnedQueryParams) } : {}),
      headerParams: parameters(op.headerParams),
      ...(op.cookieParams ? { cookieParams: parameters(op.cookieParams) } : {}),
      ...(op.parameterGroups ? { parameterGroups: op.parameterGroups.map(parameterGroup) } : {}),
      // The same three header lists `collectResponseHeaders` walks, rebuilt
      // in place; a list shared between the primary response and its
      // `successResponses` entry is expanded once and stays shared.
      ...(op.responseHeaders ? { responseHeaders: headers(op.responseHeaders) } : {}),
      ...(op.successResponses ? { successResponses: op.successResponses.map(response) } : {}),
      errors: op.errors.map(response),
      // The `default` and range responses carry `description` and `headers`
      // exactly as a status entry does, and stay absent when undeclared.
      ...(op.defaultResponse ? { defaultResponse: response(op.defaultResponse) } : {}),
      ...(op.rangeResponses ? { rangeResponses: op.rangeResponses.map(response) } : {}),
      ...(op.pagination ? { pagination: pagination(op.pagination) } : {}),
    };
  }

  return {
    ...spec,
    ...expandText(spec, 'description'),
    ...expandExternalDocs(spec),
    services: spec.services.map((service) => ({
      ...service,
      ...expandText(service, 'description'),
      ...expandExternalDocs(service),
      operations: service.operations.map(operation),
    })),
    models: spec.models.map((model) => ({
      ...model,
      ...expandText(model, 'description'),
      ...expandExternalDocs(model),
      fields: fields(model.fields),
    })),
    enums: spec.enums.map((e) => ({
      ...e,
      ...expandExternalDocs(e),
      values: e.values.map((v) => ({ ...v, ...expandText(v, 'description') })),
    })),
  };
}
