import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement, MergeImport, DocstringInfo, SymbolDocstrings } from './types.js';

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

function collectPrecedingRubyComments(children: Parser.SyntaxNode[], index: number, source: string): DocstringInfo | null {
  let lastIdx = -1;
  let firstIdx = -1;
  for (let k = index - 1; k >= 0; k--) {
    const prev = children[k];
    const nodeType = (prev as any).grammarType ?? prev.type;
    if (nodeType === 'comment') {
      const text = source.slice(prev.startIndex, prev.endIndex);
      if (text.startsWith('#')) {
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
  extractDocstrings(tree, source) {
    const result = new Map<string, SymbolDocstrings>();
    const rootChildren = tree.rootNode.children;

    for (let i = 0; i < rootChildren.length; i++) {
      const child = rootChildren[i];
      const name = extractRubyDeclarationName(child);
      if (!name) continue;

      const docstring = collectPrecedingRubyComments(rootChildren, i, source);
      const members = new Map<string, { docstring: DocstringInfo | null; declStartIndex: number; declColumn: number }>();

      // Ruby class/module bodies: comments may appear in class children
      // (before body_statement) or in body_statement children (between methods)
      if (child.type === 'class' || child.type === 'module') {
        const allClassChildren = child.children;
        const body = child.childForFieldName('body');

        // Check for comment before body_statement in class children
        // (docstring for the first method)
        let firstMethodDocFromClass: DocstringInfo | null = null;
        for (let j = 0; j < allClassChildren.length; j++) {
          if (allClassChildren[j] === body || allClassChildren[j].type === 'body_statement') {
            firstMethodDocFromClass = collectPrecedingRubyComments(allClassChildren, j, source);
            break;
          }
        }

        if (body) {
          const bodyChildren = body.children;
          let firstMethodHandled = false;
          for (let j = 0; j < bodyChildren.length; j++) {
            const member = bodyChildren[j];
            if (member.type !== 'method') continue;
            const memberName = member.childForFieldName('name')?.text;
            if (!memberName) continue;

            let memberDoc: DocstringInfo | null;
            if (!firstMethodHandled && firstMethodDocFromClass) {
              memberDoc = firstMethodDocFromClass;
              firstMethodHandled = true;
            } else {
              memberDoc = collectPrecedingRubyComments(bodyChildren, j, source);
              firstMethodHandled = true;
            }

            members.set(memberName, {
              docstring: memberDoc,
              declStartIndex: member.startIndex,
              declColumn: member.startPosition.column,
            });
          }
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
