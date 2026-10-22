import type { SdkBehavior } from './sdk-behavior.js';

/**
 * Authentication scheme extracted from OpenAPI `components.securitySchemes`.
 *
 * `schemeName` is the key under `components.securitySchemes`, spelled exactly as
 * in the document. The requirements under `ApiSpec.security` and
 * `Operation.security` refer to the same key, so emitters join a requirement to
 * its scheme on that field. `description` is present only when the document
 * declares one.
 */
export type AuthScheme = { description?: string; schemeName: string } & (
  | { kind: 'basic' }
  | { kind: 'bearer' }
  | { kind: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string }
  | { kind: 'oauth2'; flows: Record<string, unknown> }
);

/**
 * A variable in a templated server URL (`https://{region}.api.example.com`),
 * from the server's `variables` map.
 */
export interface ServerVariable {
  /** Substituted for the placeholder when the caller picks no value; OpenAPI requires one. */
  default: string;
  /** The values the variable may take. Present only when the document declares a non-empty list. */
  enum?: string[];
  description?: string;
}

/** A server entry from the OpenAPI servers array */
export interface ServerEntry {
  /**
   * As written in the document, placeholders included. `ApiSpec.baseUrl` is
   * the first server's URL with its variables' defaults filled in; resolve any
   * other entry the same way with `resolveServerUrl` from `ir/server-url.ts`.
   */
  url: string;
  description?: string;
  /** The template's variables, keyed by placeholder name. Present only when the document declares them. */
  variables?: Record<string, ServerVariable>;
}

/**
 * A link to documentation outside the OpenAPI document (an External
 * Documentation Object). Present on a node only when the document declares
 * one with a non-blank `url`; an emitter can surface it in a doc comment (a
 * JSDoc `@see`, say). `url` is exactly as written — OpenAPI allows a value
 * relative to the document's own location, which the parser does not know, so
 * it neither resolves nor rewrites it. `description` is present only when it
 * has non-whitespace content.
 */
export interface ExternalDocs {
  url: string;
  description?: string;
}

/** Root IR node representing the full API surface */
export interface ApiSpec {
  name: string;
  version: string;
  description?: string;
  /** The document's top-level `externalDocs`, when it declares a usable one. */
  externalDocs?: ExternalDocs;
  baseUrl: string;
  servers?: ServerEntry[];
  services: Service[];
  /**
   * The requests the API sends to its users, from the document's top-level
   * `webhooks` map (OpenAPI 3.1), in document order. Absent — not an empty
   * list — when the document declares none, so the IR of a document without
   * webhooks is unchanged. A webhook is not an SDK method: it belongs to no
   * service, gets no resolved operation name, and is untouched by operation
   * hints and mount rules. See `Webhook`.
   */
  webhooks?: Webhook[];
  models: Model[];
  enums: Enum[];
  auth?: AuthScheme[];
  /**
   * Document-level security requirements: the default every operation uses
   * unless it declares its own `Operation.security`. Same shape and semantics
   * as that field. `undefined` when the document declares none.
   */
  security?: SecurityRequirementSet[];
  /** Language-agnostic runtime policies (retry, errors, telemetry, etc.). */
  sdk: SdkBehavior;
}

/**
 * A request the API sends to its users: one HTTP method of one entry in the
 * document's top-level `webhooks` map (OpenAPI 3.1). An entry whose path item
 * declares several methods yields one `Webhook` per method, so `name` alone
 * does not identify a webhook; `name` + `httpMethod` does.
 *
 * Everything here is read from the receiver's side of the wire: the request
 * body is the payload the receiver is handed, the parameters are the headers
 * (signatures, event types) and query values the request carries, and
 * `responses` are the status codes the sender expects back. An emitter uses
 * this to generate a payload type or a typed handler per event. A webhook is
 * never an SDK method: it has no path, belongs to no `Service`, and gets no
 * resolved operation name.
 *
 * An operation's `callbacks` (OpenAPI 3.x), whose path items have this
 * shape, are not read into `Webhook` or anywhere else; the parser warns at
 * every site that declares any (see `warnOnIgnoredCallbacks`).
 */
export interface Webhook {
  /** The key under `webhooks`, verbatim (`petAdopted`, `user.created`). */
  name: string;
  /** The operation's `operationId`, when the document declares one. */
  operationId?: string;
  httpMethod: HttpMethod;
  /**
   * The `summary` alone, read as `Operation.summary` is: the operation's own,
   * else the path item's. Absent when neither has content.
   */
  summary?: string;
  /**
   * Combined doc text, built as `Operation.description` is from the same
   * two-level read. Absent when neither level gives any text.
   */
  description?: string;
  /**
   * The operation's own `externalDocs`, when it declares a usable one, as on
   * `Operation.externalDocs`. A Path Item Object has no `externalDocs`, so
   * there is nothing to fall back to.
   */
  externalDocs?: ExternalDocs;
  /** Present, and `true`, only when the document marks the webhook deprecated. */
  deprecated?: boolean;
  /** The operation's `tags`, read exactly as `Operation.tags` is. */
  tags?: string[];
  /** Header parameters the request carries, typed like `Operation.headerParams`. */
  headerParams: Parameter[];
  /** Query parameters the request carries, typed like `Operation.queryParams`. */
  queryParams: Parameter[];
  /** Cookie parameters; present only when the document declares at least one. */
  cookieParams?: Parameter[];
  /**
   * The payload the receiver is handed. An inline object schema is
   * materialized as a model named `<Stem>Payload`, where the stem is the
   * `operationId` when there is one and the webhook's name otherwise (see the
   * parser's `resolveWebhookModelStems` for how the stem is kept unique).
   * Read from the content entry the same pick as `Operation.requestBody`
   * chooses, by media type essence. Absent when the operation declares no
   * `requestBody`, or one none of whose media types is read — which the
   * parser warns about.
   */
  requestBody?: TypeRef;
  /** How the payload is encoded, read like `Operation.requestBodyEncoding`. */
  requestBodyEncoding?: 'json' | 'form-data' | 'form-urlencoded' | 'binary' | 'text';
  /**
   * The media type the payload was read from, by essence, read like
   * `Operation.requestBodyContentType` (`application/merge-patch+json`;
   * `application/json` for `application/json; charset=utf-8`): what the
   * sender labels the request with, so a handler can check it. Present
   * exactly when `requestBody` is.
   */
  requestBodyContentType?: string;
  /** Present, and `true`, only when the document marks the request body `required`. */
  requestBodyRequired?: boolean;
  /**
   * Media types the payload declares under `content`, in document order and
   * exactly as written, read as `Operation.requestBodyContentTypes` is.
   * Present only when at least one is declared.
   */
  requestBodyContentTypes?: string[];
  /**
   * One entry per `requestBodyContentTypes` entry, in the same order, typed
   * as `Operation.requestBodyContents` is: the entry for the media type
   * `requestBody` was read from carries that same TypeRef; an inline object
   * under another media type is materialized as `<Stem><MediaType>Payload`
   * (`PetAdoptedTextCsvPayload`). Present only when `requestBodyContentTypes`
   * is.
   */
  requestBodyContents?: RequestBodyContent[];
  /**
   * The responses the sender expects from the receiver, in document order:
   * one entry per status code key (three digits, 100–599) the operation
   * declares. `default`, range (`2XX`) and `x-` keys are not carried; a key
   * that is none of those (`error`, `6XX`, `600`) is ignored with a warning.
   * Body schemas on these responses are not carried either: a webhook
   * response is an acknowledgement, and typing it would mint models no
   * handler needs.
   */
  responses: WebhookResponse[];
  /**
   * The security the request carries, mirroring the OpenAPI document exactly
   * as `Operation.security` does: `undefined` inherits `ApiSpec.security`,
   * `[]` means none, otherwise one alternative per requirement object.
   */
  security?: SecurityRequirementSet[];
}

/** One status code a webhook's sender expects back, with the document's description of it. */
export interface WebhookResponse {
  statusCode: number;
  description?: string;
}

/** A service groups related operations (maps to an SDK resource class) */
export interface Service {
  name: string;
  description?: string;
  /**
   * A document tag's `externalDocs`, resolved by the same rule as
   * `description`: a service named after a declared tag takes that tag's; a
   * split-off service inherits it from the first linked tag its operations
   * carry, chosen independently of the tag its description comes from.
   * Absent when no tag gives one.
   */
  externalDocs?: ExternalDocs;
  operations: Operation[];
}

/** One scheme a request must satisfy, with the scopes it needs. */
export interface SecurityRequirement {
  /** Key under `components.securitySchemes`; joins to `AuthScheme.schemeName`. */
  schemeName: string;
  scopes: string[];
}

/**
 * One alternative from an OpenAPI security requirement list: a request must
 * satisfy *every* scheme in the set together ("all of"). A list of sets is
 * satisfied by *any one* of them ("either of"). An empty set is an alternative
 * that needs no credentials at all, which is how a document makes
 * authentication optional (`security: [{ userToken: [] }, {}]`).
 */
export type SecurityRequirementSet = SecurityRequirement[];

/** A single API operation (maps to an SDK method) */
export interface Operation {
  name: string;
  /**
   * The `summary` alone: the OpenAPI operation's own, or — when the operation
   * declares none with non-whitespace content — the `summary` of the Path
   * Item it sits on, which OpenAPI applies to every operation on that path.
   * Present only when one of the two has content; a summary that is not a
   * string, or is empty or whitespace-only, is treated as absent at either
   * level. Read this to use the
   * summary as a one-line label; `description` below still carries the
   * combined form, so emitters that only print `description` are unchanged.
   */
  summary?: string;
  /**
   * Doc text for the operation, combined from a `summary` and a `description`
   * each read as `summary` above is: the operation's own, else the Path
   * Item's, field by field. When both have content, this is
   * `summary + "\n\n" + description`; when only one has content (or both are
   * identical), this is that one. A value that is not a string, or is empty
   * or whitespace-only, is treated as absent, and text with content is kept
   * verbatim. The parts are
   * not separable from this field alone — use `summary` for that.
   */
  description?: string;
  /** The operation's own `externalDocs`, when it declares a usable one. */
  externalDocs?: ExternalDocs;
  httpMethod: HttpMethod;
  path: string;
  /**
   * The servers this operation is served from, when they differ from the
   * document's: the operation's own `servers`, else its Path Item's (OpenAPI
   * precedence). Absent when the operation inherits `ApiSpec.servers` — it
   * declares none at either level, or what it declares is the document's list
   * again (same URLs, descriptions and variables, in the same order). Same
   * shape as `ApiSpec.servers`, variables included, so `resolveServerUrl`
   * from `ir/server-url.ts` fills a template's defaults the way `baseUrl` was
   * produced. To find where a request goes, take `op.servers ?? spec.servers`.
   */
  servers?: ServerEntry[];
  pathParams: Parameter[];
  queryParams: Parameter[];
  /**
   * Query parameters the spec also declares as request-body properties on a
   * body-carrying method (POST/PUT/PATCH). They travel in the body only, so
   * they are excluded from `queryParams`; they are kept here so inline enums
   * they declare stay reachable and the compat surface still sees them.
   * Emitters never serialize these to the URL.
   */
  bodyOwnedQueryParams?: Parameter[];
  headerParams: Parameter[];
  cookieParams?: Parameter[];
  /**
   * The request body's type, read from one content entry of the Request Body
   * Object (after a `components/requestBodies` `$ref` is resolved). Media
   * types are matched by essence — parameters and case aside, so
   * `application/json; charset=utf-8` and `APPLICATION/JSON` are
   * `application/json` — and tried in a fixed order: `application/json`, then
   * a `+json` media type (`application/vnd.api+json`), then
   * `multipart/form-data`, then `application/x-www-form-urlencoded`, each
   * only when it declares a schema; then `application/octet-stream`, then
   * `text/plain`, with or without one (a schema-less binary body is a binary
   * string, a schema-less text body a string). An inline object body is
   * materialized as `<Op>Request`; an inline enum body, or an array of one,
   * is promoted to `spec.enums` under that name, numbered on a clash with an
   * enum of other members. Absent when the operation declares no
   * body, or one none of whose media types is read — which the parser warns
   * about once, so a body is never dropped silently.
   */
  requestBody?: TypeRef;
  /**
   * The wire encoding of the media type `requestBody` was read from: `json`
   * for `application/json` and any `+json` media type, `form-data` for
   * `multipart/form-data`, `form-urlencoded` for
   * `application/x-www-form-urlencoded`, `binary` for
   * `application/octet-stream`, `text` for `text/plain`. Set exactly when
   * `requestBody` is.
   */
  requestBodyEncoding?: 'json' | 'form-data' | 'form-urlencoded' | 'binary' | 'text';
  /**
   * The media type `requestBody` was read from, by essence — `type/subtype`
   * with parameters and case stripped: `application/merge-patch+json` for a
   * body declared under that key, `application/json` for one under
   * `application/json; charset=utf-8`, `multipart/form-data` for one under
   * `multipart/form-data; boundary=x`. This is what an emitter sends as the
   * request's `Content-Type`, so a server that requires its declared media
   * type accepts the request; parameters such as a multipart boundary are
   * the emitter's to produce. `requestBodyEncoding` says how to serialize
   * the body, this says how to label it. The key as written is the
   * `contentType` of the `requestBodyContents` entry that shares
   * `requestBody`'s type. Set exactly when `requestBody` is.
   */
  requestBodyContentType?: string;
  /**
   * Whether a caller must send `requestBody`: the Request Body Object's
   * `required`, read after a `components/requestBodies` `$ref` is resolved.
   * OpenAPI defaults the flag to `false`, so a body the document does not
   * mark required comes through as `false`. Present exactly when
   * `requestBody` is; an operation without a body has no entry.
   */
  requestBodyRequired?: boolean;
  /**
   * Media types the request body declares under `content`, in document
   * order and exactly as written (`application/json; charset=utf-8`,
   * `multipart/form-data; boundary=x`, `text/csv`), so an emitter can offer
   * each verbatim as a `Content-Type`. Present only when the body declares at
   * least one media type — whether or not one of them is read as
   * `requestBody` — as `responseContentTypes` is on the response side.
   */
  requestBodyContentTypes?: string[];
  /**
   * One entry per `requestBodyContentTypes` entry, in the same order, with
   * the type that media type resolves to. The entry for the media type
   * `requestBody` was read from carries that very TypeRef, so the two never
   * disagree. Every other entry is typed as it would be were it the only one
   * declared: from its schema when it has one (an inline object materialized
   * as `<Op><MediaType>Request`, `ReplaceWidgetTextCsvRequest`), else a
   * binary string for `application/octet-stream`, a string for `text/plain`,
   * and `unknown` for any other media type. Present only when
   * `requestBodyContentTypes` is.
   */
  requestBodyContents?: RequestBodyContent[];
  /**
   * The primary success response's body type: the lowest declared status code
   * from 200 to 399 whose type is not `unknown` — the lowest 2xx with a typed
   * body, so a `200` left `unknown` by the media-type rules (a schema-less
   * `text/csv`) yields to a `201` typed from a schema, and a 3xx entry (always
   * `unknown`) never wins over a typed 2xx — falling back to the lowest
   * declared code (an untyped 2xx, or a 3xx when no 2xx is declared).
   * `responseHeaders` and `responseDescription` come from the same entry.
   * Never promoted from a `2XX` range or the `default` response: an
   * operation declaring no 2xx or 3xx response at all (only `default` or
   * `2XX`, only a `404`, an empty `responses` map, or no `responses` key)
   * has `{ kind: 'primitive', type: 'unknown' }` here — the type of a body
   * the document does not describe — with no `responseHeaders` or
   * `responseDescription`, and an emitter should take the success body
   * from `rangeResponses` (`2XX`), then `defaultResponse` — the same order
   * it resolves any status: the explicit entry, then the matching range,
   * then the default. A body that is itself an inline enum, or an array of
   * one, is promoted to `spec.enums` as `<Op>Response` (see
   * `SuccessResponse.type` for one of several success bodies).
   */
  response: TypeRef;
  /**
   * The status code of the response `response` was read from — the primary
   * success response chosen as described there: `200`; `201` when an untyped
   * `200` yielded to a typed `201`; `302` for a lone redirect; a POST's lone
   * `200`. Present exactly when the operation declares at least one 2xx or
   * 3xx response, and absent when it declares none (only `default`, a range,
   * 4xx/5xx codes, an empty `responses` map or no `responses` key) — the
   * case where `response` is `unknown`. When `successResponses` is set, this
   * equals the `statusCode` of the entry `response` was taken from. Read it
   * to check or document the status an operation succeeds with instead of
   * guessing one from the HTTP method; the differ does not key or compare
   * by it.
   */
  responseStatusCode?: number;
  /**
   * Headers the primary success response declares (the one `response` is the
   * body of). Present only when the spec declares at least one. Each entry of
   * `successResponses` carries its own `headers`, but that list is only set
   * when an operation declares more than one 2xx or 3xx response (counted
   * together), so the primary response's headers need a home of their own.
   */
  responseHeaders?: ResponseHeader[];
  /**
   * Media types the primary success response declares under `content`, in
   * document order and exactly as written (`application/json; charset=utf-8`,
   * `application/vnd.api+json`, a wildcard such as `application/*`). Present
   * only when it declares at least one. Like `responseHeaders`, this lifts
   * the primary entry's `contentTypes`, because `successResponses` only
   * exists when an operation declares more than one 2xx or 3xx response.
   */
  responseContentTypes?: string[];
  /**
   * One entry per `responseContentTypes` entry, in the same order, with the
   * type that media type's schema resolves to. The entry for the media type
   * `response` was read from carries that same TypeRef. Present only when
   * `responseContentTypes` is.
   */
  responseContents?: ResponseContent[];
  /**
   * The `description` of the primary success response (the one `response` is
   * the body of), e.g. "The pet, with its owner." — often the clearest
   * statement of what an operation gives back, so an emitter can print it as
   * a `@returns` tag. Present only when that response declares one with
   * non-whitespace content; the text is kept verbatim. Each entry of
   * `successResponses` carries its own `description`, but that list is only
   * set when an operation declares more than one 2xx or 3xx response (counted
   * together), so the primary response's description needs a home of its own.
   */
  responseDescription?: string;
  /**
   * Every declared 2xx and 3xx response, one `SuccessResponse` per status
   * code, each with its own `type`, `headers` and `description`. A 2xx entry's
   * `type` is its body, read by media type compared by essence, parameters
   * and case aside (the JSON schema — `application/json`, else a `+json`
   * media type; else binary string for `application/octet-stream` /
   * `application/pdf`; else `string` for `text/plain`, `text/html`,
   * `text/xml`, `application/xml`; else the schema of the first media type
   * that declares one) and `unknown` when none applies, a schema-less
   * `text/csv` included; a 3xx entry's `type` is always
   * `unknown`, and the entry is kept so an emitter can
   * recognize a redirect endpoint. Set only when more than one such response
   * is declared, counting 2xx and 3xx together: `200` + `201`, `200` + `302`
   * and `301` + `302` all set it, while a lone `200` (or a lone `302`) leaves
   * it `undefined` and `response` / `responseHeaders` / `responseDescription`
   * describe that single response alone. 4xx and 5xx responses go to
   * `errors`; `default` and the ranges `1XX`–`5XX` to `defaultResponse` and
   * `rangeResponses`; an explicit 1xx code is not carried. A key is a status
   * code only when it is exactly three digits in 100–599: `6XX`, `4XXX`,
   * `20X`, `600` and `200 ` are no status code and no range, so they are
   * ignored with a warning, like `error`, never read from a numeric prefix.
   */
  successResponses?: SuccessResponse[];
  errors: ErrorResponse[];
  /**
   * The document's `default` response: what the operation returns for every
   * status it does not list explicitly or by range. Present only when the
   * spec declares one. It is kept apart from `errors` because it carries no
   * status code (`ErrorResponse.statusCode` is a number emitters compare and
   * format as one) and is not always an error — a spec may use it for its
   * success body too. An emitter should treat its `type` as the fallback for
   * any status that neither `errors`/`successResponses` nor `rangeResponses`
   * covers. `response` is never promoted from it: when the operation declares
   * no explicit 2xx, the emitter takes the success body from the `2XX` entry
   * of `rangeResponses`, then from here.
   */
  defaultResponse?: DefaultResponse;
  /**
   * The document's `1XX`–`5XX` range responses, in declaration order. Present
   * only when the spec declares at least one. A range covers every status in
   * its hundred that the operation does not list explicitly, so an emitter
   * resolves a status in the order OpenAPI does: the explicit entry, then
   * the range, then `defaultResponse`. Ranges never feed `response`,
   * `successResponses` or `errors`, whose numeric `statusCode` could not say
   * which codes an entry stands for.
   */
  rangeResponses?: RangeResponse[];
  pagination?: PaginationMeta;
  injectIdempotencyKey: boolean;
  deprecated?: boolean;
  async?: boolean;
  /**
   * The operation's `tags`, in document order, with every entry that is not
   * a non-empty string dropped and a repeated entry folded onto its first
   * occurrence. Present only when at least one remains. The parser names the
   * service from `tags[0]` — the first usable entry — so the two never
   * disagree; the list is kept so an emitter can group or document the
   * method by every tag.
   */
  tags?: string[];
  /**
   * Per-operation security requirements, mirroring the OpenAPI document:
   * - `undefined` — the operation declares nothing and inherits
   *   `ApiSpec.security` (which may itself be `undefined`).
   * - `[]` — `security: []`: the operation needs no authentication.
   * - otherwise one `SecurityRequirementSet` per requirement object; the
   *   request must satisfy any one set, and every scheme within it.
   */
  security?: SecurityRequirementSet[];
  /**
   * Mutually-exclusive parameter groups parsed from `x-mutually-exclusive-parameter-groups`.
   * Each group represents a logical choice the caller must (or may) make between
   * several subsets of query/path/header parameters. The grouped parameters remain
   * in their original arrays (queryParams, pathParams, etc.) for wire-format purposes;
   * this field adds the grouping metadata so emitters can render sum types.
   */
  parameterGroups?: ParameterGroup[];
}

/**
 * A mutually-exclusive parameter group. The caller must supply exactly one
 * variant (when `optional` is false) or may omit the group entirely (when true).
 */
export interface ParameterGroup {
  /** Group name from the extension (e.g. "parent_resource"). */
  name: string;
  /** True when the whole group may be omitted. */
  optional: boolean;
  /** Ordered variants (insertion order matches the spec). */
  variants: ParameterGroupVariant[];
  /**
   * Base name emitters must use for this group's generated wrapper type, in
   * place of `name`.
   *
   * Two operations commonly share one group name — create and update both
   * declare `protocol_options` — and emitters name the wrapper from the group
   * name alone, so both operations collapse onto one type. That is correct
   * only while their members agree. When they disagree (create's
   * `saml_options` is a `CreateConnectionSAMLOptions`, update's is a
   * `PatchConnectionSAMLOptions`) one wrapper silently forces one operation to
   * use the other operation's type.
   *
   * The parser therefore fingerprints each group's members across every
   * operation declaring it and qualifies this with the operation name
   * (`update_connection_protocol_options`) only where they genuinely diverge.
   * Groups that agree — including ones differing only by nullability, or by
   * duplicate inline enums carrying identical values — keep the bare group
   * name, so already-published wrapper types are never renamed.
   */
  wrapperName?: string;
}

/**
 * One variant within a mutually-exclusive parameter group.
 */
export interface ParameterGroupVariant {
  /** Variant name from the extension (e.g. "by_id", "by_external_id"). */
  name: string;
  /**
   * References to the actual parameter IR nodes. These are the same
   * objects that live in operation.queryParams / .pathParams / .headerParams --
   * shared by identity, not duplicated.
   */
  parameters: Parameter[];
  /**
   * Names of parameters that may be omitted when this variant is used —
   * optional modifiers of the variant's required fields, from the
   * extension's `optionalFields`. Absent means every parameter in the
   * variant is required with it.
   */
  optionalParameters?: string[];
}

/**
 * How an operation's list is paged — what an auto-paging iterator sends to
 * reach the next page:
 *
 * - `cursor` — `param` carries an opaque cursor taken from the previous
 *   response; iteration ends when the response yields no next cursor.
 * - `offset` — `param` is the number of items to skip; advance it by the
 *   number of items received, with `limitParam` as the page size.
 * - `page` — `param` is a page *number*; start at `pageStart` (the
 *   parameter's `default`, else its `minimum`, else 1) and advance it by
 *   exactly one per request, with `limitParam` as the page size.
 * - `link-header` — follow the RFC 5988 `Link: <…>; rel="next"` response
 *   header instead of building the next request from `param`.
 *
 * Under every strategy an empty page ends the iteration; `endOfIteration`
 * names a response field that ends it earlier.
 */
export type PaginationStrategy = 'cursor' | 'offset' | 'page' | 'link-header';

/**
 * The response field that tells an iterator the last page has been reached.
 * `path` is a dotted property path from the response root, in the convention
 * `dataPath` uses: `has_more` at the top level, `pagination.totalPages` one
 * level down inside the pagination companion.
 *
 * - `hasMore` — a boolean; stop when it is `false`.
 * - `totalPages` — an integer count of pages; stop once the pages fetched so
 *   far reach it. For the `page` strategy that is
 *   `page - pageStart + 1 >= totalPages` — `page >= totalPages` when pages
 *   start at 1, `page + 1 >= totalPages` when they start at 0 — and for
 *   `offset` it is `floor(offset / limit) + 1 >= totalPages`.
 * - `totalCount` — an integer count of items; stop once the items received
 *   so far reach it.
 *
 * An empty page ends the iteration under every kind and every strategy.
 */
export interface PaginationEndOfIteration {
  kind: 'hasMore' | 'totalPages' | 'totalCount';
  path: string;
}

/** Structured pagination metadata for auto-paging iterator generation */
export interface PaginationMeta {
  strategy: PaginationStrategy;
  /** Query parameter that selects the page: the cursor, the offset, or the page number. */
  param: string;
  /** Query parameter that sets the page size (`offset` and `page` strategies). */
  limitParam?: string;
  /**
   * First page number the API expects; set for the `page` strategy only. The
   * page parameter's integer `default`, else its `minimum`, else 1 — read
   * from the parameter's schema as written, through a `$ref`, `allOf`
   * members and nullable wrappers — or the value an override sets. An
   * iterator sends `pageStart` first and `pageStart + n` after `n` pages;
   * `PaginationEndOfIteration` shows how the base enters the `totalPages`
   * stop rule, so emitters never re-derive it.
   */
  pageStart?: number;
  dataPath?: string;
  /**
   * The description the document gives the data array property itself — the
   * one `dataPath` names — so an emitter that documents what a list method
   * returns can read it here instead of from the document. Like a `Field`'s
   * `description` it is the property's own text, never the item schema's.
   *
   * Present only when the property declares one; absent whenever `dataPath`
   * is, since there is no property to take it from.
   */
  dataDescription?: string;
  itemType: TypeRef;
  /**
   * Every property the list envelope carries besides the data array, in
   * document order: the pagination companion (`list_metadata`, `pagination`,
   * `has_more`, …) and any discriminant such as `object: "list"`. Together
   * with `dataPath` and `itemType` this is the envelope's full shape, so an
   * emitter can type what the endpoint returns and read the page details it
   * needs for the next request without parsing the document itself.
   *
   * An inline companion object is lifted to a model. Because the same envelope
   * recurs on every list endpoint of an API, copies that agree structurally
   * share one model named from the property alone (`list_metadata` →
   * `ListMetadata`, or the component schema of that name when one exists); a
   * copy whose shape differs keeps an operation-qualified name
   * (`ListUsersListMetadata`) so it can never change another type's shape.
   *
   * Absent when the response is a bare array, or when pagination was inferred
   * from query parameters alone and no envelope was detected.
   */
  envelopeFields?: Field[];
  /**
   * Where the response says the iteration is over (see
   * `PaginationEndOfIteration`). Detected from a recognized list envelope
   * when it carries an obvious field — a boolean `has_more`/`hasMore`, an
   * integer `total_pages`/`totalPages`, or an integer `total`/`total_count` —
   * at the top level or one level down inside a companion object
   * (`pagination.totalPages`); a `hasMore` field is preferred over a
   * `totalPages` one, which is preferred over a count. The operation's
   * `x-pagination` extension or its `operationHints` entry can set it
   * explicitly. Absent when nothing recognizable is declared; an emitter then
   * stops on an empty page (and, for `cursor`, on a missing next cursor).
   */
  endOfIteration?: PaginationEndOfIteration;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'trace';

/**
 * JSON Schema validation keywords declared directly on a schema, carried so an
 * emitter can document a value's limits ("at most 100"), check a value before
 * sending it, or keep a generated example within range. Every member is
 * optional and present only when the document declares it; a schema with no
 * validation keyword has no `constraints` at all.
 *
 * Numeric bounds use the OpenAPI 3.1 / JSON Schema 2020-12 shape, where
 * `exclusiveMinimum` / `exclusiveMaximum` are the bound itself. OpenAPI 3.0
 * spells them as booleans that make `minimum` / `maximum` exclusive; the
 * parser normalizes that form, so `{ minimum: 0, exclusiveMinimum: true }`
 * arrives as `{ exclusiveMinimum: 0 }` with no `minimum`, and a `false` is
 * dropped. Emitters read one shape whichever version produced it.
 *
 * The keywords on the field, parameter or model schema itself are carried,
 * conjoined with those of its inline `allOf` members (a single-member
 * `allOf` is unwrapped by the parser, so its limit is the value's own; a
 * `$ref` member contributes the keywords written beside the reference while
 * the referenced model keeps its own). Limits nested inside array `items` or
 * map values are not carried. A nullable wrapper — `oneOf`/`anyOf` with a
 * single non-null, non-`$ref` branch — conjoins that branch's keywords with
 * its own; limits on a general multi-variant union are not carried.
 */
export interface Constraints {
  /** Inclusive lower bound (`minimum`). */
  minimum?: number;
  /** Inclusive upper bound (`maximum`). */
  maximum?: number;
  /** Exclusive lower bound as a number; the OAS 3.0 boolean form is normalized to this. */
  exclusiveMinimum?: number;
  /** Exclusive upper bound as a number; the OAS 3.0 boolean form is normalized to this. */
  exclusiveMaximum?: number;
  /** The value must be an integer multiple of this (`multipleOf`). */
  multipleOf?: number;
  /** Minimum string length in characters (`minLength`). */
  minLength?: number;
  /** Maximum string length in characters (`maxLength`). */
  maxLength?: number;
  /** ECMA-262 regular expression the string must match (`pattern`), verbatim from the document. */
  pattern?: string;
  /** Minimum number of array items (`minItems`). */
  minItems?: number;
  /** Maximum number of array items (`maxItems`). */
  maxItems?: number;
  /** Present, and `true`, when array items must be unique; `uniqueItems: false` restates the default and is dropped. */
  uniqueItems?: boolean;
  /** Minimum number of items matching the schema's `contains` (`minContains`). */
  minContains?: number;
  /** Maximum number of items matching the schema's `contains` (`maxContains`). */
  maxContains?: number;
  /** Minimum number of object properties (`minProperties`). */
  minProperties?: number;
  /** Maximum number of object properties (`maxProperties`). */
  maxProperties?: number;
  /** Property name → properties that must also be present when it is (`dependentRequired`). */
  dependentRequired?: Record<string, string[]>;
}

export interface Parameter {
  name: string;
  type: TypeRef;
  required: boolean;
  description?: string;
  deprecated?: boolean;
  /**
   * The parameter schema's `externalDocs`, when it declares a usable one;
   * a schema that is a `$ref` falls back to the component it points at,
   * the way `description` and `deprecated` do. A Parameter Object has no
   * `externalDocs` of its own. Absent when neither level gives one.
   */
  externalDocs?: ExternalDocs;
  default?: unknown;
  /**
   * A single illustrative value, resolved level by level: the parameter's own
   * `example` (else the first entry of its `examples` map), then its inline
   * schema's `example` (else the first of its `examples` list), then the same
   * on the component schema its `$ref` points at. A level with neither falls
   * through; an explicit `null` is kept. Absent when no level gives one.
   */
  example?: unknown;
  /**
   * Every example value the document gives, in document order: the
   * parameter's `examples` map of Example Objects (each entry's `value`, with
   * `$ref`s resolved against `components.examples`), else the JSON Schema
   * `examples` list on its inline schema, else the list on the component
   * schema its `$ref` points at. Present only when at least one value exists.
   */
  examples?: unknown[];
  style?: 'form' | 'simple' | 'label' | 'matrix';
  explode?: boolean;
  /**
   * Validation keywords from the parameter's schema. When that schema is a
   * `$ref`, the target's keywords are merged underneath the parameter's own
   * — the per-value fallback `default` and `example` use — so a parameter
   * can be read on its own without chasing the fieldless alias model the
   * target also becomes. Absent when neither declares any.
   */
  constraints?: Constraints;
}

/** Type reference — the core type system of the IR */
export type TypeRef = PrimitiveType | ArrayType | ModelRef | EnumRef | UnionType | NullableType | LiteralType | MapType;

export interface PrimitiveType {
  kind: 'primitive';
  type: 'string' | 'integer' | 'number' | 'boolean' | 'unknown';
  format?: string;
}

export interface ArrayType {
  kind: 'array';
  items: TypeRef;
}

export interface ModelRef {
  kind: 'model';
  name: string;
}

export interface EnumRef {
  kind: 'enum';
  name: string;
  values?: (string | number)[];
}

export interface LiteralType {
  kind: 'literal';
  value: string | number | boolean | null;
}

export interface UnionType {
  kind: 'union';
  variants: TypeRef[];
  discriminator?: { property: string; mapping: Record<string, string> };
  /** Which OAS composition keyword produced this union. Emitters can use this to
   *  distinguish inheritance (allOf) from exclusive union (oneOf) from open union (anyOf). */
  compositionKind?: 'allOf' | 'oneOf' | 'anyOf';
}

export interface NullableType {
  kind: 'nullable';
  inner: TypeRef;
}

export interface MapType {
  kind: 'map';
  valueType: TypeRef;
  keyType?: TypeRef;
}

/**
 * A generic type parameter on a model.
 * Example: `DirectoryUser<TCustomAttributes = Record<string, unknown>>`
 * → `{ name: 'TCustomAttributes', default: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } } }`
 */
export interface TypeParam {
  name: string;
  /** Default type when the param is not specified. */
  default?: TypeRef;
}

/** Model definition (maps to an SDK model/data class) */
export interface Model {
  name: string;
  description?: string;
  /** The schema's `externalDocs`, when it declares a usable one. */
  externalDocs?: ExternalDocs;
  /**
   * Present, and `true`, when the schema this model was built from says
   * `deprecated: true` — a component, a discriminated-union variant, or an
   * inline request body, response or field object. Only that schema's own
   * top-level keyword counts, read as `Field.deprecated` is: an `allOf`
   * member's or a nullable branch's flag is not read (a `$ref` member's stays
   * on the referenced model), and a folded `<Name>Json` model's flag does not
   * deprecate the `<Name>` it collapses into. Absent otherwise.
   */
  deprecated?: boolean;
  fields: Field[];
  /** Generic type parameters. Empty/undefined for non-generic models. */
  typeParams?: TypeParam[];
  /**
   * Set when the model is a named union: a component schema that is itself a
   * `oneOf`/`anyOf` with no `properties` of its own. One TypeRef per non-null
   * variant, in document order, built exactly as an inline union's are: a
   * `$ref` variant is a `model`/`enum` ref, an inline object variant is a ref
   * to a model extracted for it (named from this model with the inline
   * variant rules, never this model's own name), a primitive stays a
   * primitive. A `type: 'null'` variant is dropped, as an inline union lifts
   * it into a `nullable` wrapper; a Model has no such wrapper. `fields` keeps
   * the optional merge of the inline variants' properties it always had, so
   * an emitter that does not read `variants` sees the same model as before.
   */
  variants?: TypeRef[];
  /** Which composition keyword produced `variants`. Present exactly when `variants` is. */
  compositionKind?: 'oneOf' | 'anyOf';
  /**
   * When set, this model is a discriminated union — over its `variants` (a
   * named `oneOf`/`anyOf` with a `discriminator:` keyword or a const-pinned
   * property shared by every variant) or over allOf+oneOf variants (where
   * `variants` is absent and the mapping alone names them). Emitters should
   * generate a dispatcher (factory) instead of a regular dataclass. The
   * `property` field is the discriminator key (e.g. "event"), and `mapping`
   * maps each discriminator value to the concrete variant model name (an IR
   * model name, after `schemaNameTransform`).
   */
  discriminator?: {
    property: string;
    mapping: Record<string, string>;
  };
  /**
   * Validation keywords declared on the model's own schema — for an object
   * schema, `minProperties`, `maxProperties` and `dependentRequired`. Absent
   * when the schema declares none.
   */
  constraints?: Constraints;
}

export interface Field {
  name: string;
  /**
   * Optional domain-facing name override. When set, emitters derive the
   * domain-side identifier (in their own casing) from this instead of `name`,
   * while serialization still uses `name` for the wire key. Lets an SDK expose
   * a wire field under a friendlier name (e.g. `connection_type` → `type`)
   * without changing the API contract. Set via the `fieldHints` config and
   * honored by any emitter that reads it.
   */
  domainName?: string;
  type: TypeRef;
  required: boolean;
  description?: string;
  /**
   * The field schema's own `externalDocs`, when it declares a usable one —
   * read like `description`: for a `$ref` with an `externalDocs` sibling
   * (legal in OAS 3.1), the sibling's link, while the referenced model keeps
   * its own; a bare `$ref` yields none. Absent otherwise. Documentation, not
   * shape: two fields that differ only here are one shape.
   */
  externalDocs?: ExternalDocs;
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  default?: unknown;
  /**
   * A single illustrative value. The field schema's `example` when present,
   * otherwise the first entry of its `examples`; when the schema is a `$ref`
   * with neither, the same taken from the component it points at. An
   * explicit `null` is kept. Absent when no level gives one.
   */
  example?: unknown;
  /**
   * Every example value the schema gives, in document order, from the JSON
   * Schema `examples` list (OAS 3.1 deprecates `example` in its favour) —
   * on the field schema, else on the component its `$ref` points at.
   * Present only when the list has at least one entry.
   */
  examples?: unknown[];
  /**
   * Validation keywords declared on the field's schema, including any
   * written beside a `$ref` (OpenAPI 3.1 allows siblings). Absent when the
   * schema declares none; a bare `$ref` yields none, since the referenced
   * model carries its own limits.
   */
  constraints?: Constraints;
}

/** Enum definition */
export interface Enum {
  name: string;
  /**
   * The component enum schema's own `description`, as `Model.description`
   * is a component model's. Present only when it has non-whitespace
   * content. An enum lifted from an inline schema carries none: that
   * schema's text is the field's or parameter's description.
   */
  description?: string;
  values: EnumValue[];
  /** Spec-level default value (the value of `default:` on the schema). Optional. */
  default?: string | number;
  /**
   * The enum schema's `externalDocs`, when it declares a usable one: a
   * component enum's own, or — for an enum lifted from an inline schema on a
   * property, parameter or response header — that schema's. A nullable
   * wrapper the parser collapses carries its link onto the enum, as it does
   * onto a model; when several inline schemas lift to one name, the first
   * lifted gives the link, as it gives the values.
   */
  externalDocs?: ExternalDocs;
  /** Present, and `true`, when the component enum schema says `deprecated: true`; absent otherwise. */
  deprecated?: boolean;
}

/**
 * One member of an enum. An enum schema is an `enum:` list or a
 * `oneOf`/`anyOf` whose every non-null variant is a string `const` schema
 * (the OAS 3.1 spelling that documents values one by one); both give one
 * `EnumValue` per member, in document order.
 */
export interface EnumValue {
  /** UPPER_SNAKE_CASE form of `value`. */
  name: string;
  /** The value as written; a number stays a number. */
  value: string | number;
  /**
   * The value's own documentation: a `const` member's `description`, else
   * the entry for the value in the enum schema's `x-enum-descriptions` /
   * `x-enumDescriptions` extension. Present only when that text has
   * non-whitespace content; absent otherwise.
   */
  description?: string;
  /**
   * Present, and `true`, when the value's `const` member says
   * `deprecated: true`; absent otherwise. An `enum:` list has no per-value
   * keyword, so its values never carry it.
   */
  deprecated?: boolean;
}

/**
 * Exhaustive check helper for TypeRef switches.
 * If a new kind is added to TypeRef, any switch that doesn't handle it
 * will fail to compile because `never` won't accept the unhandled variant.
 *
 * Usage:
 *   switch (ref.kind) {
 *     case 'primitive': ...
 *     case 'array': ...
 *     // If you forget 'literal', TypeScript errors here:
 *     default: assertNever(ref);
 *   }
 */
export function assertNever(x: never): never {
  // Inline to avoid importing from ../errors.js (ir/ is layer 0, must not import upward)
  const kind = (x as TypeRef).kind;
  const err = new Error(
    `Unexpected TypeRef kind: ${kind}\nHint: If you added a new TypeRef variant, handle it in every switch/case that calls assertNever.`,
  );
  err.name = 'InternalError';
  throw err;
}

/**
 * Generic depth-first walker for TypeRef trees.
 * Handles recursion into array/nullable/union/map children and provides
 * an exhaustive `assertNever` check so callers don't need to repeat the
 * switch boilerplate.  Supply callbacks only for the leaf kinds you care about.
 */
export function walkTypeRef(
  ref: TypeRef,
  visitor: {
    model?: (ref: ModelRef) => void;
    enum?: (ref: EnumRef) => void;
    primitive?: (ref: PrimitiveType) => void;
    literal?: (ref: LiteralType) => void;
  },
): void {
  switch (ref.kind) {
    case 'model':
      visitor.model?.(ref);
      break;
    case 'enum':
      visitor.enum?.(ref);
      break;
    case 'array':
      walkTypeRef(ref.items, visitor);
      break;
    case 'nullable':
      walkTypeRef(ref.inner, visitor);
      break;
    case 'union':
      for (const v of ref.variants) walkTypeRef(v, visitor);
      break;
    case 'map':
      if (ref.keyType) walkTypeRef(ref.keyType, visitor);
      walkTypeRef(ref.valueType, visitor);
      break;
    case 'literal':
      visitor.literal?.(ref);
      break;
    case 'primitive':
      visitor.primitive?.(ref);
      break;
    default:
      assertNever(ref);
  }
}

/**
 * Generic depth-first mapper for TypeRef trees.
 * Like walkTypeRef but returns a transformed value instead of void.
 * Handles recursion into array/nullable/union/map children, passing
 * already-mapped child values to the parent callback.
 */
export function mapTypeRef<T>(
  ref: TypeRef,
  mapper: {
    primitive: (ref: PrimitiveType) => T;
    array: (ref: ArrayType, mappedItems: T) => T;
    model: (ref: ModelRef) => T;
    enum: (ref: EnumRef) => T;
    union: (ref: UnionType, mappedVariants: T[]) => T;
    nullable: (ref: NullableType, mappedInner: T) => T;
    literal: (ref: LiteralType) => T;
    map: (ref: MapType, mappedValue: T, mappedKey?: T) => T;
  },
): T {
  switch (ref.kind) {
    case 'primitive':
      return mapper.primitive(ref);
    case 'array':
      return mapper.array(ref, mapTypeRef(ref.items, mapper));
    case 'model':
      return mapper.model(ref);
    case 'enum':
      return mapper.enum(ref);
    case 'union':
      return mapper.union(
        ref,
        ref.variants.map((v) => mapTypeRef(v, mapper)),
      );
    case 'nullable':
      return mapper.nullable(ref, mapTypeRef(ref.inner, mapper));
    case 'literal':
      return mapper.literal(ref);
    case 'map':
      return mapper.map(
        ref,
        mapTypeRef(ref.valueType, mapper),
        ref.keyType ? mapTypeRef(ref.keyType, mapper) : undefined,
      );
    default:
      return assertNever(ref);
  }
}

// --- IR traversal utilities ---

/**
 * Every TypeRef a model owns: each field's type, then each union variant
 * (`Model.variants`). Every pass that walks a model's type refs (reachability,
 * service assignment, ref rewriting and validation, dependency collection,
 * inline-enum promotion, fingerprinting) goes through this so a type reached
 * only through a named union's variant is treated the way a field type is.
 */
export function collectModelTypeRefs(model: Model): TypeRef[] {
  return [...model.fields.map((field) => field.type), ...(model.variants ?? [])];
}

/**
 * Rename the models a model refers to: every `model` ref in its fields' types
 * and its union variants, and every `discriminator.mapping` target, that
 * `renames` maps is pointed at the new name. Each reference is looked up
 * once, so a map `{ A → B, B → C }` moves `A` to `B`, never on to `C`. The
 * model's own `name` is left to the caller. Every rename and fold site goes
 * through this, so a dispatcher's mapping can never keep naming a model that
 * was renamed away while its variants moved on.
 */
export function renameModelRefs(model: Model, renames: ReadonlyMap<string, string>): void {
  for (const ref of collectModelTypeRefs(model)) {
    walkTypeRef(ref, {
      model: (r) => {
        const renamed = renames.get(r.name);
        if (renamed !== undefined) r.name = renamed;
      },
    });
  }
  const mapping = model.discriminator?.mapping;
  if (!mapping) return;
  for (const [value, target] of Object.entries(mapping)) {
    const renamed = renames.get(target);
    if (renamed !== undefined) mapping[value] = renamed;
  }
}

/**
 * Collect all model names referenced (directly or transitively) by a TypeRef.
 */
export function collectModelRefs(ref: TypeRef): string[] {
  const names: string[] = [];
  walkTypeRef(ref, { model: (r) => names.push(r.name) });
  return names;
}

/**
 * Collect all enum names referenced by a TypeRef.
 */
export function collectEnumRefs(ref: TypeRef): string[] {
  const names: string[] = [];
  walkTypeRef(ref, { enum: (r) => names.push(r.name) });
  return names;
}

/**
 * Collect all TypeRef-referenced model and enum names from a model's fields
 * and, for a named union, its variants.
 * Returns { models, enums } sets for generating import statements.
 */
export function collectFieldDependencies(model: Model): {
  models: Set<string>;
  enums: Set<string>;
} {
  const models = new Set<string>();
  const enums = new Set<string>();

  for (const ref of collectModelTypeRefs(model)) {
    for (const name of collectModelRefs(ref)) {
      if (name !== model.name) models.add(name);
    }
    for (const name of collectEnumRefs(ref)) {
      enums.add(name);
    }
  }

  return { models, enums };
}

/**
 * Assign each model to the service that first references it.
 * Models referenced by multiple services are assigned to the first.
 * Models not referenced by any service are unassigned (absent from the map).
 *
 * @param hints - Optional pin overrides keyed by IR model name → IR service
 *   name. Applied after the natural assignment loop. A hint only pins a model
 *   present in THIS `models` slice; the target service is resolved by name
 *   downstream, so a hint pointing at a service outside `services` still lands
 *   the model in the right directory. Callers may pass a PARTIAL slice (e.g.
 *   discriminated-union planning, per-service barrels, or a `--services`-scoped
 *   run), so this function never rejects a hint — typo validation lives in
 *   {@link validateModelHints}, which runs once against the full spec.
 */
export function assignModelsToServices(
  models: Model[],
  services: Service[],
  hints?: Record<string, string>,
): Map<string, string> {
  const modelToService = new Map<string, string>();
  const modelNames = new Set(models.map((m) => m.name));

  for (const service of services) {
    const referencedModels = new Set<string>();

    for (const op of service.operations) {
      if (op.requestBody) {
        for (const name of collectModelRefs(op.requestBody)) {
          referencedModels.add(name);
        }
      }
      for (const name of collectModelRefs(op.response)) {
        referencedModels.add(name);
      }
      for (const param of [
        ...op.pathParams,
        ...op.queryParams,
        ...(op.bodyOwnedQueryParams ?? []),
        ...op.headerParams,
        ...(op.cookieParams ?? []),
      ]) {
        for (const name of collectModelRefs(param.type)) {
          referencedModels.add(name);
        }
      }
      if (op.pagination) {
        for (const name of collectModelRefs(op.pagination.itemType)) {
          referencedModels.add(name);
        }
        for (const field of op.pagination.envelopeFields ?? []) {
          for (const name of collectModelRefs(field.type)) {
            referencedModels.add(name);
          }
        }
      }
      for (const error of op.errors) {
        if (!error.type) continue;
        for (const name of collectModelRefs(error.type)) {
          referencedModels.add(name);
        }
      }
      for (const header of collectResponseHeaders(op)) {
        for (const name of collectModelRefs(header.type)) {
          referencedModels.add(name);
        }
      }
      for (const { type } of collectResponseBodyTypes(op)) {
        for (const name of collectModelRefs(type)) {
          referencedModels.add(name);
        }
      }
      for (const { type } of collectRequestBodyTypes(op)) {
        for (const name of collectModelRefs(type)) {
          referencedModels.add(name);
        }
      }
    }

    // Transitively collect models referenced by the directly-referenced models
    // (through their fields and, for a named union, its variants)
    const toVisit = [...referencedModels];
    while (toVisit.length > 0) {
      const name = toVisit.pop()!;
      const model = models.find((m) => m.name === name);
      if (!model) continue;
      for (const typeRef of collectModelTypeRefs(model)) {
        for (const ref of collectModelRefs(typeRef)) {
          if (!referencedModels.has(ref) && modelNames.has(ref)) {
            referencedModels.add(ref);
            toVisit.push(ref);
          }
        }
      }
    }

    for (const name of referencedModels) {
      if (!modelToService.has(name)) {
        modelToService.set(name, service.name);
      }
    }
  }

  if (hints) {
    for (const [modelName, serviceName] of Object.entries(hints)) {
      // Only pin models present in THIS slice; an out-of-slice hint is applied
      // where its own slice is processed. The target service resolves by name
      // downstream, so it need not appear in this slice's `services`. Genuine
      // typos are caught up front by validateModelHints against the full spec.
      if (!modelNames.has(modelName)) continue;
      modelToService.set(modelName, serviceName);
    }
  }

  return modelToService;
}

/**
 * Validate model-placement hints against the FULL spec. Run once at the start of
 * generation — where the complete model/service universe is known — so typos in
 * `modelHints` fail loud even though {@link assignModelsToServices} is
 * intentionally lenient about the partial slices it may be handed.
 */
export function validateModelHints(models: Model[], services: Service[], hints: Record<string, string>): void {
  const modelNames = new Set(models.map((m) => m.name));
  const serviceNames = new Set(services.map((s) => s.name));
  for (const [modelName, serviceName] of Object.entries(hints)) {
    if (!modelNames.has(modelName)) {
      const err = new Error(
        `modelHints: unknown model "${modelName}". Hint keys must match an IR model name (post-cleanSchemaName/schemaNameTransform).`,
      );
      err.name = 'ConfigError';
      throw err;
    }
    if (!serviceNames.has(serviceName)) {
      const err = new Error(
        `modelHints: unknown service "${serviceName}" for model "${modelName}". Hint values must match an IR service name (PascalCase, derived from the operation's first tag).`,
      );
      err.name = 'ConfigError';
      throw err;
    }
  }
}

/**
 * Collect all model names referenced as request bodies across all services:
 * each operation's `requestBody`, and the body of every other media type it
 * declares (`collectRequestBodyTypes`).
 */
export function collectRequestBodyModels(services: Service[]): Set<string> {
  const result = new Set<string>();
  for (const service of services) {
    for (const op of service.operations) {
      if (op.requestBody) {
        for (const name of collectModelRefs(op.requestBody)) {
          result.add(name);
        }
      }
      for (const { type } of collectRequestBodyTypes(op)) {
        for (const name of collectModelRefs(type)) {
          result.add(name);
        }
      }
    }
  }
  return result;
}

/**
 * Every response header an operation declares: the primary response's, each
 * alternate success entry's, and each error entry's. The primary list is the
 * same array as its `successResponses` entry when both exist, so it is yielded
 * once. Every pass that walks an operation's type refs (reachability, model
 * assignment, ref rewriting and validation, direction, compat filtering, enum
 * collection) goes through this so a type reached only through a header is
 * treated the way a body or parameter type is.
 */
export function collectResponseHeaders(op: Operation): ResponseHeader[] {
  const result: ResponseHeader[] = [];
  const seen = new Set<ResponseHeader[]>();
  const lists = [
    op.responseHeaders,
    ...(op.successResponses ?? []).map((r) => r.headers),
    ...op.errors.map((e) => e.headers),
    op.defaultResponse?.headers,
    ...(op.rangeResponses ?? []).map((r) => r.headers),
  ];
  for (const list of lists) {
    if (!list || seen.has(list)) continue;
    seen.add(list);
    result.push(...list);
  }
  return result;
}

/**
 * The body type of every fallback response an operation declares: the
 * `default` response's, then each range response's in declaration order,
 * skipping entries that declare no body. Feeds `collectResponseBodyTypes`,
 * which every pass that walks an operation's type refs goes through (as it
 * goes through `collectResponseHeaders` for headers), so a model reached
 * only as the body of a `default` or `4XX` response is materialized,
 * assigned, renamed and validated like a primary response body.
 */
export function collectFallbackResponseTypes(op: Operation): TypeRef[] {
  const result: TypeRef[] = [];
  if (op.defaultResponse?.type) result.push(op.defaultResponse.type);
  for (const range of op.rangeResponses ?? []) {
    if (range.type) result.push(range.type);
  }
  return result;
}

/**
 * Every type reference a webhook carries: its parameters' types, its
 * request body, and the payload of every other media type it declares (each
 * `requestBodyContents` entry whose type is not `requestBody`'s own). Every
 * pass that walks an operation's type refs (reachability, ref rewriting and
 * validation, the differ's direction index, inline-enum collection) walks a
 * webhook's through this, so a model reached only through a webhook payload
 * or header is treated the way one reached through an operation is, and a
 * field added to `Webhook` later has one place to join.
 */
export function collectWebhookTypeRefs(webhook: Webhook): TypeRef[] {
  const refs: TypeRef[] = [];
  for (const param of [...webhook.headerParams, ...webhook.queryParams, ...(webhook.cookieParams ?? [])]) {
    refs.push(param.type);
  }
  if (webhook.requestBody) refs.push(webhook.requestBody);
  for (const content of webhook.requestBodyContents ?? []) {
    if (content.type !== webhook.requestBody) refs.push(content.type);
  }
  return refs;
}

/**
 * A header a response declares, typed like a parameter. `name` is kept exactly
 * as written in the spec (e.g. `Content-Disposition`); emitters apply their
 * own casing.
 */
export interface ResponseHeader {
  name: string;
  type: TypeRef;
  required: boolean;
  description?: string;
  deprecated?: boolean;
  /**
   * The header schema's `externalDocs`, when it declares a usable one — the
   * `schema` of the Header Object (resolved through `components/headers`), or
   * the schema of its single `content` entry. A Header Object has no
   * `externalDocs` of its own. Absent otherwise.
   */
  externalDocs?: ExternalDocs;
}

export interface ErrorResponse {
  statusCode: number;
  type?: TypeRef;
  /** Declared response headers. Present only when the spec declares at least one. */
  headers?: ResponseHeader[];
  /**
   * Media types declared under `content`, in document order and as written.
   * `type` is by definition the JSON body (`application/json`, else the first
   * `+json` media type), so the list is present only when it says something
   * `type` does not: the error declares another media type, a JSON media type
   * other than plain `application/json` (`application/problem+json` alone,
   * `application/json; charset=utf-8`), or a JSON body `type` could not be
   * read from. An error that declares only `application/json` with a schema
   * keeps its shape.
   */
  contentTypes?: string[];
  /**
   * One entry per `contentTypes` entry, in the same order. The entry for the
   * media type `type` was read from carries the same TypeRef as `type`.
   * Present only when `contentTypes` is.
   */
  contents?: ResponseContent[];
  /**
   * The response's `description` as written in the document (e.g. "Not
   * found"). Present only when it has non-whitespace content; kept verbatim.
   */
  description?: string;
}

/**
 * One entry of `Operation.successResponses`: a declared 2xx or 3xx response.
 * A 3xx entry's `type` is always `unknown`. A 2xx body that is itself an
 * inline enum, or an array of one, is promoted to `spec.enums` as
 * `<Op>Response`; every entry derives that same name, so a second body with
 * other members is qualified with its status code (`CheckPetKindResponse202`),
 * while identical members share one enum.
 */
export interface SuccessResponse {
  statusCode: number;
  type: TypeRef;
  /** Declared response headers. Present only when the spec declares at least one. */
  headers?: ResponseHeader[];
  /**
   * Media types declared under `content`, in document order and as written.
   * Present only when there is at least one.
   */
  contentTypes?: string[];
  /**
   * One entry per `contentTypes` entry, in the same order. The entry for the
   * media type `type` was read from carries that same TypeRef. Present only
   * when `contentTypes` is.
   */
  contents?: ResponseContent[];
  /**
   * The response's `description` as written in the document (e.g. "The pet,
   * with its owner."). Present only when it has non-whitespace content; kept
   * verbatim.
   */
  description?: string;
}

/**
 * One media type a response declares under `content`, with the type its
 * schema resolves to. `contentType` is kept exactly as written in the spec,
 * parameters and all, so it can be sent back verbatim in an `Accept` header.
 */
export interface ResponseContent {
  contentType: string;
  type: TypeRef;
}

/**
 * One media type a request body declares under `content`, with the type it
 * resolves to. `contentType` is kept exactly as written in the spec,
 * parameters and all, so it can be sent verbatim as a `Content-Type`.
 */
export interface RequestBodyContent {
  contentType: string;
  type: TypeRef;
}

/**
 * A response body type other than `Operation.response`, with where it comes
 * from for diagnostics.
 */
export interface ResponseBodyType {
  type: TypeRef;
  /**
   * The entry it belongs to: `contents.<media type>` for a secondary media
   * type, `defaultResponse` for the `default` response's body,
   * `rangeResponses.<range>` (`rangeResponses.4XX`) for a range response's.
   */
  source: string;
}

/**
 * Every response body type an operation declares besides `response`: the
 * bodies of its secondary media types (`collectAlternateResponseContents`,
 * fallback responses' included), then the fallback bodies of its `default`
 * and range responses (`collectFallbackResponseTypes`), and any body a later
 * field adds. The primary type of each alternate 2xx and error entry is not
 * included — walkers reach those through `successResponses[].type` and
 * `errors[].type` where they do today. Every pass that walks an operation's
 * type refs (reachability, model assignment, ref rewriting and validation,
 * direction, compat filtering, enum collection) calls this beside
 * `collectResponseHeaders`, so a new kind of body is reached everywhere by
 * extending this one function.
 */
export function collectResponseBodyTypes(op: Operation): ResponseBodyType[] {
  const result: ResponseBodyType[] = alternateResponseContents(op).map(({ content, source }) => ({
    type: content.type,
    source: `${source}.${content.contentType}`,
  }));
  if (op.defaultResponse?.type) result.push({ type: op.defaultResponse.type, source: 'defaultResponse' });
  for (const range of op.rangeResponses ?? []) {
    if (range.type) result.push({ type: range.type, source: `rangeResponses.${range.range}` });
  }
  return result;
}

/**
 * A request body type other than `Operation.requestBody`, with where it
 * comes from for diagnostics.
 */
export interface RequestBodyType {
  type: TypeRef;
  /** The entry it belongs to: `requestBodyContents.<media type>`. */
  source: string;
}

/**
 * Every request body type an operation declares besides `requestBody`: the
 * bodies of its other media types (`collectAlternateRequestBodyContents`).
 * The request-side twin of `collectResponseBodyTypes`: every pass that walks
 * an operation's type refs (reachability, model assignment, ref rewriting
 * and validation, direction, compat filtering, enum collection) calls this
 * beside it, so a body declared only for a secondary media type is reached
 * everywhere `requestBody` is, and a new kind of request body is reached
 * everywhere by extending this one function.
 */
export function collectRequestBodyTypes(op: Operation): RequestBodyType[] {
  return collectAlternateRequestBodyContents(op).map((content) => ({
    type: content.type,
    source: `requestBodyContents.${content.contentType}`,
  }));
}

/**
 * Every request content entry whose type is reachable only through it: the
 * entries of `requestBodyContents` other than the one `requestBody` was read
 * from, which shares that very TypeRef and is already reached through
 * `requestBody`. Every entry when no media type was read as `requestBody`.
 * Feeds `collectRequestBodyTypes`, which the walkers call.
 */
export function collectAlternateRequestBodyContents(op: Operation): RequestBodyContent[] {
  return (op.requestBodyContents ?? []).filter((content) => content.type !== op.requestBody);
}

/**
 * Every response content entry whose type is reachable only through it: the
 * entries of each success, error and fallback response other than the one
 * the response's own `type` was read from, which shares that very TypeRef
 * and is already reached through `response`, `successResponses[].type`,
 * `errors[].type` or `collectFallbackResponseTypes`. The primary list is the
 * same array as its `successResponses` entry when both exist, so it is
 * visited once. Feeds `collectResponseBodyTypes`, which the walkers call.
 */
export function collectAlternateResponseContents(op: Operation): ResponseContent[] {
  return alternateResponseContents(op).map(({ content }) => content);
}

/** `collectAlternateResponseContents`, each entry with the list it was read from (`contents`, `defaultResponse.contents`, `rangeResponses.4XX.contents`). */
function alternateResponseContents(op: Operation): Array<{ content: ResponseContent; source: string }> {
  const result: Array<{ content: ResponseContent; source: string }> = [];
  const seen = new Set<ResponseContent[]>();
  const owners: Array<{ contents?: ResponseContent[]; type?: TypeRef; source: string }> = [
    { contents: op.responseContents, type: op.response, source: 'contents' },
    ...(op.successResponses ?? []).map((entry) => ({ ...entry, source: 'contents' })),
    ...op.errors.map((entry) => ({ ...entry, source: 'contents' })),
    ...(op.defaultResponse ? [{ ...op.defaultResponse, source: 'defaultResponse.contents' }] : []),
    ...(op.rangeResponses ?? []).map((entry) => ({ ...entry, source: `rangeResponses.${entry.range}.contents` })),
  ];
  for (const { contents, type, source } of owners) {
    if (!contents || seen.has(contents)) continue;
    seen.add(contents);
    for (const content of contents) if (content.type !== type) result.push({ content, source });
  }
  return result;
}

/**
 * The `default` response: the body and headers for every status the
 * operation does not list. See `Operation.defaultResponse`.
 */
export interface DefaultResponse {
  /**
   * Response body type: the `application/json` body, else the first `+json`
   * one; absent when the response declares neither.
   */
  type?: TypeRef;
  /** Declared response headers. Present only when the spec declares at least one. */
  headers?: ResponseHeader[];
  /**
   * Media types declared under `content`, in document order and as written,
   * exactly as on `SuccessResponse`. Present only when there is at least one.
   */
  contentTypes?: string[];
  /**
   * One entry per `contentTypes` entry, in the same order. The entry for the
   * media type `type` was read from carries that same TypeRef. Present only
   * when `contentTypes` is.
   */
  contents?: ResponseContent[];
  /** The response's own `description`, as on `SuccessResponse`/`ErrorResponse`; present only with non-whitespace content. */
  description?: string;
}

/** A Responses Object range key, uppercase as OpenAPI writes it (`4xx` is read as `4XX`). */
export type StatusRange = '1XX' | '2XX' | '3XX' | '4XX' | '5XX';

/**
 * A range response: the body and headers for every status in one hundred
 * (`4XX` → 400–499) that the operation does not list explicitly. See
 * `Operation.rangeResponses`.
 */
export interface RangeResponse {
  range: StatusRange;
  /**
   * Response body type: the `application/json` body, else the first `+json`
   * one; absent when the response declares neither.
   */
  type?: TypeRef;
  /** Declared response headers. Present only when the spec declares at least one. */
  headers?: ResponseHeader[];
  /** Media types declared under `content`, as on `DefaultResponse`. */
  contentTypes?: string[];
  /** One entry per `contentTypes` entry, as on `DefaultResponse`. */
  contents?: ResponseContent[];
  /** The response's own `description`, as on `SuccessResponse`/`ErrorResponse`; present only with non-whitespace content. */
  description?: string;
}
