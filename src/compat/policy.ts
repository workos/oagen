/**
 * Language-aware compatibility policy.
 *
 * Defines which aspects of the public API surface are breaking in each
 * language. Built-in defaults capture language semantics (e.g., PHP has
 * named arguments, Go does not). Config overrides allow per-SDK divergence.
 */

import type { LanguageId } from './ir.js';

/** Policy hints that determine what constitutes a breaking change. */
export interface CompatPolicyHints {
  /** Callers reference parameter names at the call site (PHP named args, Python/Ruby keyword args, Kotlin/C# named args). */
  callerUsesParamNames: boolean;
  /** Constructor positional order is part of the public API. */
  constructorOrderMatters: boolean;
  /** Method parameter names are visible to callers. */
  methodParameterNamesArePublicApi: boolean;
  /** Constructor parameter names are visible to callers. */
  constructorParameterNamesArePublicApi: boolean;
  /** Method overload sets are part of the public API (Kotlin, C#). */
  overloadsArePublicApi: boolean;
  /** Function arity is part of the public API (Elixir, Go). */
  arityIsPublicApi: boolean;
}

/** Built-in language defaults. */
const LANGUAGE_DEFAULTS: Record<LanguageId, CompatPolicyHints> = {
  php: {
    callerUsesParamNames: true,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: false,
    arityIsPublicApi: false,
  },
  python: {
    callerUsesParamNames: true,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: false,
    arityIsPublicApi: false,
  },
  ruby: {
    callerUsesParamNames: true,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: false,
    arityIsPublicApi: false,
  },
  go: {
    callerUsesParamNames: false,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: false,
    constructorParameterNamesArePublicApi: false,
    overloadsArePublicApi: false,
    arityIsPublicApi: true,
  },
  kotlin: {
    callerUsesParamNames: true,
    constructorOrderMatters: false,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: true,
    arityIsPublicApi: false,
  },
  dotnet: {
    callerUsesParamNames: true,
    constructorOrderMatters: false,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: true,
    arityIsPublicApi: false,
  },
  elixir: {
    callerUsesParamNames: true,
    constructorOrderMatters: false,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: false,
    overloadsArePublicApi: false,
    arityIsPublicApi: true,
  },
  rust: {
    callerUsesParamNames: false,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: false,
    constructorParameterNamesArePublicApi: false,
    overloadsArePublicApi: false,
    arityIsPublicApi: true,
  },
  node: {
    callerUsesParamNames: false,
    constructorOrderMatters: false,
    methodParameterNamesArePublicApi: false,
    constructorParameterNamesArePublicApi: false,
    overloadsArePublicApi: false,
    arityIsPublicApi: false,
  },
};

/** Get the built-in default policy for a language. */
export function getDefaultPolicy(language: LanguageId): CompatPolicyHints {
  return { ...LANGUAGE_DEFAULTS[language] };
}

/** Merge user overrides onto language defaults. Only provided keys are overridden. */
export function mergePolicy(defaults: CompatPolicyHints, overrides: Partial<CompatPolicyHints>): CompatPolicyHints {
  return { ...defaults, ...overrides };
}

/** All supported language IDs. */
export const ALL_LANGUAGE_IDS: readonly LanguageId[] = Object.keys(LANGUAGE_DEFAULTS) as LanguageId[];
