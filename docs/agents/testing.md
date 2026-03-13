# Testing And Smoke Validation

Use this guide when changing behavior, generated output, or emitter coverage.

## Unit And Integration Tests

- `test/` mirrors `src/`
- Prefer `toMatchInlineSnapshot()` for representative output assertions

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
