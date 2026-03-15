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

2. **Existing smoke scripts** — Check `{emitterProject}/smoke/` for any existing scripts (e.g., `sdk-node.ts`, `sdk-ruby.ts`). Study the closest one to your target language. The Node script is the canonical reference (~630 lines) covering:
   - `MethodResolution` interface and 4-tier resolution: manifest, exact match, CRUD prefix, keyword fuzzy
   - `SERVICE_MAP` — IR service names to SDK property names
   - `interceptFetch()` — HTTP interception with provenance capture
   - `buildArgs()` — argument construction from IR operations

3. **`{oagen}/scripts/smoke/raw.ts`** — raw baseline script
4. **`{oagen}/scripts/smoke/diff.ts`** — diff tool severity levels (CRITICAL/WARNING/INFO)
5. **`docs/sdk-architecture/{language}.md`** (in emitter project) — target language patterns and HTTP client

## Step 1: Determine HTTP Interception Strategy

The interception must capture the raw request (method, path, query params, body) and raw response (status, body). Choose based on the target language's SDK:

- **Node:** Patch `globalThis.fetch`
- **Ruby:** WebMock `stub_request` or monkey-patch `Net::HTTP`
- **Python:** `responses`, `respx` (for httpx), or `unittest.mock.patch`
- **Go:** Custom `http.RoundTripper`
- **Java/Kotlin:** OkHttp `Interceptor`

The interception code is typically ~20-30 lines. It must capture the request as-sent, let the real HTTP call proceed, capture the response, and store both in a `currentCapture` variable.

## Step 2: Build the SERVICE_MAP

Map IR service names to SDK resource accessors. Explore the SDK at `sdk_path` (if provided) to discover the mapping:

```typescript
const SERVICE_MAP: Record<string, string> = {
  Organizations: "organizations",
  Connections: "sso",
};
```

Each language's SDK will have different accessor names — discover them by reading the SDK's client class.

## Step 3: Implement SDK Method Resolution

Adapt the 4-tier resolution to the target language's naming conventions:

0. **Manifest match** — If `smoke-manifest.json` exists, use it for deterministic resolution (preferred)
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

Add to `oagen.config.ts`:

```typescript
const config: OagenConfig = {
  emitters: [/* ... */],
  smokeRunners: {
    {language}: './smoke/sdk-{language}.ts',
  },
};
```

## Step 7: Validate

```bash
# Offline validation against spec baseline (no API key needed)
oagen verify --lang {lang} --output {sdk-path} --spec <spec>

# Live validation against real API (requires API key and raw baseline)
oagen verify --lang {lang} --output {sdk-path} --raw-results smoke-results-raw.json
```

## Emitter-Fixing Loop

During initial setup, run `oagen generate` then `oagen verify` until verify exits 0:

```bash
oagen generate --lang {lang} --output {sdk-path} --spec {spec} --namespace {ns}
oagen verify --lang {lang} --output {sdk-path} --spec {spec}
```

| Exit | Meaning             | Output                      | Action                          |
| ---- | ------------------- | --------------------------- | ------------------------------- |
| 0    | Clean               | —                           | Done                            |
| 1    | Findings            | `smoke-diff-findings.json`  | Read findings, fix emitter/smoke script |
| 2    | Compile error       | `smoke-compile-errors.json` | Read errors, fix emitter        |

See `scripts/smoke/README.md` (in oagen core) for the full remediation guide. See [Workflows](../../docs/architecture/workflows.md) for the overall workflow diagram.
