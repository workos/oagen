import type { RequestBodyContent, ResponseContent, TypeRef } from '../ir/types.js';
import { mediaTypeEssence, mediaTypeParameters } from '../utils/media-type.js';
import type { RequestBodyContentTypesChange } from './types.js';
import { sameShape, type DocumentShapes } from './shapes.js';

// Read in `utils`, where a secondary body's model is named from the same
// parameters, so the differ and the parser agree on what changed a key.
export { mediaTypeParameters };

/**
 * One media type a request body or a response entry declares, as the differ
 * compares it. Media types are compared by essence — `type/subtype`, case
 * folded, parameters stripped (`mediaTypeEssence`, the parser's own rule for
 * typing a body) — so `Text/HTML` is `text/html` and
 * `application/problem+json; charset=utf-8` is `application/problem+json`,
 * while a change is reported with the key as written in the document that
 * declares it.
 */
export interface MediaTypeBody {
  /** The key as written in its document (`Text/HTML`), which is what a change reports. */
  mediaType: string;
  /** `mediaTypeEssence(mediaType)`: what decides which key of the other document this one is. */
  essence: string;
  /** `mediaTypeParameters(mediaType)`: the parameters that may select another representation, as sorted name/value pairs. */
  parameters: Array<[string, string]>;
  /** The body's type, when the entry's contents carry one for this key. */
  type?: TypeRef;
  /**
   * Whether this is the entry's own body — the one its `type` (a response
   * entry's) or `requestBody` was read from: the content entry that shares
   * that very object (how the parser builds it), or, for an error that
   * carries no lists, the implicit `application/json` entry restored from
   * `type`. Never decided by structural equality, which a secondary body can
   * coincidentally satisfy. No body is the own one for a 3xx, for a request
   * body none of whose media types is read, or in a hand-built IR without
   * that identity.
   */
  own: boolean;
}

/**
 * The bodies of one entry, one per `contentTypes` entry, each with the
 * `contents` entry written under the same key. `ownType` marks the own body
 * by object identity; `ownEssence` is the error-only fallback for an IR
 * whose lists do not share `type`'s object: the first body of that essence
 * (`application/json`, the media type an error's `type` is read from).
 */
export function mediaTypeBodies(
  contentTypes: string[],
  contents: Array<ResponseContent | RequestBodyContent>,
  ownType: TypeRef | undefined,
  ownEssence?: string,
): MediaTypeBody[] {
  const own =
    ownType &&
    (contents.find((c) => c.type === ownType) ??
      (ownEssence ? contents.find((c) => mediaTypeEssence(c.contentType) === ownEssence) : undefined));
  return contentTypes.map((mediaType) => {
    const content = contents.find((c) => c.contentType === mediaType);
    return {
      mediaType,
      essence: mediaTypeEssence(mediaType),
      parameters: mediaTypeParameters(mediaType),
      ...(content ? { type: content.type } : {}),
      own: content !== undefined && content === own,
    };
  });
}

/**
 * The pairs whose parameters other than `charset` differ
 * (`mediaTypeParameters`, compared as structured pairs): the body is typed
 * the same on both sides, but the new spelling may select another
 * representation (`application/pdf; version=1.7` → `; version=2.0`), so it
 * is reported — additive, since callers can still ask for the essence and
 * the shape did not change.
 */
export function reparameterizedBodies(
  pairs: Array<[MediaTypeBody, MediaTypeBody]>,
): Array<[MediaTypeBody, MediaTypeBody]> {
  return pairs.filter(([before, after]) => !sameParameters(before, after));
}

/** A reparameterized pair as a change reports it: both spellings, as written in their specs. */
export function respelling([before, after]: [MediaTypeBody, MediaTypeBody]): { from: string; to: string } {
  return { from: before.mediaType, to: after.mediaType };
}

/** How the media types of one body compare between two specs, each side as written in its spec. */
export interface MediaTypeBodiesDiff {
  /** Every body both specs declare, old beside new, in the new spec's order. */
  pairs: Array<[MediaTypeBody, MediaTypeBody]>;
  added: MediaTypeBody[];
  removed: MediaTypeBody[];
}

/**
 * Which item of the old list each item of the new list is, for two lists
 * whose items are matched by a folded name — a response entry's headers by
 * case-folded name, as HTTP compares them (`foldHeaderName`: `X-Rate-Limit`
 * is `x-rate-limit`). Two names of one folding declared side by side
 * (`X-Foo` beside `x-foo`, which the parser keeps apart only in a hand-built
 * IR) never collapse into one: a new item claims the old item spelled
 * exactly as it is, else the first old item of its folding that nothing
 * claimed, in document order. What is left on the new side was `added`;
 * what is left on the old side was `removed`. Every pair is in the new
 * list's order. `pairMediaTypeBodies` below pairs an entry's media types
 * the same way at its first and last tiers, with parameter and shape tiers
 * of its own between them.
 */
export function pairByName<T>(
  oldItems: T[],
  newItems: T[],
  written: (item: T) => string,
  folded: (item: T) => string,
): { pairs: Array<[T, T]>; added: T[]; removed: T[] } {
  const unclaimed = new Set(oldItems);
  const claim = (matches: (old: T) => boolean): T | undefined => {
    for (const old of oldItems) {
      if (!unclaimed.has(old) || !matches(old)) continue;
      unclaimed.delete(old);
      return old;
    }
    return undefined;
  };
  // Exact spellings claim first, whatever their position, so a respelled
  // name never takes the old item an unchanged name still names.
  const bySpelling = new Map<T, T>();
  for (const item of newItems) {
    const old = claim((candidate) => written(candidate) === written(item));
    if (old) bySpelling.set(item, old);
  }
  const pairs: Array<[T, T]> = [];
  const added: T[] = [];
  for (const item of newItems) {
    const old = bySpelling.get(item) ?? claim((candidate) => folded(candidate) === folded(item));
    if (old) pairs.push([old, item]);
    else added.push(item);
  }
  return { pairs, added, removed: oldItems.filter((old) => unclaimed.has(old)) };
}

/**
 * Which body of the old entry each body of the new entry is, so the two
 * entries' media types compare by essence the way the parser types them —
 * `Text/HTML` is `text/html`, `application/problem+json; charset=utf-8` is
 * `application/problem+json` — without two keys of one essence declared side
 * by side (`application/json` beside `application/json; charset=utf-8`)
 * collapsing into one. Bodies pair in a strict order of preference, each
 * tier run over every new body before the next, so a later tier never takes
 * an old body an earlier one would still name: (1) the old body spelled
 * exactly the same; (2) one of the same essence with the same parameters
 * other than `charset` (`mediaTypeParameters`), so `Application/YAML;
 * version=1` is still `application/yaml; version=1` wherever it moved; (3)
 * one of the same essence whose body is the same shape (`sameShape` through
 * `shapes`), so a key that only edited a parameter finds its body; (4) one
 * of the same essence, in document order. What is left on the new side was
 * `added`; what is left on the old side was `removed`. Every pair is in the
 * new entry's order.
 */
export function pairMediaTypeBodies(
  oldBodies: MediaTypeBody[],
  newBodies: MediaTypeBody[],
  shapes?: DocumentShapes,
): MediaTypeBodiesDiff {
  const unclaimed = new Set(oldBodies);
  const pairedTo = new Map<MediaTypeBody, MediaTypeBody>();
  const tiers: Array<(before: MediaTypeBody, after: MediaTypeBody) => boolean> = [
    (before, after) => before.mediaType === after.mediaType,
    (before, after) => before.essence === after.essence && sameParameters(before, after),
    (before, after) =>
      before.essence === after.essence &&
      before.type !== undefined &&
      after.type !== undefined &&
      sameShape(before.type, after.type, shapes),
    (before, after) => before.essence === after.essence,
  ];
  for (const matches of tiers) {
    for (const after of newBodies) {
      if (pairedTo.has(after)) continue;
      const before = oldBodies.find((candidate) => unclaimed.has(candidate) && matches(candidate, after));
      if (!before) continue;
      unclaimed.delete(before);
      pairedTo.set(after, before);
    }
  }
  const pairs: Array<[MediaTypeBody, MediaTypeBody]> = [];
  const added: MediaTypeBody[] = [];
  for (const after of newBodies) {
    const before = pairedTo.get(after);
    if (before) pairs.push([before, after]);
    else added.push(after);
  }
  return { pairs, added, removed: oldBodies.filter((old) => unclaimed.has(old)) };
}

/** Whether two bodies declare the same parameters other than `charset`, as structured pairs. */
function sameParameters(a: MediaTypeBody, b: MediaTypeBody): boolean {
  return JSON.stringify(a.parameters) === JSON.stringify(b.parameters);
}

/**
 * The pairs whose body types are not one shape (`sameShape`, so a model that
 * was only renamed — as the parser does when a parameter edit on a key
 * declared beside another spelling of its essence renames the model it mints
 * — is no retype; by name alone without `shapes`), except the own body on
 * both sides when `ownCoveredElsewhere`: another comparison
 * (`responseChanged`, `errorsChanged`, `requestBodyChanged`) reports that
 * very retype.
 */
export function retypedBodies(
  pairs: Array<[MediaTypeBody, MediaTypeBody]>,
  ownCoveredElsewhere: boolean,
  shapes?: DocumentShapes,
): Array<[MediaTypeBody, MediaTypeBody]> {
  return pairs.filter(([before, after]) => {
    if (!before.type || !after.type || sameShape(before.type, after.type, shapes)) return false;
    return !(before.own && after.own && ownCoveredElsewhere);
  });
}

/** The request-body fields a media-type comparison reads, shared by `Operation` and `Webhook`. */
export interface RequestBodyMediaTypes {
  requestBody?: TypeRef;
  requestBodyContentTypes?: string[];
  requestBodyContents?: RequestBodyContent[];
}

/**
 * Whose side a request body's media types are judged from: the caller's for
 * an operation (it sends the body), the receiver's for a webhook (its
 * handler decodes the body the sender chose).
 */
export type RequestBodySide = 'caller' | 'receiver';

/**
 * How the media types of an operation's or a webhook's request body changed:
 * its `content` keys, paired by essence exactly as a response entry's are
 * (`pairMediaTypeBodies`), each reported as written in the spec that
 * declares it. Compared only while both specs declare a body — one
 * appearing or disappearing is `requestBodyChanged`'s — and the body
 * `requestBody` was read from (the entry that shares its object) is left to
 * `requestBodyChanged` when it changes type, so a retype here is always a
 * secondary media type's. Classified from `side`: for the caller, a media
 * type it could send that is gone or whose body changed type is breaking and
 * one it can newly send is additive; for the receiver, one the sender can
 * newly use or whose body changed type is breaking (the handler must decode
 * it) and one the sender can no longer use is additive. A retype is a body
 * whose shape changed (`sameShape` through `shapes`, the two documents'
 * named types), not one whose model was only renamed. A pair whose
 * parameters other than `charset` differ is `reparameterized`, additive on
 * either side. `undefined` when nothing changed.
 */
export function diffRequestBodyContentTypes(
  oldBody: RequestBodyMediaTypes,
  newBody: RequestBodyMediaTypes,
  side: RequestBodySide,
  shapes?: DocumentShapes,
): RequestBodyContentTypesChange | undefined {
  if (!declaresBody(oldBody) || !declaresBody(newBody)) return undefined;
  const { pairs, added, removed } = pairMediaTypeBodies(requestBodyBodies(oldBody), requestBodyBodies(newBody), shapes);
  const retyped = retypedBodies(pairs, true, shapes);
  const reparameterized = reparameterizedBodies(pairs);
  if (added.length === 0 && removed.length === 0 && retyped.length === 0 && reparameterized.length === 0) {
    return undefined;
  }
  const breaking = retyped.length > 0 || (side === 'caller' ? removed.length > 0 : added.length > 0);
  return {
    added: added.map((body) => body.mediaType),
    removed: removed.map((body) => body.mediaType),
    retyped: retyped.map(([, after]) => after.mediaType),
    reparameterized: reparameterized.map(respelling),
    classification: breaking ? 'breaking' : 'additive',
  };
}

/** Whether a body is declared at all: a type was read from it, or it lists media types none of which is read. */
function declaresBody(body: RequestBodyMediaTypes): boolean {
  return body.requestBody !== undefined || body.requestBodyContentTypes !== undefined;
}

/** A request body's media types as the differ compares them, the one `requestBody` was read from marked `own`. */
function requestBodyBodies(body: RequestBodyMediaTypes): MediaTypeBody[] {
  return mediaTypeBodies(body.requestBodyContentTypes ?? [], body.requestBodyContents ?? [], body.requestBody);
}

/**
 * Whether the representation one side's `requestBody` is read from — the
 * media type, with its shape — is one the other side declares with an
 * unchanged shape. Which side's is judged from `side`, as
 * `diffRequestBodyContentTypes` is: for the caller (an operation), the old
 * spec's own body must still be declared by the new spec, since an SDK
 * built for the old spec keeps sending it; for the receiver (a webhook),
 * the new spec's own body must already have been declared by the old spec,
 * since the handler built for it decodes only what it declared. The two
 * sides are always paired old against new (`pairMediaTypeBodies`, exactly
 * as the media-type diff pairs them) and compared old against new
 * (`sameShape` through `shapes`, the two documents' named types; by name
 * alone without them), so the documents are never looked up the wrong way
 * round for either side. This decides whether an encoding shift
 * (`requestBodyEncodingShift`) breaks that side of the wire. `false` when
 * the judged side marks no own body — no media-type lists, or none read as
 * `requestBody` — so a hand-built IR without lists keeps the breaking
 * reading.
 */
export function ownRepresentationKept(
  oldBody: RequestBodyMediaTypes,
  newBody: RequestBodyMediaTypes,
  side: RequestBodySide,
  shapes?: DocumentShapes,
): boolean {
  const oldBodies = requestBodyBodies(oldBody);
  const newBodies = requestBodyBodies(newBody);
  const own = (side === 'caller' ? oldBodies : newBodies).find((body) => body.own);
  if (!own?.type) return false;
  const pair = pairMediaTypeBodies(oldBodies, newBodies, shapes).pairs.find(
    ([before, after]) => (side === 'caller' ? before : after) === own,
  );
  if (!pair) return false;
  const [before, after] = pair;
  return before.type !== undefined && after.type !== undefined && sameShape(before.type, after.type, shapes);
}
