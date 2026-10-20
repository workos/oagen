import type { Enum, Model, Operation, ResponseHeader, Service, TypeRef, Webhook } from '../ir/types.js';
import { walkTypeRef, collectWebhookTypeRefs } from '../ir/types.js';
import { collectInlineEnumFromRef } from './schemas.js';

export function collectInlineEnumsFromModels(models: Model[], enums: Enum[]): void {
  const enumNames = new Set(enums.map((e) => e.name));
  for (const model of models) {
    for (const field of model.fields) {
      collectInlineEnumFromRef(field.type, enums, enumNames);
    }
  }
}

/**
 * Collect inline enum definitions from operation parameters (query, path, header)
 * list-envelope companion fields, and response headers, and promote them to
 * top-level enums so emitters can generate typed enum files.
 */
export function collectInlineEnumsFromOperations(services: Service[], enums: Enum[]): void {
  const enumNames = new Set(enums.map((e) => e.name));
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
        for (const header of headers) collectDistinctEnums(header.type, qualifier, enums, enumNames);
      }
    }
  }
}

/**
 * Promote the inline enums a webhook declares — on its header, query and
 * cookie parameters, or as its payload itself — to top-level enums, the way
 * response-header enums are: a name already taken by a different value set
 * is not silently shared (the webhook's reference would otherwise point at
 * an unrelated enum's values) but renamed to a distinct one before it is
 * promoted (`PetAdoptedXSource2`); a taken name with the same values is
 * shared. The parser's stem reservation keeps such a clash from arising
 * through `parseSpec`; this guards the IR for any caller. A payload model's
 * field enums are reached through `spec.models` by
 * `collectInlineEnumsFromModels`, since the model is materialized there.
 */
export function collectInlineEnumsFromWebhooks(webhooks: Webhook[], enums: Enum[]): void {
  const enumNames = new Set(enums.map((e) => e.name));
  for (const webhook of webhooks) {
    for (const ref of collectWebhookTypeRefs(webhook)) collectDistinctEnums(ref, undefined, enums, enumNames);
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
 * Promote the inline enums under a type reference without letting a taken
 * name mislead. A response-header enum is named from the service and header
 * name alone, so `X-Policy` allowing `fast`/`slow` on a 200 and
 * `retry`/`stop` on a 429 would share one name and whichever was collected
 * first would silently win; a request parameter named like the header, or a
 * webhook parameter named like a component enum, collides the same way. When
 * the name is already taken by a different value set, the ref is renamed to
 * a distinct name before it is promoted. A taken name with the same values is
 * shared, as before.
 */
function collectDistinctEnums(
  ref: TypeRef,
  qualifier: string | undefined,
  enums: Enum[],
  enumNames: Set<string>,
): void {
  walkTypeRef(ref, {
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
