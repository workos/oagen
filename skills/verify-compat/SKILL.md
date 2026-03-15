---
name: verify-compat
description: Verify that generated SDK code preserves backwards compatibility with a live SDK. Use when regenerating an SDK for a language that has an existing published SDK, checking for breaking changes, regressions, or API surface drift. Also triggers for "BC check", "backwards compatibility", "compat verification", "breaking change detection", "API surface comparison", or "regression check".
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

Check for `node_modules/@workos/oagen/`, or `src/engine/types.ts` in the current directory, otherwise ask.

## Prerequisites

- An emitter exists for `<language>` (run `/generate-emitter` first)
- The live SDK is accessible at `--sdk-path` — must be the real, published SDK
- An extractor exists for `<language>` (run `/generate-extractor` first)
- The emitter has been run at least once to produce generated output
- The emitter's design doc (`docs/sdk-architecture/{language}.md`) exists and documents the real SDK's patterns

## Step 1: Extract Baseline

```bash
oagen extract --sdk-path <path> --lang <language>
```

This produces `api-surface.json` — the baseline snapshot of the live SDK's public API (classes, methods, interfaces, type aliases, enums, exports).

**Verify the output:** Open `api-surface.json` and spot-check that it contains the expected classes and methods. If the surface looks empty or incomplete, the extractor may need fixes — run `/generate-extractor` to debug.

## Step 2: Generate with Overlay

```bash
oagen generate --spec <spec> --lang <language> --output <output-path> --api-surface api-surface.json
```

The emitter receives the overlay via `EmitterContext` and uses it to preserve existing method names, class names, and type names where possible.

## Step 3: Verify

```bash
oagen verify --lang <language> --output <output-path> --api-surface api-surface.json
```

- **Exit 0** + preservation score = all clear
- **Exit 1** + violations = review each violation (see Step 4)

## Step 4: Interpret Results

| Category           | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `public-api`       | A public class, method, or type was renamed or removed |
| `signature`        | A method's parameter list or return type changed       |
| `export-structure` | A barrel export is missing or reorganized              |
| `behavioral`       | A behavioral contract changed (e.g., async to sync)    |

| Severity   | Action                                                             |
| ---------- | ------------------------------------------------------------------ |
| `breaking` | Must fix before shipping — this will break consumers               |
| `warning`  | Review carefully — may be intentional but could surprise consumers |

**For each violation:**

1. Check `symbolPath` to locate the affected symbol
2. Compare `baseline` vs `candidate` to understand the change
3. Fix the emitter to preserve the baseline name/signature, OR
4. If intentional, document it as a breaking change

**When violations can't be auto-fixed:** Some violations indicate structural emitter issues (wrong method signature shape, missing exports). These require changing emitter code directly — the overlay loop can only fix naming mismatches, not structural problems. Read the violation details to determine whether this is an overlay issue or an emitter issue.

## Step 5: Self-Correcting Loop

Repeat Steps 2 and 3 until violations are resolved:

```bash
oagen generate --spec <spec> --lang <language> --output <output-path> --api-surface api-surface.json
oagen verify --lang <language> --output <output-path> --api-surface api-surface.json
```

Continue until either all violations are resolved (exit 0) or no further improvement is possible (fix the emitter manually).

## When to Skip

For languages where backwards compatibility isn't relevant (full rewrites, new SDKs), skip compat verification:

```bash
oagen generate --spec <spec> --lang <language> --output <path> --no-compat-check
```

## Reference

- Extractor contract: `{oagen}/docs/architecture/extractor-contract.md`
- Compat types: `{oagen}/src/compat/types.ts`
- Node extractor (reference): `{oagen}/src/compat/extractors/node.ts`
- Overlay logic: `{oagen}/src/compat/overlay.ts`
- Differ: `{oagen}/src/compat/differ.ts`
