import type { ApiSpec, Service, Operation } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { nodeClassName, nodeFileName, nodeMethodName, nodeTestPath } from './naming.js';
import { toCamelCase, toPascalCase } from '../../utils/naming.js';
import { generateFixtures } from './fixtures.js';

export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const service of spec.services) {
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
  const nsFile = nodeFileName(ctx.namespace);
  const lines: string[] = [];

  lines.push(`import fetch from 'jest-fetch-mock';`);
  lines.push(`import { fetchOnce, fetchURL, fetchHeaders, fetchBody } from '../common/utils/test-utils';`);
  lines.push(`import { ${ns} } from '../${nsFile}';`);
  lines.push('');

  lines.push(`const ${toCamelCase(ctx.namespace)} = new ${ns}('sk_test_xxx');`);
  lines.push('');

  lines.push(`describe('${nodeClassName(service.name)}', () => {`);
  lines.push('  beforeEach(() => fetch.resetMocks());');

  // CRUD tests
  lines.push('');
  lines.push('  // === CRUD Tests ===');
  for (const op of service.operations) {
    lines.push('');
    lines.push(...generateCrudTest(op, service, ctx));
  }

  // Error tests
  const retrieveOp = service.operations.find((o) => o.name === 'retrieve');
  const listOp = service.operations.find((o) => o.name === 'list');
  if (retrieveOp || listOp) {
    lines.push('');
    lines.push('  // === Error Tests ===');
    lines.push('');
    lines.push(...generateErrorTests(retrieveOp || listOp!, service, ctx));
  }

  // Retry tests
  if (listOp) {
    lines.push('');
    lines.push('  // === Retry Tests ===');
    lines.push('');
    lines.push(...generateRetryTest(listOp, service, ctx));
  }

  // Idempotency tests
  const createOp = service.operations.find((o) => o.name === 'create' && o.idempotent);
  if (createOp) {
    lines.push('');
    lines.push('  // === Idempotency Tests ===');
    lines.push('');
    lines.push(...generateIdempotencyTests(createOp, service, ctx));
  }

  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

function generateCrudTest(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const methodName = toCamelCase(op.name) + toPascalCase(service.name);
  const clientVar = toCamelCase(ctx.namespace);
  const resourceProp = toCamelCase(service.name);
  const statusCode = op.httpMethod === 'delete' ? 204 : op.httpMethod === 'post' ? 201 : 200;
  const fixtureName = getResponseFixtureName(op, service);

  lines.push(`  it('sends a ${op.name} request', async () => {`);

  if (statusCode === 204) {
    lines.push(`    fetchOnce({}, ${statusCode});`);
  } else {
    lines.push(`    fetchOnce(require('../fixtures/${fixtureName}.json'), ${statusCode});`);
  }

  // Build method call
  const args: string[] = [];
  for (const _p of op.pathParams) {
    args.push(`'test_id'`);
  }
  if (op.requestBody) {
    args.push(`{ name: 'test' }`);
  }

  const call = `${clientVar}.${resourceProp}.${methodName}(${args.join(', ')})`;

  if (op.httpMethod === 'delete') {
    lines.push(`    await ${call};`);
    lines.push('');
    lines.push(`    expect(fetchURL()).toContain('${stripLeadingSlash(op.path).replace(/\{[^}]+\}/g, 'test_id')}');`);
  } else {
    lines.push(`    const result = await ${call};`);
    lines.push('');
    lines.push(`    expect(result).toBeDefined();`);
    lines.push(`    expect(fetchURL()).toContain('${stripLeadingSlash(op.path).replace(/\{[^}]+\}/g, 'test_id')}');`);
  }

  lines.push('  });');

  return lines;
}

function generateErrorTests(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const methodName = toCamelCase(op.name) + toPascalCase(service.name);
  const clientVar = toCamelCase(ctx.namespace);
  const resourceProp = toCamelCase(service.name);

  const callArgs = op.pathParams.length > 0 ? `'invalid'` : '';

  // 404 test
  lines.push(`  it('throws NotFoundException on 404', async () => {`);
  lines.push(`    fetchOnce({ message: 'Not found' }, 404);`);
  lines.push('');
  lines.push(`    await expect(`);
  lines.push(`      ${clientVar}.${resourceProp}.${methodName}(${callArgs}),`);
  lines.push(`    ).rejects.toThrow('Not found');`);
  lines.push('  });');
  lines.push('');

  // 401 test
  const authOp = service.operations.find((o) => o.name === 'list') || op;
  const authMethodName = nodeMethodName(authOp.name + toCamelCase(service.name));
  const authCallArgs = authOp.pathParams.length > 0 ? `'test_id'` : '';

  lines.push(`  it('throws UnauthorizedException on 401', async () => {`);
  lines.push(`    fetchOnce({ message: 'Unauthorized' }, 401);`);
  lines.push('');
  lines.push(`    await expect(`);
  lines.push(`      ${clientVar}.${resourceProp}.${authMethodName}(${authCallArgs}),`);
  lines.push(`    ).rejects.toThrow('Unauthorized');`);
  lines.push('  });');

  return lines;
}

function generateRetryTest(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const methodName = toCamelCase(op.name) + toPascalCase(service.name);
  const clientVar = toCamelCase(ctx.namespace);
  const resourceProp = toCamelCase(service.name);
  const fixtureName = getResponseFixtureName(op, service);

  lines.push(`  it('retries on 429 rate limit', async () => {`);
  lines.push(`    fetch.mockResponses(`);
  lines.push(`      [JSON.stringify({}), { status: 429, headers: { 'Retry-After': '0.01' } }],`);
  lines.push(`      [JSON.stringify(require('../fixtures/${fixtureName}.json')), { status: 200 }],`);
  lines.push(`    );`);
  lines.push('');
  lines.push(`    const result = await ${clientVar}.${resourceProp}.${methodName}();`);
  lines.push('');
  lines.push(`    expect(result).toBeDefined();`);
  lines.push(`    expect(fetch.mock.calls).toHaveLength(2);`);
  lines.push('  });');

  return lines;
}

function generateIdempotencyTests(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const methodName = toCamelCase(op.name) + toPascalCase(service.name);
  const clientVar = toCamelCase(ctx.namespace);
  const resourceProp = toCamelCase(service.name);
  const fixtureName = getResponseFixtureName(op, service);

  // Explicit idempotency key
  lines.push(`  it('sends explicit idempotency key', async () => {`);
  lines.push(`    fetchOnce(require('../fixtures/${fixtureName}.json'), 201);`);
  lines.push('');
  lines.push(`    await ${clientVar}.${resourceProp}.${methodName}(`);
  lines.push(`      { name: 'Test' },`);
  lines.push(`      { idempotencyKey: 'my_key' },`);
  lines.push(`    );`);
  lines.push('');
  lines.push(`    expect(fetchHeaders()['Idempotency-Key']).toBe('my_key');`);
  lines.push('  });');
  lines.push('');

  // Auto-generated idempotency key
  lines.push(`  it('auto-generates idempotency key for POST', async () => {`);
  lines.push(`    fetchOnce(require('../fixtures/${fixtureName}.json'), 201);`);
  lines.push('');
  lines.push(`    await ${clientVar}.${resourceProp}.${methodName}({ name: 'Test' });`);
  lines.push('');
  lines.push(`    const key = fetchHeaders()['Idempotency-Key'];`);
  lines.push(`    expect(key).toBeDefined();`);
  lines.push(`    expect(key).toMatch(/^[0-9a-f-]{36}$/i);`);
  lines.push('  });');

  return lines;
}

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function getResponseFixtureName(op: Operation, service: Service): string {
  const resourceName = nodeFileName(service.name);
  return `${resourceName}/${op.name}`;
}
