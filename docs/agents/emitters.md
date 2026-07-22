# Emitter Implementation

Use this guide when adding or changing a language emitter.

## Working Model

Emitters transform IR into `GeneratedFile[]`. Keep generator methods pure: no I/O and no side effects.

## Common Emitter Layout

Emitters live in the separate `oagen-emitters` project and import types from `@workos/oagen`. Most emitters are organized around:

- `index.ts`: emitter entry point
- `type-map.ts`: `TypeRef` to target-language type mapping
- `naming.ts`: target-language naming rules
- `models.ts`: model generation
- `enums.ts`: enum generation
- `resources.ts`: service and resource generation
- `client.ts`: HTTP client generation
- `errors.ts`: error types
- `config.ts`: configuration output
- `tests.ts`: generated test files
- `fixtures.ts`: generated fixtures
- `manifest.ts`: smoke manifest output when needed

Language-specific extras already exist in some emitters:

- Ruby: `yard.ts`, `types-rbs.ts`, `types-rbi.ts`
- Node: `options.ts`, `common.ts`, `manifest.ts`

- `src/engine/operation-plan.ts` provides shared operation semantics (`OperationPlan`). Emitters should call `planOperation(op)` rather than duplicating decision logic for `isDelete`, `hasBody`, `isPaginated`, `responseModelName`, etc.

## Naming

IR names use PascalCase. Each emitter is responsible for converting names through its local `naming.ts`.

## Escaping Spec-Controlled Free-Text

Free-text spec fields (schema/field/operation `description`, and `info.title`, which becomes the default namespace) are **attacker-influenceable data**. Interpolating them verbatim into generated source lets a crafted spec break out of the syntactic context and emit arbitrary top-level code — which then runs when the generated files are imported during `oagen generate` → `oagen verify`, and ships to consumers if published.

The core package exports two helpers for this. Apply them at **every** site where spec free-text is interpolated into output:

- `escapeBlockComment(text)` — neutralizes `*/` before it goes inside a `/** ... */` doc comment.
- `sanitizeIdentifier(text)` — strips characters that would break out of an identifier position (e.g. a class name built from the namespace). Already-valid identifiers pass through unchanged.

Both helpers are **JS/TS-block-comment / JS-identifier specific**. Emitters for other languages must apply language-appropriate escaping instead of, or in addition to, these:

- Python docstrings (`"""`) — escape/neutralize an embedded `"""`.
- Ruby (`=begin`/`=end`, `#`) and other line-comment styles — a newline in the text can start a new source line; escape newlines or emit one comment marker per line.
- Kotlin/Java KDoc/Javadoc (`/** */`) — same terminator hazard as `escapeBlockComment`.

When adding a new interpolation site, treat "does this field originate from the spec?" as the trigger for escaping — not "is this field usually a description?".

## Verifying Backwards Compatibility

When regenerating an SDK for a language that already has a published SDK, verify that the generated output preserves the existing public API surface.

**When to use:**

- The target language has an existing SDK with consumers who depend on its public API
- You're modifying an emitter and need to ensure no regressions in method names, signatures, or exports

**When to skip:**

- The target language is brand new (no existing SDK) — pass `--no-compat-check` to the generate command
- You're doing a full rewrite where breaking changes are intentional and documented

**How the self-correcting loop works:**

1. Extract the live SDK's API surface (`oagen extract --sdk-path <path> --lang <language> --output <output>/sdk-{language}-surface.json`)
2. Generate with the overlay (`--api-surface <output>/sdk-{language}-surface.json`) so the emitter preserves existing names
3. Verify the generated output against the baseline (`oagen verify --api-surface <output>/sdk-{language}-surface.json --lang <language> --output <output>`)
4. If violations exist, fix the emitter and regenerate — `--max-retries` on `oagen verify` automates the overlay patching cycle

The differ and overlay delegate all language-specific logic to the extractor's `hints: LanguageHints` object. Every extractor must provide hints — use `resolveHints({...})` to override only what differs from Node defaults. See `docs/architecture/extractor-contract.md` for the full hints reference.

The `--api-surface` flag is supported by `oagen generate`.

Run `/generate-extractor <language>` to scaffold the extractor, then `/verify-compat <language>` for the full guided workflow.

## Source Of Truth

- Per-language design docs: `docs/sdk-architecture/{language}.md` in the emitter project
- Extractor contract: `docs/architecture/extractor-contract.md`
- Create a new emitter: `/generate-emitter <language>`
- Create a new extractor: `/generate-extractor <language>`
