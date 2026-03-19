import type { ApiSurface, LanguageHints } from './types.js';
import { splitWords } from '../utils/naming.js';

/** Untyped map patterns — hoisted to avoid allocation on every isTypeEquivalent call. */
const UNTYPED_MAP_PATTERNS = new Set([
  'Record<string, unknown>',
  'Record<string, any>',
  '{ [key: string]: any; }',
  '{ [key: string]: unknown; }',
  'any',
]);

export const NAMED_TYPE_RE = /^[A-Z][a-zA-Z0-9]*$/;

/** Check whether a type name exists as an interface, class, or enum in a surface. */
export function typeExistsInSurface(name: string, surface: ApiSurface): boolean {
  return !!(surface.interfaces[name] || surface.classes[name] || surface.enums[name]);
}

/** Split a PascalCase string into words, keeping only words > 2 chars. */
function splitPascalWords(s: string): string[] {
  return splitWords(s).filter((w) => w.length > 2);
}

/** Split a pipe-delimited union string into trimmed, non-empty members. */
function parseUnionMembers(s: string): string[] {
  return s
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Node/TypeScript language hints — reference implementation.
 * Extracted from the hardcoded logic previously in differ.ts and overlay.ts.
 */
export const nodeHints: LanguageHints = {
  stripNullable(type: string): string | null {
    const members = parseUnionMembers(type);
    const stripped = members.filter((p) => p !== 'null');
    if (stripped.length === members.length) {
      return null; // no null member found
    }
    return stripped.join(' | ');
  },

  isNullableOnlyDifference(a: string, b: string): boolean {
    return (nodeHints.stripNullable(a) ?? a) === (nodeHints.stripNullable(b) ?? b);
  },

  isUnionReorder(a: string, b: string): boolean {
    const membersA = parseUnionMembers(a).sort();
    const membersB = parseUnionMembers(b).sort();
    if (membersA.length !== membersB.length || membersA.length < 2) return false;
    return membersA.every((m, i) => m === membersB[i]);
  },

  isGenericTypeParam(type: string): boolean {
    if (/^[A-Z]$/.test(type)) return true;
    if (/^T[A-Z][a-zA-Z]*$/.test(type)) return true;
    if (/^[A-Z]\[\]$/.test(type) || /^T[A-Z][a-zA-Z]*\[\]$/.test(type)) return true;
    return false;
  },

  isExtractionArtifact(type: string): boolean {
    return type === 'any' || type === 'Record<string, unknown>';
  },

  tolerateCategoryMismatch: true,

  extractReturnTypeName(returnType: string): string | null {
    let inner = returnType;
    while (inner.startsWith('Promise<') && inner.endsWith('>')) {
      inner = inner.slice(8, -1);
    }
    const genericMatch = inner.match(/^[A-Za-z]+<(.+)>$/);
    if (genericMatch) {
      inner = genericMatch[1];
    }
    inner = inner.replace(/\[\]$/, '');
    if (['void', 'string', 'number', 'boolean', 'any', 'unknown', 'null', 'undefined'].includes(inner)) {
      return null;
    }
    return inner;
  },

  extractParamTypeName(paramType: string): string | null {
    if (['string', 'number', 'boolean', 'any', 'unknown'].includes(paramType)) {
      return null;
    }
    return paramType;
  },

  propertyMatchesClass(propertyName: string, className: string): boolean {
    // Support both camelCase and snake_case properties matching PascalCase classes
    // e.g., "organizations" ≡ "Organizations", "api_keys" ≡ "ApiKeys"
    const normalizedProp = propertyName.replace(/[-_]/g, '').toLowerCase();
    return normalizedProp === className.toLowerCase();
  },

  derivedModelNames(modelName: string): string[] {
    return [`${modelName}Response`, `Serialized${modelName}`];
  },

  isTypeEquivalent(baselineType: string, candidateType: string, candidateSurface: ApiSurface): boolean {
    // Check if one side is a named enum and the other is an inline union
    // of that enum's string literal values.
    // e.g., baseline: '"active" | "inactive"', candidate: 'ConnectionState'
    //    or baseline: 'ConnectionState', candidate: '"active" | "inactive"'

    // Try: candidate is enum name, baseline is inline union of string literals.
    // The generated enum may have MORE members than the baseline (new spec values),
    // so check that all baseline members exist in the enum (subset match).
    const candEnum = candidateSurface.enums[candidateType];
    if (candEnum) {
      const enumValuesSet = new Set(Object.values(candEnum.members).flatMap((v) => [`"${v}"`, `'${v}'`]));
      const baseMembers = parseUnionMembers(baselineType);
      if (baseMembers.length > 0 && baseMembers.every((m) => enumValuesSet.has(m))) {
        return true;
      }
    }

    // Tolerate untyped-map equivalences:
    // { [key: string]: any; } ≡ Record<string, unknown> ≡ Record<string, any>
    if (UNTYPED_MAP_PATTERNS.has(baselineType) && UNTYPED_MAP_PATTERNS.has(candidateType)) {
      return true;
    }

    // Tolerate inline object literal vs named model in candidate.
    // e.g., baseline: '{ type: "organization"; id: string; }', candidate: 'ApiKeyOwner'
    // The named model is more structured but semantically equivalent.
    if (baselineType.startsWith('{') && baselineType.endsWith('}')) {
      if (typeExistsInSurface(candidateType, candidateSurface)) {
        return true;
      }
    }

    // Tolerate named-type-to-named-type mismatches when both types exist
    // as models/interfaces/enums in their respective surfaces. This handles
    // cases where the parser qualifies inline types with parent names while
    // the live SDK uses shared types:
    //   baseline: RoleResponse, candidate: OrganizationMembershipRole
    //   baseline: ConnectionType, candidate: ProfileConnectionType
    //   baseline: AuditLogTargetSchema[], candidate: AuditLogSchemaJsonTarget[]
    const baseClean = baselineType.replace(/\[\]$/, '');
    const candClean = candidateType.replace(/\[\]$/, '');
    const sameArrayness = baselineType.endsWith('[]') === candidateType.endsWith('[]');

    // Response suffix equivalence (both directions)
    if (sameArrayness) {
      if (candClean === baseClean + 'Response' || baseClean === candClean + 'Response') {
        return true;
      }
    }

    // Both are named types (PascalCase, no operators) — check if candidate
    // is a known model/interface/enum, and baseline looks like a named type too.
    // This tolerates the parser's qualified naming vs the live SDK's shared naming.
    if (sameArrayness && NAMED_TYPE_RE.test(baseClean) && NAMED_TYPE_RE.test(candClean)) {
      if (typeExistsInSurface(candClean, candidateSurface)) {
        // One name contains the other (e.g., ProfileConnectionType contains ConnectionType)
        if (candClean.includes(baseClean) || baseClean.includes(candClean)) {
          return true;
        }
        // Strip Response suffix and check containment
        const baseNoResp = baseClean.replace(/Response$/, '');
        const candNoResp = candClean.replace(/Response$/, '');
        if (candNoResp.includes(baseNoResp) || baseNoResp.includes(candNoResp)) {
          return true;
        }
        // Word-component overlap: split PascalCase into words and check
        // if they share enough meaningful words (handles name reordering
        // from Json merges: AuditLogTargetSchema vs AuditLogSchemaJsonTarget)
        const baseWords = new Set(splitPascalWords(baseNoResp));
        const candWords = new Set(splitPascalWords(candNoResp));
        const overlap = [...baseWords].filter((w) => candWords.has(w));
        if (overlap.length >= 2 && overlap.length >= Math.min(baseWords.size, candWords.size) - 1) {
          return true;
        }
      }
    }

    return false;
  },
};

/**
 * Merge partial language hint overrides over nodeHints defaults.
 * Any hint not provided falls back to the Node/TypeScript implementation.
 */
export function resolveHints(overrides: Partial<LanguageHints>): LanguageHints {
  return { ...nodeHints, ...overrides };
}
