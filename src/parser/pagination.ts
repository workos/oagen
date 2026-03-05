import type { TypeRef, Parameter } from '../ir/types.js';

/**
 * Detect if an operation uses cursor-based pagination.
 *
 * Heuristics:
 * 1. Response contains a `data` array field
 * 2. Query params include a cursor-like parameter (cursor, after, before, starting_after)
 *
 * OR:
 * 1. Response has a wrapper object with list_metadata / next_cursor field
 */
export function detectPagination(response: TypeRef, queryParams: Parameter[]): boolean {
  const hasCursorParam = queryParams.some((p) =>
    ['cursor', 'after', 'before', 'starting_after', 'ending_before'].includes(p.name),
  );

  if (!hasCursorParam) return false;

  // Response is a model/object that likely wraps a list
  // In a dereferenced spec, the response will be inlined — check if it looks like a list wrapper
  // For now, having a cursor param is a strong enough signal
  return true;
}
