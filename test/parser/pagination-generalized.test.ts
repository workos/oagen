import { describe, it, expect } from 'vitest';
import { detectPagination } from '../../src/parser/pagination.js';
import type { TypeRef, Parameter } from '../../src/ir/types.js';

describe('generalized pagination detection', () => {
  const makeParam = (name: string): Parameter => ({
    name,
    type: { kind: 'primitive', type: 'string' },
    required: false,
  });

  const arrayResponse: TypeRef = { kind: 'array', items: { kind: 'model', name: 'Item' } };

  describe('offset strategy', () => {
    it('returns offset strategy with limitParam', () => {
      const result = detectPagination(arrayResponse, [makeParam('offset'), makeParam('limit')]);
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('offset');
      expect(result!.param).toBe('offset');
      expect(result!.limitParam).toBe('limit');
    });

    it('detects page + per_page as offset pagination', () => {
      const result = detectPagination(arrayResponse, [makeParam('page'), makeParam('per_page')]);
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('offset');
      expect(result!.param).toBe('page');
      expect(result!.limitParam).toBe('per_page');
    });

    it('detects skip + count as offset pagination', () => {
      const result = detectPagination(arrayResponse, [makeParam('skip'), makeParam('count')]);
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('offset');
      expect(result!.param).toBe('skip');
      expect(result!.limitParam).toBe('count');
    });
  });

  describe('cursor strategy', () => {
    it('returns cursor strategy for page_token', () => {
      const result = detectPagination(arrayResponse, [makeParam('page_token')]);
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('cursor');
      expect(result!.param).toBe('page_token');
      expect(result!.limitParam).toBeUndefined();
    });

    it('returns cursor strategy for next_token', () => {
      const result = detectPagination(arrayResponse, [makeParam('next_token')]);
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('cursor');
      expect(result!.param).toBe('next_token');
    });

    it('prefers cursor over offset when both present', () => {
      const result = detectPagination(arrayResponse, [makeParam('after'), makeParam('offset'), makeParam('limit')]);
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('cursor');
      expect(result!.param).toBe('after');
    });
  });

  describe('non-data dataPath', () => {
    it('uses provided dataPath for cursor pagination', () => {
      const result = detectPagination(arrayResponse, [makeParam('cursor')], 'results');
      expect(result).not.toBeNull();
      expect(result!.dataPath).toBe('results');
    });

    it('uses provided dataPath for offset pagination', () => {
      const result = detectPagination(arrayResponse, [makeParam('page'), makeParam('page_size')], 'items');
      expect(result).not.toBeNull();
      expect(result!.dataPath).toBe('items');
    });

    it('defaults to data when no dataPath provided', () => {
      const result = detectPagination(arrayResponse, [makeParam('after')]);
      expect(result).not.toBeNull();
      expect(result!.dataPath).toBe('data');
    });
  });
});
