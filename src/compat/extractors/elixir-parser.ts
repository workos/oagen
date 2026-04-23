/**
 * Elixir source parser — regex-based extraction of modules, structs,
 * functions, and type specs from Elixir source files.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface ElixirStruct {
  moduleName: string;
  fields: string[];
  sourceFile: string;
}

export interface ElixirFunction {
  moduleName: string;
  name: string;
  arity: number;
  params: string[];
  /** Per-param passing style: 'positional' or 'keyword' (for keyword list params). */
  paramStyles: ('positional' | 'keyword')[];
  isPrivate: boolean;
  sourceFile: string;
}

export interface ElixirTypeSpec {
  moduleName: string;
  name: string;
  definition: string;
  sourceFile: string;
}

export interface ElixirEnumModule {
  moduleName: string;
  members: Record<string, string>;
  sourceFile: string;
}

export interface ParsedElixirFile {
  structs: ElixirStruct[];
  functions: ElixirFunction[];
  typeSpecs: ElixirTypeSpec[];
  enumModules: ElixirEnumModule[];
  moduleNames: string[];
}

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

export function walkElixirFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry.startsWith('.') || entry === '_build' || entry === 'deps' || entry === 'test') continue;
      results.push(...walkElixirFiles(fullPath));
    } else if (entry.endsWith('.ex') && !entry.endsWith('_test.exs')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip comments and heredoc strings from Elixir source code.
 * This prevents false matches of keywords like `do`/`end` inside strings
 * and doc comments.
 */
function stripCommentsAndHeredocs(source: string): string {
  // Replace triple-quoted heredocs (@moduledoc """, @doc """, etc.)
  let result = source.replace(/"""[\s\S]*?"""/g, '""""""');
  // Remove single-line comments
  result = result.replace(/#[^\n]*/g, '');
  return result;
}

// ---------------------------------------------------------------------------
// Module body extraction using line-based do/end counting
// ---------------------------------------------------------------------------

/**
 * Given the full source and the position right after `defmodule ... do`,
 * find the module body text up to the matching `end`.
 *
 * Uses a character-by-character scan that skips string literals and
 * counts block-level `do`/`end` keywords only when they appear as
 * standalone tokens (word boundaries).
 */
function extractModuleBody(source: string, startIdx: number): string | null {
  let depth = 1;
  // Walk through source counting do/end as word boundaries
  // Skip strings (single and double quoted)
  let i = startIdx;
  while (i < source.length && depth > 0) {
    const ch = source[i];

    // Skip string literals
    if (ch === '"') {
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // skip closing quote
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < source.length && source[i] !== "'") {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }

    // Check for word-boundary keywords
    // Only match `do` and `end` as full words (not `done`, `donut`, `endor`, etc.)
    if (isWordBoundary(source, i)) {
      if (source.slice(i, i + 2) === 'do' && isWordEnd(source, i + 2)) {
        // Make sure this is block `do`, not keyword `do:` form
        if (source[i + 2] !== ':') {
          depth++;
        }
        i += 2;
        continue;
      }
      if (source.slice(i, i + 2) === 'fn' && isWordEnd(source, i + 2)) {
        depth++;
        i += 2;
        continue;
      }
      if (source.slice(i, i + 3) === 'end' && isWordEnd(source, i + 3)) {
        depth--;
        if (depth === 0) {
          return source.slice(startIdx, i);
        }
        i += 3;
        continue;
      }
    }

    i++;
  }

  return null;
}

function isWordBoundary(source: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = source[idx - 1];
  return !/[a-zA-Z0-9_]/.test(prev);
}

function isWordEnd(source: string, idx: number): boolean {
  if (idx >= source.length) return true;
  return !/[a-zA-Z0-9_]/.test(source[idx]);
}

// ---------------------------------------------------------------------------
// Module extraction
// ---------------------------------------------------------------------------

interface ExtractedModule {
  name: string;
  body: string;
}

/** Find all defmodule blocks and extract their bodies in a single pass. */
function extractModules(source: string): ExtractedModule[] {
  const modules: ExtractedModule[] = [];
  const moduleRegex = /defmodule\s+([\w.]+)\s+do\b/g;
  let match;
  while ((match = moduleRegex.exec(source)) !== null) {
    const body = extractModuleBody(source, match.index + match[0].length);
    if (body) {
      modules.push({ name: match[1], body });
    }
  }
  return modules;
}

// ---------------------------------------------------------------------------
// Struct extraction
// ---------------------------------------------------------------------------

function extractStructs(modules: ExtractedModule[], sourceFile: string): ElixirStruct[] {
  const structs: ElixirStruct[] = [];

  for (const { name: moduleName, body: moduleBody } of modules) {
    // Look for defstruct inside this module
    const structMatch = moduleBody.match(/defstruct\s+\[([^\]]*)\]/);
    if (!structMatch) continue;

    const fieldsStr = structMatch[1];
    const fields: string[] = [];
    const fieldRegex = /:(\w+)/g;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(fieldsStr)) !== null) {
      fields.push(fieldMatch[1]);
    }

    if (fields.length > 0) {
      structs.push({ moduleName, fields, sourceFile });
    }
  }

  return structs;
}

// ---------------------------------------------------------------------------
// Function extraction
// ---------------------------------------------------------------------------

function extractFunctions(modules: ExtractedModule[], sourceFile: string): ElixirFunction[] {
  const functions: ElixirFunction[] = [];

  for (const { name: moduleName, body: moduleBody } of modules) {
    // Match both styles:
    // 1. Block: def name(params) do ... end
    // 2. Keyword: def name(params), do: ...
    // 3. Keyword no-args: def name, do: ...
    const funcRegex = /(def|defp)\s+(\w+)(?:\(([^)]*)\))?(?:\s+do\b|\s*,\s*do:)/g;
    let funcMatch;
    while ((funcMatch = funcRegex.exec(moduleBody)) !== null) {
      const isPrivate = funcMatch[1] === 'defp';
      const name = funcMatch[2];
      const paramsStr = funcMatch[3] || '';

      // Skip module/struct macros
      if (name === 'defstruct' || name === 'defmodule') continue;

      const params: string[] = [];
      const paramStyles: ('positional' | 'keyword')[] = [];
      if (paramsStr.trim()) {
        const paramParts = paramsStr.split(',');
        for (const part of paramParts) {
          const trimmed = part.trim();
          // Extract parameter name (before :: type annotation or \\ default)
          const paramNameMatch = trimmed.match(/^(\w+)/);
          if (paramNameMatch) {
            params.push(paramNameMatch[1]);
            // Detect keyword list params: `opts \\ []` or `options \\ []`
            const isKeywordList = /\\\\\s*\[/.test(trimmed);
            paramStyles.push(isKeywordList ? 'keyword' : 'positional');
          }
        }
      }

      functions.push({
        moduleName,
        name,
        arity: params.length,
        params,
        paramStyles,
        isPrivate,
        sourceFile,
      });
    }
  }

  return functions;
}

// ---------------------------------------------------------------------------
// Type spec extraction
// ---------------------------------------------------------------------------

function extractTypeSpecs(modules: ExtractedModule[], sourceFile: string): ElixirTypeSpec[] {
  const specs: ElixirTypeSpec[] = [];

  for (const { name: moduleName, body: moduleBody } of modules) {
    // Match @type t :: ... capturing multi-line definitions
    // The definition continues until we hit a blank line, a new @-attribute, or def/defstruct
    const typeRegex = /@type\s+(\w+)\s*::\s*/g;
    let typeMatch;
    while ((typeMatch = typeRegex.exec(moduleBody)) !== null) {
      const typeName = typeMatch[1];
      const defStart = typeMatch.index + typeMatch[0].length;

      // Find the end of the type definition:
      // It ends at a blank line, a new @attribute, def, defp, defstruct, or end-of-module
      let defEnd = defStart;
      let braceDepth = 0;
      for (let j = defStart; j < moduleBody.length; j++) {
        const ch = moduleBody[j];
        if (ch === '{') braceDepth++;
        else if (ch === '}') {
          braceDepth--;
          if (braceDepth < 0) break;
          if (braceDepth === 0) {
            defEnd = j + 1;
            break;
          }
        } else if (braceDepth === 0 && ch === '\n') {
          // Check if next non-whitespace line starts a new declaration
          const remaining = moduleBody.slice(j + 1);
          const nextLineMatch = remaining.match(/^\s*\S/);
          if (nextLineMatch) {
            const nextContent = remaining.trimStart();
            if (
              nextContent.startsWith('@') ||
              nextContent.startsWith('def ') ||
              nextContent.startsWith('defp ') ||
              nextContent.startsWith('defstruct') ||
              nextContent.startsWith('defmodule')
            ) {
              defEnd = j;
              break;
            }
          } else {
            // Blank line — end of definition
            defEnd = j;
            break;
          }
        }
        defEnd = j + 1;
      }

      const definition = moduleBody.slice(defStart, defEnd).trim();
      specs.push({ moduleName, name: typeName, definition, sourceFile });
    }
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Enum module extraction
// ---------------------------------------------------------------------------

function extractEnumModules(modules: ExtractedModule[], sourceFile: string): ElixirEnumModule[] {
  const enumModules: ElixirEnumModule[] = [];

  for (const { name: moduleName, body: moduleBody } of modules) {
    // Check if this module has a `values` function (indicator of enum-like module)
    if (!moduleBody.match(/def\s+values[\s,]/)) continue;

    // Also verify there's no defstruct (structs aren't enums)
    if (moduleBody.match(/defstruct\b/)) continue;

    const members: Record<string, string> = {};

    // Extract individual value functions: def name, do: "value"
    const valueFuncRegex = /def\s+(\w+),\s*do:\s*"([^"]+)"/g;
    let valueFuncMatch;
    while ((valueFuncMatch = valueFuncRegex.exec(moduleBody)) !== null) {
      const funcName = valueFuncMatch[1];
      const funcValue = valueFuncMatch[2];
      if (funcName === 'values') continue;
      members[funcName] = funcValue;
    }

    if (Object.keys(members).length > 0) {
      enumModules.push({ moduleName, members, sourceFile });
    }
  }

  return enumModules;
}

// ---------------------------------------------------------------------------
// Full file parser
// ---------------------------------------------------------------------------

/** Parse a single Elixir source file and return all extracted symbols. */
export function parseElixirFile(filePath: string, sdkPath: string): ParsedElixirFile {
  const source = readFileSync(filePath, 'utf-8');
  const relPath = relative(sdkPath, filePath);
  const cleaned = stripCommentsAndHeredocs(source);
  const modules = extractModules(cleaned);

  return {
    structs: extractStructs(modules, relPath),
    functions: extractFunctions(modules, relPath),
    typeSpecs: extractTypeSpecs(modules, relPath),
    enumModules: extractEnumModules(modules, relPath),
    moduleNames: modules.map((m) => m.name),
  };
}
