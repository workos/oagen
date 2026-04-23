import { describe, it, expect } from 'vitest';
import { classifySymbolChanges, classifyAddedSymbol, summarizeChanges } from '../../src/compat/classify.js';
import type { CompatSymbol } from '../../src/compat/ir.js';
import { getDefaultPolicy } from '../../src/compat/policy.js';

function makeSymbol(overrides: Partial<CompatSymbol> & { fqName: string }): CompatSymbol {
  const { fqName, ...rest } = overrides;
  return {
    id: rest.id ?? `test:${fqName}`,
    kind: rest.kind ?? 'callable',
    fqName,
    displayName: rest.displayName ?? fqName,
    visibility: 'public',
    stability: 'stable',
    sourceKind: 'generated_service_wrapper',
    ...rest,
  };
}

describe('classifySymbolChanges', () => {
  describe('symbol removal', () => {
    it('classifies a removed symbol as breaking', () => {
      const baseline = makeSymbol({ fqName: 'UserManagement.createUser' });
      const changes = classifySymbolChanges(baseline, undefined, getDefaultPolicy('php'));
      expect(changes).toHaveLength(1);
      expect(changes[0].category).toBe('symbol_removed');
      expect(changes[0].severity).toBe('breaking');
    });
  });

  describe('parameter changes', () => {
    it('classifies parameter removal as breaking', () => {
      const baseline = makeSymbol({
        fqName: 'Authorization.check',
        parameters: [
          {
            publicName: 'resourceId',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        fqName: 'Authorization.check',
        parameters: [],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('php'));
      expect(changes.some((c) => c.category === 'parameter_removed')).toBe(true);
    });

    it('classifies parameter rename as breaking in PHP (named args)', () => {
      const baseline = makeSymbol({
        fqName: 'Authorization.check',
        parameters: [
          {
            publicName: 'resourceId',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        fqName: 'Authorization.check',
        parameters: [
          {
            publicName: 'resourceTarget',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('php'));
      const rename = changes.find((c) => c.category === 'parameter_renamed');
      expect(rename).toBeDefined();
      expect(rename!.severity).toBe('breaking');
    });

    it('classifies parameter rename as soft-risk in Go (no named args)', () => {
      const baseline = makeSymbol({
        fqName: 'Authorization.Check',
        parameters: [
          {
            publicName: 'resourceId',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'positional',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        fqName: 'Authorization.Check',
        parameters: [
          {
            publicName: 'resourceTarget',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'positional',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('go'));
      const rename = changes.find((c) => c.category === 'parameter_renamed');
      expect(rename).toBeDefined();
      expect(rename!.severity).toBe('soft-risk');
    });

    it('classifies requiredness increase as breaking', () => {
      const baseline = makeSymbol({
        fqName: 'Auth.verify',
        parameters: [
          {
            publicName: 'code',
            position: 0,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        fqName: 'Auth.verify',
        parameters: [
          {
            publicName: 'code',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('php'));
      expect(changes.some((c) => c.category === 'parameter_requiredness_increased')).toBe(true);
    });

    it('classifies position change as breaking in PHP (order-sensitive)', () => {
      const baseline = makeSymbol({
        kind: 'constructor',
        fqName: 'CreateUser.constructor',
        parameters: [
          {
            publicName: 'email',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
          {
            publicName: 'firstName',
            position: 1,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        kind: 'constructor',
        fqName: 'CreateUser.constructor',
        parameters: [
          {
            publicName: 'firstName',
            position: 0,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
          {
            publicName: 'email',
            position: 1,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('php'));
      const posChange = changes.find((c) => c.category === 'constructor_position_changed_order_sensitive');
      expect(posChange).toBeDefined();
      expect(posChange!.severity).toBe('breaking');
    });

    it('classifies constructor reorder as soft-risk in Kotlin (named-friendly)', () => {
      const baseline = makeSymbol({
        kind: 'constructor',
        fqName: 'CreateUser.constructor',
        parameters: [
          {
            publicName: 'email',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'String' },
            sensitivity: { order: false, publicName: true, requiredness: true, type: true },
          },
          {
            publicName: 'firstName',
            position: 1,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'named',
            type: { name: 'String' },
            sensitivity: { order: false, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        kind: 'constructor',
        fqName: 'CreateUser.constructor',
        parameters: [
          {
            publicName: 'firstName',
            position: 0,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'named',
            type: { name: 'String' },
            sensitivity: { order: false, publicName: true, requiredness: true, type: true },
          },
          {
            publicName: 'email',
            position: 1,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'String' },
            sensitivity: { order: false, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('kotlin'));
      const reorder = changes.find((c) => c.category === 'constructor_reordered_named_friendly');
      expect(reorder).toBeDefined();
      expect(reorder!.severity).toBe('soft-risk');
    });

    it('classifies optional terminal parameter addition as additive', () => {
      const baseline = makeSymbol({
        fqName: 'Svc.doIt',
        parameters: [
          {
            publicName: 'x',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'positional',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        fqName: 'Svc.doIt',
        parameters: [
          {
            publicName: 'x',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'positional',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
          {
            publicName: 'opts',
            position: 1,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'positional',
            type: { name: 'Options' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('go'));
      const added = changes.find((c) => c.category === 'parameter_added_optional_terminal');
      expect(added).toBeDefined();
      expect(added!.severity).toBe('additive');
    });
  });
});

describe('classifyAddedSymbol', () => {
  it('returns an additive change', () => {
    const sym = makeSymbol({ fqName: 'NewService.newMethod' });
    const change = classifyAddedSymbol(sym);
    expect(change.category).toBe('symbol_added');
    expect(change.severity).toBe('additive');
  });
});

describe('summarizeChanges', () => {
  it('counts by severity', () => {
    const changes = [
      { severity: 'breaking' as const },
      { severity: 'breaking' as const },
      { severity: 'soft-risk' as const },
      { severity: 'additive' as const },
      { severity: 'additive' as const },
      { severity: 'additive' as const },
    ];
    const summary = summarizeChanges(changes as any);
    expect(summary).toEqual({ breaking: 2, softRisk: 1, additive: 3 });
  });
});
