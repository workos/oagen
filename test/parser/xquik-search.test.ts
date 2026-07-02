import { describe, it, expect } from 'vitest';
import { extractOperations } from '../../src/parser/operations.js';

describe('Xquik search operation extraction', () => {
  it('preserves search query parameters, cursor paging, and operation security', () => {
    const paths = {
      '/api/v1/x/tweets/search': {
        get: {
          operationId: 'searchTweets',
          tags: ['x'],
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
          security: [{ apiKey: [] }],
          responses: {
            '200': {
              description: 'Search results',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tweets: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Tweet' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const { services } = extractOperations(paths as never);
    expect(services).toHaveLength(1);

    const [service] = services;
    expect(service.name).toBe('X');
    expect(service.operations).toHaveLength(1);

    const [operation] = service.operations;
    expect(operation.name).toBe('searchTweets');
    expect(operation.httpMethod).toBe('get');
    expect(operation.path).toBe('/api/v1/x/tweets/search');
    expect(operation.queryParams.map((param) => param.name)).toEqual(['q', 'cursor', 'limit']);
    expect(operation.queryParams[0].required).toBe(true);
    expect(operation.pagination).toMatchObject({ strategy: 'cursor', param: 'cursor' });
    expect(operation.security).toEqual([{ schemeName: 'apiKey', scopes: [] }]);
  });
});
