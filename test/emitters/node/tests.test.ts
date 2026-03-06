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
          queryParams: [
            { name: 'cursor', type: { kind: 'primitive', type: 'string' }, required: false },
            { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
            { name: 'order', type: { kind: 'enum', name: 'Order' }, required: false },
          ],
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
          errors: [{ statusCode: 404 }],
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
          errors: [{ statusCode: 409 }],
          paginated: false,
          idempotent: true,
        },
        {
          name: 'delete',
          httpMethod: 'delete',
          path: '/organizations/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'primitive', type: 'string' },
          errors: [{ statusCode: 404 }],
          paginated: false,
          idempotent: false,
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

function getTestFile(): string {
  const files = generateTests(spec, ctx);
  return files.find((f) => f.path === 'src/organizations/organizations.spec.ts')!.content;
}

describe('generateTests (node)', () => {
  it('generates test files with jest-fetch-mock imports', () => {
    const content = getTestFile();
    expect(content).toContain("import fetch from 'jest-fetch-mock'");
    expect(content).toContain('fetchOnce');
    expect(content).toContain('fetchSearchParams');
    expect(content).toContain("import { WorkOS } from '../work-os'");
  });

  it('wraps each operation in a nested describe block', () => {
    const content = getTestFile();
    expect(content).toContain("describe('listOrganizations'");
    expect(content).toContain("describe('retrieveOrganizations'");
    expect(content).toContain("describe('createOrganizations'");
    expect(content).toContain("describe('deleteOrganizations'");
  });

  it('generates CRUD tests with response field validation', () => {
    const content = getTestFile();
    // Non-delete ops validate deserialized response fields
    expect(content).toContain("lists and deserializes the response");
    expect(content).toContain("expect(result.id).toBe(fixture.id)");
    expect(content).toContain("expect(result.name).toBe(fixture.name)");

    // Delete ops use simple request assertion
    expect(content).toContain("sends a delete request");
  });

  it('generates per-operation error tests with expanded status codes', () => {
    const content = getTestFile();

    // list (GET) gets 401 + 404
    expect(content).toContain("throws UnauthorizedException on 401");
    expect(content).toContain("throws NotFoundException on 404");

    // create (POST) gets 401 + 409 + 422
    expect(content).toContain("throws ConflictException on 409");
    expect(content).toContain("throws UnprocessableEntityException on 422");
  });

  it('generates parameter combination tests for list operations', () => {
    const content = getTestFile();
    expect(content).toContain("sends cursor parameter");
    expect(content).toContain("sends limit parameter");
    expect(content).toContain("sends order parameter");
    expect(content).toContain("sends multiple parameters together");
    expect(content).toContain("fetchSearchParams().get('cursor')");
  });

  it('generates retry tests for GET operations', () => {
    const content = getTestFile();
    expect(content).toContain('retries on 429 rate limit');
    expect(content).toContain('status: 429');
    expect(content).toContain('fetch.mock.calls');
  });

  it('generates idempotency tests for idempotent POST operations', () => {
    const content = getTestFile();
    expect(content).toContain('explicit idempotency key');
    expect(content).toContain("'Idempotency-Key'");
    expect(content).toContain('auto-generates idempotency key');
  });

  it('generates fixture JSON files in per-service directories', () => {
    const files = generateTests(spec, ctx);
    const fixture = files.find((f) => f.path.includes('fixtures/') && f.path.endsWith('.json'));
    expect(fixture).toBeDefined();
    // Fixture should be in the service's fixture directory
    expect(fixture!.path).toBe('src/organizations/fixtures/organization.json');
    const parsed = JSON.parse(fixture!.content);
    expect(parsed).toHaveProperty('id');
    expect(parsed).toHaveProperty('name');
  });

  it('references fixtures using correct relative path in generated tests', () => {
    const content = getTestFile();
    // Fixture path should be relative to test file (same service directory)
    expect(content).toContain("require('./fixtures/organization.json')");
  });

  it('uses beforeEach to reset fetch mocks', () => {
    const content = getTestFile();
    expect(content).toContain('beforeEach(() => fetch.resetMocks())');
  });

  it('skips response field validation for delete operations', () => {
    const content = getTestFile();
    // The delete test should not have result.id assertions
    // Find the delete describe block content
    const deleteIdx = content.indexOf("describe('deleteOrganizations'");
    const nextDescribeIdx = content.indexOf("describe('", deleteIdx + 1);
    const deleteBlock = nextDescribeIdx > -1 ? content.slice(deleteIdx, nextDescribeIdx) : content.slice(deleteIdx);
    expect(deleteBlock).not.toContain('result.id');
    expect(deleteBlock).toContain("sends a delete request");
  });

  it('uses realistic test values for parameters', () => {
    const content = getTestFile();
    // enum param should use 'active'
    expect(content).toContain("order: 'active'");
    // integer param should use 10
    expect(content).toContain('limit: 10');
  });
});
