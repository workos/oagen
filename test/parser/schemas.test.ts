import { describe, it, expect } from 'vitest';
import { extractSchemas, schemaToTypeRef } from '../../src/parser/schemas.js';

describe('extractSchemas – backend suffix handling', () => {
  it('preserves Dto suffix in schema names', () => {
    const { models } = extractSchemas({
      CreateOrganizationDto: {
        type: 'object',
        properties: { name: { type: 'string' } },
      },
    });
    expect(models[0].name).toBe('CreateOrganizationDto');
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

describe('extractSchemas – no Dto collision since Dto is preserved', () => {
  it('keeps both models when Dto suffix is preserved (no name collision)', () => {
    const { models } = extractSchemas({
      RedirectUriDto: {
        type: 'object',
        properties: {
          uri: { type: 'string' },
          default: { type: 'boolean' },
        },
      },
      RedirectUri: {
        type: 'object',
        properties: {
          object: { type: 'string' },
          id: { type: 'string' },
          uri: { type: 'string' },
          default: { type: 'boolean' },
          created_at: { type: 'string' },
          updated_at: { type: 'string' },
        },
      },
    });
    const redirectUriDto = models.filter((m) => m.name === 'RedirectUriDto');
    expect(redirectUriDto).toHaveLength(1);
    expect(redirectUriDto[0].fields).toHaveLength(2);
    const redirectUri = models.filter((m) => m.name === 'RedirectUri');
    expect(redirectUri).toHaveLength(1);
    expect(redirectUri[0].fields).toHaveLength(6);
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

  it('extracts discriminated allOf oneOf variants as additional models', () => {
    const schemas = {
      EventSchema: {
        allOf: [
          {
            type: 'object' as const,
            required: ['id', 'event', 'data'],
            properties: {
              id: { type: 'string' },
              event: { type: 'string' },
              data: { type: 'object', additionalProperties: {} },
            },
          },
          {
            oneOf: [
              {
                type: 'object' as const,
                required: ['id', 'event', 'data'],
                properties: {
                  id: { type: 'string' },
                  event: { type: 'string', const: 'session.created' },
                  data: {
                    type: 'object' as const,
                    required: ['object', 'id'],
                    properties: {
                      object: { type: 'string', const: 'session' },
                      id: { type: 'string' },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    };

    const { models } = extractSchemas(schemas);
    expect(models.map((m) => m.name)).toContain('EventSchema');
    expect(models.map((m) => m.name)).toContain('SessionCreated');
    expect(models.map((m) => m.name)).toContain('SessionCreatedData');

    const variant = models.find((m) => m.name === 'SessionCreated');
    expect(variant).toBeDefined();
    expect(variant!.fields.find((f) => f.name === 'data')?.type).toEqual({
      kind: 'model',
      name: 'SessionCreatedData',
    });
  });

  it('returns empty for undefined schemas', () => {
    const { models, enums } = extractSchemas(undefined);
    expect(models).toHaveLength(0);
    expect(enums).toHaveLength(0);
  });

  it('extracts readOnly and writeOnly field annotations', () => {
    const result = extractSchemas({
      MyModel: {
        type: 'object',
        properties: {
          id: { type: 'string', readOnly: true },
          password: { type: 'string', writeOnly: true },
          name: { type: 'string' },
        },
      },
    });

    expect(result.models).toHaveLength(1);
    const fields = result.models[0].fields;

    const idField = fields.find((f) => f.name === 'id');
    expect(idField).toBeDefined();
    expect(idField!.readOnly).toBe(true);
    expect(idField!.writeOnly).toBeUndefined();

    const passwordField = fields.find((f) => f.name === 'password');
    expect(passwordField).toBeDefined();
    expect(passwordField!.readOnly).toBeUndefined();
    expect(passwordField!.writeOnly).toBe(true);

    const nameField = fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.readOnly).toBeUndefined();
    expect(nameField!.writeOnly).toBeUndefined();
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

  it('resolves $ref to named ModelRef preserving Dto', () => {
    const ref = schemaToTypeRef({ $ref: '#/components/schemas/ValidateApiKeyDto' });
    expect(ref).toEqual({ kind: 'model', name: 'ValidateApiKeyDto' });
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
    expect(ref).toEqual({ kind: 'model', name: 'UserDto' });
  });

  it('preserves DTO suffix in $ref targets (normalized to Dto by PascalCase)', () => {
    const ref = schemaToTypeRef({ $ref: '#/components/schemas/ValidateApiKeyDTO' });
    expect(ref).toEqual({ kind: 'model', name: 'ValidateApiKeyDto' });
  });

  it('falls through on malformed $ref with no segments', () => {
    const ref = schemaToTypeRef({ $ref: '', type: 'string' });
    expect(ref).toEqual({ kind: 'primitive', type: 'string' });
  });

  it('treats empty schema as unknown primitive', () => {
    const ref = schemaToTypeRef({}, 'unknownField');
    expect(ref).toEqual({ kind: 'primitive', type: 'unknown' });
  });

  it('returns model ref for object with both properties and additionalProperties', () => {
    const ref = schemaToTypeRef(
      {
        type: 'object',
        properties: { id: { type: 'string' } },
        additionalProperties: { type: 'string' },
      },
      'myField',
    );
    // Model ref is returned — extractModel surfaces additionalProperties as a map field
    expect(ref).toEqual({ kind: 'model', name: 'MyField' });
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

  it('allOf with $ref and augmentation returns merged model ref', () => {
    const ref = schemaToTypeRef(
      {
        allOf: [
          { $ref: '#/components/schemas/BaseModel' },
          { type: 'object', properties: { extra: { type: 'string' } } },
        ],
      },
      'myField',
    );
    expect(ref).toEqual({ kind: 'model', name: 'MyField' });
  });

  it('allOf with $ref only (no augmentation) returns the ref', () => {
    const ref = schemaToTypeRef(
      {
        allOf: [{ $ref: '#/components/schemas/BaseModel' }, { description: 'Just a description, no properties' }],
      },
      'myField',
    );
    expect(ref).toEqual({ kind: 'model', name: 'BaseModel' });
  });

  it('discriminator mapping strips #/components/schemas/ prefix', () => {
    const ref = schemaToTypeRef({
      oneOf: [
        { type: 'object', properties: { type: { type: 'string' } } },
        { type: 'object', properties: { type: { type: 'string' } } },
      ],
      discriminator: {
        propertyName: 'type',
        mapping: {
          a: '#/components/schemas/SchemaA',
          b: 'SchemaB',
        },
      },
    });
    expect(ref.kind).toBe('union');
    if (ref.kind === 'union') {
      expect(ref.discriminator!.mapping).toEqual({ a: 'SchemaA', b: 'SchemaB' });
    }
  });

  it('inline enum preserves numeric values', () => {
    const ref = schemaToTypeRef({ type: 'integer', enum: [1, 2, 3] }, 'status');
    expect(ref.kind).toBe('enum');
    if (ref.kind === 'enum') {
      expect(ref.values).toEqual([1, 2, 3]);
    }
  });

  it('const object returns map type', () => {
    const ref = schemaToTypeRef({ const: { key: 'value' } });
    expect(ref).toEqual({ kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } });
  });

  it('const array returns array type', () => {
    const ref = schemaToTypeRef({ const: [1, 2, 3] });
    expect(ref).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'unknown' } });
  });

  it('unknown schema fallback returns unknown, not string', () => {
    // Schema with an unrecognized type (not string/integer/number/boolean/array/object)
    const ref = schemaToTypeRef({ type: 'file' }, 'testField');
    expect(ref).toEqual({ kind: 'primitive', type: 'unknown' });
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
