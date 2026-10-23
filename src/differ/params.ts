import type { Parameter } from '../ir/types.js';
import { parameterKey } from '../ir/parameter-key.js';
import { mediaTypeEssence } from '../utils/media-type.js';
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

/** The two sides of a parameter's `contentType`, carried on the `param-content-type-changed` entry that reports them. */
export interface ParameterContentTypeShift {
  /** The old spec's `content` key as written, or `null` for a parameter typed by `schema`. */
  oldContentType: string | null;
  /** The new spec's `content` key as written, or `null` for a parameter typed by `schema`. */
  newContentType: string | null;
  /** `content type <schema> → application/json`, each side as written. */
  details: string;
}

/**
 * How a paired parameter's `Parameter.contentType` differs between two
 * specs, or `undefined` when it does not. The media type decides how the
 * value is serialized — a `content` parameter's value is sent in that media
 * type, a `schema` parameter's by `style`/`explode` — so a parameter that
 * moves between `schema` and `content`, or between two media types that
 * differ in essence (`application/json` → `text/plain`), is a change even
 * when its type did not move. The two keys are compared by essence
 * (`mediaTypeEssence`: `type/subtype`, case folded, parameters stripped),
 * since neither case nor a parameter such as `charset` changes how the
 * value is encoded; both are carried as written. `diffParams` (operations)
 * and `diffWebhookParams` (webhooks) report it through this one rule.
 */
export function parameterContentTypeShift(
  oldParam: Parameter,
  newParam: Parameter,
): ParameterContentTypeShift | undefined {
  const oldContentType = oldParam.contentType ?? null;
  const newContentType = newParam.contentType ?? null;
  const same =
    oldContentType === null || newContentType === null
      ? oldContentType === newContentType
      : mediaTypeEssence(oldContentType) === mediaTypeEssence(newContentType);
  if (same) return undefined;
  return {
    oldContentType,
    newContentType,
    details: `content type ${oldContentType ?? '<schema>'} → ${newContentType ?? '<schema>'}`,
  };
}
