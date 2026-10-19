import type { ApiSpec, ServerEntry, ServerVariable } from '../ir/types.js';
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
 * Within a matched server, variables are matched by name and every difference
 * is collected on one `server-modified`. Descriptions are not compared, as
 * nowhere else in the differ.
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

  const oldByUrl = new Map((oldSpec.servers ?? []).map((s) => [s.url, s]));
  const newByUrl = new Map((newSpec.servers ?? []).map((s) => [s.url, s]));

  for (const [url] of newByUrl) {
    if (!oldByUrl.has(url)) {
      changes.push({ kind: 'server-added', url, classification: 'additive' });
    }
  }

  for (const [url] of oldByUrl) {
    if (!newByUrl.has(url)) {
      changes.push({ kind: 'server-removed', url, classification: 'breaking' });
    }
  }

  for (const [url, newServer] of newByUrl) {
    const oldServer = oldByUrl.get(url);
    if (!oldServer) continue;

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

  return changes;
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
