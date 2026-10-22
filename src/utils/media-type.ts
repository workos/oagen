import { toPascalCase } from './naming.js';

/**
 * A media type's essence — `type/subtype` without parameters, trimmed and
 * lower-cased (RFC 9110 §8.3.1): `application/json; charset=utf-8`,
 * `APPLICATION/JSON` and ` application/json ` are all `application/json`.
 * The essence is what decides how a request or response body is typed and
 * encoded; the content keys themselves stay as written wherever the IR
 * carries them (`responseContentTypes`, `contentTypes`).
 */
export function mediaTypeEssence(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * The PascalCase fragment that qualifies a model minted for a non-primary
 * media type (`<Op><MediaType>Response`, `<Op><MediaType>Request`), taken
 * from the media type's essence so two spellings of one media type name the
 * same model: `text/html` → `TextHtml`, `application/vnd.api+json` →
 * `ApplicationVndApiJson`, and `application/json; charset=utf-8`,
 * `APPLICATION/JSON` and `application/json` all → `ApplicationJson`. A
 * wildcard segment reads as `Any` (`application/*` → `ApplicationAny`), since
 * the caser would drop the `*`; a media type nothing is left of reads as
 * `Content`.
 */
export function mediaTypeNameFragment(contentType: string): string {
  const token = toPascalCase(mediaTypeEssence(contentType).split('*').join('Any'));
  return token.length > 0 ? token : 'Content';
}
