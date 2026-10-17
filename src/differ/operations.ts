import type { ErrorResponse, Operation, ResponseContent, TypeRef } from '../ir/types.js';
import type { Change, ParamChange, ResponseContentTypesChange } from './types.js';
import { classifyParamChange } from './classify.js';
import { formatChangeDetails, primitivesDifferOnlyByFormat, typeRefsEqual } from './models.js';

export function diffOperations(serviceName: string, oldOps: Operation[], newOps: Operation[]): Change[] {
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
    const httpMethodChanged = oldOp.httpMethod !== newOp.httpMethod;
    const pathChanged = oldOp.path !== newOp.path;
    const paginatedChanged = !!oldOp.pagination !== !!newOp.pagination;
    const injectIdempotencyKeyChanged = oldOp.injectIdempotencyKey !== newOp.injectIdempotencyKey;
    const errorsDiff = classifyErrorsChange(oldOp.errors, newOp.errors);
    const errorsChanged = errorsDiff !== 'none';
    const responseContentTypeChanges = diffResponseContentTypes(oldOp, newOp);
    const responseContentTypesChanged = responseContentTypeChanges.length > 0;

    const hasChanges =
      paramChanges.length > 0 ||
      responseChanged ||
      requestBodyChanged ||
      httpMethodChanged ||
      pathChanged ||
      paginatedChanged ||
      injectIdempotencyKeyChanged ||
      errorsChanged ||
      responseContentTypesChanged;

    if (hasChanges) {
      // paginated: false→true is additive (SDK gains pagination helper)
      // paginated: true→false is breaking (SDK loses pagination helper)
      const paginatedBreaking = paginatedChanged && !newOp.pagination;
      // injectIdempotencyKey: false→true is additive (SDK gains idempotency key)
      // injectIdempotencyKey: true→false is breaking (SDK loses idempotency key)
      const injectIdempotencyKeyBreaking = injectIdempotencyKeyChanged && !newOp.injectIdempotencyKey;
      const errorsBreaking = errorsDiff === 'breaking';
      // A media type callers could ask for that is gone, or a secondary body
      // that changed shape, breaks them; one they can newly ask for does not.
      const responseContentTypesBreaking = responseContentTypeChanges.some((c) => c.classification === 'breaking');

      const hasBreaking =
        responseChanged ||
        requestBodyChanged ||
        httpMethodChanged ||
        pathChanged ||
        paginatedBreaking ||
        injectIdempotencyKeyBreaking ||
        errorsBreaking ||
        responseContentTypesBreaking ||
        paramChanges.some((pc) => pc.classification === 'breaking');
      changes.push({
        kind: 'operation-modified',
        serviceName,
        operationName: name,
        paramChanges,
        responseChanged,
        requestBodyChanged,
        httpMethodChanged,
        pathChanged,
        paginatedChanged,
        injectIdempotencyKeyChanged,
        errorsChanged,
        responseContentTypesChanged,
        responseContentTypeChanges,
        classification: hasBreaking ? 'breaking' : 'additive',
      });
    }
  }

  return changes;
}

/** One response entry's media types, with the body type the entry's own `type` is read from. */
interface ContentEntry {
  key: string;
  statusCode?: number;
  contentTypes: string[];
  contents: ResponseContent[];
  ownType?: TypeRef;
}

/**
 * Every response entry of an operation that declares media types, keyed so
 * the two specs' entries pair up: the primary success response as `primary`
 * (from the operation's own lists, whether or not `successResponses` exists),
 * every other 2xx/3xx entry as `success:<code>`, and every error as
 * `error:<code>`. With several 2xx the primary is the lowest-coded entry
 * whose type is the operation's `response` (the parser's own pick), listed
 * once, under `primary`.
 */
function contentEntries(op: Operation): ContentEntry[] {
  const entries: ContentEntry[] = [];
  if (op.responseContentTypes && op.responseContents) {
    entries.push({
      key: 'primary',
      contentTypes: op.responseContentTypes,
      contents: op.responseContents,
      ownType: op.response,
    });
  }
  let primaryListed = false;
  const successes = [...(op.successResponses ?? [])].sort((a, b) => a.statusCode - b.statusCode);
  for (const entry of successes) {
    if (!entry.contentTypes || !entry.contents) continue;
    if (!primaryListed && (entry.contents === op.responseContents || typeRefsEqual(entry.type, op.response))) {
      primaryListed = true;
      continue;
    }
    entries.push({
      key: `success:${entry.statusCode}`,
      statusCode: entry.statusCode,
      contentTypes: entry.contentTypes,
      contents: entry.contents,
      ownType: entry.type,
    });
  }
  for (const error of op.errors) {
    if (!error.contentTypes || !error.contents) continue;
    entries.push({
      key: `error:${error.statusCode}`,
      statusCode: error.statusCode,
      contentTypes: error.contentTypes,
      contents: error.contents,
      ownType: error.type,
    });
  }
  return entries;
}

function contentTypeOf(entry: ContentEntry, mediaType: string): TypeRef | undefined {
  return entry.contents.find((c) => c.contentType === mediaType)?.type;
}

/**
 * Per response entry both specs declare, the media types the new spec added,
 * removed, or — for a media type other than the one the entry's own `type`
 * is read from — retyped. An entry only one spec has is not a media-type
 * change: a status code that came or went is the errors diff's business, and
 * the primary is always present.
 */
function diffResponseContentTypes(oldOp: Operation, newOp: Operation): ResponseContentTypesChange[] {
  const before = new Map(contentEntries(oldOp).map((entry) => [entry.key, entry]));
  const changes: ResponseContentTypesChange[] = [];
  for (const entry of contentEntries(newOp)) {
    const old = before.get(entry.key);
    if (!old) continue;
    const oldTypes = new Set(old.contentTypes);
    const newTypes = new Set(entry.contentTypes);
    const added = entry.contentTypes.filter((mediaType) => !oldTypes.has(mediaType));
    const removed = old.contentTypes.filter((mediaType) => !newTypes.has(mediaType));
    const retyped = entry.contentTypes.filter((mediaType) => {
      if (!oldTypes.has(mediaType)) return false;
      const oldType = contentTypeOf(old, mediaType);
      const newType = contentTypeOf(entry, mediaType);
      if (!oldType || !newType || typeRefsEqual(oldType, newType)) return false;
      // The entry's own body is what `responseChanged` / `errorsChanged` report.
      const wasOwn = old.ownType !== undefined && typeRefsEqual(oldType, old.ownType);
      const isOwn = entry.ownType !== undefined && typeRefsEqual(newType, entry.ownType);
      return !(wasOwn && isOwn);
    });
    if (added.length === 0 && removed.length === 0 && retyped.length === 0) continue;
    changes.push({
      ...(entry.statusCode !== undefined ? { statusCode: entry.statusCode } : {}),
      added,
      removed,
      retyped,
      classification: removed.length > 0 || retyped.length > 0 ? 'breaking' : 'additive',
    });
  }
  return changes;
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
