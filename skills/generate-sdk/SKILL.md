---
name: generate-sdk
description: Orchestrate generating an SDK for a target language end-to-end. Determines the right scenario (backwards-compatible or fresh) and guides through the correct sequence of sub-skills. Use when the user wants to generate an SDK, add a new language, create SDK bindings, start a new language target, or asks "how do I add X support". Also triggers for "new SDK", "language support", or "scaffold SDK".
---

# /generate-sdk

Orchestrate the end-to-end workflow for generating an SDK for a target language. This skill does not implement anything itself — it determines the right scenario, sequences the correct skills, and tracks progress across steps.

## Architecture

Emitters, extractors, smoke tests, and their unit tests all live in the **emitter project**, not in the oagen core repo. The emitter project depends on `@workos/oagen` for types and shared utilities.

## Step 1: Determine Language

Use `AskUserQuestion` to determine the target language (e.g., "ruby", "python", "php"). Store `language` and pass it to all sub-skill invocations.

## Step 2: Determine Scenario

Use `AskUserQuestion` to determine which scenario applies:

> **A. Backwards compatible** — There's a published SDK with consumers who depend on its public API. The generated SDK must match the existing surface.
>
> **B. Fresh** — No existing SDK to preserve, or you're intentionally replacing one. No compat constraints.

**For Scenario A:** Also ask: "Where is the existing SDK? (absolute or relative path)" Validate the path exists (look for `package.json`, `Gemfile`, `go.mod`, `pyproject.toml`, or similar). Store `sdk_path`.

## Step 3: Determine Project Location

Use `AskUserQuestion`: "Where is your emitter project located? (absolute or relative path, e.g. `../oagen-emitters/node`)"

Validate and create if needed:

```bash
mkdir -p {project}/src/{language} && mkdir -p {project}/test/{language}
```

Store `project` and pass it to all sub-skill invocations.

## Step 4: Present the Plan

### Scenario A — Backwards compatible

```
Step 1: /generate-emitter {language} {project} sdk_path={sdk_path}    — study existing SDK, scaffold emitter
Step 2: /generate-extractor {language} sdk_path={sdk_path}            — scaffold extractor
Step 3: /verify-compat {language} sdk_path={sdk_path}                 — extract baseline, verify
Step 4: /generate-smoke-test {language}                               — wire-level HTTP parity tests
```

### Scenario B — Fresh

```
Step 1: /generate-emitter {project} {language}    — scaffold emitter
Step 2: /generate-smoke-test {language}            — wire-level HTTP parity tests
```

Confirm with the user, then invoke the first skill.

## Step 5: Run Skills in Sequence

Invoke each skill in order using the `Skill` tool, passing `project` through. After each skill, validate:

```bash
# After /generate-emitter — design doc, entry point, and tests
ls {project}/docs/sdk-architecture/{language}.md
ls {project}/src/{language}/index.ts
cd {project} && npx vitest run test/{language}/ 2>&1 | tail -5

# After /generate-extractor — extractor registered
grep -l "{language}Extractor\|{language}_extractor" {project}/oagen.config.ts

# After /verify-compat — handled by the skill itself

# After /generate-smoke-test — script exists
ls {project}/smoke/sdk-{language}.ts
```

**For Scenario A:** After `/generate-emitter`, also verify the design doc references real SDK patterns:

```bash
grep -c "existing SDK\|from src/" {project}/docs/sdk-architecture/{language}.md
```

If a skill fails or the user wants to pause, note where they stopped. They can resume by running the remaining skills individually.

## Step 6: Final Checklist

Run the full validation suite:

```bash
cd {project} && npx vitest run    # emitter project
npx tsc --noEmit                  # oagen core type check
npx tsup                          # oagen core build
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

Next steps:
  cd {project}
  oagen generate --lang {language} --output ./sdk --spec <spec> --namespace <ns>
  oagen verify --lang {language} --output ./sdk --spec <spec>
```
