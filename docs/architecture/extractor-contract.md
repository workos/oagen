# Extractor Contract

Source: `src/compat/types.ts`

## Interface

Every language extractor must implement the `Extractor` interface:

```typescript
interface Extractor {
  language: string;
  extract(sdkPath: string): Promise<ApiSurface>;
}
```

- `language` — the language identifier (e.g., `"node"`, `"ruby"`, `"python"`). Must match the emitter's `language` field.
- `extract` — analyzes a live SDK at `sdkPath` and returns its public API surface. Must be deterministic: same input produces the same output.

## ApiSurface

```typescript
interface ApiSurface {
  language: string;
  extractedFrom: string;
  extractedAt: string;
  classes: Record<string, ApiClass>;
  interfaces: Record<string, ApiInterface>;
  typeAliases: Record<string, ApiTypeAlias>;
  enums: Record<string, ApiEnum>;
  exports: Record<string, string[]>;
}
```

Each sub-type captures a different kind of public symbol:

| Type           | Fields                                               | What it captures                                 |
| -------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `ApiClass`     | `name`, `methods`, `properties`, `constructorParams` | Public classes with their methods and properties |
| `ApiMethod`    | `name`, `params`, `returnType`, `async`              | Method signatures                                |
| `ApiParam`     | `name`, `type`, `optional`                           | Method and constructor parameters                |
| `ApiProperty`  | `name`, `type`, `readonly`                           | Class properties                                 |
| `ApiInterface` | `name`, `fields`, `extends`                          | Interface declarations                           |
| `ApiField`     | `name`, `type`, `optional`                           | Interface fields                                 |
| `ApiTypeAlias` | `name`, `value`                                      | Type alias declarations                          |
| `ApiEnum`      | `name`, `members`                                    | Enum declarations with member values             |

The `exports` field maps file paths to their exported symbol names, capturing the barrel export structure.

## Rules

1. **Deterministic output** — Running the extractor twice on the same SDK must produce identical JSON. Sort keys and members consistently.

2. **Public surface only** — Extract only public/exported symbols. Internal implementation details, private methods, and unexported types are excluded.

3. **Preserve fidelity** — Method signatures should capture parameter names, types, and optionality as they appear in the live SDK, not as the IR would generate them.

4. **Handle missing infrastructure gracefully** — If the language's type system files are missing (e.g., no `tsconfig.json`, no `.pyi` stubs), throw a descriptive error rather than returning an empty surface.

## Registration

Extractors use a simple Map-based registry (`src/compat/extractor-registry.ts`):

```typescript
registerExtractor(extractor: Extractor): void
getExtractor(language: string): Extractor
```

Registration happens at the script level. For example, `scripts/compat-extract.ts` imports the Node extractor and registers it before use:

```typescript
import { nodeExtractor } from "../src/compat/extractors/node.js";
import { registerExtractor } from "../src/compat/extractor-registry.js";

registerExtractor(nodeExtractor);
```

## Language-Specific Strategies

### Node (reference implementation)

- Uses the TypeScript compiler API (`typescript` package) to load and analyze the SDK
- Reads `tsconfig.json` to discover source files
- Resolves the entry point from `package.json` `main`/`types` fields
- Extracts classes, interfaces, type aliases, and enums from exported declarations
- Reference: `src/compat/extractors/node.ts`

### Ruby

- Parse `.rbi` (Sorbet) or `.rbs` (Steep) type signature files for typed Ruby projects
- Fall back to YARD `@api public` annotations
- Public methods: anything not marked `private` or `protected`
- Entry point: `lib/{gem_name}.rb` or the files listed in the gemspec

### Python

- Parse `.pyi` stub files (highest fidelity)
- Fall back to `ast` module on source files
- Public surface: `__all__` in `__init__.py`, or all non-underscore-prefixed names
- Entry point: `{package}/__init__.py`

### Go

- Use `go/types` and `go/packages` to load and analyze
- Public surface: exported identifiers (capitalized names)
- Entry point: the package directory (all `.go` files)

### Java/Kotlin

- Parse with a JVM AST library or extract from compiled `.class` files
- Public surface: `public` classes and methods
- Entry point: the main package directory

## Building a New Extractor

1. Create `src/compat/extractors/{language}.ts`
2. Implement the `Extractor` interface — export a named constant (e.g., `export const rubyExtractor: Extractor = { ... }`)
3. Register in the extraction script: import and call `registerExtractor()` in `scripts/compat-extract.ts`
4. Add tests in `test/compat/extractors/{language}.test.ts`
5. Create a fixture SDK in `test/fixtures/sample-sdk-{language}/` with known classes, methods, and exports
6. Verify deterministic output: extracting twice produces identical JSON

## Existing Extractors

| Language | File                            | Status                              |
| -------- | ------------------------------- | ----------------------------------- |
| Node     | `src/compat/extractors/node.ts` | Complete — reference implementation |
