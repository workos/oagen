# CLI Reference

All commands support `--help` for full usage details.

## `oagen generate`

Generate SDK code from an OpenAPI spec.

```bash
oagen generate --spec openapi.yml --lang node --output ./sdk --namespace WorkOS
```

| Argument               | Required | Default                        | Description                                                                                                                                                                                                                                  |
| ---------------------- | -------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--spec <path>`        | No       | `OPENAPI_SPEC_PATH` env        | Path to an OpenAPI 3.x spec file.                                                                                                                                                                                                            |
| `--lang <language>`    | Yes      |                                | Target language emitter (e.g., `node`)                                                                                                                                                                                                       |
| `--output <dir>`       | Yes      |                                | Directory to write generated files into                                                                                                                                                                                                      |
| `--namespace <name>`   | No       | Spec's `info.title`            | SDK namespace in PascalCase — used directly for code identifiers (e.g., `WorkOS::Client`) and converted to `snake_case` for file paths (e.g., `lib/work_os/`). Use PascalCase with the exact casing you want (e.g., `WorkOS` not `work_os`). |
| `--dry-run`            | No       | `false`                        | Print the list of file paths that would be generated, without writing anything to disk                                                                                                                                                       |
| `--api-surface <path>` | No       |                                | Path to baseline API surface JSON for compat overlay                                                                                                                                                                                         |
| `--manifest <path>`    | No       | `<output>/smoke-manifest.json` | Path to smoke-manifest.json for method overlay (auto-discovered in output dir if present)                                                                                                                                                    |
| `--no-compat-check`    | No       | `false`                        | Skip compat overlay even if `--api-surface` is provided                                                                                                                                                                                      |

## `oagen diff`

Review or apply spec changes. Use `--report` to see what changed, or pass `--lang` and `--output` to incrementally regenerate affected files.

```bash
oagen diff --old v1.yml --new v2.yml --report           # review changes
oagen diff --old v1.yml --new v2.yml --lang node --output ./sdk  # regenerate
```

| Argument               | Required | Description                                             |
| ---------------------- | -------- | ------------------------------------------------------- |
| `--old <path>`         | Yes      | Path to the old/previous spec                           |
| `--new <path>`         | Yes      | Path to the new/current spec                            |
| `--lang <language>`    | No       | Target language (required unless `--report`)            |
| `--output <dir>`       | No       | Output directory for regenerated files                  |
| `--report`             | No       | Output a diff report as JSON instead of generating code |
| `--force`              | No       | Allow file deletions without confirmation               |
| `--api-surface <path>` | No       | Path to baseline API surface JSON for compat overlay    |
| `--manifest <path>`    | No       | Path to smoke-manifest.json for method overlay          |

## `oagen extract`

Extract the public API surface from an existing SDK. Produces a JSON file used as input for compat overlay and verification.

```bash
oagen extract --sdk-path ./existing-sdk --lang ruby
oagen extract --sdk-path ./existing-sdk --lang ruby --output my-surface.json
```

| Argument            | Required | Default            | Description          |
| ------------------- | -------- | ------------------ | -------------------- |
| `--sdk-path <path>` | Yes      |                    | Path to the live SDK |
| `--lang <language>` | Yes      |                    | Target language      |
| `--output <path>`   | No       | `api-surface.json` | Output file path     |

## `oagen verify`

Verify an already-generated SDK — run smoke tests and optional compat checks. Use after `oagen generate` or `oagen diff`.

```bash
oagen verify --lang node --output ./sdk --spec openapi.yml

# With compat check
oagen verify --lang node --output ./sdk --spec openapi.yml \
  --api-surface api-surface.json
```

| Argument                | Required | Default                 | Description                                                   |
| ----------------------- | -------- | ----------------------- | ------------------------------------------------------------- |
| `--lang <language>`     | Yes      |                         | Target language                                               |
| `--output <dir>`        | Yes      |                         | Path to the generated SDK                                     |
| `--spec <path>`         | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file                              |
| `--api-surface <path>`  | No       |                         | Baseline API surface JSON — enables compat verification       |
| `--raw-results <path>`  | No       | auto-generated          | Path to an existing smoke baseline file to diff against       |
| `--smoke-config <path>` | No       |                         | Smoke config JSON for skip lists and service mappings         |
| `--smoke-runner <path>` | No       |                         | Custom smoke runner script (overrides built-in `sdk-test.ts`) |

**Exit codes:**

| Code | Meaning                                                                 | Details                     |
| ---- | ----------------------------------------------------------------------- | --------------------------- |
| 0    | Clean — all checks passed                                               |                             |
| 1    | Findings — CRITICAL smoke mismatches, compat violations, or missing ops | `smoke-diff-findings.json`  |
| 2    | Compile error — SDK failed type check                                   | `smoke-compile-errors.json` |

## `oagen parse`

Parse an OpenAPI spec and output the IR as JSON to stdout. Useful for inspecting what the parser extracts.

```bash
oagen parse --spec openapi.yml
```

| Argument        | Required | Default                 | Description                                      |
| --------------- | -------- | ----------------------- | ------------------------------------------------ |
| `--spec <path>` | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file (YAML or JSON). |
