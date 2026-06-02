import type { EmitterContext } from '../engine/types.js';
import type { ResolvedOperation } from '../ir/operation-hints.js';
import type { ExampleBuilder } from './example-builder.js';

/**
 * A call-site code sample for one SDK operation.
 *
 * Snippet emitters produce these instead of full SDK source files. Consumers
 * (REST API docs builds, partner integrations, etc.) decide where to write
 * them based on their own layout conventions — see
 * {@link snippetResultsToFiles} for a default file-per-snippet layout.
 */
export interface SnippetResult {
  /** Language key (e.g. 'ruby', 'node'). Matches the underlying SDK emitter. */
  language: string;
  /** File extension without the leading dot (e.g. 'rb', 'js', 'cs'). */
  fileExtension: string;
  /** Stable identifier for the operation: `${mountTarget}.${methodName}`. */
  operationId: string;
  /** PascalCase mount target the method lives on (e.g. 'Organizations'). */
  mountTarget: string;
  /** snake_case method name as resolved by oagen (e.g. 'create_organization'). */
  methodName: string;
  /** The rendered snippet, ending in a trailing newline. */
  content: string;
}

/**
 * A snippet emitter renders one call-site example per resolved SDK operation
 * in a specific language. Unlike the full {@link Emitter} contract, snippet
 * emitters don't generate models, enums, or clients — only short, runnable
 * call samples.
 *
 * Implementations typically reuse the corresponding full emitter's naming
 * helpers (e.g. `src/<lang>/naming.ts`) so generated snippets stay in
 * lockstep with the SDK they document. Framework primitives like
 * {@link collectSnippetArgs} live in `@workos/oagen` so emitter authors
 * don't have to reimplement the required-only / hidden-param / split-wrapper
 * logic per language.
 */
export interface SnippetEmitter {
  /** Language key (must match the full emitter's `language`). */
  language: string;
  /** File extension without the leading dot. */
  fileExtension: string;
  /**
   * Render a single resolved operation as a complete, runnable snippet.
   *
   * Return `null` to skip — e.g. for URL-builder operations that don't make
   * an HTTP call, or other shapes the language SDK doesn't expose.
   */
  renderOperation(resolved: ResolvedOperation, ctx: EmitterContext, examples: ExampleBuilder): string | null;
}
