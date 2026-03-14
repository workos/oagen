/**
 * Independent round-trip validation against the raw OpenAPI spec.
 *
 * Loads the raw OpenAPI spec YAML directly via @redocly/openapi-core (NOT via parseSpec)
 * and validates SDK smoke results against it.
 *
 * Usage:
 *   OPENAPI_SPEC_PATH=path/to/spec.yaml npm run smoke:validate
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { bundleFromString, createConfig } from '@redocly/openapi-core';
import type { SmokeResults, CapturedExchange } from './shared.js';

interface ValidationFinding {
  operationId: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  field: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

interface SpecOperation {
  httpMethod: string;
  pathTemplate: string;
  pathParams: string[];
  queryParams: string[];
  bodyProperties: string[];
  requiredBodyProperties: string[];
}

function parseArgs(): { specPath: string; resultsPath: string } {
  const specPath = process.env.OPENAPI_SPEC_PATH;
  if (!specPath) {
    console.error('OPENAPI_SPEC_PATH environment variable is required');
    process.exit(1);
  }

  return {
    specPath,
    resultsPath: 'smoke-results-sdk-node.json',
  };
}

/** Build a map of operationId → spec operation info from a raw OpenAPI document */
function extractOperations(doc: Record<string, unknown>): Map<string, SpecOperation> {
  const ops = new Map<string, SpecOperation>();
  const paths = doc.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return ops;

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = (pathItem as Record<string, unknown>)[method] as Record<string, unknown> | undefined;
      if (!operation) continue;

      const operationId = operation.operationId as string | undefined;
      if (!operationId) continue;

      // Extract path parameters
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      const parameters = [
        ...((pathItem.parameters as Array<Record<string, unknown>>) ?? []),
        ...((operation.parameters as Array<Record<string, unknown>>) ?? []),
      ];
      for (const param of parameters) {
        if (param.in === 'path') pathParams.push(param.name as string);
        if (param.in === 'query') queryParams.push(param.name as string);
      }

      // Extract body properties
      const bodyProperties: string[] = [];
      const requiredBodyProperties: string[] = [];
      const requestBody = operation.requestBody as Record<string, unknown> | undefined;
      if (requestBody) {
        const content = requestBody.content as Record<string, Record<string, unknown>> | undefined;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown> | undefined;
        if (schema?.properties && typeof schema.properties === 'object') {
          bodyProperties.push(...Object.keys(schema.properties as object));
        }
        if (Array.isArray(schema?.required)) {
          requiredBodyProperties.push(...(schema.required as string[]));
        }
      }

      ops.set(operationId, {
        httpMethod: method.toUpperCase(),
        pathTemplate,
        pathParams,
        queryParams,
        bodyProperties,
        requiredBodyProperties,
      });
    }
  }

  return ops;
}

/** Check if a concrete path matches a template like /orgs/{id}/members */
function pathMatchesTemplate(concretePath: string, template: string): boolean {
  const concreteSegments = concretePath.split('/').filter(Boolean);
  const templateSegments = template.split('/').filter(Boolean);

  if (concreteSegments.length !== templateSegments.length) return false;

  return templateSegments.every((seg, i) => {
    if (seg.startsWith('{') && seg.endsWith('}')) return true;
    return seg === concreteSegments[i];
  });
}

function validateExchange(
  exchange: CapturedExchange,
  specOps: Map<string, SpecOperation>,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const opId = exchange.operationId;

  if (exchange.outcome === 'skipped') return findings;

  // Try to find the spec operation by operationId suffix (the operation name part)
  const opName = opId.split('.').pop() ?? opId;
  let specOp: SpecOperation | undefined;

  // Direct lookup by full spec operationId
  for (const [specOpId, op] of specOps) {
    if (specOpId === opName || specOpId.endsWith(opName)) {
      specOp = op;
      break;
    }
  }

  if (!specOp) {
    findings.push({
      operationId: opId,
      severity: 'WARNING',
      field: 'operationId',
      message: `No matching operation found in raw spec for "${opName}"`,
    });
    return findings;
  }

  // Validate HTTP method
  if (exchange.request.method !== specOp.httpMethod) {
    findings.push({
      operationId: opId,
      severity: 'CRITICAL',
      field: 'httpMethod',
      message: 'HTTP method does not match spec',
      expected: specOp.httpMethod,
      actual: exchange.request.method,
    });
  }

  // Validate path template match
  if (!pathMatchesTemplate(exchange.request.path, specOp.pathTemplate)) {
    findings.push({
      operationId: opId,
      severity: 'CRITICAL',
      field: 'path',
      message: 'Request path does not match spec path template',
      expected: specOp.pathTemplate,
      actual: exchange.request.path,
    });
  }

  // Validate query param names are in spec
  const actualQueryKeys = Object.keys(exchange.request.queryParams);
  for (const key of actualQueryKeys) {
    if (!specOp.queryParams.includes(key)) {
      findings.push({
        operationId: opId,
        severity: 'WARNING',
        field: `queryParam.${key}`,
        message: `Query param "${key}" not declared in spec`,
        expected: specOp.queryParams,
        actual: key,
      });
    }
  }

  // Validate body keys are in spec
  if (exchange.request.body && typeof exchange.request.body === 'object' && !Array.isArray(exchange.request.body)) {
    const actualBodyKeys = Object.keys(exchange.request.body as object);
    for (const key of actualBodyKeys) {
      if (specOp.bodyProperties.length > 0 && !specOp.bodyProperties.includes(key)) {
        findings.push({
          operationId: opId,
          severity: 'WARNING',
          field: `body.${key}`,
          message: `Body field "${key}" not declared in spec`,
          expected: specOp.bodyProperties,
          actual: key,
        });
      }
    }
  }

  return findings;
}

async function main() {
  const { specPath, resultsPath } = parseArgs();

  // Load raw spec via @redocly/openapi-core (independent of parseSpec)
  console.log(`Loading raw spec from ${specPath}...`);
  const specContent = readFileSync(specPath, 'utf-8');
  const config = await createConfig({});
  const bundled = await bundleFromString({ source: specContent, config, dereference: true });
  const doc = bundled.bundle.parsed as Record<string, unknown>;

  const specOps = extractOperations(doc);
  console.log(`Found ${specOps.size} operations in spec`);

  // Load SDK results
  let results: SmokeResults;
  try {
    results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
  } catch (err) {
    console.error(`Failed to read results from ${resultsPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.log(`Validating ${results.exchanges.length} exchanges from ${resultsPath}...`);

  const allFindings: ValidationFinding[] = [];
  for (const exchange of results.exchanges) {
    const findings = validateExchange(exchange, specOps);
    allFindings.push(...findings);
  }

  // Report
  const criticals = allFindings.filter((f) => f.severity === 'CRITICAL');
  const warnings = allFindings.filter((f) => f.severity === 'WARNING');
  const infos = allFindings.filter((f) => f.severity === 'INFO');

  console.log(`\nValidation Results:`);
  console.log(`  CRITICAL: ${criticals.length}`);
  console.log(`  WARNING: ${warnings.length}`);
  console.log(`  INFO: ${infos.length}`);

  if (criticals.length > 0) {
    console.log(`\nCRITICAL findings:`);
    for (const f of criticals) {
      console.log(`  ${f.operationId}: ${f.field} — ${f.message}`);
    }
  }

  // Write findings
  const report = {
    timestamp: new Date().toISOString(),
    specPath,
    resultsPath,
    summary: {
      total: allFindings.length,
      criticals: criticals.length,
      warnings: warnings.length,
      infos: infos.length,
    },
    findings: allFindings,
  };

  writeFileSync('smoke-validation-findings.json', JSON.stringify(report, null, 2));
  console.log(`\nWritten to smoke-validation-findings.json`);

  if (criticals.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Validation crashed:', err);
  process.exit(1);
});
