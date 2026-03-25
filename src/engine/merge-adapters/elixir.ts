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

const ELIXIR_URL_FINGERPRINT_CONFIG = {
  stringNodeTypes: ['string'],
  contentNodeTypes: ['quoted_content'],
  interpolationNodeTypes: ['interpolation'],
};

function isDefmodule(node: Parser.SyntaxNode): boolean {
  return node.type === 'call' && node.children[0]?.text === 'defmodule';
}

function getModuleName(node: Parser.SyntaxNode): string | null {
  if (!isDefmodule(node)) return null;
  const args = node.children.find((c) => c.type === 'arguments');
  if (!args) return null;
  const alias = args.children.find((c) => c.type === 'alias');
  return alias?.text ?? null;
}

function getDoBlock(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.children.find((c) => c.type === 'do_block') ?? null;
}

/** Check if a node is an @moduledoc or @doc attribute. */
function isDocAttribute(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'unary_operator') return null;
  const call = node.children.find((c) => c.type === 'call');
  if (!call) return null;
  const id = call.children.find((c) => c.type === 'identifier');
  if (id?.text === 'moduledoc' || id?.text === 'doc') return id.text;
  return null;
}

/** Check if a node is a def/defp call. */
function getDefName(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'call') return null;
  const id = node.children[0];
  if (!id || (id.text !== 'def' && id.text !== 'defp')) return null;
  const args = node.children.find((c) => c.type === 'arguments');
  if (!args) return null;
  // The function name is either a simple identifier or a call (for functions with params)
  for (const arg of args.namedChildren) {
    if (arg.type === 'identifier') return arg.text;
    if (arg.type === 'call') {
      const nameNode = arg.children.find((c) => c.type === 'identifier');
      return nameNode?.text ?? null;
    }
  }
  return null;
}

/** Check if a node is an alias/import/require/use call. */
function isImportLike(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'call') return false;
  const id = node.children[0];
  return id?.type === 'identifier' && ['alias', 'import', 'require', 'use'].includes(id.text);
}

export const elixirMergeAdapter: MergeAdapter = {
  language: 'elixir',
  grammarModule: 'tree-sitter-elixir',
  testFilePatterns: [/_test\.exs$/],
  urlFingerprintConfig: ELIXIR_URL_FINGERPRINT_CONFIG,
  parseStatements(tree, source) {
    const imports: MergeImport[] = [];
    const importAnchors: string[] = [];
    const statements: MergeStatement[] = [];

    for (const child of tree.rootNode.children) {
      if (child.type === 'comment') continue;

      // Top-level alias/import/require/use (rare but possible outside modules)
      if (isImportLike(child)) {
        const text = source.slice(child.startIndex, child.endIndex);
        imports.push({ key: text.trim(), text });
        importAnchors.push(text);
        continue;
      }

      const moduleName = getModuleName(child);
      statements.push({
        key: moduleName,
        kind: moduleName ? 'declaration' : 'other',
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
      const moduleName = getModuleName(child);
      if (!moduleName) continue;

      // Look for @moduledoc inside the do_block
      let docstring: DocstringInfo | null = null;
      const doBlock = getDoBlock(child);
      const members = new Map<string, MemberDocstrings>();

      if (doBlock) {
        const bodyChildren = doBlock.children;

        // Find @moduledoc
        for (const bodyChild of bodyChildren) {
          if (isDocAttribute(bodyChild) === 'moduledoc') {
            docstring = {
              text: source.slice(bodyChild.startIndex, bodyChild.endIndex),
              startIndex: bodyChild.startIndex,
              endIndex: bodyChild.endIndex,
            };
            break;
          }
        }

        // Find @doc + def pairs for member docstrings
        for (let j = 0; j < bodyChildren.length; j++) {
          const bodyChild = bodyChildren[j];
          const defName = getDefName(bodyChild);
          if (!defName) continue;

          // Look for preceding @doc attribute
          let memberDoc: DocstringInfo | null = null;
          for (let k = j - 1; k >= 0; k--) {
            const prev = bodyChildren[k];
            if (isDocAttribute(prev) === 'doc') {
              memberDoc = {
                text: source.slice(prev.startIndex, prev.endIndex),
                startIndex: prev.startIndex,
                endIndex: prev.endIndex,
              };
              break;
            }
            if (prev.type === 'comment') continue;
            break;
          }

          members.set(defName, {
            docstring: memberDoc,
            declStartIndex: bodyChild.startIndex,
            declColumn: bodyChild.startPosition.column,
            urlFingerprint: extractUrlFingerprint(bodyChild, ELIXIR_URL_FINGERPRINT_CONFIG),
          });
        }
      }

      result.set(moduleName, {
        docstring,
        declStartIndex: child.startIndex,
        declColumn: child.startPosition.column,
        members,
      });
    }

    return result;
  },
};
