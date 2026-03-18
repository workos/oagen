---
name: generate-emitter
description: Scaffold a new language emitter for oagen, implementing the Emitter interface with idiomatic target-language code generation. Use this skill whenever the user wants to add a new target language, generate SDKs for a new language, add Go/Python/Kotlin/Java/etc. support, create an emitter, or asks about code generation for a language — even if they don't use the word "emitter" explicitly. Also triggers when the user mentions "add language support" or "new SDK target".
---

# /generate-emitter

Scaffold a complete language emitter for oagen that translates the intermediate representation (IR) into idiomatic SDK code for a target language.

## Overview

oagen has a plugin architecture for code generation. Each target language is an **emitter** — a TypeScript module that implements the `Emitter` interface. An emitter receives parsed IR nodes (models, enums, services, etc.) and returns `GeneratedFile[]` — arrays of `{ path, content }` pairs. The engine orchestrator calls each emitter method, prepends a file header, and writes the results to disk.

Emitters live in **external projects** (not inside the oagen core repo). They import all oagen types from `@workos/oagen` and register via `oagen.config.ts` in their project.

## Reference Docs

- [Emitter Contract](../../docs/architecture/emitter-contract.md) — `Emitter` interface, `GeneratedFile` shape, overlay integration
- [IR Types](../../docs/architecture/ir-types.md) — `ApiSpec`, `TypeRef` discriminated union, `Model`, `Enum`, `Service`, `Operation`
- [Pipeline](../../docs/architecture/pipeline.md) — three-stage parse/emit/write flow

## Resolve Emitter Project

Determine the emitter project path before doing anything:

1. If the `project` argument was provided, use that.
2. Otherwise, use `AskUserQuestion`: "Where is your emitter project? (absolute or relative path, e.g. `../oagen-emitters/node`)"

All generated files go into this project. Store it as `project`.

## Scaffold Project (if needed)

If `{project}/package.json` does **NOT** exist, read `references/project-scaffold.md` and create the boilerplate files listed there. If `package.json` already exists, skip this.

## Prerequisites

Before starting, read and understand these oagen core types (all imported from `@workos/oagen`):

- `Emitter`, `EmitterContext`, `GeneratedFile` — the emitter interface contract
- `ApiSpec`, `Model`, `Enum`, `Service`, `Operation`, `TypeRef` — the IR type system
- `planOperation`, `OperationPlan` — operation analysis helpers
- `toPascalCase`, `toSnakeCase`, `toCamelCase`, `toKebabCase`, `toUpperSnakeCase` — naming utilities

Also read the project's `oagen.config.ts` to understand how emitters are registered.

If an `sdk_path` argument is provided, you MUST thoroughly study that SDK before proceeding to Step 1. The existing SDK's actual code — not generic conventions — drives every design decision.

## Step 1: Study Target Language Patterns

Before writing any code, establish the exact patterns the emitter will replicate.

### Scenario A: Backwards-Compatible (`sdk_path` provided)

The existing SDK is the **sole source of truth**. Study it thoroughly before making any design decisions.

#### 1a. Explore the Existing SDK (via subagent)

**Delegate this to a subagent to keep file-reading noise out of the main context.**

Use the `Agent` tool with `subagent_type: Explore` and a prompt like:

> Explore the SDK at `{sdk_path}`. Read at least 10 representative files spanning different concerns. For each of the following pattern categories, find the real code and return: a 1-2 sentence description, a real code snippet, and the source file path.
>
> Categories: client architecture (constructor, HTTP methods, resource accessors), model/data types (field types, optionality), request/response types (separate input/output/options types?), serialization (wire/domain conversion?), resource classes (method signatures, parameter patterns, return types), pagination (iterator, page object, etc.), error handling (error hierarchy, status code mapping), testing patterns (framework, mocking, fixtures), entry point/exports (barrel exports, public surface), utilities/common (shared helpers, base classes), file/directory layout (tree structure), constructor/factory (instantiation, config patterns).
>
> Only report patterns actually found — never invent. If a category doesn't apply, say so.

The subagent reads 10+ files and returns only the structured findings — intermediate file reads stay out of context.

**Do NOT skip this step.** The entire emitter is derived from these findings.

#### File Path Hints

When generating for a live SDK, the overlay provides `fileBySymbol` — a map from
IR symbol names to the relative file paths where those symbols live in the live SDK.
Emitters can use this to produce `GeneratedFile` entries with paths that match the
live SDK's layout, enabling the merger to find and merge into the correct files.

**Usage in emitter code:**

```typescript
generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  return models.map((model) => {
    // Check overlay for live SDK path hint
    const hintPath = ctx.overlayLookup?.fileBySymbol?.get(model.name);
    const filePath = hintPath ?? `models/${toKebabCase(model.name)}.ts`;

    return { path: filePath, content: renderModel(model) };
  });
}
```

This is opt-in. Emitters that don't check `fileBySymbol` generate into their
default layout. The hint is most valuable during `/integrate` (Phase 3), when
generated files need to merge into the live SDK at the correct locations.

#### 1b. Present Findings

After receiving the subagent's structured summary, present it to the user. For each pattern, include the pattern name, a 1–2 sentence description, a real code snippet from the SDK, and the source file path.

Ask the user to confirm the findings are complete and accurate.

### Scenario B: Fresh (no `sdk_path`)

1. Check if `docs/sdk-architecture/{language}.md` already exists in the emitter project. If it does, confirm with the user whether changes are needed.
2. If no design doc exists, present the Structural Guidelines Table and ask the user to confirm or override each category: Testing Framework, HTTP Mocking, Documentation, Type Signatures, Linting/Formatting, HTTP Client, JSON Parsing, Package Manager, Build Tool.

### 1c. Create SDK Design Document

Write the full design document to `docs/sdk-architecture/{language}.md` **in the emitter project**.

**For Scenario A:** Derive the doc entirely from the patterns extracted in Step 1a. Every code example must come from the real SDK, not be invented. The design doc is the contract between the study phase and the implementation phase.

**For Scenario B:** Use the confirmed structural guidelines plus your knowledge of the language ecosystem.

The design doc must include: architecture overview, naming conventions, type mapping table (IR TypeRef to target types), model pattern with example, enum pattern, resource/client pattern, serialization pattern (if applicable), pagination pattern, error handling, retry logic, test pattern, structural guidelines table, directory structure, and utility/common patterns.

**CRITICAL for Scenario A:** If the existing SDK has patterns NOT covered by the standard emitter scaffold (e.g., serializers, factory functions, dual type systems), those patterns MUST be documented as additional generator files.

## Step 2: Scaffold Emitter Files

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
├── fixtures.ts       # Test fixture generation
└── manifest.ts       # Smoke test manifest (operation → SDK method mapping)
```

Not every language needs every file, and some languages may need **additional** files beyond this scaffold. **For Scenario A**, the design doc from Step 1c may identify additional generators needed (e.g., `serializers.ts`, `common.ts`, `factory.ts`, `request-types.ts`). The file list in the design doc is authoritative, not this generic scaffold.

Omit files that don't apply, and add language-specific utility files as needed. The `index.ts` must still implement all `Emitter` interface methods (return `[]` for inapplicable ones).

### SDK Output Scaffolding (required)

The emitter must produce a **self-contained, usable SDK**. In addition to source files, `generateClient` (or another appropriate method) **must** emit these scaffolding files:

1. **Entry point barrel** (e.g., `src/index.ts`) — re-exports all public types, models, enums, exceptions, and the main client class. This is what the extractor and consumers use as the SDK's public surface.
2. **Project config** (e.g., `tsconfig.json`, `setup.py`, `Gemfile`) — whatever the target language needs so the generated SDK can be type-checked, built, or imported without manual setup.
3. **Package manifest** (e.g., `package.json`, `*.gemspec`, `pyproject.toml`) — with correct entry points (`main`, `types`, `exports`) so tooling can discover the SDK's public surface.

Without these, `oagen verify` (compat verification) will fail because the extractor cannot find the SDK's entry point. The generated output must be analyzable by the extractor without any manual intervention.

### Import Convention

All emitter files import oagen types from `@workos/oagen`:

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

## Steps 3–5: Implement Generators

Read `references/generator-guide.md` for detailed instructions on implementing each generator file: type-map.ts, naming.ts, models.ts, enums.ts, resources.ts, serializers.ts (if applicable), client.ts, errors.ts, config.ts, common.ts (if applicable), type signatures, tests.ts, and fixtures.ts.

### Read reference implementations via subagent

Before implementing generators, use the `Agent` tool with `subagent_type: Explore` to study the reference emitter files you'll be adapting. This keeps ~20K+ tokens of reference source out of the main context.

> Read these files from the reference emitter at `{emitterProject}/src/{reference_language}/`:
> type-map.ts, naming.ts, models.ts, enums.ts, resources.ts, client.ts, errors.ts, config.ts, tests.ts, fixtures.ts
>
> For each file, return:
>
> - **Purpose:** one-line description
> - **Exports:** function/constant signatures
> - **Pattern:** structural flow (setup → transform → output)
> - **IR inputs:** which IR types (Model, Enum, Service, Operation, TypeRef) it consumes
> - **Output shape:** what GeneratedFile paths/content look like
> - **Language-specific details (do NOT replicate):** parts specific to the reference language that must be adapted
>
> Be concise — the consumer needs the pattern, not a line-by-line walkthrough.

Then, for each generator, follow this pattern:

1. **Consult the subagent's summary** for the structural pattern of the corresponding reference file
2. **Consult the design doc** (`docs/sdk-architecture/{language}.md`) for the exact output patterns to produce
3. **Use `GeneratedFile[]` return type** — each function receives IR nodes + `EmitterContext` and returns file path/content pairs

**CRITICAL for Scenario A:** Each generator must produce output that matches the patterns documented in the design doc. Do NOT invent patterns that weren't found in the existing SDK.

## Step 6: Create Entry Point (`index.ts`)

Wire everything together by implementing the `Emitter` interface:

- `generateTests` internally calls `generateFixtures` — fixtures are not a separate Emitter method
- Interface methods can compose multiple generators (e.g., Node's `generateConfig` returns `[...generateConfig(ctx), ...generateCommon(ctx)]`)
- Return `[]` for inapplicable methods

```typescript
import type { Emitter } from '@workos/oagen';

export const {language}Emitter: Emitter = {
  language: "{language}",
  generateModels(models, ctx) { return generateModels(models, ctx); },
  generateEnums(enums, ctx) { return generateEnums(enums, ctx); },
  generateResources(services, ctx) { return generateResources(services, ctx); },
  generateClient(spec, ctx) { return generateClient(spec, ctx); },
  generateErrors(ctx) { return generateErrors(ctx); },
  generateConfig(ctx) { return generateConfig(ctx); },
  generateTypeSignatures(spec, ctx) { return generateTypeSignatures(spec, ctx); },
  generateTests(spec, ctx) { return generateTests(spec, ctx); },
  generateManifest(spec, ctx) { return generateManifest(spec, ctx); },
  fileHeader() { return "{language-appropriate auto-generated file header}"; },
};
```

## Step 7: Register Emitter

Add the emitter to `oagen.config.ts` and re-export from `src/index.ts`:

```typescript
// oagen.config.ts
import { {language}Emitter } from './src/{language}/index.js';
const config: OagenConfig = { emitters: [/* existing, */ {language}Emitter] };

// src/index.ts
export { {language}Emitter } from './{language}/index.js';
```

## Step 8: Create Tests

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

For each generator, test: all type mappings, required vs optional fields, file paths and naming, content snapshots (use `toMatchInlineSnapshot()` for at least one case per generator), multiple items, and edge cases (nullable, union, nested model refs, enum refs, arrays of models).

**For Scenario A:** Include at least one "golden file" test per generator that verifies the output matches a known-good excerpt from the existing SDK.

### Shared Test Context

```typescript
import { describe, it, expect } from "vitest";
import type { EmitterContext, ApiSpec } from "@workos/oagen";

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

## Step 9: Validate

```bash
# In the emitter project — all tests pass
npx vitest run

# In oagen core — type check and build
npx tsc --noEmit
npx tsup

# Smoke test — generate from an available spec fixture
npx tsx src/cli/index.ts generate \
  --spec test/fixtures/{available-spec}.yml \
  --lang {language} --output /tmp/test-{language}-sdk --namespace {namespace}

# Determinism — generating twice produces identical output
npx tsx src/cli/index.ts generate \
  --spec test/fixtures/{available-spec}.yml \
  --lang {language} --output /tmp/test-{language}-sdk-2 --namespace {namespace}
diff -r /tmp/test-{language}-sdk /tmp/test-{language}-sdk-2

# If the target language has a standard linter, run it on the generated output
```

**For Scenario A:** Also compare generated output against the existing SDK — structure, patterns, and naming should be recognizably similar.

## Verification Report

```
=== Emitter: {language} ===
Scenario: {A (backwards-compatible) / B (fresh)}
Files created (in {project}):
  src/{language}/*.ts                     — {N} files
  test/{language}/*.ts                    — {N} files
  docs/sdk-architecture/{language}.md     — SDK design document
Validation:
  Tests / Type check / Build / Smoke test / Determinism / Linter / SDK comparison
Patterns replicated: (Scenario A only)
  Model / Enum / Resource / Client / Error / Serialization / Pagination / Testing / Barrel exports
```

## Smoke Manifest Generation (required)

Every emitter **must** implement `generateManifest`. The smoke test runner uses the manifest to resolve SDK methods from HTTP operations — without it, the smoke test cannot find methods and most operations will be skipped.

The manifest maps every `HTTP_METHOD /path` to `{ sdkMethod, service }`:

```json
{
  "POST /organizations": {
    "sdkMethod": "createOrganizations",
    "service": "organizations"
  },
  "GET /organizations/{id}": {
    "sdkMethod": "getOrganizations",
    "service": "organizations"
  }
}
```

The emitter already knows every operation→method mapping (from `resolveMethodName` or the equivalent). `generateManifest` simply serializes that mapping to `smoke-manifest.json` as a `GeneratedFile`. The orchestrator calls `emitter.generateManifest?.(spec, ctx)` and writes the result alongside the SDK output.

**Implementation pattern** (`manifest.ts`):

```typescript
export function generateManifest(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const manifest: Record<string, { sdkMethod: string; service: string }> = {};
  for (const service of spec.services) {
    const propName = /* service property name on the client */;
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const methodName = /* resolved method name for this operation */;
      manifest[httpKey] = { sdkMethod: methodName, service: propName };
    }
  }
  return [{
    path: "smoke-manifest.json",
    content: JSON.stringify(manifest, null, 2),
  }];
}
```

If the emitter disambiguates operation names (e.g., multiple `list` operations in one service), the manifest must use the **disambiguated** names. Run disambiguation before building the manifest, or reuse the same resolved names that `generateResources` uses.

## Overlay Integration

When `ctx.overlayLookup` is present (user passed `--api-surface`), check it before generating default names to preserve backwards compatibility:

```typescript
const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
const existing = ctx.overlayLookup?.methodByOperation.get(httpKey);
if (existing) {
  // Use existing.methodName instead of the default generated name
}
```

Also check `interfaceByName` and `typeAliasByName` for type names, and `requiredExports` for barrel exports. See `docs/architecture/emitter-contract.md` for the full `OverlayLookup` field reference.

## Common Pitfalls

Read `references/common-pitfalls.md` before finalizing the emitter, and when debugging failures. Key ones: don't invent patterns (replicate), keep generators pure, namespace everywhere, don't ignore overlay, match the existing test framework exactly.

## Output

This skill produces, in the emitter project:

- `src/{language}/*.ts` — emitter generator files implementing the `Emitter` interface
- `test/{language}/*.ts` — unit tests for each generator
- `docs/sdk-architecture/{language}.md` — SDK design document
- Updated `oagen.config.ts` with the new emitter registered

## Backwards Compatibility

If the target language has an existing published SDK, scaffold an extractor with `/generate-extractor <language>`, then run `/verify-compat <language>` to verify the generated output preserves the existing API surface.
