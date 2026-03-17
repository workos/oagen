import type { TypeRef, Parameter, PaginationMeta } from '../ir/types.js';

const CURSOR_PARAMS = ['cursor', 'after', 'before', 'starting_after', 'ending_before'];

/**
 * Detect if an operation uses cursor-based pagination and return
 * structured metadata for auto-paging iterator generation.
 *
 * Heuristics:
 * 1. Query params include a cursor-like parameter (cursor, after, before, starting_after, ending_before)
 * 2. Response TypeRef is walked to infer the item type
 *
 * Returns null if no cursor param is found.
 */
export function detectPagination(response: TypeRef, queryParams: Parameter[]): PaginationMeta | null {
  const cursorParam = queryParams.find((p) => CURSOR_PARAMS.includes(p.name));

  if (!cursorParam) return null;

  // Infer item type from the response TypeRef
  const itemType: TypeRef = response.kind === 'array' ? response.items : response;

  return {
    cursorParam: cursorParam.name,
    dataPath: 'data',
    itemType,
  };
}
