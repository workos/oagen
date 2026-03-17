import { describe, it, expect } from 'vitest';
import { nodeHints, resolveHints } from '../../src/compat/language-hints.js';
import { diffSurfaces, specDerivedNames } from '../../src/compat/differ.js';
import type { ApiSurface } from '../../src/compat/types.js';
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

describe('nodeHints', () => {
  describe('stripNullable', () => {
    it('strips null from union', () => {
      expect(nodeHints.stripNullable('string | null')).toBe('string');
    });

    it('returns null when type is not nullable', () => {
      expect(nodeHints.stripNullable('string')).toBeNull();
    });

    it('preserves non-null union members', () => {
      expect(nodeHints.stripNullable('string | number | null')).toBe('string | number');
    });
  });

  describe('isNullableOnlyDifference', () => {
    it('returns true for nullable-only difference', () => {
      expect(nodeHints.isNullableOnlyDifference('string', 'string | null')).toBe(true);
    });

    it('returns false for different types', () => {
      expect(nodeHints.isNullableOnlyDifference('string', 'number')).toBe(false);
    });
  });

  describe('isUnionReorder', () => {
    it('returns true for reordered union members', () => {
      expect(nodeHints.isUnionReorder('"a" | "b"', '"b" | "a"')).toBe(true);
    });

    it('returns false for different union members', () => {
      expect(nodeHints.isUnionReorder('"a" | "b"', '"a" | "c"')).toBe(false);
    });

    it('returns false for single-member unions', () => {
      expect(nodeHints.isUnionReorder('"a"', '"a"')).toBe(false);
    });
  });

  describe('isGenericTypeParam', () => {
    it('detects single-letter type params', () => {
      expect(nodeHints.isGenericTypeParam('T')).toBe(true);
      expect(nodeHints.isGenericTypeParam('U')).toBe(true);
    });

    it('detects T-prefixed PascalCase params', () => {
      expect(nodeHints.isGenericTypeParam('TCustomAttributes')).toBe(true);
    });

    it('detects array of generic params', () => {
      expect(nodeHints.isGenericTypeParam('T[]')).toBe(true);
    });

    it('returns false for regular types', () => {
      expect(nodeHints.isGenericTypeParam('string')).toBe(false);
      expect(nodeHints.isGenericTypeParam('Organization')).toBe(false);
    });
  });

  describe('isExtractionArtifact', () => {
    it('treats "any" as artifact', () => {
      expect(nodeHints.isExtractionArtifact('any')).toBe(true);
    });

    it('does not treat regular types as artifacts', () => {
      expect(nodeHints.isExtractionArtifact('string')).toBe(false);
    });
  });

  describe('extractReturnTypeName', () => {
    it('unwraps Promise and generic wrappers', () => {
      expect(nodeHints.extractReturnTypeName('Promise<AutoPaginatable<Organization>>')).toBe('Organization');
    });

    it('unwraps simple Promise', () => {
      expect(nodeHints.extractReturnTypeName('Promise<Organization>')).toBe('Organization');
    });

    it('returns null for void', () => {
      expect(nodeHints.extractReturnTypeName('Promise<void>')).toBeNull();
    });

    it('returns null for primitives', () => {
      expect(nodeHints.extractReturnTypeName('Promise<string>')).toBeNull();
    });
  });

  describe('extractParamTypeName', () => {
    it('returns type name for non-primitive', () => {
      expect(nodeHints.extractParamTypeName('CreateOrganizationOptions')).toBe('CreateOrganizationOptions');
    });

    it('returns null for primitives', () => {
      expect(nodeHints.extractParamTypeName('string')).toBeNull();
      expect(nodeHints.extractParamTypeName('number')).toBeNull();
    });
  });

  describe('propertyMatchesClass', () => {
    it('matches camelCase property to PascalCase class', () => {
      expect(nodeHints.propertyMatchesClass('organizations', 'Organizations')).toBe(true);
    });

    it('does not match unrelated names', () => {
      expect(nodeHints.propertyMatchesClass('users', 'Organizations')).toBe(false);
    });
  });

  describe('derivedModelNames', () => {
    it('produces Response and Serialized variants', () => {
      expect(nodeHints.derivedModelNames('Organization')).toEqual(['OrganizationResponse', 'SerializedOrganization']);
    });
  });

  it('tolerateCategoryMismatch is true', () => {
    expect(nodeHints.tolerateCategoryMismatch).toBe(true);
  });
});

describe('resolveHints', () => {
  it('returns nodeHints when no overrides given', () => {
    const hints = resolveHints({});
    expect(hints.isExtractionArtifact('any')).toBe(true);
    expect(hints.tolerateCategoryMismatch).toBe(true);
  });

  it('overrides specific hints', () => {
    const hints = resolveHints({
      isExtractionArtifact: (type: string) => type === 'Any',
      tolerateCategoryMismatch: false,
    });
    expect(hints.isExtractionArtifact('any')).toBe(false);
    expect(hints.isExtractionArtifact('Any')).toBe(true);
    expect(hints.tolerateCategoryMismatch).toBe(false);
    // Non-overridden hints still work
    expect(hints.isGenericTypeParam('T')).toBe(true);
  });

  it('supports Go-style stripNullable', () => {
    const goHints = resolveHints({
      stripNullable: (type: string) => {
        if (type.startsWith('*')) return type.slice(1);
        return null;
      },
    });
    expect(goHints.stripNullable('*Organization')).toBe('Organization');
    expect(goHints.stripNullable('Organization')).toBeNull();
  });

  it('supports Python-style extraction artifacts', () => {
    const pyHints = resolveHints({
      isExtractionArtifact: (type: string) => type === 'Any',
      stripNullable: (type: string) => {
        const match = type.match(/^Optional\[(.+)\]$/);
        return match ? match[1] : null;
      },
    });
    expect(pyHints.isExtractionArtifact('Any')).toBe(true);
    expect(pyHints.isExtractionArtifact('any')).toBe(false);
    expect(pyHints.stripNullable('Optional[str]')).toBe('str');
    expect(pyHints.stripNullable('str')).toBeNull();
  });
});

describe('derivedModelNames customization', () => {
  it('specDerivedNames uses hints to produce language-appropriate sets', () => {
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
    };

    // Node hints produce Response + Serialized variants
    const nodeNames = specDerivedNames(spec, nodeHints);
    expect(nodeNames.has('OrganizationResponse')).toBe(true);
    expect(nodeNames.has('SerializedOrganization')).toBe(true);

    // Go-style hints only produce Response variant
    const goHints = resolveHints({
      derivedModelNames: (name: string) => [`${name}Response`],
    });
    const goNames = specDerivedNames(spec, goHints);
    expect(goNames.has('OrganizationResponse')).toBe(true);
    expect(goNames.has('SerializedOrganization')).toBe(false);
  });
});

describe('diffSurfaces with custom hints', () => {
  it('produces different severity results than nodeHints', () => {
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
          fields: { name: { name: 'name', type: 'any', optional: false } },
          extends: [],
        },
      },
    });

    // With nodeHints, "any" is an extraction artifact → warning
    const nodeResult = diffSurfaces(baseline, candidate, nodeHints);
    expect(nodeResult.violations[0].severity).toBe('warning');

    // With custom hints that don't treat "any" as artifact → breaking
    const strictHints = resolveHints({
      isExtractionArtifact: () => false,
    });
    const strictResult = diffSurfaces(baseline, candidate, strictHints);
    expect(strictResult.violations[0].severity).toBe('breaking');
  });

  it('category mismatch tolerance is controlled by hints', () => {
    const baseline = emptySurface({
      typeAliases: {
        UserRole: { name: 'UserRole', value: '"admin" | "user"' },
      },
    });
    const candidate = emptySurface({
      interfaces: {
        UserRole: { name: 'UserRole', fields: {}, extends: [] },
      },
    });

    // With nodeHints, category mismatch is tolerated
    const nodeResult = diffSurfaces(baseline, candidate, nodeHints);
    expect(nodeResult.violations).toHaveLength(0);

    // With hints that don't tolerate it → breaking
    const strictHints = resolveHints({ tolerateCategoryMismatch: false });
    const strictResult = diffSurfaces(baseline, candidate, strictHints);
    expect(strictResult.violations).toHaveLength(1);
    expect(strictResult.violations[0].severity).toBe('breaking');
  });
});
