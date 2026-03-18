# Public API Policy

This document defines what oagen treats as public API for OSS consumers.

## Core Public API

The default `@workos/oagen` entrypoint is the core public API.

It includes:

- IR types and `IR_VERSION`
- parser entrypoints such as `parseSpec`
- emitter-facing types such as `Emitter`, `EmitterContext`, and `GeneratedFile`
- generation runtime entrypoints such as `generate`, `generateFiles`, and `generateIncremental`
- spec diffing APIs such as `diffSpecs` and `mapChangesToFiles`
- naming utilities used by emitters
- `planOperation`
- config typing needed by emitter projects

Changes to this surface require a deliberate compatibility review.

## Advanced Public API

The following APIs are public, but not part of the default entrypoint:

- `@workos/oagen/compat`
- `@workos/oagen/verify`

These modules cover compatibility overlays, extractor registration, built-in extractors, and verification helpers. They are supported, but they are more opinionated and may evolve faster than the core framework surface.

## Internal API

Anything not exported from a package entrypoint should be treated as internal implementation detail, including:

- deep imports into `src/*`
- CLI implementation modules
- parser internals below `parseSpec`
- compat internals below the documented compat entrypoint
- verify internals below the documented verify entrypoint

Internal APIs may change without notice.

## Documentation Rule

If an API is intended for external use, it must satisfy all of the following:

1. It is exported from a package entrypoint.
2. It is documented in user-facing docs.
3. It has tests that reflect the intended behavior.

If one of those is missing, the API should be considered provisional at best.

## Stability Rule

When in doubt:

- keep the default entrypoint small
- prefer adding advanced capabilities behind explicit subpaths
- avoid promoting internal helpers into the public surface unless they are needed by emitter authors
