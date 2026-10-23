/**
 * Resolution of Reference Objects: `{ $ref: '#/components/<section>/<name>' }`
 * written where OpenAPI allows one in place of a Parameter, Request Body,
 * Response, Header or Example Object. The bundler never inlines internal refs
 * (`dereference: false`), so each reaches the parser as written and is
 * followed here, through one walk, with one reading of the text written
 * beside the `$ref`.
 *
 * OAS 3.1 (§4.8.23) gives a Reference Object a `summary` and a `description`
 * that override the referenced component's; OAS 3.0 gives it no field but
 * `$ref`, so there anything written beside one is ignored
 * (`siblingDocsMode`). Each ref in a chain overrides what it points at, so
 * the outermost text with non-whitespace content wins over an inner ref's
 * and over the component's own; a blank sibling is no text and falls
 * through, as a blank `summary` on an operation falls through to its path
 * item's. `summary` is applied only where the referenced object type has one
 * — an Example Object; OpenAPI says it has no effect elsewhere — so a
 * Parameter, Request Body, Response or Header never gains a `summary` key
 * (`REFERENCE_DOC_FIELDS`).
 *
 * A Path Item's `$ref` is not a Reference Object: OpenAPI leaves a field
 * present on both sides undefined, and `resolvePathItemRef` takes the
 * referenced item whole. A Schema Object's `$ref` is JSON Schema's, whose
 * siblings the field extractor reads (`Field.description`).
 */
import { resolveComponentRef } from './path-item-refs.js';

/** Whether text written beside a `$ref` overrides the referenced component's (OAS 3.1) or is ignored (OAS 3.0). */
export type SiblingDocs = 'override' | 'ignore';

/** `'ignore'` for an OAS 3.0 document, where nothing beside a `$ref` is read; `'override'` for 3.1 and for a version not recognised. */
export function siblingDocsMode(openapiVersion: string | undefined): SiblingDocs {
  return openapiVersion?.startsWith('3.0') ? 'ignore' : 'override';
}

/** The `components` sections a Reference Object may point into. */
export type ReferenceSection = 'parameters' | 'requestBodies' | 'responses' | 'headers' | 'examples';

/** A Reference Object as written, with the documentation OAS 3.1 lets it carry beside the `$ref`. */
export interface ReferenceObject {
  $ref: string;
  summary?: string;
  description?: string;
}

type ReferenceDocField = 'summary' | 'description';

/** The documentation a Reference Object overrides on each object type: `description` everywhere, `summary` only where the type has one. */
const REFERENCE_DOC_FIELDS: Record<ReferenceSection, readonly ReferenceDocField[]> = {
  parameters: ['description'],
  requestBodies: ['description'],
  responses: ['description'],
  headers: ['description'],
  examples: ['summary', 'description'],
};

/**
 * How a walk ended: at the component (or at an inline object that was no
 * reference), at a ref already seen on the chain, at a ref nothing under the
 * section answers (a pointer into another section included, since the whole
 * pointer is matched), or at a `$ref` that is not a string.
 */
export type ReferenceOutcome = 'resolved' | 'circular' | 'unresolved' | 'malformed';

export interface FollowedReference<T> {
  outcome: ReferenceOutcome;
  /**
   * The object the walk ended on, with the text kept from the refs along the
   * chain applied over its own: the component for `resolved`, else the
   * Reference Object the walk stopped at, as written. The object itself when
   * nothing was kept, so an inline object or an undescribed ref keeps its
   * identity. Typed as the caller expects; for a failure it is the ref.
   */
  value: T;
  /** The `$ref` the walk stopped at, for a failure (`String()` of a malformed one); absent when resolved. */
  ref?: string;
}

/**
 * Follow `raw` through `#/components/<section>/…` refs to the object it
 * denotes, keeping the text written beside each ref by the rule above, and
 * say how the walk ended. What a failure means — fail the parse, drop the
 * node, read the ref as written — is each caller's own; the walk itself
 * never reports. A `$ref` key holding `undefined` is no reference, and a
 * component that is not an object answers nothing.
 */
export function followReference<T extends object>(
  raw: T | ReferenceObject,
  section: ReferenceSection,
  components: Record<string, Record<string, unknown>> | undefined,
  siblings: SiblingDocs,
): FollowedReference<T> {
  const fields = REFERENCE_DOC_FIELDS[section];
  const seen = new Set<string>();
  const kept: Partial<Record<ReferenceDocField, string>> = {};
  let current: object = raw;
  const ended = (outcome: ReferenceOutcome, ref?: string): FollowedReference<T> => ({
    outcome,
    value: (Object.keys(kept).length === 0 ? current : { ...current, ...kept }) as T,
    ...(ref !== undefined ? { ref } : {}),
  });

  while ('$ref' in current) {
    const ref = (current as { $ref: unknown }).$ref;
    if (ref === undefined) break;
    if (typeof ref !== 'string') return ended('malformed', String(ref));
    if (siblings === 'override') {
      for (const field of fields) {
        const text = (current as Partial<Record<ReferenceDocField, unknown>>)[field];
        if (kept[field] === undefined && typeof text === 'string' && text.trim() !== '') kept[field] = text;
      }
    }
    if (seen.has(ref)) return ended('circular', ref);
    seen.add(ref);
    const resolved = resolveComponentRef(ref, section, components);
    if (!resolved || typeof resolved !== 'object') return ended('unresolved', ref);
    current = resolved;
  }
  return ended('resolved');
}
