# Dependency Layers

## Layer Hierarchy (one-way imports only)

```
Layer 0: ir/types        ← Pure type definitions, no imports from other layers
Layer 1: utils           ← Only imports from Layer 0
Layer 2: parser          ← Imports from Layers 0-1
Layer 3: engine, differ  ← Imports from Layers 0-1 (differ may also import engine/types)
Layer 4: emitters        ← Imports from Layers 0-1, 3
Layer 5: cli             ← Imports from Layers 0-4
```

## Allowed Imports

| File in...      | Can import from...                                  | Cannot import from...         |
| --------------- | --------------------------------------------------- | ----------------------------- |
| `src/ir/`       | (nothing in src/)                                   | everything                    |
| `src/utils/`    | `src/ir/`                                           | parser, engine, emitters, cli |
| `src/parser/`   | `src/ir/`, `src/utils/`                             | engine, emitters, cli         |
| `src/engine/`   | `src/ir/`, `src/utils/`                             | parser, emitters, cli         |
| `src/differ/`   | `src/ir/`, `src/utils/`, `src/engine/` (types only) | parser, emitters, cli         |
| `src/emitters/` | `src/ir/`, `src/utils/`, `src/engine/`              | parser, cli, other emitters   |
| `src/cli/`      | anything in `src/`                                  | (top level, can import all)   |

## Key Constraint: Emitters Cannot Import Parser

Emitters only receive IR nodes via their method signatures. They never call the parser directly. This keeps them pure and testable.

## Key Constraint: Emitters Cannot Import Other Emitters

Each emitter is self-contained. No cross-emitter dependencies. This allows independent development and testing of each language target.

## Enforcement

The structural linter (`scripts/lint-structure.ts`, run via `npm run lint:structure`) mechanically enforces these layer rules by scanning import statements. Violations produce error messages with remediation instructions.

The `differ → engine` cross-layer import is explicitly allowed via `ALLOWED_CROSS` in the linter, scoped to `engine/types` for `EmitterContext` and `GeneratedFile`.
