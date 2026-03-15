---
name: verify-compat
description: Verify that generated SDK code preserves backwards compatibility with a live SDK. Use when regenerating an SDK for a language that has an existing published SDK, or when asked to check BC, compat, or backwards compatibility.
arguments:
  - name: language
    description: Target language (e.g., "node", "ruby", "python")
    required: true
  - name: sdk_path
    description: Path to the live SDK to verify against
    required: true
---

# /verify-compat

Verify that generated SDK code preserves backwards compatibility with a live SDK's public API surface.

## Overview

The compat verification workflow extracts the public API surface from a live SDK, generates code with a compatibility overlay that preserves existing names, and then diffs the result against the baseline. Any regressions (renamed methods, changed signatures, missing exports) are reported as violations.

This is the middle tier of the three-tier testing pyramid:

- **Unit tests** — verify emitter logic in isolation
- **Compat verification** — verify the API surface (names, signatures, exports) matches the live SDK
- **Smoke tests** — verify wire-level HTTP behavior against the real API

## Resolve oagen Core Path

Some steps below reference files in the oagen core package. Resolve the path once:

1. If `node_modules/@workos/oagen/` exists, use that as `{oagen}`.
2. If the current directory has `src/engine/types.ts`, you're in the oagen repo — use `.` as `{oagen}`.
3. Otherwise, ask: "Where is the @workos/oagen package installed?"

## Prerequisites

- An emitter exists for `<language>` (run `/generate-emitter` first)
- The live SDK is accessible at `--sdk-path`
- An extractor exists for `<language>` (see `{oagen}/docs/architecture/extractor-contract.md` to build one)
- The emitter has been run at least once to produce generated output

## Step 1: Extract Baseline

Extract the public API surface from the live SDK:

```bash
oagen extract --sdk-path <path> --lang <language>
```

**Flags:**

- `--sdk-path <path>` — path to the live SDK root (required)
- `--lang <language>` — language identifier matching the extractor (required)
- `--output <path>` — output file path (default: `api-surface.json`)

This produces `api-surface.json` — the baseline snapshot of the live SDK's public API (classes, methods, interfaces, type aliases, enums, exports).

**Verify the output**: Open `api-surface.json` and spot-check that it contains the expected classes and methods. If the surface looks empty or incomplete, the extractor may need fixes.

## Step 2: Generate with Overlay

Run the emitter with the API surface overlay so it preserves existing names:

```bash
oagen generate --spec <spec> --lang <language> --output <output-path> --api-surface api-surface.json
```

**Flags:**

- `--api-surface <path>` — path to the baseline API surface JSON from Step 1
- All other flags are the standard generate flags (`--spec`, `--lang`, `--output`, `--namespace`)

The emitter receives the overlay via `EmitterContext` and uses it to preserve existing method names, class names, and type names where possible.

## Step 3: Verify

Compare the generated output against the baseline surface:

```bash
oagen verify --lang <language> --output <output-path> --api-surface api-surface.json
```

**Flags:**

- `--surface <path>` — path to the baseline API surface JSON (required)
- `--output <path>` — path to the generated SDK output (required)
- `--lang <language>` — language identifier (required)

**Interpret the result:**

- **Exit 0** + preservation score = all clear. The generated SDK preserves the live SDK's public API.
- **Exit 1** + violations = review each violation (see Step 4).

## Step 4: Interpret Results

When verification fails, the output contains categorized violations:

| Category           | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `public-api`       | A public class, method, or type was renamed or removed |
| `signature`        | A method's parameter list or return type changed       |
| `export-structure` | A barrel export is missing or reorganized              |
| `behavioral`       | A behavioral contract changed (e.g., async → sync)     |

| Severity   | Action                                                             |
| ---------- | ------------------------------------------------------------------ |
| `breaking` | Must fix before shipping — this will break consumers               |
| `warning`  | Review carefully — may be intentional but could surprise consumers |

**For each violation:**

1. Check `symbolPath` to locate the affected symbol
2. Compare `baseline` vs `candidate` to understand the change
3. Fix the emitter to preserve the baseline name/signature, OR
4. If the change is intentional (API evolution), document it as a breaking change

## Step 5: Self-Correcting Loop (Advanced)

For automated fix-and-verify cycles, use loop mode:

Repeat Steps 2 and 3 until violations are resolved:

```bash
oagen generate --spec <spec> --lang <language> --output <output-path> --api-surface api-surface.json
oagen verify --lang <language> --output <output-path> --api-surface api-surface.json
```

Each iteration regenerates the SDK with the overlay (preserving existing names) and re-verifies. Continue until either:

- All violations are resolved (exit 0)
- No further improvement is possible (fix the emitter manually for remaining violations)

## When to Skip

For languages where backwards compatibility isn't relevant (full rewrites, new SDKs with no existing consumers), skip compat verification by passing `--no-compat-check` to the generate command:

```bash
oagen generate --spec <spec> --lang <language> --output <path> --no-compat-check
```

## Reference

- Extractor contract: `{oagen}/docs/architecture/extractor-contract.md`
- Compat types: `{oagen}/src/compat/types.ts`
- Node extractor (reference): `{oagen}/src/compat/extractors/node.ts`
- Overlay logic: `{oagen}/src/compat/overlay.ts`
- Differ: `{oagen}/src/compat/differ.ts`
