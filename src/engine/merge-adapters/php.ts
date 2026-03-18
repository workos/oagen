import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement } from './types.js';

function extractPhpDeclarationName(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case 'class_declaration':
    case 'interface_declaration':
    case 'trait_declaration':
    case 'enum_declaration':
    case 'function_definition': {
      const nameNode = node.childForFieldName('name');
      return nameNode?.text ?? null;
    }
    case 'namespace_definition': {
      const nameNode = node.childForFieldName('name');
      return nameNode ? `__namespace:${nameNode.text}` : '__namespace:';
    }
    default:
      return null;
  }
}

export const phpMergeAdapter: MergeAdapter = {
  language: 'php',
  grammarModule: 'tree-sitter-php',
  resolveGrammar: (mod) => {
    if (typeof mod === 'object' && mod !== null && 'php' in mod) return (mod as { php: unknown }).php;
    return mod;
  },
  normalizeImport: (text) => text.trim(),
  parseStatements(tree, source) {
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      const declarationName = extractPhpDeclarationName(child);
      const kind: MergeStatement['kind'] =
        child.type === 'namespace_use_declaration'
          ? 'import'
          : declarationName
            ? 'declaration'
            : 'other';

      statements.push({
        key: declarationName,
        kind,
        text: source.slice(child.startIndex, child.endIndex),
      });
    }

    return { statements };
  },
};
