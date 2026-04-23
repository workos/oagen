import { describe, it, expect } from 'vitest';
import { getDefaultPolicy, mergePolicy, ALL_LANGUAGE_IDS } from '../../src/compat/policy.js';

describe('getDefaultPolicy', () => {
  it('returns PHP defaults with named args and constructor order sensitivity', () => {
    const php = getDefaultPolicy('php');
    expect(php.namedArgumentsSupported).toBe(true);
    expect(php.constructorOrderMatters).toBe(true);
    expect(php.methodParameterNamesArePublicApi).toBe(true);
    expect(php.constructorParameterNamesArePublicApi).toBe(true);
  });

  it('returns Python defaults with keyword args', () => {
    const py = getDefaultPolicy('python');
    expect(py.keywordArgumentsSupported).toBe(true);
    expect(py.namedArgumentsSupported).toBe(false);
    expect(py.methodParameterNamesArePublicApi).toBe(true);
  });

  it('returns Go defaults: positional order matters, names do not', () => {
    const go = getDefaultPolicy('go');
    expect(go.constructorOrderMatters).toBe(true);
    expect(go.methodParameterNamesArePublicApi).toBe(false);
    expect(go.arityIsPublicApi).toBe(true);
  });

  it('returns Kotlin defaults with overloads and named args', () => {
    const kt = getDefaultPolicy('kotlin');
    expect(kt.namedArgumentsSupported).toBe(true);
    expect(kt.overloadsArePublicApi).toBe(true);
    expect(kt.constructorOrderMatters).toBe(false);
  });

  it('returns .NET defaults with overloads and named args', () => {
    const dn = getDefaultPolicy('dotnet');
    expect(dn.namedArgumentsSupported).toBe(true);
    expect(dn.overloadsArePublicApi).toBe(true);
    expect(dn.constructorOrderMatters).toBe(false);
  });

  it('returns Node defaults: nothing is breaking', () => {
    const node = getDefaultPolicy('node');
    expect(node.namedArgumentsSupported).toBe(false);
    expect(node.keywordArgumentsSupported).toBe(false);
    expect(node.constructorOrderMatters).toBe(false);
    expect(node.methodParameterNamesArePublicApi).toBe(false);
    expect(node.overloadsArePublicApi).toBe(false);
    expect(node.arityIsPublicApi).toBe(false);
  });

  it('returns Elixir defaults: arity and keyword keys matter', () => {
    const ex = getDefaultPolicy('elixir');
    expect(ex.arityIsPublicApi).toBe(true);
    expect(ex.keywordArgumentsSupported).toBe(true);
    expect(ex.constructorOrderMatters).toBe(false);
  });

  it('returns Ruby defaults: keyword names and order matter', () => {
    const rb = getDefaultPolicy('ruby');
    expect(rb.keywordArgumentsSupported).toBe(true);
    expect(rb.constructorOrderMatters).toBe(true);
    expect(rb.methodParameterNamesArePublicApi).toBe(true);
  });

  it('returns Rust defaults: positional, arity matters', () => {
    const rs = getDefaultPolicy('rust');
    expect(rs.constructorOrderMatters).toBe(true);
    expect(rs.arityIsPublicApi).toBe(true);
    expect(rs.methodParameterNamesArePublicApi).toBe(false);
  });

  it('returns a fresh copy each time (not shared reference)', () => {
    const a = getDefaultPolicy('php');
    const b = getDefaultPolicy('php');
    a.namedArgumentsSupported = false;
    expect(b.namedArgumentsSupported).toBe(true);
  });
});

describe('mergePolicy', () => {
  it('overrides specific fields', () => {
    const defaults = getDefaultPolicy('php');
    const merged = mergePolicy(defaults, { constructorOrderMatters: false });
    expect(merged.constructorOrderMatters).toBe(false);
    expect(merged.namedArgumentsSupported).toBe(true); // unchanged
  });

  it('returns all fields even with empty overrides', () => {
    const defaults = getDefaultPolicy('go');
    const merged = mergePolicy(defaults, {});
    expect(merged).toEqual(defaults);
  });

  it('does not mutate the defaults object', () => {
    const defaults = getDefaultPolicy('python');
    mergePolicy(defaults, { keywordArgumentsSupported: false });
    expect(defaults.keywordArgumentsSupported).toBe(true);
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
