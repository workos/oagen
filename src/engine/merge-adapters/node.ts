import type Parser from 'tree-sitter';
import { normalizeJsExtension } from '../../utils/naming.js';
import type {
  MergeAdapter,
  MergeStatement,
  MergeImport,
  DeepMergeSymbol,
  MergeMember,
  DocstringInfo,
  SymbolDocstrings,
} from './types.js';

const REEXPORT_PREFIX = '__export:';

function extractDeclName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  if (node.type === 'lexical_declaration') {
    const declarator = node.firstNamedChild;
    if (declarator?.type === 'variable_declarator') {
      const name = declarator.childForFieldName('name');
      if (name) return name.text;
    }
  }

  return null;
}

function extractNodeKey(node: Parser.SyntaxNode): { key: string | null; kind: MergeStatement['kind'] } {
  if (node.type === 'export_statement') {
    const decl = node.childForFieldName('declaration');
    if (decl) {
      return { key: extractDeclName(decl), kind: 'declaration' };
    }

    const source = node.childForFieldName('source');
    if (source) {
      return { key: `${REEXPORT_PREFIX}${normalizeJsExtension(source.text)}`, kind: 'reexport' };
    }

    return { key: null, kind: 'other' };
  }
  return { key: extractDeclName(node), kind: extractDeclName(node) ? 'declaration' : 'other' };
}

function extractClassMembers(classBody: Parser.SyntaxNode, source: string): MergeMember[] {
  const members: MergeMember[] = [];
  for (const child of classBody.namedChildren) {
    if (child.type === 'method_definition') {
      const nameNode = child.childForFieldName('name');
      if (nameNode && nameNode.text !== 'constructor') {
        members.push({ key: nameNode.text, text: source.slice(child.startIndex, child.endIndex) });
      }
    } else if (child.type === 'public_field_definition') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        // tree-sitter may exclude the trailing semicolon from
        // public_field_definition nodes — include it if present
        let endIdx = child.endIndex;
        if (source[endIdx] === ';') {
          endIdx += 1;
        }
        members.push({ key: nameNode.text, text: source.slice(child.startIndex, endIdx) });
      }
    }
  }
  return members;
}

function extractInterfaceMembers(body: Parser.SyntaxNode, source: string): MergeMember[] {
  const members: MergeMember[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'property_signature' || child.type === 'method_signature') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        members.push({ key: nameNode.text, text: source.slice(child.startIndex, child.endIndex) });
      }
    }
  }
  return members;
}

function extractEnumMembers(body: Parser.SyntaxNode, source: string): MergeMember[] {
  const members: MergeMember[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'enum_assignment') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        members.push({ key: nameNode.text, text: source.slice(child.startIndex, child.endIndex) });
      }
    } else if (child.type === 'property_identifier') {
      members.push({ key: child.text, text: source.slice(child.startIndex, child.endIndex) });
    }
  }
  return members;
}

function isCommentNode(node: Parser.SyntaxNode): boolean {
  // tree-sitter extras (comments) may report the parent node's type
  // instead of 'comment' — check grammarType as fallback
  return node.type === 'comment' || (node as any).grammarType === 'comment';
}

function findPrecedingDocstring(children: Parser.SyntaxNode[], index: number, source: string): DocstringInfo | null {
  for (let k = index - 1; k >= 0; k--) {
    const prev = children[k];
    if (isCommentNode(prev)) {
      const text = source.slice(prev.startIndex, prev.endIndex);
      if (text.startsWith('/**')) {
        return { text, startIndex: prev.startIndex, endIndex: prev.endIndex };
      }
      return null;
    }
    if (prev.type === ',' || prev.type === ';' || prev.type === '{') continue;
    return null;
  }
  return null;
}

const CLASS_MEMBER_TYPES = new Set(['method_definition', 'public_field_definition']);
const INTERFACE_MEMBER_TYPES = new Set(['property_signature', 'method_signature']);
const ENUM_MEMBER_TYPES = new Set(['enum_assignment', 'property_identifier']);

function extractBodyMemberDocstrings(
  body: Parser.SyntaxNode,
  source: string,
  memberTypes: Set<string>,
): Map<string, { docstring: DocstringInfo | null; declStartIndex: number; declColumn: number }> {
  const result = new Map<string, { docstring: DocstringInfo | null; declStartIndex: number; declColumn: number }>();
  const allChildren = body.children;
  for (let i = 0; i < allChildren.length; i++) {
    const child = allChildren[i];
    if (!memberTypes.has(child.type)) continue;
    let memberName: string | null = null;
    if (child.type === 'property_identifier') {
      memberName = child.text;
    } else {
      const nameNode = child.childForFieldName('name');
      if (nameNode) memberName = nameNode.text;
    }
    if (!memberName || memberName === 'constructor') continue;
    const docstring = findPrecedingDocstring(allChildren, i, source);
    result.set(memberName, {
      docstring,
      declStartIndex: child.startIndex,
      declColumn: child.startPosition.column,
    });
  }
  return result;
}

export const nodeMergeAdapter: MergeAdapter = {
  language: 'node',
  grammarModule: 'tree-sitter-typescript/bindings/node/typescript.js',
  normalizeReexport: normalizeJsExtension,
  testFilePatterns: [/\.(spec|test)\.[jt]sx?$/],
  shouldSkipDeepMerge(_symbolName, existingMemberKeys, newMembers) {
    // If new members reference instance properties (this.X) that don't exist
    // in the target class, the merged code would be broken.
    const newText = newMembers.map((m) => m.text).join('\n');
    for (const match of newText.matchAll(/this\.(\w+)/g)) {
      const propName = match[1];
      if (propName && !existingMemberKeys.has(propName)) {
        return true;
      }
    }
    return false;
  },
  parseStatements(tree, source) {
    const imports: MergeImport[] = [];
    const importAnchors: string[] = [];
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      if (child.type === 'import_statement') {
        const text = source.slice(child.startIndex, child.endIndex);
        // Key on module path so `import { X }` and `import type { X }` from
        // the same module are treated as duplicates
        const sourceNode = child.childForFieldName('source');
        const modulePath = sourceNode ? normalizeJsExtension(sourceNode.text) : normalizeJsExtension(text.trim());
        imports.push({ key: modulePath, text });
        importAnchors.push(text);
        continue;
      }

      const { key, kind } = extractNodeKey(child);
      statements.push({
        key,
        kind,
        text: source.slice(child.startIndex, child.endIndex),
      });
    }

    return { imports, importAnchors, statements };
  },
  renderImports(imports) {
    return imports.map((entry) => entry.text);
  },
  extractMembers(tree, source) {
    const result = new Map<string, DeepMergeSymbol>();

    for (const child of tree.rootNode.children) {
      if (child.type !== 'export_statement') continue;
      const decl = child.childForFieldName('declaration');
      if (!decl) continue;

      const nameNode = decl.childForFieldName('name');
      if (!nameNode) continue;
      const symbolName = nameNode.text;

      if (decl.type === 'class_declaration') {
        const body = decl.childForFieldName('body');
        if (!body) continue;
        const members = extractClassMembers(body, source);
        const firstMember = body.firstNamedChild;
        const memberIndent = firstMember ? ' '.repeat(firstMember.startPosition.column) : undefined;
        result.set(symbolName, { members, bodyEndLine: body.endPosition.row, memberIndent });
      } else if (decl.type === 'interface_declaration') {
        const body = decl.childForFieldName('body');
        if (!body) continue;
        const members = extractInterfaceMembers(body, source);
        const firstMember = body.firstNamedChild;
        const memberIndent = firstMember ? ' '.repeat(firstMember.startPosition.column) : undefined;
        result.set(symbolName, { members, bodyEndLine: body.endPosition.row, memberIndent });
      } else if (decl.type === 'enum_declaration') {
        const body = decl.childForFieldName('body');
        if (!body) continue;
        const members = extractEnumMembers(body, source);
        const firstMember = body.firstNamedChild;
        const memberIndent = firstMember ? ' '.repeat(firstMember.startPosition.column) : undefined;
        result.set(symbolName, { members, bodyEndLine: body.endPosition.row, memberIndent });
      }
    }

    return result;
  },
  extractDocstrings(tree, source) {
    const result = new Map<string, SymbolDocstrings>();
    const rootChildren = tree.rootNode.children;

    for (let i = 0; i < rootChildren.length; i++) {
      const child = rootChildren[i];
      if (child.type !== 'export_statement') continue;
      const decl = child.childForFieldName('declaration');
      if (!decl) continue;
      const nameNode = decl.childForFieldName('name');
      if (!nameNode) continue;

      // Find preceding JSDoc for this top-level symbol
      const docstring = findPrecedingDocstring(rootChildren, i, source);

      // Extract member-level docstrings
      let members = new Map<string, { docstring: DocstringInfo | null; declStartIndex: number; declColumn: number }>();
      const body = decl.childForFieldName('body');
      if (body) {
        if (decl.type === 'class_declaration') {
          members = extractBodyMemberDocstrings(body, source, CLASS_MEMBER_TYPES);
        } else if (decl.type === 'interface_declaration') {
          members = extractBodyMemberDocstrings(body, source, INTERFACE_MEMBER_TYPES);
        } else if (decl.type === 'enum_declaration') {
          members = extractBodyMemberDocstrings(body, source, ENUM_MEMBER_TYPES);
        }
      }

      result.set(nameNode.text, {
        docstring,
        declStartIndex: child.startIndex,
        declColumn: child.startPosition.column,
        members,
      });
    }

    return result;
  },
};
