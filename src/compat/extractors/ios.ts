/**
 * Swift (iOS) API surface extractor.
 *
 * Walks `.swift` files (excluding tests, Package.swift, and build
 * directories), parses public structs, classes, actors, extensions, enums,
 * and type aliases, then builds an `ApiSurface`.
 *
 * Parser:  `ios-parser.ts`  — string-aware regex Swift source analysis
 * Surface: `ios-surface.ts` — ApiSurface construction
 */

import { ExtractorError } from '../../errors.js';
import type { Extractor, ApiSurface, LanguageHints } from '../types.js';
import type { CompatSnapshot } from '../ir.js';
import { apiSurfaceToSnapshot } from '../ir.js';
import { defaultIsNullableOnlyDifference } from '../language-hints.js';
import { walkSwiftFiles, parseSwiftFile } from './ios-parser.js';
import { buildSurface } from './ios-surface.js';
import type { SwiftTypeDecl, SwiftEnum, SwiftTypeAlias } from './ios-parser.js';

// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const PRIMITIVES = [
  'String',
  'Int',
  'Int32',
  'Int64',
  'Double',
  'Float',
  'Bool',
  'Void',
  'Data',
  'Date',
  'URL',
  'UUID',
];

/** Unwrap `[Element]` and `[Key: Value]` sugar; returns the element/value type. */
function unwrapBrackets(type: string): string {
  const bracketMatch = type.match(/^\[(.+)\]$/);
  if (!bracketMatch) return type;
  const inner = bracketMatch[1].trim();
  // Dictionary: the value type is the interesting one.
  const colonIdx = inner.indexOf(':');
  return colonIdx === -1 ? inner : inner.slice(colonIdx + 1).trim();
}

const iosHints: LanguageHints = {
  stripNullable(type: string): string | null {
    if (type.endsWith('?')) return type.slice(0, -1);
    return null;
  },
  isNullableOnlyDifference(a: string, b: string): boolean {
    return defaultIsNullableOnlyDifference(this, a, b);
  },
  isUnionReorder(_a: string, _b: string): boolean {
    return false; // Swift doesn't have union types
  },
  isGenericTypeParam(type: string): boolean {
    return /^[A-Z]$/.test(type) || /^T[A-Z][a-zA-Z]*$/.test(type);
  },
  isExtractionArtifact(type: string): boolean {
    return ['Any', 'Any?', 'AnyObject', 'AnyCodable', 'AnyCodable?'].includes(type);
  },
  tolerateCategoryMismatch: true,
  extractReturnTypeName(returnType: string): string | null {
    let inner = returnType.trim();
    // Unwrap optional
    if (inner.endsWith('?')) inner = inner.slice(0, -1);
    // Unwrap [Element] / [Key: Value] sugar
    inner = unwrapBrackets(inner);
    if (inner.endsWith('?')) inner = inner.slice(0, -1);
    // Unwrap Page<T> → T (the generated pagination wrapper)
    const pageMatch = inner.match(/^Page<(.+)>$/);
    if (pageMatch) inner = pageMatch[1];
    if (PRIMITIVES.includes(inner)) return null;
    return inner;
  },
  extractParamTypeName(paramType: string): string | null {
    let inner = paramType.trim();
    if (inner.endsWith('?')) inner = inner.slice(0, -1);
    inner = unwrapBrackets(inner);
    if (inner.endsWith('?')) inner = inner.slice(0, -1);
    if (PRIMITIVES.includes(inner)) return null;
    return inner;
  },
  propertyMatchesClass(propertyName: string, className: string): boolean {
    // camelCase property vs PascalCase type
    return propertyName.toLowerCase() === className.toLowerCase();
  },
  derivedModelNames(modelName: string): string[] {
    return [`${modelName}Response`];
  },
};

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const iosExtractor: Extractor = {
  language: 'ios',
  hints: iosHints,

  async extractSnapshot(sdkPath: string): Promise<CompatSnapshot> {
    const surface = await this.extract(sdkPath);
    return apiSurfaceToSnapshot(surface);
  },

  async extract(sdkPath: string): Promise<ApiSurface> {
    const swiftFiles = walkSwiftFiles(sdkPath);
    if (swiftFiles.length === 0) {
      throw new ExtractorError(
        `No .swift files found in ${sdkPath}`,
        `Ensure the --sdk-path argument points to a Swift package root containing .swift source files.`,
      );
    }

    const allTypes: SwiftTypeDecl[] = [];
    const allEnums: SwiftEnum[] = [];
    const allTypeAliases: SwiftTypeAlias[] = [];

    for (const filePath of swiftFiles) {
      const parsed = parseSwiftFile(filePath, sdkPath);
      allTypes.push(...parsed.types);
      allEnums.push(...parsed.enums);
      allTypeAliases.push(...parsed.typeAliases);
    }

    const { classes, interfaces, typeAliases, enums, exports } = buildSurface(allTypes, allEnums, allTypeAliases);

    return {
      language: 'ios',
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
