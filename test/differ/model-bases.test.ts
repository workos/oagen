import { describe, it, expect } from 'vitest';
import { diffModels } from '../../src/differ/models.js';
import { documentTypes, sameShape, type DocumentShapes } from '../../src/differ/shapes.js';
import type { Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #591: `Model.bases` and `Field.inheritedFrom` are provenance, not
 * shape. The differ reports nothing for a model that comes to inherit a
 * field it used to declare, and reads two bodies that differ only in the
 * keys as one shape.
 */

const string: TypeRef = { kind: 'primitive', type: 'string' };
const model = (name: string): TypeRef => ({ kind: 'model', name });

const animal: Model = { name: 'Animal', fields: [{ name: 'name', type: string, required: true }] };
/** `Pet` declaring `name` itself. */
const declares: Model = {
  name: 'Pet',
  fields: [
    { name: 'nickname', type: string, required: false },
    { name: 'name', type: string, required: true },
  ],
};
/** `Pet` built on `Animal`, `name` taken from it. */
const inherits: Model = {
  name: 'Pet',
  fields: [
    { name: 'nickname', type: string, required: false },
    { name: 'name', type: string, required: true, inheritedFrom: model('Animal') },
  ],
  bases: [model('Animal')],
};

const shapesOf = (old: Model[], next: Model[]): DocumentShapes => ({
  old: documentTypes({ models: old, enums: [] }),
  new: documentTypes({ models: next, enums: [] }),
});

describe('#591', () => {
  it('diffModels reports nothing when a model comes to inherit a field, or to declare one it inherited', () => {
    expect(diffModels([animal, declares], [animal, inherits])).toEqual([]);
    expect(diffModels([animal, inherits], [animal, declares])).toEqual([]);
  });

  it('diffModels still reports the field a base change adds or removes', () => {
    const owned: Model = { name: 'Owned', fields: [{ name: 'ownerId', type: string, required: false }] };
    const extended: Model = {
      ...inherits,
      fields: [...inherits.fields, { name: 'ownerId', type: string, required: false, inheritedFrom: model('Owned') }],
      bases: [model('Animal'), model('Owned')],
    };
    expect(diffModels([animal, owned, inherits], [animal, owned, extended])).toMatchObject([
      { kind: 'model-modified', name: 'Pet', fieldChanges: [{ kind: 'field-added', fieldName: 'ownerId' }] },
    ]);
  });

  it('sameShape reads two bodies that differ only in the keys as one shape', () => {
    expect(sameShape(model('Pet'), model('Pet'), shapesOf([animal, declares], [animal, inherits]))).toBe(true);
    expect(sameShape(model('Pet'), model('Pet'), shapesOf([animal, inherits], [animal, declares]))).toBe(true);
    const renamed: Model = { ...inherits, name: 'Companion' };
    expect(sameShape(model('Pet'), model('Companion'), shapesOf([animal, declares], [animal, renamed]))).toBe(true);
  });
});
