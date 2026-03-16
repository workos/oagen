import { describe, it, expect } from 'vitest';
import { buildOverlayLookup, patchOverlay } from '../../src/compat/overlay.js';
import type { ApiSurface, Violation, OverlayLookup } from '../../src/compat/types.js';

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

function emptyOverlay(): OverlayLookup {
  return buildOverlayLookup(emptySurface());
}

describe('patchOverlay — uncovered branches', () => {
  it('patches interface name from public-api violation with className.methodName path', () => {
    // Line 304-306: when symbolPath is "ClassName.method" and ClassName is an interface
    const baseline = emptySurface({
      interfaces: {
        UserOptions: {
          name: 'UserOptions',
          fields: { id: { name: 'id', type: 'string', optional: false } },
          extends: [],
        },
      },
    });

    const violations: Violation[] = [
      {
        category: 'public-api',
        severity: 'breaking',
        symbolPath: 'UserOptions.id',
        baseline: 'string',
        candidate: '(missing)',
        message: 'Missing interface field',
      },
    ];

    const patched = patchOverlay(emptyOverlay(), violations, baseline);
    expect(patched.interfaceByName.get('UserOptions')).toBe('UserOptions');
  });

  it('patches top-level type alias from single-part public-api violation', () => {
    // Lines 313-314: when symbolPath is a single name and it's a type alias
    const baseline = emptySurface({
      typeAliases: {
        UserRole: { name: 'UserRole', value: "'admin' | 'user'" },
      },
    });

    const violations: Violation[] = [
      {
        category: 'public-api',
        severity: 'breaking',
        symbolPath: 'UserRole',
        baseline: "'admin' | 'user'",
        candidate: '(missing)',
        message: 'Missing type alias',
      },
    ];

    const patched = patchOverlay(emptyOverlay(), violations, baseline);
    expect(patched.typeAliasByName.get('UserRole')).toBe('UserRole');
  });

  it('patches top-level interface from single-part public-api violation', () => {
    // Lines 310-312: when symbolPath is a single name and it's an interface
    const baseline = emptySurface({
      interfaces: {
        ListOptions: {
          name: 'ListOptions',
          fields: {},
          extends: [],
        },
      },
    });

    const violations: Violation[] = [
      {
        category: 'public-api',
        severity: 'breaking',
        symbolPath: 'ListOptions',
        baseline: 'interface',
        candidate: '(missing)',
        message: 'Missing interface',
      },
    ];

    const patched = patchOverlay(emptyOverlay(), violations, baseline);
    expect(patched.interfaceByName.get('ListOptions')).toBe('ListOptions');
  });
});
