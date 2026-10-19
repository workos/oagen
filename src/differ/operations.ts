import type { ErrorResponse, Operation } from '../ir/types.js';
import type { Change, ParamChange } from './types.js';
import { classifyParamChange, deprecationDetails, deprecationFlip } from './classify.js';
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
    // Additive either way: the operation's signature is unchanged, but a
    // changelog has to say it, so a flipped flag alone is a change.
    const deprecation = deprecationFlip(oldOp, newOp);
    const deprecatedChanged = deprecation !== undefined;

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
      deprecatedChanged;

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

      const hasBreaking =
        responseChanged ||
        requestBodyChanged ||
        requestBodyRequiredBreaking ||
        httpMethodChanged ||
        pathChanged ||
        paginatedBreaking ||
        injectIdempotencyKeyBreaking ||
        errorsBreaking ||
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
        deprecatedChanged,
        ...deprecation,
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

type ParamLocation = 'path' | 'query' | 'header';

/**
 * The key `diffParams` matches parameters on. OpenAPI allows a path `id`
 * beside a query `id` on one operation, and keying by name alone paired
 * whichever came last on each side with the other's, so a change to one of
 * them was reported against the wrong parameter or not at all.
 */
function paramKey(loc: ParamLocation, name: string): string {
  return `${loc}:${name}`;
}

function diffParams(oldOp: Operation, newOp: Operation): ParamChange[] {
  const changes: ParamChange[] = [];
  const tagged = (loc: ParamLocation, params: typeof oldOp.queryParams) => params.map((p) => ({ p, loc }));
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
  const oldByKey = new Map(allOldParams.map((e) => [paramKey(e.loc, e.p.name), e]));
  const newByKey = new Map(allNewParams.map((e) => [paramKey(e.loc, e.p.name), e]));
  // Every entry says where its parameter lives, since the name alone no
  // longer identifies it.
  const at = (change: ParamChange, loc: ParamLocation): ParamChange => {
    change.paramLocation = loc;
    return change;
  };

  for (const [key, entry] of newByKey) {
    if (!oldByKey.has(key)) {
      changes.push(at(classifyParamChange('param-added', entry.p.name, entry.p.required), entry.loc));
    }
  }

  for (const [key, entry] of oldByKey) {
    if (!newByKey.has(key)) {
      changes.push(at(classifyParamChange('param-removed', entry.p.name), entry.loc));
    }
  }

  for (const [key, newEntry] of newByKey) {
    const oldEntry = oldByKey.get(key);
    if (!oldEntry) continue;
    const name = newEntry.p.name;
    const loc = newEntry.loc;

    if (!typeRefsEqual(oldEntry.p.type, newEntry.p.type)) {
      if (primitivesDifferOnlyByFormat(oldEntry.p.type, newEntry.p.type)) {
        const change = at(classifyParamChange('param-format-changed', name), loc);
        change.details = formatChangeDetails(oldEntry.p.type, newEntry.p.type);
        changes.push(change);
      } else {
        changes.push(at(classifyParamChange('param-type-changed', name), loc));
      }
    }

    if (oldEntry.p.required !== newEntry.p.required) {
      changes.push(at(classifyParamChange('param-required-changed', name, newEntry.p.required), loc));
    }

    const oldDefault = serializeDefault(oldEntry.p.default);
    const newDefault = serializeDefault(newEntry.p.default);
    if (oldDefault !== newDefault) {
      const change = at(classifyParamChange('param-default-changed', name), loc);
      change.oldDefault = oldDefault;
      change.newDefault = newDefault;
      change.details = `default ${oldDefault ?? '<unset>'} → ${newDefault ?? '<unset>'}`;
      changes.push(change);
    }

    const deprecation = deprecationFlip(oldEntry.p, newEntry.p);
    if (deprecation) {
      changes.push({
        ...at(classifyParamChange('param-deprecated-changed', name), loc),
        ...deprecation,
        details: deprecationDetails(deprecation.newDeprecated),
      });
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
