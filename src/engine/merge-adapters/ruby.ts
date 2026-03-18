import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement, MergeImport } from './types.js';

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
  parseStatements(tree, source) {
    const imports: MergeImport[] = [];
    const importAnchors: string[] = [];
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      const declarationName = extractRubyDeclarationName(child);
      if (isRequireCall(child)) {
        const text = source.slice(child.startIndex, child.endIndex);
        imports.push({ key: text.trim(), text });
        importAnchors.push(text);
        continue;
      }

      const kind: MergeStatement['kind'] = declarationName ? 'declaration' : 'other';

      statements.push({
        key: declarationName,
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
