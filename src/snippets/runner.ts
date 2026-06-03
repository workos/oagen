import type { GeneratedFile, EmitterContext } from '../engine/types.js';
import type { ResolvedOperation } from '../ir/operation-hints.js';
import { createExampleBuilder } from './example-builder.js';
import type { SnippetEmitter, SnippetResult } from './types.js';

/**
 * Run one or more snippet emitters over every resolved operation in the spec.
 *
 * Iteration order matches `ctx.resolvedOperations`. For each operation the
 * runner asks every emitter to render once; emitters that return `null`
 * contribute nothing for that op (the URL-builder / unsupported case).
 *
 * Returns a flat list of {@link SnippetResult}. Consumers map these to
 * file paths according to their own layout — see
 * {@link snippetResultsToFiles} for a convenience that writes
 * `<outputDir>/<language>/<methodName>-request.<ext>`.
 */
export function runSnippetEmitters(emitters: SnippetEmitter[], ctx: EmitterContext): SnippetResult[] {
  const resolved = ctx.resolvedOperations;
  if (!resolved || resolved.length === 0) return [];

  const examples = createExampleBuilder(ctx.spec);
  const results: SnippetResult[] = [];

  for (const op of resolved) {
    for (const emitter of emitters) {
      const content = emitter.renderOperation(op, ctx, examples);
      if (content === null) continue;
      results.push({
        language: emitter.language,
        fileExtension: emitter.fileExtension,
        operationId: operationIdFor(op),
        mountTarget: op.mountOn,
        methodName: op.methodName,
        content: ensureTrailingNewline(content),
      });
    }
  }

  return results;
}

/**
 * Convenience: turn snippet results into oagen-style {@link GeneratedFile}s
 * under `<outputDir>/<language>/<methodName>-request.<extension>`.
 *
 * Useful for consumers wired into the standard oagen file-writing pipeline.
 * Docs builds that already have their own per-tag file layout (e.g.
 * `content/reference/{tag}/_code/...`) typically skip this helper and route
 * `SnippetResult.operationId` / `mountTarget` through their own mapping.
 */
export function snippetResultsToFiles(results: SnippetResult[], outputDir = 'snippets'): GeneratedFile[] {
  return results.map((r) => ({
    path: `${outputDir}/${r.language}/${r.methodName}-request.${r.fileExtension}`,
    content: r.content,
    overwriteExisting: true,
    integrateTarget: false,
  }));
}

function operationIdFor(op: ResolvedOperation): string {
  return `${op.mountOn}.${op.methodName}`;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}
