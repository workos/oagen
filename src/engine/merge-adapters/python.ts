import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement } from './types.js';

function extractPythonDeclarationName(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'class_definition' && node.type !== 'function_definition') return null;
  const nameNode = node.childForFieldName('name');
  return nameNode?.text ?? null;
}

export const pythonMergeAdapter: MergeAdapter = {
  language: 'python',
  grammarModule: 'tree-sitter-python',
  normalizeImport: (text) => text.trim(),
  parseStatements(tree, source) {
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      const declarationName = extractPythonDeclarationName(child);
      const kind: MergeStatement['kind'] =
        child.type === 'import_statement' || child.type === 'import_from_statement'
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
