import { describe, it, expect } from 'vitest';
import { settleBases } from '../../src/parser/settle-bases.js';
import { markComponentModelRef } from '../../src/parser/schemas.js';
import type { Field, Model, ModelRef, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #591 (Greptile review, rounds four and five): the parser's last
 * pass settles `Model.bases` and `Field.inheritedFrom` against the models
 * as they end — no chain of bases reaching its own model, each base once,
 * no base or inherited field a fold has since changed under the model.
 */

const string: TypeRef = { kind: 'primitive', type: 'string' };
const model = (name: string): ModelRef => ({ kind: 'model', name });
const field = (name: string, extra: Partial<Field> = {}): Field => ({ name, type: string, required: false, ...extra });
const outline = (m: Model) => ({ bases: m.bases, inherited: m.fields.map((f) => f.inheritedFrom) });

describe('#591 settleBases', () => {
  it('drops every base whose chain reaches the model, whatever the order, and keeps the rest', () => {
    const build = (): Model[] => [
      {
        name: 'A',
        fields: [field('a'), field('b', { inheritedFrom: model('B') }), field('o', { inheritedFrom: model('Other') })],
        bases: [model('B'), model('Other')],
      },
      { name: 'B', fields: [field('b'), field('a', { inheritedFrom: model('A') })], bases: [model('A')] },
      { name: 'Self', fields: [field('x', { inheritedFrom: model('Self') })], bases: [model('Self')] },
      { name: 'Chain', fields: [field('c', { inheritedFrom: model('Mid') })], bases: [model('Mid')] },
      { name: 'Mid', fields: [field('c', { inheritedFrom: model('Chain') })], bases: [model('Chain')] },
      { name: 'Other', fields: [field('o')] },
      { name: 'Fine', fields: [field('o', { inheritedFrom: model('Other') })], bases: [model('Other')] },
    ];
    for (const models of [build(), build().reverse()]) {
      settleBases(models);
      const byName = new Map(models.map((m) => [m.name, m]));
      const of = (name: string) => outline(byName.get(name)!);
      expect(of('A')).toEqual({ bases: [model('Other')], inherited: [undefined, undefined, model('Other')] });
      expect(of('B')).toEqual({ bases: undefined, inherited: [undefined, undefined] });
      expect(of('Self')).toEqual({ bases: undefined, inherited: [undefined] });
      expect(of('Chain')).toEqual({ bases: undefined, inherited: [undefined] });
      expect(of('Mid')).toEqual({ bases: undefined, inherited: [undefined] });
      expect(of('Fine')).toEqual({ bases: [model('Other')], inherited: [model('Other')] });
    }
  });

  it('keeps one entry for a base named twice, in place', () => {
    const m: Model = {
      name: 'Foo',
      fields: [field('a', { inheritedFrom: model('Bar') })],
      bases: [model('Bar'), model('Bar'), model('Baz')],
    };
    const bases = m.bases!;
    settleBases([m, { name: 'Bar', fields: [field('a')] }, { name: 'Baz', fields: [] }]);
    expect(m.bases).toBe(bases);
    expect(outline(m)).toEqual({ bases: [model('Bar'), model('Baz')], inherited: [model('Bar')] });
  });

  it('clears inheritedFrom when the base’s field differs by any key, and drops a base that ends with a field the model lacks', () => {
    const cases: Array<[string, Field, Field, boolean]> = [
      ['required', field('name', { required: true }), field('name'), false],
      ['nullable', field('name'), field('name', { type: { kind: 'nullable', inner: string } }), false],
      ['description', field('name'), field('name', { description: 'The name.' }), false],
      ['deprecated', field('name'), field('name', { deprecated: true }), false],
      ['constraints', field('name', { constraints: { maxLength: 3 } }), field('name'), false],
      [
        'same',
        field('name', { required: true, description: 'The name.' }),
        field('name', { required: true, description: 'The name.', inheritedFrom: model('Living') }),
        true,
      ],
    ];
    for (const [label, own, theirs, kept] of cases) {
      const pet: Model = {
        name: 'Pet',
        fields: [{ ...own, inheritedFrom: model('Animal') }],
        bases: [model('Animal')],
      };
      settleBases([{ name: 'Animal', fields: [theirs] }, pet]);
      expect(outline(pet), label).toEqual({
        bases: [model('Animal')],
        inherited: [kept ? model('Animal') : undefined],
      });
    }
    const pet: Model = {
      name: 'Pet',
      fields: [field('name', { inheritedFrom: model('Animal') })],
      bases: [model('Animal'), model('Owned')],
    };
    settleBases([{ name: 'Animal', fields: [field('name'), field('extra')] }, { name: 'Owned', fields: [] }, pet]);
    expect(outline(pet)).toEqual({ bases: [model('Owned')], inherited: [undefined] });
  });

  it('reads an inline model built under the inheriting model as the base’s, and a component reference as written', () => {
    const petMeta: ModelRef = model('PetMeta');
    const animalMeta: ModelRef = model('AnimalMeta');
    const shared: ModelRef = model('PetShared');
    const sharedAgain: ModelRef = model('PetShared');
    markComponentModelRef(shared);
    markComponentModelRef(sharedAgain);
    const pet: Model = {
      name: 'Pet',
      fields: [
        field('meta', { type: petMeta, inheritedFrom: model('Animal') }),
        field('shared', { type: shared, inheritedFrom: model('Animal') }),
        field('items', { type: { kind: 'array', items: petMeta }, inheritedFrom: model('Animal') }),
      ],
      bases: [model('Animal')],
    };
    const animal: Model = {
      name: 'Animal',
      fields: [
        field('meta', { type: animalMeta }),
        field('shared', { type: sharedAgain }),
        field('items', { type: { kind: 'array', items: animalMeta } }),
      ],
    };
    settleBases([
      animal,
      pet,
      { name: 'PetMeta', fields: [] },
      { name: 'AnimalMeta', fields: [] },
      { name: 'PetShared', fields: [] },
    ]);
    expect(outline(pet)).toEqual({
      bases: [model('Animal')],
      inherited: [model('Animal'), model('Animal'), model('Animal')],
    });
    // A component reference is read as written, so one the model's field
    // names and the base's does not keeps the field the model's own.
    const own: ModelRef = model('PetShared');
    markComponentModelRef(own);
    const other: Model = {
      name: 'Pet',
      fields: [field('shared', { type: own, inheritedFrom: model('Animal') })],
      bases: [model('Animal')],
    };
    settleBases([{ name: 'Animal', fields: [field('shared', { type: model('AnimalShared') })] }, other]);
    expect(outline(other)).toEqual({ bases: [model('Animal')], inherited: [undefined] });
  });

  it('reads an inline model under either model as it ends, so a nested change clears inheritedFrom and an unchanged one keeps it (Greptile, round six)', () => {
    const inherit = (metaFields: Field[]) => {
      const pet: Model = {
        name: 'Pet',
        fields: [field('meta', { type: model('PetMeta'), inheritedFrom: model('Animal') })],
        bases: [model('Animal')],
      };
      const models: Model[] = [
        { name: 'Animal', fields: [field('meta', { type: model('AnimalMeta') })] },
        pet,
        { name: 'PetMeta', fields: [field('name', { required: true }), field('deep', { type: model('PetMetaDeep') })] },
        { name: 'AnimalMeta', fields: metaFields },
        { name: 'PetMetaDeep', fields: [field('d')] },
        { name: 'AnimalMetaDeep', fields: [field('d')] },
      ];
      settleBases(models);
      return pet.fields[0]!.inheritedFrom;
    };
    // The same final shape, two levels down, under either name.
    expect(inherit([field('name', { required: true }), field('deep', { type: model('AnimalMetaDeep') })])).toEqual(
      model('Animal'),
    );
    // A fold loosened `AnimalMeta` alone (`AnimalMetaJson` onto it).
    expect(inherit([field('name'), field('extra'), field('deep', { type: model('AnimalMetaDeep') })])).toBeUndefined();
    // A change two levels down.
    const deepPet: Model = {
      name: 'Pet',
      fields: [field('meta', { type: model('PetMeta'), inheritedFrom: model('Animal') })],
      bases: [model('Animal')],
    };
    settleBases([
      { name: 'Animal', fields: [field('meta', { type: model('AnimalMeta') })] },
      deepPet,
      { name: 'PetMeta', fields: [field('deep', { type: model('PetMetaDeep') })] },
      { name: 'AnimalMeta', fields: [field('deep', { type: model('AnimalMetaDeep') })] },
      { name: 'PetMetaDeep', fields: [field('d')] },
      { name: 'AnimalMetaDeep', fields: [field('d', { required: true })] },
    ]);
    expect(deepPet.fields[0]!.inheritedFrom).toBeUndefined();
    // A model that reaches itself is read once on the way.
    const loopPet: Model = {
      name: 'Pet',
      fields: [field('node', { type: model('PetNode'), inheritedFrom: model('Animal') })],
      bases: [model('Animal')],
    };
    settleBases([
      { name: 'Animal', fields: [field('node', { type: model('AnimalNode') })] },
      loopPet,
      { name: 'PetNode', fields: [field('next', { type: { kind: 'nullable', inner: model('PetNode') } })] },
      { name: 'AnimalNode', fields: [field('next', { type: { kind: 'nullable', inner: model('AnimalNode') } })] },
    ]);
    expect(loopPet.fields[0]!.inheritedFrom).toEqual(model('Animal'));
  });

  it('reads an inline enum by its values, a component enum by name (Greptile, round six)', () => {
    const inline = (name: string, values: string[]): TypeRef => ({ kind: 'enum', name, values });
    const pet: Model = {
      name: 'Pet',
      fields: [
        field('status', { type: inline('PetStatus', ['a', 'b']), inheritedFrom: model('Animal') }),
        field('mood', { type: inline('PetMood', ['x']), inheritedFrom: model('Animal') }),
        field('kind', { type: { kind: 'enum', name: 'Kind' }, inheritedFrom: model('Animal') }),
        field('other', { type: { kind: 'enum', name: 'PetOther' }, inheritedFrom: model('Animal') }),
      ],
      bases: [model('Animal')],
    };
    settleBases([
      {
        name: 'Animal',
        fields: [
          field('status', { type: inline('AnimalStatus', ['a', 'b']) }),
          field('mood', { type: inline('AnimalMood', ['x', 'y']) }),
          field('kind', { type: { kind: 'enum', name: 'Kind' } }),
          field('other', { type: { kind: 'enum', name: 'AnimalOther' } }),
        ],
      },
      pet,
    ]);
    expect(outline(pet)).toEqual({
      bases: [model('Animal')],
      inherited: [model('Animal'), undefined, model('Animal'), undefined],
    });
  });

  it('leaves a base no model carries for validateModelRefs', () => {
    const pet: Model = {
      name: 'Pet',
      fields: [field('name', { inheritedFrom: model('Ghost') })],
      bases: [model('Ghost')],
    };
    settleBases([pet]);
    expect(outline(pet)).toEqual({ bases: [model('Ghost')], inherited: [model('Ghost')] });
  });
});
