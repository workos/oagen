# oagen

Generate SDKs from OpenAPI 3.x specifications.

`oagen` parses an OpenAPI spec into a language-agnostic intermediate representation (IR), then generates idiomatic SDK code for a target language.

## Install

```bash
npm install
npm run build
```

## Commands

### `oagen parse`

Parse an OpenAPI spec and output the intermediate representation (IR) as JSON to stdout. Useful for inspecting what the parser extracts.

```bash
oagen parse --spec path/to/openapi.yml
```

| Argument        | Required | Description                                     |
| --------------- | -------- | ----------------------------------------------- |
| `--spec <path>` | Yes      | Path to an OpenAPI 3.1 spec file (YAML or JSON) |

### `oagen generate`

Generate SDK code from an OpenAPI spec.

```bash
oagen generate --spec openapi.yml --lang ruby --output ./sdk --namespace WorkOS
```

| Argument             | Required | Default             | Description                                                                                                                                                                                                                                  |
| -------------------- | -------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--spec <path>`      | Yes      |                     | Path to an OpenAPI 3.1 spec file                                                                                                                                                                                                             |
| `--lang <language>`  | Yes      |                     | Target language emitter (e.g., `ruby`)                                                                                                                                                                                                       |
| `--output <dir>`     | Yes      |                     | Directory to write generated files into                                                                                                                                                                                                      |
| `--namespace <name>` | No       | Spec's `info.title` | SDK namespace in PascalCase — used directly for code identifiers (e.g., `WorkOS::Client`) and converted to `snake_case` for file paths (e.g., `lib/work_os/`). Use PascalCase with the exact casing you want (e.g., `WorkOS` not `work_os`). |
| `--dry-run`          | No       | `false`             | Print the list of file paths that would be generated, without writing anything to disk                                                                                                                                                       |

**How `--namespace` flows through the generated SDK:**

Given `--namespace WorkOS`:

- Module/class names use it as-is: `module WorkOS; module Models; class Organization`
- Type references use it as-is: `WorkOS::Models::Organization`
- File paths are derived as snake_case: `lib/work_os/models/organization.rb`
- Test paths are derived as snake_case: `test/work_os/resources/organizations_test.rb`

If omitted, the namespace is derived from the spec's `info.title` field (e.g., a spec titled `"Petstore"` produces namespace `Petstore` / `petstore`).

### `oagen diff`

Incrementally generate from spec changes.

```bash
oagen diff --old old-spec.yml --new new-spec.yml --lang ruby --output ./sdk
```

| Argument            | Required | Description                                             |
| ------------------- | -------- | ------------------------------------------------------- |
| `--old <path>`      | Yes      | Path to the old/previous spec                           |
| `--new <path>`      | Yes      | Path to the new/current spec                            |
| `--lang <language>` | No       | Target language (required unless `--report`)            |
| `--output <dir>`    | No       | Output directory for regenerated files                  |
| `--report`          | No       | Output a diff report as JSON instead of generating code |
| `--force`           | No       | Allow file deletions without confirmation               |

## Development

```bash
npm test            # run tests
npm run test:watch  # run tests in watch mode
npm run typecheck   # type check without emitting
npm run build       # build CLI binary
```

## Architecture

```
src/
├── ir/types.ts              # IR type definitions (ApiSpec, Service, Operation, Model, etc.)
├── parser/
│   ├── parse.ts             # Orchestrator: spec file → IR
│   ├── refs.ts              # Load and bundle spec via @redocly/openapi-core
│   ├── schemas.ts           # Extract schemas → Models and Enums
│   ├── operations.ts        # Extract paths → Services and Operations
│   └── pagination.ts        # Detect cursor-based pagination patterns
├── engine/
│   ├── types.ts             # Emitter interface, EmitterContext, GeneratedFile
│   ├── orchestrator.ts      # Pipeline: IR → emitter → files (with header + dry-run)
│   ├── writer.ts            # Write GeneratedFile[] to disk
│   └── registry.ts          # Register and look up language emitters
├── emitters/
│   └── ruby/                # Ruby language emitter
│       ├── index.ts         # Emitter entry point (implements Emitter interface)
│       ├── type-map.ts      # IR TypeRef → Ruby/RBS/Sorbet type strings
│       ├── naming.ts        # Ruby naming conventions (PascalCase, snake_case)
│       ├── yard.ts          # IR TypeRef → YARD documentation type strings
│       ├── models.ts        # IR Model → BaseModel classes with YARD docs
│       ├── enums.ts         # IR Enum → module with extend Enum, symbol values
│       ├── resources.ts     # IR Service → resource classes (keyword-style request)
│       ├── client.ts        # HTTP client with retry, keyword args, model/page deserialization
│       ├── errors.ts        # Error class hierarchy
│       ├── config.ts        # Configuration module
│       ├── types-rbs.ts     # RBS type signatures
│       ├── types-rbi.ts     # Sorbet RBI signatures
│       ├── tests.ts         # Minitest + WebMock test generation
│       └── fixtures.ts      # JSON test fixture generation
├── utils/naming.ts          # Naming convention converters (PascalCase, camelCase, snake_case, etc.)
└── cli/
    ├── index.ts             # CLI entry point (commander)
    ├── parse.ts             # `oagen parse` command
    ├── generate.ts          # `oagen generate` command
    └── diff.ts              # `oagen diff` stub
```

### Pipeline

1. **Parse**: OpenAPI spec → IR (`ApiSpec` with services, models, enums)
2. **Emit**: IR → `GeneratedFile[]` via language-specific emitter
3. **Write**: Files to disk with auto-generated headers

### IR

The IR is the central contract between the parser and all language emitters. It uses plain interfaces (no classes) with a discriminated union type system (`TypeRef`) that supports primitives, arrays, model references, enum references, unions, and nullable types.

### Parser

Uses `@redocly/openapi-core` to resolve all `$ref`s, then extracts models, enums, services, and operations. It infers operation names from HTTP method + path pattern (e.g., `GET /users` → `list`, `GET /users/{id}` → `retrieve`) and detects cursor-based pagination.

### Emitters

Each language target implements the `Emitter` interface (9 generator methods + `fileHeader`). The Ruby emitter is the reference implementation. New emitters can be scaffolded using the `/generate-emitter` skill.

## Adding a new language emitter

The quickest way is to use the skill directly:

```
/generate-emitter python
```

### How the documentation fits together

Two files drive new emitter creation:

```
.claude/skills/generate-emitter/SKILL.md    (AI procedural skill — the orchestrator)
        │
        │  Step 0 produces
        ▼
docs/sdk-designs/{language}.md              (language-specific design spec — single source of truth)
        │
        │  Steps 1–8 implement
        ▼
src/emitters/{language}/                    (emitter source code)
```

**`SKILL.md`** is the step-by-step procedure the AI follows. It proposes tooling choices, confirms them with the user, creates a language design doc, then scaffolds and implements the emitter. It is language-agnostic — it describes _what_ each generator must do without prescribing _how_ any particular language does it.

**`{language}.md`** (e.g., `ruby.md`) is the language-specific design spec produced by running the skill. It is the **single source of truth** for that emitter — idiomatic patterns, type mappings, code examples, structural guidelines (tooling choices), and directory structure all live here. The Ruby design doc also serves as the structural template — new language docs should have the same sections.

### The process

1. **Confirm tooling** — The skill proposes sensible defaults for the target language (test framework, HTTP mocking, documentation format, HTTP client, etc.). You confirm or override each category.

2. **Create design doc** — A `docs/sdk-designs/{language}.md` file is written with everything the emitter needs: confirmed tooling choices, idiomatic patterns (models, enums, resources, client, errors), type mappings, test patterns, and directory layout.

3. **Scaffold emitter** — Generator files are created under `src/emitters/{language}/`: type mapping, naming conventions, models, enums, resources, client, errors, config, type signatures, tests, and fixtures.

4. **Implement** — Each generator receives IR nodes and returns `GeneratedFile[]` (path + content pairs). The design doc is the source of truth for what the output should look like.

5. **Register** — The emitter is added to `src/cli/generate.ts`.

6. **Test** — Tests go under `test/emitters/{language}/`. Type check, test suite, build, smoke test against the Petstore fixture, and determinism check (generating twice produces identical output).

### Key files for reference

| File                       | What it is                                                                  |
| -------------------------- | --------------------------------------------------------------------------- |
| `src/engine/types.ts`      | The `Emitter` interface contract (9 methods + `fileHeader`)                 |
| `src/ir/types.ts`          | The IR type system (`ApiSpec`, `Model`, `Enum`, `Service`, `TypeRef`, etc.) |
| `src/emitters/ruby/`       | Reference emitter implementation                                            |
| `docs/sdk-designs/ruby.md` | Reference design doc (also the structural template for new languages)       |
