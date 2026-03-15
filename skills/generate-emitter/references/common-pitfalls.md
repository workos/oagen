# Common Pitfalls

Review this checklist before finalizing the emitter, and when debugging failures.

1. **Don't invent patterns — replicate what exists.** For backwards-compatible scenarios, every architectural decision must come from the existing SDK. If you can't find a pattern in the real code, ask the user rather than guessing. Generic "best practices" are wrong if they don't match the real SDK.

2. **Don't forget path interpolation** — each language handles format strings differently (`%s`, `f"{id}"`, `fmt.Sprintf`, `${id}`, etc.)

3. **Keep generators pure** — they receive IR and return strings. No file I/O, no side effects.

4. **Handle empty inputs** — emitter methods may receive `[]` for models/enums/services. Return `[]` without errors.

5. **Namespace everywhere** — the `ctx.namespacePascal` and `ctx.namespace` must appear in all generated code (module names, class prefixes, import paths).

6. **Ignoring overlay** — When `ctx.overlayLookup` is provided, check it for existing method/type names before generating defaults. Skipping this causes compat verification failures.

7. **Missing serialization layer** — If the existing SDK has serialize/deserialize functions, the emitter MUST generate them. Producing plain models without serializers will fail compat verification.

8. **Wrong pagination type** — Each SDK has its own pagination pattern (AutoPaginatable, CursorPage, PageIterator, etc.). Use the design doc's pagination section, not a generic implementation.

9. **Wrong test framework** — If the existing SDK uses Jest, generate Jest tests. If it uses pytest, generate pytest tests. Never substitute a different framework because it seems "better."

10. **Acronym handling in naming** — `toPascalCase('WorkOS')` may produce `WorkOs` instead of `WorkOS`. If the SDK preserves acronym casing, create an `ensurePascal()` wrapper that only capitalizes the first letter without disturbing the rest.
