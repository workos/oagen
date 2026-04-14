import type Parser from 'tree-sitter';
import type {
  MergeAdapter,
  MergeStatement,
  MergeImport,
  MergeMember,
  DeepMergeSymbol,
  DocstringInfo,
  SymbolDocstrings,
  MemberDocstrings,
} from './types.js';
import { extractUrlFingerprint } from './url-fingerprint.js';

const KOTLIN_URL_FINGERPRINT_CONFIG = {
  stringNodeTypes: ['string_literal'],
  contentNodeTypes: ['string_content'],
  interpolationNodeTypes: ['interpolated_expression'],
};

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

function extractKotlinClassMembers(classBody: Parser.SyntaxNode, source: string): MergeMember[] {
  const members: MergeMember[] = [];
  const children = classBody.namedChildren;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    let memberName: string | null = null;

    if (child.type === 'property_declaration') {
      const varDecl = child.children.find((c) => c.type === 'variable_declaration');
      memberName = varDecl?.children.find((c) => c.type === 'simple_identifier')?.text ?? null;
    } else if (child.type === 'function_declaration') {
      memberName = child.children.find((c) => c.type === 'simple_identifier')?.text ?? null;
    } else if (child.type === 'companion_object') {
      memberName = 'companion';
    }

    if (!memberName) continue;

    // Fold trailing getter/setter into the property's text span
    let endIdx = child.endIndex;
    if (child.type === 'property_declaration') {
      while (i + 1 < children.length) {
        const next = children[i + 1];
        if (next.type === 'getter' || next.type === 'setter') {
          endIdx = next.endIndex;
          i++;
        } else {
          break;
        }
      }
    }

    // Include preceding KDoc comment in the text span so deep merge
    // inserts the member with its documentation intact.
    let startIdx = child.startIndex;
    for (let k = i - 1; k >= 0; k--) {
      const prev = children[k];
      if (prev.type === 'multiline_comment') {
        const text = source.slice(prev.startIndex, prev.endIndex);
        if (text.startsWith('/**')) startIdx = prev.startIndex;
        break;
      }
      if (prev.type === 'line_comment') continue;
      break;
    }

    members.push({ key: memberName, text: source.slice(startIdx, endIdx) });
  }

  return members;
}

export const kotlinMergeAdapter: MergeAdapter = {
  language: 'kotlin',
  grammarModule: 'tree-sitter-kotlin',
  testFilePatterns: [/Test\.kt$/],
  urlFingerprintConfig: KOTLIN_URL_FINGERPRINT_CONFIG,
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
  shouldSkipDeepMerge(_symbolName, existingMemberKeys, newMembers) {
    // Skip if new members reference instance properties that don't exist in the target
    const newText = newMembers.map((m) => m.text).join('\n');
    for (const match of newText.matchAll(/this\.(\w+)/g)) {
      const propName = match[1];
      if (propName && !existingMemberKeys.has(propName)) return true;
    }
    return false;
  },
  extractMembers(tree, source) {
    const result = new Map<string, DeepMergeSymbol>();

    for (const child of tree.rootNode.children) {
      if (child.type !== 'class_declaration') continue;
      const nameNode = child.children.find((c) => c.type === 'type_identifier');
      if (!nameNode) continue;
      const body = child.children.find((c) => c.type === 'class_body');
      if (!body) continue;

      const members = extractKotlinClassMembers(body, source);
      const firstMember = body.firstNamedChild;
      const memberIndent = firstMember ? ' '.repeat(firstMember.startPosition.column) : undefined;
      result.set(nameNode.text, { members, bodyEndLine: body.endPosition.row, memberIndent });
    }

    return result;
  },
  extractDocstrings(tree, source) {
    const result = new Map<string, SymbolDocstrings>();
    const rootChildren = tree.rootNode.children;

    for (let i = 0; i < rootChildren.length; i++) {
      const child = rootChildren[i];
      const name = extractDeclarationName(child);
      if (!name) continue;

      const docstring = findPrecedingKdoc(rootChildren, i, source);
      const members = new Map<string, MemberDocstrings>();

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
              urlFingerprint: extractUrlFingerprint(member, KOTLIN_URL_FINGERPRINT_CONFIG),
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
