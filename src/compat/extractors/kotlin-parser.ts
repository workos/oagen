/**
 * Kotlin source parser — regex-based extraction of classes, data classes,
 * enum classes, functions, and type aliases from Kotlin source files.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface KotlinField {
  name: string;
  type: string;
  jsonName?: string;
  optional: boolean;
}

export interface KotlinDataClass {
  name: string;
  fields: KotlinField[];
  sourceFile: string;
  packageName: string;
}

export interface KotlinClass {
  name: string;
  constructorParams: { name: string; type: string }[];
  methods: KotlinMethod[];
  sourceFile: string;
  packageName: string;
}

export interface KotlinMethod {
  name: string;
  params: { name: string; type: string; optional: boolean }[];
  returnType: string;
  visibility: string;
}

export interface KotlinEnum {
  name: string;
  members: Record<string, string>;
  sourceFile: string;
  packageName: string;
}

export interface KotlinTypeAlias {
  name: string;
  value: string;
  sourceFile: string;
  packageName: string;
}

export interface ParsedKotlinFile {
  dataClasses: KotlinDataClass[];
  classes: KotlinClass[];
  enums: KotlinEnum[];
  typeAliases: KotlinTypeAlias[];
}

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

export function walkKotlinFiles(dir: string): string[] {
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
      if (entry.startsWith('.') || entry === 'build' || entry === 'test' || entry === 'androidTest') continue;
      results.push(...walkKotlinFiles(fullPath));
    } else if (entry.endsWith('.kt') && !entry.endsWith('Test.kt')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the package name from a Kotlin source file. */
function extractPackageName(source: string): string {
  const match = source.match(/^package\s+([\w.]+)/m);
  return match ? match[1] : 'unknown';
}

/** Strip single-line and block comments from source to avoid false matches. */
function stripComments(source: string): string {
  // Remove block comments
  let result = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove single-line comments
  result = result.replace(/\/\/[^\n]*/g, '');
  return result;
}

/**
 * Extract the @JsonProperty("name") annotation value before a parameter.
 * Looks for the pattern immediately preceding the parameter declaration.
 */
function extractJsonPropertyName(text: string): string | null {
  const match = text.match(/@JsonProperty\("([^"]+)"\)/);
  return match ? match[1] : null;
}

/**
 * Parse constructor parameters from a data class or class declaration.
 * Handles multi-line parameter lists with annotations.
 */
function parseConstructorParams(paramsBlock: string): KotlinField[] {
  const fields: KotlinField[] = [];

  // Split by top-level commas (not nested in angle brackets or parens)
  const params = splitTopLevelCommas(paramsBlock);

  for (const param of params) {
    const trimmed = param.trim();
    if (!trimmed) continue;

    // Extract JsonProperty annotation if present
    const jsonName = extractJsonPropertyName(trimmed);

    // Match val/var name: Type pattern, possibly with default value
    const paramMatch = trimmed.match(
      /(?:(?:override|private|protected)\s+)?(?:val|var)\s+(\w+)\s*:\s*([^=,]+?)(?:\s*=\s*(.+))?$/m,
    );
    if (!paramMatch) continue;

    const name = paramMatch[1];
    const rawType = paramMatch[2].trim();
    const hasDefault = paramMatch[3] !== undefined;

    // Check if the type is nullable (ends with ?)
    const isNullable = rawType.endsWith('?');
    const type = rawType;

    fields.push({
      name,
      type,
      jsonName: jsonName || undefined,
      optional: isNullable || hasDefault,
    });
  }

  return fields;
}

/** Split a string by top-level commas, ignoring commas inside angle brackets, parens, or strings. */
function splitTopLevelCommas(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      current += ch;
      if (ch === stringChar && text[i - 1] !== '\\') {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      current += ch;
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
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Enum extraction
// ---------------------------------------------------------------------------

function parseEnumClass(source: string, sourceFile: string, packageName: string): KotlinEnum[] {
  const enums: KotlinEnum[] = [];

  // Match: enum class Name(@JsonValue val value: Type) { Member1("val1"), Member2("val2") }
  const enumRegex = /enum\s+class\s+(\w+)(?:\([^)]*\))?\s*\{([^}]*)\}/g;
  let match;
  while ((match = enumRegex.exec(source)) !== null) {
    const name = match[1];
    const body = match[2];

    const members: Record<string, string> = {};

    // Match enum members: MemberName("value") or MemberName
    const memberRegex = /(\w+)\s*(?:\("([^"]*)"\))?/g;
    let memberMatch;
    while ((memberMatch = memberRegex.exec(body)) !== null) {
      const memberName = memberMatch[1];
      // Skip keywords that might match
      if (['val', 'var', 'fun', 'override', 'companion', 'object'].includes(memberName)) continue;
      const memberValue = memberMatch[2] !== undefined ? memberMatch[2] : memberName;
      members[memberName] = memberValue;
    }

    if (Object.keys(members).length > 0) {
      enums.push({ name, members, sourceFile, packageName });
    }
  }

  return enums;
}

// ---------------------------------------------------------------------------
// Data class extraction
// ---------------------------------------------------------------------------

function parseDataClasses(source: string, sourceFile: string, packageName: string): KotlinDataClass[] {
  const dataClasses: KotlinDataClass[] = [];

  // Match: data class Name(params) or data class Name @Annotation constructor(params)
  // Use a regex that captures the opening paren, then find the matching close
  const dataClassStartRegex = /data\s+class\s+(\w+)\s*(?:@\w+(?:\([^)]*\))?\s+)?(?:constructor\s*)?\(/g;
  let match;
  while ((match = dataClassStartRegex.exec(source)) !== null) {
    const name = match[1];
    const startIdx = match.index + match[0].length;

    // Find matching closing paren
    let depth = 1;
    let idx = startIdx;
    while (idx < source.length && depth > 0) {
      if (source[idx] === '(') depth++;
      else if (source[idx] === ')') depth--;
      idx++;
    }

    const paramsBlock = source.slice(startIdx, idx - 1);
    const fields = parseConstructorParams(paramsBlock);

    dataClasses.push({ name, fields, sourceFile, packageName });
  }

  return dataClasses;
}

// ---------------------------------------------------------------------------
// Class extraction (non-data classes)
// ---------------------------------------------------------------------------

function parseClasses(source: string, sourceFile: string, packageName: string): KotlinClass[] {
  const classes: KotlinClass[] = [];

  // Match non-data, non-enum classes: class Name(params) { body }
  // Skip abstract, sealed, and open classes that aren't services
  const classStartRegex =
    /(?<!data\s)(?<!enum\s)(?<!abstract\s)(?<!sealed\s)(?:open\s+)?class\s+(\w+)\s*(?:\(([^)]*)\))?\s*(?::\s*[^{]+)?\s*\{/g;
  let match;
  while ((match = classStartRegex.exec(source)) !== null) {
    const name = match[1];
    const constructorBlock = match[2] || '';

    // Find matching closing brace for the class body
    const braceStart = source.indexOf('{', match.index + match[0].length - 1);
    let depth = 1;
    let idx = braceStart + 1;
    while (idx < source.length && depth > 0) {
      if (source[idx] === '{') depth++;
      else if (source[idx] === '}') depth--;
      idx++;
    }

    const classBody = source.slice(braceStart + 1, idx - 1);

    // Parse constructor params
    const constructorParams: { name: string; type: string }[] = [];
    if (constructorBlock.trim()) {
      const params = splitTopLevelCommas(constructorBlock);
      for (const param of params) {
        const trimmed = param.trim();
        const paramMatch = trimmed.match(/(?:(?:private|protected)\s+)?(?:val|var)\s+(\w+)\s*:\s*(.+)/);
        if (paramMatch) {
          constructorParams.push({ name: paramMatch[1], type: paramMatch[2].trim() });
        }
      }
    }

    // Parse methods
    const methods = parseMethods(classBody);

    if (methods.length > 0) {
      classes.push({ name, constructorParams, methods, sourceFile, packageName });
    }
  }

  return classes;
}

/** Parse method declarations from a class body. */
function parseMethods(classBody: string): KotlinMethod[] {
  const methods: KotlinMethod[] = [];

  // Match: fun methodName(params): ReturnType or fun methodName(params)
  // Handle suspend fun, private fun, etc.
  const methodRegex =
    /(private|protected|internal|public)?\s*(?:suspend\s+)?fun\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([^\s{]+))?/g;
  let match;
  while ((match = methodRegex.exec(classBody)) !== null) {
    const visibility = match[1] || 'public';
    const name = match[2];
    const paramsStr = match[3];
    const returnType = match[4] || 'Unit';

    // Skip private/protected methods
    if (visibility === 'private' || visibility === 'protected') continue;

    const params: { name: string; type: string; optional: boolean }[] = [];
    if (paramsStr.trim()) {
      const paramParts = splitTopLevelCommas(paramsStr);
      for (const part of paramParts) {
        const trimmed = part.trim();
        const paramMatch = trimmed.match(/(\w+)\s*:\s*([^=]+?)(?:\s*=\s*(.+))?$/);
        if (paramMatch) {
          const paramType = paramMatch[2].trim();
          const hasDefault = paramMatch[3] !== undefined;
          params.push({
            name: paramMatch[1],
            type: paramType,
            optional: paramType.endsWith('?') || hasDefault,
          });
        }
      }
    }

    methods.push({ name, params, returnType, visibility });
  }

  return methods;
}

// ---------------------------------------------------------------------------
// Type alias extraction
// ---------------------------------------------------------------------------

function parseTypeAliases(source: string, sourceFile: string, packageName: string): KotlinTypeAlias[] {
  const aliases: KotlinTypeAlias[] = [];

  const aliasRegex = /typealias\s+(\w+)\s*=\s*([^\n]+)/g;
  let match;
  while ((match = aliasRegex.exec(source)) !== null) {
    aliases.push({
      name: match[1],
      value: match[2].trim(),
      sourceFile,
      packageName,
    });
  }

  return aliases;
}

// ---------------------------------------------------------------------------
// Full file parser
// ---------------------------------------------------------------------------

/** Parse a single Kotlin source file and return all extracted symbols. */
export function parseKotlinFile(filePath: string, sdkPath: string): ParsedKotlinFile {
  const source = readFileSync(filePath, 'utf-8');
  const relPath = relative(sdkPath, filePath);
  const cleaned = stripComments(source);
  const packageName = extractPackageName(cleaned);

  return {
    dataClasses: parseDataClasses(cleaned, relPath, packageName),
    classes: parseClasses(cleaned, relPath, packageName),
    enums: parseEnumClass(cleaned, relPath, packageName),
    typeAliases: parseTypeAliases(cleaned, relPath, packageName),
  };
}
