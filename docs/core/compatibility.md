# Compatibility Verification

oagen includes a cross-language compatibility engine that detects breaking changes, classifies their severity per-language, and enforces policy before generated SDKs ship.

## Overview

The compatibility system answers: **"will this regeneration break existing callers?"**

It works by comparing two snapshots of an SDK's public API surface — a baseline (the live SDK) and a candidate (the newly generated output) — and classifying every difference.

## Lifecycle

```
compat-extract → .oagen-compat-snapshot.json → compat-diff → report → compat-summary
```

1. **Extract** — `oagen compat-extract` runs an extractor against the live SDK and writes a `CompatSnapshot` JSON file to disk (`.oagen-compat-snapshot.json`)
2. **Diff** — `oagen compat-diff` compares a baseline snapshot (committed) against a candidate snapshot (freshly extracted from generated output), classifying each difference
3. **Enforce** — `compat-diff` exits non-zero when unapproved changes meet or exceed the fail threshold (`--fail-on`)
4. **Summary** — `oagen compat-summary` formats the JSON report as a markdown PR comment

The baseline snapshot is committed to the repository and updated on each release. The candidate snapshot is extracted in CI from the freshly generated SDK.

### CLI Commands

| Command                | Purpose                                        |
| ---------------------- | ---------------------------------------------- |
| `oagen compat-extract` | Extract a snapshot from a live SDK → JSON file |
| `oagen compat-diff`    | Diff two snapshot files → classified report    |
| `oagen compat-summary` | Format a report → markdown PR comment          |

See [CLI Reference](../cli.md) for full argument tables.

## Relation to Smoke Tests

Smoke tests verify **behavioral** correctness: does the generated SDK call the right endpoints with the right parameters? Compatibility verification checks **structural** correctness: does the generated SDK preserve the public API shape that callers depend on?

Both run during `oagen verify`. Smoke tests catch bugs. Compat checks catch breaking changes.

## Relation to Spec Diffing

`oagen diff` compares two OpenAPI specs to show what changed at the API level. Compat verification compares two SDK surfaces to show what changed at the SDK level. A spec change may or may not produce a breaking SDK change, depending on the language and how the emitter handles it.

## Key Concepts

### Classification

Every detected change gets a category and severity:

- **Breaking** — Will break existing callers (e.g., `parameter_removed`, `symbol_renamed`)
- **Soft-risk** — May affect callers depending on usage (e.g., `constructor_reordered_named_friendly`)
- **Additive** — Safe to ship (e.g., `symbol_added`, `parameter_added_optional_terminal`)

See [Compatibility IR](compatibility-ir.md) for the full category list.

### Language Policy

The same conceptual change has different severity in different languages. A parameter rename is breaking in PHP (named arguments) but soft-risk in Go (positional only). Language policy is defined by `CompatPolicyHints` with built-in defaults for all 9 supported languages.

See [Compatibility Policy](compatibility-policy.md) for details.

### Concept-First Approvals

When a breaking change is intentional, it can be approved in `oagen.config.ts`. Approvals are concept-first: one approval targets one symbol and one change category, optionally scoped to specific languages.

See [Compatibility Policy](compatibility-policy.md) for the approval schema.

### Provenance

Each classified change includes a provenance bucket explaining where the drift came from:

- `spec_shape_change` — The spec changed
- `emitter_template_change` — The emitter template changed
- `normalization_change` — Naming normalization produced different output
- `unknown` — Source of drift not determined

## Further Reading

- [CLI Reference](../cli.md) — `compat-extract`, `compat-diff`, `compat-summary` argument tables
- [Compatibility IR](compatibility-ir.md) — Types, categories, parameters, `extractSnapshot()`
- [Compatibility Policy](compatibility-policy.md) — Config, approvals, language defaults
- [Manifest Schema](manifest-schema.md) — `.oagen-manifest.json` format
- [Verify Compat](verify-compat.md) — CI workflows, reports, GitHub Actions example
