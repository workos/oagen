# Non-Additive Spec Changes: Staleness Detection

## Problem

The writer (`src/engine/writer.ts`) is additive-only — it never removes or modifies existing symbols in the live SDK. When an OpenAPI spec removes an endpoint, renames a model, or drops a field, the old symbols persist as dead code. The `oagen verify` command with `--scope spec-only` masks this: `specDerivedNames(newSpec)` excludes removed symbols from the baseline, so they silently pass verification.

## Solution

Staleness detection runs as an optional step in `oagen verify` when `--old-spec`, `--spec`, and `--api-surface` are all provided. It warns about symbols the spec no longer defines but that still exist in the live SDK.

All findings route through the existing compat `Violation` system with category `'staleness'` and severity `'warning'`. Stale symbols compile and run — they are dead code, not breakage.

## Detection Mechanisms

Two complementary mechanisms identify stale symbols:

### 1. Name-set difference (top-level symbols and fields)

```
removedNames = specDerivedNames(oldSpec) − specDerivedNames(newSpec)
removedFieldPaths = specDerivedFieldPaths(oldSpec) − specDerivedFieldPaths(newSpec)
```

This catches:
- Removed models, enums, services, and type aliases at the symbol level
- Removed fields from models that still exist in the new spec

### 2. Engine differ changes (operation-level)

```
diffSpecs(oldSpec, newSpec) → operation-removed changes
```

This catches methods removed from services that still exist — e.g., `Users.deleteUser` removed while the `Users` service continues.

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
- `src/cli/verify.ts` — wires staleness detection into the verify command
- `src/cli/index.ts` — registers `--old-spec` CLI flag
- `test/compat/staleness.test.ts` — unit tests
