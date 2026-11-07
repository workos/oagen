import { describe, it, expect } from 'vitest';
import { buildOverlayLookup } from '../../src/compat/overlay.js';
import type { ManifestEntry } from '../../src/compat/overlay.js';
import type { ApiSurface } from '../../src/compat/types.js';
import type { ApiSpec } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

function emptySurface(overrides?: Partial<ApiSurface>): ApiSurface {
  return {
    language: 'node',
    extractedFrom: '/test',
    extractedAt: '2024-01-01T00:00:00Z',
    classes: {},
    interfaces: {},
    typeAliases: {},
    enums: {},
    exports: {},
    ...overrides,
  };
}

describe('buildOverlayLookup — operation-based model name mapping', () => {
  it('maps request body model to SDK param type', () => {
    // Lines 202-213: match requestBody model → SDK param type via manifest
    const surface = emptySurface({
      classes: {
        Organizations: {
          name: 'Organizations',
          methods: {
            create: [
              {
                name: 'create',
                params: [{ name: 'options', type: 'CreateOrganizationOptions', optional: false }],
                returnType: 'Organization',
                async: true,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
      interfaces: {
        Organization: {
          name: 'Organization',
          fields: { id: { name: 'id', type: 'string', optional: false } },
          extends: [],
        },
        CreateOrganizationOptions: {
          name: 'CreateOrganizationOptions',
          fields: { name: { name: 'name', type: 'string', optional: false } },
          extends: [],
        },
      },
    });

    const manifest: ManifestEntry[] = [
      {
        operationId: 'createOrganization',
        sdkResourceProperty: 'organizations',
        sdkMethodName: 'create',
        httpMethod: 'POST',
        path: '/organizations',
        pathParams: [],
        bodyFields: ['name'],
        queryFields: [],
      },
    ];

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.test.com',
      services: [
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
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
      models: [
        { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
        {
          name: 'CreateOrganization',
          fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ],
      enums: [],
      sdk: defaultSdkBehavior(),
    };

    const lookup = buildOverlayLookup(surface, manifest, spec);

    // Response model mapping
    expect(lookup.modelNameByIR.get('Organization')).toBe('Organization');
    // Request body mapping — CreateOrganization → CreateOrganizationOptions
    expect(lookup.modelNameByIR.get('CreateOrganization')).toBe('CreateOrganizationOptions');
  });

  it('skips primitive param types when matching request body', () => {
    // Line 161-162: extractParamTypeName returns null for primitives
    const surface = emptySurface({
      classes: {
        Users: {
          name: 'Users',
          methods: {
            get: [
              {
                name: 'get',
                params: [{ name: 'id', type: 'string', optional: false }],
                returnType: 'User',
                async: true,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
      interfaces: {
        User: {
          name: 'User',
          fields: { id: { name: 'id', type: 'string', optional: false } },
          extends: [],
        },
      },
    });

    const manifest: ManifestEntry[] = [
      {
        operationId: 'getUser',
        sdkResourceProperty: 'users',
        sdkMethodName: 'get',
        httpMethod: 'GET',
        path: '/users/{user_id}',
        pathParams: ['user_id'],
        bodyFields: [],
        queryFields: [],
      },
    ];

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.test.com',
      services: [
        {
          name: 'Users',
          operations: [
            {
              name: 'get',
              httpMethod: 'get',
              path: '/users/{user_id}',
              pathParams: [{ name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true }],
              queryParams: [],
              headerParams: [],
              requestBody: { kind: 'model', name: 'GetUserRequest' },
              response: { kind: 'model', name: 'User' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
      models: [
        { name: 'User', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
        {
          name: 'GetUserRequest',
          fields: [{ name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ],
      enums: [],
      sdk: defaultSdkBehavior(),
    };

    const lookup = buildOverlayLookup(surface, manifest, spec);

    // User should be mapped from response type
    expect(lookup.modelNameByIR.get('User')).toBe('User');
    // GetUserRequest should NOT be mapped (param type is 'string', a primitive)
    expect(lookup.modelNameByIR.has('GetUserRequest')).toBe(false);
  });
});

describe('buildOverlayLookup — a nullable response or request body (#615)', () => {
  it('maps the model under a `nullable` wrapper by the operation, as a `$ref` to a component that admits null is typed', () => {
    // One-field models whose IR names differ from the SDK's: neither the
    // exact-name pass nor the Jaccard fallback can map them, so only the
    // operation-based pass can — and it must read through the wrapper.
    const surface = emptySurface({
      classes: {
        Organizations: {
          name: 'Organizations',
          methods: {
            update: [
              {
                name: 'update',
                params: [{ name: 'options', type: 'UpdateOrganizationOptions', optional: false }],
                returnType: 'Organization',
                async: true,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
      interfaces: {
        Organization: {
          name: 'Organization',
          fields: { id: { name: 'id', type: 'string', optional: false } },
          extends: [],
        },
        UpdateOrganizationOptions: {
          name: 'UpdateOrganizationOptions',
          fields: { name: { name: 'name', type: 'string', optional: false } },
          extends: [],
        },
      },
    });

    const manifest: ManifestEntry[] = [
      {
        operationId: 'updateOrganization',
        sdkResourceProperty: 'organizations',
        sdkMethodName: 'update',
        httpMethod: 'PUT',
        path: '/organizations',
        pathParams: [],
        bodyFields: ['name'],
        queryFields: [],
      },
    ];

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.test.com',
      services: [
        {
          name: 'Organizations',
          operations: [
            {
              name: 'update',
              httpMethod: 'put',
              path: '/organizations',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              requestBody: { kind: 'nullable', inner: { kind: 'model', name: 'OrgPatch' } },
              response: { kind: 'nullable', inner: { kind: 'model', name: 'Org' } },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
      models: [
        { name: 'Org', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
        { name: 'OrgPatch', fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }] },
      ],
      enums: [],
      sdk: defaultSdkBehavior(),
    };

    const lookup = buildOverlayLookup(surface, manifest, spec);
    expect(lookup.modelNameByIR.get('Org')).toBe('Organization');
    expect(lookup.modelNameByIR.get('OrgPatch')).toBe('UpdateOrganizationOptions');
  });
});
