# Testing And Smoke Validation

Use this guide when changing behavior, generated output, or emitter coverage.

## Unit And Integration Tests

- `test/` mirrors `src/`
- Prefer `toMatchInlineSnapshot()` for representative output assertions

## Compat Verification

Compat verification checks that generated SDK code preserves the public API surface of an existing live SDK. It sits between unit tests and smoke tests in the testing pyramid:

- **Unit tests** — verify emitter logic in isolation (fast, no external dependencies)
- **Compat verification** — verify the API surface (names, signatures, exports) matches the live SDK
- **Smoke tests** — verify wire-level HTTP behavior against the real API

Compat verification catches regressions like renamed methods, changed parameter signatures, missing exports, and reorganized barrel files — issues that unit tests don't cover because they don't compare against the live SDK, and that smoke tests don't cover because they focus on HTTP behavior rather than API shape.

- Compat extraction: `npm run compat:extract -- --sdk-path <path> --lang <language>`
- Compat verification: `npm run verify:compat -- --surface api-surface.json --output <path> --lang <language>`
- Run `/verify-compat <language>` for the full guided workflow
- See `docs/architecture/extractor-contract.md` for building new language extractors

## Smoke Tests

Smoke scripts live under `scripts/smoke/`.

- General smoke runner: `npm run smoke`
- Raw baseline generation: `npm run smoke:raw`
- Node SDK smoke test: `npm run smoke:sdk:node`
- Diffing: `npm run smoke:diff`
- Baseline generation: `npm run smoke:baseline`
- Validation: `npm run smoke:validate`

## Source Of Truth

- Smoke testing guide: `scripts/smoke/README.md`
- Create a smoke test with the `.claude` skill: `/generate-smoke-test <language>`
