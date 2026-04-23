/**
 * Compat configuration types for `oagen.config.ts`.
 *
 * The `compat` section of the config holds human-authored policy:
 * fail thresholds, language overrides, and intentional break approvals.
 * Generated state (manifests, snapshots, reports) lives elsewhere.
 */

import type { LanguageId } from './ir.js';
import type { CompatPolicyHints } from './policy.js';

// ---------------------------------------------------------------------------
// Change categories
// ---------------------------------------------------------------------------

/** Breaking change categories — changes that break callers. */
export type BreakingChangeCategory =
  | 'symbol_removed'
  | 'symbol_renamed'
  | 'parameter_removed'
  | 'parameter_renamed'
  | 'parameter_requiredness_increased'
  | 'parameter_type_narrowed'
  | 'parameter_position_changed_order_sensitive'
  | 'constructor_position_changed_order_sensitive'
  | 'named_arg_name_removed'
  | 'keyword_name_removed'
  | 'overload_removed'
  | 'union_wrapper_migration_without_compat_alias'
  | 'field_type_changed'
  | 'return_type_changed'
  | 'enum_member_value_changed';

/** Soft-risk change categories — may affect callers depending on usage. */
export type SoftRiskChangeCategory =
  | 'parameter_added_non_terminal_optional'
  | 'constructor_reordered_named_friendly'
  | 'default_value_changed'
  | 'wrapper_stricter_than_previous_sdk_but_matches_spec'
  | 'doc_surface_drift';

/** Additive change categories — safe to ship. */
export type AdditiveChangeCategory =
  | 'symbol_added'
  | 'parameter_added_optional_terminal'
  | 'new_constructor_overload_added'
  | 'new_wrapper_alias_added';

/** All change categories. */
export type CompatChangeCategory = BreakingChangeCategory | SoftRiskChangeCategory | AdditiveChangeCategory;

/** Change severity levels. */
export type CompatChangeSeverity = 'breaking' | 'soft-risk' | 'additive';

/** Provenance bucket — where the drift originated. */
export type CompatProvenance =
  | 'spec_shape_change'
  | 'spec_ordering_change'
  | 'emitter_template_change'
  | 'compat_extractor_change'
  | 'operation_hint_change'
  | 'manual_override_change'
  | 'normalization_change'
  | 'unknown';

// ---------------------------------------------------------------------------
// Fail threshold
// ---------------------------------------------------------------------------

/** Level at which `verify` should fail. */
export type CompatFailLevel = 'none' | 'breaking' | 'soft-risk';

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** A single intentional-break approval in `oagen.config.ts`. */
export interface CompatApproval {
  /** Fully-qualified symbol (e.g., "WorkOS\\Service\\UserManagement::createUser"). */
  symbol: string;
  /** The kind of change being approved. */
  category: CompatChangeCategory;
  /** Languages this approval applies to. Omit for all impacted languages. */
  appliesTo?: LanguageId[] | 'all-impacted-languages';
  /** Optional narrowing criteria. */
  match?: {
    parameter?: string;
    member?: string;
    oldName?: string;
    newName?: string;
  };
  /** Minimum release level required for this break. */
  allowedReleaseLevel?: 'major' | 'minor' | 'patch';
  /** Human-readable reason for this approval. */
  reason: string;
  /** Issue tracker reference (e.g., "SDK-1234"). */
  issue?: string;
  /** Auto-expire this approval after a version is released. */
  expiresAfterVersion?: string;
  /** Whether this approval is currently active. */
  approved?: boolean;
}

// ---------------------------------------------------------------------------
// Config section
// ---------------------------------------------------------------------------

/** The `compat` section of `oagen.config.ts`. */
export interface CompatConfig {
  /** Level at which `oagen verify` should fail. Default: 'breaking'. */
  failOn?: CompatFailLevel;
  /** Path to write the machine-readable compat report. */
  reportPath?: string;
  /** Include provenance explanations in reports. */
  explain?: boolean;
  /** Path to the baseline compatibility snapshot. */
  baselinePath?: string;
  /** Per-language policy overrides. Sparse — only override what diverges. */
  languagePolicy?: Partial<Record<LanguageId, Partial<CompatPolicyHints>>>;
  /** Intentional break approvals. */
  allow?: CompatApproval[];
}

// ---------------------------------------------------------------------------
// Category → severity mapping
// ---------------------------------------------------------------------------

const BREAKING_CATEGORIES: ReadonlySet<BreakingChangeCategory> = new Set<BreakingChangeCategory>([
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
  'field_type_changed',
  'return_type_changed',
  'enum_member_value_changed',
]);

const SOFT_RISK_CATEGORIES: ReadonlySet<SoftRiskChangeCategory> = new Set<SoftRiskChangeCategory>([
  'parameter_added_non_terminal_optional',
  'constructor_reordered_named_friendly',
  'default_value_changed',
  'wrapper_stricter_than_previous_sdk_but_matches_spec',
  'doc_surface_drift',
]);

/** Get the default severity for a change category. */
export function defaultSeverityForCategory(category: CompatChangeCategory): CompatChangeSeverity {
  if (BREAKING_CATEGORIES.has(category as BreakingChangeCategory)) return 'breaking';
  if (SOFT_RISK_CATEGORIES.has(category as SoftRiskChangeCategory)) return 'soft-risk';
  return 'additive';
}

/** Check whether a severity meets or exceeds a fail threshold. */
export function severityMeetsThreshold(severity: CompatChangeSeverity, threshold: CompatFailLevel): boolean {
  if (threshold === 'none') return false;
  if (threshold === 'soft-risk') return severity === 'breaking' || severity === 'soft-risk';
  return severity === 'breaking';
}
