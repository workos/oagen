# oagen — OpenAPI SDK Emitter Framework

Framework for building language emitters that transform OpenAPI 3.x specs into idiomatic SDK code via a language-agnostic IR.

Pipeline: `OpenAPI spec → Parser → IR → Emitter → GeneratedFile[] → Writer → disk`. Use `oagen init` to scaffold a new emitter project.

Two phases: one-time setup (`/generate-sdk`—scaffold emitter, verify compat if preserving an existing SDK, and always smoke test) then ongoing spec updates (`oagen diff` → `oagen generate` → `oagen verify`). For more information, see `docs/architecture/workflows.md`.

**Plugin system:** External consumers can register custom emitters, extractors, and smoke runners via `oagen.config.ts` in their project root—no need to modify CLI source. See the Configuration section in the README.

## Critical Rules

- **Dependency layers are one-way:** `ir → utils → parser → engine/differ → cli` (compat is used by engine and cli). Never import rightward into leftward layers. Emitters live in a separate project directory and import from `@workos/oagen`.
- **Emitters are pure:** receive IR, return `GeneratedFile[]`. No I/O, no side effects.
- **Never remove or edit existing tests.** Test coverage can be improved, but not weakend.
- **Tests:** prefer `toMatchInlineSnapshot()` for complex output; most tests use standard assertions. `test/` mirrors `src/` structure.
- **Naming:** IR uses PascalCase. Each emitter converts to target conventions via its `naming.ts`.
- **Git:** commit after each complete feature. Use Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

## Task Guides

Start here when working on a specific area:

- [Architecture & Core Contracts](docs/agents/architecture.md) — parsing, IR, orchestration, file writing
- [Emitter Implementation](docs/agents/emitters.md) — adding or changing a language emitter
- [Testing & Smoke Validation](docs/agents/testing.md) — unit tests, snapshots, smoke scripts
- **Plugin system:** `oagen.config.ts` — register custom emitters/extractors/smoke runners (see `src/cli/config-loader.ts`)

## Deep Reference

- [Workflows](docs/architecture/workflows.md) — setup (`/generate-sdk`) vs. ongoing (spec update pipeline), with loop diagrams
- [Pipeline](docs/architecture/pipeline.md) — three-stage parse/emit/write flow with orchestrator details
- [Dependency Layers](docs/architecture/dependency-layers.md) — full import matrix and enforcement via structural linter
- [Emitter Contract](docs/architecture/emitter-contract.md) — `Emitter` interface, `GeneratedFile` shape, and per-language file structure
- [IR Types](docs/architecture/ir-types.md) — `ApiSpec`, `TypeRef` discriminated union, `Model`, `Enum`, `Service`, `Operation`
- [Extractor Contract](docs/architecture/extractor-contract.md) — `Extractor` interface, `ApiSurface` type, and guide for new language extractors
- SDK design docs: live in the emitter project (e.g. `docs/sdk-architecture/{language}.md` in `oagen-emitters`)

## Skills (Claude Code Plugin)

oagen ships as a Claude Code plugin. Skills are in `skills/` at the repo root. Use `claude --plugin-dir .` (local) or `claude --plugin-dir node_modules/@workos/oagen` (consumer).

- `/oagen:generate-sdk <language>` — end-to-end orchestrator for generating a new language SDK
- `/oagen:generate-emitter <language>` — scaffold a new language emitter
- `/oagen:generate-extractor <language>` — scaffold an API surface extractor for compat verification
- `/oagen:generate-smoke-test <language>` — create smoke tests for a generated SDK
- `/oagen:verify-compat <language>` — verify emitter output preserves BC with a live SDK
- `/oagen:integrate <language>` — merge generated code into a live SDK via `--target`
- `/oagen:verify-smoke-test <language>` — run generate-verify loop to iteratively fix an emitter until smoke tests pass
