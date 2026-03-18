# Architecture And Core Contracts

Use this guide when changing parsing, IR types, orchestration, file writing, or shared framework architecture.

## Pipeline

`OpenAPI spec -> Parser -> IR -> Emitter -> GeneratedFile[] -> Writer -> disk`

Three stages transform an OpenAPI spec into SDK files:

1. **Parse** (`src/parser/parse.ts`) — Load and bundle the spec via `@redocly/openapi-core`, extract `Model[]`, `Enum[]`, and `Service[]` into the IR (`ApiSpec`). Sub-modules handle ref resolution (`refs.ts`), schema walking (`schemas.ts`), operation grouping (`operations.ts`), pagination detection (`pagination.ts`), and inline model extraction (`inline-models.ts`).

2. **Emit** (`src/engine/orchestrator.ts`) — Call each emitter method in order (`generateModels` → `generateEnums` → `generateResources` → `generateClient` → `generateErrors` → `generateConfig` → `generateTypeSignatures` → `generateTests` → `generateManifest`), collect `GeneratedFile[]`, prepend file headers.

3. **Write** (`src/engine/writer.ts`) — Write files to disk. New files are created in full. Existing files are merged at the AST level via `merger.ts` (additive-only — new symbols appended, existing symbols untouched). Files marked `skipIfExists` are never overwritten.

## Modification Patterns

When changing pipeline behavior:

- **Adding a new IR node** — Update `src/ir/types.ts`, bump `IR_VERSION`, add `assertNever` branch in emitters. See [IR Types](../architecture/ir-types.md).
- **Adding a parser feature** — Add or modify sub-modules in `src/parser/`, wire into `parseSpec()`. Parser tests live in `test/parser/`.
- **Changing orchestration** — Modify `src/engine/orchestrator.ts`. The `generate()` function builds `EmitterContext`, calls `generateAllFiles()`, then `writeFiles()`.
- **Changing write behavior** — Modify `src/engine/writer.ts` or `src/engine/merger.ts`. The writer never deletes files; see [Non-Additive Changes](../architecture/non-additive-changes.md) for staleness detection.
- **Plugin/config changes** — Modify `src/cli/config-loader.ts`. The `OagenConfig` interface defines all user-facing config fields. See [CLI Reference](../cli.md) for command details.

## Core Contracts

- IR types live in `src/ir/types.ts`
- The emitter interface lives in `src/engine/types.ts`
- Operation planning lives in `src/engine/operation-plan.ts`
- Emitter registration lives in `src/engine/registry.ts`
- Config loading lives in `src/cli/config-loader.ts`

## Source Of Truth

- Pipeline details: [docs/architecture/pipeline.md](../architecture/pipeline.md)
- Dependency rules: [docs/architecture/dependency-layers.md](../architecture/dependency-layers.md)
- IR contract details: [docs/architecture/ir-types.md](../architecture/ir-types.md)
- Emitter contract details: [docs/architecture/emitter-contract.md](../architecture/emitter-contract.md)
- Non-additive changes: [docs/architecture/non-additive-changes.md](../architecture/non-additive-changes.md)
- CLI reference: [docs/cli.md](../cli.md)
- Workflow diagrams: [docs/diagrams/generate-sdk-workflow.md](../diagrams/generate-sdk-workflow.md)

## Directory Landmarks

- `src/parser/`: OpenAPI to IR (refs, schemas, operations, pagination, inline models)
- `src/engine/`: orchestration, writer, merger, registry, shared engine types
- Language-specific emitters live in the separate `oagen-emitters` project (import from `@workos/oagen`)
- `src/differ/`: incremental diff engine
- `src/compat/`: compat verification, overlay, staleness detection, extractors
- `src/cli/`: CLI entry points and config loader
- `src/utils/`: naming utilities (snake_case, camelCase, PascalCase conversions)
