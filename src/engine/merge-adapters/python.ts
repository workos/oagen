import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement, MergeImport, DocstringInfo, SymbolDocstrings } from './types.js';

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

function extractPythonDocstring(bodyNode: Parser.SyntaxNode, source: string): DocstringInfo | null {
  // Python docstrings are the first expression_statement in a body block
  // where the expression is a string literal
  for (const child of bodyNode.namedChildren) {
    if (child.type === 'expression_statement') {
      const expr = child.firstNamedChild;
      if (expr?.type === 'string') {
        const text = source.slice(child.startIndex, child.endIndex);
        return { text, startIndex: child.startIndex, endIndex: child.endIndex };
      }
    }
    // Only the FIRST statement can be a docstring
    break;
  }
  return null;
}

function collectPrecedingPythonComments(children: Parser.SyntaxNode[], index: number, source: string): DocstringInfo | null {
  let lastIdx = -1;
  let firstIdx = -1;
  for (let k = index - 1; k >= 0; k--) {
    const prev = children[k];
    if (prev.type === 'comment') {
      if (lastIdx === -1) lastIdx = k;
      firstIdx = k;
    } else {
      break;
    }
  }
  if (firstIdx === -1) return null;
  const first = children[firstIdx];
  const last = children[lastIdx];
  return { text: source.slice(first.startIndex, last.endIndex), startIndex: first.startIndex, endIndex: last.endIndex };
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
  extractDocstrings(tree, source) {
    const result = new Map<string, SymbolDocstrings>();
    const rootChildren = tree.rootNode.children;

    for (let i = 0; i < rootChildren.length; i++) {
      const child = rootChildren[i];
      const name = extractPythonDeclarationName(child);
      if (!name) continue;

      // Python: class/function docstrings are inside the body, OR use # comments before
      let docstring: DocstringInfo | null = null;
      const body = child.childForFieldName('body');
      if (body) {
        docstring = extractPythonDocstring(body, source);
      }
      // Fallback: check for # comments before the declaration
      if (!docstring) {
        docstring = collectPrecedingPythonComments(rootChildren, i, source);
      }

      const members = new Map<string, { docstring: DocstringInfo | null; declStartIndex: number; declColumn: number }>();

      // Extract method docstrings for classes
      if (child.type === 'class_definition' && body) {
        for (const member of body.namedChildren) {
          if (member.type !== 'function_definition') continue;
          const memberName = member.childForFieldName('name')?.text;
          if (!memberName) continue;

          let memberDoc: DocstringInfo | null = null;
          const memberBody = member.childForFieldName('body');
          if (memberBody) {
            memberDoc = extractPythonDocstring(memberBody, source);
          }

          members.set(memberName, {
            docstring: memberDoc,
            declStartIndex: member.startIndex,
            declColumn: member.startPosition.column,
          });
        }
      }

      result.set(name, {
        docstring,
        declStartIndex: child.startIndex,
        declColumn: child.startPosition.column,
        members,
      });
    }

    return result;
  },
};
