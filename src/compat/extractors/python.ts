/**
 * Python API surface extractor.
 *
 * Walks `.py` files under `src/` (fallback to top-level package dirs),
 * parses classes, type aliases, and module exports, then builds an
 * `ApiSurface` with Protocol-based services, Pydantic model interfaces,
 * Literal type enums, and exception classes.
 *
 * Parser:  `python-parser.ts`  — tree-sitter-based Python source analysis
 * Surface: `python-surface.ts` — ApiSurface construction
 */

import { ExtractorError } from '../../errors.js';
import type { Extractor, ApiSurface, LanguageHints } from '../types.js';
import { walkPythonFiles, findPythonSourceRoot, parsePythonFile } from './python-parser.js';
import { buildSurface } from './python-surface.js';
import type { ParsedPythonFile } from './python-parser.js';

// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const pythonHints: LanguageHints = {
  stripNullable(type: string): string | null {
    // Optional[T] → T
    const optMatch = type.match(/^Optional\[(.+)\]$/);
    if (optMatch) return optMatch[1];
    // T | None → T, None | T → T
    const parts = type
      .split('|')
      .map((p) => p.trim())
      .filter((p) => p !== 'None');
    if (parts.length < type.split('|').length) return parts.join(' | ');
    return null;
  },

  isNullableOnlyDifference(a: string, b: string): boolean {
    const strippedA = this.stripNullable(a) ?? a;
    const strippedB = this.stripNullable(b) ?? b;
    return strippedA === strippedB && a !== b;
  },

  isUnionReorder(a: string, b: string): boolean {
    const parseUnion = (t: string) => {
      const unionMatch = t.match(/^Union\[(.+)\]$/);
      if (unionMatch)
        return unionMatch[1]
          .split(',')
          .map((s) => s.trim())
          .sort();
      return t
        .split('|')
        .map((s) => s.trim())
        .sort();
    };
    return a !== b && parseUnion(a).join(',') === parseUnion(b).join(',');
  },

  isGenericTypeParam(type: string): boolean {
    return /^[A-Z]$/.test(type) || /^T[A-Z][a-zA-Z]*$/.test(type);
  },

  isExtractionArtifact(type: string): boolean {
    return type === 'Any' || type === 'object';
  },

  tolerateCategoryMismatch: true,

  extractReturnTypeName(returnType: string): string | null {
    let inner = returnType;
    const syncOrAsyncMatch = inner.match(/^SyncOrAsync\[(.+)\]$/);
    if (syncOrAsyncMatch) inner = syncOrAsyncMatch[1];
    const awaitableMatch = inner.match(/^Awaitable\[(.+)\]$/);
    if (awaitableMatch) inner = awaitableMatch[1];
    const optMatch = inner.match(/^Optional\[(.+)\]$/);
    if (optMatch) inner = optMatch[1];
    // Unwrap list resource patterns (e.g., SomeListResource[T, ...] → T)
    for (const pattern of this.listResourcePatterns ?? []) {
      const prefix = pattern + '[';
      if (inner.startsWith(prefix)) {
        // Extract first type arg: everything up to the first comma or closing bracket
        const rest = inner.slice(prefix.length);
        const end = rest.search(/[,\]]/);
        if (end > 0) {
          inner = rest.slice(0, end).trim();
          break;
        }
      }
    }
    // Sequence[T] → T
    const seqMatch = inner.match(/^Sequence\[(.+)\]$/);
    if (seqMatch) inner = seqMatch[1];
    if (['str', 'int', 'float', 'bool', 'None', 'bytes', 'dict', 'list'].includes(inner)) return null;
    return inner;
  },

  extractParamTypeName(paramType: string): string | null {
    let inner = paramType;
    const optMatch = inner.match(/^Optional\[(.+)\]$/);
    if (optMatch) inner = optMatch[1];
    if (['str', 'int', 'float', 'bool', 'None', 'bytes', 'dict', 'list'].includes(inner)) return null;
    return inner;
  },

  propertyMatchesClass(propertyName: string, className: string): boolean {
    return propertyName.replace(/_/g, '').toLowerCase() === className.toLowerCase();
  },

  derivedModelNames(modelName: string): string[] {
    return [`${modelName}Response`];
  },

  modelBaseClasses: ['BaseModel'],
  exceptionBaseClasses: ['Exception', 'BaseException'],
  listResourcePatterns: [],
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

/** Create a Python extractor with optional hint overrides. */
export function createPythonExtractor(hintOverrides?: Partial<LanguageHints>): Extractor {
  const mergedHints: LanguageHints = hintOverrides ? { ...pythonHints, ...hintOverrides } : pythonHints;

  return {
    language: 'python',
    hints: mergedHints,

    async extract(sdkPath: string): Promise<ApiSurface> {
      const sourceRoot = findPythonSourceRoot(sdkPath);
      if (!sourceRoot) {
        throw new ExtractorError(
          `No Python package found in ${sdkPath}`,
          `Ensure the --sdk-path argument points to a Python project root containing a package directory with __init__.py.`,
        );
      }

      const pyFiles = walkPythonFiles(sourceRoot);
      if (pyFiles.length === 0) {
        throw new ExtractorError(
          `No .py files found in ${sdkPath}`,
          `Ensure the project contains Python source files.`,
        );
      }

      const parsedFiles: ParsedPythonFile[] = [];
      for (const filePath of pyFiles) {
        const parsed = parsePythonFile(filePath, sdkPath);
        parsedFiles.push(parsed);
      }

      const { classes, interfaces, typeAliases, enums, exports } = buildSurface(parsedFiles, mergedHints);

      return {
        language: 'python',
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
}

/** Default Python extractor with generic language hints (no SDK-specific bases). */
export const pythonExtractor: Extractor = createPythonExtractor();
