# Emitter Contract

Source: `src/engine/types.ts`

If you want the smallest possible implementation first, start with [Minimal Emitter](../core/minimal-emitter.md). This document is the full contract reference.

## Interface

Every language emitter must implement the `Emitter` interface:

```typescript
interface Emitter {
  language: string;

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[];
  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[];
  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[];
  generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];
  generateErrors(ctx: EmitterContext): GeneratedFile[];
  generateTypeSignatures?(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];
  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];
  generateManifest?(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];
  fileHeader(): string;
}
```

## GeneratedFile

```typescript
interface GeneratedFile {
  path: string; // Relative path within output directory
  content: string; // File content (header prepended by orchestrator)
  skipIfExists?: boolean; // Don't overwrite if file already exists on disk (defaults to false)
  headerPlacement?: "prepend" | "skip"; // How to handle the file header (default: 'prepend')
  integrateTarget?: boolean; // When false, exclude from --target integration (default: true)
}
```

## EmitterContext

Every generator method receives an `EmitterContext`:

```typescript
interface EmitterContext {
  namespace: string; // snake_case namespace for file paths
  namespacePascal: string; // PascalCase namespace for code identifiers
  spec: ApiSpec; // The full parsed IR spec
  outputDir?: string; // Output directory path
  apiSurface?: ApiSurface; // Baseline API surface (when --api-surface is provided)
  overlayLookup?: OverlayLookup; // Name preservation overlay (when --api-surface is provided)
}
```

## Overlay Integration

When a user passes `--api-surface` to `oagen generate`, the engine builds an `OverlayLookup` and passes it to emitters via `ctx.overlayLookup`. Emitters should check the overlay before generating default names to preserve backwards compatibility with an existing SDK.

**When it's present:** The user has an existing live SDK and wants the generated output to preserve its public API (method names, type names, exports).

**How emitters should use it:**

1. **Method names:** Before generating a method name, check `methodByOperation` using the HTTP key:

   ```typescript
   const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
   const existing = ctx.overlayLookup?.methodByOperation.get(httpKey);
   if (existing) {
     // Use existing.methodName instead of generating a new name
   }
   ```

2. **Type names:** Check `interfaceByName` and `typeAliasByName` for existing names before applying naming conventions.

3. **Barrel exports:** Check `requiredExports` to ensure all expected symbols are re-exported.

**`OverlayLookup` fields:**

| Field               | Type                         | Purpose                                                                 |
| ------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `methodByOperation` | `Map<string, MethodOverlay>` | HTTP key → existing method info (name, params)                          |
| `httpKeyByMethod`   | `Map<string, string>`        | Reverse map: "Class.method" → HTTP key                                  |
| `interfaceByName`   | `Map<string, string>`        | IR interface name → existing interface name                             |
| `typeAliasByName`   | `Map<string, string>`        | IR type alias name → existing type alias name                           |
| `requiredExports`   | `Map<string, Set<string>>`   | Barrel file path → symbols that must be exported                        |
| `modelNameByIR`     | `Map<string, string>`        | IR model name → SDK interface name (auto-inferred from field structure) |
| `fileBySymbol`      | `Map<string, string>`        | IR symbol name → relative file path in the live SDK                     |

The `httpKeyByMethod` reverse map is only populated when a manifest (`smoke-manifest.json`) is available. Without it, method-level violations cannot be auto-patched in the self-correcting loop. Emitters that support compat verification should implement `generateManifest`.

## Rules

1. **Pure functions** — Generator methods receive IR nodes and return `GeneratedFile[]`. No I/O, no side effects, no network calls.

2. **Empty input = empty output** — If `models` is `[]`, `generateModels` must return `[]` without errors.

3. **Namespace threading** — All generated code must use `ctx.namespace` (snake_case) for file paths and `ctx.namespacePascal` for code identifiers.

4. **Tests include fixtures** — `generateTests` should internally call fixture generation and return both test files and fixture files in the combined `GeneratedFile[]`.

5. **Inapplicable methods return `[]`** — If a language doesn't need type signature files, `generateTypeSignatures` returns `[]`. Optional methods like `generateManifest` can simply be omitted.

6. **Composable generators** — Interface methods can compose multiple internal generators when a language needs them.

## New IR Variants for Emitters

Emitters should handle these additional variants introduced for open-source readiness:

- **Auth:** `'cookie'` in the `apiKey` auth scheme `in` field
- **Pagination:** `'link-header'` strategy for RFC 5988 Link header pagination; `dataPath` may be `undefined` (meaning the response IS the data)
- **Encoding:** `'form-urlencoded'` for `application/x-www-form-urlencoded` request bodies
- **HTTP methods:** `head`, `options`, `trace` — HEAD returns no body, OPTIONS/TRACE are informational
- **Cookie params:** Optional `cookieParams` array on operations that use cookie parameters
- **Servers:** Optional `servers: ServerEntry[]` on `ApiSpec` alongside `baseUrl`
- **Multiple responses:** Optional `successResponses: SuccessResponse[]` on `Operation` when more than one 2xx exists
- **Idempotency:** `injectIdempotencyKey` is now spec-driven (true only when the spec declares an `Idempotency-Key` header)

## OperationPlan

Source: `src/engine/operation-plan.ts`

Emitters use `planOperation(op)` to compute an `OperationPlan` for each operation, rather than duplicating decision logic inline:

```typescript
interface OperationPlan {
  operation: Operation; // back-reference
  isDelete: boolean;
  hasBody: boolean;
  isIdempotentPost: boolean;
  pathParamsInOptions: boolean;
  isPaginated: boolean;
  responseModelName: string | null; // null = void/primitive
  isModelResponse: boolean;
  hasQueryParams: boolean;
}

function planOperation(op: Operation): OperationPlan;
```

- `responseModelName` is `null` for void/primitive responses. Each emitter maps this to its own fallback (`'void'` in Node, `'Object'` in Ruby).
- `resolveResponseModelName(op)` is also exported for cases that only need the model name.

## Existing Emitters

Production emitters live in the separate `oagen-emitters` project and import types from `@workos/oagen`.

| Language               | Location                        | Notes                                      |
| ---------------------- | ------------------------------- | ------------------------------------------ |
| TypeScript (reference) | `examples/reference-emitter/`   | Ships with oagen — minimal working example |
| Ruby                   | `src/ruby/` (in oagen-emitters) | Production emitter                         |
| Node                   | `src/node/` (in oagen-emitters) | Production emitter                         |

## Adding a New Emitter

1. Create design doc at `docs/sdk-architecture/{language}.md` in the emitter project
2. Scaffold files under `src/{language}/` in the emitter project
3. Implement all `Emitter` methods
4. Export through the emitter project's plugin bundle (e.g. `src/plugin.ts`)
5. Add tests under `test/{language}/` in the emitter project

Or use: `/generate-emitter <language>`

Emitters are registered via the plugin bundle exported from the emitter package. The consumer project's `oagen.config.ts` imports the bundle and layers spec interpretation policy on top. See the [CLI Reference](../cli.md#configuration-oagenconfigts) for details.
