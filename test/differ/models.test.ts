import { describe, it, expect } from 'vitest';
import { diffModels, typeRefsEqual } from '../../src/differ/models.js';
import type { Model } from '../../src/ir/types.js';

const userModel: Model = {
  name: 'User',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: false },
  ],
};

describe('diffModels', () => {
  it('returns empty for identical models', () => {
    const changes = diffModels([userModel], [userModel]);
    expect(changes).toHaveLength(0);
  });

  it('detects model added', () => {
    const team: Model = {
      name: 'Team',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const changes = diffModels([userModel], [userModel, team]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'model-added', name: 'Team', classification: 'additive' });
  });

  it('detects model removed', () => {
    const team: Model = { name: 'Team', fields: [] };
    const changes = diffModels([userModel, team], [userModel]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'model-removed', name: 'Team', classification: 'breaking' });
  });

  it('detects field added (optional = additive)', () => {
    const modified: Model = {
      ...userModel,
      fields: [
        ...userModel.fields,
        { name: 'avatar_url', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
    };
    const changes = diffModels([userModel], [modified]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'model-modified', name: 'User', classification: 'additive' });
    if (changes[0].kind === 'model-modified') {
      expect(changes[0].fieldChanges).toHaveLength(1);
      expect(changes[0].fieldChanges[0]).toMatchObject({
        kind: 'field-added',
        fieldName: 'avatar_url',
        classification: 'additive',
      });
    }
  });

  it('detects field added (required = breaking)', () => {
    const modified: Model = {
      ...userModel,
      fields: [...userModel.fields, { name: 'role', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const changes = diffModels([userModel], [modified]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'model-modified', classification: 'breaking' });
  });

  it('detects field removed (breaking)', () => {
    const modified: Model = {
      ...userModel,
      fields: userModel.fields.filter((f) => f.name !== 'email'),
    };
    const changes = diffModels([userModel], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'model-modified') {
      expect(changes[0].classification).toBe('breaking');
      expect(changes[0].fieldChanges[0]).toMatchObject({ kind: 'field-removed', fieldName: 'email' });
    }
  });

  it('detects field type changed (breaking)', () => {
    const modified: Model = {
      ...userModel,
      fields: userModel.fields.map((f) =>
        f.name === 'name' ? { ...f, type: { kind: 'primitive' as const, type: 'integer' as const } } : f,
      ),
    };
    const changes = diffModels([userModel], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'model-modified') {
      expect(changes[0].classification).toBe('breaking');
      expect(changes[0].fieldChanges[0]).toMatchObject({ kind: 'field-type-changed', fieldName: 'name' });
    }
  });

  it('detects field required changed', () => {
    const modified: Model = {
      ...userModel,
      fields: userModel.fields.map((f) => (f.name === 'created_at' ? { ...f, required: true } : f)),
    };
    const changes = diffModels([userModel], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'model-modified') {
      expect(changes[0].fieldChanges[0]).toMatchObject({
        kind: 'field-required-changed',
        fieldName: 'created_at',
        classification: 'breaking',
      });
    }
  });
});

describe('typeRefsEqual', () => {
  it('compares primitive types', () => {
    expect(typeRefsEqual({ kind: 'primitive', type: 'string' }, { kind: 'primitive', type: 'string' })).toBe(true);
    expect(typeRefsEqual({ kind: 'primitive', type: 'string' }, { kind: 'primitive', type: 'integer' })).toBe(false);
  });

  it('compares primitive format changes', () => {
    expect(
      typeRefsEqual(
        { kind: 'primitive', type: 'string', format: 'date-time' },
        { kind: 'primitive', type: 'string', format: 'email' },
      ),
    ).toBe(false);
    expect(
      typeRefsEqual(
        { kind: 'primitive', type: 'string', format: 'date-time' },
        { kind: 'primitive', type: 'string', format: 'date-time' },
      ),
    ).toBe(true);
    expect(
      typeRefsEqual({ kind: 'primitive', type: 'string' }, { kind: 'primitive', type: 'string', format: 'email' }),
    ).toBe(false);
  });

  it('compares array types', () => {
    expect(
      typeRefsEqual(
        { kind: 'array', items: { kind: 'primitive', type: 'string' } },
        { kind: 'array', items: { kind: 'primitive', type: 'string' } },
      ),
    ).toBe(true);
  });

  it('compares array types with different items', () => {
    expect(
      typeRefsEqual(
        { kind: 'array', items: { kind: 'primitive', type: 'string' } },
        { kind: 'array', items: { kind: 'primitive', type: 'integer' } },
      ),
    ).toBe(false);
  });

  it('compares model refs', () => {
    expect(typeRefsEqual({ kind: 'model', name: 'User' }, { kind: 'model', name: 'User' })).toBe(true);
    expect(typeRefsEqual({ kind: 'model', name: 'User' }, { kind: 'model', name: 'Team' })).toBe(false);
  });

  it('compares enum refs', () => {
    expect(typeRefsEqual({ kind: 'enum', name: 'Status' }, { kind: 'enum', name: 'Status' })).toBe(true);
    expect(typeRefsEqual({ kind: 'enum', name: 'Status' }, { kind: 'enum', name: 'Role' })).toBe(false);
  });

  it('compares nullable types', () => {
    expect(
      typeRefsEqual(
        { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
        { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
      ),
    ).toBe(true);
    expect(
      typeRefsEqual(
        { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
        { kind: 'nullable', inner: { kind: 'primitive', type: 'integer' } },
      ),
    ).toBe(false);
  });

  it('compares union types with same variants', () => {
    expect(
      typeRefsEqual(
        {
          kind: 'union',
          variants: [
            { kind: 'model', name: 'A' },
            { kind: 'model', name: 'B' },
          ],
        },
        {
          kind: 'union',
          variants: [
            { kind: 'model', name: 'A' },
            { kind: 'model', name: 'B' },
          ],
        },
      ),
    ).toBe(true);
  });

  it('compares union types with different length', () => {
    expect(
      typeRefsEqual(
        { kind: 'union', variants: [{ kind: 'model', name: 'A' }] },
        {
          kind: 'union',
          variants: [
            { kind: 'model', name: 'A' },
            { kind: 'model', name: 'B' },
          ],
        },
      ),
    ).toBe(false);
  });

  it('compares union types with different order', () => {
    expect(
      typeRefsEqual(
        {
          kind: 'union',
          variants: [
            { kind: 'model', name: 'A' },
            { kind: 'model', name: 'B' },
          ],
        },
        {
          kind: 'union',
          variants: [
            { kind: 'model', name: 'B' },
            { kind: 'model', name: 'A' },
          ],
        },
      ),
    ).toBe(false);
  });

  it('compares union discriminator changes', () => {
    const base = { kind: 'union' as const, variants: [{ kind: 'model' as const, name: 'A' }] };
    expect(
      typeRefsEqual(
        { ...base, discriminator: { property: 'type', mapping: { a: 'A' } } },
        { ...base, discriminator: { property: 'type', mapping: { a: 'A' } } },
      ),
    ).toBe(true);
    expect(
      typeRefsEqual(
        { ...base, discriminator: { property: 'type', mapping: { a: 'A' } } },
        { ...base, discriminator: { property: 'kind', mapping: { a: 'A' } } },
      ),
    ).toBe(false);
    expect(
      typeRefsEqual(
        { ...base, discriminator: { property: 'type', mapping: { a: 'A' } } },
        { ...base, discriminator: { property: 'type', mapping: { a: 'B' } } },
      ),
    ).toBe(false);
    expect(typeRefsEqual({ ...base, discriminator: { property: 'type', mapping: { a: 'A' } } }, { ...base })).toBe(
      false,
    );
  });

  it('compares nested types: array<nullable<model>>', () => {
    expect(
      typeRefsEqual(
        { kind: 'array', items: { kind: 'nullable', inner: { kind: 'model', name: 'User' } } },
        { kind: 'array', items: { kind: 'nullable', inner: { kind: 'model', name: 'User' } } },
      ),
    ).toBe(true);
    expect(
      typeRefsEqual(
        { kind: 'array', items: { kind: 'nullable', inner: { kind: 'model', name: 'User' } } },
        { kind: 'array', items: { kind: 'nullable', inner: { kind: 'model', name: 'Team' } } },
      ),
    ).toBe(false);
  });

  it('compares different kinds', () => {
    expect(typeRefsEqual({ kind: 'primitive', type: 'string' }, { kind: 'model', name: 'User' })).toBe(false);
  });

  it('returns false when union discriminator mappings have different number of keys', () => {
    expect(
      typeRefsEqual(
        {
          kind: 'union',
          variants: [{ kind: 'model', name: 'A' }, { kind: 'model', name: 'B' }],
          discriminator: { property: 'type', mapping: { a: 'A', b: 'B' } },
        },
        {
          kind: 'union',
          variants: [{ kind: 'model', name: 'A' }, { kind: 'model', name: 'B' }],
          discriminator: { property: 'type', mapping: { a: 'A' } },
        },
      ),
    ).toBe(false);
  });

  it('returns true when union discriminator mapping keys are in different order', () => {
    expect(
      typeRefsEqual(
        {
          kind: 'union',
          variants: [{ kind: 'model', name: 'A' }, { kind: 'model', name: 'Z' }],
          discriminator: { property: 'type', mapping: { z: 'Z', a: 'A' } },
        },
        {
          kind: 'union',
          variants: [{ kind: 'model', name: 'A' }, { kind: 'model', name: 'Z' }],
          discriminator: { property: 'type', mapping: { a: 'A', z: 'Z' } },
        },
      ),
    ).toBe(true);
  });

  it('returns true when both unions have no discriminator', () => {
    expect(
      typeRefsEqual(
        {
          kind: 'union',
          variants: [{ kind: 'model', name: 'A' }, { kind: 'model', name: 'B' }],
        },
        {
          kind: 'union',
          variants: [{ kind: 'model', name: 'A' }, { kind: 'model', name: 'B' }],
        },
      ),
    ).toBe(true);
  });
});

describe('diffModels edge cases', () => {
  it('detects multiple field changes in one model', () => {
    const old: Model = {
      name: 'User',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    };
    const modified: Model = {
      name: 'User',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'integer' }, required: true },
        { name: 'email', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
    };
    const changes = diffModels([old], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'model-modified') {
      // field-removed (name), field-type-changed (id), field-added (email)
      expect(changes[0].fieldChanges.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('returns empty for model with empty fields', () => {
    const m: Model = { name: 'Empty', fields: [] };
    const changes = diffModels([m], [m]);
    expect(changes).toHaveLength(0);
  });
});
