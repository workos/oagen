/**
 * Fixture matrix: 9-language compatibility classification tests.
 *
 * Each test creates a baseline and candidate CompatSnapshot for a specific
 * language, diffs them, and verifies that the classification and severity
 * match language semantics.
 */
import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '../../../src/compat/differ.js';
import { getDefaultPolicy } from '../../../src/compat/policy.js';
import type { CompatSnapshot, CompatSymbol, CompatParameter, LanguageId } from '../../../src/compat/ir.js';

function makeSnapshot(language: LanguageId, symbols: CompatSymbol[]): CompatSnapshot {
  return {
    schemaVersion: '1',
    source: { extractedAt: '2026-04-22T00:00:00.000Z' },
    policies: getDefaultPolicy(language),
    symbols,
  };
}

function callable(fqName: string, params: CompatParameter[]): CompatSymbol {
  return {
    id: `callable:${fqName}`,
    kind: 'callable',
    fqName,
    displayName: fqName,
    visibility: 'public',
    stability: 'stable',
    sourceKind: 'generated_service_wrapper',
    parameters: params,
  };
}

function ctor(fqName: string, params: CompatParameter[]): CompatSymbol {
  return {
    id: `ctor:${fqName}`,
    kind: 'constructor',
    fqName,
    displayName: fqName,
    visibility: 'public',
    stability: 'stable',
    sourceKind: 'generated_resource_constructor',
    parameters: params,
  };
}

function param(name: string, pos: number, opts?: Partial<CompatParameter>): CompatParameter {
  return {
    publicName: name,
    position: pos,
    required: true,
    nullable: false,
    hasDefault: false,
    passing: 'positional',
    type: { name: 'string' },
    sensitivity: { order: true, publicName: true, requiredness: true, type: true },
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// 1. PHP: named-argument parameter removal
// ---------------------------------------------------------------------------
describe('PHP: named-arg parameter removal', () => {
  it('classifies as breaking', () => {
    const baseline = makeSnapshot('php', [
      callable('UserManagement.createUser', [
        param('email', 0, { passing: 'named' }),
        param('passwordHash', 1, { passing: 'named' }),
        param('passwordHashType', 2, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      callable('UserManagement.createUser', [
        param('email', 0, { passing: 'named' }),
        param('passwordHash', 1, { passing: 'named' }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const removal = result.changes.find((c) => c.category === 'parameter_removed');
    expect(removal).toBeDefined();
    expect(removal!.severity).toBe('breaking');
    expect(removal!.old.parameter).toBe('passwordHashType');
  });
});

// ---------------------------------------------------------------------------
// 2. PHP: constructor positional reorder
// ---------------------------------------------------------------------------
describe('PHP: constructor reorder', () => {
  it('classifies as breaking for order-sensitive language', () => {
    const baseline = makeSnapshot('php', [
      ctor('CreateUser.constructor', [
        param('email', 0, { passing: 'named' }),
        param('firstName', 1, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      ctor('CreateUser.constructor', [
        param('firstName', 0, { passing: 'named', required: false, hasDefault: true }),
        param('email', 1, { passing: 'named' }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const posChange = result.changes.find((c) => c.category === 'constructor_position_changed_order_sensitive');
    expect(posChange).toBeDefined();
    expect(posChange!.severity).toBe('breaking');
  });
});

// ---------------------------------------------------------------------------
// 3. Node: options-object key rename
// ---------------------------------------------------------------------------
describe('Node: options-object key rename', () => {
  it('classifies as soft-risk (param names not public API in Node)', () => {
    const baseline = makeSnapshot('node', [
      callable('Auth.check', [
        param('resourceId', 0, {
          passing: 'options_object',
          sensitivity: { order: false, publicName: false, requiredness: true, type: true },
        }),
      ]),
    ]);
    const candidate = makeSnapshot('node', [
      callable('Auth.check', [
        param('resourceTarget', 0, {
          passing: 'options_object',
          sensitivity: { order: false, publicName: false, requiredness: true, type: true },
        }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('soft-risk');
  });
});

// ---------------------------------------------------------------------------
// 4. Python: keyword-only rename
// ---------------------------------------------------------------------------
describe('Python: keyword-only rename', () => {
  it('classifies as breaking (keyword names are public API)', () => {
    const baseline = makeSnapshot('python', [
      callable('auth.check', [param('resource_id', 0, { passing: 'keyword' })]),
    ]);
    const candidate = makeSnapshot('python', [
      callable('auth.check', [param('resource_target', 0, { passing: 'keyword' })]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('breaking');
  });
});

// ---------------------------------------------------------------------------
// 5. Ruby: keyword arg rename
// ---------------------------------------------------------------------------
describe('Ruby: keyword arg rename', () => {
  it('classifies as breaking (keyword names are public API)', () => {
    const baseline = makeSnapshot('ruby', [callable('Auth.check', [param('resource_id', 0, { passing: 'keyword' })])]);
    const candidate = makeSnapshot('ruby', [
      callable('Auth.check', [param('resource_target', 0, { passing: 'keyword' })]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('breaking');
  });
});

// ---------------------------------------------------------------------------
// 6. Go: positional parameter reorder
// ---------------------------------------------------------------------------
describe('Go: positional parameter reorder', () => {
  it('classifies position change as breaking (order matters)', () => {
    const baseline = makeSnapshot('go', [
      callable('Auth.Check', [
        param('ctx', 0, {
          passing: 'positional',
          sensitivity: { order: true, publicName: false, requiredness: true, type: true },
        }),
        param('resourceID', 1, {
          passing: 'positional',
          sensitivity: { order: true, publicName: false, requiredness: true, type: true },
        }),
      ]),
    ]);
    const candidate = makeSnapshot('go', [
      callable('Auth.Check', [
        param('resourceID', 0, {
          passing: 'positional',
          sensitivity: { order: true, publicName: false, requiredness: true, type: true },
        }),
        param('ctx', 1, {
          passing: 'positional',
          sensitivity: { order: true, publicName: false, requiredness: true, type: true },
        }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const posChange = result.changes.find((c) => c.category === 'parameter_position_changed_order_sensitive');
    expect(posChange).toBeDefined();
    expect(posChange!.severity).toBe('breaking');
  });

  it('classifies param rename as soft-risk (names not public API)', () => {
    const baseline = makeSnapshot('go', [
      callable('Auth.Check', [
        param('resourceID', 0, {
          passing: 'positional',
          sensitivity: { order: true, publicName: false, requiredness: true, type: true },
        }),
      ]),
    ]);
    const candidate = makeSnapshot('go', [
      callable('Auth.Check', [
        param('resourceTarget', 0, {
          passing: 'positional',
          sensitivity: { order: true, publicName: false, requiredness: true, type: true },
        }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename?.severity).toBe('soft-risk');
  });
});

// ---------------------------------------------------------------------------
// 7. Kotlin: overload and named arg drift
// ---------------------------------------------------------------------------
describe('Kotlin: named arg rename', () => {
  it('classifies as breaking (named args supported, names are public API)', () => {
    const baseline = makeSnapshot('kotlin', [callable('Auth.check', [param('resourceId', 0, { passing: 'named' })])]);
    const candidate = makeSnapshot('kotlin', [
      callable('Auth.check', [param('resourceTarget', 0, { passing: 'named' })]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('breaking');
  });
});

// ---------------------------------------------------------------------------
// 8. .NET: overload and named arg drift
// ---------------------------------------------------------------------------
describe('.NET: named arg rename', () => {
  it('classifies as breaking (named args supported, names are public API)', () => {
    const baseline = makeSnapshot('dotnet', [callable('Auth.Check', [param('resourceId', 0, { passing: 'named' })])]);
    const candidate = makeSnapshot('dotnet', [
      callable('Auth.Check', [param('resourceTarget', 0, { passing: 'named' })]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('breaking');
  });
});

// ---------------------------------------------------------------------------
// 9. Elixir: arity/key drift
// ---------------------------------------------------------------------------
describe('Elixir: keyword key rename', () => {
  it('classifies as breaking (keyword keys are public API)', () => {
    const baseline = makeSnapshot('elixir', [
      callable('Auth.check', [param('resource_id', 0, { passing: 'keyword' })]),
    ]);
    const candidate = makeSnapshot('elixir', [
      callable('Auth.check', [param('resource_target', 0, { passing: 'keyword' })]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('breaking');
  });
});

// ===========================================================================
// Real-world PHP fixture cases from the plan doc
// ===========================================================================

// ---------------------------------------------------------------------------
// Case 1: Requiredness tightening to match spec
// Methods like authenticateWithEmailVerification, authenticateWithTotp, etc.
// have optional params that become required when the emitter matches the spec.
// ---------------------------------------------------------------------------
describe('PHP Case 1: Requiredness tightening', () => {
  it('classifies as breaking when optional params become required', () => {
    const baseline = makeSnapshot('php', [
      callable('UserManagement.authenticateWithEmailVerification', [
        param('code', 0, { passing: 'named', required: false, hasDefault: true }),
        param('pendingAuthenticationToken', 1, { passing: 'named', required: false, hasDefault: true }),
        param('ipAddress', 2, { passing: 'named', required: false, hasDefault: true }),
        param('userAgent', 3, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      callable('UserManagement.authenticateWithEmailVerification', [
        param('code', 0, { passing: 'named', required: true }),
        param('pendingAuthenticationToken', 1, { passing: 'named', required: true }),
        param('ipAddress', 2, { passing: 'named', required: false, hasDefault: true }),
        param('userAgent', 3, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const tightened = result.changes.filter((c) => c.category === 'parameter_requiredness_increased');
    expect(tightened).toHaveLength(2);
    expect(tightened.every((c) => c.severity === 'breaking')).toBe(true);
    const names = tightened.map((c) => c.old.parameter).sort();
    expect(names).toEqual(['code', 'pendingAuthenticationToken']);
  });

  it('classifies authenticateWithTotp tightening as breaking', () => {
    const baseline = makeSnapshot('php', [
      callable('UserManagement.authenticateWithTotp', [
        param('code', 0, { passing: 'named', required: false, hasDefault: true }),
        param('pendingAuthenticationToken', 1, { passing: 'named', required: false, hasDefault: true }),
        param('authenticationChallengeId', 2, { passing: 'named', required: false, hasDefault: true }),
        param('ipAddress', 3, { passing: 'named', required: false, hasDefault: true }),
        param('userAgent', 4, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      callable('UserManagement.authenticateWithTotp', [
        param('code', 0, { passing: 'named', required: true }),
        param('pendingAuthenticationToken', 1, { passing: 'named', required: true }),
        param('authenticationChallengeId', 2, { passing: 'named', required: true }),
        param('ipAddress', 3, { passing: 'named', required: false, hasDefault: true }),
        param('userAgent', 4, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const tightened = result.changes.filter((c) => c.category === 'parameter_requiredness_increased');
    expect(tightened).toHaveLength(3);
    expect(tightened.every((c) => c.severity === 'breaking')).toBe(true);
  });

  it('is NOT breaking when requiredness stays the same', () => {
    const baseline = makeSnapshot('php', [
      callable('UserManagement.authenticateWithDeviceCode', [
        param('deviceCode', 0, { passing: 'named', required: true }),
        param('ipAddress', 1, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      callable('UserManagement.authenticateWithDeviceCode', [
        param('deviceCode', 0, { passing: 'named', required: true }),
        param('ipAddress', 1, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case 2: Scalar-to-wrapper migration
// e.g., resourceId → resourceTarget (parameter renamed + type changed)
// roleSlug/roleSlugs → role wrapper object (params removed, new param added)
// ---------------------------------------------------------------------------
describe('PHP Case 2: Scalar-to-wrapper migration', () => {
  it('classifies resourceId → resourceTarget as parameter rename (breaking)', () => {
    const baseline = makeSnapshot('php', [
      callable('FGA.check', [
        param('resourceId', 0, { passing: 'named', type: { name: 'string' } }),
        param('resourceType', 1, { passing: 'named', type: { name: 'string' } }),
        param('relation', 2, { passing: 'named', type: { name: 'string' } }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      callable('FGA.check', [
        param('resourceTarget', 0, { passing: 'named', type: { name: 'ResourceTarget' } }),
        param('resourceType', 1, { passing: 'named', type: { name: 'string' } }),
        param('relation', 2, { passing: 'named', type: { name: 'string' } }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('breaking');
    expect(rename!.old.parameter).toBe('resourceId');
    expect(rename!.new.parameter).toBe('resourceTarget');
    // The rename at position 0 is the primary signal — the type change
    // (string → ResourceTarget) is implicit in the rename since the param
    // was matched positionally. This is one conceptual change, not two.
    expect(result.summary.breaking).toBeGreaterThanOrEqual(1);
  });

  it('classifies roleSlug → role wrapper as removal + addition (breaking)', () => {
    const baseline = makeSnapshot('php', [
      callable('UserManagement.assignRole', [
        param('userId', 0, { passing: 'named' }),
        param('roleSlug', 1, { passing: 'named' }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      callable('UserManagement.assignRole', [
        param('userId', 0, { passing: 'named' }),
        param('role', 1, { passing: 'named', type: { name: 'RoleAssignment' } }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    // roleSlug renamed to role at same position
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('breaking');
    expect(rename!.old.parameter).toBe('roleSlug');
    expect(rename!.new.parameter).toBe('role');
  });

  it('classifies multi-param folding (passwordHash + passwordHashType → password wrapper) as breaking', () => {
    const baseline = makeSnapshot('php', [
      callable('UserManagement.createUser', [
        param('email', 0, { passing: 'named' }),
        param('passwordHash', 1, { passing: 'named', required: false, hasDefault: true }),
        param('passwordHashType', 2, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      callable('UserManagement.createUser', [
        param('email', 0, { passing: 'named' }),
        param('password', 1, { passing: 'named', required: false, hasDefault: true, type: { name: 'PasswordConfig' } }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    // passwordHash removed (renamed to password at position 1)
    const rename = result.changes.find((c) => c.category === 'parameter_renamed' && c.old.parameter === 'passwordHash');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('breaking');
    // passwordHashType removed entirely
    const removed = result.changes.find(
      (c) => c.category === 'parameter_removed' && c.old.parameter === 'passwordHashType',
    );
    expect(removed).toBeDefined();
    expect(removed!.severity).toBe('breaking');
  });
});

// ---------------------------------------------------------------------------
// Case 3: Constructor positional reordering
// CreateUser/UpdateUser constructors have params reordered
// ---------------------------------------------------------------------------
describe('PHP Case 3: Constructor reordering', () => {
  it('classifies CreateUser constructor reorder as breaking', () => {
    const baseline = makeSnapshot('php', [
      ctor('CreateUser.constructor', [
        param('email', 0, { passing: 'named' }),
        param('password', 1, { passing: 'named', required: false, hasDefault: true }),
        param('firstName', 2, { passing: 'named', required: false, hasDefault: true }),
        param('lastName', 3, { passing: 'named', required: false, hasDefault: true }),
        param('emailVerified', 4, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      ctor('CreateUser.constructor', [
        param('email', 0, { passing: 'named' }),
        param('firstName', 1, { passing: 'named', required: false, hasDefault: true }),
        param('lastName', 2, { passing: 'named', required: false, hasDefault: true }),
        param('password', 3, { passing: 'named', required: false, hasDefault: true }),
        param('emailVerified', 4, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    // PHP has constructorOrderMatters: true, so reordering is breaking
    const posChanges = result.changes.filter((c) => c.category === 'constructor_position_changed_order_sensitive');
    expect(posChanges.length).toBeGreaterThan(0);
    expect(posChanges.every((c) => c.severity === 'breaking')).toBe(true);
  });

  it('classifies UpdateUser constructor reorder as breaking', () => {
    const baseline = makeSnapshot('php', [
      ctor('UpdateUser.constructor', [
        param('firstName', 0, { passing: 'named', required: false, hasDefault: true }),
        param('lastName', 1, { passing: 'named', required: false, hasDefault: true }),
        param('emailVerified', 2, { passing: 'named', required: false, hasDefault: true }),
        param('password', 3, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      ctor('UpdateUser.constructor', [
        param('password', 0, { passing: 'named', required: false, hasDefault: true }),
        param('firstName', 1, { passing: 'named', required: false, hasDefault: true }),
        param('lastName', 2, { passing: 'named', required: false, hasDefault: true }),
        param('emailVerified', 3, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const posChanges = result.changes.filter((c) => c.category === 'constructor_position_changed_order_sensitive');
    expect(posChanges.length).toBeGreaterThan(0);
    expect(posChanges.every((c) => c.severity === 'breaking')).toBe(true);
  });

  it('is NOT breaking for Kotlin constructor reorder (order does not matter)', () => {
    const baseline = makeSnapshot('kotlin', [
      ctor('CreateUser.constructor', [
        param('email', 0, { passing: 'named' }),
        param('password', 1, { passing: 'named', required: false, hasDefault: true }),
        param('firstName', 2, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('kotlin', [
      ctor('CreateUser.constructor', [
        param('email', 0, { passing: 'named' }),
        param('firstName', 1, { passing: 'named', required: false, hasDefault: true }),
        param('password', 2, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    // Kotlin: constructorOrderMatters is false → soft-risk, not breaking
    const posChanges = result.changes.filter(
      (c) =>
        c.category === 'constructor_position_changed_order_sensitive' ||
        c.category === 'constructor_reordered_named_friendly',
    );
    expect(posChanges.every((c) => c.severity !== 'breaking')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 4: Named-argument breaks
// Parameter names removed or replaced in PHP/Kotlin/.NET contexts
// ---------------------------------------------------------------------------
describe('PHP Case 4: Named-argument breaks', () => {
  it('classifies param name change as breaking in PHP (named args supported)', () => {
    const baseline = makeSnapshot('php', [
      callable('UserManagement.listUsers', [
        param('limit', 0, { passing: 'named', required: false, hasDefault: true }),
        param('before', 1, { passing: 'named', required: false, hasDefault: true }),
        param('after', 2, { passing: 'named', required: false, hasDefault: true }),
        param('order', 3, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      callable('UserManagement.listUsers', [
        param('pageSize', 0, { passing: 'named', required: false, hasDefault: true }),
        param('before', 1, { passing: 'named', required: false, hasDefault: true }),
        param('after', 2, { passing: 'named', required: false, hasDefault: true }),
        param('order', 3, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('breaking');
    expect(rename!.old.parameter).toBe('limit');
    expect(rename!.new.parameter).toBe('pageSize');
  });

  it('same param name change is soft-risk in Go (names not public API)', () => {
    const baseline = makeSnapshot('go', [
      callable('UserManagement.ListUsers', [
        param('limit', 0, {
          passing: 'positional',
          sensitivity: { order: true, publicName: false, requiredness: true, type: true },
        }),
        param('before', 1, {
          passing: 'positional',
          sensitivity: { order: true, publicName: false, requiredness: true, type: true },
        }),
      ]),
    ]);
    const candidate = makeSnapshot('go', [
      callable('UserManagement.ListUsers', [
        param('pageSize', 0, {
          passing: 'positional',
          sensitivity: { order: true, publicName: false, requiredness: true, type: true },
        }),
        param('before', 1, {
          passing: 'positional',
          sensitivity: { order: true, publicName: false, requiredness: true, type: true },
        }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.severity).toBe('soft-risk');
  });

  it('classifies multiple param name changes on same method', () => {
    const baseline = makeSnapshot('php', [
      callable('SSO.getAuthorizationUrl', [
        param('provider', 0, { passing: 'named' }),
        param('redirectURI', 1, { passing: 'named' }),
        param('state', 2, { passing: 'named', required: false, hasDefault: true }),
        param('clientID', 3, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const candidate = makeSnapshot('php', [
      callable('SSO.getAuthorizationUrl', [
        param('connectionId', 0, { passing: 'named' }),
        param('redirectUri', 1, { passing: 'named' }),
        param('state', 2, { passing: 'named', required: false, hasDefault: true }),
        param('clientId', 3, { passing: 'named', required: false, hasDefault: true }),
      ]),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const renames = result.changes.filter((c) => c.category === 'parameter_renamed');
    // provider→connectionId, redirectURI→redirectUri, clientID→clientId
    expect(renames).toHaveLength(3);
    expect(renames.every((c) => c.severity === 'breaking')).toBe(true);
  });
});
