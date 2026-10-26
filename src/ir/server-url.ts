import type { ServerEntry, ServerVariable } from './types.js';

/** Outcome of filling a server URL template with its variables' defaults. */
export interface ResolvedServerUrl {
  /** The template with every placeholder that names a declared variable replaced by that variable's `default`. */
  url: string;
  /**
   * Placeholder names still in `url` because the server declares no variable
   * for them, in order of first appearance and without repeats.
   */
  unresolved: string[];
}

/**
 * Fill a server URL template with its variables' defaults.
 *
 * Each `{name}` is replaced by `variables[name].default`; a placeholder with no
 * declared variable is kept verbatim and reported in `unresolved`. The same
 * variable may appear more than once, and a declared variable the template
 * never mentions is simply unused (`serverUrlPlaceholders` lists the names the
 * template does mention). The substituted value is spliced in as text and not
 * scanned again, so a default such as `{other}` cannot trigger a second
 * substitution. A `{` with no closing `}`, an empty `{}`, and a `{` that opens
 * another `{` before closing are all literal text.
 *
 * Plain string scanning only: no pattern is built from the variable names, so
 * a name containing `.`, `+` or any other character is matched as written.
 *
 * The parser uses this for `ApiSpec.baseUrl`; an emitter that offers every
 * server (an environment picker, say) can resolve each `spec.servers[i]` the
 * same way instead of reading the OpenAPI document again.
 */
export function resolveServerUrl(server: Pick<ServerEntry, 'url' | 'variables'>): ResolvedServerUrl {
  const template = server.url;
  const variables = server.variables ?? {};
  const unresolved: string[] = [];
  let url = '';
  let cursor = 0;

  for (const { name, start, end } of scanPlaceholders(template)) {
    url += template.slice(cursor, start);
    // Own keys only: a placeholder named `constructor` or `__proto__` resolves
    // when the document declares that variable (the parser defines it as an own
    // data property), never to Object.prototype's member of that name.
    if (Object.hasOwn(variables, name)) {
      url += variables[name].default;
    } else {
      url += template.slice(start, end);
      if (!unresolved.includes(name)) unresolved.push(name);
    }
    cursor = end;
  }

  url += template.slice(cursor);
  return { url, unresolved };
}

/**
 * The placeholder names a server URL template references, in order of first
 * appearance and without repeats: `['region', 'port']` for
 * `https://{region}.example.com:{port}/{region}`. Read from the template
 * alone, by the same scan as `resolveServerUrl` (so the same literal-brace
 * rules apply), whether or not the server declares a variable for each name.
 *
 * A declared variable whose name is not listed here is one the template never
 * references: its default and its allowed values cannot reach any resolved
 * URL. The differ classifies a change to such a variable as additive on that
 * basis; an emitter that exposes a server's variables can use it to offer
 * only the ones that take effect.
 */
export function serverUrlPlaceholders(url: string): string[] {
  const names: string[] = [];
  for (const { name } of scanPlaceholders(url)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** One `{name}` in a server URL template: `start` is the index of its `{`, `end` the index just past its `}`. */
interface Placeholder {
  name: string;
  start: number;
  end: number;
}

/**
 * Walk a template's placeholders left to right. A `{` with no closing `}`
 * ends the scan (the rest is literal); an empty `{}` and a `{` that opens
 * another `{` before closing are literal, and scanning resumes right after
 * that `{` so a well-formed placeholder later in the text is still found.
 * The one reading of braces every caller shares, so `resolveServerUrl`,
 * `serverUrlPlaceholders` and `normalizeServerUrl` (through `templateUnits`)
 * cannot disagree about what counts as one.
 */
function* scanPlaceholders(template: string): Generator<Placeholder> {
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf('{', cursor);
    if (open === -1) break;
    const close = template.indexOf('}', open + 1);
    if (close === -1) break;

    const name = template.slice(open + 1, close);
    if (name === '' || name.includes('{')) {
      cursor = open + 1;
      continue;
    }

    yield { name, start: open, end: close + 1 };
    cursor = close + 1;
  }
}

/**
 * One unit of a server URL template: a single literal character, or a whole
 * `{name}` placeholder, which is never split, folded or decoded.
 */
interface TemplateUnit {
  text: string;
  placeholder: boolean;
}

/**
 * Split a server URL template into literal characters and `{name}`
 * placeholders, read by `scanPlaceholders` so the literal-brace rules are
 * the ones `resolveServerUrl` applies. A literal `{` from an unclosed, empty
 * or reopened brace is a character like any other.
 */
function templateUnits(template: string): TemplateUnit[] {
  const units: TemplateUnit[] = [];
  const literal = (text: string): void => {
    for (const char of text) units.push({ text: char, placeholder: false });
  };
  let cursor = 0;

  for (const { start, end } of scanPlaceholders(template)) {
    literal(template.slice(cursor, start));
    units.push({ text: template.slice(start, end), placeholder: true });
    cursor = end;
  }

  literal(template.slice(cursor));
  return units;
}

/** The port each scheme uses when the URL names none (RFC 9110 §4.2, RFC 6455 §3). */
const DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, https: 443, ws: 80, wss: 443 };

/**
 * A server URL in the form two equivalent spellings share, for comparing
 * server URLs — templates as written and resolved URLs alike. The IR never
 * stores it: `ServerEntry.url` and `ApiSpec.baseUrl` stay as written, and
 * the differ reports every URL as written in the document that declares it.
 *
 * The rules are those of RFC 3986 §6.2.2 (syntax-based) and §6.2.3
 * (scheme-based normalization) that apply to a base URL:
 *
 * - The scheme and the host are case-insensitive and are lower-cased
 *   (`HTTPS://PETS.example.com` and `https://pets.example.com` are one
 *   server). Userinfo, path, query and fragment are case-sensitive and keep
 *   their case, so `/V1` and `/v1` stay two servers.
 * - A port that is empty or is the scheme's default is dropped
 *   (`https://pets.example.com:443`, `https://pets.example.com:` and
 *   `https://pets.example.com` are one server; `http` and `ws` default to
 *   80, `https` and `wss` to 443). Any other port stays.
 * - An empty path after a wholly literal authority is `/`
 *   (`https://pets.example.com` and `https://pets.example.com/` are one
 *   server). Nothing else is done to the path: `/v1` and `/v1/` stay two
 *   servers, and dot-segments are kept.
 * - In a percent-encoded octet the hex digits are upper-cased (`%2f` is
 *   `%2F`) and one that encodes an unreserved character — a letter, a digit,
 *   `-`, `.`, `_` or `~` — is decoded (`%7E` is `~`). Every other octet is
 *   kept encoded, and a `%` not followed by two hex digits is literal.
 *
 * A `{name}` placeholder is kept exactly as written wherever it sits, so a
 * variable name is never case-folded (`{Region}` and `{region}` are different
 * variables) and a template is never confused with what it resolves to
 * (`https://{region}.api.example.com` and `https://eu.api.example.com` stay
 * two servers). A placeholder also ends what can be known about the URL's
 * structure: its value may carry any delimiter — `@` (which makes the text
 * before it in the authority a username), `:` and a port, `/` and a path,
 * `://` and a whole URL — so nothing from the first placeholder on is folded,
 * and a component is folded only when it is complete before that point: the
 * scheme when its `:` comes first, the authority when its end (`/`, `?`, `#`
 * or the end of the template) comes first. So `HTTPS://API.example.com/{v}`
 * is `https://api.example.com/{v}` and `HTTPS://API.example.com{basePath}`
 * is `https://API.example.com{basePath}`, while `…{basePath}` and
 * `…{basePath}/`, `https://{host}:443/v2` and `https://{host}/v2`,
 * `https://USER{suffix}/v1` and `https://user{suffix}/v1` (a `suffix` of
 * `@api.example.com` makes `USER` a username), and `{prefix}://api.example.com`
 * and `{prefix}://api.example.com/` (a `prefix` of
 * `https://gateway.example.com/path` makes the rest a path) all stay two
 * servers. From the first placeholder on not even percent-encoding is
 * folded, and neither is it in an authority the placeholder sits in: a value
 * may put the text in a scheme or a port, where `%` has no meaning
 * (`{scheme}%73://…` and `{scheme}s://…`, `…{x}%34%34%33` and `…{x}443`,
 * `https://api.example.com:4{port}` and `https://api.example.com:%34{port}`,
 * `{scheme}://host:%34%34%33` and `{scheme}://host:443` stay two servers),
 * or end in a `%` that joins with the text after it into a different octet
 * (`https://{host}/{x}7e` and `https://{host}/{x}%37e` stay two servers).
 * Percent-encoding before the first placeholder in a path, query or
 * fragment is folded, since a complete octet there is a complete octet under
 * every value. Every folding therefore applies to text whose part and bytes
 * no variable value can change, and two templates that come out as one
 * string resolve to one URL under every value of their variables. Not folded at
 * all: dot-segments (`/v1/../v2` is compared as written) and
 * internationalised host names (`bücher.example.com` and
 * `xn--bcher-kva.example.com` are two hosts). A relative reference (`/v1`,
 * `//api.example.com/v1`) goes through the same rules from wherever its
 * syntax starts.
 */
export function normalizeServerUrl(url: string): string {
  const units = templateUnits(url);
  // A placeholder's value may carry any delimiter, so it can change which
  // part every later character belongs to and, through a `@`, which part
  // the text before it in its authority belongs to; it may also end in a `%`
  // or a partial escape that joins with the text after it into a different
  // percent-encoded octet. So from the first placeholder on nothing is
  // folded, not even percent-encoding, and a component before it is folded
  // only when it is complete before that point. Percent-encoding before the
  // first placeholder in a path, query or fragment is folded: a complete
  // octet there is a complete octet under every value.
  const firstPlaceholder = units.findIndex((unit) => unit.placeholder);
  const literalEnd = firstPlaceholder === -1 ? units.length : firstPlaceholder;
  /** Units `from` to `to` as written. */
  const verbatim = (from: number, to: number): string => render(units.slice(from, to), (text) => text);
  /** Units `from` to `to`: percent-encoding folded before the first placeholder, as written from it on. */
  const emit = (from: number, to: number): string =>
    render(units.slice(from, Math.min(to, literalEnd)), normalizePercentEncoding) +
    verbatim(Math.max(from, literalEnd), to);
  let out = '';
  let cursor = 0;

  // Scheme: the units before the first `:`, provided every character among
  // them may appear in a scheme and the first one is a letter (RFC 3986
  // §3.1); a `/`, `?`, `#` or `@` before any `:` makes the URL a relative
  // reference with no scheme. Folded only when that `:` comes before the
  // first placeholder: a scheme with a placeholder in it (`{prefix}://…`)
  // may resolve to anything, so the whole template is kept as written.
  const schemeEnd = schemeLength(units);
  let scheme: string | undefined;
  if (schemeEnd !== undefined && schemeEnd >= literalEnd) return verbatim(0, units.length);
  if (schemeEnd !== undefined) {
    scheme = render(units.slice(0, schemeEnd), (text) => text.toLowerCase());
    out += scheme + ':';
    cursor = schemeEnd + 1;
  }

  // Authority: after `//`, up to the first `/`, `?` or `#`. Folded only when
  // that end comes before the first placeholder: a placeholder inside the
  // authority may resolve to a host suffix, a port, a path, or a `@` that
  // makes the text before it a username, so an authority with one is kept
  // as written from its `//` on — the text before the placeholder included,
  // which may be a port (`:4{port}`), where `%` is not decoded — and gets no
  // `/` for an empty path.
  let literalAuthority = false;
  if (isLiteral(units[cursor], '/') && isLiteral(units[cursor + 1], '/')) {
    const start = cursor + 2;
    cursor = start;
    while (cursor < units.length && !isLiteral(units[cursor], '/', '?', '#')) cursor++;
    literalAuthority = cursor <= literalEnd;
    out += '//' + (literalAuthority ? normalizeAuthority(units.slice(start, cursor), scheme) : verbatim(start, cursor));
  }

  // Path: up to the first `?` or `#`; `/` when a wholly literal authority is
  // followed by none (`…{basePath}` and `…{basePath}/` stay two templates).
  const pathStart = cursor;
  while (cursor < units.length && !isLiteral(units[cursor], '?', '#')) cursor++;
  const path = emit(pathStart, cursor);
  out += literalAuthority && path === '' ? '/' : path;

  // Query and fragment: kept as written, percent-encoding aside.
  out += emit(cursor, units.length);
  return out;
}

/** The number of units before the `:` that ends a scheme, or `undefined` when the URL has none. */
function schemeLength(units: TemplateUnit[]): number | undefined {
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.placeholder) continue;
    if (unit.text === ':') return i > 0 ? i : undefined;
    const char = unit.text;
    const first = i === 0;
    if (isAlpha(char) || (!first && (isDigit(char) || char === '+' || char === '-' || char === '.'))) continue;
    return undefined;
  }
  return undefined;
}

/**
 * A wholly literal authority with userinfo kept as written, the host
 * lower-cased and a port that is empty or the scheme's default dropped. The
 * port is what follows the last `:` after any `]` that closes an IP literal,
 * so the colons inside `[2001:db8::1]` are never read as one.
 */
function normalizeAuthority(units: TemplateUnit[], scheme: string | undefined): string {
  const at = units.findIndex((unit) => isLiteral(unit, '@'));
  const hostUnits = units.slice(at + 1);
  let closeBracket = -1;
  for (let i = hostUnits.length - 1; i >= 0; i--) {
    if (isLiteral(hostUnits[i], ']')) {
      closeBracket = i;
      break;
    }
  }
  let colon = -1;
  for (let i = hostUnits.length - 1; i > closeBracket; i--) {
    if (isLiteral(hostUnits[i], ':')) {
      colon = i;
      break;
    }
  }

  if (colon === -1) return foldUserinfoAndHost(units);

  const port = render(hostUnits.slice(colon + 1), (text) => text);
  const withoutPort = foldUserinfoAndHost(units.slice(0, at + 1 + colon));
  if (port === '' || isDefaultPort(port, scheme)) return withoutPort;
  return withoutPort + ':' + port;
}

/** Userinfo — up to the first `@` — as written and the host lower-cased, percent-encoding normalised in both. */
function foldUserinfoAndHost(units: TemplateUnit[]): string {
  const at = units.findIndex((unit) => isLiteral(unit, '@'));
  const userinfo = at === -1 ? '' : render(units.slice(0, at), normalizePercentEncoding) + '@';
  return userinfo + render(units.slice(at + 1), foldHost);
}

/**
 * A host lower-cased outside its percent-encoded octets, which keep their
 * upper-cased hex digits (`p%C3%A9ts.EXAMPLE.com` is `p%C3%A9ts.example.com`);
 * an octet that encodes a letter is decoded first and so lower-cased too
 * (`%41PI` is `api`).
 */
function foldHost(text: string): string {
  const encoded = normalizePercentEncoding(text);
  let out = '';
  for (let i = 0; i < encoded.length; i++) {
    const char = encoded[i];
    if (char === '%' && i + 2 < encoded.length && isHexDigit(encoded[i + 1]) && isHexDigit(encoded[i + 2])) {
      out += encoded.slice(i, i + 3);
      i += 2;
    } else {
      out += char.toLowerCase();
    }
  }
  return out;
}

/** Whether a literal port, read as a decimal number, is the one `scheme` implies. */
function isDefaultPort(port: string, scheme: string | undefined): boolean {
  if (scheme === undefined || !Object.hasOwn(DEFAULT_PORTS, scheme)) return false;
  for (const char of port) if (!isDigit(char)) return false;
  return Number(port) === DEFAULT_PORTS[scheme];
}

/**
 * Upper-case the hex digits of every percent-encoded octet and decode the
 * ones that encode an unreserved character (RFC 3986 §6.2.2.1–§6.2.2.2).
 */
function normalizePercentEncoding(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '%' && i + 2 < text.length && isHexDigit(text[i + 1]) && isHexDigit(text[i + 2])) {
      const hex = text.slice(i + 1, i + 3);
      const decoded = String.fromCharCode(Number.parseInt(hex, 16));
      out += isUnreserved(decoded) ? decoded : '%' + hex.toUpperCase();
      i += 2;
    } else {
      out += char;
    }
  }
  return out;
}

/** Join units back into text, passing each run of literal characters through `transform` and every placeholder as written. */
function render(units: TemplateUnit[], transform: (text: string) => string): string {
  let out = '';
  let run = '';
  for (const unit of units) {
    if (unit.placeholder) {
      out += transform(run) + unit.text;
      run = '';
    } else {
      run += unit.text;
    }
  }
  return out + transform(run);
}

/** Whether `unit` is a literal character that is one of `chars`. */
function isLiteral(unit: TemplateUnit | undefined, ...chars: string[]): boolean {
  return unit !== undefined && !unit.placeholder && chars.includes(unit.text);
}

function isAlpha(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isHexDigit(char: string): boolean {
  return isDigit(char) || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F');
}

/** RFC 3986 §2.3: a character that needs no percent-encoding anywhere in a URI. */
function isUnreserved(char: string): boolean {
  return isAlpha(char) || isDigit(char) || char === '-' || char === '.' || char === '_' || char === '~';
}

/**
 * Whether two server lists are the same, entry for entry.
 *
 * Structural: the same length, and at each position the same `url` — up to
 * `normalizeServerUrl`, so a scheme or host that differs only in case, a
 * default port written or not, and a trailing `/` after a bare authority
 * are the same URL, and that form folds nothing a placeholder's value could
 * change, so two entries it calls equal resolve to one URL under every value
 * of their variables, which `resolveAlike` checks value by value all the
 * same — and the same `description` and the same `variables`:
 * the same names, each with the same `default`, the same `enum` (same values
 * in the same order) and the same `description`, all compared as written.
 * Position matters because `servers[0]` is the one a client defaults to. A
 * key that is absent and one set to `undefined` compare equal. Variables are
 * compared by own key only, so one named `__proto__` or `constructor` is
 * compared like any other and never read off `Object.prototype`.
 *
 * The parser uses this to decide whether an operation's effective servers
 * differ from the document's (`Operation.servers` is set only when they do):
 * the IR carries exactly what the document says. The differ's
 * `serversChanged` deliberately uses a looser rule — descriptions, enum order
 * and position ignored, matching the document-level diff — so a description
 * edit sets the field without being reported as a change.
 */
export function serverListsEqual(a: readonly ServerEntry[], b: readonly ServerEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => serverEntriesEqual(entry, b[i]));
}

function serverEntriesEqual(a: ServerEntry, b: ServerEntry): boolean {
  if (normalizeServerUrl(a.url) !== normalizeServerUrl(b.url) || a.description !== b.description) return false;
  const aVariables = a.variables ?? {};
  const bVariables = b.variables ?? {};
  const names = Object.keys(aVariables);
  if (names.length !== Object.keys(bVariables).length) return false;
  if (
    !names.every((name) => Object.hasOwn(bVariables, name) && serverVariablesEqual(aVariables[name], bVariables[name]))
  ) {
    return false;
  }
  // `normalizeServerUrl` folds nothing a placeholder's value could change, so
  // equal forms with equal variables resolve to one URL under every value;
  // checked all the same, value by value, so the guarantee does not rest on
  // that reading alone.
  return resolveAlike(a, b);
}

/**
 * Whether every allowed substitution resolves `a` and `b` to the same URL up
 * to `normalizeServerUrl`: the defaults, then each enum value of each
 * variable in turn with every other variable at its default. Both entries
 * are resolved with `a`'s variables, which the caller has found equal to
 * `b`'s. Substituted maps are built with `Object.fromEntries`, so a variable
 * named `__proto__` stays an own key.
 */
function resolveAlike(a: ServerEntry, b: ServerEntry): boolean {
  const variables = a.variables ?? {};
  const substitutions: Array<Record<string, ServerVariable>> = [variables];
  for (const [name, variable] of Object.entries(variables)) {
    for (const value of variable.enum ?? []) {
      if (value === variable.default) continue;
      substitutions.push(
        Object.fromEntries(
          Object.entries(variables).map(([other, v]) => [other, other === name ? { ...v, default: value } : v]),
        ),
      );
    }
  }
  return substitutions.every(
    (vars) =>
      normalizeServerUrl(resolveServerUrl({ url: a.url, variables: vars }).url) ===
      normalizeServerUrl(resolveServerUrl({ url: b.url, variables: vars }).url),
  );
}

function serverVariablesEqual(a: ServerVariable, b: ServerVariable): boolean {
  if (a.default !== b.default || a.description !== b.description) return false;
  const aEnum = a.enum ?? [];
  const bEnum = b.enum ?? [];
  return aEnum.length === bEnum.length && aEnum.every((value, i) => value === bEnum[i]);
}

/** The server OpenAPI gives a document that declares none: a single entry at `/`. */
const DEFAULT_SERVER_URL = '/';

/**
 * Whether a server entry is OpenAPI's default server: its `url` is `/`.
 * Neither its `description` nor its `variables` count. The default server
 * has neither; a description changes nothing about where a request goes; and
 * `/` contains no placeholder (`serverUrlPlaceholders('/')` is empty), so a
 * variable declared on it is never referenced and cannot change where it
 * points either (#292). A template that merely resolves to `/` (a referenced
 * variable whose default is `/`) is a template, not the default server.
 */
export function isDefaultServerEntry(server: ServerEntry): boolean {
  // `/` is its own RFC 3986 form; read through `normalizeServerUrl` so that
  // every server URL comparison in this module goes through one function.
  return normalizeServerUrl(server.url) === DEFAULT_SERVER_URL;
}

/**
 * Whether a server list means OpenAPI's default server. OpenAPI gives a
 * document with no `servers`, or `servers: []`, a single server at `/`; a
 * document that writes that server out declares nothing beyond it, and
 * neither does one that writes it out twice. So `undefined`, an empty list,
 * and a list whose every entry is the default by `isDefaultServerEntry` are
 * all the default. A list with any other entry is not, wherever `/` sits in
 * it, because position decides the default host.
 *
 * The parser asks this of an operation's list and the document's: both at
 * the default means the operation inherits (`Operation.servers`, #291). The
 * differ asks it to tell the `/` a document is only implied to have, which
 * is never reported as added or removed, from one it lists beside another
 * server, which is.
 */
export function isDefaultServerList(servers: readonly ServerEntry[] | undefined): boolean {
  return !servers || servers.every(isDefaultServerEntry);
}

/**
 * The servers a document is served from: its list as written (the same
 * array, not a copy) when it declares anything beyond the default, else
 * OpenAPI's default server, a single `{ url: '/' }`. A document without
 * `servers`, one with `servers: []`, one whose only server is `/`, and one
 * that writes `/` out twice all come out as `[{ url: '/' }]` (a description
 * on the entry is not carried: the default server has none), while
 * `[/, host]` stays `[/, host]`, because there `/` is a server the document
 * lists, not one it is implied to have. The differ matches servers on this,
 * so the three spellings of the default pair with each other and with a `/`
 * listed beside a host.
 */
export function serversOrDefault(servers: readonly ServerEntry[] | undefined): readonly ServerEntry[] {
  return servers && !isDefaultServerList(servers) ? servers : [{ url: DEFAULT_SERVER_URL }];
}

/**
 * A document's default address beyond OpenAPI's default: `''` when
 * `baseUrl` is `''` (the parser's value for a document with no server) or
 * `/` (the resolved address of the default server, written out or not),
 * else `baseUrl` as given. The differ compares `base-url-changed` on this,
 * so the three spellings of the default share one address and a document
 * whose first server merely resolves to `/` has not moved from it. Any other
 * `baseUrl` — a host, or `/v1` — is compared as written, even with no
 * `servers` beside it (an IR built by hand, which the parser never
 * produces).
 */
export function baseUrlBeyondDefault(baseUrl: string): string {
  // Read through `normalizeServerUrl` like every other server URL comparison
  // in this module; `/` is its own form, so only `/` itself is the default.
  return normalizeServerUrl(baseUrl) === DEFAULT_SERVER_URL ? '' : baseUrl;
}
