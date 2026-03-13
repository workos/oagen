# Emitter Implementation

Use this guide when adding or changing a language emitter.

## Working Model

Emitters transform IR into `GeneratedFile[]`. Keep generator methods pure: no I/O and no side effects.

## Common Emitter Layout

Most emitters in `src/emitters/{lang}/` are organized around:

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

## Naming

IR names use PascalCase. Each emitter is responsible for converting names through its local `naming.ts`.

## Source Of Truth

- Per-language design docs: `docs/sdk-designs/{language}.md`
- Create a new emitter with the `.claude` skill: `/generate-emitter <language>`
