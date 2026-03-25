import type Parser from 'tree-sitter';
import type { UrlFingerprintConfig } from './types.js';

/**
 * Extract a URL path fingerprint from a method body using tree-sitter AST traversal.
 *
 * Walks the AST subtree of the member node looking for the first string literal
 * that starts with '/'. Normalizes interpolation expressions to '{}' and format
 * specifiers (%s, %d, etc.) to '{}' for cross-language comparison.
 *
 * @returns A normalized URL fingerprint like "/organizations/{}" or undefined if none found.
 */
export function extractUrlFingerprint(memberNode: Parser.SyntaxNode, config: UrlFingerprintConfig): string | undefined {
  const stringTypes = new Set(config.stringNodeTypes);
  const contentTypes = new Set(config.contentNodeTypes);
  const interpolationTypes = new Set(config.interpolationNodeTypes);
  const formatFns = config.formatFunctionNames ? new Set(config.formatFunctionNames) : null;

  // Iterative DFS through the method's AST subtree
  const stack: Parser.SyntaxNode[] = [memberNode];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (stringTypes.has(node.type)) {
      const fp = resolveFingerprint(node, contentTypes, interpolationTypes);
      if (fp?.startsWith('/')) return fp;
    }

    // For format functions (Go's Sprintf, Rust's format!): check if this call
    // matches and extract the first string argument.
    if (formatFns && isFormatCall(node, formatFns)) {
      const fp = extractFromFormatCall(node, stringTypes, contentTypes, interpolationTypes);
      if (fp?.startsWith('/')) return fp;
    }

    // Push children in reverse order so leftmost child is processed first
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }

  return undefined;
}

/**
 * Resolve the text content of a string node, normalizing interpolations to '{}'.
 */
function resolveFingerprint(
  stringNode: Parser.SyntaxNode,
  contentTypes: Set<string>,
  interpolationTypes: Set<string>,
): string | undefined {
  // Leaf string node (no children besides quotes) — strip quotes
  if (stringNode.namedChildCount === 0) {
    return normalizeFormatSpecifiers(stripQuotes(stringNode.text));
  }

  // Composite string (has content fragments + interpolation children)
  let result = '';
  for (let i = 0; i < stringNode.childCount; i++) {
    const child = stringNode.child(i)!;
    if (contentTypes.has(child.type)) {
      result += child.text;
    } else if (interpolationTypes.has(child.type)) {
      result += '{}';
    }
    // Skip quote delimiters, interpolation markers, etc.
  }

  return result ? normalizeFormatSpecifiers(result) : normalizeFormatSpecifiers(stripQuotes(stringNode.text));
}

/** Check if a node is a call to one of the format functions (e.g., fmt.Sprintf, format!). */
function isFormatCall(node: Parser.SyntaxNode, formatFns: Set<string>): boolean {
  if (node.type !== 'call_expression') return false;
  const fnNode = node.childForFieldName('function');
  if (!fnNode) return false;

  // Direct call: Sprintf(...) or format!(...)
  if (formatFns.has(fnNode.text)) return true;

  // Member call: fmt.Sprintf(...)
  if (fnNode.type === 'selector_expression' || fnNode.type === 'member_expression') {
    const prop = fnNode.childForFieldName('field') ?? fnNode.childForFieldName('property');
    if (prop && formatFns.has(prop.text)) return true;
  }

  // Rust macro: format!(...) — tree-sitter may parse as macro_invocation
  if (node.type === 'macro_invocation') {
    const macroName = node.childForFieldName('macro')?.text;
    if (macroName && formatFns.has(macroName.replace(/!$/, ''))) return true;
  }

  return false;
}

/** Extract the first string argument from a format function call. */
function extractFromFormatCall(
  callNode: Parser.SyntaxNode,
  stringTypes: Set<string>,
  contentTypes: Set<string>,
  interpolationTypes: Set<string>,
): string | undefined {
  const args = callNode.childForFieldName('arguments');
  if (!args) return undefined;

  for (let i = 0; i < args.childCount; i++) {
    const arg = args.child(i)!;
    if (stringTypes.has(arg.type)) {
      return resolveFingerprint(arg, contentTypes, interpolationTypes);
    }
  }
  return undefined;
}

/** Strip surrounding quote characters from a string literal. */
function stripQuotes(text: string): string {
  // Handle various quote styles: "...", '...', `...`, f"...", $"...", @"..."
  const match = text.match(/^(?:f|r|b|@|\$)?(?:"""([\s\S]*)"""|'''([\s\S]*)'''|"(.*)"|'(.*)'|`(.*)`)$/s);
  if (match) return match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? text;
  return text;
}

/** Replace printf-style format specifiers (%s, %d, %v, %f) with {}. */
function normalizeFormatSpecifiers(s: string): string {
  return s.replace(/%[sdvf]/g, '{}');
}
