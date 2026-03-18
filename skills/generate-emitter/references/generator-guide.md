# Generator Implementation Guide

Detailed instructions for implementing each generator file in a language emitter. Read this when implementing Steps 2–4 of the main skill.

## Table of Contents

- [Type Mapping (type-map.ts)](#type-mapping)
- [Naming Conventions (naming.ts)](#naming-conventions)
- [Models (models.ts)](#models)
- [Enums (enums.ts)](#enums)
- [Resources (resources.ts)](#resources)
- [Serializers (serializers.ts)](#serializers)
- [Client (client.ts)](#client)
- [Errors (errors.ts)](#errors)
- [Config (config.ts)](#config)
- [Common/Utilities (common.ts)](#common-utilities)
- [Type Signatures (types-\*.ts)](#type-signatures)
- [Tests (tests.ts) and Fixtures (fixtures.ts)](#tests-and-fixtures)

---

## Type Mapping

Foundation file. Map every IR `TypeRef` kind to the target language's type representation.

### Required Mappings

| IR TypeRef                                                   | What to Map                          |
| ------------------------------------------------------------ | ------------------------------------ |
| `{ kind: "primitive", type: "string" }`                      | String type                          |
| `{ kind: "primitive", type: "string", format: "date" }`      | Date type                            |
| `{ kind: "primitive", type: "string", format: "date-time" }` | DateTime type                        |
| `{ kind: "primitive", type: "string", format: "uuid" }`      | String or UUID type                  |
| `{ kind: "primitive", type: "integer" }`                     | Integer type                         |
| `{ kind: "primitive", type: "number" }`                      | Float/double type                    |
| `{ kind: "primitive", type: "boolean" }`                     | Boolean type                         |
| `{ kind: "array", items: ... }`                              | Array/list of mapped item type       |
| `{ kind: "model", name: "Foo" }`                             | Reference to model class             |
| `{ kind: "enum", name: "Foo" }`                              | Reference to enum type               |
| `{ kind: "nullable", inner: ... }`                           | Optional/nullable wrapper            |
| `{ kind: "union", variants: [...] }`                         | Union/sum type                       |
| `{ kind: "map", valueType: ... }`                            | Map/dict/Record of mapped value type |

Export a `mapTypeRef(typeRef: TypeRef, namespacePascal: string): string` function.

**For Scenario A:** The type mapping must produce types that match the existing SDK's conventions. If the SDK uses `Date` objects instead of ISO strings for date-time, map accordingly. If the SDK wraps nullable types in `Optional<T>`, do that. Check the design doc's type mapping table.

If the language has a separate type annotation system, also export mapping functions for those (e.g., `mapTypeRefForRbs`, `mapTypeRefForSorbet`).

---

## Naming Conventions

Map oagen's PascalCase IR names to the target language's conventions.

### Required Functions

```typescript
export function className(name: string): string;
export function fileName(name: string): string;
export function methodName(name: string): string;
export function modulePath(
  namespace: string,
  category: string,
  name: string,
): string;
```

### Examples by Language

| IR Name               | Ruby              | Python            | Go                | Kotlin           |
| --------------------- | ----------------- | ----------------- | ----------------- | ---------------- |
| `UserProfile` (class) | `UserProfile`     | `UserProfile`     | `UserProfile`     | `UserProfile`    |
| `UserProfile` (file)  | `user_profile.rb` | `user_profile.py` | `user_profile.go` | `UserProfile.kt` |
| `listUsers` (method)  | `list_users`      | `list_users`      | `ListUsers`       | `listUsers`      |
| `user_id` (field)     | `user_id`         | `user_id`         | `UserID`          | `userId`         |

**For Scenario A:** Verify naming conventions against the existing SDK. If the SDK uses non-standard naming (e.g., preserves acronyms like `SSO` instead of converting to `Sso`, or uses `ID` instead of `Id`), the naming functions must reproduce that behavior. Check 5–10 actual names from the SDK and verify the naming functions produce identical output.

Use the shared utilities from `@workos/oagen` (`toPascalCase`, `toSnakeCase`, `toCamelCase`, `toKebabCase`, `toUpperSnakeCase`) as building blocks.

---

## Models

- Input: `Model[]` (each has `name`, `description?`, `fields[]`)
- Each `Field` has `name`, `type: TypeRef`, `required: boolean`, `description?`
- Output: One file per model, using the exact model pattern from the design doc
- Use `type-map.ts` to convert field types

**For Scenario A:** If the existing SDK uses a dual type system (e.g., separate `Organization` and `OrganizationResponse` types), this generator must produce BOTH types. If the SDK has specific decorators, base classes, or factory methods on models, replicate them.

---

## Enums

- Input: `Enum[]` (each has `name`, `values[]`)
- Each `EnumValue` has `name`, `value` (string), `description?`
- Output: One file per enum, using the exact enum pattern from the design doc

---

## Resources

- Input: `Service[]` (each has `name`, `operations[]`)
- Each `Operation` has: `name`, `httpMethod`, `path`, `pathParams`, `queryParams`, `requestBody?`, `response`, `paginated`, `injectIdempotencyKey`
- Output: One file per service/resource
- Handle:
  - Path parameter interpolation (e.g., `/orgs/{id}` to target language's format string mechanism)
  - Strip leading `/` from paths (use `"organizations"` not `"/organizations"`)
  - Paginated responses — use the exact pagination pattern from the design doc (NOT a generic page type)
  - Idempotent POST methods (include an idempotency key as a standalone parameter, not embedded in params)
  - Query parameters for list methods
  - A per-request options parameter on every method (last parameter, using the language's idiomatic calling convention)
  - Documentation for parameters and return types using the target language's standard docstring format
  - Delete methods signal "no response body" using the language's null/void type and return nil/null/unit

**For Scenario A:** The method signatures, parameter ordering, and return types must match the existing SDK's patterns exactly. If the SDK takes an options object as the first parameter and an ID separately, replicate that. If it uses keyword arguments, replicate that. Read the resource pattern section of the design doc carefully.

---

## Serializers

**Only create this file if the design doc documents a serialization pattern.**

- Input: `Model[]` — generates serialize/deserialize functions for each model
- Maps between wire format (API responses) and domain types (what the SDK exposes)
- Common in SDKs that have separate Response and Domain type layers

---

## Client

Mostly static code with namespace interpolation. Must include:

- HTTP request method accepting: HTTP method, path, optional query params, optional body, a model type for deserialization, a page type for paginated responses, an optional idempotency key, and per-request options. Use the target language's idiomatic parameter passing convention.
- Model and page parameters for response deserialization
- Response handling: null/void model type returns nil/null, page type creates paginated response, model type creates model instance
- HTTP request method dispatching (GET/POST/PUT/PATCH/DELETE)
- Exponential backoff retry with jitter, capped at a reasonable maximum (see the language's SDK design doc for the specific formula)
- Retryable statuses: 429, 500, 502, 503, 504
- Respect `Retry-After` headers
- Auto-generated UUID idempotency keys for POST, reused across retries
- Resource accessor methods (one per service) with return type documentation
- Per-request options support for extra headers and timeout overrides

### SDK Scaffolding Files

`generateClient` must also emit the project scaffolding that makes the generated SDK self-contained and analyzable:

- **Barrel entry point** (e.g., `src/index.ts`) — re-exports all public types, models, enums, exceptions, and the main client. This is what `oagen verify` (via the extractor) uses to discover the SDK's public surface.
- **Project config** (e.g., `tsconfig.json`) — so the SDK can be type-checked and built.
- **Package manifest** (e.g., `package.json`) — with correct `main`, `types`, and `exports` fields so tooling resolves the entry point.

Without these, `oagen verify` will fail with "No entry point found" because the extractor cannot discover the SDK's public surface.

**For Scenario A:** The client architecture must match the existing SDK. If the client uses constructor overloads, has a specific initialization pattern, or delegates to a separate HTTP transport layer, replicate that. The design doc's client architecture section is authoritative.

---

## Errors

Mostly static code with namespace interpolation. Required error types:

- `APIError` (base), `AuthenticationError` (401), `NotFoundError` (404), `UnprocessableEntityError` (422), `RateLimitExceededError` (429), `ServerError` (500+), `NetworkError` (connection failures), `ConfigurationError` (missing API key)

**For Scenario A:** Match the existing SDK's error class names and hierarchy exactly. If the SDK names it `BadRequestException` instead of `UnprocessableEntityError`, use the SDK's name.

---

## Config

Configuration class/module with: `api_key`, `base_url`, `max_retries`, `timeout`. Environment variable default for API key.

---

## Common/Utilities

**Create this file if the design doc documents shared utilities.** Generates shared types, pagination base classes, barrel exports, or helper functions. Common in SDKs that have a `common/` directory with shared infrastructure.

---

## Type Signatures

Language-specific. May be 0, 1, or 2 files depending on the language's type system. Examples: `.pyi` stubs for Python, `.d.ts` for JavaScript, nothing for Go/Rust (types are inline). Must include request options and idempotency key parameters on resource method signatures, enum type signatures using the target language's idiomatic enum representation, and delete operations returning the language's void/null type.

---

## Tests and Fixtures

- `generateTests` is the only Emitter interface method — it should internally call `generateFixtures` from `fixtures.ts` and combine both into a single `GeneratedFile[]` return
- Generate one test file per resource/service
- Test file paths are language-specific — use the target language's idiomatic convention (e.g., Ruby uses `test/{namespace}/resources/{name}_test.rb`, Node uses `src/{service}/tests/{name}.test.ts`)
- Test classes/modules nested in namespace modules
- Each test: stub HTTP request, call method, assert response type using the language's idiomatic assertion style
- Include error tests (404, 401), retry tests (429 with Retry-After), and idempotency tests (explicit + auto-generated keys)
- Fixture JSON file paths are also language-specific — organize them near the test files using the target language's convention
- Use a `load_fixture` helper for reading fixtures
- Generate fixture JSON files from IR model schemas

**For Scenario A:** Use the exact testing framework and mocking library from the existing SDK. If the SDK uses Jest + jest-fetch-mock, generate Jest tests with jest-fetch-mock, not Vitest + msw. If the SDK uses a specific test structure (describe/it vs test functions, specific setup/teardown patterns), replicate it. Read the test pattern section of the design doc.
