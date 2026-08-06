/**
 * Change classifier for compatibility verification.
 *
 * Takes raw diffs between baseline and candidate compat snapshots and
 * classifies each change into a specific category with policy-aware severity.
 */

import type { CompatSymbol, CompatParameter, LanguageId } from './ir.js';
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
  /**
   * Optional spec-level remediation hint. Set by post-classification rules
   * (see `detectForkedSchemas` in differ.ts) when a change has a recognized
   * upstream root cause that the spec author can fix. Surfaces in both the
   * machine-readable report and the human-readable summary.
   */
  remediation?: string;
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
// Type-form normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a type annotation string to a canonical form before equality
 * comparison. Emitters evolve their annotation style across releases (e.g.
 * Python's PEP 604 `X | None` replacing `Optional[X]`, PEP 585 lowercase
 * generics, or dropping quotes from forward refs); such changes are cosmetic
 * and must not register as breaking type changes. Only Python needs this
 * today — other languages encode optionality with a single stable spelling
 * (`*Foo`, `Option<T>`, `T?`, `T.nilable(Foo)`) so they use exact comparison.
 * String-literal *values* inside `Literal[...]` are preserved verbatim so a
 * genuine change to a wire value stays visible. When `language` is absent
 * (older snapshots) no normalization is applied, preserving prior behaviour.
 */
function normalizeType(type: string, language?: LanguageId): string {
  if (!type) return type;
  if (language !== 'python') return type;
  return canonicalizePythonType(type);
}

/** PEP 585 capitalized builtins that map to their lowercase spellings, so
 *  `List[str]` and `list[str]` compare equal. */
const PEP585_BUILTINS: Record<string, string> = {
  List: 'list',
  Dict: 'dict',
  Tuple: 'tuple',
  Set: 'set',
  FrozenSet: 'frozenset',
  Type: 'type',
};

/** Recursively canonicalize a Python annotation. Structural forms are
 *  normalized (`Optional[X]`→`X | None`, `Union[...]`→` | ` joins, PEP 585
 *  builtins, quoted forward refs, parenthesized unions), but `Literal[...]`
 *  arguments are preserved verbatim — their quotes and inner whitespace are
 *  part of the wire value, not cosmetic. */
function canonicalizePythonType(s: string): string {
  const t = s.trim();
  if (t.length === 0) return t;
  // Strip a wrapping pair of parentheses — the emitter sometimes groups
  // multi-line unions as `(A | B)`. Recurse in case of nested wrapping.
  if (t.startsWith('(') && t.endsWith(')')) {
    return canonicalizePythonType(t.slice(1, -1));
  }
  // Literal[...] holds *values*, not types. Normalize the quote *character*
  // (single ↔ double) so a cosmetic emitter quote-style flip doesn't register
  // as a change, but preserve each argument's inner content verbatim so a
  // real change to a wire value (e.g. `"a b"` → `"a  b"`) stays visible.
  // Only spacing between arguments is normalized.
  if (t.startsWith('Literal[') && t.endsWith(']')) {
    const inner = t.slice('Literal['.length, -1);
    return `Literal[${splitTopLevel(inner, ',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map(canonicalizeLiteralArg)
      .join(', ')}]`;
  }
  if (t.startsWith('Optional[') && t.endsWith(']')) {
    return `${canonicalizePythonType(t.slice('Optional['.length, -1))} | None`;
  }
  if (t.startsWith('Union[') && t.endsWith(']')) {
    return splitTopLevel(t.slice('Union['.length, -1), ',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map(canonicalizePythonType)
      .join(' | ');
  }
  // PEP 604 union at top level: split on `|` and canonicalize each arm.
  if (t.includes('|')) {
    const arms = splitTopLevel(t, '|')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (arms.length > 1) return arms.map(canonicalizePythonType).join(' | ');
  }
  // Other generic (Dict[str, Any], list[Foo]): preserve the outer constructor,
  // lowercase PEP 585 builtins, and canonicalize each type argument.
  const open = t.indexOf('[');
  if (open !== -1 && t.endsWith(']')) {
    const outer = t.slice(0, open).trim();
    const inner = t.slice(open + 1, -1);
    const canonicalOuter = PEP585_BUILTINS[outer] ?? outer;
    return `${canonicalOuter}[${splitTopLevel(inner, ',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map(canonicalizePythonType)
      .join(', ')}]`;
  }
  // Quoted forward ref: "Foo" / 'Foo' → Foo. The emitter quotes type names
  // defined later in the file; the quotes are cosmetic. String-literal values
  // are preserved by the Literal branch above, so this only strips quotes from
  // bare type-name references.
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return PEP585_BUILTINS[t] ?? t;
}

/** Canonicalize one `Literal[...]` argument so semantically identical string
 *  values compare equal regardless of quote style or escape form. The value
 *  is decoded (backslash escapes processed) then re-encoded in a canonical
 *  double-quoted form, so `Literal['say "hi"']` and `Literal["say \\"hi\\""]`
 *  both canonicalize to `"say \"hi\""`. Bare (unquoted) arguments — e.g. an
 *  enum name or a number — are returned unchanged. */
function canonicalizeLiteralArg(arg: string): string {
  const a = arg.trim();
  if (a.length < 2) return a;
  let quote: '"' | "'" | null = null;
  if (a.startsWith('"') && a.endsWith('"')) quote = '"';
  else if (a.startsWith("'") && a.endsWith("'")) quote = "'";
  if (!quote) return a; // bare arg (type ref / number) — not a string literal
  const value = decodeStringLiteral(a.slice(1, -1));
  return `"${encodeDoubleQuoted(value)}"`;
}

/** Decode the backslash escapes inside a Python string literal's content.
 *  Only the delimiter-relevant escapes (`\\`, `\'`, `\"`) are processed;
 *  other sequences (`\n`, `\t`, `\u…`) are kept verbatim since they're
 *  written identically regardless of quote style and so compare equal already. */
function decodeStringLiteral(content: string): string {
  let out = '';
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '\\' && i + 1 < content.length) {
      const next = content[i + 1];
      if (next === '\\' || next === '"' || next === "'") {
        out += next;
        i++;
        continue;
      }
      out += c + next; // preserve unknown escape verbatim
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Re-encode a decoded value as a canonical double-quoted Python string. */
function encodeDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Split on a separator that sits at bracket-depth 0 and outside string
 *  literals, so commas/pipes inside `Literal["a,b"]` or `"x|y"` are not split. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
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
  language?: LanguageId,
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
    changes.push(...classifyParameterChanges(baseline, candidate, policy, specRef, language));
  }

  // Return type changes (for callables)
  if (
    baseline.returns &&
    candidate.returns &&
    normalizeType(baseline.returns.name, language) !== normalizeType(candidate.returns.name, language)
  ) {
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

  // Static ↔ instance flips (for callables). Compared only when both
  // snapshots record staticness — extractors that don't capture it and
  // snapshots written before the field existed never produce this change.
  if (baseline.isStatic !== undefined && candidate.isStatic !== undefined && baseline.isStatic !== candidate.isStatic) {
    changes.push(
      makeChange({
        category: 'staticness_changed',
        symbol: baseline.fqName,
        old: { static: String(baseline.isStatic) },
        new: { static: String(candidate.isStatic) },
        message:
          `"${baseline.displayName}" changed from ${baseline.isStatic ? 'static' : 'instance'} ` +
          `to ${candidate.isStatic ? 'static' : 'instance'} — call sites must migrate`,
        policy,
        specRef,
      }),
    );
  }

  // Field/property type changes
  if (
    baseline.typeRef &&
    candidate.typeRef &&
    normalizeType(baseline.typeRef.name, language) !== normalizeType(candidate.typeRef.name, language)
  ) {
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
  language?: LanguageId,
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
    if (normalizeType(baseParam.type.name, language) !== normalizeType(candParam.type.name, language)) {
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

    // Position changed.
    //
    // Constructors are governed by `policy.constructorOrderMatters` — some
    // languages treat ctor positional order as part of the public API even
    // when method args are named.
    //
    // For methods, the parameter's `passing` style decides:
    //   - 'positional'     → callers reference by index; reorder is breaking
    //   - 'named'          → both styles work; reorder is soft-risk (positional callers exist)
    //   - 'keyword'        → callers MUST use names (Ruby kwargs, Python kw-only, Elixir); position invisible
    //   - 'options_object' → callers pass a single object literal (Node); position invisible
    if (baseParam.position !== candParam.position) {
      if (isConstructor) {
        if (policy.constructorOrderMatters) {
          changes.push(
            makeChange({
              category: 'constructor_position_changed_order_sensitive',
              symbol: baseline.fqName,
              old: { parameter: baseParam.publicName, position: String(baseParam.position) },
              new: { parameter: candParam.publicName, position: String(candParam.position) },
              message: `Parameter "${baseParam.publicName}" moved from position ${baseParam.position} to ${candParam.position} on "${baseline.displayName}"`,
              policy,
              specRef,
            }),
          );
        } else {
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
      } else if (baseParam.passing === 'positional') {
        changes.push(
          makeChange({
            category: 'parameter_position_changed_order_sensitive',
            symbol: baseline.fqName,
            old: { parameter: baseParam.publicName, position: String(baseParam.position) },
            new: { parameter: candParam.publicName, position: String(candParam.position) },
            message: `Parameter "${baseParam.publicName}" moved from position ${baseParam.position} to ${candParam.position} on "${baseline.displayName}"`,
            policy,
            specRef,
          }),
        );
      } else if (baseParam.passing === 'named') {
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
      // keyword / options_object: position is invisible to callers — no change emitted.
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
