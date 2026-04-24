---
name: generate-smoke-test
description: Create a smoke test script for a new SDK language that verifies wire-level HTTP parity against the OpenAPI spec and live API baseline. Use when adding smoke tests for a new language, verifying a generated SDK against the real API, or checking HTTP request/response correctness. Also triggers for "integration test", "wire-level test", "HTTP parity", or "end-to-end SDK test".
---

# /generate-smoke-test

Create a self-contained smoke test script for a new SDK language that captures wire-level HTTP request/response pairs and compares them against the raw API baseline or spec-only baseline.

## Overview

Each language's smoke test is a single file: `smoke/sdk-{lang}.ts` **in the emitter project**. It uses the target language's native HTTP interception to capture what the SDK actually sends over the wire, then outputs `SmokeResults` JSON. The diff tool compares this against a baseline and reports mismatches by severity.

The script is self-contained — no proxy, no subprocess protocol, no separate driver. It imports shared infrastructure from `@workos/oagen/smoke` and implements language-specific parts inline.

## Resolve Paths

**Emitter project:** Use the `project` argument if provided, otherwise use `AskUserQuestion`.

**oagen core:** Check for `node_modules/@workos/oagen/`, or `src/engine/types.ts` in the current directory, otherwise ask.

## Prerequisites

Read and understand these files before writing any code:

1. **`@workos/oagen/smoke`** (exported from `{oagen}/scripts/smoke/shared.ts`) — `parseSpec()`, `planOperations()`, `generatePayload()` / `generateCamelPayload()`, `generateQueryParams()` / `generateCamelQueryParams()`, `IdRegistry`, `getExpectedStatusCodes()` / `isUnexpectedStatus()`, `resolvePath()`, `CapturedExchange`, `SmokeResults`

2. **Existing smoke scripts (read via subagent)** — Use the `Agent` tool with `subagent_type: Explore` to study the closest existing smoke script. This keeps ~630+ lines of reference source out of the main context:

   > Read the smoke scripts in `{emitterProject}/smoke/` (e.g., `sdk-node.ts`, `sdk-ruby.ts`). For the closest one to {language}, return: purpose, exported function signatures, structural pattern (setup → intercept → iterate → capture → cleanup), key abstractions (MethodResolution, SERVICE_MAP, interceptFetch, buildArgs), and which parts are language-specific vs. reusable. Be concise.

   The Node script is the canonical reference (~630 lines) covering:
   - `MethodResolution` interface and 4-tier resolution: manifest, exact match, CRUD prefix, keyword fuzzy
   - `SERVICE_MAP` — IR service names to SDK property names
   - `interceptFetch()` — HTTP interception with provenance capture
   - `buildArgs()` — argument construction from IR operations

3. **`{oagen}/scripts/smoke/raw.ts`** — raw baseline script
4. **`{oagen}/scripts/smoke/diff.ts`** — diff tool severity levels (CRITICAL/WARNING/INFO)
5. **`docs/sdk-architecture/{language}.md`** (in emitter project) — target language patterns and HTTP client

## Resolve Spec Path

Determine the location of the OpenAPI spec before doing anything:

1. If the `spec` argument was provided, use that.
2. Otherwise, use `AskUserQuestion`: "Where is your OpenAPI spec located? (absolute or relative path, e.g. `../openapi.yaml`)"

Store it as `spec`.

## Step 1: Determine HTTP Interception Strategy

The interception must capture the raw request (method, path, query params, body) and raw response (status, body). Choose based on the target language's SDK:

- **Node:** Patch `globalThis.fetch`
- **Ruby:** WebMock `stub_request` or monkey-patch `Net::HTTP`
- **Python:** `responses`, `respx` (for httpx), or `unittest.mock.patch`
- **Go:** Custom `http.RoundTripper`
- **Java/Kotlin:** OkHttp `Interceptor`

The interception code is typically ~20-30 lines. It must capture the request as-sent, let the real HTTP call proceed, capture the response, and store both in a `currentCapture` variable.

## Step 2: Build the SERVICE_MAP

Map IR service names to SDK resource accessors. There are two sources of truth depending on the SDK:

### Generated SDK (preferred)

For emitter-generated SDKs, the `operations` field in `.oagen-manifest.json` (produced by the emitter's `buildOperationsMap` hook) contains the authoritative `service` field for every operation. The smoke test should load this manifest and use its service mappings. The `SERVICE_MAP` only needs fallback entries for services not covered by the manifest.

If no operations map exists, warn the user: the emitter should implement `buildOperationsMap`. Without it, most operations will be skipped because heuristic method resolution fails on disambiguated names.

### Live/hand-written SDK

If `sdk_path` points to a hand-written SDK (not emitter-generated), **delegate the exploration to a subagent** to discover accessor names:

Use the `Agent` tool with `subagent_type: Explore` and a prompt like:

> Explore the SDK at `{sdk_path}`. Focus specifically on: the main client class, its resource accessor properties/methods, and how they map to domain names. Return a mapping of resource names to accessor names (e.g., Organizations → "organizations", Connections → "sso"). Only report what you actually find.

Then build the mapping:

```typescript
const SERVICE_MAP: Record<string, string> = {
  Organizations: "organizations",
  Connections: "sso",
};
```

Each language's SDK will have different accessor names — discover them by reading the SDK's client class.

## Step 3: Implement SDK Method Resolution

Adapt the 4-tier resolution to the target language's naming conventions:

0. **Manifest match** — Load the `operations` map from `.oagen-manifest.json` in the SDK output directory (emitter-generated, not hand-maintained). This is the **primary** resolution path for generated SDKs. The manifest maps every `HTTP_METHOD /path` to `{ sdkMethod, service }` and is produced by the emitter's `buildOperationsMap` hook. If the operations map is missing, warn and fall through to heuristic tiers.
1. **Exact match** — IR operation name converted to target convention
2. **CRUD prefix match** — standard verbs (create, list, retrieve/get, update, delete) with service name tiebreaker
3. **Keyword fuzzy match** — stem words and score overlap

Key convention differences: Ruby/Python use `snake_case`, Go uses `PascalCase`, Node uses `camelCase`.

Each resolution records provenance metadata (`ExchangeProvenance`) so findings can be traced back to the resolution path.

## Step 4: Implement Argument Construction

Build SDK call arguments from IR operations (reference `buildArgs()` in existing smoke scripts):

- No path params + has body → `method(payload)`
- No path params + has query params → `method(queryOpts)`
- Single path param, no body/query → `method(id)` (positional)
- Complex (path params + body/query) → `method(mergedOptions)`
- Idempotent POST → append empty options object for idempotency key

Choose the right payload convention: Node uses `generateCamelPayload()`, Ruby/Python may use `generatePayload()` directly (snake_case).

## Step 5: Write `smoke/sdk-{lang}.ts`

Create the script **in the emitter project**:

1. Imports from `@workos/oagen/smoke`
2. HTTP interception setup
3. `main()` function:
   - Parse CLI args, validate API key
   - Parse spec via `parseSpec()`
   - Load operations map from `{sdk-path}/.oagen-manifest.json` (emitter-generated). If missing, log a warning — method resolution will rely on heuristic tiers and most operations will likely be skipped.
   - Load and configure the SDK
   - Iterate `planOperations()` groups
   - For each operation: resolve SDK method, resolve path params, build args, call SDK, capture exchange
   - Extract IDs via `ids.extractAndStore()`
   - Track POST creates for cleanup
   - Cleanup created entities in reverse
   - Restore original HTTP behavior
   - Write `smoke-results-sdk-{lang}.json`
4. Summary output (successes, errors, skipped, unexpected statuses)

## Step 6: Register the Smoke Runner

Add the smoke runner path to the plugin bundle export (e.g., `src/plugin.ts`):

```typescript
// src/plugin.ts
export const workosEmittersPlugin = {
  smokeRunners: {
    // existing runners...
    {language}: path.join(smokeDir, 'sdk-{language}.ts'),
  },
  // ...
};
```

The consumer project's `oagen.config.ts` imports the plugin bundle, so the new smoke runner is automatically available.

## Step 7: Validate

```bash
# Offline validation against spec baseline (no API key needed)
oagen verify --lang {lang} --output {sdk-path} --spec <spec>

# Live validation against real API (requires API key and raw baseline)
oagen verify --lang {lang} --output {sdk-path} --raw-results smoke-results-raw.json
```

## Emitter-Fixing Loop

During initial setup, run `oagen generate` then the smoke test until skips are minimized:

```bash
oagen generate --lang {lang} --output {sdk-path} --spec {spec} --namespace {ns}
# The emitter writes the operations map into .oagen-manifest.json — the smoke test loads it automatically.
oagen verify --lang {lang} --output {sdk-path} --spec {spec}
```

If many operations are skipped with "No matching SDK method", check that the emitter's `buildOperationsMap` is implemented and that `.oagen-manifest.json` contains an `operations` field. The operations map is the primary mechanism the smoke test uses to find SDK methods.

| Exit | Meaning       | Output                      | Action                                  |
| ---- | ------------- | --------------------------- | --------------------------------------- |
| 0    | Clean         | —                           | Done                                    |
| 1    | Findings      | `smoke-diff-findings.json`  | Read findings, fix emitter/smoke script |
| 2    | Compile error | `smoke-compile-errors.json` | Read errors, fix emitter                |

See `scripts/smoke/README.md` (in oagen core) for the full remediation guide. See [Workflows](../../docs/architecture/workflows.md) for the overall workflow diagram.

## Output

This skill produces, in the emitter project:

- `smoke/sdk-{language}.ts` — self-contained smoke test script
- Updated plugin bundle (`src/plugin.ts`) with the smoke runner path registered
