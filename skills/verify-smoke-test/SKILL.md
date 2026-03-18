---
name: verify-smoke-test
description: Run the generate-verify loop to iteratively fix an emitter until smoke tests pass. Use after smoke tests are created, when verify reports findings or compile errors, when you need to fix emitter output, or when debugging smoke test failures. Also triggers for "emitter-fixing loop", "generate-verify loop", "fix smoke test failures", "emitter not passing", or "iterate on emitter".
---

# /verify-smoke-test

## Purpose

Run `oagen generate` → `oagen verify` in a loop, diagnosing and fixing the emitter (or smoke script) after each iteration until verify exits 0.

This is the final phase of `/generate-sdk` setup — after the emitter, extractor, compat overlay, and smoke tests are all scaffolded, this loop gets the emitter actually producing correct output.

## Inputs

- **language** — target language (e.g., `node`, `ruby`, `python`)
- **spec** — path to the OpenAPI spec
- **output** — path to the generated SDK output directory
- **project** — path to the emitter project
- **namespace** — SDK namespace/package name
- **sdk_path** _(optional, Scenario A)_ — path to the live SDK for target integration
- **api-surface** _(optional, Scenario A)_ — path to `sdk-{language}-surface.json`

## Reference Docs

- [Workflows](../../docs/architecture/workflows.md) — emitter-fixing loop and final validation
- [Emitter Contract](../../docs/architecture/emitter-contract.md) — generator methods and `GeneratedFile` shape
- [Testing & Smoke Validation](../../docs/agents/testing.md) — smoke testing guide and exit codes

## When to Use

- After `/generate-smoke-test` completes and you need to iterate the emitter to passing
- When `oagen verify` exits 1 (findings) or 2 (compile errors) and you want to fix and retry
- During any generate → verify cycle where the emitter needs corrections
- When resuming a previous session that left off mid-loop (the findings file is the handoff state)

## Resolve Paths

Collect these values. Use arguments if provided, otherwise ask:

1. **`language`** — target language (e.g., `node`, `ruby`, `python`)
2. **`spec`** — path to the OpenAPI spec (e.g., `../openapi.yaml`)
3. **`output`** — path to the generated SDK output directory
4. **`project`** — path to the emitter project (often the parent of `output`)
5. **`namespace`** — SDK namespace/package name (e.g., `WorkOS`)

Optional (Scenario A only):

- **`sdk_path`** — path to the live SDK for target integration
- **`api-surface`** — path to `sdk-{language}-surface.json` for compat overlay

Check if a previous findings file exists — this indicates a prior loop iteration:

```bash
ls {output}/smoke-diff-findings.json {output}/smoke-compile-errors.json 2>/dev/null
```

If findings exist, read them to understand the starting state before running the first iteration.

## The Loop

### Step 1: Generate

```bash
oagen generate --spec {spec} --lang {language} --output {output} --namespace {namespace}
```

If Scenario A (compat overlay + live SDK integration), include:

```bash
oagen generate --spec {spec} --lang {language} --output {output} --namespace {namespace} --api-surface {api-surface} --target {sdk_path}
```

### Step 2: Verify

```bash
oagen verify --spec {spec} --lang {language} --output {output}
```

If Scenario A, include:

```bash
oagen verify --spec {spec} --lang {language} --output {output} --api-surface {api-surface}
```

### Step 3: Interpret Exit Code

| Exit | Meaning       | Output file                 | Next action       |
| ---- | ------------- | --------------------------- | ----------------- |
| 0    | Clean         | —                           | Done — go to Exit |
| 1    | Findings      | `smoke-diff-findings.json`  | Go to Step 4      |
| 2    | Compile error | `smoke-compile-errors.json` | Go to Step 5      |

### Step 4: Fix Findings (exit 1)

Read `{output}/smoke-diff-findings.json`. It contains:

- `criticalFindings` — CRITICAL-severity mismatches (blocking)
- `warningFindings` — WARNING-severity mismatches (review)
- `infoFindings` — INFO-severity observations (non-blocking)
- `missingFromSdk` — operations the SDK didn't attempt
- `missingFromRaw` — operations missing from baseline (non-blocking)
- `coverage` — summary stats

Focus on CRITICAL findings first. Use the remediation table to locate the fix:

| Finding                          | Fix location                                           |
| -------------------------------- | ------------------------------------------------------ |
| "HTTP method differs"            | Emitter's `resources.ts` — method generation           |
| "Request path structure differs" | Emitter's `resources.ts` — path interpolation          |
| "Query parameters differ"        | Emitter's `resources.ts` — query param serialization   |
| "Request body key sets differ"   | Emitter's `models.ts` or `resources.ts` — serializers  |
| "Skipped in SDK"                 | Smoke runner `smoke/sdk-{lang}.ts` — method resolution |
| "Missing from SDK"               | Smoke runner `smoke/sdk-{lang}.ts` — method mapping    |

After fixing, go back to Step 1.

### Step 5: Fix Compile Errors (exit 2)

Read `{output}/smoke-compile-errors.json`. These are TypeScript type errors in the generated SDK. Common causes:

- Missing imports or wrong import paths → fix in emitter's file generators
- Type mismatches → fix in emitter's `type-map.ts` or model generators
- Missing properties → fix in emitter's `models.ts`

After fixing, go back to Step 1.

## Stall Detection

Track the count of CRITICAL findings between iterations. If the count doesn't decrease after three consecutive iterations, stop and report:

```
Stall detected: {N} CRITICAL findings remain after {iteration} iterations.
Remaining findings:
  - {finding summary}
  - ...

These may require a structural emitter change rather than a targeted fix.
```

Present the remaining findings to the user and ask how to proceed.

## Exit

When verify exits 0:

```bash
# Run the full validation suite
cd {project} && npx vitest run test/{language}/
npx tsc --noEmit
```

Report the result:

```
=== verify-smoke-test: COMPLETE ===

Iterations: {N}
Final verify: exit 0 (clean)
Unit tests: {pass/fail}
Type check: {pass/fail}
```

## Cross-Session Handoff

The findings file (`smoke-diff-findings.json` or `smoke-compile-errors.json`) is the primary handoff state. If resuming from a previous session:

1. Read the existing findings file
2. Skip straight to the fix step (Step 4 or 5)
3. After fixing, resume the loop from Step 1

## Output

- Clean verify exit (exit 0) with all smoke tests passing
- Unit tests and type check passing in the emitter project
- Iteration summary showing number of rounds and fixes applied
