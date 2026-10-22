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
