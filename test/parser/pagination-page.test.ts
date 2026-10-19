import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectPagination,
  detectEndOfIteration,
  applyPaginationOverrides,
  validatePaginationHint,
} from '../../src/parser/pagination.js';
import type { Parameter, PaginationMeta, TypeRef } from '../../src/ir/types.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

/**
 * Page-number pagination (#221): `page`-style parameters are their own
 * strategy, the envelope's end-of-iteration field is detected, and an explicit
 * override (`x-pagination` / `operationHints[...].pagination`) wins over the
 * name-based guess.
 */
const param = (name: string): Parameter => ({ name, type: { kind: 'primitive', type: 'string' }, required: false });
const pets: TypeRef = { kind: 'array', items: { kind: 'model', name: 'Pet' } };
const pet: TypeRef = { kind: 'model', name: 'Pet' };

describe('detectPagination — page-number strategy', () => {
  it('reports page + limit as the page strategy, advanced by one rather than by items', () => {
    expect(detectPagination(pets, [param('page'), param('limit')], 'pets')).toEqual({
      strategy: 'page',
      param: 'page',
      limitParam: 'limit',
      dataPath: 'pets',
      itemType: pet,
    });
  });

  it.each(['page_number', 'page_num'])('recognizes %s as a page-number parameter', (name) => {
    const result = detectPagination(pets, [param(name), param('per_page')]);
    expect(result?.strategy).toBe('page');
    expect(result?.param).toBe(name);
    expect(result?.limitParam).toBe('per_page');
  });

  it.each(['limit', 'page_size', 'per_page', 'size', 'count'])('pairs page with the %s page-size parameter', (name) => {
    expect(detectPagination(pets, [param('page'), param(name)])).toMatchObject({ strategy: 'page', limitParam: name });
  });

  it('keeps offset and skip as the offset strategy', () => {
    expect(detectPagination(pets, [param('offset'), param('limit')])).toMatchObject({
      strategy: 'offset',
      param: 'offset',
    });
    expect(detectPagination(pets, [param('skip'), param('count')])).toMatchObject({
      strategy: 'offset',
      param: 'skip',
    });
  });

  it('prefers a cursor parameter over a page parameter', () => {
    const result = detectPagination(pets, [param('page'), param('limit'), param('after')]);
    expect(result).toEqual({ strategy: 'cursor', param: 'after', dataPath: undefined, itemType: pet });
  });

  it('prefers an offset parameter over a page parameter when both are declared', () => {
    const result = detectPagination(pets, [param('page'), param('offset'), param('limit')]);
    expect(result).toMatchObject({ strategy: 'offset', param: 'offset', limitParam: 'limit' });
  });

  it('does not treat a page parameter without a page-size parameter as pagination', () => {
    expect(detectPagination(pets, [param('page')])).toBeNull();
    expect(detectPagination(pets, [param('page_number'), param('sort')])).toBeNull();
  });
});

describe('detectEndOfIteration', () => {
  const integer: SchemaObject = { type: 'integer' };
  const boolean: SchemaObject = { type: 'boolean' };
  const data: SchemaObject = { type: 'array', items: { type: 'string' } };

  it('finds totalPages nested under the pagination companion, as a dotted path', () => {
    const properties = {
      pets: data,
      pagination: { type: 'object', properties: { page: integer, totalPages: integer } },
    };
    expect(detectEndOfIteration(properties, 'pets')).toEqual({ kind: 'totalPages', path: 'pagination.totalPages' });
  });

  it('finds a top-level has_more boolean', () => {
    expect(detectEndOfIteration({ data, has_more: boolean }, 'data')).toEqual({ kind: 'hasMore', path: 'has_more' });
  });

  it('finds a top-level total count', () => {
    expect(detectEndOfIteration({ items: data, total: integer }, 'items')).toEqual({
      kind: 'totalCount',
      path: 'total',
    });
    expect(detectEndOfIteration({ items: data, total_count: { type: 'number' } }, 'items')).toEqual({
      kind: 'totalCount',
      path: 'total_count',
    });
  });

  it('prefers hasMore over totalPages over a total count', () => {
    const meta = { type: 'object', properties: { total: integer, total_pages: integer, has_more: boolean } };
    expect(detectEndOfIteration({ data, meta }, 'data')).toEqual({ kind: 'hasMore', path: 'meta.has_more' });
    expect(detectEndOfIteration({ data, total: integer, total_pages: integer }, 'data')).toEqual({
      kind: 'totalPages',
      path: 'total_pages',
    });
  });

  it('prefers a top-level field over a nested one of the same kind', () => {
    const pagination = { type: 'object', properties: { has_more: boolean } };
    expect(detectEndOfIteration({ data, pagination, hasMore: boolean }, 'data')).toEqual({
      kind: 'hasMore',
      path: 'hasMore',
    });
  });

  it('follows a $ref companion to its component schema', () => {
    const components: Record<string, SchemaObject> = {
      Pagination: { type: 'object', properties: { page: integer, total_pages: integer } },
    };
    const properties = { data, pagination: { $ref: '#/components/schemas/Pagination' } };
    expect(detectEndOfIteration(properties, 'data', components)).toEqual({
      kind: 'totalPages',
      path: 'pagination.total_pages',
    });
  });

  it('merges the allOf members of a companion, including $ref members', () => {
    const components: Record<string, SchemaObject> = { Base: { type: 'object', properties: { page: integer } } };
    const pagination: SchemaObject = {
      allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { pageCount: integer } }],
    };
    expect(detectEndOfIteration({ data, pagination }, 'data', components)).toEqual({
      kind: 'totalPages',
      path: 'pagination.pageCount',
    });
  });

  it('accepts a nullable companion declared with a type array', () => {
    const pagination: SchemaObject = {
      type: ['object', 'null'],
      properties: { totalPages: { type: ['integer', 'null'] } },
    };
    expect(detectEndOfIteration({ data, pagination }, 'data')).toEqual({
      kind: 'totalPages',
      path: 'pagination.totalPages',
    });
  });

  it('ignores a candidate whose type does not fit its kind', () => {
    expect(detectEndOfIteration({ data, total: { type: 'string' }, has_more: integer }, 'data')).toBeUndefined();
  });

  it('never reads the data array itself', () => {
    expect(detectEndOfIteration({ total: data, object: { type: 'string' } }, 'total')).toBeUndefined();
  });

  it('returns undefined when nothing recognizable is declared', () => {
    const list_metadata = { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } } };
    expect(detectEndOfIteration({ data, list_metadata, object: { type: 'string' } }, 'data')).toBeUndefined();
  });
});

describe('applyPaginationOverrides', () => {
  const detected: PaginationMeta = {
    strategy: 'offset',
    param: 'page',
    limitParam: 'limit',
    dataPath: 'pets',
    itemType: pet,
    endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
  };
  const params = [param('page'), param('limit'), param('cursor')];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    warn.mockClear();
  });

  it('returns the detected metadata untouched when no override is given', () => {
    expect(applyPaginationOverrides(detected, {}, params, pets, 'listPets')).toBe(detected);
    expect(warn).not.toHaveBeenCalled();
  });

  it('re-labels the strategy and keeps every detected field it does not restate', () => {
    expect(applyPaginationOverrides(detected, { extension: { strategy: 'page' } }, params, pets, 'listPets')).toEqual({
      ...detected,
      strategy: 'page',
    });
  });

  it('layers the config hint over the extension over detection, field by field', () => {
    const result = applyPaginationOverrides(
      detected,
      { extension: { strategy: 'page', dataPath: 'items' }, hint: { strategy: 'cursor', param: 'cursor' } },
      params,
      pets,
      'listPets',
    );
    expect(result).toEqual({
      strategy: 'cursor',
      param: 'cursor',
      limitParam: 'limit',
      dataPath: 'items',
      itemType: pet,
      endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
    });
  });

  it('turns pagination off with strategy none, from either source', () => {
    expect(applyPaginationOverrides(detected, { extension: { strategy: 'none' } }, params, pets, 'x')).toBeUndefined();
    expect(applyPaginationOverrides(detected, { hint: { strategy: 'none' } }, params, pets, 'x')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('builds pagination from scratch when nothing was detected', () => {
    const result = applyPaginationOverrides(
      undefined,
      { extension: { strategy: 'cursor', param: 'cursor', endOfIteration: { kind: 'hasMore', path: 'has_more' } } },
      params,
      pets,
      'listPets',
    );
    expect(result).toEqual({
      strategy: 'cursor',
      param: 'cursor',
      itemType: pet,
      endOfIteration: { kind: 'hasMore', path: 'has_more' },
    });
  });

  it('replaces the detected end-of-iteration field when the override names one', () => {
    const end = { kind: 'hasMore', path: 'meta.more' } as const;
    const result = applyPaginationOverrides(detected, { extension: { endOfIteration: end } }, params, pets, 'x');
    expect(result?.endOfIteration).toEqual(end);
    expect(result?.strategy).toBe('offset');
  });

  it('warns and falls back to detection on an unknown strategy', () => {
    const result = applyPaginationOverrides(detected, { extension: { strategy: 'bogus' } }, params, pets, 'listPets');
    expect(result).toBe(detected);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[oagen] Warning: x-pagination on listPets: unknown strategy "bogus"'),
    );
  });

  it('warns and falls back when a strategy is given but no param exists from any source', () => {
    const result = applyPaginationOverrides(undefined, { extension: { strategy: 'page' } }, params, pets, 'listPets');
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('strategy "page" needs a param'));
  });

  it('warns and falls back when only a param is given and no strategy exists from any source', () => {
    const result = applyPaginationOverrides(undefined, { extension: { param: 'page' } }, params, pets, 'listPets');
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sets no strategy and none was detected'));
  });

  it('warns and falls back when the named param is not a query parameter of the operation', () => {
    const result = applyPaginationOverrides(detected, { hint: { param: 'pg' } }, params, pets, 'listPets');
    expect(result).toBe(detected);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('operationHints pagination on listPets: param "pg" is not a query parameter'),
    );
  });

  it('warns and falls back when the named limitParam is not a query parameter', () => {
    const result = applyPaginationOverrides(detected, { extension: { limitParam: 'size' } }, params, pets, 'listPets');
    expect(result).toBe(detected);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('limitParam "size" is not a query parameter'));
  });

  it('still applies a valid hint when the extension is malformed', () => {
    const result = applyPaginationOverrides(
      detected,
      { extension: 'page', hint: { strategy: 'page' } },
      params,
      pets,
      'listPets',
    );
    expect(result?.strategy).toBe('page');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('x-pagination on listPets must be an object'));
  });
});

describe('validatePaginationHint', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    warn.mockClear();
  });

  it('returns only the keys the author set', () => {
    expect(validatePaginationHint({ strategy: 'page', limitParam: 'per_page' }, 'x-pagination', 'op')).toEqual({
      strategy: 'page',
      limitParam: 'per_page',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a key set to undefined as absent', () => {
    expect(validatePaginationHint({ strategy: undefined, param: 'page' }, 'x-pagination', 'op')).toEqual({
      param: 'page',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips an unknown key with a warning and keeps the rest', () => {
    expect(validatePaginationHint({ strategy: 'page', limit_param: 'x' }, 'x-pagination', 'op')).toEqual({
      strategy: 'page',
    });
    expect(warn).toHaveBeenCalledWith('[oagen] Warning: x-pagination on op: unknown key "limit_param" skipped');
  });

  it('rejects anything that is not an object', () => {
    expect(validatePaginationHint('page', 'x-pagination', 'op')).toBeUndefined();
    expect(validatePaginationHint(null, 'x-pagination', 'op')).toBeUndefined();
    expect(validatePaginationHint(['page'], 'x-pagination', 'op')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('rejects an empty or non-string parameter name', () => {
    expect(validatePaginationHint({ param: '' }, 'x-pagination', 'op')).toBeUndefined();
    expect(validatePaginationHint({ dataPath: 3 }, 'x-pagination', 'op')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('param must be a non-empty string'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dataPath must be a non-empty string'));
  });

  it('rejects a malformed endOfIteration', () => {
    expect(
      validatePaginationHint({ endOfIteration: { kind: 'last', path: 'x' } }, 'x-pagination', 'op'),
    ).toBeUndefined();
    expect(validatePaginationHint({ endOfIteration: { kind: 'hasMore' } }, 'x-pagination', 'op')).toBeUndefined();
    expect(validatePaginationHint({ endOfIteration: 'has_more' }, 'x-pagination', 'op')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
