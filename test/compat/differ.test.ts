import { describe, it, expect } from 'vitest';
import { diffSurfaces } from '../../src/compat/differ.js';
import type { ApiSurface } from '../../src/compat/types.js';

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
            get: {
              name: 'get',
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
    const result = diffSurfaces(surface, surface);
    expect(result.preservationScore).toBe(100);
    expect(result.violations).toHaveLength(0);
    expect(result.additions).toHaveLength(0);
  });

  it('returns 100% for two empty surfaces', () => {
    const result = diffSurfaces(emptySurface(), emptySurface());
    expect(result.preservationScore).toBe(100);
    expect(result.totalBaselineSymbols).toBe(0);
  });

  it('detects missing class as public-api violation', () => {
    const baseline = emptySurface({
      classes: {
        Client: { name: 'Client', methods: {}, properties: {}, constructorParams: [] },
      },
    });
    const result = diffSurfaces(baseline, emptySurface());
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
            list: { name: 'list', params: [], returnType: 'Promise<void>', async: true },
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
    const result = diffSurfaces(baseline, candidate);
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
            get: { name: 'get', params: [], returnType: 'Promise<Organization>', async: true },
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
            get: { name: 'get', params: [], returnType: 'Promise<Org>', async: true },
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const result = diffSurfaces(baseline, candidate);
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
            list: {
              name: 'list',
              params: [{ name: 'id', type: 'string', optional: false }],
              returnType: 'void',
              async: false,
            },
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
            list: {
              name: 'list',
              params: [
                { name: 'id', type: 'string', optional: false },
                { name: 'limit', type: 'number', optional: true },
              ],
              returnType: 'void',
              async: false,
            },
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const result = diffSurfaces(baseline, candidate);
    expect(result.violations).toHaveLength(0);
    expect(result.preservationScore).toBe(100);
  });

  it('detects removed param as signature violation', () => {
    const baseline = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            get: {
              name: 'get',
              params: [
                { name: 'id', type: 'string', optional: false },
                { name: 'name', type: 'string', optional: false },
              ],
              returnType: 'void',
              async: false,
            },
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
            get: {
              name: 'get',
              params: [{ name: 'id', type: 'string', optional: false }],
              returnType: 'void',
              async: false,
            },
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const result = diffSurfaces(baseline, candidate);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].category).toBe('signature');
  });

  it('detects missing interface as public-api violation', () => {
    const baseline = emptySurface({
      interfaces: {
        Options: { name: 'Options', fields: { key: { name: 'key', type: 'string', optional: false } }, extends: [] },
      },
    });
    const result = diffSurfaces(baseline, emptySurface());
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
    const result = diffSurfaces(baseline, candidate);
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
    const result = diffSurfaces(baseline, candidate);
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
    const result = diffSurfaces(baseline, candidate);
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
    const result = diffSurfaces(baseline, emptySurface());
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ category: 'public-api', symbolPath: 'StatusType' });
  });

  it('detects missing enum as public-api violation', () => {
    const baseline = emptySurface({
      enums: {
        Status: { name: 'Status', members: { Active: 'active', Inactive: 'inactive' } },
      },
    });
    const result = diffSurfaces(baseline, emptySurface());
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ category: 'public-api', symbolPath: 'Status' });
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
    const result = diffSurfaces(baseline, candidate);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ category: 'signature', symbolPath: 'Status.Active' });
  });
});
