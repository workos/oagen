/**
 * Rust API surface extractor.
 *
 * Walks `.rs` files under `src/`, parses pub structs, enums, impl blocks,
 * traits, and type aliases, then builds an ApiSurface.
 *
 * Parser:  `rust-parser.ts`  — tree-sitter-based Rust source analysis
 * Surface: `rust-surface.ts` — ApiSurface construction
 */

import { ExtractorError } from '../../errors.js';
import type { Extractor, ApiSurface, LanguageHints } from '../types.js';
import { walkRustFiles, parseRustFile } from './rust-parser.js';
import { buildSurface } from './rust-surface.js';
import type { RustStruct, RustEnum, RustFunc, RustTrait, RustTypeAlias } from './rust-parser.js';


// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const rustHints: LanguageHints = {
  stripNullable(type: string): string | null {
    const match = type.match(/^Option<(.+)>$/);
    return match ? match[1] : null;
  },
  isNullableOnlyDifference(a: string, b: string): boolean {
    const strippedA = this.stripNullable(a) ?? a;
    const strippedB = this.stripNullable(b) ?? b;
    return strippedA === strippedB && a !== b;
  },
  isUnionReorder(_a: string, _b: string): boolean {
    return false; // Rust doesn't have union types in the TS sense
  },
  isGenericTypeParam(type: string): boolean {
    // Single uppercase letter or T-prefixed: T, U, V, TResult
    return /^[A-Z]$/.test(type) || /^T[A-Z][a-zA-Z]*$/.test(type);
  },
  isExtractionArtifact(type: string): boolean {
    return type === 'serde_json::Value' || type === 'Box<dyn std::error::Error>';
  },
  tolerateCategoryMismatch: false,
  extractReturnTypeName(returnType: string): string | null {
    // Unwrap Result<T, E> → T, Vec<T> → T, Option<T> → T
    let inner = returnType;
    const resultMatch = inner.match(/^Result\s*<\s*(.+)\s*,\s*.+\s*>$/);
    if (resultMatch) inner = resultMatch[1].trim();
    const vecMatch = inner.match(/^Vec\s*<\s*(.+)\s*>$/);
    if (vecMatch) inner = vecMatch[1].trim();
    const optMatch = inner.match(/^Option\s*<\s*(.+)\s*>$/);
    if (optMatch) inner = optMatch[1].trim();
    // Strip references
    inner = inner.replace(/^&(?:mut\s+)?(?:'[a-z]+\s+)?/, '');
    if (['()', 'String', 'str', 'bool', 'i32', 'i64', 'u32', 'u64', 'f32', 'f64', 'usize'].includes(inner)) {
      return null;
    }
    return inner;
  },
  extractParamTypeName(paramType: string): string | null {
    let inner = paramType.replace(/^&(?:mut\s+)?(?:'[a-z]+\s+)?/, '');
    if (['String', '&str', 'str', 'bool', 'i32', 'i64', 'u32', 'u64', 'f32', 'f64', 'usize'].includes(inner)) {
      return null;
    }
    return inner;
  },
  propertyMatchesClass(propertyName: string, className: string): boolean {
    // snake_case property vs PascalCase class
    const normalized = propertyName.replace(/_/g, '').toLowerCase();
    return normalized === className.toLowerCase();
  },
  derivedModelNames(modelName: string): string[] {
    return [`${modelName}Response`];
  },
};

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const rustExtractor: Extractor = {
  language: 'rust',
  hints: rustHints,

  async extract(sdkPath: string): Promise<ApiSurface> {
    const rsFiles = walkRustFiles(sdkPath);
    if (rsFiles.length === 0) {
      throw new ExtractorError(
        `No .rs files found in ${sdkPath}`,
        `Ensure the --sdk-path argument points to a Rust project root containing .rs source files.`,
      );
    }

    const allStructs: RustStruct[] = [];
    const allEnums: RustEnum[] = [];
    const allFuncs: RustFunc[] = [];
    const allTraits: RustTrait[] = [];
    const allTypeAliases: RustTypeAlias[] = [];

    for (const filePath of rsFiles) {
      const parsed = parseRustFile(filePath, sdkPath);
      allStructs.push(...parsed.structs);
      allEnums.push(...parsed.enums);
      allFuncs.push(...parsed.funcs);
      allTraits.push(...parsed.traits);
      allTypeAliases.push(...parsed.typeAliases);
    }

    const { classes, interfaces, typeAliases, enums, exports } = buildSurface(
      allStructs,
      allEnums,
      allFuncs,
      allTraits,
      allTypeAliases,
    );

    return {
      language: 'rust',
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
