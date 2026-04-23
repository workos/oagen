import { describe, it, expect } from 'vitest';
import { buildOverlayLookup, patchOverlay } from '../../src/compat/overlay.js';
import type { ApiSurface, OverlayLookup } from '../../src/compat/types.js';
import type { ClassifiedChange } from '../../src/compat/classify.js';

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

function removedChange(symbol: string): ClassifiedChange {
  return {
    category: 'symbol_removed',
    severity: 'breaking',
    symbol,
    conceptualChangeId: `chg_symbol_removed_${symbol}`,
    provenance: 'unknown',
    old: { symbol },
    new: { symbol: '(removed)' },
    message: `Symbol "${symbol}" was removed`,
  };
}

describe('patchOverlay — uncovered branches', () => {
  it('patches interface name from symbol_removed change with dotted path', () => {
    const baseline = emptySurface({
      interfaces: {
        UserOptions: {
          name: 'UserOptions',
          fields: { id: { name: 'id', type: 'string', optional: false } },
          extends: [],
        },
      },
    });

    const changes: ClassifiedChange[] = [removedChange('UserOptions.id')];

    const patched = patchOverlay(emptyOverlay(), changes, baseline);
    expect(patched.interfaceByName.get('UserOptions')).toBe('UserOptions');
  });

  it('patches top-level type alias from symbol_removed change', () => {
    const baseline = emptySurface({
      typeAliases: {
        UserRole: { name: 'UserRole', value: "'admin' | 'user'" },
      },
    });

    const changes: ClassifiedChange[] = [removedChange('UserRole')];

    const patched = patchOverlay(emptyOverlay(), changes, baseline);
    expect(patched.typeAliasByName.get('UserRole')).toBe('UserRole');
  });

  it('patches top-level interface from symbol_removed change', () => {
    const baseline = emptySurface({
      interfaces: {
        ListOptions: {
          name: 'ListOptions',
          fields: {},
          extends: [],
        },
      },
    });

    const changes: ClassifiedChange[] = [removedChange('ListOptions')];

    const patched = patchOverlay(emptyOverlay(), changes, baseline);
    expect(patched.interfaceByName.get('ListOptions')).toBe('ListOptions');
  });
});
