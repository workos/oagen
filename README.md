# oagen

Generate SDKs from an OpenAPI 3.x specification.

`oagen` parses an OpenAPI spec into a language-agnostic intermediate representation (IR), then emits SDK code for a target language. Emitters are plugins — you bring your own for whatever language you need, and register them via `oagen.config.ts`.

## Quickstart

```bash
npm install @workos/oagen
```

Generate an SDK:

```bash
oagen generate --spec openapi.yml --lang ruby --output ./sdk --namespace MyService
```

When a new spec version arrives, diff and regenerate:

```bash
oagen diff --old v1.yml --new v2.yml --report          # review what changed
oagen diff --old v1.yml --new v2.yml --lang ruby --output ./sdk  # regenerate affected files
oagen verify --spec v2.yml --lang ruby --output ./sdk   # smoke test the result
```

## Configuration

Projects can register custom emitters, extractors, and smoke runners via an `oagen.config.ts` (or `.js`, `.mjs`) in the project root. The config is loaded at CLI startup before any command runs.

```ts
// oagen.config.ts
import { myGoEmitter } from "./emitters/go/index.js";
import { myGoExtractor } from "./extractors/go/index.js";

export default {
  emitters: [myGoEmitter], // additional Emitter[]
  extractors: [myGoExtractor], // additional Extractor[]
  smokeRunners: {
    // per-language smoke runner paths
    go: "./smoke/go-runner.ts",
  },
};
```

| Field            | Type                     | Description                                                                   |
| ---------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `emitters`       | `Emitter[]`              | Custom emitters to register (supplement or override built-ins)                |
| `extractors`     | `Extractor[]`            | Custom extractors to register for compat verification                         |
| `smokeRunners`   | `Record<string, string>` | Map from language key to custom smoke test runner path                        |
| `emitterProject` | `string`                 | Path to emitter project (used by skills to scaffold into the right directory) |

oagen ships with no built-in emitters. All emitters are loaded from config.

## Using as a library

The programmatic API is available via the package entry point:

```ts
import {
  parseSpec,
  generate,
  registerEmitter,
  getEmitter,
  registerExtractor,
  diffSpecs,
  generateIncremental,
  buildOverlayLookup,
  patchOverlay,
  diffSurfaces,
  toSnakeCase,
  toCamelCase,
  toPascalCase,
} from "@workos/oagen";

// Parse a spec
const ir = await parseSpec("openapi.yml");

// Register and use a custom emitter
registerEmitter(myEmitter);
const files = await generate(ir, myEmitter, {
  namespace: "MyService",
  outputDir: "./sdk",
});
```

Type exports for `ApiSpec`, `Emitter`, `EmitterContext`, `GeneratedFile`, `ApiSurface`, `OverlayLookup`, and all compat types are also available from `'@workos/oagen'`.

## Commands

### `oagen generate`

Generate SDK code from an OpenAPI spec.

```bash
oagen generate --spec openapi.yml --lang node --output ./sdk --namespace WorkOS
```

| Argument               | Required | Default                 | Description                                                                                                                                                                                                                                  |
| ---------------------- | -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--spec <path>`        | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file.                                                                                                                                                                                                            |
| `--lang <language>`    | Yes      |                         | Target language emitter (e.g., `node`)                                                                                                                                                                                                       |
| `--output <dir>`       | Yes      |                         | Directory to write generated files into                                                                                                                                                                                                      |
| `--namespace <name>`   | No       | Spec's `info.title`     | SDK namespace in PascalCase — used directly for code identifiers (e.g., `WorkOS::Client`) and converted to `snake_case` for file paths (e.g., `lib/work_os/`). Use PascalCase with the exact casing you want (e.g., `WorkOS` not `work_os`). |
| `--dry-run`            | No       | `false`                 | Print the list of file paths that would be generated, without writing anything to disk                                                                                                                                                       |
| `--api-surface <path>` | No       |                         | Path to baseline API surface JSON for compat overlay                                                                                                                                                                                         |

### `oagen diff`

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

### `oagen verify`

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

### `oagen parse`

Parse an OpenAPI spec and output the IR as JSON to stdout. Useful for inspecting what the parser extracts.

```bash
oagen parse --spec openapi.yml
```

| Argument        | Required | Default                 | Description                                      |
| --------------- | -------- | ----------------------- | ------------------------------------------------ |
| `--spec <path>` | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file (YAML or JSON). |

## Adding a new language

There are two scenarios depending on whether you need to preserve an existing SDK's public API:

- **Scenario A** (existing SDK): Scaffold an emitter, build an extractor, extract the live SDK's API surface, generate with compat overlay, verify
- **Scenario B** (fresh): Scaffold an emitter, generate, verify

Both follow the same shape: scaffold, generate, verify, test. See [Workflows](docs/architecture/workflows.md) for the full step-by-step walkthrough, including the compat overlay loop and emitter-fixing loop.

## Claude Code Plugin

oagen ships as a [Claude Code plugin](https://code.claude.com/docs/en/plugins.md) with skills that automate emitter scaffolding, compat verification, smoke testing, and end-to-end language setup.

### Using the plugin

From your emitter project (where `@workos/oagen` is installed as a dependency):

```bash
claude --plugin-dir node_modules/@workos/oagen
```

This makes the following skills available:

| Skill                               | Description                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `/oagen:add-language <lang>`        | End-to-end orchestrator — determines scenario and sequences the skills below |
| `/oagen:generate-emitter <lang>`    | Scaffold a new language emitter                                              |
| `/oagen:generate-extractor <lang>`  | Scaffold an API surface extractor for compat verification                    |
| `/oagen:generate-smoke-test <lang>` | Create smoke tests for a generated SDK                                       |
| `/oagen:verify-compat <lang>`       | Verify emitter output preserves backwards compatibility                      |

### Local development

If you're working in the oagen repo itself, the skills are also available directly:

```bash
claude --plugin-dir .
```

## Development

```bash
npm install
npm run build           # build CLI binary
npm test                # run tests
npm run typecheck       # type check
npm run lint:structure  # verify dependency layers
```
