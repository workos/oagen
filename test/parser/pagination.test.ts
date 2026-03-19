import { describe, it, expect } from 'vitest';
import { detectPagination } from '../../src/parser/pagination.js';
import type { TypeRef, Parameter } from '../../src/ir/types.js';

describe('detectPagination', () => {
  const makeParam = (name: string): Parameter => ({
    name,
    type: { kind: 'primitive', type: 'string' },
    required: false,
  });

  it('returns true when cursor param present', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [makeParam('cursor')])).not.toBeNull();
  });

  it('returns true when after param present', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [makeParam('after')])).not.toBeNull();
  });

  it('returns true when before param present', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [makeParam('before')])).not.toBeNull();
  });

  it('returns true when starting_after param present', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [makeParam('starting_after')])).not.toBeNull();
  });

  it('returns false when no cursor param', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [makeParam('limit')])).toBeNull();
  });

  it('returns false with empty params', () => {
    const response: TypeRef = { kind: 'primitive', type: 'string' };
    expect(detectPagination(response, [])).toBeNull();
  });

  it('returns structured PaginationMeta with strategy, param, dataPath, and itemType', () => {
    const result = detectPagination({ kind: 'array', items: { kind: 'model', name: 'User' } }, [
      { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
    ]);
    expect(result).toEqual({
      strategy: 'cursor',
      param: 'after',
      dataPath: 'data',
      itemType: { kind: 'model', name: 'User' },
    });
  });

  it('detects offset-based pagination with strategy and limitParam', () => {
    const result = detectPagination(
      { kind: 'array', items: { kind: 'model', name: 'Item' } },
      [makeParam('offset'), makeParam('limit')],
    );
    expect(result).toEqual({
      strategy: 'offset',
      param: 'offset',
      limitParam: 'limit',
      dataPath: 'data',
      itemType: { kind: 'model', name: 'Item' },
    });
  });

  it('accepts custom dataPath from caller', () => {
    const result = detectPagination(
      { kind: 'array', items: { kind: 'model', name: 'Repo' } },
      [makeParam('after')],
      'results',
    );
    expect(result).toEqual({
      strategy: 'cursor',
      param: 'after',
      dataPath: 'results',
      itemType: { kind: 'model', name: 'Repo' },
    });
  });

  it('offset pagination uses custom dataPath', () => {
    const result = detectPagination(
      { kind: 'array', items: { kind: 'model', name: 'Item' } },
      [makeParam('page'), makeParam('per_page')],
      'items',
    );
    expect(result).toEqual({
      strategy: 'offset',
      param: 'page',
      limitParam: 'per_page',
      dataPath: 'items',
      itemType: { kind: 'model', name: 'Item' },
    });
  });
});
