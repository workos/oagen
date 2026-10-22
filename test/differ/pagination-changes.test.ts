import { describe, it, expect } from 'vitest';
import { diffOperations } from '../../src/differ/operations.js';
import type { Operation, PaginationMeta } from '../../src/ir/types.js';

/**
 * Every change to how an iterator pages is reported (#221): the strategy, the
 * parameter it advances, the page-size parameter, the first page, the array it
 * reads and the field that stops it all change behavior even though the
 * operation's signature is unchanged.
 */
describe('diffOperations — pagination strategy, parameters and end of iteration', () => {
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

  const paginationFlags = [
    'paginationStrategyChanged',
    'paginationParamChanged',
    'paginationLimitParamChanged',
    'paginationDataPathChanged',
    'paginationPageStartChanged',
    'paginationEndOfIterationChanged',
  ] as const;

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

  it('reports a change of the parameter the iterator advances as breaking', () => {
    const change = only(diffOperations('Pets', [listPets], [withPagination({ param: 'page_number' })]));
    expect(change.paginationParamChanged).toBe(true);
    expect(change.paginationStrategyChanged).toBe(false);
    expect(change.classification).toBe('breaking');
  });

  it('reports a changed, gained or lost page-size parameter as breaking', () => {
    for (const after of [withPagination({ limitParam: 'per_page' }), withPagination({ limitParam: undefined })]) {
      const change = only(diffOperations('Pets', [listPets], [after]));
      expect(change.paginationLimitParamChanged).toBe(true);
      expect(change.classification).toBe('breaking');
    }
    const gained = only(diffOperations('Pets', [withPagination({ limitParam: undefined })], [listPets]));
    expect(gained.paginationLimitParamChanged).toBe(true);
    expect(gained.classification).toBe('breaking');
  });

  it('reports a change of the data array location as breaking', () => {
    const change = only(diffOperations('Pets', [listPets], [withPagination({ dataPath: 'items' })]));
    expect(change.paginationDataPathChanged).toBe(true);
    expect(change.classification).toBe('breaking');
  });

  it('reports a change of the first page number as breaking', () => {
    const before = withPagination({ strategy: 'page', pageStart: 1 });
    const change = only(diffOperations('Pets', [before], [withPagination({ strategy: 'page', pageStart: 0 })]));
    expect(change.paginationPageStartChanged).toBe(true);
    expect(change.paginationStrategyChanged).toBe(false);
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

  it('leaves every pagination flag false when pagination appears or disappears altogether', () => {
    const unpaginated: Operation = { ...listPets, pagination: undefined };
    for (const [before, after] of [
      [unpaginated, listPets],
      [listPets, unpaginated],
    ]) {
      const change = only(diffOperations('Pets', [before], [after]));
      expect(change.paginatedChanged).toBe(true);
      for (const flag of paginationFlags) expect(change[flag], flag).toBe(false);
    }
  });

  it('combines a strategy change with a first-time end-of-iteration field as breaking', () => {
    const after = withPagination({
      strategy: 'page',
      pageStart: 1,
      endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
    });
    const change = only(diffOperations('Pets', [listPets], [after]));
    expect(change.paginationStrategyChanged).toBe(true);
    expect(change.paginationPageStartChanged).toBe(true);
    expect(change.paginationEndOfIterationChanged).toBe(true);
    expect(change.classification).toBe('breaking');
  });
});
