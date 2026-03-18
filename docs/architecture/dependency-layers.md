# Dependency Layers

## Layer Hierarchy (one-way imports only)

```
Layer 0: ir/types        ← Pure type definitions, no imports from other layers
Layer 1: utils           ← Only imports from Layer 0 (naming, tree-sitter helpers)
Layer 2: parser          ← Imports from Layers 0-1
Layer 3: engine, differ  ← Imports from Layers 0-1 (differ may also import engine/types)
Layer 3: compat          ← Imports from Layers 0-1 (extractors, overlay, staleness, differ)
Layer 4: cli             ← Imports from Layers 0-3
```

## Allowed Imports

| File in...    | Can import from...                                  | Cannot import from...       |
| ------------- | --------------------------------------------------- | --------------------------- |
| `src/ir/`     | (nothing in src/)                                   | everything                  |
| `src/utils/`  | `src/ir/`                                           | parser, engine, compat, cli |
| `src/parser/` | `src/ir/`, `src/utils/`                             | engine, compat, cli         |
| `src/engine/` | `src/ir/`, `src/utils/`                             | parser, compat, cli         |
| `src/differ/` | `src/ir/`, `src/utils/`, `src/engine/` (types only) | parser, compat, cli         |
| `src/compat/` | `src/ir/`, `src/utils/`                             | parser, engine, cli         |
| `src/cli/`    | anything in `src/`                                  | (top level, can import all) |

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

The `differ → engine` cross-layer import exists for shared generation types such as `EmitterContext` and `GeneratedFile`. If you add a new exception, keep it narrow and document the reason in the code and docs.

## Enforcement

These layer rules are guidance for contributors rather than an automated gate. If you intentionally cross a layer boundary, document why the dependency is warranted.
