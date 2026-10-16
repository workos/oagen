import { describe, it, expect, vi } from 'vitest';
import { extractOperations } from '../../src/parser/operations.js';
import { collectInlineEnumsFromOperations } from '../../src/parser/collect-inline-enums.js';
import type { Enum } from '../../src/ir/types.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

describe('extractOperations', () => {
  it('groups operations by first path segment', () => {
    const paths = {
      '/users': {
        get: {
          operationId: 'listUsers',
          responses: { '200': { description: 'ok' } },
        },
      },
      '/organizations': {
        get: {
          operationId: 'listOrgs',
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services).toHaveLength(2);
    const names = services.map((s) => s.name).sort();
    expect(names).toEqual(['Organizations', 'Users']);
  });

  it('infers list for GET /resources', () => {
    const paths = {
      '/users': {
        get: {
          operationId: 'listUsers',
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].name).toBe('listUsers');
    expect(services[0].operations[0].httpMethod).toBe('get');
  });

  it('infers retrieve for GET /resources/{id}', () => {
    const paths = {
      '/users/{user_id}': {
        get: {
          operationId: 'getUser',
          parameters: [{ name: 'user_id', in: 'path' as const, required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].name).toBe('getUser');
    expect(services[0].operations[0].pathParams).toHaveLength(1);
    expect(services[0].operations[0].pathParams[0].name).toBe('user_id');
  });

  it('infers create for POST', () => {
    const paths = {
      '/users': {
        post: {
          operationId: 'createUser',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { name: { type: 'string' } } },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].name).toBe('createUser');
    // POST without Idempotency-Key header param → spec-driven default is false
    expect(services[0].operations[0].injectIdempotencyKey).toBe(false);
    expect(services[0].operations[0].requestBody).toBeDefined();
  });

  it('infers update for PUT', () => {
    const paths = {
      '/users/{id}': {
        put: {
          operationId: 'updateUser',
          parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].name).toBe('updateUser');
  });

  it('infers delete for DELETE', () => {
    const paths = {
      '/users/{id}': {
        delete: {
          operationId: 'deleteUser',
          parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } }],
          responses: { '204': { description: 'deleted' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].name).toBe('deleteUser');
  });

  it('extracts error responses', () => {
    const paths = {
      '/users': {
        post: {
          operationId: 'createUser',
          responses: {
            '201': { description: 'created' },
            '400': {
              description: 'bad request',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { message: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].errors).toHaveLength(1);
    expect(services[0].operations[0].errors[0].statusCode).toBe(400);
  });

  it('detects pagination when cursor param present', () => {
    const paths = {
      '/users': {
        get: {
          operationId: 'listUsers',
          parameters: [{ name: 'cursor', in: 'query' as const, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].pagination).toBeDefined();
  });

  it('returns empty for undefined paths', () => {
    const { services, inlineModels } = extractOperations(undefined);
    expect(services).toEqual([]);
    expect(inlineModels).toEqual([]);
  });

  it('uses operationId for inline response type name', () => {
    const paths = {
      '/api_keys/validate': {
        post: {
          operationId: 'ApiKeysController_validateApiKey',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { valid: { type: 'boolean' } } },
                },
              },
            },
          },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.response).toEqual({
      kind: 'model',
      name: 'ApiKeysValidateApiKeyResponse',
    });
  });

  it('falls back to path-based response name without operationId', () => {
    const paths = {
      '/widgets': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } },
                },
              },
            },
          },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.response).toEqual({
      kind: 'model',
      name: 'WidgetsGetResponse',
    });
  });

  it('resolves $ref response to named model', () => {
    const paths = {
      '/users/{id}': {
        get: {
          operationId: 'getUser',
          parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/UserDto' },
                },
              },
            },
          },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.response).toEqual({ kind: 'model', name: 'UserDto' });
  });

  it('uses operationId for inline request body name', () => {
    const paths = {
      '/users': {
        post: {
          operationId: 'createUser',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { name: { type: 'string' } } },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.requestBody).toEqual({ kind: 'model', name: 'CreateUserRequest' });
  });

  it('strips overload index `[N]` from operationId in derived names', () => {
    // NestJS emits operationIds like `Foo_bar[0]` for controller methods that
    // handle multiple routes. Without normalization the trailing digit leaks
    // into derived names: the operation method becomes `bar0`, the inline
    // request body becomes `Bar0Request`, and a oneOf variant becomes
    // `XBar0Request` — breaking name-based config references downstream.
    const paths = {
      '/things/authenticate': {
        post: {
          operationId: 'ThingsController_authenticate[0]',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { email: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
                },
              },
            },
          },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    // The operation name is camelCased without the `[0]` suffix.
    expect(op.name).toBe('thingsControllerAuthenticate');
    // cleanSchemaName strips `Controller` (anywhere) and singularizes the
    // leading word, giving `ThingAuthenticate*` — but critically with no `0`.
    expect(op.requestBody).toEqual({ kind: 'model', name: 'ThingAuthenticateRequest' });
    expect(op.response).toEqual({ kind: 'model', name: 'ThingAuthenticateResponse' });
  });

  it('applies operationIdTransform after stripping overload index', () => {
    // The transform should receive the normalized id (without `[0]`) so its
    // own logic doesn't have to know about NestJS overload markers.
    const paths = {
      '/things/authenticate': {
        post: {
          operationId: 'ThingsController_authenticate[0]',
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const seen: string[] = [];
    const transform = (id: string): string => {
      seen.push(id);
      return id.split('_').pop()!;
    };
    const { services } = extractOperations(paths, transform);
    expect(seen).toEqual(['ThingsController_authenticate']);
    expect(services[0].operations[0].name).toBe('authenticate');
  });

  it('resolves $ref request body to named model', () => {
    const paths = {
      '/users': {
        post: {
          operationId: 'createUser',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateUserDto' },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.requestBody).toEqual({ kind: 'model', name: 'CreateUserDto' });
  });

  it('sets requestBodyEncoding to form-data for multipart/form-data content type', () => {
    const paths = {
      '/uploads': {
        post: {
          operationId: 'uploadFile',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.requestBodyEncoding).toBe('form-data');
  });

  it('sets requestBodyEncoding to binary for application/octet-stream content type', () => {
    const paths = {
      '/files': {
        post: {
          operationId: 'uploadBinary',
          requestBody: {
            required: true,
            content: {
              'application/octet-stream': {},
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.requestBodyEncoding).toBe('binary');
  });

  it('default behavior camelCases the raw operationId', () => {
    const paths = {
      '/foo': {
        get: {
          operationId: 'FooController_bar',
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].name).toBe('fooControllerBar');
  });

  it('custom operationIdTransform replaces default logic', () => {
    const paths = {
      '/foo': {
        get: {
          operationId: 'FooController_bar',
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths, (id) => id.toLowerCase());
    expect(services[0].operations[0].name).toBe('foocontroller_bar');
  });

  it('identity operationIdTransform passes raw operationId through unchanged', () => {
    const paths = {
      '/foo': {
        get: {
          operationId: 'FooController_bar',
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths, (id) => id);
    expect(services[0].operations[0].name).toBe('FooController_bar');
  });

  it('reads x-oagen-async extension', () => {
    const paths = {
      '/sync': {
        get: {
          operationId: 'syncOp',
          'x-oagen-async': false,
          responses: { '200': { description: 'ok' } },
        } as Record<string, unknown>,
      },
    };

    const { services } = extractOperations(paths as never);
    expect(services[0].operations[0].async).toBe(false);
  });

  it('omits async when extension not present', () => {
    const paths = {
      '/users': {
        get: {
          operationId: 'listUsers',
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].async).toBeUndefined();
  });

  it('uses OpenAPI tag for service name when present', () => {
    const paths = {
      '/auth/factors/enroll': {
        post: {
          operationId: 'enrollFactor',
          tags: ['multi-factor-auth'],
          responses: { '201': { description: 'created' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe('MultiFactorAuth');
  });

  it('groups operations with same tag into one service', () => {
    const paths = {
      '/auth/factors/enroll': {
        post: {
          operationId: 'enrollFactor',
          tags: ['multi-factor-auth'],
          responses: { '201': { description: 'created' } },
        },
      },
      '/auth/factors/{id}/verify': {
        post: {
          operationId: 'verifyFactor',
          tags: ['multi-factor-auth'],
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe('MultiFactorAuth');
    expect(services[0].operations).toHaveLength(2);
  });

  it('hoists default and example from a referenced component schema onto the param', () => {
    const paths = {
      '/organizations': {
        get: {
          operationId: 'listOrganizations',
          parameters: [
            {
              name: 'order',
              in: 'query' as const,
              required: false,
              schema: { $ref: '#/components/schemas/PaginationOrder' },
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentSchemas = {
      PaginationOrder: {
        type: 'string',
        enum: ['desc', 'asc'],
        default: 'desc',
        example: 'desc',
      },
    };

    const { services } = extractOperations(paths, undefined, componentSchemas);
    const orderParam = services[0].operations[0].queryParams[0];
    expect(orderParam.name).toBe('order');
    expect(orderParam.default).toBe('desc');
    expect(orderParam.example).toBe('desc');
  });

  it('prefers param-level default over the referenced schema default', () => {
    const paths = {
      '/organizations': {
        get: {
          operationId: 'listOrganizations',
          parameters: [
            {
              name: 'order',
              in: 'query' as const,
              required: false,
              schema: { $ref: '#/components/schemas/PaginationOrder', default: 'asc' } as never,
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentSchemas = {
      PaginationOrder: { type: 'string', enum: ['desc', 'asc'], default: 'desc' },
    };

    const { services } = extractOperations(paths as never, undefined, componentSchemas);
    expect(services[0].operations[0].queryParams[0].default).toBe('asc');
  });

  it('leaves default undefined when neither param nor referenced schema sets one', () => {
    const paths = {
      '/organizations': {
        get: {
          operationId: 'listOrganizations',
          parameters: [
            {
              name: 'order',
              in: 'query' as const,
              required: false,
              schema: { $ref: '#/components/schemas/PaginationOrder' },
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentSchemas = {
      PaginationOrder: { type: 'string', enum: ['desc', 'asc'] },
    };

    const { services } = extractOperations(paths, undefined, componentSchemas);
    expect(services[0].operations[0].queryParams[0].default).toBeUndefined();
  });

  it('falls back to the inline schema description when the param declares none', () => {
    const paths = {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [
            {
              name: 'petId',
              in: 'path' as const,
              required: true,
              schema: { type: 'string', description: 'The ID of the pet to retrieve' },
            },
          ],
          responses: { '204': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    const petIdParam = services[0].operations[0].pathParams[0];
    expect(petIdParam.name).toBe('petId');
    expect(petIdParam.description).toBe('The ID of the pet to retrieve');
  });

  it('prefers the param-level description over the inline schema description', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            {
              name: 'fields',
              in: 'query' as const,
              required: false,
              description: 'The fields to include in the response',
              schema: { type: 'string', description: 'A comma-separated list of field names' },
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].queryParams[0].description).toBe('The fields to include in the response');
  });

  it('hoists description from a referenced component schema onto the param', () => {
    const paths = {
      '/organizations': {
        get: {
          operationId: 'listOrganizations',
          parameters: [
            {
              name: 'order',
              in: 'query' as const,
              required: false,
              schema: { $ref: '#/components/schemas/PaginationOrder' },
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentSchemas = {
      PaginationOrder: {
        type: 'string',
        enum: ['desc', 'asc'],
        description: 'Sort order for the returned list',
      },
    };

    const { services } = extractOperations(paths, undefined, componentSchemas);
    const orderParam = services[0].operations[0].queryParams[0];
    expect(orderParam.name).toBe('order');
    expect(orderParam.description).toBe('Sort order for the returned list');
  });

  it('falls through an empty param description to the schema description', () => {
    const paths = {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [
            {
              name: 'petId',
              in: 'path' as const,
              required: true,
              description: '',
              schema: { type: 'string', description: 'The ID of the pet to retrieve' },
            },
          ],
          responses: { '204': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].pathParams[0].description).toBe('The ID of the pet to retrieve');
  });

  it('leaves description undefined when every level in the chain is empty', () => {
    const paths = {
      '/organizations': {
        get: {
          operationId: 'listOrganizations',
          parameters: [
            {
              name: 'order',
              in: 'query' as const,
              required: false,
              description: '',
              schema: { $ref: '#/components/schemas/PaginationOrder', description: '' },
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentSchemas = {
      PaginationOrder: { type: 'string', enum: ['desc', 'asc'], description: '' },
    };

    const { services } = extractOperations(paths, undefined, componentSchemas);
    expect(services[0].operations[0].queryParams[0].description).toBeUndefined();
  });

  it('resolves an operation-level parameter $ref into components/parameters', () => {
    const paths = {
      '/domains': {
        get: {
          operationId: 'domains/list',
          parameters: [{ $ref: '#/components/parameters/PaginationLimit' }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentParameters = {
      PaginationLimit: {
        in: 'query',
        name: 'limit',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100 },
        description: 'Number of items to return.',
      },
    };

    const { services } = extractOperations(paths, undefined, undefined, componentParameters);
    const queryParams = services[0].operations[0].queryParams;
    expect(queryParams).toHaveLength(1);
    expect(queryParams[0].name).toBe('limit');
    expect(queryParams[0].description).toBe('Number of items to return.');
  });

  it('resolves a path-level parameter $ref shared across an operation', () => {
    const paths = {
      '/logs': {
        parameters: [
          { $ref: '#/components/parameters/PaginationAfter' },
          { $ref: '#/components/parameters/PaginationBefore' },
        ],
        get: {
          operationId: 'logs/list',
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentParameters = {
      PaginationAfter: { in: 'query', name: 'after', required: false, schema: { type: 'string' } },
      PaginationBefore: { in: 'query', name: 'before', required: false, schema: { type: 'string' } },
    };

    const { services } = extractOperations(paths, undefined, undefined, componentParameters);
    const queryParamNames = services[0].operations[0].queryParams.map((p) => p.name);
    expect(queryParamNames).toEqual(['after', 'before']);
  });

  it('lets an operation-level parameter override a path-level one with the same name and location', () => {
    const paths = {
      '/logs': {
        parameters: [
          { $ref: '#/components/parameters/PaginationLimit' },
          { in: 'query' as const, name: 'order', required: false, schema: { type: 'string' } },
        ],
        get: {
          operationId: 'logs/list',
          parameters: [
            {
              in: 'query' as const,
              name: 'limit',
              required: true,
              schema: { type: 'integer' },
              description: 'Overridden.',
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentParameters = {
      PaginationLimit: { in: 'query', name: 'limit', required: false, schema: { type: 'integer' } },
    };

    const { services } = extractOperations(paths, undefined, undefined, componentParameters);
    const queryParams = services[0].operations[0].queryParams;
    // One `limit`, not two, and the operation-level definition wins.
    expect(queryParams.map((p) => p.name)).toEqual(['limit', 'order']);
    expect(queryParams[0].required).toBe(true);
    expect(queryParams[0].description).toBe('Overridden.');
  });

  it('throws when a parameter $ref cannot be resolved against components/parameters', () => {
    const paths = {
      '/domains': {
        get: {
          operationId: 'domains/list',
          parameters: [{ $ref: '#/components/parameters/Missing' }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    expect(() => extractOperations(paths, undefined, undefined, {})).toThrow(/Missing/);
  });

  it('decodes JSON-Pointer-escaped component names in a parameter $ref', () => {
    const paths = {
      '/domains': {
        get: {
          operationId: 'domains/list',
          parameters: [{ $ref: '#/components/parameters/Pagination~1Limit' }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentParameters = {
      'Pagination/Limit': { in: 'query', name: 'limit', required: false, schema: { type: 'integer' } },
    };

    const { services } = extractOperations(paths, undefined, undefined, componentParameters);
    expect(services[0].operations[0].queryParams[0].name).toBe('limit');
  });

  it('rejects a parameter $ref that points outside components/parameters', () => {
    const paths = {
      '/domains': {
        get: {
          operationId: 'domains/list',
          parameters: [{ $ref: '#/components/schemas/Limit' }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentParameters = {
      Limit: { in: 'query', name: 'limit', required: false, schema: { type: 'integer' } },
    };

    expect(() => extractOperations(paths, undefined, undefined, componentParameters)).toThrow(
      /Unresolved parameter \$ref/,
    );
  });

  it('follows a chained parameter $ref (a component that itself is a $ref)', () => {
    const paths = {
      '/domains': {
        get: {
          operationId: 'domains/list',
          parameters: [{ $ref: '#/components/parameters/LimitAlias' }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentParameters = {
      LimitAlias: { $ref: '#/components/parameters/PaginationLimit' },
      PaginationLimit: { in: 'query', name: 'limit', required: false, schema: { type: 'integer' } },
    };

    const { services } = extractOperations(paths, undefined, undefined, componentParameters);
    expect(services[0].operations[0].queryParams[0].name).toBe('limit');
  });

  it('throws on a circular parameter $ref chain', () => {
    const paths = {
      '/domains': {
        get: {
          operationId: 'domains/list',
          parameters: [{ $ref: '#/components/parameters/A' }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const componentParameters = {
      A: { $ref: '#/components/parameters/B' },
      B: { $ref: '#/components/parameters/A' },
    };

    expect(() => extractOperations(paths, undefined, undefined, componentParameters)).toThrow(/Circular/);
  });

  it('extracts cookie parameters', () => {
    const paths = {
      '/users': {
        get: {
          operationId: 'listUsers',
          parameters: [{ name: 'session', in: 'cookie' as const, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].cookieParams).toHaveLength(1);
    expect(services[0].operations[0].cookieParams![0].name).toBe('session');
  });

  it('sets requestBodyEncoding to form-urlencoded for application/x-www-form-urlencoded', () => {
    const paths = {
      '/token': {
        post: {
          operationId: 'getToken',
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: {
                    grant_type: { type: 'string' },
                    code: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.requestBodyEncoding).toBe('form-urlencoded');
  });

  it('POST with Idempotency-Key header param sets injectIdempotencyKey to true', () => {
    const paths = {
      '/payments': {
        post: {
          operationId: 'createPayment',
          parameters: [{ name: 'Idempotency-Key', in: 'header' as const, required: false, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { amount: { type: 'integer' } } },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.injectIdempotencyKey).toBe(true);
    // Idempotency-Key should be stripped from headerParams
    expect(op.headerParams.some((p) => p.name.toLowerCase() === 'idempotency-key')).toBe(false);
  });

  it('POST without Idempotency-Key header sets injectIdempotencyKey to false', () => {
    const paths = {
      '/payments': {
        post: {
          operationId: 'createPayment',
          responses: { '201': { description: 'created' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].injectIdempotencyKey).toBe(false);
  });

  it('extracts HEAD method operations', () => {
    const paths = {
      '/users/{id}': {
        head: {
          operationId: 'checkUser',
          parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'exists' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].httpMethod).toBe('head');
    expect(services[0].operations[0].name).toBe('checkUser');
  });

  it('extracts OPTIONS method operations', () => {
    const paths = {
      '/cors': {
        options: {
          operationId: 'corsCheck',
          responses: { '204': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].httpMethod).toBe('options');
  });

  it('extracts TRACE method operations', () => {
    const paths = {
      '/debug': {
        trace: {
          operationId: 'debugTrace',
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].httpMethod).toBe('trace');
  });

  it('collects multiple 2xx responses with successResponses', () => {
    const paths = {
      '/resources': {
        post: {
          operationId: 'createResource',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Resource' } } },
            },
            '201': {
              description: 'created',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Resource' } } },
            },
          },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    // Primary response is 200's type (lowest 2xx with body)
    expect(op.response).toEqual({ kind: 'model', name: 'Resource' });
    // Multiple 2xx → successResponses populated
    expect(op.successResponses).toHaveLength(2);
    expect(op.successResponses![0].statusCode).toBe(200);
    expect(op.successResponses![1].statusCode).toBe(201);
  });

  it('omits successResponses for single 2xx response', () => {
    const paths = {
      '/resources/{id}': {
        get: {
          operationId: 'getResource',
          parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Resource' } } },
            },
          },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services[0].operations[0].successResponses).toBeUndefined();
  });

  it('200 + 204 (no content) → primary is 200, successResponses contains both', () => {
    const paths = {
      '/resources': {
        post: {
          operationId: 'createResource',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Resource' } } },
            },
            '204': { description: 'no content' },
          },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.response).toEqual({ kind: 'model', name: 'Resource' });
    expect(op.successResponses).toHaveLength(2);
  });

  it('falls back to path segment when no tag', () => {
    const paths = {
      '/widgets': {
        get: {
          operationId: 'listWidgets',
          responses: { '200': { description: 'ok' } },
        },
      },
      '/widgets/{id}': {
        get: {
          operationId: 'getWidget',
          parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe('Widgets');
    expect(services[0].operations).toHaveLength(2);
  });

  describe('x-mutually-exclusive-parameter-groups', () => {
    it('parses a required group with two variants', () => {
      const paths = {
        '/resources': {
          get: {
            operationId: 'listResources',
            parameters: [
              { name: 'parent_resource_id', in: 'query' as const, required: false, schema: { type: 'string' } },
              { name: 'parent_resource_type_slug', in: 'query' as const, required: false, schema: { type: 'string' } },
              {
                name: 'parent_resource_external_id',
                in: 'query' as const,
                required: false,
                schema: { type: 'string' },
              },
            ],
            responses: { '200': { description: 'ok' } },
            'x-mutually-exclusive-parameter-groups': {
              parent_resource: {
                optional: false,
                variants: {
                  by_id: ['parent_resource_id'],
                  by_external_id: ['parent_resource_type_slug', 'parent_resource_external_id'],
                },
              },
            },
          } as Record<string, unknown>,
        },
      };

      const { services } = extractOperations(paths as never);
      const op = services[0].operations[0];

      expect(op.parameterGroups).toBeDefined();
      expect(op.parameterGroups).toHaveLength(1);

      const group = op.parameterGroups![0];
      expect(group.name).toBe('parent_resource');
      expect(group.optional).toBe(false);
      expect(group.variants).toHaveLength(2);

      expect(group.variants[0].name).toBe('by_id');
      expect(group.variants[0].parameters).toHaveLength(1);
      expect(group.variants[0].parameters[0].name).toBe('parent_resource_id');

      expect(group.variants[1].name).toBe('by_external_id');
      expect(group.variants[1].parameters).toHaveLength(2);
      expect(group.variants[1].parameters[0].name).toBe('parent_resource_type_slug');
      expect(group.variants[1].parameters[1].name).toBe('parent_resource_external_id');

      // Verify object identity: grouped params are the same objects as in queryParams
      expect(group.variants[0].parameters[0]).toBe(op.queryParams.find((p) => p.name === 'parent_resource_id'));
      expect(group.variants[1].parameters[0]).toBe(op.queryParams.find((p) => p.name === 'parent_resource_type_slug'));
    });

    it('parses an optional group', () => {
      const paths = {
        '/resources': {
          get: {
            operationId: 'listResources',
            parameters: [
              { name: 'filter_a', in: 'query' as const, required: false, schema: { type: 'string' } },
              { name: 'filter_b', in: 'query' as const, required: false, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'ok' } },
            'x-mutually-exclusive-parameter-groups': {
              filter: {
                optional: true,
                variants: {
                  by_a: ['filter_a'],
                  by_b: ['filter_b'],
                },
              },
            },
          } as Record<string, unknown>,
        },
      };

      const { services } = extractOperations(paths as never);
      const group = services[0].operations[0].parameterGroups![0];
      expect(group.optional).toBe(true);
    });

    it('omits parameterGroups when extension is absent', () => {
      const paths = {
        '/users': {
          get: {
            operationId: 'listUsers',
            parameters: [{ name: 'status', in: 'query' as const, schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      };

      const { services } = extractOperations(paths);
      expect(services[0].operations[0].parameterGroups).toBeUndefined();
    });

    it('throws on unknown parameter name in variant', () => {
      const paths = {
        '/resources': {
          get: {
            operationId: 'listResources',
            parameters: [{ name: 'real_param', in: 'query' as const, schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
            'x-mutually-exclusive-parameter-groups': {
              group: {
                optional: false,
                variants: {
                  v1: ['real_param'],
                  v2: ['nonexistent_param'],
                },
              },
            },
          } as Record<string, unknown>,
        },
      };

      expect(() => extractOperations(paths as never)).toThrow(/nonexistent_param/);
    });

    it('throws on group with zero variants', () => {
      const paths = {
        '/resources': {
          get: {
            operationId: 'listResources',
            parameters: [],
            responses: { '200': { description: 'ok' } },
            'x-mutually-exclusive-parameter-groups': {
              empty: {
                optional: false,
                variants: {},
              },
            },
          } as Record<string, unknown>,
        },
      };

      expect(() => extractOperations(paths as never)).toThrow(/zero variants/);
    });

    it('throws when optional is not a boolean', () => {
      const paths = {
        '/resources': {
          get: {
            operationId: 'listResources',
            parameters: [{ name: 'a', in: 'query' as const, schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
            'x-mutually-exclusive-parameter-groups': {
              group: {
                optional: 'yes',
                variants: { v1: ['a'] },
              },
            },
          } as Record<string, unknown>,
        },
      };

      expect(() => extractOperations(paths as never)).toThrow(/expected a boolean/);
    });

    it('grouped params remain in queryParams for wire compatibility', () => {
      const paths = {
        '/resources': {
          get: {
            operationId: 'listResources',
            parameters: [
              { name: 'parent_id', in: 'query' as const, required: false, schema: { type: 'string' } },
              { name: 'filter', in: 'query' as const, required: false, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'ok' } },
            'x-mutually-exclusive-parameter-groups': {
              parent: {
                optional: false,
                variants: { by_id: ['parent_id'] },
              },
            },
          } as Record<string, unknown>,
        },
      };

      const { services } = extractOperations(paths as never);
      const op = services[0].operations[0];
      // parent_id should still be in queryParams
      expect(op.queryParams.some((p) => p.name === 'parent_id')).toBe(true);
      // non-grouped params should also remain
      expect(op.queryParams.some((p) => p.name === 'filter')).toBe(true);
    });
  });

  describe('discriminated-union request bodies', () => {
    // Models POST /agents/credentials/validate: a `oneOf` of inline objects
    // pinned by a string-const `type` discriminator (api_key | access_token).
    const validatePaths = {
      '/agents/credentials/validate': {
        post: {
          operationId: 'AgentAdminController_validateCredential',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  discriminator: { propertyName: 'type' },
                  oneOf: [
                    {
                      type: 'object',
                      properties: {
                        type: {
                          type: 'string',
                          const: 'api_key',
                          description: 'The kind of credential being validated.',
                        },
                        credential: { type: 'string', minLength: 1 },
                      },
                      required: ['type', 'credential'],
                    },
                    {
                      type: 'object',
                      properties: {
                        type: { type: 'string', const: 'access_token' },
                        credential: { type: 'string', minLength: 1 },
                        audience: { type: 'string', minLength: 1 },
                      },
                      required: ['type', 'credential'],
                    },
                  ],
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    it('folds an inline-object discriminated union into a spreadable model', () => {
      const { services, inlineModels } = extractOperations(validatePaths as never);
      const op = services[0].operations[0];

      // The body is a model (whose fields spread into method args), not a union.
      expect(op.requestBody?.kind).toBe('model');
      const model = inlineModels.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
      expect(model).toBeDefined();

      const byName = Object.fromEntries(model!.fields.map((f) => [f.name, f]));
      expect(Object.keys(byName).sort()).toEqual(['audience', 'credential', 'type']);

      // The discriminator collapses to an enum of the pinned const values and is
      // always required.
      expect(byName.type.required).toBe(true);
      expect(byName.type.type.kind).toBe('enum');
      if (byName.type.type.kind === 'enum') {
        expect(byName.type.type.values).toEqual(['api_key', 'access_token']);
      }

      // `credential` is required in every variant → required; `audience` is only
      // present on one variant → optional.
      expect(byName.credential.required).toBe(true);
      expect(byName.audience.required).toBe(false);
    });

    it('leaves an undiscriminated oneOf body as a union', () => {
      const paths = {
        '/things': {
          post: {
            operationId: 'ThingController_create',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
                      { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
                    ],
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      };
      const { services } = extractOperations(paths as never);
      // No explicit discriminator → existing union behavior is preserved.
      expect(services[0].operations[0].requestBody?.kind).toBe('union');
    });
  });

  describe('x-mutually-exclusive-body-groups', () => {
    const buildPaths = (extension: Record<string, unknown>) => ({
      '/users': {
        post: {
          operationId: 'createUser',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    {
                      type: 'object',
                      properties: { email: { type: 'string' } },
                      required: ['email'],
                    },
                    {
                      oneOf: [
                        { type: 'object' },
                        {
                          type: 'object',
                          properties: { password: { type: 'string' } },
                          required: ['password'],
                        },
                        {
                          type: 'object',
                          properties: {
                            password_hash: { type: 'string' },
                            password_hash_type: { type: 'string', enum: ['bcrypt', 'ssha256'] },
                            password_salt_position: { type: 'string', enum: ['prefix', 'suffix'] },
                          },
                          required: ['password_hash', 'password_hash_type'],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
          'x-mutually-exclusive-body-groups': extension,
        } as Record<string, unknown>,
      },
    });

    it('parses optionalFields into variant optionalParameters', () => {
      const paths = buildPaths({
        password: {
          optional: true,
          variants: {
            plaintext: ['password'],
            hashed: ['password_hash', 'password_hash_type', 'password_salt_position'],
          },
          optionalFields: {
            hashed: ['password_salt_position'],
          },
        },
      });

      const { services } = extractOperations(paths as never);
      const group = services[0].operations[0].parameterGroups![0];

      const plaintext = group.variants[0];
      expect(plaintext.name).toBe('plaintext');
      expect(plaintext.optionalParameters).toBeUndefined();

      const hashed = group.variants[1];
      expect(hashed.name).toBe('hashed');
      expect(hashed.parameters.map((p) => p.name)).toEqual([
        'password_hash',
        'password_hash_type',
        'password_salt_position',
      ]);
      expect(hashed.optionalParameters).toEqual(['password_salt_position']);
    });

    it('ignores optionalFields entries that are not variant members', () => {
      const paths = buildPaths({
        password: {
          optional: true,
          variants: {
            plaintext: ['password'],
            hashed: ['password_hash', 'password_hash_type'],
          },
          optionalFields: { hashed: ['not_a_member'], plaintext: 'bogus' },
        },
      });

      const { services } = extractOperations(paths as never);
      const group = services[0].operations[0].parameterGroups![0];
      expect(group.variants[0].optionalParameters).toBeUndefined();
      expect(group.variants[1].optionalParameters).toBeUndefined();
    });
  });
});

describe('body-owned query parameters', () => {
  const ok = { '200': { description: 'ok' } };
  const tokenBody = {
    type: 'object',
    properties: {
      client_id: { type: 'string' },
      client_secret: { type: 'string' },
      code: { type: 'string' },
      grant_type: { type: 'string', enum: ['authorization_code'] },
      subject_token: { type: 'string' },
    },
    required: ['client_id', 'client_secret', 'grant_type'],
  };
  const duplicatedQuery = [
    { name: 'client_id', in: 'query' as const, required: true, schema: { type: 'string' } },
    { name: 'client_secret', in: 'query' as const, required: true, schema: { type: 'string' } },
    { name: 'code', in: 'query' as const, required: false, schema: { type: 'string' } },
    {
      name: 'grant_type',
      in: 'query' as const,
      required: true,
      schema: { type: 'string', enum: ['authorization_code'] },
    },
    { name: 'trace', in: 'query' as const, required: false, schema: { type: 'string' } },
  ];

  it('drops query params a POST body also declares, keeping the rest', () => {
    const paths = {
      '/sso/token': {
        post: {
          operationId: 'SsoController_token',
          parameters: duplicatedQuery,
          requestBody: { required: true, content: { 'application/json': { schema: tokenBody } } },
          responses: ok,
        },
      },
    };

    const { services, inlineModels } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.queryParams.map((p) => p.name)).toEqual(['trace']);
    expect(op.bodyOwnedQueryParams?.map((p) => p.name)).toEqual(['client_id', 'client_secret', 'code', 'grant_type']);
    // The body keeps every field, so the SDK signature still exposes `code`.
    expect(op.requestBody).toEqual({ kind: 'model', name: 'SSOTokenRequest' });
    const bodyModel = inlineModels.find((m) => m.name === 'SSOTokenRequest');
    expect(bodyModel?.fields.map((f) => f.name)).toEqual([
      'client_id',
      'client_secret',
      'code',
      'grant_type',
      'subject_token',
    ]);
  });

  it('resolves $ref and allOf bodies when deciding ownership', () => {
    const componentSchemas = {
      TokenBase: { type: 'object', properties: { client_id: { type: 'string' }, client_secret: { type: 'string' } } },
      TokenQueryDto: {
        allOf: [
          { $ref: '#/components/schemas/TokenBase' },
          { type: 'object', properties: { code: { type: 'string' } } },
        ],
      },
    };
    const paths = {
      '/sso/token': {
        post: {
          operationId: 'SsoController_token',
          parameters: duplicatedQuery,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenQueryDto' } } },
          },
          responses: ok,
        },
      },
    };

    const { services } = extractOperations(paths, undefined, componentSchemas);
    const op = services[0].operations[0];
    // grant_type is not a body property here, so it stays a query param.
    expect(op.queryParams.map((p) => p.name)).toEqual(['grant_type', 'trace']);
    expect(op.bodyOwnedQueryParams?.map((p) => p.name)).toEqual(['client_id', 'client_secret', 'code']);
  });

  it('keeps every query param on methods without a body', () => {
    const paths = {
      '/sso/token': {
        get: {
          operationId: 'SsoController_tokenInfo',
          parameters: duplicatedQuery,
          responses: ok,
        },
        delete: {
          operationId: 'SsoController_revoke',
          parameters: duplicatedQuery,
          requestBody: { required: true, content: { 'application/json': { schema: tokenBody } } },
          responses: ok,
        },
      },
    };

    const { services } = extractOperations(paths);
    for (const op of services[0].operations) {
      expect(op.queryParams.map((p) => p.name)).toEqual(['client_id', 'client_secret', 'code', 'grant_type', 'trace']);
      expect(op.bodyOwnedQueryParams).toBeUndefined();
    }
  });

  it('leaves POST query params alone when the body shares no names', () => {
    const paths = {
      '/users/{user_id}/connected_accounts/{slug}': {
        post: {
          operationId: 'ConnectedAccountsController_create',
          parameters: [
            { name: 'user_id', in: 'path' as const, required: true, schema: { type: 'string' } },
            { name: 'slug', in: 'path' as const, required: true, schema: { type: 'string' } },
            { name: 'organization_id', in: 'query' as const, required: false, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { scopes: { type: 'array', items: { type: 'string' } } } },
              },
            },
          },
          responses: ok,
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.queryParams.map((p) => p.name)).toEqual(['organization_id']);
    expect(op.bodyOwnedQueryParams).toBeUndefined();
    expect(op.pathParams.map((p) => p.name)).toEqual(['user_id', 'slug']);
  });
});

describe('body-owned query parameters keep their inline enums', () => {
  it('still promotes an inline enum declared only by a body-owned query param', () => {
    const paths = {
      '/sso/token': {
        post: {
          operationId: 'SsoController_token',
          parameters: [
            {
              name: 'grant_type',
              in: 'query' as const,
              required: true,
              schema: {
                type: 'string',
                enum: ['authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange'],
              },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { grant_type: { type: 'string' }, code: { type: 'string' } } },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    };

    const { services } = extractOperations(paths);
    const op = services[0].operations[0];
    expect(op.queryParams).toEqual([]);
    expect(op.bodyOwnedQueryParams?.map((p) => p.name)).toEqual(['grant_type']);

    // The published SDKs already ship this enum under the query-derived name;
    // dropping the declaration from queryParams must not remove the type.
    const enums: Enum[] = [];
    collectInlineEnumsFromOperations(services, enums);
    expect(enums.map((e) => e.name)).toEqual(['SSOGrantType']);
    expect(enums[0].values.map((v) => v.value)).toEqual([
      'authorization_code',
      'urn:ietf:params:oauth:grant-type:token-exchange',
    ]);
  });
});

describe('body-owned query parameters: composition, groups, and body refs', () => {
  const ok = { '200': { description: 'ok' } };
  const q = (name: string) => ({ name, in: 'query' as const, required: false, schema: { type: 'string' } });
  const obj = (...names: string[]): SchemaObject => ({
    type: 'object',
    properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])),
  });
  const jsonBody = (schema: SchemaObject) => ({ required: true, content: { 'application/json': { schema } } });

  it('only treats properties every oneOf alternative declares as body-owned', () => {
    const paths = {
      '/sso/token': {
        post: {
          operationId: 'SsoController_token',
          parameters: [q('client_id'), q('code'), q('subject_token')],
          requestBody: jsonBody({
            oneOf: [obj('client_id', 'code'), obj('client_id', 'subject_token'), { type: 'null' }],
          }),
          responses: ok,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    // `code` and `subject_token` each live on one branch only; a caller on the
    // other branch would have nowhere to send them, so they stay in the query.
    expect(op.queryParams.map((p) => p.name)).toEqual(['code', 'subject_token']);
    expect(op.bodyOwnedQueryParams?.map((p) => p.name)).toEqual(['client_id']);
  });

  it('unions allOf members and intersects anyOf alternatives', () => {
    const paths = {
      '/sso/token': {
        post: {
          operationId: 'SsoController_token',
          parameters: [q('client_id'), q('code'), q('subject_token')],
          requestBody: jsonBody({ allOf: [obj('client_id'), { anyOf: [obj('code'), obj('code', 'subject_token')] }] }),
          responses: ok,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op.queryParams.map((p) => p.name)).toEqual(['subject_token']);
    expect(op.bodyOwnedQueryParams?.map((p) => p.name)).toEqual(['client_id', 'code']);
  });

  it('leaves x-mutually-exclusive-parameter-groups members as query parameters', () => {
    const paths = {
      '/authorization/resources': {
        post: {
          operationId: 'AuthorizationController_create',
          parameters: [q('parent_resource_id'), q('parent_external_id')],
          requestBody: jsonBody(obj('parent_resource_id', 'name')),
          'x-mutually-exclusive-parameter-groups': {
            parent: {
              optional: true,
              variants: { by_id: ['parent_resource_id'], by_external_id: ['parent_external_id'] },
            },
          },
          responses: ok,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op.queryParams.map((p) => p.name)).toEqual(['parent_resource_id', 'parent_external_id']);
    expect(op.bodyOwnedQueryParams).toBeUndefined();
    expect(op.parameterGroups).toHaveLength(1);
    expect(op.parameterGroups![0].variants.map((v) => v.parameters.map((p) => p.name))).toEqual([
      ['parent_resource_id'],
      ['parent_external_id'],
    ]);
  });

  it('resolves components/requestBodies refs before deciding ownership', () => {
    const componentRequestBodies = { TokenBody: jsonBody(obj('client_id', 'code')) };
    const paths = {
      '/sso/token': {
        post: {
          operationId: 'SsoController_token',
          parameters: [q('client_id'), q('code'), q('trace')],
          requestBody: { $ref: '#/components/requestBodies/TokenBody' },
          responses: ok,
        },
      },
    };

    const op = extractOperations(paths, undefined, undefined, undefined, componentRequestBodies).services[0]
      .operations[0];
    expect(op.queryParams.map((p) => p.name)).toEqual(['trace']);
    expect(op.bodyOwnedQueryParams?.map((p) => p.name)).toEqual(['client_id', 'code']);
    // The referenced body is extracted too — previously a $ref body was dropped.
    expect(op.requestBody).toEqual({ kind: 'model', name: 'SSOTokenRequest' });
  });

  it('fails loudly on an unresolvable components/requestBodies ref', () => {
    const paths = {
      '/sso/token': {
        post: {
          operationId: 'SsoController_token',
          requestBody: { $ref: '#/components/requestBodies/Missing' },
          responses: ok,
        },
      },
    };

    expect(() => extractOperations(paths)).toThrow(/Unresolved request body \$ref/);
  });
});

describe('extractOperations – parameter `examples` (issue #189)', () => {
  const ok = { '200': { description: 'ok' } };
  const projected = (params: Array<{ name: string; example?: unknown; examples?: unknown[] }>) =>
    params.map(({ name, example, examples }) => ({ name, example, examples }));

  it('fills a param example from its schema examples list', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            { name: 'species', in: 'query' as const, schema: { type: 'string', examples: ['dog', 'cat'] } },
            { name: 'color', in: 'query' as const, schema: { type: 'string', example: 'brown' } },
          ],
          responses: ok,
        },
      },
    };

    const { services } = extractOperations(paths);
    const { queryParams } = services[0].operations[0];
    expect(projected(queryParams)).toMatchInlineSnapshot(`
      [
        {
          "example": "dog",
          "examples": [
            "dog",
            "cat",
          ],
          "name": "species",
        },
        {
          "example": "brown",
          "examples": undefined,
          "name": "color",
        },
      ]
    `);
    expect(queryParams[1]).not.toHaveProperty('examples');
  });

  it('prefers an explicit example over the examples list for the single value', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            {
              name: 'on_param',
              in: 'query' as const,
              example: 'param',
              schema: { type: 'string', example: 'schema', examples: ['list'] },
            },
            {
              name: 'on_schema',
              in: 'query' as const,
              schema: { type: 'string', example: 'schema', examples: ['list'] },
            },
          ],
          responses: ok,
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(projected(services[0].operations[0].queryParams)).toEqual([
      { name: 'on_param', example: 'param', examples: ['list'] },
      { name: 'on_schema', example: 'schema', examples: ['list'] },
    ]);
  });

  it('reads a parameter-level map of Example Objects in document order', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            {
              name: 'species',
              in: 'query' as const,
              schema: { type: 'string' },
              examples: {
                dog: { summary: 'A dog', value: 'dog' },
                shared: { $ref: '#/components/examples/Shared' },
                remote: { externalValue: 'https://example.com/cat.json' },
                blank: { summary: 'no inline value' },
                none: { value: null },
                cat: { value: 'cat' },
              },
            },
          ],
          responses: ok,
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(projected(services[0].operations[0].queryParams)).toMatchInlineSnapshot(`
      [
        {
          "example": "dog",
          "examples": [
            "dog",
            null,
            "cat",
          ],
          "name": "species",
        },
      ]
    `);
  });

  it('prefers the parameter-level map over the schema examples list', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            {
              name: 'species',
              in: 'query' as const,
              schema: { type: 'string', examples: ['schema'] },
              examples: { one: { value: 'param' } },
            },
          ],
          responses: ok,
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(projected(services[0].operations[0].queryParams)).toEqual([
      { name: 'species', example: 'param', examples: ['param'] },
    ]);
  });

  it('falls through to the schema list when the map has no inline values', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            {
              name: 'species',
              in: 'query' as const,
              schema: { type: 'string', examples: ['schema'] },
              examples: { shared: { $ref: '#/components/examples/Shared' } },
            },
          ],
          responses: ok,
        },
      },
    };

    const { services } = extractOperations(paths);
    expect(projected(services[0].operations[0].queryParams)).toEqual([
      { name: 'species', example: 'schema', examples: ['schema'] },
    ]);
  });

  it('falls back to the referenced component schema examples', () => {
    const paths = {
      '/organizations': {
        get: {
          operationId: 'listOrganizations',
          parameters: [
            {
              name: 'order',
              in: 'query' as const,
              required: false,
              schema: { $ref: '#/components/schemas/PaginationOrder' },
            },
          ],
          responses: ok,
        },
      },
    };
    const componentSchemas = {
      PaginationOrder: {
        type: 'string',
        enum: ['desc', 'asc'],
        examples: ['desc', 'asc'],
      },
    };

    const { services } = extractOperations(paths, undefined, componentSchemas);
    const [order] = services[0].operations[0].queryParams;
    expect(order.example).toBe('desc');
    expect(order.examples).toEqual(['desc', 'asc']);
  });

  it('omits examples when neither the param nor its schema gives any', () => {
    const paths = {
      '/pets/{pet_id}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'pet_id', in: 'path' as const, required: true, schema: { type: 'string' } }],
          responses: ok,
        },
      },
    };

    const { services } = extractOperations(paths);
    const [petId] = services[0].operations[0].pathParams;
    expect(petId.example).toBeUndefined();
    expect(petId).not.toHaveProperty('examples');
  });
});

describe('extractOperations – per-level parameter example precedence (PR #198 review)', () => {
  const ok = { '200': { description: 'ok' } };
  const projected = (params: Array<{ name: string; example?: unknown; examples?: unknown[] }>) =>
    params.map(({ name, example, examples }) => ({ name, example, examples }));
  const listPets = (parameters: unknown[]) =>
    ({ '/pets': { get: { operationId: 'listPets', parameters, responses: ok } } }) as never;
  const query = (paths: never, ...rest: unknown[]) =>
    extractOperations(paths, ...(rest as [])).services[0].operations[0].queryParams;

  it('takes example from the parameter-level map before a schema-level example', () => {
    const params = query(
      listPets([
        {
          name: 'species',
          in: 'query',
          examples: { one: { value: 'param' } },
          schema: { type: 'string', example: 'schema' },
        },
      ]),
    );
    expect(projected(params)).toEqual([{ name: 'species', example: 'param', examples: ['param'] }]);
  });

  it('keeps an explicit null example at any level instead of falling through', () => {
    const params = query(
      listPets([
        { name: 'on_param', in: 'query', example: null, schema: { type: ['string', 'null'], examples: ['dog'] } },
        { name: 'on_schema', in: 'query', schema: { type: ['string', 'null'], example: null, examples: ['dog'] } },
      ]),
    );
    expect(projected(params)).toEqual([
      { name: 'on_param', example: null, examples: ['dog'] },
      { name: 'on_schema', example: null, examples: ['dog'] },
    ]);
  });

  it('keeps an explicit null on the referenced component over a later level', () => {
    const componentSchemas = { Species: { type: ['string', 'null'], example: null, examples: ['dog'] } };
    const params = query(
      listPets([{ name: 'species', in: 'query', schema: { $ref: '#/components/schemas/Species' } }]),
      undefined,
      componentSchemas,
    );
    expect(projected(params)).toEqual([{ name: 'species', example: null, examples: ['dog'] }]);
  });

  it('lets examples fall to a later level while example stays on an earlier one', () => {
    const params = query(
      listPets([
        { name: 'species', in: 'query', example: 'param', schema: { type: 'string', examples: ['s1', 's2'] } },
      ]),
    );
    expect(projected(params)).toEqual([{ name: 'species', example: 'param', examples: ['s1', 's2'] }]);
  });
});

describe('extractOperations – `$ref` entries in a parameter examples map (PR #198 review)', () => {
  const ok = { '200': { description: 'ok' } };
  const projected = (params: Array<{ name: string; example?: unknown; examples?: unknown[] }>) =>
    params.map(({ name, example, examples }) => ({ name, example, examples }));
  const withExamples = (examples: Record<string, unknown>, schema: Record<string, unknown> = { type: 'string' }) =>
    ({
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [{ name: 'species', in: 'query', schema, examples }],
          responses: ok,
        },
      },
    }) as never;
  // `componentExamples` is the 8th parameter, after `documentTags` (#197).
  const query = (paths: never, componentExamples?: Record<string, Record<string, unknown>>) =>
    extractOperations(paths, undefined, undefined, undefined, undefined, undefined, undefined, componentExamples)
      .services[0].operations[0].queryParams;

  it('resolves a $ref entry against components.examples in document order', () => {
    const params = query(withExamples({ dog: { $ref: '#/components/examples/Dog' }, cat: { value: 'cat' } }), {
      Dog: { summary: 'A dog', value: 'dog' },
    });
    expect(projected(params)).toEqual([{ name: 'species', example: 'dog', examples: ['dog', 'cat'] }]);
  });

  it('reads a map made only of refs instead of falling through to the schema list', () => {
    const params = query(
      withExamples(
        { a: { $ref: '#/components/examples/Dog' }, b: { $ref: '#/components/examples/Cat' } },
        { type: 'string', examples: ['schema'] },
      ),
      { Dog: { value: 'dog' }, Cat: { value: 'cat' } },
    );
    expect(projected(params)).toEqual([{ name: 'species', example: 'dog', examples: ['dog', 'cat'] }]);
  });

  it('skips a dangling $ref with a warning and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const params = query(
        withExamples({ missing: { $ref: '#/components/examples/Missing' }, cat: { value: 'cat' } }),
        {},
      );
      expect(projected(params)).toEqual([{ name: 'species', example: 'cat', examples: ['cat'] }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/Unresolved example \$ref "#\/components\/examples\/Missing"/);
      expect(warn.mock.calls[0][0]).toMatch(/parameter "species" in listPets/);
    } finally {
      warn.mockRestore();
    }
  });

  it('falls through to the schema list when every ref dangles', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const params = query(
        withExamples({ missing: { $ref: '#/components/examples/Missing' } }, { type: 'string', examples: ['schema'] }),
      );
      expect(projected(params)).toEqual([{ name: 'species', example: 'schema', examples: ['schema'] }]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('follows a chain of refs, unescapes JSON Pointer tokens, and guards against cycles', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const params = query(
        withExamples({
          alias: { $ref: '#/components/examples/Alias' },
          escaped: { $ref: '#/components/examples/pets~1cat' },
          loop: { $ref: '#/components/examples/Loop' },
        }),
        {
          Alias: { $ref: '#/components/examples/Dog' },
          Dog: { value: 'dog' },
          'pets/cat': { value: 'cat' },
          Loop: { $ref: '#/components/examples/Loop' },
        },
      );
      expect(projected(params)).toEqual([{ name: 'species', example: 'dog', examples: ['dog', 'cat'] }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/Circular example \$ref chain starting at "#\/components\/examples\/Loop"/);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips a resolved entry that carries externalValue or no value', () => {
    const params = query(
      withExamples({
        remote: { $ref: '#/components/examples/Remote' },
        blank: { $ref: '#/components/examples/Blank' },
      }),
      { Remote: { externalValue: 'https://example.com/dog.json' }, Blank: { summary: 'no inline value' } },
    );
    expect(projected(params)).toEqual([{ name: 'species', example: undefined, examples: undefined }]);
  });
});

describe('extractOperations – request-body fields fall back to a referenced component (PR #198 review)', () => {
  it('takes example and examples from the component a body field $refs', () => {
    const paths = {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    category: { $ref: '#/components/schemas/Category' },
                    direction: { $ref: '#/components/schemas/Direction' },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    };
    const componentSchemas = {
      Category: { type: 'string', enum: ['dog', 'cat'], examples: ['dog', 'cat'] },
      Direction: { type: 'string', enum: ['asc', 'desc'], example: 'asc' },
    };

    const { inlineModels } = extractOperations(paths, undefined, componentSchemas);
    const body = inlineModels.find((m) => m.name === 'CreatePetRequest');
    expect(body?.fields.map(({ name, example, examples }) => ({ name, example, examples }))).toEqual([
      { name: 'category', example: 'dog', examples: ['dog', 'cat'] },
      { name: 'direction', example: 'asc', examples: undefined },
    ]);
    expect(body?.fields[1]).not.toHaveProperty('examples');
  });
});

describe('extractOperations – Service.description from document tags (issue #192)', () => {
  const responses = { '200': { description: 'ok' } };
  type DocTags = Parameters<typeof extractOperations>[6];
  const withTags = (paths: Parameters<typeof extractOperations>[0], tags: DocTags) =>
    extractOperations(paths, undefined, undefined, undefined, undefined, undefined, tags).services;

  it('gives a service the description of the tag it was named after', () => {
    const paths = {
      '/pets': { get: { operationId: 'listPets', tags: ['Pets'], responses } },
    };
    const tags = [{ name: 'Pets', description: 'Pets live in a store and can be adopted.' }];

    expect(withTags(paths, tags)).toEqual([
      expect.objectContaining({ name: 'Pets', description: 'Pets live in a store and can be adopted.' }),
    ]);
  });

  it('gives every service split off a tag by path prefix that tag description', () => {
    const paths = {
      '/organizations': { get: { operationId: 'listOrganizations', tags: ['organizations'], responses } },
      '/organization_domains': {
        get: { operationId: 'listOrganizationDomains', tags: ['organizations'], responses },
      },
    };
    const tags = [{ name: 'organizations', description: 'Manage organizations.' }];

    const services = withTags(paths, tags);
    expect(Object.fromEntries(services.map((s) => [s.name, s.description]))).toEqual({
      Organizations: 'Manage organizations.',
      OrganizationDomains: 'Manage organizations.',
    });
  });

  it('prefers the tag a service is named after over one merged in by the split', () => {
    const paths = {
      '/organizations': { get: { operationId: 'listOrganizations', tags: ['organizations'], responses } },
      '/organization_domains': {
        get: { operationId: 'listOrganizationDomains', tags: ['organizations'], responses },
        post: { operationId: 'createOrganizationDomain', tags: ['organization-domains'], responses },
      },
    };
    const tags = [
      { name: 'organizations', description: 'Manage organizations.' },
      { name: 'organization-domains', description: 'Manage organization domains.' },
    ];

    const services = withTags(paths, tags);
    expect(Object.fromEntries(services.map((s) => [s.name, s.description]))).toEqual({
      Organizations: 'Manage organizations.',
      OrganizationDomains: 'Manage organization domains.',
    });
    // Both operations landed in the same service despite the differing tags.
    expect(services.find((s) => s.name === 'OrganizationDomains')!.operations).toHaveLength(2);
  });

  it('matches tags to services across casing and separator differences', () => {
    const paths = {
      '/user_management/users': {
        get: { operationId: 'listUsers', tags: ['User Management'], responses },
        post: { operationId: 'createUser', tags: ['user-management'], responses },
      },
    };
    const tags = [{ name: 'user_management', description: 'Manage users.' }];

    const services = withTags(paths, tags);
    expect(services).toHaveLength(1);
    expect(services[0]).toEqual(expect.objectContaining({ name: 'UserManagement', description: 'Manage users.' }));
    expect(services[0].operations).toHaveLength(2);
  });

  it('leaves the key unset when no document tag describes the service', () => {
    const paths = {
      '/pets': { get: { operationId: 'listPets', tags: ['Pets'], responses } },
      '/toys': { get: { operationId: 'listToys', responses } },
    };
    const tags = [{ name: 'Other', description: 'Unrelated.' }];

    const services = withTags(paths, tags);
    expect(services.map((s) => s.name).sort()).toEqual(['Pets', 'Toys']);
    for (const service of services) expect('description' in service).toBe(false);
  });

  it('describes a path-named service by the declared tag matching its name', () => {
    const paths = { '/toys': { get: { operationId: 'listToys', responses } } };
    const tags = [{ name: 'toys', description: 'Toys for pets.' }];

    expect(withTags(paths, tags)).toEqual([expect.objectContaining({ name: 'Toys', description: 'Toys for pets.' })]);
  });

  it('never borrows another tag description for a service whose own tag is declared', () => {
    // Reviewer scenario: the path-prefix split merges the api_keys operation
    // under /user_management into UserManagement. user-management is declared
    // without a description, so UserManagement must show nothing rather than
    // "API keys."; ApiKeys keeps its own description.
    const paths = {
      '/user_management/users': { get: { operationId: 'listUsers', tags: ['user-management'], responses } },
      '/user_management/api_keys': { get: { operationId: 'listUserApiKeys', tags: ['api_keys'], responses } },
      '/api_keys/{id}': { delete: { operationId: 'deleteApiKey', tags: ['api_keys'], responses } },
    };
    const tags = [{ name: 'user-management' }, { name: 'api_keys', description: 'API keys.' }];

    const services = withTags(paths, tags);
    const userManagement = services.find((s) => s.name === 'UserManagement')!;
    expect(userManagement.operations.map((o) => o.path).sort()).toEqual([
      '/user_management/api_keys',
      '/user_management/users',
    ]);
    expect('description' in userManagement).toBe(false);
    expect(services.find((s) => s.name === 'ApiKeys')).toEqual(expect.objectContaining({ description: 'API keys.' }));
  });

  it('inherits only for split-off services whose own name is not declared', () => {
    const paths = {
      '/organizations': { get: { operationId: 'listOrganizations', tags: ['organizations'], responses } },
      '/organization_domains': {
        get: { operationId: 'listOrganizationDomains', tags: ['organizations'], responses },
      },
      '/organization_memberships': {
        get: { operationId: 'listOrganizationMemberships', tags: ['organizations'], responses },
      },
    };
    const tags = [
      { name: 'organizations', description: 'Manage organizations.' },
      // Declared for the split-off OrganizationMemberships but undescribed:
      // that blocks inheritance instead of falling back to "Manage organizations."
      { name: 'organization-memberships' },
    ];

    const services = withTags(paths, tags);
    expect(Object.fromEntries(services.map((s) => [s.name, s.description]))).toEqual({
      Organizations: 'Manage organizations.',
      OrganizationDomains: 'Manage organizations.',
      OrganizationMemberships: undefined,
    });
    expect('description' in services.find((s) => s.name === 'OrganizationMemberships')!).toBe(false);
  });

  it('lets a later described duplicate tag fill in for an earlier undescribed one', () => {
    const paths = { '/pets': { get: { operationId: 'listPets', tags: ['pets'], responses } } };
    const tags = [{ name: 'pets' }, { name: 'Pets', description: 'Described later.' }];

    expect(withTags(paths, tags)[0].description).toBe('Described later.');
  });

  it('ignores blank descriptions, nameless entries, and absent document tags', () => {
    const paths = { '/pets': { get: { operationId: 'listPets', tags: ['Pets'], responses } } };

    const blank = [{ name: 'Pets', description: '   ' }, { description: 'nameless' }];
    expect('description' in withTags(paths, blank)[0]).toBe(false);
    expect('description' in withTags(paths, undefined)[0]).toBe(false);
    expect('description' in extractOperations(paths).services[0]).toBe(false);
  });

  it('uses the first document tag when several normalize to the same service', () => {
    const paths = { '/pets': { get: { operationId: 'listPets', tags: ['pets'], responses } } };
    const tags = [
      { name: 'pets', description: 'First.' },
      { name: 'Pets', description: 'Second.' },
    ];

    expect(withTags(paths, tags)[0].description).toBe('First.');
  });

  it('skips malformed document tag entries instead of throwing', () => {
    const paths = { '/pets': { get: { operationId: 'listPets', tags: ['Pets'], responses } } };
    const described = { name: 'Pets', description: 'Pets live in a store.' };

    // `tags` written as an object rather than a list matches nothing.
    const asObject = { Pets: described } as unknown as DocTags;
    expect('description' in withTags(paths, asObject)[0]).toBe(false);

    // Null entries, primitives, and non-string names are skipped; a well-formed
    // entry alongside them still applies.
    const mixed = [null, 7, { name: 42, description: 'numeric name' }, described] as unknown as DocTags;
    expect(withTags(paths, mixed)[0].description).toBe('Pets live in a store.');
  });
});

describe('operation summary', () => {
  const responses = { '204': { description: 'ok' } };

  it('keeps summary on its own and folds it into description when both are declared', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          summary: 'List pets',
          description: 'Returns every pet in the store, newest first.',
          responses,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op.summary).toBe('List pets');
    expect(op.description).toBe('List pets\n\nReturns every pet in the store, newest first.');
  });

  it('keeps summary and mirrors it into description when only summary is declared', () => {
    const paths = {
      '/pets': {
        post: {
          operationId: 'createPet',
          summary: 'Create a pet',
          responses,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op.summary).toBe('Create a pet');
    expect(op.description).toBe('Create a pet');
  });

  it('omits the summary key when only description is declared', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          description: 'Returns every pet in the store, newest first.',
          responses,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op).not.toHaveProperty('summary');
    expect(op.description).toBe('Returns every pet in the store, newest first.');
  });

  it('omits the summary key and leaves description undefined when neither is declared', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          responses,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op).not.toHaveProperty('summary');
    expect(op.description).toBeUndefined();
  });

  it('omits the summary key when the declared summary is an empty string', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          summary: '',
          description: 'Returns every pet in the store, newest first.',
          responses,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op).not.toHaveProperty('summary');
    expect(op.description).toBe('Returns every pet in the store, newest first.');
  });
});

describe('operation summary and description with empty or whitespace-only text', () => {
  const responses = { '204': { description: 'ok' } };

  it('treats an empty description as absent so description falls back to the summary', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          summary: 'List pets',
          description: '',
          responses,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op.summary).toBe('List pets');
    expect(op.description).toBe('List pets');
  });

  it('treats a whitespace-only description as absent so description falls back to the summary', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          summary: 'List pets',
          description: '  \n\t',
          responses,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op.summary).toBe('List pets');
    expect(op.description).toBe('List pets');
  });

  it('omits a whitespace-only summary from both summary and description', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          summary: '  ',
          description: 'Lists pets.',
          responses,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op).not.toHaveProperty('summary');
    expect(op.description).toBe('Lists pets.');
  });

  it('leaves description undefined and omits summary when both are whitespace-only', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          summary: ' ',
          description: '\n',
          responses,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op).not.toHaveProperty('summary');
    expect(op.description).toBeUndefined();
  });

  it('keeps surrounding whitespace on text that has content', () => {
    const paths = {
      '/pets': {
        get: {
          operationId: 'listPets',
          summary: 'List pets',
          description: 'Lists pets.\n',
          responses,
        },
      },
    };

    const op = extractOperations(paths).services[0].operations[0];
    expect(op.summary).toBe('List pets');
    expect(op.description).toBe('List pets\n\nLists pets.\n');
  });
});

describe('fallback operation names stay unique within a service (issue #208)', () => {
  const ok = { responses: { '204': { description: 'ok' } } };
  const withParam = (name: string) => ({
    parameters: [{ name, in: 'path' as const, required: true, schema: { type: 'string' } }],
    ...ok,
  });
  /** `METHOD /path` → operation name, across every service. */
  const names = (paths: Parameters<typeof extractOperations>[0]) =>
    Object.fromEntries(
      extractOperations(paths).services.flatMap((s) =>
        s.operations.map((o) => [`${o.httpMethod.toUpperCase()} ${o.path}`, o.name]),
      ),
    );

  it('names the issue repro without repeating a word, using the path parameter that tells the paths apart', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        names({
          '/v1/notes': { get: ok },
          '/v1/{teamId}/notes': { get: withParam('teamId') },
          '/v1/notes/all': { delete: ok },
          '/v1/{teamId}/notes/all': { delete: withParam('teamId') },
        }),
      ).toEqual({
        'GET /v1/notes': 'listNotes',
        'GET /v1/{teamId}/notes': 'listNotesByTeamId',
        'DELETE /v1/notes/all': 'deleteAllNotes',
        'DELETE /v1/{teamId}/notes/all': 'deleteAllNotesByTeamId',
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('qualifies each HTTP method separately, so sibling methods get parallel names', () => {
    expect(
      names({
        '/v1/notes': { get: ok, post: ok },
        '/v1/{teamId}/notes': { get: withParam('teamId'), post: withParam('teamId') },
      }),
    ).toEqual({
      'GET /v1/notes': 'listNotes',
      'POST /v1/notes': 'createNotes',
      'GET /v1/{teamId}/notes': 'listNotesByTeamId',
      'POST /v1/{teamId}/notes': 'createNotesByTeamId',
    });
  });

  it('appends one By<Param> per parameter, in path order, after the deeper path context', () => {
    expect(
      names({
        '/orgs/teams/members': { get: ok },
        '/orgs/{orgId}/teams/members': { get: withParam('orgId') },
        '/orgs/{orgId}/teams/{teamId}/members': { get: withParam('orgId') },
      }),
    ).toEqual({
      'GET /orgs/teams/members': 'listMembersTeams',
      'GET /orgs/{orgId}/teams/members': 'listMembersTeamsByOrgId',
      'GET /orgs/{orgId}/teams/{teamId}/members': 'listMembersTeamsByOrgIdByTeamId',
    });
  });

  it('does not repeat a deeper path context the name already ends with', () => {
    expect(
      names({
        '/v1/notes/{id}/notes': { get: withParam('id') },
        '/v1/{x}/notes/{id}/notes': { get: withParam('x') },
      }),
    ).toEqual({
      'GET /v1/notes/{id}/notes': 'listNotesById',
      'GET /v1/{x}/notes/{id}/notes': 'listNotesByXById',
    });
  });

  it("tells a three-way collision apart by each path's own parameters", () => {
    expect(
      names({
        '/v1/notes': { get: ok },
        '/v1/{teamId}/notes': { get: withParam('teamId') },
        '/v1/{orgId}/notes': { get: withParam('orgId') },
      }),
    ).toEqual({
      'GET /v1/notes': 'listNotes',
      'GET /v1/{teamId}/notes': 'listNotesByTeamId',
      'GET /v1/{orgId}/notes': 'listNotesByOrgId',
    });
  });

  it('falls back to a silent numeric suffix when the paths flatten to the same words, whatever the document order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const expected = {
        'GET /v1/{userId}/notes': 'listNotes',
        'GET /v1/{user_id}/notes': 'listNotes2',
      };
      expect(
        names({
          '/v1/{userId}/notes': { get: withParam('userId') },
          '/v1/{user_id}/notes': { get: withParam('user_id') },
        }),
      ).toEqual(expected);
      expect(
        names({
          '/v1/{user_id}/notes': { get: withParam('user_id') },
          '/v1/{userId}/notes': { get: withParam('userId') },
        }),
      ).toEqual(expected);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps same-path PUT and PATCH on one name while a third path gets the suffix', () => {
    expect(
      names({
        '/things/{userId}': { put: withParam('userId'), patch: withParam('userId') },
        '/things/{user_id}': { put: withParam('user_id') },
      }),
    ).toEqual({
      'PUT /things/{userId}': 'update',
      'PATCH /things/{userId}': 'update',
      'PUT /things/{user_id}': 'update2',
    });
  });

  it('skips a numeric suffix another operation already uses', () => {
    expect(
      names({
        '/v1/{userId}/notes': { get: withParam('userId') },
        '/v1/{user_id}/notes': { get: withParam('user_id') },
        '/v1/other': { get: { operationId: 'listNotes2', ...ok } },
      }),
    ).toEqual({
      'GET /v1/{userId}/notes': 'listNotes',
      'GET /v1/{user_id}/notes': 'listNotes3',
      'GET /v1/other': 'listNotes2',
    });
  });

  it('never renames an operationId-named operation; a colliding path-named one is qualified instead', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The path-named operation comes first in the document and still yields.
      expect(
        names({
          '/x/{teamId}/notes': { get: withParam('teamId') },
          '/x/notes': { get: { operationId: 'listNotes', ...ok } },
        }),
      ).toEqual({
        'GET /x/{teamId}/notes': 'listNotesByTeamId',
        'GET /x/notes': 'listNotes',
      });
      // When the path-named operation has nothing of its own to add, it takes the suffix.
      expect(
        names({
          '/x/notes': { get: ok },
          '/x/{teamId}/notes': { get: { operationId: 'listNotes', ...withParam('teamId') } },
        }),
      ).toEqual({
        'GET /x/notes': 'listNotes2',
        'GET /x/{teamId}/notes': 'listNotes',
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('suffixes a reused operationId with a warning instead of appending path words to both', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        names({
          '/x/notes': { get: { operationId: 'listNotes', ...ok } },
          '/x/items': { get: { operationId: 'listNotes', ...ok } },
        }),
      ).toEqual({
        // `/x/items` sorts before `/x/notes`, so it keeps the name regardless of document order.
        'GET /x/notes': 'listNotes2',
        'GET /x/items': 'listNotes',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /^\[oagen\] Warning: Operations GET \/x\/items and GET \/x\/notes in service X/,
      );
      expect(warn.mock.calls[0][0]).toMatch(
        /both take the name "listNotes" from their operationId; the latter is renamed "listNotes2"/,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
