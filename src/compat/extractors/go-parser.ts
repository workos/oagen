/**
 * Go source parser — tree-sitter-based extraction of structs, functions, types,
 * and const blocks from Go source files.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import type { SyntaxNode } from 'tree-sitter';
import { safeParse } from '../../utils/tree-sitter.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface GoStructField {
  name: string;
  type: string;
  jsonTag?: string;
  optional: boolean;
}

export interface GoStruct {
  name: string;
  fields: GoStructField[];
  sourceFile: string;
  packageName: string;
}

export interface GoFunc {
  receiverType: string | null;
  name: string;
  params: { name: string; type: string }[];
  returnTypes: string[];
  sourceFile: string;
  packageName: string;
}

export interface GoConst {
  name: string;
  typeName: string;
  value: string;
  sourceFile: string;
  packageName: string;
}

export interface GoTypeDecl {
  name: string;
  underlyingType: string;
  isAlias: boolean;
  sourceFile: string;
  packageName: string;
}

// ---------------------------------------------------------------------------
// Shared parser instance
// ---------------------------------------------------------------------------

const goParser = new Parser();
goParser.setLanguage(Go);

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

export function walkGoFiles(dir: string): string[] {
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
      if (entry.startsWith('.') || entry === 'vendor' || entry === 'testdata' || entry === 'internal') continue;
      results.push(...walkGoFiles(fullPath));
    } else if (entry.endsWith('.go') && !entry.endsWith('_test.go')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

/** Get the text of a child node by field name, or null. */
function fieldText(node: SyntaxNode, field: string): string | null {
  const child = node.childForFieldName(field);
  return child ? child.text : null;
}

/** Extract the JSON field name from a struct tag. */
function extractJsonTag(tagText: string): { name: string; omitempty: boolean } | null {
  const match = tagText.match(/json:"([^"]*)"/);
  if (!match) return null;
  const parts = match[1].split(',');
  const name = parts[0].trim();
  const omitempty = parts.includes('omitempty');
  if (name === '-') return null;
  return { name, omitempty };
}

/** Render a type node back to its Go source representation. */
function typeNodeText(node: SyntaxNode): string {
  return node.text;
}

// ---------------------------------------------------------------------------
// Struct extraction
// ---------------------------------------------------------------------------

function parseStructFields(structNode: SyntaxNode): GoStructField[] {
  const fields: GoStructField[] = [];
  const fieldList = structNode.namedChildren.find((c) => c.type === 'field_declaration_list');
  if (!fieldList) return fields;

  for (const fieldDecl of fieldList.namedChildren) {
    if (fieldDecl.type !== 'field_declaration') continue;

    // Get all field identifiers (there can be multiple: `A, B int`)
    const nameNodes = fieldDecl.namedChildren.filter((c) => c.type === 'field_identifier');
    if (nameNodes.length === 0) {
      // Embedded field (struct composition) — extract the type name as the field name.
      // e.g., `type Foo struct { Bar }` → field named "Bar" of type "Bar"
      const typeNode = fieldDecl.namedChildren.find(
        (c) => c.type !== 'raw_string_literal' && c.type !== 'interpreted_string_literal',
      );
      if (typeNode) {
        const typeName = typeNode.text.replace(/^\*/, ''); // strip pointer
        if (/^[A-Z]/.test(typeName)) {
          fields.push({
            name: typeName,
            type: typeNode.text,
            optional: false,
          });
        }
      }
      continue;
    }

    // The type node: find the first named child that isn't a field_identifier and isn't a tag
    const typeNode = fieldDecl.namedChildren.find(
      (c) =>
        c.type !== 'field_identifier' && c.type !== 'raw_string_literal' && c.type !== 'interpreted_string_literal',
    );
    if (!typeNode) continue;

    // Only export fields that start with uppercase
    const fieldType = typeNodeText(typeNode);

    // Tag is a raw_string_literal child
    const tagNode = fieldDecl.namedChildren.find(
      (c) => c.type === 'raw_string_literal' || c.type === 'interpreted_string_literal',
    );
    const jsonTag = tagNode ? extractJsonTag(tagNode.text) : null;

    for (const nameNode of nameNodes) {
      const name = nameNode.text;
      if (!/^[A-Z]/.test(name)) continue; // skip unexported
      fields.push({
        name,
        type: fieldType,
        jsonTag: jsonTag?.name || undefined,
        optional: jsonTag?.omitempty || false,
      });
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Type declarations
// ---------------------------------------------------------------------------

export function parseTypeDecls(
  tree: Parser.Tree,
  sourceFile: string,
  packageName: string,
): { structs: GoStruct[]; types: GoTypeDecl[] } {
  const structs: GoStruct[] = [];
  const types: GoTypeDecl[] = [];

  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== 'type_declaration') continue;

    for (const spec of node.namedChildren) {
      const name = fieldText(spec, 'name');
      if (!name || !/^[A-Z]/.test(name)) continue;

      if (spec.type === 'type_spec') {
        const typeNode = spec.childForFieldName('type');
        if (!typeNode) continue;

        if (typeNode.type === 'struct_type') {
          structs.push({ name, fields: parseStructFields(typeNode), sourceFile, packageName });
        } else if (typeNode.type !== 'interface_type') {
          types.push({ name, underlyingType: typeNodeText(typeNode), isAlias: false, sourceFile, packageName });
        }
      } else if (spec.type === 'type_alias') {
        const typeNode = spec.childForFieldName('type');
        if (typeNode) {
          types.push({ name, underlyingType: typeNodeText(typeNode), isAlias: true, sourceFile, packageName });
        }
      }
    }
  }

  return { structs, types };
}

// ---------------------------------------------------------------------------
// Const blocks
// ---------------------------------------------------------------------------

/** Strip surrounding quotes from a string value. */
function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  const convMatch = value.match(/^\w+(?:\.\w+)?\("([^"]*)"\)$/);
  if (convMatch) return convMatch[1];
  return value;
}

export function parseConstBlocks(tree: Parser.Tree, sourceFile: string, packageName: string): GoConst[] {
  const consts: GoConst[] = [];

  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== 'const_declaration') continue;

    let lastType = '';

    for (const spec of node.namedChildren) {
      if (spec.type !== 'const_spec') continue;

      const nameNodes = spec.namedChildren.filter((c) => c.type === 'identifier');
      if (nameNodes.length === 0) continue;
      const constName = nameNodes[0].text;
      if (!/^[A-Z]/.test(constName)) continue;

      // Type field (optional)
      const typeNode = spec.childForFieldName('type');
      if (typeNode) {
        lastType = typeNode.text;
      }

      // Value field
      const valueNode = spec.childForFieldName('value');
      if (valueNode) {
        // expression_list may contain a single value or a call expression
        const valueText = valueNode.text.trim();
        const strippedValue = stripQuotes(valueText);

        // Check for type conversion: TypeName("value") or TypeName(value)
        if (!typeNode) {
          const convMatch = valueText.match(/^([A-Z]\w*)\((.+)\)$/);
          if (convMatch) {
            consts.push({
              name: constName,
              typeName: convMatch[1],
              value: stripQuotes(convMatch[2].trim()),
              sourceFile,
              packageName,
            });
            continue;
          }
        }

        if (lastType) {
          consts.push({ name: constName, typeName: lastType, value: strippedValue, sourceFile, packageName });
        }
      } else if (lastType) {
        // iota continuation — no value node
        consts.push({ name: constName, typeName: lastType, value: constName, sourceFile, packageName });
      }
    }
  }

  return consts;
}

// ---------------------------------------------------------------------------
// Function & method declarations
// ---------------------------------------------------------------------------

function parseParamList(paramListNode: SyntaxNode | null): { name: string; type: string }[] {
  if (!paramListNode) return [];
  const params: { name: string; type: string }[] = [];

  let unnamedIndex = 0;
  for (const paramDecl of paramListNode.namedChildren) {
    if (paramDecl.type !== 'parameter_declaration' && paramDecl.type !== 'variadic_parameter_declaration') continue;

    const nameNode = paramDecl.namedChildren.find((c) => c.type === 'identifier');
    const typeNode = paramDecl.childForFieldName('type');
    if (!typeNode) continue;

    // When Go omits the parameter name (e.g., `func Foo(string, int)`),
    // synthesize a positional name so signature matching doesn't break.
    const name = nameNode ? nameNode.text : `_arg${unnamedIndex++}`;
    params.push({
      name,
      type: typeNodeText(typeNode),
    });
  }
  return params;
}

function parseReturnTypes(resultNode: SyntaxNode | null): string[] {
  if (!resultNode) return [];

  if (resultNode.type === 'parameter_list') {
    // Multiple return values: (Type1, Type2)
    return resultNode.namedChildren
      .filter((c) => c.type === 'parameter_declaration')
      .map((c) => {
        const t = c.childForFieldName('type');
        return t ? typeNodeText(t) : c.text;
      });
  }

  // Single return value
  return [typeNodeText(resultNode)];
}

export function parseFunctions(tree: Parser.Tree, sourceFile: string, packageName: string): GoFunc[] {
  const funcs: GoFunc[] = [];

  for (const node of tree.rootNode.namedChildren) {
    if (node.type === 'function_declaration') {
      const name = fieldText(node, 'name');
      if (!name || !/^[A-Z]/.test(name)) continue;

      funcs.push({
        receiverType: null,
        name,
        params: parseParamList(node.childForFieldName('parameters')),
        returnTypes: parseReturnTypes(node.childForFieldName('result')),
        sourceFile,
        packageName,
      });
    } else if (node.type === 'method_declaration') {
      const name = fieldText(node, 'name');
      if (!name || !/^[A-Z]/.test(name)) continue;

      // Extract receiver type
      const receiverNode = node.childForFieldName('receiver');
      let receiverType: string | null = null;
      if (receiverNode) {
        const paramDecl = receiverNode.namedChildren.find((c) => c.type === 'parameter_declaration');
        if (paramDecl) {
          const typeNode = paramDecl.childForFieldName('type');
          if (typeNode) {
            // Strip pointer: *Foo → Foo
            receiverType = typeNode.text.replace(/^\*/, '');
          }
        }
      }

      funcs.push({
        receiverType,
        name,
        params: parseParamList(node.childForFieldName('parameters')),
        returnTypes: parseReturnTypes(node.childForFieldName('result')),
        sourceFile,
        packageName,
      });
    }
  }
  return funcs;
}

// ---------------------------------------------------------------------------
// Package name extraction
// ---------------------------------------------------------------------------

export function extractPackageName(tree: Parser.Tree): string {
  const pkgClause = tree.rootNode.namedChildren.find((c) => c.type === 'package_clause');
  if (!pkgClause) return 'unknown';
  const nameNode = pkgClause.namedChildren.find((c) => c.type === 'package_identifier');
  return nameNode ? nameNode.text : 'unknown';
}

// ---------------------------------------------------------------------------
// Full file parser
// ---------------------------------------------------------------------------

export interface ParsedGoFile {
  structs: GoStruct[];
  types: GoTypeDecl[];
  funcs: GoFunc[];
  consts: GoConst[];
}

/** Parse a single Go source file and return all extracted symbols. */
export function parseGoFile(filePath: string, sdkPath: string): ParsedGoFile {
  const source = readFileSync(filePath, 'utf-8');
  const relPath = relative(sdkPath, filePath);
  const tree = safeParse(goParser, source);
  const packageName = extractPackageName(tree);

  const { structs, types } = parseTypeDecls(tree, relPath, packageName);
  const funcs = parseFunctions(tree, relPath, packageName);
  const consts = parseConstBlocks(tree, relPath, packageName);

  return { structs, types, funcs, consts };
}
