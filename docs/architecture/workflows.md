# Workflows

Two distinct phases: one-time setup (add a new SDK), then ongoing spec-driven
updates. The emitter-fixing loop only happens during setup.

---

## Phase 1: /generate-sdk (one-time setup)

Build and validate a new language emitter. This is the only time emitter code
gets written or fixed.

### Skill sequence

**Scenario A** (existing SDK to preserve):

1. `/generate-emitter` — scaffold emitter, design doc, tests
2. `/generate-extractor` — scaffold extractor for API surface extraction
3. `/verify-compat` — extract baseline, generate with overlay, verify (includes overlay loop)
4. `/generate-smoke-test` — wire-level HTTP parity tests

**Scenario B** (fresh, no compat constraints):

1. `/generate-emitter` — scaffold emitter, design doc, tests
2. `/generate-smoke-test` — wire-level HTTP parity tests

### Overlay loop (Scenario A only, inside /verify-compat)

Mechanical, automated. The overlay patches itself to resolve naming mismatches
between the generated SDK and the live SDK's API surface. The extractor's
`hints: LanguageHints` flows through to both the overlay builder and the differ,
so all type string interpretation (nullability, unions, extraction artifacts) is
language-appropriate.

1. Generate SDK with compat overlay applied (hints from extractor)
2. Diff generated output against baseline `<output>/sdk-{language}-surface.json` (hints from extractor)
3. If violations found, `patchOverlay()` adjusts the overlay
4. Regenerate with the patched overlay
5. Repeat

**Caps:**

- `--max-retries` (default 3) — hard stop after N attempts
- Stall detection — if the preservation score doesn't improve between attempts,
  stops early (the remaining violations can't be fixed by overlay patching)

**What it can't fix:** Structural emitter issues (e.g., wrong method signature
shape, missing exports). Those require changing emitter code — the loop exits 1
and the emitter-fixing loop takes over.

**Code:** `src/cli/verify.ts` (compat check) and `src/compat/overlay.ts` (patch loop)

### Emitter-fixing loop (Phase 1 only)

This loop only runs during `/generate-sdk` setup, after all skills complete.
Its purpose is to get the new emitter producing correct output for the first time:

1. `oagen generate --spec {spec} --lang {lang} --output {sdk-path}`
2. `oagen verify --spec {spec} --lang {lang} --output {sdk-path}`
3. If exit 0 — done, proceed to final validation
4. If exit 1 — read `smoke-diff-findings.json`, fix emitter or smoke script, go to 1
5. If exit 2 — read `smoke-compile-errors.json`, fix emitter, go to 1

This loop ends when verify exits 0. After that, the emitter is stable and
Phase 2 (spec-driven updates) takes over.

### Final validation

```bash
npx tsc --noEmit        # type check
npx vitest run          # tests
npx tsup                # build
npm run lint:structure  # dependency layers, naming, file size
```

---

## Phase 2: Spec updates (ongoing)

The emitter is stable. When a new version of the OpenAPI spec arrives,
regenerate the SDK and verify it.

### Pipeline

1. **Review changes:** `oagen diff --old v1.yml --new v2.yml --report`
2. **Regenerate:** `oagen generate --spec v2.yml --lang {lang} --output ./sdk`
3. **Verify:** `oagen verify --spec v2.yml --lang {lang} --output ./sdk`
4. **Ship** if verify exits 0

**Alternative: incremental generation.** Instead of full `generate`, use
`diff` in generation mode to only regenerate affected files:

```bash
oagen diff --old v1.yml --new v2.yml --lang ruby --output ./sdk
oagen verify --spec v2.yml --lang ruby --output ./sdk
```

For Scenario A (backwards-compat), pass `--api-surface` to preserve the overlay:

```bash
oagen diff --old v1.yml --new v2.yml --lang ruby --output ./sdk --api-surface ./sdk/sdk-{language}-surface.json
```

**External consumers** configure emitters and extractors via `oagen.config.ts`
instead of modifying CLI source — see the Configuration section in the README.

### If verify fails on a spec update

This is rare — it means the new spec introduced a pattern the emitter doesn't
handle yet (a new type, an unusual response shape). This is not the same as the
emitter-fixing loop from Phase 1. Fix the specific gap in the emitter, re-run
`generate` + `verify`, and move on.

**Diagnostics:** Pass `--diagnostics` to produce `verify-diagnostics.json` with
a structured breakdown of compat violations and smoke results. This is useful
for measuring overlay effectiveness per language and tracking preservation scores
over time.

```bash
oagen verify --spec v2.yml --lang node --output ./sdk --api-surface surface.json --diagnostics
# → verify-diagnostics.json
```

### Exit codes from `oagen verify`

| Exit code | Meaning                                       | Findings file               |
| --------- | --------------------------------------------- | --------------------------- |
| 0         | Clean — all checks passed                     | —                           |
| 1         | Findings — CRITICAL mismatches or missing ops | `smoke-diff-findings.json`  |
| 2         | Compile error — SDK failed type check         | `smoke-compile-errors.json` |
