---
name: generate-extractor
description: Scaffold a new language extractor for oagen's compat system, implementing the Extractor interface to extract a live SDK's public API surface. Use when the user wants to add backwards-compatibility support, build an extractor, check for breaking changes or regressions, or asks about extracting an API surface for any language — even if they don't use the word "extractor" explicitly. Also triggers for "compat support", "API surface analysis", or "public surface extraction".
---

# /generate-extractor

Scaffold a language extractor for oagen's compat verification system. An extractor analyzes a live SDK and returns its public API surface as a canonical `ApiSurface` JSON, which the differ then compares against generated output to detect breaking changes.

## Overview

```
Live SDK → Extractor → ApiSurface JSON → Differ ← Generated SDK → Violations
```

Each language needs its own extractor because public surface detection is language-specific (e.g., TypeScript exports vs. Ruby public methods vs. Python `__all__` vs. Go capitalized identifiers). An extractor implements the `Extractor` interface and is registered via `oagen.config.ts` in the emitter project.

## Resolve Paths

**Emitter project:** Use the `project` argument if provided, otherwise use `AskUserQuestion`.

**oagen core:** Check for `node_modules/@workos/oagen/`, or `src/engine/types.ts` in the current directory, otherwise ask.

## Prerequisites

Read and understand these files before starting:

1. **oagen core types** (from `@workos/oagen`): `Extractor`, `ApiSurface`, `ApiClass`, `ApiMethod`, `ApiParam`, `ApiProperty`, `ApiInterface`, `ApiField`, `ApiTypeAlias`, `ApiEnum`
2. **Reference extractor:** `{oagen}/src/compat/extractors/node.ts` — study the structure, not the TypeScript-specific analysis
3. **Reference tests:** `{oagen}/test/compat/extractors/node.test.ts`
4. **Fixture SDK:** `{oagen}/test/fixtures/sample-sdk/`
5. **Contract spec:** `{oagen}/docs/architecture/extractor-contract.md` — includes language-specific strategies

If an `sdk_path` argument is provided, explore that SDK thoroughly to understand its public surface patterns (entry points, export mechanisms, type annotation files). The real SDK is the ground truth.

## Step 0: Determine Analysis Strategy

Before writing any code, determine how to analyze the target language's SDK:

| Decision                     | What it controls                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| **Entry point discovery**    | How to find the SDK's main module/package                                               |
| **Public surface detection** | How to distinguish public from private symbols                                          |
| **Type information source**  | Where types come from (compiler API, stubs, annotations)                                |
| **Class/method extraction**  | How to extract classes, methods, params, return types                                   |
| **Analysis tooling**         | What npm packages or subprocess calls are needed                                        |

### Implementation Strategy

Extractors run as TypeScript code. For non-TS/JS SDKs, choose one:

1. **Native analysis (preferred):** Use a TS/JS parser or AST library that can analyze the target language
2. **Subprocess delegation:** Shell out to a target-language script that performs analysis and returns JSON
3. **Static file parsing:** Parse type annotation files (`.rbi`, `.rbs`, `.pyi`) or source files directly

Present your proposed strategy to the user for confirmation, including any runtime dependencies.

## Step 1: Create the Extractor

Create `src/compat/extractors/{language}.ts` **in the emitter project**.

```typescript
import type { ApiSurface, Extractor } from '@workos/oagen';

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

1. **Deterministic output** — Running twice on the same SDK must produce identical JSON. Sort all record keys and array members.
2. **Public surface only** — Extract only public/exported symbols. Each language defines "public" differently.
3. **Preserve fidelity** — Capture method signatures as they appear in the live SDK, not as the IR would generate them.
4. **Handle missing infrastructure gracefully** — Throw a descriptive error if required files are missing.
5. **Populate all ApiSurface fields** — `classes`, `interfaces`, `typeAliases`, `enums`, `exports`. Map as closely as possible even if the language doesn't have a direct equivalent for every category.

## Step 2: Register the Extractor

Add to `oagen.config.ts`:

```typescript
import { {language}Extractor } from './src/compat/extractors/{language}.js';
const config: OagenConfig = {
  emitters: [/* ... */],
  extractors: [{language}Extractor],
};
```

## Step 3: Create a Fixture SDK

Create a minimal but representative fixture at `test/fixtures/sample-sdk-{language}/` **in the emitter project**. It must include:

1. A client class with at least 3 methods (list, get, delete) — required/optional params, different return types
2. At least one model/data class (e.g., `Organization` with `id`, `name`)
3. At least one enum with 2+ members
4. At least one interface/protocol/type alias (if the language supports them)
5. A clear entry point that re-exports all public symbols
6. At least one readonly property on the client class

Mirror the Node fixture at `{oagen}/test/fixtures/sample-sdk/` in terms of what it tests, using the target language's idioms.

## Step 4: Create Tests

Create `test/compat/extractors/{language}.test.ts` **in the emitter project** covering:

1. Extracts classes with methods and properties
2. Extracts method params and return types
3. Extracts optional params and readonly properties
4. Extracts interfaces/protocols and enums
5. Extracts type aliases and barrel exports
6. Produces deterministic output (extract twice, compare)
7. Sets metadata correctly

Use `toMatchObject` for partial assertions and `toMatchInlineSnapshot()` for at least one representative snapshot per category.

## Step 5: Validate

```bash
# All tests pass
cd {project} && npx vitest run

# Manual extraction against fixture
npx tsx -e "
  import { {language}Extractor } from './src/compat/extractors/{language}.js';
  const surface = await {language}Extractor.extract('test/fixtures/sample-sdk-{language}');
  console.log(JSON.stringify(surface, null, 2));
" > /tmp/test-{language}-surface.json

# Determinism check — extract twice, diff
```

If `sdk_path` was provided, also test against the real SDK and verify all public classes are captured, method signatures match, and no private symbols leak through.

## Verification Report

```
=== Extractor: {language} ===
Files created:   src/compat/extractors/{language}.ts, test suite, fixture SDK
Modified:        oagen.config.ts
Validation:      Tests / Fixture extract / Determinism / Real SDK extract
ApiSurface:      {N} classes, {N} interfaces, {N} type aliases, {N} enums, {N} exports
```

## Common Pitfalls

1. **Non-deterministic output** — Always sort record keys and array members
2. **Missing error on bad input** — Throw descriptive errors for missing entry points or type infrastructure
3. **Extracting private symbols** — Only extract what consumers can actually use
4. **Subprocess encoding** — Ensure UTF-8 and handle stderr/stdout correctly
5. **Hardcoded paths** — Use the `sdkPath` parameter, never hardcode fixture paths
6. **Ignoring generics** — Capture generic type parameters (e.g., `ListResponse<Organization>`)
7. **Forgetting the export map** — Map the entry point to its public symbols even if the language doesn't have explicit barrel exports
