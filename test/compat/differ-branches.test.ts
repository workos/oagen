import { describe, it, expect } from 'vitest';
import { diffSurfaces } from '../../src/compat/differ.js';
import type { ApiSurface } from '../../src/compat/types.js';
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

describe('diffSurfaces — type alias branches', () => {
  it('counts preserved type aliases when values match', () => {
    // Line 316: type alias preserved
    const baseline = emptySurface({
      typeAliases: {
        UserRole: { name: 'UserRole', value: "'admin' | 'user'" },
      },
    });
    const candidate = emptySurface({
      typeAliases: {
        UserRole: { name: 'UserRole', value: "'admin' | 'user'" },
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.preservedSymbols).toBe(1);
    expect(result.violations.length).toBe(0);
  });

  it('detects new type aliases as additions', () => {
    // Line 322: new type alias not in baseline
    const baseline = emptySurface();
    const candidate = emptySurface({
      typeAliases: {
        NewAlias: { name: 'NewAlias', value: 'string' },
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.additions).toContainEqual({ symbolPath: 'NewAlias', symbolType: 'type-alias' });
  });
});

describe('diffSurfaces — class and interface field branches', () => {
  it('detects new class methods as additions', () => {
    // Lines 177-179: candidate class has methods not in baseline
    const baseline = emptySurface({
      classes: {
        Users: {
          name: 'Users',
          methods: {
            list: { name: 'list', params: [], returnType: 'User[]', async: true },
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Users: {
          name: 'Users',
          methods: {
            list: { name: 'list', params: [], returnType: 'User[]', async: true },
            create: { name: 'create', params: [], returnType: 'User', async: true },
          },
          properties: {},
          constructorParams: [],
        },
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.additions).toContainEqual({ symbolPath: 'Users.create', symbolType: 'method' });
  });

  it('detects missing class properties as violations', () => {
    // Lines 186-196: baseline class has property, candidate doesn't
    const baseline = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {},
          properties: {
            baseUrl: { name: 'baseUrl', type: 'string', readonly: true },
            apiKey: { name: 'apiKey', type: 'string', readonly: true },
          },
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {},
          properties: {
            baseUrl: { name: 'baseUrl', type: 'string', readonly: true },
            // apiKey is missing
          },
          constructorParams: [],
        },
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    const propViolations = result.violations.filter((v) => v.symbolPath === 'Client.apiKey');
    expect(propViolations.length).toBe(1);
    expect(propViolations[0].category).toBe('public-api');
  });

  it('detects new class properties as additions', () => {
    // Lines 214-216: candidate has properties not in baseline
    const baseline = emptySurface({
      classes: {
        Users: {
          name: 'Users',
          methods: {},
          properties: { baseUrl: { name: 'baseUrl', type: 'string', readonly: true } },
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Users: {
          name: 'Users',
          methods: {},
          properties: {
            baseUrl: { name: 'baseUrl', type: 'string', readonly: true },
            newProp: { name: 'newProp', type: 'number', readonly: false },
          },
          constructorParams: [],
        },
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.additions).toContainEqual({ symbolPath: 'Users.newProp', symbolType: 'property' });
  });

  it('detects missing interface fields as violations', () => {
    // Lines 249-258: baseline interface has field, candidate doesn't
    const baseline = emptySurface({
      interfaces: {
        User: {
          name: 'User',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
            email: { name: 'email', type: 'string', optional: false },
          },
          extends: [],
        },
      },
    });
    const candidate = emptySurface({
      interfaces: {
        User: {
          name: 'User',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
            // email is missing
          },
          extends: [],
        },
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    const fieldViolations = result.violations.filter((v) => v.symbolPath === 'User.email');
    expect(fieldViolations.length).toBe(1);
    expect(fieldViolations[0].category).toBe('public-api');
  });

  it('detects new interface fields as additions', () => {
    // Lines 277-278: candidate interface has fields not in baseline
    const baseline = emptySurface({
      interfaces: {
        User: {
          name: 'User',
          fields: { id: { name: 'id', type: 'string', optional: false } },
          extends: [],
        },
      },
    });
    const candidate = emptySurface({
      interfaces: {
        User: {
          name: 'User',
          fields: {
            id: { name: 'id', type: 'string', optional: false },
            newField: { name: 'newField', type: 'number', optional: true },
          },
          extends: [],
        },
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.additions).toContainEqual({ symbolPath: 'User.newField', symbolType: 'property' });
  });
});

describe('diffSurfaces — enum and export branches', () => {
  it('detects new enums as additions', () => {
    // Lines 362-364: candidate has enum not in baseline
    const baseline = emptySurface();
    const candidate = emptySurface({
      enums: {
        Status: { name: 'Status', members: { ACTIVE: 'active' } },
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.additions).toContainEqual({ symbolPath: 'Status', symbolType: 'enum' });
  });

  it('detects missing barrel exports as violations', () => {
    // Lines 370-382: baseline has exports, candidate is missing the path entirely
    const baseline = emptySurface({
      exports: {
        './models': ['User', 'Organization'],
      },
    });
    const candidate = emptySurface({
      exports: {},
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    const exportViolations = result.violations.filter((v) => v.category === 'export-structure');
    expect(exportViolations.length).toBe(2);
    expect(exportViolations[0].symbolPath).toContain('./models');
    expect(exportViolations[0].severity).toBe('warning');
  });

  it('detects missing individual exports within a path', () => {
    // Lines 383-390: path exists in candidate but missing some symbols
    const baseline = emptySurface({
      exports: {
        './models': ['User', 'Organization', 'Team'],
      },
    });
    const candidate = emptySurface({
      exports: {
        './models': ['User'],
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    const exportViolations = result.violations.filter((v) => v.category === 'export-structure');
    expect(exportViolations.length).toBe(2); // Organization and Team missing
    expect(exportViolations.map((v) => v.symbolPath)).toContainEqual(expect.stringContaining('Organization'));
  });

  it('counts preserved enums when all members match', () => {
    // Lines 355-357: enum match → preserved++
    const baseline = emptySurface({
      enums: {
        Status: { name: 'Status', members: { ACTIVE: 'active', INACTIVE: 'inactive' } },
      },
    });
    const candidate = emptySurface({
      enums: {
        Status: { name: 'Status', members: { ACTIVE: 'active', INACTIVE: 'inactive' } },
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    expect(result.preservedSymbols).toBe(1);
    expect(result.violations.length).toBe(0);
  });

  it('detects enum member mismatches as violations', () => {
    // Lines 342-354: enum exists in both but has different member values
    const baseline = emptySurface({
      enums: {
        Status: { name: 'Status', members: { ACTIVE: 'active', INACTIVE: 'inactive' } },
      },
    });
    const candidate = emptySurface({
      enums: {
        Status: { name: 'Status', members: { ACTIVE: 'active', INACTIVE: 'disabled' } },
      },
    });

    const result = diffSurfaces(baseline, candidate, nodeHints);
    const enumViolations = result.violations.filter((v) => v.symbolPath.includes('Status'));
    expect(enumViolations.length).toBeGreaterThan(0);
    expect(enumViolations[0].category).toBe('signature');
    expect(enumViolations[0].severity).toBe('breaking');
  });
});
