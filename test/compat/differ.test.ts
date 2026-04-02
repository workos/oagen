import { describe, it, expect } from 'vitest';
import { diffSurfaces, specDerivedNames, filterSurface } from '../../src/compat/differ.js';
import type { ApiSurface } from '../../src/compat/types.js';
import type { ApiSpec } from '../../src/ir/types.js';
import { nodeHints } from '../../src/compat/language-hints.js';
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

describe('diffSurfaces', () => {
  it('returns 100% score for identical surfaces', () => {
    const surface = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            get: [
              {
                name: 'get',
                params: [{ name: 'id', type: 'string', optional: false }],
                returnType: 'Promise<Organization>',
                async: true,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const result = diffSurfaces(surface, surface, nodeHints);
    expect(result.preservationScore).toBe(100);
    expect(result.violations).toHaveLength(0);
    expect(result.additions).toHaveLength(0);
  });

  it('returns 100% for two empty surfaces', () => {
    const result = diffSurfaces(emptySurface(), emptySurface(), nodeHints);
    expect(result.preservationScore).toBe(100);
    expect(result.totalBaselineSymbols).toBe(0);
  });

  it('detects missing class as public-api violation', () => {
    const baseline = emptySurface({
      classes: {
        Client: { name: 'Client', methods: {}, properties: {}, constructorParams: [] },
      },
    });
    const result = diffSurfaces(baseline, emptySurface(), nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      category: 'public-api',
      severity: 'breaking',
      symbolPath: 'Client',
    });
    expect(result.preservationScore).toBe(0);
  });

  it('detects missing method as public-api violation', () => {
    const baseline = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            list: [{ name: 'list', params: [], returnType: 'Promise<void>', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: { name: 'Client', methods: {}, properties: {}, constructorParams: [] },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      category: 'public-api',
      severity: 'breaking',
      symbolPath: 'Client.list',
    });
  });

  it('detects changed return type as signature violation', () => {
    const baseline = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            get: [{ name: 'get', params: [], returnType: 'Promise<Organization>', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            get: [{ name: 'get', params: [], returnType: 'Promise<Org>', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      category: 'signature',
      severity: 'breaking',
      symbolPath: 'Client.get',
    });
  });

  it('allows new optional param at end (non-breaking)', () => {
    const baseline = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            list: [
              {
                name: 'list',
                params: [{ name: 'id', type: 'string', optional: false }],
                returnType: 'void',
                async: false,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            list: [
              {
                name: 'list',
                params: [
                  { name: 'id', type: 'string', optional: false },
                  { name: 'limit', type: 'number', optional: true },
                ],
                returnType: 'void',
                async: false,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(0);
    expect(result.preservationScore).toBe(100);
  });

  it('detects removed param as signature violation', () => {
    const baseline = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            get: [
              {
                name: 'get',
                params: [
                  { name: 'id', type: 'string', optional: false },
                  { name: 'name', type: 'string', optional: false },
                ],
                returnType: 'void',
                async: false,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            get: [
              {
                name: 'get',
                params: [{ name: 'id', type: 'string', optional: false }],
                returnType: 'void',
                async: false,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].category).toBe('signature');
  });

  it('detects missing interface as public-api violation', () => {
    const baseline = emptySurface({
      interfaces: {
        Options: { name: 'Options', fields: { key: { name: 'key', type: 'string', optional: false } }, extends: [] },
      },
    });
    const result = diffSurfaces(baseline, emptySurface(), nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      category: 'public-api',
      symbolPath: 'Options',
    });
  });

  it('detects missing barrel export as export-structure violation', () => {
    const baseline = emptySurface({
      exports: { 'src/index.ts': ['Client', 'Options'] },
    });
    const candidate = emptySurface({
      exports: { 'src/index.ts': ['Client'] },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      category: 'export-structure',
      severity: 'warning',
    });
    expect(result.violations[0].message).toContain('Options');
  });

  it('reports new symbols as additions, not violations', () => {
    const baseline = emptySurface({
      classes: {
        Client: { name: 'Client', methods: {}, properties: {}, constructorParams: [] },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: { name: 'Client', methods: {}, properties: {}, constructorParams: [] },
        NewClient: { name: 'NewClient', methods: {}, properties: {}, constructorParams: [] },
      },
      interfaces: {
        NewInterface: { name: 'NewInterface', fields: {}, extends: [] },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(0);
    expect(result.additions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbolPath: 'NewClient', symbolType: 'class' }),
        expect.objectContaining({ symbolPath: 'NewInterface', symbolType: 'interface' }),
      ]),
    );
  });

  it('detects changed field type in interface as signature violation', () => {
    const baseline = emptySurface({
      interfaces: {
        Org: { name: 'Org', fields: { id: { name: 'id', type: 'string', optional: false } }, extends: [] },
      },
    });
    const candidate = emptySurface({
      interfaces: {
        Org: { name: 'Org', fields: { id: { name: 'id', type: 'number', optional: false } }, extends: [] },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      category: 'signature',
      symbolPath: 'Org.id',
    });
  });

  it('detects missing type alias as public-api violation', () => {
    const baseline = emptySurface({
      typeAliases: {
        StatusType: { name: 'StatusType', value: '"active" | "inactive"' },
      },
    });
    const result = diffSurfaces(baseline, emptySurface(), nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ category: 'public-api', symbolPath: 'StatusType' });
  });

  it('detects missing enum as public-api violation', () => {
    const baseline = emptySurface({
      enums: {
        Status: { name: 'Status', members: { Active: 'active', Inactive: 'inactive' } },
      },
    });
    const result = diffSurfaces(baseline, emptySurface(), nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ category: 'public-api', symbolPath: 'Status' });
  });

  it('downgrades nullable-only field mismatch to warning', () => {
    const baseline = emptySurface({
      interfaces: {
        Org: {
          name: 'Org',
          fields: { name: { name: 'name', type: 'string', optional: false } },
          extends: [],
        },
      },
    });
    const candidate = emptySurface({
      interfaces: {
        Org: {
          name: 'Org',
          fields: { name: { name: 'name', type: 'string | null', optional: false } },
          extends: [],
        },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('warning');
  });

  it('downgrades nullable-only property mismatch to warning', () => {
    const baseline = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {},
          properties: { name: { name: 'name', type: 'string', readonly: true } },
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {},
          properties: { name: { name: 'name', type: 'string | null', readonly: true } },
          constructorParams: [],
        },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('warning');
  });

  it('downgrades nullable-only type alias mismatch to warning', () => {
    const baseline = emptySurface({
      typeAliases: {
        MyType: { name: 'MyType', value: 'string' },
      },
    });
    const candidate = emptySurface({
      typeAliases: {
        MyType: { name: 'MyType', value: 'string | null' },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('warning');
  });

  it('keeps non-nullable type mismatch as breaking', () => {
    const baseline = emptySurface({
      interfaces: {
        Org: {
          name: 'Org',
          fields: { name: { name: 'name', type: 'string', optional: false } },
          extends: [],
        },
      },
    });
    const candidate = emptySurface({
      interfaces: {
        Org: {
          name: 'Org',
          fields: { name: { name: 'name', type: 'number', optional: false } },
          extends: [],
        },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('breaking');
  });

  it('detects enum member value change as signature violation', () => {
    const baseline = emptySurface({
      enums: {
        Status: { name: 'Status', members: { Active: 'active' } },
      },
    });
    const candidate = emptySurface({
      enums: {
        Status: { name: 'Status', members: { Active: 'enabled' } },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ category: 'signature', symbolPath: 'Status.Active' });
  });

  it('reports no violations when candidate has matching method overloads', () => {
    const surface = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            create: [
              {
                name: 'create',
                params: [{ name: 'params', type: 'CreateOptions', optional: false }],
                returnType: 'Promise<Organization>',
                async: true,
              },
              {
                name: 'create',
                params: [
                  { name: 'params', type: 'CreateOptions', optional: false },
                  { name: 'options', type: 'RequestOptions', optional: true },
                ],
                returnType: 'Promise<Organization>',
                async: true,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const result = diffSurfaces(surface, surface, nodeHints);
    expect(result.violations).toHaveLength(0);
    expect(result.preservationScore).toBe(100);
  });

  it('detects violation when candidate is missing one overload from baseline', () => {
    const baseline = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            create: [
              {
                name: 'create',
                params: [{ name: 'params', type: 'CreateOptions', optional: false }],
                returnType: 'Promise<Organization>',
                async: true,
              },
              {
                name: 'create',
                params: [
                  { name: 'params', type: 'CreateOptions', optional: false },
                  { name: 'options', type: 'RequestOptions', optional: true },
                ],
                returnType: 'Promise<Organization>',
                async: true,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            create: [
              {
                name: 'create',
                params: [{ name: 'params', type: 'CreateOptions', optional: false }],
                returnType: 'Promise<Organization>',
                async: true,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.violations.length).toBeGreaterThan(0);
    const overloadViolation = result.violations.find((v) => v.symbolPath === 'Client.create');
    expect(overloadViolation).toBeDefined();
  });
});

describe('specDerivedNames', () => {
  it('includes model names with Response and Serialized variants', () => {
    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      enums: [],
      models: [
        {
          name: 'Organization',
          fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ],
      sdk: defaultSdkBehavior(),
    };

    const names = specDerivedNames(spec, nodeHints);
    expect(names.has('Organization')).toBe(true);
    expect(names.has('OrganizationResponse')).toBe(true);
    expect(names.has('SerializedOrganization')).toBe(true);
  });

  it('includes enum names', () => {
    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      enums: [{ name: 'Status', values: [{ name: 'ACTIVE', value: 'active' }] }],
      models: [],
      sdk: defaultSdkBehavior(),
    };

    const names = specDerivedNames(spec, nodeHints);
    expect(names.has('Status')).toBe(true);
  });

  it('includes service names', () => {
    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [
        {
          name: 'Organizations',
          operations: [
            {
              name: 'list',
              httpMethod: 'get',
              path: '/orgs',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'Org' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
      enums: [],
      models: [],
      sdk: defaultSdkBehavior(),
    };

    const names = specDerivedNames(spec, nodeHints);
    expect(names.has('Organizations')).toBe(true);
    expect(names.has('Org')).toBe(true);
    expect(names.has('OrgResponse')).toBe(true);
    expect(names.has('SerializedOrg')).toBe(true);
  });
});

describe('filterSurface', () => {
  it('drops interfaces not in allowed set', () => {
    const surface = emptySurface({
      interfaces: {
        Organization: { name: 'Organization', fields: {}, extends: [] },
        HandWrittenHelper: { name: 'HandWrittenHelper', fields: {}, extends: [] },
      },
    });

    const allowed = new Set(['Organization']);
    const filtered = filterSurface(surface, allowed);

    expect(filtered.interfaces['Organization']).toBeDefined();
    expect(filtered.interfaces['HandWrittenHelper']).toBeUndefined();
  });

  it('drops classes not in allowed set', () => {
    const surface = emptySurface({
      classes: {
        Users: { name: 'Users', methods: {}, properties: {}, constructorParams: [] },
        Internal: { name: 'Internal', methods: {}, properties: {}, constructorParams: [] },
      },
    });

    const allowed = new Set(['Users']);
    const filtered = filterSurface(surface, allowed);

    expect(filtered.classes['Users']).toBeDefined();
    expect(filtered.classes['Internal']).toBeUndefined();
  });

  it('returns empty exports (line 101)', () => {
    const surface = emptySurface({
      exports: { 'src/index.ts': ['Client', 'Options'] },
      interfaces: {
        Options: { name: 'Options', fields: {}, extends: [] },
      },
    });

    const allowed = new Set(['Options']);
    const filtered = filterSurface(surface, allowed);

    // filterSurface always returns empty exports for scoped comparison
    expect(Object.keys(filtered.exports)).toHaveLength(0);
  });

  it('filters type aliases and enums', () => {
    const surface = emptySurface({
      typeAliases: {
        OrgId: { name: 'OrgId', value: 'string' },
        InternalId: { name: 'InternalId', value: 'string' },
      },
      enums: {
        Status: { name: 'Status', members: { Active: 'active' } },
        InternalState: { name: 'InternalState', members: { Open: 'open' } },
      },
    });

    const allowed = new Set(['OrgId', 'Status']);
    const filtered = filterSurface(surface, allowed);

    expect(filtered.typeAliases['OrgId']).toBeDefined();
    expect(filtered.typeAliases['InternalId']).toBeUndefined();
    expect(filtered.enums['Status']).toBeDefined();
    expect(filtered.enums['InternalState']).toBeUndefined();
  });
});
