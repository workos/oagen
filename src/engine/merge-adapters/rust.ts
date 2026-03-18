import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement, MergeImport, DocstringInfo, SymbolDocstrings } from './types.js';

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

function collectPrecedingRustDocComments(children: Parser.SyntaxNode[], index: number, source: string): DocstringInfo | null {
  let lastIdx = -1;
  let firstIdx = -1;
  for (let k = index - 1; k >= 0; k--) {
    const prev = children[k];
    if (prev.type === 'line_comment') {
      const text = source.slice(prev.startIndex, prev.endIndex);
      if (text.startsWith('///')) {
        if (lastIdx === -1) lastIdx = k;
        firstIdx = k;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  if (firstIdx === -1) return null;
  const first = children[firstIdx];
  const last = children[lastIdx];
  return { text: source.slice(first.startIndex, last.endIndex), startIndex: first.startIndex, endIndex: last.endIndex };
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
  extractDocstrings(tree, source) {
    const result = new Map<string, SymbolDocstrings>();
    const rootChildren = tree.rootNode.children;

    for (let i = 0; i < rootChildren.length; i++) {
      const child = rootChildren[i];
      const key = declarationKey(child);
      if (!key) continue;

      const docstring = collectPrecedingRustDocComments(rootChildren, i, source);
      result.set(key, {
        docstring,
        declStartIndex: child.startIndex,
        declColumn: child.startPosition.column,
        members: new Map(),
      });
    }

    return result;
  },
};
