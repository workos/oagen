# IR Type System Reference

Source: `src/ir/types.ts`

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
}
```

The `servers` array contains all server entries from the OpenAPI spec. `baseUrl` is always set to the first server's URL for backward compatibility.

## TypeRef (discriminated union)

Every type in the IR is a `TypeRef`, discriminated on the `kind` field:

| Kind        | Interface       | Example                                                              |
| ----------- | --------------- | -------------------------------------------------------------------- |
| `primitive` | `PrimitiveType` | `{ kind: "primitive", type: "string" }`                              |
| `array`     | `ArrayType`     | `{ kind: "array", items: { kind: "primitive", type: "string" } }`    |
| `model`     | `ModelRef`      | `{ kind: "model", name: "Organization" }`                            |
| `enum`      | `EnumRef`       | `{ kind: "enum", name: "Status" }`                                   |
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
type AuthScheme =
  | { kind: "bearer" }
  | { kind: "apiKey"; in: "header" | "query" | "cookie"; name: string }
  | { kind: "oauth2"; flows: Record<string, unknown> };
```

Emitters use `AuthScheme` to generate authentication configuration and client constructors. The `cookie` variant supports cookie-based API key authentication.

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
}
```

Present on `Operation` when pagination is detected. The `strategy` discriminant tells emitters whether to generate cursor-based, offset-based, or link-header pagination helpers. The `dataPath` is dynamically detected from the response envelope — when `undefined`, emitters should treat the entire response as the data array or use their own default.

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
  queryParams: Parameter[];
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
}

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
}
```

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
}
```

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

## Versioning

The IR does not currently use a version constant. As a 0.x project with no external consumers yet, formal IR versioning is deferred until post-open-source when external emitters need a stable contract signal.

**Compile-time safety:** `assertNever` enforces exhaustive `switch` statements over `TypeRef.kind` at compile time. Adding a new variant causes build failures in any emitter that doesn't handle it — this is the primary compatibility mechanism.

**Walker/Mapper utilities:** `walkTypeRef` and `mapTypeRef` handle recursive traversal of `TypeRef` trees. Both visit `MapType.keyType` when present. The `mapTypeRef` mapper callback for `map` receives an optional third argument `mappedKey?: T` for the mapped key type.
