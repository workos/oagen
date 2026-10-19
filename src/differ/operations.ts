import type { ErrorResponse, Operation, ServerEntry } from '../ir/types.js';
import { resolveServerUrl } from '../ir/server-url.js';
import type { Change, ParamChange } from './types.js';
import { classifyParamChange } from './classify.js';
import { formatChangeDetails, primitivesDifferOnlyByFormat, typeRefsEqual } from './models.js';

/**
 * The two documents' `servers`, so `diffOperations` can resolve what an
 * operation is actually served from (`op.servers ?? document servers`).
 * `diffSpecs` supplies it; a direct caller may leave it out, in which case an
 * operation that inherits is compared as having no servers at all.
 */
export interface DocumentServers {
  old: ServerEntry[] | undefined;
  new: ServerEntry[] | undefined;
}

export function diffOperations(
  serviceName: string,
  oldOps: Operation[],
  newOps: Operation[],
  documentServers?: DocumentServers,
): Change[] {
  const changes: Change[] = [];
  const oldByName = new Map(oldOps.map((o) => [o.name, o]));
  const newByName = new Map(newOps.map((o) => [o.name, o]));

  for (const [name] of newByName) {
    if (!oldByName.has(name)) {
      changes.push({
        kind: 'operation-added',
        serviceName,
        operationName: name,
        classification: 'additive',
      });
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push({
        kind: 'operation-removed',
        serviceName,
        operationName: name,
        classification: 'breaking',
      });
    }
  }

  for (const [name, newOp] of newByName) {
    const oldOp = oldByName.get(name);
    if (!oldOp) continue;

    const paramChanges = diffParams(oldOp, newOp);
    const responseChanged = !typeRefsEqual(oldOp.response, newOp.response);
    const requestBodyChanged = !requestBodiesEqual(oldOp.requestBody, newOp.requestBody);
    // Only while both sides carry a body: a body appearing or disappearing is
    // already `requestBodyChanged`. An absent flag reads as optional, as it
    // does in OpenAPI.
    const requestBodyRequiredChanged =
      !!oldOp.requestBody &&
      !!newOp.requestBody &&
      (oldOp.requestBodyRequired ?? false) !== (newOp.requestBodyRequired ?? false);
    const httpMethodChanged = oldOp.httpMethod !== newOp.httpMethod;
    const pathChanged = oldOp.path !== newOp.path;
    const paginatedChanged = !!oldOp.pagination !== !!newOp.pagination;
    const injectIdempotencyKeyChanged = oldOp.injectIdempotencyKey !== newOp.injectIdempotencyKey;
    const errorsDiff = classifyErrorsChange(oldOp.errors, newOp.errors);
    const errorsChanged = errorsDiff !== 'none';
    // `servers` is set only when the operation's effective servers differ from
    // the document's. Absent on both sides is "inherits" twice — a moved
    // document is the document-level diff's to report. Otherwise the lists the
    // operation is actually served from are compared, so a document that moves
    // to where the operation already pointed (its override vanishes) is no
    // change to the operation.
    const serversChanged =
      (!!oldOp.servers || !!newOp.servers) &&
      effectiveServersChanged(oldOp.servers ?? documentServers?.old ?? [], newOp.servers ?? documentServers?.new ?? []);

    const hasChanges =
      paramChanges.length > 0 ||
      responseChanged ||
      requestBodyChanged ||
      requestBodyRequiredChanged ||
      httpMethodChanged ||
      pathChanged ||
      paginatedChanged ||
      injectIdempotencyKeyChanged ||
      errorsChanged ||
      serversChanged;

    if (hasChanges) {
      // paginated: false→true is additive (SDK gains pagination helper)
      // paginated: true→false is breaking (SDK loses pagination helper)
      const paginatedBreaking = paginatedChanged && !newOp.pagination;
      // injectIdempotencyKey: false→true is additive (SDK gains idempotency key)
      // injectIdempotencyKey: true→false is breaking (SDK loses idempotency key)
      const injectIdempotencyKeyBreaking = injectIdempotencyKeyChanged && !newOp.injectIdempotencyKey;
      // requestBodyRequired: false→true is breaking (callers must now send the body)
      // requestBodyRequired: true→false is additive (callers may now omit it)
      const requestBodyRequiredBreaking = requestBodyRequiredChanged && !!newOp.requestBodyRequired;
      const errorsBreaking = errorsDiff === 'breaking';

      // servers: any change is breaking (the operation's requests go elsewhere)
      const hasBreaking =
        responseChanged ||
        requestBodyChanged ||
        requestBodyRequiredBreaking ||
        httpMethodChanged ||
        pathChanged ||
        paginatedBreaking ||
        injectIdempotencyKeyBreaking ||
        errorsBreaking ||
        serversChanged ||
        paramChanges.some((pc) => pc.classification === 'breaking');
      changes.push({
        kind: 'operation-modified',
        serviceName,
        operationName: name,
        paramChanges,
        responseChanged,
        requestBodyChanged,
        requestBodyRequiredChanged,
        httpMethodChanged,
        pathChanged,
        paginatedChanged,
        injectIdempotencyKeyChanged,
        errorsChanged,
        serversChanged,
        classification: hasBreaking ? 'breaking' : 'additive',
      });
    }
  }

  return changes;
}

/**
 * Whether an operation's effective server list changed in a way a caller
 * notices, by the rule the document-level diff applies to `ApiSpec.servers`:
 * the lists are compared as multisets keyed by `url` template plus variables
 * (names, defaults, and enum values as a set), so position, `description` on
 * a server or a variable, and enum order do not count; a reorder counts only
 * when it moves the first entry's resolved URL — the operation's default host,
 * the counterpart of the document's `base-url-changed`.
 *
 * Any variable difference flips the flag, including one the document-level
 * diff would call additive (a new enum value, a new variable, a lifted enum):
 * one boolean cannot carry that distinction. Written locally so this module
 * does not depend on the document-level diff (#255); once that lands, this
 * can delegate to `diffServers` and read the answer off its result.
 */
function effectiveServersChanged(oldServers: ServerEntry[], newServers: ServerEntry[]): boolean {
  if (resolvedFirstUrl(oldServers) !== resolvedFirstUrl(newServers)) return true;
  const unmatched = newServers.map(serverIdentity);
  for (const server of oldServers) {
    const twin = unmatched.indexOf(serverIdentity(server));
    if (twin === -1) return true;
    unmatched.splice(twin, 1);
  }
  return unmatched.length > 0;
}

/** The URL a client defaults to: the first server resolved, or `''` without one. */
function resolvedFirstUrl(servers: ServerEntry[]): string {
  return servers.length > 0 ? resolveServerUrl(servers[0]).url : '';
}

/**
 * What makes two servers the same for the multiset comparison: the template
 * and its variables by name, each with its default and its enum values in
 * sorted order (or none). Descriptions are left out. Own enumerable keys
 * only, so a variable named `__proto__` is part of the identity like any
 * other and nothing is read from Object.prototype.
 */
function serverIdentity(server: ServerEntry): string {
  const variables = Object.entries(server.variables ?? {})
    .map(([name, variable]): [string, string, string[] | null] => [
      name,
      variable.default,
      variable.enum ? [...variable.enum].sort() : null,
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify([server.url, variables]);
}

function requestBodiesEqual(a: Operation['requestBody'], b: Operation['requestBody']): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return typeRefsEqual(a, b);
}

function classifyErrorsChange(
  oldErrors: ErrorResponse[],
  newErrors: ErrorResponse[],
): 'none' | 'additive' | 'breaking' {
  const oldByCode = new Map(oldErrors.map((e) => [e.statusCode, e]));
  const newByCode = new Map(newErrors.map((e) => [e.statusCode, e]));

  let hasAdditive = false;
  let hasBreaking = false;

  // New error codes added → additive (SDK gains new error classes)
  for (const code of newByCode.keys()) {
    if (!oldByCode.has(code)) hasAdditive = true;
  }

  // Old error codes removed → breaking (SDK loses error classes)
  for (const code of oldByCode.keys()) {
    if (!newByCode.has(code)) hasBreaking = true;
  }

  // Shared error codes with changed types → breaking
  for (const [code, newErr] of newByCode) {
    const oldErr = oldByCode.get(code);
    if (!oldErr) continue;
    if (!oldErr.type && !newErr.type) continue;
    if (!oldErr.type || !newErr.type || !typeRefsEqual(oldErr.type, newErr.type)) {
      hasBreaking = true;
    }
  }

  if (hasBreaking) return 'breaking';
  if (hasAdditive) return 'additive';
  return 'none';
}

function diffParams(oldOp: Operation, newOp: Operation): ParamChange[] {
  const changes: ParamChange[] = [];
  const tagged = (loc: 'path' | 'query' | 'header', params: typeof oldOp.queryParams) =>
    params.map((p) => ({ p, loc }));
  const allOldParams = [
    ...tagged('path', oldOp.pathParams),
    ...tagged('query', oldOp.queryParams),
    ...tagged('header', oldOp.headerParams),
  ];
  const allNewParams = [
    ...tagged('path', newOp.pathParams),
    ...tagged('query', newOp.queryParams),
    ...tagged('header', newOp.headerParams),
  ];
  const oldByName = new Map(allOldParams.map((e) => [e.p.name, e]));
  const newByName = new Map(allNewParams.map((e) => [e.p.name, e]));

  for (const [name, entry] of newByName) {
    if (!oldByName.has(name)) {
      changes.push(classifyParamChange('param-added', name, entry.p.required));
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push(classifyParamChange('param-removed', name));
    }
  }

  for (const [name, newEntry] of newByName) {
    const oldEntry = oldByName.get(name);
    if (!oldEntry) continue;

    if (!typeRefsEqual(oldEntry.p.type, newEntry.p.type)) {
      if (primitivesDifferOnlyByFormat(oldEntry.p.type, newEntry.p.type)) {
        const change = classifyParamChange('param-format-changed', name);
        change.details = formatChangeDetails(oldEntry.p.type, newEntry.p.type);
        changes.push(change);
      } else {
        changes.push(classifyParamChange('param-type-changed', name));
      }
    }

    if (oldEntry.p.required !== newEntry.p.required) {
      changes.push(classifyParamChange('param-required-changed', name, newEntry.p.required));
    }

    const oldDefault = serializeDefault(oldEntry.p.default);
    const newDefault = serializeDefault(newEntry.p.default);
    if (oldDefault !== newDefault) {
      const change = classifyParamChange('param-default-changed', name);
      change.oldDefault = oldDefault;
      change.newDefault = newDefault;
      change.paramLocation = newEntry.loc;
      change.details = `default ${oldDefault ?? '<unset>'} → ${newDefault ?? '<unset>'}`;
      changes.push(change);
    }
  }

  return changes;
}

function serializeDefault(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects/arrays: stable JSON. Stringification of equal-valued objects is
  // deterministic enough for this comparison since callers typically pass
  // primitives; complex defaults are rare.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
