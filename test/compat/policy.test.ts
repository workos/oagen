import { describe, it, expect } from 'vitest';
import { getDefaultPolicy, mergePolicy, ALL_LANGUAGE_IDS } from '../../src/compat/policy.js';

describe('getDefaultPolicy', () => {
  it('returns PHP defaults with caller-uses-param-names and constructor order sensitivity', () => {
    const php = getDefaultPolicy('php');
    expect(php.callerUsesParamNames).toBe(true);
    expect(php.constructorOrderMatters).toBe(true);
    expect(php.methodParameterNamesArePublicApi).toBe(true);
    expect(php.constructorParameterNamesArePublicApi).toBe(true);
  });

  it('returns Python defaults with caller-uses-param-names', () => {
    const py = getDefaultPolicy('python');
    expect(py.callerUsesParamNames).toBe(true);
    expect(py.methodParameterNamesArePublicApi).toBe(true);
  });

  it('returns Go defaults: positional order matters, names do not', () => {
    const go = getDefaultPolicy('go');
    expect(go.callerUsesParamNames).toBe(false);
    expect(go.constructorOrderMatters).toBe(true);
    expect(go.methodParameterNamesArePublicApi).toBe(false);
    expect(go.arityIsPublicApi).toBe(true);
  });

  it('returns Kotlin defaults with overloads and caller-uses-param-names', () => {
    const kt = getDefaultPolicy('kotlin');
    expect(kt.callerUsesParamNames).toBe(true);
    expect(kt.overloadsArePublicApi).toBe(true);
    expect(kt.constructorOrderMatters).toBe(false);
  });

  it('returns .NET defaults with overloads and caller-uses-param-names', () => {
    const dn = getDefaultPolicy('dotnet');
    expect(dn.callerUsesParamNames).toBe(true);
    expect(dn.overloadsArePublicApi).toBe(true);
    expect(dn.constructorOrderMatters).toBe(false);
  });

  it('returns Node defaults: nothing is breaking', () => {
    const node = getDefaultPolicy('node');
    expect(node.callerUsesParamNames).toBe(false);
    expect(node.constructorOrderMatters).toBe(false);
    expect(node.methodParameterNamesArePublicApi).toBe(false);
    expect(node.overloadsArePublicApi).toBe(false);
    expect(node.arityIsPublicApi).toBe(false);
  });

  it('returns Elixir defaults: arity and caller-uses-param-names', () => {
    const ex = getDefaultPolicy('elixir');
    expect(ex.arityIsPublicApi).toBe(true);
    expect(ex.callerUsesParamNames).toBe(true);
    expect(ex.constructorOrderMatters).toBe(false);
  });

  it('returns Ruby defaults: caller-uses-param-names and order matter', () => {
    const rb = getDefaultPolicy('ruby');
    expect(rb.callerUsesParamNames).toBe(true);
    expect(rb.constructorOrderMatters).toBe(true);
    expect(rb.methodParameterNamesArePublicApi).toBe(true);
  });

  it('returns Rust defaults: positional, arity matters', () => {
    const rs = getDefaultPolicy('rust');
    expect(rs.callerUsesParamNames).toBe(false);
    expect(rs.constructorOrderMatters).toBe(true);
    expect(rs.arityIsPublicApi).toBe(true);
    expect(rs.methodParameterNamesArePublicApi).toBe(false);
  });

  it('returns a fresh copy each time (not shared reference)', () => {
    const a = getDefaultPolicy('php');
    const b = getDefaultPolicy('php');
    a.callerUsesParamNames = false;
    expect(b.callerUsesParamNames).toBe(true);
  });
});

describe('mergePolicy', () => {
  it('overrides specific fields', () => {
    const defaults = getDefaultPolicy('php');
    const merged = mergePolicy(defaults, { constructorOrderMatters: false });
    expect(merged.constructorOrderMatters).toBe(false);
    expect(merged.callerUsesParamNames).toBe(true); // unchanged
  });

  it('returns all fields even with empty overrides', () => {
    const defaults = getDefaultPolicy('go');
    const merged = mergePolicy(defaults, {});
    expect(merged).toEqual(defaults);
  });

  it('does not mutate the defaults object', () => {
    const defaults = getDefaultPolicy('python');
    mergePolicy(defaults, { callerUsesParamNames: false });
    expect(defaults.callerUsesParamNames).toBe(true);
  });
});

describe('ALL_LANGUAGE_IDS', () => {
  it('contains all 9 supported languages', () => {
    expect(ALL_LANGUAGE_IDS).toHaveLength(9);
    expect(ALL_LANGUAGE_IDS).toContain('php');
    expect(ALL_LANGUAGE_IDS).toContain('python');
    expect(ALL_LANGUAGE_IDS).toContain('ruby');
    expect(ALL_LANGUAGE_IDS).toContain('go');
    expect(ALL_LANGUAGE_IDS).toContain('kotlin');
    expect(ALL_LANGUAGE_IDS).toContain('dotnet');
    expect(ALL_LANGUAGE_IDS).toContain('elixir');
    expect(ALL_LANGUAGE_IDS).toContain('rust');
    expect(ALL_LANGUAGE_IDS).toContain('node');
  });
});
