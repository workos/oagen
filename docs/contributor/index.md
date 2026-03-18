# Contributor Docs

These documents describe the maintenance rules for oagen itself and the guarantees made to consumers of the public API. If you are modifying oagen core (the parser, engine, IR types, compat system, or CLI), start here to understand what contracts you must preserve.

## Key Documents

- [Public API Policy](public-api.md) — three-tier public surface (core default export, advanced subpaths, internal) and what constitutes a breaking change
- [Versioning and Migration](versioning.md) — IR version bumping rules, package versioning, and advanced workflow compatibility
- [Dependency Layers](../architecture/dependency-layers.md) — one-way import matrix (`ir → utils → parser → engine/differ/compat → cli`) enforced by structural linter
- [Pipeline Architecture](../architecture/pipeline.md) — three-stage parse/emit/write flow with orchestrator details
