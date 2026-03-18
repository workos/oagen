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
import { normalizeJsExtension } from '../utils/naming.js';

// Cache parser instances per language
const parserCache = new Map<string, Parser>();

/** Synthetic name prefix for `export * from '...'` re-export dedup */
const REEXPORT_PREFIX = '__export:';

import { safeParse } from '../utils/tree-sitter.js';

/**
 * Map emitter language names to tree-sitter grammar module names.
 */
const GRAMMAR_MODULES: Record<string, string> = {
  node: 'tree-sitter-typescript/bindings/node/typescript.js',
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

  const mod = await import(grammarModule);
  const grammar = mod.default ?? mod;
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
      return `${REEXPORT_PREFIX}${source.text}`;
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

interface ParsedSymbols {
  names: Set<string>;
  /** Trimmed text of unnamed top-level statements (for text-based dedup) */
  unnamedTexts: Set<string>;
}

/**
 * Extract all top-level symbol names (and unnamed statement texts) from source code.
 */
export async function extractTopLevelSymbols(source: string, language: string): Promise<ParsedSymbols> {
  const parser = await getParser(language);
  if (typeof source !== 'string') {
    throw new Error(`extractTopLevelSymbols: expected string source, got ${typeof source}`);
  }
  const tree = safeParse(parser, source);
  const names = new Set<string>();
  const unnamedTexts = new Set<string>();

  for (const child of tree.rootNode.children) {
    const name = extractNodeName(child);
    if (name) {
      names.add(name);
    } else if (child.type !== 'comment') {
      unnamedTexts.add(source.slice(child.startIndex, child.endIndex).trim());
    }
  }

  return { names, unnamedTexts };
}

/** Convenience wrapper that returns only the name set. */
export async function extractTopLevelNames(source: string, language: string): Promise<Set<string>> {
  return (await extractTopLevelSymbols(source, language)).names;
}

/**
 * Extract top-level statements from generated source with their names
 * and exact text span.
 */
async function extractStatements(
  source: string,
  language: string,
): Promise<Array<{ name: string | null; text: string; nodeType: string }>> {
  const parser = await getParser(language);
  const tree = safeParse(parser, source);
  const statements: Array<{ name: string | null; text: string; nodeType: string }> = [];

  for (const child of tree.rootNode.children) {
    if (child.type === 'comment') continue;

    const name = extractNodeName(child);
    statements.push({ name, text: source.slice(child.startIndex, child.endIndex), nodeType: child.type });
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
  // Parse existing file once — extract both symbols and statements from the same AST pass
  const existingStatements = await extractStatements(existingContent, language);
  const generatedStatements = await extractStatements(generatedContent, language);

  // Build symbol/text sets from existing statements (avoids a second tree-sitter parse)
  const existingNames = new Set<string>();
  const existingUnnamedTexts = new Set<string>();
  const existingImports = new Set<string>();
  let lastImportEndIndex = -1;

  for (const stmt of existingStatements) {
    if (stmt.nodeType === 'import_statement') {
      existingImports.add(normalizeJsExtension(stmt.text.trim()));
      // Track end position of last import for insertion point
      const linesBefore = existingContent.slice(0, existingContent.indexOf(stmt.text)).split('\n').length - 1;
      const stmtLines = stmt.text.split('\n').length;
      lastImportEndIndex = linesBefore + stmtLines - 1;
    }
    if (stmt.name) {
      existingNames.add(stmt.name);
    } else {
      existingUnnamedTexts.add(stmt.text.trim());
    }
  }

  const headerLine = header.trim();

  const newImports: string[] = [];
  const toAppend: string[] = [];
  let preserved = 0;

  for (const stmt of generatedStatements) {
    // Skip the header comment
    if (stmt.text.trim() === headerLine) continue;

    // For import statements, only skip if an equivalent exists in the existing file.
    // This allows new imports (required by appended code) to be included.
    if (stmt.nodeType === 'import_statement') {
      const normalizedText = normalizeJsExtension(stmt.text.trim());
      if (existingImports.has(normalizedText)) {
        preserved++;
        continue;
      }
      newImports.push(stmt.text);
      continue;
    }

    // Skip re-export statements that duplicate existing re-exports
    // (e.g., generated uses .js extension but existing doesn't).
    // Allow genuinely new re-exports through.
    if (stmt.nodeType === 'export_statement' && stmt.text.includes(' from ')) {
      const normalizedText = normalizeJsExtension(stmt.text.trim());
      const existsNormalized = [...existingUnnamedTexts].some((t) => normalizeJsExtension(t) === normalizedText);
      if (existsNormalized) {
        preserved++;
        continue;
      }
      // Also check named re-exports against existing names.
      // Strip .js extension from the module specifier before comparing,
      // since the existing file may use extensionless imports.
      // Name format: __export:'./path/to/module.js' → __export:'./path/to/module'
      if (stmt.name?.startsWith(REEXPORT_PREFIX)) {
        const normalizedName = normalizeJsExtension(stmt.name);
        if (existingNames.has(normalizedName) || existingNames.has(stmt.name)) {
          preserved++;
          continue;
        }
      }
    }

    if (stmt.name && existingNames.has(stmt.name)) {
      preserved++;
      continue;
    }

    // For unnamed statements, check text dedup via pre-built Set (O(1))
    if (!stmt.name) {
      if (existingUnnamedTexts.has(stmt.text.trim())) {
        preserved++;
        continue;
      }
    }

    toAppend.push(stmt.text);
  }

  if (newImports.length === 0 && toAppend.length === 0) {
    return { content: existingContent, added: 0, preserved, changed: false };
  }

  let result = existingContent;

  // Don't prepend auto-generated header to hand-written files

  // Insert new imports after the last existing import (using AST-derived position)
  if (newImports.length > 0) {
    const lines = result.split('\n');
    const insertIdx = lastImportEndIndex + 1;
    lines.splice(insertIdx, 0, ...newImports);
    result = lines.join('\n');
  }

  if (toAppend.length > 0) {
    result = result.trimEnd() + '\n\n' + toAppend.join('\n\n') + '\n';
  }

  return { content: result, added: newImports.length + toAppend.length, preserved, changed: true };
}
