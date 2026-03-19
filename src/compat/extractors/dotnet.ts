/**
 * DotNet (C#) API surface extractor.
 *
 * Walks `.cs` files (excluding test, bin, and obj directories), parses
 * classes, enums, properties, and methods, then builds an `ApiSurface`.
 *
 * Parser:  `dotnet-parser.ts`  — regex-based C# source analysis
 * Surface: `dotnet-surface.ts` — ApiSurface construction
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExtractorError } from '../../errors.js';
import type { Extractor, ApiSurface, LanguageHints } from '../types.js';
import { NAMED_TYPE_RE, typeExistsInSurface } from '../language-hints.js';
import { splitWords } from '../../utils/naming.js';
import { walkCSharpFiles, parseCSharpFile } from './dotnet-parser.js';
import { buildSurface } from './dotnet-surface.js';
import type { CSharpClass, CSharpEnum } from './dotnet-parser.js';


// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const DOTNET_PRIMITIVE_TYPES = new Set(['string', 'int', 'long', 'float', 'double', 'bool', 'decimal']);

const dotnetHints: LanguageHints = {
  stripNullable(type: string): string | null {
    // Nullable<T> → T
    const nullableMatch = type.match(/^Nullable<(.+)>$/);
    if (nullableMatch) return nullableMatch[1];
    // T? → T
    if (type.endsWith('?')) return type.slice(0, -1);
    return null;
  },
  isNullableOnlyDifference(a: string, b: string): boolean {
    const strippedA = this.stripNullable(a) ?? a;
    const strippedB = this.stripNullable(b) ?? b;
    return strippedA === strippedB && a !== b;
  },
  isUnionReorder(_a: string, _b: string): boolean {
    return false; // C# doesn't have union types
  },
  isGenericTypeParam(type: string): boolean {
    return /^[A-Z]$/.test(type) || /^T[A-Z][a-zA-Z]*$/.test(type);
  },
  isExtractionArtifact(type: string): boolean {
    return type === 'object' || type === 'dynamic';
  },
  tolerateCategoryMismatch: false,
  extractReturnTypeName(returnType: string): string | null {
    let inner = returnType;
    // Unwrap Task<T> → T
    const taskMatch = inner.match(/^Task<(.+)>$/);
    if (taskMatch) inner = taskMatch[1];
    // Unwrap Task → void
    if (inner === 'Task') return null;
    // Unwrap nullable
    if (inner.endsWith('?')) inner = inner.slice(0, -1);
    // Unwrap List<T> → T
    const listMatch = inner.match(/^(?:List|IList|IEnumerable|IReadOnlyList)<(.+)>$/);
    if (listMatch) inner = listMatch[1];
    // Primitives
    if (['string', 'int', 'long', 'float', 'double', 'bool', 'void', 'decimal'].includes(inner)) return null;
    return inner;
  },
  extractParamTypeName(paramType: string): string | null {
    let inner = paramType;
    if (inner.endsWith('?')) inner = inner.slice(0, -1);
    if (['string', 'int', 'long', 'float', 'double', 'bool', 'decimal'].includes(inner)) return null;
    return inner;
  },
  propertyMatchesClass(propertyName: string, className: string): boolean {
    return propertyName.toLowerCase() === className.toLowerCase();
  },
  derivedModelNames(modelName: string): string[] {
    return [`${modelName}Response`];
  },

  isTypeEquivalent(baselineType: string, candidateType: string, candidateSurface: ApiSurface): boolean {
    // Strip nullable from both sides for comparison
    const stripNullable = (t: string) => {
      if (t.endsWith('?')) return t.slice(0, -1);
      const m = t.match(/^Nullable<(.+)>$/);
      return m ? m[1] : t;
    };
    const baseClean = stripNullable(baselineType);
    const candClean = stripNullable(candidateType);

    // Map/dictionary equivalence: Dictionary<string, string> ≡ Dictionary<string, object>
    const dictPattern = /^Dictionary<string,\s*(string|object|dynamic|Object)>$/;
    if (dictPattern.test(baseClean) && dictPattern.test(candClean)) {
      return true;
    }

    // Array notation equivalence: T[] ≡ List<T>
    const arrayMatch = baseClean.match(/^(.+)\[\]$/);
    const listMatch = candClean.match(/^(?:List|IList|IEnumerable|IReadOnlyList)<(.+)>$/);
    if (arrayMatch && listMatch) {
      // Compare inner types — allow named type tolerance
      const baseInner = arrayMatch[1];
      const candInner = listMatch[1];
      if (baseInner === candInner) return true;
      // Recurse for named type equivalence
      if (NAMED_TYPE_RE.test(baseInner) && NAMED_TYPE_RE.test(candInner)) {
        if (typeExistsInSurface(candInner, candidateSurface)) {
          if (candInner.includes(baseInner) || baseInner.includes(candInner)) return true;
          const baseNoResp = baseInner.replace(/Response$/, '');
          const candNoResp = candInner.replace(/Response$/, '');
          if (candNoResp.includes(baseNoResp) || baseNoResp.includes(candNoResp)) return true;
          // Word overlap
          const baseWords = new Set(
            splitWords(baseNoResp)
              .filter((w) => w.length > 2)
              .map((w) => w.toLowerCase()),
          );
          const candWords = new Set(
            splitWords(candNoResp)
              .filter((w) => w.length > 2)
              .map((w) => w.toLowerCase()),
          );
          const overlap = [...baseWords].filter((w) => candWords.has(w));
          if (overlap.length >= 1 && overlap.length >= Math.min(baseWords.size, candWords.size) - 1) return true;
        }
      }
      // Tolerate model collection vs primitive collection: OrganizationDomain[] ≡ List<string>
      // The spec may define a field as a primitive array while the live SDK wraps it in a model.
      if (
        (DOTNET_PRIMITIVE_TYPES.has(baseInner) && NAMED_TYPE_RE.test(candInner)) ||
        (DOTNET_PRIMITIVE_TYPES.has(candInner) && NAMED_TYPE_RE.test(baseInner))
      ) {
        return true;
      }
    }
    // Also handle reverse: baseline is List<T>, candidate is T[]
    const baseListMatch = baseClean.match(/^(?:List|IList|IEnumerable|IReadOnlyList)<(.+)>$/);
    const candArrayMatch = candClean.match(/^(.+)\[\]$/);
    if (baseListMatch && candArrayMatch) {
      const baseInner = baseListMatch[1];
      const candInner = candArrayMatch[1];
      if (baseInner === candInner) return true;
      if (NAMED_TYPE_RE.test(baseInner) && NAMED_TYPE_RE.test(candInner)) {
        if (typeExistsInSurface(candInner, candidateSurface)) {
          if (candInner.includes(baseInner) || baseInner.includes(candInner)) return true;
        }
      }
    }

    // Generic container equivalence: List<T> vs List<U>, T[] vs U[]
    // where T and U are different named types for the same concept
    const genericPattern = /^(?:List|IList|IEnumerable|IReadOnlyList)<(.+)>$/;
    const baseGeneric = baseClean.match(genericPattern);
    const candGeneric = candClean.match(genericPattern);
    if (baseGeneric && candGeneric) {
      const baseInner = baseGeneric[1];
      const candInner = candGeneric[1];
      if (baseInner === candInner) return true;
      if (NAMED_TYPE_RE.test(baseInner) && NAMED_TYPE_RE.test(candInner)) {
        if (typeExistsInSurface(candInner, candidateSurface)) {
          if (candInner.includes(baseInner) || baseInner.includes(candInner)) return true;
          const baseNoResp = baseInner.replace(/Response$/, '');
          const candNoResp = candInner.replace(/Response$/, '');
          if (candNoResp.includes(baseNoResp) || baseNoResp.includes(candNoResp)) return true;
          const baseWords = new Set(
            splitWords(baseNoResp)
              .filter((w) => w.length > 2)
              .map((w) => w.toLowerCase()),
          );
          const candWords = new Set(
            splitWords(candNoResp)
              .filter((w) => w.length > 2)
              .map((w) => w.toLowerCase()),
          );
          const overlap = [...baseWords].filter((w) => candWords.has(w));
          if (overlap.length >= 1 && overlap.length >= Math.min(baseWords.size, candWords.size) - 1) return true;
        }
      }
    }

    // Named type tolerance: different PascalCase names for the same concept
    // (e.g., EmailObject vs DirectoryUsersEmail, RoleResponse vs DirectoryUserRole)
    if (NAMED_TYPE_RE.test(baseClean) && NAMED_TYPE_RE.test(candClean)) {
      if (typeExistsInSurface(candClean, candidateSurface)) {
        if (candClean.includes(baseClean) || baseClean.includes(candClean)) return true;
        const baseNoResp = baseClean.replace(/Response$/, '');
        const candNoResp = candClean.replace(/Response$/, '');
        if (candNoResp.includes(baseNoResp) || baseNoResp.includes(candNoResp)) return true;
        // Word-component overlap
        const baseWords = new Set(
          splitWords(baseNoResp)
            .filter((w) => w.length > 2)
            .map((w) => w.toLowerCase()),
        );
        const candWords = new Set(
          splitWords(candNoResp)
            .filter((w) => w.length > 2)
            .map((w) => w.toLowerCase()),
        );
        const overlap = [...baseWords].filter((w) => candWords.has(w));
        if (overlap.length >= 1 && overlap.length >= Math.min(baseWords.size, candWords.size) - 1) return true;
      }
    }

    // Numeric type equivalence: int ≡ double, long ≡ double (JSON numbers)
    const numericTypes = new Set(['int', 'long', 'float', 'double', 'decimal']);
    if (numericTypes.has(baseClean) && numericTypes.has(candClean)) return true;

    // Date type equivalence: DateTime ≡ string (spec uses string with date-time format)
    if ((baseClean === 'DateTime' && candClean === 'string') || (baseClean === 'string' && candClean === 'DateTime')) {
      return true;
    }

    // Enum name vs string equivalence (candidate has an enum, baseline says string)
    if (baseClean === 'string' && candidateSurface.enums[candClean]) return true;
    if (candClean === 'string' && candidateSurface.enums?.[baseClean]) return true;

    return false;
  },

  modelBaseClasses: [],
  exceptionBaseClasses: ['Exception'],
};

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

/** Create a DotNet extractor with optional hint overrides. */
export function createDotnetExtractor(hintOverrides?: Partial<LanguageHints>): Extractor {
  const mergedHints: LanguageHints = hintOverrides ? { ...dotnetHints, ...hintOverrides } : dotnetHints;

  return {
    language: 'dotnet',
    hints: mergedHints,

    async extract(sdkPath: string): Promise<ApiSurface> {
      // Determine the source directory: prefer src/, fallback to root
      let sourceDir: string;
      const srcPath = resolve(sdkPath, 'src');

      try {
        statSync(srcPath);
        sourceDir = srcPath;
      } catch {
        sourceDir = sdkPath;
      }

      const csFiles = walkCSharpFiles(sourceDir);
      if (csFiles.length === 0) {
        throw new ExtractorError(
          `No .cs files found in ${sdkPath}`,
          `Ensure the --sdk-path argument points to a .NET project root containing .cs source files.`,
        );
      }

      const allClasses: CSharpClass[] = [];
      const allEnums: CSharpEnum[] = [];

      for (const filePath of csFiles) {
        const parsed = parseCSharpFile(filePath, sdkPath);
        allClasses.push(...parsed.classes);
        allEnums.push(...parsed.enums);
      }

      const { classes, interfaces, enums, exports } = buildSurface(allClasses, allEnums, mergedHints);

      return {
        language: 'dotnet',
        extractedFrom: sdkPath,
        extractedAt: new Date().toISOString(),
        classes,
        interfaces,
        typeAliases: {},
        enums,
        exports,
      };
    },
  };
}

/** Default DotNet extractor with generic language hints. */
export const dotnetExtractor: Extractor = createDotnetExtractor();
