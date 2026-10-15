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

    resolveEnvelopeCompanionNames([copy], componentModels);

    expect(copy.models.map((m) => m.name)).toEqual(['Pagination', 'PaginationLink']);
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
