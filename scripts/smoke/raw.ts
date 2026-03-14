/**
 * Raw HTTP smoke test.
 *
 * Calls the target API directly via fetch, captures request/response pairs.
 *
 * Usage:
 *   OPENAPI_SPEC_PATH=path/to/spec.yaml npm run smoke:raw
 */

import { writeFileSync } from 'node:fs';
import { parseSpec } from '../../src/parser/parse.js';
import {
  planOperations,
  generatePayload,
  generateQueryParams,
  resolvePath,
  delay,
  parseCliArgs,
  loadSmokeConfig,
  IdRegistry,
  getExpectedStatusCodes,
  isUnexpectedStatus,
  type CapturedExchange,
  type SmokeResults,
} from './shared.js';

const DELAY_MS = Number(process.env.SMOKE_DELAY_MS ?? '200');
const TIMEOUT_MS = 30_000;

async function main() {
  const { spec: specPath, smokeConfig } = parseCliArgs();
  loadSmokeConfig(smokeConfig);

  console.log('Parsing spec...');
  const spec = await parseSpec(specPath);

  // Derive env var namespace from spec name: "WorkOS API" → "WORKOS"
  const ns = spec.name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .replace(/_?API$/, '');
  const apiKey = process.env[`${ns}_API_KEY`] ?? process.env.API_KEY;
  if (!apiKey) {
    console.error(`API key is required. Set ${ns}_API_KEY or API_KEY environment variable.`);
    process.exit(1);
  }

  const baseUrl = process.env[`${ns}_BASE_URL`] || spec.baseUrl;

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Spec: ${spec.name} v${spec.version}`);

  const groups = planOperations(spec);
  const ids = new IdRegistry();
  const exchanges: CapturedExchange[] = [];
  const cleanupOps: Array<{ url: string; method: string }> = [];

  console.log(
    `\nPlanned ${groups.reduce((n, g) => n + g.operations.length, 0)} operations across ${groups.length} services\n`,
  );

  for (const group of groups) {
    console.log(`\n--- ${group.service} ---`);

    for (const planned of group.operations) {
      const op = planned.operation;
      const operationId = `${group.service}.${op.name}`;

      // Resolve path params
      let pathParams: Record<string, string> = {};
      if (op.pathParams.length > 0) {
        const resolved = ids.resolvePathParams(op, group.service);
        if (!resolved) {
          console.log(`  SKIP ${op.name} (missing path params)`);
          exchanges.push({
            operationId,
            service: group.service,
            operationName: op.name,
            request: { method: op.httpMethod.toUpperCase(), path: op.path, queryParams: {}, body: null },
            response: { status: 0, body: null },
            outcome: 'skipped',
            error: 'Missing path parameters',
            durationMs: 0,
          });
          continue;
        }
        pathParams = resolved;
      }

      const path = resolvePath(op, pathParams);
      const queryParams = generateQueryParams(op, spec);
      const body = generatePayload(op, spec);

      // Build URL
      const url = new URL(path, baseUrl);
      for (const [key, value] of Object.entries(queryParams)) {
        url.searchParams.set(key, value);
      }

      const method = op.httpMethod.toUpperCase();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };

      const start = Date.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const fetchInit: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };
        if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
          fetchInit.body = JSON.stringify(body);
        }

        const response = await fetch(url.toString(), fetchInit);
        clearTimeout(timeout);

        const responseBody = await response.json().catch(() => null);
        const durationMs = Date.now() - start;
        const isError = response.status >= 400;

        // Capture the exchange
        const unexpected = isUnexpectedStatus(response.status, op);
        const exchange: CapturedExchange = {
          operationId,
          service: group.service,
          operationName: op.name,
          request: {
            method,
            path,
            queryParams: Object.fromEntries(Array.from(url.searchParams.entries()).sort()),
            body,
          },
          response: {
            status: response.status,
            body: responseBody,
          },
          outcome: isError ? 'api-error' : 'success',
          durationMs,
        };
        if (isError) {
          exchange.error = `HTTP ${response.status}`;
        }
        if (unexpected) {
          exchange.unexpectedStatus = true;
          exchange.expectedStatusCodes = getExpectedStatusCodes(op);
        }

        exchanges.push(exchange);

        // Extract IDs for chaining (only top-level ops store service ID)
        if (!isError && responseBody) {
          ids.extractAndStore(group.service, responseBody, op.pathParams.length === 0);
        }

        // Track created entities for cleanup
        if (method === 'POST' && !isError && responseBody) {
          const respObj = responseBody as Record<string, unknown>;
          if (typeof respObj.id === 'string') {
            // Build a delete URL from the same path + id
            cleanupOps.push({ url: `${baseUrl}${path}/${respObj.id}`, method: 'DELETE' });
          }
        }

        const unexpectedTag = unexpected ? ' UNEXPECTED' : '';
        const status = isError ? `ERR ${response.status}` : `OK ${response.status}`;
        console.log(`  ${status} ${op.name} (${durationMs}ms)${unexpectedTag}`);
      } catch (err) {
        const durationMs = Date.now() - start;
        const errorMsg = err instanceof Error ? err.message : String(err);

        exchanges.push({
          operationId,
          service: group.service,
          operationName: op.name,
          request: { method, path, queryParams, body },
          response: { status: 0, body: null },
          outcome: 'api-error',
          error: errorMsg,
          durationMs,
        });

        console.log(`  FAIL ${op.name}: ${errorMsg} (${durationMs}ms)`);
      }

      await delay(DELAY_MS);
    }
  }

  // Cleanup: delete created entities in reverse order
  console.log('\n--- Cleanup ---');
  let cleanupFailures = 0;
  for (const cleanup of cleanupOps.reverse()) {
    try {
      await fetch(cleanup.url, {
        method: cleanup.method,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      console.log(`  Deleted: ${cleanup.url}`);
    } catch {
      cleanupFailures++;
      console.log(`  Failed to cleanup: ${cleanup.url}`);
    }
    await delay(DELAY_MS);
  }

  // Write results
  const results: SmokeResults = {
    source: 'raw',
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };

  writeFileSync('smoke-results-raw.json', JSON.stringify(results, null, 2));

  const successes = exchanges.filter((e) => e.outcome === 'success').length;
  const errors = exchanges.filter((e) => e.outcome === 'api-error').length;
  const skipped = exchanges.filter((e) => e.outcome === 'skipped').length;
  const unexpectedCount = exchanges.filter((e) => e.unexpectedStatus).length;

  console.log(
    `\nResults: ${successes} success, ${errors} api-error, ${skipped} skipped, ${unexpectedCount} unexpected status, ${cleanupFailures} cleanup failures`,
  );
  if (unexpectedCount > 0) {
    console.log('\nUnexpected status codes:');
    for (const e of exchanges.filter((e) => e.unexpectedStatus)) {
      console.log(`  ${e.operationId}: got ${e.response.status}, expected ${e.expectedStatusCodes?.join('/')}`);
    }
  }
  console.log('Written to smoke-results-raw.json');
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
