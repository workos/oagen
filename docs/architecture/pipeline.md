# Pipeline Architecture

## Overview

oagen provides a three-stage pipeline for transforming OpenAPI specs into SDK code: Parse → Emit → Write. Emitters are registered plugins that implement the `Emitter` interface.

```
┌──────────────────┐     ┌─────────────────────┐      ┌──────────────┐
│   OpenAPI Spec   │────▶│   Parser Pipeline    │────▶│     IR       │
│   (YAML/JSON)    │     │                      │     │  (ApiSpec)   │
└──────────────────┘     └─────────────────────┘      └──────┬───────┘
                                                             │
                         ┌──────────────────────┐            │
                         │  Emitter (per lang)  │◀───────────┘
                         │  generator methods   │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │   GeneratedFile[]    │
                         │  { path, content }   │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │      Writer          │
                         │  (disk + headers)    │
                         └──────────────────────┘
```

## Stage 1: Parse (`src/parser/`)

Entry point: `parse.ts` → `parseSpec(specPath: string): Promise<ApiSpec>`

1. **refs.ts** — Loads the spec file, uses `@redocly/openapi-core` to bundle and resolve all `$ref` pointers
2. **schemas.ts** — Walks `components.schemas`, extracts `Model[]` and `Enum[]`
3. **operations.ts** — Walks `paths`, groups endpoints into `Service[]` with `Operation[]`
4. **pagination.ts** — Detects cursor-based pagination from query params; also detected from response shape in `responses.ts` (either source sets `paginated: true`)

### Operation Name Inference

If an `operationId` is present, it takes precedence. Names are inferred from HTTP method + path pattern:

| Method | Path Pattern  | Inferred Name |
| ------ | ------------- | ------------- |
| GET    | `/users`      | `list`        |
| GET    | `/users/{id}` | `get`         |
| POST   | `/users`      | `create`      |
| PUT    | `/users/{id}` | `update`      |
| DELETE | `/users/{id}` | `delete`      |

The collection vs. instance distinction is determined by whether the path ends with a `{param}` segment.

## Stage 2: Emit (`src/engine/`)

Entry point: `orchestrator.ts` → `generate(spec, emitter, options)`

The orchestrator calls each generator method in order:

```typescript
generateModels(models, ctx); // Data classes/structs
generateEnums(enums, ctx); // Enum types
generateResources(services, ctx); // API resource classes
generateClient(spec, ctx); // HTTP client
generateErrors(ctx); // Error hierarchy
generateConfig(ctx); // Configuration
generateTypeSignatures(spec, ctx); // Type annotations (optional)
generateTests(spec, ctx); // Tests + fixtures
generateManifest?.(spec, ctx); // Smoke-test manifest (optional)
```

### OperationPlan

Before rendering, emitters call `planOperation(op)` from `src/engine/operation-plan.ts` to compute an `OperationPlan` — a flat struct of semantic decisions (`isDelete`, `hasBody`, `isIdempotentPost`, `pathParamsInOptions`, `isPaginated`, `responseModelName`, etc.). This separates _what_ the generated code should do from _how_ it is rendered as a string. The plan is shared across all language emitters.

Each method returns `GeneratedFile[]`. The orchestrator:

1. Collects all files
2. Prepends `emitter.fileHeader()` to each file's content
3. Passes to writer (or prints paths in dry-run mode)

### EmitterContext

Every generator method receives:

- `namespace` — snake_case version of the SDK namespace
- `namespacePascal` — PascalCase version
- `spec` — the full IR (for cross-references)
- `outputDir` — target directory

## Stage 3: Write (`src/engine/writer.ts`)

- Writes `GeneratedFile[]` to disk under the output directory
- Respects `skipIfExists` flag — won't overwrite files marked as hand-editable
- Creates directories as needed

## Emitter Registry (`src/engine/registry.ts`)

Simple map from language name → `Emitter` instance. Emitters are registered at startup via `oagen.config.ts`:

```typescript
// In oagen.config.ts (emitter project)
import { nodeEmitter, rubyEmitter } from "./src/index.js";

export default {
  emitters: [nodeEmitter, rubyEmitter],
};
```

## Diff Engine (`src/differ/`)

Compares two parsed specs (old vs new) and produces a `DiffReport` classifying changes as additive, breaking, or mixed. Used by the `oagen diff` CLI command for review before regenerating.
