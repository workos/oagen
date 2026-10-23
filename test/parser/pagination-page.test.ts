import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectPagination,
  derivePageStart,
  detectEndOfIteration,
  resolveSchemaPath,
  resolveDataPathItemType,
  resolvePaginationOverride,
  applyPaginationOverride,
  validatePaginationHint,
  resolveSchemaKeyword,
  END_OF_ITERATION_FIELDS,
} from '../../src/parser/pagination.js';
import type { PaginationOverrides } from '../../src/parser/pagination.js';
import { resolveDataPathFromSchema } from '../../src/parser/responses.js';
import type { Model, Parameter, PaginationMeta, TypeRef } from '../../src/ir/types.js';
import { walkTypeRef } from '../../src/ir/types.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

/**
 * Page-number pagination (#221): `page`-style parameters are their own
 * strategy with an explicit first page, the envelope's end-of-iteration field
 * is detected, and an explicit override (`x-pagination` /
 * `operationHints[...].pagination`) wins over the name-based guess.
 */
const param = (name: string, extra: Partial<Parameter> = {}): Parameter => ({
  name,
  type: { kind: 'primitive', type: 'string' },
  required: false,
  ...extra,
});
const pets: TypeRef = { kind: 'array', items: { kind: 'model', name: 'Pet' } };
const pet: TypeRef = { kind: 'model', name: 'Pet' };

/** Every model name a TypeRef references, through nullable, array, map and union wrappers. */
const modelNamesIn = (ref: TypeRef): string[] => {
  const names: string[] = [];
  walkTypeRef(ref, { model: (m) => names.push(m.name) });
  return names;
};

describe('detectPagination — page-number strategy', () => {
  it('reports page + limit as the page strategy, advanced by one from pageStart', () => {
    expect(detectPagination(pets, [param('page'), param('limit')], 'pets')).toEqual({
      strategy: 'page',
      param: 'page',
      limitParam: 'limit',
      pageStart: 1,
      dataPath: 'pets',
      itemType: pet,
    });
  });

  it.each(['page_number', 'page_num'])('recognizes %s as a page-number parameter', (name) => {
    const result = detectPagination(pets, [param(name), param('per_page')]);
    expect(result?.strategy).toBe('page');
    expect(result?.param).toBe(name);
    expect(result?.limitParam).toBe('per_page');
  });

  it.each(['limit', 'page_size', 'per_page', 'size', 'count'])('pairs page with the %s page-size parameter', (name) => {
    expect(detectPagination(pets, [param('page'), param(name)])).toMatchObject({ strategy: 'page', limitParam: name });
  });

  it('keeps offset and skip as the offset strategy, without a pageStart', () => {
    expect(detectPagination(pets, [param('offset'), param('limit')])).toEqual({
      strategy: 'offset',
      param: 'offset',
      limitParam: 'limit',
      dataPath: undefined,
      itemType: pet,
    });
    expect(detectPagination(pets, [param('skip'), param('count')])).toMatchObject({
      strategy: 'offset',
      param: 'skip',
    });
  });

  it('prefers a cursor parameter over a page parameter', () => {
    const result = detectPagination(pets, [param('page'), param('limit'), param('after')]);
    expect(result).toEqual({ strategy: 'cursor', param: 'after', dataPath: undefined, itemType: pet });
  });

  it('prefers an offset parameter over a page parameter when both are declared', () => {
    const result = detectPagination(pets, [param('page'), param('offset'), param('limit')]);
    expect(result).toMatchObject({ strategy: 'offset', param: 'offset', limitParam: 'limit' });
  });

  it('does not treat a page parameter without a page-size parameter as pagination', () => {
    expect(detectPagination(pets, [param('page')])).toBeNull();
    expect(detectPagination(pets, [param('page_number'), param('sort')])).toBeNull();
  });

  it("takes pageStart from the page parameter's default, else its minimum, else 1", () => {
    expect(detectPagination(pets, [param('page', { default: 0 }), param('limit')])?.pageStart).toBe(0);
    expect(detectPagination(pets, [param('page', { constraints: { minimum: 0 } }), param('limit')])?.pageStart).toBe(0);
    expect(
      detectPagination(pets, [param('page', { default: 2, constraints: { minimum: 0 } }), param('limit')])?.pageStart,
    ).toBe(2);
  });
});

describe('derivePageStart', () => {
  it('skips a default that is not a non-negative integer and falls through to the next source', () => {
    expect(derivePageStart(param('page', { default: '1' }))).toBe(1);
    expect(derivePageStart(param('page', { default: 1.5, constraints: { minimum: 0 } }))).toBe(0);
    expect(derivePageStart(param('page', { default: -1 }))).toBe(1);
    expect(derivePageStart(undefined)).toBe(1);
  });

  const components: Record<string, SchemaObject> = {
    PageNumber: { type: 'integer', default: 0, minimum: 0 },
    MinOnly: { type: 'integer', minimum: 0 },
  };

  it('reads a default the IR parameter does not carry from the schema as written', () => {
    const bare = param('page');
    expect(derivePageStart(bare, { allOf: [{ $ref: '#/components/schemas/PageNumber' }] }, components)).toBe(0);
    expect(derivePageStart(bare, { $ref: '#/components/schemas/PageNumber' }, components)).toBe(0);
    expect(
      derivePageStart(bare, { oneOf: [{ $ref: '#/components/schemas/PageNumber' }, { type: 'null' }] }, components),
    ).toBe(0);
    expect(derivePageStart(bare, { allOf: [{ $ref: '#/components/schemas/MinOnly' }] }, components)).toBe(0);
  });

  it("prefers any default over any minimum, and the parameter's own value over the schema's", () => {
    expect(derivePageStart(param('page', { constraints: { minimum: 0 } }), { default: 3 })).toBe(3);
    expect(
      derivePageStart(param('page', { default: 2 }), { $ref: '#/components/schemas/PageNumber' }, components),
    ).toBe(2);
  });
});

describe('resolveSchemaKeyword', () => {
  const components: Record<string, SchemaObject> = {
    Base: { type: 'integer', default: 0, minimum: 0 },
    Loop: { allOf: [{ $ref: '#/components/schemas/Loop' }] },
  };

  it("takes the schema's own keyword over anything it is composed of", () => {
    expect(
      resolveSchemaKeyword({ default: 5, allOf: [{ $ref: '#/components/schemas/Base' }] }, 'default', components),
    ).toBe(5);
  });

  it('follows a $ref, then allOf members in declaration order, then a nullable wrapper', () => {
    expect(resolveSchemaKeyword({ $ref: '#/components/schemas/Base' }, 'minimum', components)).toBe(0);
    expect(
      resolveSchemaKeyword({ allOf: [{ type: 'integer' }, { default: 7 }, { default: 9 }] }, 'default', components),
    ).toBe(7);
    expect(resolveSchemaKeyword({ anyOf: [{ type: 'null' }, { default: 4 }] }, 'default')).toBe(4);
  });

  it('returns undefined when no level declares the keyword, and survives a self-referencing $ref', () => {
    expect(resolveSchemaKeyword({ type: 'integer' }, 'default')).toBeUndefined();
    expect(resolveSchemaKeyword({ oneOf: [{ default: 1 }, { default: 2 }] }, 'default')).toBeUndefined();
    expect(resolveSchemaKeyword({ $ref: '#/components/schemas/Loop' }, 'default', components)).toBeUndefined();
  });
});

describe('END_OF_ITERATION_FIELDS', () => {
  it('lists every stop-field spelling the detector reads, for envelope recognition to share', () => {
    const expected = [
      'hasMore',
      'has_more',
      'hasNext',
      'has_next',
      'totalPages',
      'total_pages',
      'pageCount',
      'page_count',
      'totalCount',
      'total_count',
      'total',
    ];
    for (const name of expected) expect(END_OF_ITERATION_FIELDS).toContain(name);
  });
});

describe('detectEndOfIteration', () => {
  const integer: SchemaObject = { type: 'integer' };
  const boolean: SchemaObject = { type: 'boolean' };
  const data: SchemaObject = { type: 'array', items: { type: 'string' } };

  it('finds totalPages nested under the pagination companion, as a dotted path', () => {
    const properties = {
      pets: data,
      pagination: { type: 'object', properties: { page: integer, totalPages: integer } },
    };
    expect(detectEndOfIteration(properties, 'pets')).toEqual({ kind: 'totalPages', path: 'pagination.totalPages' });
  });

  it('finds a top-level has_more boolean', () => {
    expect(detectEndOfIteration({ data, has_more: boolean }, 'data')).toEqual({ kind: 'hasMore', path: 'has_more' });
  });

  it('finds a top-level total count', () => {
    expect(detectEndOfIteration({ items: data, total: integer }, 'items')).toEqual({
      kind: 'totalCount',
      path: 'total',
    });
    expect(detectEndOfIteration({ items: data, total_count: { type: 'number' } }, 'items')).toEqual({
      kind: 'totalCount',
      path: 'total_count',
    });
  });

  it('prefers hasMore over totalPages over a total count', () => {
    const meta = { type: 'object', properties: { total: integer, total_pages: integer, has_more: boolean } };
    expect(detectEndOfIteration({ data, meta }, 'data')).toEqual({ kind: 'hasMore', path: 'meta.has_more' });
    expect(detectEndOfIteration({ data, total: integer, total_pages: integer }, 'data')).toEqual({
      kind: 'totalPages',
      path: 'total_pages',
    });
  });

  it('prefers a top-level field over a nested one of the same kind', () => {
    const pagination = { type: 'object', properties: { has_more: boolean } };
    expect(detectEndOfIteration({ data, pagination, hasMore: boolean }, 'data')).toEqual({
      kind: 'hasMore',
      path: 'hasMore',
    });
  });

  it('follows a $ref companion to its component schema', () => {
    const components: Record<string, SchemaObject> = {
      Pagination: { type: 'object', properties: { page: integer, total_pages: integer } },
    };
    const properties = { data, pagination: { $ref: '#/components/schemas/Pagination' } };
    expect(detectEndOfIteration(properties, 'data', components)).toEqual({
      kind: 'totalPages',
      path: 'pagination.total_pages',
    });
  });

  it('merges the allOf members of a companion, including $ref members', () => {
    const components: Record<string, SchemaObject> = { Base: { type: 'object', properties: { page: integer } } };
    const pagination: SchemaObject = {
      allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { pageCount: integer } }],
    };
    expect(detectEndOfIteration({ data, pagination }, 'data', components)).toEqual({
      kind: 'totalPages',
      path: 'pagination.pageCount',
    });
  });

  it('accepts a nullable companion declared with a type array', () => {
    const pagination: SchemaObject = {
      type: ['object', 'null'],
      properties: { totalPages: { type: ['integer', 'null'] } },
    };
    expect(detectEndOfIteration({ data, pagination }, 'data')).toEqual({
      kind: 'totalPages',
      path: 'pagination.totalPages',
    });
  });

  it('looks through a nullable oneOf wrapper around the companion', () => {
    const pagination: SchemaObject = {
      oneOf: [{ type: 'null' }, { type: 'object', properties: { has_more: boolean } }],
    };
    expect(detectEndOfIteration({ data, pagination }, 'data')).toEqual({
      kind: 'hasMore',
      path: 'pagination.has_more',
    });
  });

  it('ignores a candidate whose type does not fit its kind', () => {
    expect(detectEndOfIteration({ data, total: { type: 'string' }, has_more: integer }, 'data')).toBeUndefined();
  });

  it('never reads the data array itself', () => {
    expect(detectEndOfIteration({ total: data, object: { type: 'string' } }, 'total')).toBeUndefined();
  });

  it('returns undefined when nothing recognizable is declared', () => {
    const list_metadata = { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } } };
    expect(detectEndOfIteration({ data, list_metadata, object: { type: 'string' } }, 'data')).toBeUndefined();
  });

  it('stops on a component that refers to itself, as a stop field or beside one (Greptile)', () => {
    // `Flag: oneOf [$ref Flag, null]` is a reference cycle: unwrapping it must
    // end on the reference, whatever the companion is called.
    const components: Record<string, SchemaObject> = {
      Flag: { oneOf: [{ $ref: '#/components/schemas/Flag' }, { type: 'null' }] },
      Ping: { anyOf: [{ type: 'null' }, { $ref: '#/components/schemas/Pong' }] },
      Pong: { oneOf: [{ $ref: '#/components/schemas/Ping' }, { type: 'null' }] },
    };
    const flag: SchemaObject = { $ref: '#/components/schemas/Flag' };
    const ping: SchemaObject = { $ref: '#/components/schemas/Ping' };
    expect(detectEndOfIteration({ data, flag, has_more: boolean }, 'data', components)).toEqual({
      kind: 'hasMore',
      path: 'has_more',
    });
    expect(detectEndOfIteration({ data, has_more: flag }, 'data', components)).toBeUndefined();
    expect(detectEndOfIteration({ data, total: ping }, 'data', components)).toBeUndefined();
    expect(detectEndOfIteration({ data, pagination: flag }, 'data', components)).toBeUndefined();
    const pagination: SchemaObject = { type: 'object', properties: { has_more: flag, total: integer } };
    expect(detectEndOfIteration({ data, pagination }, 'data', components)).toEqual({
      kind: 'totalCount',
      path: 'pagination.total',
    });
  });

  it('reads a stop field through alternating $refs and nullable wrappers', () => {
    const components: Record<string, SchemaObject> = {
      MaybeCount: { oneOf: [{ $ref: '#/components/schemas/Count' }, { type: 'null' }] },
      Count: { type: ['integer', 'null'] },
      Flagged: { type: 'boolean', nullable: true },
    };
    expect(
      detectEndOfIteration({ data, total: { $ref: '#/components/schemas/MaybeCount' } }, 'data', components),
    ).toEqual({ kind: 'totalCount', path: 'total' });
    const has_more: SchemaObject = { anyOf: [{ type: 'null' }, { $ref: '#/components/schemas/Flagged' }] };
    expect(detectEndOfIteration({ data, has_more }, 'data', components)).toEqual({
      kind: 'hasMore',
      path: 'has_more',
    });
  });
  it('reads the fields beside a nested array first, under a parent of any name (MichaelDeBoey)', () => {
    const beside = (fields: Record<string, SchemaObject>): SchemaObject => ({
      type: 'object',
      properties: { items: data, ...fields },
    });
    expect(detectEndOfIteration({ result: beside({ total_pages: integer }) }, 'result.items')).toEqual({
      kind: 'totalPages',
      path: 'result.total_pages',
    });
    expect(detectEndOfIteration({ data: beside({ has_more: boolean }) }, 'data.items')).toEqual({
      kind: 'hasMore',
      path: 'data.has_more',
    });
    const twoDown: SchemaObject = { type: 'object', properties: { page: beside({ has_more: boolean }) } };
    expect(detectEndOfIteration({ data: twoDown }, 'data.page.items')).toEqual({
      kind: 'hasMore',
      path: 'data.page.has_more',
    });
    // The array itself is never a stop field, whatever it is called.
    const named: SchemaObject = { type: 'object', properties: { total: data } };
    expect(detectEndOfIteration({ result: named }, 'result.total')).toBeUndefined();
    // Beside the array before the top level within one kind; the kind order
    // still decides across levels.
    expect(detectEndOfIteration({ result: beside({ has_more: boolean }), has_more: boolean }, 'result.items')).toEqual({
      kind: 'hasMore',
      path: 'result.has_more',
    });
    expect(detectEndOfIteration({ result: beside({ total: integer }), has_more: boolean }, 'result.items')).toEqual({
      kind: 'hasMore',
      path: 'has_more',
    });
    // The parent is reached as the path is resolved: through a $ref under a
    // nullable wrapper, and through an allOf.
    const components: Record<string, SchemaObject> = { Result: beside({ total_pages: integer }) };
    const wrapped: SchemaObject = { oneOf: [{ $ref: '#/components/schemas/Result' }, { type: 'null' }] };
    expect(detectEndOfIteration({ result: wrapped }, 'result.items', components)).toEqual({
      kind: 'totalPages',
      path: 'result.total_pages',
    });
    const composed: SchemaObject = { allOf: [{ $ref: '#/components/schemas/Result' }, beside({ has_more: boolean })] };
    expect(detectEndOfIteration({ result: composed }, 'result.items', components)).toEqual({
      kind: 'hasMore',
      path: 'result.has_more',
    });
  });
});

describe('resolveSchemaPath', () => {
  const components: Record<string, SchemaObject> = {
    PetList: { type: 'object', properties: { result: { $ref: '#/components/schemas/Result' } } },
    Result: { allOf: [{ type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } }] },
  };

  it('walks a dotted path through nullable wrappers, $refs and allOf members', () => {
    const root: SchemaObject = { oneOf: [{ $ref: '#/components/schemas/PetList' }, { type: 'null' }] };
    expect(resolveSchemaPath(root, 'result.items', components)).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('resolves a $ref the path ends on', () => {
    const root: SchemaObject = { type: 'object', properties: { result: { $ref: '#/components/schemas/Result' } } };
    expect(resolveSchemaPath(root, 'result', components)).toBe(components.Result);
  });

  it('returns undefined for a missing segment or a non-object along the way', () => {
    expect(resolveSchemaPath({ $ref: '#/components/schemas/PetList' }, 'result.pets', components)).toBeUndefined();
    expect(resolveSchemaPath({ type: 'string' }, 'items')).toBeUndefined();
  });
});

describe('resolveDataPathItemType', () => {
  const models: Model[] = [
    {
      name: 'PetList',
      fields: [
        { name: 'pets', type: pets, required: true },
        { name: 'meta', type: { kind: 'nullable', inner: { kind: 'model', name: 'Meta' } }, required: false },
        { name: 'count', type: { kind: 'primitive', type: 'integer' }, required: false },
      ],
    },
    {
      name: 'Meta',
      fields: [
        {
          name: 'ids',
          type: { kind: 'nullable', inner: { kind: 'array', items: { kind: 'primitive', type: 'string' } } },
          required: false,
        },
      ],
    },
  ];
  const wrapper: TypeRef = { kind: 'model', name: 'PetList' };

  it('returns the element type of the array the path lands on', () => {
    expect(resolveDataPathItemType(wrapper, 'pets', models)).toEqual(pet);
  });

  it('returns the very TypeRef the field holds, so later renames reach it', () => {
    const items = resolveDataPathItemType(wrapper, 'pets', models);
    expect(items).toBe((models[0].fields[0].type as { items: TypeRef }).items);
  });

  it('treats an empty path as the root itself', () => {
    expect(resolveDataPathItemType(pets, '', models)).toEqual(pet);
    expect(resolveDataPathItemType({ kind: 'nullable', inner: pets }, '', models)).toEqual(pet);
    expect(resolveDataPathItemType(wrapper, '', models)).toBeUndefined();
  });

  it('unwraps nullables along the way and at the end', () => {
    expect(resolveDataPathItemType({ kind: 'nullable', inner: wrapper }, 'meta.ids', models)).toEqual({
      kind: 'primitive',
      type: 'string',
    });
  });

  it('returns undefined for a missing field, an unknown model, a non-array target, or a non-model root', () => {
    expect(resolveDataPathItemType(wrapper, 'items', models)).toBeUndefined();
    expect(resolveDataPathItemType({ kind: 'model', name: 'Nope' }, 'pets', models)).toBeUndefined();
    expect(resolveDataPathItemType(wrapper, 'count', models)).toBeUndefined();
    expect(resolveDataPathItemType(pets, 'pets', models)).toBeUndefined();
  });
});

describe('resolveDataPathFromSchema — the document fallback', () => {
  const components: Record<string, SchemaObject> = {
    Pet: { type: 'object', properties: { id: { type: 'string' } } },
    PetList: {
      type: 'object',
      properties: {
        pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
        result: {
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } },
        },
        tags: { type: ['array', 'null'], items: { type: 'string' } },
        count: { type: 'integer' },
      },
    },
  };
  const root: SchemaObject = { $ref: '#/components/schemas/PetList' };

  it('types $ref items by name without materializing anything', () => {
    expect(resolveDataPathFromSchema(root, 'pets', 'ListPetsResponse', components)).toEqual({
      itemType: { kind: 'model', name: 'Pet' },
      inlineModels: [],
    });
  });

  it('materializes inline object items under a path-derived name, never the bare <Op>Item', () => {
    const resolved = resolveDataPathFromSchema(root, 'result.items', 'ListPetsResponse', components);
    expect(resolved?.itemType).toEqual({ kind: 'model', name: 'ListPetsResultItem' });
    expect(resolved?.inlineModels.map((m) => m.name)).toEqual(['ListPetsResultItem']);
    expect(resolved?.inlineModels[0].fields.map((f) => f.name)).toEqual(['id']);
  });

  it('types primitive items, including those of a nullable array', () => {
    expect(resolveDataPathFromSchema(root, 'tags', 'ListPetsResponse', components)?.itemType).toEqual({
      kind: 'primitive',
      type: 'string',
    });
  });

  it('returns undefined when the path does not land on an array', () => {
    expect(resolveDataPathFromSchema(root, 'count', 'ListPetsResponse', components)).toBeUndefined();
    expect(resolveDataPathFromSchema(root, 'missing', 'ListPetsResponse', components)).toBeUndefined();
  });
});

describe('resolveDataPathFromSchema — nullable arrays and every item shape (Greptile)', () => {
  const stringArray: SchemaObject = { type: 'array', items: { type: 'string' } };
  const string: TypeRef = { kind: 'primitive', type: 'string' };
  const components: Record<string, SchemaObject> = {
    Tags: { type: ['array', 'null'], items: { type: 'string' } },
    Wrapper: {
      type: 'object',
      properties: {
        union: { oneOf: [stringArray, { type: 'null' }] },
        anyOfUnion: { anyOf: [{ type: 'null' }, stringArray] },
        typeList: { type: ['array', 'null'], items: { type: 'string' } },
        flagged: { type: 'array', nullable: true, items: { type: 'string' } },
        viaRef: { oneOf: [{ $ref: '#/components/schemas/Tags' }, { type: 'null' }] },
        nested: {
          oneOf: [
            { type: 'object', properties: { items: { oneOf: [stringArray, { type: 'null' }] } } },
            { type: 'null' },
          ],
        },
      },
    },
  };
  const root: SchemaObject = { $ref: '#/components/schemas/Wrapper' };

  it.each(['union', 'anyOfUnion', 'typeList', 'flagged', 'viaRef', 'nested.items'])(
    'reaches the array under the nullable wrapper at %s, as the IR walk unwraps a nullable field',
    (path) => {
      expect(resolveDataPathFromSchema(root, path, 'ListPetsResponse', components)).toEqual({
        itemType: string,
        inlineModels: [],
      });
    },
  );

  const object = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', properties });
  const id = object({ id: { type: 'string' } });
  const itemShapes: Record<string, SchemaObject> = {
    'a nullable object (type list)': { ...id, type: ['object', 'null'] },
    'a nullable object (OAS 3.0 flag)': { ...id, nullable: true },
    'a nullable oneOf around an object': { oneOf: [id, { type: 'null' }] },
    'a union of inline objects': { oneOf: [id, object({ name: { type: 'string' } })] },
    'an object holding a nested object': object({ owner: object({ name: { type: 'string' } }) }),
    'an array of inline objects': { type: 'array', items: id },
    'a map of inline objects': { type: 'object', additionalProperties: id },
  };

  it.each(Object.entries(itemShapes))(
    'materializes every model the item type references when the items are %s, under the path-derived name',
    (_shape, items) => {
      const schema = object({ result: object({ items: { type: 'array', items } }) });
      const resolved = resolveDataPathFromSchema(schema, 'result.items', 'ListPetsResponse');
      expect(resolved).toBeDefined();
      const materialized = resolved!.inlineModels.map((m) => m.name);
      const referenced = [
        ...modelNamesIn(resolved!.itemType),
        ...resolved!.inlineModels.flatMap((m) => m.fields.flatMap((f) => modelNamesIn(f.type))),
      ];
      expect(referenced.length).toBeGreaterThan(0);
      for (const name of referenced) expect(materialized).toContain(name);
      for (const name of materialized) expect(name).toContain('ListPetsResultItem');
      expect(materialized).not.toContain('ListPetsItem');
    },
  );
});

describe('resolvePaginationOverride + applyPaginationOverride', () => {
  const detected: PaginationMeta = {
    strategy: 'offset',
    param: 'page',
    limitParam: 'limit',
    dataPath: 'pets',
    itemType: pet,
    endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
  };
  const params = [param('page', { default: 1 }), param('limit'), param('cursor')];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const apply = (base: PaginationMeta | undefined, sources: PaginationOverrides, overrideItemType?: TypeRef) =>
    applyPaginationOverride(base, resolvePaginationOverride(sources, 'listPets'), params, pets, 'listPets', {
      overrideItemType,
    });

  afterEach(() => {
    warn.mockClear();
  });

  it('returns the detected metadata untouched when no override is given', () => {
    expect(resolvePaginationOverride({}, 'listPets')).toBeUndefined();
    expect(apply(detected, {})).toBe(detected);
    expect(warn).not.toHaveBeenCalled();
  });

  it('merges the sources field by field, hint over extension, and names both for warnings', () => {
    const resolved = resolvePaginationOverride(
      { extension: { strategy: 'page', dataPath: 'items' }, hint: { strategy: 'cursor', param: 'cursor' } },
      'listPets',
    );
    expect(resolved).toEqual({
      hint: { strategy: 'cursor', param: 'cursor', dataPath: 'items' },
      source: 'x-pagination / operationHints pagination',
    });
  });

  it('re-labels the strategy and keeps every detected field it does not restate', () => {
    expect(apply(detected, { extension: { strategy: 'page' } })).toEqual({
      ...detected,
      strategy: 'page',
      pageStart: 1,
    });
  });

  it('layers the config hint over the extension over detection, field by field', () => {
    expect(
      apply(detected, {
        extension: { strategy: 'page', dataPath: 'items' },
        hint: { strategy: 'cursor', param: 'cursor' },
      }),
    ).toEqual({
      strategy: 'cursor',
      param: 'cursor',
      limitParam: 'limit',
      dataPath: 'items',
      itemType: pet,
      endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
    });
  });

  it('turns pagination off with strategy none, from either source', () => {
    expect(apply(detected, { extension: { strategy: 'none' } })).toBeUndefined();
    expect(apply(detected, { hint: { strategy: 'none' } })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('builds pagination from scratch when nothing was detected', () => {
    const result = apply(undefined, {
      extension: { strategy: 'cursor', param: 'cursor', endOfIteration: { kind: 'hasMore', path: 'has_more' } },
    });
    expect(result).toEqual({
      strategy: 'cursor',
      param: 'cursor',
      itemType: pet,
      endOfIteration: { kind: 'hasMore', path: 'has_more' },
    });
  });

  it('uses the item type an explicit dataPath resolved to', () => {
    const result = apply(detected, { extension: { dataPath: 'result.items' } }, { kind: 'primitive', type: 'string' });
    expect(result).toMatchObject({ dataPath: 'result.items', itemType: { kind: 'primitive', type: 'string' } });
  });

  it('replaces the detected end-of-iteration field when the override names one', () => {
    const end = { kind: 'hasMore', path: 'meta.more' } as const;
    const result = apply(detected, { extension: { endOfIteration: end } });
    expect(result?.endOfIteration).toEqual(end);
    expect(result?.strategy).toBe('offset');
  });

  it('derives pageStart from the page parameter in use, or takes it from the override', () => {
    expect(apply(detected, { extension: { strategy: 'page' } })?.pageStart).toBe(1);
    expect(apply(detected, { hint: { strategy: 'page', pageStart: 5 } })?.pageStart).toBe(5);
    const zeroBased = applyPaginationOverride(
      detected,
      resolvePaginationOverride({ extension: { strategy: 'page' } }, 'x'),
      [param('page', { default: 0 }), param('limit')],
      pets,
      'x',
    );
    expect(zeroBased?.pageStart).toBe(0);
  });

  it('asks the caller-supplied resolver for the first page of the parameter in use', () => {
    const pageStartOf = (p: Parameter | undefined) => (p?.name === 'page' ? 42 : 1);
    const result = applyPaginationOverride(
      detected,
      resolvePaginationOverride({ extension: { strategy: 'page' } }, 'x'),
      params,
      pets,
      'x',
      { pageStartOf },
    );
    expect(result?.pageStart).toBe(42);
  });

  it("carries the response's stop field into an iterator the override creates from scratch (Greptile)", () => {
    const total = { kind: 'totalCount', path: 'total' } as const;
    const override = resolvePaginationOverride({ extension: { strategy: 'page', param: 'page' } }, 'x');
    expect(applyPaginationOverride(undefined, override, params, pets, 'x', { endOfIteration: total })).toMatchObject({
      strategy: 'page',
      param: 'page',
      endOfIteration: total,
    });
    // The override's own stop field wins over it; a detected iterator's does too.
    const own = resolvePaginationOverride(
      { extension: { strategy: 'page', param: 'page', endOfIteration: { kind: 'hasMore', path: 'more' } } },
      'x',
    );
    expect(
      applyPaginationOverride(undefined, own, params, pets, 'x', { endOfIteration: total })?.endOfIteration,
    ).toEqual({ kind: 'hasMore', path: 'more' });
    expect(
      applyPaginationOverride(detected, override, params, pets, 'x', { endOfIteration: total })?.endOfIteration,
    ).toBe(detected.endOfIteration);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops pageStart when the resulting strategy is not page', () => {
    expect(apply(detected, { extension: { strategy: 'offset', pageStart: 5 } })?.pageStart).toBeUndefined();
    expect(
      apply({ ...detected, strategy: 'page', pageStart: 1 }, { hint: { strategy: 'cursor', param: 'cursor' } }),
    ).not.toHaveProperty('pageStart');
  });

  it('warns and falls back to detection on an unknown strategy', () => {
    expect(apply(detected, { extension: { strategy: 'bogus' } })).toBe(detected);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[oagen] Warning: x-pagination on listPets: unknown strategy "bogus"'),
    );
  });

  it('warns and falls back when a strategy is given but no param exists from any source', () => {
    // No page parameter is declared, none was detected, and the override names none.
    const override = resolvePaginationOverride({ extension: { strategy: 'page' } }, 'listPets');
    expect(applyPaginationOverride(undefined, override, [param('limit')], pets, 'listPets')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('strategy "page" needs a param'));
  });

  it("takes the strategy's own query parameter over one detection guessed (MichaelDeBoey)", () => {
    // `GET /pets?page` with `{ data, total_pages }`: the envelope fallback detected
    // `cursor`/`after`, which the operation never declares.
    const fallback: PaginationMeta = {
      strategy: 'cursor',
      param: 'after',
      dataPath: 'data',
      itemType: pet,
      endOfIteration: { kind: 'totalPages', path: 'total_pages' },
    };
    const override = resolvePaginationOverride({ extension: { strategy: 'page' } }, 'listPets');
    const result = applyPaginationOverride(fallback, override, [param('page', { default: 1 })], pets, 'listPets');
    expect(result).toMatchObject({ strategy: 'page', param: 'page', pageStart: 1 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and falls back when the resolved param, not only an explicit one, is undeclared', () => {
    const fallback: PaginationMeta = { strategy: 'cursor', param: 'after', dataPath: 'data', itemType: pet };
    const override = resolvePaginationOverride({ extension: { strategy: 'page' } }, 'listPets');
    expect(applyPaginationOverride(fallback, override, [param('limit')], pets, 'listPets')).toBe(fallback);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('param "after" is not a query parameter of the operation — ignoring the override'),
    );
  });

  it('warns and falls back when only a param is given and no strategy exists from any source', () => {
    expect(apply(undefined, { extension: { param: 'page' } })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sets no strategy and none was detected'));
  });

  it('warns and falls back when the named param is not a query parameter of the operation', () => {
    expect(apply(detected, { hint: { param: 'pg' } })).toBe(detected);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('operationHints pagination on listPets: param "pg" is not a query parameter'),
    );
  });

  it('warns and falls back when the named limitParam is not a query parameter', () => {
    expect(apply(detected, { extension: { limitParam: 'size' } })).toBe(detected);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('limitParam "size" is not a query parameter'));
  });

  it('still applies a valid hint when the extension is malformed', () => {
    expect(apply(detected, { extension: 'page', hint: { strategy: 'page' } })?.strategy).toBe('page');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('x-pagination on listPets must be an object'));
  });
});

describe('validatePaginationHint', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    warn.mockClear();
  });

  it('returns only the keys the author set', () => {
    expect(validatePaginationHint({ strategy: 'page', limitParam: 'per_page' }, 'x-pagination', 'op')).toEqual({
      strategy: 'page',
      limitParam: 'per_page',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a key set to undefined as absent', () => {
    expect(validatePaginationHint({ strategy: undefined, param: 'page' }, 'x-pagination', 'op')).toEqual({
      param: 'page',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips an unknown key with a warning and keeps the rest', () => {
    expect(validatePaginationHint({ strategy: 'page', limit_param: 'x' }, 'x-pagination', 'op')).toEqual({
      strategy: 'page',
    });
    expect(warn).toHaveBeenCalledWith('[oagen] Warning: x-pagination on op: unknown key "limit_param" skipped');
  });

  it('rejects anything that is not an object', () => {
    expect(validatePaginationHint('page', 'x-pagination', 'op')).toBeUndefined();
    expect(validatePaginationHint(null, 'x-pagination', 'op')).toBeUndefined();
    expect(validatePaginationHint(['page'], 'x-pagination', 'op')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('rejects an empty or non-string parameter name', () => {
    expect(validatePaginationHint({ param: '' }, 'x-pagination', 'op')).toBeUndefined();
    expect(validatePaginationHint({ dataPath: 3 }, 'x-pagination', 'op')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('param must be a non-empty string'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dataPath must be a non-empty string'));
  });

  it('rejects a pageStart that is not a non-negative integer', () => {
    expect(validatePaginationHint({ pageStart: -1 }, 'x-pagination', 'op')).toBeUndefined();
    expect(validatePaginationHint({ pageStart: 1.5 }, 'x-pagination', 'op')).toBeUndefined();
    expect(validatePaginationHint({ pageStart: '1' }, 'x-pagination', 'op')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(validatePaginationHint({ pageStart: 0 }, 'x-pagination', 'op')).toEqual({ pageStart: 0 });
  });

  it('rejects a malformed endOfIteration', () => {
    expect(
      validatePaginationHint({ endOfIteration: { kind: 'last', path: 'x' } }, 'x-pagination', 'op'),
    ).toBeUndefined();
    expect(validatePaginationHint({ endOfIteration: { kind: 'hasMore' } }, 'x-pagination', 'op')).toBeUndefined();
    expect(validatePaginationHint({ endOfIteration: 'has_more' }, 'x-pagination', 'op')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
