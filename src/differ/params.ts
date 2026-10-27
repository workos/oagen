import type { Parameter } from '../ir/types.js';
import { parameterKey } from '../ir/parameter-key.js';
import { isJsonMediaType, mediaTypeEssence } from '../utils/media-type.js';
import type { ParamLocation } from './types.js';

/** A parameter tagged with where it lives, as `locatedParams` yields it. */
export interface LocatedParam {
  p: Parameter;
  loc: ParamLocation;
}

/**
 * The parameter lists an operation or a webhook carries, by location.
 * `Operation` has all four (`cookieParams` only when the document declares
 * one); `Webhook` has no `pathParams`.
 */
export interface ParamCarrier {
  pathParams?: Parameter[];
  queryParams: Parameter[];
  headerParams: Parameter[];
  cookieParams?: Parameter[];
}

/**
 * Every parameter an operation or a webhook carries, each tagged with its
 * location, in one fixed order: path, query, header, cookie. `diffParams`
 * (operations) and `diffWebhookParams` (webhooks) both build their two sides
 * from this walk, so a location the IR carries is never compared on one node
 * and skipped on the other — an operation's cookie parameters were (#294).
 *
 * `Operation.bodyOwnedQueryParams` is not walked. Those are query parameters
 * the request body also declares as properties, on a body-carrying method;
 * they travel in the body only and no emitter serializes them to the URL,
 * so the differ compares them as fields of the body's model, and a query
 * parameter the body takes over is reported as `param-removed` at `query`.
 */
export function locatedParams(node: ParamCarrier): LocatedParam[] {
  const tagged = (loc: ParamLocation, params: Parameter[] | undefined): LocatedParam[] =>
    (params ?? []).map((p) => ({ p, loc }));
  return [
    ...tagged('path', node.pathParams),
    ...tagged('query', node.queryParams),
    ...tagged('header', node.headerParams),
    ...tagged('cookie', node.cookieParams),
  ];
}

/**
 * The key a parameter is matched on between two specs. OpenAPI allows a path
 * `id` beside a query `id` on one operation, and a webhook's header and query
 * parameters may share a name, so the name alone does not identify one
 * (#261): the location is joined to it. Header names are case-insensitive
 * (RFC 9110 §5.1), so a header's name is folded before it is joined (#295).
 * The rule is `parameterKey` in `ir/parameter-key.ts`, the identity the
 * parser merges a path item's parameters with an operation's on, so what the
 * parser reads as one parameter the differ pairs as one.
 */
export function paramKey(loc: ParamLocation, name: string): string {
  return parameterKey(loc, name);
}

/** The two sides of a parameter's media type, carried on the `param-content-type-changed` entry that reports them. */
export interface ParameterContentTypeShift {
  /** The old spec's `content` key as written (see `declaredMediaType`), or `null` for a parameter typed by `schema`. */
  oldContentType: string | null;
  /** The new spec's `content` key as written (see `declaredMediaType`), or `null` for a parameter typed by `schema`. */
  newContentType: string | null;
  /** `content type <schema> → application/json`, each side as written, a side the parser does not read followed by `(unread)`. */
  details: string;
}

/** The media type a parameter is declared in, and whether the parser read the value's type from it. */
interface DeclaredMediaType {
  contentType: string;
  read: boolean;
}

/**
 * `Parameter.contentType` when the `content` map is read; else, for a map
 * none of whose media types is read, the first of `Parameter.contentTypes`,
 * whose value is a string sent as written; `null` for a parameter typed by
 * `schema`.
 */
function declaredMediaType(param: Parameter): DeclaredMediaType | null {
  if (param.contentType !== undefined) return { contentType: param.contentType, read: true };
  const declared = param.contentTypes?.[0];
  return declared !== undefined ? { contentType: declared, read: false } : null;
}

/**
 * How a paired parameter's media type differs between two specs, or
 * `undefined` when it does not. The media type decides how the value is
 * serialized — a `content` parameter's value is sent in that media type, a
 * `schema` parameter's by `style`/`explode` — so a parameter that moves
 * between `schema` and `content`, or between two media types that differ in
 * essence (`application/json` → `text/plain`), is a change even when its
 * type did not move. A `content` map none of whose media types is read
 * carries no `contentType` and is compared by the first media type it
 * declares (`contentTypes`), not taken for `schema` (#410). Its string
 * value is sent as written rather than encoded in that media type, so a
 * map read on one side only is a change even when the essence is kept (a
 * JSON entry that gained or lost its schema); `details` marks an unread
 * side `(unread)`. The two keys are compared by essence
 * (`mediaTypeEssence`: `type/subtype`, case folded, parameters stripped),
 * since neither case nor a parameter such as `charset` changes how the
 * value is encoded; both are carried as written. `diffParams` (operations)
 * and `diffWebhookParams` (webhooks) report it through this one rule.
 */
export function parameterContentTypeShift(
  oldParam: Parameter,
  newParam: Parameter,
): ParameterContentTypeShift | undefined {
  const oldSide = declaredMediaType(oldParam);
  const newSide = declaredMediaType(newParam);
  const same =
    oldSide === null || newSide === null
      ? oldSide === newSide
      : oldSide.read === newSide.read &&
        mediaTypeEssence(oldSide.contentType) === mediaTypeEssence(newSide.contentType);
  if (same) return undefined;
  const label = (side: DeclaredMediaType | null): string =>
    side === null ? '<schema>' : side.read ? side.contentType : `${side.contentType} (unread)`;
  return {
    oldContentType: oldSide?.contentType ?? null,
    newContentType: newSide?.contentType ?? null,
    details: `content type ${label(oldSide)} → ${label(newSide)}`,
  };
}

/**
 * Whether both parameters are read from a JSON media type —
 * `application/json` or a `+json` one (`isJsonMediaType`, the rule the
 * parser reads a `content` map by) — so the value is JSON-encoded on both
 * sides and a move between the two (`application/json` →
 * `application/vnd.api+json`) changes nothing a caller sends or a handler
 * decodes: the one `param-content-type-changed` that is additive (#410).
 * A JSON entry without a schema is not read, and its value is sent as
 * written, so it does not count.
 */
export function jsonEncodedOnBothSides(oldParam: Parameter, newParam: Parameter): boolean {
  return [oldParam, newParam].every((p) => p.contentType !== undefined && isJsonMediaType(p.contentType));
}
