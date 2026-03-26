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
import type { MergeImport, ParsedMergeFile, SymbolDocstrings } from './merge-adapters/types.js';

// Cache parser instances per language
const parserCache = new Map<string, Parser>();

import { safeParse } from '../utils/tree-sitter.js';

// --- @oagen-ignore region helpers ---

interface IgnoredRegion {
  startIndex: number;
  endIndex: number;
}

function findIgnoredRegions(source: string): IgnoredRegion[] {
  const regions: IgnoredRegion[] = [];
  const startTag = '@oagen-ignore-start';
  const endTag = '@oagen-ignore-end';
  let searchFrom = 0;

  while (true) {
    const startIdx = source.indexOf(startTag, searchFrom);
    if (startIdx === -1) break;
    const endIdx = source.indexOf(endTag, startIdx + startTag.length);
    if (endIdx === -1) break; // Unclosed — silently ignore
    regions.push({ startIndex: startIdx, endIndex: endIdx + endTag.length });
    searchFrom = endIdx + endTag.length;
  }

  return regions;
}

function buildIgnoredSymbolNames(docstrings: Map<string, SymbolDocstrings>, regions: IgnoredRegion[]): Set<string> {
  if (regions.length === 0) return new Set();
  const ignored = new Set<string>();
  for (const [name, info] of docstrings) {
    if (regions.some((r) => info.declStartIndex >= r.startIndex && info.declStartIndex <= r.endIndex)) {
      ignored.add(name);
    }
  }
  return ignored;
}

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
export async function extractStatements(source: string, language: string): Promise<ParsedMergeFile> {
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
      // The existing file already imports from this module path.
      // Check if the generated import adds identifiers not present in
      // the existing import — if so, create a supplemental import with
      // only the new identifiers.  The supplemental participates in the
      // usage-based filter (below) so unused identifiers are dropped.
      const braceMatch = imp.text.match(/\{([^}]+)\}/);
      if (braceMatch) {
        const names = braceMatch[1]
          .split(',')
          .map((n) => n.replace(/\btype\b/, '').trim())
          .filter(Boolean);
        const newNames = names.filter((n) => !existingImportedNames.has(n) && !existingKeys.has(n));
        if (newNames.length > 0) {
          const isTypeImport = imp.text.trimStart().startsWith('import type');
          const prefix = isTypeImport ? 'import type' : 'import';
          const sourceMatch = imp.text.match(/from\s+(['"][^'"]+['"]);?/);
          if (sourceMatch) {
            newImports.push({
              key: imp.key + '#supplemental',
              text: `${prefix} { ${newNames.join(', ')} } from ${sourceMatch[1]};`,
            });
          }
        }
      }
      preserved++;
      continue;
    }
    // Strip out identifiers that are already imported from another path.
    // This prevents duplicates when the generated file uses a specific path
    // (e.g., '../interfaces/organization.interface') while the existing file
    // imports the same names from a barrel (e.g., '../interfaces').
    const braceMatch = imp.text.match(/\{([^}]+)\}/);
    if (braceMatch) {
      const names = braceMatch[1]
        .split(',')
        .map((n) => n.replace(/\btype\b/, '').trim())
        .filter(Boolean);
      // Check against both existing imports AND existing top-level declarations
      const isAlreadyDefined = (n: string) => existingImportedNames.has(n) || existingKeys.has(n);
      if (names.length > 0 && names.every(isAlreadyDefined)) {
        preserved++;
        continue;
      }
      // If only SOME identifiers are already defined, strip them out and keep only new ones
      if (names.some(isAlreadyDefined)) {
        const newNames = names.filter((n) => !isAlreadyDefined(n));
        if (newNames.length === 0) {
          preserved++;
          continue;
        }
        // Rebuild the import with only new identifiers
        const isTypeImport = imp.text.trimStart().startsWith('import type');
        const prefix = isTypeImport ? 'import type' : 'import';
        const sourceMatch = imp.text.match(/from\s+(['"][^'"]+['"]);?/);
        if (sourceMatch) {
          const newText = `${prefix} { ${newNames.join(', ')} } from ${sourceMatch[1]};`;
          newImports.push({ key: imp.key, text: newText });
          continue;
        }
      }
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
  const insertions: { line: number; text: string }[] = [];
  if (adapter.extractMembers) {
    const parser = await getParser(language);
    const resultTree = safeParse(parser, result);
    const generatedTree = safeParse(parser, generatedContent);
    const resultSymbols = adapter.extractMembers(resultTree, result);
    const generatedSymbols = adapter.extractMembers(generatedTree, generatedContent);

    // Build ignored symbol set from @oagen-ignore-start/@oagen-ignore-end regions
    const existingTree = safeParse(parser, existingContent);
    const existingDocs = adapter.extractDocstrings(existingTree, existingContent);
    const deepIgnoredRegions = findIgnoredRegions(existingContent);
    const deepIgnoredSymbols = buildIgnoredSymbolNames(existingDocs, deepIgnoredRegions);

    for (const [symbolName, genSymbol] of generatedSymbols) {
      if (deepIgnoredSymbols.has(symbolName)) continue;
      const existSymbol = resultSymbols.get(symbolName);
      if (!existSymbol) continue; // New symbol — handled by top-level append

      const existingMemberKeys = new Set(existSymbol.members.map((m) => m.key));
      const newMembers = genSymbol.members.filter((m) => !existingMemberKeys.has(m.key));

      if (newMembers.length > 0) {
        // Let the adapter decide whether to skip deep merge (e.g., when new members
        // reference dependencies the existing symbol doesn't provide)
        if (adapter.shouldSkipDeepMerge?.(symbolName, existingMemberKeys, newMembers)) {
          continue;
        }

        const indent = existSymbol.memberIndent ?? '  ';
        const insertText = newMembers.map((m) => indent + m.text).join('\n');
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
  // Additionally, filter imports to only include identifiers actually used in the
  // appended/inserted code — prevents orphaned imports for generated code that
  // referenced types used in other (non-appended) generated functions.
  if (newImports.length > 0 && (toAppend.length > 0 || deepAdded > 0)) {
    // Build text of all new code that was actually added (appended + deep-merged members)
    const addedParts: string[] = [...toAppend];
    if (insertions) {
      for (const ins of insertions) {
        addedParts.push(ins.text);
      }
    }
    const addedCodeText = addedParts.join('\n');

    // Filter imports to only identifiers that appear in the added code.
    // Strip individual unused identifiers from each import rather than
    // keeping/dropping the entire import — prevents orphaned imports when
    // a generated import line contains both used and unused identifiers
    // (e.g., `import { deserializeFoo, serializeFoo }` where only
    // serializeFoo is used in the appended code).
    const filteredImports: MergeImport[] = [];
    for (const imp of newImports) {
      const braceMatch = imp.text.match(/\{([^}]+)\}/);
      if (!braceMatch) {
        // Non-destructured import (e.g., default import) — keep as-is
        filteredImports.push(imp);
        continue;
      }
      const names = braceMatch[1]
        .split(',')
        .map((n) => n.replace(/\btype\b/, '').trim())
        .filter(Boolean);
      const usedNames = names.filter((name) => addedCodeText.includes(name));
      if (usedNames.length === 0) continue; // Drop entirely
      if (usedNames.length === names.length) {
        // All identifiers used — keep original import
        filteredImports.push(imp);
      } else {
        // Rebuild import with only used identifiers
        const isTypeImport = imp.text.trimStart().startsWith('import type');
        const prefix = isTypeImport ? 'import type' : 'import';
        const sourceMatch = imp.text.match(/from\s+(['"][^'"]+['"]);?/);
        if (sourceMatch) {
          filteredImports.push({
            key: imp.key,
            text: `${prefix} { ${usedNames.join(', ')} } from ${sourceMatch[1]};`,
          });
        } else {
          filteredImports.push(imp);
        }
      }
    }

    if (filteredImports.length > 0) {
      const renderedImports = adapter.renderImports
        ? adapter.renderImports(filteredImports)
        : filteredImports.map((entry) => entry.text);
      const lines = result.split('\n');
      const insertIdx = lastImportEndIndex + 1;
      lines.splice(insertIdx, 0, ...renderedImports);
      result = lines.join('\n');
    }
  }

  // Docstring refresh pass: update existing docstrings to match generated content
  let docstringUpdates = 0;
  {
    const parser = await getParser(language);
    const resultTree = safeParse(parser, result);
    const generatedTree = safeParse(parser, generatedContent);
    const resultDocs = adapter.extractDocstrings(resultTree, result);
    const generatedDocs = adapter.extractDocstrings(generatedTree, generatedContent);
    const docIgnoredRegions = findIgnoredRegions(result);
    const docIgnoredSymbols = buildIgnoredSymbolNames(resultDocs, docIgnoredRegions);

    const edits: { start: number; end: number; newText: string }[] = [];

    for (const [symbolName, genInfo] of generatedDocs) {
      const existInfo = resultDocs.get(symbolName);
      if (!existInfo) continue;
      if (docIgnoredSymbols.has(symbolName)) continue;

      // Skip header comments being treated as docstrings
      const genDoc = genInfo.docstring && genInfo.docstring.text.trim() !== headerLine ? genInfo.docstring : null;

      // Top-level docstring
      if (genDoc) {
        if (existInfo.docstring) {
          const isPreserved = existInfo.docstring.text.includes('@oagen-ignore');
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

      // Member-level docstrings — first pass: match by name
      const matchedExistMembers = new Set<string>();
      for (const [memberName, genMember] of genInfo.members) {
        const existMember = existInfo.members.get(memberName);
        if (!existMember || !genMember.docstring) continue;
        matchedExistMembers.add(memberName);

        if (existMember.docstring) {
          const isPreserved = existMember.docstring.text.includes('@oagen-ignore');
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

      // Member-level docstrings — second pass: URL fingerprint fallback
      // Match generated members to existing members by URL pattern when
      // name-based matching fails (e.g., generated "find" vs existing "getOrganization"
      // both call this.workos.get('/organizations/${id}')).
      for (const [_genName, genMember] of genInfo.members) {
        if (!genMember.docstring || !genMember.urlFingerprint) continue;
        // Find unmatched existing member with the same URL fingerprint
        for (const [existName, existMember] of existInfo.members) {
          if (matchedExistMembers.has(existName)) continue;
          if (!existMember.urlFingerprint || existMember.urlFingerprint !== genMember.urlFingerprint) continue;
          if (existMember.docstring) {
            const isPreserved = existMember.docstring.text.includes('@oagen-ignore');
            if (isPreserved) continue;
            if (existMember.docstring.text !== genMember.docstring.text) {
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
          matchedExistMembers.add(existName);
          break; // Only match one existing member per generated member
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
