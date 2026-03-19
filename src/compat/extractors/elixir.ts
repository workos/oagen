/**
 * Elixir API surface extractor.
 *
 * Walks `.ex` files under `lib/` (the standard Elixir source directory),
 * parses modules, structs, functions, and type specs, then builds an
 * `ApiSurface`.
 *
 * Parser:  `elixir-parser.ts`  — regex-based Elixir source analysis
 * Surface: `elixir-surface.ts` — ApiSurface construction
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExtractorError } from '../../errors.js';
import type { Extractor, ApiSurface, LanguageHints } from '../types.js';
import { walkElixirFiles, parseElixirFile } from './elixir-parser.js';
import { buildSurface } from './elixir-surface.js';
import type { ElixirStruct, ElixirFunction, ElixirEnumModule, ElixirTypeSpec } from './elixir-parser.js';

// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const elixirHints: LanguageHints = {
  stripNullable(type: string): string | null {
    // T | nil → T
    if (type.includes('| nil')) return type.replace(/\s*\|\s*nil/g, '').trim();
    if (type.includes('nil |')) return type.replace(/nil\s*\|\s*/g, '').trim();
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
  isGenericTypeParam(type: string): boolean {
    // Elixir doesn't have generic type params in the same sense
    return type === 'any' || type === 'term';
  },
  isExtractionArtifact(type: string): boolean {
    return type === 'any' || type === 'term' || type === 'any()';
  },
  tolerateCategoryMismatch: true,
  extractReturnTypeName(returnType: string): string | null {
    let inner = returnType;
    // Unwrap {:ok, T} → T
    const okMatch = inner.match(/^\{:ok,\s*(.+)\}$/);
    if (okMatch) inner = okMatch[1].trim();
    // Unwrap [T] → T
    const listMatch = inner.match(/^\[(.+)\]$/);
    if (listMatch) inner = listMatch[1].trim();
    // Primitives
    if (['any', 'term', 'atom', 'binary', 'boolean', 'integer', 'float', 'number', 'pid'].includes(inner)) {
      return null;
    }
    // String.t() → String
    const typeCallMatch = inner.match(/^(\w+)\.t\(\)$/);
    if (typeCallMatch) return typeCallMatch[1];
    return inner || null;
  },
  extractParamTypeName(paramType: string): string | null {
    if (
      ['any', 'term', 'atom', 'binary', 'boolean', 'integer', 'float', 'number', 'pid', 'keyword'].includes(paramType)
    ) {
      return null;
    }
    const typeCallMatch = paramType.match(/^(\w+)\.t\(\)$/);
    if (typeCallMatch) return typeCallMatch[1];
    return paramType;
  },
  propertyMatchesClass(propertyName: string, className: string): boolean {
    // snake_case → PascalCase comparison
    return propertyName.replace(/_/g, '').toLowerCase() === className.toLowerCase();
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

export const elixirExtractor: Extractor = {
  language: 'elixir',
  hints: elixirHints,

  async extract(sdkPath: string): Promise<ApiSurface> {
    // Determine the source directory: prefer lib/, fallback to root
    let sourceDir: string;
    const libPath = resolve(sdkPath, 'lib');

    try {
      statSync(libPath);
      sourceDir = libPath;
    } catch {
      sourceDir = sdkPath;
    }

    const exFiles = walkElixirFiles(sourceDir);
    if (exFiles.length === 0) {
      throw new ExtractorError(
        `No .ex files found in ${sdkPath}`,
        `Ensure the --sdk-path argument points to an Elixir project root containing .ex source files in lib/.`,
      );
    }

    const allStructs: ElixirStruct[] = [];
    const allFunctions: ElixirFunction[] = [];
    const allEnumModules: ElixirEnumModule[] = [];
    const allTypeSpecs: ElixirTypeSpec[] = [];

    for (const filePath of exFiles) {
      const parsed = parseElixirFile(filePath, sdkPath);
      allStructs.push(...parsed.structs);
      allFunctions.push(...parsed.functions);
      allEnumModules.push(...parsed.enumModules);
      allTypeSpecs.push(...parsed.typeSpecs);
    }

    const { classes, interfaces, enums, exports } = buildSurface(
      allStructs,
      allFunctions,
      allEnumModules,
      allTypeSpecs,
    );

    return {
      language: 'elixir',
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
