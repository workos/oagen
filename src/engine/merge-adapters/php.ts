import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement, MergeImport } from './types.js';

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
  parseStatements(tree, source) {
    const imports: MergeImport[] = [];
    const importAnchors: string[] = [];
    let importInsertionAnchor: string | undefined;
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      if (child.type === 'namespace_definition') {
        importInsertionAnchor = source.slice(child.startIndex, child.endIndex);
      }

      if (child.type === 'namespace_use_declaration') {
        const text = source.slice(child.startIndex, child.endIndex);
        imports.push({ key: text.trim(), text });
        importAnchors.push(text);
        continue;
      }

      const declarationName = extractPhpDeclarationName(child);
      const kind: MergeStatement['kind'] = declarationName ? 'declaration' : 'other';

      statements.push({
        key: declarationName,
        kind,
        text: source.slice(child.startIndex, child.endIndex),
      });
    }

    return { imports, importAnchors, importInsertionAnchor, statements };
  },
  renderImports(imports) {
    return imports.map((entry) => entry.text);
  },
};
