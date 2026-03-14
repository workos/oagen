# Smoke Tests

Smoke tests verify that a generated SDK produces matching request behavior (HTTP method, path, query params, body keys) compared to raw HTTP calls against the target API. Response checks (status code, body keys) are INFO-level and non-blocking. Headers are not compared.

## Prerequisites

- `${NAMESPACE}_API_KEY` (or `API_KEY`) — set via a `.env` file in the project root (auto-loaded) or as an environment variable. The namespace is derived from the spec name (e.g. "WorkOS API" → `WORKOS_API_KEY`).
- `OPENAPI_SPEC_PATH` — path to the OpenAPI spec file (YAML or JSON), set via `.env` or environment variable
- For SDK tests: a built copy of the target SDK
- Optionally: `--smoke-config <path>` (or `SMOKE_CONFIG` env var) pointing to a JSON config file for skip lists, service priority, and service property mappings

## Two-Phase Workflow

### Phase 1: Generate a baseline

Choose one:

**Raw baseline (live API):** Calls the target API and captures ground-truth request/response pairs. Re-run only when the API spec changes.

```bash
npm run smoke:raw
```

Writes `smoke-results-raw.json`.

**Spec-only baseline (offline):** Generates expected request structure from the OpenAPI spec alone — no API key or network access needed. See [Spec-Only Baseline](#spec-only-baseline) below.

```bash
npm run smoke:baseline
```

Writes `smoke-results-spec-baseline.json`.

### Phase 2: Test the SDK against the baseline

```bash
# Against raw baseline (default)
npm run smoke -- --lang node --sdk-path ../path/to/sdk

# Against spec-only baseline
npm run smoke -- --lang node --sdk-path ../path/to/sdk --raw-results smoke-results-spec-baseline.json
```

---

## Smoke Config

A smoke config JSON file lets you customize skip lists, service priority, and service-to-SDK-property mappings. Pass it via `--smoke-config <path>` or the `SMOKE_CONFIG` env var.

```json
{
  "skipOperations": ["operationToSkip"],
  "skipServices": ["ServiceToSkip"],
  "servicePriority": { "ImportantService": 10 },
  "servicePropertyMap": { "IRServiceName": "sdkPropertyName" },
  "paramServiceMap": { "paramName": "ServiceName" }
}
```

Without a config file, no operations or services are skipped, all services have equal priority (50), and SDK properties are resolved via `toCamelCase(serviceName)`.

For WorkOS, use the bundled config:

```bash
npm run smoke:raw -- --smoke-config scripts/smoke/smoke.config.workos.json
```

---

## Spec-Only Baseline

The spec-only baseline generates expected request structure from the OpenAPI spec without hitting a live API. For each planned operation it writes:

- `request.method` — from the operation's HTTP method
- `request.path` — with `<ID>` placeholders for path params
- `request.queryParams` — from required query params + `limit=1` for paginated ops
- `request.body` — expected body keys/structure from the request body model
- `response.status` — default success status (201 for POST, 200 for GET, etc.)
- `response.body` — `null` (unknown without the API)

This enables offline verification of CRITICAL checks (method, path, query params, body keys) during development. Response-side checks (INFO-level) will show as "differs" since the baseline has null response bodies — that's expected and non-blocking.

```bash
npm run smoke:baseline
npm run smoke -- --lang node --sdk-path ../path/to/sdk --raw-results smoke-results-spec-baseline.json
```

---

## Individual Steps

### Raw HTTP (`smoke/raw.ts`)

Calls the real API directly via `fetch` and captures request/response pairs.

```bash
npm run smoke:raw
```

Outputs `smoke-results-raw.json`.

### Spec-Only Baseline (`smoke/baseline.ts`)

Generates expected request structure from the spec alone.

```bash
npm run smoke:baseline
```

Outputs `smoke-results-spec-baseline.json`.

### SDK Test (`smoke/sdk-{lang}.ts`)

Each language has a self-contained smoke test script that uses the target language's native HTTP interception to capture wire-level request/response pairs.

```bash
npm run smoke:sdk:node -- --sdk-path ../path/to/sdk
```

Outputs `smoke-results-sdk-{lang}.json`.

### Diff (`smoke/diff.ts`)

Compares two result files and reports discrepancies.

```bash
npx tsx scripts/smoke/diff.ts --raw path/to/raw.json --sdk path/to/sdk.json
```

Exit code 0 if no critical mismatches and no operations missing from the SDK, 1 otherwise.

---

## Environment Variables

All variables can be set in a `.env` file in the project root. The smoke scripts auto-load it (existing env vars take precedence).

| Variable                            | Default                 | Description                                                                          |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `${NAMESPACE}_API_KEY` or `API_KEY` | (required)              | API key for authentication. Namespace is derived from spec name.                     |
| `OPENAPI_SPEC_PATH`                      | (required)              | Path to the OpenAPI spec file (YAML or JSON). Can also be passed as `--spec <path>`. |
| `${NAMESPACE}_BASE_URL`             | spec's `servers[0].url` | Override the API base URL.                                                           |
| `SMOKE_CONFIG`                      | (optional)              | Path to smoke config JSON file. Can also be passed as `--smoke-config <path>`.       |
| `SMOKE_DELAY_MS`                    | `200`                   | Delay between requests (rate limiting)                                               |

---

## How It Works

The smoke test pipeline has 5 steps:

1. **Parse** — Read the OpenAPI spec into IR
2. **Plan** — Order operations by dependency and lifecycle (creates before gets, parent services before children)
3. **Execute** — Run each operation via raw HTTP or SDK, capturing request/response pairs
4. **Chain** — Extract IDs from responses to fill path params in subsequent operations
5. **Diff** — Compare raw baseline against SDK output by severity level

### Smoke Manifest

If the emitter implements `generateManifest`, a `smoke-manifest.json` file is generated alongside the SDK. This manifest maps `operationId`s directly to SDK method names and service accessors, providing deterministic method resolution (tier 0) that bypasses the heuristic exact/CRUD-prefix/fuzzy matching. The SDK smoke test loads the manifest automatically if present.

### Pre-flight Type Check

For TypeScript SDKs, `sdk-test.ts` runs a `tsc --noEmit` pre-flight check before executing the smoke test. This catches type errors in the generated SDK before any runtime testing begins.

### Validation

`npm run smoke:validate` performs an independent round-trip validation against the raw OpenAPI spec (loaded directly via `@redocly/openapi-core`, not via `parseSpec`). It validates SDK smoke results against the spec without needing a raw baseline.

---

## Diff Severity Levels

| Severity     | What's Compared                                    |
| ------------ | -------------------------------------------------- |
| **CRITICAL** | HTTP method, path, query params, request body keys |
| **WARNING**  | Request body values (on deterministic fields)      |
| **INFO**     | Response status code, response body keys           |

## Results File Format

Both `smoke-results-raw.json` and `smoke-results-sdk-{lang}.json` contain a `SmokeResults` object with an array of `CapturedExchange` records. Each exchange records the request sent, the response received, and outcome metadata:

- **`outcome`**: `"success"` (2xx), `"api-error"` (4xx/5xx or network failure), or `"skipped"` (missing path params or no SDK mapping)
- **`unexpectedStatus`**: `true` when the response status code is not declared in the OpenAPI spec for that operation. Only present when `true`.
- **`expectedStatusCodes`**: The status codes declared in the spec (success + error codes). Only present when `unexpectedStatus` is `true`.
- **`provenance`**: (SDK results only) Records how the SDK method was resolved — includes `resolutionTier` (`exact`, `crud-prefix`, `fuzzy`, or `manifest`), `resolutionConfidence`, and the `sdkMethodName` used.

The console summary also reports the count of unexpected status codes, cleanup failures, and lists each unexpected status:

```
Results: 30 success, 80 api-error, 48 skipped, 5 unexpected status, 2 cleanup failures

Unexpected status codes:
  Organizations.retrieve: got 404, expected 200/201/422
```

## Skipped Operations

Operations requiring complex preconditions (OAuth flows, magic auth, password resets, etc.) can be skipped via the smoke config file. See the `skipOperations` and `skipServices` fields in the config JSON.

## Asymmetric Skips

When an operation is skipped in one result set but executed in the other, the diff emits a CRITICAL finding. This catches cases where the SDK can't resolve an operation that raw HTTP handled (or vice versa). Both-skipped operations are reported separately and are non-blocking.

## Missing Operations

Operations present in one result set but absent from the other are tracked as `missingFromSdk` or `missingFromRaw` arrays in the findings file. Operations missing from the SDK result fail the build (exit code 1), since they indicate the SDK did not attempt an operation that the baseline covered. Operations missing from raw are reported but non-blocking.

---

## Adding a New Language

Use the skill: `/generate-smoke-test <language>` — it walks through HTTP interception strategy, SERVICE_MAP discovery, method resolution, argument construction, and creates a self-contained `scripts/smoke/sdk-{lang}.ts` script.

Each language's smoke test is a single file that:

1. Imports shared infrastructure from `shared.ts` (operation planning, payload generation, ID registry)
2. Sets up HTTP interception native to the target language/SDK
3. Iterates planned operations, calling SDK methods and capturing exchanges
4. Writes `smoke-results-sdk-{lang}.json`

The `sdk-test.ts` orchestrator auto-discovers scripts by convention: `--lang ruby` resolves to `scripts/smoke/sdk-ruby.ts`.

---

## Verify-and-Fix Loop

The iterative pattern for verifying a generated SDK against the API:

```
loop:
  1. Generate SDK:
     oagen generate --lang {lang} --spec {spec} --output {sdk-path} --namespace {ns}

  2. Run smoke test + diff:
     npm run smoke -- --lang {lang} --sdk-path {path}
     (exits 0 = clean, exits 1 = CRITICAL findings)

  3. If exit code 1, read smoke-diff-findings.json. Each CRITICAL maps to an emitter fix:
     - "HTTP method differs" → fix resources.ts method generation
     - "Request path structure differs" → fix path interpolation in resources.ts
     - "Query parameters differ" → fix query param serialization
     - "Request body key sets differ" → fix model serialization or payload construction

  4. Fix the emitter code in src/emitters/{lang}/

  5. Go to step 1
```

**Mechanical gates:**

- `diff.ts` exits 1 on CRITICALs, `sdk-test.ts` propagates that exit code
- `diff.ts` always writes `smoke-diff-findings.json` — structured findings that survive across conversations

**Cross-session handoff:** If context gets noisy after many iterations, start a fresh conversation. The findings file is the primary handoff state — it includes CRITICAL/WARNING/INFO findings plus `missingFromSdk` and `missingFromRaw` operation lists, a `configuration` block (listing `skipOperations` and `skipServices` sets), and a `coverage` summary (total operations, exercised count, skip count, percentages). Read it to see what's broken, fix those emitter files, re-run the loop.

For offline iteration (no API key needed), use the spec-only baseline instead of the raw baseline:

```bash
npm run smoke:baseline
npm run smoke -- --lang {lang} --sdk-path {path} --raw-results smoke-results-spec-baseline.json
```
