/**
 * C# (.NET) source parser — regex-based extraction of classes, enums,
 * properties, and methods from C# source files.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface CSharpProperty {
  name: string;
  type: string;
  jsonName?: string;
  readonly: boolean;
}

export interface CSharpMethod {
  name: string;
  params: { name: string; type: string; optional: boolean }[];
  returnType: string;
  visibility: string;
  isAsync: boolean;
}

export interface CSharpClass {
  name: string;
  namespace: string;
  properties: CSharpProperty[];
  methods: CSharpMethod[];
  constructorParams: { name: string; type: string }[];
  isService: boolean;
  sourceFile: string;
}

export interface CSharpEnum {
  name: string;
  namespace: string;
  members: Record<string, string>;
  sourceFile: string;
}

export interface ParsedCSharpFile {
  classes: CSharpClass[];
  enums: CSharpEnum[];
}

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

export function walkCSharpFiles(dir: string): string[] {
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
      if (entry.startsWith('.') || entry === 'bin' || entry === 'obj' || entry === 'test' || entry === 'tests') {
        continue;
      }
      results.push(...walkCSharpFiles(fullPath));
    } else if (entry.endsWith('.cs') && !entry.endsWith('Test.cs') && !entry.endsWith('Tests.cs')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the namespace from a C# source file. */
function extractNamespace(source: string): string {
  // File-scoped namespace (C# 10+): namespace Foo.Bar;
  const fileScopedMatch = source.match(/^namespace\s+([\w.]+)\s*;/m);
  if (fileScopedMatch) return fileScopedMatch[1];

  // Block-scoped namespace: namespace Foo.Bar { ... }
  const blockMatch = source.match(/^namespace\s+([\w.]+)\s*\{/m);
  if (blockMatch) return blockMatch[1];

  return 'unknown';
}

/** Strip single-line and block comments from source. */
function stripComments(source: string): string {
  let result = source.replace(/\/\*[\s\S]*?\*\//g, '');
  result = result.replace(/\/\/[^\n]*/g, '');
  return result;
}

/** Extract [JsonProperty("name")] value from text preceding a property. */
function extractJsonPropertyName(text: string): string | null {
  const match = text.match(/\[JsonProperty\("([^"]+)"\)\]/);
  return match ? match[1] : null;
}

/** Extract [EnumMember(Value = "name")] value from text. */
function extractEnumMemberValue(text: string): string | null {
  const match = text.match(/\[EnumMember\(Value\s*=\s*"([^"]+)"\)\]/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Enum extraction
// ---------------------------------------------------------------------------

function parseEnums(source: string, sourceFile: string): CSharpEnum[] {
  const enums: CSharpEnum[] = [];
  const ns = extractNamespace(source);

  // Match: public enum Name { ... }
  const enumRegex = /public\s+enum\s+(\w+)\s*\{([^}]*)\}/g;
  let match;
  while ((match = enumRegex.exec(source)) !== null) {
    const name = match[1];
    const body = match[2];
    const members: Record<string, string> = {};

    // Split by commas and extract each member
    const lines = body.split(',');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const enumValue = extractEnumMemberValue(trimmed);
      const memberNameMatch = trimmed.match(/(\w+)\s*$/);
      if (memberNameMatch) {
        const memberName = memberNameMatch[1];
        members[memberName] = enumValue || memberName;
      }
    }

    if (Object.keys(members).length > 0) {
      enums.push({ name, namespace: ns, members, sourceFile });
    }
  }

  return enums;
}

// ---------------------------------------------------------------------------
// Class extraction
// ---------------------------------------------------------------------------

function parseClasses(source: string, sourceFile: string): CSharpClass[] {
  const classes: CSharpClass[] = [];
  const ns = extractNamespace(source);

  // Match: public class Name { ... } — need to handle nested braces
  const classStartRegex = /public\s+class\s+(\w+)(?:\s*:\s*[\w.,\s<>]+)?\s*\{/g;
  let match;
  while ((match = classStartRegex.exec(source)) !== null) {
    const name = match[1];
    const braceStart = source.indexOf('{', match.index + match[0].length - 1);

    // Find matching closing brace
    let depth = 1;
    let idx = braceStart + 1;
    while (idx < source.length && depth > 0) {
      if (source[idx] === '{') depth++;
      else if (source[idx] === '}') depth--;
      idx++;
    }

    const classBody = source.slice(braceStart + 1, idx - 1);

    // Parse properties
    const properties = parseProperties(classBody);

    // Parse methods
    const methods = parseMethods(classBody);

    // Parse constructor params
    const constructorParams = parseConstructor(classBody, name);

    // A class is a "service" if it has methods
    const isService = methods.length > 0;

    classes.push({
      name,
      namespace: ns,
      properties,
      methods,
      constructorParams,
      isService,
      sourceFile,
    });
  }

  return classes;
}

/** Parse properties from a class body. */
function parseProperties(classBody: string): CSharpProperty[] {
  const properties: CSharpProperty[] = [];

  // Split into lines so we can look at annotations on the line above
  const lines = classBody.split('\n');
  let pendingJsonName: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for JsonProperty annotation
    const jsonPropMatch = extractJsonPropertyName(trimmed);
    if (jsonPropMatch) {
      pendingJsonName = jsonPropMatch;
      continue;
    }

    // Match: public Type Name { get; set; } or public Type Name { get; }
    const propMatch = trimmed.match(/public\s+(\S+(?:<[^>]+>)?(?:\?)?)\s+(\w+)\s*\{\s*get;\s*(set;\s*)?\}/);
    if (propMatch) {
      const type = propMatch[1];
      const name = propMatch[2];
      const hasSetter = !!propMatch[3];

      properties.push({
        name,
        type,
        jsonName: pendingJsonName || undefined,
        readonly: !hasSetter,
      });
      pendingJsonName = null;
      continue;
    }

    // Reset pending annotation if we hit a non-annotation, non-property line
    if (!trimmed.startsWith('[') && trimmed.length > 0) {
      pendingJsonName = null;
    }
  }

  return properties;
}

/** Parse methods from a class body. */
function parseMethods(classBody: string): CSharpMethod[] {
  const methods: CSharpMethod[] = [];

  // Match: public [async] ReturnType MethodName(params)
  const methodRegex =
    /(private|protected|internal|public)\s+(?:(static)\s+)?(?:(async)\s+)?(\S+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = methodRegex.exec(classBody)) !== null) {
    const visibility = match[1];
    const isAsync = match[3] === 'async';
    const returnType = match[4];
    const name = match[5];
    const paramsStr = match[6];

    // Skip private/protected methods and constructors
    if (visibility === 'private' || visibility === 'protected') continue;

    const params: { name: string; type: string; optional: boolean }[] = [];
    if (paramsStr.trim()) {
      const paramParts = paramsStr.split(',');
      for (const part of paramParts) {
        const trimmed = part.trim();
        // Match: Type name or Type name = default
        const paramMatch = trimmed.match(/(\S+(?:<[^>]+>)?(?:\?)?)\s+(\w+)(?:\s*=\s*(.+))?/);
        if (paramMatch) {
          const paramType = paramMatch[1];
          const paramName = paramMatch[2];
          const hasDefault = paramMatch[3] !== undefined;
          params.push({
            name: paramName,
            type: paramType,
            optional: paramType.endsWith('?') || hasDefault,
          });
        }
      }
    }

    methods.push({
      name,
      params,
      returnType,
      visibility,
      isAsync,
    });
  }

  return methods;
}

/** Parse constructor parameters. */
function parseConstructor(classBody: string, className: string): { name: string; type: string }[] {
  const params: { name: string; type: string }[] = [];

  // Match: public ClassName(params)
  const ctorRegex = new RegExp(`public\\s+${className}\\s*\\(([^)]*)\\)`);
  const match = classBody.match(ctorRegex);
  if (!match) return params;

  const paramsStr = match[1];
  if (!paramsStr.trim()) return params;

  const paramParts = paramsStr.split(',');
  for (const part of paramParts) {
    const trimmed = part.trim();
    const paramMatch = trimmed.match(/(\S+(?:<[^>]+>)?)\s+(\w+)/);
    if (paramMatch) {
      params.push({ name: paramMatch[2], type: paramMatch[1] });
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Full file parser
// ---------------------------------------------------------------------------

/** Parse a single C# source file and return all extracted symbols. */
export function parseCSharpFile(filePath: string, sdkPath: string): ParsedCSharpFile {
  const source = readFileSync(filePath, 'utf-8');
  const relPath = relative(sdkPath, filePath);
  const cleaned = stripComments(source);

  return {
    classes: parseClasses(cleaned, relPath),
    enums: parseEnums(cleaned, relPath),
  };
}
