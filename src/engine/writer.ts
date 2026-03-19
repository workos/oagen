import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GeneratedFile } from './types.js';
import { mergeIntoExisting, hasGrammar } from './merger.js';
import { deepMergeJson } from './json-merge.js';

export interface WriteOptions {
  /** The emitter language (e.g., "node", "ruby"). Used to select the
   *  tree-sitter grammar for AST-level merging. */
  language?: string;
  /** The auto-generated file header string. */
  header?: string;
}

export interface WriteResult {
  written: string[];
  merged: string[];
  skipped: string[];
  identical: string[];
  ignored: string[];
}

/**
 * Write generated files to disk with AST-level merging.
 *
 * When a file already exists:
 * - skipIfExists → leave it alone entirely
 * - AST merge available → parse both, append only new symbols
 * - No grammar → skip (never clobber hand-written code)
 *
 * New files are always written in full.
 */
export async function writeFiles(
  files: GeneratedFile[],
  outputDir: string,
  options?: WriteOptions,
): Promise<WriteResult> {
  const result: WriteResult = { written: [], merged: [], skipped: [], identical: [], ignored: [] };
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const language = options?.language;
  const header = options?.header ?? '';

  for (const file of sorted) {
    const fullPath = path.join(outputDir, file.path);

    // Check if file already exists
    let existingContent: string | null = null;
    try {
      existingContent = await fs.readFile(fullPath, 'utf-8');
    } catch {
      // File doesn't exist
    }

    // New file → write in full
    if (existingContent === null) {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, file.content, 'utf-8');
      result.written.push(file.path);
      continue;
    }

    // skipIfExists → hard skip, no merge (but ensure header is present)
    if (file.skipIfExists) {
      if (header && !existingContent.startsWith(header)) {
        await fs.writeFile(fullPath, header + '\n\n' + existingContent, 'utf-8');
      }
      result.skipped.push(file.path);
      continue;
    }

    // @oagen-ignore-file → skip entirely (existing file opts out of all generation)
    if (existingContent.includes('@oagen-ignore-file')) {
      result.ignored.push(file.path);
      continue;
    }

    // Identical content → no-op
    if (existingContent === file.content) {
      result.identical.push(file.path);
      continue;
    }

    // JSON files → deep merge preserving existing keys
    if (file.path.endsWith('.json')) {
      try {
        const existingJson = JSON.parse(existingContent);
        const generatedJson = JSON.parse(file.content);
        const merged = deepMergeJson(existingJson, generatedJson);
        const mergedContent = JSON.stringify(merged, null, 2) + '\n';
        if (mergedContent === existingContent) {
          result.identical.push(file.path);
        } else {
          await fs.writeFile(fullPath, mergedContent, 'utf-8');
          result.merged.push(file.path);
        }
      } catch {
        // Parse failed — fall back to overwrite
        await fs.writeFile(fullPath, file.content, 'utf-8');
        result.written.push(file.path);
      }
      continue;
    }

    // Source files with grammar → AST-level merge
    if (language && hasGrammar(language)) {
      try {
        if (file.mergeMode === 'docstring-only') {
          // Only update docstrings and ensure header — no new imports/symbols/members
          const mergeResult = await mergeIntoExisting(existingContent, file.content, language, header, {
            docstringOnly: true,
          });
          let finalContent = mergeResult.content;
          if (header && !finalContent.startsWith(header)) {
            finalContent = header + '\n\n' + finalContent;
          }
          if (finalContent === existingContent) {
            result.identical.push(file.path);
          } else {
            await fs.writeFile(fullPath, finalContent, 'utf-8');
            result.merged.push(file.path);
          }
          continue;
        }

        const mergeResult = await mergeIntoExisting(existingContent, file.content, language, header);

        // Ensure header is present on merged content
        let finalContent = mergeResult.content;
        if (header && !finalContent.startsWith(header)) {
          finalContent = header + '\n\n' + finalContent;
        }

        if (!mergeResult.changed && finalContent === existingContent) {
          result.identical.push(file.path);
          continue;
        }

        await fs.writeFile(fullPath, finalContent, 'utf-8');
        result.merged.push(file.path);
        continue;
      } catch (err) {
        // AST merge failed (e.g. tree-sitter grammar ABI issue) — fall back to overwrite
        console.warn(
          `[oagen] AST merge failed for ${file.path}, falling back to overwrite.${err instanceof Error ? ` ${err.message}` : ''}`,
        );
        await fs.writeFile(fullPath, file.content, 'utf-8');
        result.written.push(file.path);
        continue;
      }
    }

    // No grammar available → skip to avoid clobbering
    result.skipped.push(file.path);
  }

  return result;
}
