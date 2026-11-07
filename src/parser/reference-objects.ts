/**
 * Resolution of Reference Objects: `{ $ref: '#/components/<section>/<name>' }`
 * written where OpenAPI allows one in place of a Parameter, Request Body,
 * Response, Header, Example or Security Scheme Object. The bundler never inlines internal refs
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
 * (`REFERENCE_DOC_FIELDS`). Neither version lets a Reference Object carry
 * anything else — "any properties added SHALL be ignored" — so a `content`
 * or `headers` written beside a response `$ref`, or a `value` beside an
 * example's, is never read: a ref that resolves reads the component, and
 * one that fails is returned with nothing but its `$ref` and the text the
 * rule above keeps (#562).
 *
 * A Path Item's `$ref` is not a Reference Object: OpenAPI leaves a field
 * present on both sides undefined, and `resolvePathItemRef` takes the
 * referenced item whole. A Schema Object's `$ref` is JSON Schema's, whose
 * siblings the field extractor reads (`Field.description`).
 */
import { componentRefEntry } from './path-item-refs.js';

/** Whether text written beside a `$ref` overrides the referenced component's (OAS 3.1) or is ignored (OAS 3.0). */
export type SiblingDocs = 'override' | 'ignore';

/** `'ignore'` for an OAS 3.0 document, where nothing beside a `$ref` is read; `'override'` for 3.1 and for a version not recognised. */
export function siblingDocsMode(openapiVersion: string | undefined): SiblingDocs {
  return openapiVersion?.startsWith('3.0') ? 'ignore' : 'override';
}

/** The `components` sections a Reference Object may point into. */
export type ReferenceSection =
  | 'parameters'
  | 'requestBodies'
  | 'responses'
  | 'headers'
  | 'examples'
  | 'securitySchemes';

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
  securitySchemes: ['description'],
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
   * Reference Object the walk stopped at, reduced to what one may carry —
   * its `$ref` and, under `'override'`, that text. Every other key written
   * beside the `$ref` is left out (#562), and under `'ignore'`, where no
   * ref's text is read, so is the text (#444). The object itself when
   * nothing was kept or left out, so an inline object or an undescribed ref
   * keeps its identity. Typed as the caller expects; for a failure it is the
   * ref.
   */
  value: T;
  /** The `$ref` the walk stopped at, for a failure (`String()` of a malformed one); absent when resolved. */
  ref?: string;
  /**
   * For `unresolved` only: the entry the section does hold under the ref's
   * name when it is no object — `null`, a string, a number, a boolean or an
   * array — and so answers nothing, with the name decoded, so a reader can
   * report it as the malformed entry it is rather than as missing (#617).
   * Absent when the section holds nothing under that name at all.
   */
  found?: { name: string; value: unknown };
}

/**
 * Follow `raw` through `#/components/<section>/…` refs to the object it
 * denotes, keeping the text written beside each ref by the rule above, and
 * say how the walk ended. What a failure means — fail the parse, drop the
 * node, read the ref as written — is each caller's own; the walk itself
 * never reports. A `$ref` key holding `undefined` is no reference, and a
 * component that is not an object — an array included — answers nothing:
 * the walk ends `unresolved` on the ref, handing the entry back as `found`.
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
  const ended = (
    outcome: ReferenceOutcome,
    ref?: string,
    found?: FollowedReference<T>['found'],
  ): FollowedReference<T> => {
    let value: object;
    if (outcome === 'resolved') {
      value = Object.keys(kept).length === 0 ? current : { ...current, ...kept };
    } else {
      // A failed walk stops at a Reference Object, which carries nothing but
      // its `$ref` and the text the rule above keeps: the text beside it is
      // read under 'override' and, as every other ref's, ignored under
      // 'ignore' (#444), and every other key written beside the `$ref` — a
      // response's `content` or `headers`, an example's `value` — is left
      // out, as OpenAPI says of any property added to a Reference Object
      // (#562), so no reader takes it for the object's own. The ref itself
      // when that leaves it as written, so an undescribed ref keeps its
      // identity.
      const reference: Record<string, unknown> = { $ref: (current as { $ref: unknown }).$ref, ...kept };
      value = holdsExactly(current, reference) ? current : reference;
    }
    return {
      outcome,
      value: value as T,
      ...(ref !== undefined ? { ref } : {}),
      ...(found !== undefined ? { found } : {}),
    };
  };

  while ('$ref' in current) {
    const ref = (current as { $ref: unknown }).$ref;
    if (ref === undefined) break;
    // The text beside this ref is read before the walk can end on it, so a
    // malformed ref's own travels with it as a dangling one's does.
    if (siblings === 'override') {
      for (const field of fields) {
        const text = (current as Partial<Record<ReferenceDocField, unknown>>)[field];
        if (kept[field] === undefined && typeof text === 'string' && text.trim() !== '') kept[field] = text;
      }
    }
    if (typeof ref !== 'string') return ended('malformed', String(ref));
    if (seen.has(ref)) return ended('circular', ref);
    seen.add(ref);
    const entry = componentRefEntry(ref, section, components);
    if (entry === undefined) return ended('unresolved', ref);
    // The section holds the name, but no object: nothing to walk into. The
    // entry travels with the outcome so a reader can say what it found.
    if (!isRecord(entry.value)) return ended('unresolved', ref, entry);
    current = entry.value;
  }
  return ended('resolved');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `object` holds exactly `entries`, key for key and value for value, so it can stand for them as it is. */
function holdsExactly(object: object, entries: Record<string, unknown>): boolean {
  const own = object as Record<string, unknown>;
  const keys = Object.keys(own);
  return (
    keys.length === Object.keys(entries).length && keys.every((key) => key in entries && own[key] === entries[key])
  );
}
