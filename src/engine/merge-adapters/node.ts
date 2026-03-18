import type Parser from 'tree-sitter';
import { normalizeJsExtension } from '../../utils/naming.js';
import type { MergeAdapter, MergeStatement, MergeImport, DeepMergeSymbol, MergeMember } from './types.js';

const REEXPORT_PREFIX = '__export:';

function extractDeclName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  if (node.type === 'lexical_declaration') {
    const declarator = node.firstNamedChild;
    if (declarator?.type === 'variable_declarator') {
      const name = declarator.childForFieldName('name');
      if (name) return name.text;
    }
  }

  return null;
}

function extractNodeKey(node: Parser.SyntaxNode): { key: string | null; kind: MergeStatement['kind'] } {
  if (node.type === 'export_statement') {
    const decl = node.childForFieldName('declaration');
    if (decl) {
      return { key: extractDeclName(decl), kind: 'declaration' };
    }

    const source = node.childForFieldName('source');
    if (source) {
      return { key: `${REEXPORT_PREFIX}${normalizeJsExtension(source.text)}`, kind: 'reexport' };
    }

    return { key: null, kind: 'other' };
  }
  return { key: extractDeclName(node), kind: extractDeclName(node) ? 'declaration' : 'other' };
}

function extractClassMembers(classBody: Parser.SyntaxNode, source: string): MergeMember[] {
  const members: MergeMember[] = [];
  for (const child of classBody.namedChildren) {
    if (child.type === 'method_definition') {
      const nameNode = child.childForFieldName('name');
      if (nameNode && nameNode.text !== 'constructor') {
        members.push({ key: nameNode.text, text: source.slice(child.startIndex, child.endIndex) });
      }
    } else if (child.type === 'public_field_definition') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        members.push({ key: nameNode.text, text: source.slice(child.startIndex, child.endIndex) });
      }
    }
  }
  return members;
}

function extractInterfaceMembers(body: Parser.SyntaxNode, source: string): MergeMember[] {
  const members: MergeMember[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'property_signature' || child.type === 'method_signature') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        members.push({ key: nameNode.text, text: source.slice(child.startIndex, child.endIndex) });
      }
    }
  }
  return members;
}

function extractEnumMembers(body: Parser.SyntaxNode, source: string): MergeMember[] {
  const members: MergeMember[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'enum_assignment') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        members.push({ key: nameNode.text, text: source.slice(child.startIndex, child.endIndex) });
      }
    } else if (child.type === 'property_identifier') {
      members.push({ key: child.text, text: source.slice(child.startIndex, child.endIndex) });
    }
  }
  return members;
}

export const nodeMergeAdapter: MergeAdapter = {
  language: 'node',
  grammarModule: 'tree-sitter-typescript/bindings/node/typescript.js',
  normalizeReexport: normalizeJsExtension,
  parseStatements(tree, source) {
    const imports: MergeImport[] = [];
    const importAnchors: string[] = [];
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      if (child.type === 'import_statement') {
        const text = source.slice(child.startIndex, child.endIndex);
        imports.push({ key: normalizeJsExtension(text.trim()), text });
        importAnchors.push(text);
        continue;
      }

      const { key, kind } = extractNodeKey(child);
      statements.push({
        key,
        kind,
        text: source.slice(child.startIndex, child.endIndex),
      });
    }

    return { imports, importAnchors, statements };
  },
  renderImports(imports) {
    return imports.map((entry) => entry.text);
  },
  extractMembers(tree, source) {
    const result = new Map<string, DeepMergeSymbol>();

    for (const child of tree.rootNode.children) {
      if (child.type !== 'export_statement') continue;
      const decl = child.childForFieldName('declaration');
      if (!decl) continue;

      const nameNode = decl.childForFieldName('name');
      if (!nameNode) continue;
      const symbolName = nameNode.text;

      if (decl.type === 'class_declaration') {
        const body = decl.childForFieldName('body');
        if (!body) continue;
        const members = extractClassMembers(body, source);
        result.set(symbolName, { members, bodyEndLine: body.endPosition.row });
      } else if (decl.type === 'interface_declaration') {
        const body = decl.childForFieldName('body');
        if (!body) continue;
        const members = extractInterfaceMembers(body, source);
        result.set(symbolName, { members, bodyEndLine: body.endPosition.row });
      } else if (decl.type === 'enum_declaration') {
        const body = decl.childForFieldName('body');
        if (!body) continue;
        const members = extractEnumMembers(body, source);
        result.set(symbolName, { members, bodyEndLine: body.endPosition.row });
      }
    }

    return result;
  },
};
