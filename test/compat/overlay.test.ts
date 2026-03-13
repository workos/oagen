import { describe, it, expect } from 'vitest';
import { buildOverlayLookup, patchOverlay } from '../../src/compat/overlay.js';
import type { ManifestEntry } from '../../src/compat/overlay.js';
import type { ApiSurface, Violation } from '../../src/compat/types.js';

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

describe('buildOverlayLookup', () => {
  it('builds method lookup from manifest entries', () => {
    const surface = emptySurface({
      classes: {
        Organizations: {
          name: 'Organizations',
          methods: {
            listOrgs: {
              name: 'listOrgs',
              params: [{ name: 'options', type: 'ListOrgsOptions', optional: true }],
              returnType: 'Promise<Organization[]>',
              async: true,
            },
            getOrg: {
              name: 'getOrg',
              params: [{ name: 'id', type: 'string', optional: false }],
              returnType: 'Promise<Organization>',
              async: true,
            },
          },
          properties: {},
          constructorParams: [],
        },
      },
    });

    const manifest: ManifestEntry[] = [
      {
        operationId: 'Organizations.ListOrganizations',
        sdkResourceProperty: 'organizations',
        sdkMethodName: 'listOrgs',
        httpMethod: 'GET',
        path: '/organizations',
        pathParams: [],
        bodyFields: [],
        queryFields: [],
      },
      {
        operationId: 'Organizations.GetOrganization',
        sdkResourceProperty: 'organizations',
        sdkMethodName: 'getOrg',
        httpMethod: 'GET',
        path: '/organizations/{id}',
        pathParams: ['id'],
        bodyFields: [],
        queryFields: [],
      },
    ];

    const lookup = buildOverlayLookup(surface, manifest);

    expect(lookup.methodByOperation.get('GET /organizations')).toEqual({
      className: 'Organizations',
      methodName: 'listOrgs',
      params: [{ name: 'options', type: 'ListOrgsOptions', optional: true }],
      returnType: 'Promise<Organization[]>',
    });

    expect(lookup.methodByOperation.get('GET /organizations/{id}')).toEqual({
      className: 'Organizations',
      methodName: 'getOrg',
      params: [{ name: 'id', type: 'string', optional: false }],
      returnType: 'Promise<Organization>',
    });
  });

  it('maps interface names from surface', () => {
    const surface = emptySurface({
      interfaces: {
        Organization: { name: 'Organization', fields: {}, extends: [] },
        User: { name: 'User', fields: {}, extends: [] },
      },
    });

    const lookup = buildOverlayLookup(surface);
    expect(lookup.interfaceByName.get('Organization')).toBe('Organization');
    expect(lookup.interfaceByName.get('User')).toBe('User');
    expect(lookup.interfaceByName.get('NotPresent')).toBeUndefined();
  });

  it('maps type alias names from surface', () => {
    const surface = emptySurface({
      typeAliases: {
        OrgId: { name: 'OrgId', value: 'string' },
      },
    });

    const lookup = buildOverlayLookup(surface);
    expect(lookup.typeAliasByName.get('OrgId')).toBe('OrgId');
  });

  it('maps barrel exports from surface', () => {
    const surface = emptySurface({
      exports: {
        'src/organizations/interfaces/index.ts': ['Organization', 'ListOrgsOptions'],
        'src/users/interfaces/index.ts': ['User'],
      },
    });

    const lookup = buildOverlayLookup(surface);
    expect(lookup.requiredExports.get('src/organizations/interfaces/index.ts')).toEqual(
      new Set(['Organization', 'ListOrgsOptions']),
    );
  });

  it('returns empty lookup when no manifest and empty surface', () => {
    const lookup = buildOverlayLookup(emptySurface());
    expect(lookup.methodByOperation.size).toBe(0);
    expect(lookup.interfaceByName.size).toBe(0);
    expect(lookup.typeAliasByName.size).toBe(0);
    expect(lookup.requiredExports.size).toBe(0);
  });

  it('normalizes httpMethod to uppercase for key lookup', () => {
    const surface = emptySurface({
      classes: {
        Users: {
          name: 'Users',
          methods: {
            createUser: {
              name: 'createUser',
              params: [],
              returnType: 'Promise<User>',
              async: true,
            },
          },
          properties: {},
          constructorParams: [],
        },
      },
    });

    const manifest: ManifestEntry[] = [
      {
        operationId: 'Users.CreateUser',
        sdkResourceProperty: 'users',
        sdkMethodName: 'createUser',
        httpMethod: 'post',
        path: '/users',
        pathParams: [],
        bodyFields: [],
        queryFields: [],
      },
    ];

    const lookup = buildOverlayLookup(surface, manifest);
    expect(lookup.methodByOperation.get('POST /users')).toBeDefined();
    expect(lookup.methodByOperation.get('POST /users')!.methodName).toBe('createUser');
  });

  it('skips manifest entries with no matching class', () => {
    const surface = emptySurface(); // no classes

    const manifest: ManifestEntry[] = [
      {
        operationId: 'Foo.bar',
        sdkResourceProperty: 'foo',
        sdkMethodName: 'bar',
        httpMethod: 'GET',
        path: '/foo',
        pathParams: [],
        bodyFields: [],
        queryFields: [],
      },
    ];

    const lookup = buildOverlayLookup(surface, manifest);
    expect(lookup.methodByOperation.size).toBe(0);
  });
});

describe('patchOverlay', () => {
  it('adds export-structure violations to requiredExports', () => {
    const overlay = buildOverlayLookup(emptySurface());
    const violations: Violation[] = [
      {
        category: 'export-structure',
        severity: 'warning',
        symbolPath: 'exports[src/orgs/interfaces/index.ts].ListOrgsOptions',
        baseline: 'ListOrgsOptions',
        candidate: '(missing)',
        message: 'Export "ListOrgsOptions" not found',
      },
    ];

    const patched = patchOverlay(overlay, violations, emptySurface());
    expect(patched.requiredExports.get('src/orgs/interfaces/index.ts')).toEqual(
      new Set(['ListOrgsOptions']),
    );
  });

  it('adds interface name mappings from public-api violations', () => {
    const baseline = emptySurface({
      interfaces: {
        Organization: { name: 'Organization', fields: {}, extends: [] },
      },
    });

    const overlay = buildOverlayLookup(emptySurface());
    const violations: Violation[] = [
      {
        category: 'public-api',
        severity: 'breaking',
        symbolPath: 'Organization',
        baseline: 'Organization',
        candidate: '(missing)',
        message: 'Interface "Organization" missing',
      },
    ];

    const patched = patchOverlay(overlay, violations, baseline);
    expect(patched.interfaceByName.get('Organization')).toBe('Organization');
  });

  it('does not mutate the original overlay', () => {
    const overlay = buildOverlayLookup(emptySurface());
    const violations: Violation[] = [
      {
        category: 'export-structure',
        severity: 'warning',
        symbolPath: 'exports[foo.ts].Bar',
        baseline: 'Bar',
        candidate: '(missing)',
        message: 'Export missing',
      },
    ];

    patchOverlay(overlay, violations, emptySurface());
    expect(overlay.requiredExports.size).toBe(0);
  });

  it('accumulates constraints across multiple patches', () => {
    const baseline = emptySurface({
      interfaces: {
        Org: { name: 'Org', fields: {}, extends: [] },
        User: { name: 'User', fields: {}, extends: [] },
      },
    });

    let overlay = buildOverlayLookup(emptySurface());

    overlay = patchOverlay(
      overlay,
      [{ category: 'public-api', severity: 'breaking', symbolPath: 'Org', baseline: 'Org', candidate: '(missing)', message: '' }],
      baseline,
    );

    overlay = patchOverlay(
      overlay,
      [{ category: 'public-api', severity: 'breaking', symbolPath: 'User', baseline: 'User', candidate: '(missing)', message: '' }],
      baseline,
    );

    expect(overlay.interfaceByName.get('Org')).toBe('Org');
    expect(overlay.interfaceByName.get('User')).toBe('User');
  });
});
