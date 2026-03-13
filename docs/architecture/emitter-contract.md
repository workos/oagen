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
  skipIfExists?: boolean; // Don't overwrite if file already exists on disk
}
```

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

| Language | Directory            | Design Doc                 |
| -------- | -------------------- | -------------------------- |
| Ruby     | `src/emitters/ruby/` | `docs/sdk-designs/ruby.md` |
| Node     | `src/emitters/node/` | `docs/sdk-designs/node.md` |

## Adding a New Emitter

1. Create design doc at `docs/sdk-designs/{language}.md`
2. Scaffold files under `src/emitters/{language}/`
3. Implement all `Emitter` methods
4. Register in `src/cli/generate.ts` and `src/cli/diff.ts`
5. Add tests under `test/emitters/{language}/`

Or use: `/generate-emitter <language>`
