# Dependency Layers

## Layer Hierarchy (one-way imports only)

```
Layer 0: ir/types        ← Pure type definitions, no imports from other layers
Layer 1: utils           ← Only imports from Layer 0 (naming, tree-sitter helpers)
Layer 2: parser          ← Imports from Layers 0-1
Layer 3: engine, differ  ← Imports from Layers 0-1
Layer 3: compat          ← Imports from Layers 0-1 (extractors, overlay, staleness, differ)
Layer 4: verify          ← Imports from Layers 0-3
Layer 5: cli             ← Imports from Layers 0-4

Top-level entrypoints (`src/index.ts`, `src/errors.ts`) are exempt from these directional rules because they exist to re-export public APIs and shared error types.
```

## Allowed Imports

| File in...     | Can import from...                                              | Cannot import from...              |
| -------------- | --------------------------------------------------------------- | ---------------------------------- |
| `src/ir/`      | (nothing in `src/`)                                             | everything                         |
| `src/utils/`   | `src/ir/`, `src/errors.ts`                                      | parser, engine, differ, compat...  |
| `src/parser/`  | `src/ir/`, `src/utils/`, `src/errors.ts`                        | engine, differ, compat, verify, cli |
| `src/engine/`  | `src/ir/`, `src/utils/`, `src/errors.ts`, `src/differ/`         | parser, verify, cli                |
| `src/differ/`  | `src/ir/`, `src/utils/`, `src/errors.ts`                        | parser, compat, verify, cli        |
| `src/compat/`  | `src/ir/`, `src/utils/`, `src/errors.ts`, `src/differ/`         | parser, verify, cli                |
| `src/verify/`  | `src/ir/`, `src/utils/`, `src/errors.ts`, `src/engine/`, `src/compat/` | parser, cli                        |
| `src/cli/`     | anything in `src/`                                              | (top level, can import all)        |

`src/utils/` contains naming utilities (`naming.ts`) and tree-sitter helpers (`tree-sitter.ts`). The `safeParse()` function in `tree-sitter.ts` is used by all tree-sitter-based extractors and the engine merger to work around a 32KB buffer limit in the tree-sitter 0.21.x native binding.

`src/compat/` contains the backwards-compatibility system: extractors (per-language API surface extraction), the compat differ, overlay system, and staleness detection. Extractors use tree-sitter grammars for source parsing (via `src/utils/tree-sitter.ts`).

## Emitters Are External

Emitters live in a separate project (`oagen-emitters`) and import from `@workos/oagen`. They receive IR nodes via their method signatures and never call the parser directly. Each emitter is self-contained with no cross-emitter dependencies.

## Violation Examples

A violation occurs when a lower-layer module imports from a higher layer:

```typescript
// BAD: src/parser/schemas.ts importing from engine (Layer 2 → Layer 3)
import { generate } from "../engine/orchestrator.js";

// BAD: src/ir/types.ts importing from utils (Layer 0 → Layer 1)
import { toSnakeCase } from "../utils/naming.js";

// BAD: src/engine/orchestrator.ts importing from cli (Layer 3 → Layer 4)
import { loadConfig } from "../cli/config-loader.js";
```

**Remediation:** Move the shared logic to a lower layer, or extract a type-only import.

## Cross-Layer Exceptions

Two type-only exceptions are currently allowed:

- `differ -> engine/types` for shared generation types such as `EmitterContext` and `GeneratedFile`
- `engine -> compat/types` because overlay-aware generation threads compat types through `EmitterContext` and generation options without depending on compat implementation modules

One runtime exception is currently allowed:

- `engine -> differ` for incremental generation, which depends on spec diffing and file mapping

If you add a new exception, keep it narrow, make it type-only when possible, and document the reason in both code and docs.

## Enforcement

These layer rules are enforced by `test/architecture/dependency-layers.test.ts`.

If you intentionally cross a layer boundary, either:

1. refactor the shared code to a lower layer, or
2. add a narrow documented exception here and update the enforcement test
