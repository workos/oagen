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

Inline object variants of a `oneOf`/`anyOf` are extracted as their own models. The first keeps the field's inline name (`DrawingShape`); later ones take a const-discriminator prefix when every variant pins one (`SquareDrawingShape`). A variant with neither is named from its own content, so an SDK user can tell the variants apart and reordering them changes nothing but which one is first: its `title`, trimmed and PascalCased, as the same prefix form (`CircleDrawingShape`; a title the base name already starts with is not doubled, and a title an earlier variant already took is not reused); else the first property, in the variant's own order, that no other inline object variant of the union declares (`DrawingShapeWithSide`, `DrawingShapeWithRadius`); else, only when its property set adds nothing to another variant's, the position counter (`DrawingShape2`). Every candidate also steps around the inline names the parent's other properties mint, so a variant never overwrites another field's model: beside a `shape_with_side` object (`DrawingShapeWithSide`), the `{ side }` variant of `shape` takes the next candidate (`DrawingShape2`), and beside a `shape2` object the counter keeps counting (`DrawingShape3`); each sibling's names are read in isolation, so the choice depends on sibling names and content only. When the union has no const discriminator and every variant carries a distinct title, the first variant takes its title too (`CircleDrawingShape` beside `SquareDrawingShape`) instead of being the only one left bare. The decision reads the variants' content only, and the union TypeRef and every extractor (component fields, request bodies, inline responses, array items, map values) make it through one function, so a reference always has a model behind it. A request body that is itself a `oneOf` of inline objects follows the same rule for its const-less variants (`CreateThingRequest`, `CreateThingRequestWithB`); a variant with a const string property is still named after it. A response that is itself a `oneOf` goes through the field extractor under the response name, so every inline object variant — const-prefixed, titled, property-named, or nullable (`type: ['object', 'null']`) — is materialized under exactly the name the union references (`GetThingResponse`, `GetThingResponseWithSide`, `SquareGetThingResponse`). Everything nested under a variant is named from the variant, never from the union's field: an inline object under the second variant is `DrawingShapeWithSideCenter` (or `SquareDrawingShapeCenter` under a titled one); a multi-type variant such as `type: ['object', 'array']` keeps its other types beside the model (`union[model, array]`), and the inline items of that array member are `<Variant>Item` (`DrawingShapeWithSideItem`, with nested objects `DrawingShapeWithSideItemChild`); any other non-object member is named `<Variant>Value` (an inline enum, for instance). If a property of the variant already claims that model name (`item`, or `items`, which singularizes to the same `<Variant>Item`), the member falls back to `<Variant>ArrayItem` / `<Variant>MemberValue`, then `<Variant>ArrayItem2`, `<Variant>ArrayItem3`, and so on. A variant that admits null (`['object', 'null']` or `nullable: true`) keeps its `nullable` wrapper around the model.

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
  itemType: TypeRef; // Type of each item in the paginated list
  envelopeFields?: Field[]; // Every envelope property besides the data array, in document order
}
```

Present on `Operation` when pagination is detected. The `strategy` discriminant tells emitters whether to generate cursor-based, offset-based, or link-header pagination helpers. The `dataPath` is dynamically detected from the response envelope — when `undefined`, emitters should treat the entire response as the data array or use their own default.

When the parser recognizes an inline list envelope — one array property plus a companion that looks like pagination metadata — `Operation.response` becomes the bare array, and `envelopeFields` keeps everything else the envelope carries: the pagination companion (`list_metadata`, `pagination`, `has_more`, `total`, …) and any discriminant such as `object: "list"`. Each entry is an ordinary `Field` (wire name, type, `required`, description), so `dataPath` + `itemType` + `envelopeFields` together describe the full shape of what the endpoint returns, and an emitter can both type the response and read the page details it needs for the next request:

```typescript
// GET /customers → { customers: Customer[], pagination: Pagination }
op.pagination = {
  strategy: "offset",
  param: "page",
  limitParam: "limit",
  dataPath: "customers",
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

`envelopeFields` is absent when the response is a bare array, when the response is a `$ref` to a component schema (the wrapper model itself carries the companions), or when pagination was inferred from query parameters alone.

The `link-header` strategy is for APIs that use RFC 5988 `Link` headers for pagination (e.g., GitHub API).

## Service & Operation

Service names are derived from OpenAPI tags when present — the first tag on an operation is converted to PascalCase (e.g., `tags: ["multi-factor-auth"]` → service `MultiFactorAuth`). When no tag is present, the parser falls back to the first path segment (e.g., `/organizations/{id}` → `Organizations`). Emitters can further remap service names via an overlay (e.g., `MultiFactorAuth` → `Mfa`) to match existing SDK class names.

`Service.description` comes from the document's top-level `tags` list, matched by name: a tag entry applies to the service whose PascalCase name its `name` converts to, so `user-management`, `User Management`, and `user_management` all map to `UserManagement`. A service whose own name is a declared tag is described by that tag alone — its description when it has one, nothing otherwise — so another tag's wording is never borrowed for it (operations tagged `api_keys` that the path-prefix split merges into `UserManagement` do not label it "API keys"). A service whose own name is not declared, which is what the split produces when it carves `OrganizationDomains` out of operations tagged `organizations`, inherits the description of the first described tag its operations carry. The key is omitted when neither rule yields a description, including for path-named services whose operations have no tag. Malformed `tags` values (a non-array, `null` entries, non-string names) are skipped rather than failing the parse.

An operation carries its OpenAPI `summary` and `description` in two fields. `Operation.description` is the combined doc text: `summary + "\n\n" + description` when the document declares both with content, or whichever one has content (a summary identical to the description is not repeated). An empty or whitespace-only `summary` or `description` is treated as absent — `summary: "List pets"` with `description: ""` yields `description: "List pets"` — and text that has content is kept verbatim, surrounding whitespace included. An emitter that prints `description` as the doc comment therefore sees the same text whether or not the document used a summary. `Operation.summary` is the document's `summary` alone and is present only when the operation declares one with content, so an emitter that wants a one-line label (and the description without it) reads `summary` rather than guessing whether the first paragraph of `description` is one. When a doc URL base is configured, relative links are expanded in `summary` exactly as in `description`.

```typescript
interface Service {
  name: string; // e.g., "Organizations"
  description?: string;
  operations: Operation[];
}

interface Operation {
  name: string; // e.g., "listUsers", "getUser", "createUser"
  summary?: string; // The document's summary alone; only when it has non-whitespace content
  description?: string; // summary + "\n\n" + description when both have content, else whichever does
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
}
```

`Parameter.description` is the first non-empty `description` found on, in order, the parameter itself, its inline `schema`, and the `$ref`'d component schema — the same fallback chain `deprecated`, `default`, and `example` use. An empty string at any level counts as absent, and the field is `undefined` (never `""`) when nothing in the chain is documented.

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

## Model & Field

```typescript
interface Model {
  name: string; // PascalCase, e.g., "Organization"
  description?: string;
  fields: Field[];
  typeParams?: TypeParam[]; // Generic type parameters
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
}
```

### Field Examples

OpenAPI 3.1 deprecates a schema's `example` in favour of the JSON Schema `examples` list. The parser reads both: `examples` carries every value the document gives, and `example` is the document's `example` when present, otherwise the first entry of `examples`. A field whose schema is a `$ref` to a component falls back to that component's `example`/`examples`, the same way a parameter does. A field whose schema (and `$ref` target, if any) gives neither has no `example` and no `examples` key.

## Enum

```typescript
interface Enum {
  name: string; // PascalCase
  values: EnumValue[];
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
