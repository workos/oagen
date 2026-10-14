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

    expect(models.map((m) => m.name)).toEqual(['Pagination', 'Pagination']);
    expect(a.field.type).toEqual({ kind: 'model', name: 'Pagination' });
    expect(b.field.type).toEqual({ kind: 'model', name: 'Pagination' });
  });

  it('keeps the minority shape under its operation name and gives the majority the bare name', () => {
    const a = companion('ListA', 'Pagination', [{ name: 'next', type: str, required: false }]);
    const b = companion('ListB', 'Pagination', [{ name: 'page', type: int, required: true }]);
    const c = companion('ListC', 'Pagination', [{ name: 'next', type: str, required: false }]);

    const models = resolveEnvelopeCompanionNames([a, b, c]);

    expect(models.map((m) => m.name)).toEqual(['Pagination', 'ListBPagination', 'Pagination']);
    expect(b.field.type).toEqual({ kind: 'model', name: 'ListBPagination' });
  });

  it('breaks a tie in favour of the shape declared first', () => {
    const a = companion('ListA', 'Meta', [{ name: 'next', type: str, required: false }]);
    const b = companion('ListB', 'Meta', [{ name: 'page', type: int, required: false }]);

    resolveEnvelopeCompanionNames([a, b]);

    expect(a.models[0].name).toBe('Meta');
    expect(b.models[0].name).toBe('ListBMeta');
  });

  it('treats requiredness, nullability, and nested shape as part of the structure', () => {
    const plain = companion('ListA', 'Meta', [{ name: 'next', type: str, required: false }]);
    const required = companion('ListB', 'Meta', [{ name: 'next', type: str, required: true }]);
    const nullable = companion('ListC', 'Meta', [
      { name: 'next', type: { kind: 'nullable', inner: str }, required: false },
    ]);

    resolveEnvelopeCompanionNames([plain, required, nullable]);

    expect([plain, required, nullable].map((c) => c.models[0].name)).toEqual(['Meta', 'ListBMeta', 'ListCMeta']);
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

    // a and b agree (enum values are compared as a set); c's enum differs.
    expect(a.models.map((m) => m.name)).toEqual(['Pagination', 'PaginationLink']);
    expect(b.models.map((m) => m.name)).toEqual(['Pagination', 'PaginationLink']);
    expect(c.models.map((m) => m.name)).toEqual(['ListCPagination', 'ListCPaginationLink']);
    // Nested references follow the rename.
    expect(a.models[0].fields[0].type).toEqual({ kind: 'model', name: 'PaginationLink' });
    expect(c.models[0].fields[0].type).toEqual({ kind: 'model', name: 'ListCPaginationLink' });
  });

  it('collapses onto a same-named component only when the field names match', () => {
    const matching = companion('ListA', 'ListMetadata', [
      { name: 'before', type: str, required: false },
      { name: 'after', type: str, required: false },
    ]);
    const extra = companion('ListB', 'ListMetadata', [
      { name: 'before', type: str, required: false },
      { name: 'after', type: str, required: false },
      { name: 'total', type: int, required: false },
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

    resolveEnvelopeCompanionNames([matching, extra], componentModels);

    expect(matching.models[0].name).toBe('ListMetadata');
    expect(extra.models[0].name).toBe('ListBListMetadata');
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
