import { describe, it, expect } from 'vitest';
import {
  collectFieldDependencies,
  collectModelTypeRefs,
  dropCircularBases,
  renameModelRefs,
} from '../../src/ir/types.js';
import type { Model, ModelRef, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #591: `Model.bases` and `Field.inheritedFrom` are provenance, not
 * types a model owns. `collectModelTypeRefs` leaves them out, so every pass
 * that fingerprints or compares a model by its type refs reads a model with
 * and without them alike, while `renameModelRefs` repoints them with the
 * fields, so a base renamed or folded away is named by its new name.
 */

const string: TypeRef = { kind: 'primitive', type: 'string' };
const model = (name: string): ModelRef => ({ kind: 'model', name });

/** `Pet` over `Animal`: `name` inherited, `nickname` its own, `owner` typed as `Owner`. */
const pet = (): Model => ({
  name: 'Pet',
  fields: [
    { name: 'nickname', type: string, required: false },
    { name: 'name', type: string, required: true, inheritedFrom: model('Animal') },
    { name: 'owner', type: model('Owner'), required: false, inheritedFrom: model('Animal') },
  ],
  bases: [model('Animal'), model('Owned')],
});

describe('#591', () => {
  it('collectModelTypeRefs lists the field types and leaves the bases and inheritedFrom out', () => {
    const m = pet();
    expect(collectModelTypeRefs(m)).toEqual([string, string, model('Owner')]);
    expect(collectFieldDependencies(m).models).toEqual(new Set(['Owner']));
  });

  it('renameModelRefs repoints the bases and each field’s inheritedFrom with the field types', () => {
    const m = pet();
    expect(renameModelRefs(m, new Map([['Animal', 'Beast']]))).toBe(true);
    expect(m.bases).toEqual([model('Beast'), model('Owned')]);
    expect(m.fields.map((f) => f.inheritedFrom)).toEqual([undefined, model('Beast'), model('Beast')]);
    expect(m.fields[2]!.type).toEqual(model('Owner'));
    expect(
      renameModelRefs(
        m,
        new Map([
          ['Owned', 'Possessed'],
          ['Owner', 'Keeper'],
        ]),
      ),
    ).toBe(true);
    expect(m.bases).toEqual([model('Beast'), model('Possessed')]);
    expect(m.fields[2]!.type).toEqual(model('Keeper'));
    // Each reference is looked up once: `Animal` moves to `Beast`, never on to `Creature`.
    const fresh = pet();
    expect(
      renameModelRefs(
        fresh,
        new Map([
          ['Animal', 'Beast'],
          ['Beast', 'Creature'],
        ]),
      ),
    ).toBe(true);
    expect(fresh.bases).toEqual([model('Beast'), model('Owned')]);
    expect(fresh.fields[1]!.inheritedFrom).toEqual(model('Beast'));
  });

  it('renameModelRefs keeps one entry when a rename sends two bases to one name (Greptile)', () => {
    const m: Model = {
      name: 'Foo',
      fields: [
        { name: 'a', type: string, required: false, inheritedFrom: model('Bar') },
        { name: 'b', type: string, required: false, inheritedFrom: model('BarJson') },
      ],
      bases: [model('Bar'), model('BarJson'), model('Other')],
    };
    const bases = m.bases!;
    expect(renameModelRefs(m, new Map([['BarJson', 'Bar']]))).toBe(true);
    expect(m.bases).toBe(bases);
    expect(m.bases).toEqual([model('Bar'), model('Other')]);
    expect(m.fields.map((f) => f.inheritedFrom)).toEqual([model('Bar'), model('Bar')]);
  });

  it('dropCircularBases drops every base whose chain reaches the model, whatever the order, and keeps the rest', () => {
    const build = (): Model[] => [
      {
        name: 'A',
        fields: [
          { name: 'a', type: string, required: false },
          { name: 'b', type: string, required: false, inheritedFrom: model('B') },
        ],
        bases: [model('B'), model('Other')],
      },
      {
        name: 'B',
        fields: [
          { name: 'b', type: string, required: false },
          { name: 'a', type: string, required: false, inheritedFrom: model('A') },
        ],
        bases: [model('A')],
      },
      {
        name: 'Self',
        fields: [{ name: 'x', type: string, required: false, inheritedFrom: model('Self') }],
        bases: [model('Self')],
      },
      {
        name: 'Chain',
        fields: [{ name: 'c', type: string, required: false, inheritedFrom: model('Mid') }],
        bases: [model('Mid')],
      },
      {
        name: 'Mid',
        fields: [{ name: 'c', type: string, required: false, inheritedFrom: model('Chain') }],
        bases: [model('Chain')],
      },
      { name: 'Other', fields: [{ name: 'o', type: string, required: false }] },
      {
        name: 'Fine',
        fields: [{ name: 'o', type: string, required: false, inheritedFrom: model('Other') }],
        bases: [model('Other')],
      },
    ];
    for (const models of [build(), build().reverse()]) {
      dropCircularBases(models);
      const byName = new Map(models.map((m) => [m.name, m]));
      const of = (name: string) => ({
        bases: byName.get(name)!.bases,
        inherited: byName.get(name)!.fields.map((f) => f.inheritedFrom),
      });
      expect(of('A')).toEqual({ bases: [model('Other')], inherited: [undefined, undefined] });
      expect(of('B')).toEqual({ bases: undefined, inherited: [undefined, undefined] });
      expect(of('Self')).toEqual({ bases: undefined, inherited: [undefined] });
      expect(of('Chain')).toEqual({ bases: undefined, inherited: [undefined] });
      expect(of('Mid')).toEqual({ bases: undefined, inherited: [undefined] });
      expect(of('Fine')).toEqual({ bases: [model('Other')], inherited: [model('Other')] });
    }
  });

  it('renameModelRefs leaves a base or inheritedFrom an admit rejects as written', () => {
    const m = pet();
    expect(renameModelRefs(m, new Map([['Animal', 'Beast']]), () => false)).toBe(false);
    expect(m.bases).toEqual([model('Animal'), model('Owned')]);
    expect(m.fields[1]!.inheritedFrom).toEqual(model('Animal'));
  });
});
