import { describe, it, expect } from 'vitest';
import { settleBases } from '../../src/parser/settle-bases.js';
import { markComponentModelRef } from '../../src/parser/schemas.js';
import type { Field, Model, ModelRef, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #591 (Greptile review, rounds four to seven, and the maintainer's
 * review): the parser's last pass settles `Model.bases` and
 * `Field.inheritedFrom` against the models as they end — no chain of
 * bases reaching its own model, each base once, a base kept only while
 * every field it ends with is on the model as the model's own declaration
 * or as the same field, so the model is its own fields plus its bases'.
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

  it('drops a base when a field it ends with is missing on the model or differs by any key, and keeps one the model carries', () => {
    const cases: Array<[string, Field, Field, boolean]> = [
      ['required', field('name', { required: true }), field('name'), false],
      ['nullable', field('name'), field('name', { type: { kind: 'nullable', inner: string } }), false],
      ['format', field('name', { type: { kind: 'primitive', type: 'string', format: 'uuid' } }), field('name'), false],
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
        fields: [{ ...own, inheritedFrom: model('Animal') }, field('tail', { inheritedFrom: model('Animal') })],
        bases: [model('Animal')],
      };
      settleBases([{ name: 'Animal', fields: [theirs, field('tail')] }, pet]);
      expect(outline(pet), label).toEqual(
        kept
          ? { bases: [model('Animal')], inherited: [model('Animal'), model('Animal')] }
          : { bases: undefined, inherited: [undefined, undefined] },
      );
    }
    const missing: Model = {
      name: 'Pet',
      fields: [field('name', { inheritedFrom: model('Animal') })],
      bases: [model('Animal'), model('Owned')],
    };
    settleBases([{ name: 'Animal', fields: [field('name'), field('extra')] }, { name: 'Owned', fields: [] }, missing]);
    expect(outline(missing)).toEqual({ bases: [model('Owned')], inherited: [undefined] });
  });

  it('keeps a base whose field the model overrides with a declaration of its own, and drops one another base’s declaration outranked (review)', () => {
    const kinded: TypeRef = { kind: 'enum', name: 'KindedTag', values: ['cat', 'dog'] };
    // `overrides.json`: the model's own `name` overrides `Animal`'s.
    const own: Model = {
      name: 'Pet',
      fields: [field('name', { required: true, type: kinded }), field('species', { inheritedFrom: model('Animal') })],
      bases: [model('Animal')],
    };
    settleBases([{ name: 'Animal', fields: [field('name'), field('species')] }, own]);
    expect(outline(own)).toEqual({ bases: [model('Animal')], inherited: [undefined, model('Animal')] });
    // The review's document: the model carries `Tagged`'s `tag`, so
    // `Kinded` is no base and `kind` is the model's own — in either order.
    const tagged: Model = { name: 'Tagged', fields: [field('tag')] };
    const kindedModel: Model = { name: 'Kinded', fields: [field('tag', { type: kinded }), field('kind')] };
    for (const order of [
      [model('Tagged'), model('Kinded')],
      [model('Kinded'), model('Tagged')],
    ]) {
      const pet: Model = {
        name: 'Pet',
        fields: [field('tag', { inheritedFrom: model('Tagged') }), field('kind', { inheritedFrom: model('Kinded') })],
        bases: [...order],
      };
      settleBases([tagged, kindedModel, pet]);
      expect(outline(pet)).toEqual({ bases: [model('Tagged')], inherited: [model('Tagged'), undefined] });
    }
  });

  it('reads an inline model under either model as it ends, so a nested change drops the base and an unchanged one keeps it (Greptile, round six)', () => {
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
      return outline(pet);
    };
    const kept = { bases: [model('Animal')], inherited: [model('Animal')] };
    const dropped = { bases: undefined, inherited: [undefined] };
    // The same final shape, two levels down, under either name.
    expect(inherit([field('name', { required: true }), field('deep', { type: model('AnimalMetaDeep') })])).toEqual(
      kept,
    );
    // A fold loosened `AnimalMeta` alone (`AnimalMetaJson` onto it).
    expect(inherit([field('name'), field('extra'), field('deep', { type: model('AnimalMetaDeep') })])).toEqual(dropped);
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
    expect(outline(deepPet)).toEqual(dropped);
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
    expect(outline(loopPet)).toEqual(kept);
  });

  it('reads an inline enum by its values, a component enum by name (Greptile, round six)', () => {
    const inline = (name: string, values: string[]): TypeRef => ({ kind: 'enum', name, values });
    const over = (own: Field, theirs: Field) => {
      const pet: Model = {
        name: 'Pet',
        fields: [{ ...own, inheritedFrom: model('Animal') }],
        bases: [model('Animal')],
      };
      settleBases([{ name: 'Animal', fields: [theirs] }, pet]);
      return outline(pet);
    };
    const kept = { bases: [model('Animal')], inherited: [model('Animal')] };
    const dropped = { bases: undefined, inherited: [undefined] };
    expect(
      over(
        field('status', { type: inline('PetStatus', ['a', 'b']) }),
        field('status', { type: inline('AnimalStatus', ['a', 'b']) }),
      ),
    ).toEqual(kept);
    expect(
      over(
        field('mood', { type: inline('PetMood', ['x']) }),
        field('mood', { type: inline('AnimalMood', ['x', 'y']) }),
      ),
    ).toEqual(dropped);
    expect(
      over(
        field('kind', { type: { kind: 'enum', name: 'Kind' } }),
        field('kind', { type: { kind: 'enum', name: 'Kind' } }),
      ),
    ).toEqual(kept);
    expect(
      over(
        field('other', { type: { kind: 'enum', name: 'PetOther' } }),
        field('other', { type: { kind: 'enum', name: 'AnimalOther' } }),
      ),
    ).toEqual(dropped);
  });

  it('reads a discriminated union’s mapping targets by their final shapes, a component target by name (Greptile, after the merge)', () => {
    const literal = (value: string): TypeRef => ({ kind: 'literal', value });
    const union = (prefix: string): TypeRef => ({
      kind: 'union',
      variants: [model(`${prefix}Meta`), model(`Dog${prefix}Meta`)],
      compositionKind: 'oneOf',
      discriminator: { property: 'kind', mapping: { cat: `${prefix}Meta`, dog: `Dog${prefix}Meta` } },
    });
    const variants = (prefix: string, bark: Field = field('bark')): Model[] => [
      { name: `${prefix}Meta`, fields: [field('kind', { type: literal('cat') }), field('meow')] },
      { name: `Dog${prefix}Meta`, fields: [field('kind', { type: literal('dog') }), bark] },
    ];
    const over = (dogBark: Field) => {
      const pet: Model = {
        name: 'Pet',
        fields: [field('meta', { type: union('Pet'), inheritedFrom: model('Animal') })],
        bases: [model('Animal')],
      };
      settleBases([
        { name: 'Animal', fields: [field('meta', { type: union('Animal') })] },
        pet,
        ...variants('Pet'),
        ...variants('Animal', dogBark),
      ]);
      return outline(pet);
    };
    expect(over(field('bark'))).toEqual({ bases: [model('Animal')], inherited: [model('Animal')] });
    expect(over(field('bark', { required: true }))).toEqual({ bases: undefined, inherited: [undefined] });
    // A component among the targets is the same model on both sides, by name.
    const cat: ModelRef = model('Cat');
    const catAgain: ModelRef = model('Cat');
    markComponentModelRef(cat);
    markComponentModelRef(catAgain);
    const withComponent = (prefix: string, ref: ModelRef): TypeRef => ({
      kind: 'union',
      variants: [ref, model(`Dog${prefix}Meta`)],
      compositionKind: 'oneOf',
      discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: `Dog${prefix}Meta` } },
    });
    const pet: Model = {
      name: 'Pet',
      fields: [field('meta', { type: withComponent('Pet', cat), inheritedFrom: model('Animal') })],
      bases: [model('Animal')],
    };
    settleBases([
      { name: 'Animal', fields: [field('meta', { type: withComponent('Animal', catAgain) })] },
      pet,
      { name: 'Cat', fields: [] },
      ...variants('Pet'),
      ...variants('Animal'),
    ]);
    expect(outline(pet)).toEqual({ bases: [model('Animal')], inherited: [model('Animal')] });
  });

  it('reads a component reference as written, so one the model’s field names and the base’s does not is another type', () => {
    const shared: ModelRef = model('PetShared');
    const sharedAgain: ModelRef = model('PetShared');
    markComponentModelRef(shared);
    markComponentModelRef(sharedAgain);
    const pet: Model = {
      name: 'Pet',
      fields: [field('shared', { type: shared, inheritedFrom: model('Animal') })],
      bases: [model('Animal')],
    };
    settleBases([
      { name: 'Animal', fields: [field('shared', { type: sharedAgain })] },
      pet,
      { name: 'PetShared', fields: [] },
    ]);
    expect(outline(pet)).toEqual({ bases: [model('Animal')], inherited: [model('Animal')] });
    const own: ModelRef = model('PetShared');
    markComponentModelRef(own);
    const other: Model = {
      name: 'Pet',
      fields: [field('shared', { type: own, inheritedFrom: model('Animal') })],
      bases: [model('Animal')],
    };
    settleBases([{ name: 'Animal', fields: [field('shared', { type: model('AnimalShared') })] }, other]);
    expect(outline(other)).toEqual({ bases: undefined, inherited: [undefined] });
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
