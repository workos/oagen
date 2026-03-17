import { describe, it, expect } from 'vitest';
import { nodeHints, typeExistsInSurface } from '../../src/compat/language-hints.js';
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

/**
 * Covers uncovered branches in language-hints.ts:
 * - Lines 21-23: splitPascalWords (indirectly via isTypeEquivalent)
 * - Lines 113-178: isTypeEquivalent branches
 */
describe('nodeHints.isTypeEquivalent', () => {
  const isTypeEquivalent = nodeHints.isTypeEquivalent!;

  it('matches candidate enum to baseline inline union of string literals', () => {
    // Lines 113-118: candidate is an enum name, baseline is union of string literal values
    const surface = emptySurface({
      enums: {
        ConnectionState: {
          name: 'ConnectionState',
          members: { ACTIVE: 'active', INACTIVE: 'inactive' },
        },
      },
    });

    expect(isTypeEquivalent('"active" | "inactive"', 'ConnectionState', surface)).toBe(true);
  });

  it('returns false when enum members do not match baseline literals', () => {
    const surface = emptySurface({
      enums: {
        Status: {
          name: 'Status',
          members: { ON: 'on', OFF: 'off' },
        },
      },
    });

    expect(isTypeEquivalent('"active" | "inactive"', 'Status', surface)).toBe(false);
  });

  it('tolerates untyped map equivalences', () => {
    // Lines 122-124: UNTYPED_MAP_PATTERNS match
    const surface = emptySurface();

    expect(isTypeEquivalent('{ [key: string]: any; }', 'Record<string, unknown>', surface)).toBe(true);
    expect(isTypeEquivalent('Record<string, any>', 'any', surface)).toBe(true);
  });

  it('tolerates inline object literal vs named model in candidate', () => {
    // Lines 129-133: baseline is object literal, candidate is named type in surface
    const surface = emptySurface({
      interfaces: {
        ApiKeyOwner: {
          name: 'ApiKeyOwner',
          fields: { type: { name: 'type', type: 'string', optional: false } },
          extends: [],
        },
      },
    });

    expect(isTypeEquivalent('{ type: "organization"; id: string; }', 'ApiKeyOwner', surface)).toBe(true);
  });

  it('returns false for inline object literal when candidate not in surface', () => {
    const surface = emptySurface();
    expect(isTypeEquivalent('{ type: string; }', 'NonExistent', surface)).toBe(false);
  });

  it('tolerates Response suffix equivalence', () => {
    // Lines 148-151: candClean === baseClean + 'Response' or vice versa
    const surface = emptySurface({
      interfaces: {
        OrganizationResponse: {
          name: 'OrganizationResponse',
          fields: {},
          extends: [],
        },
      },
    });

    expect(isTypeEquivalent('Organization', 'OrganizationResponse', surface)).toBe(true);
    expect(isTypeEquivalent('OrganizationResponse', 'Organization', surface)).toBe(true);
  });

  it('tolerates Response suffix with arrays', () => {
    const surface = emptySurface();
    expect(isTypeEquivalent('Organization[]', 'OrganizationResponse[]', surface)).toBe(true);
  });

  it('tolerates named type containment when candidate exists in surface', () => {
    // Lines 157-161: one name contains the other
    const surface = emptySurface({
      interfaces: {
        ProfileConnectionType: {
          name: 'ProfileConnectionType',
          fields: {},
          extends: [],
        },
      },
    });

    expect(isTypeEquivalent('ConnectionType', 'ProfileConnectionType', surface)).toBe(true);
  });

  it('tolerates containment after stripping Response suffix', () => {
    // Lines 163-167: strip Response suffix and check containment
    const surface = emptySurface({
      interfaces: {
        UserRoleResponse: {
          name: 'UserRoleResponse',
          fields: {},
          extends: [],
        },
      },
    });

    expect(isTypeEquivalent('RoleResponse', 'UserRoleResponse', surface)).toBe(true);
  });

  it('tolerates word-component overlap for reordered names', () => {
    // Lines 171-176: PascalCase word overlap (handles Json merge renames)
    const surface = emptySurface({
      interfaces: {
        AuditLogSchemaJsonTarget: {
          name: 'AuditLogSchemaJsonTarget',
          fields: {},
          extends: [],
        },
      },
    });

    expect(isTypeEquivalent('AuditLogTargetSchema', 'AuditLogSchemaJsonTarget', surface)).toBe(true);
  });

  it('returns false for named types with insufficient word overlap', () => {
    const surface = emptySurface({
      interfaces: {
        FooBar: {
          name: 'FooBar',
          fields: {},
          extends: [],
        },
      },
    });

    expect(isTypeEquivalent('BazQux', 'FooBar', surface)).toBe(false);
  });

  it('returns false when array-ness differs', () => {
    const surface = emptySurface({
      interfaces: {
        Widget: {
          name: 'Widget',
          fields: {},
          extends: [],
        },
      },
    });

    // Widget vs Widget[] — different arrayness, should not match via named-type tolerance
    expect(isTypeEquivalent('Widget', 'Widget[]', surface)).toBe(false);
  });

  it('returns false for completely unrelated types', () => {
    const surface = emptySurface();
    expect(isTypeEquivalent('string', 'number', surface)).toBe(false);
  });
});

describe('typeExistsInSurface', () => {
  it('finds interfaces', () => {
    const surface = emptySurface({
      interfaces: {
        Foo: { name: 'Foo', fields: {}, extends: [] },
      },
    });
    expect(typeExistsInSurface('Foo', surface)).toBe(true);
  });

  it('finds classes', () => {
    const surface = emptySurface({
      classes: {
        Bar: { name: 'Bar', methods: {}, properties: {}, constructorParams: [] },
      },
    });
    expect(typeExistsInSurface('Bar', surface)).toBe(true);
  });

  it('finds enums', () => {
    const surface = emptySurface({
      enums: {
        Baz: { name: 'Baz', members: {} },
      },
    });
    expect(typeExistsInSurface('Baz', surface)).toBe(true);
  });

  it('returns false for unknown names', () => {
    const surface = emptySurface();
    expect(typeExistsInSurface('Missing', surface)).toBe(false);
  });
});
