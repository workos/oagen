import { describe, it, expect } from 'vitest';
import type { Model, TypeRef } from '../../src/ir/types.js';
import { unionRulesKey, unionShapeKey } from '../../src/parser/union-shape.js';

const key = (ref: TypeRef): string => (ref.kind === 'model' ? ref.name : ref.kind);

const members: TypeRef[] = [
  { kind: 'model', name: 'Cat' },
  { kind: 'model', name: 'Dog' },
];

describe('unionShapeKey / unionRulesKey', () => {
  it('is empty for a model that is no union', () => {
    const plain: Model = { name: 'Cat', fields: [] };
    expect(unionShapeKey(plain, key)).toBe('');
    expect(unionRulesKey(plain)).toBe('');
  });

  it('keeps mappings apart whose joined entries would read alike (Greptile)', () => {
    const base: Model = { name: 'U', fields: [], compositionKind: 'oneOf' };
    const a = unionRulesKey({ ...base, discriminator: { property: 'kind', mapping: { a: 'A', b: 'B' } } });
    const b = unionRulesKey({ ...base, discriminator: { property: 'kind', mapping: { 'a=A,b': 'B' } } });
    expect(a).not.toBe(b);
  });

  it('tells two unions with the same members but different dispatch rules apart', () => {
    const byKind: Model = {
      name: 'Pet',
      fields: [],
      variants: members,
      compositionKind: 'oneOf',
      discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } },
    };
    const byType: Model = { ...byKind, discriminator: { property: 'type', mapping: { cat: 'Cat', dog: 'Dog' } } };
    const remapped: Model = { ...byKind, discriminator: { property: 'kind', mapping: { cat: 'Dog', dog: 'Cat' } } };
    const anyOf: Model = { ...byKind, compositionKind: 'anyOf' };
    const undiscriminated: Model = { name: 'Pet', fields: [], variants: members, compositionKind: 'oneOf' };

    const keys = [byKind, byType, remapped, anyOf, undiscriminated].map((m) => unionShapeKey(m, key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(unionShapeKey(byKind, key)).toBe('|oneOf<Cat,Dog>|kind:oneOf|disc:"kind"[["cat","Cat"],["dog","Dog"]]');
  });

  it('ignores mapping key order, and member order only when asked to', () => {
    const a: Model = {
      name: 'Pet',
      fields: [],
      variants: members,
      compositionKind: 'oneOf',
      discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } },
    };
    const b: Model = {
      ...a,
      variants: [...members].reverse(),
      discriminator: { property: 'kind', mapping: { dog: 'Dog', cat: 'Cat' } },
    };
    expect(unionRulesKey(a)).toBe(unionRulesKey(b));
    expect(unionShapeKey(a, key, { sorted: true })).toBe(unionShapeKey(b, key, { sorted: true }));
    expect(unionShapeKey(a, key)).not.toBe(unionShapeKey(b, key));
  });
});
