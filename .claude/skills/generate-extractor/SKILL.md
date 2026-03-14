---
name: generate-extractor
description: Scaffold a new language extractor for oagen's compat system, implementing the Extractor interface to extract a live SDK's public API surface. Use when the user wants to add compat/backwards-compatibility support for a language, build an extractor, or asks about extracting an API surface — even if they don't use the word "extractor" explicitly.
arguments:
  - name: language
    description: Target language name (e.g., "ruby", "python", "go", "kotlin")
    required: true
  - name: sdk_path
    description: Path to an existing SDK to use as the reference for discovering public surface patterns (optional — used for exploration, not modification)
    required: false
---

# /generate-extractor

Scaffold a language extractor for oagen's compat verification system. An extractor analyzes a live SDK and returns its public API surface as a canonical `ApiSurface` JSON, which the differ then compares against generated output to detect breaking changes.

## Overview

The compat verification pipeline is:

```
Live SDK → Extractor → ApiSurface JSON → Differ ← Generated SDK → Violations
```

Each language needs its own extractor because public surface detection is language-specific (e.g., TypeScript exports vs. Ruby public methods vs. Python `__all__` vs. Go capitalized identifiers). An extractor implements the `Extractor` interface from `src/compat/types.ts` and is registered in the extraction script.

The Node extractor at `src/compat/extractors/node.ts` is the reference implementation. Use it as a structural template, but implement language-appropriate analysis for the target language.

## Prerequisites

Before starting, read and understand these files:

1. **`src/compat/types.ts`** — The `Extractor` interface, `ApiSurface` type, and all sub-types (`ApiClass`, `ApiMethod`, `ApiParam`, `ApiProperty`, `ApiInterface`, `ApiField`, `ApiTypeAlias`, `ApiEnum`)
2. **`src/compat/extractors/node.ts`** — The reference extractor (study the structure, not the TypeScript-specific analysis)
3. **`src/compat/extractor-registry.ts`** — How extractors are registered (`registerExtractor` / `getExtractor`)
4. **`scripts/compat-extract.ts`** — The CLI script that imports and registers extractors
5. **`test/compat/extractors/node.test.ts`** — The reference test suite (study the test structure and assertions)
6. **`test/fixtures/sample-sdk/`** — The Node fixture SDK (study the structure to understand what a fixture looks like)
7. **`docs/architecture/extractor-contract.md`** — The full contract specification with language-specific strategies

If an `sdk_path` argument is provided, explore that SDK to understand its public surface patterns (entry points, export mechanisms, type annotation files, documentation conventions).

## Step 0: Determine Language-Specific Analysis Strategy

Before writing any code, determine how to analyze the target language's SDK. Use `AskUserQuestion` if the strategy isn't clear from the language's conventions.

### 0a. Identify the Analysis Approach

Each language has different mechanisms for declaring public API surfaces. Determine:

| Decision                     | What it controls                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Entry point discovery**    | How to find the SDK's main module/package (e.g., `package.json` for Node, `lib/{gem}.rb` for Ruby, `__init__.py` for Python, package directory for Go)                      |
| **Public surface detection** | How to distinguish public from private symbols (e.g., TS exports, Ruby `public`/`private`, Python `__all__`, Go capitalization)                                             |
| **Type information source**  | Where types come from (e.g., TypeScript compiler API, `.rbi`/`.rbs` files, `.pyi` stubs, `go/types`, Java reflection)                                                       |
| **Class/method extraction**  | How to extract classes, methods, params, return types (e.g., AST parsing, type checker, reflection)                                                                         |
| **Analysis tooling**         | What npm packages or subprocess calls are needed (e.g., `typescript` for Node, a Ruby parser gem via subprocess, Python `ast` via subprocess, `go/packages` via subprocess) |

### 0b. Determine Implementation Strategy

Extractors run as TypeScript code inside the oagen codebase. For non-TypeScript/JavaScript SDKs, the extractor typically needs to:

1. **Native analysis (preferred)**: Use a TypeScript/JavaScript parser or AST library that can analyze the target language (e.g., a Ruby parser written in JS, Python AST parser in JS)
2. **Subprocess delegation**: Shell out to a target-language script that performs the analysis and returns JSON. The TypeScript extractor wrapper calls `child_process.execSync()` with a helper script.
3. **Static file parsing**: Parse type annotation files (`.rbi`, `.rbs`, `.pyi`) or source files directly using regex or a lightweight parser

Present your proposed strategy to the user for confirmation.

### 0c. Determine Runtime Dependencies

If the extractor needs npm packages (e.g., a Ruby parser), or target-language tooling (e.g., `ruby`, `python3`, `go` must be installed), note these as prerequisites. The extractor should throw a descriptive error if required tooling is missing.

## Step 1: Create the Extractor

Create `src/compat/extractors/{language}.ts`.

### Required Shape

```typescript
import type {
  ApiSurface,
  Extractor,
  ApiClass,
  ApiMethod,
  ApiParam,
  ApiProperty,
  ApiInterface,
  ApiField,
  ApiTypeAlias,
  ApiEnum,
} from '../types.js';

export const {language}Extractor: Extractor = {
  language: '{language}',

  async extract(sdkPath: string): Promise<ApiSurface> {
    // 1. Discover entry point
    // 2. Load and analyze public surface
    // 3. Extract classes, interfaces, type aliases, enums
    // 4. Build export map
    // 5. Return sorted, deterministic ApiSurface

    return {
      language: '{language}',
      extractedFrom: sdkPath,
      extractedAt: new Date().toISOString(),
      classes: sortRecord(classes),
      interfaces: sortRecord(interfaces),
      typeAliases: sortRecord(typeAliases),
      enums: sortRecord(enums),
      exports: sortRecord(exports),
    };
  },
};
```

### Implementation Rules

1. **Deterministic output** — Running the extractor twice on the same SDK must produce identical JSON. Sort all record keys and array members consistently. Use `sortRecord()` (see the Node extractor's helper).

2. **Public surface only** — Extract only public/exported symbols. Skip private methods, internal modules, and unexported types. Each language defines "public" differently:
   - **Node**: Exported from entry point
   - **Ruby**: Not marked `private` or `protected`; or listed in public API annotations
   - **Python**: Listed in `__all__`, or non-underscore-prefixed names
   - **Go**: Capitalized identifiers
   - **Java/Kotlin**: `public` access modifier

3. **Preserve fidelity** — Capture method signatures as they appear in the live SDK, not as the IR would generate them. Parameter names, types, and optionality must match reality.

4. **Handle missing infrastructure gracefully** — If required files are missing (e.g., no `tsconfig.json`, no `.pyi` stubs, no `.rbi` files), throw a descriptive error rather than returning an empty surface.

5. **Populate all ApiSurface fields** — Even if the language doesn't have a direct equivalent for every category, map as closely as possible:
   - `classes` — Classes, structs with methods, or module-level method groups
   - `interfaces` — Interfaces, protocols, abstract classes, or type definitions
   - `typeAliases` — Type aliases, typedefs, or named type expressions
   - `enums` — Enums, constant groups, or frozen string sets
   - `exports` — File-to-symbol mapping capturing the barrel/re-export structure

### Language-Specific Strategies

Reference `docs/architecture/extractor-contract.md` for detailed strategies per language. Key patterns:

**Ruby:**

- Parse `.rbi` (Sorbet) or `.rbs` (Steep) type signature files for typed projects
- Fall back to YARD `@api public` annotations
- Public methods: anything not marked `private` or `protected`
- Entry point: `lib/{gem_name}.rb` or files listed in the gemspec

**Python:**

- Parse `.pyi` stub files (highest fidelity)
- Fall back to `ast` module on source files
- Public surface: `__all__` in `__init__.py`, or all non-underscore-prefixed names
- Entry point: `{package}/__init__.py`

**Go:**

- Use `go/types` and `go/packages` to load and analyze (via subprocess)
- Public surface: exported identifiers (capitalized names)
- Entry point: the package directory (all `.go` files)

**Java/Kotlin:**

- Parse with a JVM AST library or extract from compiled `.class` files
- Public surface: `public` classes and methods
- Entry point: the main package directory

## Step 2: Register the Extractor

Add the new extractor's import and registration to `scripts/compat-extract.ts`:

```typescript
import { {language}Extractor } from '../src/compat/extractors/{language}.js';
registerExtractor({language}Extractor);
```

This is the only registration point — the extraction script imports all known extractors at startup.

## Step 3: Create a Fixture SDK

Create a minimal but representative fixture SDK at `test/fixtures/sample-sdk-{language}/`. The fixture must include:

1. **A client class** with at least 3 methods (list, get, delete) demonstrating:
   - Required and optional parameters
   - Async/sync return types
   - Different return types (model, list response, void/nil)
2. **At least one model/data class** (e.g., `Organization` with `id`, `name` fields)
3. **At least one enum** with 2+ members
4. **At least one interface/protocol/type alias** (if the language supports them)
5. **A clear entry point** that re-exports all public symbols
6. **Properties** — at least one readonly property on the client class

The fixture should mirror the Node fixture at `test/fixtures/sample-sdk/` in terms of what it tests, but use the target language's idioms. Read the Node fixture files to understand the expected surface:

- `SampleClient` class with `getOrganization(id)`, `listOrganizations(limit?)`, `deleteOrganization(id)` methods
- `Organization` interface with `id`, `name`, `status` fields
- `ClientOptions` interface with `apiKey` (required), `baseUrl` (optional)
- `ListResponse<T>` generic interface
- `Status` enum with `Active`/`Inactive` members
- `StatusType` type alias
- `ExtendedClient` subclass with `createOrganization(name)` method
- `baseUrl` readonly property on `SampleClient`
- Barrel export from entry point

## Step 4: Create Tests

Create `test/compat/extractors/{language}.test.ts` following the test structure in `test/compat/extractors/node.test.ts`.

### Required Test Cases

Every extractor test suite must include:

```typescript
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { {language}Extractor } from '../../../src/compat/extractors/{language}.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-{language}');

describe('{language}Extractor', () => {
  // 1. Extracts classes with methods and properties
  // 2. Extracts method params and return types
  // 3. Extracts optional params
  // 4. Extracts readonly properties
  // 5. Extracts constructor params (if applicable to language)
  // 6. Extracts interfaces/protocols with fields (if applicable)
  // 7. Extracts enums
  // 8. Extracts type aliases (if applicable)
  // 9. Extracts inherited/subclass methods (if applicable)
  // 10. Extracts barrel exports / entry point exports
  // 11. Produces deterministic output (extract twice, compare)
  // 12. Sets metadata correctly (language, extractedFrom, extractedAt)
});
```

Adapt test assertions to the target language's conventions. For example:

- Ruby: method names are snake_case (`get_organization` not `getOrganization`)
- Python: method names are snake_case, type hints differ from TypeScript
- Go: method names are PascalCase, no optional params (use option structs)

Use `toMatchObject` for partial assertions and `toMatchInlineSnapshot()` for at least one representative snapshot per category.

## Step 5: Validate

Run the following checks after implementation:

```bash
# Type check — no TypeScript errors
npx tsc --noEmit

# All tests pass (existing + new)
npx vitest run

# Build succeeds
npx tsup

# Structural linter — verify dependency layers
npm run lint:structure

# Manual extraction test — run against the fixture
npx tsx scripts/compat-extract.ts \
  --sdk-path test/fixtures/sample-sdk-{language} \
  --lang {language} \
  --output /tmp/test-{language}-surface.json

# Inspect the output — verify it looks correct
cat /tmp/test-{language}-surface.json | head -50

# Determinism — extracting twice produces identical output
npx tsx scripts/compat-extract.ts \
  --sdk-path test/fixtures/sample-sdk-{language} \
  --lang {language} \
  --output /tmp/test-{language}-surface-2.json
diff /tmp/test-{language}-surface.json /tmp/test-{language}-surface-2.json
```

If an `sdk_path` argument was provided, also test against the real SDK:

```bash
npx tsx scripts/compat-extract.ts \
  --sdk-path {sdk_path} \
  --lang {language} \
  --output /tmp/real-{language}-surface.json

# Verify non-empty and reasonable
cat /tmp/real-{language}-surface.json | python3 -c "
import json, sys
s = json.load(sys.stdin)
print(f'Classes: {len(s[\"classes\"])}')
print(f'Interfaces: {len(s[\"interfaces\"])}')
print(f'Type aliases: {len(s[\"typeAliases\"])}')
print(f'Enums: {len(s[\"enums\"])}')
print(f'Export files: {len(s[\"exports\"])}')
"
```

## Step 6: Verification Report

After validation, produce this report:

```
=== Extractor: {language} ===
Files created:
  src/compat/extractors/{language}.ts          — extractor implementation
  test/compat/extractors/{language}.test.ts    — test suite
  test/fixtures/sample-sdk-{language}/         — fixture SDK ({N} files)

Modified:
  scripts/compat-extract.ts                    — registered new extractor

Validation:
  Type check:       PASS/FAIL
  Tests:            {N} passed, {N} failed
  Build:            PASS/FAIL
  Structural lint:  PASS/FAIL
  Fixture extract:  {N} symbols extracted
  Determinism:      PASS/FAIL
  Real SDK extract: {N} symbols / SKIPPED (no sdk_path)

ApiSurface coverage:
  Classes:     {N} extracted from fixture
  Interfaces:  {N} extracted from fixture
  Type aliases:{N} extracted from fixture
  Enums:       {N} extracted from fixture
  Exports:     {N} file(s) with {N} total symbols
```

## Common Pitfalls

1. **Non-deterministic output** — The most common failure. Always sort record keys, array members, and any other ordered output. Use a `sortRecord()` helper consistently.
2. **Missing error on bad input** — If the SDK path doesn't exist, has no entry point, or is missing type infrastructure, throw a descriptive error. Don't return an empty `ApiSurface`.
3. **Extracting private symbols** — Only extract what consumers can actually use. Internal helpers, private methods, and unexported utilities must be excluded.
4. **Subprocess encoding issues** — If using subprocess delegation, ensure UTF-8 encoding and handle stderr/stdout correctly. Parse JSON output defensively.
5. **Hardcoded paths** — The extractor receives `sdkPath` as a parameter. Never hardcode fixture paths or assume a specific directory structure beyond what the language convention dictates.
6. **Ignoring generics** — Capture generic type parameters in return types and fields (e.g., `ListResponse<Organization>`, `List<String>`). The differ needs these to detect signature changes.
7. **Forgetting the export map** — The `exports` field maps file paths to their exported symbol names. Even if the language doesn't have explicit barrel exports, map the entry point to its public symbols.
