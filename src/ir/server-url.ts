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
 * One unit of a server URL template: a single literal character, or a whole
 * `{name}` placeholder, which is never split, folded or decoded.
 */
interface TemplateUnit {
  text: string;
  placeholder: boolean;
}

/**
 * Split a server URL template into literal characters and `{name}`
 * placeholders. A `{` with no closing `}`, an empty `{}`, and a `{` that
 * opens another `{` before closing are all literal text. Plain string
 * scanning only: no pattern is built from the template.
 */
function templateUnits(template: string): TemplateUnit[] {
  const units: TemplateUnit[] = [];
  const literal = (text: string): void => {
    for (const char of text) units.push({ text: char, placeholder: false });
  };
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf('{', cursor);
    if (open === -1) break;
    const close = template.indexOf('}', open + 1);
    if (close === -1) break;

    const name = template.slice(open + 1, close);
    if (name === '' || name.includes('{')) {
      // `{}` or a `{` reopened before it closed: the brace is literal. Copy it
      // through and keep scanning from the character after it.
      literal(template.slice(cursor, open + 1));
      cursor = open + 1;
      continue;
    }

    literal(template.slice(cursor, open));
    units.push({ text: template.slice(open, close + 1), placeholder: true });
    cursor = close + 1;
  }

  literal(template.slice(cursor));
  return units;
}

/** The variable name a placeholder unit stands for: the text between its braces. */
function placeholderName(unit: TemplateUnit): string {
  return unit.text.slice(1, -1);
}

/**
 * Fill a server URL template with its variables' defaults.
 *
 * Each `{name}` is replaced by `variables[name].default`; a placeholder with no
 * declared variable is kept verbatim and reported in `unresolved`. The same
 * variable may appear more than once, and a declared variable the template
 * never mentions is simply unused. The substituted value is spliced in as text
 * and not scanned again, so a default such as `{other}` cannot trigger a
 * second substitution. A `{` with no closing `}`, an empty `{}`, and a `{`
 * that opens another `{` before closing are all literal text.
 *
 * Plain string scanning only: no pattern is built from the variable names, so
 * a name containing `.`, `+` or any other character is matched as written.
 *
 * The parser uses this for `ApiSpec.baseUrl`; an emitter that offers every
 * server (an environment picker, say) can resolve each `spec.servers[i]` the
 * same way instead of reading the OpenAPI document again.
 */
export function resolveServerUrl(server: Pick<ServerEntry, 'url' | 'variables'>): ResolvedServerUrl {
  const variables = server.variables ?? {};
  const unresolved: string[] = [];
  let url = '';

  for (const unit of templateUnits(server.url)) {
    if (!unit.placeholder) {
      url += unit.text;
      continue;
    }
    const name = placeholderName(unit);
    // Own keys only: a placeholder named `constructor` or `__proto__` resolves
    // when the document declares that variable (the parser defines it as an own
    // data property), never to Object.prototype's member of that name.
    if (Object.hasOwn(variables, name)) {
      url += variables[name].default;
    } else {
      url += unit.text;
      if (!unresolved.includes(name)) unresolved.push(name);
    }
  }

  return { url, unresolved };
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
 *   80, `https` and `wss` to 443). Any other port stays, and so does a port
 *   written as a placeholder.
 * - An empty path after an authority is `/` (`https://pets.example.com` and
 *   `https://pets.example.com/` are one server). Nothing else is done to the
 *   path: `/v1` and `/v1/` stay two servers, and dot-segments are kept.
 * - In a percent-encoded octet the hex digits are upper-cased (`%2f` is
 *   `%2F`) and one that encodes an unreserved character — a letter, a digit,
 *   `-`, `.`, `_` or `~` — is decoded (`%7E` is `~`). Every other octet is
 *   kept encoded, and a `%` not followed by two hex digits is literal.
 *
 * A `{name}` placeholder is kept exactly as written wherever it sits, so a
 * variable name is never case-folded (`{Region}` and `{region}` are different
 * variables) and a template is never confused with what it resolves to
 * (`https://{region}.api.example.com` and `https://eu.api.example.com` stay
 * two servers). A template that opens with a placeholder (`{scheme}://…`)
 * has no known scheme, so no port is dropped from it. A relative reference
 * (`/v1`, `//api.example.com/v1`) goes through the same rules from wherever
 * its syntax starts.
 */
export function normalizeServerUrl(url: string): string {
  const units = templateUnits(url);
  let out = '';
  let cursor = 0;

  // Scheme: the units before the first `:`, provided every literal character
  // among them may appear in a scheme and the first one is a letter (RFC
  // 3986 §3.1). A unit that may not — `/`, `?`, `#`, `@` — makes the URL a
  // relative reference with no scheme.
  const schemeEnd = schemeLength(units);
  let scheme: string | undefined;
  if (schemeEnd !== undefined) {
    const schemeUnits = units.slice(0, schemeEnd);
    const schemeText = render(schemeUnits, (text) => text.toLowerCase());
    out += schemeText + ':';
    // A scheme written as a placeholder is unknown, so no default port applies.
    if (schemeUnits.every((unit) => !unit.placeholder)) scheme = schemeText;
    cursor = schemeEnd + 1;
  }

  // Authority: after `//`, up to the first `/`, `?` or `#`.
  let hasAuthority = false;
  if (isLiteral(units[cursor], '/') && isLiteral(units[cursor + 1], '/')) {
    hasAuthority = true;
    const start = cursor + 2;
    cursor = start;
    while (cursor < units.length && !isLiteral(units[cursor], '/', '?', '#')) cursor++;
    out += '//' + normalizeAuthority(units.slice(start, cursor), scheme);
  }

  // Path: up to the first `?` or `#`; `/` when an authority is followed by none.
  const pathStart = cursor;
  while (cursor < units.length && !isLiteral(units[cursor], '?', '#')) cursor++;
  const path = render(units.slice(pathStart, cursor), normalizePercentEncoding);
  out += hasAuthority && path === '' ? '/' : path;

  // Query and fragment: kept as written, percent-encoding aside.
  out += render(units.slice(cursor), normalizePercentEncoding);
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
 * The authority with userinfo kept as written, the host lower-cased and a
 * port that is empty or the scheme's default dropped. The port is what
 * follows the last `:` after any `]` that closes an IP literal, so the
 * colons inside `[2001:db8::1]` are never read as one.
 */
function normalizeAuthority(units: TemplateUnit[], scheme: string | undefined): string {
  let userinfo = '';
  let hostUnits = units;
  const at = units.findIndex((unit) => isLiteral(unit, '@'));
  if (at !== -1) {
    userinfo = render(units.slice(0, at), normalizePercentEncoding) + '@';
    hostUnits = units.slice(at + 1);
  }

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

  const host = render(colon === -1 ? hostUnits : hostUnits.slice(0, colon), (text) =>
    normalizePercentEncoding(text).toLowerCase(),
  );
  if (colon === -1) return userinfo + host;

  const portUnits = hostUnits.slice(colon + 1);
  const port = render(portUnits, (text) => text);
  const literalPort = portUnits.every((unit) => !unit.placeholder);
  if (literalPort && (port === '' || isDefaultPort(port, scheme))) return userinfo + host;
  return userinfo + host + ':' + port;
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
 * are the same URL — and the same `description` and the same `variables`:
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
  return names.every(
    (name) => Object.hasOwn(bVariables, name) && serverVariablesEqual(aVariables[name], bVariables[name]),
  );
}

function serverVariablesEqual(a: ServerVariable, b: ServerVariable): boolean {
  if (a.default !== b.default || a.description !== b.description) return false;
  const aEnum = a.enum ?? [];
  const bEnum = b.enum ?? [];
  return aEnum.length === bEnum.length && aEnum.every((value, i) => value === bEnum[i]);
}
