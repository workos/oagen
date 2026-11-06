import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractSchemas,
  extractInlineModelsFromSchemas,
  schemaToTypeRef,
  clearSchemaNameTransform,
} from '../../src/parser/schemas.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import { parseSpec, type OpenApiDocument } from '../../src/parser/parse.js';
import type { ApiSpec, Field, Parameter, TypeRef } from '../../src/ir/types.js';

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

describe('a null variant written as `{ const: null }` or `{ enum: [null] }` (#394)', () => {
  afterEach(() => clearSchemaNameTransform());

  const components = (nullVariant: SchemaObject): Record<string, SchemaObject> => ({
    Thing: {
      type: 'object',
      properties: {
        name: { anyOf: [{ type: 'string', maxLength: 8 }, nullVariant] },
        status: { $ref: '#/components/schemas/Status' },
        inline_status: { oneOf: [{ const: 'on' }, { const: 'off' }, nullVariant] },
        pet: { $ref: '#/components/schemas/Pet' },
      },
    },
    Status: { oneOf: [{ const: 'on' }, { const: 'off' }, nullVariant] },
    Pet: { oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }, nullVariant] },
    Cat: { type: 'object', properties: { meow: { type: 'string' } } },
    Dog: { type: 'object', properties: { bark: { type: 'string' } } },
  });

  it('is set aside as `{ type: "null" }` is: a wrapper collapses, an enum of consts and a named union admit null', () => {
    const expected = extractSchemas(components({ type: 'null' }));
    const thing = expected.models.find((m) => m.name === 'Thing')!;
    expect(Object.fromEntries(thing.fields.map((f) => [f.name, f.type]))).toEqual({
      name: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
      status: { kind: 'nullable', inner: { kind: 'enum', name: 'Status' } },
      inline_status: { kind: 'nullable', inner: { kind: 'enum', name: 'ThingInlineStatus', values: ['on', 'off'] } },
      pet: { kind: 'nullable', inner: { kind: 'model', name: 'Pet' } },
    });
    expect(thing.fields.find((f) => f.name === 'name')?.constraints).toEqual({ maxLength: 8 });
    expect(expected.enums.map((e) => [e.name, e.values.map((v) => v.value)])).toEqual([
      ['Status', ['on', 'off']],
      ['ThingInlineStatus', ['on', 'off']],
    ]);
    for (const spelling of [
      { const: null },
      { enum: [null] },
      { enum: [null, null] },
      { nullable: true, enum: [null] },
      { const: null, description: 'No value.' },
    ]) {
      expect(extractSchemas(components(spelling)), JSON.stringify(spelling)).toEqual(expected);
    }
  });

  it('sets aside every null variant of a union, however many and however mixed', () => {
    const thing = (...nulls: SchemaObject[]): Record<string, SchemaObject> => ({
      Thing: {
        type: 'object',
        properties: {
          tag: { oneOf: [{ type: 'string' }, ...nulls] },
          pet: { oneOf: [{ type: 'object', properties: { name: { type: 'string' } } }, ...nulls] },
        },
      },
    });
    const expected = extractSchemas(thing({ type: 'null' }));
    expect(expected.models.find((m) => m.name === 'Thing')?.fields.map((f) => f.type)).toEqual([
      { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
      { kind: 'nullable', inner: { kind: 'model', name: 'ThingPet' } },
    ]);
    expect(expected.enums).toEqual([]);
    for (const nulls of [
      [{ type: 'null' }, { type: 'null' }],
      [{ type: 'null' }, { enum: [null] }],
      [{ const: null }, { enum: [null] }],
    ]) {
      expect(extractSchemas(thing(...nulls)), JSON.stringify(nulls)).toEqual(expected);
    }
  });

  it('keeps a variant that admits another value, or that a `type`, `$ref` or composition beside it types', () => {
    const string = { kind: 'primitive', type: 'string' };
    const cases: Array<[SchemaObject, unknown]> = [
      [{ enum: [null, 'x'] }, { kind: 'nullable', inner: { kind: 'literal', value: 'x' } }],
      [
        { enum: [null], const: 'x' },
        { kind: 'literal', value: 'x' },
      ],
      [
        { type: 'string', const: null },
        { kind: 'nullable', inner: { kind: 'primitive', type: 'unknown' } },
      ],
      [
        { $ref: '#/components/schemas/Cat', const: null },
        { kind: 'model', name: 'Cat' },
      ],
      [
        { allOf: [{ $ref: '#/components/schemas/Cat' }], const: null },
        { kind: 'model', name: 'Cat' },
      ],
    ];
    for (const [variant, typed] of cases) {
      expect(schemaToTypeRef({ anyOf: [{ type: 'string' }, variant] }, 'name'), JSON.stringify(variant)).toEqual({
        kind: 'union',
        variants: [string, typed],
        compositionKind: 'anyOf',
      });
    }
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

describe('extractSchemas – fields fall back to a referenced component (PR #198 review)', () => {
  const projected = (fields: Array<{ name: string; example?: unknown; examples?: unknown[] }>) =>
    fields.map(({ name, example, examples }) => ({ name, example, examples }));
  const components = {
    Category: { type: 'string', enum: ['dog', 'cat'], examples: ['dog', 'cat'] },
    Direction: { type: 'string', enum: ['asc', 'desc'], example: 'asc' },
    Plain: { type: 'string' },
  };

  it('takes example and examples from the component a field $refs', () => {
    const { models } = extractSchemas({
      ...components,
      Pet: {
        type: 'object',
        properties: {
          category: { $ref: '#/components/schemas/Category' },
          direction: { $ref: '#/components/schemas/Direction' },
          plain: { $ref: '#/components/schemas/Plain' },
        },
      },
    });
    const pet = models.find((m) => m.name === 'Pet')!;
    expect(projected(pet.fields)).toMatchInlineSnapshot(`
      [
        {
          "example": "dog",
          "examples": [
            "dog",
            "cat",
          ],
          "name": "category",
        },
        {
          "example": "asc",
          "examples": undefined,
          "name": "direction",
        },
        {
          "example": undefined,
          "examples": undefined,
          "name": "plain",
        },
      ]
    `);
    expect(pet.fields[1]).not.toHaveProperty('examples');
    expect(pet.fields[2]).not.toHaveProperty('examples');
  });

  it('prefers the field schema over the referenced component, and keeps an explicit null', () => {
    const { models } = extractSchemas({
      ...components,
      Pet: {
        type: 'object',
        properties: {
          own: { $ref: '#/components/schemas/Category', examples: ['own'] },
          nulled: { $ref: '#/components/schemas/Category', example: null },
        },
      },
    });
    const pet = models.find((m) => m.name === 'Pet')!;
    expect(projected(pet.fields)).toEqual([
      { name: 'own', example: 'own', examples: ['own'] },
      // `example` stops at the field's explicit null; `examples` still
      // walks on to the component's list.
      { name: 'nulled', example: null, examples: ['dog', 'cat'] },
    ]);
  });

  it('reaches fields declared through allOf composition', () => {
    const { models } = extractSchemas({
      ...components,
      Base: { type: 'object', properties: { direction: { $ref: '#/components/schemas/Direction' } } },
      Pet: {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          { type: 'object', properties: { category: { $ref: '#/components/schemas/Category' } } },
        ],
      },
    });
    const pet = models.find((m) => m.name === 'Pet')!;
    expect(projected(pet.fields)).toEqual([
      { name: 'direction', example: 'asc', examples: undefined },
      { name: 'category', example: 'dog', examples: ['dog', 'cat'] },
    ]);
  });

  it('reaches fields of inline models nested under a component', () => {
    const inlineModels = extractInlineModelsFromSchemas({
      ...components,
      Pet: {
        type: 'object',
        properties: {
          owner: {
            type: 'object',
            properties: { preference: { $ref: '#/components/schemas/Category' } },
          },
        },
      },
    });
    const owner = inlineModels.find((m) => m.name === 'PetOwner')!;
    expect(projected(owner.fields)).toEqual([{ name: 'preference', example: 'dog', examples: ['dog', 'cat'] }]);
  });
});

describe('#512', () => {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const string = { kind: 'primitive', type: 'string' } as const;

  /** Parse a document of `schemas` and `paths` from a file, as a spec is read. */
  async function parse(
    schemas: Record<string, unknown>,
    paths: Record<string, unknown> = {},
    openapi = '3.1.0',
  ): Promise<ApiSpec> {
    const dir = await mkdtemp(join(tmpdir(), 'oagen-512-'));
    try {
      const file = join(dir, 'spec.json');
      const doc = { openapi, info: { title: 'Pets', version: '1' }, paths, components: { schemas } };
      await writeFile(file, JSON.stringify(doc));
      return await parseSpec(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const fieldsOf = (spec: ApiSpec, model: string): Field[] => spec.models.find((m) => m.name === model)?.fields ?? [];
  const typed = ({ name, type, constraints }: Pick<Field, 'name' | 'type' | 'constraints'>) => ({
    name,
    type,
    constraints,
  });

  it('types a $ref to a primitive component as that primitive, on a field and a path parameter (the issue’s repro)', async () => {
    const spec = await parse(
      {
        Pet: {
          type: 'object',
          required: ['age', 'id', 'vaccinated'],
          properties: { age: ref('Age'), id: ref('PetId'), vaccinated: ref('Vaccinated') },
        },
        Age: { type: 'integer', minimum: 0 },
        PetId: { type: 'string', pattern: '^pet_[0-9A-Z]{26}$' },
        Vaccinated: { type: 'boolean' },
      },
      {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', required: true, schema: ref('PetId') }],
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Pet') } } } },
          },
        },
      },
    );

    // No empty `Age`, `PetId` or `Vaccinated` model.
    expect(spec.models.map((m) => m.name)).toEqual(['Pet']);
    expect(fieldsOf(spec, 'Pet').map(typed)).toEqual([
      { name: 'age', type: { kind: 'primitive', type: 'integer' }, constraints: { minimum: 0 } },
      { name: 'id', type: string, constraints: { pattern: '^pet_[0-9A-Z]{26}$' } },
      { name: 'vaccinated', type: { kind: 'primitive', type: 'boolean' }, constraints: undefined },
    ]);
    const [getPet] = spec.services.flatMap((service) => service.operations);
    expect(getPet.pathParams.map(typed)).toEqual([
      { name: 'petId', type: string, constraints: { pattern: '^pet_[0-9A-Z]{26}$' } },
    ]);
    expect(getPet.response).toEqual({ kind: 'model', name: 'Pet' });
  });

  it('carries the component’s format, docs, flags, default and limits under what the field writes beside the $ref', async () => {
    const spec = await parse({
      Pet: {
        type: 'object',
        properties: {
          id: ref('PetId'),
          owner_id: { ...ref('PetId'), description: 'The owner.', maxLength: 10 },
          limit: ref('Limit'),
        },
      },
      PetId: {
        type: 'string',
        format: 'uuid',
        description: 'A pet id.',
        externalDocs: { url: 'https://example.com/ids' },
        maxLength: 36,
        readOnly: true,
        deprecated: true,
        example: '0f8fad5b-d9cb-469f-a165-70867728950e',
        'x-kind': 'id',
      },
      Limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    });

    expect(spec.models.map((m) => m.name)).toEqual(['Pet']);
    const [id, ownerId, limit] = fieldsOf(spec, 'Pet');
    expect(id).toMatchObject({
      type: { kind: 'primitive', type: 'string', format: 'uuid' },
      description: 'A pet id.',
      externalDocs: { url: 'https://example.com/ids' },
      readOnly: true,
      deprecated: true,
      example: '0f8fad5b-d9cb-469f-a165-70867728950e',
      constraints: { maxLength: 36 },
      extensions: { 'x-kind': 'id' },
    });
    // The field's own text and stricter limit win; the component fills in the rest.
    expect(ownerId).toMatchObject({ description: 'The owner.', readOnly: true, constraints: { maxLength: 10 } });
    expect(limit).toMatchObject({
      type: { kind: 'primitive', type: 'integer' },
      default: 10,
      constraints: { minimum: 1, maximum: 100 },
    });
  });

  it('keeps the component’s nullability, in every spelling', async () => {
    const spec = await parse({
      Holder: {
        type: 'object',
        properties: { list: ref('TypeList'), one_of: ref('OneOfNull'), any_of: ref('AnyOfNull') },
      },
      TypeList: { type: ['string', 'null'], maxLength: 3 },
      OneOfNull: { oneOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
      AnyOfNull: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }] },
    });
    const spec30 = await parse(
      { Holder: { type: 'object', properties: { flag: ref('Flag') } }, Flag: { type: 'boolean', nullable: true } },
      {},
      '3.0.3',
    );

    for (const parsed of [spec, spec30]) expect(parsed.models.map((m) => m.name)).toEqual(['Holder']);
    expect(fieldsOf(spec, 'Holder').map(typed)).toEqual([
      { name: 'list', type: { kind: 'nullable', inner: string }, constraints: { maxLength: 3 } },
      {
        name: 'one_of',
        type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string', format: 'date' } },
        constraints: undefined,
      },
      {
        name: 'any_of',
        type: { kind: 'nullable', inner: { kind: 'primitive', type: 'integer' } },
        constraints: { minimum: 1 },
      },
    ]);
    expect(fieldsOf(spec30, 'Holder').map(typed)).toEqual([
      {
        name: 'flag',
        type: { kind: 'nullable', inner: { kind: 'primitive', type: 'boolean' } },
        constraints: undefined,
      },
    ]);
  });

  it('reads through an alias of a primitive component, the nearer entry’s text first', async () => {
    const spec = await parse({
      Holder: {
        type: 'object',
        properties: { alias: ref('NameAlias'), nickname: ref('Nickname'), maybe: ref('MaybeName') },
      },
      Name: { type: 'string', minLength: 1, description: 'A name.' },
      NameAlias: ref('Name'),
      Nickname: { allOf: [ref('Name')], description: 'A nickname.', maxLength: 20 },
      MaybeName: { oneOf: [ref('Name'), { type: 'null' }] },
    });

    expect(spec.models.map((m) => m.name)).toEqual(['Holder']);
    expect(fieldsOf(spec, 'Holder').map(({ description, ...field }) => ({ ...typed(field), description }))).toEqual([
      { name: 'alias', type: string, constraints: { minLength: 1 }, description: 'A name.' },
      { name: 'nickname', type: string, constraints: { minLength: 1, maxLength: 20 }, description: 'A nickname.' },
      {
        name: 'maybe',
        type: { kind: 'nullable', inner: string },
        constraints: { minLength: 1 },
        description: 'A name.',
      },
    ]);
  });

  // Review round 1 (MichaelDeBoey): the component's limits were read for a
  // bare `$ref` only, so `{ allOf: [{ $ref: PetId }, { description }] }` —
  // the usual OAS 3.0 way to document a reference — read none of `PetId`'s,
  // and with `PetId` no longer a model its `pattern` was nowhere in the IR.
  // The wire enforces them wrapped or not, so they conjoin as a bare
  // `$ref`'s do; the text, flags, default and keys stay the field's own,
  // read from the wrapper and the members beside the `$ref` (as for an
  // array component, #335).
  it.each(['3.1.0', '3.0.3'])(
    'conjoins the component’s limits through an allOf or a nullable wrapper around the $ref, the field documenting itself (OAS %s)',
    async (openapi) => {
      const spec = await parse(
        {
          Pet: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { allOf: [ref('PetId'), { description: 'The pet.' }] },
              lone: { allOf: [ref('PetId')] },
              beside: { allOf: [{ ...ref('PetId'), maxLength: 40 }], minLength: 5, description: 'Beside.' },
              flagged: { allOf: [ref('PetId'), { deprecated: true, default: 'pet_1', 'x-kind': 'legacy' }] },
              maybe: { oneOf: [ref('PetId'), { type: 'null' }] },
              any: { anyOf: [ref('PetId'), { type: 'null' }], description: 'Maybe a pet.' },
              nested: { oneOf: [{ allOf: [ref('PetId'), { description: 'Nested.' }] }, { type: 'null' }] },
              alias: { allOf: [ref('Nickname')] },
              tags: { allOf: [ref('Tags'), { description: 'The tags.' }] },
              more: { oneOf: [ref('Tags'), { type: 'null' }] },
            },
          },
          PetId: {
            type: 'string',
            format: 'uuid',
            pattern: '^pet_',
            description: 'A pet id.',
            default: 'pet_0',
            deprecated: true,
            'x-kind': 'id',
          },
          Nickname: { allOf: [ref('PetId')], maxLength: 20, description: 'A nickname.' },
          Tags: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Some tags.', deprecated: true },
        },
        {},
        openapi,
      );
      expect(spec.models.map((m) => m.name)).toEqual(['Pet']);
      const uuid = { kind: 'primitive', type: 'string', format: 'uuid' } as const;
      const own = ({ name, type, constraints, description, default: fallback, deprecated, extensions }: Field) => ({
        name,
        type,
        constraints,
        description,
        default: fallback,
        deprecated,
        extensions,
      });
      const none = { description: undefined, default: undefined, deprecated: undefined, extensions: undefined };
      expect(fieldsOf(spec, 'Pet').map(own)).toEqual([
        { name: 'id', type: uuid, constraints: { pattern: '^pet_' }, ...none, description: 'The pet.' },
        { name: 'lone', type: uuid, constraints: { pattern: '^pet_' }, ...none },
        {
          name: 'beside',
          type: uuid,
          constraints: { pattern: '^pet_', maxLength: 40, minLength: 5 },
          ...none,
          description: 'Beside.',
        },
        {
          name: 'flagged',
          type: uuid,
          constraints: { pattern: '^pet_' },
          ...none,
          deprecated: true,
          default: 'pet_1',
          extensions: { 'x-kind': 'legacy' },
        },
        { name: 'maybe', type: { kind: 'nullable', inner: uuid }, constraints: { pattern: '^pet_' }, ...none },
        {
          name: 'any',
          type: { kind: 'nullable', inner: uuid },
          constraints: { pattern: '^pet_' },
          ...none,
          description: 'Maybe a pet.',
        },
        {
          name: 'nested',
          type: { kind: 'nullable', inner: uuid },
          constraints: { pattern: '^pet_' },
          ...none,
          description: 'Nested.',
        },
        { name: 'alias', type: uuid, constraints: { pattern: '^pet_', maxLength: 20 }, ...none },
        {
          name: 'tags',
          type: { kind: 'array', items: string },
          constraints: { minItems: 1 },
          ...none,
          description: 'The tags.',
        },
        {
          name: 'more',
          type: { kind: 'nullable', inner: { kind: 'array', items: string } },
          constraints: { minItems: 1 },
          ...none,
        },
      ]);
    },
  );

  // Greptile (review round 2): a parameter read one `$ref` level only, so
  // through an alias (`Alias: { $ref: Name }`), a lone `allOf` or a nullable
  // wrapper it lost `Name`'s limits, and with `Name` no longer a model they
  // were nowhere in the IR. A parameter now reads the component as a field
  // does (`componentReference`).
  it('reads a primitive or array component on a parameter through its aliases and wrappers, as a field does', async () => {
    const parameter = (name: string, schema: unknown) => ({ name, in: 'query', schema });
    const spec = await parse(
      {
        Name: { type: 'string', minLength: 1, description: 'A name.', default: 'n', deprecated: true },
        Alias: ref('Name'),
        Tags: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Tags.' },
        TagsAlias: ref('Tags'),
      },
      {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [
              parameter('bare', ref('Name')),
              parameter('alias', ref('Alias')),
              parameter('beside', { ...ref('Alias'), maxLength: 3 }),
              parameter('looser', { ...ref('Name'), minLength: 0 }),
              parameter('lone', { allOf: [ref('Name')] }),
              parameter('annotated', { allOf: [ref('Name'), { description: 'Annotated.' }] }),
              parameter('maybe', { oneOf: [ref('Name'), { type: 'null' }] }),
              parameter('tags', ref('TagsAlias')),
              parameter('tags_lone', { allOf: [ref('Tags')] }),
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    );
    expect(spec.models.map((m) => m.name)).toEqual([]);
    const [listPets] = spec.services.flatMap((service) => service.operations);
    const own = ({ name, type, constraints, description, default: fallback, deprecated }: Parameter) => ({
      name,
      type,
      constraints,
      description,
      default: fallback,
      deprecated,
    });
    const none = { description: undefined, default: undefined, deprecated: undefined };
    const named = { description: 'A name.', default: 'n', deprecated: true };
    const tags = { kind: 'array', items: string } as const;
    expect(listPets.queryParams.map(own)).toEqual([
      // A bare `$ref` reads the component's text, default and flag through every alias, and its limits.
      { name: 'bare', type: string, constraints: { minLength: 1 }, ...named },
      { name: 'alias', type: string, constraints: { minLength: 1 }, ...named },
      { name: 'beside', type: string, constraints: { minLength: 1, maxLength: 3 }, ...named },
      // A looser keyword beside the `$ref` does not loosen it: the stricter bound wins, as on a field (review round 3).
      { name: 'looser', type: string, constraints: { minLength: 1 }, ...named },
      // Under a wrapper the limits alone; the text is the wrapper's own.
      { name: 'lone', type: string, constraints: { minLength: 1 }, ...none },
      { name: 'annotated', type: string, constraints: { minLength: 1 }, ...none, description: 'Annotated.' },
      { name: 'maybe', type: { kind: 'nullable', inner: string }, constraints: { minLength: 1 }, ...none },
      { name: 'tags', type: tags, constraints: { minItems: 1 }, ...none, description: 'Tags.' },
      { name: 'tags_lone', type: tags, constraints: { minItems: 1 }, ...none },
    ]);
  });

  it('types the reference as the primitive at every other site', async () => {
    const spec = await parse(
      {
        Pet: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: ref('Tag') },
            labels: { type: 'object', additionalProperties: ref('Tag') },
            all: ref('Tags'),
          },
        },
        Tags: { type: 'array', items: ref('Tag') },
        TagOrPet: { oneOf: [ref('Tag'), ref('Pet')] },
        Tag: { type: 'string', maxLength: 10 },
      },
      {
        '/tags': {
          post: {
            operationId: 'createTag',
            parameters: [{ name: 'tag', in: 'query', schema: ref('Tag') }],
            requestBody: { content: { 'application/json': { schema: ref('Tag') } } },
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('TagOrPet') } } } },
          },
        },
      },
    );

    expect(spec.models.map((m) => m.name)).toEqual(['Pet', 'TagOrPet']);
    expect(fieldsOf(spec, 'Pet').map(({ name, type }) => ({ name, type }))).toEqual([
      { name: 'tags', type: { kind: 'array', items: string } },
      { name: 'labels', type: { kind: 'map', valueType: string } },
      { name: 'all', type: { kind: 'array', items: string } },
    ]);
    expect(spec.models.find((m) => m.name === 'TagOrPet')?.variants).toEqual([string, { kind: 'model', name: 'Pet' }]);
    const [createTag] = spec.services.flatMap((service) => service.operations);
    expect(createTag.queryParams.map(typed)).toEqual([{ name: 'tag', type: string, constraints: { maxLength: 10 } }]);
    expect(createTag.requestBody).toEqual(string);
    expect(createTag.response).toEqual({ kind: 'model', name: 'TagOrPet' });
  });
});

describe('#560', () => {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const kind = { kind: 'enum', name: 'Kind' } as const;
  const nullableKind = { kind: 'nullable', inner: kind } as const;

  /** Parse a document of `schemas`, `paths` and `webhooks` from a file, as a spec is read. */
  async function parse(
    schemas: Record<string, unknown>,
    paths: Record<string, unknown> = {},
    openapi = '3.1.0',
    webhooks?: Record<string, unknown>,
  ): Promise<ApiSpec> {
    const dir = await mkdtemp(join(tmpdir(), 'oagen-560-'));
    try {
      const file = join(dir, 'spec.json');
      const doc = {
        openapi,
        info: { title: 'Pets', version: '1' },
        paths,
        ...(webhooks ? { webhooks } : {}),
        components: { schemas },
      };
      await writeFile(file, JSON.stringify(doc));
      return await parseSpec(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const fieldsOf = (spec: ApiSpec, model: string): Field[] => spec.models.find((m) => m.name === model)?.fields ?? [];
  const names = (spec: ApiSpec) => ({ enums: spec.enums.map((e) => e.name), models: spec.models.map((m) => m.name) });
  const typed = ({ name, type }: Pick<Field, 'name' | 'type'>) => ({ name, type });
  /** A field's type and every keyword an alias could hand it. */
  const own = ({
    name,
    type,
    description,
    externalDocs,
    deprecated,
    readOnly,
    default: fallback,
    example,
    constraints,
    extensions,
  }: Field) => ({
    name,
    type,
    description,
    externalDocs,
    deprecated,
    readOnly,
    default: fallback,
    example,
    constraints,
    extensions,
  });
  const none = {
    description: undefined,
    externalDocs: undefined,
    deprecated: undefined,
    readOnly: undefined,
    default: undefined,
    example: undefined,
    constraints: undefined,
    extensions: undefined,
  };

  it.each(['3.1.0', '3.0.3'])(
    'types a $ref to an alias of an enum component as the enum, the alias’s text on the field (the issue’s repro, OAS %s)',
    async (openapi) => {
      const spec = await parse(
        {
          Pet: {
            type: 'object',
            required: ['kind', 'size'],
            properties: {
              kind: ref('PetKind'),
              size: { allOf: [ref('Size'), { description: 'The size of the pet.' }] },
            },
          },
          Kind: { type: 'string', enum: ['cat', 'dog'] },
          PetKind: { allOf: [ref('Kind'), { description: 'The kind of pet.' }] },
          Size: { type: 'string', enum: ['large', 'small'] },
        },
        {
          '/pets/{petId}': {
            get: {
              operationId: 'getPet',
              parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
              responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Pet') } } } },
            },
          },
        },
        openapi,
      );

      // No empty `PetKind` model: the alias reads through to `Kind`, as the
      // same `allOf` written on `size` does, and its text lands on the field.
      expect(names(spec)).toEqual({ enums: ['Kind', 'Size'], models: ['Pet'] });
      expect(
        fieldsOf(spec, 'Pet').map(({ name, type, description, required }) => ({ name, type, description, required })),
      ).toEqual([
        { name: 'kind', type: kind, description: 'The kind of pet.', required: true },
        { name: 'size', type: { kind: 'enum', name: 'Size' }, description: 'The size of the pet.', required: true },
      ]);
      const [getPet] = spec.services.flatMap((service) => service.operations);
      expect(getPet.response).toEqual({ kind: 'model', name: 'Pet' });
    },
  );

  it('reads through every alias spelling, an alias of an alias included', async () => {
    const spec = await parse({
      Holder: {
        type: 'object',
        properties: {
          bare: ref('Bare'),
          beside: ref('Beside'),
          lone: ref('Lone'),
          annotated: ref('Annotated'),
          one_of: ref('OneOfNull'),
          any_of: ref('AnyOfNull'),
          required: ref('Required'),
          chain: ref('Chain'),
          chain_of_nullable: ref('ChainOfNullable'),
        },
      },
      Kind: { type: 'string', enum: ['cat', 'dog'] },
      Bare: ref('Kind'),
      Beside: { ...ref('Kind'), description: 'Beside.' },
      Lone: { allOf: [ref('Kind')] },
      Annotated: { allOf: [ref('Kind'), { description: 'Annotated.' }] },
      OneOfNull: { oneOf: [ref('Kind'), { type: 'null' }] },
      AnyOfNull: { anyOf: [{ type: 'null' }, ref('Kind')] },
      // `required` constrains an object instance only: beside an enum it adds
      // nothing, and the reference stands (`readInlineAllOf`).
      Required: { allOf: [ref('Kind')], required: ['x'] },
      Chain: { allOf: [ref('Annotated')] },
      ChainOfNullable: ref('OneOfNull'),
    });

    expect(names(spec)).toEqual({ enums: ['Kind'], models: ['Holder'] });
    expect(fieldsOf(spec, 'Holder').map(typed)).toEqual([
      { name: 'bare', type: kind },
      { name: 'beside', type: kind },
      { name: 'lone', type: kind },
      { name: 'annotated', type: kind },
      { name: 'one_of', type: nullableKind },
      { name: 'any_of', type: nullableKind },
      { name: 'required', type: kind },
      { name: 'chain', type: kind },
      { name: 'chain_of_nullable', type: nullableKind },
    ]);
  });

  it('keeps the enum’s own nullability through an alias, in every spelling', async () => {
    const spec = await parse({
      Holder: { type: 'object', properties: { member: ref('MemberAlias'), list: ref('ListAlias') } },
      NullMember: { type: 'string', enum: ['cat', 'dog', null] },
      NullList: { type: ['string', 'null'], enum: ['cat', 'dog'] },
      MemberAlias: { allOf: [ref('NullMember')] },
      ListAlias: ref('NullList'),
    });
    const spec30 = await parse(
      {
        Holder: { type: 'object', properties: { flag: ref('FlagAlias'), unflagged: ref('Unflagged') } },
        Flagged: { type: 'string', enum: ['cat', 'dog'], nullable: true },
        Kind: { type: 'string', enum: ['cat', 'dog'] },
        FlagAlias: { allOf: [ref('Flagged'), { description: 'Flagged.' }] },
        // OAS 3.0 gives `nullable` meaning beside a `type` only, so beside an
        // `allOf` it declares nothing — on an alias as on a field.
        Unflagged: { allOf: [ref('Kind')], nullable: true },
      },
      {},
      '3.0.3',
    );

    expect(names(spec)).toEqual({ enums: ['NullMember', 'NullList'], models: ['Holder'] });
    expect(fieldsOf(spec, 'Holder').map(typed)).toEqual([
      { name: 'member', type: { kind: 'nullable', inner: { kind: 'enum', name: 'NullMember' } } },
      { name: 'list', type: { kind: 'nullable', inner: { kind: 'enum', name: 'NullList' } } },
    ]);
    expect(names(spec30)).toEqual({ enums: ['Flagged', 'Kind'], models: ['Holder'] });
    expect(fieldsOf(spec30, 'Holder').map(typed)).toEqual([
      { name: 'flag', type: { kind: 'nullable', inner: { kind: 'enum', name: 'Flagged' } } },
      { name: 'unflagged', type: kind },
    ]);
  });

  it('carries what the alias declares onto a field that names it with a bare $ref, while the enum keeps its own', async () => {
    const spec = await parse({
      Pet: {
        type: 'object',
        properties: {
          kind: ref('Kind'),
          beside: ref('Beside'),
          lone: ref('LoneOwn'),
          annotated: ref('Annotated'),
          nested: ref('NestedOwn'),
          chain: ref('Chain'),
        },
      },
      Kind: {
        type: 'string',
        enum: ['cat', 'dog'],
        description: 'A kind.',
        externalDocs: { url: 'https://example.com/kinds' },
        deprecated: true,
        maxLength: 5,
        default: 'cat',
        example: 'cat',
        'x-kind': 'enum',
      },
      Beside: {
        ...ref('Kind'),
        description: 'Beside.',
        externalDocs: { url: 'https://example.com/beside' },
        readOnly: true,
        example: 'dog',
        'x-alias': 'beside',
      },
      LoneOwn: { allOf: [ref('Kind')], description: 'Own.', maxLength: 3, default: 'dog' },
      // An `allOf` member that declares no type is part of the alias's own
      // declaration, as it is part of a field's (#555).
      Annotated: {
        allOf: [ref('Kind'), { description: 'Annotated.', deprecated: true, maxLength: 4, 'x-alias': 'annotated' }],
      },
      // The lone member of an `allOf` is the entry's own declaration, not a
      // level of its own: its text is not read (#399).
      NestedOwn: { allOf: [{ allOf: [ref('Kind')], description: 'The member’s text' }] },
      Chain: { allOf: [ref('Annotated')], description: 'Chain.' },
    });

    expect(names(spec)).toEqual({ enums: ['Kind'], models: ['Pet'] });
    // The enum keeps its own text, link, flag, default and keys.
    expect(spec.enums[0]).toMatchObject({
      name: 'Kind',
      description: 'A kind.',
      externalDocs: { url: 'https://example.com/kinds' },
      deprecated: true,
      default: 'cat',
      extensions: { 'x-kind': 'enum' },
    });
    const annotated = {
      description: 'Annotated.',
      deprecated: true,
      constraints: { maxLength: 4 },
      extensions: { 'x-alias': 'annotated' },
    };
    expect(fieldsOf(spec, 'Pet').map(own)).toEqual([
      // A `$ref` to the enum itself leaves all of it on the enum but the
      // `example` a field takes from any component it names.
      { name: 'kind', type: kind, ...none, example: 'cat' },
      {
        name: 'beside',
        type: kind,
        ...none,
        description: 'Beside.',
        externalDocs: { url: 'https://example.com/beside' },
        readOnly: true,
        example: 'dog',
        extensions: { 'x-alias': 'beside' },
      },
      {
        name: 'lone',
        type: kind,
        ...none,
        description: 'Own.',
        constraints: { maxLength: 3 },
        default: 'dog',
        example: 'cat',
      },
      { name: 'annotated', type: kind, ...none, ...annotated, example: 'cat' },
      { name: 'nested', type: kind, ...none, example: 'cat' },
      // The nearer alias's text first; the farther alias's flag, limit and keys still reach the field.
      { name: 'chain', type: kind, ...none, ...annotated, description: 'Chain.', example: 'cat' },
    ]);
  });

  it.each(['3.1.0', '3.0.3'])(
    'conjoins the alias’s limits through a wrapper around the $ref, the field documenting itself (OAS %s)',
    async (openapi) => {
      const spec = await parse(
        {
          Pet: {
            type: 'object',
            properties: {
              lone: { allOf: [ref('Annotated')] },
              text: { allOf: [ref('Annotated'), { description: 'The pet.' }] },
              maybe: { oneOf: [ref('Annotated'), { type: 'null' }] },
              any: { anyOf: [ref('Annotated'), { type: 'null' }], description: 'Maybe a kind.' },
              nested: { oneOf: [{ allOf: [ref('Annotated'), { description: 'Nested.' }] }, { type: 'null' }] },
              beside: { ...ref('Annotated'), description: 'Beside.', maxLength: 2 },
              wider: { ...ref('Annotated'), maxLength: 10 },
            },
          },
          Kind: { type: 'string', enum: ['cat', 'dog'], description: 'A kind.', default: 'cat', deprecated: true },
          Annotated: {
            allOf: [
              ref('Kind'),
              { description: 'Annotated.', deprecated: true, maxLength: 4, default: 'dog', 'x-alias': 'annotated' },
            ],
          },
        },
        {},
        openapi,
      );

      expect(names(spec)).toEqual({ enums: ['Kind'], models: ['Pet'] });
      const aliased = { deprecated: true, default: 'dog', extensions: { 'x-alias': 'annotated' } };
      expect(fieldsOf(spec, 'Pet').map(own)).toEqual([
        { name: 'lone', type: kind, ...none, constraints: { maxLength: 4 } },
        { name: 'text', type: kind, ...none, constraints: { maxLength: 4 }, description: 'The pet.' },
        { name: 'maybe', type: nullableKind, ...none, constraints: { maxLength: 4 } },
        { name: 'any', type: nullableKind, ...none, constraints: { maxLength: 4 }, description: 'Maybe a kind.' },
        { name: 'nested', type: nullableKind, ...none, constraints: { maxLength: 4 }, description: 'Nested.' },
        // A bare `$ref` with keywords beside it reads the alias under its own:
        // the field's text, and the stricter bound either way.
        { name: 'beside', type: kind, ...none, ...aliased, description: 'Beside.', constraints: { maxLength: 2 } },
        { name: 'wider', type: kind, ...none, ...aliased, description: 'Annotated.', constraints: { maxLength: 4 } },
      ]);
    },
  );

  it('reads an alias on a parameter as a field does, then the enum as a bare $ref to it is read', async () => {
    const parameter = (name: string, schema: unknown) => ({ name, in: 'query', schema });
    const spec = await parse(
      {
        Kind: {
          type: 'string',
          enum: ['cat', 'dog'],
          description: 'A kind.',
          deprecated: true,
          default: 'cat',
          example: 'cat',
          maxLength: 5,
        },
        Alias: ref('Kind'),
        Annotated: { allOf: [ref('Kind'), { description: 'Annotated.', maxLength: 4, default: 'dog' }] },
      },
      {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [
              parameter('kind', ref('Kind')),
              parameter('alias', ref('Alias')),
              parameter('annotated', ref('Annotated')),
              parameter('beside', { ...ref('Annotated'), description: 'Beside.', maxLength: 2 }),
              parameter('looser', { ...ref('Annotated'), maxLength: 10 }),
              parameter('lone', { allOf: [ref('Annotated')] }),
              parameter('text', { allOf: [ref('Annotated'), { description: 'Text.' }] }),
              parameter('maybe', { oneOf: [ref('Annotated'), { type: 'null' }] }),
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    );

    expect(names(spec)).toEqual({ enums: ['Kind'], models: [] });
    const [listPets] = spec.services.flatMap((service) => service.operations);
    const read = ({ name, type, description, deprecated, default: fallback, example, constraints }: Parameter) => ({
      name,
      type,
      description,
      deprecated,
      default: fallback,
      example,
      constraints,
    });
    const blank = { description: undefined, deprecated: undefined, default: undefined, example: undefined };
    const enumsOwn = { description: 'A kind.', deprecated: true, default: 'cat', example: 'cat' };
    expect(listPets.queryParams.map(read)).toEqual([
      // A `$ref` to the enum reads the component, as a parameter reads any component it names; so does one to a bare alias of it.
      { name: 'kind', type: kind, ...enumsOwn, constraints: { maxLength: 5 } },
      { name: 'alias', type: kind, ...enumsOwn, constraints: { maxLength: 5 } },
      // The alias's own first, the enum's where the alias declares none; the alias's limit conjoins, the stricter bound winning.
      {
        name: 'annotated',
        type: kind,
        ...enumsOwn,
        description: 'Annotated.',
        default: 'dog',
        constraints: { maxLength: 4 },
      },
      {
        name: 'beside',
        type: kind,
        ...enumsOwn,
        description: 'Beside.',
        default: 'dog',
        constraints: { maxLength: 2 },
      },
      {
        name: 'looser',
        type: kind,
        ...enumsOwn,
        description: 'Annotated.',
        default: 'dog',
        constraints: { maxLength: 4 },
      },
      // Under a wrapper the alias's limits alone; the text is the parameter's own.
      { name: 'lone', type: kind, ...blank, constraints: { maxLength: 4 } },
      { name: 'text', type: kind, ...blank, description: 'Text.', constraints: { maxLength: 4 } },
      { name: 'maybe', type: nullableKind, ...blank, constraints: { maxLength: 4 } },
    ]);
  });

  it('types the reference as the enum at every other site: a request body, a response, a webhook payload, array items, map values and a union variant', async () => {
    const spec = await parse(
      {
        Pet: {
          type: 'object',
          properties: {
            kinds: { type: 'array', items: ref('PetKind') },
            by_name: { type: 'object', additionalProperties: ref('MaybeKind') },
            kind_or_age: { oneOf: [ref('PetKind'), { type: 'integer' }] },
          },
        },
        Kind: { type: 'string', enum: ['cat', 'dog'] },
        PetKind: { allOf: [ref('Kind'), { description: 'The kind of pet.' }] },
        MaybeKind: { oneOf: [ref('Kind'), { type: 'null' }] },
        KindOrPet: { oneOf: [ref('PetKind'), ref('Pet')] },
        KindOrOwner: { oneOf: [{ anyOf: [ref('PetKind'), { type: 'null' }] }, ref('Owner')] },
        Owner: { type: 'object', properties: { name: { type: 'string' } } },
      },
      {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: { content: { 'application/json': { schema: ref('PetKind') } } },
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('MaybeKind') } } } },
          },
        },
      },
      '3.1.0',
      {
        petKind: {
          post: {
            operationId: 'onPetKind',
            requestBody: { content: { 'application/json': { schema: ref('PetKind') } } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    );

    expect(names(spec)).toEqual({ enums: ['Kind'], models: ['Pet', 'KindOrPet', 'KindOrOwner', 'Owner'] });
    expect(fieldsOf(spec, 'Pet').map(typed)).toEqual([
      { name: 'kinds', type: { kind: 'array', items: kind } },
      { name: 'by_name', type: { kind: 'map', valueType: nullableKind } },
      {
        name: 'kind_or_age',
        type: { kind: 'union', variants: [kind, { kind: 'primitive', type: 'integer' }], compositionKind: 'oneOf' },
      },
    ]);
    // A named union's variant that names the alias is the enum, and a nullable
    // wrapper around it `nullable<enum>`: neither names a model (`wrappedVariantReference`).
    expect(spec.models.find((m) => m.name === 'KindOrPet')?.variants).toEqual([kind, { kind: 'model', name: 'Pet' }]);
    expect(spec.models.find((m) => m.name === 'KindOrOwner')?.variants).toEqual([
      nullableKind,
      { kind: 'model', name: 'Owner' },
    ]);
    const [createPet] = spec.services.flatMap((service) => service.operations);
    expect(createPet.requestBody).toEqual(kind);
    expect(createPet.response).toEqual(nullableKind);
    expect((spec.webhooks ?? []).map(({ name, requestBody }) => ({ name, requestBody }))).toEqual([
      { name: 'petKind', requestBody: kind },
    ]);
  });

  it('keeps a component that is no alias a model: two $ref members, properties beside the allOf, a reference cycle', async () => {
    const spec = await parse({
      Holder: { type: 'object', properties: { two: ref('TwoKinds'), props: ref('WithProps'), cycle: ref('CycleA') } },
      Kind: { type: 'string', enum: ['cat', 'dog'] },
      Size: { type: 'string', enum: ['large', 'small'] },
      TwoKinds: { allOf: [ref('Kind'), ref('Size')] },
      WithProps: { allOf: [ref('Kind')], properties: { name: { type: 'string' } } },
      CycleA: ref('CycleB'),
      CycleB: { allOf: [ref('CycleA')] },
    });

    expect(names(spec)).toEqual({
      enums: ['Kind', 'Size'],
      models: ['Holder', 'TwoKinds', 'WithProps', 'CycleA', 'CycleB'],
    });
    expect(fieldsOf(spec, 'Holder').map(typed)).toEqual([
      { name: 'two', type: { kind: 'model', name: 'TwoKinds' } },
      { name: 'props', type: { kind: 'model', name: 'WithProps' } },
      { name: 'cycle', type: { kind: 'model', name: 'CycleA' } },
    ]);
  });

  it('keeps the alias’s name claimed: an array component’s items step around it, as around any component’s', async () => {
    const spec = await parse({
      Kind: { type: 'string', enum: ['cat', 'dog'] },
      PetsItemKind: { allOf: [ref('Kind')] },
      Pets: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['x', 'y'] } } } },
      Holder: { type: 'object', properties: { pets: ref('Pets'), kind: ref('PetsItemKind') } },
    });

    // The items' enum would be `PetsItemKind`, the alias's name, so the tree steps to `item_item`.
    expect(names(spec)).toEqual({ enums: ['Kind', 'PetsItemItemKind'], models: ['PetsItemItem', 'Holder'] });
    expect(fieldsOf(spec, 'Holder').map(typed)).toEqual([
      { name: 'pets', type: { kind: 'array', items: { kind: 'model', name: 'PetsItemItem' } } },
      { name: 'kind', type: kind },
    ]);
  });

  it('reads an annotating allOf member of an array or primitive component’s alias as the alias’s own, as a field reads one', async () => {
    const spec = await parse({
      Holder: { type: 'object', properties: { tags: ref('TagsAlias'), name: ref('NameAlias') } },
      Tags: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Some tags.' },
      TagsAlias: { allOf: [ref('Tags'), { description: 'The tags.', deprecated: true, maxItems: 5 }] },
      Name: { type: 'string', minLength: 1, description: 'A name.' },
      NameAlias: { allOf: [ref('Name'), { description: 'The name.', readOnly: true }] },
    });

    expect(names(spec)).toEqual({ enums: [], models: ['Holder'] });
    expect(fieldsOf(spec, 'Holder').map(own)).toEqual([
      {
        name: 'tags',
        type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
        ...none,
        description: 'The tags.',
        deprecated: true,
        constraints: { minItems: 1, maxItems: 5 },
      },
      {
        name: 'name',
        type: { kind: 'primitive', type: 'string' },
        ...none,
        description: 'The name.',
        readOnly: true,
        constraints: { minLength: 1 },
      },
    ]);
  });
});

describe('#569', () => {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const string = { kind: 'primitive', type: 'string' } as const;
  const integer = { kind: 'primitive', type: 'integer' } as const;
  const unknown = { kind: 'primitive', type: 'unknown' } as const;
  const cat = { kind: 'literal', value: 'cat' } as const;
  const stringOrInteger = { kind: 'union', variants: [string, integer] } as const;
  const nullable = (inner: unknown) => ({ kind: 'nullable', inner });

  /** Parse a document of `schemas`, `paths` and `webhooks` from a file, as a spec is read. */
  async function parse(
    schemas: Record<string, unknown>,
    paths: Record<string, unknown> = {},
    openapi = '3.1.0',
    webhooks?: Record<string, unknown>,
  ): Promise<ApiSpec> {
    const dir = await mkdtemp(join(tmpdir(), 'oagen-569-'));
    try {
      const file = join(dir, 'spec.json');
      const doc = {
        openapi,
        info: { title: 'Pets', version: '1' },
        paths,
        ...(webhooks ? { webhooks } : {}),
        components: { schemas },
      };
      await writeFile(file, JSON.stringify(doc));
      return await parseSpec(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const names = (spec: ApiSpec) => ({ enums: spec.enums.map((e) => e.name), models: spec.models.map((m) => m.name) });
  const fieldsOf = (spec: ApiSpec, model: string): Field[] => spec.models.find((m) => m.name === model)?.fields ?? [];
  const typed = ({ name, type, constraints }: Pick<Field, 'name' | 'type' | 'constraints'>) => ({
    name,
    type,
    constraints,
  });
  const documented = ({ name, type, constraints, description }: Field) => ({ name, type, constraints, description });

  it('types a $ref to a const, multi-type or untyped component as the same schema written inline (the issue’s repro)', async () => {
    const spec = await parse(
      {
        Anything: { description: 'Any value.' },
        Kind: { type: 'string', const: 'cat' },
        Tag: { type: ['string', 'integer'], maxLength: 20 },
        Pet: {
          type: 'object',
          required: ['anything', 'anythingInline', 'kind', 'kindInline', 'tag', 'tagInline'],
          properties: {
            anything: ref('Anything'),
            anythingInline: { description: 'Any value.' },
            kind: ref('Kind'),
            kindInline: { type: 'string', const: 'cat' },
            tag: ref('Tag'),
            tagInline: { type: ['string', 'integer'], maxLength: 20 },
          },
        },
      },
      {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Pet') } } } },
          },
        },
      },
    );

    // No empty `Anything`, `Kind` or `Tag` model, and `Tag`'s `maxLength` on the field, not on a model.
    expect(names(spec)).toEqual({ enums: [], models: ['Pet'] });
    expect(fieldsOf(spec, 'Pet').map(documented)).toEqual([
      { name: 'anything', type: unknown, constraints: undefined, description: 'Any value.' },
      { name: 'anythingInline', type: unknown, constraints: undefined, description: 'Any value.' },
      { name: 'kind', type: cat, constraints: undefined, description: undefined },
      { name: 'kindInline', type: cat, constraints: undefined, description: undefined },
      { name: 'tag', type: stringOrInteger, constraints: { maxLength: 20 }, description: undefined },
      { name: 'tagInline', type: stringOrInteger, constraints: { maxLength: 20 }, description: undefined },
    ]);
  });

  it('keeps the component’s nullability in every OAS 3.1 spelling, and types a const of any value as the literal', async () => {
    const spec = await parse({
      Holder: {
        type: 'object',
        properties: {
          kind_list: ref('KindList'),
          tag_list: ref('TagList'),
          tag_one_of: ref('TagOneOf'),
          any_one_of: ref('AnyOneOf'),
          seven: ref('Seven'),
          yes: ref('Yes'),
          nothing: ref('Nothing'),
          empty: ref('Empty'),
          format_only: ref('FormatOnly'),
        },
      },
      KindList: { type: ['string', 'null'], const: 'cat', description: 'A kind.' },
      TagList: { type: ['string', 'integer', 'null'], maxLength: 20, minimum: 1 },
      TagOneOf: { oneOf: [{ type: ['string', 'integer'], maxLength: 20 }, { type: 'null' }], description: 'A tag.' },
      // The component's own text rides onto the field; a `null` variant's
      // sibling branch is no level of the component, as it is not for a
      // primitive under the same wrapper (#512) nor for the same schema inline.
      AnyOneOf: { anyOf: [{ type: 'null' }, { description: 'Any.' }], description: 'Maybe any.' },
      Seven: { type: 'integer', const: 7 },
      Yes: { const: true },
      Nothing: { const: null },
      Empty: {},
      FormatOnly: { format: 'uuid', description: 'Just a format.' },
    });

    expect(names(spec)).toEqual({ enums: [], models: ['Holder'] });
    expect(fieldsOf(spec, 'Holder').map(documented)).toEqual([
      { name: 'kind_list', type: nullable(cat), constraints: undefined, description: 'A kind.' },
      {
        name: 'tag_list',
        type: nullable(stringOrInteger),
        constraints: { minimum: 1, maxLength: 20 },
        description: undefined,
      },
      { name: 'tag_one_of', type: nullable(stringOrInteger), constraints: { maxLength: 20 }, description: 'A tag.' },
      { name: 'any_one_of', type: nullable(unknown), constraints: undefined, description: 'Maybe any.' },
      { name: 'seven', type: { kind: 'literal', value: 7 }, constraints: undefined, description: undefined },
      { name: 'yes', type: { kind: 'literal', value: true }, constraints: undefined, description: undefined },
      { name: 'nothing', type: nullable(unknown), constraints: undefined, description: undefined },
      { name: 'empty', type: unknown, constraints: undefined, description: undefined },
      { name: 'format_only', type: unknown, constraints: undefined, description: 'Just a format.' },
    ]);
  });

  // Type lists and `const` are OAS 3.1 keywords; an untyped component is
  // the one shape a 3.0 document writes, with or without a `nullable: true`
  // that declares nothing beside no `type`, as it declares nothing inline.
  it.each(['3.0.3', '3.1.0'])(
    'carries an untyped component’s docs, flags, default, examples and keys onto a field that names it (OAS %s)',
    async (openapi) => {
      const spec = await parse(
        {
          Holder: {
            type: 'object',
            properties: {
              anything: ref('Anything'),
              own: { ...ref('Anything'), description: 'Own.', deprecated: false },
              maybe: ref('MaybeAnything'),
            },
          },
          Anything: {
            description: 'Any value.',
            externalDocs: { url: 'https://example.com/any' },
            deprecated: true,
            readOnly: true,
            default: 'd',
            example: 1,
            examples: [1, 2],
            'x-kind': 'any',
          },
          MaybeAnything: { nullable: true, description: 'Maybe any value.' },
        },
        {},
        openapi,
      );

      expect(names(spec)).toEqual({ enums: [], models: ['Holder'] });
      const [anything, own, maybe] = fieldsOf(spec, 'Holder');
      expect(anything).toEqual({
        name: 'anything',
        type: unknown,
        required: false,
        description: 'Any value.',
        externalDocs: { url: 'https://example.com/any' },
        readOnly: true,
        writeOnly: undefined,
        deprecated: true,
        default: 'd',
        example: 1,
        examples: [1, 2],
        extensions: { 'x-kind': 'any' },
      });
      // The field's own text wins; the component fills in the rest.
      expect(own).toMatchObject({ type: unknown, description: 'Own.', deprecated: true, default: 'd' });
      expect(maybe).toMatchObject({ type: unknown, description: 'Maybe any value.' });
    },
  );

  it('reads through an alias of a const or multi-type component, the nearer entry’s text first, as through a primitive’s', async () => {
    const spec = await parse({
      Holder: {
        type: 'object',
        properties: {
          kind_alias: ref('KindAlias'),
          kind_doc: ref('KindDoc'),
          kind_maybe: ref('KindMaybe'),
          kind_lone: ref('KindLone'),
          kind_alias_alias: ref('KindAliasAlias'),
          tag_alias: ref('TagAlias'),
          tag_doc: ref('TagDoc'),
          tag_maybe: ref('TagMaybe'),
          any_doc: ref('AnyDoc'),
        },
      },
      Kind: { type: 'string', const: 'cat', description: 'A kind.', default: 'cat', 'x-kind': 'k' },
      KindAlias: ref('Kind'),
      KindDoc: { allOf: [ref('Kind'), { description: 'The kind of pet.', deprecated: true }] },
      KindMaybe: { oneOf: [ref('Kind'), { type: 'null' }] },
      KindLone: { allOf: [ref('Kind')] },
      KindAliasAlias: ref('KindDoc'),
      Tag: { type: ['string', 'integer'], maxLength: 20, description: 'A tag.' },
      TagAlias: ref('Tag'),
      TagDoc: { allOf: [ref('Tag'), { description: 'Documented tag.', maxLength: 10 }] },
      TagMaybe: { anyOf: [{ type: 'null' }, ref('Tag')] },
      Anything: { description: 'Any value.' },
      AnyDoc: { allOf: [ref('Anything'), { description: 'Documented.' }] },
    });

    expect(names(spec)).toEqual({ enums: [], models: ['Holder'] });
    const own = ({ name, type, constraints, description, default: fallback, deprecated, extensions }: Field) => ({
      name,
      type,
      constraints,
      description,
      default: fallback,
      deprecated,
      extensions,
    });
    const kind = { description: 'A kind.', default: 'cat', deprecated: undefined, extensions: { 'x-kind': 'k' } };
    const kindDoc = { ...kind, description: 'The kind of pet.', deprecated: true };
    const tag = { description: 'A tag.', default: undefined, deprecated: undefined, extensions: undefined };
    expect(fieldsOf(spec, 'Holder').map(own)).toEqual([
      { name: 'kind_alias', type: cat, constraints: undefined, ...kind },
      { name: 'kind_doc', type: cat, constraints: undefined, ...kindDoc },
      { name: 'kind_maybe', type: nullable(cat), constraints: undefined, ...kind },
      { name: 'kind_lone', type: cat, constraints: undefined, ...kind },
      { name: 'kind_alias_alias', type: cat, constraints: undefined, ...kindDoc },
      { name: 'tag_alias', type: stringOrInteger, constraints: { maxLength: 20 }, ...tag },
      // The alias's stricter limit wins, as a field's own would.
      {
        name: 'tag_doc',
        type: stringOrInteger,
        constraints: { maxLength: 10 },
        ...tag,
        description: 'Documented tag.',
      },
      { name: 'tag_maybe', type: nullable(stringOrInteger), constraints: { maxLength: 20 }, ...tag },
      { name: 'any_doc', type: unknown, constraints: undefined, ...tag, description: 'Documented.' },
    ]);
  });

  it('conjoins the component’s limits under a wrapper around the $ref, the field documenting itself', async () => {
    const spec = await parse({
      Holder: {
        type: 'object',
        properties: {
          own: { ...ref('Kind'), description: 'Own.' },
          wrapped: { allOf: [ref('Tag'), { description: 'Wrapped.', maxLength: 5 }] },
          lone: { allOf: [ref('Tag')] },
          maybe: { oneOf: [ref('Kind'), { type: 'null' }] },
          any_maybe: { anyOf: [ref('Anything'), { type: 'null' }], description: 'Maybe.' },
        },
      },
      Kind: { type: 'string', const: 'cat', description: 'A kind.' },
      Tag: { type: ['string', 'integer'], maxLength: 20, description: 'A tag.' },
      Anything: { description: 'Any value.' },
    });

    expect(names(spec)).toEqual({ enums: [], models: ['Holder'] });
    expect(fieldsOf(spec, 'Holder').map(documented)).toEqual([
      { name: 'own', type: cat, constraints: undefined, description: 'Own.' },
      { name: 'wrapped', type: stringOrInteger, constraints: { maxLength: 5 }, description: 'Wrapped.' },
      { name: 'lone', type: stringOrInteger, constraints: { maxLength: 20 }, description: undefined },
      { name: 'maybe', type: nullable(cat), constraints: undefined, description: undefined },
      { name: 'any_maybe', type: nullable(unknown), constraints: undefined, description: 'Maybe.' },
    ]);
  });

  it('types the reference the same way at every other site', async () => {
    const parameter = (name: string, schema: unknown, extra: Record<string, unknown> = {}) => ({
      name,
      in: 'query',
      schema,
      ...extra,
    });
    const spec = await parse(
      {
        Pet: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: ref('Tag') },
            labels: { type: 'object', additionalProperties: ref('Anything') },
            all: ref('Tags'),
            kinds: ref('Kinds'),
          },
        },
        Tags: { type: 'array', items: ref('Tag') },
        Kinds: { type: 'array', items: ref('Kind'), minItems: 1 },
        TagOrPet: { oneOf: [ref('Tag'), ref('Pet')] },
        AnyOrPet: { oneOf: [ref('Anything'), ref('Pet')] },
        KindOrAny: { oneOf: [ref('Kind'), ref('Anything')] },
        Tag: { type: ['string', 'integer'], maxLength: 10, description: 'A tag.' },
        Kind: { type: 'string', const: 'cat' },
        Anything: { description: 'Any value.', default: 1 },
      },
      {
        '/tags': {
          post: {
            operationId: 'createTag',
            parameters: [
              parameter('tag', ref('Tag')),
              parameter('kind', ref('Kind'), { description: 'Own.' }),
              parameter('any', ref('Anything')),
              parameter('anyWrapped', { allOf: [ref('Anything'), { description: 'Wrapped.' }] }),
              parameter('tagMaybe', { oneOf: [ref('Tag'), { type: 'null' }] }),
            ],
            requestBody: { content: { 'application/json': { schema: ref('Kind') } } },
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('TagOrPet') } } } },
          },
        },
        '/any': {
          post: {
            operationId: 'createAny',
            requestBody: { content: { 'application/json': { schema: ref('Anything') } } },
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Anything') } } } },
          },
          get: {
            operationId: 'getAny',
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Tag') } } } },
          },
        },
      },
      '3.1.0',
      {
        anyHappened: {
          post: {
            operationId: 'anyHappened',
            requestBody: { content: { 'application/json': { schema: ref('Anything') } } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    );

    expect(names(spec)).toEqual({ enums: [], models: ['Pet', 'TagOrPet', 'AnyOrPet', 'KindOrAny'] });
    expect(fieldsOf(spec, 'Pet').map(typed)).toEqual([
      { name: 'tags', type: { kind: 'array', items: stringOrInteger }, constraints: undefined },
      { name: 'labels', type: { kind: 'map', valueType: unknown }, constraints: undefined },
      { name: 'all', type: { kind: 'array', items: stringOrInteger }, constraints: undefined },
      { name: 'kinds', type: { kind: 'array', items: cat }, constraints: { minItems: 1 } },
    ]);
    // A named union's variant that names such a component is the literal,
    // union or unknown, and names no model for a discriminator.
    const union = (name: string) => spec.models.find((m) => m.name === name);
    expect(union('TagOrPet')).toMatchObject({ variants: [stringOrInteger, { kind: 'model', name: 'Pet' }] });
    expect(union('AnyOrPet')).toMatchObject({ variants: [unknown, { kind: 'model', name: 'Pet' }] });
    expect(union('KindOrAny')).toMatchObject({ variants: [cat, unknown] });
    expect(union('AnyOrPet')?.discriminator).toBeUndefined();
    const [createTag, getAny, createAny] = spec.services.flatMap((service) => service.operations);
    const param = ({ name, type, constraints, description, default: fallback }: Parameter) => ({
      name,
      type,
      constraints,
      description,
      default: fallback,
    });
    expect(createTag.queryParams.map(param)).toEqual([
      { name: 'tag', type: stringOrInteger, constraints: { maxLength: 10 }, description: 'A tag.', default: undefined },
      { name: 'kind', type: cat, constraints: undefined, description: 'Own.', default: undefined },
      { name: 'any', type: unknown, constraints: undefined, description: 'Any value.', default: 1 },
      { name: 'anyWrapped', type: unknown, constraints: undefined, description: 'Wrapped.', default: undefined },
      {
        name: 'tagMaybe',
        type: nullable(stringOrInteger),
        constraints: { maxLength: 10 },
        description: undefined,
        default: undefined,
      },
    ]);
    expect(createTag.requestBody).toEqual(cat);
    expect(createTag.response).toEqual({ kind: 'model', name: 'TagOrPet' });
    expect(getAny.response).toEqual(stringOrInteger);
    expect(createAny.requestBody).toEqual(unknown);
    expect(createAny.response).toEqual(unknown);
    expect(spec.webhooks?.map((webhook) => webhook.requestBody)).toEqual([unknown]);
  });

  // The primary response is the lowest 2xx whose body is typed, decided
  // before any body is typed (`bodyTypesAsUnknown`): a `$ref` to an untyped
  // component is `unknown` to that pick as the same schema inline is, so it
  // never claims the pick from a typed body.
  it('passes the primary-response pick over a body that is a $ref to an untyped component', async () => {
    const pick = (first: unknown) => ({
      responses: {
        '200': { description: 'Any', content: { 'application/json': { schema: first } } },
        '201': { description: 'Pet', content: { 'application/json': { schema: ref('Pet') } } },
      },
    });
    const spec = await parse(
      {
        Pet: { type: 'object', properties: { id: { type: 'string' } } },
        Anything: { description: 'Any value.' },
        AnyAlias: ref('Anything'),
        Kind: { type: 'string', const: 'cat' },
      },
      {
        '/bare': { get: { operationId: 'bare', ...pick(ref('Anything')) } },
        '/alias': { get: { operationId: 'alias', ...pick(ref('AnyAlias')) } },
        '/wrapped': { get: { operationId: 'wrapped', ...pick({ allOf: [ref('Anything')] }) } },
        '/annotated': {
          get: { operationId: 'annotated', ...pick({ allOf: [ref('Anything'), { description: 'Any.' }] }) },
        },
        '/maybe': { get: { operationId: 'maybe', ...pick({ oneOf: [ref('Anything'), { type: 'null' }] }) } },
        '/kind': { get: { operationId: 'kind', ...pick(ref('Kind')) } },
      },
    );

    const responses = Object.fromEntries(
      spec.services.flatMap((service) => service.operations).map((op) => [op.name, op.response]),
    );
    expect(responses).toEqual({
      bare: { kind: 'model', name: 'Pet' },
      alias: { kind: 'model', name: 'Pet' },
      wrapped: { kind: 'model', name: 'Pet' },
      annotated: { kind: 'model', name: 'Pet' },
      // `nullable<unknown>` and a literal are typed, so the 200 keeps the pick.
      maybe: nullable(unknown),
      kind: cat,
    });
  });

  it('leaves a component that declares a type no rule reads as the fieldless model it always became', async () => {
    const spec = await parse({
      Holder: {
        type: 'object',
        properties: {
          array_without_items: ref('ArrayWithoutItems'),
          object_or_string: ref('ObjectOrString'),
          array_or_string: ref('ArrayOrString'),
          null_only: ref('NullOnly'),
          null_list: ref('NullList'),
          map_without_type: ref('MapWithoutType'),
          unread_type: ref('UnreadType'),
          one_const: ref('OneConst'),
        },
      },
      ArrayWithoutItems: { type: 'array' },
      ObjectOrString: { type: ['object', 'string'] },
      ArrayOrString: { type: ['array', 'string'], items: { type: 'string' } },
      NullOnly: { type: 'null' },
      NullList: { type: ['null'] },
      MapWithoutType: { additionalProperties: { type: 'string' } },
      UnreadType: { type: 'file' },
      // A `oneOf` of string consts, one beside a `null` variant included, is an enum component, not a literal.
      OneConst: { oneOf: [{ const: 'cat' }, { type: 'null' }] },
    });

    expect(names(spec)).toEqual({
      enums: ['OneConst'],
      models: [
        'Holder',
        'ArrayWithoutItems',
        'ObjectOrString',
        'ArrayOrString',
        'NullOnly',
        'NullList',
        'MapWithoutType',
        'UnreadType',
      ],
    });
    expect(fieldsOf(spec, 'Holder').map(({ name, type }) => ({ name, type }))).toEqual([
      { name: 'array_without_items', type: { kind: 'model', name: 'ArrayWithoutItems' } },
      { name: 'object_or_string', type: { kind: 'model', name: 'ObjectOrString' } },
      { name: 'array_or_string', type: { kind: 'model', name: 'ArrayOrString' } },
      { name: 'null_only', type: { kind: 'model', name: 'NullOnly' } },
      { name: 'null_list', type: { kind: 'model', name: 'NullList' } },
      { name: 'map_without_type', type: { kind: 'model', name: 'MapWithoutType' } },
      { name: 'unread_type', type: { kind: 'model', name: 'UnreadType' } },
      { name: 'one_const', type: nullable({ kind: 'enum', name: 'OneConst' }) },
    ]);
  });
});

describe('#568', () => {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const model = (name: string) => ({ kind: 'model', name }) as const;
  const keyword = { discriminator: { propertyName: 'kind' } };
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  /** A GET whose JSON 200 body is `schema`. */
  const getOp = (operationId: string, schema: unknown) => ({
    get: {
      operationId,
      parameters: [idParam],
      responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
    },
  });
  /** A webhook whose JSON payload is `schema`. */
  const webhook = (schema: unknown) => ({
    'pet.adopted': {
      post: {
        requestBody: { content: { 'application/json': { schema } } },
        responses: { '200': { description: 'ok' } },
      },
    },
  });

  /** Parse a document of `schemas`, `paths` and `webhooks` from a file, as a spec is read. */
  async function parse(
    schemas: Record<string, unknown>,
    paths: Record<string, unknown> = {},
    openapi = '3.1.0',
    webhooks?: Record<string, unknown>,
  ): Promise<ApiSpec> {
    const dir = await mkdtemp(join(tmpdir(), 'oagen-568-'));
    try {
      const file = join(dir, 'spec.json');
      const doc = {
        openapi,
        info: { title: 'Pets', version: '1' },
        paths,
        ...(webhooks ? { webhooks } : {}),
        components: { schemas },
      };
      await writeFile(file, JSON.stringify(doc));
      return await parseSpec(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const fieldType = (spec: ApiSpec, modelName: string, field: string): TypeRef | undefined =>
    spec.models.find((m) => m.name === modelName)?.fields.find((f) => f.name === field)?.type;
  const responseOf = (spec: ApiSpec, operation: string): TypeRef | undefined =>
    spec.services.flatMap((s) => s.operations).find((o) => o.name === operation)?.response;
  const discriminatorOf = (spec: ApiSpec, name: string) => spec.models.find((m) => m.name === name)?.discriminator;

  /** The models every discriminator mapping under `type` names. */
  function mappingTargets(type: TypeRef | undefined, out: string[] = []): string[] {
    if (!type) return out;
    if (type.kind === 'union') {
      out.push(...Object.values(type.discriminator?.mapping ?? {}));
      for (const variant of type.variants) mappingTargets(variant, out);
    } else if (type.kind === 'nullable') mappingTargets(type.inner, out);
    else if (type.kind === 'array') mappingTargets(type.items, out);
    else if (type.kind === 'map') mappingTargets(type.valueType, out);
    return out;
  }
  /** Every model a mapping names — on a field, a named union, a response, a webhook payload — must exist, or an emitter dispatches to nothing. */
  const unresolvedMappingTargets = (spec: ApiSpec): string[] => {
    const known = new Set(spec.models.map((m) => m.name));
    const targets: string[] = [];
    for (const m of spec.models) {
      targets.push(...Object.values(m.discriminator?.mapping ?? {}));
      for (const f of m.fields) mappingTargets(f.type, targets);
      for (const v of m.variants ?? []) mappingTargets(v, targets);
    }
    for (const s of spec.services) for (const op of s.operations) mappingTargets(op.response, targets);
    for (const w of spec.webhooks ?? []) mappingTargets(w.requestBody, targets);
    return targets.filter((t) => !known.has(t));
  };

  describe.each(['3.1.0', '3.0.3'])('OAS %s', (openapi) => {
    /** `kind` pinned to `value`: a `const` in 3.1, a one-value `enum:` in 3.0. */
    const pin = (value: string) =>
      openapi === '3.1.0' ? { type: 'string', const: value } : { type: 'string', enum: [value] };
    const animal = (value: string, extra: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => ({
      type: 'object',
      required: ['kind'],
      properties: { kind: pin(value), ...extra },
      ...more,
    });
    const animals = {
      Bird: animal('bird', { wingspan: { type: 'number' } }),
      Cat: animal('cat', { livesLeft: { type: 'integer' } }),
      Dog: animal('dog', { barks: { type: 'boolean' } }),
      Song: { type: 'string', enum: ['chirp', 'tweet'] },
    };
    const union = (variants: unknown[], discriminated: boolean) => ({
      oneOf: variants,
      ...(discriminated ? keyword : {}),
    });
    const pet = (discriminated: boolean) => union([ref('Cat'), ref('Dog')], discriminated);
    const anyPet = (discriminated: boolean) =>
      union([ref('Cat'), ref('Dog'), { oneOf: [ref('Bird'), ref('Song')] }], discriminated);
    const petDiscriminator = { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } };
    const anyPetDiscriminator = { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog', bird: 'Bird' } };
    const petUnion = {
      kind: 'union',
      variants: [model('Cat'), model('Dog')],
      compositionKind: 'oneOf',
      discriminator: petDiscriminator,
    };
    const anyPetUnion = {
      kind: 'union',
      variants: [
        model('Cat'),
        model('Dog'),
        { kind: 'union', variants: [model('Bird'), { kind: 'enum', name: 'Song' }], compositionKind: 'oneOf' },
      ],
      compositionKind: 'oneOf',
      discriminator: anyPetDiscriminator,
    };

    it.each([true, false])(
      'the issue’s repro: an inline union of $ref variants, one wrapping a model $ref beside an enum $ref, carries the mapping the same union carries as a component, on a field and a 200 body (keyword: %s)',
      async (discriminated) => {
        const spec = await parse(
          {
            ...animals,
            Pet: pet(discriminated),
            AnyPet: anyPet(discriminated),
            Owner: {
              type: 'object',
              properties: {
                pet: pet(discriminated),
                anyPet: anyPet(discriminated),
                named: ref('Pet'),
                anyNamed: ref('AnyPet'),
              },
            },
          },
          {
            '/owners/{id}': getOp('getOwner', ref('Owner')),
            '/pets/{id}': getOp('getPet', pet(discriminated)),
            '/any-pets/{id}': getOp('getAnyPet', anyPet(discriminated)),
          },
          openapi,
        );
        expect(discriminatorOf(spec, 'Pet')).toEqual(petDiscriminator);
        expect(discriminatorOf(spec, 'AnyPet')).toEqual(anyPetDiscriminator);
        expect(fieldType(spec, 'Owner', 'pet')).toEqual(petUnion);
        expect(fieldType(spec, 'Owner', 'anyPet')).toEqual(anyPetUnion);
        expect(fieldType(spec, 'Owner', 'named')).toEqual(model('Pet'));
        expect(fieldType(spec, 'Owner', 'anyNamed')).toEqual(model('AnyPet'));
        expect(responseOf(spec, 'getPet')).toEqual(petUnion);
        expect(responseOf(spec, 'getAnyPet')).toEqual(anyPetUnion);
        expect(unresolvedMappingTargets(spec)).toEqual([]);
      },
    );

    it.each([true, false])(
      'reads a $ref variant’s const through its component’s allOf wrappers, as a named union does (keyword: %s)',
      async (discriminated) => {
        const merged = (value: string) => ({
          allOf: [ref('Animal'), { type: 'object', required: ['kind'], properties: { kind: pin(value) } }],
        });
        const spec = await parse(
          {
            Animal: { type: 'object', properties: { name: { type: 'string' } } },
            Lion: merged('lion'),
            Tiger: merged('tiger'),
            Cat: union([ref('Lion'), ref('Tiger')], discriminated),
            Owner: { type: 'object', properties: { cat: union([ref('Lion'), ref('Tiger')], discriminated) } },
          },
          {},
          openapi,
        );
        const discriminator = { property: 'kind', mapping: { lion: 'Lion', tiger: 'Tiger' } };
        expect(discriminatorOf(spec, 'Cat')).toEqual(discriminator);
        expect(fieldType(spec, 'Owner', 'cat')).toEqual({
          kind: 'union',
          variants: [model('Lion'), model('Tiger')],
          compositionKind: 'oneOf',
          discriminator,
        });
        expect(unresolvedMappingTargets(spec)).toEqual([]);
      },
    );

    it.each([
      ['a nullable wrapper', { anyOf: [ref('Bird'), { type: 'null' }] }, { kind: 'nullable', inner: model('Bird') }],
      [
        'a multi-type wrapper',
        { oneOf: [ref('Bird'), { type: 'string' }] },
        { kind: 'union', variants: [model('Bird'), { kind: 'primitive', type: 'string' }], compositionKind: 'oneOf' },
      ],
      ['an allOf read as its reference', { allOf: [ref('Bird')], description: 'A bird' }, model('Bird')],
    ])(
      'reads the const of a variant under %s from the one model it wraps, keyword or not, as a named union does (#427)',
      async (_, third, variant) => {
        for (const discriminated of [true, false]) {
          const spec = await parse(
            {
              ...animals,
              Owner: { type: 'object', properties: { pet: union([ref('Cat'), ref('Dog'), third], discriminated) } },
            },
            {},
            openapi,
          );
          expect(fieldType(spec, 'Owner', 'pet'), `keyword: ${discriminated}`).toEqual({
            kind: 'union',
            variants: [model('Cat'), model('Dog'), variant],
            compositionKind: 'oneOf',
            discriminator: anyPetDiscriminator,
          });
          expect(unresolvedMappingTargets(spec)).toEqual([]);
        }
      },
    );

    it.each([true, false])(
      'maps a $ref variant and an inline object variant alike, by the component and by the model extracted for the variant (keyword: %s)',
      async (discriminated) => {
        const spec = await parse(
          {
            ...animals,
            Owner: {
              type: 'object',
              properties: {
                pet: union([ref('Cat'), animal('dog', { barks: { type: 'boolean' } })], discriminated),
                pal: union(
                  [ref('Cat'), animal('doggo', { barks: { type: 'boolean' } }, { title: 'Doggo' })],
                  discriminated,
                ),
              },
            },
          },
          {},
          openapi,
        );
        expect(fieldType(spec, 'Owner', 'pet')).toEqual({
          kind: 'union',
          variants: [model('Cat'), model('OwnerPet')],
          compositionKind: 'oneOf',
          discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'OwnerPet' } },
        });
        // Without the keyword the union is title-mapped — the `$ref` variant's
        // const is read from `Cat` — so the titled variant keeps its title, as
        // it does beside titled variants; under the keyword titles name nothing.
        const doggo = discriminated ? 'OwnerPal' : 'Doggo';
        expect(fieldType(spec, 'Owner', 'pal')).toEqual({
          kind: 'union',
          variants: [model('Cat'), model(doggo)],
          compositionKind: 'oneOf',
          discriminator: { property: 'kind', mapping: { cat: 'Cat', doggo } },
        });
        expect(spec.models.map((m) => m.name)).toEqual(['Bird', 'Cat', 'Dog', 'Owner', 'OwnerPet', doggo]);
        expect(unresolvedMappingTargets(spec)).toEqual([]);
      },
    );

    it.each([true, false])(
      'keeps an inline-only union as it was: the field’s name and a const prefix, mapped by their consts (keyword: %s)',
      async (discriminated) => {
        const spec = await parse(
          { Owner: { type: 'object', properties: { pet: union([animal('cat'), animal('dog')], discriminated) } } },
          {},
          openapi,
        );
        expect(fieldType(spec, 'Owner', 'pet')).toEqual({
          kind: 'union',
          variants: [model('OwnerPet'), model('DogOwnerPet')],
          compositionKind: 'oneOf',
          discriminator: { property: 'kind', mapping: { cat: 'OwnerPet', dog: 'DogOwnerPet' } },
        });
        expect(unresolvedMappingTargets(spec)).toEqual([]);
      },
    );

    it.each([true, false])(
      'passes over a constant every variant shares to find the property that tells them apart, as a named union does (keyword: %s)',
      async (discriminated) => {
        const spec = await parse(
          {
            Owner: {
              type: 'object',
              properties: {
                shape: union(
                  [
                    animal('a', { version: pin('v1') }, { title: 'A' }),
                    animal('b', { version: pin('v1') }, { title: 'B' }),
                  ],
                  discriminated,
                ),
              },
            },
          },
          {},
          openapi,
        );
        // Under the keyword the titles name nothing and the variants take the
        // field's name and a const prefix; without it the union is title-mapped.
        const [a, b] = discriminated ? ['OwnerShape', 'BOwnerShape'] : ['A', 'B'];
        expect(fieldType(spec, 'Owner', 'shape')).toEqual({
          kind: 'union',
          variants: [model(a), model(b)],
          compositionKind: 'oneOf',
          discriminator: { property: 'kind', mapping: { a, b } },
        });
        expect(unresolvedMappingTargets(spec)).toEqual([]);
      },
    );

    it('maps nothing when a $ref variant’s component pins no const, and when two variants pin one value: `{}` under the keyword, no discriminator without it', async () => {
      const spec = await parse(
        {
          ...animals,
          Plain: { type: 'object', properties: { name: { type: 'string' } } },
          Owner: {
            type: 'object',
            properties: {
              unpinned: union([ref('Cat'), ref('Plain')], true),
              unpinnedImplicit: union([ref('Cat'), ref('Plain')], false),
              dup: union([animal('x', {}, { title: 'C' }), animal('x', {}, { title: 'D' })], true),
              dupImplicit: union([animal('x', {}, { title: 'C' }), animal('x', {}, { title: 'D' })], false),
            },
          },
        },
        {},
        openapi,
      );
      const plain = (discriminator?: { property: string; mapping: Record<string, string> }) => ({
        kind: 'union',
        variants: [model('Cat'), model('Plain')],
        compositionKind: 'oneOf',
        ...(discriminator ? { discriminator } : {}),
      });
      expect(fieldType(spec, 'Owner', 'unpinned')).toEqual(plain({ property: 'kind', mapping: {} }));
      expect(fieldType(spec, 'Owner', 'unpinnedImplicit')).toEqual(plain());
      // The values tell nothing apart, so no mapping is derived. Under the
      // keyword the titles name nothing and prefix the field's name; without
      // it every variant is titled and pins `kind`, so the union stays
      // title-mapped for naming and keeps the titles, while the discriminator
      // itself needs values that tell the variants apart.
      expect(fieldType(spec, 'Owner', 'dup')).toEqual({
        kind: 'union',
        variants: [model('COwnerDup'), model('DOwnerDup')],
        compositionKind: 'oneOf',
        discriminator: { property: 'kind', mapping: {} },
      });
      expect(fieldType(spec, 'Owner', 'dupImplicit')).toEqual({
        kind: 'union',
        variants: [model('C'), model('D')],
        compositionKind: 'oneOf',
      });
      expect(unresolvedMappingTargets(spec)).toEqual([]);
    });

    it.each([true, false])(
      'carries the mapping on an array’s items and on a webhook payload too (keyword: %s)',
      async (discriminated) => {
        const spec = await parse(
          { ...animals, Owner: { type: 'object', properties: { pets: { type: 'array', items: pet(discriminated) } } } },
          {},
          openapi,
          webhook(pet(discriminated)),
        );
        expect(fieldType(spec, 'Owner', 'pets')).toEqual({ kind: 'array', items: petUnion });
        expect(spec.webhooks?.[0]?.requestBody).toEqual(petUnion);
        expect(unresolvedMappingTargets(spec)).toEqual([]);
      },
    );
  });
});

describe('#539', () => {
  const ref = (path: string) => ({ $ref: `#/components/schemas/${path}` });
  const model = (name: string) => ({ kind: 'model', name }) as const;
  const string = { kind: 'primitive', type: 'string' } as const;
  const unknown = { kind: 'primitive', type: 'unknown' } as const;
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  /** A GET whose JSON 200 body is `schema`. */
  const getOp = (operationId: string, schema: unknown) => ({
    get: {
      operationId,
      parameters: [idParam],
      responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
    },
  });
  /** The issue's `Pet`: `owner` an inline object that requires `name`. */
  const Pet = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      owner: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    },
  };
  /** The issue's paths: `getPet` returning `Pet`, `getPetOwner` returning a pointer into it. */
  const pointerPaths = {
    '/pets/{id}': getOp('getPet', ref('Pet')),
    '/pets/{id}/owner': getOp('getPetOwner', ref('Pet/properties/owner')),
  };

  /**
   * Parse a document of `schemas`, `paths` and `webhooks` from a file, as a
   * spec is read; `transformSpec` edits the bundled document, the one way a
   * pointer the bundler rejects (dangling, self-referencing) reaches the parser.
   */
  async function parse(
    schemas: Record<string, unknown>,
    paths: Record<string, unknown> = {},
    openapi = '3.1.0',
    options: { webhooks?: Record<string, unknown>; transformSpec?: (doc: OpenApiDocument) => OpenApiDocument } = {},
  ): Promise<ApiSpec> {
    const dir = await mkdtemp(join(tmpdir(), 'oagen-539-'));
    try {
      const file = join(dir, 'spec.json');
      const doc = {
        openapi,
        info: { title: 'Pets', version: '1' },
        paths,
        ...(options.webhooks ? { webhooks: options.webhooks } : {}),
        components: { schemas, responses: { Problem: { description: 'A problem.' } } },
      };
      await writeFile(file, JSON.stringify(doc));
      return await parseSpec(file, options.transformSpec ? { transformSpec: options.transformSpec } : undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const operation = (spec: ApiSpec, name: string) =>
    spec.services.flatMap((s) => s.operations).find((o) => o.name === name);
  const responseOf = (spec: ApiSpec, name: string): TypeRef | undefined => operation(spec, name)?.response;
  const fieldOf = (spec: ApiSpec, modelName: string, field: string): Field | undefined =>
    spec.models.find((m) => m.name === modelName)?.fields.find((f) => f.name === field);
  const modelNames = (spec: ApiSpec): string[] => spec.models.map((m) => m.name).sort();

  let warnings: string[] = [];
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  const captureWarnings = (): void => {
    warnings = [];
    spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
  };
  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  describe.each(['3.1.0', '3.0.3'])('OpenAPI %s', (openapi) => {
    it('types a pointer into a component as the schema it lands on is typed where it stands (pointer.json)', async () => {
      captureWarnings();
      const spec = await parse({ Pet }, pointerPaths, openapi);
      // `PetOwner`, the model `Pet.owner` is built as — not a dangling `Owner`, not a copy.
      expect(responseOf(spec, 'getPetOwner')).toEqual(model('PetOwner'));
      expect(responseOf(spec, 'getPet')).toEqual(model('Pet'));
      expect(modelNames(spec)).toEqual(['Pet', 'PetOwner']);
      expect(fieldOf(spec, 'Pet', 'owner')?.type).toEqual(model('PetOwner'));
      expect(
        spec.models
          .find((m) => m.name === 'PetOwner')
          ?.fields.map(({ name, required, type }) => ({ name, required, type })),
      ).toEqual([{ name: 'name', required: true, type: string }]);
      expect(warnings).toEqual([]);
    });

    it('never types the site as an unrelated component the pointer does not name (pointer-owner.json)', async () => {
      captureWarnings();
      const spec = await parse(
        { Pet, Owner: { type: 'object', properties: { email: { type: 'string' } } } },
        pointerPaths,
        openapi,
      );
      expect(responseOf(spec, 'getPetOwner')).toEqual(model('PetOwner'));
      expect(modelNames(spec)).toEqual(['Owner', 'Pet', 'PetOwner']);
      expect(fieldOf(spec, 'Owner', 'email')?.type).toEqual(string);
      expect(warnings).toEqual([]);
    });

    it('types a pointer to a string property as string and Pets/items as the array component’s items', async () => {
      captureWarnings();
      const spec = await parse(
        {
          Pet,
          Owner: { type: 'object', properties: { email: { type: 'string' } } },
          Pets: { type: 'array', items: { type: 'object', properties: { nick: { type: 'string' } } } },
          Widgets: { type: 'array', items: ref('Owner') },
        },
        {
          '/a/{id}': getOp('getPetId', ref('Pet/properties/id')),
          '/b/{id}': getOp('getPetsItem', ref('Pets/items')),
          '/c/{id}': getOp('getWidgetsItem', ref('Widgets/items')),
        },
        openapi,
      );
      expect(responseOf(spec, 'getPetId')).toEqual(string);
      expect(responseOf(spec, 'getPetsItem')).toEqual(model('PetsItem'));
      expect(responseOf(spec, 'getWidgetsItem')).toEqual(model('Owner'));
      // No `Id` or `Item` model, which the last token used to name.
      expect(modelNames(spec)).toEqual(['Owner', 'Pet', 'PetOwner', 'PetsItem']);
      expect(warnings).toEqual([]);
    });

    it('resolves the pointer at every site: body, field, array items, map values, parameter, nullable wrapper, webhook payload', async () => {
      captureWarnings();
      const nullable = (schema: Record<string, unknown>) =>
        openapi === '3.1.0' ? { oneOf: [schema, { type: 'null' }] } : { ...schema, nullable: true };
      const webhook = {
        'pet.adopted': {
          post: {
            requestBody: { content: { 'application/json': { schema: ref('Pet/properties/owner') } } },
            responses: { '200': { description: 'ok' } },
          },
        },
      };
      const spec = await parse(
        {
          Pet,
          Kennel: {
            type: 'object',
            properties: {
              primary: ref('Pet/properties/owner'),
              residents: { type: 'array', items: ref('Pet/properties/owner') },
              by_name: { type: 'object', additionalProperties: ref('Pet/properties/owner') },
              maybe: nullable(ref('Pet/properties/owner')),
            },
          },
        },
        {
          '/owner/{id}': {
            put: {
              operationId: 'setPetOwner',
              parameters: [idParam, { name: 'pet_id', in: 'query', schema: ref('Pet/properties/id') }],
              requestBody: { content: { 'application/json': { schema: ref('Pet/properties/owner') } } },
              responses: {
                '200': {
                  description: 'OK',
                  content: { 'application/json': { schema: { type: 'array', items: ref('Pet/properties/owner') } } },
                },
              },
            },
          },
          '/maybe/{id}': getOp('getMaybeOwner', nullable(ref('Pet/properties/owner'))),
        },
        openapi,
        openapi === '3.1.0' ? { webhooks: webhook } : {},
      );
      const setPetOwner = operation(spec, 'setPetOwner');
      expect(setPetOwner?.requestBody).toEqual(model('PetOwner'));
      expect(setPetOwner?.response).toEqual({ kind: 'array', items: model('PetOwner') });
      expect(setPetOwner?.queryParams.map(({ name, type }) => ({ name, type }))).toEqual([
        { name: 'pet_id', type: string },
      ]);
      expect(fieldOf(spec, 'Kennel', 'primary')?.type).toEqual(model('PetOwner'));
      expect(fieldOf(spec, 'Kennel', 'residents')?.type).toEqual({ kind: 'array', items: model('PetOwner') });
      expect(fieldOf(spec, 'Kennel', 'by_name')?.type).toEqual({ kind: 'map', valueType: model('PetOwner') });
      // An OAS 3.0 `nullable: true` beside a `$ref` is a sibling the version ignores, as beside any `$ref`.
      const maybe = openapi === '3.1.0' ? { kind: 'nullable', inner: model('PetOwner') } : model('PetOwner');
      expect(fieldOf(spec, 'Kennel', 'maybe')?.type).toEqual(maybe);
      expect(responseOf(spec, 'getMaybeOwner')).toEqual(maybe);
      if (openapi === '3.1.0') expect(spec.webhooks?.[0]?.requestBody).toEqual(model('PetOwner'));
      // One `PetOwner`, built once for `Pet.owner`; no copy per site.
      expect(modelNames(spec)).toEqual(['Kennel', 'Pet', 'PetOwner']);
      expect(warnings).toEqual([]);
    });

    it('follows a pointer through nested properties, items, map values, union variants, allOf members and a $ref', async () => {
      captureWarnings();
      const spec = await parse(
        {
          Pet: {
            type: 'object',
            properties: {
              owner: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  address: { type: 'object', properties: { city: { type: 'string' } } },
                },
              },
              tags: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } },
              labels: {
                type: 'object',
                additionalProperties: { type: 'object', properties: { color: { type: 'string' } } },
              },
              kind: { type: 'string', enum: ['cat', 'dog'] },
              friend: ref('Owner'),
              choice: { oneOf: [ref('Cat'), ref('Dog')] },
              mate: ref('Pet/properties/owner'),
            },
          },
          Owner: { type: 'object', properties: { email: { type: 'string' } } },
          Cat: { type: 'object', properties: { kind: { type: 'string', const: 'cat' }, lives: { type: 'integer' } } },
          Dog: { type: 'object', properties: { kind: { type: 'string', const: 'dog' }, barks: { type: 'boolean' } } },
          Shape: { oneOf: [ref('Cat'), ref('Dog'), { type: 'null' }] },
          Base: {
            allOf: [
              ref('Owner'),
              { type: 'object', properties: { extra: { type: 'object', properties: { deep: { type: 'string' } } } } },
            ],
          },
        },
        {
          '/a/{id}': getOp('getOwnerName', ref('Pet/properties/owner/properties/name')),
          '/b/{id}': getOp('getOwnerAddress', ref('Pet/properties/owner/properties/address')),
          '/c/{id}': getOp('getTag', ref('Pet/properties/tags/items')),
          '/d/{id}': getOp('getLabel', ref('Pet/properties/labels/additionalProperties')),
          '/e/{id}': getOp('getKind', ref('Pet/properties/kind')),
          '/f/{id}': getOp('getFriend', ref('Pet/properties/friend')),
          '/g/{id}': getOp('getChoice', ref('Pet/properties/choice/oneOf/1')),
          '/h/{id}': getOp('getShapeDog', ref('Shape/oneOf/1')),
          '/i/{id}': getOp('getBaseOwner', ref('Base/allOf/0')),
          '/j/{id}': getOp('getBaseExtra', ref('Base/allOf/1/properties/extra')),
          '/k/{id}': getOp('getMate', ref('Pet/properties/mate')),
        },
        openapi,
      );
      expect(responseOf(spec, 'getOwnerName')).toEqual(string);
      expect(responseOf(spec, 'getOwnerAddress')).toEqual(model('PetOwnerAddress'));
      // The field's own items and values, as `Pet.tags` and `Pet.labels` are typed.
      expect(fieldOf(spec, 'Pet', 'tags')?.type).toEqual({ kind: 'array', items: model('PetTags') });
      expect(responseOf(spec, 'getTag')).toEqual(model('PetTags'));
      expect(fieldOf(spec, 'Pet', 'labels')?.type).toEqual({ kind: 'map', valueType: model('PetLabel') });
      expect(responseOf(spec, 'getLabel')).toEqual(model('PetLabel'));
      expect(responseOf(spec, 'getKind')).toEqual({ kind: 'enum', name: 'PetKind', values: ['cat', 'dog'] });
      // A pointer that lands on a `$ref` is what that `$ref` is; one that lands on a pointer, what that pointer is.
      expect(responseOf(spec, 'getFriend')).toEqual(model('Owner'));
      expect(responseOf(spec, 'getMate')).toEqual(model('PetOwner'));
      expect(responseOf(spec, 'getChoice')).toEqual(model('Dog'));
      expect(responseOf(spec, 'getShapeDog')).toEqual(model('Dog'));
      expect(responseOf(spec, 'getBaseOwner')).toEqual(model('Owner'));
      expect(responseOf(spec, 'getBaseExtra')).toEqual(model('BaseExtra'));
      expect(warnings).toEqual([]);
    });

    it('unescapes ~1 and ~0 in a component key and in a property name (RFC 6901 §4)', async () => {
      captureWarnings();
      const spec = await parse(
        {
          'a/b': { type: 'integer' },
          'c~d': { type: 'object', properties: { 'x/y': { type: 'string' }, 'p~q': { type: 'boolean' } } },
        },
        {
          '/a/{id}': getOp('getSlashKey', { $ref: '#/components/schemas/a~1b' }),
          '/b/{id}': getOp('getSlashProperty', { $ref: '#/components/schemas/c~0d/properties/x~1y' }),
          '/c/{id}': getOp('getTildeProperty', { $ref: '#/components/schemas/c~0d/properties/p~0q' }),
        },
        openapi,
      );
      expect(responseOf(spec, 'getSlashKey')).toEqual({ kind: 'primitive', type: 'integer' });
      expect(responseOf(spec, 'getSlashProperty')).toEqual(string);
      expect(responseOf(spec, 'getTildeProperty')).toEqual({ kind: 'primitive', type: 'boolean' });
      expect(warnings).toEqual([]);
    });

    it('warns once per site and types unknown for a pointer that leads nowhere, never a model it does not name', async () => {
      captureWarnings();
      const spec = await parse(
        {
          Pet: { ...Pet, properties: { ...Pet.properties, friend: ref('Owner') } },
          Owner: { type: 'object', properties: { email: { type: 'string' } } },
          Kind: { type: 'string', enum: ['a', 'b'] },
          Shape: { oneOf: [ref('Owner'), { type: 'null' }] },
          Kennel: { type: 'object', properties: { name: { type: 'string' } } },
        },
        {
          '/a/{id}': getOp('getType', ref('Pet/properties/id/type')),
          '/b/{id}': getOp('getEnumMember', ref('Kind/enum/0')),
          '/c/{id}': getOp('getNullVariant', ref('Shape/oneOf/1')),
          '/d/{id}': getOp('getThroughRef', ref('Pet/properties/friend/properties/email')),
          '/e/{id}': getOp('getOtherSection', { $ref: '#/components/responses/Problem' }),
        },
        openapi,
        {
          // The bundler rejects a dangling or self-referencing pointer, so these are written after bundling.
          transformSpec: (doc) => {
            const paths = doc.paths as Record<string, unknown>;
            paths['/f/{id}'] = getOp('getNope', ref('Pet/properties/nope'));
            paths['/g/{id}'] = getOp('getNoComponent', ref('Nope/properties/x'));
            const kennel = (doc.components as { schemas: Record<string, { properties: Record<string, unknown> }> })
              .schemas.Kennel;
            kennel.properties.self = ref('Kennel/properties/self');
            kennel.properties.loop = ref('Kennel/properties/loop2');
            kennel.properties.loop2 = ref('Kennel/properties/loop');
            return doc;
          },
        },
      );
      for (const name of [
        'getType',
        'getEnumMember',
        'getNullVariant',
        'getThroughRef',
        'getOtherSection',
        'getNope',
        'getNoComponent',
      ]) {
        expect(responseOf(spec, name), name).toEqual(unknown);
      }
      for (const field of ['self', 'loop', 'loop2'])
        expect(fieldOf(spec, 'Kennel', field)?.type, field).toEqual(unknown);
      // No `Type`, `0`, `Email`, `Problem`, `Nope` or `X` model is referenced or declared.
      expect(modelNames(spec)).toEqual(['Kennel', 'Owner', 'Pet', 'PetOwner', 'Shape']);
      expect(warnings.filter((w) => w.includes('Unresolved model reference'))).toEqual([]);
      expect(warnings.sort()).toEqual(
        [
          '[oagen] Warning: Circular schema $ref chain starting at "#/components/schemas/Kennel/properties/loop2" in Kennel.loop — typing the site as unknown',
          '[oagen] Warning: Circular schema $ref chain starting at "#/components/schemas/Kennel/properties/self" in Kennel.self — typing the site as unknown',
          '[oagen] Warning: Unresolved schema $ref "#/components/responses/Problem" in E.getOtherSection.response: only a $ref into components/schemas is followed — typing the site as unknown',
          '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Kind/enum/0" in B.getEnumMember.response: no schema at that pointer — typing the site as unknown',
          '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Nope/properties/x" in G.getNoComponent.response: no component schema "Nope" — typing the site as unknown',
          '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/friend/properties/email" in D.getThroughRef.response: no schema at that pointer — typing the site as unknown',
          '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/id/type" in A.getType.response: no schema at that pointer — typing the site as unknown',
          '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/nope" in F.getNope.response: no schema at that pointer — typing the site as unknown',
          '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Shape/oneOf/1" in C.getNullVariant.response: "oneOf/1" is the null variant, which the IR carries as nullability — typing the site as unknown',
        ].sort(),
      );
    });

    it('control: a plain component $ref keeps its typing at every site', async () => {
      captureWarnings();
      const spec = await parse(
        {
          Pet,
          Owner: { type: 'object', properties: { email: { type: 'string' } } },
          Kind: { type: 'string', enum: ['a', 'b'] },
          Pets: { type: 'array', items: ref('Pet') },
          Kennel: { type: 'object', properties: { owner: ref('Owner'), kind: ref('Kind'), pets: ref('Pets') } },
        },
        {
          '/a/{id}': getOp('getOwner', ref('Owner')),
          '/b/{id}': getOp('getKind', ref('Kind')),
          '/c/{id}': getOp('getPets', ref('Pets')),
        },
        openapi,
      );
      expect(responseOf(spec, 'getOwner')).toEqual(model('Owner'));
      expect(responseOf(spec, 'getKind')).toEqual({ kind: 'enum', name: 'Kind' });
      expect(responseOf(spec, 'getPets')).toEqual({ kind: 'array', items: model('Pet') });
      expect(fieldOf(spec, 'Kennel', 'owner')?.type).toEqual(model('Owner'));
      expect(fieldOf(spec, 'Kennel', 'kind')?.type).toEqual({ kind: 'enum', name: 'Kind' });
      expect(fieldOf(spec, 'Kennel', 'pets')?.type).toEqual({ kind: 'array', items: model('Pet') });
      expect(warnings).toEqual([]);
    });

    describe('review', () => {
      const Made = { type: 'object', properties: { ok: { type: 'boolean' } } };

      it('settles a pointer in a cookie parameter and in a secondary success body', async () => {
        captureWarnings();
        const spec = await parse(
          { Pet, Made },
          {
            '/a/{id}': {
              get: {
                operationId: 'getA',
                parameters: [idParam, { name: 'session', in: 'cookie', schema: ref('Pet/properties/id') }],
                responses: {
                  '200': { description: 'OK', content: { 'application/json': { schema: ref('Made') } } },
                  '201': {
                    description: 'Made',
                    content: { 'application/json': { schema: ref('Pet/properties/owner') } },
                  },
                },
              },
            },
          },
          openapi,
        );
        const op = operation(spec, 'getA');
        expect(op?.cookieParams?.map(({ name, type }) => ({ name, type }))).toEqual([
          { name: 'session', type: string },
        ]);
        expect(op?.response).toEqual(model('Made'));
        expect(op?.successResponses?.map(({ statusCode, type }) => ({ statusCode, type }))).toEqual([
          { statusCode: 200, type: model('Made') },
          { statusCode: 201, type: model('PetOwner') },
        ]);
        expect(modelNames(spec)).toEqual(['Made', 'Pet', 'PetOwner']);
        expect(warnings).toEqual([]);
      });

      it('chooses the iterator’s item type from the settled response: a pointer to an array of strings yields strings', async () => {
        captureWarnings();
        const paged = (operationId: string, schema: unknown) => ({
          get: {
            operationId,
            parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
            responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
          },
        });
        const spec = await parse(
          { Pet: { ...Pet, properties: { ...Pet.properties, tags: { type: 'array', items: { type: 'string' } } } } },
          {
            '/tags': paged('listTags', ref('Pet/properties/tags')),
            '/owners': paged('listOwners', ref('Pet/properties/owner')),
          },
          openapi,
        );
        const tags = operation(spec, 'listTags');
        expect(tags?.response).toEqual({ kind: 'array', items: string });
        expect(tags?.pagination?.strategy).toBe('cursor');
        expect(tags?.pagination?.itemType).toEqual(string);
        // A pointer to an object yields the object, as a `$ref` to a component does.
        const owners = operation(spec, 'listOwners');
        expect(owners?.response).toEqual(model('PetOwner'));
        expect(owners?.pagination?.itemType).toEqual(model('PetOwner'));
        expect(warnings).toEqual([]);
      });

      it('picks the primary response knowing what a pointer settles to: an untyped 200 loses to a typed 201', async () => {
        captureWarnings();
        const twoCodes = (operationId: string, ok: unknown) => ({
          get: {
            operationId,
            parameters: [idParam],
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema: ok } } },
              '201': { description: 'Made', content: { 'application/json': { schema: ref('Made') } } },
            },
          },
        });
        const spec = await parse(
          { Pet: { ...Pet, properties: { ...Pet.properties, anything: {} } }, Made },
          {
            '/a/{id}': twoCodes('getAnything', ref('Pet/properties/anything')),
            '/b/{id}': twoCodes('getId', ref('Pet/properties/id')),
            '/c/{id}': twoCodes('getNope', ref('Pet/properties/id/type')),
          },
          openapi,
        );
        const anything = operation(spec, 'getAnything');
        expect(anything?.response).toEqual(model('Made'));
        expect(anything?.responseStatusCode).toBe(201);
        expect(anything?.successResponses?.map(({ statusCode, type }) => ({ statusCode, type }))).toEqual([
          { statusCode: 200, type: unknown },
          { statusCode: 201, type: model('Made') },
        ]);
        // A pointer to a typed schema is typed, so the 200 wins as a `$ref` to a typed component does.
        const id = operation(spec, 'getId');
        expect(id?.response).toEqual(string);
        expect(id?.responseStatusCode).toBe(200);
        // One that leads nowhere settles to unknown, so it loses too, reported once at its site.
        const nope = operation(spec, 'getNope');
        expect(nope?.response).toEqual(model('Made'));
        expect(nope?.responseStatusCode).toBe(201);
        expect(warnings).toEqual([
          '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/id/type" in C.getNope.successResponses.200: no schema at that pointer — typing the site as unknown',
        ]);
      });

      it('ends a chain of pointers that reaches itself through an array component’s items', async () => {
        captureWarnings();
        const spec = await parse({ Pet }, { '/a/{id}': getOp('getPet', ref('Pet')) }, openapi, {
          // The bundler rejects a self-referencing pointer, so it is written after bundling.
          transformSpec: (doc) => {
            (doc.components as { schemas: Record<string, unknown> }).schemas.Loop = {
              type: 'array',
              items: ref('Loop/items'),
            };
            const paths = doc.paths as Record<string, unknown>;
            paths['/loop/{id}'] = getOp('getLoop', ref('Loop'));
            paths['/loop-item/{id}'] = getOp('getLoopItem', ref('Loop/items'));
            return doc;
          },
        });
        expect(responseOf(spec, 'getLoop')).toEqual({ kind: 'array', items: unknown });
        expect(responseOf(spec, 'getLoopItem')).toEqual(unknown);
        expect(modelNames(spec)).toEqual(['Pet', 'PetOwner']);
        expect(warnings.sort()).toEqual(
          [
            '[oagen] Warning: Circular schema $ref chain starting at "#/components/schemas/Loop/items" in Loop.getLoop.response — typing the site as unknown',
            '[oagen] Warning: Circular schema $ref chain starting at "#/components/schemas/Loop/items" in LoopItem.getLoopItem.response — typing the site as unknown',
          ].sort(),
        );
      });

      it('types a pointer to an allOf member as the member’s own type, and an inline member of a merge as unknown', async () => {
        captureWarnings();
        const nickname = { type: 'object', properties: { nickname: { type: 'string' } } };
        const spec = await parse(
          {
            Owner: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } },
            Pet: { allOf: [ref('Owner'), nickname] },
            Note: { type: 'object', properties: { author: { allOf: [ref('Owner'), nickname] } } },
            Solo: {
              allOf: [{ description: 'An annotation.' }, { type: 'object', properties: { only: { type: 'string' } } }],
            },
            Kind: { allOf: [{ type: 'string', enum: ['a', 'b'] }, { description: 'The kind.' }] },
          },
          {
            '/a/{id}': getOp('getPetNickname', ref('Pet/allOf/1')),
            '/b/{id}': getOp('getPetOwner', ref('Pet/allOf/0')),
            '/c/{id}': getOp('getPetNicknameField', ref('Pet/allOf/1/properties/nickname')),
            '/d/{id}': getOp('getNoteAuthorNickname', ref('Note/properties/author/allOf/1')),
            '/e/{id}': getOp('getSoloMember', ref('Solo/allOf/1')),
            '/f/{id}': getOp('getSoloAnnotation', ref('Solo/allOf/0')),
            '/g/{id}': getOp('getKindMember', ref('Kind/allOf/0')),
            '/h/{id}': getOp('getKind', ref('Kind')),
          },
          openapi,
        );
        // An inline member of a merge has no type of its own: never the merged model, which requires `Owner`'s `email`.
        expect(responseOf(spec, 'getPetNickname')).toEqual(unknown);
        expect(responseOf(spec, 'getNoteAuthorNickname')).toEqual(unknown);
        // A `$ref` member is its reference; a pointer on through an inline member reads the merged model's field.
        expect(responseOf(spec, 'getPetOwner')).toEqual(model('Owner'));
        expect(responseOf(spec, 'getPetNicknameField')).toEqual(string);
        // A member the merge reads as a property-declaring member is merged too; the one typing member beside
        // annotating members is what the `allOf` is read as (#555), so the pointer is typed as the `allOf` is.
        expect(responseOf(spec, 'getSoloMember')).toEqual(unknown);
        expect(responseOf(spec, 'getSoloAnnotation')).toEqual(unknown);
        expect(responseOf(spec, 'getKindMember')).toEqual(responseOf(spec, 'getKind'));
        expect(responseOf(spec, 'getKindMember')).not.toEqual(unknown);
        expect(modelNames(spec)).toEqual(['Note', 'NoteAuthor', 'Owner', 'Pet', 'Solo']);
        const member = (pointer: string, site: string) =>
          `[oagen] Warning: Unresolved schema $ref "#/components/schemas/${pointer}" in ${site}.response: "${pointer.slice(pointer.lastIndexOf('allOf/'))}" is an inline allOf member, which has no type of its own — typing the site as unknown`;
        expect(warnings.sort()).toEqual(
          [
            member('Pet/allOf/1', 'A.getPetNickname'),
            member('Note/properties/author/allOf/1', 'D.getNoteAuthorNickname'),
            member('Solo/allOf/1', 'E.getSoloMember'),
            member('Solo/allOf/0', 'F.getSoloAnnotation'),
          ].sort(),
        );
      });

      it('decodes percent-escapes in a component key and in a property name as the bundler does (RFC 6901 §6)', async () => {
        captureWarnings();
        const spec = await parse(
          {
            Note: { type: 'object', properties: { 'due date': { type: 'string' } } },
            'Pet Owner': { type: 'object', properties: { name: { type: 'string' } } },
          },
          {
            '/a/{id}': getOp('getNoteDueDate', { $ref: '#/components/schemas/Note/properties/due%20date' }),
            '/b/{id}': getOp('getPetOwner', { $ref: '#/components/schemas/Pet%20Owner' }),
          },
          openapi,
        );
        expect(responseOf(spec, 'getNoteDueDate')).toEqual(string);
        expect(responseOf(spec, 'getPetOwner')).toEqual(model('PetOwner'));
        // No dangling `Pet20Owner`.
        expect(modelNames(spec)).toEqual(['Note', 'PetOwner']);
        expect(warnings).toEqual([]);
      });

      describe('a discriminator mapping target the bundler hoisted from a pointer variant', () => {
        const kind = (value: string) => ({ type: 'string', enum: [value] });
        const union = {
          oneOf: [ref('Cat'), ref('Zoo/properties/dog')],
          discriminator: {
            propertyName: 'kind',
            mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Zoo/properties/dog' },
          },
        };
        const schemas = {
          Cat: { type: 'object', required: ['kind'], properties: { kind: kind('cat') } },
          Zoo: {
            type: 'object',
            properties: { dog: { type: 'object', required: ['kind'], properties: { kind: kind('dog') } } },
          },
          Pet: union,
          Home: { type: 'object', properties: { pet: union } },
        };
        const expectedUnion = (dog: string) => ({
          kind: 'union',
          variants: [model('Cat'), model(dog)],
          compositionKind: 'oneOf',
          discriminator: { property: 'kind', mapping: { cat: 'Cat', dog } },
        });

        it('is settled with the variant, to the model the variant is settled to, as a component and inline', async () => {
          captureWarnings();
          const spec = await parse(schemas, { '/pets/{id}': getOp('getPet', ref('Pet')) }, openapi);
          const pet = spec.models.find((m) => m.name === 'Pet');
          expect(pet?.variants).toEqual([model('Cat'), model('ZooDog')]);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ZooDog' } });
          expect(fieldOf(spec, 'Home', 'pet')?.type).toEqual(expectedUnion('ZooDog'));
          // The bundler keeps the hoisted copy as a component `dog`, so a model `Dog` is built for it; nothing references it.
          expect(modelNames(spec)).toEqual(['Cat', 'Dog', 'Home', 'Pet', 'Zoo', 'ZooDog']);
          expect(warnings).toEqual([]);
        });

        it('follows a rename of the variant’s model after the settle', async () => {
          captureWarnings();
          const spec = await parse(
            schemas,
            {
              '/pets/{id}': getOp('getPet', ref('Pet')),
              // A `dog` query enum of the `zoo` service takes the name `ZooDog`, so `Zoo.dog`'s model steps to `ZooDog2`.
              '/zoo': {
                get: {
                  operationId: 'listZoo',
                  parameters: [{ name: 'dog', in: 'query', schema: { type: 'string', enum: ['x', 'y'] } }],
                  responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Zoo') } } } },
                },
              },
            },
            openapi,
          );
          expect(spec.enums.map((e) => e.name)).toContain('ZooDog');
          expect(fieldOf(spec, 'Zoo', 'dog')?.type).toEqual(model('ZooDog2'));
          const pet = spec.models.find((m) => m.name === 'Pet');
          expect(pet?.variants).toEqual([model('Cat'), model('ZooDog2')]);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ZooDog2' } });
          expect(fieldOf(spec, 'Home', 'pet')?.type).toEqual(expectedUnion('ZooDog2'));
        });
      });
    });
  });

  it('names a named union’s pointer variant by nothing: no implicit discriminator is derived from it', async () => {
    captureWarnings();
    const spec = await parse(
      {
        Cat: { type: 'object', properties: { kind: { type: 'string', const: 'cat' } } },
        Pet: {
          type: 'object',
          properties: { dog: { type: 'object', properties: { kind: { type: 'string', const: 'dog' } } } },
        },
        Animal: { oneOf: [ref('Cat'), ref('Pet/properties/dog')] },
      },
      { '/a/{id}': getOp('getAnimal', ref('Animal')) },
    );
    const animal = spec.models.find((m) => m.name === 'Animal');
    expect(animal?.variants).toEqual([model('Cat'), model('PetDog')]);
    expect(animal?.discriminator).toBeUndefined();
    expect(modelNames(spec)).toEqual(['Animal', 'Cat', 'Pet', 'PetDog']);
    expect(warnings).toEqual([]);
  });
});
