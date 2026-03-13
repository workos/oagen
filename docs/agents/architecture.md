# Architecture And Core Contracts

Use this guide when changing parsing, IR types, orchestration, file writing, or shared architecture.

## Pipeline

`OpenAPI spec -> Parser -> IR -> Emitter -> GeneratedFile[] -> Writer -> disk`

- Parse entry point: `src/parser/parse.ts`
- Emit entry point: `src/engine/orchestrator.ts`
- Write entry point: `src/engine/writer.ts`

## Core Contracts

- IR types live in `src/ir/types.ts`
- The emitter interface lives in `src/engine/types.ts`
- Emitter registration lives in `src/engine/registry.ts`

## Source Of Truth

- Pipeline details: `docs/architecture/pipeline.md`
- Dependency rules: `docs/architecture/dependency-layers.md`
- IR contract details: `docs/architecture/ir-types.md`
- Emitter contract details: `docs/architecture/emitter-contract.md`

## Directory Landmarks

- `src/parser/`: OpenAPI to IR
- `src/engine/`: orchestration, writer, registry, shared engine types
- `src/emitters/`: language-specific emitters
- `src/differ/`: incremental diff engine
- `src/cli/`: CLI entry points
