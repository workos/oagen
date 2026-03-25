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
} from '../../src/ir/types.js';
import {
  walkTypeRef,
  mapTypeRef,
  collectModelRefs,
  collectEnumRefs,
  collectFieldDependencies,
  assignModelsToServices,
  collectRequestBodyModels,
} from '../../src/ir/types.js';

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
