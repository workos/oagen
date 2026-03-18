# Dependency Layers

Source: `scripts/lint-structure.ts`

## Layer Hierarchy (one-way imports only)

```
Layer 0: ir/types        ← Pure type definitions, no imports from other layers
Layer 1: utils           ← Only imports from Layer 0
Layer 2: parser          ← Imports from Layers 0-1
Layer 3: engine, differ  ← Imports from Layers 0-1 (differ may also import engine/types)
Layer 4: cli             ← Imports from Layers 0-3
```

## Allowed Imports

| File in...    | Can import from...                                  | Cannot import from...         |
| ------------- | --------------------------------------------------- | ----------------------------- |
| `src/ir/`     | (nothing in src/)                                   | everything                    |
| `src/utils/`  | `src/ir/`                                           | parser, engine, emitters, cli |
| `src/parser/` | `src/ir/`, `src/utils/`                             | engine, emitters, cli         |
| `src/engine/` | `src/ir/`, `src/utils/`                             | parser, emitters, cli         |
| `src/differ/` | `src/ir/`, `src/utils/`, `src/engine/` (types only) | parser, emitters, cli         |
| `src/cli/`    | anything in `src/`                                  | (top level, can import all)   |

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

**Remediation:** Move the shared logic to a lower layer, or extract a type-only import. The linter error message includes the violating import path and which layers are involved.

## Cross-Layer Exceptions

The `differ → engine` cross-layer import is explicitly allowed via `ALLOWED_CROSS` in the linter, scoped to `engine/types` for `EmitterContext` and `GeneratedFile`. To add a new exception, update the `ALLOWED_CROSS` array in `scripts/lint-structure.ts` and document the reason.

## Enforcement

The structural linter (`scripts/lint-structure.ts`, run via `npm run lint:structure`) mechanically enforces these layer rules by scanning import statements. Run it before every commit:

```bash
npm run lint:structure
```

Violations produce error messages with the source file, the imported path, and the layer boundary that was crossed.
