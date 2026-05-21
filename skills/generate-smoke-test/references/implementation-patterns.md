# Smoke Test Implementation Patterns

Concrete templates for the language-specific parts of a smoke test script. Adapt naming conventions and HTTP interception to the target language.

## Argument Construction (`buildArgs`)

Build SDK call arguments from IR operations. Choose payload generator based on target language: Node uses `generateCamelPayload()`, Ruby/Python use `generatePayload()` (snake_case).

```typescript
function buildArgs(op: OperationPlan, spec: ApiSpec): unknown[] {
  const pathParams = op.parameters.filter((p) => p.in === "path");
  const hasBody = !!op.requestBody;
  const hasQuery = op.parameters.some((p) => p.in === "query");

  if (pathParams.length === 0 && hasBody) return [generatePayload(op, spec)];
  if (pathParams.length === 0 && hasQuery) return [generateQueryParams(op)];
  if (pathParams.length === 1 && !hasBody && !hasQuery)
    return [ids.get(pathParams[0].schema) ?? "test_id"];
  // Complex: merge path params + body/query into options object
  const opts = { ...generatePayload(op, spec), ...resolvePathParams(op) };
  if (hasQuery) Object.assign(opts, generateQueryParams(op));
  // Idempotent POST: append empty options for idempotency key
  if (
    op.method === "post" &&
    op.parameters.some((p) => p.name === "idempotency_key")
  )
    return [opts, {}];
  return [opts];
}
```

## Smoke Script Structural Template

The complete structure for `smoke/sdk-{lang}.ts`:

```typescript
import {
  parseSpec,
  planOperations,
  generatePayload,
  generateQueryParams,
  IdRegistry,
  isUnexpectedStatus,
  resolvePath,
  type CapturedExchange,
  type SmokeResults,
} from "@workos/oagen/smoke";

let currentCapture: CapturedExchange | null = null;
const ids = new IdRegistry();

// Interception setup — see language table in SKILL.md Step 1

async function main() {
  const spec = await parseSpec(specPath);
  const opsMap = loadManifestOperations(sdkPath); // from Step 2
  const client = initSdk(apiKey);
  const results: SmokeResults = { exchanges: [], errors: [], skipped: [] };
  const cleanups: Array<() => Promise<void>> = [];

  for (const group of planOperations(spec)) {
    for (const op of group.operations) {
      const resolved = resolveMethod(op, opsMap, client); // Step 3
      if (!resolved) {
        results.skipped.push(op);
        continue;
      }
      const args = buildArgs(op, spec); // Step 4
      try {
        currentCapture = null;
        await resolved.fn(...args);
        if (currentCapture) {
          ids.extractAndStore(currentCapture.response);
          results.exchanges.push(currentCapture);
          if (op.method === "post")
            cleanups.push(() => deleteEntity(client, op));
        }
      } catch (e) {
        results.errors.push({ op, error: e });
      }
    }
  }
  for (const cleanup of cleanups.reverse()) await cleanup();
  writeFileSync(`smoke-results-sdk-{lang}.json`, JSON.stringify(results));
  printSummary(results); // successes, errors, skipped, unexpected statuses
}
```
