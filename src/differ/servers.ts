import type { ApiSpec, ServerEntry, ServerVariable } from '../ir/types.js';
import {
  baseUrlBeyondDefault,
  isDefaultServerList,
  normalizeServerUrl,
  resolveServerUrl,
  serverUrlPlaceholders,
  serversOrDefault,
} from '../ir/server-url.js';
import type { ServerChange, ServerVariableChange } from './types.js';

/**
 * Compare the two documents' `baseUrl` and `servers`.
 *
 * Every URL — `baseUrl` and each `url` template — is compared through
 * `normalizeServerUrl`, so two spellings RFC 3986 calls equivalent are one
 * URL: a scheme or host that only changed case, a default port written or
 * dropped, a `/` added after a bare authority, a percent-encoded octet whose
 * hex digits changed case. The path, query and variable values are
 * case-sensitive. Every URL a change carries is reported as written in the
 * document that declares it.
 *
 * `base-url-changed` is reported once whenever the resolved default host
 * differs, on top of whichever server change moved it, so a consumer that only
 * cares where the client's default host points finds it without reconstructing
 * `servers[0]`. It is the only change a reordered list produces.
 *
 * Servers are matched on their normalised `url` template, independent of
 * position: a changed template is a `server-removed` plus a `server-added`.
 * A template the document declares more than once is matched as a multiset.
 * Its old and new entries pair up by the strongest signal available, each pass
 * taking the first unmatched candidate in declaration order: identical
 * variables first, so a reordered list, or one whose duplicates are unchanged,
 * reports nothing; then the same variable defaults (the entry kept its
 * identity and changed its enums); then the same normalised resolved URL (it
 * differs only in a variable the template does not use); then position. The
 * surplus on either side is a `server-added` or a `server-removed`. Within a
 * matched pair, variables are matched by name and every difference is
 * collected on one `server-modified` carrying the new document's spelling of
 * the template; a change to a variable the template never references is
 * additive whatever its kind, since no resolved URL can move (see
 * `diffServerVariables`). Descriptions are not compared, as nowhere else in
 * the differ.
 *
 * OpenAPI's default server is one thing however a document spells it (#291):
 * no `servers`, `servers: []`, and `servers: [{ url: '/' }]` (description and
 * variables aside: `/` references no variable, so one declared on it changes
 * nothing — #292) are all matched as `[{ url: '/' }]`
 * (`serversOrDefault`), so nothing is reported between two such documents
 * and `/` gaining a named host beside it is one `server-added`, losing that
 * host one `server-removed`. The `/` a document is only implied to have is
 * never a `server-added` or a `server-removed` itself: a document that moves
 * from any spelling of the default to a named host gains it as additive with
 * no `server-removed` for `/`, and the reverse has no `server-added` for
 * `/`. A `/` listed beside another server is one a caller can pick, so it is
 * added and removed like any other. The default address is compared through
 * `baseUrlBeyondDefault`, which reads `''` and `/` as one, so a document
 * whose first server merely resolves to `/` has not moved, while a `baseUrl`
 * naming a host with no `servers` beside it — an IR built by hand, which the
 * parser never produces — is compared as written. `oldBaseUrl` and
 * `newBaseUrl` still carry `ApiSpec.baseUrl` as the parser set it, `/`
 * included.
 *
 * `diffOperations` compares an operation's two effective server lists
 * through this same function, each read as a document whose `baseUrl` is
 * its first entry resolved, and carries the result as `serverChanges` on the
 * `operation-modified` change, so an edit is classified the same whether it
 * sits on the document, a Path Item or an Operation (#299).
 */
export function diffServers(
  oldSpec: Pick<ApiSpec, 'baseUrl' | 'servers'>,
  newSpec: Pick<ApiSpec, 'baseUrl' | 'servers'>,
): ServerChange[] {
  const changes: ServerChange[] = [];

  // A document that declares nothing beyond the default is served from
  // OpenAPI's single `/`, so that is what it is matched as.
  const oldServers = serversOrDefault(oldSpec.servers);
  const newServers = serversOrDefault(newSpec.servers);
  // `''` and `/` are one address — the default — on either side, so only a
  // move to or from somewhere else is a change. Any other `baseUrl` is
  // compared as written, even with no `servers` beside it.
  const oldBaseUrl = baseUrlBeyondDefault(oldSpec.baseUrl);
  const newBaseUrl = baseUrlBeyondDefault(newSpec.baseUrl);

  if (normalizeServerUrl(oldBaseUrl) !== normalizeServerUrl(newBaseUrl)) {
    changes.push({
      kind: 'base-url-changed',
      oldBaseUrl: oldSpec.baseUrl,
      newBaseUrl: newSpec.baseUrl,
      // A default host appearing where there was none leaves every existing
      // caller — who had to name a host — working; one moving or disappearing
      // does not.
      classification: oldBaseUrl === '' ? 'additive' : 'breaking',
    });
  }

  const oldByUrl = groupByUrl(oldServers);
  const newByUrl = groupByUrl(newServers);

  const pairings = new Map<string, ServerPairing>();
  for (const url of new Set([...oldByUrl.keys(), ...newByUrl.keys()])) {
    pairings.set(url, pairServers(oldByUrl.get(url) ?? [], newByUrl.get(url) ?? []));
  }

  // The `/` a document is only implied to have (its list means the default,
  // so it was matched as `[{ url: '/' }]` above) is not a server a caller
  // gained or lost: left unmatched, it is not reported. A side that lists
  // anything beyond the default has no implied entry, so every surplus there
  // is reported, a `/` beside a named host included. Each surplus entry is
  // reported with its own spelling.
  const oldImplied = isDefaultServerList(oldSpec.servers);
  const newImplied = isDefaultServerList(newSpec.servers);

  if (!newImplied) {
    for (const url of newByUrl.keys()) {
      for (const server of pairings.get(url)!.surplusNew) {
        changes.push({ kind: 'server-added', url: server.url, classification: 'additive' });
      }
    }
  }

  if (!oldImplied) {
    for (const url of oldByUrl.keys()) {
      for (const server of pairings.get(url)!.surplusOld) {
        changes.push({ kind: 'server-removed', url: server.url, classification: 'breaking' });
      }
    }
  }

  for (const url of newByUrl.keys()) {
    for (const [oldServer, newServer] of pairings.get(url)!.pairs) {
      const variableChanges = diffServerVariables(oldServer, newServer);
      if (variableChanges.length > 0) {
        const hasBreaking = variableChanges.some((vc) => vc.classification === 'breaking');
        changes.push({
          kind: 'server-modified',
          url: newServer.url,
          variableChanges,
          classification: hasBreaking ? 'breaking' : 'additive',
        });
      }
    }
  }

  return changes;
}

/**
 * Every entry with each `url` template, keyed by the template's normalised
 * form (`normalizeServerUrl`) in declaration order of the first one. Each
 * entry keeps its own spelling for the report.
 */
function groupByUrl(servers: readonly ServerEntry[]): Map<string, ServerEntry[]> {
  const groups = new Map<string, ServerEntry[]>();
  for (const server of servers) {
    const key = normalizeServerUrl(server.url);
    const group = groups.get(key);
    if (group) group.push(server);
    else groups.set(key, [server]);
  }
  return groups;
}

interface ServerPairing {
  /** Old and new entries that differ, paired in declaration order. */
  pairs: Array<[ServerEntry, ServerEntry]>;
  /** Old entries with no counterpart, in declaration order: removed. */
  surplusOld: ServerEntry[];
  /** New entries with no counterpart, in declaration order: added. */
  surplusNew: ServerEntry[];
}

/**
 * Pair the old and new entries of one template, strongest signal first. Each
 * pass walks the old entries still unmatched and gives each the first new
 * entry still unmatched that passes; what neither pass claims pairs by
 * position. Equal defaults imply an equal resolved URL, so that stricter pass
 * has to run first or it would never select anything.
 */
function pairServers(olds: ServerEntry[], news: ServerEntry[]): ServerPairing {
  let unmatchedOld = [...olds];
  const unmatchedNew = [...news];
  const pairs: Array<[ServerEntry, ServerEntry]> = [];

  for (const same of [identicalVariables, sameDefaults, sameResolvedUrl]) {
    const stillUnmatched: ServerEntry[] = [];
    for (const oldServer of unmatchedOld) {
      const twin = unmatchedNew.findIndex((newServer) => same(oldServer, newServer));
      if (twin === -1) stillUnmatched.push(oldServer);
      else pairs.push([oldServer, unmatchedNew.splice(twin, 1)[0]]);
    }
    unmatchedOld = stillUnmatched;
  }

  const paired = Math.min(unmatchedOld.length, unmatchedNew.length);
  for (let i = 0; i < paired; i++) pairs.push([unmatchedOld[i], unmatchedNew[i]]);

  // Report in the new document's order, like every other change.
  pairs.sort((a, b) => news.indexOf(a[1]) - news.indexOf(b[1]));

  return { pairs, surplusOld: unmatchedOld.slice(paired), surplusNew: unmatchedNew.slice(paired) };
}

function identicalVariables(a: ServerEntry, b: ServerEntry): boolean {
  return diffServerVariables(a, b).length === 0;
}

/** The same variable names with the same defaults; enums and descriptions aside. */
function sameDefaults(a: ServerEntry, b: ServerEntry): boolean {
  const aVars = Object.entries(a.variables ?? {});
  const bVars = b.variables ?? {};
  return (
    aVars.length === Object.keys(bVars).length &&
    aVars.every(([name, variable]) => Object.hasOwn(bVars, name) && bVars[name].default === variable.default)
  );
}

/** The same resolved URL up to `normalizeServerUrl`, like every URL comparison in this file. */
function sameResolvedUrl(a: ServerEntry, b: ServerEntry): boolean {
  return normalizeServerUrl(resolveServerUrl(a).url) === normalizeServerUrl(resolveServerUrl(b).url);
}

/**
 * Every difference between the variables of two entries with the same `url`
 * template, matched by name.
 *
 * Whether a difference is breaking depends on whether the template references
 * the variable. A `{name}` in the template is filled from that variable's
 * `default`, or from a value the caller picks, so removing the variable,
 * changing its default or narrowing its values moves a resolved URL some
 * caller was built on: breaking. A declared variable the template never
 * references (`serverUrlPlaceholders` does not list it; the parser keeps it
 * as written) cannot reach any resolved URL, so the same differences take
 * nothing away from any caller and are additive, with `details` saying why.
 * The template is the same on both sides, since entries are matched on it, so
 * one reading of it serves the pair. The kinds that are additive for any
 * variable (a variable added, an enum lifted, an enum value added) are not
 * affected.
 */
function diffServerVariables(oldServer: ServerEntry, newServer: ServerEntry): ServerVariableChange[] {
  const changes: ServerVariableChange[] = [];
  // Own enumerable keys only: the parser defines each variable as an own data
  // property, so one named `constructor` or `__proto__` is compared like any
  // other and nothing is read from Object.prototype.
  const oldByName = new Map(Object.entries(oldServer.variables ?? {}));
  const newByName = new Map(Object.entries(newServer.variables ?? {}));
  const referenced = new Set(serverUrlPlaceholders(oldServer.url));

  for (const [name] of newByName) {
    if (!oldByName.has(name)) {
      // A new knob. If its placeholder was already in the template, the
      // resolved URL moves too, which `base-url-changed` reports for servers[0].
      changes.push({ kind: 'variable-added', variableName: name, classification: 'additive' });
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push(breakingIfReferenced({ kind: 'variable-removed', variableName: name }, referenced));
    }
  }

  for (const [name, newVar] of newByName) {
    const oldVar = oldByName.get(name);
    if (!oldVar) continue;

    if (oldVar.default !== newVar.default) {
      // The default is what a caller gets without choosing, so when the
      // template references the variable this moves the server's resolved
      // URL whether or not it is servers[0].
      changes.push(
        breakingIfReferenced(
          {
            kind: 'variable-default-changed',
            variableName: name,
            oldDefault: oldVar.default,
            newDefault: newVar.default,
            details: `default changed from '${oldVar.default}' to '${newVar.default}'`,
          },
          referenced,
        ),
      );
    }

    changes.push(...diffVariableEnum(name, oldVar, newVar, referenced));
  }

  return changes;
}

/**
 * Classify a variable difference that moves a resolved URL when the template
 * references the variable: breaking then, additive otherwise — with
 * `details` extended to say why, since the kind alone reads as breaking.
 */
function breakingIfReferenced(
  change: Omit<ServerVariableChange, 'classification'>,
  referenced: ReadonlySet<string>,
): ServerVariableChange {
  if (referenced.has(change.variableName)) return { ...change, classification: 'breaking' };
  const reason = `{${change.variableName}} is not in the URL template, so no resolved URL moves`;
  return { ...change, classification: 'additive', details: change.details ? `${change.details}; ${reason}` : reason };
}

function diffVariableEnum(
  name: string,
  oldVar: ServerVariable,
  newVar: ServerVariable,
  referenced: ReadonlySet<string>,
): ServerVariableChange[] {
  const oldEnum = oldVar.enum;
  const newEnum = newVar.enum;
  if (!oldEnum && !newEnum) return [];

  if (!oldEnum) {
    // Any value was accepted; now only the listed ones are.
    return [
      breakingIfReferenced(
        { kind: 'variable-enum-added', variableName: name, details: `values restricted to ${newEnum!.join(', ')}` },
        referenced,
      ),
    ];
  }

  if (!newEnum) {
    // The restriction is lifted: every value a caller picked before still works.
    return [
      {
        kind: 'variable-enum-removed',
        variableName: name,
        classification: 'additive',
        details: `any value accepted; was ${oldEnum.join(', ')}`,
      },
    ];
  }

  const changes: ServerVariableChange[] = [];

  for (const value of newEnum) {
    if (!oldEnum.includes(value)) {
      changes.push({ kind: 'variable-enum-value-added', variableName: name, value, classification: 'additive' });
    }
  }

  for (const value of oldEnum) {
    if (!newEnum.includes(value)) {
      changes.push(
        breakingIfReferenced({ kind: 'variable-enum-value-removed', variableName: name, value }, referenced),
      );
    }
  }

  return changes;
}
