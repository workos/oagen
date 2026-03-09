import { describe, it, expect } from 'vitest';
import { generateResources } from '../../../src/emitters/node/resources.js';
import type { EmitterContext } from '../../../src/engine/types.js';
import type { Service, ApiSpec } from '../../../src/ir/types.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'work_os',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateResources (node)', () => {
  it('generates a resource with paginated list method', () => {
    const services: Service[] = [
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
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            paginated: true,
            idempotent: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/organizations/organizations.ts');

    const content = files[0].content;
    expect(content).toContain('class Organizations');
    expect(content).toContain('constructor(private readonly workOs: WorkOS)');
    expect(content).toContain('AutoPaginatable<Organization>');
    expect(content).toContain('fetchAndDeserialize');
    expect(content).toContain('deserializeOrganization');
  });

  it('generates a resource with retrieve method using path params', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
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
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain('async retrieveOrganizations(id: string)');
    expect(content).toContain('`organizations/${id}`');
    expect(content).toContain('get<OrganizationResponse>');
    expect(content).toContain('deserializeOrganization(data)');
  });

  it('generates a resource with create method (body + idempotency)', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
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
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain('async createOrganizations(');
    expect(content).toContain('post<OrganizationResponse>');
    expect(content).toContain('requestOptions');
    expect(content).toContain('deserializeOrganization(data)');
  });

  it('generates a resource with delete method returning void', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'delete',
            httpMethod: 'delete',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'string' },
            errors: [],
            paginated: false,
            idempotent: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain('async deleteOrganizations(id: string): Promise<void>');
    expect(content).toContain('this.workOs.delete(');
  });

  it('generates a resource with update (put) method', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'update',
            httpMethod: 'put',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'UpdateOrganization' },
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            paginated: false,
            idempotent: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain('async updateOrganizations(');
    expect(content).toContain('put<OrganizationResponse>');
    expect(content).toContain('`organizations/${id}`');
  });

  it('generates a resource with array response type for paginated list', () => {
    const services: Service[] = [
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
            response: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
            errors: [],
            paginated: true,
            idempotent: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain('AutoPaginatable<Organization>');
    expect(content).toContain('deserializeOrganization');
    expect(content).toContain('OrganizationResponse');
  });

  it('generates multiple resources as separate files', () => {
    const services: Service[] = [
      { name: 'Users', operations: [] },
      { name: 'Organizations', operations: [] },
    ];

    const files = generateResources(services, ctx);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('src/users/users.ts');
    expect(files[1].path).toBe('src/organizations/organizations.ts');
  });
});
