import { describe, it, expect } from 'vitest';
import { resolveEnvelopeCompanionNames, type EnvelopeCompanion } from '../../src/parser/envelope-companion-names.js';
import type { Field, Model } from '../../src/ir/types.js';

/**
 * Covers the cross-operation naming of lifted list-envelope companions: the
 * bare name is taken only where it cannot change another type's shape.
 */
function companion(op: string, bare: string, fields: Model['fields'], nested: Model[] = []): EnvelopeCompanion {
  const qualified = `${op}${bare}`;
  const field: Field = { name: bare.toLowerCase(), type: { kind: 'model', name: qualified }, required: false };
  const models: Model[] = [{ name: qualified, fields }, ...nested];
  return { field, models, bareNames: [bare, ...nested.map((m) => m.name.replace(op, ''))] };
}

const str = { kind: 'primitive', type: 'string' } as const;
const int = { kind: 'primitive', type: 'integer' } as const;

describe('resolveEnvelopeCompanionNames', () => {
  it('gives every copy the bare name when all copies agree', () => {
    const a = companion('ListA', 'Pagination', [{ name: 'next', type: str, required: false }]);
    const b = companion('ListB', 'Pagination', [{ name: 'next', type: str, required: false }]);

    const models = resolveEnvelopeCompanionNames([a, b]);

    // One definition for the shared name; both operations point at it.
    expect(models.map((m) => m.name)).toEqual(['Pagination']);
    expect(a.field.type).toEqual({ kind: 'model', name: 'Pagination' });
    expect(b.field.type).toEqual({ kind: 'model', name: 'Pagination' });
  });

  it('judges a oneOf companion on every variant, and folds only when the variants line up', () => {
    const variants = (op: string, second: string) => {
      const base = `${op}Meta`;
      const other = `${second}${op}Meta`;
      const c: EnvelopeCompanion = {
        field: {
          name: 'meta',
          type: {
            kind: 'union',
            compositionKind: 'oneOf',
            variants: [
              { kind: 'model', name: base },
              { kind: 'model', name: other },
            ],
          },
          required: false,
        },
        models: [
          { name: base, fields: [{ name: 'kind', type: { kind: 'literal', value: 'cursor' }, required: true }] },
          {
            name: other,
            fields: [{ name: 'kind', type: { kind: 'literal', value: second.toLowerCase() }, required: true }],
          },
        ],
        bareNames: ['Meta', `${second}Meta`],
      };
      return c;
    };
    const cursorOffset = variants('ListA', 'Offset');
    const cursorToken = variants('ListB', 'Token');
    const cursorOffsetAgain = variants('ListC', 'Offset');

    const models = resolveEnvelopeCompanionNames([cursorOffset, cursorToken, cursorOffsetAgain]);

    // A and C share every variant and fold; B's second variant differs, so it keeps its own models.
    expect(models.map((m) => m.name)).toEqual(['Meta', 'OffsetMeta', 'ListBMeta', 'TokenListBMeta']);
    expect(cursorOffsetAgain.field.type).toEqual({
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [
        { kind: 'model', name: 'Meta' },
        { kind: 'model', name: 'OffsetMeta' },
      ],
    });
    expect(cursorToken.field.type).toEqual({
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [
        { kind: 'model', name: 'ListBMeta' },
        { kind: 'model', name: 'TokenListBMeta' },
      ],
    });
  });

  it('never folds a oneOf companion onto a plain component', () => {
    const c: EnvelopeCompanion = {
      field: {
        name: 'pagination',
        type: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [
            { kind: 'model', name: 'ListAPagination' },
            { kind: 'model', name: 'OffsetListAPagination' },
          ],
        },
        required: false,
      },
      models: [
        { name: 'ListAPagination', fields: [{ name: 'next', type: str, required: false }] },
        { name: 'OffsetListAPagination', fields: [{ name: 'page', type: int, required: false }] },
      ],
      bareNames: ['Pagination', 'OffsetPagination'],
    };
    const componentModels: Model[] = [{ name: 'Pagination', fields: [{ name: 'next', type: str, required: false }] }];

    const models = resolveEnvelopeCompanionNames([c], componentModels);

    expect(models.map((m) => m.name)).toEqual(['ListAPagination', 'OffsetListAPagination']);
  });

  it('folds a nullable copy onto a component by repointing only its reference', () => {
    const c = companion('ListA', 'ListMetadata', [{ name: 'after', type: str, required: false }]);
    c.field.type = { kind: 'nullable', inner: { kind: 'model', name: 'ListAListMetadata' } };
    const componentModels: Model[] = [
      { name: 'ListMetadata', fields: [{ name: 'after', type: { kind: 'nullable', inner: str }, required: false }] },
    ];

    const models = resolveEnvelopeCompanionNames([c], componentModels);

    expect(models).toEqual([]);
    expect(c.field.type).toEqual({ kind: 'nullable', inner: { kind: 'model', name: 'ListMetadata' } });
  });

  it("keeps the target's definition when stricter copies fold onto it, whatever their order", () => {
    const required = companion('ListA', 'Pagination', [{ name: 'next', type: str, required: true }]);
    const optional1 = companion('ListB', 'Pagination', [{ name: 'next', type: str, required: false }]);
    const optional2 = companion('ListC', 'Pagination', [{ name: 'next', type: str, required: false }]);

    const models = resolveEnvelopeCompanionNames([required, optional1, optional2]);

    // The optional shape is the majority target; the earlier, stricter copy folds onto it
    // and must not become the shared definition just because it was declared first.
    expect(models).toEqual([{ name: 'Pagination', fields: [{ name: 'next', type: str, required: false }] }]);
    expect([required, optional1, optional2].map((c) => c.field.type)).toEqual(
      Array(3).fill({ kind: 'model', name: 'Pagination' }),
    );
  });

  it('emits nothing for copies folded onto a component; the component is the definition', () => {
    const copy = companion('ListA', 'ListMetadata', [{ name: 'after', type: str, required: true }]);
    const componentModels: Model[] = [
      { name: 'ListMetadata', fields: [{ name: 'after', type: str, required: false }] },
    ];

    const models = resolveEnvelopeCompanionNames([copy], componentModels);

    expect(models).toEqual([]);
    expect(copy.field.type).toEqual({ kind: 'model', name: 'ListMetadata' });
  });

  it('keeps the minority shape under its operation name and gives the majority the bare name', () => {
    const a = companion('ListA', 'Pagination', [{ name: 'next', type: str, required: false }]);
    const b = companion('ListB', 'Pagination', [{ name: 'page', type: int, required: true }]);
    const c = companion('ListC', 'Pagination', [{ name: 'next', type: str, required: false }]);

    const models = resolveEnvelopeCompanionNames([a, b, c]);

    expect(models.map((m) => m.name)).toEqual(['Pagination', 'ListBPagination']);
    expect(b.field.type).toEqual({ kind: 'model', name: 'ListBPagination' });
    expect(c.field.type).toEqual({ kind: 'model', name: 'Pagination' });
  });

  it('breaks a tie in favour of the shape declared first', () => {
    const a = companion('ListA', 'Meta', [{ name: 'next', type: str, required: false }]);
    const b = companion('ListB', 'Meta', [{ name: 'page', type: int, required: false }]);

    resolveEnvelopeCompanionNames([a, b]);

    expect(a.models[0].name).toBe('Meta');
    expect(b.models[0].name).toBe('ListBMeta');
  });

  it('lets a stricter copy collapse onto a looser target, never the reverse', () => {
    // Target (first declared, so it wins the tie): optional, nullable.
    const loose = companion('ListA', 'Meta', [
      { name: 'next', type: { kind: 'nullable', inner: str }, required: false },
    ]);
    const required = companion('ListB', 'Meta', [
      { name: 'next', type: { kind: 'nullable', inner: str }, required: true },
    ]);
    const nonNull = companion('ListC', 'Meta', [{ name: 'next', type: str, required: false }]);
    const wrongType = companion('ListD', 'Meta', [{ name: 'next', type: int, required: false }]);

    resolveEnvelopeCompanionNames([loose, required, nonNull, wrongType]);

    // `required` and `nonNull` hold only values `loose` admits; `wrongType` does not.
    expect([loose, required, nonNull, wrongType].map((c) => c.models[0].name)).toEqual([
      'Meta',
      'Meta',
      'Meta',
      'ListDMeta',
    ]);
  });

  it('keeps a looser copy qualified when the target is stricter', () => {
    const required = companion('ListA', 'Meta', [{ name: 'next', type: str, required: true }]);
    const optional = companion('ListB', 'Meta', [{ name: 'next', type: str, required: false }]);
    const nullable = companion('ListC', 'Meta', [
      { name: 'next', type: { kind: 'nullable', inner: str }, required: true },
    ]);

    resolveEnvelopeCompanionNames([required, optional, nullable]);

    expect([required, optional, nullable].map((c) => c.models[0].name)).toEqual(['Meta', 'ListBMeta', 'ListCMeta']);
  });

  it('compares nested models by shape and inline enums by value, not by qualified name', () => {
    const make = (op: string, values: string[]) =>
      companion(
        op,
        'Pagination',
        [
          { name: 'links', type: { kind: 'model', name: `${op}PaginationLink` }, required: false },
          { name: 'sort', type: { kind: 'enum', name: `${op}PaginationSort`, values }, required: false },
        ],
        [{ name: `${op}PaginationLink`, fields: [{ name: 'next', type: str, required: false }] }],
      );
    const a = make('ListA', ['asc', 'desc']);
    const b = make('ListB', ['desc', 'asc']);
    const c = make('ListC', ['newest', 'oldest']);

    resolveEnvelopeCompanionNames([a, b, c]);

    // a and b agree (enum values are compared as a set); c's enum has values a's does not admit.
    expect(a.models.map((m) => m.name)).toEqual(['Pagination', 'PaginationLink']);
    expect(b.models.map((m) => m.name)).toEqual(['Pagination', 'PaginationLink']);
    expect(c.models.map((m) => m.name)).toEqual(['ListCPagination', 'ListCPaginationLink']);
    // Nested references follow the rename.
    expect(a.models[0].fields[0].type).toEqual({ kind: 'model', name: 'PaginationLink' });
    expect(c.models[0].fields[0].type).toEqual({ kind: 'model', name: 'ListCPaginationLink' });
  });

  it('collapses onto a same-named component only when the whole shape matches', () => {
    const matching = companion('ListA', 'ListMetadata', [
      { name: 'before', type: str, required: false },
      { name: 'after', type: str, required: false },
    ]);
    const extraField = companion('ListB', 'ListMetadata', [
      { name: 'before', type: str, required: false },
      { name: 'after', type: str, required: false },
      { name: 'total', type: int, required: false },
    ]);
    // Same field names as the component, but a different type.
    const sameNamesOnly = companion('ListC', 'ListMetadata', [
      { name: 'before', type: str, required: false },
      { name: 'after', type: int, required: false },
    ]);
    // Same names and types; the copy merely requires what the component leaves optional.
    const stricter = companion('ListD', 'ListMetadata', [
      { name: 'before', type: str, required: true },
      { name: 'after', type: str, required: true },
    ]);
    const componentModels: Model[] = [
      {
        name: 'ListMetadata',
        fields: [
          { name: 'after', type: str, required: false },
          { name: 'before', type: str, required: false },
        ],
      },
    ];

    resolveEnvelopeCompanionNames([matching, extraField, sameNamesOnly, stricter], componentModels);

    expect(matching.models[0].name).toBe('ListMetadata');
    expect(extraField.models[0].name).toBe('ListBListMetadata');
    expect(sameNamesOnly.models[0].name).toBe('ListCListMetadata');
    expect(stricter.models[0].name).toBe('ListMetadata');
    expect(componentModels[0].fields.map((f) => `${f.name}${f.required ? '!' : '?'}`)).toEqual(['after?', 'before?']);
  });

  it("resolves the component's nested references so a copy nesting the same shape still collapses", () => {
    const copy = companion(
      'ListA',
      'Pagination',
      [{ name: 'links', type: { kind: 'model', name: 'ListAPaginationLink' }, required: false }],
      [{ name: 'ListAPaginationLink', fields: [{ name: 'next', type: str, required: false }] }],
    );
    const componentModels: Model[] = [
      {
        name: 'Pagination',
        fields: [{ name: 'links', type: { kind: 'model', name: 'PaginationLinks' }, required: false }],
      },
      { name: 'PaginationLinks', fields: [{ name: 'next', type: str, required: false }] },
    ];

    const models = resolveEnvelopeCompanionNames([copy], componentModels);

    // Folded onto the component: the field points at it and the copy's own models are dropped.
    expect(models).toEqual([]);
    expect(copy.field.type).toEqual({ kind: 'model', name: 'Pagination' });
  });

  it('keeps every copy qualified when a same-named component differs from all of them, even if they agree', () => {
    const a = companion('ListA', 'Pagination', [{ name: 'page', type: int, required: false }]);
    const b = companion('ListB', 'Pagination', [{ name: 'page', type: int, required: false }]);
    const componentModels: Model[] = [{ name: 'Pagination', fields: [{ name: 'cursor', type: str, required: false }] }];

    resolveEnvelopeCompanionNames([a, b], componentModels);

    expect([a, b].map((c) => c.models[0].name)).toEqual(['ListAPagination', 'ListBPagination']);
    expect(componentModels[0].fields.map((f) => f.name)).toEqual(['cursor']);
  });

  it('returns every companion model, renamed or not, and nothing for companions without models', () => {
    const lifted = companion('ListA', 'Pagination', [{ name: 'page', type: int, required: false }]);
    const scalar: EnvelopeCompanion = {
      field: { name: 'total', type: int, required: false },
      models: [],
      bareNames: [],
    };

    const models = resolveEnvelopeCompanionNames([scalar, lifted]);

    expect(models).toEqual([{ name: 'Pagination', fields: [{ name: 'page', type: int, required: false }] }]);
  });
});

describe('resolveEnvelopeCompanionNames – deprecated', () => {
  const next = () => [{ name: 'next', type: str, required: false }];
  const orders = [
    ['ListLegacy', 'ListA', 'ListB'],
    ['ListA', 'ListLegacy', 'ListB'],
    ['ListA', 'ListB', 'ListLegacy'],
  ];

  it('keeps a deprecated copy on its operation-qualified name, whatever the document order', () => {
    for (const order of orders) {
      const copies = order.map((op) => {
        const c = companion(op, 'Pagination', next());
        if (op === 'ListLegacy') c.models[0].deprecated = true;
        return c;
      });

      const models = resolveEnvelopeCompanionNames(copies);

      // The live copies share the bare name; the deprecated one keeps its own,
      // so no live operation ever references a deprecated model.
      expect(models.map((m) => [m.name, m.deprecated]).sort()).toEqual([
        ['ListLegacyPagination', true],
        ['Pagination', undefined],
      ]);
      for (const c of copies) {
        const expected = c.models[0].deprecated ? 'ListLegacyPagination' : 'Pagination';
        expect(c.field.type).toEqual({ kind: 'model', name: expected });
      }
    }
  });

  it('lets a deprecated shape take the bare name only when every copy is deprecated', () => {
    const copies = ['ListA', 'ListB'].map((op) => {
      const c = companion(op, 'Pagination', next());
      c.models[0].deprecated = true;
      return c;
    });

    const models = resolveEnvelopeCompanionNames(copies);

    expect(models.map((m) => [m.name, m.deprecated])).toEqual([['Pagination', true]]);
    for (const c of copies) expect(c.field.type).toEqual({ kind: 'model', name: 'Pagination' });
  });

  it('folds onto a component when the component’s flag admits the copy’s: a live component takes a deprecated copy, never the reverse', () => {
    const live: Model = { name: 'Pagination', fields: next() };
    const deprecated: Model = { name: 'Pagination', deprecated: true, fields: next() };

    const onto = (component: Model, flag: boolean | undefined) => {
      const c = companion('ListA', 'Pagination', next());
      if (flag) c.models[0].deprecated = true;
      const models = resolveEnvelopeCompanionNames([c], [component]);
      return { ref: c.field.type, models: models.map((m) => [m.name, m.deprecated]) };
    };

    expect(onto(live, undefined)).toEqual({ ref: { kind: 'model', name: 'Pagination' }, models: [] });
    expect(onto(deprecated, true)).toEqual({ ref: { kind: 'model', name: 'Pagination' }, models: [] });
    // Issue #312: the copy's own flag is not part of the shape beside a
    // component; the envelope field keeps it.
    expect(onto(live, true)).toEqual({ ref: { kind: 'model', name: 'Pagination' }, models: [] });
    expect(onto(deprecated, undefined)).toEqual({
      ref: { kind: 'model', name: 'ListAPagination' },
      models: [['ListAPagination', undefined]],
    });
  });

  it('still keeps a deprecated copy apart from a live component when a model nested in it is deprecated too', () => {
    const cursor = (op: string): Model => ({ name: `${op}PaginationCursor`, fields: next() });
    const nestedField = (name: string): Model['fields'] => [
      { name: 'cursor', type: { kind: 'model', name }, required: false },
    ];
    const component: Model = { name: 'Pagination', fields: nestedField('PaginationCursor') };
    const nestedComponent: Model = { name: 'PaginationCursor', fields: next() };

    // Only the companion's own flag is read apart; a deprecated nested model
    // beside a live `PaginationCursor` keeps the whole copy apart, since no
    // field of the component's side would carry that flag.
    const nested = cursor('ListA');
    nested.deprecated = true;
    const c = companion('ListA', 'Pagination', nestedField(nested.name), [nested]);
    c.models[0].deprecated = true;
    const models = resolveEnvelopeCompanionNames([c], [component, nestedComponent]);
    expect(c.field.type).toEqual({ kind: 'model', name: 'ListAPagination' });
    expect(models.map((m) => [m.name, m.deprecated])).toEqual([
      ['ListAPagination', true],
      ['ListAPaginationCursor', true],
    ]);

    // With the nested model live, the deprecated companion folds onto the component.
    const liveNested = cursor('ListB');
    const d = companion('ListB', 'Pagination', nestedField(liveNested.name), [liveNested]);
    d.models[0].deprecated = true;
    expect(resolveEnvelopeCompanionNames([d], [component, nestedComponent])).toEqual([]);
    expect(d.field.type).toEqual({ kind: 'model', name: 'Pagination' });
  });

  it('folds onto a component only when every field agrees on its own flag, whatever the root flags (Greptile, #364 round 1)', () => {
    const live = (deprecated: boolean): Model['fields'] => [
      { name: 'next', type: str, required: false, ...(deprecated ? { deprecated: true } : {}) },
    ];
    const component = (fieldDeprecated: boolean): Model => ({ name: 'Pagination', fields: live(fieldDeprecated) });
    const onto = (comp: Model, rootDeprecated: boolean, fieldDeprecated: boolean) => {
      const c = companion('ListA', 'Pagination', live(fieldDeprecated));
      if (rootDeprecated) c.models[0].deprecated = true;
      const models = resolveEnvelopeCompanionNames([c], [comp]);
      return { ref: c.field.type, models: models.map((m) => [m.name, m.deprecated, m.fields[0]?.deprecated]) };
    };
    const kept = { ref: { kind: 'model', name: 'ListAPagination' } };
    const folded = { ref: { kind: 'model', name: 'Pagination' }, models: [] };

    // The copy's `next` deprecated, the component's live: the notice would
    // vanish with the copy, so the copy keeps its name — with a deprecated
    // root (the reviewer's case) and with a live one alike.
    expect(onto(component(false), true, true)).toEqual({ ...kept, models: [['ListAPagination', true, true]] });
    expect(onto(component(false), false, true)).toEqual({ ...kept, models: [['ListAPagination', undefined, true]] });
    // The component's `next` deprecated, the copy's live: the copy's readers
    // would gain a notice its schema never wrote, so it keeps its name too.
    expect(onto(component(true), false, false)).toEqual({
      ...kept,
      models: [['ListAPagination', undefined, undefined]],
    });
    expect(onto(component(true), true, false)).toEqual({ ...kept, models: [['ListAPagination', true, undefined]] });
    // Both deprecated: the fold changes nothing a reader sees.
    expect(onto(component(true), false, true)).toEqual(folded);
    expect(onto(component(true), true, true)).toEqual(folded);
  });

  it('keeps a model nested in the companion apart from the component when one of its fields is deprecated', () => {
    const cursorFields = (deprecated: boolean): Model['fields'] => [
      { name: 'after', type: str, required: false, ...(deprecated ? { deprecated: true } : {}) },
    ];
    const nestedField = (name: string): Model['fields'] => [
      { name: 'cursor', type: { kind: 'model', name }, required: false },
    ];
    const component: Model = { name: 'Pagination', fields: nestedField('PaginationCursor') };
    const nestedComponent: Model = { name: 'PaginationCursor', fields: cursorFields(false) };

    const nested: Model = { name: 'ListAPaginationCursor', fields: cursorFields(true) };
    const c = companion('ListA', 'Pagination', nestedField(nested.name), [nested]);
    c.models[0].deprecated = true;
    const models = resolveEnvelopeCompanionNames([c], [component, nestedComponent]);
    expect(c.field.type).toEqual({ kind: 'model', name: 'ListAPagination' });
    expect(models.map((m) => m.name)).toEqual(['ListAPagination', 'ListAPaginationCursor']);
  });

  it('never shares a bare name between two live copies that disagree on a field’s flag', () => {
    const fields = (deprecated: boolean): Model['fields'] => [
      { name: 'next', type: str, required: false, ...(deprecated ? { deprecated: true } : {}) },
    ];
    for (const [first, second] of [
      [false, true],
      [true, false],
    ] as const) {
      const a = companion('ListA', 'Pagination', fields(first));
      const b = companion('ListB', 'Pagination', fields(second));
      const models = resolveEnvelopeCompanionNames([a, b]);
      // The first declared shape takes the bare name; the other keeps its own.
      expect(models.map((m) => [m.name, m.fields[0]?.deprecated])).toEqual([
        ['Pagination', first || undefined],
        ['ListBPagination', second || undefined],
      ]);
      expect(a.field.type).toEqual({ kind: 'model', name: 'Pagination' });
      expect(b.field.type).toEqual({ kind: 'model', name: 'ListBPagination' });
    }
  });
});
