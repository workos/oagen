/** Python source parser — tree-sitter-based extraction of classes, type aliases, and symbols. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import type { SyntaxNode } from 'tree-sitter';
import { safeParse } from '../../utils/tree-sitter.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface PythonField {
  name: string;
  type: string;
  hasDefault: boolean;
}

export interface PythonMethod {
  name: string;
  params: {
    name: string;
    type: string;
    optional: boolean;
    passingStyle?: 'positional' | 'keyword' | 'keyword_or_positional';
  }[];
  returnType: string;
  isAsync: boolean;
  isProperty: boolean;
  isClassMethod: boolean;
  isStaticMethod: boolean;
}

export interface PythonClass {
  name: string;
  bases: string[];
  fields: PythonField[];
  methods: PythonMethod[];
  decorators: string[];
  sourceFile: string;
}

export interface PythonTypeAlias {
  name: string;
  value: string;
  sourceFile: string;
}

export interface PythonImport {
  names: string[];
  sourceFile: string;
}

// ---------------------------------------------------------------------------
// Shared parser instance
// ---------------------------------------------------------------------------

const pythonParser = new Parser();
pythonParser.setLanguage(Python);

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

export function walkPythonFiles(dir: string): string[] {
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
      if (
        entry.startsWith('.') ||
        entry === '__pycache__' ||
        entry === 'tests' ||
        entry === 'test' ||
        entry === 'node_modules'
      )
        continue;
      results.push(...walkPythonFiles(fullPath));
    } else if (entry.endsWith('.py')) {
      // Skip test files
      if (entry.endsWith('_test.py') || entry.startsWith('test_')) continue;
      // Skip private modules (but include __init__.py)
      if (entry.startsWith('_') && entry !== '__init__.py') continue;
      results.push(fullPath);
    }
  }
  return results.sort();
}

/** Find the Python source root (prefers `src/`, falls back to top-level package). */
export function findPythonSourceRoot(sdkPath: string): string | null {
  // Strategy 1: src/ directory
  const srcDir = join(sdkPath, 'src');
  try {
    const stat = statSync(srcDir);
    if (stat.isDirectory()) {
      const entries = readdirSync(srcDir);
      for (const entry of entries) {
        const pkgDir = join(srcDir, entry);
        try {
          const pkgStat = statSync(pkgDir);
          if (pkgStat.isDirectory()) {
            const initFile = join(pkgDir, '__init__.py');
            try {
              statSync(initFile);
              return srcDir;
            } catch {
              // no __init__.py, keep looking
            }
          }
        } catch {
          continue;
        }
      }
    }
  } catch {
    // no src/, continue
  }

  // Strategy 2: top-level package directory
  try {
    const entries = readdirSync(sdkPath);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'tests' || entry === 'test' || entry === 'node_modules') continue;
      const pkgDir = join(sdkPath, entry);
      try {
        const pkgStat = statSync(pkgDir);
        if (pkgStat.isDirectory()) {
          const initFile = join(pkgDir, '__init__.py');
          try {
            statSync(initFile);
            return sdkPath;
          } catch {
            // no __init__.py
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // can't read sdkPath
  }

  return null;
}

/** Get all decorator names from a decorated_definition or class_definition. */
function getDecorators(node: SyntaxNode): string[] {
  const decorators: string[] = [];
  // Decorated definition wraps the class or function
  if (node.type === 'decorated_definition') {
    for (const child of node.namedChildren) {
      if (child.type === 'decorator') {
        const exprNode = child.namedChildren[0];
        if (exprNode) decorators.push(exprNode.text);
      }
    }
  }
  return decorators;
}

/** Extract base class names from a class definition's argument_list. */
function getBaseClasses(classNode: SyntaxNode): string[] {
  const bases: string[] = [];
  const argList = classNode.childForFieldName('superclasses');
  if (!argList) return bases;

  for (const child of argList.namedChildren) {
    if (child.type === 'identifier' || child.type === 'attribute') {
      bases.push(child.text);
    } else if (child.type === 'keyword_argument') {
      // skip keyword arguments like total=False
    }
  }
  return bases;
}

/** Extract annotated fields from a class body. */
function extractClassFields(bodyNode: SyntaxNode): PythonField[] {
  const fields: PythonField[] = [];

  for (const child of bodyNode.namedChildren) {
    if (child.type !== 'expression_statement') continue;

    const stmtChild = child.namedChildren[0];
    if (!stmtChild || stmtChild.type !== 'assignment') continue;

    const left = stmtChild.childForFieldName('left');
    const typeNode = stmtChild.childForFieldName('type');

    // Must be an annotated assignment (has a type annotation)
    if (!left || !typeNode) continue;
    // Only simple identifier on left side (not tuple unpacking, etc.)
    if (left.type !== 'identifier') continue;

    const right = stmtChild.childForFieldName('right');

    fields.push({
      name: left.text,
      type: typeNode.text,
      hasDefault: right !== null,
    });
  }
  return fields;
}

/** Extract methods from a class body. */
function extractClassMethods(bodyNode: SyntaxNode): PythonMethod[] {
  const methods: PythonMethod[] = [];

  for (const child of bodyNode.namedChildren) {
    let funcNode: SyntaxNode | null = null;
    let decorators: string[] = [];

    if (child.type === 'decorated_definition') {
      decorators = getDecorators(child);
      // The actual function/class is the last named child
      funcNode = child.namedChildren.find((c) => c.type === 'function_definition') || null;
    } else if (child.type === 'function_definition') {
      funcNode = child;
    }

    if (!funcNode) continue;

    const nameNode = funcNode.childForFieldName('name');
    if (!nameNode) continue;
    const methodName = nameNode.text;

    // Skip private methods (starting with _) but keep __init__
    if (methodName.startsWith('_') && methodName !== '__init__') continue;

    const isAsync = funcNode.namedChildren.some((c) => c.type === 'async');
    const isProperty = decorators.includes('property');
    const isClassMethod = decorators.includes('classmethod');
    const isStaticMethod = decorators.includes('staticmethod');

    // Extract parameters
    const paramsNode = funcNode.childForFieldName('parameters');
    const params = extractFunctionParams(paramsNode, isStaticMethod || isClassMethod);

    // Extract return type
    const returnTypeNode = funcNode.childForFieldName('return_type');
    const returnType = returnTypeNode ? returnTypeNode.text : '';

    methods.push({
      name: methodName,
      params,
      returnType,
      isAsync,
      isProperty,
      isClassMethod,
      isStaticMethod,
    });
  }

  return methods;
}

/** Extract parameters from a function's parameter list. */
function extractFunctionParams(
  paramsNode: SyntaxNode | null,
  skipFirst: boolean,
): {
  name: string;
  type: string;
  optional: boolean;
  passingStyle?: 'positional' | 'keyword' | 'keyword_or_positional';
}[] {
  if (!paramsNode) return [];
  const params: {
    name: string;
    type: string;
    optional: boolean;
    passingStyle?: 'positional' | 'keyword' | 'keyword_or_positional';
  }[] = [];
  let skippedFirst = false;
  let seenStarMarker = false;

  for (const child of paramsNode.namedChildren) {
    // Skip `self` or `cls` parameter
    if (!skippedFirst && !skipFirst && child.type === 'identifier' && (child.text === 'self' || child.text === 'cls')) {
      skippedFirst = true;
      continue;
    }
    if (!skippedFirst && !skipFirst && child.type === 'typed_parameter' && child.namedChildren[0]?.text === 'self') {
      skippedFirst = true;
      continue;
    }

    // `*` separator in parameters (keyword-only marker)
    if (child.text === '*') {
      seenStarMarker = true;
      continue;
    }

    // *args — variadic positional (also marks subsequent params as keyword-only)
    if (child.type === 'list_splat_pattern') {
      seenStarMarker = true;
      const nameNode = child.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      params.push({
        name: nameNode ? `*${nameNode.text}` : '*args',
        type: '',
        optional: true,
        passingStyle: 'positional',
      });
      continue;
    }

    // **kwargs — variadic keyword
    if (child.type === 'dictionary_splat_pattern') {
      const nameNode = child.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      params.push({
        name: nameNode ? `**${nameNode.text}` : '**kwargs',
        type: '',
        optional: true,
        passingStyle: 'keyword',
      });
      continue;
    }

    const passingStyle = seenStarMarker ? ('keyword' as const) : ('keyword_or_positional' as const);

    if (child.type === 'typed_parameter') {
      const nameNode = child.namedChildren.find((c) => c.type === 'identifier');
      const typeNode = child.childForFieldName('type');
      if (nameNode) {
        params.push({
          name: nameNode.text,
          type: typeNode ? typeNode.text : '',
          optional: false,
          passingStyle,
        });
      }
    } else if (child.type === 'typed_default_parameter') {
      const nameNode = child.childForFieldName('name');
      const typeNode = child.childForFieldName('type');
      if (nameNode) {
        params.push({
          name: nameNode.text,
          type: typeNode ? typeNode.text : '',
          optional: true,
          passingStyle,
        });
      }
    } else if (child.type === 'default_parameter') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        params.push({
          name: nameNode.text,
          type: '',
          optional: true,
          passingStyle,
        });
      }
    } else if (child.type === 'identifier') {
      params.push({
        name: child.text,
        type: '',
        optional: false,
        passingStyle,
      });
    }
  }

  return params;
}

/** Extract module-level type aliases (e.g., FooType = Literal["a", "b"]). */
function extractTypeAliases(tree: Parser.Tree, sourceFile: string): PythonTypeAlias[] {
  const aliases: PythonTypeAlias[] = [];

  for (const node of tree.rootNode.namedChildren) {
    // type alias statement (Python 3.12+): type X = ...
    if (node.type === 'type_alias_statement') {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (nameNode && valueNode) {
        aliases.push({ name: nameNode.text, value: valueNode.text, sourceFile });
      }
      continue;
    }

    // Assignment: X = Literal[...] or X = "SomeResource[...]"
    if (node.type === 'expression_statement') {
      const inner = node.namedChildren[0];
      if (!inner || inner.type !== 'assignment') continue;

      const left = inner.childForFieldName('left');
      const right = inner.childForFieldName('right');
      if (!left || !right) continue;

      // Only consider simple name assignments (not a: type = value)
      if (left.type !== 'identifier') continue;

      const name = left.text;
      // Skip private names and dunder names
      if (name.startsWith('_')) continue;
      // Skip ALL_CAPS constants that are not type aliases
      if (/^[A-Z][A-Z_0-9]*$/.test(name)) continue;

      const value = right.text;

      // Only take subscript expressions (Literal[...], SomeResource[...], etc.)
      // or string literals that look like type aliases
      if (right.type === 'subscript' || (right.type === 'string' && value.includes('['))) {
        // For string literals, strip quotes
        let cleanValue = value;
        if (right.type === 'string') {
          cleanValue = value.replace(/^["']|["']$/g, '');
        }
        aliases.push({ name, value: cleanValue, sourceFile });
      }
    }
  }

  return aliases;
}

/** Extract __all__ exports from a module. */
function extractAllExports(tree: Parser.Tree): string[] {
  const exports: string[] = [];

  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== 'expression_statement') continue;
    const inner = node.namedChildren[0];
    if (!inner || inner.type !== 'assignment') continue;

    const left = inner.childForFieldName('left');
    const right = inner.childForFieldName('right');
    if (!left || !right) continue;
    if (left.text !== '__all__') continue;

    // __all__ = ["Foo", "Bar"]
    if (right.type === 'list') {
      for (const elem of right.namedChildren) {
        if (elem.type === 'string') {
          const text = elem.text.replace(/^["']|["']$/g, '');
          exports.push(text);
        }
      }
    }
  }

  return exports;
}

function extractClassesFromTree(tree: Parser.Tree, sourceFile: string): PythonClass[] {
  const classes: PythonClass[] = [];

  for (const node of tree.rootNode.namedChildren) {
    let classNode: SyntaxNode | null = null;
    let decorators: string[] = [];

    if (node.type === 'decorated_definition') {
      decorators = getDecorators(node);
      classNode = node.namedChildren.find((c) => c.type === 'class_definition') || null;
    } else if (node.type === 'class_definition') {
      classNode = node;
    }

    if (!classNode) continue;

    const nameNode = classNode.childForFieldName('name');
    if (!nameNode) continue;
    const className = nameNode.text;

    const bases = getBaseClasses(classNode);

    const bodyNode = classNode.childForFieldName('body');
    if (!bodyNode) {
      classes.push({ name: className, bases, fields: [], methods: [], decorators, sourceFile });
      continue;
    }

    const fields = extractClassFields(bodyNode);
    const methods = extractClassMethods(bodyNode);

    classes.push({ name: className, bases, fields, methods, decorators, sourceFile });
  }

  return classes;
}

// ---------------------------------------------------------------------------
// Full file parser
// ---------------------------------------------------------------------------

export interface ParsedPythonFile {
  classes: PythonClass[];
  typeAliases: PythonTypeAlias[];
  allExports: string[];
  sourceFile: string;
}

/** Parse a single Python source file and return all extracted symbols. */
export function parsePythonFile(filePath: string, sdkPath: string): ParsedPythonFile {
  const source = readFileSync(filePath, 'utf-8');
  const relPath = relative(sdkPath, filePath);
  const tree = safeParse(pythonParser, source);

  const classes = extractClassesFromTree(tree, relPath);
  const typeAliases = extractTypeAliases(tree, relPath);
  const allExports = extractAllExports(tree);

  return { classes, typeAliases, allExports, sourceFile: relPath };
}
