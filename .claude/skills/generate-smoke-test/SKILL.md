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
---

# /generate-smoke-test

Create a self-contained smoke test script for a new SDK language that captures wire-level HTTP request/response pairs and compares them against the raw API baseline or spec-only baseline.

## Overview

Each language's smoke test is a single file: `scripts/smoke/sdk-{lang}.ts`. It uses the target language's native HTTP interception to capture what the SDK actually sends over the wire, then outputs `SmokeResults` JSON. The diff tool compares this against a baseline (raw API or spec-only) and reports mismatches by severity.

The script is self-contained — no proxy, no subprocess protocol, no separate driver. It imports shared infrastructure from `shared.ts` (operation planning, payload generation, ID registry) and implements language-specific parts inline.

## Step 0: Read prerequisite files

Before writing any code, read and understand these files thoroughly:

1. **`scripts/smoke/shared.ts`** — All shared infrastructure:
   - `planOperations()` — orders operations by dependency and lifecycle
   - `generatePayload()` / `generateCamelPayload()` — request body generation (snake_case / camelCase)
   - `generateQueryParams()` / `generateCamelQueryParams()` — query param generation
   - `IdRegistry` — stores and resolves IDs for operation chaining
   - `getExpectedStatusCodes()` / `isUnexpectedStatus()` — status code validation
   - `resolvePath()` — path parameter interpolation
   - `CapturedExchange`, `SmokeResults` — output types

2. **`scripts/smoke/sdk-node.ts`** — The reference implementation (~630 lines). Study thoroughly:
   - `MethodResolution` interface and 4-tier resolution: manifest → exact → CRUD prefix → keyword fuzzy
   - `loadManifest()` / `resolveFromManifest()` — deterministic resolution from `smoke-manifest.json`
   - `resolveExactMatch()` / `resolveCrudPrefix()` / `resolveFuzzyMatch()` — heuristic fallback tiers
   - `SERVICE_MAP` — IR service names → SDK property names
   - `interceptFetch()` — Fetch interception (captures raw request/response with provenance)
   - `buildArgs()` — Argument construction (how to build SDK call args from IR operations)

3. **`scripts/smoke/raw.ts`** — The raw baseline script for comparison

4. **`scripts/smoke/baseline.ts`** — The spec-only baseline (offline mode)

5. **`scripts/smoke/diff.ts`** — The diff tool:
   - CRITICAL: method, path, query params, body keys
   - WARNING: body values (deterministic fields)
   - INFO: response status, response body keys

6. **`docs/sdk-designs/{language}.md`** — Target language patterns, HTTP client, test framework

7. **`src/emitters/{language}/manifest.ts`** — If the emitter has a manifest generator, study it to understand the `smoke-manifest.json` format

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

- Node uses `generateCamelPayload()` / `generateCamelQueryParams()` from `shared.ts`
- Ruby/Python may use `generatePayload()` / `generateQueryParams()` directly (snake_case)
- Other languages may need a custom convention converter

## Step 5: Write `scripts/smoke/sdk-{lang}.ts`

Create the script following the structure of `sdk-node.ts`:

1. **Imports** from `shared.ts` (planOperations, payload generators, IdRegistry, etc.)
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

## Step 6: Validate

```bash
# Offline validation against spec baseline (no API key needed)
npm run smoke:baseline
npm run smoke -- --lang {lang} --sdk-path {path} --raw-results smoke-results-spec-baseline.json

# Live validation against real API
npm run smoke:raw
npm run smoke -- --lang {lang} --sdk-path {path}
```

The existing `sdk-test.ts` auto-discovers `scripts/smoke/sdk-{lang}.ts` by convention.

## Step 7: Verify-and-fix loop

This is the iterative verification pattern. Run until the diff reports zero CRITICAL findings:

```
loop:
  1. Generate SDK:
     oagen generate --lang {lang} --spec {spec} --output {sdk-path} --namespace {ns}

  2. Run smoke test + diff:
     npm run smoke -- --lang {lang} --sdk-path {path}
     (exits 0 = clean, exits 1 = CRITICAL findings)

  3. If exit code 1, read smoke-diff-findings.json. Each CRITICAL finding maps to an emitter fix:
     - "HTTP method differs" → fix resources.ts method generation
     - "Request path structure differs" → fix path interpolation in resources.ts
     - "Query parameters differ" → fix query param serialization
     - "Request body key sets differ" → fix model serialization or payload construction

  4. Fix the emitter code in src/emitters/{lang}/

  5. Go to step 1
```

**Mechanical gates:**

- `diff.ts` exits 1 on CRITICALs, `sdk-test.ts` propagates that exit code
- `diff.ts` always writes `smoke-diff-findings.json` to disk — structured findings that survive across conversations

**Cross-session handoff:** If the conversation runs long or context gets noisy, start a fresh conversation. The findings file is the handoff state — read `smoke-diff-findings.json` to see exactly what's broken, fix those specific emitter files, then re-run the loop. No intermediate history needed.
