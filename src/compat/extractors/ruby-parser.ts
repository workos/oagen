/**
 * Ruby entity extraction — tree-sitter-based parsing of classes, service modules,
 * and enum modules from Ruby source files.
 */

import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import type { SyntaxNode } from 'tree-sitter';
import type { ApiClass, ApiEnum, ApiMethod, ApiParam, ApiProperty } from '../types.js';
import { safeParse as safeParseWith } from '../../utils/tree-sitter.js';
import { sortRecord } from './shared.js';

// ---------------------------------------------------------------------------
// Shared parser instance
// ---------------------------------------------------------------------------

const rubyParser = new Parser();
rubyParser.setLanguage(Ruby);

function safeParse(source: string): Parser.Tree {
  return safeParseWith(rubyParser, source);
}

// ---------------------------------------------------------------------------
// Public API — called from ruby.ts
// ---------------------------------------------------------------------------

/** Parse a Ruby source string and return all class declarations (excluding service modules). */
export function extractClasses(source: string): ApiClass[] {
  const tree = safeParse(source);
  const classes: ApiClass[] = [];

  // Collect line ranges of service modules so we can skip nested classes
  const serviceModuleNodes = findServiceModulesFromTree(tree.rootNode);
  const serviceRanges = serviceModuleNodes.map((n) => [n.startPosition.row, n.endPosition.row] as [number, number]);

  for (const node of tree.rootNode.descendantsOfType('class')) {
    // Skip singleton_class nodes (class << self)
    if (node.type !== 'class') continue;

    // Skip classes inside service modules
    if (isInsideRanges(node.startPosition.row, serviceRanges)) continue;

    // Skip if this class contains a singleton_class (class << self) — those are service modules
    if (node.descendantsOfType('singleton_class').length > 0) continue;

    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;
    const className = nameNode.text;

    const bodyNode = node.childForFieldName('body');

    const methods: Record<string, ApiMethod[]> = {};
    const properties: Record<string, ApiProperty> = {};
    const constructorParams: ApiParam[] = [];

    // Only extract body content if body exists (single-line classes like `class Foo < Bar; end` may not have a body)
    if (bodyNode) {
      // Extract attr_accessor/attr_reader
      extractAttributes(bodyNode, properties);

      // Extract methods (respecting visibility)
      const extractedMethods = extractMethodsFromBody(bodyNode);
      for (const method of extractedMethods) {
        if (method.name === 'initialize') {
          constructorParams.push(...method.params);
        } else {
          if (!methods[method.name]) methods[method.name] = [];
          methods[method.name].push(method);
        }
      }
    }

    classes.push({
      name: className,
      methods: sortRecord(methods),
      properties: sortRecord(properties),
      constructorParams,
    });
  }

  return classes;
}

/** Extract service modules (modules with `class << self` at immediate depth). */
export function extractServiceModules(source: string): ApiClass[] {
  const tree = safeParse(source);
  const services: ApiClass[] = [];

  for (const moduleNode of findServiceModulesFromTree(tree.rootNode)) {
    const nameNode = moduleNode.childForFieldName('name');
    if (!nameNode) continue;
    const moduleName = nameNode.text;

    const bodyNode = moduleNode.childForFieldName('body');
    if (!bodyNode) continue;

    // Find the singleton_class (class << self) at immediate depth
    const singletonNode = findImmediateSingletonClass(bodyNode);
    if (!singletonNode) continue;

    const singletonBody = singletonNode.childForFieldName('body');
    if (!singletonBody) continue;

    const methods: Record<string, ApiMethod[]> = {};
    const properties: Record<string, ApiProperty> = {};

    // Extract methods from the singleton class body
    const extractedMethods = extractMethodsFromBody(singletonBody);
    for (const method of extractedMethods) {
      if (!methods[method.name]) methods[method.name] = [];
      methods[method.name].push(method);
    }

    // Extract constants as properties
    extractConstantsAsProperties(singletonBody, properties);

    if (Object.keys(methods).length > 0 || Object.keys(properties).length > 0) {
      services.push({
        name: moduleName,
        methods: sortRecord(methods),
        properties: sortRecord(properties),
        constructorParams: [],
      });
    }
  }

  return services;
}

/** Extract enum-like modules (modules with string/number constants, no class << self). */
export function extractEnumModules(source: string): ApiEnum[] {
  const tree = safeParse(source);
  const enums: ApiEnum[] = [];

  const serviceModuleNodes = findServiceModulesFromTree(tree.rootNode);
  const serviceRanges = serviceModuleNodes.map((n) => [n.startPosition.row, n.endPosition.row] as [number, number]);

  for (const node of tree.rootNode.descendantsOfType('module')) {
    // Skip modules inside service modules
    if (isInsideRanges(node.startPosition.row, serviceRanges)) continue;

    // Skip modules that have singleton_class (service modules)
    if (node.descendantsOfType('singleton_class').length > 0) continue;

    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;

    const bodyNode = node.childForFieldName('body');
    if (!bodyNode) continue;

    const constants = extractEnumConstants(bodyNode);
    if (Object.keys(constants).length < 2) continue;

    enums.push({
      name: nameNode.text,
      members: sortRecord(constants),
    });
  }

  return enums;
}

/** Extract autoload declarations to build the export map. */
export function extractAutoloads(source: string): string[] {
  const tree = safeParse(source);
  const names: string[] = [];

  for (const callNode of tree.rootNode.descendantsOfType('call')) {
    const methodNode = callNode.childForFieldName('method');
    if (!methodNode || methodNode.text !== 'autoload') continue;

    const argsNode = callNode.childForFieldName('arguments');
    if (!argsNode) continue;

    // First argument is the symbol name
    const firstArg = argsNode.namedChildren[0];
    if (firstArg && (firstArg.type === 'simple_symbol' || firstArg.type === 'symbol')) {
      names.push(firstArg.text.replace(/^:/, ''));
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// Internal: finding service modules
// ---------------------------------------------------------------------------

/** Find module nodes that have `class << self` at their immediate body level. */
function findServiceModulesFromTree(rootNode: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];

  for (const moduleNode of rootNode.descendantsOfType('module')) {
    const bodyNode = moduleNode.childForFieldName('body');
    if (!bodyNode) continue;

    if (findImmediateSingletonClass(bodyNode)) {
      result.push(moduleNode);
    }
  }

  return result;
}

/** Find a singleton_class (class << self) at the immediate body level (not nested). */
function findImmediateSingletonClass(bodyNode: SyntaxNode): SyntaxNode | null {
  for (const child of bodyNode.namedChildren) {
    if (child.type === 'singleton_class') return child;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal: method extraction with visibility tracking
// ---------------------------------------------------------------------------

/** Extract methods from a body_statement, respecting private/protected/public markers. */
function extractMethodsFromBody(bodyNode: SyntaxNode): ApiMethod[] {
  const methods: ApiMethod[] = [];
  let isPrivate = false;

  for (const child of bodyNode.namedChildren) {
    // Track visibility markers: bare `private`, `public`, `protected` calls
    if (child.type === 'identifier') {
      if (child.text === 'private') {
        isPrivate = true;
        continue;
      }
      if (child.text === 'public') {
        isPrivate = false;
        continue;
      }
      if (child.text === 'protected') {
        isPrivate = true;
        continue;
      }
    }

    if (isPrivate) continue;

    if (child.type === 'method') {
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;

      const params = extractMethodParams(child);
      methods.push({
        name: nameNode.text,
        params,
        returnType: 'Object',
        async: false,
      });
    }
  }

  return methods;
}

/** Extract parameters from a method node. */
function extractMethodParams(methodNode: SyntaxNode): ApiParam[] {
  const paramsNode = methodNode.childForFieldName('parameters');
  if (!paramsNode) return [];

  const params: ApiParam[] = [];

  for (const paramNode of paramsNode.namedChildren) {
    switch (paramNode.type) {
      case 'identifier': {
        // Plain positional argument
        params.push({ name: paramNode.text, type: 'Object', optional: false, passingStyle: 'positional' as const });
        break;
      }
      case 'optional_parameter': {
        // Positional argument with default: name = value
        const nameNode = paramNode.childForFieldName('name');
        if (nameNode) {
          params.push({ name: nameNode.text, type: 'Object', optional: true, passingStyle: 'positional' as const });
        }
        break;
      }
      case 'keyword_parameter': {
        // Keyword argument: name: or name: default
        const nameNode = paramNode.childForFieldName('name');
        if (nameNode) {
          const valueNode = paramNode.childForFieldName('value');
          params.push({
            name: nameNode.text,
            type: 'Object',
            optional: valueNode !== null,
            passingStyle: 'keyword' as const,
          });
        }
        break;
      }
      case 'splat_parameter': {
        // *args — variadic positional
        const nameNode = paramNode.childForFieldName('name');
        params.push({
          name: nameNode ? `*${nameNode.text}` : '*args',
          type: 'Object',
          optional: true,
          passingStyle: 'positional' as const,
        });
        break;
      }
      case 'hash_splat_parameter': {
        // **kwargs — variadic keyword
        const nameNode = paramNode.childForFieldName('name');
        params.push({
          name: nameNode ? `**${nameNode.text}` : '**kwargs',
          type: 'Object',
          optional: true,
          passingStyle: 'keyword' as const,
        });
        break;
      }
      case 'block_parameter': {
        // &block — block argument
        const nameNode = paramNode.childForFieldName('name');
        params.push({
          name: nameNode ? `&${nameNode.text}` : '&block',
          type: 'Object',
          optional: true,
          passingStyle: 'positional' as const,
        });
        break;
      }
      default:
        break;
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Internal: attribute extraction
// ---------------------------------------------------------------------------

/** Extract attr_accessor/attr_reader calls into properties. */
function extractAttributes(bodyNode: SyntaxNode, properties: Record<string, ApiProperty>): void {
  for (const callNode of bodyNode.descendantsOfType('call')) {
    const methodNode = callNode.childForFieldName('method');
    if (!methodNode) continue;
    const methodName = methodNode.text;
    if (methodName !== 'attr_accessor' && methodName !== 'attr_reader') continue;

    const isReadonly = methodName === 'attr_reader';

    const argsNode = callNode.childForFieldName('arguments');
    if (!argsNode) continue;

    for (const argNode of argsNode.namedChildren) {
      if (argNode.type === 'simple_symbol' || argNode.type === 'symbol') {
        const name = argNode.text.replace(/^:/, '');
        properties[name] = { name, type: 'Object', readonly: isReadonly };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: constant extraction
// ---------------------------------------------------------------------------

/** Extract UPPER_CASE constants from a body as readonly properties. */
function extractConstantsAsProperties(bodyNode: SyntaxNode, properties: Record<string, ApiProperty>): void {
  for (const child of bodyNode.namedChildren) {
    if (child.type !== 'assignment') continue;
    const leftNode = child.childForFieldName('left');
    if (!leftNode || leftNode.type !== 'constant') continue;
    const name = leftNode.text;
    if (!/^[A-Z][A-Z_0-9]*$/.test(name)) continue;
    properties[name] = { name, type: 'Object', readonly: true };
  }
}

/** Extract enum-style constants (ConstantName = 'value') from a module body. */
function extractEnumConstants(bodyNode: SyntaxNode): Record<string, string | number> {
  const constants: Record<string, string | number> = {};

  for (const child of bodyNode.namedChildren) {
    if (child.type !== 'assignment') continue;
    const leftNode = child.childForFieldName('left');
    if (!leftNode || leftNode.type !== 'constant') continue;
    const name = leftNode.text;
    if (name === 'ALL') continue; // Skip aggregate constants

    const rightNode = child.childForFieldName('right');
    if (!rightNode) continue;

    const value = extractLiteralValue(rightNode);
    if (value !== undefined) {
      constants[name] = value;
    }
  }

  return constants;
}

/** Extract a literal string or number value from a tree-sitter node. */
function extractLiteralValue(node: SyntaxNode): string | number | undefined {
  if (node.type === 'string' || node.type === 'string_content') {
    // String: strip surrounding quotes
    const text = node.text;
    if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
      return text.slice(1, -1);
    }
    // For string_content (inside a string node), return as-is
    return text;
  }
  if (node.type === 'integer') {
    return Number(node.text);
  }
  if (node.type === 'float') {
    return Number(node.text);
  }
  // For strings, tree-sitter wraps in a `string` node with `string_content` children
  if (node.type === 'string') {
    const contentNode = node.namedChildren.find((c) => c.type === 'string_content');
    if (contentNode) return contentNode.text;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal: tree traversal helpers
// ---------------------------------------------------------------------------

/** Check if a line number falls inside any of the given ranges. */
function isInsideRanges(line: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (line > start && line < end) return true;
  }
  return false;
}

export { sortRecord } from './shared.js';
