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
 * The one reading of braces every caller shares, so `resolveServerUrl` and
 * `serverUrlPlaceholders` cannot disagree about what counts as one.
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
 * Whether two server lists are the same, entry for entry.
 *
 * Structural: the same length, and at each position the same `url` and
 * `description` and the same `variables` — the same names, each with the same
 * `default`, the same `enum` (same values in the same order) and the same
 * `description`. Position matters because `servers[0]` is the one a client
 * defaults to. A key that is absent and one set to `undefined` compare equal.
 * Variables are compared by own key only, so one named `__proto__` or
 * `constructor` is compared like any other and never read off
 * `Object.prototype`.
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
  if (a.url !== b.url || a.description !== b.description) return false;
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
  return server.url === DEFAULT_SERVER_URL;
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
  return baseUrl === DEFAULT_SERVER_URL ? '' : baseUrl;
}
