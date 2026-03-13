# oagen — OpenAPI SDK Generator

Generate idiomatic SDKs from OpenAPI 3.x specs via a language-agnostic IR.

Pipeline: `OpenAPI spec → Parser → IR → Emitter → GeneratedFile[] → Writer → disk`

## Critical Rules

- **Dependency layers are one-way:** `ir/types → utils → parser → engine → emitters → cli`. Never import rightward into leftward layers.
- **Emitters are pure:** receive IR, return `GeneratedFile[]`. No I/O, no side effects.
- **Never remove or edit existing tests.**
- **Tests:** use `toMatchInlineSnapshot()` for representative cases. `test/` mirrors `src/` structure.
- **Naming:** IR uses PascalCase. Each emitter converts to target conventions via its `naming.ts`.
- **Git:** commit after each complete feature.

## Task Guides

Start here when working on a specific area:

- [Architecture & Core Contracts](docs/agents/architecture.md) — parsing, IR, orchestration, file writing
- [Emitter Implementation](docs/agents/emitters.md) — adding or changing a language emitter
- [Testing & Smoke Validation](docs/agents/testing.md) — unit tests, snapshots, smoke scripts

## Deep Reference

- [Pipeline](docs/architecture/pipeline.md) — three-stage parse/emit/write flow with orchestrator details
- [Dependency Layers](docs/architecture/dependency-layers.md) — full import matrix and enforcement via structural linter
- [Emitter Contract](docs/architecture/emitter-contract.md) — `Emitter` interface, `GeneratedFile` shape, and per-language file structure
- [IR Types](docs/architecture/ir-types.md) — `ApiSpec`, `TypeRef` discriminated union, `Model`, `Enum`, `Service`, `Operation`
- SDK design docs: `docs/sdk-designs/{language}.md`

## Skills

- `/generate-emitter <language>` — scaffold a new language emitter
- `/generate-smoke-test <language>` — create smoke tests for a generated SDK
