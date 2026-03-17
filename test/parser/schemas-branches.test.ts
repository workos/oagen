import { describe, it, expect } from 'vitest';
import { extractSchemas, extractInlineModelsFromSchemas } from '../../src/parser/schemas.js';

describe('schemaToTypeRef — uncovered branches', () => {
  it('treats schema with no type but with properties as a model ref', () => {
    // Lines 283-288: schema has properties but no type field
    const { models } = extractSchemas({
      Container: {
        type: 'object',
        properties: {
          metadata: {
            // No type, but has properties
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
      },
    });

    // The metadata field should be treated as a model ref
    const container = models.find((m) => m.name === 'Container');
    expect(container).toBeDefined();
    const metadataField = container!.fields.find((f) => f.name === 'metadata');
    expect(metadataField).toBeDefined();
    expect(metadataField!.type.kind).toBe('model');
  });
});

describe('schemaToTypeRef — multi-type and literal branches', () => {
  it('creates a union from multiple non-null types (type: [string, integer])', () => {
    // Lines 168-175: multiple non-null types in array → union
    const { models } = extractSchemas({
      Flexible: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          mixed_value: { type: ['string', 'integer'] },
        },
      },
    });

    const model = models.find((m) => m.name === 'Flexible');
    expect(model).toBeDefined();
    const field = model!.fields.find((f) => f.name === 'mixed_value');
    expect(field).toBeDefined();
    expect(field!.type.kind).toBe('union');
  });

  it('creates nullable union when type array includes null', () => {
    // Lines 171-173: multi-type array with null → nullable(union)
    const { models } = extractSchemas({
      NullableUnion: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          value: { type: ['string', 'integer', 'null'] },
        },
      },
    });

    const model = models.find((m) => m.name === 'NullableUnion');
    expect(model).toBeDefined();
    const field = model!.fields.find((f) => f.name === 'value');
    expect(field).toBeDefined();
    expect(field!.type.kind).toBe('nullable');
    if (field!.type.kind === 'nullable') {
      expect(field!.type.inner.kind).toBe('union');
    }
  });

  it('treats single-value enum as literal type', () => {
    // Lines 208-210: enum with exactly one value → literal
    const { models } = extractSchemas({
      SingleEnum: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['only_value'] },
        },
      },
    });

    const model = models.find((m) => m.name === 'SingleEnum');
    expect(model).toBeDefined();
    const field = model!.fields.find((f) => f.name === 'kind');
    expect(field).toBeDefined();
    expect(field!.type.kind).toBe('literal');
    if (field!.type.kind === 'literal') {
      expect(field!.type.value).toBe('only_value');
    }
  });

  it('handles patternProperties for map value type', () => {
    // Lines 252-258: patternProperties → use first pattern's schema
    const { models } = extractSchemas({
      Config: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          metadata: {
            type: 'object',
            patternProperties: {
              '^x-': { type: 'integer' },
            },
          },
        },
      },
    });

    const model = models.find((m) => m.name === 'Config');
    expect(model).toBeDefined();
    const field = model!.fields.find((f) => f.name === 'metadata');
    expect(field).toBeDefined();
    expect(field!.type.kind).toBe('map');
    if (field!.type.kind === 'map') {
      expect(field!.type.valueType).toEqual({ kind: 'primitive', type: 'integer' });
    }
  });
});

describe('extractInlineModelsFromSchemas — uncovered branches', () => {
  it('extracts inline models from arrays of inline objects', () => {
    // Lines 343-350: array field whose items is an inline object with properties
    const models = extractInlineModelsFromSchemas({
      Order: {
        type: 'object',
        properties: {
          line_items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string' },
                quantity: { type: 'integer' },
              },
              required: ['product_id'],
            },
          },
        },
      },
    });

    const lineItemModel = models.find((m) => m.name === 'OrderLineItem');
    expect(lineItemModel).toBeDefined();
    expect(lineItemModel!.fields.map((f) => f.name)).toContain('product_id');
    expect(lineItemModel!.fields.map((f) => f.name)).toContain('quantity');
    // product_id should be required
    const productField = lineItemModel!.fields.find((f) => f.name === 'product_id');
    expect(productField!.required).toBe(true);
  });

  it('extracts nested inline models recursively', () => {
    const models = extractInlineModelsFromSchemas({
      Parent: {
        type: 'object',
        properties: {
          child: {
            type: 'object',
            properties: {
              grandchild: {
                type: 'object',
                properties: {
                  value: { type: 'string' },
                },
              },
            },
          },
        },
      },
    });

    // Should extract both ParentChild and ParentChildGrandchild
    const childModel = models.find((m) => m.name === 'ParentChild');
    const grandchildModel = models.find((m) => m.name === 'ParentChildGrandchild');
    expect(childModel).toBeDefined();
    expect(grandchildModel).toBeDefined();
  });
});
