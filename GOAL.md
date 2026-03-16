# Goal: Source Coverage

## Fitness Function

```bash
# Run this to get the current score:
bash scripts/score.sh
```

### Metric Definition

```
score = (line_coverage * 0.50) + (branch_coverage * 0.30) + (function_coverage * 0.20)
```

| Component | What it measures |
|-----------|------------------|
| **line_coverage** | % of src/ lines exercised by tests (vitest --coverage) |
| **branch_coverage** | % of src/ branches (if/else, ternary, ??) exercised |
| **function_coverage** | % of src/ functions called at least once |
| **gates** | Typecheck, structural lint, and 100% test pass rate — any gate failure → score 0 |

### Metric Mutability

- [ ] **Locked** — Agent cannot modify scoring code
- [x] **Split** — Agent can improve the instrument but not the outcome definition
- [ ] **Open** — Agent can modify everything including how success is measured

## Operating Mode

- [x] **Converge** — Stop when criteria met
- [ ] **Continuous** — Run until human interrupts
- [ ] **Supervised** — Pause at gates for approval

### Stopping Conditions

Stop and report when ANY of:
- Score ≥ 92 (roughly: lines ≥ 90%, branches ≥ 90%, functions ≥ 95%)
- 15 iterations completed
- A change would require modifying existing tests (violates CLAUDE.md constraint)

## Bootstrap

1. `npm install`
2. `npm run build && npm test` — verify clean state
3. `bash scripts/score.sh` — record baseline
4. Starting score: **80.15**

## Improvement Loop

```
repeat:
  0. Read iterations.jsonl if it exists — note what's been tried and what worked
  1. bash scripts/score.sh > /tmp/before.json  (use the last JSON line)
  2. Read scores and per-directory breakdowns from coverage/coverage-summary.json
  3. Pick highest-impact action from Action Catalog
  4. Make the change (add tests, not change source to game coverage)
  5. npm test — verify no regressions
  6. bash scripts/score.sh > /tmp/after.json
  7. Compare: if score improved without regression, commit
  8. If score regressed or unchanged, revert
  9. Append to iterations.jsonl: before/after scores, action taken, result, one-sentence note
  10. Continue
```

Commit messages: `[S:NN→NN] component: what you did`

## Iteration Log

File: `iterations.jsonl` (append-only, one JSON object per line)

```jsonl
{"iteration":1,"before":80.15,"after":82.0,"action":"Add CLI generate tests","result":"kept","note":"covered generate command paths"}
```

## Action Catalog

### src/cli/ (current: 8.12% lines — largest gap)

| Action | Est. Impact | How |
|--------|------------|-----|
| Test `generate` command paths | +4–6 pts | Cover missing-spec, missing-lang, dry-run, real generation with fixture emitter |
| Test `diff` command (report + apply modes) | +3–5 pts | Feed two spec versions, verify diff output and incremental regen |
| Test `extract` command | +1–2 pts | Invoke with mock extractor, verify JSON output |
| Test `verify` command smoke paths | +2–3 pts | Already has some coverage in verify.test.ts — fill remaining branches |
| Test `parse` command edge cases | +1 pt | Missing-spec, invalid YAML, large spec handling |

### src/compat/ (current: 81.3% lines)

| Action | Est. Impact | How |
|--------|------------|-----|
| Cover overlay edge cases (empty surface, no overlap) | +1–2 pts | Add overlay.test.ts cases for degenerate inputs |
| Cover differ uncovered branches (371–382) | +1 pt | Read differ.ts:371-382, write targeted test |
| Test extractor-registry.ts | +1 pt | Register/lookup/miss scenarios |

### src/engine/ (current: 88.33% lines)

| Action | Est. Impact | How |
|--------|------------|-----|
| Cover writer.ts lines 10–16 (mkdir/write branches) | +1–2 pts | Test write-to-nonexistent-dir, overwrite-existing, dry-run |
| Cover orchestrator.ts lines 54–56 | +0.5 pts | Test edge case where no emitter is registered |
| Cover incremental.ts lines 68–76 | +0.5 pts | Test unchanged-file skip logic |

### src/parser/ (current: 89.08% lines)

| Action | Est. Impact | How |
|--------|------------|-----|
| Cover parse.ts lines 128–148 (ref resolution edge cases) | +1 pt | Feed spec with circular refs or deeply nested allOf |
| Cover schemas.ts uncovered lines (284–288, 344–350) | +1 pt | Test patternProperties and new untyped-schema fallback |
| Cover refs.ts lines 27–32 | +0.5 pts | Test malformed $ref strings |
| Cover operations.ts remaining branches | +0.5 pts | Test deprecated operations, unusual HTTP methods |

### src/ir/ (current: 50% lines)

| Action | Est. Impact | How |
|--------|------------|-----|
| Test validateModelRefs (types.ts:133–134) | +0.5 pts | Feed IR with dangling model refs, verify warnings |

## Constraints

1. **Never remove or edit existing tests** — CLAUDE.md rule, violating this reverts + score 0
2. **Tests must be meaningful** — no empty tests, no `expect(true).toBe(true)`, no tests that simply import a module without exercising it
3. **No source changes to game coverage** — don't add unreachable branches, don't delete untested source code
4. **Respect dependency layers** — test files may import from src/ but not violate the one-way layer rule
5. **Keep tests fast** — no network calls, no 5-second sleeps; mock external I/O where needed

## File Map

| File | Role | Editable? |
|------|------|-----------|
| scripts/score.sh | Fitness function | Split (can fix bugs, not redefine formula) |
| iterations.jsonl | Iteration log | Append-only |
| GOAL.md | This file | No |
| test/**/*.test.ts | Existing tests | No (add new tests, don't edit existing) |
| src/**/*.ts | Source under test | No (coverage comes from tests, not source changes) |
| coverage/ | Generated reports | Written by vitest only |

## When to Stop

```
Starting score: 80.15
Ending score:   NN.N
Iterations:     N
Changes made:   (list)
Remaining gaps: (list)
Next actions:   (what a human or future agent should do next)
```
