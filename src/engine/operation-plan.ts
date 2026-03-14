import type { Operation, TypeRef } from '../ir/types.js';

export interface OperationPlan {
  operation: Operation;
  isDelete: boolean;
  hasBody: boolean;
  isIdempotentPost: boolean;
  pathParamsInOptions: boolean;
  isPaginated: boolean;
  responseModelName: string | null;
  isModelResponse: boolean;
  hasQueryParams: boolean;
}

export function planOperation(op: Operation): OperationPlan {
  const isDelete = op.httpMethod === 'delete';
  const hasBody = !!op.requestBody;
  const isIdempotentPost = op.idempotent && op.httpMethod === 'post';
  const hasQueryParams = op.queryParams.length > 0;
  const pathParamsInOptions = op.pathParams.length > 1 || (op.pathParams.length > 0 && (hasBody || hasQueryParams));
  const isPaginated = op.paginated;
  const responseModelName = resolveResponseModelName(op);
  const isModelResponse = responseModelName !== null;

  return {
    operation: op,
    isDelete,
    hasBody,
    isIdempotentPost,
    pathParamsInOptions,
    isPaginated,
    responseModelName,
    isModelResponse,
    hasQueryParams,
  };
}

export function resolveResponseModelName(op: Operation): string | null {
  if (op.httpMethod === 'delete') return null;
  return extractModelName(op.response);
}

function extractModelName(ref: TypeRef): string | null {
  switch (ref.kind) {
    case 'model':
      return ref.name;
    case 'array':
      return ref.items.kind === 'model' ? ref.items.name : null;
    case 'nullable':
      return extractModelName(ref.inner);
    case 'union': {
      const firstModel = ref.variants.find((v) => v.kind === 'model');
      return firstModel && firstModel.kind === 'model' ? firstModel.name : null;
    }
    case 'enum':
    case 'primitive':
      return null;
  }
}
