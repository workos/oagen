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
 * A media type's parameters other than `charset`, in one form whatever the
 * spelling: each parameter as `parseMediaType` reads it — name lower-cased,
 * quoted value decoded, so a `;` inside the quotes is part of the value and
 * `profile="print"` is `profile=print` — as `[name, value]` pairs sorted by
 * name, then value. So `application/pdf; version=1.7` reads
 * `[['version', '1.7']]`, `text/html; Charset=UTF-8` and `text/html` both
 * read `[]`, and `; a=1; b=2` is `; b=2 ;a=1`. The pairs stay structured
 * (compared JSON-encoded, never joined into one string), so `title="report;
 * version=2"` — one parameter — and `title=report; version=2` — two — are
 * different parameters. `charset` is left out because it never selects
 * another representation of a JSON or text body (RFC 8259 §8.1 has no
 * charset for JSON at all); any other parameter — `version`, `profile` —
 * may. The one reading of parameters `oagen diff` compares two keys by (what
 * `reparameterized` reports) and a secondary body's model is named by
 * (`mediaTypeNameFragment`), so the two agree on what changed a key.
 */
export function mediaTypeParameters(contentType: string): Array<[string, string]> {
  return parseMediaType(contentType)
    .parameters.filter((parameter) => parameter.name !== 'charset')
    .map((parameter): [string, string] => [parameter.name, parameter.value])
    .sort(([aName, aValue], [bName, bValue]) =>
      aName < bName ? -1 : aName > bName ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0,
    );
}

/**
 * The PascalCase fragment that qualifies a model minted for a non-primary
 * media type among the `content` keys it is declared beside (`siblings`,
 * the key itself included or not), built from what `oagen diff` compares two
 * keys by: the essence's token (`text/html` → `TextHtml`, `application/json;
 * charset=utf-8` → `ApplicationJson`), so a key keeps its model name however
 * it is spelled — plus, only when another key of the same essence sits
 * beside it, the key's parameters other than `charset`, sorted
 * (`mediaTypeParameters`: `application/yaml; version=2` →
 * `ApplicationYamlVersion2`, `; b=2; a=1` → `A1B2`), lower-cased before
 * casing — plus `Charset`, without its value, when the key declares a
 * `charset` and nothing else tells it apart from such a key
 * (`application/yaml; charset=utf-8` beside `application/yaml` →
 * `ApplicationYamlCharset`). So neither the keys' order, nor a parameter's,
 * nor a `charset`'s value reaches a name, and a key with no parameter but a
 * `charset` keeps its name when a key told apart by another parameter is
 * declared beside it (`application/yaml; charset=utf-8` beside a new
 * `application/yaml; version=2`). Keys left with one fragment — they differ
 * only in case or whitespace, the order or quoting of their parameters, or
 * the value of the `charset` they both declare — are named in
 * `mediaTypeNamingOrder`. A wildcard segment reads as `Any` (`application/*`
 * → `ApplicationAny`); nothing left reads as `Content`.
 */
export function mediaTypeNameFragment(contentType: string, siblings: Iterable<string> = []): string {
  const { essence, parameters } = parseMediaType(contentType);
  const token = toPascalCase(essence.split('*').join('Any'));
  const compared = mediaTypeParameters(contentType);
  const beside = [...siblings].filter((sibling) => sibling !== contentType && mediaTypeEssence(sibling) === essence);
  let fragment = token;
  if (beside.length > 0) {
    fragment += toPascalCase(compared.map(([name, value]) => `${name} ${value}`.toLowerCase()).join(' '));
    const told = JSON.stringify(compared);
    const charset =
      parameters.some((parameter) => parameter.name === 'charset') &&
      beside.some((sibling) => JSON.stringify(mediaTypeParameters(sibling)) === told);
    if (charset) fragment += 'Charset';
  }
  return fragment.length > 0 ? fragment : 'Content';
}

/**
 * `contentTypes` in the order their models are named: as written, except that
 * keys deriving one fragment among them (`mediaTypeNameFragment`) take the
 * places of that fragment's keys in one order whatever the document's — by
 * the key in one spelling (`namingSpelling`), case folded, then lower case
 * before upper case where only case differs. The first takes the bare name
 * and the next steps from it (or shares it, when its shape is identical), so
 * which key steps depends neither on the keys' order nor on how a key
 * quotes, spaces or orders its parameters: `application/yaml` beside
 * `Application/YAML` is named first wherever either is written, and so is
 * `application/yaml; profile=print` beside `Application/YAML;
 * profile="print"`. Keys alike in that spelling differ in nothing but syntax
 * (`; b=2; a=1` beside `; a=1; b=2`), so they keep their document order: the
 * key as written never decides, or respelling one could swap them.
 */
export function mediaTypeNamingOrder(contentTypes: readonly string[]): string[] {
  const fragments = contentTypes.map((contentType) => mediaTypeNameFragment(contentType, contentTypes));
  const turns = new Map<string, string[]>();
  contentTypes.forEach((contentType, i) => turns.set(fragments[i], [...(turns.get(fragments[i]) ?? []), contentType]));
  // `sort` is stable, so keys alike in `namingSpelling` keep their document order.
  for (const keys of turns.values()) keys.sort((a, b) => bySpelling(namingSpelling(a), namingSpelling(b)));
  return fragments.map((fragment) => turns.get(fragment)!.shift()!);
}

/**
 * A key in one spelling whatever its quotes, spaces or parameter order: its
 * essence as written, so its case still orders case-only spellings, then its
 * parameters other than `charset` as `oagen diff` reads them
 * (`mediaTypeParameters`: decoded, sorted), then its `charset`.
 */
function namingSpelling(contentType: string): string {
  const charsets = parseMediaType(contentType)
    .parameters.filter((parameter) => parameter.name === 'charset')
    .map((parameter) => parameter.value);
  return JSON.stringify([contentType.split(';')[0].trim(), mediaTypeParameters(contentType), charsets]);
}

/** Case folded, then lower case first where only case differs (`application/yaml` before `Application/YAML`). */
function bySpelling(a: string, b: string): number {
  const [foldedA, foldedB] = [a.toLowerCase(), b.toLowerCase()];
  if (foldedA !== foldedB) return foldedA < foldedB ? -1 : 1;
  return a === b ? 0 : a > b ? -1 : 1;
}
