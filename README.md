# oagen

Generate SDKs from OpenAPI 3.x specifications.

`oagen` parses an OpenAPI spec into a language-agnostic intermediate representation (IR), then generates idiomatic SDK code for a target language.

## Install

```bash
npm install
npm run build
```

## Usage

### Parse a spec to IR

```bash
oagen parse --spec path/to/openapi.yml
```

Outputs the IR as JSON to stdout. Useful for inspecting what the parser extracts.

### Generate SDK code

```bash
oagen generate --spec openapi.yml --lang ruby --output ./sdk
```

### Diff two specs

```bash
oagen diff --old old-spec.yml --new new-spec.yml --lang ruby --output ./sdk
```

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
├── ir/types.ts          # IR type definitions (ApiSpec, Service, Operation, Model, etc.)
├── parser/
│   ├── parse.ts         # Orchestrator: spec file → IR
│   ├── refs.ts          # Load and bundle spec via @redocly/openapi-core
│   ├── schemas.ts       # Extract schemas → Models and Enums
│   ├── operations.ts    # Extract paths → Services and Operations
│   └── pagination.ts    # Detect cursor-based pagination patterns
├── utils/naming.ts      # Naming convention converters (PascalCase, camelCase, snake_case, etc.)
└── cli/
    ├── index.ts         # CLI entry point (commander)
    ├── parse.ts         # `oagen parse` command
    ├── generate.ts      # `oagen generate` stub
    └── diff.ts          # `oagen diff` stub
```

The **IR** is the central contract between the parser and all language emitters. It uses plain interfaces (no classes) with a discriminated union type system (`TypeRef`) that supports primitives, arrays, model references, enum references, unions, and nullable types.

The **parser** uses `@redocly/openapi-core` to resolve all `$ref`s, then extracts models, enums, services, and operations. It infers operation names from HTTP method + path pattern (e.g., `GET /users` → `list`, `GET /users/{id}` → `retrieve`) and detects cursor-based pagination.
