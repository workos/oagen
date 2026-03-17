import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GeneratedFile } from './types.js';
import { mergeIntoExisting, hasGrammar } from './merger.js';

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
  const result: WriteResult = { written: [], merged: [], skipped: [], identical: [] };
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

    // skipIfExists → hard skip, no merge
    if (file.skipIfExists) {
      result.skipped.push(file.path);
      continue;
    }

    // Identical content → no-op
    if (existingContent === file.content) {
      result.identical.push(file.path);
      continue;
    }

    // JSON files → overwrite (data files like manifests)
    if (file.path.endsWith('.json')) {
      await fs.writeFile(fullPath, file.content, 'utf-8');
      result.written.push(file.path);
      continue;
    }

    // Source files with grammar → AST-level merge
    if (language && hasGrammar(language)) {
      const mergeResult = await mergeIntoExisting(existingContent, file.content, language, header);

      if (!mergeResult.changed) {
        result.identical.push(file.path);
        continue;
      }

      await fs.writeFile(fullPath, mergeResult.content, 'utf-8');
      result.merged.push(file.path);
      continue;
    }

    // No grammar available → skip to avoid clobbering
    result.skipped.push(file.path);
  }

  return result;
}
