# IR Type System Reference

Source: `src/ir/types.ts`

The intermediate representation (IR) is the contract between the parser and all language emitters. It uses plain TypeScript interfaces (no classes) with a discriminated union type system.

## Top-Level: ApiSpec

```typescript
interface ApiSpec {
  name: string; // From info.title
  version: string; // From info.version
  description?: string; // From info.description
  baseUrl: string; // From servers[0].url
  services: Service[]; // Grouped operations
  models: Model[]; // Schema objects
  enums: Enum[]; // String enums
}
```

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
| `map`       | `MapType`       | `{ kind: "map", valueType: { kind: "primitive", type: "string" } }`  |

### Primitive Formats

The `format` field on `PrimitiveType` carries additional type information:

| type      | format      | Semantic          |
| --------- | ----------- | ----------------- |
| `string`  | (none)      | Plain string      |
| `string`  | `date`      | ISO 8601 date     |
| `string`  | `date-time` | ISO 8601 datetime |
| `string`  | `uuid`      | UUID string       |
| `integer` | (none)      | Integer           |
| `number`  | (none)      | Floating point    |
| `boolean` | (none)      | Boolean           |

## AuthScheme

```typescript
type AuthScheme =
  | { kind: "bearer" }
  | { kind: "apiKey"; in: "header" | "query"; name: string }
  | { kind: "oauth2"; flows: Record<string, unknown> };
```

Emitters use `AuthScheme` to generate authentication configuration and client constructors.

## PaginationMeta

```typescript
interface PaginationMeta {
  strategy: 'cursor' | 'offset'; // Pagination strategy
  param: string; // Query param name (e.g., "after" for cursor, "offset" for offset)
  limitParam?: string; // Limit param name (offset strategy only, e.g., "limit")
  dataPath: string; // JSON path to the data array (e.g., "data", "results", "items")
  itemType: TypeRef; // Type of each item in the paginated list
}
```

Present on `Operation` when pagination is detected. The `strategy` discriminant tells emitters whether to generate cursor-based or offset-based pagination helpers. The `dataPath` is dynamically detected from the response envelope — it is NOT hardcoded to `'data'`.

## Service & Operation

Service names are derived from OpenAPI tags when present — the first tag on an operation is converted to PascalCase (e.g., `tags: ["multi-factor-auth"]` → service `MultiFactorAuth`). When no tag is present, the parser falls back to the first path segment (e.g., `/organizations/{id}` → `Organizations`). Emitters can further remap service names via an overlay (e.g., `MultiFactorAuth` → `Mfa`) to match existing SDK class names.

```typescript
interface Service {
  name: string; // e.g., "Organizations"
  description?: string;
  operations: Operation[];
}

interface Operation {
  name: string; // e.g., "list", "retrieve", "create"
  description?: string;
  httpMethod: HttpMethod; // "get" | "post" | "put" | "patch" | "delete"
  path: string; // e.g., "/organizations/{id}"
  pathParams: Parameter[];
  queryParams: Parameter[];
  headerParams: Parameter[];
  requestBody?: TypeRef;
  response: TypeRef;
  errors: ErrorResponse[];
  paginated: boolean;
  injectIdempotencyKey: boolean;
}
```

## Model & Field

```typescript
interface Model {
  name: string; // PascalCase, e.g., "Organization"
  description?: string;
  fields: Field[];
}

interface Field {
  name: string; // snake_case from the spec
  type: TypeRef;
  required: boolean;
  description?: string;
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
  value: string; // Actual string value from spec
  description?: string;
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
