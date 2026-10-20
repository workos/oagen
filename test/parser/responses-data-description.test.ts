import { describe, it, expect } from 'vitest';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

/**
 * Covers `dataDescription` on the list-envelope path of `classifyAndExtractResponse`:
 * the data array property's own description must reach the IR beside `dataPath`,
 * exactly as every companion's does through `envelopeFields` (#207).
 */
describe('classifyAndExtractResponse — list envelope data description', () => {
  it('keeps the data array property description next to dataPath (#207 repro)', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          pets: {
            description: 'The pets on this page, newest first.',
            type: 'array',
            items: { $ref: '#/components/schemas/Pet' },
          },
          pagination: { description: 'Where this page sits in the list.', $ref: '#/components/schemas/Pagination' },
        },
        required: ['pets', 'pagination'],
      },
      'ListPetsResponse',
    );

    expect(result.isPaginated).toBe(true);
    expect(result.dataPath).toBe('pets');
    expect(result.dataDescription).toBe('The pets on this page, newest first.');
    expect(result.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'Pet' } });
    // The companion beside it is untouched.
    expect(result.envelopeFields).toEqual([
      {
        name: 'pagination',
        type: { kind: 'model', name: 'Pagination' },
        required: true,
        description: 'Where this page sits in the list.',
      },
    ]);
  });

  it('leaves dataDescription out when the data property declares none', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
          list_metadata: { $ref: '#/components/schemas/ListMetadata' },
        },
      },
      'ListUsersResponse',
    );

    expect(result.dataPath).toBe('data');
    expect(result).not.toHaveProperty('dataDescription');
  });

  it("takes the property's own text, never the item schema's", () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { type: 'object', description: 'A single user.', properties: { id: { type: 'string' } } },
          },
          has_more: { type: 'boolean' },
        },
      },
      'ListUsersResponse',
    );

    expect(result.dataPath).toBe('data');
    expect(result).not.toHaveProperty('dataDescription');
    // The item's description lives on the lifted item model, as before.
    expect(result.inlineModels.map((m) => [m.name, m.description])).toEqual([['ListUsersItem', 'A single user.']]);
  });

  it('keeps the description when a later allOf branch only constrains the data array', () => {
    const result = classifyAndExtractResponse(
      {
        allOf: [
          {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                description: 'The connections on this page.',
                items: { $ref: '#/components/schemas/Connection' },
              },
            },
          },
          { type: 'object', properties: { data: { type: 'array', minItems: 1 } } },
          { type: 'object', properties: { list_metadata: { $ref: '#/components/schemas/ListMetadata' } } },
        ],
      },
      'ListConnectionsResponse',
    );

    expect(result.dataPath).toBe('data');
    expect(result.dataDescription).toBe('The connections on this page.');
    expect(result.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'Connection' } });
  });

  it('lets a later allOf branch restate the description, as allOf merging does elsewhere', () => {
    const result = classifyAndExtractResponse(
      {
        allOf: [
          {
            type: 'object',
            properties: {
              data: { type: 'array', description: 'Base.', items: { $ref: '#/components/schemas/Connection' } },
            },
          },
          { type: 'object', properties: { data: { type: 'array', description: 'Refined.' } } },
          { type: 'object', properties: { list_metadata: { $ref: '#/components/schemas/ListMetadata' } } },
        ],
      },
      'ListConnectionsResponse',
    );

    expect(result.dataDescription).toBe('Refined.');
    expect(result.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'Connection' } });
  });

  it('takes the description an allOf $ref base declares when the inline branch only supplies items', () => {
    const result = classifyAndExtractResponse(
      {
        allOf: [
          { $ref: '#/components/schemas/ListResponse' },
          {
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/Connection' } },
              list_metadata: { $ref: '#/components/schemas/ListMetadata' },
            },
          },
        ],
      },
      'ListConnectionsResponse',
      {
        ListResponse: {
          type: 'object',
          properties: {
            object: { type: 'string', const: 'list' },
            data: { type: 'array', description: 'The records for the current page.' },
          },
          required: ['data'],
        },
      },
    );

    expect(result.dataPath).toBe('data');
    expect(result.dataDescription).toBe('The records for the current page.');
    expect(result.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'Connection' } });
    expect(result.envelopeFields?.map((f) => f.name)).toEqual(['object', 'list_metadata']);
  });

  it('sets nothing for a response that is not a list envelope', () => {
    const cases: Array<[string, SchemaObject]> = [
      ['$ref', { $ref: '#/components/schemas/UserList' }],
      ['bare array', { type: 'array', description: 'All users.', items: { $ref: '#/components/schemas/User' } }],
      ['object', { type: 'object', properties: { id: { type: 'string' } } }],
    ];
    for (const [label, schema] of cases) {
      const result = classifyAndExtractResponse(schema, 'GetUsersResponse');
      expect(result.dataPath, label).toBeUndefined();
      expect(result, label).not.toHaveProperty('dataDescription');
    }
  });
});
