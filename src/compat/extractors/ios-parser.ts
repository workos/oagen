/**
 * Swift source parser — regex-based extraction of structs, classes, actors,
 * extensions, enums, and type aliases from Swift source files.
 *
 * Swift-specific concerns handled here that the other parsers can ignore:
 *  - String literals may contain `//` (URLs) and braces, so comment stripping
 *    and brace matching are both string-aware.
 *  - Files marked `@oagen-ignore-file` are hand-maintained and skipped, so an
 *    `extension` of a hand-written type (e.g. `WorkOSClient+Resources.swift`)
 *    owns the surface it contributes.
 *  - Generated enums carry an `unknown(String)` escape-hatch case and encode
 *    member raw values in `init(rawValue:)` / `var rawValue` switches rather
 *    than `case name = "value"` declarations.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface SwiftProperty {
  name: string;
  type: string;
  optional: boolean;
  readonly: boolean;
}

export interface SwiftParam {
  name: string;
  type: string;
  optional: boolean;
}

export interface SwiftMethod {
  name: string;
  params: SwiftParam[];
  returnType: string;
  async: boolean;
}

export interface SwiftTypeDecl {
  kind: 'struct' | 'class' | 'actor' | 'extension';
  name: string;
  properties: SwiftProperty[];
  methods: SwiftMethod[];
  initOverloads: SwiftParam[][];
  sourceFile: string;
}

export interface SwiftEnum {
  name: string;
  members: Record<string, string>;
  sourceFile: string;
}

export interface SwiftTypeAlias {
  name: string;
  value: string;
  sourceFile: string;
}

export interface ParsedSwiftFile {
  types: SwiftTypeDecl[];
  enums: SwiftEnum[];
  typeAliases: SwiftTypeAlias[];
}

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['build', 'Tests', 'DerivedData', 'Pods', 'Carthage']);

export function walkSwiftFiles(dir: string): string[] {
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
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      results.push(...walkSwiftFiles(fullPath));
    } else if (
      entry.endsWith('.swift') &&
      !entry.endsWith('Tests.swift') &&
      !entry.endsWith('Test.swift') &&
      entry !== 'Package.swift'
    ) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// String-aware scanning helpers
// ---------------------------------------------------------------------------

/** Advance past a string literal starting at `idx` (which must point at `"`).
 *  Handles escapes and multi-line `"""` literals. Returns the index just past
 *  the closing quote(s). */
function skipString(source: string, idx: number): number {
  const n = source.length;
  if (source.startsWith('"""', idx)) {
    const end = source.indexOf('"""', idx + 3);
    return end === -1 ? n : end + 3;
  }
  let i = idx + 1;
  while (i < n && source[i] !== '"') {
    if (source[i] === '\\') i++;
    i++;
  }
  return Math.min(i + 1, n);
}

/** Strip line and (nesting) block comments. String literals are preserved
 *  verbatim, including any `//` sequences inside them (URLs). */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '"') {
      const end = skipString(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Given the index of an opening `{`, return the index just past its matching
 *  `}`. String-aware so braces inside literals don't skew the depth. */
function matchBrace(source: string, openIdx: number): number {
  const n = source.length;
  let depth = 1;
  let i = openIdx + 1;
  while (i < n && depth > 0) {
    const ch = source[i];
    if (ch === '"') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return i;
}

/** Reduce a type body to its top-level text: nested `{...}` blocks are
 *  replaced with a newline so declaration signatures survive while method
 *  bodies, computed-property accessors, and nested types disappear. */
function topLevelText(body: string): string {
  let out = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (ch === '"') {
      const end = skipString(body, i);
      out += body.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '{') {
      out += '\n';
      i = matchBrace(body, i);
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Split by top-level commas, ignoring commas nested in brackets or strings. */
function splitTopLevelCommas(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipString(text, i);
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '<' || ch === '(' || ch === '[') {
      depth++;
      current += ch;
    } else if (ch === '>' || ch === ')' || ch === ']') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
    i++;
  }
  if (current.trim()) result.push(current);
  return result;
}

/** Given the index of an opening `(`, return the index just past its matching `)`. */
function matchParen(source: string, openIdx: number): number {
  const n = source.length;
  let depth = 1;
  let i = openIdx + 1;
  while (i < n && depth > 0) {
    const ch = source[i];
    if (ch === '"') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    i++;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Member parsing
// ---------------------------------------------------------------------------

const VISIBILITY_PUBLIC = /\b(?:public|open)\b/;

/** Parse `label name: Type = default` parameter fragments. The public name is
 *  the external argument label; `_ name:` falls back to the internal name. */
function parseParams(paramsBlock: string): SwiftParam[] {
  const params: SwiftParam[] = [];
  for (const part of splitTopLevelCommas(paramsBlock)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const paramMatch = trimmed.match(/^(?:(\w+|_)\s+)?(\w+)\s*:\s*([^=]+?)(?:\s*=\s*(.+))?$/s);
    if (!paramMatch) continue;
    const label = paramMatch[1];
    const internalName = paramMatch[2];
    const type = paramMatch[3].trim();
    const hasDefault = paramMatch[4] !== undefined;
    const name = !label || label === '_' ? internalName : label;
    params.push({ name, type, optional: type.endsWith('?') || hasDefault });
  }
  return params;
}

/** Parse stored and computed property declarations from top-level type text. */
function parseProperties(surfaceText: string, defaultPublic: boolean): SwiftProperty[] {
  const properties: SwiftProperty[] = [];
  const propRegex =
    /^[ \t]*((?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|open|package|internal|fileprivate|private|static|class|final|lazy|weak|nonisolated)(?:\([^)]*\))?\s+)*)(let|var)\s+(\w+)\s*:\s*([^\n={]+)/gm;
  let match;
  while ((match = propRegex.exec(surfaceText)) !== null) {
    const modifiers = match[1] || '';
    if (
      !VISIBILITY_PUBLIC.test(modifiers) &&
      !(defaultPublic && !/\b(?:internal|fileprivate|private|package)\b/.test(modifiers))
    )
      continue;
    if (/\bstatic\b/.test(modifiers)) continue;
    const keyword = match[2];
    const name = match[3];
    const type = match[4].trim();
    properties.push({
      name,
      type,
      optional: type.endsWith('?'),
      readonly: keyword === 'let',
    });
  }
  return properties;
}

/** Parse `func` declarations from top-level type text. */
function parseMethods(surfaceText: string, defaultPublic: boolean): SwiftMethod[] {
  const methods: SwiftMethod[] = [];
  const funcRegex =
    /((?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|open|package|internal|fileprivate|private|static|class|final|nonisolated|mutating)(?:\([^)]*\))?\s+)*)func\s+(\w+)(?:<[^>]*>)?\s*\(/g;
  let match;
  while ((match = funcRegex.exec(surfaceText)) !== null) {
    const modifiers = match[1] || '';
    if (
      !VISIBILITY_PUBLIC.test(modifiers) &&
      !(defaultPublic && !/\b(?:internal|fileprivate|private|package)\b/.test(modifiers))
    )
      continue;
    const name = match[2];
    const parenOpen = match.index + match[0].length - 1;
    const parenClose = matchParen(surfaceText, parenOpen);
    const params = parseParams(surfaceText.slice(parenOpen + 1, parenClose - 1));

    const tail = surfaceText.slice(parenClose);
    const tailMatch = tail.match(/^\s*(async)?\s*(?:throws|rethrows)?\s*(?:->\s*([^\n]+))?/);
    let returnType = tailMatch?.[2]?.trim() ?? 'Void';
    const whereIdx = returnType.indexOf(' where ');
    if (whereIdx !== -1) returnType = returnType.slice(0, whereIdx).trim();

    methods.push({ name, params, returnType, async: tailMatch?.[1] === 'async' });
    funcRegex.lastIndex = parenClose;
  }
  return methods;
}

/** Parse `init` declarations from top-level type text. */
function parseInits(surfaceText: string, defaultPublic: boolean): SwiftParam[][] {
  const overloads: SwiftParam[][] = [];
  const initRegex =
    /((?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|open|package|internal|fileprivate|private|convenience|required|nonisolated)\s+)*)init\s*\??\s*\(/g;
  let match;
  while ((match = initRegex.exec(surfaceText)) !== null) {
    const modifiers = match[1] || '';
    if (
      !VISIBILITY_PUBLIC.test(modifiers) &&
      !(defaultPublic && !/\b(?:internal|fileprivate|private|package)\b/.test(modifiers))
    )
      continue;
    const parenOpen = match.index + match[0].length - 1;
    const parenClose = matchParen(surfaceText, parenOpen);
    overloads.push(parseParams(surfaceText.slice(parenOpen + 1, parenClose - 1)));
    initRegex.lastIndex = parenClose;
  }
  return overloads;
}

// ---------------------------------------------------------------------------
// Enum extraction
// ---------------------------------------------------------------------------

function parseEnumBody(name: string, body: string, sourceFile: string): SwiftEnum | null {
  const surface = topLevelText(body);

  // Collect member names from top-level `case` declarations. Cases with
  // associated values — e.g. the generated `unknown(String)` escape hatch —
  // are not spec members and are skipped.
  const declared: { name: string; rawValue?: string }[] = [];
  const caseLineRegex = /^\s*(?:indirect\s+)?case\s+(.+)$/gm;
  let match;
  while ((match = caseLineRegex.exec(surface)) !== null) {
    for (const entry of splitTopLevelCommas(match[1])) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const caseMatch = trimmed.match(/^`?(\w+)`?(\([^)]*\))?(?:\s*=\s*"([^"]*)")?/);
      if (!caseMatch) continue;
      if (caseMatch[2] !== undefined) continue; // associated value case
      declared.push({ name: caseMatch[1], rawValue: caseMatch[3] });
    }
  }
  if (declared.length === 0) return null;

  // Raw values live in the `var rawValue` getter (`case .name: return "value"`)
  // or the `init(rawValue:)` switch (`case "value": self = .name`). Scan the
  // full body — these switches sit inside nested braces.
  const valueByMember = new Map<string, string>();
  const getterRegex = /case\s+\.(\w+)\s*:\s*return\s+"((?:[^"\\]|\\.)*)"/g;
  while ((match = getterRegex.exec(body)) !== null) {
    valueByMember.set(match[1], match[2]);
  }
  const initRegex = /case\s+"((?:[^"\\]|\\.)*)"\s*:\s*self\s*=\s*\.(\w+)/g;
  while ((match = initRegex.exec(body)) !== null) {
    if (!valueByMember.has(match[2])) valueByMember.set(match[2], match[1]);
  }

  const members: Record<string, string> = {};
  for (const { name: memberName, rawValue } of declared) {
    members[memberName] = rawValue ?? valueByMember.get(memberName) ?? memberName;
  }
  return { name, members, sourceFile };
}

// ---------------------------------------------------------------------------
// Full file parser
// ---------------------------------------------------------------------------

const TYPE_DECL_REGEX =
  /((?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|open|package|internal|fileprivate|private|final|indirect)\s+)*)(struct|class|actor|enum)\s+(\w+)(?:<[^>]*>)?(?:\s*:\s*[^{]+?)?\s*\{/g;

const EXTENSION_REGEX =
  /(^|\n)\s*((?:public|package|internal|fileprivate|private)\s+)?extension\s+(\w+)(?:\s*:\s*[^{]+?)?\s*\{/g;

/** Parse a single Swift source file and return all extracted symbols.
 *  Files marked `@oagen-ignore-file` are hand-maintained and yield nothing. */
export function parseSwiftFile(filePath: string, sdkPath: string): ParsedSwiftFile {
  const source = readFileSync(filePath, 'utf-8');
  const relPath = relative(sdkPath, filePath);

  const empty: ParsedSwiftFile = { types: [], enums: [], typeAliases: [] };
  if (source.includes('@oagen-ignore-file')) return empty;

  const cleaned = stripComments(source);
  const types: SwiftTypeDecl[] = [];
  const enums: SwiftEnum[] = [];
  const typeAliases: SwiftTypeAlias[] = [];

  let match;
  while ((match = TYPE_DECL_REGEX.exec(cleaned)) !== null) {
    const modifiers = match[1] || '';
    const kind = match[2] as 'struct' | 'class' | 'actor' | 'enum';
    const name = match[3];
    const braceIdx = match.index + match[0].length - 1;
    const bodyEnd = matchBrace(cleaned, braceIdx);
    const body = cleaned.slice(braceIdx + 1, bodyEnd - 1);

    if (!VISIBILITY_PUBLIC.test(modifiers)) continue;

    if (kind === 'enum') {
      const parsed = parseEnumBody(name, body, relPath);
      if (parsed) enums.push(parsed);
      continue;
    }

    const surface = topLevelText(body);
    types.push({
      kind,
      name,
      properties: parseProperties(surface, false),
      methods: parseMethods(surface, false),
      initOverloads: parseInits(surface, false),
      sourceFile: relPath,
    });
  }

  while ((match = EXTENSION_REGEX.exec(cleaned)) !== null) {
    const isPublicExtension = (match[2] || '').trim() === 'public';
    const name = match[3];
    const braceIdx = match.index + match[0].length - 1;
    const bodyEnd = matchBrace(cleaned, braceIdx);
    const body = cleaned.slice(braceIdx + 1, bodyEnd - 1);
    const surface = topLevelText(body);

    const decl: SwiftTypeDecl = {
      kind: 'extension',
      name,
      properties: parseProperties(surface, isPublicExtension),
      methods: parseMethods(surface, isPublicExtension),
      initOverloads: parseInits(surface, isPublicExtension),
      sourceFile: relPath,
    };
    if (decl.properties.length > 0 || decl.methods.length > 0 || decl.initOverloads.length > 0) {
      types.push(decl);
    }
  }

  const aliasRegex = /(?:public|open)\s+typealias\s+(\w+)(?:<[^>]*>)?\s*=\s*([^\n]+)/g;
  while ((match = aliasRegex.exec(cleaned)) !== null) {
    typeAliases.push({ name: match[1], value: match[2].trim(), sourceFile: relPath });
  }

  return { types, enums, typeAliases };
}
