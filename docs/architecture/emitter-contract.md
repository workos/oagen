# Emitter Contract

Source: `src/engine/types.ts`

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
  generateConfig(ctx: EmitterContext): GeneratedFile[];
  generateTypeSignatures(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];
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
  header?: string; // Optional override of the default file header
  skipIfExists?: boolean; // Don't overwrite if file already exists on disk (defaults to false)
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
  irVersion: number; // IR contract version — see ir-types.md Versioning section
}
```

## Overlay Integration

When a user passes `--api-surface` to `oagen generate` or `oagen diff`, the engine builds an `OverlayLookup` and passes it to emitters via `ctx.overlayLookup`. Emitters should check the overlay before generating default names to preserve backwards compatibility with an existing SDK.

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

| Field               | Type                         | Purpose                                          |
| ------------------- | ---------------------------- | ------------------------------------------------ |
| `methodByOperation` | `Map<string, MethodOverlay>` | HTTP key → existing method info (name, params)   |
| `httpKeyByMethod`   | `Map<string, string>`        | Reverse map: "Class.method" → HTTP key           |
| `interfaceByName`   | `Map<string, string>`        | IR interface name → existing interface name      |
| `typeAliasByName`   | `Map<string, string>`        | IR type alias name → existing type alias name    |
| `requiredExports`   | `Map<string, Set<string>>`   | Barrel file path → symbols that must be exported |

The `httpKeyByMethod` reverse map is only populated when a manifest (`smoke-manifest.json`) is available. Without it, method-level violations cannot be auto-patched in the self-correcting loop. Emitters that support compat verification should implement `generateManifest`.

## Contract Versioning

Emitters can optionally declare `contractVersion` to indicate which IR version they were built against:

```typescript
const emitter: Emitter = {
  language: "ruby",
  contractVersion: 1,
  // ...
};
```

When registered via `registerEmitter()`, the registry validates `contractVersion` against the current `IR_VERSION`:

- **Matches**: registration succeeds silently
- **Mismatches**: throws `RegistryError` — `Emitter "ruby" declares contractVersion 3, but oagen requires IR_VERSION 5.`
- **Undefined**: emits `console.warn` — `Warning: Emitter "ruby" does not declare a contractVersion.` — but still registers

Consumers can also set `irVersion` in `oagen.config.ts` for a project-level version pin (checked at config load time, before emitter registration).

## Rules

1. **Pure functions** — Generator methods receive IR nodes and return `GeneratedFile[]`. No I/O, no side effects, no network calls.

2. **Empty input = empty output** — If `models` is `[]`, `generateModels` must return `[]` without errors.

3. **Namespace threading** — All generated code must use `ctx.namespace` (snake_case) for file paths and `ctx.namespacePascal` for code identifiers.

4. **Tests include fixtures** — `generateTests` should internally call fixture generation and return both test files and fixture files in the combined `GeneratedFile[]`.

5. **Inapplicable methods return `[]`** — If a language doesn't need type signature files, `generateTypeSignatures` returns `[]`. Optional methods like `generateManifest` can simply be omitted.

6. **Composable generators** — Interface methods can compose multiple internal generators. Example: Node's `generateConfig` returns config files plus shared utility files.

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

Emitters live in the separate `oagen-emitters` project and import types from `@workos/oagen`.

| Language | Location (in oagen-emitters) | Design Doc (in oagen-emitters) |
| -------- | ---------------------------- | ------------------------------ |
| Ruby     | `src/ruby/`                  | `docs/ruby.md`                 |
| Node     | `src/node/`                  | `docs/node.md`                 |

## Adding a New Emitter

1. Create design doc at `docs/sdk-architecture/{language}.md` in the emitter project
2. Scaffold files under `src/{language}/` in the emitter project
3. Implement all `Emitter` methods
4. Register in the emitter project's `oagen.config.ts`
5. Add tests under `test/{language}/` in the emitter project

Or use: `/generate-emitter <language>`

Emitters are registered via `oagen.config.ts` — no need to modify CLI source. See the Configuration section in the README.
