import { describe, it, expect, vi } from 'vitest';
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

    const lineItemModel = models.find((m) => m.name === 'LineItems');
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

    // Should extract both Child and Grandchild
    const childModel = models.find((m) => m.name === 'Child');
    const grandchildModel = models.find((m) => m.name === 'Grandchild');
    expect(childModel).toBeDefined();
    expect(grandchildModel).toBeDefined();
  });
});
