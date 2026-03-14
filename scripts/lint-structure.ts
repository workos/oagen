/**
 * Structural linter for oagen.
 *
 * Enforces architectural invariants mechanically:
 * - Dependency layer hierarchy (one-way imports)
 * - File naming conventions
 * - Maximum file size
 * - Required emitter exports
 *
 * Error messages include remediation instructions so agents can self-repair.
 *
 * Usage: npx tsx scripts/lint-structure.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');
const MAX_FILE_LINES = 500;

// ── Layer definitions ──────────────────────────────────────────────────

/** Layer index — lower numbers cannot import higher numbers */
const LAYERS: Record<string, number> = {
  ir: 0,
  utils: 1,
  parser: 2,
  engine: 3,
  differ: 3, // same level as engine (imports ir, utils, engine/types)
  emitters: 4,
  cli: 5,
};

/** Special cross-layer allowances */
const ALLOWED_CROSS: [string, string][] = [
  // differ may import engine/types for EmitterContext, GeneratedFile
  ['differ', 'engine'],
];

function layerOf(filePath: string): string | null {
  const rel = relative(SRC, filePath);
  const topDir = rel.split(sep)[0];
  return topDir in LAYERS ? topDir : null;
}

function layerOfImport(importPath: string, sourceFile: string): string | null {
  // Resolve relative import to a layer
  if (!importPath.startsWith('.')) return null; // external package

  // Normalize: walk up from source file
  const parts = importPath.replace(/\.js$/, '').split('/');

  // Find the target layer by resolving the relative path
  let depth = 0;
  for (const p of parts) {
    if (p === '..') depth++;
    else break;
  }

  // If the import doesn't go above the current directory enough to reach
  // another layer, it's an intra-layer import
  const targetSegment = parts[depth];
  if (targetSegment && targetSegment in LAYERS) {
    return targetSegment;
  }

  // Intra-layer import (e.g., ./naming.js within the same emitter)
  return layerOf(sourceFile);
}

// ── Collect source files ───────────────────────────────────────────────

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ── Checks ─────────────────────────────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  rule: string;
  message: string;
  fix: string;
}

function checkDependencyLayers(files: string[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const sourceLayer = layerOf(file);
    if (!sourceLayer) continue;

    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^import .+ from ['"]([^'"]+)['"]/);
      if (!match) continue;

      const importPath = match[1];
      const targetLayer = layerOfImport(importPath, file);
      if (!targetLayer || targetLayer === sourceLayer) continue;

      const sourceLevel = LAYERS[sourceLayer];
      const targetLevel = LAYERS[targetLayer];

      // Check if this is an allowed cross-layer import
      const isAllowed = ALLOWED_CROSS.some(([from, to]) => from === sourceLayer && to === targetLayer);

      if (targetLevel > sourceLevel && !isAllowed) {
        const rel = relative(SRC, file);
        violations.push({
          file: rel,
          line: i + 1,
          rule: 'dependency-layer',
          message: `Layer violation: ${sourceLayer} (L${sourceLevel}) imports from ${targetLayer} (L${targetLevel})`,
          fix: `Move the imported code to a lower layer, or extract the needed types into ir/types.ts or utils/. Layer hierarchy: ir(0) → utils(1) → parser(2) → engine(3) → emitters(4) → cli(5). Only higher layers may import lower layers.`,
        });
      }

      // Check emitter cross-imports
      if (sourceLayer === 'emitters' && targetLayer === 'emitters') {
        const sourceRel = relative(SRC, file);
        const sourceEmitter = sourceRel.split(sep)[1]; // e.g., "ruby"
        // Check if the import targets a different emitter
        const importParts = importPath.split('/');
        const upCount = importParts.filter((p) => p === '..').length;
        if (upCount >= 1) {
          // Went up at least one directory — check if landing in a different emitter
          const targetPart = importParts[upCount];
          if (
            targetPart &&
            targetPart !== sourceEmitter &&
            targetPart !== 'ir' &&
            targetPart !== 'utils' &&
            targetPart !== 'engine'
          ) {
            violations.push({
              file: relative(SRC, file),
              line: i + 1,
              rule: 'emitter-isolation',
              message: `Cross-emitter import: ${sourceEmitter} imports from ${targetPart}`,
              fix: `Emitters must be self-contained. If you need shared logic, extract it to src/utils/ or duplicate it in each emitter. Each emitter should only import from ir/, utils/, engine/, and its own directory.`,
            });
          }
        }
      }
    }
  }

  return violations;
}

function checkFileSize(files: string[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const lineCount = content.split('\n').length;

    if (lineCount > MAX_FILE_LINES) {
      violations.push({
        file: relative(SRC, file),
        line: 0,
        rule: 'file-size',
        message: `File has ${lineCount} lines (max ${MAX_FILE_LINES})`,
        fix: `Split this file into smaller, focused modules. For emitter files: extract helper functions into separate files (e.g., a format-helpers.ts). For parser files: extract sub-parsers. Each file should have a single responsibility.`,
      });
    }
  }

  return violations;
}

function checkFileNaming(files: string[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const rel = relative(SRC, file);
    const filename = rel.split(sep).pop()!;

    // All source files should be kebab-case or single-word lowercase
    if (filename !== 'index.ts' && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*\.ts$/.test(filename)) {
      violations.push({
        file: rel,
        line: 0,
        rule: 'file-naming',
        message: `File name "${filename}" does not match kebab-case convention`,
        fix: `Rename to kebab-case (lowercase, words separated by hyphens). Examples: "type-map.ts", "naming.ts", "types-rbs.ts". No camelCase or PascalCase in file names.`,
      });
    }
  }

  return violations;
}

function checkEmitterExports(files: string[]): Violation[] {
  const violations: Violation[] = [];

  // Find all emitter index.ts files
  const emitterIndexFiles = files.filter((f) => {
    const rel = relative(SRC, f);
    const parts = rel.split(sep);
    return parts[0] === 'emitters' && parts.length === 3 && parts[2] === 'index.ts';
  });

  for (const indexFile of emitterIndexFiles) {
    const content = readFileSync(indexFile, 'utf-8');
    const rel = relative(SRC, indexFile);
    const lang = rel.split(sep)[1];

    // Check that the emitter exports an object implementing Emitter
    if (!content.includes('Emitter')) {
      violations.push({
        file: rel,
        line: 0,
        rule: 'emitter-contract',
        message: `Emitter index.ts for "${lang}" does not reference the Emitter interface`,
        fix: `The index.ts must import { Emitter } from "@workos/oagen" and export a const that satisfies the Emitter interface.`,
      });
    }

    // Check required method names exist
    const requiredMethods = [
      'generateModels',
      'generateEnums',
      'generateResources',
      'generateClient',
      'generateErrors',
      'generateConfig',
      'generateTypeSignatures',
      'generateTests',
      'fileHeader',
    ];

    for (const method of requiredMethods) {
      if (!content.includes(method)) {
        violations.push({
          file: rel,
          line: 0,
          rule: 'emitter-contract',
          message: `Emitter "${lang}" missing required method: ${method}`,
          fix: `Add ${method} to the emitter object. It must match the signature in src/engine/types.ts. If the method is not applicable for this language, return [].`,
        });
      }
    }
  }

  return violations;
}

// ── Main ───────────────────────────────────────────────────────────────

const files = collectTsFiles(SRC);

const violations = [
  ...checkDependencyLayers(files),
  ...checkFileSize(files),
  ...checkFileNaming(files),
  ...checkEmitterExports(files),
];

if (violations.length === 0) {
  console.log('✓ All structural checks passed');
  process.exit(0);
}

// Group by rule for readability
const byRule = new Map<string, Violation[]>();
for (const v of violations) {
  const list = byRule.get(v.rule) ?? [];
  list.push(v);
  byRule.set(v.rule, list);
}

let hasError = false;

for (const [rule, vs] of byRule) {
  console.log(`\n── ${rule} (${vs.length} violation${vs.length === 1 ? '' : 's'}) ──\n`);
  for (const v of vs) {
    const loc = v.line > 0 ? `:${v.line}` : '';
    console.log(`  ✗ src/${v.file}${loc}`);
    console.log(`    ${v.message}`);
    console.log(`    FIX: ${v.fix}`);
    console.log();
    hasError = true;
  }
}

if (hasError) {
  console.log(`\n${violations.length} structural violation(s) found.\n`);
  process.exit(1);
}
