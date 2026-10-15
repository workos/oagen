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
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options"
  | "trace";
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

```typescript
interface Service {
  name: string; // e.g., "Organizations"
  description?: string;
  operations: Operation[];
}

interface Operation {
  name: string; // e.g., "listUsers", "getUser", "createUser"
  description?: string;
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
    | "json"
    | "form-data"
    | "form-urlencoded"
    | "binary"
    | "text";
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
  example?: unknown;
  style?: "form" | "simple" | "label" | "matrix";
  explode?: boolean;
  constraints?: Constraints; // Validation keywords; see Constraints below
}
```

A parameter's `constraints` come from its own schema, or — like `default` and `example` — from the `$ref` target when the schema is a bare reference, since a primitive alias such as `Limit: { type: integer, maximum: 100 }` has no model of its own to carry them. The key is absent when neither declares any.

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
  example?: unknown;
  constraints?: Constraints; // Validation keywords on the field's schema; absent for a $ref field
}
```

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

**Scope.** Only the keywords declared directly on the field, parameter or model schema are collected. Limits nested inside array `items` or map values (e.g. `items: { maxLength: 10 }`) are not carried; a field whose schema is a `$ref` gets no `constraints`, because its limits belong to the referenced model. A `Model` carries whatever its own schema declares — for an object schema that is `minProperties`, `maxProperties` and `dependentRequired`; for an `allOf` model it is the keywords on the outer wrapper.

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
