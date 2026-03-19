# Reference Emitter

A minimal but working TypeScript emitter for oagen, demonstrating the Emitter interface against a GitHub-flavored fixture spec.

## What it covers

- `generateModels` — TypeScript interfaces from IR models
- `generateEnums` — string literal unions from IR enums
- `generateResources` — resource classes using `planOperation`
- `generateClient` — top-level client with resource accessors
- `generateErrors` — error class hierarchy
- `generateConfig` — config types and base resource class
- Type mapping via `mapTypeRef`

## What it does NOT cover

Production emitters typically also handle:

- Overlay resolution for compat-aware naming
- Merge modes for incremental generation
- HTTP client implementation (fetch, axios, etc.)
- Pagination iterators
- Request/response serialization

## Usage

From the oagen root:

```bash
npx vitest run test/examples/reference-emitter/
```

Or to generate output manually:

```bash
npx tsx src/cli/index.ts generate \
  --lang typescript \
  --spec examples/reference-emitter/spec/github-subset.yml \
  --namespace GitHub \
  --output /tmp/github-sdk
```
