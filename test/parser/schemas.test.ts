import { describe, it, expect, afterEach } from 'vitest';
import { extractSchemas, schemaToTypeRef, clearSchemaNameTransform } from '../../src/parser/schemas.js';

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
    expect(enums[0].default).toBeUndefined();
    expect(models).toHaveLength(0);
  });

  it('captures default on enum when present and a member', () => {
    const schemas = {
      PaginationOrder: {
        type: 'string',
        enum: ['normal', 'desc', 'asc'],
        default: 'desc',
      },
    };

    const { enums } = extractSchemas(schemas);
    expect(enums).toHaveLength(1);
    expect(enums[0].default).toBe('desc');
  });

  it('drops default that is not a member of the enum values', () => {
    const schemas = {
      Status: {
        type: 'string',
        enum: ['active', 'inactive'],
        default: 'archived',
      },
    };

    const { enums } = extractSchemas(schemas);
    expect(enums).toHaveLength(1);
    expect(enums[0].default).toBeUndefined();
  });

  it('captures numeric enum default', () => {
    const schemas = {
      Priority: {
        type: 'integer',
        enum: [0, 1, 2],
        default: 1,
      },
    };

    const { enums } = extractSchemas(schemas);
    expect(enums).toHaveLength(1);
    expect(enums[0].default).toBe(1);
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

describe('nullable enum components (#174)', () => {
  // OAS 3.1 lets `null` appear in `enum:` next to `type: [x, 'null']`. The
  // `null` is a nullability marker, not a member, and a `$ref` to such a
  // component must carry that nullability instead of dropping it.

  it('drops a null enum member instead of stringifying it to "null"', () => {
    const { enums } = extractSchemas({
      MemberForm: { type: ['string', 'null'], enum: ['a', 'b', null] },
    });
    expect(enums).toHaveLength(1);
    expect(enums[0].name).toBe('MemberForm');
    expect(enums[0].values.map((v) => v.name)).toEqual(['A', 'B']);
    expect(enums[0].values.map((v) => v.value)).toEqual(['a', 'b']);
  });

  it('issue repro: $ref to a nullable enum component has the same shape as the oneOf-null form', () => {
    const { models, enums } = extractSchemas({
      Thing: {
        type: 'object',
        properties: {
          asEnumMember: { $ref: '#/components/schemas/MemberForm' },
          asUnion: { oneOf: [{ $ref: '#/components/schemas/UnionForm' }, { type: 'null' }] },
        },
        required: ['asEnumMember', 'asUnion'],
      },
      MemberForm: { type: ['string', 'null'], enum: ['a', 'b', null] },
      UnionForm: { type: 'string', enum: ['a', 'b'] },
    });
    const thing = models.find((m) => m.name === 'Thing')!;
    const asEnumMember = thing.fields.find((f) => f.name === 'asEnumMember')!;
    const asUnion = thing.fields.find((f) => f.name === 'asUnion')!;
    expect(asEnumMember.type).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'MemberForm' } });
    expect(asUnion.type).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'UnionForm' } });

    const memberForm = enums.find((e) => e.name === 'MemberForm')!;
    expect(memberForm.values.map((v) => v.value)).toEqual(['a', 'b']);
    expect(memberForm.values.some((v) => v.name === 'NULL')).toBe(false);
    const unionForm = enums.find((e) => e.name === 'UnionForm')!;
    expect(unionForm.values.map((v) => v.value)).toEqual(['a', 'b']);
  });

  it('resolves $ref to an OAS 3.0 `nullable: true` enum component as nullable(enum)', () => {
    const { models, enums } = extractSchemas({
      Thing: { type: 'object', properties: { state: { $ref: '#/components/schemas/State' } } },
      State: { type: 'string', nullable: true, enum: ['on', 'off'] },
    });
    const state = models.find((m) => m.name === 'Thing')!.fields.find((f) => f.name === 'state')!;
    expect(state.type).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'State' } });
    expect(enums.find((e) => e.name === 'State')!.values.map((v) => v.value)).toEqual(['on', 'off']);
  });

  it('resolves $ref to a component that is nullable only via a null enum member as nullable(enum)', () => {
    const { models, enums } = extractSchemas({
      Thing: { type: 'object', properties: { state: { $ref: '#/components/schemas/State' } } },
      State: { type: 'string', enum: ['on', 'off', null] },
    });
    const state = models.find((m) => m.name === 'Thing')!.fields.find((f) => f.name === 'state')!;
    expect(state.type).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'State' } });
    expect(enums.find((e) => e.name === 'State')!.values.map((v) => v.value)).toEqual(['on', 'off']);
  });

  it('still resolves $ref to a non-nullable enum component as a bare enum ref', () => {
    const { models } = extractSchemas({
      Thing: { type: 'object', properties: { state: { $ref: '#/components/schemas/State' } } },
      State: { type: 'string', enum: ['on', 'off'] },
    });
    const state = models.find((m) => m.name === 'Thing')!.fields.find((f) => f.name === 'state')!;
    expect(state.type).toEqual({ kind: 'enum', name: 'State' });
  });

  it('wraps oneOf: [{ $ref: NullableEnum }, { type: null }] exactly once', () => {
    const { models } = extractSchemas({
      Thing: {
        type: 'object',
        properties: {
          state: { oneOf: [{ $ref: '#/components/schemas/State' }, { type: 'null' }] },
        },
      },
      State: { type: ['string', 'null'], enum: ['on', 'off', null] },
    });
    const state = models.find((m) => m.name === 'Thing')!.fields.find((f) => f.name === 'state')!;
    expect(state.type).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'State' } });
  });

  it('wraps anyOf: [{ $ref: NullableEnum }, { type: null }] exactly once', () => {
    const { models } = extractSchemas({
      Thing: {
        type: 'object',
        properties: {
          state: { anyOf: [{ $ref: '#/components/schemas/State' }, { type: 'null' }] },
        },
      },
      State: { type: 'string', nullable: true, enum: ['on', 'off'] },
    });
    const state = models.find((m) => m.name === 'Thing')!.fields.find((f) => f.name === 'state')!;
    expect(state.type).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'State' } });
  });

  it('carries nullability through an array of $ref to a nullable enum', () => {
    const { models } = extractSchemas({
      Thing: {
        type: 'object',
        properties: {
          states: { type: 'array', items: { $ref: '#/components/schemas/State' } },
        },
      },
      State: { type: ['string', 'null'], enum: ['on', 'off', null] },
    });
    const states = models.find((m) => m.name === 'Thing')!.fields.find((f) => f.name === 'states')!;
    expect(states.type).toEqual({
      kind: 'array',
      items: { kind: 'nullable', inner: { kind: 'enum', name: 'State' } },
    });
  });

  it('does not adopt `default: null` as the enum default', () => {
    const { enums } = extractSchemas({
      State: { type: ['string', 'null'], enum: ['on', 'off', null], default: null },
    });
    expect(enums[0].default).toBeUndefined();
    expect(enums[0].values.map((v) => v.value)).toEqual(['on', 'off']);
  });

  it('keeps a real default on a nullable enum component', () => {
    const { enums } = extractSchemas({
      State: { type: ['string', 'null'], enum: ['on', 'off', null], default: 'on' },
    });
    expect(enums[0].default).toBe('on');
  });

  it('clears nullable enum tracking alongside the enum set', () => {
    extractSchemas({ State: { type: ['string', 'null'], enum: ['on', 'off', null] } });
    expect(schemaToTypeRef({ $ref: '#/components/schemas/State' })).toEqual({
      kind: 'nullable',
      inner: { kind: 'enum', name: 'State' },
    });
    clearSchemaNameTransform();
    // With no extraction active, a $ref is not known to be an enum at all.
    expect(schemaToTypeRef({ $ref: '#/components/schemas/State' })).toEqual({ kind: 'model', name: 'State' });
  });

  describe('inline field enums', () => {
    it('maps `type: [string, null], enum: [a, b, null]` to nullable(enum) without a "null" member', () => {
      const ref = schemaToTypeRef({ type: ['string', 'null'], enum: ['a', 'b', null] }, 'status');
      expect(ref).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'Status', values: ['a', 'b'] } });
    });

    it('maps `type: string, enum: [a, b, null]` (null member only) to nullable(enum)', () => {
      const ref = schemaToTypeRef({ type: 'string', enum: ['a', 'b', null] }, 'status');
      expect(ref).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'Status', values: ['a', 'b'] } });
    });

    it('maps `type: string, nullable: true, enum: [a, b, null]` to nullable(enum) wrapped once', () => {
      const ref = schemaToTypeRef({ type: 'string', nullable: true, enum: ['a', 'b', null] }, 'status');
      expect(ref).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'Status', values: ['a', 'b'] } });
    });

    it('maps `enum: [a, null]` to a nullable literal, not a two-member enum', () => {
      const ref = schemaToTypeRef({ type: ['string', 'null'], enum: ['a', null] }, 'status');
      expect(ref).toEqual({ kind: 'nullable', inner: { kind: 'literal', value: 'a' } });
    });

    it('leaves a non-nullable inline enum untouched', () => {
      const ref = schemaToTypeRef({ type: 'string', enum: ['a', 'b'] }, 'status');
      expect(ref).toEqual({ kind: 'enum', name: 'Status', values: ['a', 'b'] });
    });

    it('promotes an inline nullable enum to a top-level enum without a NULL member', () => {
      const { enums } = extractSchemas({
        Thing: {
          type: 'object',
          properties: { status: { type: ['string', 'null'], enum: ['a', 'b', null] } },
        },
      });
      expect(enums).toHaveLength(1);
      expect(enums[0].values.map((v) => v.value)).toEqual(['a', 'b']);
      expect(enums[0].values.map((v) => v.name)).toEqual(['A', 'B']);
    });
  });
});

describe('extractSchemas – schemaNameTransform receives the original schema name (issue #175)', () => {
  // extractSchemas() leaves the transform active for later extraction phases;
  // clear it so no other test in this file sees it.
  afterEach(() => clearSchemaNameTransform());

  const schemas = {
    Thing: {
      type: 'object',
      properties: {
        http: { $ref: '#/components/schemas/HTTPConfig' },
        url: { $ref: '#/components/schemas/URL' },
        settings: { $ref: '#/components/schemas/Settings' },
      },
    },
    HTTPConfig: { type: 'object', properties: { timeout: { type: 'number' } } },
    URL: { type: 'object', properties: { href: { type: 'string' } } },
    Settings: { type: 'object', properties: { locale: { type: 'string' } } },
  };

  it('normalises component names by default (no transform)', () => {
    const { models } = extractSchemas(schemas);
    expect(models.map((m) => m.name).sort()).toEqual(['HttpConfig', 'Setting', 'Thing', 'Url']);
  });

  it('calls the transform with (cleanedName, originalName) for component schemas', () => {
    const calls: Array<[string, string | undefined]> = [];
    extractSchemas(schemas, {
      schemaNameTransform: (name, originalName) => {
        calls.push([name, originalName]);
        return name;
      },
    });
    expect(calls).toContainEqual(['HttpConfig', 'HTTPConfig']);
    expect(calls).toContainEqual(['Setting', 'Settings']);
    expect(calls).toContainEqual(['Url', 'URL']);
    expect(calls).toContainEqual(['Thing', 'Thing']);
  });

  it('keeps one-arg transforms working unchanged', () => {
    const { models } = extractSchemas(schemas, { schemaNameTransform: (name) => name });
    expect(models.map((m) => m.name).sort()).toEqual(['HttpConfig', 'Setting', 'Thing', 'Url']);
  });

  it('returning originalName restores the document spelling for declarations and $ref fields alike', () => {
    const { models } = extractSchemas(schemas, {
      schemaNameTransform: (name, originalName) => originalName ?? name,
    });
    expect(models.map((m) => m.name).sort()).toEqual(['HTTPConfig', 'Settings', 'Thing', 'URL']);

    const thing = models.find((m) => m.name === 'Thing')!;
    const fieldType = (fieldName: string) => thing.fields.find((f) => f.name === fieldName)!.type;
    expect(fieldType('http')).toEqual({ kind: 'model', name: 'HTTPConfig' });
    expect(fieldType('url')).toEqual({ kind: 'model', name: 'URL' });
    expect(fieldType('settings')).toEqual({ kind: 'model', name: 'Settings' });
  });

  it('resolves $ref to a component enum under the original spelling', () => {
    const { enums, models } = extractSchemas(
      {
        Widget: { type: 'object', properties: { mode: { $ref: '#/components/schemas/HTTPMode' } } },
        HTTPMode: { type: 'string', enum: ['get', 'post'] },
      },
      { schemaNameTransform: (name, originalName) => originalName ?? name },
    );
    expect(enums.map((e) => e.name)).toEqual(['HTTPMode']);
    const widget = models.find((m) => m.name === 'Widget')!;
    expect(widget.fields.find((f) => f.name === 'mode')!.type).toEqual({ kind: 'enum', name: 'HTTPMode' });
  });

  it('passes no originalName for inline enum names oagen synthesises', () => {
    const calls: Array<[string, string | undefined]> = [];
    extractSchemas(
      {
        Widget: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['active', 'inactive'] } },
        },
      },
      {
        schemaNameTransform: (name, originalName) => {
          calls.push([name, originalName]);
          return name;
        },
      },
    );
    expect(calls).toContainEqual(['Widget', 'Widget']);
    expect(calls).toContainEqual(['WidgetStatus', undefined]);
    for (const [name, originalName] of calls) {
      if (name === 'WidgetStatus') expect(originalName).toBeUndefined();
    }
  });

  it('keeps cleaned names when an originalName-based transform would collide', () => {
    // UserDto and User clean to different names, but a transform that strips
    // `Dto` from the original spelling maps both to `User`. The existing
    // collision guard must still disable the transform for both.
    const { models } = extractSchemas(
      {
        UserDto: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
        User: { type: 'object', properties: { id: { type: 'string' } } },
      },
      { schemaNameTransform: (name, originalName) => (originalName ?? name).replace(/Dto$/, '') },
    );
    expect(models.map((m) => m.name).sort()).toEqual(['User', 'UserDto']);
  });

  it('tracks collisions by raw key so a colliding cleaned name does not disable the transform for its siblings', () => {
    // `Users` and `User` both clean to `User`. With an originalName-based
    // transform, `UserDto` and `User` collide on `User` (both kept as cleaned),
    // but `Users` transforms to the distinct `Users` and must keep its own
    // definition instead of being merged into `User` and dropped.
    const { models } = extractSchemas(
      {
        UserDto: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
        User: { type: 'object', properties: { id: { type: 'string' } } },
        Users: { type: 'object', properties: { data: { type: 'array', items: { type: 'string' } } } },
      },
      { schemaNameTransform: (name, originalName) => (originalName ?? name).replace(/Dto$/, '') },
    );
    expect(models.map((m) => m.name).sort()).toEqual(['User', 'UserDto', 'Users']);
    const fieldsOf = (modelName: string) => models.find((m) => m.name === modelName)!.fields.map((f) => f.name);
    expect(fieldsOf('UserDto')).toEqual(['id', 'name']);
    expect(fieldsOf('User')).toEqual(['id']);
    expect(fieldsOf('Users')).toEqual(['data']);
  });

  it('keeps the pre-existing collision behaviour for one-arg transforms', () => {
    // Same three schemas with a one-arg Dto-stripping transform: UserDto and
    // User collide on `User` and are kept as cleaned; `Users` cleans to `User`
    // too and, as before, is merged into the single `User` model (the first
    // definition wins when field counts tie).
    const { models } = extractSchemas(
      {
        UserDto: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
        User: { type: 'object', properties: { id: { type: 'string' } } },
        Users: { type: 'object', properties: { data: { type: 'array', items: { type: 'string' } } } },
      },
      { schemaNameTransform: (name) => name.replace(/Dto$/, '') },
    );
    expect(models.map((m) => m.name).sort()).toEqual(['User', 'UserDto']);
    expect(models.find((m) => m.name === 'User')!.fields.map((f) => f.name)).toEqual(['id']);
    expect(models.find((m) => m.name === 'UserDto')!.fields.map((f) => f.name)).toEqual(['id', 'name']);
  });

  it('passes no originalName for title-derived variant names', () => {
    // A field whose oneOf has const-discriminated inline variants carrying a
    // `title` gets its discriminator mapping named via resolveSchemaName(title).
    // The title is not a component key, so the transform must not receive it
    // as originalName.
    const calls: Array<[string, string | undefined]> = [];
    extractSchemas(
      {
        Envelope: {
          type: 'object',
          properties: {
            event: {
              oneOf: [
                {
                  title: 'UserCreatedEvent',
                  type: 'object',
                  properties: { event: { const: 'user.created' }, id: { type: 'string' } },
                },
                {
                  title: 'UserDeletedEvent',
                  type: 'object',
                  properties: { event: { const: 'user.deleted' }, id: { type: 'string' } },
                },
              ],
            },
          },
        },
      },
      {
        schemaNameTransform: (name, originalName) => {
          calls.push([name, originalName]);
          return name;
        },
      },
    );
    expect(calls).toContainEqual(['Envelope', 'Envelope']);
    expect(calls).toContainEqual(['UserCreatedEvent', undefined]);
    expect(calls).toContainEqual(['UserDeletedEvent', undefined]);
    for (const [, originalName] of calls) {
      if (originalName !== undefined) expect(originalName).toBe('Envelope');
    }
  });
});

describe('extractSchemas – JSON Schema `examples` on fields (issue #189)', () => {
  it('fills example from the first entry of examples and keeps every entry', () => {
    const { models } = extractSchemas({
      Pet: {
        type: 'object',
        properties: {
          name: { type: 'string', examples: ['Rex', 'Bella'] },
          age: { type: 'integer', examples: [3] },
        },
        required: ['name'],
      },
    });
    const fields = models[0].fields.map(({ name, example, examples }) => ({ name, example, examples }));
    expect(fields).toMatchInlineSnapshot(`
      [
        {
          "example": "Rex",
          "examples": [
            "Rex",
            "Bella",
          ],
          "name": "name",
        },
        {
          "example": 3,
          "examples": [
            3,
          ],
          "name": "age",
        },
      ]
    `);
  });

  it('prefers the schema example over examples for the single value', () => {
    const { models } = extractSchemas({
      Pet: {
        type: 'object',
        properties: { name: { type: 'string', example: 'Rexie', examples: ['Rex', 'Bella'] } },
      },
    });
    const [name] = models[0].fields;
    expect(name.example).toBe('Rexie');
    expect(name.examples).toEqual(['Rex', 'Bella']);
  });

  it('keeps an explicit null example instead of falling back to examples', () => {
    const { models } = extractSchemas({
      Pet: {
        type: 'object',
        properties: { name: { type: ['string', 'null'], example: null, examples: ['Rex'] } },
      },
    });
    const [name] = models[0].fields;
    expect(name.example).toBeNull();
    expect(name.examples).toEqual(['Rex']);
  });

  it('omits examples when the schema gives none, an empty list, or a non-list', () => {
    const { models } = extractSchemas({
      Pet: {
        type: 'object',
        properties: {
          nickname: { type: 'string', example: 'Rexie' },
          empty: { type: 'string', examples: [] },
          // An OAS Example Object map where JSON Schema expects a list.
          mapped: { type: 'string', examples: { one: { value: 'x' } } } as never,
        },
      },
    });
    for (const field of models[0].fields) expect(field).not.toHaveProperty('examples');
    expect(models[0].fields.map((f) => f.example)).toEqual(['Rexie', undefined, undefined]);
  });
});
