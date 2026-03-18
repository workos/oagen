import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement } from './types.js';

function isRequireCall(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'call') return false;
  const method = node.childForFieldName('method');
  if (!method) return false;
  return method.text === 'require' || method.text === 'require_relative';
}

function extractRubyDeclarationName(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'class' && node.type !== 'module') return null;
  const nameNode = node.childForFieldName('name');
  return nameNode?.text ?? null;
}

export const rubyMergeAdapter: MergeAdapter = {
  language: 'ruby',
  grammarModule: 'tree-sitter-ruby',
  normalizeImport: (text) => text.trim(),
  parseStatements(tree, source) {
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      const declarationName = extractRubyDeclarationName(child);
      const kind: MergeStatement['kind'] = isRequireCall(child)
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
