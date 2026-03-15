---
name: generate-smoke-test
description: Create a smoke test script for a new SDK language that verifies wire-level HTTP parity against the OpenAPI spec and live API baseline. Use when adding smoke test support for a new language, or when asked to verify/test a generated SDK against the API.
arguments:
  - name: language
    description: Target language (e.g., "ruby", "python", "go")
    required: true
  - name: sdk_path
    description: Path to a built copy of the target SDK
    required: false
  - name: project
    description: Path to the emitter project (overrides oagen.config.ts emitterProject)
    required: false
---

# /generate-smoke-test

Create a self-contained smoke test script for a new SDK language that captures wire-level HTTP request/response pairs and compares them against the raw API baseline or spec-only baseline.

## Overview

Each language's smoke test is a single file: `smoke/sdk-{lang}.ts` **in the emitter project**. It uses the target language's native HTTP interception to capture what the SDK actually sends over the wire, then outputs `SmokeResults` JSON. The diff tool compares this against a baseline (raw API or spec-only) and reports mismatches by severity.

The script is self-contained — no proxy, no subprocess protocol, no separate driver. It imports shared infrastructure from `@workos/oagen/smoke` (operation planning, payload generation, ID registry, parseSpec, naming utilities) and implements language-specific parts inline.

## Resolve Emitter Project

Before doing anything else, determine the emitter project path:

1. If the `project` argument was provided, use that.
2. Otherwise, read `oagen.config.ts` in the current directory and check for `emitterProject`.
3. If neither exists, use `AskUserQuestion` to ask: "Where is your emitter project? (path relative to this repo, e.g. `../my-emitters`)"

Store it for use in all subsequent steps.

## Resolve oagen Core Path

Some steps below reference files in the oagen core package. Resolve the path once:

1. If `node_modules/@workos/oagen/` exists, use that as `{oagen}`.
2. If the current directory has `src/engine/types.ts`, you're in the oagen repo — use `.` as `{oagen}`.
3. Otherwise, ask: "Where is the @workos/oagen package installed?"

## Step 0: Read prerequisite files

Before writing any code, read and understand these files thoroughly:

1. **`@workos/oagen/smoke`** — All shared infrastructure (exported from `{oagen}/scripts/smoke/shared.ts`):
   - `parseSpec()` — parse an OpenAPI spec
   - `toCamelCase()`, `toSnakeCase()` — naming utilities
   - `planOperations()` — orders operations by dependency and lifecycle
   - `generatePayload()` / `generateCamelPayload()` — request body generation (snake_case / camelCase)
   - `generateQueryParams()` / `generateCamelQueryParams()` — query param generation
   - `IdRegistry` — stores and resolves IDs for operation chaining
   - `getExpectedStatusCodes()` / `isUnexpectedStatus()` — status code validation
   - `resolvePath()` — path parameter interpolation
   - `CapturedExchange`, `SmokeResults` — output types

2. **`{emitterProject}/smoke/sdk-node.ts`** — The reference implementation (~630 lines). Study thoroughly:
   - `MethodResolution` interface and 4-tier resolution: manifest → exact → CRUD prefix → keyword fuzzy
   - `loadManifest()` / `resolveFromManifest()` — deterministic resolution from `smoke-manifest.json`
   - `resolveExactMatch()` / `resolveCrudPrefix()` / `resolveFuzzyMatch()` — heuristic fallback tiers
   - `SERVICE_MAP` — IR service names → SDK property names
   - `interceptFetch()` — Fetch interception (captures raw request/response with provenance)
   - `buildArgs()` — Argument construction (how to build SDK call args from IR operations)

3. **`{oagen}/scripts/smoke/raw.ts`** — The raw baseline script for comparison

4. **`{oagen}/scripts/smoke/baseline.ts`** — The spec-only baseline (offline mode)

5. **`{oagen}/scripts/smoke/diff.ts`** — The diff tool:
   - CRITICAL: method, path, query params, body keys
   - WARNING: body values (deterministic fields)
   - INFO: response status, response body keys

6. **`docs/{language}.md`** (in emitter project) — Target language patterns, HTTP client, test framework

7. **The emitter's `manifest.ts`** — If the emitter has a manifest generator, study it to understand the `smoke-manifest.json` format

## Step 1: Determine HTTP interception strategy

The interception must capture the raw request (method, path, query params, body) and raw response (status, body) for each SDK call. Choose based on the target language's SDK:

- **Node**: Patch `globalThis.fetch` (see `interceptFetch()` in `sdk-node.ts`)
- **Ruby**: WebMock `stub_request` or monkey-patch `Net::HTTP`
- **Python**: `responses` library, `respx` (for httpx), or `unittest.mock.patch('requests.Session.request')`
- **Go**: Custom `http.RoundTripper` wrapping `http.DefaultTransport`
- **Java/Kotlin**: OkHttp `Interceptor`

The interception code is typically ~20-30 lines. It must:

1. Capture the request as-sent (after SDK serialization)
2. Let the real HTTP call proceed to the live API
3. Capture the response
4. Store both in a `currentCapture` variable the main loop reads

Ask the user or determine from the SDK design doc if the strategy isn't obvious.

## Step 2: Build the SERVICE_MAP

Map IR service names to SDK resource accessors. Explore the SDK at `sdk_path` (if provided) to discover the mapping. Reference `SERVICE_MAP` in `sdk-node.ts` as the pattern:

```typescript
const SERVICE_MAP: Record<string, string> = {
  Organizations: "organizations",
  Connections: "sso",
  // ...
};
```

Each language's SDK will have different accessor names — discover them by reading the SDK's client class.

## Step 3: Implement SDK method resolution

Adapt the 4-tier resolution from `sdk-node.ts` (manifest → exact match → CRUD prefix match → keyword fuzzy match) to the target language's naming conventions. Key considerations:

- Ruby/Python: methods are snake_case (`list_organizations`)
- Go: methods are PascalCase (`ListOrganizations`)
- Node: methods are camelCase (`listOrganizations`)

The resolution needs to handle: 0. **Manifest match** — If a `smoke-manifest.json` is present (generated by the emitter's `generateManifest`), use it for deterministic resolution. This is the preferred tier.

1. **Exact match** — IR operation name converted to target convention
2. **CRUD prefix match** — standard verbs (create, list, retrieve/get, update, delete) with service name tiebreaker
3. **Keyword fuzzy match** — for controller-style names, stem words and score overlap

Each resolution records provenance metadata (`ExchangeProvenance`) on the `CapturedExchange` — tier, confidence, and SDK method name — so findings can be traced back to the resolution path.

## Step 4: Implement argument construction

How to build SDK call arguments from IR operations. Reference `buildArgs()` in `sdk-node.ts`. The pattern:

- No path params + has body → `method(payload)`
- No path params + has query params → `method(queryOpts)`
- Single path param, no body/query → `method(id)` (positional)
- Complex (path params + body/query) → `method(mergedOptions)`
- Idempotent POST → append empty options object for idempotency key

Each language needs convention-appropriate payload generation:

- Node uses `generateCamelPayload()` / `generateCamelQueryParams()` from `@workos/oagen/smoke`
- Ruby/Python may use `generatePayload()` / `generateQueryParams()` directly (snake_case)
- Other languages may need a custom convention converter

## Step 5: Write `smoke/sdk-{lang}.ts`

Create the script **in the emitter project** at `smoke/sdk-{lang}.ts`, following the structure of `sdk-node.ts`:

1. **Imports** from `@workos/oagen/smoke` (parseSpec, toCamelCase, planOperations, payload generators, IdRegistry, etc.)
2. **HTTP interception setup** (from Step 1)
3. **`main()` function:**
   a. Parse CLI args, validate API key
   b. Parse spec via `parseSpec()`
   c. Load and configure the SDK
   d. Iterate `planOperations()` groups
   e. For each operation: resolve SDK method, resolve path params, build args, call SDK, capture exchange
   f. Extract IDs from responses via `ids.extractAndStore()`
   g. Track POST creates for cleanup
   h. Cleanup created entities in reverse
   i. Restore original HTTP behavior
   j. Write `smoke-results-sdk-{lang}.json`
4. **Summary output** (successes, errors, skipped, unexpected statuses)

### Import Convention

```typescript
import {
  parseSpec,
  toCamelCase,
  planOperations,
  generateCamelPayload,
  generateCamelQueryParams,
  delay,
  parseCliArgs,
  loadSmokeConfig,
  SERVICE_PROPERTY_MAP,
  IdRegistry,
  getExpectedStatusCodes,
  isUnexpectedStatus,
  type CapturedExchange,
  type ExchangeProvenance,
  type SmokeResults,
} from "@workos/oagen/smoke";
```

## Step 6: Register the smoke runner

Add the smoke runner to the project's `oagen.config.ts`:

```typescript
const config: OagenConfig = {
  emitters: [/* ... */],
  smokeRunners: {
    // existing runners...
    {language}: './smoke/sdk-{language}.ts',
  },
};
```

## Step 7: Validate

```bash
# Offline validation against spec baseline (no API key needed)
oagen verify --lang {lang} --output {sdk-path} --spec <spec>

# Live validation against real API (requires API key and raw baseline)
# Generate raw baseline from the oagen core repo, then verify:
oagen verify --lang {lang} --output {sdk-path} --raw-results smoke-results-raw.json
```

## Step 8: Emitter-fixing loop (during initial setup)

Run `oagen generate` then `oagen verify` until verify exits 0. This loop is
part of `/add-language` setup — once the emitter is stable, it's no longer needed.

```bash
oagen generate --lang {lang} --output {sdk-path} --spec {spec} --namespace {ns}
oagen verify --lang {lang} --output {sdk-path} --spec {spec}
```

`verify` does not generate — it only checks the already-generated SDK. If no
baseline exists, a spec-only baseline is generated automatically (offline, no
API key needed).

**Exit codes:**

| Code | Meaning                                       | Structured output           |
| ---- | --------------------------------------------- | --------------------------- |
| 0    | Clean — all checks passed                     | —                           |
| 1    | Findings — CRITICAL mismatches or missing ops | `smoke-diff-findings.json`  |
| 2    | Compile error — SDK failed type check         | `smoke-compile-errors.json` |

A remediation guide mapping finding types to fix locations is printed on failure.
See `scripts/smoke/README.md` (in oagen core) for the full table.

**Cross-session handoff:** If context gets noisy, start a fresh conversation.
Read `smoke-diff-findings.json` to see what's broken, fix those emitter files,
re-run.

See [Workflows](../../docs/architecture/workflows.md) for the full workflow diagram.
