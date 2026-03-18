import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement, MergeImport } from './types.js';

function declarationKey(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case 'struct_item':
    case 'enum_item':
    case 'function_item':
    case 'trait_item':
    case 'type_item':
    case 'const_item': {
      return node.childForFieldName('name')?.text ?? null;
    }
    case 'impl_item': {
      const typeName = node.childForFieldName('type')?.text ?? 'unknown';
      const traitName = node.childForFieldName('trait')?.text;
      return traitName ? `impl:${traitName}->${typeName}` : `impl:${typeName}`;
    }
    default:
      return null;
  }
}

export const rustMergeAdapter: MergeAdapter = {
  language: 'rust',
  grammarModule: 'tree-sitter-rust',
  parseStatements(tree, source) {
    const imports: MergeImport[] = [];
    const importAnchors: string[] = [];
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      if (child.type === 'use_declaration') {
        const text = source.slice(child.startIndex, child.endIndex);
        imports.push({ key: text.trim(), text });
        importAnchors.push(text);
        continue;
      }

      const key = declarationKey(child);
      statements.push({
        key,
        kind: key ? 'declaration' : 'other',
        text: source.slice(child.startIndex, child.endIndex),
      });
    }

    return { imports, importAnchors, statements };
  },
  renderImports(imports) {
    return imports.map((entry) => entry.text);
  },
};
