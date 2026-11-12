# Non-Additive Spec Changes: Staleness Detection

## Problem

The writer (`src/engine/writer.ts`) is additive-only — it never removes or modifies existing symbols in the live SDK. When an OpenAPI spec removes an endpoint, renames a model, or drops a field, the old symbols persist as dead code. The `oagen verify` command with `--scope spec-only` masks this: `specDerivedNames(newSpec)` excludes removed symbols from the baseline, so they silently pass verification.

The scope reads the spec as `generate` writes it. A service class is named by the mount target each operation resolves to (`ResolvedOperation.mountOn`) and a method by the mount target and the resolved method name (`methodName`), under the config's `mountRules`, `operationHints` and `operationNaming` — the settings `generate` resolves with (`OperationResolution`, see [Operation Resolution](ir-types.md#operation-resolution)) — never by the IR's `Service.name` and `Operation.name` alone. Under `mountRules: { Pets: 'Animals' }` and `operationHints: { 'GET /pets': { name: 'list_all' } }`, the scope holds `Animals` and the method paths `Animals.list_all` and `Animals.get_pet` (beside the IR's `Animals.list` and `Animals.get`, the keys the scope read before, so an SDK whose methods carry the operationIds stays in scope); a method path is matched with underscores stripped and case folded, so a Node `listAll`, a Ruby `list_all` and a .NET `ListAll` all read `Animals.list_all`. Read from the IR as parsed, `Animals` was no name the spec derived, so a `mountRules` setup scoped the remounted class out — `1/2 baseline symbols in scope` — and a method removed from it passed verification; with the resolution the scope is `2/2` and the removal is a `symbol_removed`. A `Pets` class is then out of scope, since `generate` writes none; with no settings, every service keeps its own name and path naming.

## Solution

Staleness detection runs as an optional step in `oagen verify` when `--old-spec`, `--spec`, and `--api-surface` are all provided. It warns about symbols the spec no longer defines but that still exist in the live SDK.

All findings route through the existing compat `Violation` system with category `'staleness'` and severity `'warning'`. Stale symbols compile and run — they are dead code, not breakage.

## Detection Mechanisms

Two complementary mechanisms identify stale symbols:

### 1. Name-set difference (top-level symbols and fields)

```
removedNames = specDerivedNames(oldSpec, resolution) − specDerivedNames(newSpec, resolution)
removedFieldPaths = specDerivedFieldPaths(oldSpec) − specDerivedFieldPaths(newSpec)
```

This catches:

- Removed models, enums, services, and type aliases at the symbol level
- Removed fields from models that still exist in the new spec

Both specs are resolved with the same `OperationResolution` (the config's `mountRules`, `operationHints` and `operationNaming`), so a service class is its mount target: under `mountRules: { Pets: 'Animals' }` a live `Animals` class is stale once the new spec drops the `Pets` tag and nothing else mounts on `Animals`.

### 2. Resolved method difference (method-level)

```
removedMethods = specDerivedMethodPaths(oldSpec, resolution) − specDerivedMethodPaths(newSpec, resolution)
```

A live method on a class the new spec still names is stale when the old spec's resolution names it on that class — by the resolved method name, a split wrapper's name or the IR's operation name, matched with underscores stripped and case folded — and the new spec's resolution does not. This catches methods removed from services that still exist — e.g., `Users.deleteUser` removed while the `Users` service continues — on the class `generate` wrote them to: a live `Animals.listAll` under `operationHints: { 'GET /pets': { name: 'list_all' } }` once the new spec drops `GET /pets`, and the methods of a service merged onto a mount target another service keeps (`mountRules: { Pets: 'Animals', Dogs: 'Animals' }`, the `Pets` tag dropped). The latter is why this step does not read the differ's `operation-removed` changes: a removed service yields none, and the changes are keyed by the IR's names. A class the new spec no longer names is reported once, by the first mechanism, not again per method. Both sides also read the compat overlay `generate --api-surface` wrote the SDK with (`buildOverlayLookup` from the baseline and the `.oagen-manifest.json` in `--output`): a baseline method the manifest maps to an operation (`GET /pets` → `Animals.fetchAll`) is keyed under that name, so it is stale once the new spec drops the route.

### Cross-reference with live surface

Both mechanisms cross-reference findings against the live SDK surface (`--api-surface`) to confirm the stale symbol actually exists. If a removed spec symbol was never in the SDK (e.g., never generated, or already cleaned up), no warning is emitted.

## CLI Usage

```bash
oagen verify \
  --lang node \
  --output ./sdk \
  --spec openapi-v2.yml \
  --old-spec openapi-v1.yml \
  --api-surface sdk-node-surface.json
```

Flags:

- `--old-spec <path>` — previous version of the OpenAPI spec
- `--spec <path>` — current version of the OpenAPI spec
- `--api-surface <path>` — extracted API surface of the live SDK

All three must be provided for staleness detection to run. When `--diagnostics` is set, staleness findings are included in `verify-diagnostics.json` under `stalenessCheck`.

## Behavior

- Staleness findings are **warnings only** — they never cause a non-zero exit code on their own
- Hand-written SDK symbols (never in any spec version) are not flagged
- Field-level staleness is only reported for models that still exist in the new spec (fully removed models are reported at the symbol level)

## Deferred Work

**Rename detection** is not implemented. When a spec renames a model (e.g., `Organization` → `Org`), staleness detection flags the old name as stale and compat verification flags the new name as missing. Precise rename detection (linking old → new) requires manifest comparison across spec versions and is deferred to future work.

## Implementation

- `src/compat/types.ts` — `ViolationCategory` union includes `'staleness'`
- `src/compat/staleness.ts` — `detectStaleSymbols()` core detection logic
- `src/compat/spec-filter.ts` — `specDerivedNames()` and `specDerivedMethodPaths()`, resolved as `generate` resolves (`OperationResolution`)
- `src/cli/verify.ts` — wires staleness detection into the verify command, with the config's `mountRules`, `operationHints` and `operationNaming`
- `src/cli/index.ts` — registers `--old-spec` CLI flag
- `test/compat/staleness.test.ts` — unit tests
