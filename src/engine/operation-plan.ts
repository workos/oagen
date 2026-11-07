import type { Operation, TypeRef } from '../ir/types.js';
import { assertNever } from '../ir/types.js';

export interface OperationPlan {
  operation: Operation;
  isDelete: boolean;
  hasBody: boolean;
  isIdempotentPost: boolean;
  pathParamsInOptions: boolean;
  isPaginated: boolean;
  /** The model the response deserializes to, read under a nullable wrapper
   *  on the response or on an array's items, and through a union's first
   *  model variant (`extractModelName`). Null when there is none. */
  responseModelName: string | null;
  /** For paginated operations, the model name of individual list items
   *  (unwrapped from the list wrapper, and from a nullable wrapper on the
   *  item type: an item that is a `$ref` to a component admitting `null` is
   *  `nullable<model>`, #615, and deserializes to that model when present).
   *  Null for non-paginated. */
  paginatedItemModelName: string | null;
  isModelResponse: boolean;
  /** True when the response is an unpaginated `type: array` of models —
   *  the items a model, or `nullable<model>` (#615). Emitters should use
   *  this to return `Model[]` (or the language's list equivalent) and map
   *  the deserializer over each element, passing a `null` element through
   *  when `op.response.items` is nullable. */
  isArrayResponse: boolean;
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
  const paginatedItem = isPaginated && op.pagination ? bareOf(op.pagination.itemType) : undefined;
  const paginatedItemModelName = paginatedItem?.kind === 'model' ? paginatedItem.name : null;
  const isModelResponse = responseModelName !== null;
  // Unpaginated `type: array` of models — needs `Model[]` return + elementwise
  // deserialization.  Paginated operations use the pagination wrapper instead.
  // The items may be `nullable<model>` (#615): still that model's list.
  const isArrayResponse = !isPaginated && op.response.kind === 'array' && bareOf(op.response.items).kind === 'model';
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
    isArrayResponse,
    hasQueryParams,
    isAsync,
  };
}

export function resolveResponseModelName(op: Operation): string | null {
  if (op.httpMethod === 'delete') return null;
  return extractModelName(op.response);
}

/**
 * `type` under a nullable wrapper. A `$ref` to a component that admits
 * `null` is `nullable<model>` wherever it stands (#615) — an array's items,
 * a union's variant, a pagination item type — and the model it names is
 * the one to deserialize when a value is present.
 */
function bareOf(type: TypeRef): TypeRef {
  return type.kind === 'nullable' ? type.inner : type;
}

function extractModelName(ref: TypeRef): string | null {
  switch (ref.kind) {
    case 'model':
      return ref.name;
    case 'array': {
      const items = bareOf(ref.items);
      return items.kind === 'model' ? items.name : null;
    }
    case 'nullable':
      return extractModelName(ref.inner);
    case 'union': {
      const firstModel = ref.variants.map(bareOf).find((v) => v.kind === 'model');
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
