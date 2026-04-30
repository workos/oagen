# CLI Reference

All commands support `--help` for full usage details.

## `oagen generate`

Generate SDK code from an OpenAPI spec.

```bash
oagen generate --spec openapi.yml --lang node --output ./sdk --namespace WorkOS
```

| Argument               | Required | Default                 | Description                                                                                                                                                                                                                                  |
| ---------------------- | -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--spec <path>`        | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file.                                                                                                                                                                                                            |
| `--lang <language>`    | Yes      |                         | Target language — must have a registered emitter (via `oagen.config.ts`)                                                                                                                                                                     |
| `--output <dir>`       | Yes      |                         | Directory to write generated files into                                                                                                                                                                                                      |
| `--namespace <name>`   | No       | Spec's `info.title`     | SDK namespace in PascalCase — used directly for code identifiers (e.g., `WorkOS::Client`) and converted to `snake_case` for file paths (e.g., `lib/work_os/`). Use PascalCase with the exact casing you want (e.g., `WorkOS` not `work_os`). |
| `--dry-run`            | No       | `false`                 | Print the list of file paths that would be generated, without writing anything to disk                                                                                                                                                       |
| `--api-surface <path>` | No       |                         | Path to baseline API surface JSON for compat overlay                                                                                                                                                                                         |
| `--target <dir>`       | No       |                         | Target directory for live SDK integration — generated files are merged into this directory instead of `--output`                                                                                                                             |
| `--no-compat-check`    | No       | `false`                 | Skip compat overlay even if `--api-surface` is provided                                                                                                                                                                                      |

## `oagen diff`

Compare two OpenAPI specs and output a diff report as JSON. Use this to review what changed before regenerating.

```bash
oagen diff --old v1.yml --new v2.yml
```

| Argument       | Required | Description                   |
| -------------- | -------- | ----------------------------- |
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

## `oagen compat-extract`

Extract a compat snapshot from a live SDK and write it to a JSON file. The snapshot is a machine-readable record of the SDK's public API surface, used as input to `compat-diff`.

```bash
oagen compat-extract --sdk-path ./existing-sdk --lang node --output .
oagen compat-extract --sdk-path ./existing-sdk --lang php --output ./sdk --spec openapi.yml
```

| Argument            | Required | Default                 | Description                                                                        |
| ------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `--sdk-path <path>` | Yes      |                         | Path to the live SDK                                                               |
| `--lang <language>` | Yes      |                         | Target language                                                                    |
| `--output <dir>`    | Yes      |                         | Directory to write `.oagen-compat-snapshot.json` into                              |
| `--spec <path>`     | No       | `OPENAPI_SPEC_PATH` env | Path to OpenAPI spec — enriches symbols with `operationId`, `route`, and `specSha` |

Always writes `.oagen-compat-snapshot.json` in the specified directory. The snapshot file is meant to be committed to the repository and updated on each release.

When `--spec` is provided, the command parses the spec and enriches callable symbols with `operationId` and `route` (HTTP method + path) by matching against spec operations. It also computes a SHA-256 of the spec file and stores it as `source.specSha` in the snapshot.

## `oagen compat-diff`

Diff two compat snapshot files and produce a classified change report. No extraction or spec required — pure file-in, report-out.

```bash
# Basic diff with terminal output
oagen compat-diff --baseline .oagen-compat-snapshot.json --candidate /tmp/candidate.json

# With machine-readable report and failure threshold
oagen compat-diff \
  --baseline .oagen-compat-snapshot.json \
  --candidate /tmp/candidate.json \
  --output compat-report.json \
  --fail-on breaking
```

| Argument             | Required | Default    | Description                                        |
| -------------------- | -------- | ---------- | -------------------------------------------------- |
| `--baseline <path>`  | Yes      |            | Path to the baseline compat snapshot JSON          |
| `--candidate <path>` | Yes      |            | Path to the candidate compat snapshot JSON         |
| `--output <path>`    | No       |            | Write machine-readable JSON report to this path    |
| `--fail-on <level>`  | No       | `breaking` | Fail threshold: `none`, `breaking`, or `soft-risk` |
| `--explain`          | No       | `false`    | Include provenance explanations in terminal output |

**Exit codes:** 0 = no changes exceed threshold, 1 = changes exceed threshold.

## `oagen compat-summary`

Format a compat report as a markdown PR comment. Reads the JSON report produced by `compat-diff --output` and outputs markdown to stdout or a file.

```bash
# Single language
oagen compat-summary --report compat-report.json | gh pr comment --body-file -

# Cross-language rollup (multiple reports)
oagen compat-summary --report php.json --report python.json --report go.json

# Write to a file
oagen compat-summary --report compat-report.json --output summary.md
```

| Argument             | Required | Default | Description                                                                |
| -------------------- | -------- | ------- | -------------------------------------------------------------------------- |
| `--report <path...>` | Yes      |         | Path(s) to compat report JSON(s) — pass multiple for cross-language rollup |
| `--output <path>`    | No       | stdout  | Write markdown to this file instead of stdout                              |

**Single report** output includes:

- Status header (pass/warning/fail)
- Summary table with breaking, soft-risk, and additive counts
- Breaking changes table (always visible)
- Soft-risk and additive changes in collapsible `<details>` sections

**Multiple reports** produce a cross-language rollup:

- Per-language summary table (breaking/soft-risk/additive per language)
- Conceptual changes table showing per-language severity for each change
- Same conceptual change across languages is shown as one row, not N separate rows

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
- `oagen.config.ts` — minimal config for local development, imports the plugin bundle
- `src/plugin.ts` — plugin bundle export registering the stub emitter
- `src/{language}/index.ts` — stub emitter implementing the full `Emitter` interface
- `src/index.ts` — barrel export including the plugin bundle
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

## `oagen resolve`

Resolve operation names from the spec using the algorithm and optional hints. Outputs a review table (markdown) or JSON for programmatic use.

```bash
# Markdown review table (default)
oagen resolve --spec openapi.yml

# JSON output for CI/scripting
oagen resolve --spec openapi.yml --format json
```

| Argument            | Required | Default                 | Description                                      |
| ------------------- | -------- | ----------------------- | ------------------------------------------------ |
| `--spec <path>`     | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file (YAML or JSON). |
| `--format <format>` | No       | `table`                 | Output format: `table` (markdown) or `json`.     |

When `oagen.config.ts` defines `operationHints` and/or `mountRules`, they are applied automatically. The table format flags operations that have no hint and are resolved purely by algorithm.

## `--config <path>`

All commands accept a global `--config <path>` option to load a specific config file instead of the default cwd-based discovery.

```bash
# Explicit config
oagen generate --config ../openapi-spec/oagen.config.ts --spec openapi.yml --lang node --output ./sdk

# Default: searches for oagen.config.ts in the current directory
oagen generate --spec openapi.yml --lang node --output ./sdk
```

When `--config` is omitted, the CLI searches the current working directory for `oagen.config.ts`, `oagen.config.js`, or `oagen.config.mjs` in that order.

## Configuration (`oagen.config.ts`)

Place an `oagen.config.ts` (or `.js`/`.mjs`) in the project that drives generation. The CLI loads this file at startup before any command runs.

The config file belongs to the **consumer project** (the project that owns spec interpretation policy), not the emitter library. Emitter packages export plugin bundles that the consumer config composes.

### Consumer config (recommended)

```ts
import type { OagenConfig } from "@workos/oagen";
import { workosEmittersPlugin } from "@workos/oagen-emitters";

const config: OagenConfig = {
  ...workosEmittersPlugin,
  docUrl: "https://workos.com/docs",
  operationIdTransform: (id) => id.replace(/Controller_/, ""),
  operationHints,
  mountRules,
};

export default config;
```

### Standalone emitter config

For standalone emitter projects that also serve as the consumer:

```ts
import type { OagenConfig } from "@workos/oagen";
import { nodeEmitter } from "./src/node/index.js";

const config: OagenConfig = {
  emitters: [nodeEmitter],
};

export default config;
```

### Composing multiple plugin bundles

```ts
import type { OagenConfig } from "@workos/oagen";
import { workosEmittersPlugin } from "@workos/oagen-emitters";
import { experimentalPlugin } from "@workos/oagen-experimental";

const config: OagenConfig = {
  emitters: [
    ...(workosEmittersPlugin.emitters ?? []),
    ...(experimentalPlugin.emitters ?? []),
  ],
  extractors: [
    ...(workosEmittersPlugin.extractors ?? []),
    ...(experimentalPlugin.extractors ?? []),
  ],
  smokeRunners: {
    ...(workosEmittersPlugin.smokeRunners ?? {}),
    ...(experimentalPlugin.smokeRunners ?? {}),
  },
  operationHints,
  mountRules,
};

export default config;
```

### Options

| Key                    | Type                                         | Description                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emitters`             | `Emitter[]`                                  | Language emitters to register. Each emitter implements the `Emitter` interface and generates SDK files for one target language.                                                                                                                                                                                               |
| `extractors`           | `Extractor[]`                                | API surface extractors to register. Each extractor parses a live SDK and produces an `ApiSurface` JSON used for compat verification.                                                                                                                                                                                          |
| `emitterProject`       | `string`                                     | Path to the emitter project directory. Used by skills to scaffold new emitters, tests, and smoke runners in the correct location.                                                                                                                                                                                             |
| `smokeRunners`         | `Record<string, string>`                     | Map from language key to custom smoke runner script path. Overrides the built-in `sdk-test.ts` for `oagen verify`. Can also be set per-invocation with `--smoke-runner`.                                                                                                                                                      |
| `operationIdTransform` | `(id: string) => string`                     | Custom transform for operation IDs. Receives the raw `operationId` from the spec; return the desired operation name. No additional casing conversion is applied. When omitted, `operationId` values are converted to `camelCase`.                                                                                             |
| `schemaNameTransform`  | `(name: string) => string`                   | Custom transform for schema (model/enum) names. Applied after the built-in `cleanSchemaName` normalization. Receives the cleaned PascalCase name; return the desired name.                                                                                                                                                    |
| `transformSpec`        | `(spec: OpenApiDocument) => OpenApiDocument` | Pre-IR overlay applied to the bundled OpenAPI document before any IR extraction. Use to patch around upstream spec quirks that would otherwise emit a breaking SDK change. See [`transformSpec` — Pre-IR Spec Overlay](advanced/transform-spec.md).                                                                           |
| `docUrl`               | `string`                                     | Base URL for documentation links. When set, relative markdown paths in descriptions (e.g. `[User](/reference/authkit/user)`) are expanded to full URLs (e.g. `[User](https://workos.com/docs/reference/authkit/user)`).                                                                                                       |
| `operationHints`       | `Record<string, OperationHint>`              | Per-operation overrides keyed by `"METHOD /path"`. Override derived method names, remount to a different service, or split union-body operations into typed wrappers. See [Operation Resolution](architecture/ir-types.md#operation-resolution).                                                                              |
| `mountRules`           | `Record<string, string>`                     | Service-level remounting. Maps IR service name to target service/namespace (PascalCase). All operations in the source service are mounted on the target unless overridden per-operation in `operationHints`.                                                                                                                  |
| `modelHints`           | `Record<string, string>`                     | Pin specific models to a specific IR service for placement. Maps IR model name (post-`cleanSchemaName`/`schemaNameTransform`) → IR service name (PascalCase). Overrides the default "first service to reference the model wins" assignment. Both names must exist in the parsed spec; unknown names throw at generation time. |
