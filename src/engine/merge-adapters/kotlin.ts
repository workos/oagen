import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement, MergeImport, DocstringInfo, SymbolDocstrings } from './types.js';

function extractDeclarationName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'class_declaration') {
    // Handles class, data class, enum class, etc.
    const nameNode = node.children.find((c) => c.type === 'type_identifier');
    return nameNode?.text ?? null;
  }
  if (node.type === 'function_declaration') {
    const nameNode = node.children.find((c) => c.type === 'simple_identifier');
    return nameNode?.text ?? null;
  }
  if (node.type === 'object_declaration') {
    const nameNode = node.children.find((c) => c.type === 'type_identifier');
    return nameNode?.text ?? null;
  }
  if (node.type === 'type_alias') {
    const nameNode = node.children.find((c) => c.type === 'type_identifier');
    return nameNode?.text ?? null;
  }
  if (node.type === 'property_declaration') {
    const nameNode = node.children.find((c) => c.type === 'variable_declaration');
    if (nameNode) {
      const id = nameNode.children.find((c) => c.type === 'simple_identifier');
      return id?.text ?? null;
    }
  }
  return null;
}

function findPrecedingKdoc(children: Parser.SyntaxNode[], index: number, source: string): DocstringInfo | null {
  for (let k = index - 1; k >= 0; k--) {
    const prev = children[k];
    if (prev.type === 'multiline_comment') {
      const text = source.slice(prev.startIndex, prev.endIndex);
      if (text.startsWith('/**')) {
        return { text, startIndex: prev.startIndex, endIndex: prev.endIndex };
      }
      return null;
    }
    if (prev.type === 'line_comment') continue;
    return null;
  }
  return null;
}

export const kotlinMergeAdapter: MergeAdapter = {
  language: 'kotlin',
  grammarModule: 'tree-sitter-kotlin',
  testFilePatterns: [/Test\.kt$/],
  parseStatements(tree, source) {
    const imports: MergeImport[] = [];
    const importAnchors: string[] = [];
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'multiline_comment' || child.type === 'line_comment') continue;

      if (child.type === 'import_list') {
        const fullText = source.slice(child.startIndex, child.endIndex);
        importAnchors.push(fullText);
        for (const imp of child.namedChildren) {
          if (imp.type === 'import_header') {
            const text = source.slice(imp.startIndex, imp.endIndex).trim();
            // Key on the full import path
            const idNode = imp.children.find((c) => c.type === 'identifier');
            const key = idNode?.text ?? text;
            imports.push({ key, text });
          }
        }
        continue;
      }

      const name = extractDeclarationName(child);
      statements.push({
        key: name,
        kind: name ? 'declaration' : 'other',
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
      const name = extractDeclarationName(child);
      if (!name) continue;

      const docstring = findPrecedingKdoc(rootChildren, i, source);
      const members = new Map<
        string,
        { docstring: DocstringInfo | null; declStartIndex: number; declColumn: number }
      >();

      // Extract member docstrings for classes
      if (child.type === 'class_declaration') {
        const body = child.children.find((c) => c.type === 'class_body' || c.type === 'enum_class_body');
        if (body) {
          const bodyChildren = body.children;
          for (let j = 0; j < bodyChildren.length; j++) {
            const member = bodyChildren[j];
            const memberName = extractDeclarationName(member);
            if (!memberName) continue;
            const memberDoc = findPrecedingKdoc(bodyChildren, j, source);
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
