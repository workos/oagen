import type { Operation, TypeRef } from '../ir/types.js';
import { assertNever } from '../ir/types.js';

export interface OperationPlan {
  operation: Operation;
  isDelete: boolean;
  hasBody: boolean;
  isIdempotentPost: boolean;
  pathParamsInOptions: boolean;
  isPaginated: boolean;
  responseModelName: string | null;
  /** For paginated operations, the model name of individual list items
   *  (unwrapped from the list wrapper). Null for non-paginated. */
  paginatedItemModelName: string | null;
  isModelResponse: boolean;
  hasQueryParams: boolean;
  isAsync: boolean;
}

export function planOperation(op: Operation): OperationPlan {
  const isDelete = op.httpMethod === 'delete';
  const hasBody = !!op.requestBody;
  const isIdempotentPost = op.injectIdempotencyKey && op.httpMethod === 'post';
  const hasQueryParams = op.queryParams.length > 0;
  const pathParamsInOptions = op.pathParams.length > 1 || (op.pathParams.length > 0 && (hasBody || hasQueryParams));
  const isPaginated = op.pagination !== undefined;
  const responseModelName = resolveResponseModelName(op);
  const paginatedItemModelName =
    isPaginated && op.pagination?.itemType.kind === 'model' ? op.pagination.itemType.name : null;
  const isModelResponse = responseModelName !== null;
  const isAsync = op.async ?? true;

  return {
    operation: op,
    isDelete,
    hasBody,
    isIdempotentPost,
    pathParamsInOptions,
    isPaginated,
    responseModelName,
    paginatedItemModelName,
    isModelResponse,
    hasQueryParams,
    isAsync,
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
    case 'map':
    case 'enum':
    case 'primitive':
    case 'literal':
      return null;
    default:
      return assertNever(ref);
  }
}
