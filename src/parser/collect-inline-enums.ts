import type { Enum, Model, Operation, ResponseHeader, Service, TypeRef } from '../ir/types.js';
import { walkTypeRef, collectResponseBodyTypes, collectModelRefs } from '../ir/types.js';
import { collectInlineEnumFromRef } from './schemas.js';

/**
 * Promote the inline enums of every model's fields. Collision-aware like the
 * operation pass below: an inline enum whose name a component enum already
 * owns with other values (`GetReportResponse.status` beside a component
 * `GetReportResponseStatus`) is renamed before it is promoted, so the field
 * never points at the component's values; the same values share the name.
 */
export function collectInlineEnumsFromModels(models: Model[], enums: Enum[]): void {
  const enumNames = new Set(enums.map((e) => e.name));
  for (const model of models) {
    for (const field of model.fields) {
      collectDistinctEnums(field.type, undefined, enums, enumNames);
    }
  }
}

/**
 * Collect inline enum definitions from operation parameters (query, path, header)
 * list-envelope companion fields, response headers and secondary response
 * bodies, and promote them to top-level enums so emitters can generate typed
 * enum files.
 *
 * `models` lets the walk continue into the models a header or secondary body
 * references — the ones the parser materialized for them, never a component
 * (`componentNames`), whose enums the model pass owns — so an enum nested in
 * such a model gets the same collision-aware treatment as one at the top: a
 * name a component enum already owns with other values is renamed, not
 * silently given the component's values.
 */
export function collectInlineEnumsFromOperations(
  services: Service[],
  enums: Enum[],
  models: readonly Model[] = [],
  componentNames: ReadonlySet<string> = new Set(),
): void {
  const enumNames = new Set(enums.map((e) => e.name));
  const modelsByName = new Map(models.map((model) => [model.name, model]));
  // Each materialized model is visited once, under the first qualifier that reaches it.
  const visited = new Set<string>();
  const collectThroughModels = (type: TypeRef, qualifier: string | undefined): void => {
    collectDistinctEnums(type, qualifier, enums, enumNames);
    for (const name of collectModelRefs(type)) {
      if (visited.has(name) || componentNames.has(name)) continue;
      visited.add(name);
      const model = modelsByName.get(name);
      if (!model) continue;
      for (const field of model.fields) collectThroughModels(field.type, qualifier);
    }
  };
  for (const service of services) {
    for (const op of service.operations) {
      for (const param of [
        ...op.pathParams,
        ...op.queryParams,
        ...(op.bodyOwnedQueryParams ?? []),
        ...op.headerParams,
        ...(op.cookieParams ?? []),
      ]) {
        collectInlineEnumFromRef(param.type, enums, enumNames);
      }
      for (const field of op.pagination?.envelopeFields ?? []) {
        collectInlineEnumFromRef(field.type, enums, enumNames);
      }
      // Response headers are typed like parameters, so an inline enum declared
      // on one must reach `spec.enums` the same way or the IR would point at
      // an enum no emitter ever generates.
      for (const { headers, qualifier } of responseHeaderGroups(op)) {
        for (const header of headers) collectThroughModels(header.type, qualifier);
      }
      // A body declared only for a secondary media type (`text/plain` next to
      // `application/json`) is typed like a response body, so its inline enums
      // are promoted the same way. Its name is already operation-qualified; a
      // clash with a different value set falls back to a numeric suffix.
      for (const { type } of collectResponseBodyTypes(op)) {
        collectThroughModels(type, undefined);
      }
    }
  }
}

/**
 * Header lists to walk, each with the status-code qualifier that keeps a
 * colliding enum name apart. When `successResponses` exists the primary list
 * is the same array as its entry there, so the entries are walked with their
 * own codes instead of `responseHeaders`; a lone 2xx carries no status code
 * in the IR, so its headers get no qualifier.
 */
function responseHeaderGroups(op: Operation): Array<{ headers: ResponseHeader[]; qualifier?: string }> {
  const groups: Array<{ headers: ResponseHeader[]; qualifier?: string }> = [];
  if (op.successResponses) {
    for (const entry of op.successResponses) {
      if (entry.headers) groups.push({ headers: entry.headers, qualifier: String(entry.statusCode) });
    }
  } else if (op.responseHeaders) {
    groups.push({ headers: op.responseHeaders });
  }
  for (const error of op.errors) {
    if (error.headers) groups.push({ headers: error.headers, qualifier: String(error.statusCode) });
  }
  return groups;
}

/**
 * Promote the inline enums under `type` — a response header's, or a secondary
 * media type's body. A header enum is named from the service
 * and header name alone, so `X-Policy` allowing `fast`/`slow` on a 200 and
 * `retry`/`stop` on a 429 would share one name and whichever was collected
 * first would silently win; a request parameter named like the header
 * collides the same way. When the name is already taken by a different value
 * set, the ref is renamed to a distinct name before it is promoted.
 * A taken name with the same values is shared, as before.
 */
function collectDistinctEnums(
  type: TypeRef,
  qualifier: string | undefined,
  enums: Enum[],
  enumNames: Set<string>,
): void {
  walkTypeRef(type, {
    enum: (ref) => {
      if (!ref.values) return;
      const existing = enums.find((e) => e.name === ref.name);
      if (existing && !sameEnumValues(existing, ref.values)) {
        ref.name = distinctEnumName(ref.name, ref.values, qualifier, enums);
      }
      collectInlineEnumFromRef(ref, enums, enumNames);
    },
  });
}

/** Order-insensitive: a reordering of the same members is the same type. */
function sameEnumValues(existing: Enum, values: (string | number)[]): boolean {
  if (existing.values.length !== values.length) return false;
  const have = new Set(existing.values.map((v) => v.value));
  return values.every((v) => have.has(v));
}

/**
 * The first name not taken by a different value set: the base qualified by
 * the status code (`DocumentsXPolicy429`), then numeric suffixes
 * (`DocumentsXPolicy2`, `DocumentsXPolicy3`, ...). Deterministic for a given
 * spec, since it depends only on declaration order.
 */
function distinctEnumName(
  base: string,
  values: (string | number)[],
  qualifier: string | undefined,
  enums: Enum[],
): string {
  const isUsable = (name: string): boolean => {
    const taken = enums.find((e) => e.name === name);
    return !taken || sameEnumValues(taken, values);
  };
  if (qualifier && isUsable(`${base}${qualifier}`)) return `${base}${qualifier}`;
  let suffix = 2;
  while (!isUsable(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
}
