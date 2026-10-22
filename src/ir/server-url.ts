import type { ApiSpec, ServerEntry, ServerVariable } from './types.js';

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
  const template = server.url;
  const variables = server.variables ?? {};
  const unresolved: string[] = [];
  let url = '';
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
      url += template.slice(cursor, open + 1);
      cursor = open + 1;
      continue;
    }

    url += template.slice(cursor, open);
    // Own keys only: a placeholder named `constructor` or `__proto__` resolves
    // when the document declares that variable (the parser defines it as an own
    // data property), never to Object.prototype's member of that name.
    if (Object.hasOwn(variables, name)) {
      url += variables[name].default;
    } else {
      url += template.slice(open, close + 1);
      if (!unresolved.includes(name)) unresolved.push(name);
    }
    cursor = close + 1;
  }

  url += template.slice(cursor);
  return { url, unresolved };
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
 * Whether a server list means OpenAPI's default server.
 *
 * OpenAPI gives a document with no `servers`, or `servers: []`, a single
 * server with `url: '/'`; a document that writes that server out declares
 * nothing beyond it. So `undefined`, an empty list, and a list of exactly one
 * entry whose `url` is `/` and which declares no variables (`variables`
 * absent or empty, by own key) are all the default. The entry's `description`
 * does not count: the default server has none, and a description changes
 * nothing about where a request goes. A `/` entry that declares a variable, a
 * template that merely resolves to `/`, and `/` listed beside another server
 * are not the default.
 *
 * The parser (`Operation.servers`) and the differ (`server-added`,
 * `server-removed`, `serversChanged`) read lists through
 * `serversBeyondDefault`, and `base-url-changed` reads `baseUrl` and
 * `servers` together through `isDefaultServerSet`, so the three spellings of
 * the default compare equal everywhere server lists are compared (#291).
 */
export function isDefaultServerList(servers: readonly ServerEntry[] | undefined): boolean {
  if (!servers || servers.length === 0) return true;
  if (servers.length !== 1) return false;
  const [only] = servers;
  return only.url === DEFAULT_SERVER_URL && Object.keys(only.variables ?? {}).length === 0;
}

/**
 * The servers a list declares beyond OpenAPI's default: `servers` itself
 * (the same array, not a copy) when it is not the default by
 * `isDefaultServerList`, else an empty list. A document without `servers`,
 * one with `servers: []`, and one whose only server is `/` without variables
 * all come out as `[]`, which is how the parser and the differ compare them
 * as one thing.
 */
export function serversBeyondDefault(servers: readonly ServerEntry[] | undefined): readonly ServerEntry[] {
  return servers && !isDefaultServerList(servers) ? servers : [];
}

/**
 * Whether a document's `servers` and `baseUrl` together mean OpenAPI's
 * default server: the list is the default by `isDefaultServerList` and
 * `baseUrl` is what the parser sets for such a list — `''` when the
 * document declares no server, `/` when it writes the default out. Both
 * fields are read because `ApiSpec` does not tie them: an IR built by hand
 * may name a host in `baseUrl` with no `servers` beside it, and that host is
 * not the default — the differ compares it as written and reports it when
 * it moves. The parser never produces that shape (`baseUrl` is always
 * `servers[0]` resolved, or `''`).
 */
export function isDefaultServerSet(spec: Pick<ApiSpec, 'baseUrl' | 'servers'>): boolean {
  return isDefaultServerList(spec.servers) && (spec.baseUrl === '' || spec.baseUrl === DEFAULT_SERVER_URL);
}
