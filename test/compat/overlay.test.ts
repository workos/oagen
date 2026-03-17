import { describe, it, expect } from 'vitest';
import { buildOverlayLookup, patchOverlay } from '../../src/compat/overlay.js';
import type { ManifestEntry } from '../../src/compat/overlay.js';
import type { ApiSurface, Violation } from '../../src/compat/types.js';
import type { ApiSpec } from '../../src/ir/types.js';

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
    expect(lookup.modelNameByIR.size).toBe(0);
    expect(lookup.fileBySymbol.size).toBe(0);
  });

  it('populates fileBySymbol from enriched surface', () => {
    const surface = emptySurface({
      classes: {
        SampleClient: { name: 'SampleClient', sourceFile: 'src/client.ts', methods: {}, properties: {}, constructorParams: [] },
      },
      interfaces: {
        Organization: { name: 'Organization', sourceFile: 'src/models.ts', fields: {}, extends: [] },
      },
      typeAliases: {
        StatusType: { name: 'StatusType', sourceFile: 'src/models.ts', value: '"active" | "inactive"' },
      },
      enums: {
        Status: { name: 'Status', sourceFile: 'src/models.ts', members: { Active: 'active' } },
      },
    });

    const lookup = buildOverlayLookup(surface);
    expect(lookup.fileBySymbol.get('SampleClient')).toBe('src/client.ts');
    expect(lookup.fileBySymbol.get('Organization')).toBe('src/models.ts');
    expect(lookup.fileBySymbol.get('StatusType')).toBe('src/models.ts');
    expect(lookup.fileBySymbol.get('Status')).toBe('src/models.ts');
  });

  it('remaps fileBySymbol with IR names after modelNameByIR', () => {
    const surface = emptySurface({
      classes: {
        Organizations: {
          name: 'Organizations',
          methods: {
            getOrganization: {
              name: 'getOrganization',
              params: [{ name: 'id', type: 'string', optional: false }],
              returnType: 'Promise<Organization>',
              async: true,
            },
          },
          properties: {},
          constructorParams: [],
        },
      },
      interfaces: {
        Organization: {
          name: 'Organization',
          sourceFile: 'src/models.ts',
          fields: { id: { name: 'id', type: 'string', optional: false } },
          extends: [],
        },
      },
    });

    const manifest: ManifestEntry[] = [
      {
        operationId: 'Organizations.GetOrganization',
        sdkResourceProperty: 'organizations',
        sdkMethodName: 'getOrganization',
        httpMethod: 'GET',
        path: '/organizations/{id}',
        pathParams: ['id'],
        bodyFields: [],
        queryFields: [],
      },
    ];

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [
        {
          name: 'Organizations',
          operations: [
            {
              name: 'GetOrganization',
              httpMethod: 'get',
              path: '/organizations/{id}',
              pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'ControllerOrgResponse' },
              errors: [],
              paginated: false,
              idempotent: false,
            },
          ],
        },
      ],
      enums: [],
      models: [
        {
          name: 'ControllerOrgResponse',
          fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ],
    };

    const lookup = buildOverlayLookup(surface, manifest, spec);
    // SDK name maps to file
    expect(lookup.fileBySymbol.get('Organization')).toBe('src/models.ts');
    // IR name also maps to same file via modelNameByIR remapping
    expect(lookup.fileBySymbol.get('ControllerOrgResponse')).toBe('src/models.ts');
  });

  it('produces empty fileBySymbol from surface without sourceFile fields', () => {
    const surface = emptySurface({
      interfaces: {
        Organization: { name: 'Organization', fields: {}, extends: [] },
      },
    });

    const lookup = buildOverlayLookup(surface);
    expect(lookup.fileBySymbol.size).toBe(0);
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

  it('infers model names from field structure matching', () => {
    const surface = emptySurface({
      interfaces: {
        Organization: {
          name: 'Organization',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
            name: { name: 'name', type: 'string', optional: false },
            createdAt: { name: 'createdAt', type: 'string', optional: false },
            updatedAt: { name: 'updatedAt', type: 'string', optional: false },
          },
          extends: [],
        },
      },
    });

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      enums: [],
      models: [
        {
          name: 'WorkOsControllerOrganizationResponse',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'created_at', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'updated_at', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
      ],
    };

    const lookup = buildOverlayLookup(surface, undefined, spec);
    expect(lookup.modelNameByIR.get('WorkOsControllerOrganizationResponse')).toBe('Organization');
  });

  it('does not match models with low field overlap', () => {
    const surface = emptySurface({
      interfaces: {
        User: {
          name: 'User',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
            email: { name: 'email', type: 'string', optional: false },
            firstName: { name: 'firstName', type: 'string', optional: false },
          },
          extends: [],
        },
      },
    });

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      enums: [],
      models: [
        {
          name: 'TotallyDifferentModel',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'color', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'size', type: { kind: 'primitive', type: 'integer' }, required: true },
            { name: 'weight', type: { kind: 'primitive', type: 'number' }, required: true },
          ],
        },
      ],
    };

    const lookup = buildOverlayLookup(surface, undefined, spec);
    expect(lookup.modelNameByIR.get('TotallyDifferentModel')).toBeUndefined();
  });

  it('infers model names from operation return types when manifest is available', () => {
    const surface = emptySurface({
      classes: {
        Organizations: {
          name: 'Organizations',
          methods: {
            getOrganization: {
              name: 'getOrganization',
              params: [{ name: 'id', type: 'string', optional: false }],
              returnType: 'Promise<Organization>',
              async: true,
            },
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
      },
    });

    const manifest: ManifestEntry[] = [
      {
        operationId: 'Organizations.GetOrganization',
        sdkResourceProperty: 'organizations',
        sdkMethodName: 'getOrganization',
        httpMethod: 'GET',
        path: '/organizations/{id}',
        pathParams: ['id'],
        bodyFields: [],
        queryFields: [],
      },
    ];

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [
        {
          name: 'Organizations',
          operations: [
            {
              name: 'GetOrganization',
              httpMethod: 'get',
              path: '/organizations/{id}',
              pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'ControllerOrgResponse' },
              errors: [],
              paginated: false,
              idempotent: false,
            },
          ],
        },
      ],
      enums: [],
      models: [
        {
          name: 'ControllerOrgResponse',
          fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ],
    };

    const lookup = buildOverlayLookup(surface, manifest, spec);
    expect(lookup.modelNameByIR.get('ControllerOrgResponse')).toBe('Organization');
  });

  it('field matching picks first interface when Jaccard scores tie', () => {
    const surface = emptySurface({
      interfaces: {
        Alpha: {
          name: 'Alpha',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
            name: { name: 'name', type: 'string', optional: false },
            slug: { name: 'slug', type: 'string', optional: false },
          },
          extends: [],
        },
        Beta: {
          name: 'Beta',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
            name: { name: 'name', type: 'string', optional: false },
            slug: { name: 'slug', type: 'string', optional: false },
          },
          extends: [],
        },
      },
    });

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      enums: [],
      models: [
        {
          name: 'MyModel',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
      ],
    };

    const lookup = buildOverlayLookup(surface, undefined, spec);
    // First processed interface wins — Alpha comes before Beta
    expect(lookup.modelNameByIR.get('MyModel')).toBe('Alpha');
  });

  it('skips IR model with only 1 field', () => {
    const surface = emptySurface({
      interfaces: {
        Tiny: {
          name: 'Tiny',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
          },
          extends: [],
        },
      },
    });

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      enums: [],
      models: [
        {
          name: 'TinyModel',
          fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ],
    };

    const lookup = buildOverlayLookup(surface, undefined, spec);
    expect(lookup.modelNameByIR.get('TinyModel')).toBeUndefined();
  });

  it('does not match IR model with 2 fields (needs >= 3 common fields)', () => {
    const surface = emptySurface({
      interfaces: {
        Small: {
          name: 'Small',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
            name: { name: 'name', type: 'string', optional: false },
          },
          extends: [],
        },
      },
    });

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      enums: [],
      models: [
        {
          name: 'SmallModel',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
      ],
    };

    const lookup = buildOverlayLookup(surface, undefined, spec);
    expect(lookup.modelNameByIR.get('SmallModel')).toBeUndefined();
  });

  it('does not produce duplicate mappings', () => {
    const surface = emptySurface({
      interfaces: {
        Org: {
          name: 'Org',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
            name: { name: 'name', type: 'string', optional: false },
            slug: { name: 'slug', type: 'string', optional: false },
          },
          extends: [],
        },
      },
    });

    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      enums: [],
      models: [
        {
          name: 'OrgModelA',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
        {
          name: 'OrgModelB',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
      ],
    };

    const lookup = buildOverlayLookup(surface, undefined, spec);
    // Only one IR model should claim "Org" — first match wins
    const mappedToOrg = [...lookup.modelNameByIR.entries()].filter(([, v]) => v === 'Org');
    expect(mappedToOrg).toHaveLength(1);
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
    expect(patched.requiredExports.get('src/orgs/interfaces/index.ts')).toEqual(new Set(['ListOrgsOptions']));
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

  it('preserves fileBySymbol entries from the original overlay', () => {
    const surface = emptySurface({
      interfaces: {
        Organization: { name: 'Organization', sourceFile: 'src/models.ts', fields: {}, extends: [] },
      },
    });

    const overlay = buildOverlayLookup(surface);
    const patched = patchOverlay(overlay, [], emptySurface());
    expect(patched.fileBySymbol.get('Organization')).toBe('src/models.ts');
  });

  it('does not mutate the original overlay fileBySymbol', () => {
    const surface = emptySurface({
      interfaces: {
        Organization: { name: 'Organization', sourceFile: 'src/models.ts', fields: {}, extends: [] },
      },
    });

    const overlay = buildOverlayLookup(surface);
    const patched = patchOverlay(overlay, [], emptySurface());
    patched.fileBySymbol.set('NewSymbol', 'src/new.ts');
    expect(overlay.fileBySymbol.has('NewSymbol')).toBe(false);
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
      [
        {
          category: 'public-api',
          severity: 'breaking',
          symbolPath: 'Org',
          baseline: 'Org',
          candidate: '(missing)',
          message: '',
        },
      ],
      baseline,
    );

    overlay = patchOverlay(
      overlay,
      [
        {
          category: 'public-api',
          severity: 'breaking',
          symbolPath: 'User',
          baseline: 'User',
          candidate: '(missing)',
          message: '',
        },
      ],
      baseline,
    );

    expect(overlay.interfaceByName.get('Org')).toBe('Org');
    expect(overlay.interfaceByName.get('User')).toBe('User');
  });

  it('gracefully handles method violation when no manifest (no httpKeyByMethod)', () => {
    const baseline = emptySurface({
      classes: {
        Users: {
          name: 'Users',
          methods: {
            listUsers: {
              name: 'listUsers',
              params: [],
              returnType: 'Promise<User[]>',
              async: true,
            },
          },
          properties: {},
          constructorParams: [],
        },
      },
    });

    const overlay = buildOverlayLookup(emptySurface());
    // No manifest → httpKeyByMethod is empty
    expect(overlay.httpKeyByMethod.size).toBe(0);

    const violations: Violation[] = [
      {
        category: 'public-api',
        severity: 'breaking',
        symbolPath: 'Users.listUsers',
        baseline: 'listUsers',
        candidate: '(missing)',
        message: 'Method "Users.listUsers" missing',
      },
    ];

    const patched = patchOverlay(overlay, violations, baseline);
    // Should not crash, and should not add a method mapping (no HTTP key available)
    expect(patched.methodByOperation.size).toBe(0);
  });

  it('returns equivalent overlay when violations array is empty', () => {
    const surface = emptySurface({
      interfaces: {
        Org: { name: 'Org', fields: {}, extends: [] },
      },
    });
    const overlay = buildOverlayLookup(surface);
    const patched = patchOverlay(overlay, [], emptySurface());

    expect(patched.interfaceByName.get('Org')).toBe('Org');
    expect(patched.methodByOperation.size).toBe(overlay.methodByOperation.size);
    expect(patched.requiredExports.size).toBe(overlay.requiredExports.size);
  });

  it('handles violation referencing symbol not in baseline without crashing', () => {
    const overlay = buildOverlayLookup(emptySurface());
    const violations: Violation[] = [
      {
        category: 'public-api',
        severity: 'breaking',
        symbolPath: 'NonExistentClass.missingMethod',
        baseline: 'missingMethod',
        candidate: '(missing)',
        message: 'Method missing',
      },
      {
        category: 'public-api',
        severity: 'breaking',
        symbolPath: 'GhostInterface',
        baseline: 'GhostInterface',
        candidate: '(missing)',
        message: 'Interface missing',
      },
    ];

    // Should not throw — baseline has no matching symbols
    const patched = patchOverlay(overlay, violations, emptySurface());
    expect(patched.methodByOperation.size).toBe(0);
    expect(patched.interfaceByName.size).toBe(0);
  });
});
