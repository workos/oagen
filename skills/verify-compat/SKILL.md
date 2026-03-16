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

## Resolve Emitter Project

Determine the location of the OpenAPI spec and live SDK before doing anything:

1. If the `spec` argument was provided, use that.
2. Otherwise, use `AskUserQuestion`: "Where is your OpenAPI spec located? (absolute or relative path, e.g. `../openapi.yaml`)"

Store it as `spec`.

3. If the `sdk-path` argument was provided, use that.
4. Otherwise, use `AskUserQuestion`: "Where is the live, published SDK? This must be the real SDK repository, not a generated output directory. (absolute path, e.g. `../backend/workos-node`)"

Store it as `sdk-path`.

**Validation**: The `sdk-path` MUST NOT be the same as or inside the `--output` directory. If it is, reject it and ask again — extracting from the generation target produces a meaningless self-comparison. The purpose of compat verification is to compare generated output against an independently maintained SDK.

## Step 1: Extract Baseline

```bash
oagen extract --sdk-path <path> --lang <language> --output <output-path>/sdk-{language}-surface.json
```

This produces `sdk-{language}-surface.json` inside the output directory — the baseline snapshot of the live SDK's public API (classes, methods, interfaces, type aliases, enums, exports).

**Gitignore it** — it's a derived artifact. Ensure `sdk-*-surface.json` is in the output project's `.gitignore`:

```bash
grep -q 'sdk-\*-surface.json' <output-path>/.gitignore 2>/dev/null || echo 'sdk-*-surface.json' >> <output-path>/.gitignore
```

**Verify the output via subagent:** Use the `Agent` tool with `subagent_type: Explore` to spot-check the extraction. This keeps the SDK's source out of the main context:

> Explore the SDK at `{sdk_path}`. List all public classes and their public method names. Only report what you actually find — no assumptions.

Compare the subagent's findings against `<output-path>/sdk-{language}-surface.json`. If the surface looks empty or incomplete, the extractor may need fixes — run `/generate-extractor` to debug.

**Scope to API-relevant symbols:** The live SDK may export hand-written classes and interfaces that are not derivable from the OpenAPI spec (e.g., `CookieSession`, `PKCE`, `Webhooks`, signature verification utilities, HTTP client abstractions). These are out of scope for compat verification — the emitter isn't expected to generate them.

After extraction, cross-reference the baseline surface against the OpenAPI spec's operations. Symbols that have no corresponding OpenAPI operation should be noted but excluded from the compat score. Report them separately so the user knows what's excluded:

```
Out of scope (not in OpenAPI spec): CookieSession, PKCE, Webhooks, ...
In scope (API-derived): 280 classes, 1200 interfaces, ...
```

This prevents the compat score from being diluted by symbols the emitter can't possibly generate. The goal is to measure how well the emitter preserves the API surface, not how completely it replicates hand-written SDK features.

## Step 2: Generate with Overlay

```bash
oagen generate --spec <spec> --lang <language> --output <output-path> --api-surface <output-path>/sdk-{language}-surface.json
```

The emitter receives the overlay via `EmitterContext` and uses it to preserve existing method names, class names, and type names where possible.

## Step 3: Verify

```bash
oagen verify --lang <language> --output <output-path> --api-surface <output-path>/sdk-{language}-surface.json
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
oagen generate --spec <spec> --lang <language> --output <output-path> --api-surface <output-path>/sdk-{language}-surface.json
oagen verify --lang <language> --output <output-path> --api-surface <output-path>/sdk-{language}-surface.json
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
