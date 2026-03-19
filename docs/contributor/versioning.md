# Versioning and Migration

oagen has two different compatibility concerns. They should not be treated as interchangeable.

## 1. Package Version

The npm package version communicates overall release maturity and changelog history.

## 2. Advanced Workflow Compatibility

Compat extraction, overlays, smoke verification, and target integration are higher-level workflows built on top of the core framework. They may require narrower migration guidance than the core parser/emitter contract.

Treat changes here as public if they affect:

- documented CLI flags
- documented subpath exports
- persisted file formats such as extracted API surfaces or diagnostics files

## Compile-Time Safety

The primary compatibility mechanism is `assertNever`, which enforces exhaustive `switch` statements over `TypeRef.kind` at compile time. Adding a new IR variant causes build failures in any emitter that doesn't handle it.

## Migration Guidance

Every release that changes public behavior should describe:

1. what changed
2. who is affected
3. whether the change is core or advanced
4. what users need to update

At minimum, migration notes should call out:

- IR shape changes
- emitter contract changes
- config shape changes
- CLI flag changes
- compat JSON format changes

## Release Discipline

Before broadening the public surface:

1. decide whether the API belongs in the core entrypoint or an advanced subpath
2. document it
3. add tests that exercise its intended use by external consumers

If that discipline is too expensive, the API is not ready to be public.
