/**
 * Resolution of Reference Objects into `components/responses`.
 *
 * The bundler never inlines internal refs (`dereference: false`), so a
 * response written as `{ $ref: '#/components/responses/Problem' }` reaches
 * extraction as a Reference Object whose `headers` and `content` are
 * nowhere to be read. This module is self-contained so every response path
 * — fallback, explicit status code, webhook — can resolve the same way.
 */

import { followReference, type ReferenceObject, type SiblingDocs } from './reference-objects.js';

export type { ReferenceObject };

/**
 * Resolve a raw response to a concrete Response Object, following `$ref`
 * chains into `components/responses` (`followReference`, the walk every
 * Reference Object takes). The text written beside a ref follows the one
 * rule stated there: in an OAS 3.1 document the outermost sibling
 * `description` with content wins over an inner ref's and over the
 * component's; under `siblingDescriptions: 'ignore'` (OAS 3.0, where
 * properties beside a `$ref` are ignored) the component's own is kept. A ref
 * nothing under `components/responses` answers (a pointer into another
 * section, or one a bundler wrote to the first place it inlined a repeated
 * external ref, `#/paths/~1pets/get/responses/200`) is warned about and
 * returned as written: no body, no headers, its sibling `description` kept
 * under `'override'` and, as beside every ref, ignored under `'ignore'`. So
 * is a `$ref` that is not a string (`{ $ref: 42 }`), direct or at the end of
 * a chain, with a warning naming the value as JSON — `42`, `true`, `null`,
 * `[]`, `["#/components/responses/NotFound"]`, `{"name":"x"}` — so an array
 * or an object never reads as nothing or as the string it is not, as the
 * webhook reader warns about the same ref (#563). A document that parsed
 * before any response ref was resolved still parses. Only a circular chain
 * throws, since no reader could resolve it. Under `onFailure: 'silent'`
 * neither failure is reported and the ref is returned as written; that is
 * for a reader that only pre-computes names, leaving the report to the
 * operation that declares the ref.
 */
export function resolveResponseRef<T extends object>(
  raw: T | ReferenceObject,
  componentResponses: Record<string, Record<string, unknown>> | undefined,
  context: string,
  siblingDescriptions: SiblingDocs = 'override',
  onFailure: 'report' | 'silent' = 'report',
): T {
  const followed = followReference<T>(raw, 'responses', componentResponses, siblingDescriptions);
  if (onFailure === 'report') {
    if (followed.outcome === 'circular') {
      throw new Error(`Circular response $ref chain starting at "${followed.ref}" in ${context}.`);
    }
    // `silent` is for a reader that only pre-computes names from the
    // component map (`resolvePathModelBaseNames`): the operation that
    // declares the ref reports the problem once when it reads it, so this
    // reader neither warns nor throws and returns the ref as written.
    if (followed.outcome === 'unresolved') {
      console.warn(
        `[oagen] Warning: Unresolved response $ref "${followed.ref}" in ${context}: no matching entry under components/responses — reading the response as written, without a body or headers`,
      );
    }
    // A `$ref` that is not a string ends the walk as `malformed` and is read
    // as written like a ref nothing answers; it is warned about the same
    // way, naming the value, as the webhook reader warns about it (#563).
    // The value is rendered as JSON, read off the object the walk stopped at
    // (`followed.ref` is `String()` of it, which prints `[]` as nothing and
    // `["#/components/responses/NotFound"]` as the string it is not).
    if (followed.outcome === 'malformed') {
      const { $ref } = followed.value as { $ref?: unknown };
      console.warn(
        `[oagen] Warning: Malformed response $ref ${JSON.stringify($ref)} in ${context}: a $ref must be a string — reading the response as written, without a body or headers`,
      );
    }
  }
  return followed.value;
}
