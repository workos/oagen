import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '../../src/compat/differ.js';
import { getDefaultPolicy } from '../../src/compat/policy.js';
import type { CompatSnapshot, CompatSymbol } from '../../src/compat/ir.js';

function makeSnapshot(symbols: CompatSymbol[]): CompatSnapshot {
  return {
    schemaVersion: '1',
    source: { extractedAt: '2026-04-30T00:00:00.000Z' },
    policies: getDefaultPolicy('go'),
    symbols,
  };
}

function sym(overrides: Partial<CompatSymbol> & { fqName: string; kind: CompatSymbol['kind'] }): CompatSymbol {
  return {
    id: overrides.id ?? `test:${overrides.fqName}`,
    displayName: overrides.displayName ?? overrides.fqName,
    visibility: 'public',
    stability: 'stable',
    sourceKind: 'generated_resource_constructor',
    ...overrides,
  };
}

/**
 * Build a snapshot pair that mirrors the WorkOS authorization-membership
 * schema-fork case: a list method's return type was redirected from `FooList`
 * to a brand-new `FooWithUserList` whose fields are a strict superset.
 */
function buildBaseline(): CompatSnapshot {
  return makeSnapshot([
    // Old "list" type
    sym({ fqName: 'MembershipBaseList', kind: 'alias' }),
    sym({
      fqName: 'MembershipBaseList.object',
      kind: 'field',
      ownerFqName: 'MembershipBaseList',
      typeRef: { name: 'string' },
    }),
    sym({
      fqName: 'MembershipBaseList.data',
      kind: 'field',
      ownerFqName: 'MembershipBaseList',
      typeRef: { name: 'MembershipBase[]' },
    }),
    sym({
      fqName: 'MembershipBaseList.list_metadata',
      kind: 'field',
      ownerFqName: 'MembershipBaseList',
      typeRef: { name: 'ListMetadata' },
    }),
    // The list method returning the old type
    sym({
      fqName: 'AuthorizationService.list_memberships_for_resource',
      kind: 'callable',
      ownerFqName: 'AuthorizationService',
      parameters: [],
      returns: { name: 'MembershipBaseList' },
    }),
  ]);
}

describe('detectForkedSchemas — schema fork antipattern', () => {
  it('attaches a remediation hint when a return type points at a newly-added superset schema', () => {
    const baseline = buildBaseline();
    const candidate = makeSnapshot([
      // Old type still present (typical when upstream forks rather than removes)
      ...baseline.symbols.filter((s) => !s.fqName.startsWith('AuthorizationService')),
      // New "WithUser" type — strict superset of MembershipBaseList's fields
      sym({ fqName: 'MembershipBaseWithUserList', kind: 'alias' }),
      sym({
        fqName: 'MembershipBaseWithUserList.object',
        kind: 'field',
        ownerFqName: 'MembershipBaseWithUserList',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'MembershipBaseWithUserList.data',
        kind: 'field',
        ownerFqName: 'MembershipBaseWithUserList',
        typeRef: { name: 'MembershipBaseWithUser[]' },
      }),
      sym({
        fqName: 'MembershipBaseWithUserList.list_metadata',
        kind: 'field',
        ownerFqName: 'MembershipBaseWithUserList',
        typeRef: { name: 'ListMetadata' },
      }),
      sym({
        fqName: 'MembershipBaseWithUserList.user',
        kind: 'field',
        ownerFqName: 'MembershipBaseWithUserList',
        typeRef: { name: 'User' },
      }),
      // Same method, now returning the forked type
      sym({
        fqName: 'AuthorizationService.list_memberships_for_resource',
        kind: 'callable',
        ownerFqName: 'AuthorizationService',
        parameters: [],
        returns: { name: 'MembershipBaseWithUserList' },
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const change = result.changes.find(
      (c) => c.category === 'return_type_changed' && c.symbol === 'AuthorizationService.list_memberships_for_resource',
    );
    expect(change).toBeDefined();
    expect(change!.remediation).toBeDefined();
    expect(change!.remediation).toContain('MembershipBaseWithUserList');
    expect(change!.remediation).toContain('MembershipBaseList');
    expect(change!.remediation).toMatch(/forking/i);
  });

  it('does not flag when the new type is not a strict superset', () => {
    const baseline = buildBaseline();
    const candidate = makeSnapshot([
      ...baseline.symbols.filter((s) => !s.fqName.startsWith('AuthorizationService')),
      // New type that drops a field — not a fork pattern, a genuine reshape
      sym({ fqName: 'MembershipReshape', kind: 'alias' }),
      sym({
        fqName: 'MembershipReshape.object',
        kind: 'field',
        ownerFqName: 'MembershipReshape',
        typeRef: { name: 'string' },
      }),
      // missing `data`, missing `list_metadata`
      sym({
        fqName: 'AuthorizationService.list_memberships_for_resource',
        kind: 'callable',
        ownerFqName: 'AuthorizationService',
        parameters: [],
        returns: { name: 'MembershipReshape' },
      }),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const change = result.changes.find((c) => c.category === 'return_type_changed');
    expect(change).toBeDefined();
    expect(change!.remediation).toBeUndefined();
  });

  it('does not flag when the new type already existed in the baseline', () => {
    // Switching between two pre-existing types isn't a fork; it's a swap.
    const baseline = makeSnapshot([
      sym({ fqName: 'A', kind: 'alias' }),
      sym({ fqName: 'A.x', kind: 'field', ownerFqName: 'A', typeRef: { name: 'string' } }),
      sym({ fqName: 'B', kind: 'alias' }),
      sym({ fqName: 'B.x', kind: 'field', ownerFqName: 'B', typeRef: { name: 'string' } }),
      sym({ fqName: 'B.y', kind: 'field', ownerFqName: 'B', typeRef: { name: 'string' } }),
      sym({
        fqName: 'Service.method',
        kind: 'callable',
        ownerFqName: 'Service',
        parameters: [],
        returns: { name: 'A' },
      }),
    ]);
    const candidate = makeSnapshot([
      ...baseline.symbols.filter((s) => !s.fqName.startsWith('Service')),
      sym({
        fqName: 'Service.method',
        kind: 'callable',
        ownerFqName: 'Service',
        parameters: [],
        returns: { name: 'B' },
      }),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const change = result.changes.find((c) => c.category === 'return_type_changed');
    expect(change).toBeDefined();
    expect(change!.remediation).toBeUndefined();
  });

  it('flags a field type change when the new field type is a forked superset', () => {
    const baseline = makeSnapshot([
      sym({ fqName: 'OldThing', kind: 'alias' }),
      sym({ fqName: 'OldThing.id', kind: 'field', ownerFqName: 'OldThing', typeRef: { name: 'string' } }),
      sym({ fqName: 'Container', kind: 'alias' }),
      sym({
        fqName: 'Container.thing',
        kind: 'field',
        ownerFqName: 'Container',
        typeRef: { name: 'OldThing' },
      }),
    ]);
    const candidate = makeSnapshot([
      ...baseline.symbols.filter((s) => !s.fqName.startsWith('Container.thing')),
      // New superset type
      sym({ fqName: 'NewThing', kind: 'alias' }),
      sym({ fqName: 'NewThing.id', kind: 'field', ownerFqName: 'NewThing', typeRef: { name: 'string' } }),
      sym({ fqName: 'NewThing.extra', kind: 'field', ownerFqName: 'NewThing', typeRef: { name: 'string' } }),
      sym({
        fqName: 'Container.thing',
        kind: 'field',
        ownerFqName: 'Container',
        typeRef: { name: 'NewThing' },
      }),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const change = result.changes.find((c) => c.category === 'field_type_changed' && c.symbol === 'Container.thing');
    expect(change).toBeDefined();
    expect(change!.remediation).toBeDefined();
    expect(change!.remediation).toContain('NewThing');
    expect(change!.remediation).toContain('OldThing');
  });

  it('does not flag unrelated changes (renames, removals, additions)', () => {
    const baseline = makeSnapshot([
      sym({ fqName: 'Foo', kind: 'alias' }),
      sym({ fqName: 'Foo.x', kind: 'field', ownerFqName: 'Foo', typeRef: { name: 'string' } }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'Foo', kind: 'alias' }),
      sym({ fqName: 'Foo.x', kind: 'field', ownerFqName: 'Foo', typeRef: { name: 'string' } }),
      sym({ fqName: 'Bar', kind: 'alias' }),
      sym({ fqName: 'Bar.y', kind: 'field', ownerFqName: 'Bar', typeRef: { name: 'string' } }),
    ]);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes.every((c) => !c.remediation)).toBe(true);
  });
});
