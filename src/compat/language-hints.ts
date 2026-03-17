import type { ApiSurface, LanguageHints } from './types.js';

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
    return propertyName === className.charAt(0).toLowerCase() + className.slice(1);
  },

  derivedModelNames(modelName: string): string[] {
    return [`${modelName}Response`, `Serialized${modelName}`];
  },

  isTypeEquivalent(
    baselineType: string,
    candidateType: string,
    candidateSurface: ApiSurface,
  ): boolean {
    // Check if one side is a named enum and the other is an inline union
    // of that enum's string literal values.
    // e.g., baseline: '"active" | "inactive"', candidate: 'ConnectionState'
    //    or baseline: 'ConnectionState', candidate: '"active" | "inactive"'

    // Try: candidate is enum name, baseline is inline union of string literals.
    // The generated enum may have MORE members than the baseline (new spec values),
    // so check that all baseline members exist in the enum (subset match).
    const candEnum = candidateSurface.enums[candidateType];
    if (candEnum) {
      const enumValuesSet = new Set(
        Object.values(candEnum.members).flatMap((v) => [`"${v}"`, `'${v}'`]),
      );
      const baseMembers = parseUnionMembers(baselineType);
      if (baseMembers.length > 0 && baseMembers.every((m) => enumValuesSet.has(m))) {
        return true;
      }
    }

    // Tolerate untyped-map equivalences:
    // { [key: string]: any; } ≡ Record<string, unknown> ≡ Record<string, any>
    const untypedMapPatterns = [
      'Record<string, unknown>',
      'Record<string, any>',
      '{ [key: string]: any; }',
      '{ [key: string]: unknown; }',
      'any',
    ];
    if (untypedMapPatterns.includes(baselineType) && untypedMapPatterns.includes(candidateType)) {
      return true;
    }

    // Tolerate inline object literal vs named model in candidate.
    // e.g., baseline: '{ type: "organization"; id: string; }', candidate: 'ApiKeyOwner'
    // The named model is more structured but semantically equivalent.
    if (baselineType.startsWith('{') && baselineType.endsWith('}')) {
      if (candidateSurface.interfaces[candidateType] || candidateSurface.classes[candidateType]) {
        return true;
      }
    }

    // Tolerate Response-suffix equivalence for model names (with or without []):
    // e.g., 'DirectoryStateResponse' ≡ 'DirectoryState'
    //        'ConnectionDomain[]' ≡ 'ConnectionDomainResponse[]'
    //        'RoleAssignmentRole' ≡ 'RoleAssignmentRoleResponse'
    const baseStripped = baselineType.replace(/\[\]$/, '');
    const candStripped = candidateType.replace(/\[\]$/, '');
    const bothArray = baselineType.endsWith('[]') === candidateType.endsWith('[]');
    if (bothArray || baselineType.endsWith('[]') === candidateType.endsWith('[]')) {
      if (candStripped === baseStripped + 'Response' || baseStripped === candStripped + 'Response') {
        return true;
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
