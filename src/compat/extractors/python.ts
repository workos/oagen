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
import type { CompatSnapshot } from '../ir.js';
import { apiSurfaceToSnapshot } from '../ir.js';
import {
  NAMED_TYPE_RE,
  typeExistsInSurface,
  namedTypeWordsOverlap,
  defaultIsNullableOnlyDifference,
} from '../language-hints.js';
import { walkPythonFiles, findPythonSourceRoot, parsePythonFile } from './python-parser.js';
import { buildSurface } from './python-surface.js';
import type { ParsedPythonFile } from './python-parser.js';

// ---------------------------------------------------------------------------
// Language hints
// ---------------------------------------------------------------------------

const PYTHON_PRIMITIVE_TYPES = new Set(['str', 'int', 'float', 'bool', 'bytes']);

const pythonHints: LanguageHints = {
  stripNullable(type: string): string | null {
    // Normalize whitespace before matching
    const normalized = type.replace(/\s+/g, ' ').trim();
    // Optional[T] → T
    const optMatch = normalized.match(/^Optional\[(.+)\]$/);
    if (optMatch) return optMatch[1].trim();
    // NotRequired[T] → T (TypedDict optionality ≡ nullable for compat purposes)
    const nrMatch = normalized.match(/^NotRequired\[(.+)\]$/);
    if (nrMatch) return nrMatch[1].trim();
    // T | None → T, None | T → T
    const parts = normalized
      .split('|')
      .map((p) => p.trim())
      .filter((p) => p !== 'None');
    if (parts.length < normalized.split('|').length) return parts.join(' | ');
    return null;
  },

  isNullableOnlyDifference(a: string, b: string): boolean {
    return defaultIsNullableOnlyDifference(this, a, b);
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

  isTypeEquivalent(baselineType: string, candidateType: string, candidateSurface: ApiSurface): boolean {
    // Strip nullable wrappers from both sides
    const stripNullable = (t: string): string => {
      const normalized = t.replace(/\s+/g, ' ').trim();
      const optMatch = normalized.match(/^Optional\[(.+)\]$/);
      if (optMatch) return optMatch[1].trim();
      const nrMatch = normalized.match(/^NotRequired\[(.+)\]$/);
      if (nrMatch) return nrMatch[1].trim();
      const parts = normalized
        .split('|')
        .map((p) => p.trim())
        .filter((p) => p !== 'None');
      if (parts.length < normalized.split('|').length) return parts.join(' | ');
      return normalized;
    };
    const baseClean = stripNullable(baselineType);
    const candClean = stripNullable(candidateType);

    // Literal quote style equivalence: Literal["foo"] ≡ Literal['foo']
    const literalMatch = (t: string) => t.match(/^Literal\[(['"])(.+)\1\]$/);
    const baseLit = literalMatch(baseClean);
    const candLit = literalMatch(candClean);
    if (baseLit && candLit && baseLit[2] === candLit[2]) return true;

    // LiteralOrUntyped[T] ≡ T (custom wrapper type) — strip recursively
    const stripWrappers = (t: string): string => {
      let inner = t;
      // Strip LiteralOrUntyped[...]
      const louMatch = inner.match(/^LiteralOrUntyped\[(.+)\]$/);
      if (louMatch) inner = louMatch[1];
      // Strip Literal[...] to get the enum name if it's a Literal of literals
      return inner;
    };
    const baseUnwrapped = stripWrappers(baseClean);
    const candUnwrapped = stripWrappers(candClean);
    if (baseUnwrapped !== baseClean || candUnwrapped !== candClean) {
      // After unwrapping, check equivalence
      if (baseUnwrapped === candClean || candUnwrapped === baseClean) return true;
      if (baseUnwrapped === candUnwrapped) return true;
      // LiteralOrUntyped[Literal["a", "b"]] ≡ enum type
      if (baseUnwrapped.startsWith('Literal[') && candidateSurface.enums[candClean]) return true;
      if (candUnwrapped.startsWith('Literal[') && candidateSurface.enums?.[baseClean]) return true;
    }

    // Sequence[T] ≡ list[T] ≡ List[T]
    const seqPattern = /^(?:Sequence|list|List)\[(.+)\]$/;
    const baseSeq = baseClean.match(seqPattern);
    const candSeq = candClean.match(seqPattern);
    if (baseSeq && candSeq) {
      if (baseSeq[1] === candSeq[1]) return true;
      // Inner types may differ by named type (InlineRole vs DirectoryUserRole)
      const baseInner = baseSeq[1];
      const candInner = candSeq[1];
      if (NAMED_TYPE_RE.test(baseInner) && NAMED_TYPE_RE.test(candInner)) {
        if (typeExistsInSurface(candInner, candidateSurface)) {
          if (candInner.includes(baseInner) || baseInner.includes(candInner)) return true;
          if (namedTypeWordsOverlap(baseInner, candInner)) return true;
        }
      }
      // Tolerate model collection vs primitive collection: Sequence[OrganizationDomain] ≡ list[str]
      // The spec may define a field as a primitive array while the live SDK wraps it in a model.
      const primitiveTypes = PYTHON_PRIMITIVE_TYPES;
      if (
        (primitiveTypes.has(baseInner) && NAMED_TYPE_RE.test(candInner)) ||
        (primitiveTypes.has(candInner) && NAMED_TYPE_RE.test(baseInner))
      ) {
        return true;
      }
    }
    // Cross-container tolerance: Sequence[T] vs list[str] (different container names)
    if (baseSeq && !candSeq) {
      const candListMatch = candClean.match(/^(?:list|List)\[(.+)\]$/);
      if (candListMatch) {
        const baseInner = baseSeq[1];
        const candInner = candListMatch[1];
        if (baseInner === candInner) return true;
        const primitiveTypes = PYTHON_PRIMITIVE_TYPES;
        if (
          (primitiveTypes.has(baseInner) && NAMED_TYPE_RE.test(candInner)) ||
          (primitiveTypes.has(candInner) && NAMED_TYPE_RE.test(baseInner))
        ) {
          return true;
        }
      }
    }

    // Mapping[K, V] ≡ dict[K, V] (Mapping is the ABC for dict)
    const mappingPattern = /^(?:Mapping|dict|Dict)\[(.+)\]$/;
    const baseMapping = baseClean.match(mappingPattern);
    const candMapping = candClean.match(mappingPattern);
    if (baseMapping && candMapping) {
      // Both are map-like — compare key/value types loosely
      return true;
    }

    // dict map equivalence: dict[str, str] ≡ dict[str, Any] ≡ Dict[str, Any] ≡ dict[str, str | float | bool]
    const dictLikePattern = /^(?:dict|Dict|Mapping)\[str,\s*.+\]$/;
    if (dictLikePattern.test(baseClean) && dictLikePattern.test(candClean)) return true;

    // Named metadata type ≡ dict[str, ...] (custom type alias for dict)
    const isMapType = (t: string) => dictLikePattern.test(t) || /^(?:Metadata|AuditLog\w*Metadata)$/.test(t);
    if (isMapType(baseClean) && isMapType(candClean)) return true;

    // Named type alias for a map/dict type ≡ inline dict expression
    // e.g., AuditLogMetadata ≡ dict[str, str | float | bool]
    if (NAMED_TYPE_RE.test(baseClean) && dictLikePattern.test(candClean)) {
      // Assume named types ending in "Metadata" or "Attributes" are dict aliases
      if (/(?:Metadata|Attributes)$/.test(baseClean)) return true;
    }
    if (NAMED_TYPE_RE.test(candClean) && dictLikePattern.test(baseClean)) {
      if (/(?:Metadata|Attributes)$/.test(candClean)) return true;
    }

    // str ≡ Literal["..."] (literal string type vs plain str)
    if (baseClean === 'str' && candClean.startsWith('Literal[')) return true;
    if (candClean === 'str' && baseClean.startsWith('Literal[')) return true;

    // Literal[...] ≡ enum name (candidate has an enum, baseline has Literal)
    if (baseClean.startsWith('Literal[') && candidateSurface.enums[candClean]) return true;
    if (candClean.startsWith('Literal[') && candidateSurface.enums?.[baseClean]) return true;

    // str ≡ enum type (baseline says str, candidate uses enum)
    if (baseClean === 'str' && candidateSurface.enums[candClean]) return true;
    if (candClean === 'str' && candidateSurface.enums?.[baseClean]) return true;

    // int ≡ float (JSON number coercion)
    const numericTypes = new Set(['int', 'float']);
    if (numericTypes.has(baseClean) && numericTypes.has(candClean)) return true;

    // Named type tolerance
    if (NAMED_TYPE_RE.test(baseClean) && NAMED_TYPE_RE.test(candClean)) {
      if (typeExistsInSurface(candClean, candidateSurface)) {
        if (candClean.includes(baseClean) || baseClean.includes(candClean)) return true;
        const baseNoResp = baseClean.replace(/Response$/, '');
        const candNoResp = candClean.replace(/Response$/, '');
        if (candNoResp.includes(baseNoResp) || baseNoResp.includes(candNoResp)) return true;
        if (namedTypeWordsOverlap(baseClean, candClean)) return true;
      }
    }

    return false;
  },

  isSignatureEquivalent(
    baseline: import('../types.js').ApiMethod,
    candidate: import('../types.js').ApiMethod,
    _candidateSurface: ApiSurface,
  ): boolean {
    // Tolerate methods where the candidate uses a body dict (payload: dict[str, Any])
    // while the baseline unpacks the body into individual typed params.
    // The first N params that match by name and type are consumed, then the remaining
    // baseline params are tolerated if the candidate has a dict payload param.

    // Return types must be equivalent (use named type tolerance)
    if (baseline.returnType !== candidate.returnType) {
      const baseRet = baseline.returnType;
      const candRet = candidate.returnType;
      if (!(NAMED_TYPE_RE.test(baseRet) && NAMED_TYPE_RE.test(candRet))) return false;
      // Check named-type containment or word overlap
      if (!candRet.includes(baseRet) && !baseRet.includes(candRet)) {
        if (!namedTypeWordsOverlap(baseRet, candRet)) return false;
      }
    }

    // Check if candidate has a body dict param
    const bodyDictTypes = new Set(['dict[str, Any]', 'Dict[str, Any]', 'dict']);
    const candBodyIdx = candidate.params.findIndex(
      (p) => bodyDictTypes.has(p.type) && (p.name === 'payload' || p.name === 'body' || p.name === 'data'),
    );
    if (candBodyIdx < 0) return false;

    // All candidate params before the body dict must match baseline params by name and type
    for (let i = 0; i < candBodyIdx; i++) {
      if (i >= baseline.params.length) return false;
      if (baseline.params[i].name !== candidate.params[i].name) return false;
      if (baseline.params[i].type !== candidate.params[i].type) return false;
    }

    // Remaining baseline params after the matched prefix are tolerated as body fields
    return true;
  },

  // Consumers should configure modelBaseClasses for their framework (e.g., ['BaseModel'] for Pydantic)
  modelBaseClasses: [],
  exceptionBaseClasses: ['Exception', 'BaseException'],
  listResourcePatterns: [],
};

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

/** Create a Python extractor with optional hint overrides. */
export function createPythonExtractor(hintOverrides?: Partial<LanguageHints>): Extractor {
  const mergedHints: LanguageHints = hintOverrides ? { ...pythonHints, ...hintOverrides } : pythonHints;

  return {
    language: 'python',
    hints: mergedHints,

    async extractSnapshot(sdkPath: string): Promise<CompatSnapshot> {
      const surface = await this.extract(sdkPath);
      return apiSurfaceToSnapshot(surface);
    },

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
        classes,
        interfaces,
        typeAliases,
        enums,
        exports,
      };
    },
  };
}

/** Default Python extractor with generic language hints (no SDK-specific bases). */
export const pythonExtractor: Extractor = createPythonExtractor();
