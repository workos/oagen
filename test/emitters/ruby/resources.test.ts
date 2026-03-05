import { describe, it, expect } from 'vitest';
import { generateResources } from '../../../src/emitters/ruby/resources.js';
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

describe('generateResources', () => {
  it('generates a resource with list (paginated) method using keyword args', () => {
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
    expect(files[0].path).toBe('lib/work_os/resources/organizations.rb');

    const content = files[0].content;
    // Keyword-style request
    expect(content).toContain('method: :get');
    expect(content).toContain('path: "organizations"');
    expect(content).toContain('query: params');
    expect(content).toContain('page: WorkOS::Internal::CursorPage');
    expect(content).toContain('model: WorkOS::Models::Organization');
    expect(content).toContain('options: request_options');
    // Method signature includes request_options
    expect(content).toContain('def list(params = {}, request_options: nil)');
    // YARD docs
    expect(content).toContain('# @param request_options [Hash, nil]');
    expect(content).toContain('# @return [WorkOS::Internal::CursorPage[WorkOS::Models::Organization]]');
  });

  it('generates a resource with retrieve method (path param)', () => {
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
    expect(content).toContain('def retrieve(id, request_options: nil)');
    expect(content).toContain('path: ["organizations/%1$s", id]');
    expect(content).toContain('model: WorkOS::Models::Organization');
  });

  it('generates a resource with create method (body + idempotency as separate param)', () => {
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
    expect(content).toContain('def create(params, idempotency_key: nil, request_options: nil)');
    expect(content).toContain('method: :post');
    expect(content).toContain('path: "organizations"');
    expect(content).toContain('body: params');
    expect(content).toContain('idempotency_key: idempotency_key');
    expect(content).toContain('model: WorkOS::Models::Organization');
    // YARD docs
    expect(content).toContain('# @param idempotency_key [String, nil]');
  });

  it('generates a resource with update method (path param + body)', () => {
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
    expect(content).toContain('def update(id, params, request_options: nil)');
    expect(content).toContain('path: ["organizations/%1$s", id]');
    expect(content).toContain('body: params');
    expect(content).toContain('model: WorkOS::Models::Organization');
  });

  it('generates a resource with delete method returning nil', () => {
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
    expect(content).toContain('def delete(id, request_options: nil)');
    expect(content).toContain('path: ["organizations/%1$s", id]');
    expect(content).toContain('model: NilClass');
    expect(content).toContain('# @return [nil]');
  });

  it('generates multiple resources as separate files', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [],
      },
      {
        name: 'Organizations',
        operations: [],
      },
    ];

    const files = generateResources(services, ctx);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('lib/work_os/resources/users.rb');
    expect(files[1].path).toBe('lib/work_os/resources/organizations.rb');
  });
});
