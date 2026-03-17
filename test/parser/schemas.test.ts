import { describe, it, expect, vi } from 'vitest';
import { extractSchemas, schemaToTypeRef } from '../../src/parser/schemas.js';

describe('extractSchemas – backend suffix stripping', () => {
  it('strips Dto suffix from schema names', () => {
    const { models } = extractSchemas({
      CreateOrganizationDto: {
        type: 'object',
        properties: { name: { type: 'string' } },
      },
    });
    expect(models[0].name).toBe('CreateOrganization');
  });

  it('strips Controller suffix and singularizes schema names', () => {
    const { models } = extractSchemas({
      OrganizationsController: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    });
    expect(models[0].name).toBe('Organization');
  });

  it('does not strip suffix from the middle of a name', () => {
    const { models } = extractSchemas({
      DtoValidator: {
        type: 'object',
        properties: { valid: { type: 'boolean' } },
      },
    });
    expect(models[0].name).toBe('DtoValidator');
  });
});

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
    expect(ref).toEqual({ kind: 'enum', name: 'Status', values: ['a', 'b'] });
  });

  it('resolves $ref to named ModelRef', () => {
    const ref = schemaToTypeRef({ $ref: '#/components/schemas/ValidateApiKeyDto' });
    expect(ref).toEqual({ kind: 'model', name: 'ValidateApiKey' });
  });

  it('resolves $ref with PascalCase name preserved', () => {
    const ref = schemaToTypeRef({ $ref: '#/components/schemas/ListMetadata' });
    expect(ref).toEqual({ kind: 'model', name: 'ListMetadata' });
  });

  it('resolves $ref with kebab-case name to PascalCase', () => {
    const ref = schemaToTypeRef({ $ref: '#/components/schemas/api-key-response' });
    expect(ref).toEqual({ kind: 'model', name: 'ApiKeyResponse' });
  });

  it('$ref takes priority over other schema properties', () => {
    const ref = schemaToTypeRef({
      $ref: '#/components/schemas/UserDto',
      type: 'object',
      properties: { id: { type: 'string' } },
    });
    expect(ref).toEqual({ kind: 'model', name: 'User' });
  });

  it('strips DTO suffix from $ref targets', () => {
    const ref = schemaToTypeRef({ $ref: '#/components/schemas/ValidateApiKeyDTO' });
    expect(ref).toEqual({ kind: 'model', name: 'ValidateApiKey' });
  });

  it('falls through on malformed $ref with no segments', () => {
    const ref = schemaToTypeRef({ $ref: '', type: 'string' });
    expect(ref).toEqual({ kind: 'primitive', type: 'string' });
  });

  it('treats empty schema as unknown primitive', () => {
    const ref = schemaToTypeRef({}, 'unknownField');
    expect(ref).toEqual({ kind: 'primitive', type: 'unknown' });
  });

  it('warns on ignored additionalProperties with object schema that also has properties', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ref = schemaToTypeRef(
        {
          type: 'object',
          properties: { id: { type: 'string' } },
          additionalProperties: { type: 'string' },
        },
        'myField',
      );
      // Model fields are still extracted correctly
      expect(ref).toEqual({ kind: 'model', name: 'MyField' });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('additionalProperties with object schema ignored'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('maps freeform object to MapType with unknown value', () => {
    const ref = schemaToTypeRef({ type: 'object' });
    expect(ref).toEqual({ kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } });
  });

  it('maps object with additionalProperties schema to MapType', () => {
    const ref = schemaToTypeRef({
      type: 'object',
      additionalProperties: { type: 'integer' },
    });
    expect(ref).toEqual({ kind: 'map', valueType: { kind: 'primitive', type: 'integer' } });
  });

  it('maps object with additionalProperties: true to MapType with unknown value', () => {
    const ref = schemaToTypeRef({
      type: 'object',
      additionalProperties: true,
    });
    expect(ref).toEqual({ kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } });
  });

  it('handles combined OAS 3.1 type array and 3.0 nullable without double-wrapping', () => {
    const ref = schemaToTypeRef({ type: ['string', 'null'], nullable: true });
    expect(ref).toEqual({
      kind: 'nullable',
      inner: { kind: 'primitive', type: 'string' },
    });
    // Should NOT be double-wrapped as nullable(nullable(string))
    if (ref.kind === 'nullable') {
      expect(ref.inner.kind).not.toBe('nullable');
    }
  });
});
