import { describe, it, expect } from 'vitest';
import { detectStaleSymbols } from '../../src/compat/staleness.js';
import type { ApiSurface } from '../../src/compat/types.js';
import type { ApiSpec } from '../../src/ir/types.js';
import { nodeHints } from '../../src/compat/language-hints.js';

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

function emptySpec(overrides?: Partial<ApiSpec>): ApiSpec {
  return {
    version: '1.0.0',
    title: 'Test API',
    baseUrl: 'https://api.test.com',
    models: [],
    enums: [],
    services: [],
    ...overrides,
  };
}

describe('detectStaleSymbols', () => {
  it('detects removed model as stale when still in live surface', () => {
    const oldSpec = emptySpec({
      models: [{ name: 'Organization', fields: [] }],
    });
    const newSpec = emptySpec();
    const surface = emptySurface({
      interfaces: {
        Organization: { name: 'Organization', fields: {}, extends: [] },
      },
    });

    const violations = detectStaleSymbols(surface, oldSpec, newSpec, nodeHints);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      category: 'staleness',
      severity: 'warning',
      symbolPath: 'Organization',
      message: 'Interface "Organization" is no longer defined in the OpenAPI spec',
    });
  });

  it('does not flag removed model when already absent from live surface', () => {
    const oldSpec = emptySpec({
      models: [{ name: 'Organization', fields: [] }],
    });
    const newSpec = emptySpec();
    const surface = emptySurface(); // no Organization in surface

    const violations = detectStaleSymbols(surface, oldSpec, newSpec, nodeHints);
    expect(violations).toHaveLength(0);
  });

  it('detects removed enum as stale', () => {
    const oldSpec = emptySpec({
      enums: [{ name: 'ConnectionStatus', values: [{ name: 'Active', value: 'active' }] }],
    });
    const newSpec = emptySpec();
    const surface = emptySurface({
      enums: {
        ConnectionStatus: { name: 'ConnectionStatus', members: { Active: 'active' } },
      },
    });

    const violations = detectStaleSymbols(surface, oldSpec, newSpec, nodeHints);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      category: 'staleness',
      severity: 'warning',
      symbolPath: 'ConnectionStatus',
      message: 'Enum "ConnectionStatus" is no longer defined in the OpenAPI spec',
    });
  });

  it('detects removed operation method as stale (service still exists)', () => {
    const oldSpec = emptySpec({
      services: [
        {
          name: 'Users',
          operations: [
            {
              name: 'getUser',
              httpMethod: 'GET',
              path: '/users/{id}',
              pathParams: [{ name: 'id', type: { kind: 'primitive', name: 'string' }, required: true }],
              queryParams: [],
              headerParams: [],
              response: { kind: 'primitive', name: 'void' },
              errors: [],
              idempotent: false,
            },
            {
              name: 'deleteUser',
              httpMethod: 'DELETE',
              path: '/users/{id}',
              pathParams: [{ name: 'id', type: { kind: 'primitive', name: 'string' }, required: true }],
              queryParams: [],
              headerParams: [],
              response: { kind: 'primitive', name: 'void' },
              errors: [],
              idempotent: false,
            },
          ],
        },
      ],
    });
    const newSpec = emptySpec({
      services: [
        {
          name: 'Users',
          operations: [
            {
              name: 'getUser',
              httpMethod: 'GET',
              path: '/users/{id}',
              pathParams: [{ name: 'id', type: { kind: 'primitive', name: 'string' }, required: true }],
              queryParams: [],
              headerParams: [],
              response: { kind: 'primitive', name: 'void' },
              errors: [],
              idempotent: false,
            },
          ],
        },
      ],
    });
    const surface = emptySurface({
      classes: {
        Users: {
          name: 'Users',
          methods: {
            getUser: [{ name: 'getUser', params: [], returnType: 'Promise<void>', async: true }],
            deleteUser: [{ name: 'deleteUser', params: [], returnType: 'Promise<void>', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });

    const violations = detectStaleSymbols(surface, oldSpec, newSpec, nodeHints);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      category: 'staleness',
      severity: 'warning',
      symbolPath: 'Users.deleteUser',
      message: 'Method "Users.deleteUser" is no longer defined in the OpenAPI spec',
    });
  });

  it('detects removed field as stale (model still exists)', () => {
    const oldSpec = emptySpec({
      models: [
        {
          name: 'Organization',
          fields: [
            { name: 'id', type: { kind: 'primitive', name: 'string' }, required: true },
            { name: 'legacyCode', type: { kind: 'primitive', name: 'string' }, required: false },
          ],
        },
      ],
    });
    const newSpec = emptySpec({
      models: [
        {
          name: 'Organization',
          fields: [{ name: 'id', type: { kind: 'primitive', name: 'string' }, required: true }],
        },
      ],
    });
    const surface = emptySurface({
      interfaces: {
        Organization: {
          name: 'Organization',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
            legacyCode: { name: 'legacyCode', type: 'string', optional: true },
          },
          extends: [],
        },
      },
    });

    const violations = detectStaleSymbols(surface, oldSpec, newSpec, nodeHints);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      category: 'staleness',
      severity: 'warning',
      symbolPath: 'Organization.legacyCode',
      message: 'Field "Organization.legacyCode" is no longer defined in the OpenAPI spec',
    });
  });

  it('detects service removed entirely as stale class', () => {
    const oldSpec = emptySpec({
      services: [
        {
          name: 'LegacyService',
          operations: [
            {
              name: 'doThing',
              httpMethod: 'GET',
              path: '/legacy/thing',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'primitive', name: 'void' },
              errors: [],
              idempotent: false,
            },
          ],
        },
      ],
    });
    const newSpec = emptySpec();
    const surface = emptySurface({
      classes: {
        LegacyService: {
          name: 'LegacyService',
          methods: {
            doThing: [{ name: 'doThing', params: [], returnType: 'Promise<void>', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });

    const violations = detectStaleSymbols(surface, oldSpec, newSpec, nodeHints);
    // Should flag the class itself
    const classViolation = violations.find((v) => v.symbolPath === 'LegacyService');
    expect(classViolation).toBeDefined();
    expect(classViolation).toMatchObject({
      category: 'staleness',
      severity: 'warning',
      message: 'Class "LegacyService" is no longer defined in the OpenAPI spec',
    });
  });

  it('does not flag hand-written symbols that were never in any spec', () => {
    const oldSpec = emptySpec({
      models: [{ name: 'Organization', fields: [] }],
    });
    const newSpec = emptySpec({
      models: [{ name: 'Organization', fields: [] }],
    });
    const surface = emptySurface({
      interfaces: {
        Organization: { name: 'Organization', fields: {}, extends: [] },
        // Hand-written helper — never in any spec
        CustomHelper: { name: 'CustomHelper', fields: {}, extends: [] },
      },
      classes: {
        WorkOS: {
          name: 'WorkOS',
          methods: {},
          properties: {},
          constructorParams: [],
        },
      },
    });

    const violations = detectStaleSymbols(surface, oldSpec, newSpec, nodeHints);
    expect(violations).toHaveLength(0);
  });

  it('produces no staleness findings when specs are identical', () => {
    const spec = emptySpec({
      models: [{ name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', name: 'string' }, required: true }] }],
      enums: [{ name: 'Status', values: [{ name: 'Active', value: 'active' }] }],
      services: [
        {
          name: 'Orgs',
          operations: [
            {
              name: 'getOrg',
              httpMethod: 'GET',
              path: '/orgs/{id}',
              pathParams: [{ name: 'id', type: { kind: 'primitive', name: 'string' }, required: true }],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'Organization' },
              errors: [],
              idempotent: false,
            },
          ],
        },
      ],
    });
    const surface = emptySurface({
      interfaces: {
        Organization: {
          name: 'Organization',
          fields: { id: { name: 'id', type: 'string', optional: false } },
          extends: [],
        },
      },
      enums: { Status: { name: 'Status', members: { Active: 'active' } } },
      classes: {
        Orgs: {
          name: 'Orgs',
          methods: {
            getOrg: [{ name: 'getOrg', params: [], returnType: 'Promise<Organization>', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });

    const violations = detectStaleSymbols(surface, spec, spec, nodeHints);
    expect(violations).toHaveLength(0);
  });
});
