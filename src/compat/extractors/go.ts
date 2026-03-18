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
import { walkGoFiles, parseGoFile } from './go-parser.js';
import { buildSurface } from './go-surface.js';
import type { GoStruct, GoTypeDecl, GoFunc, GoConst } from './go-parser.js';

// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const goHints: LanguageHints = {
  stripNullable(type: string): string | null {
    if (type.startsWith('*')) return type.slice(1);
    return null;
  },
  isNullableOnlyDifference(a: string, b: string): boolean {
    const strippedA = this.stripNullable(a) ?? a;
    const strippedB = this.stripNullable(b) ?? b;
    return strippedA === strippedB && a !== b;
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
  derivedModelNames(modelName: string): string[] {
    return [`${modelName}Response`];
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}

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
      classes: sortRecord(classes),
      interfaces: sortRecord(interfaces),
      typeAliases: sortRecord(typeAliases),
      enums: sortRecord(enums),
      exports: sortRecord(exports),
    };
  },
};
