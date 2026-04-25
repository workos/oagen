/**
 * Change classifier for compatibility verification.
 *
 * Takes raw diffs between baseline and candidate compat snapshots and
 * classifies each change into a specific category with policy-aware severity.
 */

import type { CompatSymbol, CompatParameter } from './ir.js';
import type { CompatPolicyHints } from './policy.js';
import type { CompatChangeCategory, CompatChangeSeverity, CompatProvenance } from './config.js';
import { defaultSeverityForCategory } from './config.js';

/** A single classified compatibility change. */
export interface ClassifiedChange {
  /** Specific change category. */
  category: CompatChangeCategory;
  /** Policy-aware severity (may differ from defaultSeverityForCategory). */
  severity: CompatChangeSeverity;
  /** Fully-qualified symbol path. */
  symbol: string;
  /** Deterministic ID for grouping related changes across languages. */
  conceptualChangeId: string;
  /** Where the drift originated. */
  provenance: CompatProvenance;
  /** Description of the old state. */
  old: Record<string, string>;
  /** Description of the new state. */
  new: Record<string, string>;
  /** Human-readable explanation. */
  message: string;
}

/** Result of classifying all changes between two snapshots. */
export interface ClassificationResult {
  changes: ClassifiedChange[];
  summary: {
    breaking: number;
    softRisk: number;
    additive: number;
  };
}

// ---------------------------------------------------------------------------
// Classification engine
// ---------------------------------------------------------------------------

/**
 * Classify changes between a baseline and candidate symbol.
 * Returns one or more classified changes for the diff.
 */
export function classifySymbolChanges(
  baseline: CompatSymbol,
  candidate: CompatSymbol | undefined,
  policy: CompatPolicyHints,
): ClassifiedChange[] {
  const changes: ClassifiedChange[] = [];

  // Build spec-level ref for cross-language grouping.
  // Prefer schemaName from either symbol (baseline for removals, candidate for adds).
  const specRef = baseline.schemaName ?? candidate?.schemaName;

  // Symbol removed
  if (!candidate) {
    changes.push(
      makeChange({
        category: 'symbol_removed',
        symbol: baseline.fqName,
        old: { symbol: baseline.fqName },
        new: { symbol: '(removed)' },
        message: `Symbol "${baseline.displayName}" was removed`,
        policy,
        specRef,
      }),
    );
    return changes;
  }

  // Symbol renamed
  if (baseline.fqName !== candidate.fqName && baseline.id === candidate.id) {
    changes.push(
      makeChange({
        category: 'symbol_renamed',
        symbol: baseline.fqName,
        old: { name: baseline.fqName },
        new: { name: candidate.fqName },
        message: `Symbol renamed from "${baseline.displayName}" to "${candidate.displayName}"`,
        policy,
        specRef,
      }),
    );
  }

  // Parameter-level changes (for callables and constructors)
  if (baseline.parameters && candidate.parameters) {
    changes.push(...classifyParameterChanges(baseline, candidate, policy, specRef));
  }

  // Return type changes (for callables)
  if (baseline.returns && candidate.returns && baseline.returns.name !== candidate.returns.name) {
    changes.push(
      makeChange({
        category: 'return_type_changed',
        symbol: baseline.fqName,
        old: { returnType: baseline.returns.name },
        new: { returnType: candidate.returns.name },
        message: `Return type changed for "${baseline.displayName}" from "${baseline.returns.name}" to "${candidate.returns.name}"`,
        policy,
        specRef,
      }),
    );
  }

  // Field/property type changes
  if (baseline.typeRef && candidate.typeRef && baseline.typeRef.name !== candidate.typeRef.name) {
    changes.push(
      makeChange({
        category: 'field_type_changed',
        symbol: baseline.fqName,
        old: { type: baseline.typeRef.name },
        new: { type: candidate.typeRef.name },
        message: `Type changed for "${baseline.displayName}" from "${baseline.typeRef.name}" to "${candidate.typeRef.name}"`,
        policy,
        specRef,
      }),
    );
  }

  // Enum member value changes
  if (
    baseline.kind === 'enum_member' &&
    candidate.kind === 'enum_member' &&
    baseline.value !== undefined &&
    candidate.value !== undefined &&
    baseline.value !== candidate.value
  ) {
    changes.push(
      makeChange({
        category: 'enum_member_value_changed',
        symbol: baseline.fqName,
        old: { value: String(baseline.value) },
        new: { value: String(candidate.value) },
        message: `Enum value changed for "${baseline.displayName}" from "${baseline.value}" to "${candidate.value}"`,
        policy,
      }),
    );
  }

  return changes;
}

/**
 * Classify parameter-level changes between two symbol versions.
 */
function classifyParameterChanges(
  baseline: CompatSymbol,
  candidate: CompatSymbol,
  policy: CompatPolicyHints,
  specRef?: string,
): ClassifiedChange[] {
  const changes: ClassifiedChange[] = [];
  const baseParams = baseline.parameters ?? [];
  const candParams = candidate.parameters ?? [];

  const baseByName = new Map(baseParams.map((p) => [p.publicName, p]));
  const candByName = new Map(candParams.map((p) => [p.publicName, p]));
  const isConstructor = baseline.kind === 'constructor';

  // Check each baseline parameter
  for (const baseParam of baseParams) {
    const candParam = candByName.get(baseParam.publicName);

    if (!candParam) {
      // Parameter removed — check if it was renamed
      const positionalMatch = candParams[baseParam.position];
      if (positionalMatch && !baseByName.has(positionalMatch.publicName)) {
        // Position preserved but name changed → rename
        const isBreakingRename = parameterNameIsPublicApi(baseParam, policy, isConstructor);
        changes.push(
          makeChange({
            category: 'parameter_renamed',
            symbol: baseline.fqName,
            old: { parameter: baseParam.publicName },
            new: { parameter: positionalMatch.publicName },
            message: `Parameter "${baseParam.publicName}" renamed to "${positionalMatch.publicName}" on "${baseline.displayName}"`,
            policy,
            specRef,
            severityOverride: isBreakingRename ? undefined : 'soft-risk',
          }),
        );
      } else {
        // Truly removed
        changes.push(
          makeChange({
            category: 'parameter_removed',
            symbol: baseline.fqName,
            old: { parameter: baseParam.publicName },
            new: { parameter: '(removed)' },
            message: `Parameter "${baseParam.publicName}" removed from "${baseline.displayName}"`,
            policy,
            specRef,
          }),
        );
      }
      continue;
    }

    // Requiredness increased (optional → required)
    if (!baseParam.required && candParam.required) {
      changes.push(
        makeChange({
          category: 'parameter_requiredness_increased',
          symbol: baseline.fqName,
          old: { parameter: baseParam.publicName, required: 'false' },
          new: { parameter: candParam.publicName, required: 'true' },
          message: `Parameter "${baseParam.publicName}" became required on "${baseline.displayName}"`,
          policy,
          specRef,
        }),
      );
    }

    // Type narrowed
    if (baseParam.type.name !== candParam.type.name) {
      changes.push(
        makeChange({
          category: 'parameter_type_narrowed',
          symbol: baseline.fqName,
          old: { parameter: baseParam.publicName, type: baseParam.type.name },
          new: { parameter: candParam.publicName, type: candParam.type.name },
          message: `Parameter type changed for "${baseParam.publicName}" on "${baseline.displayName}"`,
          policy,
          specRef,
        }),
      );
    }

    // Position changed (order-sensitive)
    if (baseParam.position !== candParam.position) {
      const orderMatters = isConstructor ? policy.constructorOrderMatters : baseParam.sensitivity.order;

      if (orderMatters) {
        const category: CompatChangeCategory = isConstructor
          ? 'constructor_position_changed_order_sensitive'
          : 'parameter_position_changed_order_sensitive';
        changes.push(
          makeChange({
            category,
            symbol: baseline.fqName,
            old: { parameter: baseParam.publicName, position: String(baseParam.position) },
            new: { parameter: candParam.publicName, position: String(candParam.position) },
            message: `Parameter "${baseParam.publicName}" moved from position ${baseParam.position} to ${candParam.position} on "${baseline.displayName}"`,
            policy,
            specRef,
          }),
        );
      } else {
        // Reordered but in a named-friendly language → soft-risk
        changes.push(
          makeChange({
            category: 'constructor_reordered_named_friendly',
            symbol: baseline.fqName,
            old: { parameter: baseParam.publicName, position: String(baseParam.position) },
            new: { parameter: candParam.publicName, position: String(candParam.position) },
            message: `Parameter "${baseParam.publicName}" reordered on "${baseline.displayName}" (named-friendly language)`,
            policy,
            specRef,
          }),
        );
      }
    }
  }

  // Check for new parameters in candidate
  for (const candParam of candParams) {
    if (!baseByName.has(candParam.publicName)) {
      // Check if this was already captured as a rename
      const isRename = changes.some(
        (c) => c.category === 'parameter_renamed' && c.new.parameter === candParam.publicName,
      );
      if (isRename) continue;

      const isTerminal = candParam.position === candParams.length - 1;
      const category: CompatChangeCategory = candParam.required
        ? 'parameter_requiredness_increased'
        : isTerminal
          ? 'parameter_added_optional_terminal'
          : 'parameter_added_non_terminal_optional';

      if (candParam.required) {
        changes.push(
          makeChange({
            category,
            symbol: baseline.fqName,
            old: { parameter: '(absent)' },
            new: { parameter: candParam.publicName, required: 'true' },
            message: `Required parameter "${candParam.publicName}" added to "${baseline.displayName}"`,
            policy,
            specRef,
          }),
        );
      } else {
        changes.push(
          makeChange({
            category,
            symbol: baseline.fqName,
            old: { parameter: '(absent)' },
            new: { parameter: candParam.publicName },
            message: `Optional parameter "${candParam.publicName}" added to "${baseline.displayName}"`,
            policy,
            specRef,
          }),
        );
      }
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parameterNameIsPublicApi(param: CompatParameter, policy: CompatPolicyHints, isConstructor: boolean): boolean {
  if (param.sensitivity.publicName) return true;
  if (isConstructor) return policy.constructorParameterNamesArePublicApi;
  return policy.methodParameterNamesArePublicApi;
}

/**
 * Build a deterministic conceptual change ID.
 *
 * When `specRef` is provided (e.g. "GenerateLinkBody.admin_emails"), it is
 * used instead of the language-specific symbol name.  This ensures the same
 * spec entity produces the same ID across all languages, enabling cross-
 * language rollup in reports.
 */
function buildConceptualChangeId(
  category: CompatChangeCategory,
  symbol: string,
  match: Record<string, string>,
  specRef?: string,
): string {
  const identity = specRef ?? symbol;
  const parts = ['chg', category, identity.replace(/[^a-zA-Z0-9_.]/g, '_')];
  if (match.parameter) parts.push(match.parameter);
  if (match.member) parts.push(match.member);
  return parts.join('_').toLowerCase();
}

function makeChange(opts: {
  category: CompatChangeCategory;
  symbol: string;
  old: Record<string, string>;
  new: Record<string, string>;
  message: string;
  policy: CompatPolicyHints;
  provenance?: CompatProvenance;
  severityOverride?: CompatChangeSeverity;
  specRef?: string;
}): ClassifiedChange {
  return {
    category: opts.category,
    severity: opts.severityOverride ?? defaultSeverityForCategory(opts.category),
    symbol: opts.symbol,
    conceptualChangeId: buildConceptualChangeId(opts.category, opts.symbol, opts.old, opts.specRef),
    provenance: opts.provenance ?? 'unknown',
    old: opts.old,
    new: opts.new,
    message: opts.message,
  };
}

/**
 * Classify a new symbol as additive.
 */
export function classifyAddedSymbol(symbol: CompatSymbol): ClassifiedChange {
  return {
    category: 'symbol_added',
    severity: 'additive',
    symbol: symbol.fqName,
    conceptualChangeId: buildConceptualChangeId('symbol_added', symbol.fqName, {}, symbol.schemaName),
    provenance: 'unknown',
    old: { symbol: '(absent)' },
    new: { symbol: symbol.fqName },
    message: `Symbol "${symbol.displayName}" was added`,
  };
}

/** Summarize a list of classified changes by severity. */
export function summarizeChanges(changes: ClassifiedChange[]): ClassificationResult['summary'] {
  let breaking = 0;
  let softRisk = 0;
  let additive = 0;
  for (const c of changes) {
    if (c.severity === 'breaking') breaking++;
    else if (c.severity === 'soft-risk') softRisk++;
    else additive++;
  }
  return { breaking, softRisk, additive };
}
