import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffOperations } from '../../src/differ/operations.js';
import type { FieldChange } from '../../src/differ/types.js';
import type { ApiSpec, Field, Operation, PaginationMeta, TypeRef } from '../../src/ir/types.js';
import { parseSpec } from '../../src/parser/parse.js';

/**
 * Every change to how an iterator pages is reported (#221): the strategy, the
 * parameter it advances, the page-size parameter, the first page, the array it
 * reads and the field that stops it all change behavior even though the
 * operation's signature is unchanged.
 */
describe('diffOperations — pagination strategy, parameters and end of iteration', () => {
  const pagination: PaginationMeta = {
    strategy: 'offset',
    param: 'page',
    limitParam: 'limit',
    dataPath: 'pets',
    itemType: { kind: 'model', name: 'Pet' },
  };

  const listPets: Operation = {
    name: 'listPets',
    description: 'List pets',
    httpMethod: 'get',
    path: '/pets',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'array', items: { kind: 'model', name: 'Pet' } },
    errors: [],
    pagination,
    injectIdempotencyKey: false,
  };

  const withPagination = (over: Partial<PaginationMeta>): Operation => ({
    ...listPets,
    pagination: { ...pagination, ...over },
  });

  const only = (changes: ReturnType<typeof diffOperations>) => {
    expect(changes).toHaveLength(1);
    const change = changes[0];
    if (change.kind !== 'operation-modified') throw new Error(`expected operation-modified, got ${change.kind}`);
    return change;
  };

  const paginationFlags = [
    'paginationStrategyChanged',
    'paginationParamChanged',
    'paginationLimitParamChanged',
    'paginationDataPathChanged',
    'paginationPageStartChanged',
    'paginationEndOfIterationChanged',
  ] as const;

  it('reports no change for identical pagination', () => {
    expect(diffOperations('Pets', [listPets], [withPagination({})])).toEqual([]);
  });

  it('reports a strategy change as breaking', () => {
    const change = only(diffOperations('Pets', [listPets], [withPagination({ strategy: 'page' })]));
    expect(change.paginationStrategyChanged).toBe(true);
    expect(change.paginationEndOfIterationChanged).toBe(false);
    expect(change.paginatedChanged).toBe(false);
    expect(change.classification).toBe('breaking');
  });

  it('reports a change of the parameter the iterator advances as breaking', () => {
    const change = only(diffOperations('Pets', [listPets], [withPagination({ param: 'page_number' })]));
    expect(change.paginationParamChanged).toBe(true);
    expect(change.paginationStrategyChanged).toBe(false);
    expect(change.classification).toBe('breaking');
  });

  it('reports a changed, gained or lost page-size parameter as breaking', () => {
    for (const after of [withPagination({ limitParam: 'per_page' }), withPagination({ limitParam: undefined })]) {
      const change = only(diffOperations('Pets', [listPets], [after]));
      expect(change.paginationLimitParamChanged).toBe(true);
      expect(change.classification).toBe('breaking');
    }
    const gained = only(diffOperations('Pets', [withPagination({ limitParam: undefined })], [listPets]));
    expect(gained.paginationLimitParamChanged).toBe(true);
    expect(gained.classification).toBe('breaking');
  });

  it('reports a change of the data array location as breaking', () => {
    const change = only(diffOperations('Pets', [listPets], [withPagination({ dataPath: 'items' })]));
    expect(change.paginationDataPathChanged).toBe(true);
    expect(change.classification).toBe('breaking');
  });

  it('reports a change of the first page number as breaking', () => {
    const before = withPagination({ strategy: 'page', pageStart: 1 });
    const change = only(diffOperations('Pets', [before], [withPagination({ strategy: 'page', pageStart: 0 })]));
    expect(change.paginationPageStartChanged).toBe(true);
    expect(change.paginationStrategyChanged).toBe(false);
    expect(change.classification).toBe('breaking');
  });

  it('reports a newly detected end-of-iteration field as additive', () => {
    const change = only(
      diffOperations('Pets', [listPets], [withPagination({ endOfIteration: { kind: 'hasMore', path: 'has_more' } })]),
    );
    expect(change.paginationEndOfIterationChanged).toBe(true);
    expect(change.paginationStrategyChanged).toBe(false);
    expect(change.classification).toBe('additive');
  });

  it('reports a changed end-of-iteration field as breaking', () => {
    const before = withPagination({ endOfIteration: { kind: 'hasMore', path: 'has_more' } });
    const kindChanged = withPagination({ endOfIteration: { kind: 'totalPages', path: 'has_more' } });
    const pathChanged = withPagination({ endOfIteration: { kind: 'hasMore', path: 'meta.has_more' } });
    for (const after of [kindChanged, pathChanged]) {
      const change = only(diffOperations('Pets', [before], [after]));
      expect(change.paginationEndOfIterationChanged).toBe(true);
      expect(change.classification).toBe('breaking');
    }
  });

  it('reports a removed end-of-iteration field as breaking', () => {
    const before = withPagination({ endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' } });
    const change = only(diffOperations('Pets', [before], [listPets]));
    expect(change.paginationEndOfIterationChanged).toBe(true);
    expect(change.classification).toBe('breaking');
  });

  it('leaves every pagination flag false when pagination appears or disappears altogether', () => {
    const unpaginated: Operation = { ...listPets, pagination: undefined };
    for (const [before, after] of [
      [unpaginated, listPets],
      [listPets, unpaginated],
    ]) {
      const change = only(diffOperations('Pets', [before], [after]));
      expect(change.paginatedChanged).toBe(true);
      for (const flag of paginationFlags) expect(change[flag], flag).toBe(false);
    }
  });

  it('combines a strategy change with a first-time end-of-iteration field as breaking', () => {
    const after = withPagination({
      strategy: 'page',
      pageStart: 1,
      endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
    });
    const change = only(diffOperations('Pets', [listPets], [after]));
    expect(change.paginationStrategyChanged).toBe(true);
    expect(change.paginationPageStartChanged).toBe(true);
    expect(change.paginationEndOfIterationChanged).toBe(true);
    expect(change.classification).toBe('breaking');
  });
});

/**
 * `pagination.envelopeFields` is every property of an unwrapped list envelope
 * besides the data array — what an emitter types the envelope from — so a
 * field added to it, removed from it or retyped is compared as the same edit
 * to a model's field is (#439).
 */
describe('diffOperations — the list envelope’s fields (issue #439)', () => {
  const integer: TypeRef = { kind: 'primitive', type: 'integer' };
  const hasMore: Field = { name: 'has_more', type: { kind: 'primitive', type: 'boolean' }, required: false };
  const totalCount = (over: Partial<Field> = {}): Field => ({
    name: 'total_count',
    type: integer,
    required: false,
    ...over,
  });

  /** `GET /pets?after=` returning `{ data: string[], …envelopeFields }`. */
  const listPets = (envelopeFields?: Field[]): Operation => ({
    name: 'listPets',
    httpMethod: 'get',
    path: '/pets',
    pathParams: [],
    queryParams: [{ name: 'after', type: { kind: 'primitive', type: 'string' }, required: false }],
    headerParams: [],
    response: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
    errors: [],
    injectIdempotencyKey: false,
    pagination: {
      strategy: 'cursor',
      param: 'after',
      dataPath: 'data',
      itemType: { kind: 'primitive', type: 'string' },
      ...(envelopeFields ? { envelopeFields } : {}),
      endOfIteration: { kind: 'hasMore', path: 'has_more' },
    },
  });

  /** The one `operation-modified` change `before` → `after` reports, with its `envelopeFieldChanges`. */
  function envelopeChange(before: Field[] | undefined, after: Field[] | undefined) {
    const changes = diffOperations('Pets', [listPets(before)], [listPets(after)]);
    expect(changes).toHaveLength(1);
    const change = changes[0];
    if (change.kind !== 'operation-modified') throw new Error(`expected operation-modified, got ${change.kind}`);
    return change;
  }

  it('reports a field added to the envelope as additive, and its removal as breaking', () => {
    const added = envelopeChange([hasMore], [hasMore, totalCount()]);
    expect(added.envelopeFieldChanges).toEqual([
      { kind: 'field-added', fieldName: 'total_count', classification: 'additive' },
    ]);
    expect(added.responseChanged).toBe(false);
    expect(added.classification).toBe('additive');

    const removed = envelopeChange([hasMore, totalCount()], [hasMore]);
    expect(removed.envelopeFieldChanges).toEqual([
      { kind: 'field-removed', fieldName: 'total_count', classification: 'breaking' },
    ]);
    expect(removed.classification).toBe('breaking');
  });

  it('keeps a required field added additive: the envelope is only ever read, as a response-only model is', () => {
    const change = envelopeChange([hasMore], [hasMore, totalCount({ required: true })]);
    expect(change.envelopeFieldChanges).toEqual([
      {
        kind: 'field-added',
        fieldName: 'total_count',
        classification: 'additive',
        details: 'required on a response-only model',
      },
    ]);
    expect(change.classification).toBe('additive');
  });

  it('reports a field retyped as breaking, and a format-only change as additive', () => {
    const retyped = envelopeChange(
      [hasMore, totalCount()],
      [hasMore, totalCount({ type: { kind: 'primitive', type: 'string' } })],
    );
    expect(retyped.envelopeFieldChanges).toEqual([
      { kind: 'field-type-changed', fieldName: 'total_count', classification: 'breaking', details: 'type changed' },
    ]);
    expect(retyped.classification).toBe('breaking');

    const formatted = envelopeChange(
      [hasMore, totalCount()],
      [hasMore, totalCount({ type: { kind: 'primitive', type: 'integer', format: 'int64' } })],
    );
    expect(formatted.envelopeFieldChanges).toEqual([
      {
        kind: 'field-format-changed',
        fieldName: 'total_count',
        classification: 'additive',
        details: 'format <unset> → int64',
      },
    ]);
    expect(formatted.classification).toBe('additive');
  });

  it('compares requiredness, access flags and deprecation as on a model’s field', () => {
    const cases: Array<[Partial<Field>, Partial<Field>, FieldChange[], 'additive' | 'breaking']> = [
      [
        {},
        { required: true },
        [
          {
            kind: 'field-required-changed',
            fieldName: 'total_count',
            classification: 'breaking',
            details: 'optional → required',
          },
        ],
        'breaking',
      ],
      [
        { required: true },
        {},
        [
          {
            kind: 'field-required-changed',
            fieldName: 'total_count',
            classification: 'additive',
            details: 'required → optional',
          },
        ],
        'additive',
      ],
      [
        {},
        { readOnly: true },
        [{ kind: 'field-access-changed', fieldName: 'total_count', classification: 'breaking' }],
        'breaking',
      ],
      [
        {},
        { deprecated: true },
        [
          {
            kind: 'field-deprecated-changed',
            fieldName: 'total_count',
            classification: 'additive',
            oldDeprecated: false,
            newDeprecated: true,
            details: 'live → deprecated',
          },
        ],
        'additive',
      ],
    ];
    for (const [before, after, entries, classification] of cases) {
      const change = envelopeChange([hasMore, totalCount(before)], [hasMore, totalCount(after)]);
      expect([after, change.envelopeFieldChanges, change.classification]).toEqual([after, entries, classification]);
    }
  });

  it('reads an absent list as no field, and leaves the key off when no envelope field changed', () => {
    expect(envelopeChange(undefined, [hasMore]).envelopeFieldChanges).toEqual([
      { kind: 'field-added', fieldName: 'has_more', classification: 'additive' },
    ]);
    expect(envelopeChange([hasMore], undefined).envelopeFieldChanges).toEqual([
      { kind: 'field-removed', fieldName: 'has_more', classification: 'breaking' },
    ]);
    expect(diffOperations('Pets', [listPets(undefined)], [listPets([])])).toEqual([]);
    expect(diffOperations('Pets', [listPets([hasMore])], [listPets([{ ...hasMore }])])).toEqual([]);
    const tagged = diffOperations('Pets', [listPets([hasMore])], [{ ...listPets([hasMore]), tags: ['pets'] }]);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).not.toHaveProperty('envelopeFieldChanges');
  });

  it('compares the fields only while both specs paginate', () => {
    const unpaginated: Operation = { ...listPets(), pagination: undefined };
    for (const [before, after] of [
      [unpaginated, listPets([hasMore])],
      [listPets([hasMore]), unpaginated],
    ]) {
      const changes = diffOperations('Pets', [before], [after]);
      expect(changes).toMatchObject([{ kind: 'operation-modified', paginatedChanged: true }]);
      expect(changes[0]).not.toHaveProperty('envelopeFieldChanges');
    }
  });
});

describe("diffSpecs — the issue's documents, end to end (issue #439)", () => {
  /** `GET /pets?after=` returning `{ data: string[], has_more: boolean, …extra }`. */
  const document = (extra: Record<string, object> = {}) => ({
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1.0.0' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: { type: 'string' } },
                      has_more: { type: 'boolean' },
                      ...extra,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oagen-439-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  async function parse(name: string, doc: object): Promise<ApiSpec> {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(doc));
    return parseSpec(file);
  }
  /**
   * Each change as `<operation> <envelope field> <kind>: <classification>`
   * beside the change's own classification, and the summary counts `oagen
   * diff` takes its exit code from (2 for any breaking, else 1 for any
   * modified).
   */
  const summarize = (report: ReturnType<typeof diffSpecs>) => ({
    changes: report.changes.flatMap((c) =>
      c.kind === 'operation-modified'
        ? (c.envelopeFieldChanges ?? []).map((f) => `${c.operationName} ${f.fieldName} ${f.kind}: ${f.classification}`)
        : [c.kind],
    ),
    classifications: report.changes.map((c) => c.classification),
    modified: report.summary.modified,
    breaking: report.summary.breaking,
  });

  it('reports `total_count` added as additive (exit 1), and removed or retyped as breaking (exit 2)', async () => {
    const oldSpec = await parse('old', document());
    const newSpec = await parse('new', document({ total_count: { type: 'integer' } }));
    const retyped = await parse('retyped', document({ total_count: { type: 'string' } }));
    const envelope = (spec: ApiSpec) =>
      spec.services[0]!.operations[0]!.pagination?.envelopeFields?.map(
        ({ name, type }) => `${name}: ${type.kind === 'primitive' ? type.type : type.kind}`,
      );
    expect([envelope(oldSpec), envelope(newSpec), envelope(retyped)]).toEqual([
      ['has_more: boolean'],
      ['has_more: boolean', 'total_count: integer'],
      ['has_more: boolean', 'total_count: string'],
    ]);

    expect(summarize(diffSpecs(oldSpec, newSpec))).toEqual({
      changes: ['listPets total_count field-added: additive'],
      classifications: ['additive'],
      modified: 1,
      breaking: 0,
    });
    expect(summarize(diffSpecs(newSpec, oldSpec))).toEqual({
      changes: ['listPets total_count field-removed: breaking'],
      classifications: ['breaking'],
      modified: 1,
      breaking: 1,
    });
    expect(summarize(diffSpecs(newSpec, retyped))).toEqual({
      changes: ['listPets total_count field-type-changed: breaking'],
      classifications: ['breaking'],
      modified: 1,
      breaking: 1,
    });
    expect(summarize(diffSpecs(newSpec, newSpec))).toEqual({
      changes: [],
      classifications: [],
      modified: 0,
      breaking: 0,
    });
  });
});
