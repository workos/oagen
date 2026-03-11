import { describe, it, expect } from 'vitest';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';

describe('classifyAndExtractResponse', () => {
  describe('$ref schemas', () => {
    it('resolves $ref to named model', () => {
      const result = classifyAndExtractResponse({ $ref: '#/components/schemas/UserDto' }, 'GetUserResponse');
      expect(result.response).toEqual({ kind: 'model', name: 'User' });
      expect(result.inlineModels).toEqual([]);
      expect(result.isPaginated).toBe(false);
    });
  });

  describe('list envelopes', () => {
    it('extracts list with $ref items', () => {
      const schema = {
        allOf: [
          {
            type: 'object',
            properties: {
              object: { type: 'string', const: 'list' },
              list_metadata: { $ref: '#/components/schemas/ListMetadata' },
            },
          },
          {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: { $ref: '#/components/schemas/Organization' },
              },
            },
          },
        ],
      };

      const result = classifyAndExtractResponse(schema, 'ListOrganizationsResponse');
      expect(result.response).toEqual({
        kind: 'array',
        items: { kind: 'model', name: 'Organization' },
      });
      expect(result.inlineModels).toEqual([]);
      expect(result.isPaginated).toBe(true);
    });

    it('extracts list with inline items and creates inline model', () => {
      const schema = {
        allOf: [
          {
            type: 'object',
            properties: {
              object: { type: 'string', const: 'list' },
              list_metadata: { type: 'object', properties: { next: { type: 'string' } } },
            },
          },
          {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                  },
                  required: ['id'],
                },
              },
            },
          },
        ],
      };

      const result = classifyAndExtractResponse(schema, 'ListEventsResponse');
      expect(result.response).toEqual({
        kind: 'array',
        items: { kind: 'model', name: 'ListEventsItem' },
      });
      expect(result.inlineModels).toHaveLength(1);
      expect(result.inlineModels[0].name).toBe('ListEventsItem');
      expect(result.inlineModels[0].fields).toHaveLength(2);
      expect(result.inlineModels[0].fields[0].name).toBe('id');
      expect(result.inlineModels[0].fields[0].required).toBe(true);
      expect(result.isPaginated).toBe(true);
    });

    it('falls through when allOf has no data array', () => {
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
              name: { type: 'string' },
            },
          },
        ],
      };

      const result = classifyAndExtractResponse(schema, 'SomeResponse');
      // Not a valid list envelope — should fall through to direct resource
      expect(result.isPaginated).toBe(false);
    });
  });

  describe('single-resource wrappers', () => {
    it('unwraps a single-resource wrapper', () => {
      const schema = {
        type: 'object',
        properties: {
          api_key: {
            type: 'object',
            properties: {
              object: { type: 'string', const: 'api_key' },
              id: { type: 'string' },
              name: { type: 'string' },
            },
            required: ['object', 'id'],
          },
        },
        required: ['api_key'],
      };

      const result = classifyAndExtractResponse(schema, 'CreateApiKeyResponse');
      expect(result.response).toEqual({ kind: 'model', name: 'ApiKey' });
      expect(result.inlineModels).toHaveLength(1);
      expect(result.inlineModels[0].name).toBe('ApiKey');
      expect(result.inlineModels[0].fields).toHaveLength(3);
      expect(result.isPaginated).toBe(false);
    });

    it('unwraps nullable wrapper (oneOf with object + null)', () => {
      const schema = {
        type: 'object',
        properties: {
          api_key: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  object: { type: 'string', const: 'api_key' },
                  id: { type: 'string' },
                },
                required: ['object', 'id'],
              },
              { type: 'null' },
            ],
          },
        },
        required: ['api_key'],
      };

      const result = classifyAndExtractResponse(schema, 'ValidateApiKeyResponse');
      expect(result.response).toEqual({
        kind: 'nullable',
        inner: { kind: 'model', name: 'ApiKey' },
      });
      expect(result.inlineModels).toHaveLength(1);
      expect(result.inlineModels[0].name).toBe('ApiKey');
      expect(result.isPaginated).toBe(false);
    });

    it('does not match wrapper with multiple required properties', () => {
      const schema = {
        type: 'object',
        properties: {
          api_key: {
            type: 'object',
            properties: {
              object: { type: 'string', const: 'api_key' },
              id: { type: 'string' },
            },
          },
          metadata: { type: 'object', properties: {} },
        },
        required: ['api_key', 'metadata'],
      };

      const result = classifyAndExtractResponse(schema, 'SomeResponse');
      // Not a single-resource wrapper — treated as direct resource
      expect(result.response).toEqual({ kind: 'model', name: 'SomeResponse' });
    });
  });

  describe('direct resource objects', () => {
    it('creates named model from inline object schema', () => {
      const schema = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          active: { type: 'boolean' },
        },
        required: ['id', 'name'],
      };

      const result = classifyAndExtractResponse(schema, 'GetWidgetResponse');
      expect(result.response).toEqual({ kind: 'model', name: 'GetWidgetResponse' });
      expect(result.inlineModels).toHaveLength(1);
      expect(result.inlineModels[0].name).toBe('GetWidgetResponse');
      expect(result.inlineModels[0].fields).toHaveLength(3);
      expect(result.inlineModels[0].fields[0].required).toBe(true);
      expect(result.inlineModels[0].fields[2].required).toBe(false);
      expect(result.isPaginated).toBe(false);
    });

    it('derives model name from object const field', () => {
      const schema = {
        type: 'object',
        properties: {
          object: { type: 'string', const: 'organization' },
          id: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['object', 'id'],
      };

      const result = classifyAndExtractResponse(schema, 'GetOrgResponse');
      expect(result.response).toEqual({ kind: 'model', name: 'Organization' });
      expect(result.inlineModels[0].name).toBe('Organization');
    });

    it('handles non-object schema (primitive)', () => {
      const schema = { type: 'string' };

      const result = classifyAndExtractResponse(schema, 'SomeResponse');
      expect(result.response).toEqual({ kind: 'primitive', type: 'string' });
      expect(result.inlineModels).toEqual([]);
      expect(result.isPaginated).toBe(false);
    });

    it('handles no-content response (empty schema)', () => {
      const schema = {};

      const result = classifyAndExtractResponse(schema, 'DeleteResponse');
      expect(result.inlineModels).toEqual([]);
      expect(result.isPaginated).toBe(false);
    });
  });
});
