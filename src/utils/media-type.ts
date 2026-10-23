import { toPascalCase } from './naming.js';

/** One `name=value` parameter of a media type, the name lower-cased and the value decoded. */
export interface MediaTypeParameter {
  name: string;
  value: string;
}

/** A media type read into its essence and its parameters (`parseMediaType`). */
export interface ParsedMediaType {
  /** `type/subtype`, trimmed and lower-cased. */
  essence: string;
  /** The parameters in document order, names lower-cased, quoted values decoded. */
  parameters: MediaTypeParameter[];
}

/**
 * A media type read as RFC 9110 §8.3.1 writes it: `type/subtype`, then
 * `;`-separated `name=value` parameters whose value is a token or a
 * quoted-string. A `;` inside a quoted-string does not end a parameter
 * (`profile="https://example.com/a;b"` is one parameter), a backslash inside
 * one escapes the next character (`"say \"hi\""` reads `say "hi"`), and the
 * quotes are not part of the value. The essence is trimmed and lower-cased,
 * and so is every parameter name (they are case-insensitive); a value keeps
 * its case, since whether it matters depends on the parameter. A parameter
 * written without `=` has the empty value, an empty segment (`a;;b`) is
 * skipped, and a quoted-string nobody closes runs to the end of the key.
 * This is the one reader every media-type question goes through — the
 * essence, the model-name fragment and the differ's comparison of
 * parameters — so they agree on where a parameter ends.
 */
export function parseMediaType(contentType: string): ParsedMediaType {
  const segments: string[] = [];
  let segment = '';
  let quoted = false;
  for (let i = 0; i < contentType.length; i++) {
    const char = contentType[i];
    if (quoted) {
      if (char === '\\' && i + 1 < contentType.length) {
        segment += char + contentType[++i];
        continue;
      }
      if (char === '"') quoted = false;
      segment += char;
      continue;
    }
    if (char === ';') {
      segments.push(segment);
      segment = '';
      continue;
    }
    if (char === '"') quoted = true;
    segment += char;
  }
  segments.push(segment);
  const [first = '', ...rest] = segments;
  const parameters: MediaTypeParameter[] = [];
  for (const raw of rest) {
    const parameter = raw.trim();
    if (parameter.length === 0) continue;
    const separator = parameter.indexOf('=');
    const name = (separator === -1 ? parameter : parameter.slice(0, separator)).trim().toLowerCase();
    const value = separator === -1 ? '' : unquote(parameter.slice(separator + 1).trim());
    parameters.push({ name, value });
  }
  return { essence: first.trim().toLowerCase(), parameters };
}

/** A parameter value decoded: a quoted-string without its quotes and with its escapes resolved, a token as written. */
function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  let value = '';
  for (let i = 1; i < raw.length; i++) {
    const char = raw[i];
    if (char === '\\' && i + 1 < raw.length) {
      value += raw[++i];
      continue;
    }
    if (char === '"') break;
    value += char;
  }
  return value;
}

/**
 * A media type's essence — `type/subtype` without parameters, trimmed and
 * lower-cased (RFC 9110 §8.3.1): `application/json; charset=utf-8`,
 * `APPLICATION/JSON` and ` application/json ` are all `application/json`.
 * The essence is what decides how a request or response body is typed and
 * encoded; the content keys themselves stay as written wherever the IR
 * carries them (`responseContentTypes`, `contentTypes`).
 */
export function mediaTypeEssence(contentType: string): string {
  return parseMediaType(contentType).essence;
}

/**
 * Whether a media type is `application/json` itself, by essence
 * (`application/json; charset=utf-8`, `APPLICATION/JSON`): the JSON
 * spelling a request body pick and a response body read prefer over a
 * `+json` type declared beside it.
 */
export function isPlainJsonMediaType(contentType: string): boolean {
  return mediaTypeEssence(contentType) === 'application/json';
}

/**
 * Whether a media type is JSON by essence: `application/json` itself, or any
 * type with the `+json` structured-syntax suffix (`application/vnd.api+json`,
 * `application/merge-patch+json`, `application/problem+json`). The one rule
 * for what a JSON body is, on a request and on a response alike; which JSON
 * spelling wins when several are declared is `isPlainJsonMediaType`'s.
 */
export function isJsonMediaType(contentType: string): boolean {
  const essence = mediaTypeEssence(contentType);
  return essence === 'application/json' || essence.endsWith('+json');
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
 * their order. Parameters are read by `parseMediaType` (a `;` inside a
 * quoted value does not split one) and lower-cased before casing, so
 * `Charset=UTF-8` and `charset=utf-8` agree; their order is kept. A
 * wildcard segment reads as `Any` (`application/*` → `ApplicationAny`);
 * nothing left reads as `Content`.
 */
export function mediaTypeNameFragment(contentType: string, siblings: Iterable<string> = []): string {
  const { essence, parameters } = parseMediaType(contentType);
  const token = toPascalCase(essence.split('*').join('Any'));
  const shared =
    parameters.length > 0 &&
    [...siblings].some((sibling) => sibling !== contentType && mediaTypeEssence(sibling) === essence);
  const fragment = shared
    ? `${token}${toPascalCase(parameters.map((parameter) => `${parameter.name} ${parameter.value}`.toLowerCase()).join(' '))}`
    : token;
  return fragment.length > 0 ? fragment : 'Content';
}
