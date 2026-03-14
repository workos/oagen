/**
 * Smoke test diff tool.
 *
 * Compares raw HTTP and SDK smoke test results, reports discrepancies.
 *
 * Usage:
 *   npx tsx scripts/smoke/diff.ts
 *   npx tsx scripts/smoke/diff.ts --raw path/to/raw.json --sdk path/to/sdk.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseSpec } from '../../src/parser/parse.js';
import { getSmokeConfig, loadSmokeConfig } from './shared.js';
import type { SmokeResults, CapturedExchange, ExchangeProvenance } from './shared.js';

// Fields that vary between calls and should be redacted before comparing
const REDACT_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'request_id',
  'idempotency_key',
  'after',
  'before',
  'token',
  'object',
]);

interface DiffFinding {
  operationId: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  field: string;
  message: string;
  rawValue?: unknown;
  sdkValue?: unknown;
  provenance?: ExchangeProvenance;
}

function parseArgs(): { rawPath: string; sdkPath: string; specPath?: string; smokeConfig?: string } {
  const args = process.argv.slice(2);
  const rawIdx = args.indexOf('--raw');
  const sdkIdx = args.indexOf('--sdk');
  const configIdx = args.indexOf('--smoke-config');

  return {
    rawPath: rawIdx !== -1 && args[rawIdx + 1] ? args[rawIdx + 1] : 'smoke-results-raw.json',
    sdkPath: sdkIdx !== -1 && args[sdkIdx + 1] ? args[sdkIdx + 1] : 'smoke-results-sdk-node.json',
    specPath: process.env.OPENAPI_SPEC_PATH,
    smokeConfig: configIdx !== -1 && args[configIdx + 1] ? args[configIdx + 1] : process.env.SMOKE_CONFIG,
  };
}

function redactBody(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  if (typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map(redactBody);

  const obj = body as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (REDACT_FIELDS.has(key)) {
      result[key] = '<redacted>';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactBody(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Normalize resource IDs in a path so that different IDs from separate test runs
 * don't cause false-positive mismatches.
 *
 * Handles:
 *  - WorkOS ULIDs: {prefix}_{ULID} (e.g. org_01HZDS...)
 *  - UUIDs: 550e8400-e29b-41d4-a716-446655440000
 *  - Numeric IDs: 4+ digit numbers in path segments (e.g. /users/12345)
 */
export function normalizePath(path: string): string {
  return path
    .replace(/[a-z][a-z_]*_[0-9][0-9A-Z]{25}/g, '<ID>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<ID>')
    .replace(/(?<=\/)\d{4,}\b/g, '<ID>');
}

function getKeys(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj).sort();
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();

  if (aKeys.length !== bKeys.length) return false;
  if (!aKeys.every((k, i) => k === bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}

function compareExchanges(raw: CapturedExchange, sdk: CapturedExchange): DiffFinding[] {
  const findings: DiffFinding[] = [];
  const opId = raw.operationId;

  // INFO: Warn about fuzzy method resolution
  if (sdk.provenance?.resolutionTier === 'fuzzy') {
    findings.push({
      operationId: opId,
      severity: 'INFO',
      field: 'resolution',
      message: `SDK method resolved via fuzzy matching (confidence: ${sdk.provenance.resolutionConfidence.toFixed(2)}, method: ${sdk.provenance.sdkMethodName})`,
      provenance: sdk.provenance,
    });
  }

  // CRITICAL: Method must match
  if (raw.request.method !== sdk.request.method) {
    findings.push({
      operationId: opId,
      severity: 'CRITICAL',
      field: 'request.method',
      message: 'HTTP method differs',
      rawValue: raw.request.method,
      sdkValue: sdk.request.method,
    });
  }

  // CRITICAL: Path structure must match (normalize resource IDs since raw/SDK runs
  // create different resources)
  const normalizedRawPath = normalizePath(raw.request.path);
  const normalizedSdkPath = normalizePath(sdk.request.path);
  if (normalizedRawPath !== normalizedSdkPath) {
    findings.push({
      operationId: opId,
      severity: 'CRITICAL',
      field: 'request.path',
      message: 'Request path structure differs',
      rawValue: raw.request.path,
      sdkValue: sdk.request.path,
    });
  }

  // CRITICAL: Query params must match (keys + values)
  if (!deepEqual(raw.request.queryParams, sdk.request.queryParams)) {
    findings.push({
      operationId: opId,
      severity: 'CRITICAL',
      field: 'request.queryParams',
      message: 'Query parameters differ',
      rawValue: raw.request.queryParams,
      sdkValue: sdk.request.queryParams,
    });
  }

  // CRITICAL: Request body keys must match
  const rawBodyKeys = getKeys(raw.request.body);
  const sdkBodyKeys = getKeys(sdk.request.body);
  if (!deepEqual(rawBodyKeys, sdkBodyKeys)) {
    findings.push({
      operationId: opId,
      severity: 'CRITICAL',
      field: 'request.body keys',
      message: 'Request body key sets differ',
      rawValue: rawBodyKeys,
      sdkValue: sdkBodyKeys,
    });
  }

  // WARNING: Request body values (deep equal on deterministic fields)
  if (raw.request.body && sdk.request.body && deepEqual(rawBodyKeys, sdkBodyKeys)) {
    const rawBody = raw.request.body as Record<string, unknown>;
    const sdkBody = sdk.request.body as Record<string, unknown>;
    for (const key of rawBodyKeys) {
      if (REDACT_FIELDS.has(key)) continue;
      // Skip name/slug fields as they have uniqueness markers
      if (key === 'name' || key === 'slug') continue;
      if (!deepEqual(rawBody[key], sdkBody[key])) {
        findings.push({
          operationId: opId,
          severity: 'WARNING',
          field: `request.body.${key}`,
          message: `Request body field "${key}" differs`,
          rawValue: rawBody[key],
          sdkValue: sdkBody[key],
        });
      }
    }
  }

  // INFO: Response status
  if (raw.response.status !== sdk.response.status) {
    findings.push({
      operationId: opId,
      severity: 'INFO',
      field: 'response.status',
      message: 'Response status code differs',
      rawValue: raw.response.status,
      sdkValue: sdk.response.status,
    });
  }

  // INFO: Response body keys (after redacting non-deterministic fields)
  const rawRespKeys = getKeys(redactBody(raw.response.body));
  const sdkRespKeys = getKeys(redactBody(sdk.response.body));
  if (!deepEqual(rawRespKeys, sdkRespKeys)) {
    findings.push({
      operationId: opId,
      severity: 'INFO',
      field: 'response.body keys',
      message: 'Response body key sets differ',
      rawValue: rawRespKeys,
      sdkValue: sdkRespKeys,
    });
  }

  return findings;
}

async function main() {
  const { rawPath, sdkPath, specPath, smokeConfig } = parseArgs();
  loadSmokeConfig(smokeConfig);
  const { skipOperations: SKIP_OPERATIONS, skipServices: SKIP_SERVICES } = getSmokeConfig();

  let rawResults: SmokeResults;
  let sdkResults: SmokeResults;

  try {
    rawResults = JSON.parse(readFileSync(rawPath, 'utf-8'));
  } catch (err) {
    console.error(`Failed to read raw results from ${rawPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  try {
    sdkResults = JSON.parse(readFileSync(sdkPath, 'utf-8'));
  } catch (err) {
    console.error(`Failed to read SDK results from ${sdkPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Warn if spec versions differ (non-blocking)
  if (rawResults.specVersion !== sdkResults.specVersion) {
    console.warn(
      `WARNING: spec version mismatch — raw="${rawResults.specVersion}", sdk="${sdkResults.specVersion}". Results may not be comparable.`,
    );
  }

  // Index by operationId
  const rawByOp = new Map<string, CapturedExchange>();
  for (const ex of rawResults.exchanges) {
    rawByOp.set(ex.operationId, ex);
  }
  const sdkByOp = new Map<string, CapturedExchange>();
  for (const ex of sdkResults.exchanges) {
    sdkByOp.set(ex.operationId, ex);
  }

  const allOps = new Set([...Array.from(rawByOp.keys()), ...Array.from(sdkByOp.keys())]);
  const missingFromRaw: string[] = [];
  const missingFromSdk: string[] = [];
  const skippedBoth: string[] = [];
  const allFindings: DiffFinding[] = [];
  let matchedCount = 0;

  for (const opId of Array.from(allOps)) {
    const raw = rawByOp.get(opId);
    const sdk = sdkByOp.get(opId);

    if (!raw) {
      missingFromRaw.push(opId);
      continue;
    }
    if (!sdk) {
      missingFromSdk.push(opId);
      continue;
    }

    // Skip operations that were skipped in both
    if (raw.outcome === 'skipped' && sdk.outcome === 'skipped') {
      skippedBoth.push(opId);
      continue;
    }

    // Asymmetric skip: one side ran but the other didn't — that's a real discrepancy
    if (raw.outcome === 'skipped' && sdk.outcome !== 'skipped') {
      allFindings.push({
        operationId: opId,
        severity: 'CRITICAL',
        field: 'outcome',
        message: 'Skipped in raw but executed in SDK — raw test could not run this operation',
        rawValue: raw.outcome,
        sdkValue: sdk.outcome,
      });
      continue;
    }
    if (sdk.outcome === 'skipped' && raw.outcome !== 'skipped') {
      allFindings.push({
        operationId: opId,
        severity: 'CRITICAL',
        field: 'outcome',
        message: 'Executed in raw but skipped in SDK — SDK could not resolve this operation',
        rawValue: raw.outcome,
        sdkValue: sdk.outcome,
      });
      continue;
    }

    matchedCount++;
    const findings = compareExchanges(raw, sdk);
    allFindings.push(...findings);
  }

  // Output report
  console.log('Smoke Test Diff Report');
  console.log('\u2500'.repeat(50));
  console.log(`Matched: ${matchedCount} operations`);
  console.log(`Missing from raw: ${missingFromRaw.length}`);
  console.log(`Missing from SDK: ${missingFromSdk.length}`);
  console.log(`Skipped in both: ${skippedBoth.length}`);

  if (missingFromRaw.length > 0) {
    console.log(`\nMissing from raw: ${missingFromRaw.join(', ')}`);
  }
  if (missingFromSdk.length > 0) {
    console.log(`\nMissing from SDK (FAILS BUILD): ${missingFromSdk.join(', ')}`);
  }

  const criticals = allFindings.filter((f) => f.severity === 'CRITICAL');
  const warnings = allFindings.filter((f) => f.severity === 'WARNING');
  const infos = allFindings.filter((f) => f.severity === 'INFO');

  if (criticals.length > 0) {
    console.log(`\nCRITICAL mismatches (${criticals.length}):`);
    for (const f of criticals) {
      console.log(`  \u2717 ${f.operationId}`);
      console.log(`    ${f.field}: ${f.message}`);
      console.log(`      raw:  ${JSON.stringify(f.rawValue)}`);
      console.log(`      sdk:  ${JSON.stringify(f.sdkValue)}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    for (const f of warnings) {
      console.log(`  \u26A0 ${f.operationId}`);
      console.log(`    ${f.field}: ${f.message}`);
    }
  }

  if (infos.length > 0) {
    console.log(`\nINFO (${infos.length}):`);
    for (const f of infos) {
      console.log(`  \u2139 ${f.operationId} — ${f.field}: ${f.message}`);
    }
  }

  const clearCount =
    matchedCount - new Set(allFindings.filter((f) => f.severity === 'CRITICAL').map((f) => f.operationId)).size;
  console.log(`\nAll clear: ${clearCount} operations matched perfectly`);

  // Compute coverage if spec provided
  let coverage: Record<string, unknown> | undefined;
  if (specPath) {
    try {
      const spec = await parseSpec(specPath);
      let totalOps = 0;
      let skippedByConfig = 0;
      for (const svc of spec.services) {
        if (SKIP_SERVICES.has(svc.name)) {
          skippedByConfig += svc.operations.length;
          totalOps += svc.operations.length;
          continue;
        }
        for (const op of svc.operations) {
          totalOps++;
          if (SKIP_OPERATIONS.has(op.name)) {
            skippedByConfig++;
          }
        }
      }
      const exercised = allOps.size;
      const coveragePercent = totalOps > 0 ? ((exercised / totalOps) * 100).toFixed(1) : '0.0';
      const skipPercent = totalOps > 0 ? ((skippedByConfig / totalOps) * 100).toFixed(1) : '0.0';
      coverage = {
        totalOperations: totalOps,
        exercisedOperations: exercised,
        skippedByConfig,
        coveragePercent: Number(coveragePercent),
        skipPercent: Number(skipPercent),
      };
      console.log(
        `\nCoverage: ${exercised}/${totalOps} operations (${coveragePercent}%), ${skippedByConfig} skipped by config (${skipPercent}%)`,
      );
    } catch (err) {
      console.warn(`Could not compute coverage: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Always persist findings to disk for cross-session handoff
  const findingsReport: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    rawSource: rawPath,
    sdkSource: sdkPath,
    configuration: {
      skipOperations: Array.from(SKIP_OPERATIONS).sort(),
      skipServices: Array.from(SKIP_SERVICES).sort(),
    },
    summary: {
      matched: matchedCount,
      missingFromRaw: missingFromRaw.length,
      missingFromSdk: missingFromSdk.length,
      skippedBoth: skippedBoth.length,
      criticals: criticals.length,
      warnings: warnings.length,
      infos: infos.length,
    },
    missingFromSdk,
    missingFromRaw,
    findings: allFindings,
  };
  if (coverage) {
    findingsReport.coverage = coverage;
  }
  writeFileSync('smoke-diff-findings.json', JSON.stringify(findingsReport, null, 2));
  console.log(`\nFindings written to smoke-diff-findings.json`);

  // Exit code: 0 if no CRITICAL mismatches and no missing SDK operations, 1 otherwise
  if (criticals.length > 0 || missingFromSdk.length > 0) {
    process.exit(1);
  }
}

// Only run when executed directly (not when imported for testing)
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('diff.ts') || process.argv[1].endsWith('diff.js'));
if (isDirectRun) {
  main();
}
