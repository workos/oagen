import { describe, it, expect } from 'vitest';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';

describe('generalized response classification', () => {
  describe('list envelope detection without list_metadata', () => {
    it('detects results array with meta companion as list envelope', () => {
      const schema = {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: { $ref: '#/components/schemas/Repo' },
          },
          meta: {
            type: 'object',
            properties: {
              next_cursor: { type: 'string' },
              total: { type: 'integer' },
            },
          },
        },
      };

      const result = classifyAndExtractResponse(schema, 'ListReposResponse');
      expect(result.isPaginated).toBe(true);
      expect(result.dataPath).toBe('results');
      expect(result.response).toEqual({
        kind: 'array',
        items: { kind: 'model', name: 'Repo' },
      });
    });

    it('detects items array with pagination companion as list envelope', () => {
      const schema = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/Issue' },
          },
          pagination: {
            type: 'object',
            properties: {
              page: { type: 'integer' },
              total_pages: { type: 'integer' },
            },
          },
        },
      };

      const result = classifyAndExtractResponse(schema, 'ListIssuesResponse');
      expect(result.isPaginated).toBe(true);
      expect(result.dataPath).toBe('items');
    });

    it('detects allOf with non-list_metadata envelope', () => {
      const schema = {
        allOf: [
          {
            type: 'object',
            properties: {
              pagination: {
                type: 'object',
                properties: { next: { type: 'string' } },
              },
            },
          },
          {
            type: 'object',
            properties: {
              records: {
                type: 'array',
                items: { $ref: '#/components/schemas/Event' },
              },
            },
          },
        ],
      };

      const result = classifyAndExtractResponse(schema, 'ListEventsResponse');
      expect(result.isPaginated).toBe(true);
      expect(result.dataPath).toBe('records');
    });

    it('still detects WorkOS-style list_metadata envelope', () => {
      const schema = {
        allOf: [
          {
            type: 'object',
            properties: {
              list_metadata: { $ref: '#/components/schemas/ListMetadata' },
            },
          },
          {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: { $ref: '#/components/schemas/User' },
              },
            },
          },
        ],
      };

      const result = classifyAndExtractResponse(schema, 'ListUsersResponse');
      expect(result.isPaginated).toBe(true);
      expect(result.dataPath).toBe('data');
    });

    it('does not classify single-array-property without companion as envelope', () => {
      const schema = {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      };

      const result = classifyAndExtractResponse(schema, 'SomeResponse');
      // Single array property with no companion → NOT a list envelope
      expect(result.isPaginated).toBe(false);
    });

    it('does not classify single-resource with nested array as list envelope', () => {
      const schema = {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          name: { type: 'string' },
          permissions: {
            type: 'array',
            items: { $ref: '#/components/schemas/Permission' },
          },
        },
        required: ['slug', 'name', 'permissions'],
      };

      const result = classifyAndExtractResponse(schema, 'GetRoleResponse');
      // permissions is not a known data path and slug/name are not pagination metadata
      expect(result.isPaginated).toBe(false);
    });
  });

  describe('deriveModelName with non-object const fields', () => {
    it('derives model name from type const field', () => {
      const schema = {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'repository' },
          id: { type: 'integer' },
          name: { type: 'string' },
        },
        required: ['type', 'id'],
      };

      const result = classifyAndExtractResponse(schema, 'GetRepoResponse');
      expect(result.response).toEqual({ kind: 'model', name: 'Repository' });
    });

    it('prefers object const over other const fields', () => {
      const schema = {
        type: 'object',
        properties: {
          kind: { type: 'string', const: 'special_kind' },
          object: { type: 'string', const: 'widget' },
          id: { type: 'string' },
        },
      };

      const result = classifyAndExtractResponse(schema, 'GetWidgetResponse');
      expect(result.response).toEqual({ kind: 'model', name: 'Widget' });
    });

    it('falls back to contextName when no const field', () => {
      const schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      };

      const result = classifyAndExtractResponse(schema, 'GetThingResponse');
      expect(result.response).toEqual({ kind: 'model', name: 'GetThingResponse' });
    });
  });
});
