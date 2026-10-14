import { describe, it, expect } from 'vitest';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';

/**
 * Covers `envelopeFields` on the list-envelope path of `classifyAndExtractResponse`:
 * everything a list response carries besides the data array must survive into
 * the IR so an emitter can type the envelope and read its page details (#183).
 */
describe('classifyAndExtractResponse — list envelope companion fields', () => {
  it('keeps a $ref companion as a model-typed field next to dataPath', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          customers: { type: 'array', items: { $ref: '#/components/schemas/Customer' } },
          pagination: { $ref: '#/components/schemas/Pagination' },
        },
        required: ['customers', 'pagination'],
      },
      'GetCustomersResponse',
    );

    expect(result.isPaginated).toBe(true);
    expect(result.dataPath).toBe('customers');
    expect(result.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'Customer' } });
    expect(result.envelopeFields).toEqual([
      { name: 'pagination', type: { kind: 'model', name: 'Pagination' }, required: true },
    ]);
    // A $ref companion needs no inline model.
    expect(result.inlineModels).toEqual([]);
  });

  it('lifts an inline companion object to a model named from the property alone', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
          list_metadata: {
            type: 'object',
            description: 'Cursors.',
            properties: {
              before: { type: ['string', 'null'] },
              after: { type: ['string', 'null'] },
            },
          },
        },
      },
      'ListUsersResponse',
    );

    expect(result.envelopeFields).toMatchObject([
      {
        name: 'list_metadata',
        type: { kind: 'model', name: 'ListMetadata' },
        required: false,
        description: 'Cursors.',
      },
    ]);
    // Not `ListUsersListMetadata`: the shape recurs on every list endpoint and
    // must collapse onto one model.
    expect(result.inlineModels.map((m) => m.name)).toEqual(['ListMetadata']);
    expect(result.inlineModels[0].fields.map((f) => f.name)).toEqual(['before', 'after']);
  });

  it('extracts objects nested inside an inline companion with the companion as parent', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Issue' } },
          pagination: {
            type: 'object',
            properties: {
              page: { type: 'integer' },
              links: { type: 'object', properties: { next: { type: 'string' } } },
            },
          },
        },
      },
      'ListIssuesResponse',
    );

    expect(result.inlineModels.map((m) => m.name)).toEqual(['Pagination', 'PaginationLink']);
    const pagination = result.inlineModels[0];
    expect(pagination.fields.find((f) => f.name === 'links')?.type).toEqual({ kind: 'model', name: 'PaginationLink' });
  });

  it('keeps every companion of a flat envelope, scalars and inline enums alike', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
          total: { type: 'integer', description: 'Total matches.' },
          has_more: { type: 'boolean' },
          sort: { type: 'string', enum: ['asc', 'desc'] },
        },
        required: ['items', 'total'],
      },
      'ListItemsResponse',
    );

    expect(result.envelopeFields).toEqual([
      { name: 'total', type: { kind: 'primitive', type: 'integer' }, required: true, description: 'Total matches.' },
      { name: 'has_more', type: { kind: 'primitive', type: 'boolean' }, required: false },
      { name: 'sort', type: { kind: 'enum', name: 'Sort', values: ['asc', 'desc'] }, required: false },
    ]);
  });

  it('never lists the data array among the companions', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          results: { type: 'array', items: { $ref: '#/components/schemas/Repo' } },
          meta: { type: 'object', properties: { next_cursor: { type: 'string' } } },
        },
      },
      'ListReposResponse',
    );

    expect(result.envelopeFields?.map((f) => f.name)).toEqual(['meta']);
  });

  it('merges companions and required lists across allOf branches', () => {
    const result = classifyAndExtractResponse(
      {
        allOf: [
          {
            type: 'object',
            properties: {
              object: { type: 'string', const: 'list', description: 'Indicates this is a list response.' },
              list_metadata: { $ref: '#/components/schemas/ListMetadata' },
            },
          },
          {
            type: 'object',
            properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Connection' } } },
            required: ['data', 'list_metadata'],
          },
        ],
      },
      'ListConnectionsResponse',
    );

    expect(result.dataPath).toBe('data');
    expect(result.envelopeFields).toEqual([
      {
        name: 'object',
        type: { kind: 'literal', value: 'list' },
        required: false,
        description: 'Indicates this is a list response.',
      },
      { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
    ]);
  });

  it('keeps inline list items and companions side by side', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
          page_info: { type: 'object', properties: { end_cursor: { type: 'string' } } },
        },
      },
      'ListNodesResponse',
    );

    expect(result.itemType).toEqual({ kind: 'model', name: 'ListNodesItem' });
    expect(result.envelopeFields).toEqual([
      { name: 'page_info', type: { kind: 'model', name: 'PageInfo' }, required: false },
    ]);
    expect(result.inlineModels.map((m) => m.name)).toEqual(['ListNodesItem', 'PageInfo']);
  });

  it('leaves envelopeFields unset when the response is not a list envelope', () => {
    const direct = classifyAndExtractResponse(
      { type: 'object', properties: { object: { type: 'string', const: 'user' }, id: { type: 'string' } } },
      'GetUserResponse',
    );
    expect(direct.isPaginated).toBe(false);
    expect(direct.envelopeFields).toBeUndefined();

    const ref = classifyAndExtractResponse({ $ref: '#/components/schemas/UserList' }, 'ListUsersResponse');
    expect(ref.envelopeFields).toBeUndefined();

    const bareArray = classifyAndExtractResponse(
      { type: 'array', items: { $ref: '#/components/schemas/User' } },
      'ListUsersResponse',
    );
    expect(bareArray.envelopeFields).toBeUndefined();
  });
});
