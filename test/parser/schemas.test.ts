import { describe, it, expect } from 'vitest';
import { extractSchemas, schemaToTypeRef } from '../../src/parser/schemas.js';

describe('extractSchemas', () => {
  it('extracts a simple model', () => {
    const schemas = {
      User: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          age: { type: 'integer' },
        },
      },
    };

    const { models, enums } = extractSchemas(schemas);
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('User');
    expect(models[0].fields).toHaveLength(3);
    expect(models[0].fields[0]).toEqual({
      name: 'id',
      type: { kind: 'primitive', type: 'string', format: 'uuid' },
      required: true,
      description: undefined,
    });
    expect(models[0].fields[2].type).toEqual({
      kind: 'primitive',
      type: 'integer',
    });
    expect(enums).toHaveLength(0);
  });

  it('extracts an enum', () => {
    const schemas = {
      Status: {
        type: 'string',
        enum: ['active', 'inactive', 'pending'],
      },
    };

    const { models, enums } = extractSchemas(schemas);
    expect(enums).toHaveLength(1);
    expect(enums[0].name).toBe('Status');
    expect(enums[0].values).toEqual([
      { name: 'ACTIVE', value: 'active', description: undefined },
      { name: 'INACTIVE', value: 'inactive', description: undefined },
      { name: 'PENDING', value: 'pending', description: undefined },
    ]);
    expect(models).toHaveLength(0);
  });

  it('extracts allOf model by merging fields', () => {
    const schemas = {
      Member: {
        allOf: [
          {
            type: 'object' as const,
            required: ['id'],
            properties: {
              id: { type: 'string' },
            },
          },
          {
            type: 'object' as const,
            required: ['name'],
            properties: {
              name: { type: 'string' },
            },
          },
        ],
      },
    };

    const { models } = extractSchemas(schemas);
    expect(models).toHaveLength(1);
    expect(models[0].fields).toHaveLength(2);
    expect(models[0].fields[0].name).toBe('id');
    expect(models[0].fields[0].required).toBe(true);
    expect(models[0].fields[1].name).toBe('name');
    expect(models[0].fields[1].required).toBe(true);
  });

  it('returns empty for undefined schemas', () => {
    const { models, enums } = extractSchemas(undefined);
    expect(models).toHaveLength(0);
    expect(enums).toHaveLength(0);
  });
});

describe('schemaToTypeRef', () => {
  it('maps string to PrimitiveType', () => {
    expect(schemaToTypeRef({ type: 'string' })).toEqual({
      kind: 'primitive',
      type: 'string',
    });
  });

  it('maps string with format', () => {
    expect(schemaToTypeRef({ type: 'string', format: 'date-time' })).toEqual({
      kind: 'primitive',
      type: 'string',
      format: 'date-time',
    });
  });

  it('maps integer', () => {
    expect(schemaToTypeRef({ type: 'integer' })).toEqual({
      kind: 'primitive',
      type: 'integer',
    });
  });

  it('maps boolean', () => {
    expect(schemaToTypeRef({ type: 'boolean' })).toEqual({
      kind: 'primitive',
      type: 'boolean',
    });
  });

  it('maps array type', () => {
    const ref = schemaToTypeRef({
      type: 'array',
      items: { type: 'string' },
    });
    expect(ref).toEqual({
      kind: 'array',
      items: { kind: 'primitive', type: 'string' },
    });
  });

  it('maps OAS 3.1 nullable type array', () => {
    const ref = schemaToTypeRef({ type: ['string', 'null'] });
    expect(ref).toEqual({
      kind: 'nullable',
      inner: { kind: 'primitive', type: 'string' },
    });
  });

  it('maps OAS 3.0 nullable flag', () => {
    const ref = schemaToTypeRef({ type: 'string', nullable: true });
    expect(ref).toEqual({
      kind: 'nullable',
      inner: { kind: 'primitive', type: 'string' },
    });
  });

  it('maps oneOf to UnionType', () => {
    const ref = schemaToTypeRef({
      oneOf: [{ type: 'string' }, { type: 'integer' }],
    });
    expect(ref.kind).toBe('union');
    if (ref.kind === 'union') {
      expect(ref.variants).toHaveLength(2);
    }
  });

  it('maps oneOf with discriminator', () => {
    const ref = schemaToTypeRef({
      oneOf: [
        { type: 'object', properties: { type: { type: 'string' } } },
        { type: 'object', properties: { type: { type: 'string' } } },
      ],
      discriminator: {
        propertyName: 'type',
        mapping: { a: 'SchemaA', b: 'SchemaB' },
      },
    });
    expect(ref.kind).toBe('union');
    if (ref.kind === 'union') {
      expect(ref.discriminator).toEqual({
        property: 'type',
        mapping: { a: 'SchemaA', b: 'SchemaB' },
      });
    }
  });

  it('maps enum schema to EnumRef', () => {
    const ref = schemaToTypeRef({ type: 'string', enum: ['a', 'b'] }, 'status');
    expect(ref).toEqual({ kind: 'enum', name: 'Status' });
  });
});
