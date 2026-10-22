import type { Operation, SecurityRequirementSet } from '../ir/types.js';

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

export type BehaviorChange = ParamDefaultChanged | DeprecatedChanged | SecurityChanged;

export interface ParamDefaultChanged {
  kind: 'param-default-changed';
  /** Service name (e.g. 'authorization', 'accounts'). */
  serviceName: string;
  /** Operation name within the service. */
  operationName: string;
  /** Parameter name (e.g. 'order', 'limit'). */
  paramName: string;
  /** Where the parameter lives; kept in step with `ParamChange.paramLocation`. */
  paramLocation: 'path' | 'query' | 'header' | 'cookie';
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
      paramLocation: 'path' | 'query' | 'header' | 'cookie';
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
      paramLocation: 'path' | 'query' | 'header' | 'cookie';
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
  classification: 'additive' | 'breaking';
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
    | 'field-deprecated-changed';
  fieldName: string;
  classification: 'additive' | 'breaking';
  /** For `field-deprecated-changed`: the flag's two sides, old → new. */
  oldDeprecated?: boolean;
  newDeprecated?: boolean;
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
   * under. Always breaking: an SDK built for the old spec keeps serializing
   * and labelling the body as that spec said (`application/json` where the
   * server now reads `application/x-www-form-urlencoded`). Compared only
   * while both specs carry a body, as `requestBodyRequiredChanged` is; a
   * body appearing or disappearing takes its encoding with it and is
   * `requestBodyChanged` alone.
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
   * The servers the operation is actually served from changed, so its
   * requests go elsewhere. Always breaking. Each side is `op.servers ??`
   * that document's servers (`diffSpecs` supplies them), compared by the rule
   * the document-level diff uses: matched on `url` template plus variables
   * (names, defaults, enum values as a set), ignoring position, descriptions
   * and enum order — except that a reorder that moves the first entry's
   * resolved URL counts, as `base-url-changed` does for the document. Absent
   * on both sides is unchanged: the operation inherits twice, and a moved
   * document is the document-level diff's to report. So a document that moves
   * to where an operation already pointed is not a change to that operation.
   * OpenAPI's default server is one list however it is spelled (#291): no
   * servers and `/` alone without variables are served from the same place.
   */
  serversChanged: boolean;
  /**
   * The operation's own `deprecated` flipped. Additive either way: the
   * signature is unchanged. A parameter's flag flipping is a
   * `param-deprecated-changed` entry in `paramChanges` instead.
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
   * change nothing a caller compiles against.
   */
  tagsChanged: boolean;
  /** Present exactly when `tagsChanged`: the lists on each side, old → new, `[]` for none. */
  oldTags?: string[];
  newTags?: string[];
  /**
   * True when a response entry gained or lost a media type, or a secondary
   * media type's body type changed; `responseContentTypeChanges` says which.
   */
  responseContentTypesChanged: boolean;
  responseContentTypeChanges: ResponseContentTypesChange[];
  /** The `default` or a `1XX`–`5XX` range response was added, removed, or changed type. */
  fallbackResponsesChanged: boolean;
  classification: 'additive' | 'breaking';
}

/**
 * How one response entry's media types changed between two specs. Entries
 * pair up by status code — 2xx entries from `successResponses`, the primary
 * among them, errors from `errors` — so a primary that changes status still
 * pairs with the entry of its code; a lone 2xx carries no code in the IR and
 * is paired with the entry of the other spec that offers its media types,
 * else with that spec's primary — reported with `statusCode` unset when it is
 * the new spec's lone entry. The `default` and range responses pair by key
 * and are reported with `fallback` set. A 2xx the old spec declared and the
 * new does not is reported with its media types `removed`; one the new spec
 * adds is no media-type change. Media types are compared by essence —
 * `type/subtype`, case folded, parameters stripped (`mediaTypeEssence`, the
 * rule the parser types a body by) — and order aside: reordering them is no
 * change, and neither is a key that only changed case (`Text/HTML`) or
 * gained, lost or respelled a parameter (`application/problem+json;
 * charset=utf-8`). Each media type is reported as written in the spec that
 * declares it (`retyped` lists the new spec's spelling). Two keys of one
 * essence declared side by side (`application/json` beside
 * `application/json; charset=utf-8`) stay two media types: each pairs with
 * the key spelled the same way on the other side, else with the other
 * side's next unpaired key of its essence, and one left over is `added` or
 * `removed`.
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
   * Media types declared by both whose body type changed, other than the one
   * the entry's own `type` is read from, which `responseChanged` and
   * `errorsChanged` already report.
   */
  retyped: string[];
  /** `breaking` when anything was removed or retyped, else `additive`. */
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
 * since a header and a query parameter may share a name. A parameter's
 * `deprecated` flipping is a `param-deprecated-changed` entry there, as on
 * an operation. The security the request carries is read from the
 * receiver's side too: a credential the sender stops presenting, or an
 * alternative it may now present that the handler never checked for, is
 * breaking.
 */
export interface WebhookModified {
  kind: 'webhook-modified';
  name: string;
  httpMethod: string;
  paramChanges: ParamChange[];
  /** True when the payload's type, encoding, or `requestBodyRequired` changed; `details` says which. */
  requestBodyChanged: boolean;
  /**
   * Set exactly when the payload's encoding changed (`details` reads
   * `encoding json → form-urlencoded`): the encoding on each side, old →
   * new, as an `operation-modified` change carries them. Breaking: the
   * handler decodes a different wire format.
   */
  oldRequestBodyEncoding?: RequestBodyEncoding;
  newRequestBodyEncoding?: RequestBodyEncoding;
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
 * A change to one parameter of an operation. Parameters are matched by
 * location and name — OpenAPI allows a path `id` beside a query `id` on one
 * operation — so every entry carries `paramLocation` to say which one it is.
 */
export interface ParamChange {
  kind:
    | 'param-added'
    | 'param-removed'
    | 'param-type-changed'
    | 'param-format-changed'
    | 'param-required-changed'
    | 'param-default-changed'
    | 'param-deprecated-changed';
  paramName: string;
  classification: 'additive' | 'breaking';
  /** For `param-default-changed`: serialized old default value, or `null` if previously unset. */
  oldDefault?: string | null;
  /** For `param-default-changed`: serialized new default value, or `null` if now unset. */
  newDefault?: string | null;
  /** For `param-deprecated-changed`: the flag's two sides, old → new. */
  oldDeprecated?: boolean;
  newDeprecated?: boolean;
  /**
   * Where the parameter lives. Set on every entry `diffOperations` produces
   * and on every entry `diffWebhooks` produces (a webhook's header, query and
   * cookie parameters may share a name).
   */
  paramLocation?: 'path' | 'query' | 'header' | 'cookie';
  /** For `param-deprecated-changed`: `live → deprecated` or `deprecated → live`. */
  details?: string;
}

/**
 * `ApiSpec.baseUrl` — the first server's URL with its variables' defaults
 * filled in — differs, so a client built on the default host sends its
 * requests somewhere else. Reported once per diff whatever moved it: a
 * changed `servers[0]` template (also a `server-removed` plus a
 * `server-added`), a changed variable default (also a `server-modified`), a
 * reordered list, or a `servers` list that appeared or disappeared. A
 * document that declares no server and one whose only server is `/` without
 * variables both have OpenAPI's default server and no default host, so
 * nothing is reported between them (#291).
 */
export interface BaseUrlChanged {
  kind: 'base-url-changed';
  /** `''` when the old document declared no server; `/` when it wrote OpenAPI's default out, which means the same. */
  oldBaseUrl: string;
  /** `''` when the new document declares no server; `/` when it writes OpenAPI's default out, which means the same. */
  newBaseUrl: string;
  /**
   * Breaking when the default host moves or disappears. Additive when the old
   * document declared no server, or only `/`: every existing caller had to
   * name a host themselves and still can.
   */
  classification: 'additive' | 'breaking';
}

export interface ServerAdded {
  kind: 'server-added';
  /** The URL template as written in the document, placeholders included. */
  url: string;
  classification: 'additive';
}

export interface ServerRemoved {
  kind: 'server-removed';
  /** The URL template as written in the document, placeholders included. */
  url: string;
  classification: 'breaking';
}

/**
 * A server present in both documents — matched on its `url` template,
 * position-independent; a template declared more than once is matched as a
 * multiset, see `diffServers` — whose variables changed. A changed template is
 * a `server-removed` plus a `server-added` instead.
 */
export interface ServerModified {
  kind: 'server-modified';
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
 * additive case `details` says so.
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
   * not in the URL template, so no resolved URL moves`.
   */
  details?: string;
}

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
   * Read from the caller's side, as for an operation: breaking when a
   * request built for the old list no longer satisfies the new one. When a
   * webhook in either document inherits the default, read from the
   * receiver's side as well, and breaking if either side breaks.
   */
  classification: 'additive' | 'breaking';
}
