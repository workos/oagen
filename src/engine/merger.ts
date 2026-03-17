/**
 * AST-level file merger using tree-sitter.
 *
 * When generating into a directory that already contains files, the merger
 * parses both the existing and generated content, detects top-level symbols,
 * and only appends symbols that don't already exist. Hand-written code is
 * never modified or removed.
 *
 * Supports any language with a tree-sitter grammar package.
 */

import Parser from 'tree-sitter';

// Cache parser instances per language
const parserCache = new Map<string, Parser>();

/**
 * Map emitter language names to tree-sitter grammar module names.
 */
const GRAMMAR_MODULES: Record<string, string> = {
  node: 'tree-sitter-typescript/typescript',
  typescript: 'tree-sitter-typescript/typescript',
};

/**
 * Check if a tree-sitter grammar is configured for the given language.
 */
export function hasGrammar(language: string): boolean {
  return language in GRAMMAR_MODULES;
}

async function getParser(language: string): Promise<Parser> {
  const cached = parserCache.get(language);
  if (cached) return cached;

  const grammarModule = GRAMMAR_MODULES[language];
  if (!grammarModule) {
    throw new Error(
      `No tree-sitter grammar configured for language "${language}". ` +
      `Add it to GRAMMAR_MODULES in merger.ts and install the corresponding npm package.`,
    );
  }

  const grammar = (await import(grammarModule)).default;
  const parser = new Parser();
  parser.setLanguage(grammar);
  parserCache.set(language, parser);
  return parser;
}

/**
 * Extract the name of a top-level node. Handles export-wrapped declarations.
 */
function extractNodeName(node: Parser.SyntaxNode): string | null {
  // export_statement wraps the actual declaration
  if (node.type === 'export_statement') {
    const decl = node.childForFieldName('declaration');
    if (decl) {
      return extractDeclName(decl);
    }
    // export * from '...' — use the source string as identifier
    const source = node.childForFieldName('source');
    if (source) {
      return `__export:${source.text}`;
    }
    return null;
  }

  return extractDeclName(node);
}

function extractDeclName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  // const foo = ... → variable_declarator → name
  if (node.type === 'lexical_declaration') {
    const declarator = node.firstNamedChild;
    if (declarator?.type === 'variable_declarator') {
      const name = declarator.childForFieldName('name');
      if (name) return name.text;
    }
  }

  return null;
}

/**
 * Extract all top-level symbol names from source code.
 */
export async function extractTopLevelNames(
  source: string,
  language: string,
): Promise<Set<string>> {
  const parser = await getParser(language);
  const tree = parser.parse(source);
  const names = new Set<string>();

  for (const child of tree.rootNode.children) {
    const name = extractNodeName(child);
    if (name) names.add(name);
  }

  return names;
}

/**
 * Extract top-level statements from generated source with their names
 * and exact text span.
 */
async function extractStatements(
  source: string,
  language: string,
): Promise<Array<{ name: string | null; text: string }>> {
  const parser = await getParser(language);
  const tree = parser.parse(source);
  const statements: Array<{ name: string | null; text: string }> = [];

  for (const child of tree.rootNode.children) {
    if (child.type === 'comment') continue;

    const name = extractNodeName(child);
    statements.push({ name, text: source.slice(child.startIndex, child.endIndex) });
  }

  return statements;
}

export interface MergeResult {
  content: string;
  added: number;
  preserved: number;
  changed: boolean;
}

/**
 * Merge generated content into an existing file.
 *
 * - Parses both files with tree-sitter
 * - Detects which top-level symbols already exist
 * - Appends only new symbols
 * - Never modifies or removes existing code
 * - Adds auto-generated header if not present
 */
export async function mergeIntoExisting(
  existingContent: string,
  generatedContent: string,
  language: string,
  header: string,
): Promise<MergeResult> {
  const existingNames = await extractTopLevelNames(existingContent, language);
  const generatedStatements = await extractStatements(generatedContent, language);

  const headerLine = header.trim();

  const toAppend: string[] = [];
  let preserved = 0;

  for (const stmt of generatedStatements) {
    // Skip the header comment
    if (stmt.text.trim() === headerLine) continue;

    if (stmt.name && existingNames.has(stmt.name)) {
      preserved++;
      continue;
    }

    // For unnamed statements, check text dedup
    if (!stmt.name) {
      if (existingContent.includes(stmt.text.trim())) {
        preserved++;
        continue;
      }
    }

    toAppend.push(stmt.text);
  }

  if (toAppend.length === 0) {
    return { content: existingContent, added: 0, preserved, changed: false };
  }

  let result = existingContent;

  if (!result.includes(headerLine)) {
    result = header + '\n\n' + result;
  }

  result = result.trimEnd() + '\n\n' + toAppend.join('\n\n') + '\n';

  return { content: result, added: toAppend.length, preserved, changed: true };
}
