# Extractor Contract

Source: `src/compat/types.ts`

## Interface

Every language extractor must implement the `Extractor` interface:

```typescript
interface Extractor {
  language: string;
  extract(sdkPath: string): Promise<ApiSurface>;
  hints: LanguageHints;
}
```

- `language` — the language identifier (e.g., `"node"`, `"ruby"`, `"python"`). Must match the emitter's `language` field.
- `extract` — analyzes a live SDK at `sdkPath` and returns its public API surface. Must be deterministic: same input produces the same output.
- `hints` — a `LanguageHints` object that tells the differ and overlay how to interpret type strings for this language. Required — every extractor must explicitly declare its conventions.

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

| Type           | Fields                                                             | What it captures                                 |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| `ApiClass`     | `name`, `sourceFile?`, `methods`, `properties`, `constructorParams` | Public classes with their methods and properties |
| `ApiMethod`    | `name`, `params`, `returnType`, `async`                            | Method signatures (methods is `Record<string, ApiMethod[]>` to support overloads) |
| `ApiParam`     | `name`, `type`, `optional`                                         | Method and constructor parameters                |
| `ApiProperty`  | `name`, `type`, `readonly`                                         | Class properties                                 |
| `ApiInterface` | `name`, `sourceFile?`, `fields`, `extends`                         | Interface declarations                           |
| `ApiField`     | `name`, `type`, `optional`                                         | Interface fields                                 |
| `ApiTypeAlias` | `name`, `sourceFile?`, `value`                                     | Type alias declarations                          |
| `ApiEnum`      | `name`, `sourceFile?`, `members`                                   | Enum declarations with member values             |

The `exports` field maps file paths to their exported symbol names, capturing the barrel export structure.

## Rules

1. **Deterministic output** — Running the extractor twice on the same SDK must produce identical JSON. Sort keys and members consistently.

2. **Public surface only** — Extract only public/exported symbols. Internal implementation details, private methods, and unexported types are excluded.

3. **Preserve fidelity** — Method signatures should capture parameter names, types, and optionality as they appear in the live SDK, not as the IR would generate them.

4. **Handle missing infrastructure gracefully** — If the language's type system files are missing (e.g., no `tsconfig.json`, no `.pyi` stubs), throw a descriptive error rather than returning an empty surface.

## Language Hints

Every extractor must provide a `hints: LanguageHints` object that tells the differ and overlay how to interpret language-specific type strings. The `LanguageHints` interface includes:

| Method/Property                     | Purpose                                       | Node example                                     | Go example                           |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| `stripNullable(type)`               | Strip nullable wrapper                        | `"string \| null"` → `"string"`                  | `"*Organization"` → `"Organization"` |
| `isNullableOnlyDifference(a, b)`    | True if a and b differ only by nullability    | `"string"` vs `"string \| null"` → true          |                                      |
| `isUnionReorder(a, b)`              | True if same union members in different order | `"a" \| "b"` vs `"b" \| "a"` → true              | Always false (Go has no unions)      |
| `isGenericTypeParam(type)`          | True if type is an unresolvable generic param | `"T"`, `"TCustomAttributes"` → true              |                                      |
| `isExtractionArtifact(type)`        | True if type is an extraction artifact        | `"any"` → true                                   | `"interface{}"` → true               |
| `tolerateCategoryMismatch`          | Allow type alias ↔ interface/class mismatch   | `true` (TS allows both forms)                    | `false`                              |
| `extractReturnTypeName(returnType)` | Extract innermost type from return type       | `"Promise<Organization>"` → `"Organization"`     |                                      |
| `extractParamTypeName(paramType)`   | Extract type from param (null for primitives) | `"string"` → null                                |                                      |
| `propertyMatchesClass(prop, class)` | True if property maps to class name           | camelCase: `"organizations"` → `"Organizations"` |                                      |
| `derivedModelNames(modelName)`      | Additional names a model produces             | `["FooResponse", "SerializedFoo"]`               | `["FooResponse"]`                    |
| `isTypeEquivalent?(a, b, surface)`  | True if types are semantically equivalent     | Named enum vs inline union of literals           |                                      |
| `isSignatureEquivalent?(a, b, s)`   | True if signatures are equivalent despite structural differences | Unpacked params vs dict payload |                                      |
| `modelBaseClasses?`                 | Base class names indicating a data model      | `["BaseModel"]` (Python/Pydantic)                | —                                    |
| `exceptionBaseClasses?`             | Base class names indicating an exception      | `["Exception"]`                                  | —                                    |
| `listResourcePatterns?`             | Type names for list/paginated wrappers        | `["ListResource"]`                               | —                                    |

Use `resolveHints({...overrides})` to start from Node defaults and override only the methods that differ for your language:

```typescript
import { resolveHints } from "@workos/oagen";

const goHints = resolveHints({
  stripNullable: (type) => (type.startsWith("*") ? type.slice(1) : null),
  isExtractionArtifact: (type) => type === "interface{}",
  tolerateCategoryMismatch: false,
  derivedModelNames: (name) => [`${name}Response`],
});
```

## Registration

Extractors are registered via `oagen.config.ts` in the consumer project. The CLI loads the config at startup and registers all extractors automatically before any command runs.

```typescript
// oagen.config.ts
import { myExtractor } from "./src/compat/extractors/my-language.js";
import type { OagenConfig } from "@workos/oagen";

const config: OagenConfig = {
  extractors: [myExtractor],
};
export default config;
```

Under the hood, the config loader calls `registerExtractor()` for each entry, populating a Map-based registry (`src/compat/extractor-registry.ts`):

```typescript
registerExtractor(extractor: Extractor): void
getExtractor(language: string): Extractor
```

## File Structure: Parser vs Surface

Extractors use tree-sitter for source parsing (except Node, which uses the TypeScript compiler API). The internal file layout depends on the complexity of getting from parsed AST nodes to `ApiSurface` types. There are two reasons a language needs a separate `*-surface.ts` file:

1. **Structural joining** — the language separates type definitions from method implementations (e.g., Go receiver functions, Rust impl blocks), so parsed symbols must be joined before they can become `ApiClass` etc.
2. **Classification** — the language co-locates methods inside classes, but deciding _which_ API surface type a class maps to requires non-trivial heuristics (e.g., PHP resource classes → `ApiInterface`, Python Protocols → `ApiClass`).

### Parser only

When the AST co-locates methods/properties inside their owning declaration **and** the mapping to API surface types is straightforward enough to handle inline.

- **Ruby**: `class Foo` contains `def bar` and `attr_accessor :baz` as direct children. The parser has separate functions (`extractClasses`, `extractServiceModules`, `extractEnumModules`) that each return the appropriate `Api*` type directly.
- **Node**: The TypeScript compiler API resolves classes with their members in one pass.

### Parser + Surface (structural joining)

When the language separates type definitions from method implementations. The parser extracts raw symbols (structs, functions, consts) independently, then a surface builder joins them by matching receivers to types, consts to type declarations, etc.

- **Go**: `type Foo struct` and `func (f *Foo) Bar()` are separate top-level declarations. The parser extracts `GoStruct[]` and `GoFunc[]`; the surface builder matches functions to structs by receiver type to produce `ApiClass`.
- **Rust**: `pub struct Foo` and `impl Foo { pub fn bar() }` are separate items. The parser extracts `RustStruct[]` and `RustFunc[]`; the surface builder matches impl methods to structs.

### Parser + Surface (classification)

When the AST co-locates methods inside classes (like Ruby), but the classification logic — deciding whether a parsed class becomes an `ApiClass`, `ApiInterface`, or `ApiEnum` — is complex enough to warrant its own file.

- **PHP**: The parser returns `PhpClass[]` with methods, properties, and constants already attached. The surface builder classifies each class: resource classes (extends configured model base class via `hints.modelBaseClasses`) → `ApiInterface`, const-only classes → `ApiEnum`, PHP interface declarations → `ApiInterface`, service/exception classes → `ApiClass`.
- **Python**: The parser returns `PythonClass[]`, `PythonTypeAlias[]`, and `__all__` exports. The surface builder classifies: `Protocol` subclasses → `ApiClass`, model base class subclasses (configured via `hints.modelBaseClasses`, e.g., `BaseModel` for Pydantic) → `ApiInterface`, `TypedDict` subclasses → `ApiInterface`, `Literal[...]` type aliases → `ApiEnum`, exception subclasses → `ApiClass`. Transitive base class resolution is needed (a class inheriting from another model class is also a model).

| Language | Files                                                  | Why                                                                                                                                                               |
| -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node     | `node.ts`                                              | TS compiler API resolves everything in one pass                                                                                                                   |
| Ruby     | `ruby.ts` + `ruby-parser.ts`                           | AST co-locates methods in classes/modules — classification handled inline by separate extract functions                                                           |
| Go       | `go.ts` + `go-parser.ts` + `go-surface.ts`             | Structs and methods are separate declarations — surface builder joins by receiver type and qualifies duplicate names across packages                              |
| Rust     | `rust.ts` + `rust-parser.ts` + `rust-surface.ts`       | Structs and impl blocks are separate items — surface builder joins by impl target type                                                                            |
| PHP      | `php.ts` + `php-parser.ts` + `php-surface.ts`          | Methods co-located in classes, but classification (resource vs enum vs service vs interface) requires heuristics                                                  |
| Python   | `python.ts` + `python-parser.ts` + `python-surface.ts` | Methods co-located in classes, but classification (Protocol vs BaseModel vs TypedDict vs Literal vs exception) requires heuristics and transitive base resolution |

The `*-parser.ts` file handles tree-sitter AST traversal and returns language-specific intermediate types (`GoStruct`, `PhpClass`, `PythonClass`, etc.). The `*-surface.ts` file transforms those into `ApiSurface` types (`ApiClass`, `ApiInterface`, etc.) — either by structural joining or classification. The `*.ts` orchestrator file owns the `Extractor` constant, `LanguageHints`, file walking, and the `extract()` method.

All tree-sitter parsers use `safeParse()` from `src/utils/tree-sitter.ts` to handle files larger than 32KB (works around a buffer size limit in tree-sitter 0.21.x's native binding).

## Language-Specific Strategies

### Node (reference implementation)

- Uses the TypeScript compiler API (`typescript` package) to load and analyze the SDK
- Reads `tsconfig.json` to discover source files
- Resolves the entry point from `package.json` `main`/`types` fields
- Extracts classes, interfaces, type aliases, and enums from exported declarations
- File: `src/compat/extractors/node.ts`

### Ruby

- Uses tree-sitter-ruby to parse `.rb` files under `lib/`
- Extracts classes (with `attr_accessor`/`attr_reader` properties and methods), service modules (modules with `class << self`), and enum-like modules (modules with string constants)
- Respects `private`/`protected`/`public` visibility markers
- Files: `src/compat/extractors/ruby.ts`, `ruby-parser.ts`

### Go

- Uses tree-sitter-go to parse `.go` files (excluding `_test.go`, `vendor/`, `internal/`)
- Extracts structs (with JSON struct tags), functions/methods (matching receivers to structs), const blocks (enum patterns), and type aliases
- Package-qualifies duplicate names (e.g., `organizations.Client` vs `sso.Client`)
- Filters `context.Context` params (infrastructure, not API surface)
- Files: `src/compat/extractors/go.ts`, `go-parser.ts`, `go-surface.ts`

### Rust

- Uses tree-sitter-rust to parse `.rs` files under `src/` (excluding `target/`)
- Extracts pub structs (with serde rename attributes), pub enums (with serde variant renames), impl block methods, pub traits, and type aliases
- Maps `Option<T>` to optional, unwraps `Result<T, E>` return types
- Matches impl blocks to struct definitions to distinguish `ApiClass` (has methods) from `ApiInterface` (data only)
- Files: `src/compat/extractors/rust.ts`, `rust-parser.ts`, `rust-surface.ts`

### PHP

- Uses tree-sitter-php to parse `.php` files under `lib/` (fallback to `src/`), excluding `vendor/`, `tests/`
- Parser extracts classes and interfaces with methods, properties, constants, and `RESOURCE_ATTRIBUTES` arrays
- Surface builder classifies: resource classes (extends configured model base class with `RESOURCE_ATTRIBUTES`) → `ApiInterface`, const-only classes → `ApiEnum`, PHP `interface` declarations → `ApiInterface`, service/exception classes → `ApiClass`
- Reads both native type hints and PHPDoc `@param`/`@return` annotations for type information
- Files: `src/compat/extractors/php.ts`, `php-parser.ts`, `php-surface.ts`

### Python

- Uses tree-sitter-python to parse `.py` files, finding the source root via `src/` or top-level package directories (looks for `__init__.py`)
- Parser extracts classes (with fields, methods, decorators, base classes), module-level type aliases, and `__all__` exports
- Surface builder classifies: `Protocol` subclasses → `ApiClass` (canonical service), model base class subclasses (configured via `hints.modelBaseClasses`, e.g., `BaseModel` for Pydantic) → `ApiInterface`, `TypedDict` subclasses → `ApiInterface`, `Literal[...]` type aliases → `ApiEnum`, exception subclasses → `ApiClass`. Uses transitive base resolution for model and exception detection.
- Skips private modules (`_*.py` except `__init__.py`), test files, and `__pycache__`
- Files: `src/compat/extractors/python.ts`, `python-parser.ts`, `python-surface.ts`

## Building a New Extractor

1. Create the extractor in `src/compat/extractors/{language}.ts` in oagen core
2. Implement the `Extractor` interface — export a named constant (e.g., `export const rubyExtractor: Extractor = { ... }`)
3. Provide `hints` as a `LanguageHints` object. Every extractor must have hints — the differ and overlay delegate all language-specific logic through them.
4. Split into `{language}-parser.ts` and `{language}-surface.ts` if either: (a) the language separates type definitions from method implementations (structural joining needed), or (b) the classification logic for mapping parsed types to `ApiClass`/`ApiInterface`/`ApiEnum` is non-trivial. If the AST co-locates symbols and classification is straightforward, a single `{language}-parser.ts` returning `ApiClass[]` directly is sufficient.
5. Use `safeParse()` from `src/utils/tree-sitter.ts` instead of calling `parser.parse()` directly.
6. Export from `src/index.ts`
7. Register in the consumer project's `oagen.config.ts`
8. Add tests in `test/compat/extractors/{language}.test.ts`
9. Create a fixture SDK in `test/fixtures/sample-sdk-{language}/` with known classes, methods, and exports
10. Verify deterministic output: extracting twice produces identical JSON

Use `/generate-extractor <language>` for a guided workflow.

## Existing Extractors

| Language | Files                                                |
| -------- | ---------------------------------------------------- |
| Node     | `node.ts`                                              |
| Ruby     | `ruby.ts`, `ruby-parser.ts`                            |
| Go       | `go.ts`, `go-parser.ts`, `go-surface.ts`               |
| Rust     | `rust.ts`, `rust-parser.ts`, `rust-surface.ts`         |
| PHP      | `php.ts`, `php-parser.ts`, `php-surface.ts`            |
| Python   | `python.ts`, `python-parser.ts`, `python-surface.ts`   |
| Kotlin   | `kotlin.ts`, `kotlin-parser.ts`, `kotlin-surface.ts`   |
| .NET     | `dotnet.ts`, `dotnet-parser.ts`, `dotnet-surface.ts`   |
| Elixir   | `elixir.ts`, `elixir-parser.ts`, `elixir-surface.ts`   |
