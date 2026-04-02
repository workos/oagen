/**
 * PHP source parser — tree-sitter-based extraction of classes, interfaces,
 * methods, properties, and constants from PHP source files.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Parser from 'tree-sitter';
import PhpGrammar from 'tree-sitter-php';
import type { SyntaxNode } from 'tree-sitter';
import { safeParse } from '../../utils/tree-sitter.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface PhpParam {
  name: string;
  type: string;
  optional: boolean;
}

export interface PhpMethod {
  name: string;
  visibility: 'public' | 'protected' | 'private';
  isStatic: boolean;
  params: PhpParam[];
  returnType: string;
}

export interface PhpConstant {
  name: string;
  value: string;
}

export interface PhpProperty {
  name: string;
  type: string;
  visibility: 'public' | 'protected' | 'private';
}

export interface PhpClass {
  name: string;
  namespace: string;
  extends: string | null;
  isInterface: boolean;
  methods: PhpMethod[];
  properties: PhpProperty[];
  constants: PhpConstant[];
  resourceAttributes: string[];
  /** True if the class defines its own constructFromResponse method (not inherited). */
  hasCustomConstructor: boolean;
  sourceFile: string;
}

// ---------------------------------------------------------------------------
// Shared parser instance
// ---------------------------------------------------------------------------

const phpParser = new Parser();
phpParser.setLanguage(PhpGrammar.php_only);

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

export function walkPhpFiles(dir: string): string[] {
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
      if (entry.startsWith('.') || entry === 'vendor' || entry === 'tests' || entry === 'test') continue;
      results.push(...walkPhpFiles(fullPath));
    } else if (entry.endsWith('.php')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

interface PhpDocInfo {
  params: Map<string, string>; // $name → type
  returnType: string;
}

function parsePhpDoc(commentText: string): PhpDocInfo {
  const params = new Map<string, string>();
  let returnType = '';

  const lines = commentText.split('\n');
  for (const line of lines) {
    // Match @param type $name
    const paramMatch = line.match(/@param\s+(\S+)\s+\$(\w+)/);
    if (paramMatch) {
      params.set(paramMatch[2], paramMatch[1]);
    }
    // Match @return type
    const returnMatch = line.match(/@return\s+(\S+)/);
    if (returnMatch) {
      returnType = returnMatch[1];
    }
  }

  return { params, returnType };
}

/** Find the doc comment immediately preceding a node. */
function findDocComment(node: SyntaxNode): PhpDocInfo | null {
  // Walk backward through siblings to find comment
  let sibling = node.previousNamedSibling;
  if (sibling && sibling.type === 'comment' && sibling.text.startsWith('/**')) {
    return parsePhpDoc(sibling.text);
  }
  return null;
}

function getVisibility(node: SyntaxNode): 'public' | 'protected' | 'private' {
  for (const child of node.children) {
    if (child.type === 'visibility_modifier') {
      const text = child.text.toLowerCase();
      if (text === 'public') return 'public';
      if (text === 'protected') return 'protected';
      if (text === 'private') return 'private';
    }
  }
  return 'public'; // PHP default
}

function isStaticMethod(node: SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === 'static_modifier') return true;
  }
  return false;
}

/** Parse a PHP array literal to extract string values: ["id", "name", ...] */
function parseArrayLiteral(node: SyntaxNode): string[] {
  const values: string[] = [];
  // In tree-sitter-php, array elements contain encapsed_string → string_content
  // For simple indexed arrays, each array_element_initializer has one encapsed_string
  for (const elemInit of node.descendantsOfType('array_element_initializer')) {
    const strings = elemInit.namedChildren.filter((c) => c.type === 'encapsed_string' || c.type === 'string');
    // For indexed arrays (no =>), there's one string per element
    if (strings.length === 1) {
      const contentNode = strings[0].namedChildren.find((c) => c.type === 'string_content');
      if (contentNode) {
        values.push(contentNode.text);
      }
    }
  }
  return values;
}

/** Extract the name and value from a const_element node. */
function parseConstElement(constElement: SyntaxNode): { name: string; value: string } | null {
  const nameNode = constElement.namedChildren.find((c) => c.type === 'name');
  if (!nameNode) return null;

  const constName = nameNode.text;

  // Skip RESOURCE_ATTRIBUTES and RESPONSE_TO_RESOURCE_KEY (they're arrays, not scalar constants)
  if (constName === 'RESOURCE_ATTRIBUTES' || constName === 'RESPONSE_TO_RESOURCE_KEY') return null;

  // Find the value node (encapsed_string, string, integer, etc.)
  const valueNode = constElement.namedChildren.find((c) => c.type !== 'name');
  if (!valueNode) return null;

  // For string values, extract string_content
  if (valueNode.type === 'encapsed_string') {
    const contentNode = valueNode.namedChildren.find((c) => c.type === 'string_content');
    return { name: constName, value: contentNode ? contentNode.text : '' };
  }
  if (valueNode.type === 'string') {
    const contentNode = valueNode.namedChildren.find((c) => c.type === 'string_content');
    return { name: constName, value: contentNode ? contentNode.text : '' };
  }

  // For other types (integers, etc.), use the raw text
  return { name: constName, value: valueNode.text };
}

// ---------------------------------------------------------------------------
// Method extraction
// ---------------------------------------------------------------------------

function parseMethods(classBody: SyntaxNode): PhpMethod[] {
  const methods: PhpMethod[] = [];

  for (const child of classBody.namedChildren) {
    if (child.type !== 'method_declaration') continue;

    const nameNode = child.childForFieldName('name');
    if (!nameNode) continue;
    const methodName = nameNode.text;

    // Skip magic methods except __construct
    if (methodName.startsWith('__') && methodName !== '__construct') continue;

    const visibility = getVisibility(child);
    const isStatic = isStaticMethod(child);

    // Get PHPDoc info
    const docInfo = findDocComment(child);

    // Parse parameters
    const params: PhpParam[] = [];
    const paramsList = child.childForFieldName('parameters');
    if (paramsList) {
      for (const paramNode of paramsList.namedChildren) {
        if (paramNode.type !== 'simple_parameter') continue;

        const paramNameNode = paramNode.namedChildren.find((c) => c.type === 'variable_name');
        if (!paramNameNode) continue;

        const paramName = paramNameNode.text.replace(/^\$/, '');

        // Check for native type hint
        let paramType = '';
        const typeNode = paramNode.childForFieldName('type');
        if (typeNode) {
          paramType = typeNode.text;
        }
        // Fall back to PHPDoc
        if (!paramType && docInfo) {
          paramType = docInfo.params.get(paramName) || 'mixed';
        }
        if (!paramType) {
          paramType = 'mixed';
        }

        // Check for default value (means optional)
        const defaultNode = paramNode.childForFieldName('default_value');
        const hasDefault = defaultNode !== null;

        params.push({
          name: paramName,
          type: paramType,
          optional: hasDefault,
        });
      }
    }

    // Return type
    let returnType = '';
    const returnTypeNode = child.childForFieldName('return_type');
    if (returnTypeNode) {
      returnType = returnTypeNode.text;
    }
    if (!returnType && docInfo) {
      returnType = docInfo.returnType || 'mixed';
    }
    if (!returnType) {
      returnType = 'mixed';
    }

    methods.push({
      name: methodName,
      visibility,
      isStatic,
      params,
      returnType,
    });
  }

  return methods;
}

// ---------------------------------------------------------------------------
// Property extraction
// ---------------------------------------------------------------------------

function parseProperties(classBody: SyntaxNode): PhpProperty[] {
  const properties: PhpProperty[] = [];

  for (const child of classBody.namedChildren) {
    if (child.type !== 'property_declaration') continue;

    const visibility = getVisibility(child);

    // Get property name from property_element → variable_name
    for (const propElement of child.namedChildren) {
      if (propElement.type !== 'property_element') continue;
      const varNameNode = propElement.namedChildren.find((c) => c.type === 'variable_name');
      if (!varNameNode) continue;

      const propName = varNameNode.text.replace(/^\$/, '');

      // Check for type hint
      let propType = 'mixed';
      const typeNode = child.namedChildren.find(
        (c) =>
          c.type === 'union_type' ||
          c.type === 'named_type' ||
          c.type === 'optional_type' ||
          c.type === 'primitive_type',
      );
      if (typeNode) {
        propType = typeNode.text;
      }

      properties.push({
        name: propName,
        type: propType,
        visibility,
      });
    }
  }

  return properties;
}

// ---------------------------------------------------------------------------
// Constant extraction
// ---------------------------------------------------------------------------

function parseConstants(classBody: SyntaxNode): PhpConstant[] {
  const constants: PhpConstant[] = [];

  for (const child of classBody.namedChildren) {
    if (child.type !== 'const_declaration') continue;

    for (const constElement of child.namedChildren) {
      if (constElement.type !== 'const_element') continue;

      const parsed = parseConstElement(constElement);
      if (parsed) {
        constants.push(parsed);
      }
    }
  }

  return constants;
}

// ---------------------------------------------------------------------------
// Resource attributes extraction
// ---------------------------------------------------------------------------

function parseResourceAttributes(classBody: SyntaxNode): string[] {
  for (const child of classBody.namedChildren) {
    if (child.type !== 'const_declaration') continue;

    for (const constElement of child.namedChildren) {
      if (constElement.type !== 'const_element') continue;

      const nameNode = constElement.namedChildren.find((c) => c.type === 'name');
      if (!nameNode || nameNode.text !== 'RESOURCE_ATTRIBUTES') continue;

      const arrayNode = constElement.namedChildren.find((c) => c.type === 'array_creation_expression');
      if (!arrayNode) continue;

      return parseArrayLiteral(arrayNode);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Namespace extraction
// ---------------------------------------------------------------------------

function extractNamespace(tree: Parser.Tree): string {
  for (const node of tree.rootNode.namedChildren) {
    if (node.type === 'namespace_definition') {
      const nameNode = node.childForFieldName('name');
      return nameNode ? nameNode.text : '';
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Class/interface extraction
// ---------------------------------------------------------------------------

function parseClassDeclarations(tree: Parser.Tree, sourceFile: string, namespace: string): PhpClass[] {
  const classes: PhpClass[] = [];

  for (const node of tree.rootNode.descendantsOfType('class_declaration')) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;

    // Check for extends
    let extendsName: string | null = null;
    const baseClause = node.namedChildren.find((c) => c.type === 'base_clause');
    if (baseClause) {
      const baseNameNode = baseClause.namedChildren.find((c) => c.type === 'name' || c.type === 'qualified_name');
      if (baseNameNode) {
        // Strip leading backslash and namespace qualifiers for base name
        const fullName = baseNameNode.text.replace(/^\\/, '');
        const parts = fullName.split('\\');
        extendsName = parts[parts.length - 1];
      }
    }

    const bodyNode = node.childForFieldName('body');
    if (!bodyNode) continue;

    const methods = parseMethods(bodyNode);
    const properties = parseProperties(bodyNode);
    const constants = parseConstants(bodyNode);
    const resourceAttributes = parseResourceAttributes(bodyNode);

    const hasCustomConstructor = methods.some((m) => m.name === 'constructFromResponse' && m.isStatic);

    classes.push({
      name: nameNode.text,
      namespace,
      extends: extendsName,
      isInterface: false,
      methods,
      properties,
      constants,
      resourceAttributes,
      hasCustomConstructor,
      sourceFile,
    });
  }

  return classes;
}

function parseInterfaceDeclarations(tree: Parser.Tree, sourceFile: string, namespace: string): PhpClass[] {
  const interfaces: PhpClass[] = [];

  for (const node of tree.rootNode.descendantsOfType('interface_declaration')) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;

    const bodyNode = node.childForFieldName('body');
    if (!bodyNode) continue;

    const methods = parseMethods(bodyNode);

    interfaces.push({
      name: nameNode.text,
      namespace,
      extends: null,
      isInterface: true,
      methods,
      properties: [],
      constants: [],
      resourceAttributes: [],
      hasCustomConstructor: false,
      sourceFile,
    });
  }

  return interfaces;
}

// ---------------------------------------------------------------------------
// PHP 8.1 enum extraction
// ---------------------------------------------------------------------------

function parseEnumDeclarations(tree: Parser.Tree, sourceFile: string, namespace: string): PhpClass[] {
  const enums: PhpClass[] = [];

  for (const node of tree.rootNode.descendantsOfType('enum_declaration')) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;

    const bodyNode = node.childForFieldName('body');
    if (!bodyNode) continue;

    // Extract enum cases as constants
    const constants: PhpConstant[] = [];
    for (const child of bodyNode.namedChildren) {
      if (child.type !== 'enum_case') continue;
      const caseNameNode = child.childForFieldName('name');
      if (!caseNameNode) continue;

      // Get the value (backed enum): case Foo = 'foo'
      let value = caseNameNode.text;
      const valueNode = child.namedChildren.find(
        (c) => c.type === 'encapsed_string' || c.type === 'string' || c.type === 'integer',
      );
      if (valueNode) {
        const contentNode = valueNode.namedChildren.find((c) => c.type === 'string_content');
        value = contentNode ? contentNode.text : valueNode.text;
      }

      constants.push({ name: caseNameNode.text, value });
    }

    const methods = parseMethods(bodyNode);

    enums.push({
      name: nameNode.text,
      namespace,
      extends: null,
      isInterface: false,
      methods,
      properties: [],
      constants,
      resourceAttributes: [],
      hasCustomConstructor: false,
      sourceFile,
    });
  }

  return enums;
}

// ---------------------------------------------------------------------------
// Full file parser
// ---------------------------------------------------------------------------

export interface ParsedPhpFile {
  classes: PhpClass[];
}

/** Parse a single PHP source file and return all extracted symbols. */
export function parsePhpFile(filePath: string, sdkPath: string): ParsedPhpFile {
  const source = readFileSync(filePath, 'utf-8');
  const relPath = relative(sdkPath, filePath);
  const tree = safeParse(phpParser, source);
  const namespace = extractNamespace(tree);

  const classDecls = parseClassDeclarations(tree, relPath, namespace);
  const interfaceDecls = parseInterfaceDeclarations(tree, relPath, namespace);
  const enumDecls = parseEnumDeclarations(tree, relPath, namespace);

  return {
    classes: [...classDecls, ...interfaceDecls, ...enumDecls],
  };
}
