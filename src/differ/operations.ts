import type { ErrorResponse, Operation, TypeRef } from '../ir/types.js';
import type { Change, ParamChange } from './types.js';
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
    const fallbackDiff = classifyFallbackResponsesChange(oldOp, newOp);
    const fallbackResponsesChanged = fallbackDiff !== 'none';

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
      fallbackResponsesChanged;

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
      const fallbackBreaking = fallbackDiff === 'breaking';

      const hasBreaking =
        responseChanged ||
        requestBodyChanged ||
        requestBodyRequiredBreaking ||
        httpMethodChanged ||
        pathChanged ||
        paginatedBreaking ||
        injectIdempotencyKeyBreaking ||
        errorsBreaking ||
        fallbackBreaking ||
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
        fallbackResponsesChanged,
        classification: hasBreaking ? 'breaking' : 'additive',
      });
    }
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
  return classifyKeyedResponsesChange(
    new Map(oldErrors.map((e) => [e.statusCode, e])),
    new Map(newErrors.map((e) => [e.statusCode, e])),
  );
}

/**
 * The fallback responses, keyed the way the spec keys them (`default`,
 * `4XX`), classified like `errors`: one added is additive (the SDK gains a
 * typed fallback), one removed or retyped is breaking.
 */
function classifyFallbackResponsesChange(oldOp: Operation, newOp: Operation): 'none' | 'additive' | 'breaking' {
  const byKey = (op: Operation): Map<string, { type?: TypeRef }> => {
    const entries = new Map<string, { type?: TypeRef }>();
    if (op.defaultResponse) entries.set('default', op.defaultResponse);
    for (const range of op.rangeResponses ?? []) entries.set(range.range, range);
    return entries;
  };
  return classifyKeyedResponsesChange(byKey(oldOp), byKey(newOp));
}

/**
 * Responses matched by key (a status code, `default`, a range): a new key is
 * additive (the SDK gains an error class or typed fallback), a removed key is
 * breaking (it loses one), and a shared key whose body type changed is
 * breaking. A key with no body on either side is unchanged.
 */
function classifyKeyedResponsesChange<K>(
  oldByKey: Map<K, { type?: TypeRef }>,
  newByKey: Map<K, { type?: TypeRef }>,
): 'none' | 'additive' | 'breaking' {
  let hasAdditive = false;
  let hasBreaking = false;

  for (const key of newByKey.keys()) {
    if (!oldByKey.has(key)) hasAdditive = true;
  }

  for (const key of oldByKey.keys()) {
    if (!newByKey.has(key)) hasBreaking = true;
  }

  for (const [key, newEntry] of newByKey) {
    const oldEntry = oldByKey.get(key);
    if (!oldEntry) continue;
    if (!oldEntry.type && !newEntry.type) continue;
    if (!oldEntry.type || !newEntry.type || !typeRefsEqual(oldEntry.type, newEntry.type)) {
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
