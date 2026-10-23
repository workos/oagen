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
  buildOperationsMap?(spec: ApiSpec, ctx: EmitterContext): OperationsMap;
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

The `httpKeyByMethod` reverse map is only populated when an `operations` map is present in `.oagen-manifest.json`. Without it, method-level violations cannot be auto-patched in the self-correcting loop. Emitters that support compat verification should implement `buildOperationsMap`.

## Rules

1. **Pure functions** — Generator methods receive IR nodes and return `GeneratedFile[]`. No I/O, no side effects, no network calls.

2. **Empty input = empty output** — If `models` is `[]`, `generateModels` must return `[]` without errors.

3. **Namespace threading** — All generated code must use `ctx.namespace` (snake_case) for file paths and `ctx.namespacePascal` for code identifiers.

4. **Tests include fixtures** — `generateTests` should internally call fixture generation and return both test files and fixture files in the combined `GeneratedFile[]`.

5. **Inapplicable methods return `[]`** — If a language doesn't need type signature files, `generateTypeSignatures` returns `[]`. Optional methods like `buildOperationsMap` can simply be omitted.

6. **Composable generators** — Interface methods can compose multiple internal generators when a language needs them.

## New IR Variants for Emitters

Emitters should handle these additional variants introduced for open-source readiness:

- **Auth:** `'cookie'` in the `apiKey` auth scheme `in` field
- **Pagination:** `'page'` strategy for page-number pagination — send `pageStart` first and advance `param` by one per request — next to `'link-header'` for RFC 5988 Link header pagination; optional `endOfIteration` (`{ kind: 'hasMore' | 'totalPages' | 'totalCount', path }`) naming the response field that ends the iteration, whatever the strategy (`hasMore === false`; pages fetched so far `>= totalPages` — `page - pageStart + 1` under `page`, `floor(offset / limit) + 1` under `offset`, the number of requests made under `cursor`; items received `>= totalCount`), in addition to the empty-page stop every strategy has; `dataPath` may be `undefined` (meaning the response IS the data)
- **Encoding:** `'form-urlencoded'` for `application/x-www-form-urlencoded` request bodies; every request body media type is matched by essence (parameters and case aside), and a `+json` media type is `'json'`
- **HTTP methods:** `head`, `options`, `trace` — HEAD returns no body, OPTIONS/TRACE are informational
- **Cookie params:** Optional `cookieParams` array on operations that use cookie parameters
- **Content parameters:** Optional `contentType: string` on `Parameter` — the `content` key a `content`-declared parameter's value is serialized under, as written (`application/json`, `application/json; charset=utf-8`), present exactly when the parameter is declared with `content` and the map is read; serialize such a value in that media type (JSON-encode an `application/json` or `+json` value) instead of by `style`/`explode`
- **Webhooks:** Optional `webhooks: Webhook[]` on `ApiSpec` — the document's top-level `webhooks` map (OpenAPI 3.1), one entry per HTTP method of each key, present only when the document declares at least one. A webhook is not an SDK method: it has no path, belongs to no `Service` and gets no resolved operation name. Each carries the payload (`requestBody`, with `requestBodyEncoding`, `requestBodyContentType`, `requestBodyDescription` and the `requestBodyContentTypes` / `requestBodyContents` lists read as an operation's are, and `requestBodyRequired` present, and `true`, only when the payload is required), the `headerParams`, `queryParams` and `cookieParams` the request carries, the `responses` the sender expects back, and `summary`, `description`, `externalDocs`, `deprecated`, `tags` and `security` as an operation has them; generate a payload type (the model is already in `spec.models`) or a typed handler per event, keyed by `name` + `httpMethod`
- **Named unions:** Optional `variants: TypeRef[]` and `compositionKind: 'oneOf' | 'anyOf'` on `Model` (present together) for a component schema that is itself a `oneOf`/`anyOf`: emit such a model as a union of `variants`, not as a data class — `fields` holds only the inline variants' properties merged as optional fields. `discriminator` is set on a named union that is discriminated (an explicit `discriminator:`, or a const-pinned property every variant shares) as it is on an allOf+oneOf dispatcher, so an emitter that keys dispatchers on it emits one for such a union too; its `mapping` values are IR model names. A `$ref` to a named union that admits `null` resolves to `nullable<model>`
- **Extensions:** Optional `extensions: Record<string, unknown>` on `Operation`, `Model`, `Field` and `Enum` — the `x-*` keys of the object the node was built from, each under the key as written with its value verbatim, less the keys the parser reads into typed fields (an Operation Object's `x-pagination`, `x-oagen-async`, `x-mutually-exclusive-parameter-groups` and `x-mutually-exclusive-body-groups`; a Schema Object's `x-enum-descriptions` and `x-enumDescriptions`), present only when at least one key remains. Read the keys the SDK knows (`x-idempotent: true` on a `POST` that is safe to retry, `x-since` for an `@since` tag); the values come from the document unvalidated, so escape one before writing it into generated source, as a `description` is escaped. No other node carries them (see [Extensions](ir-types.md#extensions))
- **Enum descriptions:** Optional `description: string` on `Enum` — the enum schema's own `description`, a component enum's or the inline schema's an enum was lifted from, present only with non-whitespace content; emit it as the enum's doc comment
- **Servers:** Optional `servers: ServerEntry[]` on `ApiSpec` alongside `baseUrl`. Each entry keeps its URL template and, when declared, its `variables` (`default`, `enum`, `description`); `baseUrl` already has the defaults filled in, and `resolveServerUrl` from `@workos/oagen` does the same for any other entry
- **Operation servers:** Optional `servers: ServerEntry[]` on `Operation` (same shape), present only when the operation's own `servers`, else its Path Item's, differ from the document's; an operation without the key inherits `ApiSpec.servers`, so the servers a request goes to are `op.servers ?? spec.servers`
- **Multiple responses:** Optional `successResponses: SuccessResponse[]` on `Operation`: one entry per declared 2xx and 3xx response, set only when more than one is declared, counting both together (`200` + `302` sets it; a lone `200` does not). A 3xx entry's `type` is `unknown`. `response` stays the primary response: the lowest declared code whose type is not `unknown` (the lowest 2xx with a typed body), else the lowest declared code
- **Response headers:** Optional `responseHeaders: ResponseHeader[]` on `Operation` (the primary response's headers) and `headers: ResponseHeader[]` on each `SuccessResponse` / `ErrorResponse`, present only when the spec declares at least one
- **Response descriptions:** Optional `responseDescription: string` on `Operation` (the primary response's description, e.g. for a `@returns` tag) and `description: string` on each `SuccessResponse` / `ErrorResponse`, present only when the spec declares one with non-whitespace content
- **Primary response status code:** Optional `responseStatusCode: number` on `Operation`: the status code of the response `response` was read from (`200`, a lone `302`, a POST's `200`), present exactly when the operation declares at least one 2xx or 3xx response
- **Request body required:** Optional `requestBodyRequired: boolean` on `Operation`, present exactly when `requestBody` is; `false` when the spec omits the flag (the OpenAPI default)
- **Request body description:** Optional `requestBodyDescription: string` on `Operation` and `Webhook` — the Request Body Object's own `description` (after a `components/requestBodies` `$ref` is resolved), else the `description` written on the schema `requestBody` was read from (a `$ref` not followed) — present only when one of the two has non-whitespace content, e.g. for the body argument's doc tag; an inline object body's model carries its schema's `description` as any other inline model does
- **Request body content types:** Optional `requestBodyContentType: string` on `Operation` and `Webhook` — the essence of the media type `requestBody` was read from (`application/merge-patch+json`; `application/json` for `application/json; charset=utf-8`), set exactly when `requestBody` is: send it as the `Content-Type`, producing parameters such as a multipart boundary yourself — and optional `requestBodyContentTypes: string[]` / `requestBodyContents: RequestBodyContent[]` on both (every media type the body declares, verbatim and in document order, with a type per media type; the entry for the picked media type shares `requestBody`'s type), present only when the body declares at least one media type; `requestBody` is the fixed-order pick
- **Deprecation:** Optional `deprecated: boolean` on `Operation`, `Parameter`, `ResponseHeader`, `Field`, `Model` and `Enum`, each read from its own source: `Operation` from the Operation Object's own keyword; `Parameter` from any of the Parameter Object (after a `components.parameters` `$ref` is resolved), its inline `schema` and the component schema its `schema.$ref` points at — deprecated when any of the three says `deprecated: true`, so a `false` on one level does not stop a `true` on another; `ResponseHeader` from the Header Object only (after a `components/headers` `$ref` is resolved), never from its schema; `Field` from the property schema itself, a keyword written beside a `$ref` included, while the referenced model keeps its own and an `allOf` member's is not read — except that a bare `$ref` to an array component, which has no model to keep the flag, deprecates the field when the component says `deprecated: true`, as the field takes that component's `description`, `externalDocs`, `extensions` and `example`; `Model` from the schema the model was built from — a component's own top-level keyword, or the inline schema an inline model is materialized from — never an `allOf` member's; `Enum` from the component enum schema's own top-level keyword, while an inline enum lifted into `spec.enums` carries no flag of its own: the field, parameter or header that declares it carries `deprecated`. At every site the parser tests `=== true`: a `false`, absent or non-boolean keyword (`"yes"`, `1`) leaves the key absent, so the IR never carries anything but a literal `true` and `if (node.deprecated)` is the whole check. Emit the language's deprecation marker on the generated symbol (a `@deprecated` doc tag, `[Obsolete]`, `#[deprecated]`, a runtime warning where the language has no annotation). `EnumValue.deprecated` is present, and `true`, when the enum is declared as a `oneOf`/`anyOf` of `const` schemas and the value's own member says `deprecated: true` — the OAS 3.1 spelling for deprecating one value; a plain `enum:` list has no per-value keyword, so its values never carry it. Emit the same deprecation marker on that member alone
- **Response content types:** Optional `responseContentTypes: string[]` and `responseContents: ResponseContent[]` on `Operation` (the primary response's media types, verbatim and in document order, with a type per media type) and `contentTypes` / `contents` on each `SuccessResponse` / `ErrorResponse`, present only when the response declares at least one media type (an error carries them only when they add to its `type`); `response` is the fixed-order pick
- **Fallback responses:** Optional `defaultResponse: DefaultResponse` (the `default` response) and `rangeResponses: RangeResponse[]` (`1XX`–`5XX`) on `Operation`, present only when the spec declares them, each with its own `type`, `headers`, `description` and — in the shape a `SuccessResponse` carries them — `contentTypes` / `contents`; resolve a status as the explicit entry, then its range, then `defaultResponse`. Neither feeds `response` or `errors`: `defaultResponse.type` types the errors an operation does not list, and the `2XX` range's `type`, then `defaultResponse.type`, is the success body of an operation that declares no explicit 2xx (`response` is `unknown` there)
- **Idempotency:** `injectIdempotencyKey` is spec-driven: `true` exactly when the operation declares an `Idempotency-Key` header parameter (the name compared case-insensitively), which is then left out of `headerParams` — the SDK injects the header rather than typing it as an argument — so its `description`, `required` flag and schema do not reach the IR
- **Async marker:** Optional `async` on `Operation` — the Operation Object's `x-oagen-async` extension, carried as the document writes it, with no test or coercion of the value: `x-oagen-async: true` arrives as `true` and `'x-oagen-async': 'yes'` as the string `'yes'`, although the IR types the field as `boolean`; absent when the document declares none. Test `=== true`

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
