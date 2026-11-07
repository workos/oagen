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
 * returned as the Reference Object it is: its `$ref` and its sibling
 * `description`, kept under `'override'` and, as beside every ref, ignored
 * under `'ignore'` — never a `content` or `headers` written beside the
 * `$ref`, which OpenAPI says to ignore there as it is ignored beside a ref
 * that resolves (#562), so the response has no body and no headers, as the
 * warning says. So is a `$ref` that is not a string (`{ $ref: 42 }`), direct
 * or at the end of a chain, with a warning naming the value as JSON — `42`,
 * `true`, `null`, `[]`, `["#/components/responses/NotFound"]`,
 * `{"name":"x"}` — so an array or an object never reads as nothing or as the
 * string it is not, as the webhook reader warns about the same ref (#563).
 * A document that parsed before any response ref was resolved still parses.
 * An entry that is no object at all — `200: "oops"`, `null`, `7` — never
 * reaches here: every reader checks `isResponseEntry` first and skips it
 * (#617). Only a circular chain throws, since no reader could resolve it. Under
 * `onFailure: 'silent'` neither failure is reported and the ref is returned
 * the same way; that is for a reader that only pre-computes names, leaving
 * the report to the operation that declares the ref.
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

/**
 * Whether a Responses Object entry is something a reader can read at all:
 * a Response Object or a Reference Object, which are objects. An entry
 * written as a string, a number, a boolean, `null` or an array — `200:
 * "oops"`, `200: null`, `200: 7`, `200: true`, `200: []` — is neither, so
 * nothing could be read from it, not even a `$ref`: it is skipped and the
 * operation is read from its other entries, rather than failing the parse
 * with a `TypeError` that names neither the operation nor the key (#617).
 * The reader that reports — the operation's (`extractResponses`) or the
 * webhook's (`extractWebhookResponses`) — passes the site and warns once,
 * naming the value as JSON: `200 response of listPets is not a Response
 * Object (null); skipping it.` A reader that only pre-computes names
 * passes no site and skips the entry silently, leaving the report to the
 * operation that declares it, as `resolveResponseRef` does under
 * `'silent'`.
 */
export function isResponseEntry(raw: unknown, site?: string): raw is Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return true;
  if (site !== undefined) {
    console.warn(`[oagen] Warning: ${site} is not a Response Object (${JSON.stringify(raw)}); skipping it.`);
  }
  return false;
}

/**
 * Whether an operation's or a webhook's `responses` is a Responses Object
 * at all: an object. One written as a string, a number, a boolean, `null`
 * or an array — `responses: "oops"` — declares no response under any key:
 * it is warned about once, naming the operation or webhook and the value as
 * JSON (`responses of listPets is not a Responses Object ("oops"); reading
 * no response from it.`), and read as absent, never as the map of its
 * characters' or elements' indexes, which are no status codes (#617).
 */
export function isResponsesObject(responses: unknown, label: string): responses is Record<string, unknown> {
  if (typeof responses === 'object' && responses !== null && !Array.isArray(responses)) return true;
  console.warn(
    `[oagen] Warning: responses of ${label} is not a Responses Object (${JSON.stringify(responses)}); reading no response from it.`,
  );
  return false;
}
