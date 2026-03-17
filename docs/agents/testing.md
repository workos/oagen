# Testing And Smoke Validation

Use this guide when changing behavior, generated output, or emitter coverage.

## Quick Start: Spec Update Pipeline

When a new spec version arrives:

```bash
oagen diff --old v1.yml --new v2.yml --report         # review what changed
oagen generate --spec v2.yml --lang node --output ./sdk
oagen verify --spec v2.yml --lang node --output ./sdk

# With custom smoke runner
oagen verify --spec v2.yml --lang node --output ./sdk --smoke-runner ./my-runner.ts
```

Exit 0 = all passed. Exit 1 = findings (`smoke-diff-findings.json`). Exit 2 = compile error (`smoke-compile-errors.json`).

See [Workflows](../architecture/workflows.md) for the full workflow diagram (setup vs. ongoing).

## Unit And Integration Tests

- `test/` mirrors `src/`
- Prefer `toMatchInlineSnapshot()` for representative output assertions

## Compat Verification

Compat verification checks that generated SDK code preserves the public API surface of an existing live SDK. It sits between unit tests and smoke tests in the testing pyramid:

- **Unit tests** — verify emitter logic in isolation (fast, no external dependencies)
- **Compat verification** — verify the API surface (names, signatures, exports) matches the live SDK
- **Smoke tests** — verify wire-level HTTP behavior against the real API

Compat verification catches regressions like renamed methods, changed parameter signatures, missing exports, and reorganized barrel files — issues that unit tests don't cover because they don't compare against the live SDK, and that smoke tests don't cover because they focus on HTTP behavior rather than API shape.

- Compat extraction: `oagen extract --sdk-path <path> --lang <language> --output <output>/sdk-{language}-surface.json`
- Compat verification: `oagen verify --api-surface <output>/sdk-{language}-surface.json --lang <language> --output <output>`
- Unified verify (includes compat): `oagen verify --api-surface <output>/sdk-{language}-surface.json --lang <language> --output <output>`
- Run `/verify-compat <language>` for the full guided workflow
- See `docs/architecture/extractor-contract.md` for building new language extractors
- The differ and overlay use `LanguageHints` from the extractor to handle language-specific type comparisons (nullability, unions, extraction artifacts, derived model names). See the "Language Hints" section in the extractor contract doc.

## Smoke Tests

Smoke scripts live under `scripts/smoke/`.

- **Verify (recommended):** `oagen verify --lang <language> --output <path>` (after `oagen generate`)
- **Custom smoke runner:** `oagen verify --lang <language> --output <path> --smoke-runner ./my-runner.ts` or set `smokeRunners` (per-language map) in `oagen.config.ts`
- General smoke runner: `npm run smoke`
- Raw baseline generation: `npm run smoke:raw`
- Spec-only baseline: `npm run smoke:baseline`
- Per-language SDK smoke tests: registered via `smokeRunners` in `oagen.config.ts`
- Diffing: `npm run smoke:diff`
- Validation: `npm run smoke:validate`

## Source Of Truth

- Smoke testing guide: `scripts/smoke/README.md`
- Create a smoke test with the `.claude` skill: `/generate-smoke-test <language>`
