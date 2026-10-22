/**
 * Resolution of Reference Objects into `components/responses`.
 *
 * The bundler never inlines internal refs (`dereference: false`), so a
 * response written as `{ $ref: '#/components/responses/Problem' }` reaches
 * extraction as a Reference Object whose `headers` and `content` are
 * nowhere to be read. This module is self-contained so every response path
 * — fallback, explicit status code, webhook — can resolve the same way.
 */

/**
 * A Reference Object as written beside a response. In OAS 3.1 it may carry
 * its own `description`, which overrides the referenced component's.
 */
export interface ReferenceObject {
  $ref: string;
  description?: string;
}

/**
 * Resolve a raw response to a concrete Response Object, following `$ref`
 * chains into `components/responses` with a cycle guard. In an OAS 3.1
 * document each ref in a chain overrides what it points at, so the outermost
 * sibling `description` wins over any inner one and over the component's;
 * OAS 3.0 says properties beside a `$ref` are ignored, so under
 * `siblingDescriptions: 'ignore'` the component's own is kept. A ref nothing under
 * `components/responses` answers (a pointer into another section, or one a
 * bundler wrote to the first place it inlined a repeated external ref,
 * `#/paths/~1pets/get/responses/200`) is warned about and returned as written, so the response reads as it always
 * did: no body, no headers, its sibling `description` kept. A document that
 * parsed before any response ref was resolved still parses. Only a circular
 * chain throws, since no reader could resolve it. Under `onFailure: 'silent'`
 * neither failure is reported and the ref is returned as written; that is
 * for a reader that only pre-computes names, leaving the report to the
 * operation that declares the ref.
 */
export function resolveResponseRef<T extends object>(
  raw: T | ReferenceObject,
  componentResponses: Record<string, Record<string, unknown>> | undefined,
  context: string,
  siblingDescriptions: 'override' | 'ignore' = 'override',
  onFailure: 'report' | 'silent' = 'report',
): T {
  const seenRefs = new Set<string>();
  let current: T | ReferenceObject = raw;
  let description: string | undefined;

  while ('$ref' in current && typeof current.$ref === 'string') {
    if (siblingDescriptions === 'override' && description === undefined && typeof current.description === 'string') {
      description = current.description;
    }
    if (seenRefs.has(current.$ref)) {
      if (onFailure === 'silent') break;
      throw new Error(`Circular response $ref chain starting at "${current.$ref}" in ${context}.`);
    }
    seenRefs.add(current.$ref);

    // Match the whole pointer, not just its last token: a ref into any other
    // section must not resolve off a same-named response component.
    const match = /^#\/components\/responses\/(.+)$/.exec(current.$ref);
    // JSON Pointer escapes (RFC 6901 §4): `~1` -> `/`, then `~0` -> `~`, in that order.
    const refName = match?.[1].replace(/~1/g, '/').replace(/~0/g, '~');
    const resolved = refName ? componentResponses?.[refName] : undefined;
    if (!resolved) {
      // `silent` is for a reader that only pre-computes names from the
      // component map (`resolvePathModelBaseNames`): the operation that
      // declares the ref reports the problem once when it reads it, so this
      // reader neither warns nor throws and returns the ref as written.
      if (onFailure === 'report') {
        console.warn(
          `[oagen] Warning: Unresolved response $ref "${current.$ref}" in ${context}: no matching entry under components/responses — reading the response as written, without a body or headers`,
        );
      }
      break;
    }
    current = resolved as unknown as T | ReferenceObject;
  }

  return (description === undefined ? current : { ...current, description }) as T;
}
