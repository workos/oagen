import type { RequestBodyContent, ResponseContent, TypeRef } from '../ir/types.js';
import { mediaTypeEssence } from '../utils/media-type.js';
import type { RequestBodyContentTypesChange } from './types.js';
import { sameShape, type DocumentShapes } from './shapes.js';

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
      ...(content ? { type: content.type } : {}),
      own: content !== undefined && content === own,
    };
  });
}

/** How the media types of one body compare between two specs, each side as written in its spec. */
export interface MediaTypeBodiesDiff {
  /** Every body both specs declare, old beside new, in the new spec's order. */
  pairs: Array<[MediaTypeBody, MediaTypeBody]>;
  added: MediaTypeBody[];
  removed: MediaTypeBody[];
}

/**
 * Which body of the old entry each body of the new entry is, so the two
 * entries' media types compare by essence the way the parser types them —
 * `Text/HTML` is `text/html`, `application/problem+json; charset=utf-8` is
 * `application/problem+json` — without two keys of one essence declared side
 * by side (`application/json` beside `application/json; charset=utf-8`)
 * collapsing into one. A new body claims the old body spelled exactly as it
 * is, else the first old body of its essence that nothing claimed, in
 * document order. What is left on the new side was `added`; what is left on
 * the old side was `removed`. Every pair is in the new entry's order.
 */
export function pairMediaTypeBodies(oldBodies: MediaTypeBody[], newBodies: MediaTypeBody[]): MediaTypeBodiesDiff {
  const unclaimed = new Set(oldBodies);
  const claim = (matches: (old: MediaTypeBody) => boolean): MediaTypeBody | undefined => {
    for (const old of oldBodies) {
      if (!unclaimed.has(old) || !matches(old)) continue;
      unclaimed.delete(old);
      return old;
    }
    return undefined;
  };
  // Exact spellings claim first, whatever their position, so a respelled
  // key never takes the old body an unchanged key still names.
  const bySpelling = new Map<MediaTypeBody, MediaTypeBody>();
  for (const body of newBodies) {
    const old = claim((candidate) => candidate.mediaType === body.mediaType);
    if (old) bySpelling.set(body, old);
  }
  const pairs: Array<[MediaTypeBody, MediaTypeBody]> = [];
  const added: MediaTypeBody[] = [];
  for (const body of newBodies) {
    const old = bySpelling.get(body) ?? claim((candidate) => candidate.essence === body.essence);
    if (old) pairs.push([old, body]);
    else added.push(body);
  }
  return { pairs, added, removed: oldBodies.filter((old) => unclaimed.has(old)) };
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
 * named types), not one whose model was only renamed. `undefined` when
 * nothing changed.
 */
export function diffRequestBodyContentTypes(
  oldBody: RequestBodyMediaTypes,
  newBody: RequestBodyMediaTypes,
  side: RequestBodySide,
  shapes?: DocumentShapes,
): RequestBodyContentTypesChange | undefined {
  if (!declaresBody(oldBody) || !declaresBody(newBody)) return undefined;
  const bodies = (body: RequestBodyMediaTypes): MediaTypeBody[] =>
    mediaTypeBodies(body.requestBodyContentTypes ?? [], body.requestBodyContents ?? [], body.requestBody);
  const { pairs, added, removed } = pairMediaTypeBodies(bodies(oldBody), bodies(newBody));
  const retyped = retypedBodies(pairs, true, shapes);
  if (added.length === 0 && removed.length === 0 && retyped.length === 0) return undefined;
  const breaking = retyped.length > 0 || (side === 'caller' ? removed.length > 0 : added.length > 0);
  return {
    added: added.map((body) => body.mediaType),
    removed: removed.map((body) => body.mediaType),
    retyped: retyped.map(([, after]) => after.mediaType),
    classification: breaking ? 'breaking' : 'additive',
  };
}

/** Whether a body is declared at all: a type was read from it, or it lists media types none of which is read. */
function declaresBody(body: RequestBodyMediaTypes): boolean {
  return body.requestBody !== undefined || body.requestBodyContentTypes !== undefined;
}
