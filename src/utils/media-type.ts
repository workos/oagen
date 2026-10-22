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
 * media type among the `content` keys it is declared beside (`siblings`,
 * the key itself included or not): the essence's token (`text/html` →
 * `TextHtml`, `application/json; charset=utf-8` → `ApplicationJson`), so a
 * key keeps its model name however it is spelled — plus the key's own
 * parameters (`application/yaml; charset=utf-8` → `ApplicationYamlCharsetUtf8`)
 * only when another key of the same essence sits beside it, so two spellings
 * of one essence declared side by side take names that do not depend on
 * their order. Parameters are lower-cased before casing, so `Charset=UTF-8`
 * and `charset=utf-8` agree; their order is kept. A wildcard segment reads
 * as `Any` (`application/*` → `ApplicationAny`); nothing left reads as `Content`.
 */
export function mediaTypeNameFragment(contentType: string, siblings: Iterable<string> = []): string {
  const essence = mediaTypeEssence(contentType);
  const token = toPascalCase(essence.split('*').join('Any'));
  const parameters = toPascalCase(
    contentType
      .slice(contentType.indexOf(';') + 1)
      .trim()
      .toLowerCase(),
  );
  const shared =
    contentType.includes(';') &&
    [...siblings].some((sibling) => sibling !== contentType && mediaTypeEssence(sibling) === essence);
  const fragment = shared ? `${token}${parameters}` : token;
  return fragment.length > 0 ? fragment : 'Content';
}
