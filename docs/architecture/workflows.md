# Workflows

Two distinct phases: one-time setup (add a new SDK), then ongoing spec-driven
updates. The emitter-fixing loop only happens during setup.

---

## Phase 1: /generate-sdk (one-time setup)

Build and validate a new language emitter. This is the only time emitter code
gets written or fixed.

### Skill sequence

**Project setup:** Run `oagen init --lang {language}` to create the emitter project, then implement the emitter methods.

**Scenario A** (existing SDK to preserve):

1. `/generate-emitter` — scaffold emitter, design doc, tests
2. `/generate-extractor` — scaffold extractor for API surface extraction
3. `/verify-compat` — extract baseline, generate with overlay, verify (includes overlay loop)
4. `/generate-smoke-test` — wire-level HTTP parity tests against output dir
5. `/verify-smoke-test` — iterate until smoke tests pass
6. `/integrate` — merge generated code into the live SDK

**Scenario B** (fresh, no compat constraints):

1. `/generate-emitter` — scaffold emitter, design doc, tests
2. `/generate-smoke-test` — wire-level HTTP parity tests

> **Lifecycle note:** Scenario B is a one-time bootstrap. Once the generated SDK
> ships, it becomes the live SDK. All future spec updates follow Scenario A —
> use `--target` to integrate into the live SDK and `--api-surface` to preserve
> backwards compatibility. Phase 2 is always Scenario A.

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

- `--max-retries <n>` flag on `oagen verify` (default 3, set to 0 for single-pass)
- Stall detection — if the preservation score doesn't improve between iterations,
  stops early (the remaining violations can't be fixed by overlay patching)
- Only `public-api` and `export-structure` violations are patchable; `signature`
  and `behavioral` violations require emitter code changes

**Guard rails:** The retry loop only activates when BOTH `--api-surface` AND
`--spec` are provided (the spec is needed to regenerate). Without both,
verify runs a single pass.

**What it can't fix:** Structural emitter issues (e.g., wrong method signature
shape, async/sync mismatches). Those require changing emitter code — the loop
exits 1 and the emitter-fixing loop takes over.

**Code:** `src/cli/verify.ts` (retry loop + compat check) and `src/compat/overlay.ts`
(`patchOverlay` — also available as a library export for custom loops)

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
```

---

## Phase 2: Spec updates (ongoing)

The emitter is stable. Phase 2 is always Scenario A — there is always a live
SDK to integrate into (either a pre-existing one from Scenario A setup, or the
output of Scenario B's initial generation).

### Pipeline

Every spec update uses `--target` to merge into the live SDK and `--api-surface`
to preserve backwards compatibility:

1. **Review changes:** `oagen diff --old v1.yml --new v2.yml`
2. **Regenerate:** `oagen generate --spec v2.yml --lang {lang} --output ./sdk --target {sdk_path} --api-surface sdk-{lang}-surface.json`
3. **Verify:** `oagen verify --spec v2.yml --lang {lang} --output ./sdk --api-surface sdk-{lang}-surface.json`
4. **Ship** if verify exits 0

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

### Verify Result Types

Source: `src/verify/types.ts`, `src/compat/types.ts`, `src/differ/types.ts`

The verify pipeline returns structured result types that consumers can use programmatically:

```typescript
interface VerifyDiagnostics {
  compatCheck?: {
    totalBaselineSymbols: number;
    preservedSymbols: number;
    preservationScore: number;
    violationsByCategory: Record<string, number>;
    violationsBySeverity: Record<string, number>;
    additions: number;
    scopedToSpec: boolean;
    scopedSymbolCount?: number;
  };
  stalenessCheck?: { staleSymbolCount: number; staleSymbols: string[] };
  smokeCheck?: {
    passed: boolean;
    findingsCount?: number;
    compileErrors?: boolean;
  };
  retryLoop?: {
    attempts: number;
    converged: boolean;
    finalScore: number;
    patchedPerIteration: number[];
  };
}

interface CompatCheckResult {
  passed: boolean; // true if no breaking violations
  diff: DiffResult; // detailed diff between baseline and candidate
  scopedToSpec: boolean; // true if --spec was used to filter
  scopedSymbolCount?: number;
}

interface SmokeCheckResult {
  passed: boolean;
  findingsCount?: number; // number of CRITICAL/WARNING findings
  compileErrors?: boolean; // true if SDK failed type check
  baselinePath: string; // path to the baseline used
  generatedBaseline: boolean;
}
```

The compat differ returns a `DiffResult`:

```typescript
interface DiffResult {
  preservationScore: number; // 0–100% of baseline symbols preserved
  totalBaselineSymbols: number;
  preservedSymbols: number;
  violations: Violation[]; // breaking changes found
  additions: Addition[]; // new symbols not in baseline
}
```

Each `Violation` carries a `ViolationCategory` that indicates the kind of breaking change:

| ViolationCategory  | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `public-api`       | A public class, method, or type was renamed or removed |
| `signature`        | A method's parameter list or return type changed       |
| `export-structure` | A barrel export is missing or reorganized              |
| `behavioral`       | A behavioral contract changed (e.g., async to sync)    |
| `staleness`        | A symbol was removed from the spec but still exists    |

The spec differ (used by `oagen diff`) returns a `DiffReport`:

```typescript
interface DiffReport {
  oldVersion: string;
  newVersion: string;
  changes: Change[]; // ModelAdded, ModelRemoved, EnumAdded, OperationAdded, etc.
  summary: { added; removed; modified; breaking; additive };
}
```

### Exit codes from `oagen verify`

| Exit code | Meaning                                       | Findings file               |
| --------- | --------------------------------------------- | --------------------------- |
| 0         | Clean — all checks passed                     | —                           |
| 1         | Findings — CRITICAL mismatches or missing ops | `smoke-diff-findings.json`  |
| 2         | Compile error — SDK failed type check         | `smoke-compile-errors.json` |
