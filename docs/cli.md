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
| `--lang <language>`    | Yes      |                                | Target language — must have a registered emitter (via `oagen.config.ts`)                                                                                                                                                                     |
| `--output <dir>`       | Yes      |                                | Directory to write generated files into                                                                                                                                                                                                      |
| `--namespace <name>`   | No       | Spec's `info.title`            | SDK namespace in PascalCase — used directly for code identifiers (e.g., `WorkOS::Client`) and converted to `snake_case` for file paths (e.g., `lib/work_os/`). Use PascalCase with the exact casing you want (e.g., `WorkOS` not `work_os`). |
| `--dry-run`            | No       | `false`                        | Print the list of file paths that would be generated, without writing anything to disk                                                                                                                                                       |
| `--api-surface <path>` | No       |                                | Path to baseline API surface JSON for compat overlay                                                                                                                                                                                         |
| `--manifest <path>`    | No       | `<output>/smoke-manifest.json` | Path to smoke-manifest.json for method overlay (auto-discovered in output dir if present)                                                                                                                                                    |
| `--no-compat-check`    | No       | `false`                        | Skip compat overlay even if `--api-surface` is provided                                                                                                                                                                                      |

## `oagen diff`

Compare two OpenAPI specs and output a diff report as JSON. Use this to review what changed before regenerating.

```bash
oagen diff --old v1.yml --new v2.yml
```

| Argument       | Required | Description                 |
| -------------- | -------- | --------------------------- |
| `--old <path>` | Yes      | Path to the old/previous spec |
| `--new <path>` | Yes      | Path to the new/current spec  |

**Exit codes:** 0 = no changes, 1 = additive or modified changes, 2 = breaking changes.

## `oagen extract`

Extract the public API surface from an existing SDK. Produces a JSON file used as input for compat overlay and verification.

```bash
oagen extract --sdk-path ./existing-sdk --lang ruby --output ./sdk/sdk-ruby-surface.json
oagen extract --sdk-path ./existing-sdk --lang ruby --output my-surface.json
```

| Argument            | Required | Default                   | Description                                                                                                     |
| ------------------- | -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--sdk-path <path>` | Yes      |                           | Path to the live SDK                                                                                            |
| `--lang <language>` | Yes      |                           | Target language                                                                                                 |
| `--output <path>`   | No       | `sdk-{lang}-surface.json` | Output file path (recommend writing to your output dir, e.g. `./sdk/sdk-ruby-surface.json`, and gitignoring it) |

## `oagen verify`

Verify an already-generated SDK — run smoke tests and optional compat checks. Use after `oagen generate`.

```bash
oagen verify --lang node --output ./sdk --spec openapi.yml

# With compat check
oagen verify --lang node --output ./sdk --spec openapi.yml \
  --api-surface ./sdk/sdk-node-surface.json
```

| Argument                | Required | Default                         | Description                                                                                                   |
| ----------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--lang <language>`     | Yes      |                                 | Target language                                                                                               |
| `--output <dir>`        | Yes      |                                 | Path to the generated SDK                                                                                     |
| `--spec <path>`         | No       | `OPENAPI_SPEC_PATH` env         | Path to an OpenAPI 3.x spec file                                                                              |
| `--api-surface <path>`  | No       |                                 | Baseline API surface JSON — enables compat verification                                                       |
| `--raw-results <path>`  | No       | auto-generated                  | Path to an existing smoke baseline file to diff against                                                       |
| `--smoke-config <path>` | No       |                                 | Smoke config JSON for skip lists and service mappings                                                         |
| `--smoke-runner <path>` | No       |                                 | Custom smoke runner script (overrides built-in `sdk-test.ts`)                                                 |
| `--scope <mode>`        | No       | `spec-only` when `--spec` given | Compat scope: `full` compares all baseline symbols, `spec-only` only compares symbols derivable from the spec |
| `--diagnostics`         | No       | `false`                         | Output `verify-diagnostics.json` with structured violation breakdown                                          |
| `--max-retries <n>`     | No       | `3`                             | Max retry iterations for self-correcting overlay loop (set to 0 for single-pass)                              |

**Exit codes:**

| Code | Meaning                                                                 | Details                     |
| ---- | ----------------------------------------------------------------------- | --------------------------- |
| 0    | Clean — all checks passed                                               |                             |
| 1    | Findings — CRITICAL smoke mismatches, compat violations, or missing ops | `smoke-diff-findings.json`  |
| 2    | Compile error — SDK failed type check                                   | `smoke-compile-errors.json` |

## `oagen init`

Scaffold a new emitter project with all boilerplate files and a compilable stub emitter.

```bash
oagen init --lang ruby
oagen init --lang go --project ./my-emitter
```

| Argument            | Required | Default | Description                          |
| ------------------- | -------- | ------- | ------------------------------------ |
| `--lang <language>` | Yes      |         | Target language (e.g., `ruby`, `go`) |
| `--project <dir>`   | No       | `.`     | Directory to create the project in   |

Creates:

- `package.json` with `@workos/oagen` dependency and `sdk:generate`/`sdk:verify`/`sdk:extract` scripts
- `tsconfig.json`, `vitest.config.ts`, `tsup.config.ts` — build/test tooling
- `oagen.config.ts` — registers the stub emitter
- `src/{language}/index.ts` — stub emitter implementing the full `Emitter` interface
- `src/index.ts` — barrel export
- Empty directories: `test/`, `smoke/`, `docs/sdk-architecture/`

After initialization, `npm run typecheck` passes immediately. Implement your emitter methods in `src/{language}/` to start generating SDK code.

## `oagen parse`

Parse an OpenAPI spec and output the IR as JSON to stdout. Useful for inspecting what the parser extracts.

```bash
oagen parse --spec openapi.yml
```

| Argument        | Required | Default                 | Description                                      |
| --------------- | -------- | ----------------------- | ------------------------------------------------ |
| `--spec <path>` | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file (YAML or JSON). |

## Configuration (`oagen.config.ts`)

Place an `oagen.config.ts` (or `.js`/`.mjs`) in your project root to register emitters, extractors, and customize pipeline behavior. The CLI loads this file at startup before any command runs.

```ts
import type { OagenConfig } from "@workos/oagen";
import { nodeEmitter } from "./src/node/index.js";
import { nodeExtractor } from "./src/node/extractor.js";

const config: OagenConfig = {
  emitters: [nodeEmitter],
  extractors: [nodeExtractor],
  docUrl: "https://workos.com/docs",
};

export default config;
```

### Options

| Key                    | Type                     | Description                                                                                                                                                                                                                       |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emitters`             | `Emitter[]`              | Language emitters to register. Each emitter implements the `Emitter` interface and generates SDK files for one target language.                                                                                                   |
| `extractors`           | `Extractor[]`            | API surface extractors to register. Each extractor parses a live SDK and produces an `ApiSurface` JSON used for compat verification.                                                                                              |
| `emitterProject`       | `string`                 | Path to the emitter project directory. Used by skills to scaffold new emitters, tests, and smoke runners in the correct location.                                                                                                 |
| `smokeRunners`         | `Record<string, string>` | Map from language key to custom smoke runner script path. Overrides the built-in `sdk-test.ts` for `oagen verify`. Can also be set per-invocation with `--smoke-runner`.                                                          |
| `operationIdTransform` | `(id: string) => string` | Custom transform for operation IDs. Receives the raw `operationId` from the spec; return the desired operation name. No additional casing conversion is applied. When omitted, `operationId` values are converted to `camelCase`. |
| `docUrl`               | `string`                 | Base URL for documentation links. When set, relative markdown paths in descriptions (e.g. `[User](/reference/authkit/user)`) are expanded to full URLs (e.g. `[User](https://workos.com/docs/reference/authkit/user)`).           |
