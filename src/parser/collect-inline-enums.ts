import type { Enum, Model, Operation, ResponseHeader, Service, TypeRef, Webhook } from '../ir/types.js';
import { walkTypeRef, collectResponseBodyTypes, collectModelRefs, collectWebhookTypeRefs } from '../ir/types.js';
import { collectInlineEnumFromRef } from './schemas.js';
import { STATUS_RANGE_LABELS } from './responses.js';

/**
 * Promote the inline enums a model's fields declare to top-level enums. A
 * field enum is named from its model and field alone
 * (`GetReportResponseStatus`, `ListPetsDefaultResponseStatus`), a name a
 * component enum — or the same field of another model — may already own with
 * other values; such a field is renamed to a distinct name before it is
 * promoted (`…Status2`), collision-aware like the operation pass below and the
 * way header and webhook enums are, so the field never points at the other
 * values. A taken name with the same values is shared.
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
 * list-envelope companion fields, response headers, error bodies and secondary
 * response bodies, and promote them to top-level enums so emitters can
 * generate typed enum files.
 *
 * Every kind is collected collision-aware (`collectDistinctEnums`): a
 * parameter enum is named from the service and parameter name alone, so a
 * query parameter `error404` of a later operation derives the very name an
 * earlier operation's inline 404 enum body or `Error404` response header was
 * promoted under (`GetPetError404`), and whichever was collected first would
 * otherwise hand its values to the other's reference. A different value set
 * is renamed to a distinct name before it is promoted (`GetPetError4042`);
 * identical members are shared, as a parameter repeated across the
 * operations of a service always was.
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
        collectDistinctEnums(param.type, undefined, enums, enumNames);
      }
      for (const field of op.pagination?.envelopeFields ?? []) {
        collectDistinctEnums(field.type, undefined, enums, enumNames);
      }
      // Response headers are typed like parameters, so an inline enum declared
      // on one must reach `spec.enums` the same way or the IR would point at
      // an enum no emitter ever generates.
      for (const { headers, qualifier } of responseHeaderGroups(op)) {
        for (const header of headers) collectThroughModels(header.type, qualifier);
      }
      // An error body that is itself an inline enum, or an array of one, is
      // typed by `schemaToTypeRef` and reaches no model, so it is promoted
      // here — after the headers, so a header enum of the same name keeps it
      // as a header model would. The name is already operation-qualified
      // (`GetPetError404`); one a component, header or earlier error enum
      // owns with other members steps to `GetPetError404Body`. An enum
      // nested in an error body's model is collected with every other
      // model's (`collectInlineEnumsFromModels`).
      for (const error of op.errors) {
        if (error.type) collectDistinctEnums(error.type, 'Body', enums, enumNames);
      }
      // A body declared only for a secondary media type (`text/plain` next to
      // `application/json`), or for a `default` or range response, is typed
      // like a response body, so its inline enums are promoted the same way —
      // a body that is itself an inline enum, or an array of one, reaches no
      // model and is walked here; enums nested in its inline models are
      // reached through them. Its name is already operation-qualified
      // (`ListPetsDefaultResponse`); a clash with a different value set falls
      // back to a numeric suffix.
      for (const { type } of collectResponseBodyTypes(op)) {
        collectThroughModels(type, undefined);
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
  // A fallback response has no status code to qualify by; its label
  // (`Default`, `ClientError`) is what names its inline models too.
  if (op.defaultResponse?.headers) groups.push({ headers: op.defaultResponse.headers, qualifier: 'Default' });
  for (const range of op.rangeResponses ?? []) {
    if (range.headers) groups.push({ headers: range.headers, qualifier: STATUS_RANGE_LABELS[range.range] });
  }
  return groups;
}

/**
 * Promote the inline enums under a type reference — a response header's, a
 * secondary media type's or fallback response's body, a webhook parameter's
 * — without letting a taken name mislead. A response-header enum is named
 * from the service and header name alone, so `X-Policy` allowing
 * `fast`/`slow` on a 200 and `retry`/`stop` on a 429 would share one name
 * and whichever was collected first would silently win; a request parameter
 * named like the header, or a webhook parameter named like a component enum,
 * collides the same way. When the name is already taken by a different value
 * set, the ref is renamed to a distinct name before it is promoted. A taken
 * name with the same values is shared, as before.
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
