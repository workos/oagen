import { describe, expect, it } from 'vitest';
import { createExampleBuilder, MAX_GENERATED_ITEMS, MAX_GENERATED_LENGTH } from '../../src/snippets/example-builder.js';
import type { ApiSpec, Field, Model, Parameter } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

function makeSpec(models: Model[] = []): ApiSpec {
  return {
    name: 'TestApi',
    version: '1.0.0',
    baseUrl: 'https://api.test.com',
    services: [],
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

describe('snippets/example-builder', () => {
  it('prefers an explicit `example` over derived defaults', () => {
    const builder = createExampleBuilder(makeSpec());
    const f: Field = {
      name: 'email',
      type: { kind: 'primitive', type: 'string', format: 'email' },
      required: true,
      example: 'spec-author@example.com',
    };
    expect(builder.forField(f)).toBe('spec-author@example.com');
  });

  it('falls back to `default` when no `example` is set', () => {
    const builder = createExampleBuilder(makeSpec());
    const f: Field = {
      name: 'limit',
      type: { kind: 'primitive', type: 'integer' },
      required: true,
      default: 50,
    };
    expect(builder.forField(f)).toBe(50);
  });

  it('derives a typed default by primitive + format when neither is set', () => {
    const builder = createExampleBuilder(makeSpec());
    expect(builder.forType({ kind: 'primitive', type: 'string', format: 'email' })).toBe('user@example.com');
    expect(builder.forType({ kind: 'primitive', type: 'string', format: 'date-time' })).toBe(
      '2026-01-15T12:00:00.000Z',
    );
    expect(builder.forType({ kind: 'primitive', type: 'string' })).toBe('string_example');
    expect(builder.forType({ kind: 'primitive', type: 'integer' })).toBe(1);
    expect(builder.forType({ kind: 'primitive', type: 'boolean' })).toBe(true);
  });

  it('uses the first enum value for enum types', () => {
    const builder = createExampleBuilder(makeSpec());
    expect(builder.forType({ kind: 'enum', name: 'Order', values: ['asc', 'desc'] })).toBe('asc');
  });

  it('walks model fields, skipping deprecated and readOnly fields', () => {
    const model: Model = {
      name: 'Org',
      fields: [
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true, example: 'Foo' },
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, readOnly: true },
        {
          name: 'legacy_field',
          type: { kind: 'primitive', type: 'string' },
          required: false,
          deprecated: true,
        },
      ],
    };
    const builder = createExampleBuilder(makeSpec([model]));
    expect(builder.forModel('Org')).toEqual({ name: 'Foo' });
  });

  it('caps recursion depth on cyclic models', () => {
    const cyclic: Model = {
      name: 'Node',
      fields: [{ name: 'child', type: { kind: 'model', name: 'Node' }, required: true }],
    };
    const builder = createExampleBuilder(makeSpec([cyclic]));
    // Should return a nested structure capped at MAX_DEPTH (6), not blow the stack.
    expect(() => builder.forModel('Node')).not.toThrow();
  });
});

describe('snippets/example-builder: constraints', () => {
  const builder = createExampleBuilder(makeSpec());
  const integer = { kind: 'primitive', type: 'integer' } as const;
  const number = { kind: 'primitive', type: 'number' } as const;
  const string = { kind: 'primitive', type: 'string' } as const;

  it('never adjusts a document-given example or default, even when it violates a limit', () => {
    const f: Field = {
      name: 'n',
      type: string,
      required: true,
      example: 'far too long',
      constraints: { maxLength: 2 },
    };
    expect(builder.forField(f)).toBe('far too long');
    const d: Field = { name: 'n', type: integer, required: true, default: 0, constraints: { minimum: 10 } };
    expect(builder.forField(d)).toBe(0);
    const p: Parameter = { name: 'limit', type: integer, required: true, example: 500, constraints: { maximum: 100 } };
    expect(builder.forParameter(p)).toBe(500);
  });

  it('anchors numbers at the lowest declared bound, else the highest, else 1', () => {
    expect(builder.forType(integer)).toBe(1);
    expect(builder.forType(integer, { minimum: 10, maximum: 100 })).toBe(10);
    expect(builder.forType(integer, { exclusiveMinimum: 0 })).toBe(1);
    expect(builder.forType(integer, { exclusiveMinimum: 10, maximum: 100 })).toBe(11);
    expect(builder.forType(integer, { maximum: 5 })).toBe(5);
    expect(builder.forType(integer, { exclusiveMaximum: 5 })).toBe(4);
    expect(builder.forType(number, { maximum: 0.5 })).toBe(0.5);
    expect(builder.forType(integer, { minimum: -3 })).toBe(-3);
  });

  it('rounds numbers up to the next multipleOf that fits and keeps integers integral', () => {
    expect(builder.forType(integer, { minimum: 1, multipleOf: 5 })).toBe(5);
    expect(builder.forType(integer, { multipleOf: 3 })).toBe(3);
    expect(builder.forType(number, { exclusiveMinimum: 0, multipleOf: 0.5 })).toBe(0.5);
    expect(builder.forType(number, { minimum: 0.1, multipleOf: 0.25 })).toBe(0.25);
    expect(builder.forType(integer, { minimum: 1.5 })).toBe(2);
    expect(builder.forType(integer, { exclusiveMinimum: 2, multipleOf: 2 })).toBe(4);
  });

  it('returns the lower bound when the bounds are contradictory', () => {
    expect(builder.forType(integer, { minimum: 10, maximum: 5 })).toBe(10);
    expect(builder.forType(integer, { minimum: 4, maximum: 5, multipleOf: 3 })).toBe(4);
    expect(builder.forType(integer, { exclusiveMinimum: 4, exclusiveMaximum: 5 })).toBe(5);
  });

  it('clamps the plain string sample to minLength/maxLength and leaves format-driven values alone', () => {
    expect(builder.forType(string, { maxLength: 5 })).toBe('strin');
    expect(builder.forType(string, { minLength: 20 })).toBe('string_examplestring');
    expect(builder.forType(string, { minLength: 3, maxLength: 8 })).toBe('string_e');
    expect(builder.forType(string, { minLength: 20, maxLength: 4 })).toBe('stri');
    expect(builder.forType(string, { maxLength: 0 })).toBe('');
    expect(builder.forType({ ...string, format: 'email' }, { maxLength: 3 })).toBe('user@example.com');
    expect(builder.forType({ ...string, format: 'uuid' }, { minLength: 50 })).toBe(
      '00000000-0000-0000-0000-000000000000',
    );
  });

  it('keeps the plain sample when only a pattern is declared', () => {
    expect(builder.forType(string, { pattern: '^[0-9]{4}$' })).toBe('string_example');
    expect(builder.forType(string, { pattern: '^[A-Z]', maxLength: 6 })).toBe('string');
  });

  it('emits max(1, minItems) array items capped at maxItems', () => {
    const strings = { kind: 'array', items: string } as const;
    expect(builder.forType(strings)).toEqual(['string_example']);
    expect(builder.forType(strings, { minItems: 3 })).toEqual(['string_example', 'string_example', 'string_example']);
    expect(builder.forType(strings, { minItems: 5, maxItems: 2 })).toEqual(['string_example', 'string_example']);
    expect(builder.forType(strings, { maxItems: 0 })).toEqual([]);
    expect(builder.forType(strings, { maxItems: 3 })).toEqual(['string_example']);
  });

  it('varies generated primitives by index under uniqueItems', () => {
    expect(builder.forType({ kind: 'array', items: string }, { minItems: 3, uniqueItems: true })).toEqual([
      'string_example',
      'string_example1',
      'string_example2',
    ]);
    expect(builder.forType({ kind: 'array', items: integer }, { minItems: 3, uniqueItems: true })).toEqual([1, 2, 3]);
    expect(builder.forType({ kind: 'array', items: number }, { minItems: 2, uniqueItems: true })).toEqual([1, 2]);
    // A single item needs no variation, and the suffix is kept when truncating.
    expect(builder.forType({ kind: 'array', items: string }, { uniqueItems: true })).toEqual(['string_example']);
    const field: Field = {
      name: 'tags',
      type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
      required: true,
      constraints: { minItems: 2, uniqueItems: true },
    };
    expect(builder.forField(field)).toEqual(['string_example', 'string_example1']);
  });

  it('does not carry array limits into the items themselves', () => {
    // minLength belongs to the array field's schema, not to its items; items stay unconstrained.
    expect(builder.forType({ kind: 'array', items: string }, { minItems: 1, maxLength: 3 })).toEqual([
      'string_example',
    ]);
  });

  it('emits minProperties distinct map keys capped at maxProperties', () => {
    const map = { kind: 'map', valueType: integer } as const;
    expect(builder.forType(map)).toEqual({ key: 1 });
    expect(builder.forType(map, { minProperties: 3 })).toEqual({ key1: 1, key2: 1, key3: 1 });
    expect(builder.forType(map, { minProperties: 3, maxProperties: 2 })).toEqual({ key1: 1, key2: 1 });
    expect(builder.forType(map, { maxProperties: 0 })).toEqual({});
    expect(builder.forType(map, { minProperties: 1 })).toEqual({ key: 1 });
  });

  it('ignores model-level minProperties/maxProperties since every field is emitted anyway', () => {
    const model: Model = {
      name: 'Wide',
      fields: [
        { name: 'a', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'b', type: { kind: 'primitive', type: 'integer' }, required: false, constraints: { minimum: 7 } },
      ],
      constraints: { minProperties: 5, maxProperties: 1 },
    };
    expect(createExampleBuilder(makeSpec([model])).forModel('Wide')).toEqual({ a: 'string_example', b: 7 });
  });

  it('applies constraints through nullable and union wrappers', () => {
    expect(builder.forType({ kind: 'nullable', inner: integer }, { minimum: 3 })).toBe(3);
    expect(builder.forType({ kind: 'union', variants: [string, integer] }, { maxLength: 2 })).toBe('st');
  });

  it('builds parameter values from example, then default, then constraints', () => {
    const base: Parameter = {
      name: 'limit',
      type: integer,
      required: false,
      constraints: { minimum: 1, maximum: 100 },
    };
    expect(builder.forParameter(base)).toBe(1);
    expect(builder.forParameter({ ...base, constraints: { minimum: 10, maximum: 100 } })).toBe(10);
    expect(builder.forParameter({ ...base, default: 50 })).toBe(50);
    expect(builder.forParameter({ ...base, default: 50, example: 25 })).toBe(25);
    expect(builder.forParameter({ name: 'q', type: string, required: false })).toBe('string_example');
  });
});

describe('snippets/example-builder: size budget, satisfiable numbers, unique booleans', () => {
  const builder = createExampleBuilder(makeSpec());
  const integer = { kind: 'primitive', type: 'integer' } as const;
  const number = { kind: 'primitive', type: 'number' } as const;
  const string = { kind: 'primitive', type: 'string' } as const;
  const boolean = { kind: 'primitive', type: 'boolean' } as const;

  it('caps generated strings, arrays and maps at the size budget instead of allocating the minimum', () => {
    const long = builder.forType(string, { minLength: 1_000_000_000 }) as string;
    expect(long.length).toBe(MAX_GENERATED_LENGTH);
    expect(long.startsWith('string_examplestring_example')).toBe(true);
    // The budget caps the padding; maxLength still truncates below it.
    expect((builder.forType(string, { minLength: 1_000_000, maxLength: 10 }) as string).length).toBe(10);

    const items = builder.forType({ kind: 'array', items: integer }, { minItems: 1_000_000_000 }) as unknown[];
    expect(items.length).toBe(MAX_GENERATED_ITEMS);
    expect(builder.forType({ kind: 'array', items: integer }, { minItems: 1_000_000, maxItems: 3 })).toEqual([1, 1, 1]);

    const entries = builder.forType({ kind: 'map', valueType: integer }, { minProperties: 1_000_000_000 });
    expect(Object.keys(entries as object)).toHaveLength(MAX_GENERATED_ITEMS);
    expect(
      Object.keys(
        builder.forType({ kind: 'map', valueType: integer }, { minProperties: 99, maxProperties: 2 }) as object,
      ),
    ).toEqual(['key1', 'key2']);
  });

  it('rounds down to the previous multiple when the anchor is an upper bound', () => {
    expect(builder.forType(integer, { maximum: 5, multipleOf: 2 })).toBe(4);
    expect(builder.forType(integer, { exclusiveMaximum: 5, multipleOf: 2 })).toBe(4);
    expect(builder.forType(integer, { exclusiveMaximum: 4, multipleOf: 2 })).toBe(2);
    expect(builder.forType(number, { maximum: 1, multipleOf: 0.3 })).toBe(0.9);
  });

  it('picks a value strictly inside exclusive bounds', () => {
    expect(builder.forType(number, { exclusiveMinimum: 0, exclusiveMaximum: 1 })).toBe(0.5);
    expect(builder.forType(integer, { exclusiveMinimum: 0, exclusiveMaximum: 2 })).toBe(1);
    expect(builder.forType(number, { exclusiveMinimum: 0, maximum: 0.25 })).toBe(0.125);
    expect(builder.forType(integer, { exclusiveMinimum: 3, multipleOf: 2 })).toBe(4);
  });

  it('snaps to a multiple inside a two-sided range', () => {
    expect(builder.forType(integer, { minimum: 3, maximum: 5, multipleOf: 2 })).toBe(4);
    expect(builder.forType(number, { minimum: 3, maximum: 5, multipleOf: 2 })).toBe(4);
    expect(builder.forType(number, { minimum: 0, maximum: 10 })).toBe(5);
    expect(builder.forType(number, { minimum: 0, maximum: 10, multipleOf: 3 })).toBe(6);
    expect(builder.forType(number, { minimum: 0.7, maximum: 0.8, multipleOf: 0.25 })).toBe(0.75);
    expect(builder.forType(integer, { minimum: 0, maximum: 10 })).toBe(0);
  });

  it('returns the lower bound only when nothing can satisfy every limit at once', () => {
    expect(builder.forType(integer, { minimum: 3, maximum: 4, multipleOf: 5 })).toBe(3);
    expect(builder.forType(number, { minimum: 3, maximum: 4, multipleOf: 5 })).toBe(3);
    expect(builder.forType(integer, { minimum: 10, maximum: 5 })).toBe(10);
    expect(builder.forType(integer, { exclusiveMinimum: 4, exclusiveMaximum: 5 })).toBe(5);
  });

  it('alternates booleans under uniqueItems and caps a unique boolean array at two items', () => {
    const booleans = { kind: 'array', items: boolean } as const;
    expect(builder.forType(booleans, { minItems: 2, uniqueItems: true })).toEqual([true, false]);
    expect(builder.forType(booleans, { minItems: 5, uniqueItems: true })).toEqual([true, false]);
    expect(
      builder.forType(
        { kind: 'array', items: { kind: 'nullable', inner: boolean } },
        { minItems: 3, uniqueItems: true },
      ),
    ).toEqual([true, false]);
    expect(builder.forType(booleans, { minItems: 3 })).toEqual([true, true, true]);
    expect(builder.forType(boolean)).toBe(true);
  });
});
