import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement, MergeImport, DocstringInfo, SymbolDocstrings } from './types.js';

function lastIdentifier(text: string): string | null {
  const matches = [...text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)];
  return matches.length > 0 ? matches[matches.length - 1]![0] : null;
}

function receiverKey(node: Parser.SyntaxNode): string | null {
  const receiver = node.childForFieldName('receiver');
  if (!receiver) return null;
  return lastIdentifier(receiver.text);
}

function declarationKey(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case 'package_clause': {
      const pkg = lastIdentifier(node.text);
      return pkg ? `__package:${pkg}` : '__package:';
    }
    case 'type_declaration': {
      const spec = node.firstNamedChild?.type === 'type_spec' ? node.firstNamedChild : node.namedChildren[0];
      const nameNode = spec?.childForFieldName('name');
      return nameNode?.text ?? null;
    }
    case 'function_declaration': {
      return node.childForFieldName('name')?.text ?? null;
    }
    case 'method_declaration': {
      const name = node.childForFieldName('name')?.text ?? null;
      const receiver = receiverKey(node);
      return name && receiver ? `method:${receiver}.${name}` : name;
    }
    case 'const_declaration':
    case 'var_declaration': {
      return node.text.split(/\s+/).slice(0, 3).join(' ');
    }
    default:
      return null;
  }
}

function importEntries(node: Parser.SyntaxNode, source: string): MergeImport[] {
  const entries: MergeImport[] = [];

  const collect = (spec: Parser.SyntaxNode): void => {
    const path = spec.childForFieldName('path')?.text ?? spec.text;
    const name = spec.childForFieldName('name')?.text ?? '';
    const text = source.slice(spec.startIndex, spec.endIndex);
    entries.push({
      key: `${name}:${path.replace(/^"|"$/g, '')}`,
      text,
    });
  };

  for (const child of node.namedChildren) {
    if (child.type === 'import_spec') {
      collect(child);
      continue;
    }
    if (child.type === 'import_spec_list') {
      for (const spec of child.namedChildren) {
        if (spec.type === 'import_spec') collect(spec);
      }
    }
  }

  return entries;
}

function collectPrecedingGoComments(children: Parser.SyntaxNode[], index: number, source: string): DocstringInfo | null {
  let lastIdx = -1;
  let firstIdx = -1;
  for (let k = index - 1; k >= 0; k--) {
    const prev = children[k];
    if (prev.type === 'comment') {
      const text = source.slice(prev.startIndex, prev.endIndex);
      if (text.startsWith('//')) {
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

export const goMergeAdapter: MergeAdapter = {
  language: 'go',
  grammarModule: 'tree-sitter-go',
  parseStatements(tree, source) {
    const imports: MergeImport[] = [];
    const importAnchors: string[] = [];
    let importInsertionAnchor: string | undefined;
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      if (child.type === 'package_clause') {
        importInsertionAnchor = source.slice(child.startIndex, child.endIndex);
      }

      if (child.type === 'import_declaration') {
        imports.push(...importEntries(child, source));
        importAnchors.push(source.slice(child.startIndex, child.endIndex));
        continue;
      }

      const key = declarationKey(child);
      statements.push({
        key,
        kind: key ? 'declaration' : 'other',
        text: source.slice(child.startIndex, child.endIndex),
      });
    }

    return { imports, importAnchors, importInsertionAnchor, statements };
  },
  renderImports(imports) {
    if (imports.length === 0) return [];
    if (imports.length === 1) return [`import ${imports[0]!.text}`];
    return [`import (\n${imports.map((entry) => `  ${entry.text}`).join('\n')}\n)`];
  },
  extractDocstrings(tree, source) {
    const result = new Map<string, SymbolDocstrings>();
    const rootChildren = tree.rootNode.children;

    for (let i = 0; i < rootChildren.length; i++) {
      const child = rootChildren[i];
      const key = declarationKey(child);
      if (!key || key.startsWith('__package:')) continue;

      const docstring = collectPrecedingGoComments(rootChildren, i, source);
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
