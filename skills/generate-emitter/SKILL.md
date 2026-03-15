---
name: generate-emitter
description: Scaffold a new language emitter for oagen, implementing the Emitter interface with idiomatic target-language code generation. Use this skill whenever the user wants to add a new target language, generate SDKs for a new language, add Go/Python/Kotlin/Java/etc. support, or asks about creating an emitter — even if they don't use the word "emitter" explicitly.
arguments:
  - name: language
    description: Target language name (e.g., "python", "go", "kotlin")
    required: true
  - name: sdk_path
    description: Path to an existing live SDK to study and replicate patterns from (required for backwards-compatible scenarios)
    required: false
  - name: sdk_design_path
    description: Path to an existing SDK design document (optional — sdk_path takes precedence)
    required: false
  - name: project
    description: Path to the emitter project (overrides oagen.config.ts emitterProject)
    required: false
---

# /generate-emitter

Scaffold a complete language emitter for oagen that translates the intermediate representation (IR) into idiomatic SDK code for a target language.

## Overview

oagen has a plugin architecture for code generation. Each target language is an **emitter** — a TypeScript module that implements the `Emitter` interface. An emitter receives parsed IR nodes (models, enums, services, etc.) and returns `GeneratedFile[]` — arrays of `{ path, content }` pairs. The engine orchestrator calls each emitter method, prepends a file header, and writes the results to disk.

Emitters live in **external projects** (not inside the oagen core repo). Emitters import all oagen types from `@workos/oagen` and register via `oagen.config.ts` in their project.

## Resolve Emitter Project

Before doing anything else, determine the emitter project path:

1. If the `project` argument was provided, use that.
2. Otherwise, read `oagen.config.ts` in the current directory and check for `emitterProject`.
3. If neither exists, use `AskUserQuestion` to ask: "Where is your emitter project? (path relative to this repo, e.g. `../my-emitters`)"

All generated files go into this project path. Store it for use in all subsequent steps.

The **reference emitter** is at `{emitterProject}/src/ruby/` (if it exists). If the emitter project doesn't have a Ruby emitter, study the Node emitter at `{emitterProject}/src/node/` instead.

## Step -1: Scaffold Project (if needed)

If `{emitterProject}/package.json` does **NOT** exist, the project needs initialization. Create the following boilerplate files:

### `package.json`

```json
{
  "name": "@workos/oagen-emitters-{language}",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@workos/oagen": "^0.0.1"
  },
  "devDependencies": {
    "tsup": "^8.4.0",
    "tsx": "^4.19.0",
    "vitest": "^3.0.0",
    "@types/node": "^25.3.3"
  }
}
```

### `tsconfig.json`

Mirror oagen core's config: ES2022, ESNext modules, bundler resolution, strict mode, declaration output.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": ".",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src", "test"],
  "exclude": ["node_modules", "dist"]
}
```

### `vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { globals: true, include: ["test/**/*.test.ts"] },
});
```

### `tsup.config.ts`

```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
});
```

### `oagen.config.ts`

```ts
import type { OagenConfig } from "@workos/oagen";
const config: OagenConfig = { emitters: [] };
export default config;
```

(Step 6 of this skill adds the emitter to this config.)

### `src/index.ts`

```ts
// Barrel export — re-exports all emitters
```

(Step 6 adds the re-export.)

### `.gitignore`

```
node_modules/
dist/
```

After creating these files, run `npm install` in the emitter project directory to install dependencies.

If `package.json` already exists, skip this step entirely.

## Prerequisites

Before starting, read and understand these files:

1. **oagen core types** — Import everything from `@workos/oagen`:
   - `Emitter`, `EmitterContext`, `GeneratedFile` — the emitter interface contract
   - `ApiSpec`, `Model`, `Enum`, `Service`, `Operation`, `TypeRef` — the IR type system
   - `planOperation`, `OperationPlan` — operation analysis helpers
   - `toPascalCase`, `toSnakeCase`, `toCamelCase`, `toKebabCase`, `toUpperSnakeCase` — naming utilities
2. **`{emitterProject}/src/ruby/`** — The reference emitter (study the structure, not the Ruby-specific output)
3. **`oagen.config.ts`** (in the emitter project) — How emitters are registered via the plugin system

If an `sdk_path` argument is provided, you MUST thoroughly study that SDK before proceeding to Step 0. This is not optional. The existing SDK's actual code — not generic conventions — drives every design decision.

If an `sdk_design_path` argument is provided (and no `sdk_path`), read that file for idiomatic patterns.

## Step 0: Study Target Language Patterns

Before writing any code, you MUST establish the exact patterns the emitter will replicate. How you do this depends on whether an existing SDK must be preserved.

### Scenario A: Backwards-Compatible (`sdk_path` provided)

When an `sdk_path` argument is provided, the existing SDK is the **sole source of truth**. You must study it thoroughly before making any design decisions. Do NOT guess patterns based on "common conventions" — the real SDK's actual code drives everything.

#### 0a. Explore the Existing SDK

Read at least 10 representative files from the SDK to extract its actual architecture. For each pattern below, find the real code, read the file, and document what you see:

| Pattern                    | What to look for                                                    | Example files to read                                                    |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Client architecture**    | Constructor, HTTP methods, resource accessors, method overloads     | Main client class (e.g., `workos.ts`, `client.py`, `client.rb`)         |
| **Model/data types**       | How data classes are defined, field types, optionality              | 2-3 model files (e.g., `organization.ts`, `user.ts`)                    |
| **Request/response types** | Whether the SDK has separate input/output/options types             | Interface/type directories, options files                                |
| **Serialization**          | Whether there are serialize/deserialize functions between wire/domain | Serializer files, if they exist                                          |
| **Resource classes**       | Method signatures, parameter patterns, return types, delegation     | 2-3 resource modules (e.g., `organizations.ts`, `users.ts`)             |
| **Pagination**             | How paginated responses are handled (iterator, page object, etc.)   | Pagination utilities, list methods                                       |
| **Error handling**         | Error class hierarchy, status code mapping                          | Error/exception files                                                    |
| **Testing**                | Test framework, mocking approach, test structure, fixture patterns  | 2-3 test files                                                           |
| **Entry point**            | Barrel exports, what's publicly exposed, re-export structure        | `index.ts`, `__init__.py`, `lib/{gem}.rb`, etc.                         |
| **Utilities/common**       | Shared helpers, common types, pagination base classes               | Common/utils directories                                                 |
| **File/directory layout**  | How the SDK organizes files by feature/domain                       | `ls` the top-level `src/` directory                                      |
| **Constructor/factory**    | How the client is instantiated, config patterns, overloads          | Factory files, config types                                              |

**Do NOT skip this step.** The entire emitter is derived from these findings.

#### 0b. Present Findings

After studying the SDK, present a structured summary to the user. For each pattern category, include:

1. **Pattern name** — What architectural pattern the SDK uses
2. **Description** — How it works (1-2 sentences)
3. **Code snippet** — An actual excerpt from the SDK (not invented)
4. **Source file(s)** — Where you found it

Example format:

> **Model pattern**: Dual types — each domain model has a `{Name}` interface (public-facing) and a `{Name}Response` interface (wire format), plus a `deserialize{Name}()` function that converts between them.
> ```typescript
> // From src/organizations/interfaces/organization.interface.ts
> export interface Organization { id: string; name: string; ... }
> // From src/organizations/serializers/organization.serializer.ts
> export const deserializeOrganization = (data: OrganizationResponse): Organization => ({ ... });
> ```

Ask the user to confirm the findings are complete and accurate. If patterns are unclear or you can't determine them from the code, ask specific questions rather than guessing.

### Scenario B: Fresh (no `sdk_path`)

When there is no existing SDK to replicate:

1. Check if `docs/{language}.md` already exists in the emitter project. If it does, its structural guidelines section is the source of truth — confirm with the user whether any changes are needed.
2. If no design doc exists, present the Structural Guidelines Table and ask the user to confirm or override each category:

| Category                  | What it controls in the emitter                                            |
| ------------------------- | -------------------------------------------------------------------------- |
| **Testing Framework**     | `tests.ts` — test runner syntax (assertions, structure, setup/teardown)    |
| **HTTP Mocking**          | `tests.ts` — how HTTP stubs are written in generated tests                 |
| **Documentation**         | `models.ts`, `resources.ts` — docstring/annotation format                  |
| **Type Signatures**       | `types-*.ts` — whether separate type annotation files are needed           |
| **Linting/Formatting**    | Validation step — which linter to run on generated output                  |
| **HTTP Client (default)** | `client.ts` — which HTTP library the generated client uses                 |
| **JSON Parsing**          | `client.ts` — how serialization/deserialization is done                    |
| **Package Manager**       | `config.ts` — what package metadata file to reference                      |
| **Build Tool**            | Only if language needs one. Omit if N/A.                                   |

### 0c. Create SDK Design Document

Write the full design document to `docs/{language}.md` **in the emitter project**.

**For Scenario A (backwards-compatible):** The design doc MUST be derived entirely from the patterns extracted from the existing SDK in Step 0a. Every code example must come from the real SDK, not be invented. The design doc is the contract between the study phase and the implementation phase — if a pattern isn't documented here, the emitter won't reproduce it.

**For Scenario B (fresh):** Use the confirmed structural guidelines plus your knowledge of the language ecosystem.

The design doc must include these sections (see `{emitterProject}/docs/ruby.md` for a worked example):

- Architecture overview (Scenario A: describe the existing SDK's actual architecture)
- Naming conventions (OpenAPI → target language)
- Type mapping table (IR TypeRef → target language types → type annotation types)
- Model pattern with full example (Scenario A: real model from the existing SDK)
- Enum pattern with full example
- Resource/client pattern with full example (Scenario A: real resource method from the existing SDK)
- Serialization pattern (if the SDK uses serializers — document exactly how they work)
- Pagination pattern (document the exact pagination mechanism — this varies dramatically between SDKs)
- Error handling pattern
- Retry logic pattern
- Test pattern with full example (Scenario A: real test from the existing SDK)
- Structural guidelines table (testing framework, HTTP mocking, etc.)
- Directory structure of generated SDK (Scenario A: match the existing SDK's directory layout)
- Utility/common patterns (shared types, base classes, helpers)

**CRITICAL for Scenario A:** If the existing SDK has patterns NOT covered by the standard emitter scaffold (e.g., serializers, factory functions, dual type systems, custom pagination classes), those patterns MUST be documented as additional generator files. The standard scaffold is a starting point, not a ceiling — add files to cover every pattern found in the SDK.

## Step 1: Scaffold Emitter Files

Create the following files under `src/{language}/` **in the emitter project**:

```
{project}/src/{language}/
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

**For Scenario A:** The design doc from Step 0c may identify additional generator files needed to reproduce the existing SDK's patterns. Common additions include:

- `serializers.ts` — If the SDK has a serialization layer between wire format and domain types
- `common.ts` — If the SDK has shared utility types, pagination base classes, or helper functions
- `factory.ts` — If the SDK has a factory pattern for client construction
- `request-types.ts` — If the SDK has separate request/options types distinct from models

Add these files to the scaffold. **The file list in the design doc is authoritative, not this generic scaffold.**

Omit files that don't apply, and add language-specific utility files as needed. The `index.ts` must still implement all `Emitter` interface methods (return `[]` for inapplicable ones).

### Import Convention

All emitter files import oagen types from the `@workos/oagen` package:

```typescript
import type { Model, TypeRef, Operation } from "@workos/oagen";
import type { EmitterContext, GeneratedFile } from "@workos/oagen";
import { planOperation, toCamelCase, toKebabCase } from "@workos/oagen";
```

Local imports within the emitter use relative paths:

```typescript
import { mapTypeRef } from "./type-map.js";
import { className, fileName } from "./naming.js";
```

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

**For Scenario A:** The type mapping must produce types that match the existing SDK's conventions. If the SDK uses `Date` objects instead of ISO strings for date-time, map accordingly. If the SDK wraps nullable types in `Optional<T>`, do that. Check the design doc's type mapping table.

If the language has a separate type annotation system, also export mapping functions for those (e.g., `mapTypeRefForPyi`, `mapTypeRefForGoDoc`).

### Reference: Ruby Type Map

Study `{emitterProject}/src/ruby/type-map.ts` for the pattern. It exports `mapTypeRef` (for Ruby source), `mapTypeRefForRbs` (for RBS signatures), and `mapTypeRefForSorbet` (for Sorbet RBI).

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

**For Scenario A:** Verify naming conventions against the existing SDK. If the SDK uses non-standard naming (e.g., preserves acronyms like `SSO` instead of converting to `Sso`, or uses `ID` instead of `Id`), the naming functions must reproduce that behavior. Check 5-10 actual names from the SDK and verify the naming functions produce identical output.

Use the shared utilities from `@workos/oagen` (`toPascalCase`, `toSnakeCase`, `toCamelCase`, `toKebabCase`, `toUpperSnakeCase`) as building blocks.

## Step 4: Implement Each Generator

For each generator file, follow this pattern:

1. **Read the corresponding file** in the reference emitter (`{emitterProject}/src/ruby/` or `{emitterProject}/src/node/`) to understand the structure
2. **Consult the design doc** (`docs/{language}.md`) for the exact output patterns to produce
3. **Use `GeneratedFile[]` return type** — each function receives IR nodes + `EmitterContext` and returns file path/content pairs

**CRITICAL for Scenario A:** Each generator must produce output that matches the patterns documented in the design doc from Step 0c. Do NOT invent patterns that weren't found in the existing SDK. The design doc is the specification; the generator is the implementation.

### Models (`models.ts`)

- Input: `Model[]` (each has `name`, `description?`, `fields[]`)
- Each `Field` has `name`, `type: TypeRef`, `required: boolean`, `description?`
- Output: One file per model, using the exact model pattern from the design doc
- Use `type-map.ts` to convert field types

**For Scenario A:** If the existing SDK uses a dual type system (e.g., separate `Organization` and `OrganizationResponse` types), this generator must produce BOTH types. If the SDK has specific decorators, base classes, or factory methods on models, replicate them.

### Enums (`enums.ts`)

- Input: `Enum[]` (each has `name`, `values[]`)
- Each `EnumValue` has `name`, `value` (string), `description?`
- Output: One file per enum, using the exact enum pattern from the design doc

### Resources (`resources.ts`)

- Input: `Service[]` (each has `name`, `operations[]`)
- Each `Operation` has: `name`, `httpMethod`, `path`, `pathParams`, `queryParams`, `requestBody?`, `response`, `paginated`, `idempotent`
- Output: One file per service/resource
- Handle:
  - Path parameter interpolation (e.g., `/orgs/{id}` → target language's format string mechanism)
  - Strip leading `/` from paths (use `"organizations"` not `"/organizations"`)
  - Paginated responses — use the exact pagination pattern from the design doc (NOT a generic page type)
  - Idempotent POST methods (include an idempotency key as a standalone parameter, not embedded in params)
  - Query parameters for list methods
  - A per-request options parameter on every method (last parameter, using the language's idiomatic calling convention)
  - Documentation for parameters and return types using the target language's standard docstring format
  - Delete methods signal "no response body" using the language's null/void type and return nil/null/unit

**For Scenario A:** The method signatures, parameter ordering, and return types must match the existing SDK's patterns exactly. If the SDK takes an options object as the first parameter and an ID separately, replicate that. If it uses keyword arguments, replicate that. Read the resource pattern section of the design doc carefully.

### Serializers (`serializers.ts`) — if applicable

- **Only create this file if the design doc documents a serialization pattern.**
- Input: `Model[]` — generates serialize/deserialize functions for each model
- Maps between wire format (API responses) and domain types (what the SDK exposes)
- Common in SDKs that have separate Response and Domain type layers

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

**For Scenario A:** The client architecture must match the existing SDK. If the client uses constructor overloads, has a specific initialization pattern, or delegates to a separate HTTP transport layer, replicate that. The design doc's client architecture section is authoritative.

### Errors (`errors.ts`)

- Mostly static code with namespace interpolation
- Required error types: `APIError` (base), `AuthenticationError` (401), `NotFoundError` (404), `UnprocessableEntityError` (422), `RateLimitExceededError` (429), `ServerError` (500+), `NetworkError` (connection failures), `ConfigurationError` (missing API key)

**For Scenario A:** Match the existing SDK's error class names and hierarchy exactly. If the SDK names it `BadRequestException` instead of `UnprocessableEntityError`, use the SDK's name.

### Config (`config.ts`)

- Configuration class/module with: `api_key`, `base_url`, `max_retries`, `timeout`
- Environment variable default for API key

### Common/Utilities (`common.ts`) — if applicable

- **Create this file if the design doc documents shared utilities.**
- Generates shared types, pagination base classes, barrel exports, or helper functions
- Common in SDKs that have a `common/` directory with shared infrastructure

### Type Signatures (`types-*.ts`)

- Language-specific. May be 0, 1, or 2 files depending on the language's type system.
- Examples: `.pyi` stubs for Python, `.d.ts` for JavaScript, nothing for Go/Rust (types are inline)
- Must include request options and idempotency key parameters on resource method signatures
- Must include enum type signatures using the target language's idiomatic enum representation
- Delete operations should return the language's void/null type

### Tests (`tests.ts`) and Fixtures (`fixtures.ts`)

- `generateTests` is the only Emitter interface method — it should internally call `generateFixtures` from `fixtures.ts` and combine both into a single `GeneratedFile[]` return
- Generate one test file per resource/service
- Test file paths are language-specific — use the target language's idiomatic convention (e.g., Ruby uses `test/{namespace}/resources/{name}_test.rb`, Node uses `src/{service}/tests/{name}.test.ts`)
- Test classes/modules nested in namespace modules
- Each test: stub HTTP request → call method → assert response type using the language's idiomatic assertion style
- Include error tests (404, 401), retry tests (429 with Retry-After), and idempotency tests (explicit + auto-generated keys)
- Fixture JSON file paths are also language-specific — organize them near the test files using the target language's convention
- Use a `load_fixture` helper for reading fixtures
- Generate fixture JSON files from IR model schemas

**For Scenario A:** Use the exact testing framework and mocking library from the existing SDK. If the SDK uses Jest + jest-fetch-mock, generate Jest tests with jest-fetch-mock, not Vitest + msw. If the SDK uses a specific test structure (describe/it vs test functions, specific setup/teardown patterns), replicate it. Read the test pattern section of the design doc.

## Step 5: Create Entry Point (`index.ts`)

Wire everything together by implementing the `Emitter` interface. Note that:

- `generateTests` internally calls `generateFixtures` — fixtures are not a separate Emitter method
- Interface methods can compose multiple generators (e.g., the Node emitter's `generateConfig` returns `[...generateConfig(ctx), ...generateCommon(ctx)]` to include shared utilities)
- Return `[]` for inapplicable methods (e.g., `generateTypeSignatures` for languages with inline types)

```typescript
import type { Emitter } from '@workos/oagen';
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

Add the emitter to the project's `oagen.config.ts`:

```typescript
import { {language}Emitter } from './src/{language}/index.js';
import type { OagenConfig } from '@workos/oagen';

const config: OagenConfig = {
  emitters: [/* existing emitters, */ {language}Emitter],
};
export default config;
```

Also add a re-export to the project's barrel `src/index.ts`:

```typescript
export { {language}Emitter } from './{language}/index.js';
```

## Step 7: Create Tests

Create test files under `test/{language}/` **in the emitter project**:

```
{project}/test/{language}/
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

**For Scenario A:** Include at least one "golden file" test per generator that verifies the output matches a known-good excerpt from the existing SDK. This catches drift between what the emitter produces and what the real SDK looks like.

### Import Convention for Tests

```typescript
import { describe, it, expect } from "vitest";
import type { EmitterContext } from "@workos/oagen";
import type { Model, ApiSpec } from "@workos/oagen";
import { generateModels } from "../../src/{language}/models.js";
```

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
# In the emitter project:

# All tests pass
npx vitest run

# In the oagen core repo:

# Type check
npx tsc --noEmit

# Build
npx tsup

# Smoke test — generate from an available spec fixture
# Use whichever spec is available in test/fixtures/ (e.g., petstore.yml, workos.yml)
npx tsx src/cli/index.ts generate \
  --spec test/fixtures/{available-spec}.yml \
  --lang {language} \
  --output /tmp/test-{language}-sdk \
  --namespace {namespace}

# Determinism — generating twice produces identical output
npx tsx src/cli/index.ts generate \
  --spec test/fixtures/{available-spec}.yml \
  --lang {language} \
  --output /tmp/test-{language}-sdk-2 \
  --namespace {namespace}
diff -r /tmp/test-{language}-sdk /tmp/test-{language}-sdk-2

# If the target language has a standard linter, run it on the generated output
# e.g., ruff check /tmp/test-{language}-sdk/ (Python)
# e.g., gofmt -l /tmp/test-{language}-sdk/ (Go)
```

**For Scenario A:** Additionally, compare the generated output against the existing SDK:

```bash
# Generate from the same spec the real SDK uses
npx tsx src/cli/index.ts generate \
  --spec {real-spec-path} \
  --lang {language} \
  --output /tmp/test-{language}-sdk-compat \
  --namespace {namespace}

# Manually compare a few key files against the real SDK
# Focus on: one model, one resource, the client, and one test file
diff /tmp/test-{language}-sdk-compat/{model-file} {sdk_path}/{model-file}
```

This comparison is not expected to produce identical output, but the structure, patterns, and naming should be recognizably similar.

## Step 9: Verification Report

After validation, produce this report:

```
=== Emitter: {language} ===
Scenario: {A (backwards-compatible) / B (fresh)}

Files created (in {project}):
  src/{language}/*.ts    — {N} files ({N} lines)
  test/{language}/*.ts   — {N} files ({N} lines)
  docs/{language}.md     — SDK design document

Validation:
  Tests:            {N} passed, {N} failed
  Type check:       PASS/FAIL
  Build:            PASS/FAIL
  Smoke test:       {N} files generated
  Determinism:      PASS/FAIL
  Linter:           PASS/FAIL/N/A
  SDK comparison:   {summary of key differences} / SKIPPED (Scenario B)

Patterns replicated from existing SDK:    (Scenario A only)
  [x] Model pattern: {description}
  [x] Enum pattern: {description}
  [x] Resource pattern: {description}
  [x] Client architecture: {description}
  [x] Error hierarchy: {description}
  [x] Serialization: {description or N/A}
  [x] Pagination: {description}
  [x] Testing: {framework + mocking}
  [x] Barrel exports: {description}

Generated SDK structure:
  {actual directory tree matching the design doc}
```

## Common Pitfalls

1. **Don't invent patterns — replicate what exists.** For backwards-compatible scenarios, every architectural decision must come from the existing SDK. If you can't find a pattern in the real code, ask the user rather than guessing. Generic "best practices" are wrong if they don't match the real SDK.
2. **Don't copy Ruby idioms** — `frozen_string_literal`, `module ... end` wrapping, symbol enums, etc. are Ruby-specific. Use the target language's conventions.
3. **Don't forget path interpolation** — each language handles format strings differently (`%s`, `f"{id}"`, `fmt.Sprintf`, `${id}`, etc.)
4. **Keep generators pure** — they receive IR and return strings. No file I/O, no side effects.
5. **Match the existing test patterns** — look at `{emitterProject}/test/ruby/*.test.ts` for the test structure conventions used in this project.
6. **Handle empty inputs** — emitter methods may receive `[]` for models/enums/services. Return `[]` without errors.
7. **Namespace everywhere** — the `ctx.namespacePascal` and `ctx.namespace` must appear in all generated code (module names, class prefixes, import paths).
8. **Ignoring overlay** — When `ctx.overlayLookup` is provided, check it for existing method/type names before generating defaults. Skipping this causes compat verification failures.
9. **Missing serialization layer** — If the existing SDK has serialize/deserialize functions, the emitter MUST generate them. Producing plain models without serializers will fail compat verification.
10. **Wrong pagination type** — Each SDK has its own pagination pattern (AutoPaginatable, CursorPage, PageIterator, etc.). Use the design doc's pagination section, not a generic implementation.
11. **Wrong test framework** — If the existing SDK uses Jest, generate Jest tests. If it uses pytest, generate pytest tests. Never substitute a different framework because it seems "better."
12. **Acronym handling in naming** — `toPascalCase('WorkOS')` may produce `WorkOs` instead of `WorkOS`. If the SDK preserves acronym casing, create an `ensurePascal()` wrapper that only capitalizes the first letter without disturbing the rest.

## Overlay Integration

When `ctx.overlayLookup` is present (user passed `--api-surface`), emitters should check it before generating default names to preserve backwards compatibility:

```typescript
// In resources.ts, before generating a method name:
const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
const existing = ctx.overlayLookup?.methodByOperation.get(httpKey);
if (existing) {
  // Use existing.methodName instead of the default generated name
}
```

Also check `ctx.overlayLookup?.interfaceByName` and `ctx.overlayLookup?.typeAliasByName` for type names, and `ctx.overlayLookup?.requiredExports` for barrel exports.

See `docs/architecture/emitter-contract.md` for the full `OverlayLookup` field reference.

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
