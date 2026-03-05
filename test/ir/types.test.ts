import { describe, it, expect } from 'vitest';
import type {
  ApiSpec,
  TypeRef,
  PrimitiveType,
  ArrayType,
  ModelRef,
  NullableType,
  UnionType,
  Model,
  Enum,
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
              paginated: true,
              idempotent: false,
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
    expect(spec.services[0].operations[0].paginated).toBe(true);
    expect(spec.models).toHaveLength(1);
  });
});
