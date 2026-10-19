import { describe, it, expect } from 'vitest';
import { diffOperations } from '../../src/differ/operations.js';
import type { Operation, PaginationMeta } from '../../src/ir/types.js';

/**
 * A change of pagination strategy or of the end-of-iteration field is reported
 * (#221): the generated iterator advances or stops differently even though
 * the operation's signature is unchanged.
 */
describe('diffOperations — pagination strategy and end of iteration', () => {
  const pagination: PaginationMeta = {
    strategy: 'offset',
    param: 'page',
    limitParam: 'limit',
    dataPath: 'pets',
    itemType: { kind: 'model', name: 'Pet' },
  };

  const listPets: Operation = {
    name: 'listPets',
    description: 'List pets',
    httpMethod: 'get',
    path: '/pets',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'array', items: { kind: 'model', name: 'Pet' } },
    errors: [],
    pagination,
    injectIdempotencyKey: false,
  };

  const withPagination = (over: Partial<PaginationMeta>): Operation => ({
    ...listPets,
    pagination: { ...pagination, ...over },
  });

  const only = (changes: ReturnType<typeof diffOperations>) => {
    expect(changes).toHaveLength(1);
    const change = changes[0];
    if (change.kind !== 'operation-modified') throw new Error(`expected operation-modified, got ${change.kind}`);
    return change;
  };

  it('reports no change for identical pagination', () => {
    expect(diffOperations('Pets', [listPets], [withPagination({})])).toEqual([]);
  });

  it('reports a strategy change as breaking', () => {
    const change = only(diffOperations('Pets', [listPets], [withPagination({ strategy: 'page' })]));
    expect(change.paginationStrategyChanged).toBe(true);
    expect(change.paginationEndOfIterationChanged).toBe(false);
    expect(change.paginatedChanged).toBe(false);
    expect(change.classification).toBe('breaking');
  });

  it('reports a newly detected end-of-iteration field as additive', () => {
    const change = only(
      diffOperations('Pets', [listPets], [withPagination({ endOfIteration: { kind: 'hasMore', path: 'has_more' } })]),
    );
    expect(change.paginationEndOfIterationChanged).toBe(true);
    expect(change.paginationStrategyChanged).toBe(false);
    expect(change.classification).toBe('additive');
  });

  it('reports a changed end-of-iteration field as breaking', () => {
    const before = withPagination({ endOfIteration: { kind: 'hasMore', path: 'has_more' } });
    const kindChanged = withPagination({ endOfIteration: { kind: 'totalPages', path: 'has_more' } });
    const pathChanged = withPagination({ endOfIteration: { kind: 'hasMore', path: 'meta.has_more' } });
    for (const after of [kindChanged, pathChanged]) {
      const change = only(diffOperations('Pets', [before], [after]));
      expect(change.paginationEndOfIterationChanged).toBe(true);
      expect(change.classification).toBe('breaking');
    }
  });

  it('reports a removed end-of-iteration field as breaking', () => {
    const before = withPagination({ endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' } });
    const change = only(diffOperations('Pets', [before], [listPets]));
    expect(change.paginationEndOfIterationChanged).toBe(true);
    expect(change.classification).toBe('breaking');
  });

  it('leaves both flags false when pagination appears or disappears altogether', () => {
    const unpaginated: Operation = { ...listPets, pagination: undefined };
    for (const [before, after] of [
      [unpaginated, listPets],
      [listPets, unpaginated],
    ]) {
      const change = only(diffOperations('Pets', [before], [after]));
      expect(change.paginatedChanged).toBe(true);
      expect(change.paginationStrategyChanged).toBe(false);
      expect(change.paginationEndOfIterationChanged).toBe(false);
    }
  });

  it('combines a strategy change with a first-time end-of-iteration field as breaking', () => {
    const after = withPagination({
      strategy: 'page',
      endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
    });
    const change = only(diffOperations('Pets', [listPets], [after]));
    expect(change.paginationStrategyChanged).toBe(true);
    expect(change.paginationEndOfIterationChanged).toBe(true);
    expect(change.classification).toBe('breaking');
  });
});
