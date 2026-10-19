# IR Type System Reference

Source: `src/ir/types.ts`, `src/ir/sdk-behavior.ts`

The intermediate representation (IR) is the contract between the parser and all language emitters. It uses plain TypeScript interfaces (no classes) with a discriminated union type system.

## Top-Level: ApiSpec

```typescript
interface ServerEntry {
  url: string;
  description?: string;
}

interface ApiSpec {
  name: string; // From info.title
  version: string; // From info.version
  description?: string; // From info.description
  externalDocs?: ExternalDocs; // The document's top-level externalDocs, when usable
  baseUrl: string; // From servers[0].url
  servers?: ServerEntry[]; // All servers from the spec
  services: Service[]; // Grouped operations
  models: Model[]; // Schema objects
  enums: Enum[]; // String enums
  auth?: AuthScheme[]; // Authentication schemes
  security?: SecurityRequirementSet[]; // Document-level default requirements (see Operation.security)
  sdk: SdkBehavior; // Runtime policies (retry, errors, telemetry, etc.)
}
```

The `servers` array contains all server entries from the OpenAPI spec. `baseUrl` is always set to the first server's URL for backward compatibility.

`security` is the document-level `security` list, in the same shape as `Operation.security`; every operation that declares no `security` of its own inherits it. It is `undefined` when the document declares none.

### ExternalDocs

```typescript
interface ExternalDocs {
  url: string; // Exactly as written in the document
  description?: string; // Only when it has non-whitespace content
}
```

An OpenAPI External Documentation Object — the document's way of linking to fuller documentation — carried on `ApiSpec` (the top-level `externalDocs`), `Service` (from the document tag, see below), `Operation`, `Model` and `Enum`, so an emitter can add it to a doc comment (a JSDoc `@see`, say). The key is present only when the document declares an entry with a non-blank `url`: a non-object, a missing or blank `url`, is dropped — silently, the way a malformed document tag is, since the parser ignored `externalDocs` entirely before and a malformed value must keep parsing. `url` is kept verbatim. OpenAPI allows it to be relative to the document's own location, which the parser does not know, so it is neither resolved nor rewritten, and `expandDocUrls` leaves it alone too; `expandDocUrls` does expand relative links inside `description`, which is CommonMark like every other description it walks. `description` is present only when it has non-whitespace content and is kept verbatim otherwise.

A `Model` built from an inline schema — a request body, a response, a `oneOf` variant, an object nested in a component field, array items, an `allOf` merge, a discriminated `allOf` + `oneOf` variant — carries the `externalDocs` of the schema it was built from. A wrapper the parser collapses or merges — a nullable `oneOf`/`anyOf` or `type: [..., "null"]`, a single-member `allOf`, an `allOf` response, field or nested-field merge — is the schema the document wrote, so the model built from what it unwraps or merges to carries the wrapper's link; a member's own stays on that member (a `$ref` member's on its component model), and a collapsed branch or member keeps its own link only when the wrapper has none. Every later pass that keeps, renames or merges models preserves the link; when `collapseJsonSuffixModels` folds `PetJson` into `Pet`, `Pet` keeps its own link as it keeps its own description, and takes `PetJson`'s only when it has none. An `Enum` carries the component schema's; an enum lifted from an inline field schema carries none.

### SdkBehavior

Source: `src/ir/sdk-behavior.ts`

Language-agnostic runtime policies consumed by emitters via `ctx.spec.sdk`. Always populated by the parser with `defaultSdkBehavior()`. Override per-SDK via `oagen.config.ts`.

```typescript
interface SdkBehavior {
  retry: RetryPolicy; // Retry status codes, max attempts, backoff strategy
  errors: ErrorPolicy; // Status code → exception kind mapping, doc URL template
  telemetry: TelemetryPolicy; // Request metrics header, request ID header
  pagination: PaginationPolicy; // Auto-page delay
  idempotency: IdempotencyPolicy; // Idempotency header name, auto-generate for POST
  logging: LoggingPolicy; // Log events and levels
  userAgent: UserAgentPolicy; // SDK identifier template, AI agent detection
  requestGuard: RequestGuardPolicy; // Misplaced-options key detection
  timeout: TimeoutPolicy; // Default timeout, env var override
}
```

Use `defaultSdkBehavior()` for canonical defaults. Use `mergeSdkBehavior(overrides)` for partial overrides (arrays replace, objects merge recursively).

## TypeRef (discriminated union)

Every type in the IR is a `TypeRef`, discriminated on the `kind` field:

| Kind        | Interface       | Example                                                              |
| ----------- | --------------- | -------------------------------------------------------------------- |
| `primitive` | `PrimitiveType` | `{ kind: "primitive", type: "string" }`                              |
| `array`     | `ArrayType`     | `{ kind: "array", items: { kind: "primitive", type: "string" } }`    |
| `model`     | `ModelRef`      | `{ kind: "model", name: "Organization" }`                            |
| `enum`      | `EnumRef`       | `{ kind: "enum", name: "Status", values?: ["active", "inactive"] }`  |
| `union`     | `UnionType`     | `{ kind: "union", variants: [...], discriminator?: {...} }`          |
| `nullable`  | `NullableType`  | `{ kind: "nullable", inner: { kind: "primitive", type: "string" } }` |
| `literal`   | `LiteralType`   | `{ kind: "literal", value: "active" }`                               |
| `map`       | `MapType`       | `{ kind: "map", valueType: { kind: "primitive", type: "string" } }`  |

### Primitive Formats

The `format` field on `PrimitiveType` carries additional type information:

| type      | format      | Semantic          |
| --------- | ----------- | ----------------- |
| `string`  | (none)      | Plain string      |
| `string`  | `date`      | ISO 8601 date     |
| `string`  | `date-time` | ISO 8601 datetime |
| `string`  | `uuid`      | UUID string       |
| `string`  | `binary`    | Binary data       |
| `integer` | (none)      | Integer           |
| `number`  | (none)      | Floating point    |
| `boolean` | (none)      | Boolean           |
| `unknown` | (none)      | Unknown/any type  |

### LiteralType

```typescript
interface LiteralType {
  kind: "literal";
  value: string | number | boolean | null;
}
```

Represents a fixed value. The `null` variant maps to language-specific null literals.

### MapType

```typescript
interface MapType {
  kind: "map";
  valueType: TypeRef;
  keyType?: TypeRef; // Defaults to string when absent
}
```

The optional `keyType` allows non-string map keys (e.g., enum-keyed maps). When absent, emitters should assume `string` keys.

A map's value schema is typed the same way an array's items are: with the owning field's name and parent model. When the value is an inline object (or an array or `oneOf` of inline objects), the parser extracts it as a model named by the parent plus the singularized field name, e.g. `layers` on `CreateDrawingRequest` → `CreateDrawingRequestLayer`, matching `shapes` → `CreateDrawingRequestShape` for array items. `additionalProperties: {}` or `true` keeps the value type `unknown`. The singular form is taken only when no sibling property of the same object would itself mint that name — an inline object, an inline enum, an inline union with object variants, or an array or map of such (a primitive `email` beside `emails` claims nothing); otherwise array items are `<Parent><Field>Item` (`DrawingLayersItem` beside a `layer` object with different fields) and map values `<Parent><Field>Value`; if a sibling claims that name too (a property `layers_item`), the fallback continues to `<Parent><Field>ArrayItem`, then `<Parent><Field>ArrayItem2`, and so on (`<Parent><Field>MemberValue`, `…MemberValue2` for maps), taking the first name no sibling mints. One deliberate exception: when the claiming sibling is an inline object structurally identical to the items or values (same properties, required, types, nested inline schemas and enum values; `description`, `title` and `example` ignored), both fields share one model under the singular name, since one type is right for both and a duplicate would only add noise; the split happens only once the shapes diverge. The choice reads sibling names and schema content only, so document order plays no part.

Inline object variants of a `oneOf`/`anyOf` are extracted as their own models. The first keeps the field's inline name (`DrawingShape`); later ones take a const-discriminator prefix when every variant pins one (`SquareDrawingShape`). A variant with neither is named from its own content, so an SDK user can tell the variants apart and reordering them changes nothing but which one is first: its `title`, trimmed and PascalCased, as the same prefix form (`CircleDrawingShape`; a title the base name already starts with is not doubled, and a title an earlier variant already took is not reused); else the first property, in the variant's own order, that no other inline object variant of the union declares (`DrawingShapeWithSide`, `DrawingShapeWithRadius`); else, only when its property set adds nothing to another variant's, the position counter (`DrawingShape2`). Every candidate also steps around the inline names the parent's other properties mint, so a variant never overwrites another field's model: beside a `shape_with_side` object (`DrawingShapeWithSide`), the `{ side }` variant of `shape` takes the next candidate (`DrawingShape2`), and beside a `shape2` object the counter keeps counting (`DrawingShape3`); each sibling's names are read in isolation, so the choice depends on sibling names and content only. The same reservation is handed down to a union among a field's array items or map values. A `oneOf` without an explicit `discriminator:` whose every variant carries a `title` and pins the same const property is the one shape named differently: its discriminator mapping has always named each variant by its title (`Circle`, `Square`), so the extracted models carry those titles too, and the mapping is read from the same names — such a title is context-free and names one shape wherever it appears, as a component name would, so a second union beside it (at field level, or among a sibling array's items or map's values) that gives the same title a variant of the identical shape (same properties, required, types and nested schemas; `description`, `title` and `example` ignored — the rule array items already use to share a singular sibling's model) shares the model instead of stepping around it. A sibling that gives the same title a different shape reserves it, and because each side reads its siblings in isolation the decision is symmetric: when `Circle` is `{ radius }` on `shape` and `{ diameter }` on `marker`, both fall back to their context-qualified names (`CircleDrawingShape`, `CircleDrawingMarker`: the title as a prefix on the base, else a distinguishing property, else the counter) and neither keeps the bare `Circle`, with the mappings following; when the shapes are identical, both keep `Circle` and one model is emitted. A title that coincides with another field's context-dependent model name falls back the same way. When the union has no const discriminator and every variant carries a distinct title, the first variant takes its title too (`CircleDrawingShape` beside `SquareDrawingShape`) instead of being the only one left bare. The decision reads the variants' content only, and the union TypeRef and every extractor (component fields, request bodies, inline responses, array items, map values) make it through one function, so a reference always has a model behind it. A request body that is itself a `oneOf` of inline objects follows the same rule for its const-less variants (`CreateThingRequest`, `CreateThingRequestWithB`); a variant with a const string property is still named after it, and either kind steps around a name an earlier variant of the body already took (a variant titled `Foo` beside one pinning `kind: foo` gives `FooCreateThingRequest` and `FooCreateThingRequest2`). A response that is itself a `oneOf` goes through the field extractor under the response name, so every inline object variant — const-prefixed, titled, property-named, or nullable (`type: ['object', 'null']`) — is materialized under exactly the name the union references (`GetThingResponse`, `GetThingResponseWithSide`, `SquareGetThingResponse`). Everything nested under a variant is named from the variant, never from the union's field: an inline object under the second variant is `DrawingShapeWithSideCenter` (or `SquareDrawingShapeCenter` under a titled one); a multi-type variant such as `type: ['object', 'array']` keeps its other types beside the model (`union[model, array]`), and the inline items of that array member are `<Variant>Item` (`DrawingShapeWithSideItem`, with nested objects `DrawingShapeWithSideItemChild`); any other non-object member is named `<Variant>Value` (an inline enum, for instance). If a property of the variant already claims that model name (`item`, or `items`, which singularizes to the same `<Variant>Item`), the member falls back to `<Variant>ArrayItem` / `<Variant>MemberValue`, then `<Variant>ArrayItem2`, `<Variant>ArrayItem3`, and so on. A variant that admits null (`['object', 'null']` or `nullable: true`) keeps its `nullable` wrapper around the model.

### UnionType

```typescript
interface UnionType {
  kind: "union";
  variants: TypeRef[];
  discriminator?: { property: string; mapping: Record<string, string> };
  compositionKind?: "allOf" | "oneOf" | "anyOf";
}
```

The `compositionKind` field tells emitters which OAS composition keyword produced the union, allowing them to distinguish inheritance (`allOf`) from exclusive union (`oneOf`) from open union (`anyOf`).

### TypeParam

```typescript
interface TypeParam {
  name: string;
  default?: TypeRef;
}
```

Generic type parameters on models. Example: `DirectoryUser<TCustomAttributes = Record<string, unknown>>`.

## AuthScheme

```typescript
type AuthScheme = { description?: string; schemeName: string } & (
  | { kind: "basic" }
  | { kind: "bearer" }
  | { kind: "apiKey"; in: "header" | "query" | "cookie"; name: string }
  | { kind: "oauth2"; flows: Record<string, unknown> }
);
```

Emitters use `AuthScheme` to generate authentication configuration and client constructors. The `cookie` variant supports cookie-based API key authentication.

`schemeName` is the key under `components.securitySchemes`, spelled exactly as in the document, and `description` is present only when the document declares one; entries keep the document's order. The requirements under `ApiSpec.security` and `Operation.security` refer to the same key, so an emitter joins a requirement to its scheme with `spec.auth?.find((a) => a.schemeName === requirement.schemeName)`. The optional chaining matters: `auth` is `undefined` when the document declares no scheme the IR can represent, and a requirement can still name a scheme that was omitted (see below), so a missing match means "no SDK-level auth is known for this operation", not an error.

HTTP scheme names are matched case-insensitively (`Bearer`, `bearer`, and `BEARER` all yield `kind: "bearer"`). Security schemes the IR cannot represent (other `http` schemes such as `digest`, plus `openIdConnect` and `mutualTLS`) are omitted from `auth`, and the parser prints an `[oagen] Warning:` diagnostic naming the scheme.

## HttpMethod

```typescript
type HttpMethod =
  "get" | "post" | "put" | "patch" | "delete" | "head" | "options" | "trace";
```

All standard HTTP methods are supported. Emitters should handle `head`, `options`, and `trace` appropriately (e.g., HEAD returns no body).

## PaginationMeta

```typescript
interface PaginationMeta {
  strategy: "cursor" | "offset" | "link-header";
  param: string; // Query param name (e.g., "after" for cursor, "offset" for offset)
  limitParam?: string; // Limit param name (offset strategy only, e.g., "limit")
  dataPath?: string; // JSON path to the data array (e.g., "data", "results") — undefined means the response IS the data
  dataDescription?: string; // The data array property's own description, when it declares one
  itemType: TypeRef; // Type of each item in the paginated list
  envelopeFields?: Field[]; // Every envelope property besides the data array, in document order
}
```

Present on `Operation` when pagination is detected. The `strategy` discriminant tells emitters whether to generate cursor-based, offset-based, or link-header pagination helpers. The `dataPath` is dynamically detected from the response envelope — when `undefined`, emitters should treat the entire response as the data array or use their own default.

When the parser recognizes an inline list envelope — one array property plus a companion that looks like pagination metadata — `Operation.response` becomes the bare array, and `envelopeFields` keeps everything else the envelope carries: the pagination companion (`list_metadata`, `pagination`, `has_more`, `total`, …) and any discriminant such as `object: "list"`. Each entry is an ordinary `Field` (wire name, type, `required`, description), so `dataPath` + `itemType` + `envelopeFields` together describe the full shape of what the endpoint returns, and an emitter can both type the response and read the page details it needs for the next request:

```typescript
// GET /customers → { customers: Customer[] ("The customers on this page."), pagination: Pagination }
op.pagination = {
  strategy: "offset",
  param: "page",
  limitParam: "limit",
  dataPath: "customers",
  dataDescription: "The customers on this page.",
  itemType: { kind: "model", name: "Customer" },
  envelopeFields: [
    {
      name: "pagination",
      type: { kind: "model", name: "Pagination" },
      required: true,
    },
  ],
};
```

A companion that is an inline object is lifted to a model. The same envelope recurs on every list endpoint of an API, so copies that agree structurally share one model named from the property alone (`list_metadata` → `ListMetadata`, `pagination` → `Pagination`) rather than one per operation as list items are (`ListUsersItem`). The bare name is taken only where it cannot change another type's shape. A copy collapses onto a target only when the target admits every value the copy can hold: the same fields with the same types, where the target may be looser (optional where the copy requires, nullable where the copy is not) but never stricter. When a component model of that name exists, the copies it admits collapse onto the component as written; otherwise the most common shape becomes the target. Any other copy keeps its operation-qualified name (`ListUsersPagination`). An inline enum in a companion is qualified by operation exactly like a parameter enum (`ListUsersSortOrder`). Companions declared through an `allOf` `$ref` branch are resolved against the component schemas, and a companion declared by more than one branch merges both declarations. Models and enums reached only through `envelopeFields` count as referenced for emission, service assignment, compat scoping, and the differ's request/response direction.

The data array property's own description, when it declares one, is kept beside `dataPath` as `dataDescription`, so an emitter documenting what a list method returns (an `@returns` tag, say) reads it from the IR like the companions' descriptions rather than from the document. As with a `Field`'s `description`, it is the property's text and never the item schema's; an inline item object's description is on the lifted item model.

`envelopeFields` is absent when the response is a bare array, when the response is a `$ref` to a component schema (the wrapper model itself carries the companions), or when pagination was inferred from query parameters alone. `dataDescription` is absent in the same cases — the wrapper model's own data field carries the description — and whenever the data property declares none.

The `link-header` strategy is for APIs that use RFC 5988 `Link` headers for pagination (e.g., GitHub API).

## Service & Operation

Service names are derived from OpenAPI tags when present — the first tag on an operation is converted to PascalCase (e.g., `tags: ["multi-factor-auth"]` → service `MultiFactorAuth`). When no tag is present, the parser falls back to a path segment (e.g., `/organizations/{id}` → `Organizations`), skipping the API root the document's untagged operations sit under. Each untagged path contributes its leading literal segments through the last API marker — `api`, `rest`, or a version such as `v1`, `2.0` or `2010-04-01` — and the root is the longest marker-terminated prefix every contribution shares (compared verbatim), so a document whose paths all start with `/api/v1/` groups `/api/v1/notes` under `Notes` rather than collapsing the whole API into one `Api` service, and `/wiki/rest/api/content` lands in `Content`. The service is named from the first literal segment after the root, so `/v1/notes` and `/v1/{teamId}/notes` share `Notes`; a path with nothing literal after the root (`/api` itself, `/api/{id}`) keeps its first segment, `Api`. A path with no marker at all (`/health`, `/openapi.json`) sits outside the root, keeps its own first segment, and does not switch the root off for the rest of the document. A shared prefix that carries no marker is kept whole, since a module prefix every path shares (`/user_management/users`, `/user_management/invitations` → `UserManagement`) is the service, not noise; and `/v1/…` beside `/v2/…` has no shared root, so the versions stay separate services. Tagged operations and path items without an operation take no part. Fallback operation names skip the root and the service segment the same way, so `/api/v1/notes` is `Notes.list`, never `Notes.listV1Notes`; when two path-named operations under the root still share a name in one service and their paths differ only by parameters, the parameters qualify them (`/v1/notes` → `Notes.list`, `/v1/{teamId}/notes` → `Notes.listByTeamId`). Without a root — a root-less document, a path outside the root, or a tagged operation — services and fallback names are exactly what they were before this rule: an untagged `/{tenant}/users` stays `Default.listUsers`. Emitters can further remap service names via an overlay (e.g., `MultiFactorAuth` → `Mfa`) to match existing SDK class names.

`Service.description` comes from the document's top-level `tags` list, matched by name: a tag entry applies to the service whose PascalCase name its `name` converts to, so `user-management`, `User Management`, and `user_management` all map to `UserManagement`. A service whose own name is a declared tag is described by that tag alone — its description when it has one, nothing otherwise — so another tag's wording is never borrowed for it (operations tagged `api_keys` that the path-prefix split merges into `UserManagement` do not label it "API keys"). A service whose own name is not declared, which is what the split produces when it carves `OrganizationDomains` out of operations tagged `organizations`, inherits the description of the first described tag its operations carry. The key is omitted when neither rule yields a description, including for path-named services whose operations have no tag. Malformed `tags` values (a non-array, `null` entries, non-string names) are skipped rather than failing the parse.

`Service.externalDocs` is the tag's `externalDocs` (see [ExternalDocs](#externaldocs)), resolved by the same rule through the same code path: a service named after a declared tag takes that tag's link or nothing, and a split-off service inherits the link of the first linked tag its operations carry. Each field is chosen independently, from the first tag that gives it — among the tags a split-off service inherits from and among several document tags that normalize to one service name — so the description and the link need not come from the same tag, and adding a link to a tag never changes which description a service shows. A tag entry whose `externalDocs` is unusable keeps its description and gives no link.

`Operation.externalDocs` is the operation's own `externalDocs`, present only when it declares a usable one.

An operation carries its OpenAPI `summary` and `description` in two fields. `Operation.description` is the combined doc text: `summary + "\n\n" + description` when the document declares both with content, or whichever one has content (a summary identical to the description is not repeated). An empty or whitespace-only `summary` or `description` is treated as absent — `summary: "List pets"` with `description: ""` yields `description: "List pets"` — and text that has content is kept verbatim, surrounding whitespace included. An emitter that prints `description` as the doc comment therefore sees the same text whether or not the document used a summary. `Operation.summary` is the document's `summary` alone and is present only when the operation declares one with content, so an emitter that wants a one-line label (and the description without it) reads `summary` rather than guessing whether the first paragraph of `description` is one. When a doc URL base is configured, relative links are expanded in `summary` exactly as in `description`.

```typescript
interface Service {
  name: string; // e.g., "Organizations"
  description?: string;
  externalDocs?: ExternalDocs; // The document tag's link, by the same rule as description
  operations: Operation[];
}

interface Operation {
  name: string; // e.g., "listUsers", "getUser", "createUser"
  summary?: string; // The document's summary alone; only when it has non-whitespace content
  description?: string; // summary + "\n\n" + description when both have content, else whichever does
  externalDocs?: ExternalDocs; // The operation's own externalDocs, when usable
  httpMethod: HttpMethod; // All 8 standard HTTP methods
  path: string; // e.g., "/organizations/{id}"
  pathParams: Parameter[];
  // Excludes `in: query` params that a POST/PUT/PATCH request body also declares;
  // those travel body-only and are kept in bodyOwnedQueryParams instead.
  queryParams: Parameter[];
  // Query declarations the body owns (see above). Emitters never serialize
  // these to the URL; enum collection and the compat surface still walk them.
  bodyOwnedQueryParams?: Parameter[];
  headerParams: Parameter[];
  cookieParams?: Parameter[]; // Present only when cookie params exist
  requestBody?: TypeRef;
  requestBodyEncoding?:
    "json" | "form-data" | "form-urlencoded" | "binary" | "text";
  response: TypeRef; // Primary response (lowest 2xx with body)
  responseHeaders?: ResponseHeader[]; // Headers declared on the primary response (only when any exist)
  responseDescription?: string; // The primary response's description (only when it has content)
  successResponses?: SuccessResponse[]; // All 2xx responses (only when multiple exist)
  errors: ErrorResponse[];
  pagination?: PaginationMeta;
  injectIdempotencyKey: boolean; // true when spec declares Idempotency-Key header
  deprecated?: boolean;
  async?: boolean;
  security?: SecurityRequirementSet[]; // Per-operation requirements; undefined inherits ApiSpec.security
}

interface SecurityRequirement {
  schemeName: string; // Matches AuthScheme.schemeName in ApiSpec.auth
  scopes: string[];
}

// One alternative: every scheme in the set is required together.
type SecurityRequirementSet = SecurityRequirement[];
```

`security` mirrors the OpenAPI document instead of flattening it. Each requirement object in the document becomes one `SecurityRequirementSet` whose schemes must all be satisfied together ("all of"); the list of sets is satisfied by any one of them ("either of"); an empty set is an alternative that needs no credentials, which is how a document marks authentication optional. The field therefore distinguishes cases a flat list could not:

| Document                                            | `Operation.security`                  | Meaning                                              |
| --------------------------------------------------- | ------------------------------------- | ---------------------------------------------------- |
| no `security` key                                   | `undefined`                           | inherit `ApiSpec.security`                           |
| `security: []`                                      | `[]`                                  | no authentication                                    |
| `security: [{ userToken: [] }, { partnerKey: [] }]` | `[[{ userToken }], [{ partnerKey }]]` | either scheme                                        |
| `security: [{ userToken: [], partnerKey: [] }]`     | `[[{ userToken }, { partnerKey }]]`   | both schemes together                                |
| `security: [{ userToken: [] }, {}]`                 | `[[{ userToken }], []]`               | `userToken`, or nothing (authentication is optional) |

To resolve what an operation accepts, take `op.security ?? spec.security`; a result of `undefined` means the document declares no requirements at all. The same list shape applies to `ApiSpec.security`.

```typescript
interface SuccessResponse {
  statusCode: number;
  type: TypeRef;
  headers?: ResponseHeader[]; // Only when the spec declares at least one
  description?: string; // The response's description; only when it has non-whitespace content
}

interface ResponseHeader {
  name: string; // As written in the spec, e.g. "Content-Disposition"
  type: TypeRef;
  required: boolean;
  description?: string;
  deprecated?: boolean;
}

interface Parameter {
  name: string;
  type: TypeRef;
  required: boolean;
  description?: string;
  deprecated?: boolean;
  default?: unknown;
  example?: unknown; // The document's `example`, else `examples[0]`
  examples?: unknown[]; // Every example value, in document order; only when non-empty
  style?: "form" | "simple" | "label" | "matrix";
  explode?: boolean;
  constraints?: Constraints; // Validation keywords; see Constraints below
}
```

`Parameter.description` is the first non-empty `description` found on, in order, the parameter itself, its inline `schema`, and the `$ref`'d component schema — the same fallback chain `deprecated`, `default`, and `example` use. An empty string at any level counts as absent, and the field is `undefined` (never `""`) when nothing in the chain is documented.

A parameter's `constraints` come from its own schema. When that schema is a `$ref`, the target's keywords are merged underneath the parameter's own — `{ $ref: Limit, minimum: 5 }` against `Limit: { type: integer, minimum: 1, maximum: 100 }` gives `{ minimum: 5, maximum: 100 }` — the per-value way `default` and `example` fall back, so a parameter can be read on its own without chasing the fieldless alias model the target also becomes. The key is absent when neither declares any.

### Parameter Examples

`example` and `examples` are read from three levels in order: the parameter itself, then its inline `schema`, then the component schema its `$ref` points at. A parameter-level `examples` is an OpenAPI map of Example Objects, so each entry's `value` is taken in document order; a `$ref` entry is resolved against `components.examples` (a dangling ref is skipped with a warning), and an `externalValue` entry is skipped. A schema-level `examples` is the JSON Schema list and is taken as-is.

Each value walks the levels on its own. `examples` is the first level's non-empty list. `example` comes from the first level that has either an `example` or a list, preferring that level's own `example` over its first list entry, so a schema-level `example` can never mask the parameter's own `examples` map. A level with neither falls through; an explicit `null` is a value and is kept. Emitters that read only `example` therefore still see a value for an OAS 3.1 document that uses `examples` alone.

### Idempotency Key

The `injectIdempotencyKey` flag is spec-driven: it is `true` only when the operation explicitly declares an `Idempotency-Key` header parameter in the OpenAPI spec. This means APIs that don't use idempotency keys (e.g., GitHub) get `false`, while APIs that do (e.g., Stripe, billing APIs) already declare the header in their spec and get `true`.

### Request Body Encoding

The `requestBodyEncoding` field tells emitters how to serialize the request body:

| Value             | Content-Type                        |
| ----------------- | ----------------------------------- |
| `json`            | `application/json`                  |
| `form-data`       | `multipart/form-data`               |
| `form-urlencoded` | `application/x-www-form-urlencoded` |
| `binary`          | `application/octet-stream`          |
| `text`            | `text/plain`                        |

### Multiple 2xx Responses

When an operation has multiple 2xx status codes, `successResponses` contains all of them. The `response` field always points to the primary response (lowest 2xx with a body schema). This is useful for emitters that need to handle different status codes differently (e.g., 200 vs 204).

### Response Descriptions

A response's `description` — often the clearest statement of what an operation gives back ("The pet, with its owner.", "Not found") — is kept with the status code it belongs to as `description` on each `SuccessResponse` and `ErrorResponse`. Because `successResponses` is only set when more than one 2xx exists, the primary response's description (the one `response` is the body of) is also exposed directly as `Operation.responseDescription`, where an emitter can print it as a `@returns` tag. All three fields follow the rule `Operation.summary` uses: present only when the document declares a description with non-whitespace content, kept verbatim when it does, and omitted otherwise — a description is never borrowed from another status code. A `$ref` into `components/responses` is not resolved, so for one only a `description` written next to the `$ref` (an OAS 3.1 sibling override) is seen. When a doc URL base is configured, relative links are expanded in response descriptions exactly as in `description`. The differ does not report a changed response description, the same as a changed operation description.

### Response Headers

Headers a response declares (`Content-Disposition` on a download, `Location` after a create, `ETag`, rate-limit headers) are kept with the status code they belong to as `headers: ResponseHeader[]` on each `SuccessResponse` and `ErrorResponse`. Because `successResponses` is only set when more than one 2xx exists, the primary response's headers are also exposed directly as `Operation.responseHeaders`.

Each header is typed like a parameter via its `schema` (or the first media type of its `content` map); a header with neither is a `string`. `$ref`s into `components/headers` are resolved, and a `description` written next to the `$ref` overrides the component's (OpenAPI 3.1); a ref that cannot be resolved is warned about and dropped rather than failing the parse. A header named `Content-Type` is ignored, as OpenAPI requires. All three fields are present only when at least one header survives, so operations without headers keep their shape.

An object-shaped header (directly, inside an array, or as a oneOf variant) is materialized as an inline model named from the service and header name (`Documents` + `X-Meta` → `DocumentsXMeta`), nested objects included (`DocumentsXMetaOrigin`). Because that name can already belong to a differently shaped component schema, to the same header on another status code, or to the same header on another operation of the service, the parser keeps a spec-wide registry of model shapes: the first owner of a name keeps it (component models first, then operations in path order, then a single operation's responses in ascending status-code order), and a later header with a different shape is re-derived under the first free candidate — bare name; then the status code (`DocumentsXMeta429`) when the clash is inside the same operation, or the operation (`DocumentsCreateDocumentXMeta`) when it is with a component or another operation; then the other of those two; then both (`DocumentsCreateDocumentXMeta429`); then a numeric suffix (`DocumentsXMeta2`). A header whose shape matches the name's owner shares it and materializes nothing new, so a header matching a component schema simply references that schema. Inline header enums follow the same idea with their own, status-code-based rule.

`collectResponseHeaders(op)` (exported from `@workos/oagen`) yields every header list once — the primary list is the same array as its `successResponses` entry — and is what reachability, model assignment, ref rewriting/validation, the differ, and the compat filter use, so a model or enum reached only through a header is emitted like any other.

## Model & Field

```typescript
interface Model {
  name: string; // PascalCase, e.g., "Organization"
  description?: string;
  externalDocs?: ExternalDocs; // The schema's externalDocs, when usable
  fields: Field[];
  typeParams?: TypeParam[]; // Generic type parameters
  constraints?: Constraints; // The object schema's own minProperties / maxProperties / dependentRequired
}

interface Field {
  name: string; // snake_case from the spec
  type: TypeRef;
  required: boolean;
  description?: string;
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  default?: unknown;
  example?: unknown; // The schema's `example`, else `examples[0]`
  examples?: unknown[]; // The JSON Schema `examples` list; only when non-empty
  constraints?: Constraints; // Validation keywords on the field's schema, siblings of a $ref included; a bare $ref yields none
}
```

### Inline model naming

Models come from `components/schemas` (named as written, after `cleanSchemaName` and any `schemaNameTransform`) and from inline object schemas in operations, which the parser materializes as models so emitters have something to reference. An inline request body or response is named from its operation:

- **With an `operationId`:** `PascalCase(operationId)` + `Request` / `Response`, passed through `cleanSchemaName`. `createNote` → `CreateNoteRequest` / `CreateNoteResponse`.
- **Without an `operationId`:** from the full path and method. Each non-parameter segment is PascalCased in order, each `{param}` segment becomes `By` + `PascalCase(param)`, then the method and `Request` / `Response` are appended, and the whole name is normalized with `toPascalCase` so an operation's body and response share a prefix (`POST /a/b` → `AbPostRequest` / `AbPostResponse`). `POST /notes` → `NotesPostRequest` / `NotesPostResponse`; `POST /notes/{id}/pin` → `NotesByIdPinPostResponse`; `GET /users/{user_id}/sessions` → `UsersByUserIdSessionsGetResponse`. This tells the common path shapes apart (list vs. item, sibling and nested sub-resources) but is not unique by construction: `/foo-bar` and `/foo/bar`, `/notes/by-id` and `/notes/{id}`, or `/notes` and `/notes/` flatten to the same words. Names already taken are reserved first: every component schema name and, for every operation with an `operationId`, the stem all of its models start with (`PascalCase(operationId)` after `cleanSchemaName`). A path-based prefix is treated as colliding when any reserved name starts with it, because one prefix is the stem of several emitted names (`…Request`, `…Response`, a list's `…Item`, nested inline models such as `…ResponseOwner`, envelope companions such as `…ListMetadata`). Names derived from a path-based prefix use it verbatim — body `oneOf` variants included (`NotesPostRequest`, `NotesPostRequest2`, `EmailNotesPostRequest`) — and are never re-cleaned, so no later step can move them out from under the reservation; as a second line of defence the check also runs on the cleaned spellings of the prefix (`cleanSchemaName`, the project's `schemaNameTransform`, `ListItem`-marker stripping), so an unnamed `GET /notes` also yields to a component `NoteGetItem`. Names that embed the prefix behind a const value are covered as well: a body `oneOf` variant pinning `kind: email` is `EmailTagsPostRequest` and a nested `oneOf`/`anyOf` variant is `<Const><Parent><Field>`, so every string `const` (or single-value `enum`) found in the operation's inline body and 2xx response variants, top level and nested, is prepended to every spelling before the check, and a hashed prefix lands inside those names too (`EmailTags151Dd5PostRequest`). Names that do not embed the prefix at all — a response `oneOf` variant named from its bare const (`Email`) or a `title`-mapped variant — are outside what a disambiguator can separate and are left as they are. This is deliberately a superset: a component `AuditEventsGetter`, or an operationId `auditEventsGetSummary`, also pushes an unnamed `GET /audit/events` onto a hashed name although no emitted name would coincide; determinism and never sharing a name wrongly matter more than the rare extra hash. The reservation is unconditional, so an inline body is never merged into a same-named component even when their shapes agree. When two distinct paths with the same method would collide, the path spelled most plainly keeps the plain name (no trailing slash, `{id}` rather than a literal `by-id`; precisely, the lowest `[trailing slash, literal segments with a character outside a-z0-9]`), and every other path in the group gets a six-character disambiguator derived from its raw path (the start of its SHA-1, inserted before the method): `POST /foo/bar` next to `POST /foo-bar` → `FooBarPostResponse` and `FooBar546F12PostResponse`; `GET /notes/{id}` next to `GET /notes/by-id` → `NotesByIdGetResponse` and `NotesByIdBa41B5GetResponse`. When two paths tie for plainest (`/foo-bar` and `/foo_bar`), or the path-based name matches a reserved one (an unnamed `POST /audit/events` next to `operationId: auditEventsPost` or next to `components/schemas/AuditEventsPostRequest`), nobody keeps the plain name and every path in the group is disambiguated. The result depends only on the document's paths, `operationId`s and component names and never on their order; `operationId`-derived and component names never change, and paths that do not collide keep the plain name.

A response object with a string `const` discriminant (`object: "note"`) is named from that value instead (`Note`); a list envelope's inline item model replaces the `Response` suffix with `Item`; nested inline objects are qualified with their parent model's name.

If two inline models still resolve to the same name with different fields or field types (two `operationId`s that PascalCase to the same word, for example), the parser keeps the one with more fields — the first definition on a tie — and prints `[oagen] Warning: Inline model "…" has more than one definition with different fields or field types`.

### Field Examples

OpenAPI 3.1 deprecates a schema's `example` in favour of the JSON Schema `examples` list. The parser reads both: `examples` carries every value the document gives, and `example` is the document's `example` when present, otherwise the first entry of `examples`. A field whose schema is a `$ref` to a component falls back to that component's `example`/`examples`, the same way a parameter does. A field whose schema (and `$ref` target, if any) gives neither has no `example` and no `examples` key.

### Constraints

JSON Schema's validation keywords are carried on `Field`, `Parameter` and `Model` so an emitter can document a value's limits ("at most 100"), check a value before sending it, or keep a generated example within range. `type`, `enum`, `const` and `required` already have their own place in the IR and are not repeated here.

```typescript
interface Constraints {
  // numbers
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  // strings
  minLength?: number;
  maxLength?: number;
  pattern?: string; // ECMA-262 regex, verbatim from the document
  // arrays
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean; // present only when true
  minContains?: number;
  maxContains?: number;
  // objects
  minProperties?: number;
  maxProperties?: number;
  dependentRequired?: Record<string, string[]>;
}
```

Every member is optional and present only when the document declares it. A schema with no validation keyword yields no `constraints` key at all, so `field.constraints?.maxLength` is the idiomatic read. The parser ignores a keyword whose value has the wrong type (a string `maxLength`, say) rather than carrying it.

**OAS 3.0 → 3.1 normalization.** OpenAPI 3.1 (JSON Schema 2020-12) gives `exclusiveMinimum` / `exclusiveMaximum` as the bound itself; OpenAPI 3.0 spells them as booleans that make `minimum` / `maximum` exclusive. Both versions are parsed, and the IR always uses the 3.1 shape:

| Document (3.0)                             | IR                                         |
| ------------------------------------------ | ------------------------------------------ |
| `minimum: 0, exclusiveMinimum: true`       | `{ exclusiveMinimum: 0 }` (no `minimum`)   |
| `maximum: 100, exclusiveMaximum: true`     | `{ exclusiveMaximum: 100 }` (no `maximum`) |
| `minimum: 0, exclusiveMinimum: false`      | `{ minimum: 0 }`                           |
| `exclusiveMinimum: true` with no `minimum` | nothing                                    |

A 3.1 document's numeric form passes through unchanged, including the legal-but-unusual case of an inclusive and an exclusive bound on the same side.

**Scope.** The keywords declared on the field, parameter or model schema are collected, conjoined with those of its inline `allOf` members: the parser unwraps a single-member `allOf`, so `{ allOf: [{ type: string, maxLength: 3 }] }` is a string field carrying `{ maxLength: 3 }`, and a `$ref` member contributes the keywords written beside the reference while the referenced model keeps its own. Limits nested inside array `items` or map values (e.g. `items: { maxLength: 10 }`) are not carried. The one exception is a nullable wrapper — a `oneOf`/`anyOf` with exactly one non-null, non-`$ref` branch, which the IR collapses to `nullable<T>` — whose branch keywords are conjoined with the wrapper's own (and its `allOf` members'), so `anyOf: [{ type: string, maxLength: 8 }, { type: "null" }]` gives `{ maxLength: 8 }` and `{ allOf: [{ maxLength: 30 }], anyOf: [{ type: string, minLength: 20 }, { type: "null" }] }` gives `{ maxLength: 30, minLength: 20 }`, and an inline model built from that branch carries the same conjoined keywords, so `minProperties` written beside `anyOf: [{ type: object, … }, { type: "null" }]` reaches both the field and its model. Limits on a general multi-variant union are not carried. Keywords written beside a `$ref` (OpenAPI 3.1 allows them) are the field's own and are kept; a bare `$ref` field gets no `constraints`, because its limits belong to the referenced model. A `Model` carries whatever its own schema declares — for an object schema that is `minProperties`, `maxProperties` and `dependentRequired`; for an `allOf` model — a component, or an inline response, request body or field the parser rebuilds from `allOf` members — it is the wrapper's keywords conjoined with its members' (the stricter bound wins; a `$ref` member contributes the keywords written beside the reference, while the referenced model keeps its own). A variant model of a discriminated `allOf` + `oneOf` union conjoins the shared keywords — the outer wrapper's, the base members' and any written beside the `oneOf` — with the variant's own the way `allOf` does — an instance must satisfy both, so the larger `min*` and the smaller `max*` win and `dependentRequired` maps are unioned per property.

## Enum

```typescript
interface Enum {
  name: string; // PascalCase
  values: EnumValue[];
  externalDocs?: ExternalDocs; // The component enum schema's externalDocs, when usable; inline enums carry none
}

interface EnumValue {
  name: string; // UPPER_SNAKE_CASE display name
  value: string | number; // Actual value from spec (preserves numeric types)
  description?: string;
  deprecated?: boolean;
}
```

## ErrorResponse

```typescript
interface ErrorResponse {
  statusCode: number; // e.g., 401, 404, 422
  type?: TypeRef; // Response body type, if any
  headers?: ResponseHeader[]; // e.g. Retry-After on a 429; only when the spec declares at least one
  description?: string; // e.g. "Not found"; only when it has non-whitespace content
}
```

## Operation Resolution

Source: `src/ir/operation-hints.ts`

The operation resolver derives method names, mount targets, and wrapper metadata for all operations in the spec. It runs in `buildEmitterContext()` and produces `ResolvedOperation[]` on `ctx.resolvedOperations`.

### Algorithm

`deriveMethodName(op, service)` derives a snake_case name from the HTTP method and path:

1. Strip path-param segments (`{id}`, `{slug}`, etc.)
2. If the terminal segment is an action verb (`verify`, `enroll`, `confirm`, `revoke`, etc.), use it as the verb with the preceding resource as the noun: `verify_challenge`
3. Otherwise, use a CRUD verb from the HTTP method: GET → `list`/`get`, POST → `create`, PUT/PATCH → `update`, DELETE → `delete`
4. Singularize the resource noun for single-resource operations

### Hint types

Consumer-provided overrides keyed by `"METHOD /path"`:

```typescript
interface OperationHint {
  name?: string; // Override derived method name
  mountOn?: string; // Remount to different service/namespace
  split?: SplitHint[]; // Split union body into N typed wrappers
  defaults?: Record<string, string | number | boolean>;
  inferFromClient?: string[];
}
```

### Resolved output

```typescript
interface ResolvedOperation {
  operation: Operation; // Original IR
  service: Service; // Original owning service
  methodName: string; // Resolved snake_case name
  mountOn: string; // Resolved target service (PascalCase)
  wrappers?: ResolvedWrapper[];
}
```

### Mount rules

Service-level remounting maps an IR service name to a target namespace. All operations in the source service are mounted on the target unless overridden per-operation. Per-operation `mountOn` hints take precedence over service-level rules.

Rule keys may be exact service names or trailing-`*` prefix patterns. Precedence: an exact key always wins; otherwise the wildcard with the longest prefix wins. Matching is plain `startsWith` string comparison — `*` is only meaningful as the final character, and no regex is involved. This lets a family of tags collapse to a few rules:

```typescript
{
  "UserManagement*": "UserManagement",                          // catch-all for the family
  "UserManagementOrganizationMembership*": "OrganizationMembership", // longer prefix wins
  "UserManagementDataProviders": "Pipes",                       // exact wins over wildcard
}
```

Note that a catch-all also absorbs future tags added to the spec under that prefix — a new `UserManagementFoo` tag mounts silently instead of surfacing as a new top-level service, so review `oagen diff` output (or run `/oagen:review-operations`) when the spec adds tags.

### CLI

`oagen resolve --spec <path> --format table|json` outputs the full resolution table for review. Use `--format json` for programmatic consumption.

## Versioning

The IR does not currently use a version constant. As a 0.x project with no external consumers yet, formal IR versioning is deferred until post-open-source when external emitters need a stable contract signal.

**Compile-time safety:** `assertNever` enforces exhaustive `switch` statements over `TypeRef.kind` at compile time. Adding a new variant causes build failures in any emitter that doesn't handle it — this is the primary compatibility mechanism.

**Walker/Mapper utilities:** `walkTypeRef` and `mapTypeRef` handle recursive traversal of `TypeRef` trees. Both visit `MapType.keyType` when present. The `mapTypeRef` mapper callback for `map` receives an optional third argument `mappedKey?: T` for the mapped key type.
