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

describe('diffSurfaces — enum and export branches', () => {
  it('detects new enums as additions', () => {
    // Lines 362-364: candidate has enum not in baseline
    const baseline = emptySurface();
    const candidate = emptySurface({
      enums: {
        Status: { name: 'Status', members: { ACTIVE: 'active' } },
      },
    });

    const result = diffSurfaces(baseline, candidate);
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

    const result = diffSurfaces(baseline, candidate);
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

    const result = diffSurfaces(baseline, candidate);
    const exportViolations = result.violations.filter((v) => v.category === 'export-structure');
    expect(exportViolations.length).toBe(2); // Organization and Team missing
    expect(exportViolations.map((v) => v.symbolPath)).toContainEqual(
      expect.stringContaining('Organization'),
    );
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

    const result = diffSurfaces(baseline, candidate);
    const enumViolations = result.violations.filter((v) => v.symbolPath.includes('Status'));
    expect(enumViolations.length).toBeGreaterThan(0);
    expect(enumViolations[0].category).toBe('signature');
    expect(enumViolations[0].severity).toBe('breaking');
  });
});
