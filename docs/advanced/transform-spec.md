# `transformSpec` — Pre-IR Spec Overlay

`transformSpec` is a function on `OagenConfig` (and `ParseOptions`) that runs once on the bundled OpenAPI document, after `$ref` bundling and before any IR extraction. Use it to patch around upstream spec quirks that would otherwise emit a breaking SDK change.

## Signature

```typescript
import type { OagenConfig, OpenApiDocument } from "@workos/oagen";

const config: OagenConfig = {
  // ...
  transformSpec(spec: OpenApiDocument): OpenApiDocument {
    // mutate `spec` in place and return it, or return a new object
    return spec;
  },
};
```

`OpenApiDocument` is `Record<string, unknown>` — intentionally loose so the transform can reach extension keys without fighting types. Narrow with `as` at use sites.

## When to use it

`transformSpec` is an emergency lever, not a routine knob. Reach for it when:

1. **The upstream spec can't be changed in time.** The right fix is almost always to amend the spec author's PR. `transformSpec` is for when you can't, and the SDK ships tomorrow.
2. **The change is genuinely additive at the schema level but the spec authoring expressed it as a fork.** The canonical example is below.
3. **You need a one-shot adapter** for an OpenAPI extension, vendor extension, or non-conforming construct that oagen doesn't natively model.

If you find yourself reaching for `transformSpec` repeatedly for the same pattern, that's a signal the underlying issue belongs upstream — either in the spec authoring style or as a feature request to oagen.

## Canonical example: schema-fork rescue

The pattern: an upstream PR forks a new schema (`FooWithBar`) instead of adding a field to the existing one (`Foo`), and re-points a path's response `$ref` at the fork. Because the schema name is part of the SDK's public surface in typed languages, this changes the return type of every method that uses it — a breaking change in Go, Kotlin, .NET, etc.

oagen's compat differ flags this pattern via the `remediation` hint on classified changes (see `docs/core/compatibility-policy.md`). The hint nudges spec authors to fix it upstream. When you can't wait for that fix, `transformSpec` un-forks the schema at parse time:

```typescript
// oagen.config.ts
import type { OagenConfig } from "@workos/oagen";

const config: OagenConfig = {
  transformSpec(spec) {
    const components = (
      spec as {
        components?: {
          schemas?: Record<
            string,
            { properties?: Record<string, unknown>; required?: string[] }
          >;
        };
      }
    ).components;
    const paths = (
      spec as {
        paths?: Record<
          string,
          Record<
            string,
            {
              responses?: Record<
                string,
                { content?: Record<string, { schema?: { $ref?: string } }> }
              >;
            }
          >
        >;
      }
    ).paths;

    // 1. Rewrite the path response refs back to the original schema.
    const forkedRef = "#/components/schemas/FooWithBarList";
    const originalRef = "#/components/schemas/FooList";
    for (const pathItem of Object.values(paths ?? {})) {
      for (const op of Object.values(pathItem)) {
        const ref =
          op?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref;
        if (
          ref === forkedRef &&
          op.responses?.["200"]?.content?.["application/json"]?.schema
        ) {
          op.responses["200"].content["application/json"].schema!.$ref =
            originalRef;
        }
      }
    }

    // 2. Add the forked schema's new fields to the original schema additively.
    const foo = components?.schemas?.Foo;
    if (foo?.properties) {
      foo.properties.bar = {
        $ref: "#/components/schemas/Bar",
      } as unknown as Record<string, unknown>;
    }

    // 3. Drop the now-orphaned forked schemas so they don't bloat the IR.
    if (components?.schemas) {
      delete components.schemas.FooWithBar;
      delete components.schemas.FooWithBarList;
    }

    return spec;
  },
};

export default config;
```

The result: typed SDKs see no return-type change. Existing callers compile against the same struct/class, and the new `bar` field is available as an additive property.

## When the hook runs

- **After:** OpenAPI doc load, `$ref` bundling (`@redocly/openapi-core`), and OpenAPI version validation.
- **Before:** schema extraction, operation extraction, inline-model normalization, and IR validation.

This means anything you do to `spec.components.schemas`, `spec.paths`, or `spec.servers` flows naturally into the IR. Internal `$ref`s are still strings at this point — they aren't dereferenced until extraction.

If you need to inspect the resulting IR instead, post-process the `ApiSpec` returned by `parseSpec`. `transformSpec` is intentionally narrow.

## Caveats

- **Not for backward-compat hacks.** If a server-side change is a real shape change (not a fork), don't paper over it here — fix the SDK instead.
- **Idempotence is your responsibility.** The hook may run more than once per CLI session (e.g. `verify` parses the spec twice when `--old-spec` is provided). Write transforms that no-op cleanly when applied to an already-patched document.
- **No type narrowing.** `OpenApiDocument` is intentionally `Record<string, unknown>`. Cast aggressively at use sites; the alternative would be importing OpenAPI's full type tree, which we deliberately avoid in oagen's public surface.
- **Surfaces in every command.** `parse`, `generate`, `diff`, `resolve`, `verify`, and `compat-extract` all honor `transformSpec` from the config file.
