import type Parser from 'tree-sitter';
import { normalizeJsExtension } from '../../utils/naming.js';
import type { MergeAdapter, MergeStatement, MergeImport } from './types.js';

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
};
