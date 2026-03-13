import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiSpec, Service, Operation, TypeRef, Model } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { planOperation } from '../../engine/operation-plan.js';
import { nodeClassName, nodeFileName, nodeTestPath, nodeResourcePath } from './naming.js';
import { toCamelCase, toSnakeCase } from '../../utils/naming.js';
import { generateFixtures } from './fixtures.js';

export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const service of spec.services) {
    // Only generate tests for services whose resource file already exists on disk.
    // New services won't be wired into the hand-written client, so tests would fail.
    if (ctx.outputDir) {
      const resourcePath = path.join(ctx.outputDir, nodeResourcePath(service.name));
      if (!fs.existsSync(resourcePath)) continue;
    }

    files.push({
      path: nodeTestPath(service.name),
      content: generateTestFile(service, ctx),
    });
  }

  files.push(...generateFixtures(spec, ctx));

  return files;
}

function generateTestFile(service: Service, ctx: EmitterContext): string {
  const ns = ctx.namespacePascal;
  const nsFile = ctx.namespacePascal.toLowerCase();
  const lines: string[] = [];

  lines.push(`import fetch from 'jest-fetch-mock';`);
  lines.push(
    `import { fetchOnce, fetchURL, fetchSearchParams, fetchHeaders, fetchBody } from '../common/utils/test-utils';`,
  );
  lines.push(`import { ${ns} } from '../${nsFile}';`);
  lines.push('');

  lines.push(`const ${toCamelCase(ctx.namespace)} = new ${ns}('sk_test_xxx');`);
  lines.push('');

  lines.push(`describe('${nodeClassName(service.name)}', () => {`);
  lines.push('  beforeEach(() => fetch.resetMocks());');

  // Generate per-operation nested describe blocks
  for (const op of service.operations) {
    const methodName = toCamelCase(op.name);
    lines.push('');
    lines.push(`  describe('${methodName}', () => {`);

    // CRUD test with response validation
    lines.push(...generateCrudTestWithValidation(op, service, ctx));

    // Parameter combination tests
    if (op.queryParams.length > 0) {
      lines.push('');
      lines.push(...generateParamTests(op, service, ctx));
    }

    // Error tests for this operation
    lines.push('');
    lines.push(...generateErrorTestsForOp(op, service, ctx));

    // Retry test (for operations that can get 429)
    if (op.paginated || op.httpMethod === 'get') {
      lines.push('');
      lines.push(...generateRetryTest(op, service, ctx));
    }

    // Idempotency tests
    if (planOperation(op).isIdempotentPost) {
      lines.push('');
      lines.push(...generateIdempotencyTests(op, service, ctx));
    }

    lines.push('  });');
  }

  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

function generateCrudTestWithValidation(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const methodName = toCamelCase(op.name);
  const clientVar = toCamelCase(ctx.namespace);
  const resourceProp = toCamelCase(service.name);
  const statusCode = op.httpMethod === 'delete' ? 204 : op.httpMethod === 'post' ? 201 : 200;
  const fixtureName = getResponseFixtureName(op, service);

  if (op.httpMethod === 'delete' || !fixtureName) {
    lines.push(`    it('sends a ${op.name} request', async () => {`);
    lines.push(`      fetchOnce({}, ${statusCode});`);
    const args = buildTestCallArgs(op);
    lines.push(`      await ${clientVar}.${resourceProp}.${methodName}(${args});`);
    lines.push('');
    lines.push(`      expect(fetchURL()).toContain('${stripLeadingSlash(op.path).replace(/\{[^}]+\}/g, 'test_id')}');`);
    lines.push('    });');
    return lines;
  }

  lines.push(`    it('${op.name}s and deserializes the response', async () => {`);
  lines.push(`      const fixture = require('./fixtures/${fixtureName}.json');`);
  lines.push(`      fetchOnce(fixture, ${statusCode});`);
  lines.push('');

  const args = buildTestCallArgs(op);
  lines.push(`      const result = await ${clientVar}.${resourceProp}.${methodName}(${args});`);
  lines.push('');
  lines.push(`      expect(fetchURL()).toContain('${stripLeadingSlash(op.path).replace(/\{[^}]+\}/g, 'test_id')}');`);

  // Assert response fields if we know the model
  if (op.response.kind === 'model') {
    const model = findModelByName(op.response.name, ctx);
    if (model) {
      const requiredFields = model.fields.filter((f) => f.required).slice(0, 5);
      for (const field of requiredFields) {
        const camel = toCamelCase(field.name);
        const snake = toSnakeCase(field.name);
        lines.push(`      expect(result.${camel}).toBe(fixture.${snake});`);
      }
    }
  }

  lines.push('    });');
  return lines;
}

function generateParamTests(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  if (op.queryParams.length === 0) return lines;

  const methodName = toCamelCase(op.name);
  const clientVar = toCamelCase(ctx.namespace);
  const resourceProp = toCamelCase(service.name);
  const fixtureName = getResponseFixtureName(op, service);
  const fixtureExpr = fixtureName ? `require('./fixtures/${fixtureName}.json')` : `{}`;

  for (const param of op.queryParams) {
    const camelParam = toCamelCase(param.name);
    const testValue = getTestValueForType(param.type, param.name);

    lines.push(`    it('sends ${param.name} parameter', async () => {`);
    lines.push(`      fetchOnce(${fixtureExpr}, 200);`);
    lines.push('');
    lines.push(`      await ${clientVar}.${resourceProp}.${methodName}({ ${camelParam}: ${testValue} });`);
    lines.push('');
    lines.push(`      expect(fetchSearchParams().get('${param.name}')).toBe(${stringifyTestValue(testValue)});`);
    lines.push(`    });`);
    lines.push('');
  }

  if (op.queryParams.length > 1) {
    lines.push(`    it('sends multiple parameters together', async () => {`);
    lines.push(`      fetchOnce(${fixtureExpr}, 200);`);
    lines.push('');
    const paramObj = op.queryParams
      .slice(0, 3)
      .map((p) => `${toCamelCase(p.name)}: ${getTestValueForType(p.type, p.name)}`)
      .join(', ');
    lines.push(`      await ${clientVar}.${resourceProp}.${methodName}({ ${paramObj} });`);
    lines.push('');
    for (const param of op.queryParams.slice(0, 3)) {
      lines.push(`      expect(fetchSearchParams().get('${param.name}')).toBeDefined();`);
    }
    lines.push(`    });`);
  }

  return lines;
}

const errorMap: Record<number, { exception: string; message: string }> = {
  400: { exception: 'BadRequestException', message: 'Bad request' },
  401: { exception: 'UnauthorizedException', message: 'Unauthorized' },
  404: { exception: 'NotFoundException', message: 'Not found' },
  409: { exception: 'ConflictException', message: 'Conflict' },
  422: { exception: 'UnprocessableEntityException', message: 'Unprocessable entity' },
  429: { exception: 'RateLimitExceededException', message: 'Rate limit exceeded' },
};

function generateErrorTestsForOp(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const methodName = toCamelCase(op.name);
  const clientVar = toCamelCase(ctx.namespace);
  const resourceProp = toCamelCase(service.name);

  const statusCodes = op.errors.map((e) => e.statusCode);
  const codesToTest = new Set([
    401,
    ...statusCodes,
    ...(op.httpMethod === 'get' ? [404] : []),
    ...(op.httpMethod === 'post' ? [409, 422] : []),
    ...(op.httpMethod === 'put' || op.httpMethod === 'patch' ? [404, 422] : []),
    ...(op.httpMethod === 'delete' ? [404] : []),
  ]);

  const callArgs = buildTestCallArgs(op);

  for (const code of codesToTest) {
    const err = errorMap[code];
    if (!err) continue;

    lines.push(`    it('throws ${err.exception} on ${code}', async () => {`);
    lines.push(`      fetchOnce({ message: '${err.message}' }, ${code});`);
    lines.push('');
    lines.push(`      await expect(`);
    lines.push(`        ${clientVar}.${resourceProp}.${methodName}(${callArgs}),`);
    lines.push(`      ).rejects.toThrow('${err.message}');`);
    lines.push('    });');
    lines.push('');
  }

  return lines;
}

function generateRetryTest(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const methodName = toCamelCase(op.name);
  const clientVar = toCamelCase(ctx.namespace);
  const resourceProp = toCamelCase(service.name);
  const fixtureName = getResponseFixtureName(op, service);
  const fixtureExpr = fixtureName ? `require('./fixtures/${fixtureName}.json')` : `{}`;

  lines.push(`    it('retries on 429 rate limit', async () => {`);
  lines.push(`      fetch.mockResponses(`);
  lines.push(`        [JSON.stringify({}), { status: 429, headers: { 'Retry-After': '0.01' } }],`);
  lines.push(`        [JSON.stringify(${fixtureExpr}), { status: 200 }],`);
  lines.push(`      );`);
  lines.push('');
  const args = buildTestCallArgs(op);
  lines.push(`      const result = await ${clientVar}.${resourceProp}.${methodName}(${args});`);
  lines.push('');
  lines.push(`      expect(result).toBeDefined();`);
  lines.push(`      expect(fetch.mock.calls).toHaveLength(2);`);
  lines.push('    });');

  return lines;
}

function generateIdempotencyTests(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const methodName = toCamelCase(op.name);
  const clientVar = toCamelCase(ctx.namespace);
  const resourceProp = toCamelCase(service.name);
  const fixtureName = getResponseFixtureName(op, service);
  const fixtureExpr = fixtureName ? `require('./fixtures/${fixtureName}.json')` : `{}`;

  lines.push(`    it('sends explicit idempotency key', async () => {`);
  lines.push(`      fetchOnce(${fixtureExpr}, 201);`);
  lines.push('');
  lines.push(`      await ${clientVar}.${resourceProp}.${methodName}(`);
  lines.push(`        { name: 'Test' },`);
  lines.push(`        { idempotencyKey: 'my_key' },`);
  lines.push(`      );`);
  lines.push('');
  lines.push(`      expect(fetchHeaders()['Idempotency-Key']).toBe('my_key');`);
  lines.push('    });');
  lines.push('');

  lines.push(`    it('auto-generates idempotency key for POST', async () => {`);
  lines.push(`      fetchOnce(${fixtureExpr}, 201);`);
  lines.push('');
  lines.push(`      await ${clientVar}.${resourceProp}.${methodName}({ name: 'Test' });`);
  lines.push('');
  lines.push(`      const key = fetchHeaders()['Idempotency-Key'];`);
  lines.push(`      expect(key).toBeDefined();`);
  lines.push(`      expect(key).toMatch(/^[0-9a-f-]{36}$/i);`);
  lines.push('    });');

  return lines;
}

function buildTestCallArgs(op: Operation): string {
  const args: string[] = [];
  for (const _p of op.pathParams) {
    args.push(`'test_id'`);
  }
  if (op.requestBody) {
    args.push(`{ name: 'test' }`);
  }
  return args.join(', ');
}

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function getResponseFixtureName(op: Operation, _service: Service): string | undefined {
  const modelName = planOperation(op).responseModelName;
  if (!modelName) return undefined;
  return nodeFileName(modelName);
}

function findModelByName(name: string, ctx: EmitterContext): Model | undefined {
  return ctx.spec.models.find((m) => m.name === name);
}

function getTestValueForType(type: TypeRef, name: string): string {
  if (type.kind === 'primitive') {
    if (type.type === 'string') {
      if (name.includes('id')) return "'org_01EHQMYV6MBK39QC5PZXHY59C3'";
      if (name.includes('email')) return "'test@example.com'";
      if (name.includes('domain')) return "'example.com'";
      return `'test_${name}'`;
    }
    if (type.type === 'integer' || type.type === 'number') return '10';
    if (type.type === 'boolean') return 'true';
  }
  if (type.kind === 'enum') return "'active'";
  return "'test_value'";
}

function stringifyTestValue(value: string): string {
  // If value is already a quoted string, return as-is
  if (value.startsWith("'") && value.endsWith("'")) return value;
  // For numeric/boolean values, wrap in String()
  return `String(${value})`;
}
