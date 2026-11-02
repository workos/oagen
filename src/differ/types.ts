import type { Extensions, Operation, SecurityRequirementSet, StatusRange } from '../ir/types.js';
import type { ParameterLocation } from '../ir/parameter-key.js';

export interface DiffReport {
  oldVersion: string;
  newVersion: string;
  changes: Change[];
  /**
   * Cross-cutting events that a type signature does not show: a parameter
   * default changing observable runtime behavior for callers who never set it
   * explicitly (breaking), an IR node becoming or ceasing to be deprecated
   * (additive), or the security requirements a request must satisfy changing
   * (either). Surfaced separately so PR-description and changelog tooling
   * can call them out even when the shapes in `changes` are otherwise
   * unchanged. Every entry here mirrors a flag or nested entry on a change in
   * `changes`, so the totals in `summary` count each event once.
   */
  behaviorChanges: BehaviorChange[];
  summary: {
    added: number;
    removed: number;
    modified: number;
    breaking: number;
    additive: number;
    behaviorChanges: number;
  };
}

export type BehaviorChange = ParamDefaultChanged | DeprecatedChanged | SecurityChanged | ExtensionsChanged;

export interface ParamDefaultChanged {
  kind: 'param-default-changed';
  /** Service name (e.g. 'authorization', 'accounts'). */
  serviceName: string;
  /** Operation name within the service. */
  operationName: string;
  /** Parameter name (e.g. 'order', 'limit'). */
  paramName: string;
  /** Where the parameter lives; kept in step with `ParamChange.paramLocation`. */
  paramLocation: ParamLocation;
  /** Old default value as a string, or null if previously unset. */
  oldDefault: string | null;
  /** New default value as a string, or null if now unset. */
  newDefault: string | null;
  classification: 'breaking';
}

/**
 * An IR node became deprecated, or stopped being deprecated. The node is still
 * there with the same shape, so nothing a caller compiles against changes and
 * the event is additive; it is surfaced here, beside the `deprecatedChanged`
 * flag or `*-deprecated-changed` entry on the owning change, so a changelog
 * can say it. `oldDeprecated`/`newDeprecated` are copied from that change,
 * which carries them beside its flag. `undefined` and `false` both read as
 * not deprecated, as the parser only ever writes `true`.
 */
export type DeprecatedChanged = {
  kind: 'deprecated-changed';
  /** Whether the node was deprecated in the old spec. Always the opposite of `newDeprecated`. */
  oldDeprecated: boolean;
  /** Whether the node is deprecated in the new spec. */
  newDeprecated: boolean;
  classification: 'additive';
} & DeprecatedNode;

/** Which IR node a `deprecated-changed` entry is about, named the way the owning change names it. */
export type DeprecatedNode =
  | { node: 'operation'; serviceName: string; operationName: string }
  | {
      node: 'parameter';
      serviceName: string;
      operationName: string;
      paramName: string;
      paramLocation: ParamLocation;
    }
  | {
      node: 'response-header';
      serviceName: string;
      operationName: string;
      /** The header's name as written in the new spec. */
      headerName: string;
      /** The response entry's status code, as on `ResponseHeaderChange`; unset for a fallback response. */
      statusCode?: number;
      /** Set instead of `statusCode` for the `default` or a range response. */
      fallback?: 'default' | StatusRange;
    }
  | { node: 'model'; modelName: string }
  | { node: 'field'; modelName: string; fieldName: string }
  | { node: 'enum'; enumName: string }
  | { node: 'enum-value'; enumName: string; valueName: string }
  | { node: 'webhook'; name: string; httpMethod: string }
  | {
      node: 'webhook-parameter';
      name: string;
      httpMethod: string;
      paramName: string;
      paramLocation: ParamLocation;
    };

/**
 * The security requirements a node's requests must satisfy changed. Mirrors
 * the document-level `security-changed` change (`node: 'document'`) and the
 * `securityChanged` flag on an `operation-modified` or `webhook-modified`
 * change, copying `oldSecurity`/`newSecurity` from it. The classification is
 * the security change's own — `classifySecurityChange` on the two lists,
 * read from the caller's side for an operation and from the receiver's side
 * for a webhook, and for the document as `DocumentSecurityChanged` says — not
 * the owning change's, which may be breaking for another reason.
 */
export type SecurityChanged = {
  kind: 'security-changed';
  oldSecurity: SecurityRequirementSet[];
  newSecurity: SecurityRequirementSet[];
  classification: 'additive' | 'breaking';
} & SecurityNode;

/** Which node a `security-changed` entry is about, named the way the owning change names it. */
export type SecurityNode =
  | { node: 'document' }
  | { node: 'operation'; serviceName: string; operationName: string }
  | { node: 'webhook'; name: string; httpMethod: string };

/**
 * An IR node's `extensions` — the `x-*` keys of the object it was built
 * from — changed: a key added, removed or given another value (compared
 * deeply, key order aside; an absent key and an empty object are the
 * same). The node is still there with the same shape, so nothing a caller
 * compiles against changes and the event is additive; it is surfaced here,
 * beside the `extensionsChanged` flag or `field-extensions-changed` entry
 * on the owning change, since an emitter may derive behavior from a key it
 * knows (`x-idempotent`, say) and a changelog has to say it.
 * `oldExtensions`/`newExtensions` are copied from that change: each is the
 * node's `extensions` on that side, absent when the node had none there.
 */
export type ExtensionsChanged = {
  kind: 'extensions-changed';
  oldExtensions?: Extensions;
  newExtensions?: Extensions;
  classification: 'additive';
} & ExtensionsNode;

/**
 * Which IR node an `extensions-changed` entry is about, named the way the
 * owning change names it. One entry kind per carrier of `extensions`: an
 * operation, a model, a model's field, an enum, and a list envelope's field
 * (`Operation.pagination.envelopeFields`, which sits on no model).
 */
export type ExtensionsNode =
  | { node: 'operation'; serviceName: string; operationName: string }
  | { node: 'model'; modelName: string }
  | { node: 'field'; modelName: string; fieldName: string }
  | { node: 'enum'; enumName: string }
  | { node: 'envelope-field'; serviceName: string; operationName: string; fieldName: string };

export type Change =
  | ModelAdded
  | ModelRemoved
  | ModelModified
  | EnumAdded
  | EnumRemoved
  | EnumModified
  | ServiceAdded
  | ServiceRemoved
  | OperationAdded
  | OperationRemoved
  | OperationModified
  | BaseUrlChanged
  | ServerAdded
  | ServerRemoved
  | ServerModified
  | DocumentSecurityChanged
  | WebhookAdded
  | WebhookRemoved
  | WebhookModified;

export interface ModelAdded {
  kind: 'model-added';
  name: string;
  classification: 'additive';
}

export interface ModelRemoved {
  kind: 'model-removed';
  name: string;
  classification: 'breaking';
}

export interface ModelModified {
  kind: 'model-modified';
  name: string;
  fieldChanges: FieldChange[];
  /**
   * Changes to a named union's `variants` and `discriminator`
   * (`Model.variants`). Present only when there is at least one.
   */
  variantChanges?: VariantChange[];
  /**
   * The model's own `deprecated` flipped. Additive either way: the model and
   * its fields are unchanged. A model whose only change is this flag is still
   * reported, with an empty `fieldChanges`.
   */
  deprecatedChanged: boolean;
  /** Present exactly when `deprecatedChanged`: the flag's two sides, old → new. */
  oldDeprecated?: boolean;
  newDeprecated?: boolean;
  /**
   * Present, and `true`, only when the model's own `extensions` differ
   * (see `ExtensionsChanged`). Additive: the model and its fields are
   * unchanged. A model whose only change is this is still reported, with
   * an empty `fieldChanges`.
   */
  extensionsChanged?: true;
  /** Present exactly when `extensionsChanged`, each when the model had extensions on that side: old → new. */
  oldExtensions?: Extensions;
  newExtensions?: Extensions;
  classification: 'additive' | 'breaking';
}

export interface VariantChange {
  kind: 'variant-added' | 'variant-removed' | 'discriminator-changed' | 'composition-changed';
  /**
   * The variant, as a short type label (`Cat`, `string`, `nullable<Cat>`,
   * `array<Cat>`); the discriminator property for `discriminator-changed`;
   * the new composition keyword for `composition-changed`.
   */
  variant: string;
  /**
   * `variant-added` is additive and `variant-removed` breaking, from either
   * side of the wire. `discriminator-changed` and `composition-changed` are
   * breaking. A mapping entry that comes with an added variant or goes with a
   * removed one is part of that variant's entry (see `details`), not a
   * `discriminator-changed` of its own.
   */
  classification: 'additive' | 'breaking';
  /**
   * For `variant-added` / `variant-removed`: present when discriminator
   * mapping keys came or went with the variant, reading `mapping added for
   * 'bird'` / `mapping removed for 'dog'`; absent otherwise (an undiscriminated
   * union's entries never carry it). For `discriminator-changed`:
   * `discriminator added` / `discriminator removed`, `property changed from
   * 'kind' to 'type'`, or `mapping changed for 'dog'` naming every key
   * retargeted, added for a model the old union already dispatched to under
   * any wrapper (an alias: `kitty: Cat` beside a kept `Cat`, bare or as
   * `nullable<Cat>`) or for no variant, or removed while its model stays. For
   * `composition-changed`: `composition changed from 'anyOf' to 'oneOf'`.
   */
  details?: string;
}

export interface FieldChange {
  kind:
    | 'field-added'
    | 'field-removed'
    | 'field-type-changed'
    | 'field-format-changed'
    | 'field-required-changed'
    | 'field-access-changed'
    | 'field-deprecated-changed'
    | 'field-extensions-changed';
  fieldName: string;
  classification: 'additive' | 'breaking';
  /** For `field-deprecated-changed`: the flag's two sides, old → new. */
  oldDeprecated?: boolean;
  newDeprecated?: boolean;
  /** For `field-extensions-changed` (additive, see `ExtensionsChanged`): the field's `extensions` on each side, each when it had any there. */
  oldExtensions?: Extensions;
  newExtensions?: Extensions;
  /** For `field-deprecated-changed`: `live → deprecated` or `deprecated → live`. */
  details?: string;
}

export interface EnumAdded {
  kind: 'enum-added';
  name: string;
  classification: 'additive';
}

export interface EnumRemoved {
  kind: 'enum-removed';
  name: string;
  classification: 'breaking';
}

export interface EnumModified {
  kind: 'enum-modified';
  name: string;
  valueChanges: EnumValueChange[];
  /**
   * The enum's own `deprecated` flipped. Additive either way: the values are
   * unchanged. An enum whose only change is this flag is still reported, with
   * an empty `valueChanges`.
   */
  deprecatedChanged: boolean;
  /** Present exactly when `deprecatedChanged`: the flag's two sides, old → new. */
  oldDeprecated?: boolean;
  newDeprecated?: boolean;
  /**
   * Present, and `true`, only when the enum's own `extensions` differ (see
   * `ExtensionsChanged`). Additive: the values are unchanged. An enum whose
   * only change is this is still reported, with an empty `valueChanges`.
   */
  extensionsChanged?: true;
  /** Present exactly when `extensionsChanged`, each when the enum had extensions on that side: old → new. */
  oldExtensions?: Extensions;
  newExtensions?: Extensions;
  classification: 'additive' | 'breaking';
}

export interface EnumValueChange {
  kind: 'value-added' | 'value-removed' | 'value-changed' | 'value-deprecated-changed';
  valueName: string;
  classification: 'additive' | 'breaking';
  /** For `value-deprecated-changed`: the flag's two sides, old → new. */
  oldDeprecated?: boolean;
  newDeprecated?: boolean;
  /** For `value-deprecated-changed`: `live → deprecated` or `deprecated → live`. */
  details?: string;
}

export interface ServiceAdded {
  kind: 'service-added';
  name: string;
  classification: 'additive';
}

export interface ServiceRemoved {
  kind: 'service-removed';
  name: string;
  classification: 'breaking';
}

export interface OperationAdded {
  kind: 'operation-added';
  serviceName: string;
  operationName: string;
  classification: 'additive';
}

export interface OperationRemoved {
  kind: 'operation-removed';
  serviceName: string;
  operationName: string;
  classification: 'breaking';
}

/** The wire encodings a request body or webhook payload is serialized as: `Operation.requestBodyEncoding`'s values. */
export type RequestBodyEncoding = NonNullable<Operation['requestBodyEncoding']>;

export interface OperationModified {
  kind: 'operation-modified';
  serviceName: string;
  operationName: string;
  paramChanges: ParamChange[];
  /**
   * `Operation.response` changed type, or the operation gained or lost its
   * only 2xx/3xx response (`responseStatusCode` present on one side only),
   * with or without a body. Breaking.
   */
  responseChanged: boolean;
  /**
   * The body appeared, disappeared, or changed type. Breaking, except that a
   * body appearing with `requestBodyRequired` not `true` is additive: callers
   * gain an argument they may leave out, like an optional `param-added`.
   */
  requestBodyChanged: boolean;
  /**
   * The body stayed but its `requestBodyRequired` flipped. Optional → required
   * is breaking (callers must now send a body); required → optional is additive.
   */
  requestBodyRequiredChanged: boolean;
  /**
   * The body stayed but its `requestBodyEncoding` differs: the wire format
   * the SDK serializes it as (`json`, `form-data`, `form-urlencoded`,
   * `binary` or `text`), read from the media type the body is declared
   * under. An SDK built for the old spec keeps serializing and labelling the
   * body as that spec said, so the change is breaking when the new spec no
   * longer accepts that representation — the media type the old body was
   * read from is gone from `requestBodyContentTypes`, or its shape changed,
   * compared as `retyped` is (`application/json` where the server now reads only
   * `application/x-www-form-urlencoded`) — and additive when it still does,
   * as when a media type the parser prefers is added beside it
   * (`application/json` added beside a kept
   * `application/x-www-form-urlencoded`: existing callers keep sending the
   * form body). A body without media-type lists reads as breaking. Compared
   * only while both specs carry a body, as `requestBodyRequiredChanged` is;
   * a body appearing or disappearing takes its encoding with it and is
   * `requestBodyChanged` alone. Reported beside
   * `requestBodyContentTypesChanged`, which lists the media types callers
   * may choose from: a body moving from `application/json` to
   * `application/x-www-form-urlencoded` sets both (the JSON media type is
   * removed, the form one added), while a media type changing essence
   * within one encoding (`application/json` → `application/vnd.api+json`)
   * sets `requestBodyContentTypesChanged` alone.
   */
  requestBodyEncodingChanged: boolean;
  /**
   * Set exactly when `requestBodyEncodingChanged`: the encoding on each
   * side, old → new. A side is `undefined` when that spec's body carries no
   * encoding, which the parser never produces (it sets one beside every
   * body) but a hand-built IR may.
   */
  oldRequestBodyEncoding?: RequestBodyEncoding;
  newRequestBodyEncoding?: RequestBodyEncoding;
  /**
   * True when, both specs declaring a body, it gained or lost a media type
   * or a secondary media type's body type changed;
   * `requestBodyContentTypeChange` says which. A body appearing or
   * disappearing is `requestBodyChanged` alone.
   */
  requestBodyContentTypesChanged: boolean;
  /** Present exactly when `requestBodyContentTypesChanged`. */
  requestBodyContentTypeChange?: RequestBodyContentTypesChange;
  httpMethodChanged: boolean;
  pathChanged: boolean;
  paginatedChanged: boolean;
  /**
   * Both versions paginate but `pagination.strategy` differs. Breaking: the
   * iterator must advance differently (an offset by items received, a page
   * number by one, a cursor from the response).
   */
  paginationStrategyChanged: boolean;
  /** Both versions paginate but the parameter the iterator advances (`pagination.param`) differs. Breaking. */
  paginationParamChanged: boolean;
  /** Both versions paginate but the page-size parameter (`pagination.limitParam`) differs, gained or lost. Breaking. */
  paginationLimitParamChanged: boolean;
  /** Both versions paginate but the data array's location (`pagination.dataPath`) differs. Breaking. */
  paginationDataPathChanged: boolean;
  /** Both versions paginate but the first page number (`pagination.pageStart`) differs. Breaking. */
  paginationPageStartChanged: boolean;
  /**
   * Both versions paginate but `pagination.endOfIteration` differs. Additive
   * when a stop field appears for the first time (the iterator merely stops
   * one request sooner); breaking when an existing one changes or disappears.
   */
  paginationEndOfIterationChanged: boolean;
  injectIdempotencyKeyChanged: boolean;
  errorsChanged: boolean;
  /**
   * The servers the operation is actually served from changed. Each side is
   * `op.servers ??` that document's servers (`diffSpecs` supplies them),
   * compared by `diffServers`, the document-level diff, with each list read
   * as a document whose `baseUrl` is its first entry resolved: matched on
   * `url` template plus variables (names, defaults, enum values as a set),
   * ignoring position, descriptions and enum order — except that a reorder
   * that moves the first entry's resolved URL counts, as `base-url-changed`
   * does for the document. URLs are compared through `normalizeServerUrl`,
   * so a scheme or host that only changed case, a default port written or
   * dropped, or a `/` added after a bare authority is no change. Absent on
   * both sides is unchanged: the operation inherits twice, and a moved
   * document is the document-level diff's to report. So a document that
   * moves to where an operation already pointed is not a change to that
   * operation. OpenAPI's default server is one list however it is spelled
   * (#291): no servers and `/` alone — description and variables aside,
   * since `/` references no variable — are served from the same place.
   *
   * Classified change by change, as the document-level diff classifies the
   * same edit to the document's `servers` (#299), and `serverChanges` lists
   * them. Breaking when a server the operation's callers could use is gone
   * or its resolved URL moved: the first entry's resolved URL changed or
   * disappeared (`base-url-changed`), an entry removed (`server-removed`),
   * or, on a `server-modified`, a variable the template references removed,
   * its default changed so that a resolved URL moves, an enum put on it or a
   * value taken off it. Additive otherwise: an entry added, a first entry
   * appearing where there was none, a variable added, an enum lifted or a
   * value added to it, a default changed that moves no resolved URL in its
   * RFC 3986 form, whatever values a caller picks for the other variables
   * (a host that only changed case, #406), and any change to a variable the
   * template never references. The operation is breaking for its servers
   * exactly when one entry of `serverChanges` is. A webhook carries no
   * `servers` in the IR (`Webhook` has no such field), so a
   * `webhook-modified` change has no such flag.
   */
  serversChanged: boolean;
  /**
   * What changed between the two effective lists, as `diffServers` reports
   * it for a document — `base-url-changed`, `server-added`, `server-removed`
   * and `server-modified` with its `variableChanges` — in that order, each
   * with its own classification and every URL as written in the spec that
   * declares it. `[]` when `serversChanged` is false.
   */
  serverChanges: ServerChange[];
  /**
   * The operation's own `deprecated` flipped. Additive either way: the
   * signature is unchanged. A parameter's flag flipping is a
   * `param-deprecated-changed` entry in `paramChanges` instead, and a
   * response header's a `header-deprecated-changed` entry in
   * `responseHeaderChanges`.
   */
  deprecatedChanged: boolean;
  /** Present exactly when `deprecatedChanged`: the flag's two sides, old → new. */
  oldDeprecated?: boolean;
  newDeprecated?: boolean;
  /**
   * The security requirements the operation's requests must satisfy changed.
   * Each side is `op.security ?? ` that document's `security` (`diffSpecs`
   * supplies them), `[]` when neither declares any; the two lists are
   * compared as sets of alternatives, each a set of schemes with scopes as
   * sets, so order and repetition do not count. Absent on both sides is
   * unchanged: the operation inherits twice, and a moved document default is
   * the document-level `security-changed` change's to report. Breaking when
   * a request built for the old list no longer satisfies the new one — a
   * scheme or scope it now has to carry, an alternative it could use that is
   * gone, an anonymous alternative withdrawn; additive when every old
   * alternative still passes — a new alternative, a scope or scheme no longer
   * needed, authentication made optional.
   */
  securityChanged: boolean;
  /** Present exactly when `securityChanged`: the effective requirements on each side, old → new. */
  oldSecurity?: SecurityRequirementSet[];
  newSecurity?: SecurityRequirementSet[];
  /**
   * The operation's `tags` differ, compared in document order (an absent key
   * is an empty list). Always additive: tags group and document a method and
   * change nothing a caller compiles against. Operations are matched by
   * name within a service, so this flag only ever carries an edit that
   * leaves the operation in a service of the same name; a first-tag change
   * that the parser's grouping files under another service leaves nothing
   * to match, and the diff reports the move instead — removed from the old
   * service and added to the new one, or `service-removed` and
   * `service-added` when a service goes or comes with it.
   */
  tagsChanged: boolean;
  /** Present exactly when `tagsChanged`: the lists on each side, old → new, `[]` for none. */
  oldTags?: string[];
  newTags?: string[];
  /**
   * Present, and `true`, only when the operation's `extensions` differ (see
   * `ExtensionsChanged`). Additive: the operation's signature is unchanged.
   * A change whose only content is this is still reported.
   */
  extensionsChanged?: true;
  /** Present exactly when `extensionsChanged`, each when the operation had extensions on that side: old → new. */
  oldExtensions?: Extensions;
  newExtensions?: Extensions;
  /**
   * The fields of the list envelope (`Operation.pagination.envelopeFields`)
   * whose `extensions` differ, one `field-extensions-changed` entry each
   * with the two sides beside it, matched by field name while both specs
   * paginate. Present only when there is at least one. A scalar companion
   * (`has_more`) sits on no model `diffModels` reads, so this is where its
   * change is reported; a companion object's model is compared in the
   * models diff like any model. No other property of an envelope field is
   * compared by the differ.
   */
  envelopeFieldChanges?: FieldChange[];
  /**
   * True when a response entry gained or lost a media type, or a secondary
   * media type's body type changed; `responseContentTypeChanges` says which.
   */
  responseContentTypesChanged: boolean;
  responseContentTypeChanges: ResponseContentTypesChange[];
  /**
   * True when a response entry gained, lost, retyped, re-required, renamed
   * or deprecated one of the headers it declares; `responseHeaderChanges`
   * says which.
   */
  responseHeadersChanged: boolean;
  responseHeaderChanges: ResponseHeaderChange[];
  /**
   * `Operation.responseStatusCode` — the status code the primary success
   * response is read from — differs while both specs carry one: a lone
   * `201` that became a lone `200`, a `200` added beside a lone `201` (the
   * `200` is now the primary), or a `201` that became the primary beside a
   * `200` whose body is no longer typed. Additive on its own: the old code
   * may still be declared, as in the second case, and whether a bare status
   * move breaks callers is left to a separate issue — this flag only says
   * the move happened, so a changelog can. Compared only while both sides
   * carry a code, as `requestBodyRequired` is while both carry a body; an
   * operation gaining or losing its only 2xx/3xx is not a move but
   * `responseChanged`. Not mirrored into `behaviorChanges`.
   */
  responseStatusCodeChanged: boolean;
  /** Present exactly when `responseStatusCodeChanged`: the code on each side, old → new. */
  oldResponseStatusCode?: number;
  newResponseStatusCode?: number;
  /** The `default` or a `1XX`–`5XX` range response was added, removed, or changed type. */
  fallbackResponsesChanged: boolean;
  classification: 'additive' | 'breaking';
}

/**
 * A change to one header a response declares — `Operation.responseHeaders`
 * on the primary success response, `headers` on each other `SuccessResponse`,
 * on each `ErrorResponse`, on the `DefaultResponse` and on each
 * `RangeResponse` — between two specs. The SDK reads these headers off the
 * response and never sends them, so each kind is classified from the
 * reader's side, as a webhook's parameters are: a header added is additive,
 * required or not (the server simply starts sending it); one removed is
 * breaking (an accessor the SDK exposed is gone); a type change is breaking,
 * a format-only change additive, as elsewhere; optional → required is
 * additive (the header is now always present) and required → optional
 * breaking (code that assumed it breaks); a `deprecated` flip and a
 * respelling are additive.
 *
 * Response entries pair up between the two specs exactly as they do for
 * `responseContentTypeChanges`: by status code — every 2xx entry, the
 * primary among them (a lone 2xx by `Operation.responseStatusCode`), and
 * every error — with `statusCode` set; two lone primaries of different
 * codes pair with each other, the move reported once as
 * `responseStatusCodeChanged`; a lone 2xx that carries no code (a hand-built
 * IR) pairs with the entry of the other spec that offers its media types,
 * else with that spec's primary, and is reported with `statusCode` unset,
 * though only one that carries media types or headers pairs as the old
 * spec's: one that carries neither, as the primary of an operation that
 * declared no 2xx/3xx does, pairs with nothing, so a 2xx the new spec adds
 * to it is no header change; the `default` and range responses by key,
 * with `fallback` set. Within an entry, headers pair
 * by name case-insensitively (RFC 9110 §5.1, `foldHeaderName`), so
 * `X-Rate-Limit` and `x-rate-limit` are one header: a pair whose written
 * names differ is reported as `header-name-changed` with `oldName`/`newName`
 * beside it, additive, since an emitter may derive an identifier from the
 * name as written. Two names of one folding declared side by side (a
 * hand-built IR; the parser keeps one) stay two headers: each pairs with the
 * one spelled the same way on the other side, else with the other side's
 * next unpaired name of its folding, and one left over is added or removed.
 * A 2xx entry the old spec declared and the new does not has no other diff
 * to report its headers, so each is reported `header-removed`; an error or
 * fallback entry only one spec declares is the errors or fallback diff's
 * business, and so is a 2xx the new spec adds. A webhook's accepted
 * responses (`WebhookResponse`) carry no headers in the IR, so a
 * `webhook-modified` change has no such list.
 */
export interface ResponseHeaderChange {
  kind:
    | 'header-added'
    | 'header-removed'
    | 'header-type-changed'
    | 'header-format-changed'
    | 'header-required-changed'
    | 'header-name-changed'
    | 'header-deprecated-changed';
  /** The header's name as written in the spec that declares it: the new spec's for a header both declare. */
  headerName: string;
  /**
   * The response entry's status code — `Operation.responseStatusCode` for a
   * lone 2xx — of the entry that declares what changed: the old spec's for
   * `header-removed`, the new spec's for every other kind — so an operation
   * that lost its only 2xx, whose new primary carries no code, reports that
   * entry's headers under its old code. Unset for a fallback response, and
   * for a lone 2xx of a hand-built IR that carries no code.
   */
  statusCode?: number;
  /** Set instead of `statusCode` for the `default` or a `1XX`–`5XX` range response, which carry no code. */
  fallback?: 'default' | StatusRange;
  classification: 'additive' | 'breaking';
  /** For `header-name-changed`: the name as written in the old spec. */
  oldName?: string;
  /** For `header-name-changed`: the name as written in the new spec (the same as `headerName`). */
  newName?: string;
  /** For `header-deprecated-changed`: the flag's two sides, old → new. */
  oldDeprecated?: boolean;
  newDeprecated?: boolean;
  /**
   * What changed, in words: `format <old> → <new>` for `header-format-changed`,
   * `optional → required` or `required → optional` for
   * `header-required-changed`, `name <old> → <new>` for `header-name-changed`,
   * `live → deprecated` or `deprecated → live` for `header-deprecated-changed`.
   */
  details?: string;
}

/**
 * How one response entry's media types changed between two specs. Entries
 * pair up by status code — 2xx entries from `successResponses`, the primary
 * among them, errors from `errors` — so a primary that changes status still
 * pairs with the entry of its code; a lone 2xx pairs by its
 * `Operation.responseStatusCode` and is reported with that code, and two
 * lone primaries of different codes pair with each other
 * (`responseStatusCodeChanged` reports the move); a primary that carries no
 * code (an operation declaring no 2xx/3xx, or a hand-built IR's lone 2xx) is
 * paired with the entry of the other spec that offers its media types, else
 * with that spec's primary, except the old spec's when it carries no media
 * types or headers either, as the primary of an operation that declared no
 * 2xx/3xx does: that one pairs with nothing, so a 2xx the new spec adds to
 * it is no media-type change. A change is located at the new spec's entry,
 * or — when that entry carries no code and the change only removes, as
 * when an operation lost its only 2xx — at the old spec's entry, which
 * declared what is gone, so `statusCode` is unset only for a lone 2xx of a
 * hand-built IR that carries no code. The `default` and range responses pair by key
 * and are reported with `fallback` set. A 2xx the old spec declared and the
 * new does not is reported with its media types `removed`; one the new spec
 * adds is no media-type change. Media types are compared by essence —
 * `type/subtype`, case folded, parameters stripped (`mediaTypeEssence`, the
 * rule the parser types a body by) — and order aside: reordering them is no
 * change, and neither is a key that only changed case (`Text/HTML`) or
 * gained, lost or respelled `charset` (`application/problem+json;
 * charset=utf-8`); a pair whose other parameters differ is
 * `reparameterized`, additive. Each media type is reported as written in
 * the spec that declares it (`retyped` lists the new spec's spelling). Two keys of one
 * essence declared side by side (`application/json` beside
 * `application/json; charset=utf-8`) stay two media types: each pairs, in
 * this order of preference, with the key spelled the same way on the other
 * side, else one of its essence with the same parameters other than
 * `charset`, else one of its essence whose body is the same shape, else the
 * other side's next unpaired key of its essence; one left over is `added`
 * or `removed`.
 */
export interface ResponseContentTypesChange {
  statusCode?: number;
  /** Set instead of `statusCode` for the `default` or a `1XX`–`5XX` range response, which carry no code. */
  fallback?: 'default' | '1XX' | '2XX' | '3XX' | '4XX' | '5XX';
  /** Media types the new spec declares and the old did not: callers gain a representation to ask for. */
  added: string[];
  /** Media types the old spec declared and the new does not: a representation callers could ask for is gone. */
  removed: string[];
  /**
   * Media types declared by both whose body's shape changed — two model
   * refs are compared field by field through the two specs' models, nested
   * models and enums included, so a model that was only renamed (a
   * parameter edit on a key declared beside another spelling of its essence
   * renames the model the parser mints for it) is no retype and surfaces as
   * `model-removed` + `model-added` instead — other than the one the entry's
   * own `type` is read from, which `responseChanged` and `errorsChanged`
   * already report. Two model or enum refs whose names both specs declare
   * are compared by name, nested ones included, however alike: neither was
   * renamed, so a body moved from `Note` to an identical `NoteCopy` is
   * retyped.
   */
  retyped: string[];
  /**
   * Media types declared by both whose parameters other than `charset`
   * differ (`application/pdf; version=1.7` → `; version=2.0`), both
   * spellings as written: the body is typed the same, but the parameter
   * may select another representation, so the change is kept visible.
   * Additive. Case, whitespace, parameter order and `charset` are not
   * differences.
   */
  reparameterized: Array<{ from: string; to: string }>;
  /** `breaking` when anything was removed or retyped, else `additive`. */
  classification: 'additive' | 'breaking';
}

/**
 * How an operation's or a webhook's request body media types changed: the
 * `content` keys of its Request Body Object, compared the way a response
 * entry's are (see `ResponseContentTypesChange`) — by essence, order aside,
 * each reported as written in the spec that declares it, two keys of one
 * essence kept apart. Compared only while both specs declare a body: one
 * appearing or disappearing is `requestBodyChanged` alone, and the body
 * `requestBody` is read from is left to `requestBodyChanged` when it changes
 * type, so `retyped` only ever lists a secondary media type. Classified
 * from the node's side. For an operation, the caller sends the body: a
 * media type it could send that is gone, or whose body changed type, is
 * breaking; one it can newly send is additive. For a webhook, the handler
 * decodes the body the sender chose: a media type the sender can newly use,
 * or whose body changed type, is breaking; one it can no longer use is
 * additive.
 */
export interface RequestBodyContentTypesChange {
  /** Media types the new spec declares and the old did not: a representation the caller can newly send. */
  added: string[];
  /** Media types the old spec declared and the new does not: a representation the caller could send is gone. */
  removed: string[];
  /**
   * Media types declared by both whose body's shape changed — two model
   * refs are compared field by field through the two specs' models, nested
   * models and enums included, so a model that was only renamed (a
   * parameter edit on a key declared beside another spelling of its essence
   * renames the model the parser mints for it) is no retype and surfaces as
   * `model-removed` + `model-added` instead — other than the one
   * `requestBody` is read from, which `requestBodyChanged` reports. Two
   * model or enum refs whose names both specs declare are compared by name,
   * nested ones included, however alike: neither was renamed, so a body
   * moved from `Note` to an identical `NoteCopy` is retyped.
   */
  retyped: string[];
  /**
   * Media types declared by both whose parameters other than `charset`
   * differ (`application/vnd.pets+json; version=1` → `; version=2`), both
   * spellings as written: the body is typed the same, but the parameter
   * may select another representation, so the change is kept visible.
   * Additive on either side. Case, whitespace, parameter order and
   * `charset` are not differences.
   */
  reparameterized: Array<{ from: string; to: string }>;
  /**
   * From the caller's side on an operation: `breaking` when anything was
   * removed or retyped, else `additive`. From the receiver's side on a
   * webhook: `breaking` when anything was added or retyped, else `additive`.
   */
  classification: 'additive' | 'breaking';
}

/**
 * A webhook is identified by its `name` and `httpMethod` together, since one
 * `webhooks` key may declare several methods; a method change therefore
 * reports as one webhook removed and another added.
 */
export interface WebhookAdded {
  kind: 'webhook-added';
  name: string;
  httpMethod: string;
  classification: 'additive';
}

export interface WebhookRemoved {
  kind: 'webhook-removed';
  name: string;
  httpMethod: string;
  classification: 'breaking';
}

/**
 * Changes to a webhook the receiver already handles. Read from the receiver's
 * side: a payload type or encoding change breaks the handler's signature, a
 * body that may now be absent breaks a handler that assumed one, and
 * parameter changes are classified the way a response's would be (see
 * `diffWebhookParams`). Every `ParamChange` carries its `paramLocation`,
 * since a header and a query parameter may share a name; a header's name is
 * matched case-insensitively, as on an operation, so a header whose name
 * only changed case is a `param-name-changed` entry. A parameter's
 * `deprecated` flipping is a `param-deprecated-changed` entry there, as on
 * an operation. The security the request carries is read from the
 * receiver's side too: a credential the sender stops presenting, or an
 * alternative it may now present that the handler never checked for, is
 * breaking. A webhook carries no `servers` in the IR (`Webhook` has no such
 * field), so there is no `serversChanged` or `serverChanges` here.
 */
export interface WebhookModified {
  kind: 'webhook-modified';
  name: string;
  httpMethod: string;
  paramChanges: ParamChange[];
  /**
   * True when the payload's type changed, or — both specs declaring a
   * payload — its encoding, its `requestBodyRequired` or the media types the
   * sender may use did; `details` says which.
   */
  requestBodyChanged: boolean;
  /**
   * Set exactly when the payload's encoding changed (`details` reads
   * `encoding json → form-urlencoded`): the encoding on each side, old →
   * new, as an `operation-modified` change carries them. Breaking when the
   * representation the sender now uses — the media type the new payload is
   * read from, with its shape — is not one the old spec declared with that
   * shape, so the handler decodes a wire format it never saw; additive when
   * the old spec already declared it. A payload without media-type lists
   * reads as breaking. Compared only while both specs declare a payload, as
   * on an operation: a payload appearing or disappearing is `payload added`
   * / `payload removed` in `details` and carries neither field.
   */
  oldRequestBodyEncoding?: RequestBodyEncoding;
  newRequestBodyEncoding?: RequestBodyEncoding;
  /**
   * Present exactly when the payload's media types changed: which were
   * added, removed or retyped, classified from the receiver's side (see
   * `RequestBodyContentTypesChange`).
   */
  requestBodyContentTypeChange?: RequestBodyContentTypesChange;
  /** True when the set of status codes the sender accepts changed; `details` says which (a code removed is breaking). */
  responsesChanged: boolean;
  /**
   * The webhook's own `deprecated` flipped. Additive either way: the handler's
   * signature is unchanged. A webhook whose only change is this flag is still
   * reported, with an empty `paramChanges`.
   */
  deprecatedChanged: boolean;
  /** Present exactly when `deprecatedChanged`: the flag's two sides, old → new. */
  oldDeprecated?: boolean;
  newDeprecated?: boolean;
  /**
   * The security the request carries changed. Each side is
   * `webhook.security ?? ` that document's `security`, `[]` when neither
   * declares any, compared as on an operation (sets of alternatives; absent
   * on both sides is unchanged). Breaking when what the sender may now
   * present no longer carries what the handler checked for — a scheme it
   * stops presenting, an alternative it may now use that the old list never
   * offered; additive when every new alternative still carries some old one
   * — a credential the sender starts carrying beside the old ones, an
   * alternative withdrawn.
   */
  securityChanged: boolean;
  /** Present exactly when `securityChanged`: the effective requirements on each side, old → new. */
  oldSecurity?: SecurityRequirementSet[];
  newSecurity?: SecurityRequirementSet[];
  /** The webhook's `tags` differ, compared in document order. Always additive, as on an operation. */
  tagsChanged: boolean;
  /** Present exactly when `tagsChanged`: the lists on each side, old → new, `[]` for none. */
  oldTags?: string[];
  newTags?: string[];
  /** What changed about the body or the accepted responses, e.g. `payload type changed; accepted response 200 removed`. */
  details?: string;
  classification: 'additive' | 'breaking';
}

/**
 * Where a parameter lives. An operation carries parameters in all four
 * locations (`Operation.pathParams`, `queryParams`, `headerParams` and
 * `cookieParams`); a webhook carries `header`, `query` and `cookie` ones.
 * `locatedParams` in `params.ts` tags every parameter a node carries with
 * its location, and `paramKey` there joins it to the name to identify one.
 * The same four locations `ParameterLocation` in `ir/parameter-key.ts`
 * names, since the parser merges parameters on the same identity.
 */
export type ParamLocation = ParameterLocation;

/**
 * A change to one parameter of an operation or a webhook, in any location it
 * carries one. Parameters are matched by location and name (`paramKey` in
 * `params.ts`, which is `parameterKey` in `ir/parameter-key.ts`) — OpenAPI
 * allows a path `id` beside a query `id` on one operation — so every entry
 * carries `paramLocation` to say which one it is. A header's name is
 * compared case-insensitively (RFC 9110 §5.1): a header written
 * `X-Pet-Token` on one side and `x-pet-token` on the other is one parameter,
 * and the spelling change is a `param-name-changed` entry (additive, with
 * `oldName`/`newName`) beside whatever else changed about it, not a
 * `param-removed` beside a `param-added`. Path, query and cookie names are
 * case-sensitive. On the entries of a paired parameter, `paramName` is the
 * name as the new spec writes it; a `param-removed` entry carries the old
 * spec's name, which the new spec no longer has, and a `param-added` entry
 * the new spec's.
 */
export interface ParamChange {
  kind:
    | 'param-added'
    | 'param-removed'
    | 'param-type-changed'
    | 'param-format-changed'
    | 'param-required-changed'
    | 'param-default-changed'
    | 'param-deprecated-changed'
    | 'param-name-changed'
    | 'param-content-type-changed';
  paramName: string;
  classification: 'additive' | 'breaking';
  /** For `param-name-changed`: the name as the old spec wrote it. */
  oldName?: string;
  /** For `param-name-changed`: the name as the new spec writes it (also `paramName`). */
  newName?: string;
  /** For `param-default-changed`: serialized old default value, or `null` if previously unset. */
  oldDefault?: string | null;
  /** For `param-default-changed`: serialized new default value, or `null` if now unset. */
  newDefault?: string | null;
  /** For `param-deprecated-changed`: the flag's two sides, old → new. */
  oldDeprecated?: boolean;
  newDeprecated?: boolean;
  /**
   * For `param-content-type-changed`: `Parameter.contentType` on each side as
   * written, or `null` for a parameter typed by `schema` (see
   * `parameterContentTypeShift` in `params.ts`).
   */
  oldContentType?: string | null;
  newContentType?: string | null;
  /**
   * Where the parameter lives. Set on every entry `diffOperations` produces
   * (an operation's path, query, header and cookie parameters) and on every
   * entry `diffWebhooks` produces (a webhook's header, query and cookie
   * parameters may share a name).
   */
  paramLocation?: ParamLocation;
  /**
   * For `param-deprecated-changed`: `live → deprecated` or `deprecated → live`.
   * For `param-name-changed`: `name X-Pet-Token → x-pet-token`.
   * For `param-content-type-changed`: `content type <schema> → application/json`.
   */
  details?: string;
}

/**
 * `ApiSpec.baseUrl` — the first server's URL with its variables' defaults
 * filled in — differs, so a client built on the default host sends its
 * requests somewhere else. Reported once per diff whatever moved it: a
 * changed `servers[0]` template (also a `server-removed` plus a
 * `server-added`), a changed variable default (also a `server-modified`), a
 * reordered list, or a `servers` list that appeared or disappeared. The two
 * URLs are compared through `normalizeServerUrl` (RFC 3986: scheme and host
 * case, a default or empty port, a bare authority's `/`, percent-encoding
 * case), so a `baseUrl` that only changed in one of those ways is not
 * reported; both are carried as written. The comparison also reads `''` and
 * `/` as one address — OpenAPI's default, whether the document declares no
 * server, writes `/` out, or resolves its first server to `/` — so nothing
 * is reported between those (#291).
 */
export interface BaseUrlChanged {
  kind: 'base-url-changed';
  /** As written in the old document; `''` when it declared no server, `/` when its first server resolved to `/`, which means the same. */
  oldBaseUrl: string;
  /** As written in the new document; `''` when it declares no server, `/` when its first server resolves to `/`, which means the same. */
  newBaseUrl: string;
  /**
   * Breaking when the default host moves or disappears. Additive when the old
   * document declared nothing beyond OpenAPI's default server — no `servers`,
   * `servers: []`, or nothing but `/` (`isDefaultServerList`): every existing
   * caller had to name a host themselves and still can. A `/` the old
   * document listed first beside another server is the address a caller got
   * without naming one, so a host taking the front from it is breaking
   * (#405).
   */
  classification: 'additive' | 'breaking';
}

/**
 * A server the new document lists and the old did not. The `/` a document
 * is only implied to have — its list means OpenAPI's default — is never
 * reported here; `/` listed beside another server is, like any other (#291).
 */
export interface ServerAdded {
  kind: 'server-added';
  /** The URL template as written in the new document, placeholders included. */
  url: string;
  classification: 'additive';
}

/**
 * A server the old document listed and the new does not. The `/` a document
 * is only implied to have is never reported here; `/` listed beside another
 * server is, like any other (#291).
 */
export interface ServerRemoved {
  kind: 'server-removed';
  /** The URL template as written in the old document, placeholders included. */
  url: string;
  classification: 'breaking';
}

/**
 * A server present in both documents — matched on its `url` template through
 * `normalizeServerUrl`, so a template that only changed scheme or host case,
 * a default port or a bare authority's `/` is the same server;
 * position-independent; a template declared more than once is matched as a
 * multiset, see `diffServers` — whose variables changed. A changed template
 * is a `server-removed` plus a `server-added` instead.
 */
export interface ServerModified {
  kind: 'server-modified';
  /** The URL template as written in the new document, placeholders included. */
  url: string;
  variableChanges: ServerVariableChange[];
  classification: 'additive' | 'breaking';
}

/**
 * One variable of a `server-modified` server, matched by name. A variable
 * added, an enum lifted (`variable-enum-removed`) and an enum value added are
 * additive for any variable. The other four kinds — the variable removed, its
 * default changed, an enum appearing, an enum value removed — are breaking
 * when the server's `url` template references the variable (its `{name}` is
 * in the template, so the resolved URL a caller built on moves) and additive
 * when it does not: a variable the template never references cannot reach
 * any resolved URL, so nothing a caller relied on is taken away. In that
 * additive case — those four kinds only — `details` says so; the three kinds
 * that are additive for any variable keep their shape. A referenced
 * variable's default changed is additive too when it moves nothing: when the
 * template with only that variable filled in is one URL in its RFC 3986 form
 * (`normalizeServerUrl`) from either default, as when only the host's case
 * changed (#406); `details` then says so. The other placeholders are kept
 * rather than filled from their defaults, so that holds whatever values a
 * caller picks for them: in `{scheme}://pets.example.com:{port}`, `port`
 * going from `443` to `''` stays breaking, since a caller who picks `http`
 * moves from port 443 to 80.
 */
export interface ServerVariableChange {
  kind:
    | 'variable-added'
    | 'variable-removed'
    | 'variable-default-changed'
    | 'variable-enum-added'
    | 'variable-enum-removed'
    | 'variable-enum-value-added'
    | 'variable-enum-value-removed';
  variableName: string;
  classification: 'additive' | 'breaking';
  /** For `variable-default-changed`: the previous default. */
  oldDefault?: string;
  /** For `variable-default-changed`: the new default. */
  newDefault?: string;
  /** For `variable-enum-value-added` / `variable-enum-value-removed`: the value. */
  value?: string;
  /**
   * What changed, in words, for `variable-default-changed`,
   * `variable-enum-added` and `variable-enum-removed`. For a variable the
   * template never references, every change that would otherwise be breaking
   * also carries (appended after `; ` when there is other text) `{name} is
   * not in the URL template, so no resolved URL moves`. A default changed on a
   * referenced variable without moving any resolved URL carries `either
   * default resolves to the same URL in its RFC 3986 form` after its text the
   * same way.
   */
  details?: string;
}

/**
 * The changes `diffServers` reports between two server lists: the
 * document-level kinds, which an `operation-modified` change carries as
 * `serverChanges` when the operation's effective servers differ (#299).
 */
export type ServerChange = BaseUrlChanged | ServerAdded | ServerRemoved | ServerModified;

/**
 * `ApiSpec.security` — the default every operation and webhook that declares
 * no `security` of its own inherits — differs between the two documents,
 * compared as sets of alternatives (order and repetition do not count; `[]`
 * and an undeclared list both mean no authentication). Reported once per
 * diff: an operation or webhook that inherits on both sides is not reported
 * again for it, while one that declares its own list on either side is
 * compared on what it actually requires (`securityChanged`).
 */
export interface DocumentSecurityChanged {
  kind: 'security-changed';
  /** The old document's list; `[]` when it declared none. */
  oldSecurity: SecurityRequirementSet[];
  /** The new document's list; `[]` when it declares none. */
  newSecurity: SecurityRequirementSet[];
  /**
   * Read from each side that inherits the default in both documents, by the
   * rule the inheriting node would be read by (`classifySecurityChange`):
   * the caller's when an operation does, the receiver's when a webhook
   * does, each matched across the documents as its own change is; breaking
   * if any such side breaks. A node that declares its own list on either
   * side is compared on its own (`securityChanged`), and one added or
   * removed is reported as such. When nothing inherits it in both
   * documents, no request reads both defaults, so the change is additive.
   */
  classification: 'additive' | 'breaking';
}
