import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement, MergeImport } from './types.js';

function extractPythonDeclarationName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'class_definition' || node.type === 'function_definition') {
    const nameNode = node.childForFieldName('name');
    return nameNode?.text ?? null;
  }

  // Detect `__all__ = [...]` assignments so they get a key and can be deduplicated
  if (node.type === 'expression_statement') {
    const firstChild = node.firstNamedChild;
    if (firstChild?.type === 'assignment') {
      const left = firstChild.childForFieldName('left');
      if (left?.type === 'identifier' && left.text === '__all__') {
        return '__all__';
      }
    }
  }

  return null;
}

export const pythonMergeAdapter: MergeAdapter = {
  language: 'python',
  grammarModule: 'tree-sitter-python',
  parseStatements(tree, source) {
    const imports: MergeImport[] = [];
    const importAnchors: string[] = [];
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      if (child.type === 'import_statement' || child.type === 'import_from_statement') {
        const text = source.slice(child.startIndex, child.endIndex);
        imports.push({ key: text.trim(), text });
        importAnchors.push(text);
        continue;
      }

      const declarationName = extractPythonDeclarationName(child);
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
