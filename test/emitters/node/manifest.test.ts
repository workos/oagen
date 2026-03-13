import { describe, it, expect } from 'vitest';
import { generateManifest } from '../../../src/emitters/node/manifest.js';
import type { ApiSpec } from '../../../src/ir/types.js';
import type { EmitterContext } from '../../../src/engine/types.js';

const minimalSpec: ApiSpec = {
  name: 'TestAPI',
  version: '1.0.0',
  baseUrl: 'https://api.example.com',
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
            { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
          ],
          headerParams: [],
          response: { kind: 'primitive', type: 'string' },
          errors: [],
          paginated: true,
          idempotent: false,
        },
        {
          name: 'create',
          httpMethod: 'post',
          path: '/organizations',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: 'model', name: 'CreateOrganizationOptions' },
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          paginated: false,
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
      ],
    },
  ],
  models: [
    {
      name: 'CreateOrganizationOptions',
      fields: [
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'domains', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: false },
      ],
    },
  ],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: minimalSpec,
};

describe('generateManifest', () => {
  it('generates a manifest with entries for each operation', () => {
    const files = generateManifest(minimalSpec, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('smoke-manifest.json');
    expect(files[0].skipIfExists).toBe(false);

    const manifest = JSON.parse(files[0].content);
    expect(manifest.entries).toHaveLength(3);
  });

  it('maps operationId, method, and path correctly', () => {
    const files = generateManifest(minimalSpec, ctx);
    const manifest = JSON.parse(files[0].content);
    const listEntry = manifest.entries.find((e: Record<string, unknown>) => e.operationId === 'Organizations.list');

    expect(listEntry).toMatchObject({
      operationId: 'Organizations.list',
      sdkResourceProperty: 'organizations',
      sdkMethodName: 'list',
      httpMethod: 'GET',
      path: '/organizations',
      pathParams: [],
    });
  });

  it('includes required body fields', () => {
    const files = generateManifest(minimalSpec, ctx);
    const manifest = JSON.parse(files[0].content);
    const createEntry = manifest.entries.find((e: Record<string, unknown>) => e.operationId === 'Organizations.create');

    expect(createEntry.bodyFields).toEqual(['name']);
  });

  it('includes path params', () => {
    const files = generateManifest(minimalSpec, ctx);
    const manifest = JSON.parse(files[0].content);
    const retrieveEntry = manifest.entries.find(
      (e: Record<string, unknown>) => e.operationId === 'Organizations.retrieve',
    );

    expect(retrieveEntry.pathParams).toEqual(['id']);
  });

  it('includes all services using toCamelCase for SDK property', () => {
    const specWithUnknown: ApiSpec = {
      ...minimalSpec,
      services: [
        ...minimalSpec.services,
        {
          name: 'UnknownService',
          operations: [
            {
              name: 'list',
              httpMethod: 'get',
              path: '/unknown',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'primitive', type: 'string' },
              errors: [],
              paginated: false,
              idempotent: false,
            },
          ],
        },
      ],
    };
    const files = generateManifest(specWithUnknown, ctx);
    const manifest = JSON.parse(files[0].content);
    // Organizations (3 ops) + UnknownService (1 op)
    expect(manifest.entries).toHaveLength(4);
    const unknownEntry = manifest.entries.find(
      (e: Record<string, unknown>) => e.operationId === 'UnknownService.list',
    );
    expect(unknownEntry).toBeDefined();
    expect(unknownEntry.sdkResourceProperty).toBe('unknownService');
  });
});
