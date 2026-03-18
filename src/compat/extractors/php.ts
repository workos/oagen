/**
 * PHP API surface extractor.
 *
 * Walks `.php` files under `lib/` (or `src/`), parses classes, interfaces,
 * methods, properties, and constants, then builds an `ApiSurface`.
 *
 * Parser:  `php-parser.ts`  — tree-sitter-based PHP source analysis
 * Surface: `php-surface.ts` — ApiSurface construction
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExtractorError } from '../../errors.js';
import type { Extractor, ApiSurface, LanguageHints } from '../types.js';
import { walkPhpFiles, parsePhpFile } from './php-parser.js';
import { buildSurface } from './php-surface.js';
import type { PhpClass } from './php-parser.js';

// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const phpHints: LanguageHints = {
  stripNullable(type: string): string | null {
    // ?string → string
    if (type.startsWith('?')) return type.slice(1);
    // null|string → string, string|null → string
    const parts = type.split('|').filter((p) => p.trim().toLowerCase() !== 'null');
    if (parts.length < type.split('|').length) return parts.join('|');
    return null;
  },
  isNullableOnlyDifference(a: string, b: string): boolean {
    const strippedA = this.stripNullable(a) ?? a;
    const strippedB = this.stripNullable(b) ?? b;
    return strippedA === strippedB && a !== b;
  },
  isUnionReorder(a: string, b: string): boolean {
    // Parse pipe-separated types, sort, compare
    const sortParts = (t: string) =>
      t
        .split('|')
        .map((s) => s.trim())
        .sort()
        .join('|');
    return a !== b && sortParts(a) === sortParts(b);
  },
  isGenericTypeParam(_type: string): boolean {
    return false; // PHP has no generics
  },
  isExtractionArtifact(type: string): boolean {
    return type === 'mixed' || type === 'Object';
  },
  tolerateCategoryMismatch: false,
  extractReturnTypeName(returnType: string): string | null {
    // Strip nullable: ?Foo → Foo, null|Foo → Foo
    const stripped = this.stripNullable(returnType) ?? returnType;
    if (['string', 'int', 'float', 'bool', 'void', 'array', 'mixed'].includes(stripped)) return null;
    return stripped.replace(/^\\/, '');
  },
  extractParamTypeName(paramType: string): string | null {
    const stripped = this.stripNullable(paramType) ?? paramType;
    if (['string', 'int', 'float', 'bool', 'void', 'array', 'mixed', 'null', 'callable'].includes(stripped)) {
      return null;
    }
    return stripped.replace(/^\\/, '');
  },
  propertyMatchesClass(propertyName: string, className: string): boolean {
    // camelCase → PascalCase comparison
    return propertyName.toLowerCase() === className.toLowerCase();
  },
  derivedModelNames(_modelName: string): string[] {
    return [];
  },

  modelBaseClasses: [],
  exceptionBaseClasses: ['Exception', '\\Exception'],
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

/** Create a PHP extractor with optional hint overrides. */
export function createPhpExtractor(hintOverrides?: Partial<LanguageHints>): Extractor {
  const mergedHints: LanguageHints = hintOverrides ? { ...phpHints, ...hintOverrides } : phpHints;

  return {
    language: 'php',
    hints: mergedHints,

    async extract(sdkPath: string): Promise<ApiSurface> {
      // Determine the source directory: prefer lib/, fallback to src/
      let sourceDir: string;
      const libPath = resolve(sdkPath, 'lib');
      const srcPath = resolve(sdkPath, 'src');

      try {
        statSync(libPath);
        sourceDir = libPath;
      } catch {
        try {
          statSync(srcPath);
          sourceDir = srcPath;
        } catch {
          throw new ExtractorError(
            `No lib/ or src/ directory found in ${sdkPath}`,
            `Ensure the --sdk-path argument points to a PHP project root containing a lib/ or src/ directory.`,
          );
        }
      }

      const phpFiles = walkPhpFiles(sourceDir);
      if (phpFiles.length === 0) {
        throw new ExtractorError(
          `No .php files found in ${sourceDir}`,
          `Ensure the source directory contains PHP source files.`,
        );
      }

      const allClasses: PhpClass[] = [];

      for (const filePath of phpFiles) {
        const parsed = parsePhpFile(filePath, sdkPath);
        allClasses.push(...parsed.classes);
      }

      const { classes, interfaces, enums, exports } = buildSurface(allClasses, mergedHints);

      return {
        language: 'php',
        extractedFrom: sdkPath,
        extractedAt: new Date().toISOString(),
        classes: sortRecord(classes),
        interfaces: sortRecord(interfaces),
        typeAliases: {},
        enums: sortRecord(enums),
        exports: sortRecord(exports),
      };
    },
  };
}

/** Default PHP extractor with generic language hints (no SDK-specific bases). */
export const phpExtractor: Extractor = createPhpExtractor();
