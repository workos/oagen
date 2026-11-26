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
  /**
   * A parameter's type is checked by shape: a value is accepted for it when
   * it has the members the type asks for, whatever type the value was
   * declared as, and may be written in place as an object literal
   * (TypeScript's interfaces and object types). `false` where a value is
   * accepted by the type it was declared as: a class, a struct.
   *
   * It decides how a retyped parameter (`parameter_type_narrowed`) is found
   * to accept every argument callers pass today: by the two types' members
   * and by a union's members where this is `true`, by a declared supertype
   * alone where it is `false`. Optional, unlike the other hints: a snapshot
   * written before the key existed does not carry it, and a policy that does
   * not state it credits neither rule, so such a retype stays breaking.
   */
  parameterTypesAreStructural?: boolean;
}

/** Built-in language defaults. Each states every hint. */
const LANGUAGE_DEFAULTS: Record<LanguageId, Required<CompatPolicyHints>> = {
  php: {
    callerUsesParamNames: true,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: false,
    arityIsPublicApi: false,
    parameterTypesAreStructural: false,
  },
  python: {
    callerUsesParamNames: true,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: false,
    arityIsPublicApi: false,
    parameterTypesAreStructural: false,
  },
  ruby: {
    callerUsesParamNames: true,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: false,
    arityIsPublicApi: false,
    parameterTypesAreStructural: false,
  },
  go: {
    callerUsesParamNames: false,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: false,
    constructorParameterNamesArePublicApi: false,
    overloadsArePublicApi: false,
    arityIsPublicApi: true,
    parameterTypesAreStructural: false,
  },
  kotlin: {
    callerUsesParamNames: true,
    constructorOrderMatters: false,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: true,
    arityIsPublicApi: false,
    parameterTypesAreStructural: false,
  },
  dotnet: {
    callerUsesParamNames: true,
    constructorOrderMatters: false,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: true,
    arityIsPublicApi: false,
    parameterTypesAreStructural: false,
  },
  elixir: {
    callerUsesParamNames: true,
    constructorOrderMatters: false,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: false,
    overloadsArePublicApi: false,
    arityIsPublicApi: true,
    parameterTypesAreStructural: false,
  },
  rust: {
    callerUsesParamNames: false,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: false,
    constructorParameterNamesArePublicApi: false,
    overloadsArePublicApi: false,
    arityIsPublicApi: true,
    parameterTypesAreStructural: false,
  },
  // Swift: argument labels are mandatory and order-sensitive at the call
  // site, so both names and positions are public API. Overloading is legal.
  ios: {
    callerUsesParamNames: true,
    constructorOrderMatters: true,
    methodParameterNamesArePublicApi: true,
    constructorParameterNamesArePublicApi: true,
    overloadsArePublicApi: true,
    arityIsPublicApi: false,
    parameterTypesAreStructural: false,
  },
  node: {
    callerUsesParamNames: false,
    constructorOrderMatters: false,
    methodParameterNamesArePublicApi: false,
    constructorParameterNamesArePublicApi: false,
    overloadsArePublicApi: false,
    arityIsPublicApi: false,
    parameterTypesAreStructural: true,
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
