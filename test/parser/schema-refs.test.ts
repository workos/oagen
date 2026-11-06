import { describe, it, expect } from 'vitest';
import { componentKeyOf, schemaAtPointer, schemaRefTarget, schemaRefTokens } from '../../src/parser/schema-refs.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

describe('#539 schema $ref reading', () => {
  const Pet: SchemaObject = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      owner: { type: 'object', properties: { name: { type: 'string' } } },
      friend: { $ref: '#/components/schemas/Owner' },
      tags: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } },
      'x/y': { type: 'integer' },
    },
    allOf: [{ $ref: '#/components/schemas/Base' }, { properties: { extra: { type: 'boolean' } } }],
    oneOf: [{ type: 'string' }, { type: 'null' }],
    enum: ['a', 'b'],
  };
  const schemas: Record<string, SchemaObject> = {
    Pet,
    Owner: { type: 'object', properties: { email: { type: 'string' } } },
    'a/b': { type: 'integer' },
    'c~d': { type: 'number' },
    'Pet Owner': { type: 'object', properties: { 'due date': { type: 'string' } } },
  };

  describe('schemaRefTokens', () => {
    it('reads a component ref as one token and a pointer deeper into it as the tokens after the map', () => {
      expect(schemaRefTokens('#/components/schemas/Pet')).toEqual(['Pet']);
      expect(schemaRefTokens('#/components/schemas/Pet/properties/owner')).toEqual(['Pet', 'properties', 'owner']);
      expect(schemaRefTokens('#/components/schemas/Pets/items')).toEqual(['Pets', 'items']);
    });

    it('undoes JSON Pointer escapes, ~1 before ~0', () => {
      expect(schemaRefTokens('#/components/schemas/a~1b')).toEqual(['a/b']);
      expect(schemaRefTokens('#/components/schemas/c~0d/properties/x~1y')).toEqual(['c~d', 'properties', 'x/y']);
      // `~01` is `~1` once unescaped, never `/`.
      expect(schemaRefTokens('#/components/schemas/a~01b')).toEqual(['a~1b']);
    });

    it('decodes percent-escapes after the pointer escapes, per token, as the bundler does (RFC 6901 §6)', () => {
      expect(schemaRefTokens('#/components/schemas/Pet%20Owner')).toEqual(['Pet Owner']);
      expect(schemaRefTokens('#/components/schemas/Note/properties/due%20date')).toEqual([
        'Note',
        'properties',
        'due date',
      ]);
      // A `%2F` decodes inside its token and never splits one; `~1` is undone first, so `%7E1` is `~1`, not `/`.
      expect(schemaRefTokens('#/components/schemas/a%2Fb')).toEqual(['a/b']);
      expect(schemaRefTokens('#/components/schemas/a%7E1b')).toEqual(['a~1b']);
      // A sequence that is no percent-escape is kept as written.
      expect(schemaRefTokens('#/components/schemas/100%25')).toEqual(['100%']);
      expect(schemaRefTokens('#/components/schemas/100%')).toEqual(['100%']);
    });

    it('reads nothing off a $ref into another section, at the map itself, or that is no string', () => {
      expect(schemaRefTokens('#/components/responses/Problem')).toBeUndefined();
      expect(schemaRefTokens('#/paths/~1pets/get/responses/200/content/application~1json/schema')).toBeUndefined();
      expect(schemaRefTokens('#/components/schemas/')).toBeUndefined();
      expect(schemaRefTokens('#/components/schemas')).toBeUndefined();
      expect(schemaRefTokens('Pet')).toBeUndefined();
      expect(schemaRefTokens(42)).toBeUndefined();
      expect(schemaRefTokens(undefined)).toBeUndefined();
    });
  });

  describe('componentKeyOf', () => {
    it('names the component of an exact component ref, escapes undone', () => {
      expect(componentKeyOf('#/components/schemas/Pet')).toBe('Pet');
      expect(componentKeyOf('#/components/schemas/a~1b')).toBe('a/b');
      expect(componentKeyOf('#/components/schemas/Pet%20Owner')).toBe('Pet Owner');
    });

    it('names no component for a pointer deeper into one or into another section', () => {
      expect(componentKeyOf('#/components/schemas/Pet/properties/owner')).toBeUndefined();
      expect(componentKeyOf('#/components/schemas/Pets/items')).toBeUndefined();
      expect(componentKeyOf('#/components/responses/Pet')).toBeUndefined();
      expect(componentKeyOf(undefined)).toBeUndefined();
    });
  });

  describe('schemaRefTarget', () => {
    it('follows a component ref to the component and a pointer to the schema inside it', () => {
      expect(schemaRefTarget('#/components/schemas/Pet', schemas)).toBe(Pet);
      expect(schemaRefTarget('#/components/schemas/Pet/properties/owner', schemas)).toBe(Pet.properties!.owner);
      expect(schemaRefTarget('#/components/schemas/Pet/properties/x~1y', schemas)).toBe(Pet.properties!['x/y']);
      expect(schemaRefTarget('#/components/schemas/a~1b', schemas)).toBe(schemas['a/b']);
      expect(schemaRefTarget('#/components/schemas/c~0d', schemas)).toBe(schemas['c~d']);
      expect(schemaRefTarget('#/components/schemas/Pet%20Owner', schemas)).toBe(schemas['Pet Owner']);
      expect(schemaRefTarget('#/components/schemas/Pet%20Owner/properties/due%20date', schemas)).toBe(
        schemas['Pet Owner']!.properties!['due date'],
      );
    });

    it('lands on a $ref schema without following it, and never passes through one', () => {
      expect(schemaRefTarget('#/components/schemas/Pet/properties/friend', schemas)).toBe(Pet.properties!.friend);
      expect(schemaRefTarget('#/components/schemas/Pet/properties/friend/properties/email', schemas)).toBeUndefined();
    });

    it('follows nothing without a map, for a missing component, or outside components/schemas', () => {
      expect(schemaRefTarget('#/components/schemas/Pet', undefined)).toBeUndefined();
      expect(schemaRefTarget('#/components/schemas/Nope/properties/x', schemas)).toBeUndefined();
      expect(schemaRefTarget('#/components/responses/Pet', schemas)).toBeUndefined();
      // An inherited key is no component.
      expect(schemaRefTarget('#/components/schemas/constructor', schemas)).toBeUndefined();
    });
  });

  describe('schemaAtPointer', () => {
    it('steps through the keywords a schema holds schemas under', () => {
      expect(schemaAtPointer(Pet, [])).toBe(Pet);
      expect(schemaAtPointer(Pet, ['properties', 'owner', 'properties', 'name'])).toBe(
        Pet.properties!.owner!.properties!.name,
      );
      expect(schemaAtPointer(Pet, ['properties', 'tags', 'items'])).toBe(Pet.properties!.tags!.items);
      expect(schemaAtPointer(Pet, ['allOf', '0'])).toBe(Pet.allOf![0]);
      expect(schemaAtPointer(Pet, ['allOf', '1', 'properties', 'extra'])).toBe(Pet.allOf![1].properties!.extra);
      expect(schemaAtPointer(Pet, ['oneOf', '1'])).toBe(Pet.oneOf![1]);
    });

    it('lands on no schema for a token that names none', () => {
      // A keyword that holds schemas, with no name or index after it.
      expect(schemaAtPointer(Pet, ['properties'])).toBeUndefined();
      expect(schemaAtPointer(Pet, ['allOf'])).toBeUndefined();
      // A keyword that holds no schema, or a value that is no object.
      expect(schemaAtPointer(Pet, ['type'])).toBeUndefined();
      expect(schemaAtPointer(Pet, ['enum', '0'])).toBeUndefined();
      expect(schemaAtPointer(Pet, ['properties', 'id', 'type'])).toBeUndefined();
      expect(schemaAtPointer(Pet, ['properties', 'nope'])).toBeUndefined();
      expect(schemaAtPointer(Pet, ['x-extension'])).toBeUndefined();
    });

    it('indexes a list as RFC 6901 §4 spells an index: digits with no leading zero, never `-`', () => {
      expect(schemaAtPointer(Pet, ['allOf', '01'])).toBeUndefined();
      expect(schemaAtPointer(Pet, ['allOf', '-'])).toBeUndefined();
      expect(schemaAtPointer(Pet, ['allOf', '2'])).toBeUndefined();
      expect(schemaAtPointer(Pet, ['allOf', 'first'])).toBeUndefined();
    });

    it('lands on no schema for a boolean schema', () => {
      const open: SchemaObject = { type: 'object', additionalProperties: true };
      expect(schemaAtPointer(open, ['additionalProperties'])).toBeUndefined();
    });
  });
});
