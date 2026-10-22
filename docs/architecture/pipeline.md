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

| Method | Path Pattern               | Inferred Name  |
| ------ | -------------------------- | -------------- |
| GET    | `/users`                   | `list`         |
| GET    | `/users/{id}`              | `get`          |
| POST   | `/users`                   | `create`       |
| PUT    | `/users/{id}`              | `update`       |
| DELETE | `/users/{id}`              | `delete`       |
| GET    | `/store/pets`              | `listPets`     |
| GET    | `/store/pets/{id}`         | `getPet`       |
| POST   | `/store/pets/{id}/adopt`   | `adoptPet`     |
| POST   | `/store/pets/{id}/photos`  | `createPhotos` |
| POST   | `/accounts/users/{id}/ban` | `banUser`      |

The collection vs. instance distinction is determined by whether the path ends with a `{param}` segment. The resource is the last literal segment, dropped when it is the first segment (the service already carries it), and singularised for an instance operation (`pets` → `Pet`, `api_keys` → `ApiKey`, `addresses` → `Address`; `status` and other words that do not look plural are kept). A POST whose last segment is a literal that follows a `{param}` and does not end in `s` is an action: the segment is the verb and the singular parent resource is appended (`adoptPet`), even when the parent is the first segment, so two actions with the same name on different resources do not collide — unless the verb already ends with the parent's words (`POST /companies/verification/{id}/restart-id-verification` → `restartIdVerification`). API root and version segments (`api`, `rest`, `v1`, `2.0`) are never the parent, so `POST /api/v1/{companyId}/sendDocument` is the bare `sendDocument`. A plural literal after a `{param}` (`/users/{id}/photos`) is a nested collection and stays a `create`. A singleton noun after a `{param}` (`/users/{id}/avatar`) is misread as a verb; give it an `operationId`.

Fallback names are unique within a service. An `operationId` is never renamed; a colliding fallback is qualified by its path (resource, deeper segments, `By<Param>`) and numbered as a last resort. When a singular fallback is the name of an `operationId` in the same service and nothing in its path tells the two apart (`GET /store/pets/{id}` next to `operationId: getPet` on `/store/featured/{id}`), the fallback keeps the plural it had before singularisation, `getPets`, if that name is free, rather than `getPet2`. Two colliding actions are qualified by the path of their parent, never by repeating the verb (`adoptPet` and `adoptPetRescue`, not `adoptPetAdopt`).

## Stage 2: Emit (`src/engine/`)

Entry point: `orchestrator.ts` → `generate(spec, emitter, options)`

The orchestrator calls each generator method in order:

```typescript
generateModels(models, ctx); // Data classes/structs
generateEnums(enums, ctx); // Enum types
generateResources(services, ctx); // API resource classes
generateClient(spec, ctx); // HTTP client
generateErrors(ctx); // Error hierarchy
generateTypeSignatures(spec, ctx); // Type annotations (optional)
generateTests(spec, ctx); // Tests + fixtures
buildOperationsMap?.(spec, ctx); // Operations map for .oagen-manifest.json (optional)
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
// In oagen.config.ts (consumer project)
import { acmeEmittersPlugin } from "@acme/oagen-emitters";

export default {
  ...acmeEmittersPlugin,
  // spec interpretation policy...
};
```

## Diff Engine (`src/differ/`)

Compares two parsed specs (old vs new) and produces a `DiffReport` classifying changes as additive, breaking, or mixed. Used by the `oagen diff` CLI command for review before regenerating. It compares the document root (`baseUrl` and `servers`, with their variables, and the default `security`), models, enums, services and webhooks; every change kind and its classification is listed under [`oagen diff`](../cli.md#oagen-diff) in the CLI reference.
