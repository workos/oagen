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
 * chains into `components/responses` with a cycle guard. Each ref in a chain
 * overrides what it points at, so the outermost sibling `description` wins
 * over any inner one and over the component's. Throws on an unresolvable or
 * circular ref so a malformed spec fails at parse time instead of silently
 * losing the body and headers the ref stands for.
 */
export function resolveResponseRef<T extends object>(
  raw: T | ReferenceObject,
  componentResponses: Record<string, Record<string, unknown>> | undefined,
  context: string,
): T {
  const seenRefs = new Set<string>();
  let current: T | ReferenceObject = raw;
  let description: string | undefined;

  while ('$ref' in current && typeof current.$ref === 'string') {
    if (description === undefined && typeof current.description === 'string') description = current.description;
    if (seenRefs.has(current.$ref)) {
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
      throw new Error(
        `Unresolved response $ref "${current.$ref}" in ${context}: no matching entry under components/responses.`,
      );
    }
    current = resolved as unknown as T | ReferenceObject;
  }

  return (description === undefined ? current : { ...current, description }) as T;
}
