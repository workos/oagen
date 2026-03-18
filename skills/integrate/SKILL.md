---
name: integrate
description: Integrate generated SDK code into a live SDK by running `oagen generate --target`. Required for every Scenario A generation cycle — initial setup and ongoing spec updates. Use when the user wants to merge generated code into an existing SDK or integrate emitter output into a live codebase.
---

# /integrate

## Purpose

Integrate generated SDK code into a live SDK by running `oagen generate --target`. This runs every time code is generated for a live SDK, not just once — both during initial setup and on every subsequent spec update. The writer's additive merge makes it safe to run on every regeneration.

## Reference Docs

- [Pipeline Architecture](../../docs/architecture/pipeline.md) — how the writer's additive merge works
- [Workflows](../../docs/architecture/workflows.md) — where `/integrate` fits in the overall workflow
- [Emitter Contract](../../docs/architecture/emitter-contract.md) — overlay integration and `skipIfExists`

## Prerequisites

Before integration:

1. **Verify-compat must have passed** — check for an existing API surface file (`sdk-{language}-surface.json` in the emitter project). If missing, suggest running `/verify-compat` first.
2. **The emitter should use `fileBySymbol` hints** for correct file placement — this ensures generated files land at the paths the live SDK expects.

## Step 1: Resolve Paths

Determine required paths:

- **Language**: from argument, or use `AskUserQuestion`
- **Live SDK path** (`sdk_path`): from argument, or use `AskUserQuestion`: "Where is the live SDK? (absolute or relative path)"
- **OpenAPI spec** (`spec`): from argument, `OPENAPI_SPEC_PATH` env var, or use `AskUserQuestion`
- **Emitter project** (`project`): from argument, or detect from current directory
- **Output directory** (`output`): use a temp directory or the emitter project's `sdk/` directory
- **API surface** (`api_surface`): `sdk-{language}-surface.json` in the emitter project
- **Manifest** (`manifest`): `smoke-manifest.json` in the output directory (if it exists)

## Step 2: Dry-Run Preview

Run `oagen generate` with `--dry-run` and `--target` to show what will happen:

```bash
npx tsx src/cli/index.ts generate \
  --spec {spec} \
  --lang {language} \
  --output {output} \
  --target {sdk_path} \
  --namespace {namespace} \
  --api-surface {api_surface} \
  --manifest {manifest} \
  --dry-run
```

Present the output to the user. The dry-run shows:

- Files that would be written to the output directory
- Files that would be written/merged/skipped in the target directory

## Step 3: Confirm and Execute

Use `AskUserQuestion` to confirm:

> "The above files will be written to `{output}` and integrated into `{sdk_path}`. Proceed?"

On confirmation, run without `--dry-run`:

```bash
npx tsx src/cli/index.ts generate \
  --spec {spec} \
  --lang {language} \
  --output {output} \
  --target {sdk_path} \
  --namespace {namespace} \
  --api-surface {api_surface} \
  --manifest {manifest}
```

## Step 4: Post-Integration Verification

Suggest running the live SDK's test suite:

```bash
cd {sdk_path} && npm test  # or equivalent for the target language
```

If tests fail, the merger's additive-only guarantees mean hand-written code was not modified — failures are likely from new symbols that need wiring up or import updates.

## Step 5: Summary

Report what happened:

```
=== Integration Complete ===
Target: {sdk_path}
New files created: {N}
Existing files merged: {N}
Files skipped: {N}

Next steps:
  - Review changes: cd {sdk_path} && git diff
  - Run tests: cd {sdk_path} && npm test
  - If needed, re-run /integrate after fixing issues
```

## Output

- Generated files written to `{output}` directory
- Files merged into the live SDK at `{sdk_path}` via the writer's additive merge
- Summary report showing new files created, existing files merged, and files skipped
