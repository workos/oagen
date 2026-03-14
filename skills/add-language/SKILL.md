---
name: add-language
description: Orchestrate adding a new target language to oagen end-to-end. Determines the right scenario (backwards-compatible or fresh) and guides through the correct sequence of skills. Use when the user wants to add a language, start a new SDK, or asks "how do I add X support".
arguments:
  - name: language
    description: Target language name (e.g., "python", "go", "kotlin")
    required: true
  - name: sdk_path
    description: Path to an existing live SDK for the language (optional — triggers compat scenario)
    required: false
  - name: project
    description: Path to the emitter project (overrides oagen.config.ts emitterProject)
    required: false
---

# /add-language

Orchestrate the end-to-end workflow for adding a new target language to oagen. This skill does not implement anything itself — it determines the right scenario, sequences the correct skills, and tracks progress across steps.

## Resolve Emitter Project

Before doing anything else, determine the emitter project path:

1. If the `project` argument was provided, use that.
2. Otherwise, read `oagen.config.ts` in the current directory and check for `emitterProject`.
3. If neither exists, use `AskUserQuestion` to ask: "Where is your emitter project? (path relative to this repo, e.g. `../my-emitters`)"

Store it and pass it as the `project` argument to every sub-skill invocation.

## Architecture

Emitters, extractors, smoke tests, and their unit tests all live in the **emitter project**, not in the oagen core repo. The emitter project depends on `@workos/oagen` for types and shared utilities. Skills in this repo generate files into the emitter project.

## Step 1: Determine Scenario

Use `AskUserQuestion` to determine which scenario applies. Present both with a one-line description:

> I need to know which scenario fits this language:
>
> **A. Backwards compatible** — There's a published SDK with consumers who depend on its public API. The generated SDK must match the existing surface (method names, signatures, exports).
>
> **B. Fresh** — No existing SDK to preserve, or you're intentionally replacing one. No compat constraints.

If an `sdk_path` argument was provided, default to Scenario A and confirm.

## Step 2: Present the Plan

Based on the scenario, present the skill sequence the user will run. Show only the steps that apply.

### Scenario A — Backwards compatible

```
Step 1: /generate-emitter {language}        ← scaffold emitter, design doc, tests
Step 2: /generate-extractor {language}      ← scaffold extractor for API surface extraction
Step 3: /verify-compat {language}           ← extract baseline, generate with overlay, verify
Step 4: /generate-smoke-test {language}     ← wire-level HTTP parity tests
```

### Scenario B — Fresh

```
Step 1: /generate-emitter {language}        ← scaffold emitter, design doc, tests
Step 2: /generate-smoke-test {language}     ← wire-level HTTP parity tests
```

No extractor or compat verification needed.

After presenting the plan, confirm with the user, then invoke the first skill.

## Step 3: Run Skills in Sequence

Invoke each skill in order using the `Skill` tool, passing the `project` argument through to each sub-skill. After each skill completes, report status and invoke the next one.

Between skills, run a quick validation to make sure the previous step succeeded:

```bash
# After /generate-emitter — verify emitter exists and tests pass
cd {project} && npx vitest run test/{language}/ 2>&1 | tail -5

# After /generate-extractor — verify extractor is registered
grep -l "{language}Extractor" {project}/oagen.config.ts

# After /verify-compat — check exit code / preservation score
# (handled by the skill itself)

# After /generate-smoke-test — verify script exists
ls {project}/smoke/sdk-{language}.ts
```

If a skill fails or the user wants to pause, note where they stopped. They can resume by running the remaining skills individually.

## Step 4: Final Checklist

After all skills complete, run the full validation suite and present results:

```bash
# In the emitter project:
cd {project} && npx vitest run

# In oagen core:
npx tsc --noEmit
npx tsup
```

Then present the summary:

```
=== {language} SDK support: COMPLETE ===

Scenario: {A/B}
Skills completed:
  [x] /generate-emitter {language}
  [x] /generate-extractor {language}     (Scenario A only)
  [x] /verify-compat {language}          (Scenario A only)
  [x] /generate-smoke-test {language}

Validation:
  Emitter tests:    {N} passed, {N} failed
  Type check:       PASS/FAIL
  Build:            PASS/FAIL

Files created (in {project}):
  docs/{language}.md                              — SDK design document
  src/{language}/*.ts                             — emitter ({N} files)
  test/{language}/*.test.ts                       — emitter tests ({N} files)
  src/compat/extractors/{language}.ts             (Scenario A)
  test/compat/extractors/{language}.test.ts       (Scenario A)
  test/fixtures/sample-sdk-{language}/            (Scenario A)
  smoke/sdk-{language}.ts                         — smoke test runner

Next steps:
  - Run the verify-and-fix loop:
    oagen generate --lang {language} --output ./sdk --spec <spec> --namespace <ns>
    oagen verify --lang {language} --output ./sdk --spec <spec>
```
