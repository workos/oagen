import { describe, expect, it } from 'vitest';
import { createExampleBuilder } from '../../src/snippets/example-builder.js';
import type { ApiSpec, Field, Model } from '../../src/ir/types.js';
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
