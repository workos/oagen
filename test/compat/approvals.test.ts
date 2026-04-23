import { describe, it, expect } from 'vitest';
import {
  validateApproval,
  validateApprovals,
  matchApproval,
  applyApprovals,
  unapprovedChanges,
} from '../../src/compat/approvals.js';
import type { CompatApproval } from '../../src/compat/config.js';
import type { ClassifiedChange } from '../../src/compat/classify.js';

function makeChange(overrides: Partial<ClassifiedChange>): ClassifiedChange {
  return {
    category: 'parameter_renamed',
    severity: 'breaking',
    symbol: 'Authorization.check',
    conceptualChangeId: 'chg_parameter_renamed_authorization.check_resourceid',
    provenance: 'unknown',
    old: { parameter: 'resourceId' },
    new: { parameter: 'resourceTarget' },
    message: 'Parameter renamed',
    ...overrides,
  };
}

function makeApproval(overrides: Partial<CompatApproval>): CompatApproval {
  return {
    symbol: 'Authorization.check',
    category: 'parameter_renamed',
    reason: 'Intentional wrapper migration',
    ...overrides,
  };
}

describe('validateApproval', () => {
  it('accepts a well-formed approval', () => {
    const result = validateApproval(makeApproval({}));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects approval with empty symbol', () => {
    const result = validateApproval(makeApproval({ symbol: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('specific symbol');
  });

  it('rejects wildcard symbols', () => {
    const result = validateApproval(makeApproval({ symbol: '*' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('too broad');
  });

  it('rejects suffix wildcard symbols', () => {
    const result = validateApproval(makeApproval({ symbol: 'Authorization.*' }));
    expect(result.valid).toBe(false);
  });

  it('rejects namespace wildcard symbols', () => {
    const result = validateApproval(makeApproval({ symbol: 'WorkOS\\Service::*' }));
    expect(result.valid).toBe(false);
  });

  it('rejects approval with empty reason', () => {
    const result = validateApproval(makeApproval({ reason: '' }));
    expect(result.valid).toBe(false);
  });
});

describe('validateApprovals', () => {
  it('returns empty map for valid approvals', () => {
    const errors = validateApprovals([makeApproval({})]);
    expect(errors.size).toBe(0);
  });

  it('returns errors keyed by index', () => {
    const errors = validateApprovals([
      makeApproval({}),
      makeApproval({ symbol: '' }),
      makeApproval({}),
      makeApproval({ reason: '' }),
    ]);
    expect(errors.size).toBe(2);
    expect(errors.has(1)).toBe(true);
    expect(errors.has(3)).toBe(true);
  });
});

describe('matchApproval', () => {
  it('matches by symbol and category', () => {
    const change = makeChange({});
    const approval = makeApproval({});
    expect(matchApproval(change, [approval], 'php')).toBe(approval);
  });

  it('does not match different category', () => {
    const change = makeChange({});
    const approval = makeApproval({ category: 'symbol_removed' });
    expect(matchApproval(change, [approval], 'php')).toBeNull();
  });

  it('does not match different symbol', () => {
    const change = makeChange({});
    const approval = makeApproval({ symbol: 'Other.method' });
    expect(matchApproval(change, [approval], 'php')).toBeNull();
  });

  it('matches with cross-language symbol normalization (PHP backslash)', () => {
    const change = makeChange({ symbol: 'WorkOS.Service.UserManagement.createUser' });
    const approval = makeApproval({ symbol: 'WorkOS\\Service\\UserManagement::createUser' });
    expect(matchApproval(change, [approval], 'php')).toBe(approval);
  });

  it('filters by appliesTo language list', () => {
    const change = makeChange({});
    const approval = makeApproval({ appliesTo: ['python', 'ruby'] });
    expect(matchApproval(change, [approval], 'php')).toBeNull();
    expect(matchApproval(change, [approval], 'python')).toBe(approval);
  });

  it('matches with appliesTo: all-impacted-languages', () => {
    const change = makeChange({});
    const approval = makeApproval({ appliesTo: 'all-impacted-languages' });
    expect(matchApproval(change, [approval], 'php')).toBe(approval);
    expect(matchApproval(change, [approval], 'go')).toBe(approval);
  });

  it('matches with narrowing parameter match', () => {
    const change = makeChange({ old: { parameter: 'resourceId' }, new: { parameter: 'resourceTarget' } });
    const approval = makeApproval({ match: { parameter: 'resourceId' } });
    expect(matchApproval(change, [approval], 'php')).toBe(approval);
  });

  it('rejects narrowing match on wrong parameter', () => {
    const change = makeChange({ old: { parameter: 'resourceId' }, new: { parameter: 'resourceTarget' } });
    const approval = makeApproval({ match: { parameter: 'userId' } });
    expect(matchApproval(change, [approval], 'php')).toBeNull();
  });

  it('returns the first matching approval', () => {
    const change = makeChange({});
    const a1 = makeApproval({ reason: 'first' });
    const a2 = makeApproval({ reason: 'second' });
    const matched = matchApproval(change, [a1, a2], 'php');
    expect(matched?.reason).toBe('first');
  });

  it('skips approvals with approved: false', () => {
    const change = makeChange({});
    const approval = makeApproval({ approved: false });
    expect(matchApproval(change, [approval], 'php')).toBeNull();
  });

  it('matches approvals with approved: true', () => {
    const change = makeChange({});
    const approval = makeApproval({ approved: true });
    expect(matchApproval(change, [approval], 'php')).toBe(approval);
  });

  it('matches approvals without approved field (defaults to active)', () => {
    const change = makeChange({});
    const approval = makeApproval({});
    expect(matchApproval(change, [approval], 'php')).toBe(approval);
  });

  it('skips inactive approval and matches next active one', () => {
    const change = makeChange({});
    const inactive = makeApproval({ reason: 'inactive', approved: false });
    const active = makeApproval({ reason: 'active', approved: true });
    const matched = matchApproval(change, [inactive, active], 'php');
    expect(matched?.reason).toBe('active');
  });
});

describe('applyApprovals', () => {
  it('marks approved and unapproved changes', () => {
    const changes = [
      makeChange({ symbol: 'Auth.check' }),
      makeChange({ symbol: 'Auth.other', category: 'symbol_removed' }),
    ];
    const approvals = [makeApproval({ symbol: 'Auth.check' })];
    const matches = applyApprovals(changes, approvals, 'php');
    expect(matches[0].approved).toBe(true);
    expect(matches[1].approved).toBe(false);
  });
});

describe('unapprovedChanges', () => {
  it('filters to only unapproved changes', () => {
    const changes = [
      makeChange({ symbol: 'Auth.check' }),
      makeChange({ symbol: 'Auth.other', category: 'symbol_removed' }),
    ];
    const approvals = [makeApproval({ symbol: 'Auth.check' })];
    const remaining = unapprovedChanges(changes, approvals, 'php');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].symbol).toBe('Auth.other');
  });
});
