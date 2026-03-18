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
import { getLanguageCapabilities } from '../capabilities.js';
import { getMergeAdapter } from './merge-adapters/index.js';
import type { MergeStatement } from './merge-adapters/types.js';

// Cache parser instances per language
const parserCache = new Map<string, Parser>();

import { safeParse } from '../utils/tree-sitter.js';

/**
 * Check if a tree-sitter grammar is configured for the given language.
 */
export function hasGrammar(language: string): boolean {
  return getLanguageCapabilities(language).supportsAstMerge && getMergeAdapter(language) !== undefined;
}

async function getParser(language: string): Promise<Parser> {
  const cached = parserCache.get(language);
  if (cached) return cached;

  const adapter = getMergeAdapter(language);
  if (!adapter) {
    throw new Error(
      `No tree-sitter grammar configured for language "${language}". ` +
        `Add a merge adapter and install the corresponding tree-sitter grammar package.`,
    );
  }

  const mod = await import(adapter.grammarModule);
  const grammar = mod.default ?? mod;
  const parser = new Parser();
  parser.setLanguage(grammar);
  parserCache.set(language, parser);
  return parser;
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
  const adapter = getMergeAdapter(language);
  if (!adapter) {
    throw new Error(`No merge adapter configured for language "${language}"`);
  }
  if (typeof source !== 'string') {
    throw new Error(`extractTopLevelSymbols: expected string source, got ${typeof source}`);
  }
  const tree = safeParse(parser, source);
  const names = new Set<string>();
  const unnamedTexts = new Set<string>();
  const parsed = adapter.parseStatements(tree, source);

  for (const statement of parsed.statements) {
    if (statement.key) {
      names.add(statement.key);
    } else {
      unnamedTexts.add(statement.text.trim());
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
async function extractStatements(source: string, language: string): Promise<MergeStatement[]> {
  const parser = await getParser(language);
  const adapter = getMergeAdapter(language);
  if (!adapter) {
    throw new Error(`No merge adapter configured for language "${language}"`);
  }
  const tree = safeParse(parser, source);
  return adapter.parseStatements(tree, source).statements;
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
  const adapter = getMergeAdapter(language);
  if (!adapter) {
    throw new Error(`No merge adapter configured for language "${language}"`);
  }
  // Parse existing file once — extract both symbols and statements from the same AST pass
  const existingStatements = await extractStatements(existingContent, language);
  const generatedStatements = await extractStatements(generatedContent, language);

  const existingKeys = new Set<string>();
  const existingUnnamedTexts = new Set<string>();
  const existingImports = new Set<string>();
  const existingReexports = new Set<string>();
  let lastImportEndIndex = -1;

  for (const stmt of existingStatements) {
    if (stmt.kind === 'import') {
      existingImports.add(adapter.normalizeImport ? adapter.normalizeImport(stmt.text.trim()) : stmt.text.trim());
      const linesBefore = existingContent.slice(0, existingContent.indexOf(stmt.text)).split('\n').length - 1;
      const stmtLines = stmt.text.split('\n').length;
      lastImportEndIndex = linesBefore + stmtLines - 1;
    }
    if (stmt.kind === 'reexport') {
      existingReexports.add(adapter.normalizeReexport ? adapter.normalizeReexport(stmt.text.trim()) : stmt.text.trim());
    }
    if (stmt.key) {
      existingKeys.add(stmt.key);
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
    if (stmt.kind === 'import') {
      const normalizedText = adapter.normalizeImport ? adapter.normalizeImport(stmt.text.trim()) : stmt.text.trim();
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
    if (stmt.kind === 'reexport') {
      const normalizedText = adapter.normalizeReexport
        ? adapter.normalizeReexport(stmt.text.trim())
        : stmt.text.trim();
      if (existingReexports.has(normalizedText) || (stmt.key !== null && existingKeys.has(stmt.key))) {
        preserved++;
        continue;
      }
    }

    if (stmt.key && existingKeys.has(stmt.key)) {
      preserved++;
      continue;
    }

    if (!stmt.key) {
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
