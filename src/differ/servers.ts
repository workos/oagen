import type { ApiSpec, ServerEntry, ServerVariable } from '../ir/types.js';
import { resolveServerUrl } from '../ir/server-url.js';
import type { Change, ServerVariableChange } from './types.js';

/**
 * Compare the two documents' `baseUrl` and `servers`.
 *
 * `base-url-changed` is reported once whenever the resolved default host
 * differs, on top of whichever server change moved it, so a consumer that only
 * cares where the client's default host points finds it without reconstructing
 * `servers[0]`. It is the only change a reordered list produces.
 *
 * Servers are matched on their `url` template exactly as written, independent
 * of position: a changed template is a `server-removed` plus a `server-added`.
 * A template the document declares more than once is matched as a multiset.
 * Its old and new entries pair up by the strongest signal available, each pass
 * taking the first unmatched candidate in declaration order: identical
 * variables first, so a reordered list, or one whose duplicates are unchanged,
 * reports nothing; then the same variable defaults (the entry kept its
 * identity and changed its enums); then the same resolved URL (it differs only
 * in a variable the template does not use); then position. The surplus on
 * either side is a `server-added` or a `server-removed`. Within a matched
 * pair, variables are matched by name and every difference is collected on one
 * `server-modified`. Descriptions are not compared, as nowhere else in the
 * differ.
 */
export function diffServers(
  oldSpec: Pick<ApiSpec, 'baseUrl' | 'servers'>,
  newSpec: Pick<ApiSpec, 'baseUrl' | 'servers'>,
): Change[] {
  const changes: Change[] = [];

  if (oldSpec.baseUrl !== newSpec.baseUrl) {
    changes.push({
      kind: 'base-url-changed',
      oldBaseUrl: oldSpec.baseUrl,
      newBaseUrl: newSpec.baseUrl,
      // A default host appearing where there was none leaves every existing
      // caller — who had to name a host — working; one moving or disappearing
      // does not.
      classification: oldSpec.baseUrl === '' ? 'additive' : 'breaking',
    });
  }

  const oldByUrl = groupByUrl(oldSpec.servers ?? []);
  const newByUrl = groupByUrl(newSpec.servers ?? []);

  const pairings = new Map<string, ServerPairing>();
  for (const url of new Set([...oldByUrl.keys(), ...newByUrl.keys()])) {
    pairings.set(url, pairServers(oldByUrl.get(url) ?? [], newByUrl.get(url) ?? []));
  }

  for (const url of newByUrl.keys()) {
    for (let i = 0; i < pairings.get(url)!.surplusNew; i++) {
      changes.push({ kind: 'server-added', url, classification: 'additive' });
    }
  }

  for (const url of oldByUrl.keys()) {
    for (let i = 0; i < pairings.get(url)!.surplusOld; i++) {
      changes.push({ kind: 'server-removed', url, classification: 'breaking' });
    }
  }

  for (const url of newByUrl.keys()) {
    for (const [oldServer, newServer] of pairings.get(url)!.pairs) {
      const variableChanges = diffServerVariables(oldServer, newServer);
      if (variableChanges.length > 0) {
        const hasBreaking = variableChanges.some((vc) => vc.classification === 'breaking');
        changes.push({
          kind: 'server-modified',
          url,
          variableChanges,
          classification: hasBreaking ? 'breaking' : 'additive',
        });
      }
    }
  }

  return changes;
}

/** Every entry with each `url` template, keyed in declaration order of the first one. */
function groupByUrl(servers: ServerEntry[]): Map<string, ServerEntry[]> {
  const groups = new Map<string, ServerEntry[]>();
  for (const server of servers) {
    const group = groups.get(server.url);
    if (group) group.push(server);
    else groups.set(server.url, [server]);
  }
  return groups;
}

interface ServerPairing {
  /** Old and new entries that differ, paired in declaration order. */
  pairs: Array<[ServerEntry, ServerEntry]>;
  /** Old entries with no counterpart: removed. */
  surplusOld: number;
  /** New entries with no counterpart: added. */
  surplusNew: number;
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

  return { pairs, surplusOld: unmatchedOld.length - paired, surplusNew: unmatchedNew.length - paired };
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

function sameResolvedUrl(a: ServerEntry, b: ServerEntry): boolean {
  return resolveServerUrl(a).url === resolveServerUrl(b).url;
}

function diffServerVariables(oldServer: ServerEntry, newServer: ServerEntry): ServerVariableChange[] {
  const changes: ServerVariableChange[] = [];
  // Own enumerable keys only: the parser defines each variable as an own data
  // property, so one named `constructor` or `__proto__` is compared like any
  // other and nothing is read from Object.prototype.
  const oldByName = new Map(Object.entries(oldServer.variables ?? {}));
  const newByName = new Map(Object.entries(newServer.variables ?? {}));

  for (const [name] of newByName) {
    if (!oldByName.has(name)) {
      // A new knob. If its placeholder was already in the template, the
      // resolved URL moves too, which `base-url-changed` reports for servers[0].
      changes.push({ kind: 'variable-added', variableName: name, classification: 'additive' });
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push({ kind: 'variable-removed', variableName: name, classification: 'breaking' });
    }
  }

  for (const [name, newVar] of newByName) {
    const oldVar = oldByName.get(name);
    if (!oldVar) continue;

    if (oldVar.default !== newVar.default) {
      // The default is what a caller gets without choosing, so this moves the
      // server's resolved URL whether or not it is servers[0].
      changes.push({
        kind: 'variable-default-changed',
        variableName: name,
        classification: 'breaking',
        oldDefault: oldVar.default,
        newDefault: newVar.default,
        details: `default changed from '${oldVar.default}' to '${newVar.default}'`,
      });
    }

    changes.push(...diffVariableEnum(name, oldVar, newVar));
  }

  return changes;
}

function diffVariableEnum(name: string, oldVar: ServerVariable, newVar: ServerVariable): ServerVariableChange[] {
  const oldEnum = oldVar.enum;
  const newEnum = newVar.enum;
  if (!oldEnum && !newEnum) return [];

  if (!oldEnum) {
    // Any value was accepted; now only the listed ones are.
    return [
      {
        kind: 'variable-enum-added',
        variableName: name,
        classification: 'breaking',
        details: `values restricted to ${newEnum!.join(', ')}`,
      },
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
      changes.push({ kind: 'variable-enum-value-removed', variableName: name, value, classification: 'breaking' });
    }
  }

  return changes;
}
