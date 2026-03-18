/**
 * Rust source parser — tree-sitter-based extraction of structs, enums,
 * impl blocks, traits, type aliases, and functions from Rust source files.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Parser from 'tree-sitter';
import RustLang from 'tree-sitter-rust';
import type { SyntaxNode } from 'tree-sitter';
import { safeParse } from '../../utils/tree-sitter.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface RustStructField {
  name: string;
  type: string;
  serdeRename?: string;
  optional: boolean;
}

export interface RustStruct {
  name: string;
  fields: RustStructField[];
  sourceFile: string;
}

export interface RustEnum {
  name: string;
  variants: RustEnumVariant[];
  sourceFile: string;
}

export interface RustEnumVariant {
  name: string;
  serdeRename?: string;
}

export interface RustFunc {
  receiverType: string | null;
  name: string;
  params: { name: string; type: string }[];
  returnType: string;
  isAsync: boolean;
  sourceFile: string;
}

export interface RustTypeAlias {
  name: string;
  underlyingType: string;
  sourceFile: string;
}

export interface RustTrait {
  name: string;
  methods: RustFunc[];
  sourceFile: string;
}

// ---------------------------------------------------------------------------
// Shared parser instance
// ---------------------------------------------------------------------------

const rustParser = new Parser();
rustParser.setLanguage(RustLang);

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

export function walkRustFiles(dir: string): string[] {
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
      if (entry.startsWith('.') || entry === 'target' || entry === 'benches' || entry === 'examples') continue;
      results.push(...walkRustFiles(fullPath));
    } else if (entry.endsWith('.rs') && !entry.endsWith('_test.rs')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Serde attribute helpers
// ---------------------------------------------------------------------------

/** Extract the serde rename value from an attribute_item preceding a node. */
function extractSerdeRename(attributeNode: SyntaxNode): string | null {
  const attr = attributeNode.namedChildren.find((c) => c.type === 'attribute');
  if (!attr) return null;

  const ident = attr.namedChildren.find((c) => c.type === 'identifier');
  if (!ident || ident.text !== 'serde') return null;

  const tokenTree = attr.namedChildren.find((c) => c.type === 'token_tree');
  if (!tokenTree) return null;

  const renameIdent = tokenTree.namedChildren.find((c) => c.type === 'identifier' && c.text === 'rename');
  if (!renameIdent) return null;

  const strLit = tokenTree.namedChildren.find((c) => c.type === 'string_literal');
  if (!strLit) return null;

  const content = strLit.namedChildren.find((c) => c.type === 'string_content');
  return content ? content.text : null;
}

/** Check if a node is preceded by a serde(skip) or serde(skip_serializing) attribute. */
function hasSerdeSkip(attributeNode: SyntaxNode): boolean {
  const attr = attributeNode.namedChildren.find((c) => c.type === 'attribute');
  if (!attr) return false;

  const ident = attr.namedChildren.find((c) => c.type === 'identifier');
  if (!ident || ident.text !== 'serde') return false;

  const tokenTree = attr.namedChildren.find((c) => c.type === 'token_tree');
  if (!tokenTree) return false;

  return tokenTree.namedChildren.some(
    (c) => c.type === 'identifier' && (c.text === 'skip' || c.text === 'skip_serializing'),
  );
}

/** Check if a type is Option<T> and return the inner type. */
function isOptionType(typeText: string): boolean {
  return typeText.startsWith('Option<') && typeText.endsWith('>');
}

/** Check if a node has `pub` visibility. */
function isPublic(node: SyntaxNode): boolean {
  return node.namedChildren.some((c) => c.type === 'visibility_modifier');
}

// ---------------------------------------------------------------------------
// Struct extraction
// ---------------------------------------------------------------------------

function parseStructFields(bodyNode: SyntaxNode): RustStructField[] {
  const fields: RustStructField[] = [];
  let pendingAttr: SyntaxNode | null = null;

  for (const child of bodyNode.namedChildren) {
    if (child.type === 'attribute_item') {
      pendingAttr = child;
      continue;
    }

    if (child.type === 'field_declaration') {
      // Skip non-pub fields
      if (!isPublic(child)) {
        pendingAttr = null;
        continue;
      }

      // Skip serde(skip) fields
      if (pendingAttr && hasSerdeSkip(pendingAttr)) {
        pendingAttr = null;
        continue;
      }

      const nameNode = child.namedChildren.find((c) => c.type === 'field_identifier');
      const typeNode = child.childForFieldName('type');
      if (!nameNode || !typeNode) {
        pendingAttr = null;
        continue;
      }

      const fieldName = nameNode.text;
      const fieldType = typeNode.text;
      const serdeRename = pendingAttr ? extractSerdeRename(pendingAttr) : null;

      fields.push({
        name: fieldName,
        type: fieldType,
        serdeRename: serdeRename || undefined,
        optional: isOptionType(fieldType),
      });

      pendingAttr = null;
    } else {
      pendingAttr = null;
    }
  }
  return fields;
}

export function parseStructs(tree: Parser.Tree, sourceFile: string): RustStruct[] {
  const structs: RustStruct[] = [];

  for (const node of tree.rootNode.descendantsOfType('struct_item')) {
    if (!isPublic(node)) continue;

    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;

    const bodyNode = node.childForFieldName('body');
    if (!bodyNode || bodyNode.type !== 'field_declaration_list') {
      // Tuple struct or unit struct — no named fields
      structs.push({ name: nameNode.text, fields: [], sourceFile });
      continue;
    }

    structs.push({ name: nameNode.text, fields: parseStructFields(bodyNode), sourceFile });
  }

  return structs;
}

// ---------------------------------------------------------------------------
// Enum extraction
// ---------------------------------------------------------------------------

export function parseEnums(tree: Parser.Tree, sourceFile: string): RustEnum[] {
  const enums: RustEnum[] = [];

  for (const node of tree.rootNode.descendantsOfType('enum_item')) {
    if (!isPublic(node)) continue;

    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;

    const bodyNode = node.childForFieldName('body');
    if (!bodyNode) continue;

    const variants: RustEnumVariant[] = [];
    let pendingAttr: SyntaxNode | null = null;

    for (const child of bodyNode.namedChildren) {
      if (child.type === 'attribute_item') {
        pendingAttr = child;
        continue;
      }
      if (child.type === 'enum_variant') {
        const variantName = child.childForFieldName('name');
        if (variantName) {
          const serdeRename = pendingAttr ? extractSerdeRename(pendingAttr) : null;
          variants.push({ name: variantName.text, serdeRename: serdeRename || undefined });
        }
        pendingAttr = null;
      } else {
        pendingAttr = null;
      }
    }

    if (variants.length > 0) {
      enums.push({ name: nameNode.text, variants, sourceFile });
    }
  }

  return enums;
}

// ---------------------------------------------------------------------------
// Impl & function extraction
// ---------------------------------------------------------------------------

function parseParams(paramsNode: SyntaxNode): { name: string; type: string }[] {
  const params: { name: string; type: string }[] = [];

  for (const child of paramsNode.namedChildren) {
    if (child.type === 'self_parameter') continue; // skip &self, &mut self

    if (child.type === 'parameter') {
      const patternNode = child.childForFieldName('pattern');
      const typeNode = child.childForFieldName('type');
      if (patternNode && typeNode) {
        params.push({ name: patternNode.text, type: typeNode.text });
      }
    }
  }

  return params;
}

function extractReturnType(funcNode: SyntaxNode): string {
  const retNode = funcNode.childForFieldName('return_type');
  if (!retNode) return '()';
  return retNode.text;
}

function isAsyncFunc(funcNode: SyntaxNode): boolean {
  return funcNode.namedChildren.some((c) => c.type === 'function_modifiers' && c.text.includes('async'));
}

export function parseImplBlocks(tree: Parser.Tree, sourceFile: string): RustFunc[] {
  const funcs: RustFunc[] = [];

  for (const implNode of tree.rootNode.descendantsOfType('impl_item')) {
    const typeNode = implNode.childForFieldName('type');
    if (!typeNode) continue;
    const receiverType = typeNode.text;

    const bodyNode = implNode.childForFieldName('body');
    if (!bodyNode) continue;

    for (const child of bodyNode.namedChildren) {
      if (child.type !== 'function_item') continue;
      if (!isPublic(child)) continue;

      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;

      const paramsNode = child.childForFieldName('parameters');

      funcs.push({
        receiverType,
        name: nameNode.text,
        params: paramsNode ? parseParams(paramsNode) : [],
        returnType: extractReturnType(child),
        isAsync: isAsyncFunc(child),
        sourceFile,
      });
    }
  }

  return funcs;
}

// ---------------------------------------------------------------------------
// Trait extraction
// ---------------------------------------------------------------------------

export function parseTraits(tree: Parser.Tree, sourceFile: string): RustTrait[] {
  const traits: RustTrait[] = [];

  for (const traitNode of tree.rootNode.descendantsOfType('trait_item')) {
    if (!isPublic(traitNode)) continue;

    const nameNode = traitNode.childForFieldName('name');
    if (!nameNode) continue;

    const bodyNode = traitNode.childForFieldName('body');
    if (!bodyNode) continue;

    const methods: RustFunc[] = [];

    for (const child of bodyNode.namedChildren) {
      // Trait methods appear as function_signature_item (no body)
      if (child.type !== 'function_signature_item' && child.type !== 'function_item') continue;

      const methodName = child.childForFieldName('name');
      if (!methodName) continue;

      const paramsNode = child.childForFieldName('parameters');

      methods.push({
        receiverType: null,
        name: methodName.text,
        params: paramsNode ? parseParams(paramsNode) : [],
        returnType: extractReturnType(child),
        isAsync: isAsyncFunc(child),
        sourceFile,
      });
    }

    if (methods.length > 0) {
      traits.push({ name: nameNode.text, methods, sourceFile });
    }
  }

  return traits;
}

// ---------------------------------------------------------------------------
// Type alias extraction
// ---------------------------------------------------------------------------

export function parseTypeAliases(tree: Parser.Tree, sourceFile: string): RustTypeAlias[] {
  const aliases: RustTypeAlias[] = [];

  for (const node of tree.rootNode.descendantsOfType('type_item')) {
    if (!isPublic(node)) continue;

    const nameNode = node.childForFieldName('name');
    const typeNode = node.childForFieldName('type');
    if (!nameNode || !typeNode) continue;

    aliases.push({ name: nameNode.text, underlyingType: typeNode.text, sourceFile });
  }

  return aliases;
}

// ---------------------------------------------------------------------------
// Full file parser
// ---------------------------------------------------------------------------

export interface ParsedRustFile {
  structs: RustStruct[];
  enums: RustEnum[];
  funcs: RustFunc[];
  traits: RustTrait[];
  typeAliases: RustTypeAlias[];
}

export function parseRustFile(filePath: string, sdkPath: string): ParsedRustFile {
  const source = readFileSync(filePath, 'utf-8');
  const relPath = relative(sdkPath, filePath);
  const tree = safeParse(rustParser, source);

  return {
    structs: parseStructs(tree, relPath),
    enums: parseEnums(tree, relPath),
    funcs: parseImplBlocks(tree, relPath),
    traits: parseTraits(tree, relPath),
    typeAliases: parseTypeAliases(tree, relPath),
  };
}
