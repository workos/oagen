/**
 * Ruby API surface extractor.
 *
 * Walks `.rb` files under `lib/`, parses class/module declarations,
 * and builds an `ApiSurface` with classes, service modules, and enum modules.
 *
 * Parser: `ruby-parser.ts` — tree-sitter-based class/module/enum extraction
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { ExtractorError } from '../../errors.js';
import type { ApiSurface, Extractor, LanguageHints } from '../types.js';
import { defaultIsNullableOnlyDifference } from '../language-hints.js';
import {
  extractClasses,
  extractServiceModules,
  extractEnumModules,
  extractAutoloads,
  sortRecord,
} from './ruby-parser.js';

// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const rubyHints: LanguageHints = {
  stripNullable(type: string): string | null {
    const match = type.match(/^T\.nilable\((.+)\)$/);
    return match ? match[1] : null;
  },
  isNullableOnlyDifference(a: string, b: string): boolean {
    return defaultIsNullableOnlyDifference(this, a, b);
  },
  isUnionReorder(_a: string, _b: string): boolean {
    return false;
  },
  isGenericTypeParam(type: string): boolean {
    return type === 'T.untyped';
  },
  isExtractionArtifact(type: string): boolean {
    return type === 'T.untyped' || type === 'BasicObject';
  },
  tolerateCategoryMismatch: false,
  extractReturnTypeName(returnType: string): string | null {
    return returnType || null;
  },
  extractParamTypeName(paramType: string): string | null {
    if (['String', 'Integer', 'Float', 'Boolean', 'NilClass'].includes(paramType)) return null;
    return paramType;
  },
  propertyMatchesClass(propertyName: string, className: string): boolean {
    return propertyName.replace(/_/g, '').toLowerCase() === className.toLowerCase();
  },
  derivedModelNames(_modelName: string): string[] {
    return [];
  },
};

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/** Recursively collect all .rb files under a directory. */
function collectRbFiles(dir: string): string[] {
  const result: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      result.push(...collectRbFiles(full));
    } else if (entry.endsWith('.rb')) {
      result.push(full);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const rubyExtractor: Extractor = {
  language: 'ruby',
  hints: rubyHints,

  async extract(sdkPath: string): Promise<ApiSurface> {
    const libPath = resolve(sdkPath, 'lib');
    try {
      statSync(libPath);
    } catch {
      throw new ExtractorError(
        `No lib/ directory found in ${sdkPath}`,
        `Verify the --sdk-path argument points to a Ruby project root containing a lib/ directory.`,
      );
    }

    const rbFiles = collectRbFiles(libPath);
    if (rbFiles.length === 0) {
      throw new ExtractorError(
        `No .rb files found in ${libPath}`,
        `Ensure the lib/ directory contains Ruby source files.`,
      );
    }

    const classes: Record<string, import('../types.js').ApiClass> = {};
    const enums: Record<string, import('../types.js').ApiEnum> = {};
    const exports: Record<string, string[]> = {};

    for (const absPath of rbFiles) {
      const relPath = relative(sdkPath, absPath);
      const source = readFileSync(absPath, 'utf-8');

      const fileExports: string[] = [];

      // Extract classes (model classes and struct classes)
      const extractedClasses = extractClasses(source);
      for (const cls of extractedClasses) {
        classes[cls.name] = { ...cls, sourceFile: relPath };
        fileExports.push(cls.name);
      }

      // Extract service modules (modules with class << self)
      const extractedServices = extractServiceModules(source);
      for (const svc of extractedServices) {
        classes[svc.name] = { ...svc, sourceFile: relPath };
        fileExports.push(svc.name);
      }

      // Extract enum-like modules (modules with constants)
      const extractedEnums = extractEnumModules(source);
      for (const en of extractedEnums) {
        enums[en.name] = { ...en, sourceFile: relPath };
        fileExports.push(en.name);
      }

      // Extract autoload declarations as exports
      const autoloadNames = extractAutoloads(source);
      if (autoloadNames.length > 0) {
        fileExports.push(...autoloadNames);
      }

      if (fileExports.length > 0) {
        exports[relPath] = [...new Set(fileExports)].sort();
      }
    }

    return {
      language: 'ruby',
      extractedFrom: sdkPath,
      extractedAt: new Date().toISOString(),
      classes: sortRecord(classes),
      interfaces: {},
      typeAliases: {},
      enums: sortRecord(enums),
      exports: sortRecord(exports),
    };
  },
};
