---
name: check-emitter-parity
description: >-
  Audit an emitter's coverage of IR fields and produce a structured gap analysis.
  Use when checking if an emitter handles all IR types, after updating oagen,
  or verifying emitter completeness. Also triggers for "IR coverage",
  "emitter audit", "field coverage", "parity check".
---

# /check-emitter-parity

Audit an emitter's coverage of IR fields — both behavioral and documentation — and produce a structured, priority-tiered gap analysis.

## Overview

The IR defines fields that fall into two categories:

1. **Behavioral fields** affect generated code correctness: authentication, pagination, request body encoding, TypeRef variant handling, discriminated unions, idempotency keys. Missing these means the SDK won't work for certain API shapes.
2. **Documentation fields** affect developer experience: descriptions, deprecation markers, defaults, examples, readOnly/writeOnly. Missing these means the SDK compiles but is harder to use.

Emitters should handle every field relevant to their target language. This skill automates the gap analysis by reading the IR types, scanning the emitter implementation, and reporting which fields are covered vs. ignored — grouped by impact priority.

This skill is **language-agnostic** — it works for any emitter (Node, Ruby, Kotlin, Rust, Python, Go, etc.) by examining the emitter source files rather than assuming any particular output format.

## Accept Arguments

Accept `<language>` as an argument. If not provided, use `AskUserQuestion` to ask which language emitter to audit.

## Step 1: Resolve Paths

Determine required paths:

1. **Language**: from argument, or use `AskUserQuestion`: "Which language emitter do you want to audit?"
2. **oagen core path**: Check for `src/ir/types.ts` in the current directory, or `node_modules/@workos/oagen/src/ir/types.ts`. If neither exists, use `AskUserQuestion`: "Where is the oagen core package? (absolute or relative path)"
3. **Emitter project** (`project`): from argument, or use `AskUserQuestion`: "Where is your emitter project? (absolute or relative path, e.g. `../oagen-emitters`)"
4. **Emitter source directory**: `{project}/src/{language}/`

Validate that both the IR types file and the emitter source directory exist before proceeding.

## Step 2: Read IR Types

Read `src/ir/types.ts` from the oagen package. Extract fields dynamically from the interfaces — the list below is a reference guide for known fields, but always check the actual types file for any additions since this list was written.

### Priority: HIGH (behavioral — affects code correctness)

#### TypeRef Variant Coverage

Every emitter must handle all `TypeRef.kind` variants in its type-mapping logic. Check that the emitter handles each of these:

- `primitive` — basic types (string, integer, number, boolean, unknown)
- `array` — list/array types
- `model` — references to model definitions
- `enum` — references to enum definitions
- `union` — union/variant types
- `nullable` — nullable wrappers
- `literal` — literal value types
- `map` — dictionary/map types

A missing kind means an entire category of types won't generate correctly.

#### ApiSpec

- `auth` — Authentication schemes (bearer, apiKey, oauth2). Determines how the client authenticates requests.

#### Operation

- `pagination` — Auto-paging iterator generation (cursor, offset, page, link-header strategies; optional `endOfIteration` stop field)
- `requestBodyEncoding` — Body serialization: json (`application/json` and any concrete `+json` media type), form-data, form-urlencoded, binary, text
- `requestBodyRequired` — Whether the body argument is mandatory or optional
- `requestBodyContentType` — The media type to send as `Content-Type` (the picked entry's essence, `application/merge-patch+json`)
- `injectIdempotencyKey` — Whether to inject an idempotency key header (the `Idempotency-Key` parameter is left out of `headerParams`)
- `defaultResponse` — The `default` response: the body type for every status the operation does not list (typically the API's error shape), with its `headers`, `description` and `contentTypes` / `contents`. Types the errors an operation does not list individually, and the success body of an operation with no explicit 2xx (`response` is `unknown` there)
- `rangeResponses` — `1XX`–`5XX` range responses, each with the same fields; resolve a status as the explicit entry, then its range, then `defaultResponse`. A `4XX`/`5XX` body is an error body (`<Op>Error4Xx`); the `2XX` body is the success body when no explicit 2xx is declared

#### UnionType

- `discriminator` — Discriminator property and mapping for tagged unions
- `compositionKind` — Whether the union came from allOf (inheritance), oneOf (exclusive), or anyOf (open). Emitters use this to decide serialization strategy.

#### Model

- `variants` — The members of a named union (a component schema that is itself a `oneOf`/`anyOf`), one `TypeRef` per non-null variant; such a model must be emitted as a union of these, not as a data class — its `fields` are only the inline variants' properties merged as optional fields
- `compositionKind` — `oneOf` or `anyOf`, present exactly when `variants` is
- `discriminator` — Set on a discriminated named union (a `oneOf` or `anyOf` with an explicit `discriminator:` keyword, or a `oneOf` without the keyword whose variants are all nameable and pin distinct string constants on one property; an `anyOf` is never discriminated implicitly) and on an allOf+oneOf dispatcher (no `variants`; the mapping alone names them); generate a dispatcher from `property` and `mapping` (IR model names). A named union without one is an undiscriminated union of `variants`

#### PrimitiveType

- `format` — Format hints like `date-time`, `uuid`, `email`, `uri`, `int64`. Determines whether to use language-specific types (e.g., `DateTime` in Ruby, `OffsetDateTime` in Kotlin).

#### ErrorResponse

- `type` — Structured error type for typed exception/error classes: a component model for a `$ref` body, a `<Op>Error<code>` model `generateModels` emits for an inline object body, or a `<Op>Error<code>` enum `generateEnums` emits for a body that is itself an inline enum
- `headers` — Declared response headers (e.g. `Retry-After` on a 429) for typed error accessors

### Priority: MEDIUM (documentation — affects developer experience)

#### ApiSpec

- `description` — API-level description for the root client class doc comment
- `externalDocs` — The document's link to fuller documentation (`url`, optional `description`), for a `@see`-style doc tag
- `servers` — Server entries (url, description, variables with default/enum/description; `resolveServerUrl` fills a template's defaults, `normalizeServerUrl` gives the RFC 3986 form two spellings of one URL share)
- `webhooks` — Requests the API sends to its users (OpenAPI 3.1 `webhooks`), each with a payload type, the headers it carries, and the `summary`, `description` and `externalDocs` an operation has

#### Service

- `description` — Service-level description for resource class doc comment
- `externalDocs` — The tag's link, for the resource class doc comment

#### Operation

- `description` — Method-level description (the operation's own `summary` and `description`, each falling back to its Path Item's)
- `externalDocs` — The operation's link, for the method doc comment
- `deprecated` — Deprecation marker on methods (the Operation Object's own keyword)
- `async` — Async operation marker
- `successResponses` — Every declared 2xx and 3xx response, set when there is more than one; a 3xx entry's `type` is `unknown`
- `responseHeaders` — Headers declared on the primary response (`Content-Disposition`, `Location`, `ETag`, rate limits); each carries `description`, `deprecated` and `externalDocs`
- `responseDescription` — The primary response's description, for a `@returns`-style doc tag
- `responseStatusCode` — The primary response's status code (`200`, `201`, `204`, a lone `302`), for an SDK that checks or documents the status it expects; absent when the operation declares no 2xx or 3xx response
- `responseContentTypes` — Media types the primary response offers (`text/html` and `application/pdf`), with a type per media type in `responseContents`; drives `Accept` headers and per-format return types
- `requestBodyContentTypes` — Media types the request body accepts (`application/json` and `text/csv`), with a type per media type in `requestBodyContents`; drives a body argument or serializer per media type
- `requestBodyDescription` — The request body's doc text (the Request Body Object's own, else its picked schema's), for the body argument's doc tag; also on `Webhook`
- `errors` — Error responses for exception/error documentation (each carries its own `description`)
- `cookieParams` — Cookie parameter handling
- `tags` — The operation's tags in document order, present only when at least one usable entry remains; for grouping or doc comments
- `servers` — Operation-level servers (own, else the Path Item's), present only when they differ from `ApiSpec.servers`; a request goes to `op.servers ?? spec.servers`
- `extensions` — The Operation Object's own `x-*` keys, as written, less the ones the parser reads into typed fields (`x-pagination`, `x-oagen-async`, the two mutually-exclusive-group keys); for a key the SDK knows (`x-idempotent` → retry policy, `x-since` → an `@since` tag)

#### Parameter

- `type` — Every `TypeRef` kind, a model reference included: an inline object parameter (`style: deepObject`), or an array, map or union holding one, references a model the parser created (`PetsFilter`), as a response header's does
- `description` — Parameter description content
- `externalDocs` — The parameter schema's link (falls back to its `$ref` target), for the param doc tag
- `deprecated` — Deprecated marker on params (`true` when any of the parameter object, its inline `schema` or the `$ref`'d component schema says `deprecated: true`)
- `default` — Default value annotation
- `example` — Example value annotation
- `constraints` — Validation limits (min/max, length, pattern, item counts) for doc comments or argument checks
- `examples` — Every example value (the list `example` is drawn from)
- `contentType` — The media type a `content`-declared parameter's value is serialized in (`application/json`): the value must be encoded in it (JSON) rather than by `style`/`explode`; absent for a `schema` parameter
- `contentTypes` — Every media type a `content`-declared parameter's map declares, as written, read or not, for the param doc tag: a map none of whose media types is read has no `contentType`, and its string value is sent as written

#### Model

- `description` — Model-level doc comment
- `externalDocs` — The schema's link, for the model doc comment (an `Enum` carries one the same way, component or lifted inline)
- `deprecated` — Deprecation marker on models (present, and `true`, only when the schema the model was built from says `deprecated: true` — the literal `true`, any other value sets nothing; never an `allOf` member's)
- `typeParams` — Generic type parameters
- `constraints` — Object-level limits (`minProperties`, `maxProperties`, `dependentRequired`)
- `extensions` — The `x-*` keys of the schema the model was built from, as written, less `x-enum-descriptions` / `x-enumDescriptions`; for a key the SDK knows (`x-since` → an `@since` tag)

#### Field

- `description` — Field-level doc comment
- `externalDocs` — The field schema's own link (a `$ref` sibling's included; a bare `$ref` yields none unless it names an array component, whose link the field carries), for the field doc comment
- `readOnly` — Read-only annotation (language-appropriate: `readonly` in TS, `attr_reader` in Ruby, `val` in Kotlin, etc.)
- `writeOnly` — Write-only annotation
- `deprecated` — Deprecation marker on fields (the property schema's own keyword, a `$ref` sibling included; the referenced model keeps its own, except that a bare `$ref` to an array component, which has no model, deprecates the field when the component says `deprecated: true`)
- `default` — Default value annotation
- `example` — Example value annotation
- `examples` — Every example value (the list `example` is drawn from)
- `constraints` — Validation limits (min/max, length, pattern, item counts) for doc comments or value checks
- `extensions` — The field schema's own `x-*` keys (a `$ref` sibling's included; a bare `$ref` yields none unless it names an array component, whose keys the field carries under its own, as it carries that component's `externalDocs`), as written; for a key the SDK knows

#### Enum

- `description` — Enum doc comment (the enum schema's own `description`: a component enum's, or the inline schema's the enum was lifted from; a collapsed nullable or single-member `allOf` wrapper's text wins over its branch's)
- `default` — The schema's `default:` value, for a default-value annotation
- `externalDocs` — Link to external documentation, for a `@see`-style tag
- `deprecated` — Deprecation marker on enums (present, and `true`, only when the component enum schema says `deprecated: true` — the literal `true`, any other value sets nothing; an inline enum carries no flag of its own)
- `extensions` — The `x-*` keys of the schema that declares the members (a component enum's own, or the inline schema's the enum was lifted from), as written, less `x-enum-descriptions` / `x-enumDescriptions`; for a key the SDK knows

#### EnumValue

- `description` — Enum value doc comment (a `oneOf`-of-`const` member's own `description`, else the value's `x-enum-descriptions` / `x-enumDescriptions` entry)
- `deprecated` — Deprecation marker on one enum value (`true` when the value's `const` member says `deprecated: true`; a plain `enum:` list never sets it)

## Step 3: Read Emitter Generators

Read all source files in `src/{language}/`.

### 3a: TypeRef Variant Coverage

Search for `switch` statements or conditional chains on `ref.kind`, `.kind`, or equivalent pattern-matching constructs. Verify that all 8 TypeRef kinds are handled: `primitive`, `array`, `model`, `enum`, `union`, `nullable`, `literal`, `map`. Also check for `assertNever` usage — emitters that use the exhaustive check helper are guaranteed to handle all variants at compile time.

### 3b: Field Coverage

For each IR field from Step 2, search for references to the field name in the emitter source. Consider a field "covered" if:

- The field name appears as a property access (e.g., `op.description`, `field.readOnly`)
- The field is used in conditional logic or output generation
- The field is iterated over (e.g., `op.cookieParams`, `op.successResponses`)

Use `Grep` with patterns like `\.description`, `\.externalDocs`, `\.extensions`, `\.readOnly`, `\.writeOnly`, `\.deprecated`, `\.default`, `\.example`, `\.examples`, `\.async`, `\.cookieParams`, `\.successResponses`, `\.responseHeaders`, `\.responseDescription`, `\.responseContentTypes`, `\.defaultResponse`, `\.rangeResponses`, `\.servers`, `\.webhooks`, `\.typeParams`, `\.pagination`, `\.auth`, `\.requestBodyEncoding`, `\.requestBodyRequired`, `\.requestBodyDescription`, `\.requestBodyContentType`, `\.requestBodyContentTypes`, `\.injectIdempotencyKey`, `\.discriminator`, `\.compositionKind`, `\.variants`, `\.contentType`, `\.format`, `\.constraints` scoped to the emitter source directory.

### 3c: Intentional Skips

If the emitter source contains comments like `// @oagen-ignore: <field>` or similar documented justifications for skipping a field, mark those fields as "intentionally skipped" rather than "missing." These are acceptable gaps — not every field applies to every language.

### 3d: Free-Text Escaping (security)

Spec free-text fields (`description` on model/field/operation/parameter/enum/enum-value, every value in `extensions` on operation/model/field/enum, and `info.title` when it becomes the namespace) are attacker-influenceable. An emitter that interpolates them verbatim into output can be made to emit arbitrary source — a code-execution vector during `oagen generate` → `oagen verify` and in published SDKs.

For every covered free-text field, check that the emitter escapes it at the interpolation site:

- **Doc comments** — the field must be wrapped so a comment terminator cannot break out. The core exports `escapeBlockComment` for JS/TS-style `/** */` comments; it is **specific to languages whose block comments end at `*/`** (JS, TS, Java, C#, Kotlin, Go). Emitters for other comment syntaxes need their own escaping: Python `"""` docstrings, Ruby `#`/`=begin` and other line-comment styles (where an embedded newline starts a new source line), etc.
- **Identifier positions** — free-text flowing into a class/variable name (notably `info.title` → namespace → client class) must be run through `sanitizeIdentifier` (or an equivalent) so it cannot break out of the declaration.

Report a covered-but-unescaped free-text field as a **HIGH-priority security gap**, distinct from a missing-coverage gap: the field is handled, but unsafely.

## Step 4: Produce Gap Analysis

Output a structured report grouped by priority tier:

```
=== Emitter Parity Report: {language} ===

--- TypeRef Variant Coverage ---
✓ primitive, array, model, enum, union, nullable, literal, map
  (all 8 variants handled — uses assertNever exhaustive check)
  OR
✗ Missing variants: literal, map
  (only 6/8 handled — these type categories will not generate)

--- HIGH PRIORITY (behavioral) ---
✓ ApiSpec.auth → client.{ext}:23
✓ Operation.pagination → resources.{ext}:200
✗ Operation.requestBodyEncoding — not referenced
✗ Operation.injectIdempotencyKey — not referenced
✗ UnionType.discriminator — not referenced
✗ UnionType.compositionKind — not referenced
✗ PrimitiveType.format — not referenced
✗ ErrorResponse.type — not referenced

--- MEDIUM PRIORITY (documentation) ---
✓ ApiSpec.description → client.{ext}:47
✓ Service.description → resources.{ext}:130
✓ Operation.description → resources.{ext}:162
✓ Operation.deprecated → resources.{ext}:168
...
✗ Field.readOnly — not referenced
✗ Field.writeOnly — not referenced
~ Parameter.example — intentionally skipped (// @oagen-ignore: no example support in target)

--- INTENTIONALLY SKIPPED ---
~ Parameter.example — "no example support in target"

SCORE: 18/30 fields covered (60%)
  HIGH:  3/8  (38%) ← focus here first
  MEDIUM: 15/22 (68%)
```

## Step 5: Suggest Fixes

For each gap, provide a specific, actionable suggestion for what the emitter should generate **in its target language's idiomatic style**. Adapt the suggestion to the language's conventions. Group suggestions by priority — HIGH gaps first.

### HIGH priority suggestions

| IR Field                           | What to Generate                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing TypeRef kinds              | Add cases to type-mapping switch; use `assertNever` for compile-time exhaustiveness                                                                                        |
| `ApiSpec.auth`                     | Client constructor auth configuration (API key header, bearer token, OAuth flow)                                                                                           |
| `Operation.pagination`             | Auto-paging iterator/generator that handles cursor, offset, page, or link-header strategies and stops on `endOfIteration`                                                  |
| `Operation.requestBodyEncoding`    | Serialize the body to match: multipart handling for form-data, raw bytes for binary (the `Content-Type` header comes from `requestBodyContentType`)                        |
| `Operation.requestBodyRequired`    | Make the body argument mandatory when `true`; when `false`, make it optional and omit the body only if the caller leaves it out                                            |
| `Operation.requestBodyContentType` | Send it as the `Content-Type` header, producing parameters such as a multipart boundary yourself                                                                           |
| `Operation.injectIdempotencyKey`   | Generate and attach `Idempotency-Key` header on applicable requests                                                                                                        |
| `Operation.defaultResponse`        | Type the error raised for a status `errors` does not list from `defaultResponse.type`; use it (after the `2XX` range) as the success body when no explicit 2xx is declared |
| `Operation.rangeResponses`         | Resolve a status as the explicit entry, then its range, then `defaultResponse`; type `4XX`/`5XX` errors and a `2XX` success body from the range entries                    |
| `UnionType.discriminator`          | Tagged union deserialization using the discriminator property and mapping                                                                                                  |
| `UnionType.compositionKind`        | Distinguish allOf (merge/inherit) from oneOf (exclusive union) from anyOf (open union) in serialization                                                                    |
| `Model.variants`                   | Emit a named union as a union type of its variants (dispatched on `Model.discriminator` when set), not as a data class of `fields`                                         |
| `PrimitiveType.format`             | Map formats to language types (e.g., `date-time` → `DateTime`/`OffsetDateTime`/`Time`, `uuid` → `UUID`)                                                                    |
| `ErrorResponse.type`               | Typed exception/error classes per status code, with the body typed as the `<Op>Error<code>` model or enum the parser mints                                                 |

### MEDIUM priority suggestions

| IR Field                           | What to Generate                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ApiSpec.description`              | Doc comment on the root client class (e.g., YARD `#` for Ruby, KDoc `/**` for Kotlin, `///` for Rust, docstring for Python)                                  |
| `ApiSpec.servers`                  | Server URL constants or configuration                                                                                                                        |
| `ApiSpec.webhooks`                 | A payload type (or typed handler) per event, keyed by `name` + `httpMethod`; the payload model is already in `spec.models`                                   |
| `Operation.async`                  | Mark method as async or add async behavior hints (e.g., `async` in TS/Rust, coroutine in Kotlin, `async def` in Python)                                      |
| `Operation.successResponses`       | Document each 2xx entry's return type; treat a 3xx entry (`type` is `unknown`) as a redirect, not a body                                                     |
| `Operation.responseHeaders`        | Typed accessors for declared response headers (download filename, `Location`, `ETag`, rate limits)                                                           |
| `Operation.responseContents`       | An `Accept` option per media type (`responseContentTypes`) and a return type per media type when a response offers several                                   |
| `Operation.requestBodyContents`    | A body argument or serializer per media type (`requestBodyContentTypes`) when a body accepts several                                                         |
| `Operation.requestBodyDescription` | Print it as the body argument's doc text (a `@param body` tag); `Webhook.requestBodyDescription` documents the payload the same way                          |
| `Operation.cookieParams`           | Document cookie parameters                                                                                                                                   |
| `Operation.servers`                | Send the operation's requests to its own server (`op.servers ?? spec.servers`) instead of the client's base URL                                              |
| `Parameter.description`            | Document query/header/cookie params in method doc comments                                                                                                   |
| `Parameter.externalDocs`           | Link fuller documentation from the param doc tag (e.g. a `@see`); `Field`, `Model`, `Enum`, `Operation`, `Webhook`, `Service` and `ApiSpec` carry the same   |
| `Parameter.deprecated`             | Mark parameter as deprecated in docs                                                                                                                         |
| `Model.deprecated`                 | Deprecation marker on the generated type (`@deprecated` tag, `[Obsolete]`, `#[deprecated]`)                                                                  |
| `Enum.deprecated`                  | Deprecation marker on the generated enum type, as for `Model.deprecated`                                                                                     |
| `Operation.extensions`             | Read the `x-*` keys the SDK knows (`x-idempotent` → safe to retry, `x-since` → an `@since` tag); `Model`, `Field` and `Enum` carry `extensions` the same way |
| `Enum.default`                     | Document the enum's default value                                                                                                                            |
| `Parameter.default`                | Document default value                                                                                                                                       |
| `Parameter.example`                | Document example value                                                                                                                                       |
| `Parameter.examples`               | Document every example value (e.g. one `@example` tag each)                                                                                                  |
| `Field.readOnly`                   | Read-only annotation and language-appropriate modifier (`readonly` in TS, `attr_reader` in Ruby, `val` in Kotlin, `pub` without setter in Rust)              |
| `Field.writeOnly`                  | Write-only annotation in doc comments                                                                                                                        |
| `Field.default`                    | Document default value                                                                                                                                       |
| `Field.example`                    | Document example value                                                                                                                                       |
| `Field.examples`                   | Document every example value (e.g. one `@example` tag each)                                                                                                  |
| `Field.constraints`                | Document limits ("at most 100 characters") or validate before serializing                                                                                    |
| `Parameter.constraints`            | Document limits on method arguments or validate before sending                                                                                               |

Include the specific file and approximate location where each fix should be applied.

## Output

The report is printed to stdout. No files are created or modified — this is a read-only audit.
