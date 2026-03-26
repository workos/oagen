import path from 'node:path';
import type { GeneratedFile } from './types.js';
import { writeFiles, type WriteResult } from './writer.js';
import { extractStatements } from './merger.js';
import { hasGrammar } from './merger.js';

/**
 * Resolve a relative import path against a source file path to get the
 * target file path.  Handles implicit .ts extensions and /index.ts.
 */
function resolveImportPath(
  fromFilePath: string,
  importModulePath: string,
  knownPaths: Set<string>,
): string | undefined {
  // Strip quotes from module path key (tree-sitter keeps them)
  const cleaned = importModulePath.replace(/^['"]|['"]$/g, '');
  // Skip non-relative imports (node_modules, bare specifiers)
  if (!cleaned.startsWith('.')) return undefined;

  const dir = path.dirname(fromFilePath);
  const resolved = path.normalize(path.join(dir, cleaned));

  // Try exact match, .ts, /index.ts
  for (const candidate of [resolved, `${resolved}.ts`, `${resolved}/index.ts`]) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Determine whether a generated file is a "root" — a file that should always
 * be integrated into the target.  Roots are entry points from which we trace
 * the import graph.  Everything else must be reachable from a root.
 *
 * Roots: resource classes, client, config, errors, enums, barrel index files.
 * Non-roots: serializers, fixtures, standalone interfaces, test files.
 */
function isRootFile(filePath: string): boolean {
  // Fixtures are never roots (and should be filtered by integrateTarget already)
  if (filePath.includes('/fixtures/')) return false;
  // Test files
  if (filePath.endsWith('.spec.ts') || filePath.endsWith('.test.ts')) return false;
  // Serializer files
  if (filePath.includes('/serializers/')) return false;
  // Standalone interface files (not barrel/index)
  if (filePath.includes('/interfaces/') && !filePath.endsWith('/index.ts')) return false;
  // Everything else is a root: resource classes, client, config, errors, enums, barrel files
  return true;
}

/**
 * Build a file-level dependency graph from generated files and return only
 * files reachable from root entry points.  Uses tree-sitter to parse imports.
 */
export async function treeShakeFiles(files: GeneratedFile[], language: string): Promise<GeneratedFile[]> {
  if (!hasGrammar(language)) return files;

  const knownPaths = new Set(files.map((f) => f.path));

  // Build dependency graph: file → set of files it imports
  const deps = new Map<string, Set<string>>();
  for (const file of files) {
    // Only parse .ts/.js files (skip JSON, etc.)
    if (!file.path.endsWith('.ts') && !file.path.endsWith('.js')) {
      deps.set(file.path, new Set());
      continue;
    }
    const parsed = await extractStatements(file.content, language);
    const fileDeps = new Set<string>();
    for (const imp of parsed.imports) {
      const resolved = resolveImportPath(file.path, imp.key, knownPaths);
      if (resolved) fileDeps.add(resolved);
    }
    // Also check re-export statements (export * from './foo')
    for (const stmt of parsed.statements) {
      if (stmt.kind === 'reexport') {
        // Extract module path from "export * from './foo'" or "export { X } from './foo'"
        const match = stmt.text.match(/from\s+['"]([^'"]+)['"]/);
        if (match) {
          const resolved = resolveImportPath(file.path, match[1], knownPaths);
          if (resolved) fileDeps.add(resolved);
        }
      }
    }
    deps.set(file.path, fileDeps);
  }

  // BFS from roots
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const file of files) {
    if (isRootFile(file.path)) {
      reachable.add(file.path);
      queue.push(file.path);
    }
  }
  while (queue.length > 0) {
    const current = queue.pop()!;
    const fileDeps = deps.get(current);
    if (!fileDeps) continue;
    for (const dep of fileDeps) {
      if (!reachable.has(dep)) {
        reachable.add(dep);
        queue.push(dep);
      }
    }
  }

  return files.filter((f) => reachable.has(f.path));
}

export function mapFilesForTargetIntegration(files: GeneratedFile[], language: string): GeneratedFile[] {
  const langPrefix = `${language}/`;
  return files
    .filter((f) => f.integrateTarget !== false) // integrateTarget: false files are standalone-only
    .map((f) => {
      const stripped = f.path.startsWith(langPrefix) ? f.path.replace(langPrefix, '') : f.path;
      return {
        ...f,
        skipIfExists: false, // Always merge in target — never hard-skip
        path: stripped,
      };
    });
}

export async function integrateGeneratedFiles(opts: {
  files: GeneratedFile[];
  language: string;
  targetDir: string;
  header: string;
}): Promise<WriteResult> {
  const mapped = mapFilesForTargetIntegration(opts.files, opts.language);
  const shaken = await treeShakeFiles(mapped, opts.language);
  return writeFiles(shaken, opts.targetDir, {
    language: opts.language,
    header: opts.header,
  });
}
