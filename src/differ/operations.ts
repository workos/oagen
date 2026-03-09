import type { ErrorResponse, Operation } from '../ir/types.js';
import type { Change, ParamChange } from './types.js';
import { classifyParamChange } from './classify.js';
import { typeRefsEqual } from './models.js';

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
    const paginatedChanged = oldOp.paginated !== newOp.paginated;
    const idempotentChanged = oldOp.idempotent !== newOp.idempotent;
    const errorsDiff = classifyErrorsChange(oldOp.errors, newOp.errors);
    const errorsChanged = errorsDiff !== 'none';

    const hasChanges =
      paramChanges.length > 0 ||
      responseChanged ||
      requestBodyChanged ||
      httpMethodChanged ||
      pathChanged ||
      paginatedChanged ||
      idempotentChanged ||
      errorsChanged;

    if (hasChanges) {
      // paginated: false→true is additive (SDK gains pagination helper)
      // paginated: true→false is breaking (SDK loses pagination helper)
      const paginatedBreaking = paginatedChanged && !newOp.paginated;
      // idempotent: false→true is additive (SDK gains idempotency key)
      // idempotent: true→false is breaking (SDK loses idempotency key)
      const idempotentBreaking = idempotentChanged && !newOp.idempotent;
      const errorsBreaking = errorsDiff === 'breaking';

      const hasBreaking =
        responseChanged ||
        requestBodyChanged ||
        httpMethodChanged ||
        pathChanged ||
        paginatedBreaking ||
        idempotentBreaking ||
        errorsBreaking ||
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
        idempotentChanged,
        errorsChanged,
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

function diffParams(oldOp: Operation, newOp: Operation): ParamChange[] {
  const changes: ParamChange[] = [];
  const allOldParams = [...oldOp.pathParams, ...oldOp.queryParams, ...oldOp.headerParams];
  const allNewParams = [...newOp.pathParams, ...newOp.queryParams, ...newOp.headerParams];
  const oldByName = new Map(allOldParams.map((p) => [p.name, p]));
  const newByName = new Map(allNewParams.map((p) => [p.name, p]));

  for (const [name, param] of newByName) {
    if (!oldByName.has(name)) {
      changes.push(classifyParamChange('param-added', name, param.required));
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push(classifyParamChange('param-removed', name));
    }
  }

  for (const [name, newParam] of newByName) {
    const oldParam = oldByName.get(name);
    if (!oldParam) continue;

    if (!typeRefsEqual(oldParam.type, newParam.type)) {
      changes.push(classifyParamChange('param-type-changed', name));
    }

    if (oldParam.required !== newParam.required) {
      changes.push(classifyParamChange('param-required-changed', name, newParam.required));
    }
  }

  return changes;
}
