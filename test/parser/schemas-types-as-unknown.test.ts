import { describe, it, expect, vi } from 'vitest';
import { schemaToTypeRef, typesAsUnknown } from '../../src/parser/schemas.js';
import { bodyTypesAsUnknown, classifyAndExtractResponse } from '../../src/parser/responses.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import type { TypeRef } from '../../src/ir/types.js';

/**
 * `typesAsUnknown` is the one answer to "does `schemaToTypeRef` type this as
 * the bare `unknown`": `schemaToTypeRef` returns on it, and the primary
 * response is chosen by it before any body is typed (#362 review), so the
 * two must agree on every shape.
 */
const isUnknown = (type: TypeRef): boolean => type.kind === 'primitive' && type.type === 'unknown';
const Pet = '#/components/schemas/Pet';

describe('typesAsUnknown agrees with schemaToTypeRef', () => {
  const unknownShapes: Array<[string, SchemaObject]> = [
    ['an empty schema', {}],
    ['annotations only', { description: 'anything' }],
    ['a type no rule knows', { type: 'weird' }],
    ['an array without items', { type: 'array' }],
    ['nullable without a type', { nullable: true }],
    ['type null alone', { type: 'null' }],
    ['additionalProperties without type object', { additionalProperties: {} }],
    ['a one-entry type list naming object without properties', { type: ['object'] }],
    ['a lone allOf member that is empty', { allOf: [{}] }],
    ['a lone allOf member of a type no rule knows', { allOf: [{ type: 'weird' }] }],
  ];
  const typedShapes: Array<[string, SchemaObject]> = [
    ['a primitive', { type: 'string' }],
    ['a formatted primitive', { type: 'integer', format: 'int64' }],
    ['a one-entry type list', { type: ['string'] }],
    ['a nullable type list', { type: ['string', 'null'] }],
    ['a multi-type list', { type: ['string', 'integer'] }],
    ['an empty type list (nullable unknown)', { type: [] }],
    ['a type list of null alone (nullable unknown)', { type: ['null'] }],
    ['nullable beside a type', { type: 'string', nullable: true }],
    ['a reference', { $ref: Pet }],
    ['an object with properties', { properties: { id: { type: 'string' } } }],
    ['an object with no properties', { properties: {} }],
    ['a map', { type: 'object' }],
    ['a map with typed values', { type: 'object', additionalProperties: { type: 'string' } }],
    ['an array', { items: { type: 'string' } }],
    ['an array of anything', { type: 'array', items: {} }],
    ['an enum', { enum: ['a', 'b'] }],
    ['a one-value enum', { enum: ['a'] }],
    ['a const', { const: 1 }],
    ['a null const', { const: null }],
    ['a union', { oneOf: [{ type: 'string' }, { type: 'integer' }] }],
    ['a nullable union', { oneOf: [{ type: 'string' }, { type: 'null' }] }],
    ['a lone allOf member with a type', { allOf: [{ type: 'string' }] }],
    ['a lone allOf reference', { allOf: [{ $ref: Pet }] }],
    ['an allOf merge', { allOf: [{ $ref: Pet }, { properties: { x: { type: 'string' } } }] }],
    [
      'an anyOf of objects',
      { anyOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'string' } } }] },
    ],
    [
      'properties beside a oneOf',
      { properties: { id: { type: 'string' } }, oneOf: [{ $ref: Pet }, { properties: { t: { type: 'string' } } }] },
    ],
  ];

  it.each(unknownShapes)('%s is unknown before typing and after', (_label, schema) => {
    expect(typesAsUnknown(schema)).toBe(true);
    expect(isUnknown(schemaToTypeRef(schema))).toBe(true);
  });

  it.each(typedShapes)('%s is typed before typing and after', (_label, schema) => {
    expect(typesAsUnknown(schema)).toBe(false);
    expect(isUnknown(schemaToTypeRef(schema))).toBe(false);
  });

  it('warns once, with the context, about a shape it does not read, and not about an empty schema', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      schemaToTypeRef({ type: 'weird' }, 'Weird');
      schemaToTypeRef({}, 'Empty');
      schemaToTypeRef({ type: 'weird' });
      expect(warn.mock.calls).toEqual([['[oagen] Warning: Unknown schema shape treated as unknown (context: Weird)']]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('bodyTypesAsUnknown agrees with response classification', () => {
  // Shapes classification reads its own way — `extractDirectResource` reads a
  // single-entry type list as an array through `isArraySchema`, and recurses
  // into a lone `allOf` member — beside the ones `schemaToTypeRef` decides.
  const classifiedAsTyped: Array<[string, SchemaObject]> = [
    ['a single-entry type list naming array, with items', { type: ['array'], items: { type: 'string' } }],
    ['a nullable type list naming array, with items', { type: ['array', 'null'], items: { type: 'string' } }],
    ['a nullable type list, null first', { type: ['null', 'array'], items: { type: 'string' } }],
    [
      'a single-entry type list naming object, with properties',
      { type: ['object'], properties: { id: { type: 'string' } } },
    ],
    ['a lone allOf member that is such an array', { allOf: [{ type: ['array'], items: { type: 'string' } }] }],
    [
      'a list envelope',
      {
        type: 'object',
        properties: { data: { type: 'array', items: { type: 'string' } }, total: { type: 'integer' } },
      },
    ],
    ['a reference', { $ref: Pet }],
    ['a union', { oneOf: [{ type: 'string' }, { type: 'integer' }] }],
    ['a primitive', { type: ['string'] }],
    ['an allOf merge', { allOf: [{ $ref: Pet }, { properties: { x: { type: 'string' } } }] }],
  ];
  const classifiedAsUnknown: Array<[string, SchemaObject]> = [
    ['an empty schema', {}],
    ['a type no rule knows', { type: 'weird' }],
    ['a single-entry type list naming array, without items', { type: ['array'] }],
    ['nullable without a type', { nullable: true }],
    ['a lone allOf member that is empty', { allOf: [{}] }],
  ];

  it.each(classifiedAsTyped)('%s is typed before classification and after', (_label, schema) => {
    expect(bodyTypesAsUnknown(schema)).toBe(false);
    expect(isUnknown(classifyAndExtractResponse(schema, 'Body').response)).toBe(false);
  });

  it.each(classifiedAsUnknown)('%s is unknown before classification and after', (_label, schema) => {
    expect(bodyTypesAsUnknown(schema)).toBe(true);
    expect(isUnknown(classifyAndExtractResponse(schema, 'Body').response)).toBe(true);
  });
});
