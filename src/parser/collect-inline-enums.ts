import type { Enum, EnumValue, Model, Operation, ResponseHeader, Service, TypeRef, Webhook } from '../ir/types.js';
import {
  walkTypeRef,
  collectModelTypeRefs,
  collectRequestBodyTypes,
  collectResponseBodyTypes,
  collectModelRefs,
  collectWebhookTypeRefs,
} from '../ir/types.js';
import { collectInlineEnumFromRef } from './schemas.js';
import { enumValuesOf, sameEnumShape } from './enum-members.js';
import { STATUS_RANGE_LABELS } from './responses.js';

/**
 * Promote the inline enums a model's fields and named-union variants
 * declare to top-level enums. A field enum is named from its model and field alone
 * (`GetReportResponseStatus`, `ListPetsDefaultResponseStatus`), a name a
 * component enum — or the same field of another model — may already own with
 * other values; such a field is renamed to a distinct name before it is
 * promoted (`…Status2`), collision-aware like the operation pass below and the
 * way header and webhook enums are, so the field never points at the other
 * values. A taken name with the same members — values and per-value
 * deprecation (`sameEnumShape`) — is shared. A name a model owns is a clash
 * too, and the distinct name is never one of `models`' (see
 * `distinctEnumName`): a component field's enum named like a model
 * (`Pet.kind` beside a `PetKind` object) is left on its ref by
 * `extractSchemas` and promoted here as `PetKind2`.
 */
export function collectInlineEnumsFromModels(models: Model[], enums: Enum[]): void {
  const enumNames = new Set(enums.map((e) => e.name));
  const modelNames = new Set(models.map((model) => model.name));
  for (const model of models) {
    for (const ref of collectModelTypeRefs(model)) {
      collectDistinctEnums(ref, undefined, enums, enumNames, modelNames);
    }
  }
}

/**
 * Collect inline enum definitions from operation parameters (query, path,
 * header, cookie), list-envelope companion fields, response headers, the
 * request body, every success body, error bodies, secondary and fallback
 * response bodies, and secondary request bodies, and promote them to
 * top-level enums so emitters can generate typed enum files.
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
 * silently given the component's values. It is also the set of names a
 * renamed enum must step around (`distinctEnumName`), so pass every model of
 * the document, not only the ones to walk into.
 *
 * `owned` is the parser's record of every inline error body an operation
 * named itself (`OperationExtractionResult.ownedErrorBodies`, the one
 * answer to which bodies an operation owns), by identity. Those step by
 * `Body` on a clash (`GetPetError404Body`), as their `<Op>Error<code>…`
 * names do in the shape registry; every other body — a body shared through
 * `components/responses` at a 404, a `4XX` or `default`, a `default` or
 * `1XX`–`3XX` body, a success body — steps by number, so the one enum a
 * shared component declares settles on one name (`ProblemResponse2`) from
 * every operation that returns it. The IR alone cannot tell the two apart
 * (`ProblemResponse` is a shared body's name wherever it is returned), so
 * the record is required: a caller that built `services` by hand passes the
 * bodies it owns, or an empty set when it declares no error body.
 */
export function collectInlineEnumsFromOperations(
  services: Service[],
  enums: Enum[],
  owned: ReadonlySet<TypeRef>,
  models: readonly Model[] = [],
  componentNames: ReadonlySet<string> = new Set(),
): void {
  const enumNames = new Set(enums.map((e) => e.name));
  const modelsByName = new Map(models.map((model) => [model.name, model]));
  const modelNames = new Set(modelsByName.keys());
  // Each materialized model is visited once, under the first qualifier that reaches it.
  const visited = new Set<string>();
  const collectThroughModels = (type: TypeRef, qualifier: string | undefined): void => {
    collectDistinctEnums(type, qualifier, enums, enumNames, modelNames);
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
        collectDistinctEnums(param.type, undefined, enums, enumNames, modelNames);
      }
      // The iterator's item type is reached through `response` when detection
      // unwrapped the data array, but an explicit `dataPath` can type it from
      // the document — an inline enum, or an array or union holding one — on
      // a body kept as a wrapper, where nothing else references it. It is
      // walked on its own, like the envelope companions, under the name the
      // path gave it (`ListPetsRecord`); one a component enum owns with other
      // members falls back to a numeric suffix. A model it names is walked
      // like a body's, so an enum nested in one is reached the same way.
      if (op.pagination) collectThroughModels(op.pagination.itemType, undefined);
      for (const field of op.pagination?.envelopeFields ?? []) {
        collectDistinctEnums(field.type, undefined, enums, enumNames, modelNames);
      }
      // Response headers are typed like parameters, so an inline enum declared
      // on one must reach `spec.enums` the same way or the IR would point at
      // an enum no emitter ever generates.
      for (const { headers, qualifier } of responseHeaderGroups(op)) {
        for (const header of headers) collectThroughModels(header.type, qualifier);
      }
      // The request body and each success body are typed by `schemaToTypeRef`
      // under the operation's `<Op>Request` / `<Op>Response` name, so one that
      // is itself an inline enum, or an array of one, reaches no model and is
      // promoted here — neither `collectResponseBodyTypes` nor the error loop
      // below yields it (workos/oagen#281). Every `successResponses` entry is
      // walked on its own under its status code, as its headers are: the 200
      // and the 202 derive the same name, so a second body with other members
      // steps to `CheckPetKindResponse202`, while identical members share. A
      // lone success response, and the request body, carry no code and fall
      // back to a numeric suffix (`GetPetKindResponse2`). An enum nested in a
      // body's model is collected with every other model's
      // (`collectInlineEnumsFromModels`).
      for (const { type, qualifier } of requestAndSuccessBodies(op)) {
        collectDistinctEnums(type, qualifier, enums, enumNames, modelNames);
      }
      // An error body that is itself an inline enum, or an array of one, is
      // typed by `schemaToTypeRef` and reaches no model, so it is promoted
      // here — after the headers, so a header enum of the same name keeps it
      // as a header model would. An operation-owned body's name is already
      // operation-qualified (`GetPetError404`); one a component, header or
      // earlier error enum owns with other members steps to
      // `GetPetError404Body`. A body shared through `components/responses`
      // (`ProblemResponse`, not in `owned`) steps by number instead
      // (`ProblemResponse2`), the name the same body takes at a `default`
      // or range site, so every operation returning it shares one enum. An
      // enum nested in an error body's model is collected with every other
      // model's (`collectInlineEnumsFromModels`).
      for (const error of op.errors) {
        if (error.type)
          collectDistinctEnums(error.type, owned.has(error.type) ? 'Body' : undefined, enums, enumNames, modelNames);
      }
      // A body declared only for a secondary media type (`text/plain` next to
      // `application/json`), or for a `default` or range response, is typed
      // like a response body, so its inline enums are promoted the same way —
      // a body that is itself an inline enum, or an array of one, reaches no
      // model and is walked here; enums nested in its inline models are
      // reached through them. Its name is already operation-qualified
      // (`ListPetsDefaultResponse`); a clash with a different value set falls
      // back to a numeric suffix — except for an operation-owned error body
      // (`owned`: a 4xx/5xx or `4XX`/`5XX` body under a secondary media type,
      // a `4XX`/`5XX` range's body), named `<Op>Error<code>…` like
      // `errors[].type`, which steps to `…Body` as that does.
      for (const { type } of collectResponseBodyTypes(op)) {
        collectThroughModels(type, owned.has(type) ? 'Body' : undefined);
      }
      // A request body declared only for a secondary media type (`text/csv`
      // next to `application/json`) is typed like one, with its name already
      // operation-qualified (`ReplaceWidgetTextCsvRequest`), so its inline
      // enums are promoted the same way.
      for (const { type } of collectRequestBodyTypes(op)) {
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
 * promoted (`PetAdoptedXSource2`); a taken name with the same members is
 * shared, and the distinct name is never one of `models`'
 * (`distinctEnumName`). The parser's stem reservation keeps such a clash from
 * arising through `parseSpec`; this guards the IR for any caller. A payload
 * model's field enums are reached through `spec.models` by
 * `collectInlineEnumsFromModels`, since the model is materialized there.
 */
export function collectInlineEnumsFromWebhooks(
  webhooks: Webhook[],
  enums: Enum[],
  models: readonly Model[] = [],
): void {
  const enumNames = new Set(enums.map((e) => e.name));
  const modelNames = new Set(models.map((model) => model.name));
  for (const webhook of webhooks) {
    for (const ref of collectWebhookTypeRefs(webhook)) {
      collectDistinctEnums(ref, undefined, enums, enumNames, modelNames);
    }
  }
}

/**
 * Header lists to walk, each with the status-code qualifier that keeps a
 * colliding enum name apart. When `successResponses` exists the primary list
 * is the same array as its entry there, so the entries are walked with their
 * own codes instead of `responseHeaders`; a lone 2xx or 3xx response is not
 * listed in `successResponses` (set only for more than one), so its headers
 * get no qualifier — its `responseStatusCode` is deliberately not used here,
 * as qualifying by it would rename every enum such a header declares.
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
  // (`Default`, `ClientError`) qualifies its header models and enums, and
  // names the inline body of a `default` or `1XX`–`3XX` response (a `4XX`
  // or `5XX` body is named by its range key, `<Op>Error4Xx`).
  if (op.defaultResponse?.headers) groups.push({ headers: op.defaultResponse.headers, qualifier: 'Default' });
  for (const range of op.rangeResponses ?? []) {
    if (range.headers) groups.push({ headers: range.headers, qualifier: STATUS_RANGE_LABELS[range.range] });
  }
  return groups;
}

/**
 * The bodies `collectResponseBodyTypes` leaves out because each is reached
 * through the entry's own `type`: the request body, then every success body,
 * each with the qualifier that keeps a colliding enum name apart. When
 * `successResponses` exists its entries are walked under their own status
 * codes — the primary's `type` is the very ref its entry carries, so
 * `response` is not walked again; a lone 2xx or 3xx response carries no
 * status code in the IR (`successResponses` is set only for more than one),
 * so `response` gets no qualifier, and neither does the request body. Error
 * bodies are walked by the caller under their own qualifier.
 */
function requestAndSuccessBodies(op: Operation): Array<{ type: TypeRef; qualifier?: string }> {
  const bodies: Array<{ type: TypeRef; qualifier?: string }> = [];
  if (op.requestBody) bodies.push({ type: op.requestBody });
  if (op.successResponses) {
    for (const entry of op.successResponses) bodies.push({ type: entry.type, qualifier: String(entry.statusCode) });
  } else {
    bodies.push({ type: op.response });
  }
  return bodies;
}

/**
 * Promote the inline enums under a type reference — a response header's, a
 * secondary media type's or fallback response's body, a webhook parameter's
 * — without letting a taken name mislead. A response-header enum is named
 * from the service and header name alone, so `X-Policy` allowing
 * `fast`/`slow` on a 200 and `retry`/`stop` on a 429 would share one name
 * and whichever was collected first would silently win; a request parameter
 * named like the header, or a webhook parameter named like a component enum,
 * collides the same way. When the name is already taken by a different
 * member set — other values, or the same values with a different one
 * deprecated (`sameEnumShape`) — or by a model, the ref is renamed to a
 * distinct name before it is promoted: an enum and a model under one name
 * reach an emitter as one public symbol, so the name is checked against the
 * union of every model name (`modelNames`, every model of the document) and
 * every enum name (`enums`) before any minted enum keeps it, on every path
 * that promotes one — a field, a parameter, a response header, an error or
 * secondary body, a webhook parameter or payload. A taken name with the same
 * members is shared, as before; the first lifted copy's value descriptions
 * and link are the enum's. A component enum declared under a component
 * model's name is the document's own clash and is left as declared.
 */
function collectDistinctEnums(
  ref: TypeRef,
  qualifier: string | undefined,
  enums: Enum[],
  enumNames: Set<string>,
  modelNames: ReadonlySet<string>,
): void {
  walkTypeRef(ref, {
    enum: (ref) => {
      if (!ref.values) return;
      const values = enumValuesOf(ref);
      const existing = enums.find((e) => e.name === ref.name);
      const ownedByOtherMembers = existing !== undefined && !sameEnumShape(existing.values, values);
      const ownedByModel = existing === undefined && modelNames.has(ref.name);
      if (ownedByOtherMembers || ownedByModel) {
        ref.name = distinctEnumName(ref.name, values, qualifier, enums, modelNames);
      }
      collectInlineEnumFromRef(ref, enums, enumNames);
    },
  });
}

/**
 * A name the base was already stepped to that holds the same members
 * (`isNumericStep`), else the first name not taken by a different member set,
 * nor by a model: the base qualified by the status code
 * (`DocumentsXPolicy429`), then numeric suffixes (`DocumentsXPolicy2`,
 * `DocumentsXPolicy3`, ...). Deterministic for a given spec, since it depends
 * only on declaration order. The collectors
 * run after every model is named, and the merge passes mint against every
 * enum name an `EnumRef` carries (`reservedTypeNames`) — but not against the
 * names chosen here, so this is the side that steps around the other: a
 * model a merge pass qualified to `GetLegacyWidgetWidget2`, because a
 * component enum owns `GetLegacyWidgetWidget`, sends a query enum of that
 * name with other members on to `GetLegacyWidgetWidget3`, and no enum
 * promoted by a collector takes a model's name.
 */
function distinctEnumName(
  base: string,
  values: readonly EnumValue[],
  qualifier: string | undefined,
  enums: Enum[],
  modelNames: ReadonlySet<string>,
): string {
  const isUsable = (name: string): boolean => {
    if (modelNames.has(name)) return false;
    const taken = enums.find((e) => e.name === name);
    return !taken || sameEnumShape(taken.values, values);
  };
  // A name this stem already stepped to for the same members — another
  // status code's body or header (`…200` when this is the 202's), or an
  // earlier numeric step — is shared before a new one is minted, so
  // identical members on two status codes never become two enums once their
  // plain name is taken. Only a digit-qualified name is a step of this stem:
  // `…Body` and the fallback labels (`…Default`) qualify other sites.
  const stepped = enums.find(
    (e) => isNumericStep(e.name, base) && !modelNames.has(e.name) && sameEnumShape(e.values, values),
  );
  if (stepped) return stepped.name;
  if (qualifier && isUsable(`${base}${qualifier}`)) return `${base}${qualifier}`;
  let suffix = 2;
  while (!isUsable(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
}

/** Whether `name` is `base` followed by one or more digits: a status-code or numeric-suffix step of the stem. */
function isNumericStep(name: string, base: string): boolean {
  if (name.length <= base.length || !name.startsWith(base)) return false;
  for (const char of name.slice(base.length)) if (char < '0' || char > '9') return false;
  return true;
}
