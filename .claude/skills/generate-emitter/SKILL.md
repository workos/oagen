---
name: generate-emitter
description: Scaffold a new language emitter for oagen, implementing the Emitter interface with idiomatic target-language code generation. Use this skill whenever the user wants to add a new target language, generate SDKs for a new language, add Go/Python/Kotlin/Java/etc. support, or asks about creating an emitter — even if they don't use the word "emitter" explicitly.
arguments:
  - name: language
    description: Target language name (e.g., "python", "go", "kotlin")
    required: true
  - name: sdk_design_path
    description: Path to an SDK_DESIGN.md or existing SDK to use as the reference for idiomatic patterns (optional)
    required: false
---

# /generate-emitter

Scaffold a complete language emitter for oagen that translates the intermediate representation (IR) into idiomatic SDK code for a target language.

## Overview

oagen has a plugin architecture for code generation. Each target language is an **emitter** — a TypeScript module that implements the `Emitter` interface from `src/engine/types.ts`. An emitter receives parsed IR nodes (models, enums, services, etc.) and returns `GeneratedFile[]` — arrays of `{ path, content }` pairs. The engine orchestrator calls each emitter method, prepends a file header, and writes the results to disk.

The Ruby emitter at `src/emitters/ruby/` is the reference implementation. Use it as a structural template, but generate **idiomatic** code for the target language.

## Prerequisites

Before starting, read and understand these files:

1. **`src/engine/types.ts`** — The `Emitter` interface contract
2. **`src/ir/types.ts`** — The IR type system (`ApiSpec`, `Model`, `Enum`, `Service`, `Operation`, `TypeRef`, etc.)
3. **`src/emitters/ruby/`** — The reference emitter (study the structure, not the Ruby-specific output)
4. **`src/engine/registry.ts`** — How emitters are registered
5. **`src/cli/generate.ts`** — How emitters are wired into the CLI
6. **`src/cli/diff.ts`** — Also registers emitters for the diff command

If an `sdk_design_path` argument is provided, read that file to understand the target language's idiomatic patterns, naming conventions, and architecture. If a path to an existing SDK repo is given instead, explore its structure to extract patterns.

## Step 0: Gather Structural Guidelines from User

Before writing any code, you must ask the user to confirm the tooling and pattern choices for the target language. These choices drive every generator file.

### 0a. Load Known Defaults

Check if a `docs/sdk-designs/{language}.md` already exists for this language. If it does, its structural guidelines section is the source of truth — confirm with the user whether any changes are needed. If no design doc exists yet, propose sensible choices based on your knowledge of the language ecosystem.

### 0b. Present the Structural Guidelines Table

Use `AskUserQuestion` to walk through each category. For each category, explain **what it controls in the generated SDK** and ask the user to confirm or override the choice.

The categories are:

| Category                  | What it controls in the emitter                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| **Testing Framework**     | `tests.ts` — which test runner syntax to generate (assertions, test structure, setup/teardown) |
| **HTTP Mocking**          | `tests.ts` — how HTTP stubs are written in generated tests (request matching, response faking) |
| **Documentation**         | `models.ts`, `resources.ts` — docstring/annotation format on generated classes and methods     |
| **Type Signatures**       | `types-*.ts` — whether separate type annotation files are needed, and what format              |
| **Linting/Formatting**    | Validation step — which linter to run on generated output to verify style compliance           |
| **HTTP Client (default)** | `client.ts` — which HTTP library the generated client code uses for requests                   |
| **JSON Parsing**          | `client.ts` — how JSON serialization/deserialization is done in the generated client           |
| **Package Manager**       | `config.ts` — what package metadata file to reference (e.g., gemspec, pyproject.toml, go.mod)  |
| **Build Tool**            | Only if language needs one (e.g., `tsdown` for TypeScript, Gradle for Kotlin). Omit if N/A.    |

Ask these as a series of questions. For example, for Python you might ask:

> "For the Python emitter, I'll need your choices on tooling. Here's what I'd suggest based on common Python SDK patterns — confirm or override each:"
>
> 1. Testing Framework: **pytest** — generates `def test_list():` style tests with `assert` statements
> 2. HTTP Mocking: **respx** (pairs with httpx) — generates `respx.mock(...)` stubs in tests
> 3. Documentation: **Google-style docstrings** — generates `Args:` / `Returns:` blocks on methods
> 4. Type Signatures: **Inline type hints (PEP 484) + py.typed** — no separate stub files needed
> 5. Linting: **Ruff** — validates generated output in the smoke test
> 6. HTTP Client: **httpx** — generates sync client using `httpx.Client`
> 7. JSON Parsing: **json (stdlib)** — no external deps
> 8. Package Manager: **pip/uv with pyproject.toml** — PEP 621 metadata

The user may confirm all at once, override specific categories, or provide a complete table. Accept any format.

### 0c. Create SDK Design Document

With the structural guidelines confirmed, write the full SDK design document to `docs/sdk-designs/{language}.md`. This document is the **single source of truth** for the emitter, including the confirmed structural guidelines table.

If an `sdk_design_path` argument was provided, read that file to extract idiomatic patterns. Otherwise, use the confirmed structural guidelines plus your knowledge of the language to determine:

1. **Model pattern**: How are data classes defined? (dataclass, struct, POJO, etc.)
2. **Enum pattern**: How are enums defined? (native enum, string constants, frozen object, etc.)
3. **Error hierarchy**: How are errors represented? (exception classes, error types, result types)
4. **File naming**: What's the convention? (snake_case.py, PascalCase.kt, snake_case.go)
5. **Module/package system**: How is the namespace organized?
6. **Nullable/optional types**: How are they expressed?
7. **Path interpolation**: How are format strings done? (f-strings, fmt.Sprintf, String.format)

The design doc must include these sections (see `docs/sdk-designs/ruby.md` for a worked example):

- Architecture overview
- Naming conventions (OpenAPI → target language)
- Type mapping table (IR TypeRef → target language types → type annotation types)
- Model pattern with full example
- Enum pattern with full example
- Resource/client pattern with full example
- Error handling pattern
- Retry logic pattern
- Test pattern with full example
- Structural guidelines table (the confirmed tooling choices from Step 0)
- Directory structure of generated SDK

## Step 1: Scaffold Emitter Files

Create the following files under `src/emitters/{language}/`:

```
src/emitters/{language}/
├── index.ts          # Emitter entry point, implements Emitter interface
├── type-map.ts       # IR TypeRef → target language type string mapping
├── naming.ts         # Target-language naming conventions
├── models.ts         # IR Model → target language model/data class
├── enums.ts          # IR Enum → target language enum
├── resources.ts      # IR Service → target language resource/client class
├── client.ts         # HTTP client with retry logic
├── errors.ts         # Error class/type hierarchy
├── config.ts         # Configuration module/class
├── types-*.ts        # Type annotation files (language-specific, may be 0-2 files)
├── tests.ts          # Test file generation
└── fixtures.ts       # Test fixture generation
```

Not every language needs every file, and some languages may need **additional** files beyond this scaffold. For example:

- Go doesn't need separate type annotation files (types are inline)
- Python might need a single `types-pyi.ts` for `.pyi` stubs
- TypeScript SDK needs no separate type files (types are in the source)
- The Node emitter adds a `common.ts` file for shared utilities like pagination, wired through `generateConfig()` — other languages may need similar shared utility generators

Omit files that don't apply, and add language-specific utility files as needed. The `index.ts` must still implement all `Emitter` interface methods (return `[]` for inapplicable ones).

## Step 2: Implement Type Mapping (`type-map.ts`)

This is the foundation. Map every IR `TypeRef` kind to the target language's type representation.

### Required Mappings

Every type-map must handle these IR types:

| IR TypeRef                                                   | What to Map                    |
| ------------------------------------------------------------ | ------------------------------ |
| `{ kind: "primitive", type: "string" }`                      | String type                    |
| `{ kind: "primitive", type: "string", format: "date" }`      | Date type                      |
| `{ kind: "primitive", type: "string", format: "date-time" }` | DateTime type                  |
| `{ kind: "primitive", type: "string", format: "uuid" }`      | String or UUID type            |
| `{ kind: "primitive", type: "integer" }`                     | Integer type                   |
| `{ kind: "primitive", type: "number" }`                      | Float/double type              |
| `{ kind: "primitive", type: "boolean" }`                     | Boolean type                   |
| `{ kind: "array", items: ... }`                              | Array/list of mapped item type |
| `{ kind: "model", name: "Foo" }`                             | Reference to model class       |
| `{ kind: "enum", name: "Foo" }`                              | Reference to enum type         |
| `{ kind: "nullable", inner: ... }`                           | Optional/nullable wrapper      |
| `{ kind: "union", variants: [...] }`                         | Union/sum type                 |

Export a `mapTypeRef(typeRef: TypeRef, namespacePascal: string): string` function.

If the language has a separate type annotation system, also export mapping functions for those (e.g., `mapTypeRefForPyi`, `mapTypeRefForGoDoc`).

### Reference: Ruby Type Map

Study `src/emitters/ruby/type-map.ts` for the pattern. It exports `mapTypeRef` (for Ruby source), `mapTypeRefForRbs` (for RBS signatures), and `mapTypeRefForSorbet` (for Sorbet RBI).

## Step 3: Implement Naming Conventions (`naming.ts`)

Map oagen's PascalCase IR names to the target language's conventions.

### Required Functions

```typescript
// Class/type name: IR "UserProfile" → target convention
export function className(name: string): string;

// File name: IR "UserProfile" → target file name (without extension)
export function fileName(name: string): string;

// Method name: IR operation "list" → target convention
export function methodName(name: string): string;

// Full file path for a model/resource/etc.
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

Use the shared utilities from `src/utils/naming.ts` (`toPascalCase`, `toSnakeCase`, `toCamelCase`, `toKebabCase`, `toUpperSnakeCase`) as building blocks.

## Step 4: Implement Each Generator

For each generator file, follow this pattern:

1. **Read the corresponding Ruby file** to understand the structure
2. **Translate the output patterns** to the target language's idioms
3. **Use `GeneratedFile[]` return type** — each function receives IR nodes + `EmitterContext` and returns file path/content pairs

### Models (`models.ts`)

- Input: `Model[]` (each has `name`, `description?`, `fields[]`)
- Each `Field` has `name`, `type: TypeRef`, `required: boolean`, `description?`
- Output: One file per model in the target language's model pattern
- Use `type-map.ts` to convert field types

### Enums (`enums.ts`)

- Input: `Enum[]` (each has `name`, `values[]`)
- Each `EnumValue` has `name`, `value` (string), `description?`
- Output: One file per enum

### Resources (`resources.ts`)

- Input: `Service[]` (each has `name`, `operations[]`)
- Each `Operation` has: `name`, `httpMethod`, `path`, `pathParams`, `queryParams`, `requestBody?`, `response`, `paginated`, `idempotent`
- Output: One file per service/resource
- Handle:
  - Path parameter interpolation (e.g., `/orgs/{id}` → target language's format string mechanism)
  - Strip leading `/` from paths (use `"organizations"` not `"/organizations"`)
  - Paginated responses (pass page type and model type to the client request method)
  - Idempotent POST methods (include an idempotency key as a standalone parameter, not embedded in params)
  - Query parameters for list methods
  - A per-request options parameter on every method (last parameter, using the language's idiomatic calling convention)
  - Documentation for parameters and return types using the target language's standard docstring format
  - Delete methods signal "no response body" using the language's null/void type and return nil/null/unit

### Client (`client.ts`)

- Mostly static code with namespace interpolation
- Must include:
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

### Errors (`errors.ts`)

- Mostly static code with namespace interpolation
- Required error types: `APIError` (base), `AuthenticationError` (401), `NotFoundError` (404), `UnprocessableEntityError` (422), `RateLimitExceededError` (429), `ServerError` (500+), `NetworkError` (connection failures), `ConfigurationError` (missing API key)

### Config (`config.ts`)

- Configuration class/module with: `api_key`, `base_url`, `max_retries`, `timeout`
- Environment variable default for API key

### Type Signatures (`types-*.ts`)

- Language-specific. May be 0, 1, or 2 files depending on the language's type system.
- Examples: `.pyi` stubs for Python, `.d.ts` for JavaScript, nothing for Go/Rust (types are inline)
- Must include request options and idempotency key parameters on resource method signatures
- Must include enum type signatures using the target language's idiomatic enum representation
- Delete operations should return the language's void/null type

### Tests (`tests.ts`) and Fixtures (`fixtures.ts`)

- `generateTests` is the only Emitter interface method — it should internally call `generateFixtures` from `fixtures.ts` and combine both into a single `GeneratedFile[]` return
- Generate one test file per resource/service
- Use the target language's standard test framework
- Use the target language's HTTP mocking library
- Test file paths are language-specific — use the target language's idiomatic convention (e.g., Ruby uses `test/{namespace}/resources/{name}_test.rb`, Node uses `src/{service}/tests/{name}.test.ts`)
- Test classes/modules nested in namespace modules
- Each test: stub HTTP request → call method → assert response type using the language's idiomatic assertion style
- Include error tests (404, 401), retry tests (429 with Retry-After), and idempotency tests (explicit + auto-generated keys)
- Fixture JSON file paths are also language-specific — organize them near the test files using the target language's convention
- Use a `load_fixture` helper for reading fixtures
- Generate fixture JSON files from IR model schemas

## Step 5: Create Entry Point (`index.ts`)

Wire everything together by implementing the `Emitter` interface. Note that:

- `generateTests` internally calls `generateFixtures` — fixtures are not a separate Emitter method
- Interface methods can compose multiple generators (e.g., the Node emitter's `generateConfig` returns `[...generateConfig(ctx), ...generateCommon(ctx)]` to include shared utilities)
- Return `[]` for inapplicable methods (e.g., `generateTypeSignatures` for languages with inline types)

```typescript
import type { Emitter } from "../../engine/types.js";
// ... import all generators ...

export const {language}Emitter: Emitter = {
  language: "{language}",
  generateModels(models, ctx) { return generateModels(models, ctx); },
  generateEnums(enums, ctx) { return generateEnums(enums, ctx); },
  generateResources(services, ctx) { return generateResources(services, ctx); },
  generateClient(spec, ctx) { return generateClient(spec, ctx); },
  generateErrors(ctx) { return generateErrors(ctx); },
  generateConfig(ctx) { return generateConfig(ctx); },
  generateTypeSignatures(spec, ctx) { return generateTypeSignatures(spec, ctx); },
  generateTests(spec, ctx) { return generateTests(spec, ctx); }, // includes fixtures
  fileHeader() { return "{language-appropriate auto-generated file header}"; },
};
```

## Step 6: Register Emitter

Add the emitter to **both** CLI entry points:

**`src/cli/generate.ts`:**

```typescript
import { {language}Emitter } from "../emitters/{language}/index.js";
registerEmitter({language}Emitter);
```

**`src/cli/diff.ts`:**

```typescript
import { {language}Emitter } from "../emitters/{language}/index.js";
registerEmitter({language}Emitter);
```

## Step 7: Create Tests

Create test files under `test/emitters/{language}/`:

```
test/emitters/{language}/
├── models.test.ts      # Model generation tests
├── enums.test.ts       # Enum generation tests
├── resources.test.ts   # Resource generation tests
├── client.test.ts      # Client generation tests
├── errors.test.ts      # Error hierarchy tests
└── tests.test.ts       # Test generation tests (meta!)
```

### Test Strategy

For each generator, test:

1. **All type mappings** — every IR TypeRef kind produces correct target-language type
2. **Required vs optional fields** — correct annotation in target language
3. **File paths** — correct directory structure and naming convention
4. **Content snapshots** — use `toMatchInlineSnapshot()` for at least one representative case per generator
5. **Multiple items** — generates separate files for multiple models/services
6. **Edge cases** — nullable, union, nested model refs, enum refs, arrays of models

### Shared Test Context

Every test file needs an `EmitterContext`. Use this pattern:

```typescript
const emptySpec: ApiSpec = {
  name: "Test",
  version: "1.0.0",
  baseUrl: "",
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: "{snake_case_namespace}",
  namespacePascal: "{PascalNamespace}",
  spec: emptySpec,
};
```

## Step 8: Validate

Run the following checks after implementation:

```bash
# Type check — no TypeScript errors
npx tsc --noEmit

# All tests pass (existing + new)
npx vitest run

# Build succeeds
npx tsup

# Structural linter — verify dependency layers, naming, file size, emitter exports
npm run lint:structure

# Smoke test — generate from Petstore fixture
npx tsx src/cli/index.ts generate \
  --spec test/fixtures/petstore.yml \
  --lang {language} \
  --output /tmp/test-{language}-sdk \
  --namespace petstore

# Determinism — generating twice produces identical output
npx tsx src/cli/index.ts generate \
  --spec test/fixtures/petstore.yml \
  --lang {language} \
  --output /tmp/test-{language}-sdk-2 \
  --namespace petstore
diff -r /tmp/test-{language}-sdk /tmp/test-{language}-sdk-2

# If the target language has a standard linter, run it on the generated output
# e.g., ruff check /tmp/test-{language}-sdk/ (Python)
# e.g., gofmt -l /tmp/test-{language}-sdk/ (Go)
```

## Step 9: Verification Report

After validation, produce this report:

```
=== Emitter: {language} ===
Files created:
  src/emitters/{language}/*.ts    — {N} files ({N} lines)
  test/emitters/{language}/*.ts   — {N} files ({N} lines)
  docs/sdk-designs/{language}.md  — SDK design document

Validation:
  Type check:       PASS/FAIL
  Tests:            {N} passed, {N} failed
  Build:            PASS/FAIL
  Structural lint:  PASS/FAIL
  Smoke test:       {N} files generated
  Determinism:      PASS/FAIL
  Linter:           PASS/FAIL/N/A

Generated SDK structure:
  lib/{namespace}/models/      — {N} model files
  lib/{namespace}/resources/   — {N} resource files
  lib/{namespace}/client.{ext} — HTTP client
  lib/{namespace}/errors.{ext} — Error hierarchy
  {type annotation dirs if any}
  test/                        — {N} test files
  test/fixtures/               — {N} fixture files
```

## Common Pitfalls

1. **Don't copy Ruby idioms** — `frozen_string_literal`, `module ... end` wrapping, symbol enums, etc. are Ruby-specific. Use the target language's conventions.
2. **Don't forget path interpolation** — each language handles format strings differently (`%s`, `f"{id}"`, `fmt.Sprintf`, `${id}`, etc.)
3. **Keep generators pure** — they receive IR and return strings. No file I/O, no side effects.
4. **Match the existing test patterns** — look at `test/emitters/ruby/*.test.ts` for the test structure conventions used in this project.
5. **Handle empty inputs** — emitter methods may receive `[]` for models/enums/services. Return `[]` without errors.
6. **Namespace everywhere** — the `ctx.namespacePascal` and `ctx.namespace` must appear in all generated code (module names, class prefixes, import paths).

## Backwards Compatibility

If the target language has an existing published SDK that requires backwards compatibility, scaffold an extractor with `/generate-extractor <language>`, then run `/verify-compat <language>` to verify the generated output preserves the existing SDK's API surface.

## Reference: Ruby Emitter File Inventory

> **This inventory is Ruby-specific.** Files like `yard.ts`, `types-rbs.ts`, and `types-rbi.ts` are unique to Ruby — do not replicate them for other languages unless the target language has an equivalent type annotation system. Use this table to understand the purpose of each generator file, not as a universal file list. The scaffold in Step 1 is the actual template.

| File           | Purpose                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `index.ts`     | Entry point, wires all generators into `Emitter` interface                                                 |
| `type-map.ts`  | `mapTypeRef`, `mapTypeRefForRbs`, `mapTypeRefForSorbet`                                                    |
| `naming.ts`    | `rubyClassName`, `rubyFileName`                                                                            |
| `yard.ts`      | `yardType` — IR TypeRef to YARD documentation type strings                                                 |
| `models.ts`    | `generateModels` — BaseModel DSL classes with YARD `@!attribute` docs                                      |
| `enums.ts`     | `generateEnums` — Module-based enums with `extend Enum` and symbol values                                  |
| `resources.ts` | `generateResources` — Keyword-style `@client.request(method:, path:, model:, ...)` with `request_options:` |
| `client.ts`    | `generateClient` — Net::HTTP client with keyword args, model/page deserialization, retry                   |
| `errors.ts`    | `generateErrors` — Error hierarchy                                                                         |
| `config.ts`    | `generateConfig` — Configuration module                                                                    |
| `types-rbs.ts` | `generateRbs` — RBS type signatures (models, enums, resources with request_options)                        |
| `types-rbi.ts` | `generateRbi` — Sorbet RBI signatures (models, enums, resources with request_options)                      |
| `tests.ts`     | `generateTests` — Minitest + WebMock tests (CRUD, error, retry, idempotency)                               |
| `fixtures.ts`  | `generateFixtures` — JSON test fixtures                                                                    |
