import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SRC_ROOT = resolve(ROOT, 'src');

type Layer = 'root' | 'ir' | 'utils' | 'parser' | 'engine' | 'differ' | 'compat' | 'verify' | 'cli';

interface ImportEdge {
  from: string;
  to: string;
  specifier: string;
  typeOnly: boolean;
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    if (entry.isFile() && extname(path) === '.ts') {
      files.push(path);
    }
  }

  return files;
}

function classifyLayer(path: string): Layer {
  const rel = relative(SRC_ROOT, path).replaceAll('\\', '/');
  const [first] = rel.split('/');

  switch (first) {
    case 'ir':
      return 'ir';
    case 'utils':
      return 'utils';
    case 'parser':
      return 'parser';
    case 'engine':
      return 'engine';
    case 'differ':
      return 'differ';
    case 'compat':
      return 'compat';
    case 'verify':
      return 'verify';
    case 'cli':
      return 'cli';
    default:
      return 'root';
  }
}

function collectImports(file: string): ImportEdge[] {
  const sourceText = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: ImportEdge[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;

    const target = resolve(dirname(file), specifier);
    const importClause = statement.importClause;
    const typeOnly = importClause?.isTypeOnly ?? false;

    imports.push({ from: file, to: target, specifier, typeOnly });
  }

  return imports;
}

function rel(path: string): string {
  return relative(ROOT, path).replaceAll('\\', '/');
}

function isErrorsModule(path: string): boolean {
  const normalized = rel(path);
  return normalized === 'src/errors.ts' || normalized === 'src/errors.js';
}

function isExemptEntrypoint(path: string): boolean {
  const normalized = rel(path);
  return normalized === 'src/index.ts' || normalized === 'src/errors.ts';
}

function isEngineCompatTypesException(edge: ImportEdge): boolean {
  return (
    classifyLayer(edge.from) === 'engine' &&
    classifyLayer(edge.to) === 'compat' &&
    rel(edge.to) === 'src/compat/types.js' &&
    edge.typeOnly
  );
}

function isDifferEngineTypesException(edge: ImportEdge): boolean {
  return (
    classifyLayer(edge.from) === 'differ' &&
    classifyLayer(edge.to) === 'engine' &&
    rel(edge.to) === 'src/engine/types.js' &&
    edge.typeOnly
  );
}

function isAllowed(edge: ImportEdge): boolean {
  if (isExemptEntrypoint(edge.from)) return true;
  if (isErrorsModule(edge.to)) return true;

  const from = classifyLayer(edge.from);
  const to = classifyLayer(edge.to);

  if (from === 'root') return true;
  if (to === 'root') return false;
  if (from === to) return true;

  switch (from) {
    case 'ir':
      return false;
    case 'utils':
      return to === 'ir';
    case 'parser':
      return to === 'ir' || to === 'utils';
    case 'engine':
      return to === 'ir' || to === 'utils' || to === 'differ' || isEngineCompatTypesException(edge);
    case 'differ':
      return to === 'ir' || to === 'utils' || isDifferEngineTypesException(edge);
    case 'compat':
      return to === 'ir' || to === 'utils' || to === 'differ';
    case 'verify':
      return to === 'ir' || to === 'utils' || to === 'engine' || to === 'compat';
    case 'cli':
      return true;
  }

  return true;
}

describe('dependency layers', () => {
  it('only allows documented cross-layer imports', () => {
    const files = walk(SRC_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      for (const edge of collectImports(file)) {
        if (isAllowed(edge)) continue;

        violations.push(
          `${rel(edge.from)} -> ${edge.specifier} (${rel(edge.to)}), ` +
            `from layer "${classifyLayer(edge.from)}" to "${classifyLayer(edge.to)}"`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});
