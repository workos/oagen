import type Parser from 'tree-sitter';
import type { MergeAdapter, MergeStatement, MergeImport, DocstringInfo, SymbolDocstrings } from './types.js';
import { extractUrlFingerprint } from './url-fingerprint.js';

const DOTNET_URL_FINGERPRINT_CONFIG = {
  stringNodeTypes: ['string_literal', 'interpolated_string_expression'],
  contentNodeTypes: ['string_content', 'string_literal_content'],
  interpolationNodeTypes: ['interpolation'],
};

const DECLARATION_TYPES = new Set([
  'class_declaration',
  'struct_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
]);

function extractDeclarationName(node: Parser.SyntaxNode): string | null {
  if (DECLARATION_TYPES.has(node.type)) {
    const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'identifier');
    return nameNode?.text ?? null;
  }
  if (node.type === 'namespace_declaration' || node.type === 'file_scoped_namespace_declaration') {
    const nameNode =
      node.children.find((c) => c.type === 'qualified_name') ?? node.children.find((c) => c.type === 'identifier');
    return nameNode ? `__namespace:${nameNode.text}` : null;
  }
  return null;
}

function collectPrecedingXmlDocComments(
  children: Parser.SyntaxNode[],
  index: number,
  source: string,
): DocstringInfo | null {
  let lastIdx = -1;
  let firstIdx = -1;
  for (let k = index - 1; k >= 0; k--) {
    const prev = children[k];
    if (prev.type === 'comment') {
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

/**
 * Collect declarations from a list of sibling nodes (root level or namespace body).
 */
function collectDeclarations(
  children: Parser.SyntaxNode[],
  source: string,
  statements: MergeStatement[],
  imports: MergeImport[],
  importAnchors: string[],
  importInsertionAnchor: { value?: string },
): void {
  for (const child of children) {
    if (child.type === 'comment') continue;

    if (child.type === 'using_directive') {
      const text = source.slice(child.startIndex, child.endIndex);
      imports.push({ key: text.trim(), text });
      importAnchors.push(text);
      continue;
    }

    if (child.type === 'file_scoped_namespace_declaration') {
      importInsertionAnchor.value = source.slice(child.startIndex, child.endIndex);
      // File-scoped namespace: subsequent declarations are siblings at root
      continue;
    }

    if (child.type === 'namespace_declaration') {
      importInsertionAnchor.value = source.slice(child.startIndex, child.endIndex);
      // Block namespace: recurse into declaration_list
      const body = child.children.find((c) => c.type === 'declaration_list');
      if (body) {
        collectDeclarations(body.namedChildren, source, statements, imports, importAnchors, importInsertionAnchor);
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
}

export const dotnetMergeAdapter: MergeAdapter = {
  language: 'dotnet',
  grammarModule: 'tree-sitter-c-sharp',
  testFilePatterns: [/Tests?\.cs$/],
  urlFingerprintConfig: DOTNET_URL_FINGERPRINT_CONFIG,
  parseStatements(tree, source) {
    const imports: MergeImport[] = [];
    const importAnchors: string[] = [];
    const statements: MergeStatement[] = [];
    const importInsertionAnchor: { value?: string } = {};

    collectDeclarations(tree.rootNode.children, source, statements, imports, importAnchors, importInsertionAnchor);

    return {
      imports,
      importAnchors,
      importInsertionAnchor: importInsertionAnchor.value,
      statements,
    };
  },
  renderImports(imports) {
    return imports.map((entry) => entry.text);
  },
  extractDocstrings(tree, source) {
    const result = new Map<string, SymbolDocstrings>();

    function processChildren(children: Parser.SyntaxNode[]): void {
      for (let i = 0; i < children.length; i++) {
        const child = children[i];

        // Recurse into namespaces
        if (child.type === 'namespace_declaration') {
          const body = child.children.find((c) => c.type === 'declaration_list');
          if (body) processChildren(body.children);
          continue;
        }

        const name = extractDeclarationName(child);
        if (!name || name.startsWith('__namespace:')) continue;

        const docstring = collectPrecedingXmlDocComments(children, i, source);
        const members = new Map<
          string,
          { docstring: DocstringInfo | null; declStartIndex: number; declColumn: number }
        >();

        // Extract member docstrings
        const body = child.children.find((c) => c.type === 'declaration_list');
        if (body) {
          const bodyChildren = body.children;
          for (let j = 0; j < bodyChildren.length; j++) {
            const member = bodyChildren[j];
            if (member.type !== 'method_declaration' && member.type !== 'property_declaration') continue;
            // For methods, the second identifier is the name (first is return type)
            const identifiers = member.children.filter((c) => c.type === 'identifier');
            const memberName =
              member.type === 'method_declaration'
                ? identifiers.length >= 2
                  ? identifiers[1]!.text
                  : identifiers[0]?.text
                : identifiers[0]?.text;
            if (!memberName) continue;
            const memberDoc = collectPrecedingXmlDocComments(bodyChildren, j, source);
            members.set(memberName, {
              docstring: memberDoc,
              declStartIndex: member.startIndex,
              declColumn: member.startPosition.column,
              urlFingerprint: extractUrlFingerprint(member, DOTNET_URL_FINGERPRINT_CONFIG),
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
    }

    processChildren(tree.rootNode.children);
    return result;
  },
};
