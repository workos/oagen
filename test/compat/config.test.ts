import { describe, it, expect } from 'vitest';
import { defaultSeverityForCategory, severityMeetsThreshold } from '../../src/compat/config.js';
import type { CompatChangeCategory } from '../../src/compat/config.js';

describe('defaultSeverityForCategory', () => {
  it('classifies breaking categories correctly', () => {
    const breakingCategories: CompatChangeCategory[] = [
      'symbol_removed',
      'symbol_renamed',
      'parameter_removed',
      'parameter_renamed',
      'parameter_requiredness_increased',
      'parameter_type_narrowed',
      'parameter_position_changed_order_sensitive',
      'constructor_position_changed_order_sensitive',
      'named_arg_name_removed',
      'keyword_name_removed',
      'overload_removed',
      'union_wrapper_migration_without_compat_alias',
    ];
    for (const cat of breakingCategories) {
      expect(defaultSeverityForCategory(cat)).toBe('breaking');
    }
  });

  it('classifies soft-risk categories correctly', () => {
    const softRiskCategories: CompatChangeCategory[] = [
      'parameter_added_non_terminal_optional',
      'constructor_reordered_named_friendly',
      'default_value_changed',
      'wrapper_stricter_than_previous_sdk_but_matches_spec',
      'doc_surface_drift',
    ];
    for (const cat of softRiskCategories) {
      expect(defaultSeverityForCategory(cat)).toBe('soft-risk');
    }
  });

  it('classifies additive categories correctly', () => {
    const additiveCategories: CompatChangeCategory[] = [
      'symbol_added',
      'parameter_added_optional_terminal',
      'new_constructor_overload_added',
      'new_wrapper_alias_added',
    ];
    for (const cat of additiveCategories) {
      expect(defaultSeverityForCategory(cat)).toBe('additive');
    }
  });
});

describe('severityMeetsThreshold', () => {
  it('none threshold never triggers', () => {
    expect(severityMeetsThreshold('breaking', 'none')).toBe(false);
    expect(severityMeetsThreshold('soft-risk', 'none')).toBe(false);
    expect(severityMeetsThreshold('additive', 'none')).toBe(false);
  });

  it('breaking threshold only triggers on breaking', () => {
    expect(severityMeetsThreshold('breaking', 'breaking')).toBe(true);
    expect(severityMeetsThreshold('soft-risk', 'breaking')).toBe(false);
    expect(severityMeetsThreshold('additive', 'breaking')).toBe(false);
  });

  it('soft-risk threshold triggers on breaking and soft-risk', () => {
    expect(severityMeetsThreshold('breaking', 'soft-risk')).toBe(true);
    expect(severityMeetsThreshold('soft-risk', 'soft-risk')).toBe(true);
    expect(severityMeetsThreshold('additive', 'soft-risk')).toBe(false);
  });
});
