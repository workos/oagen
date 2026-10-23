import { describe, it, expect } from 'vitest';
import type {
  ApiSpec,
  TypeRef,
  PrimitiveType,
  ArrayType,
  ModelRef,
  NullableType,
  UnionType,
  LiteralType,
  Model,
  Enum,
  Operation,
} from '../../src/ir/types.js';
import {
  walkTypeRef,
  mapTypeRef,
  collectModelRefs,
  collectEnumRefs,
  collectFieldDependencies,
  assignModelsToServices,
  validateModelHints,
  collectRequestBodyModels,
  collectResponseHeaders,
  collectFallbackResponseTypes,
  collectResponseBodyTypes,
  collectRequestBodyTypes,
  collectOperationTypeRefs,
} from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

describe('IR types', () => {
  it('constructs a valid PrimitiveType', () => {
    const t: PrimitiveType = { kind: 'primitive', type: 'string', format: 'uuid' };
    expect(t.kind).toBe('primitive');
    expect(t.type).toBe('string');
    expect(t.format).toBe('uuid');
  });

  it('constructs a valid ArrayType', () => {
    const t: ArrayType = {
      kind: 'array',
      items: { kind: 'primitive', type: 'string' },
    };
    expect(t.kind).toBe('array');
    expect(t.items.kind).toBe('primitive');
  });

  it('constructs a valid ModelRef', () => {
    const t: ModelRef = { kind: 'model', name: 'Organization' };
    expect(t.kind).toBe('model');
    expect(t.name).toBe('Organization');
  });

  it('constructs a valid NullableType', () => {
    const t: NullableType = {
      kind: 'nullable',
      inner: { kind: 'primitive', type: 'string' },
    };
    expect(t.kind).toBe('nullable');
    expect(t.inner.kind).toBe('primitive');
  });

  it('constructs a valid UnionType with discriminator', () => {
    const t: UnionType = {
      kind: 'union',
      variants: [
        { kind: 'model', name: 'Dog' },
        { kind: 'model', name: 'Cat' },
      ],
      discriminator: {
        property: 'pet_type',
        mapping: { dog: 'Dog', cat: 'Cat' },
      },
    };
    expect(t.kind).toBe('union');
    expect(t.variants).toHaveLength(2);
    expect(t.discriminator?.property).toBe('pet_type');
  });

  it('TypeRef discriminated union works with switch/case', () => {
    const refs: TypeRef[] = [
      { kind: 'primitive', type: 'string' },
      { kind: 'array', items: { kind: 'primitive', type: 'integer' } },
      { kind: 'model', name: 'User' },
      { kind: 'enum', name: 'Status' },
      { kind: 'nullable', inner: { kind: 'primitive', type: 'boolean' } },
      { kind: 'union', variants: [] },
    ];

    const kinds = refs.map((r) => r.kind);
    expect(kinds).toEqual(['primitive', 'array', 'model', 'enum', 'nullable', 'union']);
  });

  it('constructs a valid Model', () => {
    const m: Model = {
      name: 'Organization',
      description: 'An organization',
      fields: [
        {
          name: 'id',
          type: { kind: 'primitive', type: 'string', format: 'uuid' },
          required: true,
        },
        {
          name: 'name',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
        {
          name: 'parent_id',
          type: {
            kind: 'nullable',
            inner: { kind: 'primitive', type: 'string' },
          },
          required: false,
        },
      ],
    };
    expect(m.fields).toHaveLength(3);
    expect(m.fields[2].type.kind).toBe('nullable');
  });

  it('constructs a valid Enum', () => {
    const e: Enum = {
      name: 'Status',
      values: [
        { name: 'ACTIVE', value: 'active' },
        { name: 'INACTIVE', value: 'inactive' },
      ],
    };
    expect(e.values).toHaveLength(2);
    expect(e.values[0].name).toBe('ACTIVE');
  });

  it('constructs an Operation whose responses carry descriptions', () => {
    const op: Operation = {
      name: 'getPet',
      httpMethod: 'get',
      path: '/pets/{id}',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model', name: 'Pet' },
      responseDescription: 'The pet, with its owner.',
      successResponses: [
        { statusCode: 200, type: { kind: 'model', name: 'Pet' }, description: 'The pet, with its owner.' },
        { statusCode: 304, type: { kind: 'primitive', type: 'unknown' } },
      ],
      errors: [{ statusCode: 404, description: 'Not found.' }, { statusCode: 500 }],
      injectIdempotencyKey: false,
    };
    expect(op.responseDescription).toBe(op.successResponses?.[0].description);
    expect(op.successResponses?.[1].description).toBeUndefined();
    expect(op.errors.map((e) => e.description)).toEqual(['Not found.', undefined]);
  });

  it('constructs a full ApiSpec', () => {
    const spec: ApiSpec = {
      name: 'Test API',
      version: '1.0.0',
      baseUrl: 'https://api.example.com',
      services: [
        {
          name: 'Users',
          operations: [
            {
              name: 'list',
              httpMethod: 'get',
              path: '/users',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: {
                kind: 'array',
                items: { kind: 'model', name: 'User' },
              },
              errors: [{ statusCode: 401 }],
              pagination: {
                strategy: 'cursor',
                param: 'after',
                dataPath: 'data',
                itemType: { kind: 'model', name: 'User' },
              },
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
      models: [
        {
          name: 'User',
          fields: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
        },
      ],
      enums: [],
      sdk: defaultSdkBehavior(),
    };
    expect(spec.services).toHaveLength(1);
    expect(spec.services[0].operations[0].pagination).toBeDefined();
    expect(spec.models).toHaveLength(1);
  });
});

describe('mapTypeRef', () => {
  const stringMapper = {
    primitive: (r: PrimitiveType) => r.type,
    array: (_r: ArrayType, items: string) => `Array<${items}>`,
    model: (r: ModelRef) => r.name,
    enum: (r: { kind: 'enum'; name: string }) => r.name,
    union: (_r: UnionType, variants: string[]) => variants.join(' | '),
    nullable: (_r: NullableType, inner: string) => `${inner} | null`,
    literal: (r: LiteralType) => `"${r.value}"`,
    map: (_r: { kind: 'map'; valueType: TypeRef }, value: string) => `Map<string, ${value}>`,
  };

  it('maps a primitive to its type name string', () => {
    const result = mapTypeRef({ kind: 'primitive', type: 'string' }, stringMapper);
    expect(result).toBe('string');
  });

  it('maps an array type', () => {
    const result = mapTypeRef({ kind: 'array', items: { kind: 'primitive', type: 'string' } }, stringMapper);
    expect(result).toBe('Array<string>');
  });

  it('maps a nullable model ref', () => {
    const result = mapTypeRef({ kind: 'nullable', inner: { kind: 'model', name: 'User' } }, stringMapper);
    expect(result).toBe('User | null');
  });

  it('maps a union type', () => {
    const result = mapTypeRef(
      {
        kind: 'union',
        variants: [
          { kind: 'primitive', type: 'string' },
          { kind: 'model', name: 'Foo' },
        ],
      },
      stringMapper,
    );
    expect(result).toBe('string | Foo');
  });

  it('maps a map type', () => {
    const result = mapTypeRef({ kind: 'map', valueType: { kind: 'primitive', type: 'integer' } }, stringMapper);
    expect(result).toBe('Map<string, integer>');
  });

  it('maps an enum ref', () => {
    const result = mapTypeRef({ kind: 'enum', name: 'Status' }, stringMapper);
    expect(result).toBe('Status');
  });

  it('maps a literal type', () => {
    const result = mapTypeRef({ kind: 'literal', value: 'active' }, stringMapper);
    expect(result).toBe('"active"');
  });

  it('maps a map type with keyType', () => {
    const result = mapTypeRef(
      { kind: 'map', valueType: { kind: 'primitive', type: 'string' }, keyType: { kind: 'enum', name: 'Scope' } },
      stringMapper,
    );
    expect(result).toBe('Map<string, string>');
  });
});

describe('LiteralType with null', () => {
  it('constructs a LiteralType with null value', () => {
    const t: LiteralType = { kind: 'literal', value: null };
    expect(t.kind).toBe('literal');
    expect(t.value).toBeNull();
  });
});

describe('walkTypeRef on MapType with keyType', () => {
  it('visits keyType when present', () => {
    const visited: string[] = [];
    walkTypeRef(
      { kind: 'map', valueType: { kind: 'primitive', type: 'string' }, keyType: { kind: 'enum', name: 'Scope' } },
      {
        enum: (ref) => visited.push(`enum:${ref.name}`),
        primitive: (ref) => visited.push(`primitive:${ref.type}`),
      },
    );
    expect(visited).toEqual(['enum:Scope', 'primitive:string']);
  });

  it('does not error when keyType is absent', () => {
    const visited: string[] = [];
    walkTypeRef(
      { kind: 'map', valueType: { kind: 'primitive', type: 'integer' } },
      {
        primitive: (ref) => visited.push(ref.type),
      },
    );
    expect(visited).toEqual(['integer']);
  });
});

describe('collectModelRefs', () => {
  it('collects model names from nested TypeRef', () => {
    const ref: TypeRef = {
      kind: 'array',
      items: { kind: 'nullable', inner: { kind: 'model', name: 'User' } },
    };
    expect(collectModelRefs(ref)).toEqual(['User']);
  });

  it('collects multiple models from a union', () => {
    const ref: TypeRef = {
      kind: 'union',
      variants: [
        { kind: 'model', name: 'Dog' },
        { kind: 'model', name: 'Cat' },
      ],
    };
    expect(collectModelRefs(ref)).toEqual(['Dog', 'Cat']);
  });

  it('returns empty for primitives', () => {
    expect(collectModelRefs({ kind: 'primitive', type: 'string' })).toEqual([]);
  });
});

describe('collectEnumRefs', () => {
  it('collects enum names from nested TypeRef', () => {
    const ref: TypeRef = { kind: 'nullable', inner: { kind: 'enum', name: 'Status' } };
    expect(collectEnumRefs(ref)).toEqual(['Status']);
  });
});

describe('collectFieldDependencies', () => {
  it('collects model and enum deps excluding self-references', () => {
    const model: Model = {
      name: 'Organization',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'owner', type: { kind: 'model', name: 'User' }, required: true },
        { name: 'status', type: { kind: 'enum', name: 'Status' }, required: true },
        { name: 'parent', type: { kind: 'nullable', inner: { kind: 'model', name: 'Organization' } }, required: false },
      ],
    };
    const deps = collectFieldDependencies(model);
    expect(deps.models).toEqual(new Set(['User']));
    expect(deps.enums).toEqual(new Set(['Status']));
  });
});

describe('assignModelsToServices', () => {
  it('assigns models to the first service that references them', () => {
    const models: Model[] = [
      { name: 'User', fields: [] },
      { name: 'Org', fields: [] },
      { name: 'Orphan', fields: [] },
    ];
    const services = [
      {
        name: 'Users',
        operations: [
          {
            name: 'getUser',
            httpMethod: 'get' as const,
            path: '/users/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model' as const, name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
      {
        name: 'Orgs',
        operations: [
          {
            name: 'getOrg',
            httpMethod: 'get' as const,
            path: '/orgs/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model' as const, name: 'Org' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const map = assignModelsToServices(models, services);
    expect(map.get('User')).toBe('Users');
    expect(map.get('Org')).toBe('Orgs');
    expect(map.has('Orphan')).toBe(false);
  });

  it('overrides assignment when modelHints pin a model to a specific service', () => {
    const models: Model[] = [
      { name: 'User', fields: [] },
      { name: 'Org', fields: [] },
    ];
    const services = [
      {
        name: 'Authorization',
        operations: [
          {
            name: 'check',
            httpMethod: 'get' as const,
            path: '/authorization/check',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model' as const, name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
      {
        name: 'UserManagementUsers',
        operations: [
          {
            name: 'getUser',
            httpMethod: 'get' as const,
            path: '/user_management/users/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model' as const, name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    // Without hints: Authorization wins (it's listed first).
    expect(assignModelsToServices(models, services).get('User')).toBe('Authorization');
    // With hints: explicit pin wins regardless of service order.
    expect(assignModelsToServices(models, services, { User: 'UserManagementUsers' }).get('User')).toBe(
      'UserManagementUsers',
    );
  });

  it('skips a hint whose model is outside this slice (partial models)', () => {
    // Placement is handed a partial slice that lacks `User`; the hint for `User`
    // must be skipped, not treated as a typo (it is a real model elsewhere).
    const models: Model[] = [{ name: 'Org', fields: [] }];
    const services = [
      {
        name: 'Orgs',
        operations: [
          {
            name: 'getOrg',
            httpMethod: 'get' as const,
            path: '/orgs/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model' as const, name: 'Org' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const map = assignModelsToServices(models, services, { User: 'UserManagementUsers' });
    expect(map.has('User')).toBe(false);
  });

  it('applies a hint whose target service is outside this slice (partial services)', () => {
    // The model is in the slice but the target service is not listed here; the
    // pin is still applied because placement resolves by service name.
    const models: Model[] = [{ name: 'User', fields: [] }];
    const services = [
      {
        name: 'Pipes',
        operations: [
          {
            name: 'getPipe',
            httpMethod: 'get' as const,
            path: '/pipes/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model' as const, name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const map = assignModelsToServices(models, services, { User: 'UserManagementUsers' });
    expect(map.get('User')).toBe('UserManagementUsers');
  });
});

describe('validateModelHints', () => {
  const models: Model[] = [{ name: 'User', fields: [] }];
  const services = [
    {
      name: 'Users',
      operations: [
        {
          name: 'getUser',
          httpMethod: 'get' as const,
          path: '/users/{id}',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model' as const, name: 'User' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    },
  ];

  it('throws when modelHints names an unknown model', () => {
    expect(() => validateModelHints(models, services, { Userrr: 'Users' })).toThrow(/unknown model "Userrr"/);
  });

  it('throws when modelHints names an unknown service', () => {
    expect(() => validateModelHints(models, services, { User: 'Userzzz' })).toThrow(/unknown service "Userzzz"/);
  });

  it('accepts hints whose model and service both exist in the full spec', () => {
    expect(() => validateModelHints(models, services, { User: 'Users' })).not.toThrow();
  });
});

describe('collectRequestBodyModels', () => {
  it('collects model names from request bodies', () => {
    const services = [
      {
        name: 'Users',
        operations: [
          {
            name: 'createUser',
            httpMethod: 'post' as const,
            path: '/users',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model' as const, name: 'CreateUserRequest' },
            response: { kind: 'model' as const, name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
          },
          {
            name: 'getUser',
            httpMethod: 'get' as const,
            path: '/users/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model' as const, name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const result = collectRequestBodyModels(services);
    expect(result).toEqual(new Set(['CreateUserRequest']));
  });
});

describe('assignModelsToServices — pagination envelope fields', () => {
  it('assigns a model reached only through a list envelope companion to that service', () => {
    const models: Model[] = [
      { name: 'User', fields: [] },
      { name: 'ListMetadata', fields: [] },
    ];
    const services = [
      {
        name: 'Users',
        operations: [
          {
            name: 'listUsers',
            httpMethod: 'get' as const,
            path: '/users',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'array' as const, items: { kind: 'model' as const, name: 'User' } },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor' as const,
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model' as const, name: 'User' },
              envelopeFields: [
                { name: 'list_metadata', type: { kind: 'model' as const, name: 'ListMetadata' }, required: true },
              ],
            },
          },
        ],
      },
    ];
    const map = assignModelsToServices(models, services);
    expect(map.get('User')).toBe('Users');
    expect(map.get('ListMetadata')).toBe('Users');
  });
});

describe('assignModelsToServices — response content types', () => {
  it('assigns a model reached only through a secondary media type to that service', () => {
    const models: Model[] = [
      { name: 'Thing', fields: [] },
      { name: 'ThingDocument', fields: [] },
      { name: 'Problem', fields: [] },
    ];
    const thing = { kind: 'model' as const, name: 'Thing' };
    const services = [
      {
        name: 'Things',
        operations: [
          {
            name: 'getThing',
            httpMethod: 'get' as const,
            path: '/things/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: thing,
            responseContentTypes: ['application/json', 'application/vnd.api+json'],
            responseContents: [
              { contentType: 'application/json', type: thing },
              { contentType: 'application/vnd.api+json', type: { kind: 'model' as const, name: 'ThingDocument' } },
            ],
            errors: [
              {
                statusCode: 500,
                contentTypes: ['application/problem+json'],
                contents: [
                  { contentType: 'application/problem+json', type: { kind: 'model' as const, name: 'Problem' } },
                ],
              },
            ],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const map = assignModelsToServices(models, services);
    expect(map.get('Thing')).toBe('Things');
    expect(map.get('ThingDocument')).toBe('Things');
    expect(map.get('Problem')).toBe('Things');
  });
});

describe('assignModelsToServices — response headers', () => {
  it('assigns a model reached only through a response header to that service', () => {
    const models: Model[] = [
      { name: 'Document', fields: [] },
      { name: 'DownloadMeta', fields: [] },
      { name: 'ThrottleInfo', fields: [] },
    ];
    const services = [
      {
        name: 'Documents',
        operations: [
          {
            name: 'downloadDocument',
            httpMethod: 'get' as const,
            path: '/documents/{id}/download',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model' as const, name: 'Document' },
            responseHeaders: [
              { name: 'X-Meta', type: { kind: 'model' as const, name: 'DownloadMeta' }, required: false },
            ],
            errors: [
              {
                statusCode: 429,
                headers: [
                  { name: 'X-Throttle', type: { kind: 'model' as const, name: 'ThrottleInfo' }, required: false },
                ],
              },
            ],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const map = assignModelsToServices(models, services);
    expect(map.get('Document')).toBe('Documents');
    expect(map.get('DownloadMeta')).toBe('Documents');
    expect(map.get('ThrottleInfo')).toBe('Documents');
  });
});

describe('assignModelsToServices — default and range responses', () => {
  it('assigns a model reached only as a fallback response body, or through one, to that service', () => {
    const models: Model[] = [
      { name: 'Document', fields: [] },
      { name: 'ApiError', fields: [{ name: 'cause', type: { kind: 'model', name: 'ErrorCause' }, required: false }] },
      { name: 'ErrorCause', fields: [] },
      { name: 'Outage', fields: [] },
      { name: 'Unrelated', fields: [] },
    ];
    const services = [
      {
        name: 'Documents',
        operations: [
          {
            name: 'getDocument',
            httpMethod: 'get' as const,
            path: '/documents/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model' as const, name: 'Document' },
            errors: [],
            defaultResponse: { type: { kind: 'model' as const, name: 'ApiError' } },
            rangeResponses: [{ range: '5XX' as const, type: { kind: 'model' as const, name: 'Outage' } }],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const map = assignModelsToServices(models, services);
    expect(map.get('Document')).toBe('Documents');
    expect(map.get('ApiError')).toBe('Documents');
    // Chased transitively through the fallback body's own fields.
    expect(map.get('ErrorCause')).toBe('Documents');
    expect(map.get('Outage')).toBe('Documents');
    expect(map.get('Unrelated')).toBeUndefined();
  });
});

describe('collectResponseHeaders — default and range responses', () => {
  const baseOperation = {
    name: 'getDocument',
    httpMethod: 'get' as const,
    path: '/documents/{id}',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive' as const, type: 'string' as const },
    errors: [],
    injectIdempotencyKey: false,
  };

  it('yields default and range headers after the explicit lists', () => {
    const headers = collectResponseHeaders({
      ...baseOperation,
      responseHeaders: [{ name: 'ETag', type: { kind: 'primitive', type: 'string' }, required: false }],
      errors: [
        {
          statusCode: 429,
          headers: [{ name: 'X-Throttle', type: { kind: 'primitive', type: 'string' }, required: false }],
        },
      ],
      defaultResponse: {
        headers: [{ name: 'Retry-After', type: { kind: 'primitive', type: 'integer' }, required: false }],
      },
      rangeResponses: [
        { range: '4XX' },
        {
          range: '5XX',
          headers: [{ name: 'X-Request-Id', type: { kind: 'primitive', type: 'string' }, required: false }],
        },
      ],
    });
    expect(headers.map((h) => h.name)).toEqual(['ETag', 'X-Throttle', 'Retry-After', 'X-Request-Id']);
  });

  it('yields nothing from fallback responses that declare no headers', () => {
    expect(
      collectResponseHeaders({ ...baseOperation, defaultResponse: {}, rangeResponses: [{ range: '2XX' }] }),
    ).toEqual([]);
  });
});

describe('collectFallbackResponseTypes', () => {
  const baseOperation = {
    name: 'getDocument',
    httpMethod: 'get' as const,
    path: '/documents/{id}',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive' as const, type: 'string' as const },
    errors: [],
    injectIdempotencyKey: false,
  };

  it('yields the default body, then each range body in order, skipping entries without one', () => {
    const types = collectFallbackResponseTypes({
      ...baseOperation,
      defaultResponse: { type: { kind: 'model', name: 'ApiError' } },
      rangeResponses: [
        { range: '5XX', type: { kind: 'model', name: 'Outage' } },
        { range: '2XX' },
        { range: '4XX', type: { kind: 'array', items: { kind: 'model', name: 'Violation' } } },
      ],
    });
    expect(types).toEqual([
      { kind: 'model', name: 'ApiError' },
      { kind: 'model', name: 'Outage' },
      { kind: 'array', items: { kind: 'model', name: 'Violation' } },
    ]);
  });

  it('yields nothing for an operation without fallback responses, or with bodiless ones', () => {
    expect(collectFallbackResponseTypes(baseOperation)).toEqual([]);
    expect(
      collectFallbackResponseTypes({ ...baseOperation, defaultResponse: {}, rangeResponses: [{ range: '1XX' }] }),
    ).toEqual([]);
  });
});

describe('collectResponseBodyTypes — default and range responses', () => {
  const baseOperation = {
    name: 'getDocument',
    httpMethod: 'get' as const,
    path: '/documents/{id}',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive' as const, type: 'string' as const },
    errors: [],
    injectIdempotencyKey: false,
  };

  it('yields the fallback bodies after the secondary media types, each with the source its ref is validated under', () => {
    const html: TypeRef = { kind: 'primitive', type: 'string' };
    const apiError: TypeRef = { kind: 'model', name: 'ApiError' };
    const yamlError: TypeRef = { kind: 'model', name: 'GetDocumentDefaultApplicationYamlResponse' };
    const op: Operation = {
      ...baseOperation,
      responseContentTypes: ['application/json', 'text/html'],
      responseContents: [
        { contentType: 'application/json', type: baseOperation.response },
        { contentType: 'text/html', type: html },
      ],
      // The entry for the media type `type` was read from shares its object and is not yielded again.
      defaultResponse: {
        type: apiError,
        contentTypes: ['application/json', 'application/yaml'],
        contents: [
          { contentType: 'application/json', type: apiError },
          { contentType: 'application/yaml', type: yamlError },
        ],
      },
      rangeResponses: [
        { range: '5XX', type: { kind: 'model', name: 'Outage' } },
        { range: '2XX' },
        { range: '4XX', type: { kind: 'array', items: { kind: 'model', name: 'Violation' } } },
      ],
    };
    expect(collectResponseBodyTypes(op)).toEqual([
      { type: html, source: 'contents.text/html' },
      { type: yamlError, source: 'defaultResponse.contents.application/yaml' },
      { type: apiError, source: 'defaultResponse' },
      { type: { kind: 'model', name: 'Outage' }, source: 'rangeResponses.5XX' },
      { type: { kind: 'array', items: { kind: 'model', name: 'Violation' } }, source: 'rangeResponses.4XX' },
    ]);
    // The same bodies `collectFallbackResponseTypes` yields, in its order.
    expect(
      collectResponseBodyTypes(op)
        .slice(2)
        .map((entry) => entry.type),
    ).toEqual(collectFallbackResponseTypes(op));
  });

  it('yields nothing for an operation without fallback responses or secondary media types, or with bodiless fallbacks', () => {
    expect(collectResponseBodyTypes(baseOperation)).toEqual([]);
    expect(
      collectResponseBodyTypes({ ...baseOperation, defaultResponse: {}, rangeResponses: [{ range: '1XX' }] }),
    ).toEqual([]);
  });
});

describe('collectOperationTypeRefs', () => {
  /** A fresh, distinct reference per site, so identity tells every site apart. */
  const model = (name: string): TypeRef => ({ kind: 'model', name });
  const en = (name: string): TypeRef => ({ kind: 'enum', name, values: ['a', 'b'] });
  const KINDS = new Set(['primitive', 'array', 'model', 'enum', 'literal', 'union', 'nullable', 'map']);
  const isTypeRef = (value: unknown): value is TypeRef =>
    typeof value === 'object' && value !== null && KINDS.has((value as { kind?: unknown }).kind as string);

  /**
   * Every TypeRef reachable from the operation by walking its object graph
   * blindly — each `type` property that holds one, at any depth, without
   * descending into a TypeRef itself. What the helper must return, so a
   * field added to `Operation` later shows up here before it is listed there.
   */
  function bruteForceRefs(op: Operation): Set<TypeRef> {
    const refs = new Set<TypeRef>();
    const seen = new Set<unknown>();
    const walk = (value: unknown): void => {
      if (typeof value !== 'object' || value === null || seen.has(value)) return;
      seen.add(value);
      if (isTypeRef(value)) {
        refs.add(value);
        return;
      }
      for (const inner of Array.isArray(value) ? value : Object.values(value)) walk(inner);
    };
    walk(op);
    return refs;
  }

  // One operation carrying a reference at every site the IR has: parameters
  // in every location (the body-owned query parameter included, and a
  // parameter group pointing at the same objects), a request body with two
  // other media types, a primary and a second success body with headers and
  // alternate contents, an error with a body, headers and an alternate
  // content, a default and a range response likewise, and a pagination item
  // type and envelope field.
  const primary = model('ListPetsResponse');
  const primaryHeaders = [{ name: 'X-Mode', type: en('PetsXMode'), required: false }];
  const primaryContents = [
    { contentType: 'application/json', type: primary },
    { contentType: 'text/html', type: model('ListPetsTextHtmlResponse') },
  ];
  const queryFilter = { name: 'filter', type: model('PetsFilter'), required: false };
  const op: Operation = {
    name: 'listPets',
    httpMethod: 'post',
    path: '/pets/{id}',
    pathParams: [{ name: 'id', type: model('PetsId'), required: true }],
    queryParams: [queryFilter],
    bodyOwnedQueryParams: [{ name: 'owned', type: en('PetsOwned'), required: false }],
    headerParams: [{ name: 'X-Trace', type: model('PetsXTrace'), required: false }],
    cookieParams: [{ name: 'session', type: model('PetsSession'), required: false }],
    parameterGroups: [
      { name: 'selector', optional: true, variants: [{ name: 'by_filter', parameters: [queryFilter] }] },
    ],
    requestBody: model('ListPetsRequest'),
    requestBodyContentTypes: ['application/json', 'application/xml', 'text/csv'],
    requestBodyContents: [
      { contentType: 'application/json', type: model('ListPetsRequest') },
      { contentType: 'application/xml', type: model('ListPetsApplicationXmlRequest') },
      { contentType: 'text/csv', type: en('ListPetsTextCsvRequest') },
    ],
    response: primary,
    responseHeaders: primaryHeaders,
    responseContentTypes: ['application/json', 'text/html'],
    responseContents: primaryContents,
    successResponses: [
      {
        statusCode: 200,
        type: primary,
        headers: primaryHeaders,
        contentTypes: ['application/json', 'text/html'],
        contents: primaryContents,
      },
      {
        statusCode: 202,
        type: model('ListPetsResponse202'),
        headers: [{ name: 'Retry-After', type: model('PetsRetryAfter'), required: false }],
        contentTypes: ['application/json'],
        contents: [{ contentType: 'application/json', type: model('ListPetsResponse202') }],
      },
    ],
    errors: [
      {
        statusCode: 404,
        description: 'nf',
        type: model('ListPetsError404'),
        headers: [{ name: 'X-Reason', type: en('PetsXReason'), required: false }],
        contentTypes: ['application/json', 'text/plain'],
        contents: [
          { contentType: 'application/json', type: model('ListPetsError404') },
          { contentType: 'text/plain', type: { kind: 'primitive', type: 'string' } },
        ],
      },
    ],
    defaultResponse: {
      type: model('ListPetsDefaultResponse'),
      headers: [{ name: 'X-Default', type: model('PetsXDefault'), required: false }],
      contentTypes: ['application/json', 'application/yaml'],
      contents: [
        { contentType: 'application/json', type: model('ListPetsDefaultResponse') },
        { contentType: 'application/yaml', type: model('ListPetsDefaultApplicationYamlResponse') },
      ],
    },
    rangeResponses: [
      {
        range: '5XX',
        type: model('ListPetsServerErrorResponse'),
        headers: [{ name: 'X-Outage', type: model('PetsXOutage'), required: false }],
      },
    ],
    pagination: {
      strategy: 'cursor',
      param: 'after',
      itemType: model('Pet'),
      envelopeFields: [{ name: 'list_metadata', type: model('ListMetadata'), required: true }],
    },
    injectIdempotencyKey: false,
  };

  it('returns every type reference the operation carries, and nothing else', () => {
    const expected = bruteForceRefs(op);
    const returned = collectOperationTypeRefs(op);
    // A reference shared by two sites (the primary body and its
    // successResponses entry, a group's parameter and its location list) is
    // one object, so the comparison is by identity.
    expect(new Set(returned)).toEqual(expected);
    expect(expected.size).toBeGreaterThanOrEqual(22);
  });

  it('reaches the other request media types through collectRequestBodyTypes, as the other response bodies through collectResponseBodyTypes', () => {
    const returned = new Set(collectOperationTypeRefs(op));
    for (const { type } of collectRequestBodyTypes(op)) expect(returned.has(type)).toBe(true);
    for (const { type } of collectResponseBodyTypes(op)) expect(returned.has(type)).toBe(true);
    for (const header of collectResponseHeaders(op)) expect(returned.has(header.type)).toBe(true);
    // The `text/csv` body is reached by no other field: only its entry carries it.
    const csv = op.requestBodyContents!.find((c) => c.contentType === 'text/csv')!.type;
    expect(returned.has(csv)).toBe(true);
  });

  it('lists a bare operation’s response alone', () => {
    const bare: Operation = {
      name: 'ping',
      httpMethod: 'get',
      path: '/ping',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive', type: 'unknown' },
      errors: [],
      injectIdempotencyKey: false,
    };
    expect(collectOperationTypeRefs(bare)).toEqual([bare.response]);
    expect(new Set(collectOperationTypeRefs(bare))).toEqual(bruteForceRefs(bare));
  });
});
