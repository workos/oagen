import type { LanguageHints } from './types.js';

/**
 * Node/TypeScript language hints — reference implementation.
 * Extracted from the hardcoded logic previously in differ.ts and overlay.ts.
 */
export const nodeHints: LanguageHints = {
  stripNullable(type: string): string | null {
    const stripped = type
      .split('|')
      .map((p) => p.trim())
      .filter((p) => p !== 'null');
    if (stripped.length === type.split('|').map((p) => p.trim()).filter(Boolean).length) {
      return null; // no null member found
    }
    return stripped.join(' | ');
  },

  isNullableOnlyDifference(a: string, b: string): boolean {
    const stripNull = (s: string) =>
      s
        .split('|')
        .map((p) => p.trim())
        .filter((p) => p !== 'null')
        .join(' | ');
    return stripNull(a) === stripNull(b);
  },

  isUnionReorder(a: string, b: string): boolean {
    const parseMembers = (s: string) =>
      s
        .split('|')
        .map((p) => p.trim())
        .filter(Boolean)
        .sort();
    const membersA = parseMembers(a);
    const membersB = parseMembers(b);
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
    return type === 'any';
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
};

/**
 * Merge partial language hint overrides over nodeHints defaults.
 * Any hint not provided falls back to the Node/TypeScript implementation.
 */
export function resolveHints(overrides: Partial<LanguageHints>): LanguageHints {
  return { ...nodeHints, ...overrides };
}
