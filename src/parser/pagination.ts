import type { TypeRef, Parameter, PaginationMeta } from '../ir/types.js';

const CURSOR_PARAMS = ['cursor', 'after', 'before', 'starting_after', 'ending_before', 'page_token', 'next_token'];

const OFFSET_PARAMS = ['offset', 'page', 'page_number', 'skip'];
const LIMIT_PARAMS = ['limit', 'page_size', 'per_page', 'size', 'count'];

/**
 * Detect if an operation uses pagination and return structured metadata
 * for auto-paging iterator generation.
 *
 * Supports two strategies:
 * 1. **Cursor-based**: query params include a cursor-like parameter
 * 2. **Offset-based**: query params include both an offset-like and limit-like parameter
 *
 * Returns null if no pagination pattern is detected.
 */
export function detectPagination(
  response: TypeRef,
  queryParams: Parameter[],
  dataPath?: string,
): PaginationMeta | null {
  // Try cursor-based first (preferred)
  const cursorParam = queryParams.find((p) => CURSOR_PARAMS.includes(p.name));

  if (cursorParam) {
    const itemType: TypeRef = response.kind === 'array' ? response.items : response;
    return {
      strategy: 'cursor',
      param: cursorParam.name,
      dataPath: dataPath,
      itemType,
    };
  }

  // Try offset-based pagination
  const offsetParam = queryParams.find((p) => OFFSET_PARAMS.includes(p.name));
  const limitParam = queryParams.find((p) => LIMIT_PARAMS.includes(p.name));

  if (offsetParam && limitParam) {
    const itemType: TypeRef = response.kind === 'array' ? response.items : response;
    return {
      strategy: 'offset',
      param: offsetParam.name,
      limitParam: limitParam.name,
      dataPath: dataPath,
      itemType,
    };
  }

  return null;
}
