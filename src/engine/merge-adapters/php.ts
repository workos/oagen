import type Parser from 'tree-sitter';
import type {
  MergeAdapter,
  MergeStatement,
  MergeImport,
  DocstringInfo,
  SymbolDocstrings,
  MemberDocstrings,
} from './types.js';
import { extractUrlFingerprint } from './url-fingerprint.js';

const PHP_URL_FINGERPRINT_CONFIG = {
  stringNodeTypes: ['encapsed_string', 'string'],
  contentNodeTypes: ['string_content'],
  interpolationNodeTypes: ['variable_name'],
};

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

function findPhpDocstring(children: Parser.SyntaxNode[], index: number, source: string): DocstringInfo | null {
  for (let k = index - 1; k >= 0; k--) {
    const prev = children[k];
    if (prev.type === 'comment') {
      const text = source.slice(prev.startIndex, prev.endIndex);
      if (text.startsWith('/**')) {
        return { text, startIndex: prev.startIndex, endIndex: prev.endIndex };
      }
      return null;
    }
    if (prev.type === ';' || prev.type === '{') continue;
    return null;
  }
  return null;
}

export const phpMergeAdapter: MergeAdapter = {
  language: 'php',
  grammarModule: 'tree-sitter-php',
  testFilePatterns: [/Test\.php$/],
  urlFingerprintConfig: PHP_URL_FINGERPRINT_CONFIG,
  resolveGrammar: (mod) => {
    // ESM import wraps in { default: { php, php_only } }
    const m = (mod as Record<string, unknown>)?.default ?? mod;
    if (typeof m === 'object' && m !== null && 'php' in (m as Record<string, unknown>))
      return (m as { php: unknown }).php;
    return m;
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
  extractDocstrings(tree, source) {
    const result = new Map<string, SymbolDocstrings>();
    const rootChildren = tree.rootNode.children;

    for (let i = 0; i < rootChildren.length; i++) {
      const child = rootChildren[i];
      const name = extractPhpDeclarationName(child);
      if (!name || name.startsWith('__namespace:')) continue;

      const docstring = findPhpDocstring(rootChildren, i, source);
      const members = new Map<string, MemberDocstrings>();

      const body = child.childForFieldName('body');
      if (body) {
        const bodyChildren = body.children;
        for (let j = 0; j < bodyChildren.length; j++) {
          const member = bodyChildren[j];
          if (member.type !== 'method_declaration') continue;
          const memberName = member.childForFieldName('name')?.text;
          if (!memberName) continue;
          const memberDoc = findPhpDocstring(bodyChildren, j, source);
          members.set(memberName, {
            docstring: memberDoc,
            declStartIndex: member.startIndex,
            declColumn: member.startPosition.column,
            urlFingerprint: extractUrlFingerprint(member, PHP_URL_FINGERPRINT_CONFIG),
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
