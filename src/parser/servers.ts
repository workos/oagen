import type { ServerEntry, ServerVariable } from '../ir/types.js';
import { resolveServerUrl } from '../ir/server-url.js';

/** A `servers` entry as written in the OpenAPI document; narrowed field by field. */
export interface RawServerObject {
  url?: unknown;
  description?: unknown;
  variables?: unknown;
}

/** What the document's `servers` list contributes to `ApiSpec`. */
export interface ExtractedServers {
  /** One entry per server that has a URL, in document order; `undefined` when there is none. */
  servers: ServerEntry[] | undefined;
  /** The first server's URL with its variables' defaults filled in, or `''` without a server. */
  baseUrl: string;
}

/**
 * Convert the document's `servers` list into `ApiSpec.servers` and
 * `ApiSpec.baseUrl`.
 *
 * `ServerEntry.url` stays as written — placeholders included — so an emitter
 * can offer the variables; `baseUrl` is `servers[0]` resolved with
 * `resolveServerUrl`, which fills each `{name}` with the variable's `default`
 * (OpenAPI requires one). The list itself is normalised by
 * `extractServerList`, the same way a Path Item's or an Operation's is.
 */
export function extractServers(rawServers: unknown): ExtractedServers {
  const servers = extractServerList(rawServers, 'the document');
  const baseUrl = servers ? resolveServerUrl(servers[0]).url : '';
  return { servers, baseUrl };
}

/**
 * Normalise a `servers` list — the document's, a Path Item's or an
 * Operation's — into `ServerEntry[]`, or `undefined` when it declares nothing
 * usable. All three levels go through here so they come out identical: the
 * same handling of non-object entries, blank URLs, `variables` and
 * prototype-named keys, and the same warnings, each naming `context` ("the
 * document", "path item /pets", "operation listPets").
 *
 * A non-array, an empty list, and a list whose entries are all unusable (not
 * an object, no `url`, or an empty `url`) all yield `undefined`. OpenAPI gives
 * `servers: []` no meaning as an override — only the document-level default
 * of `/` is defined for an empty list — so at path and operation level
 * `undefined` means "inherit".
 *
 * Server variables are the same shape in OpenAPI 3.0 and 3.1. Every server is
 * checked, not only the first, because an emitter may resolve any of them,
 * and each problem is reported once with an `[oagen] Warning:`:
 *
 * - A variable without a usable `default` has no IR representation
 *   (`ServerVariable.default` is required) and is omitted; its placeholder
 *   stays in the URL.
 * - A placeholder that names no declared variable stays in the URL.
 * - A `default` outside the variable's `enum` is kept as written.
 *
 * A declared variable the URL never mentions is kept without comment; it is
 * harmless and an emitter may still expose it. `default` and `enum` entries
 * are strings; a number or boolean (YAML reads `default: 8443` as a number)
 * is carried as its text, anything else is ignored. An empty `enum`, which
 * the specification forbids, is treated as undeclared.
 */
export function extractServerList(rawServers: unknown, context: string): ServerEntry[] | undefined {
  if (!Array.isArray(rawServers)) return undefined;
  const servers: ServerEntry[] = [];
  for (const raw of rawServers) {
    const entry = buildServerEntry(raw, context);
    if (entry) servers.push(entry);
  }
  return servers.length > 0 ? servers : undefined;
}

function buildServerEntry(raw: unknown, context: string): ServerEntry | undefined {
  if (!isRecord(raw) || typeof raw.url !== 'string' || raw.url === '') return undefined;
  const url = raw.url;
  const entry: ServerEntry = { url, description: typeof raw.description === 'string' ? raw.description : undefined };

  const declared = isRecord(raw.variables) ? raw.variables : {};
  // Collected in a Map and materialized with Object.fromEntries, which defines
  // own data properties: `variables[name] = …` on a plain object would set its
  // prototype instead when the document names a variable `__proto__`. The
  // result is still an ordinary object, so `Object.keys`, JSON and snapshots
  // see nothing unusual.
  const variables = new Map<string, ServerVariable>();
  for (const [name, value] of Object.entries(declared)) {
    const variable = buildServerVariable(url, context, name, value);
    if (variable) variables.set(name, variable);
  }
  // Absent, not `undefined`, when the document declares none (or none usable).
  if (variables.size > 0) entry.variables = Object.fromEntries(variables);

  for (const name of resolveServerUrl(entry).unresolved) {
    // A declared variable that was omitted above has already been reported.
    if (Object.hasOwn(declared, name)) continue;
    console.warn(
      `[oagen] Warning: Server URL "${url}" on ${context} uses {${name}} but declares no such variable; the placeholder stays in the URL`,
    );
  }
  return entry;
}

function buildServerVariable(url: string, context: string, name: string, raw: unknown): ServerVariable | undefined {
  const declared: Record<string, unknown> = isRecord(raw) ? raw : {};
  const defaultValue = scalarText(declared.default);
  if (defaultValue === undefined) {
    console.warn(
      `[oagen] Warning: Server variable "${name}" of "${url}" on ${context} has no default (a string is required) and is omitted; its placeholder stays in the URL`,
    );
    return undefined;
  }

  const variable: ServerVariable = { default: defaultValue };
  const enumValues = Array.isArray(declared.enum)
    ? declared.enum.map(scalarText).filter((value): value is string => value !== undefined)
    : [];
  if (enumValues.length > 0) {
    variable.enum = enumValues;
    if (!enumValues.includes(defaultValue)) {
      console.warn(
        `[oagen] Warning: Server variable "${name}" of "${url}" on ${context} defaults to "${defaultValue}", which is not one of its enum values (${enumValues.join(', ')}); kept as written`,
      );
    }
  }
  if (typeof declared.description === 'string') variable.description = declared.description;
  return variable;
}

/** A string as itself; a number or boolean as its text; anything else is not a value. */
function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
