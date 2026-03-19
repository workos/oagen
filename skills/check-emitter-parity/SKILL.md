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
- `description` — API-level description for the root client class JSDoc
- `servers` — Server entries (url, description)

### Service
- `description` — Service-level description for resource class JSDoc

### Operation
- `description` — Method-level description
- `deprecated` — `@deprecated` tag on methods
- `async` — Async operation marker
- `successResponses` — Multiple 2xx response types
- `errors` — Error responses (`@throws` tags)
- `cookieParams` — Cookie parameter handling

### Parameter
- `description` — `@param` tag content
- `deprecated` — Deprecated marker on params
- `default` — Default value annotation
- `example` — Example value annotation

### Model
- `description` — Model-level JSDoc
- `typeParams` — Generic type parameters

### Field
- `description` — Field-level JSDoc
- `readOnly` — Read-only annotation and TS `readonly` modifier
- `writeOnly` — Write-only annotation
- `deprecated` — `@deprecated` tag on fields
- `default` — `@default` tag

### EnumValue
- `description` — Enum value JSDoc
- `deprecated` — `@deprecated` tag on enum values

## Step 3: Read Emitter Generators

Read all `.ts` files in `src/{language}/`. For each IR field from Step 2, search for references to the field name in the emitter source. Consider a field "covered" if:

- The field name appears as a property access (e.g., `op.description`, `field.readOnly`)
- The field is used in conditional logic or output generation
- The field is iterated over (e.g., `op.cookieParams`, `op.successResponses`)

Use `Grep` with patterns like `\.description`, `\.readOnly`, `\.writeOnly`, `\.deprecated`, `\.default`, `\.example`, `\.async`, `\.cookieParams`, `\.successResponses`, `\.servers`, `\.typeParams` scoped to the emitter source directory.

## Step 4: Produce Gap Analysis

Output a structured report:

```
=== Emitter Parity Report: {language} ===

COVERED (field is read/used in emitter output):
✓ ApiSpec.description → client.ts:47
✓ Service.description → resources.ts:130
✓ Operation.description → resources.ts:162
✓ Operation.deprecated → resources.ts:168
✓ Operation.errors → resources.ts:169
✓ Parameter.description → resources.ts:164
✓ Model.description → models.ts:165
✓ Model.typeParams → models.ts:161
✓ Field.description → models.ts:173
✓ Field.deprecated → models.ts:176
✓ EnumValue.description → enums.ts
✓ EnumValue.deprecated → enums.ts
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

For each gap, provide a specific, actionable suggestion for what the emitter should generate:

| IR Field | Suggested Emitter Output |
|----------|--------------------------|
| `ApiSpec.description` | JSDoc on the root client class |
| `ApiSpec.servers` | Server URL constants or configuration |
| `Operation.async` | Mark method or add async behavior hints |
| `Operation.successResponses` | Additional `@returns` lines for each 2xx response |
| `Operation.cookieParams` | `@param` tags for cookie parameters |
| `Parameter.description` | `@param` tags for query/header/cookie params (non-path) |
| `Parameter.deprecated` | `(deprecated)` prefix in param description |
| `Parameter.default` | `@default` tag in param docs |
| `Parameter.example` | `@example` tag in param docs |
| `Field.readOnly` | `@readonly` JSDoc tag + TS `readonly` modifier |
| `Field.writeOnly` | `@writeonly` JSDoc tag (informational) |
| `Field.default` | `@default {value}` JSDoc tag |

Include the specific file and approximate location where each fix should be applied.

## Output

The report is printed to stdout. No files are created or modified — this is a read-only audit.
