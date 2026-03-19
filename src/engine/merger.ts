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
import { getMergeAdapter } from './merge-adapters/index.js';
import type { MergeImport, ParsedMergeFile } from './merge-adapters/types.js';

// Cache parser instances per language
const parserCache = new Map<string, Parser>();

import { safeParse } from '../utils/tree-sitter.js';

/**
 * Check if a tree-sitter grammar is configured for the given language.
 */
export function hasGrammar(language: string): boolean {
  return getMergeAdapter(language) !== undefined;
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
  const exported = adapter.resolveGrammar ? adapter.resolveGrammar(mod) : mod;
  const grammar = (exported as { default?: unknown }).default ?? exported;
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

  for (const imp of parsed.imports) {
    names.add(imp.key);
  }
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
async function extractStatements(source: string, language: string): Promise<ParsedMergeFile> {
  const parser = await getParser(language);
  const adapter = getMergeAdapter(language);
  if (!adapter) {
    throw new Error(`No merge adapter configured for language "${language}"`);
  }
  const tree = safeParse(parser, source);
  return adapter.parseStatements(tree, source);
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
  options?: { docstringOnly?: boolean },
): Promise<MergeResult> {
  const adapter = getMergeAdapter(language);
  if (!adapter) {
    throw new Error(`No merge adapter configured for language "${language}"`);
  }

  // Docstring-only mode: skip all additive merging, only refresh docstrings
  if (options?.docstringOnly) {
    let result = existingContent;
    let docstringUpdates = 0;
    const parser = await getParser(language);
    const resultTree = safeParse(parser, result);
    const generatedTree = safeParse(parser, generatedContent);
    const resultDocs = adapter.extractDocstrings(resultTree, result);
    const generatedDocs = adapter.extractDocstrings(generatedTree, generatedContent);
    const headerLine = header.trim();
    const edits: { start: number; end: number; newText: string }[] = [];

    for (const [symbolName, genInfo] of generatedDocs) {
      const existInfo = resultDocs.get(symbolName);
      if (!existInfo) continue;
      const genDoc = genInfo.docstring && genInfo.docstring.text.trim() !== headerLine ? genInfo.docstring : null;
      if (genDoc) {
        if (existInfo.docstring) {
          const isPreserved = existInfo.docstring.text.includes('@oagen-keep');
          if (!isPreserved && existInfo.docstring.text !== genDoc.text) {
            edits.push({
              start: existInfo.docstring.startIndex,
              end: existInfo.docstring.endIndex,
              newText: genDoc.text,
            });
            docstringUpdates++;
          }
        } else {
          const lineStart = existInfo.declStartIndex - existInfo.declColumn;
          const indent = ' '.repeat(existInfo.declColumn);
          edits.push({ start: lineStart, end: lineStart, newText: indent + genDoc.text + '\n' });
          docstringUpdates++;
        }
      }
      for (const [memberName, genMember] of genInfo.members) {
        const existMember = existInfo.members.get(memberName);
        if (!existMember || !genMember.docstring) continue;
        if (existMember.docstring) {
          const isPreserved = existMember.docstring.text.includes('@oagen-keep');
          if (!isPreserved && existMember.docstring.text !== genMember.docstring.text) {
            edits.push({
              start: existMember.docstring.startIndex,
              end: existMember.docstring.endIndex,
              newText: genMember.docstring.text,
            });
            docstringUpdates++;
          }
        } else {
          const lineStart = existMember.declStartIndex - existMember.declColumn;
          const indent = ' '.repeat(existMember.declColumn);
          edits.push({ start: lineStart, end: lineStart, newText: indent + genMember.docstring.text + '\n' });
          docstringUpdates++;
        }
      }
    }
    if (edits.length > 0) {
      edits.sort((a, b) => b.start - a.start);
      for (const edit of edits) {
        result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
      }
    }
    return { content: result, added: 0, preserved: 0, changed: docstringUpdates > 0 };
  }

  // Parse existing file once — extract both symbols and statements from the same AST pass
  const existingStatements = await extractStatements(existingContent, language);
  const generatedStatements = await extractStatements(generatedContent, language);

  const existingKeys = new Set<string>();
  const existingUnnamedTexts = new Set<string>();
  const existingImportKeys = new Set<string>();
  const existingReexports = new Set<string>();
  let lastImportEndIndex = -1;

  // Collect import keys AND imported identifiers (to prevent adding declarations
  // that clash with already-imported names)
  const existingImportedNames = new Set<string>();
  for (const imp of existingStatements.imports) {
    existingImportKeys.add(imp.key);
    // Extract identifiers from import text: import { Foo, Bar } from '...'
    const braceMatch = imp.text.match(/\{([^}]+)\}/);
    if (braceMatch) {
      for (const name of braceMatch[1].split(',')) {
        const trimmed = name.replace(/\btype\b/, '').trim();
        if (trimmed) existingImportedNames.add(trimmed);
      }
    }
  }
  for (const anchor of existingStatements.importAnchors) {
    const linesBefore = existingContent.slice(0, existingContent.indexOf(anchor)).split('\n').length - 1;
    const stmtLines = anchor.split('\n').length;
    lastImportEndIndex = linesBefore + stmtLines - 1;
  }
  if (lastImportEndIndex === -1 && existingStatements.importInsertionAnchor) {
    const linesBefore =
      existingContent.slice(0, existingContent.indexOf(existingStatements.importInsertionAnchor)).split('\n').length -
      1;
    const stmtLines = existingStatements.importInsertionAnchor.split('\n').length;
    lastImportEndIndex = linesBefore + stmtLines - 1;
  }

  for (const stmt of existingStatements.statements) {
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

  const newImports: MergeImport[] = [];
  const toAppend: string[] = [];
  let preserved = 0;

  for (const imp of generatedStatements.imports) {
    if (imp.text.trim() === headerLine) continue;
    if (existingImportKeys.has(imp.key)) {
      preserved++;
      continue;
    }
    newImports.push(imp);
  }

  for (const stmt of generatedStatements.statements) {
    // Skip the header comment
    if (stmt.text.trim() === headerLine) continue;

    // Skip re-export statements that duplicate existing re-exports
    // (e.g., generated uses .js extension but existing doesn't).
    // Allow genuinely new re-exports through.
    if (stmt.kind === 'reexport') {
      const normalizedText = adapter.normalizeReexport ? adapter.normalizeReexport(stmt.text.trim()) : stmt.text.trim();
      if (existingReexports.has(normalizedText) || (stmt.key !== null && existingKeys.has(stmt.key))) {
        preserved++;
        continue;
      }
    }

    if (stmt.key && (existingKeys.has(stmt.key) || existingImportedNames.has(stmt.key))) {
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
    // No top-level changes — check for deep merge before returning
    if (!adapter.extractMembers) {
      // Still need to check docstring refresh below
    }
  }

  let result = existingContent;

  // Append new top-level symbols first (so deep merge can see them)
  if (toAppend.length > 0) {
    result = result.trimEnd() + '\n\n' + toAppend.join('\n\n') + '\n';
  }

  // Deep merge pass: add new members to existing symbols
  // Runs after import/symbol merge so line numbers are based on the updated content
  let deepAdded = 0;
  if (adapter.extractMembers) {
    const parser = await getParser(language);
    const resultTree = safeParse(parser, result);
    const generatedTree = safeParse(parser, generatedContent);
    const resultSymbols = adapter.extractMembers(resultTree, result);
    const generatedSymbols = adapter.extractMembers(generatedTree, generatedContent);

    // Collect insertions: {line, text} for new members
    const insertions: { line: number; text: string }[] = [];

    for (const [symbolName, genSymbol] of generatedSymbols) {
      const existSymbol = resultSymbols.get(symbolName);
      if (!existSymbol) continue; // New symbol — handled by top-level append

      const existingMemberKeys = new Set(existSymbol.members.map((m) => m.key));
      const newMembers = genSymbol.members.filter((m) => !existingMemberKeys.has(m.key));

      if (newMembers.length > 0) {
        const insertText = newMembers.map((m) => '  ' + m.text).join('\n');
        insertions.push({ line: existSymbol.bodyEndLine, text: insertText });
        deepAdded += newMembers.length;
      }
    }

    if (insertions.length > 0) {
      // Apply bottom-up to avoid offset shifting
      insertions.sort((a, b) => b.line - a.line);
      const resultLines = result.split('\n');
      for (const ins of insertions) {
        resultLines.splice(ins.line, 0, ins.text);
      }
      result = resultLines.join('\n');
    }
  }

  // Insert new imports only when new symbols or members were actually added.
  // This prevents orphaned imports for generated code that wasn't merged in.
  if (newImports.length > 0 && (toAppend.length > 0 || deepAdded > 0)) {
    const renderedImports = adapter.renderImports
      ? adapter.renderImports(newImports)
      : newImports.map((entry) => entry.text);
    const lines = result.split('\n');
    const insertIdx = lastImportEndIndex + 1;
    lines.splice(insertIdx, 0, ...renderedImports);
    result = lines.join('\n');
  }

  // Docstring refresh pass: update existing docstrings to match generated content
  let docstringUpdates = 0;
  {
    const parser = await getParser(language);
    const resultTree = safeParse(parser, result);
    const generatedTree = safeParse(parser, generatedContent);
    const resultDocs = adapter.extractDocstrings(resultTree, result);
    const generatedDocs = adapter.extractDocstrings(generatedTree, generatedContent);

    const edits: { start: number; end: number; newText: string }[] = [];

    for (const [symbolName, genInfo] of generatedDocs) {
      const existInfo = resultDocs.get(symbolName);
      if (!existInfo) continue;

      // Skip header comments being treated as docstrings
      const genDoc = genInfo.docstring && genInfo.docstring.text.trim() !== headerLine ? genInfo.docstring : null;

      // Top-level docstring
      if (genDoc) {
        if (existInfo.docstring) {
          const isPreserved = existInfo.docstring.text.includes('@oagen-keep');
          if (!isPreserved && existInfo.docstring.text !== genDoc.text) {
            edits.push({
              start: existInfo.docstring.startIndex,
              end: existInfo.docstring.endIndex,
              newText: genDoc.text,
            });
            docstringUpdates++;
          }
        } else {
          const lineStart = existInfo.declStartIndex - existInfo.declColumn;
          const indent = ' '.repeat(existInfo.declColumn);
          edits.push({
            start: lineStart,
            end: lineStart,
            newText: indent + genDoc.text + '\n',
          });
          docstringUpdates++;
        }
      }

      // Member-level docstrings
      for (const [memberName, genMember] of genInfo.members) {
        const existMember = existInfo.members.get(memberName);
        if (!existMember || !genMember.docstring) continue;

        if (existMember.docstring) {
          const isPreserved = existMember.docstring.text.includes('@oagen-keep');
          if (!isPreserved && existMember.docstring.text !== genMember.docstring.text) {
            edits.push({
              start: existMember.docstring.startIndex,
              end: existMember.docstring.endIndex,
              newText: genMember.docstring.text,
            });
            docstringUpdates++;
          }
        } else {
          const lineStart = existMember.declStartIndex - existMember.declColumn;
          const indent = ' '.repeat(existMember.declColumn);
          edits.push({
            start: lineStart,
            end: lineStart,
            newText: indent + genMember.docstring.text + '\n',
          });
          docstringUpdates++;
        }
      }
    }

    if (edits.length > 0) {
      edits.sort((a, b) => b.start - a.start);
      for (const edit of edits) {
        result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
      }
    }
  }

  const importsActuallyAdded =
    toAppend.length > 0 || deepAdded > 0
      ? adapter.renderImports
        ? adapter.renderImports(newImports).length
        : newImports.length
      : 0;
  const topLevelAdded = importsActuallyAdded + toAppend.length;
  const totalAdded = topLevelAdded + deepAdded;

  if (totalAdded === 0 && docstringUpdates === 0) {
    return { content: existingContent, added: 0, preserved, changed: false };
  }

  return {
    content: result,
    added: totalAdded,
    preserved,
    changed: true,
  };
}
