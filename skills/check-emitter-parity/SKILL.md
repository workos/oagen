---
name: check-emitter-parity
description: >-
  Audit an emitter's coverage of IR fields and produce a structured gap analysis.
  Use when checking if an emitter handles all IR types, after updating oagen,
  or verifying emitter completeness. Also triggers for "IR coverage",
  "emitter audit", "field coverage", "parity check".
---

# /check-emitter-parity

Audit an emitter's coverage of documentation-relevant IR fields and produce a structured gap analysis.

## Overview

The IR defines many fields that carry documentation or behavioral semantics (descriptions, deprecation, defaults, readOnly/writeOnly, examples, async, cookie params, success responses, etc.). Emitters should handle every field that is relevant to their target language. This skill automates the gap analysis by reading the IR types, scanning the emitter implementation, and reporting which fields are covered vs. ignored.

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

Read `src/ir/types.ts` from the oagen package. Extract every documentation-relevant field from these interfaces:

### ApiSpec
- `description` — API-level description for the root client class doc comment
- `servers` — Server entries (url, description)

### Service
- `description` — Service-level description for resource class doc comment

### Operation
- `description` — Method-level description
- `deprecated` — Deprecation marker on methods
- `async` — Async operation marker
- `successResponses` — Multiple 2xx response types
- `errors` — Error responses for exception/error documentation
- `cookieParams` — Cookie parameter handling

### Parameter
- `description` — Parameter description content
- `deprecated` — Deprecated marker on params
- `default` — Default value annotation
- `example` — Example value annotation

### Model
- `description` — Model-level doc comment
- `typeParams` — Generic type parameters

### Field
- `description` — Field-level doc comment
- `readOnly` — Read-only annotation (language-appropriate: `readonly` in TS, `attr_reader` in Ruby, `val` in Kotlin, etc.)
- `writeOnly` — Write-only annotation
- `deprecated` — Deprecation marker on fields
- `default` — Default value annotation

### EnumValue
- `description` — Enum value doc comment
- `deprecated` — Deprecation marker on enum values

## Step 3: Read Emitter Generators

Read all source files in `src/{language}/`. For each IR field from Step 2, search for references to the field name in the emitter source. Consider a field "covered" if:

- The field name appears as a property access (e.g., `op.description`, `field.readOnly`)
- The field is used in conditional logic or output generation
- The field is iterated over (e.g., `op.cookieParams`, `op.successResponses`)

Use `Grep` with patterns like `\.description`, `\.readOnly`, `\.writeOnly`, `\.deprecated`, `\.default`, `\.example`, `\.async`, `\.cookieParams`, `\.successResponses`, `\.servers`, `\.typeParams` scoped to the emitter source directory.

## Step 4: Produce Gap Analysis

Output a structured report:

```
=== Emitter Parity Report: {language} ===

COVERED (field is read/used in emitter output):
✓ ApiSpec.description → client.{ext}:47
✓ Service.description → resources.{ext}:130
✓ Operation.description → resources.{ext}:162
✓ Operation.deprecated → resources.{ext}:168
✓ Operation.errors → resources.{ext}:169
✓ Parameter.description → resources.{ext}:164
✓ Model.description → models.{ext}:165
✓ Model.typeParams → models.{ext}:161
✓ Field.description → models.{ext}:173
✓ Field.deprecated → models.{ext}:176
✓ EnumValue.description → enums.{ext}
✓ EnumValue.deprecated → enums.{ext}
...

GAPS (field exists in IR but not used by emitter):
✗ ApiSpec.servers — not referenced in any generator
✗ Operation.async — not referenced in any generator
✗ Operation.cookieParams — not referenced in any generator
✗ Operation.successResponses — not referenced in any generator
✗ Parameter.deprecated — not referenced in any generator
✗ Parameter.default — not referenced in any generator
✗ Parameter.example — not referenced in any generator
✗ Field.readOnly — not referenced in any generator
✗ Field.writeOnly — not referenced in any generator
✗ Field.default — not referenced in any generator
...

SCORE: 12/22 fields covered (55%)
```

## Step 5: Suggest Fixes

For each gap, provide a specific, actionable suggestion for what the emitter should generate **in its target language's idiomatic style**. Adapt the suggestion to the language's documentation and annotation conventions:

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
