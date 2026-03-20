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
- `pagination` — Auto-paging iterator generation (cursor, offset, link-header strategies)
- `requestBodyEncoding` — Content-type handling: json, form-data, form-urlencoded, binary, text
- `injectIdempotencyKey` — Whether to inject an idempotency key header

#### UnionType
- `discriminator` — Discriminator property and mapping for tagged unions
- `compositionKind` — Whether the union came from allOf (inheritance), oneOf (exclusive), or anyOf (open). Emitters use this to decide serialization strategy.

#### PrimitiveType
- `format` — Format hints like `date-time`, `uuid`, `email`, `uri`, `int64`. Determines whether to use language-specific types (e.g., `DateTime` in Ruby, `OffsetDateTime` in Kotlin).

#### ErrorResponse
- `type` — Structured error type for typed exception/error classes

### Priority: MEDIUM (documentation — affects developer experience)

#### ApiSpec
- `description` — API-level description for the root client class doc comment
- `servers` — Server entries (url, description)

#### Service
- `description` — Service-level description for resource class doc comment

#### Operation
- `description` — Method-level description
- `deprecated` — Deprecation marker on methods
- `async` — Async operation marker
- `successResponses` — Multiple 2xx response types
- `errors` — Error responses for exception/error documentation
- `cookieParams` — Cookie parameter handling

#### Parameter
- `description` — Parameter description content
- `deprecated` — Deprecated marker on params
- `default` — Default value annotation
- `example` — Example value annotation

#### Model
- `description` — Model-level doc comment
- `typeParams` — Generic type parameters

#### Field
- `description` — Field-level doc comment
- `readOnly` — Read-only annotation (language-appropriate: `readonly` in TS, `attr_reader` in Ruby, `val` in Kotlin, etc.)
- `writeOnly` — Write-only annotation
- `deprecated` — Deprecation marker on fields
- `default` — Default value annotation

#### EnumValue
- `description` — Enum value doc comment
- `deprecated` — Deprecation marker on enum values

## Step 3: Read Emitter Generators

Read all source files in `src/{language}/`.

### 3a: TypeRef Variant Coverage

Search for `switch` statements or conditional chains on `ref.kind`, `.kind`, or equivalent pattern-matching constructs. Verify that all 8 TypeRef kinds are handled: `primitive`, `array`, `model`, `enum`, `union`, `nullable`, `literal`, `map`. Also check for `assertNever` usage — emitters that use the exhaustive check helper are guaranteed to handle all variants at compile time.

### 3b: Field Coverage

For each IR field from Step 2, search for references to the field name in the emitter source. Consider a field "covered" if:

- The field name appears as a property access (e.g., `op.description`, `field.readOnly`)
- The field is used in conditional logic or output generation
- The field is iterated over (e.g., `op.cookieParams`, `op.successResponses`)

Use `Grep` with patterns like `\.description`, `\.readOnly`, `\.writeOnly`, `\.deprecated`, `\.default`, `\.example`, `\.async`, `\.cookieParams`, `\.successResponses`, `\.servers`, `\.typeParams`, `\.pagination`, `\.auth`, `\.requestBodyEncoding`, `\.injectIdempotencyKey`, `\.discriminator`, `\.compositionKind`, `\.format` scoped to the emitter source directory.

### 3c: Intentional Skips

If the emitter source contains comments like `// @oagen-ignore: <field>` or similar documented justifications for skipping a field, mark those fields as "intentionally skipped" rather than "missing." These are acceptable gaps — not every field applies to every language.

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

| IR Field | What to Generate |
|----------|-----------------|
| Missing TypeRef kinds | Add cases to type-mapping switch; use `assertNever` for compile-time exhaustiveness |
| `ApiSpec.auth` | Client constructor auth configuration (API key header, bearer token, OAuth flow) |
| `Operation.pagination` | Auto-paging iterator/generator that handles cursor, offset, or link-header strategies |
| `Operation.requestBodyEncoding` | Set correct Content-Type header; use multipart handling for form-data, raw bytes for binary |
| `Operation.injectIdempotencyKey` | Generate and attach `Idempotency-Key` header on applicable requests |
| `UnionType.discriminator` | Tagged union deserialization using the discriminator property and mapping |
| `UnionType.compositionKind` | Distinguish allOf (merge/inherit) from oneOf (exclusive union) from anyOf (open union) in serialization |
| `PrimitiveType.format` | Map formats to language types (e.g., `date-time` → `DateTime`/`OffsetDateTime`/`Time`, `uuid` → `UUID`) |
| `ErrorResponse.type` | Typed exception/error classes per status code |

### MEDIUM priority suggestions

| IR Field | What to Generate |
|----------|-----------------|
| `ApiSpec.description` | Doc comment on the root client class (e.g., YARD `#` for Ruby, KDoc `/**` for Kotlin, `///` for Rust, docstring for Python) |
| `ApiSpec.servers` | Server URL constants or configuration |
| `Operation.async` | Mark method as async or add async behavior hints (e.g., `async` in TS/Rust, coroutine in Kotlin, `async def` in Python) |
| `Operation.successResponses` | Document additional return types for each 2xx response |
| `Operation.cookieParams` | Document cookie parameters |
| `Parameter.description` | Document query/header/cookie params in method doc comments |
| `Parameter.deprecated` | Mark parameter as deprecated in docs |
| `Parameter.default` | Document default value |
| `Parameter.example` | Document example value |
| `Field.readOnly` | Read-only annotation and language-appropriate modifier (`readonly` in TS, `attr_reader` in Ruby, `val` in Kotlin, `pub` without setter in Rust) |
| `Field.writeOnly` | Write-only annotation in doc comments |
| `Field.default` | Document default value |

Include the specific file and approximate location where each fix should be applied.

## Output

The report is printed to stdout. No files are created or modified — this is a read-only audit.
