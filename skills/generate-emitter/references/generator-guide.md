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

- Input: `Model[]`. Each `Model` has:
  - `name` — PascalCase model name
  - `description?` — doc text for the model
  - `externalDocs?` — the schema's `externalDocs` link, when usable
  - `deprecated?` — present and `true` when the schema says `deprecated: true`
  - `fields` — `Field[]`
  - `typeParams?` — generic type parameters (`name`, `default?: TypeRef`)
  - `variants?` — `TypeRef[]` when the model is a named union (a component schema that is itself a `oneOf`/`anyOf`): one entry per non-null variant, in document order; emit the model as a union of these, not as a data class — `fields` then holds only the inline variants' properties merged as optional fields. A `$ref` to a named union that admits `null` arrives as `nullable<model>`
  - `compositionKind?` — `oneOf` | `anyOf`, the keyword that produced `variants`; present exactly when `variants` is
  - `discriminator?` — `{ property, mapping }` when the model is a discriminated union: a named `oneOf` or `anyOf` with an explicit `discriminator:` keyword (its `mapping` taken as written, or paired from each variant's const on the property when the keyword declares none); a named `oneOf` without the keyword whose variants are all nameable (a `$ref`, or an inline object) and pin distinct string constants on one property — an `anyOf` is never inferred, so an `anyOf` of `Cat` and `Dog` with distinct `kind` consts carries no `discriminator`; or an allOf+oneOf dispatcher (no `variants`; the mapping alone names the variant models). Generate a dispatcher instead of a data class; `mapping` values are IR model names. A named union without one is emitted as an undiscriminated union of `variants`
  - `constraints?` — the object schema's own `minProperties` / `maxProperties` / `dependentRequired`
  - `extensions?` — the `x-*` keys of the schema the model was built from, keys as written and values verbatim, less `x-enum-descriptions` / `x-enumDescriptions`; read the keys you know (`x-since`) and escape a value before writing it into source, as you escape a description
- Each `Field` has:
  - `name` — wire key, as spelled in the spec
  - `domainName?` — domain-facing name override from `fieldHints`; derive the identifier from it, serialize with `name`
  - `type` — `TypeRef`
  - `required` — `boolean`
  - `description?`, `readOnly?`, `writeOnly?`, `deprecated?` — doc text and modifier flags
  - `externalDocs?` — the field schema's own link (a `$ref` sibling's included), for a `@see`-style tag. A bare `$ref` yields none — the referenced model, union or enum carries its own — unless it names an array component, which has no model to carry it: the field then takes the component's, read through any alias of it, by the one rule `description`, `deprecated`, `externalDocs`, `extensions`, `example` / `examples`, `readOnly`, `writeOnly`, `default` and `constraints` share (the component's limits conjoined with the field's own)
  - `default?`, `example?`, `examples?` — spec-declared values (`example` is the schema's `example`, else `examples[0]`)
  - `constraints?` — validation keywords on the field's schema (`Constraints`)
  - `extensions?` — the field schema's own `x-*` keys (a `$ref` sibling's included; a bare `$ref` yields none unless it names an array component, whose keys the field then carries under its own, as it carries that component's `externalDocs`); escape a value before writing it into source
- Output: One file per model, using the exact model pattern from the design doc
- Use `type-map.ts` to convert field types

**For Scenario A:** If the existing SDK uses a dual type system (e.g., separate `Organization` and `OrganizationResponse` types), this generator must produce BOTH types. If the SDK has specific decorators, base classes, or factory methods on models, replicate them.

---

## Enums

- Input: `Enum[]`. Each `Enum` has:
  - `name` — PascalCase enum name
  - `description?` — the enum schema's own description, when it has content: a component enum's, or the inline schema's the enum was lifted from (a collapsed nullable or single-member `allOf` wrapper's text wins over its branch's); emit it as the enum's doc comment
  - `values` — `EnumValue[]`
  - `default?` — the schema's `default:` value (`string | number`)
  - `externalDocs?` — the enum schema's link, when usable: a component enum's own, or the inline schema's an enum was lifted from
  - `deprecated?` — present and `true` when the component enum schema says `deprecated: true`
  - `extensions?` — the `x-*` keys of the schema that declares the members (a component enum's own, or the inline schema's the enum was lifted from; a collapsed wrapper's keys win over its branch's), less `x-enum-descriptions` / `x-enumDescriptions`; escape a value before writing it into source
- Each `EnumValue` has:
  - `name` — UPPER_SNAKE_CASE display name
  - `value` — the spec's value, `string | number` (numeric enums keep numbers)
  - `description?` — the value's own documentation: a `oneOf`-of-`const` member's `description`, else its `x-enum-descriptions` / `x-enumDescriptions` entry; absent otherwise
  - `deprecated?` — present and `true` when the value's `const` member says `deprecated: true` (a plain `enum:` list never sets it); emit the language's deprecation marker on that member
- Output: One file per enum, using the exact enum pattern from the design doc

---

## Resources

- Input: `Service[]`. Each `Service` has:
  - `name` — PascalCase service name (becomes the resource class)
  - `description?` — from the matching document tag
  - `externalDocs?` — the tag's link, when usable
  - `operations` — `Operation[]`
- Each `Operation` has (the authoritative list is `Operation` in `src/ir/types.ts`):
  - `name` — method name, e.g. `listUsers`
  - `summary?` — the `summary` alone: the operation's own, else its Path Item's
  - `description?` — combined doc text: `summary + "\n\n" + description`, or whichever one has content; each part is the operation's own, else its Path Item's
  - `externalDocs?` — the operation's own link, when usable
  - `httpMethod` — `get` | `post` | `put` | `patch` | `delete` | `head` | `options` | `trace`
  - `path` — e.g. `/organizations/{id}`
  - `pathParams`, `queryParams`, `headerParams` — `Parameter[]` per location; always present, possibly empty. Each `name` is as the spec wrote it; a parameter's identity is its location plus name, a header's name compared case-insensitively (`parameterKey` from `@workos/oagen`), so one list never holds two headers that differ in case alone. An `Idempotency-Key` header parameter (any case) is not in `headerParams`: it sets `injectIdempotencyKey` instead, and its `description`, `required` and schema do not reach the IR
  - `bodyOwnedQueryParams?` — query declarations the request body also owns; never serialize these to the URL
  - `cookieParams?` — `Parameter[]`, present only when the operation declares cookie parameters
  - `requestBody?` — `TypeRef` of the request body, read from one `content` entry by media type essence (parameters and case aside): `application/json`, else a concrete `+json` media type, else `multipart/form-data`, else `application/x-www-form-urlencoded` (each only with a schema), else `application/octet-stream`, else `text/plain`; absent, with a parser warning, when none of the declared media types is read
  - `requestBodyEncoding?` — `json` (`application/json` and any concrete `+json` media type) | `form-data` | `form-urlencoded` | `binary` | `text`; selects the serialization, while `requestBodyContentType` is the `Content-Type` to send; set exactly when `requestBody` is
  - `requestBodyRequired?` — whether the caller must send the body; present exactly when `requestBodyContentTypes` is, so a body carried in `requestBodyContents` alone has it too and it does not imply `requestBody`
  - `requestBodyDescription?` — the request body's doc text: the Request Body Object's own `description`, else the `description` written on the schema `requestBody` was read from (a `$ref` not followed); present only when one has non-whitespace content, for the body argument's doc tag (a `Webhook` carries the same for its payload)
  - `requestBodyContentType?` — the essence of the media type `requestBody` was read from (`application/merge-patch+json`; `application/json` for `application/json; charset=utf-8`); send it as the `Content-Type`, producing parameters such as a multipart boundary yourself; set exactly when `requestBody` is
  - `requestBodyContentTypes?`, `requestBodyContents?` — every media type the request body declares, as written and in document order, with a `TypeRef` per media type (the entry `requestBody` was read from shares its `TypeRef`); present only when the body declares at least one, so a body argument or serializer per media type can be offered
  - `response` — `TypeRef` of the primary response: the lowest 2xx with a typed body, else the lowest declared 2xx/3xx (`unknown` when the operation declares neither)
  - `responseHeaders?` — `ResponseHeader[]` the primary response declares
  - `responseDescription?` — the primary response's `description`, for a `@returns`-style tag
  - `responseStatusCode?` — the status code of the primary response (`200`, `201`, a lone `302`), present exactly when the operation declares at least one 2xx or 3xx response
  - `responseContentTypes?`, `responseContents?` — the media types the primary response declares, as written and in document order, with a `TypeRef` per media type (the entry `response` was read from shares its `TypeRef`); present only when it declares at least one, so an `Accept` header or a per-format decoder can be offered
  - `successResponses?` — every declared 2xx and 3xx response (`statusCode`, `type`, `headers?`, `description?`, `contentTypes?`, `contents?`), set only when more than one is declared; a 3xx entry's `type` is `unknown`
  - `errors` — `ErrorResponse[]` for 4xx/5xx (`statusCode`, `type?`, `headers?`, `description?`, `contentTypes?`, `contents?`; the two lists only when they say something `type` does not)
  - `defaultResponse?`, `rangeResponses?` — the `default` response and the `1XX`–`5XX` range responses (`type?`, `headers?`, `description?`, `contentTypes?`, `contents?`; a range entry also carries `range`), present only when declared. Resolve a status as the explicit entry, then its range, then `defaultResponse`: an operation declaring only `2XX` or `default` has `response` as `unknown`, and its real body type lives here
  - `pagination?` — `PaginationMeta` when the operation is paginated: `strategy` (`cursor` | `offset` | `page` | `link-header`), `param`, `limitParam?`, `pageStart?`, `dataPath?`, `dataDescription?`, `itemType`, `envelopeFields?`, `endOfIteration?`. To reach the next page: `cursor` sends the cursor the previous response returned in `param`; `offset` adds the items received to `param` and sends the page size in `limitParam`; `page` sends `pageStart` first and adds exactly one per request; `link-header` follows the `Link: <…>; rel="next"` response header. Every iterator stops on an empty page; `endOfIteration` (`{ kind: 'hasMore' | 'totalPages' | 'totalCount', path }`), when present, names the response field that ends it one request sooner, whatever the strategy: `hasMore` — stop when it is `false`; `totalPages` — stop once the pages fetched so far reach it (`page - pageStart + 1 >= totalPages` under `page`, `floor(offset / limit) + 1 >= totalPages` under `offset`, the number of requests made under `cursor`); `totalCount` — stop once the items received so far reach it
  - `injectIdempotencyKey` — `true` when the spec declares an `Idempotency-Key` header parameter on the operation, which is then left out of `headerParams`: generate and send the header yourself
  - `deprecated?` — present, and `true`, only when the Operation Object says `deprecated: true`
  - `async?` — the Operation Object's `x-oagen-async` extension, carried as the document writes it (no test or coercion, so a non-boolean value such as `'yes'` arrives as that string); test `=== true`
  - `tags?` — the operation's `tags` in document order, present only when at least one usable entry remains; for grouping or doc comments (the parser already named the service from the first tag that has a name, or from the path when none has one, as for an untagged operation)
  - `security?` — per-operation `SecurityRequirementSet[]`; `undefined` inherits `ApiSpec.security`
  - `servers?` — set only when the operation (or its Path Item) declares servers that differ from the document's; send its requests to `op.servers ?? spec.servers`
  - `parameterGroups?` — mutually-exclusive parameter groups (`name`, `optional`, `variants`, `wrapperName?`) for sum-type rendering; the grouped parameters stay in their location arrays
  - `extensions?` — the Operation Object's own `x-*` keys, keys as written and values verbatim, less the ones the parser reads into typed fields (`x-pagination`, `x-oagen-async`, `x-mutually-exclusive-parameter-groups`, `x-mutually-exclusive-body-groups`); read the keys you know (`x-idempotent`, `x-since`) and escape a value before writing it into source
- Each `Parameter` has `name`, `type`, `required`, `description?`, `deprecated?`, `externalDocs?` (the parameter schema's link, else its `$ref` target's), `default?`, `example?`, `examples?`, `style?`, `explode?`, `contentType?` (the `content` key a `content`-declared parameter is serialized under, e.g. `application/json`: serialize the value in that media type instead of by `style`/`explode`), `contentTypes?` (every media type the `content` map declares, as written, read or not; a map none of whose media types is read has no `contentType`, and its string value is sent as written), `constraints?`
  - `type` may reference a model the parser created for an inline object parameter (`style: deepObject` → `PetsFilter`), or an array, map or union of such, exactly as a response header's does; render it as that model and serialize it per `style`/`explode`
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
- Response media types: `Operation.response` is the body of one media type, the parser's fixed-order pick, while `responseContentTypes` / `responseContents` (and `contentTypes` / `contents` on each `SuccessResponse`, `ErrorResponse`, `DefaultResponse` and `RangeResponse`) list every media type the response declares with a type per media type. When a response offers several, send the picked one as `Accept` — or expose an option per media type and decode the body by the `Content-Type` the server returns — rather than assuming one body type per response
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

Type the error bodies the spec declares, not only the status codes:

- `ErrorResponse.type` on each `Operation.errors` entry is the body of that status code: a `$ref` body references the component model; an inline object body is a model the parser mints as `<Op>Error<code>` (`GetPetError404`, nested objects `GetPetError404Details`) that `generateModels` emits; a body that is itself an inline enum (or an array of one) is an `Enum` of the same name in `spec.enums` that `generateEnums` emits. Give the raised error a typed `body` (or a typed subclass per status code) from it
- `Operation.defaultResponse` (the `default` response) and `Operation.rangeResponses` (`1XX`–`5XX`) type the statuses an operation does not list: resolve a status as the explicit entry, then its range, then `defaultResponse`. In practice `defaultResponse.type` is the API's error shape, so an error for a status not in `errors` can still carry a typed body; a `4XX`/`5XX` range body is named `<Op>Error4Xx` / `<Op>Error5Xx`. These two fields also hold the success body of an operation with no explicit 2xx (`response` is `unknown` there; use the `2XX` range's `type`, then `defaultResponse.type`)
- Each error, `default` and range entry carries its `headers` (`Retry-After` on a 429) and `description` for the error's accessors and doc comment. Read `contentTypes` / `contents` whenever present, even for a single media type: `type` is the JSON body alone (`application/json`, else the first `+json` media type), so a body offered only as `text/plain` or another non-JSON media type leaves `type` unset and its type lives in `contents[0].type`

**For Scenario A:** Match the existing SDK's error class names and hierarchy exactly. If the SDK names it `BadRequestException` instead of `UnprocessableEntityError`, use the SDK's name.

---

## Config

Configuration class/module with: `api_key`, `base_url`, `max_retries`, `timeout`. Environment variable default for API key.

- `base_url` defaults to `spec.baseUrl` — the first `servers` entry with each variable's `default` filled in (`https://eu.api.example.com/v1`) — and stays overridable by the caller. A variable with no usable `default`, or one the entry never declares, keeps its `{region}` placeholder in `spec.baseUrl` (the parser warns), so do not treat the string as always resolved: `resolveServerUrl(entry).unresolved` lists the variables still missing, and an emitter that finds any should surface the template rather than ship it as a working default address.
- When `spec.servers` has more than one entry, or an entry declares `variables`, expose the choice (named constants, or an environment/region picker) instead of only the default. Each entry keeps its `url` template, `description` and `variables` (`default`, `enum`, `description`); `resolveServerUrl(entry)` from `@workos/oagen` fills the defaults exactly as the parser produced `baseUrl`, so do not re-implement the template substitution. `check-emitter-parity` reports `ApiSpec.servers` as a gap when an emitter never reads it.

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
