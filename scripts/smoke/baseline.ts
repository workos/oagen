/**
 * Spec-only baseline generator.
 *
 * Generates expected request structure from the OpenAPI spec alone — no live
 * API needed. Produces a SmokeResults file that the diff tool can compare
 * against SDK smoke test output for offline CRITICAL-level verification.
 *
 * Usage:
 *   OPENAPI_SPEC=path/to/spec.yaml npm run smoke:baseline
 */

import { writeFileSync } from 'node:fs';
import { parseSpec } from '../../src/parser/parse.js';
import {
  planOperations,
  generatePayload,
  generateQueryParams,
  resolvePath,
  parseCliArgs,
  type CapturedExchange,
  type SmokeResults,
} from './shared.js';

async function main() {
  const { spec: specPath } = parseCliArgs();

  console.log('Parsing spec...');
  const spec = await parseSpec(specPath);
  console.log(`Spec: ${spec.name} v${spec.version}`);

  const groups = planOperations(spec);
  const exchanges: CapturedExchange[] = [];

  for (const group of groups) {
    for (const planned of group.operations) {
      const op = planned.operation;
      const operationId = `${group.service}.${op.name}`;

      // Build path with placeholder IDs for path params
      const placeholderParams: Record<string, string> = {};
      for (const p of op.pathParams) {
        placeholderParams[p.name] = '<ID>';
      }
      const path = resolvePath(op, placeholderParams);

      const queryParams = generateQueryParams(op, spec);
      const body = generatePayload(op, spec);

      // Default success status by HTTP method
      const defaultSuccess: Record<string, number> = {
        post: 201,
        get: 200,
        put: 200,
        patch: 200,
        delete: 204,
      };
      const status = defaultSuccess[op.httpMethod] ?? 200;

      exchanges.push({
        operationId,
        service: group.service,
        operationName: op.name,
        request: {
          method: op.httpMethod.toUpperCase(),
          path,
          queryParams,
          body,
        },
        response: {
          status,
          body: null,
        },
        outcome: 'success',
        durationMs: 0,
      });
    }
  }

  const results: SmokeResults = {
    source: 'spec-baseline',
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };

  writeFileSync('smoke-results-spec-baseline.json', JSON.stringify(results, null, 2));

  console.log(`\nGenerated ${exchanges.length} operations from spec`);
  console.log('Written to smoke-results-spec-baseline.json');
}

main().catch((err) => {
  console.error('Baseline generation failed:', err);
  process.exit(1);
});
