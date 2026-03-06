import { describe, it, expect } from 'vitest';
import { generateTests } from '../../../src/emitters/node/tests.js';
import type { EmitterContext } from '../../../src/engine/types.js';
import type { ApiSpec } from '../../../src/ir/types.js';

const spec: ApiSpec = {
  name: 'WorkOS',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services: [
    {
      name: 'Organizations',
      operations: [
        {
          name: 'list',
          httpMethod: 'get',
          path: '/organizations',
          pathParams: [],
          queryParams: [{ name: 'cursor', type: { kind: 'primitive', type: 'string' }, required: false }],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          paginated: true,
          idempotent: false,
        },
        {
          name: 'retrieve',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          paginated: false,
          idempotent: false,
        },
        {
          name: 'create',
          httpMethod: 'post',
          path: '/organizations',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: 'model', name: 'CreateOrganization' },
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          paginated: false,
          idempotent: true,
        },
      ],
    },
  ],
  models: [
    {
      name: 'Organization',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    },
  ],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'work_os',
  namespacePascal: 'WorkOS',
  spec,
};

describe('generateTests (node)', () => {
  it('generates test files with jest-fetch-mock imports', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'src/organizations/organizations.spec.ts');
    expect(testFile).toBeDefined();

    expect(testFile!.content).toContain("import fetch from 'jest-fetch-mock'");
    expect(testFile!.content).toContain('fetchOnce');
    expect(testFile!.content).toContain("import { WorkOS } from '../work-os'");
  });

  it('generates CRUD tests for each operation', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'src/organizations/organizations.spec.ts')!;

    expect(testFile.content).toContain("it('sends a list request'");
    expect(testFile.content).toContain("it('sends a retrieve request'");
    expect(testFile.content).toContain("it('sends a create request'");
  });

  it('generates error tests (404, 401)', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'src/organizations/organizations.spec.ts')!;

    expect(testFile.content).toContain('// === Error Tests ===');
    expect(testFile.content).toContain('NotFoundException on 404');
    expect(testFile.content).toContain('UnauthorizedException on 401');
    expect(testFile.content).toContain('rejects.toThrow');
  });

  it('generates retry tests for list operations', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'src/organizations/organizations.spec.ts')!;

    expect(testFile.content).toContain('// === Retry Tests ===');
    expect(testFile.content).toContain('retries on 429 rate limit');
    expect(testFile.content).toContain('status: 429');
    expect(testFile.content).toContain('fetch.mock.calls');
  });

  it('generates idempotency tests for create operations', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'src/organizations/organizations.spec.ts')!;

    expect(testFile.content).toContain('// === Idempotency Tests ===');
    expect(testFile.content).toContain('explicit idempotency key');
    expect(testFile.content).toContain("'Idempotency-Key'");
    expect(testFile.content).toContain('auto-generates idempotency key');
  });

  it('generates fixture JSON files', () => {
    const files = generateTests(spec, ctx);
    const fixture = files.find((f) => f.path.includes('fixtures/') && f.path.endsWith('.json'));
    expect(fixture).toBeDefined();
    const parsed = JSON.parse(fixture!.content);
    expect(parsed).toHaveProperty('id');
    expect(parsed).toHaveProperty('name');
  });

  it('uses beforeEach to reset fetch mocks', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'src/organizations/organizations.spec.ts')!;
    expect(testFile.content).toContain('beforeEach(() => fetch.resetMocks())');
  });
});
