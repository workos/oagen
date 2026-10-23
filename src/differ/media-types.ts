import type { RequestBodyContent, ResponseContent, TypeRef } from '../ir/types.js';
import { mediaTypeEssence } from '../utils/media-type.js';
import type { RequestBodyContentTypesChange } from './types.js';
import { typeRefsEqual } from './models.js';

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
 * Which item of the old list each item of the new list is, for two lists
 * whose items are matched by a folded name: an entry's media types by
 * essence, the way the parser types them — `Text/HTML` is `text/html`,
 * `application/problem+json; charset=utf-8` is `application/problem+json` —
 * and its response headers by case-folded name, as HTTP compares them —
 * `X-Rate-Limit` is `x-rate-limit`. Two names of one folding declared side
 * by side (`application/json` beside `application/json; charset=utf-8`)
 * never collapse into one: a new item claims the old item spelled exactly
 * as it is, else the first old item of its folding that nothing claimed, in
 * document order. What is left on the new side was `added`; what is left on
 * the old side was `removed`. Every pair is in the new list's order.
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
 * Which body of the old entry each body of the new entry is: `pairByName`
 * over the bodies, spelled as written (`mediaType`) and folded to their
 * essence, so the two entries' media types compare by essence the way the
 * parser types them without two keys of one essence declared side by side
 * collapsing into one.
 */
export function pairMediaTypeBodies(oldBodies: MediaTypeBody[], newBodies: MediaTypeBody[]): MediaTypeBodiesDiff {
  return pairByName(
    oldBodies,
    newBodies,
    (body) => body.mediaType,
    (body) => body.essence,
  );
}

/**
 * The pairs whose body types differ, except the own body on both sides when
 * `ownCoveredElsewhere`: another comparison (`responseChanged`,
 * `errorsChanged`, `requestBodyChanged`) reports that very retype.
 */
export function retypedBodies(
  pairs: Array<[MediaTypeBody, MediaTypeBody]>,
  ownCoveredElsewhere: boolean,
): Array<[MediaTypeBody, MediaTypeBody]> {
  return pairs.filter(([before, after]) => {
    if (!before.type || !after.type || typeRefsEqual(before.type, after.type)) return false;
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
 * it) and one the sender can no longer use is additive. `undefined` when
 * nothing changed.
 */
export function diffRequestBodyContentTypes(
  oldBody: RequestBodyMediaTypes,
  newBody: RequestBodyMediaTypes,
  side: RequestBodySide,
): RequestBodyContentTypesChange | undefined {
  if (!declaresBody(oldBody) || !declaresBody(newBody)) return undefined;
  const { pairs, added, removed } = pairMediaTypeBodies(requestBodyBodies(oldBody), requestBodyBodies(newBody));
  const retyped = retypedBodies(pairs, true);
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

/** A request body's media types as the differ compares them, the one `requestBody` was read from marked `own`. */
function requestBodyBodies(body: RequestBodyMediaTypes): MediaTypeBody[] {
  return mediaTypeBodies(body.requestBodyContentTypes ?? [], body.requestBodyContents ?? [], body.requestBody);
}

/**
 * Whether the representation `requestBody` is read from in `from` — the
 * media type it was read from, with its type — is one `to` declares with an
 * unchanged type: paired by essence as `diffRequestBodyContentTypes` pairs
 * the two sides, the types compared as a retype is (`typeRefsEqual`). This
 * decides whether an encoding shift (`requestBodyEncodingShift`) breaks a
 * side of the wire: for an operation, whether the representation the old
 * SDK sends (`from` the old spec) is still accepted by the new spec (`to`);
 * for a webhook, whether the representation the sender now uses (`from`
 * the new spec) is one the old handler (`to`) already decoded. `false` when
 * `from` marks no own body — no media-type lists, or none read as
 * `requestBody` — so a hand-built IR without lists keeps the breaking
 * reading.
 */
export function ownRepresentationKept(from: RequestBodyMediaTypes, to: RequestBodyMediaTypes): boolean {
  const fromBodies = requestBodyBodies(from);
  const own = fromBodies.find((body) => body.own);
  if (!own?.type) return false;
  const counterpart = pairMediaTypeBodies(fromBodies, requestBodyBodies(to)).pairs.find(([body]) => body === own)?.[1];
  return counterpart?.type !== undefined && typeRefsEqual(own.type, counterpart.type);
}
