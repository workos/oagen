import { describe, it, expect } from 'vitest';
import { extractOperations } from '../../src/parser/operations.js';

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
});
