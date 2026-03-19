/**
 * Kotlin API surface extractor.
 *
 * Walks `.kt` files (excluding test files and build directories), parses
 * data classes, classes, enum classes, and type aliases, then builds an
 * `ApiSurface`.
 *
 * Parser:  `kotlin-parser.ts`  — regex-based Kotlin source analysis
 * Surface: `kotlin-surface.ts` — ApiSurface construction
 */

import { ExtractorError } from '../../errors.js';
import type { Extractor, ApiSurface, LanguageHints } from '../types.js';
import { defaultIsNullableOnlyDifference } from '../language-hints.js';
import { walkKotlinFiles, parseKotlinFile } from './kotlin-parser.js';
import { buildSurface } from './kotlin-surface.js';
import type { KotlinDataClass, KotlinClass, KotlinEnum, KotlinTypeAlias } from './kotlin-parser.js';


// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const kotlinHints: LanguageHints = {
  stripNullable(type: string): string | null {
    if (type.endsWith('?')) return type.slice(0, -1);
    return null;
  },
  isNullableOnlyDifference(a: string, b: string): boolean {
    return defaultIsNullableOnlyDifference(this, a, b);
  },
  isUnionReorder(_a: string, _b: string): boolean {
    return false; // Kotlin doesn't have union types
  },
  isGenericTypeParam(type: string): boolean {
    return /^[A-Z]$/.test(type) || /^T[A-Z][a-zA-Z]*$/.test(type);
  },
  isExtractionArtifact(type: string): boolean {
    return type === 'Any' || type === 'Any?';
  },
  tolerateCategoryMismatch: true,
  extractReturnTypeName(returnType: string): string | null {
    let inner = returnType;
    // Unwrap nullable
    if (inner.endsWith('?')) inner = inner.slice(0, -1);
    // Unwrap List<T> → T
    const listMatch = inner.match(/^(?:List|MutableList|ArrayList)<(.+)>$/);
    if (listMatch) inner = listMatch[1];
    // Unwrap PaginatedList<T> → T
    const paginatedMatch = inner.match(/^PaginatedList<(.+)>$/);
    if (paginatedMatch) inner = paginatedMatch[1];
    // Primitives
    if (['String', 'Int', 'Long', 'Float', 'Double', 'Boolean', 'Unit', 'Void'].includes(inner)) return null;
    return inner;
  },
  extractParamTypeName(paramType: string): string | null {
    let inner = paramType;
    if (inner.endsWith('?')) inner = inner.slice(0, -1);
    if (['String', 'Int', 'Long', 'Float', 'Double', 'Boolean'].includes(inner)) return null;
    return inner;
  },
  propertyMatchesClass(propertyName: string, className: string): boolean {
    // camelCase property vs PascalCase class
    return propertyName.toLowerCase() === className.toLowerCase();
  },
  derivedModelNames(modelName: string): string[] {
    return [`${modelName}Response`];
  },
};

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const kotlinExtractor: Extractor = {
  language: 'kotlin',
  hints: kotlinHints,

  async extract(sdkPath: string): Promise<ApiSurface> {
    const ktFiles = walkKotlinFiles(sdkPath);
    if (ktFiles.length === 0) {
      throw new ExtractorError(
        `No .kt files found in ${sdkPath}`,
        `Ensure the --sdk-path argument points to a Kotlin project root containing .kt source files.`,
      );
    }

    const allDataClasses: KotlinDataClass[] = [];
    const allClasses: KotlinClass[] = [];
    const allEnums: KotlinEnum[] = [];
    const allTypeAliases: KotlinTypeAlias[] = [];

    for (const filePath of ktFiles) {
      const parsed = parseKotlinFile(filePath, sdkPath);
      allDataClasses.push(...parsed.dataClasses);
      allClasses.push(...parsed.classes);
      allEnums.push(...parsed.enums);
      allTypeAliases.push(...parsed.typeAliases);
    }

    const { classes, interfaces, typeAliases, enums, exports } = buildSurface(
      allDataClasses,
      allClasses,
      allEnums,
      allTypeAliases,
    );

    return {
      language: 'kotlin',
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
