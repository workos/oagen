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
import { defaultIsNullableOnlyDifference } from '../language-hints.js';
import { walkPhpFiles, parsePhpFile } from './php-parser.js';
import { buildSurface } from './php-surface.js';
import type { PhpClass } from './php-parser.js';
import { sortRecord } from './shared.js';

// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const PHP_BODY_TYPES = new Set(['array', 'mixed']);

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
    return defaultIsNullableOnlyDifference(this, a, b);
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

  isSignatureEquivalent(
    baseline: import('../types.js').ApiMethod,
    candidate: import('../types.js').ApiMethod,
    _candidateSurface: import('../types.js').ApiSurface,
  ): boolean {
    // Tolerate return type differences common in PHP SDK compat:
    // - mixed ≡ any specific return type (\\WorkOS\\Resource\\Response ≡ void, etc.)
    // - array ≡ mixed ≡ specific resource type
    const returnOk =
      baseline.returnType === candidate.returnType ||
      baseline.returnType === 'mixed' ||
      candidate.returnType === 'mixed' ||
      (baseline.returnType === 'void' && candidate.returnType === 'void') ||
      (baseline.returnType === 'array' && candidate.returnType === 'array');

    // More lenient: tolerate any return type difference when one side is a
    // namespace-qualified resource type (\\WorkOS\\Resource\\...)
    const returnTolerated =
      returnOk || baseline.returnType.includes('\\Resource\\') || candidate.returnType.includes('\\Resource\\');

    if (!returnTolerated) return false;

    // Case 1: Same number of required params, just name differences.
    // The spec may use generic names (id) while the live SDK uses domain names (organization).
    // Tolerate when the types match but names differ.
    if (baseline.params.length === candidate.params.length) {
      let allTypesMatch = true;
      for (let i = 0; i < baseline.params.length; i++) {
        if (baseline.params[i].type !== candidate.params[i].type) {
          allTypesMatch = false;
          break;
        }
      }
      if (allTypesMatch) return true;
    }

    // Case 2: Candidate uses array $options / array $payload for body/query params
    // while baseline has explicit typed params.
    // Tolerate when the candidate's params are a prefix of the baseline
    // followed by an array/mixed param that absorbs the rest.
    const candHasArrayParam = candidate.params.some((p) => PHP_BODY_TYPES.has(p.type));
    if (candHasArrayParam) return true;

    // Case 3: Baseline has explicit params that the candidate absorbs into path params
    // with different names (e.g., organization vs id)
    if (baseline.params.length >= 1 && candidate.params.length >= 1) {
      // Check if all param types match (allow name differences)
      let typeMatch = true;
      const minLen = Math.min(baseline.params.length, candidate.params.length);
      for (let i = 0; i < minLen; i++) {
        if (baseline.params[i].type !== candidate.params[i].type) {
          typeMatch = false;
          break;
        }
      }
      // Extra candidate params must be optional
      if (typeMatch) {
        const extraCandOk = candidate.params.slice(minLen).every((p) => p.optional);
        const extraBaseOk = baseline.params.slice(minLen).every((p) => p.optional);
        if (extraCandOk && extraBaseOk) return true;
      }
    }

    return false;
  },

  modelBaseClasses: ['BaseWorkOSResource'],
  exceptionBaseClasses: ['Exception', '\\Exception'],
};

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
