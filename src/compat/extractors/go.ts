/**
 * Go API surface extractor.
 *
 * Walks `.go` files (excluding `_test.go` and `internal/`), parses exported
 * structs, functions, type declarations, and const blocks, then builds an
 * `ApiSurface` with package-qualified names to avoid collisions when
 * multiple packages define the same symbol (e.g., `Client`).
 *
 * Parser: `go-parser.ts`   — regex-based Go source analysis
 * Surface: `go-surface.ts` — ApiSurface construction & name qualification
 */

import { ExtractorError } from '../../errors.js';
import type { Extractor, ApiSurface, LanguageHints } from '../types.js';
import { defaultIsNullableOnlyDifference } from '../language-hints.js';
import { walkGoFiles, parseGoFile } from './go-parser.js';
import { buildSurface } from './go-surface.js';
import type { GoStruct, GoTypeDecl, GoFunc, GoConst } from './go-parser.js';

// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

/**
 * Go acronyms that may differ in casing between hand-written and generated code.
 * e.g., hand-written uses "Json" / "Uri" while generated uses "JSON" / "URI".
 */
const GO_ACRONYMS = [
  'ID',
  'URL',
  'API',
  'HTTP',
  'HTTPS',
  'JSON',
  'XML',
  'SQL',
  'HTML',
  'CSS',
  'URI',
  'SSO',
  'IP',
  'TLS',
  'SSL',
  'DNS',
  'TCP',
  'UDP',
  'SSH',
  'JWT',
  'MFA',
  'SAML',
  'SCIM',
];

// Precompiled regex matching all acronym forms (uppercase + title-case) in a single pass.
const GO_ACRONYM_RE = new RegExp(
  GO_ACRONYMS.flatMap((a) => [a, a.charAt(0) + a.slice(1).toLowerCase()]).join('|'),
  'g',
);

/**
 * Normalize a Go type string so that acronym casing differences don't cause
 * false mismatches. Lowercases all known Go acronyms to a canonical form.
 */
function normalizeGoAcronyms(type: string): string {
  return type.replace(GO_ACRONYM_RE, (match) => match.toLowerCase());
}

const goHints: LanguageHints = {
  stripNullable(type: string): string | null {
    if (type.startsWith('*')) return type.slice(1);
    return null;
  },
  isNullableOnlyDifference(a: string, b: string): boolean {
    return defaultIsNullableOnlyDifference(this, a, b);
  },
  isUnionReorder(_a: string, _b: string): boolean {
    return false;
  },
  isGenericTypeParam(type: string): boolean {
    return type === 'interface{}' || type === 'any';
  },
  isExtractionArtifact(type: string): boolean {
    return type === 'interface{}' || type === 'any';
  },
  tolerateCategoryMismatch: false,
  extractReturnTypeName(returnType: string): string | null {
    const stripped = returnType.replace(/^\*/, '').replace(/\[\]/, '');
    return stripped || null;
  },
  extractParamTypeName(paramType: string): string | null {
    const stripped = paramType.replace(/^\*/, '');
    if (['string', 'int', 'int64', 'float64', 'bool'].includes(stripped)) return null;
    return stripped;
  },
  propertyMatchesClass(propertyName: string, className: string): boolean {
    return propertyName.toLowerCase() === className.toLowerCase();
  },
  derivedModelNames(_modelName: string): string[] {
    // Go SDK does not generate *Response wrapper types — models are returned directly.
    // Don't derive extra names, as they would create false positives in compat checks
    // when the live SDK has hand-written response wrappers.
    return [];
  },
  isTypeEquivalent(baselineType: string, candidateType: string, candidateSurface: ApiSurface): boolean {
    // Normalize Go acronym casing differences (e.g., "Json" vs "JSON", "Uri" vs "URI")
    const normBase = normalizeGoAcronyms(baselineType);
    const normCand = normalizeGoAcronyms(candidateType);
    if (normBase === normCand) return true;

    // Also try after stripping nullable wrappers and slice prefixes on both sides
    const stripType = (t: string) => t.replace(/^\*/, '').replace(/^\[\]/, '');
    const strippedBase = stripType(normBase);
    const strippedCand = stripType(normCand);
    if (strippedBase === strippedCand) return true;

    // Strip package qualifiers (e.g., "common.RoleResponse" → "RoleResponse")
    const unqualBase = strippedBase.includes('.') ? strippedBase.split('.').pop()! : strippedBase;
    const unqualCand = strippedCand.includes('.') ? strippedCand.split('.').pop()! : strippedCand;
    if (unqualBase === unqualCand) return true;

    // Suffix match: the baseline may use a shorter shared type name while the
    // generated code prefixes it with the parent struct name.
    // e.g., baseline "FactorType" matches generated "AuthenticationFactorType"
    // Only match if the candidate type actually exists in the generated surface.
    const candRaw = stripType(candidateType);
    if (unqualCand.endsWith(unqualBase) && unqualCand.length > unqualBase.length) {
      const exists =
        candidateSurface.enums[candRaw] != null ||
        candidateSurface.interfaces[candRaw] != null ||
        candidateSurface.classes[candRaw] != null ||
        candidateSurface.typeAliases[candRaw] != null;
      if (exists) return true;
    }

    return false;
  },
};

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const goExtractor: Extractor = {
  language: 'go',
  hints: goHints,

  async extract(sdkPath: string): Promise<ApiSurface> {
    const goFiles = walkGoFiles(sdkPath);
    if (goFiles.length === 0) {
      throw new ExtractorError(
        `No .go files found in ${sdkPath}`,
        `Ensure the --sdk-path argument points to a Go project root containing .go source files.`,
      );
    }

    const allStructs: GoStruct[] = [];
    const allTypes: GoTypeDecl[] = [];
    const allFuncs: GoFunc[] = [];
    const allConsts: GoConst[] = [];

    for (const filePath of goFiles) {
      const parsed = parseGoFile(filePath, sdkPath);
      allStructs.push(...parsed.structs);
      allTypes.push(...parsed.types);
      allFuncs.push(...parsed.funcs);
      allConsts.push(...parsed.consts);
    }

    const { classes, interfaces, typeAliases, enums, exports } = buildSurface(
      allStructs,
      allTypes,
      allFuncs,
      allConsts,
    );

    return {
      language: 'go',
      extractedFrom: sdkPath,
      extractedAt: new Date().toISOString(),
      classes,
      interfaces,
      typeAliases,
      enums,
      exports,
    };
  },
};
