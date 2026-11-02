import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';
import { walkTypeRef } from '../../src/ir/types.js';
import type { PaginationHint } from '../../src/ir/operation-hints.js';

/**
 * End-to-end coverage for #221: a page-numbered list comes out as the `page`
 * strategy with its first page and the field that ends the iteration, and the
 * operation's `x-pagination` extension or an `operationHints` entry can
 * override the guess — config hint over extension over detection.
 */
describe('parseSpec — page pagination and x-pagination overrides', () => {
  let tmpDir: string;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-pagination-override-'));
  });

  afterEach(async () => {
    warn.mockClear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown, options?: Parameters<typeof parseSpec>[1]): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile, options);
  }

  const query = (name: string, schema: Record<string, unknown> = { type: 'integer' }) => ({
    name,
    in: 'query',
    schema,
  });
  const pageParams = [query('page', { type: 'integer', minimum: 1, default: 1 }), query('limit', { type: 'integer' })];

  const envelope = (companions: Record<string, unknown>) => ({
    type: 'object',
    properties: { pets: { type: 'array', items: { type: 'string' } }, ...companions },
    required: ['pets', ...Object.keys(companions)],
  });
  const totalPagesEnvelope = envelope({
    pagination: {
      type: 'object',
      properties: { page: { type: 'integer' }, totalPages: { type: 'integer' } },
      required: ['page', 'totalPages'],
    },
  });
  const jsonResponse = (schema: unknown) => ({
    '200': { description: 'ok', content: { 'application/json': { schema } } },
  });

  const petsSpec = (operation: Record<string, unknown>, components?: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: pageParams,
          responses: jsonResponse(totalPagesEnvelope),
          ...operation,
        },
      },
    },
    ...(components && { components }),
  });

  const onlyOperation = (ir: ApiSpec): Operation => {
    const operations = ir.services.flatMap((s) => s.operations);
    expect(operations).toHaveLength(1);
    return operations[0];
  };

  /** Every model name a TypeRef references, through nullable, array, map and union wrappers. */
  const modelNamesIn = (ref: TypeRef): string[] => {
    const names: string[] = [];
    walkTypeRef(ref, { model: (m) => names.push(m.name) });
    return names;
  };
  /** Every enum name a TypeRef references, through the same wrappers. */
  const enumNamesIn = (ref: TypeRef): string[] => {
    const names: string[] = [];
    walkTypeRef(ref, { enum: (e) => names.push(e.name) });
    return names;
  };

  it('reports the issue repro as page pagination ending at pagination.totalPages (#221)', async () => {
    const op = onlyOperation(await parseJson(petsSpec({})));
    expect(op.pagination).toEqual({
      strategy: 'page',
      param: 'page',
      limitParam: 'limit',
      pageStart: 1,
      dataPath: 'pets',
      itemType: { kind: 'primitive', type: 'string' },
      envelopeFields: [{ name: 'pagination', type: { kind: 'model', name: 'Pagination' }, required: true }],
      endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('detects a top-level has_more boolean as the end of iteration', async () => {
    const op = onlyOperation(
      await parseJson(petsSpec({ responses: jsonResponse(envelope({ has_more: { type: 'boolean' } })) })),
    );
    expect(op.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });
  });

  it('reads a stop field through a nullable oneOf wrapper, as through a type list (Greptile)', async () => {
    const wrapped = envelope({ has_more: { oneOf: [{ type: 'boolean' }, { type: 'null' }] } });
    const op = onlyOperation(await parseJson(petsSpec({ responses: jsonResponse(wrapped) })));
    expect(op.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });
    const listed = envelope({ has_more: { type: ['boolean', 'null'] } });
    const op2 = onlyOperation(await parseJson(petsSpec({ responses: jsonResponse(listed) })));
    expect(op2.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });
  });

  it('reads the end-of-iteration field through a $ref companion', async () => {
    const schema = envelope({ meta: { $ref: '#/components/schemas/Meta' } });
    const components = { schemas: { Meta: { type: 'object', properties: { total_pages: { type: 'integer' } } } } };
    const op = onlyOperation(await parseJson(petsSpec({ responses: jsonResponse(schema) }, components)));
    expect(op.pagination?.endOfIteration).toEqual({ kind: 'totalPages', path: 'meta.total_pages' });
  });

  it('survives a companion whose component refers to itself, as a stop field or beside one (Greptile)', async () => {
    const schemas = { Flag: { oneOf: [{ $ref: '#/components/schemas/Flag' }, { type: 'null' }] } };
    const flag = { $ref: '#/components/schemas/Flag' };
    const beside = envelope({ flag, has_more: { type: 'boolean' } });
    const op = onlyOperation(await parseJson(petsSpec({ responses: jsonResponse(beside) }, { schemas })));
    expect(op.pagination).toMatchObject({ dataPath: 'pets', endOfIteration: { kind: 'hasMore', path: 'has_more' } });
    // As the stop field itself its type is never known, so there is no stop field.
    const asStop = envelope({ has_more: flag });
    const op2 = onlyOperation(await parseJson(petsSpec({ responses: jsonResponse(asStop) }, { schemas })));
    expect(op2.pagination?.dataPath).toBe('pets');
    expect(op2.pagination?.endOfIteration).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves endOfIteration unset when the envelope declares nothing recognizable', async () => {
    const schema = envelope({ list_metadata: { type: 'object', properties: { after: { type: 'string' } } } });
    const op = onlyOperation(await parseJson(petsSpec({ responses: jsonResponse(schema) })));
    expect(op.pagination).toBeDefined();
    expect(op.pagination?.endOfIteration).toBeUndefined();
  });

  it('looks inside pagination-looking companions only, so an unrelated total is not the stop field (MichaelDeBoey)', async () => {
    const schema = envelope({
      pagination: { type: 'object', properties: { page: { type: 'integer' } } },
      stats: { type: 'object', properties: { total: { type: 'integer' } } },
    });
    const op = onlyOperation(await parseJson(petsSpec({ responses: jsonResponse(schema) })));
    expect(op.pagination?.endOfIteration).toBeUndefined();
    // Top-level stop fields are read whatever their neighbours are called.
    const topLevel = envelope({
      stats: { type: 'object', properties: { x: { type: 'integer' } } },
      total: { type: 'integer' },
    });
    const op2 = onlyOperation(await parseJson(petsSpec({ responses: jsonResponse(topLevel) })));
    expect(op2.pagination?.endOfIteration).toEqual({ kind: 'totalCount', path: 'total' });
  });

  describe('stop-field aliases mark an envelope', () => {
    it.each([
      ['hasMore', { type: 'boolean' }, { kind: 'hasMore', path: 'hasMore' }],
      ['hasNext', { type: 'boolean' }, { kind: 'hasMore', path: 'hasNext' }],
      ['has_next', { type: 'boolean' }, { kind: 'hasMore', path: 'has_next' }],
      ['pageCount', { type: 'integer' }, { kind: 'totalPages', path: 'pageCount' }],
    ])('recognizes { data, %s } as a list envelope with a stop field', async (name, schema, end) => {
      const body = {
        type: 'object',
        properties: { data: { type: 'array', items: { type: 'string' } }, [name]: schema },
      };
      const op = onlyOperation(await parseJson(petsSpec({ responses: jsonResponse(body) })));
      expect(op.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
      expect(op.pagination).toMatchObject({ strategy: 'page', dataPath: 'data', endOfIteration: end });
    });
  });

  it('keeps a page parameter without a page-size parameter unpaginated unless overridden', async () => {
    const bare = { parameters: [query('page')], responses: { '200': { description: 'ok' } } };
    expect(onlyOperation(await parseJson(petsSpec(bare))).pagination).toBeUndefined();

    const overridden = { ...bare, 'x-pagination': { strategy: 'page', param: 'page' } };
    expect(onlyOperation(await parseJson(petsSpec(overridden))).pagination).toEqual({
      strategy: 'page',
      param: 'page',
      pageStart: 1,
      itemType: { kind: 'primitive', type: 'unknown' },
    });
  });

  describe('pageStart', () => {
    it("comes from the page parameter's default, else its minimum, else 1", async () => {
      const start = async (schema: Record<string, unknown>) =>
        onlyOperation(await parseJson(petsSpec({ parameters: [query('page', schema), query('limit')] }))).pagination
          ?.pageStart;
      expect(await start({ type: 'integer', default: 0 })).toBe(0);
      expect(await start({ type: 'integer', minimum: 0 })).toBe(0);
      expect(await start({ type: 'integer', default: 2, minimum: 0 })).toBe(2);
      expect(await start({ type: 'integer' })).toBe(1);
    });

    it('can be set by the override and is absent for other strategies', async () => {
      expect(onlyOperation(await parseJson(petsSpec({ 'x-pagination': { pageStart: 0 } }))).pagination?.pageStart).toBe(
        0,
      );
      const offset = onlyOperation(await parseJson(petsSpec({ 'x-pagination': { strategy: 'offset' } }))).pagination;
      expect(offset?.strategy).toBe('offset');
      expect(offset).not.toHaveProperty('pageStart');
    });

    it('reads a default hidden behind allOf, a bare $ref, a nullable wrapper or a parameter $ref', async () => {
      const components = {
        schemas: { PageNumber: { type: 'integer', default: 0, minimum: 0 } },
        parameters: {
          Page: { name: 'page', in: 'query', schema: { allOf: [{ $ref: '#/components/schemas/PageNumber' }] } },
        },
      };
      const start = async (parameter: unknown) =>
        onlyOperation(await parseJson(petsSpec({ parameters: [parameter, query('limit')] }, components))).pagination
          ?.pageStart;
      expect(await start(query('page', { allOf: [{ $ref: '#/components/schemas/PageNumber' }] }))).toBe(0);
      expect(await start(query('page', { $ref: '#/components/schemas/PageNumber' }))).toBe(0);
      expect(
        await start(query('page', { oneOf: [{ $ref: '#/components/schemas/PageNumber' }, { type: 'null' }] })),
      ).toBe(0);
      expect(await start({ $ref: '#/components/parameters/Page' })).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    });

    it("lets the parameter's own default win over the component's", async () => {
      const components = { schemas: { PageNumber: { type: 'integer', default: 0, minimum: 0 } } };
      const op = onlyOperation(
        await parseJson(
          petsSpec(
            {
              parameters: [
                query('page', { allOf: [{ $ref: '#/components/schemas/PageNumber' }], default: 2 }),
                query('limit'),
              ],
            },
            components,
          ),
        ),
      );
      expect(op.pagination?.pageStart).toBe(2);
    });
  });

  describe('x-pagination on the Operation Object', () => {
    it.each(['cursor', 'offset', 'page', 'link-header'] as const)(
      'sets strategy %s while keeping the detected parameters and envelope',
      async (strategy) => {
        const op = onlyOperation(await parseJson(petsSpec({ 'x-pagination': { strategy } })));
        expect(op.pagination).toMatchObject({
          strategy,
          param: 'page',
          limitParam: 'limit',
          dataPath: 'pets',
          endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
        });
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('switches to a parameter detection does not recognize, keeping the detected page size', async () => {
      const op = onlyOperation(
        await parseJson(
          petsSpec({
            parameters: [...pageParams, query('next', { type: 'string' })],
            'x-pagination': { strategy: 'cursor', param: 'next' },
          }),
        ),
      );
      expect(op.pagination).toMatchObject({ strategy: 'cursor', param: 'next', limitParam: 'limit' });
    });

    it('disables pagination with strategy none and keeps the envelope as a plain response model', async () => {
      const ir = await parseJson(petsSpec({ 'x-pagination': { strategy: 'none' } }));
      const op = onlyOperation(ir);
      expect(op.pagination).toBeUndefined();
      // Nothing is unwrapped: the body is one model carrying every field.
      expect(op.response.kind).toBe('model');
      const wrapper = ir.models.find((m) => op.response.kind === 'model' && m.name === op.response.name);
      expect(wrapper?.fields.map((f) => f.name)).toEqual(['pets', 'pagination']);
      expect(wrapper?.fields[0].type).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
      const companion = wrapper?.fields[1].type;
      expect(companion?.kind).toBe('model');
      if (companion?.kind === 'model') {
        expect(ir.models.find((m) => m.name === companion.name)?.fields.map((f) => f.name)).toEqual([
          'page',
          'totalPages',
        ]);
      }
      // validateModelRefs would have warned about a dangling reference.
      expect(warn).not.toHaveBeenCalled();
    });

    it('disables pagination through the config hint the same way', async () => {
      const ir = await parseJson(petsSpec({}), {
        operationHints: { 'GET /pets': { pagination: { strategy: 'none' } } },
      });
      const op = onlyOperation(ir);
      expect(op.pagination).toBeUndefined();
      expect(op.response.kind).toBe('model');
    });

    it('sets the end-of-iteration field and data path explicitly', async () => {
      // `more` is a name detection does not know, declared where the override
      // points (#310: a path the response lacks is rejected, not kept).
      const more = envelope({
        pagination: {
          type: 'object',
          properties: { page: { type: 'integer' }, totalPages: { type: 'integer' }, more: { type: 'boolean' } },
          required: ['page', 'totalPages', 'more'],
        },
      });
      const op = onlyOperation(
        await parseJson(
          petsSpec({
            responses: jsonResponse(more),
            'x-pagination': { dataPath: 'pets', endOfIteration: { kind: 'hasMore', path: 'pagination.more' } },
          }),
        ),
      );
      expect(op.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'pagination.more' });
      expect(op.pagination?.strategy).toBe('page');
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns and falls back to detection on an unknown strategy', async () => {
      const op = onlyOperation(await parseJson(petsSpec({ 'x-pagination': { strategy: 'pages' } })));
      expect(op.pagination?.strategy).toBe('page');
      expect(warn).toHaveBeenCalledWith(
        '[oagen] Warning: x-pagination on listPets: unknown strategy "pages" (expected one of "cursor", "offset", "page", "link-header", "none") — ignoring it',
      );
    });

    it('warns and falls back when the named param is not a query parameter', async () => {
      const op = onlyOperation(await parseJson(petsSpec({ 'x-pagination': { param: 'page_number' } })));
      expect(op.pagination?.param).toBe('page');
      expect(warn).toHaveBeenCalledWith(
        '[oagen] Warning: x-pagination on listPets: param "page_number" is not a query parameter of the operation — ignoring the override',
      );
    });

    it('warns and falls back when the extension is not an object', async () => {
      const op = onlyOperation(await parseJson(petsSpec({ 'x-pagination': 'page' })));
      expect(op.pagination?.strategy).toBe('page');
      expect(warn).toHaveBeenCalledWith('[oagen] Warning: x-pagination on listPets must be an object — ignoring it');
    });

    it('names the operation by method and path when it has no operationId', async () => {
      await parseJson(petsSpec({ operationId: undefined, 'x-pagination': { strategy: 'bogus' } }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('x-pagination on GET /pets: unknown strategy "bogus"'));
    });
  });

  describe('x-pagination.dataPath selects the item type', () => {
    const Pet = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    const petArray = { type: 'array', items: { $ref: '#/components/schemas/Pet' } };

    it('types the iterator from the array a root $ref wrapper holds, not from the wrapper', async () => {
      const PetList = {
        type: 'object',
        properties: { pets: petArray, pagination: { type: 'object', properties: { totalPages: { type: 'integer' } } } },
      };
      const op = onlyOperation(
        await parseJson(
          petsSpec(
            {
              responses: jsonResponse({ $ref: '#/components/schemas/PetList' }),
              'x-pagination': { strategy: 'page', dataPath: 'pets' },
            },
            { schemas: { Pet, PetList } },
          ),
        ),
      );
      expect(op.response).toEqual({ kind: 'model', name: 'PetList' });
      expect(op.pagination).toMatchObject({
        strategy: 'page',
        param: 'page',
        dataPath: 'pets',
        itemType: { kind: 'model', name: 'Pet' },
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('types the iterator from an inline wrapper detection did not recognize as an envelope', async () => {
      // `count` alone does not mark a list envelope, so the body stays a plain model.
      const body = { type: 'object', properties: { pets: petArray, count: { type: 'integer' } } };
      const op = onlyOperation(
        await parseJson(
          petsSpec({ responses: jsonResponse(body), 'x-pagination': { dataPath: 'pets' } }, { schemas: { Pet } }),
        ),
      );
      expect(op.response.kind).toBe('model');
      expect(op.pagination).toMatchObject({
        strategy: 'page',
        dataPath: 'pets',
        itemType: { kind: 'model', name: 'Pet' },
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('reaches an array nested under an inline object of a $ref wrapper through the document', async () => {
      const PetList = { type: 'object', properties: { result: { type: 'object', properties: { items: petArray } } } };
      const op = onlyOperation(
        await parseJson(
          petsSpec(
            {
              responses: jsonResponse({ $ref: '#/components/schemas/PetList' }),
              'x-pagination': { dataPath: 'result.items' },
            },
            { schemas: { Pet, PetList } },
          ),
        ),
      );
      expect(op.pagination).toMatchObject({ dataPath: 'result.items', itemType: { kind: 'model', name: 'Pet' } });
      expect(warn).not.toHaveBeenCalled();
    });

    it('reuses the item model the parser already created for nested inline items, never a duplicate', async () => {
      const PetList = {
        type: 'object',
        properties: {
          result: {
            type: 'object',
            properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } },
          },
        },
      };
      const ir = await parseJson(
        petsSpec(
          {
            responses: jsonResponse({ $ref: '#/components/schemas/PetList' }),
            'x-pagination': { dataPath: 'result.items' },
          },
          { schemas: { PetList } },
        ),
      );
      const op = onlyOperation(ir);
      // The IR already names these items from the component; that name is kept.
      expect(op.pagination?.itemType).toEqual({ kind: 'model', name: 'PetListResultItem' });
      expect(ir.models.find((m) => m.name === 'PetListResultItem')?.fields.map((f) => f.name)).toEqual(['id']);
      expect(ir.models.some((m) => m.name === 'ListPetsItem')).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reuses the detected item type when the override restates the detected path', async () => {
      const op = onlyOperation(await parseJson(petsSpec({ 'x-pagination': { dataPath: 'pets' } })));
      expect(op.pagination).toMatchObject({ dataPath: 'pets', itemType: { kind: 'primitive', type: 'string' } });
      expect(warn).not.toHaveBeenCalled();
    });

    it("keeps the data array's item model apart from an overridden nested array's", async () => {
      // The override names another array than the `data` the envelope pass would
      // unwrap, so the body is kept as a wrapper (as `strategy: 'none'` keeps it):
      // `response` is the wrapper, the `data` items and the overridden `result.items`
      // each get their own model, and `envelopeFields` is absent since the wrapper
      // carries the companions. Its `total` is still read as the stop field.
      const body = {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
          result: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } } },
              },
            },
          },
          total: { type: 'integer' },
        },
      };
      const ir = await parseJson(
        petsSpec({ responses: jsonResponse(body), 'x-pagination': { dataPath: 'result.items' } }),
      );
      const op = onlyOperation(ir);
      expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      const wrapper = ir.models.find((m) => m.name === 'ListPetsResponse');
      expect(wrapper?.fields.map((f) => f.name)).toEqual(['data', 'result', 'total']);
      const dataItems = wrapper?.fields.find((f) => f.name === 'data')?.type;
      const dataItemModel =
        dataItems?.kind === 'array' && dataItems.items.kind === 'model'
          ? ir.models.find((m) => m.name === (dataItems.items as { name: string }).name)
          : undefined;
      expect(dataItemModel?.fields.map((f) => f.name)).toEqual(['id']);
      expect(op.pagination).toMatchObject({
        dataPath: 'result.items',
        endOfIteration: { kind: 'totalCount', path: 'total' },
      });
      expect(op.pagination).not.toHaveProperty('envelopeFields');
      const itemType = op.pagination?.itemType;
      expect(itemType?.kind).toBe('model');
      const itemModel = itemType?.kind === 'model' ? ir.models.find((m) => m.name === itemType.name) : undefined;
      expect(itemModel?.name).not.toBe(dataItemModel?.name);
      expect(itemModel?.fields.map((f) => f.name)).toEqual(['name', 'age']);
      expect(ir.models.filter((m) => m.fields.map((f) => f.name).join() === 'name,age')).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('leaves the response as detection reads it when the override will be rejected anyway (Greptile)', async () => {
      // A usable alternate `dataPath` beside a `param` the operation does not declare:
      // the override is rejected, so the envelope must stay unwrapped on `data`
      // rather than kept as a wrapper that detection then reads as the list.
      const body = {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' } },
          result: { type: 'object', properties: { items: { type: 'array', items: { type: 'integer' } } } },
          total: { type: 'integer' },
        },
      };
      const op = onlyOperation(
        await parseJson(
          petsSpec({ responses: jsonResponse(body), 'x-pagination': { dataPath: 'result.items', param: 'typo' } }),
        ),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('param "typo" is not a query parameter'));
      expect(op.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
      expect(op.pagination).toMatchObject({ strategy: 'page', param: 'page', dataPath: 'data' });
      expect(op.pagination?.itemType).toEqual({ kind: 'primitive', type: 'string' });
    });

    it('keeps a stop field beside the nested array an override selects (Greptile)', async () => {
      const body = {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' } },
          pagination: {
            type: 'object',
            properties: { items: { type: 'array', items: { type: 'integer' } }, has_more: { type: 'boolean' } },
          },
        },
      };
      const op = onlyOperation(
        await parseJson(petsSpec({ responses: jsonResponse(body), 'x-pagination': { dataPath: 'pagination.items' } })),
      );
      expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      expect(op.pagination).toMatchObject({
        dataPath: 'pagination.items',
        itemType: { kind: 'primitive', type: 'integer' },
        endOfIteration: { kind: 'hasMore', path: 'pagination.has_more' },
      });
    });

    it('keeps the data description through an override that keeps the detected array (Greptile)', async () => {
      const described = envelope({ total_pages: { type: 'integer' } });
      (described.properties.pets as Record<string, unknown>).description = 'The pets on this page.';
      const op = onlyOperation(
        await parseJson(petsSpec({ responses: jsonResponse(described), 'x-pagination': { strategy: 'page' } })),
      );
      expect(op.pagination).toMatchObject({
        strategy: 'page',
        dataPath: 'pets',
        dataDescription: 'The pets on this page.',
      });
    });

    it('keeps unwrapping when the override restates the detected path, and when it names nothing', async () => {
      const op = onlyOperation(await parseJson(petsSpec({ 'x-pagination': { dataPath: 'pets' } })));
      expect(op.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
      expect(op.pagination?.envelopeFields?.map((f) => f.name)).toEqual(['pagination']);
      warn.mockClear();
      const missing = onlyOperation(await parseJson(petsSpec({ 'x-pagination': { dataPath: 'nowhere.items' } })));
      expect(missing.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
      expect(missing.pagination?.dataPath).toBe('pets');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not resolve to an array'));
    });

    it('resolves the override against the primary response, not the last 2xx declared', async () => {
      const op = onlyOperation(
        await parseJson(
          petsSpec({
            responses: {
              ...jsonResponse(totalPagesEnvelope),
              '202': {
                description: 'queued',
                content: {
                  'application/json': { schema: { type: 'object', properties: { job_id: { type: 'string' } } } },
                },
              },
            },
            'x-pagination': { dataPath: 'pets' },
          }),
        ),
      );
      expect(op.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
      expect(op.successResponses?.map((r) => r.statusCode)).toEqual([200, 202]);
      // Every paging field describes the primary 200, not the 202 read last.
      expect(op.pagination).toMatchObject({
        strategy: 'page',
        dataPath: 'pets',
        itemType: { kind: 'primitive', type: 'string' },
        envelopeFields: [{ name: 'pagination', type: { kind: 'model', name: 'Pagination' }, required: true }],
        endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
      });
      expect(warn).not.toHaveBeenCalled();
    });

    describe('with a secondary 2xx body', () => {
      // `data` is the detected array; the override points into the `result`
      // companion, whose item model must survive the 202 being read too.
      const listBody = {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' } },
          result: {
            type: 'object',
            properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } },
          },
          total: { type: 'integer' },
        },
      };
      const jobBody = { type: 'object', properties: { job_id: { type: 'string' } } };
      const response = (schema: unknown, description = 'ok') => ({
        description,
        content: { 'application/json': { schema } },
      });

      it.each([
        ['200 declared before 202', { '200': response(listBody), '202': response(jobBody, 'queued') }],
        ['202 declared before 200', { '202': response(jobBody, 'queued'), '200': response(listBody) }],
      ])("keeps the primary body's companion item model the override selects (%s)", async (_order, responses) => {
        const ir = await parseJson(petsSpec({ responses, 'x-pagination': { dataPath: 'result.items' } }));
        const op = onlyOperation(ir);
        // The override names another array than `data`, so the 200 is kept as a wrapper.
        expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
        expect(op.successResponses?.map((r) => r.statusCode)).toEqual([200, 202]);
        expect(op.pagination).toMatchObject({
          dataPath: 'result.items',
          endOfIteration: { kind: 'totalCount', path: 'total' },
        });
        const itemType = op.pagination?.itemType;
        expect(itemType?.kind).toBe('model');
        const itemModel = itemType?.kind === 'model' ? ir.models.find((m) => m.name === itemType.name) : undefined;
        expect(itemModel?.fields.map((f) => f.name)).toEqual(['id']);
        // The 202's own model is kept as well, so `successResponses` never dangles:
        // its `{ job_id }` is another shape than the 200's kept wrapper, so it
        // steps to its status code instead of resolving to the 200's model (#309).
        const job = op.successResponses?.find((r) => r.statusCode === 202)?.type;
        expect(job).toEqual({ kind: 'model', name: 'ListPetsResponse202' });
        expect(ir.models.find((m) => m.name === 'ListPetsResponse202')?.fields.map((f) => f.name)).toEqual(['job_id']);
        // validateModelRefs would have warned about any dangling reference.
        expect(warn).not.toHaveBeenCalled();
      });
    });

    it('warns and falls back to detection when the path does not reach an array', async () => {
      const op = onlyOperation(
        await parseJson(petsSpec({ 'x-pagination': { strategy: 'offset', dataPath: 'pagination' } })),
      );
      expect(op.pagination).toMatchObject({ strategy: 'page', dataPath: 'pets' });
      expect(warn).toHaveBeenCalledWith(
        '[oagen] Warning: x-pagination on listPets: dataPath "pagination" does not resolve to an array in the response — ignoring the override',
      );
    });

    describe('through a nullable wrapper around the array (Greptile)', () => {
      // The early check (does the path reach an array? then keep the wrapper)
      // and the IR walk (what are its items?) must unwrap the same forms, or
      // the body is unwrapped on `data` while the iterator reads `result.items`.
      const stringArray = { type: 'array', items: { type: 'string' } };
      const forms: Record<string, unknown> = {
        'a oneOf with a null variant': { oneOf: [stringArray, { type: 'null' }] },
        'an anyOf with a null variant': { anyOf: [{ type: 'null' }, stringArray] },
        'a type list naming null': { type: ['array', 'null'], items: { type: 'string' } },
        'an OAS 3.0 nullable flag': { type: 'array', nullable: true, items: { type: 'string' } },
        'a nullable $ref to an array component': {
          oneOf: [{ $ref: '#/components/schemas/Tags' }, { type: 'null' }],
        },
      };
      const schemas = { Tags: { type: 'array', items: { type: 'string' } } };
      const listBody = (items: unknown) => ({
        type: 'object',
        properties: {
          data: stringArray,
          result: { type: 'object', properties: { items } },
          total: { type: 'integer' },
        },
      });
      const expectWrapperKept = (ir: ApiSpec): Operation => {
        const op = onlyOperation(ir);
        expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
        const wrapper = ir.models.find((m) => m.name === 'ListPetsResponse');
        expect(wrapper?.fields.map((f) => f.name)).toEqual(['data', 'result', 'total']);
        expect(op.pagination).toMatchObject({
          dataPath: 'result.items',
          itemType: { kind: 'primitive', type: 'string' },
          endOfIteration: { kind: 'totalCount', path: 'total' },
        });
        expect(op.pagination).not.toHaveProperty('envelopeFields');
        return op;
      };

      it.each(Object.entries(forms))(
        'keeps the wrapper when the path ends on %s, as it does for a plain array',
        async (_form, items) => {
          const operation = { responses: jsonResponse(listBody(items)), 'x-pagination': { dataPath: 'result.items' } };
          expectWrapperKept(await parseJson(petsSpec(operation, { schemas })));
          expect(warn).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['200 declared before 202', (list: unknown, job: unknown) => ({ '200': list, '202': job })],
        ['202 declared before 200', (list: unknown, job: unknown) => ({ '202': job, '200': list })],
      ])('reads the primary body, whichever 2xx is declared first (%s)', async (_order, order) => {
        const list = {
          description: 'ok',
          content: { 'application/json': { schema: listBody(forms['a oneOf with a null variant']) } },
        };
        const jobBody = { type: 'object', properties: { job_id: { type: 'string' } } };
        const job = { description: 'queued', content: { 'application/json': { schema: jobBody } } };
        const ir = await parseJson(
          petsSpec({ responses: order(list, job), 'x-pagination': { dataPath: 'result.items' } }),
        );
        const op = expectWrapperKept(ir);
        expect(op.successResponses?.map((r) => r.statusCode)).toEqual([200, 202]);
        // The 202's `{ job_id }` is another shape than the 200's kept wrapper,
        // so it steps to its status code and keeps its fields (#309).
        expect(op.successResponses?.find((r) => r.statusCode === 202)?.type).toEqual({
          kind: 'model',
          name: 'ListPetsResponse202',
        });
        expect(warn).not.toHaveBeenCalled();
      });
    });

    describe('items behind an array component (Greptile)', () => {
      // A `$ref` wrapper whose array is itself a component: the wrapper's
      // field is typed as that array (#284), so the IR walk reaches the items
      // the component pass materialized under the component's name, and
      // whatever they reference must exist there — every shape.
      const id = { type: 'object', properties: { id: { type: 'string' } } };
      const shapes: Record<string, unknown> = {
        'a nullable object (type list)': { ...id, type: ['object', 'null'] },
        'a nullable object (OAS 3.0 flag)': { ...id, nullable: true },
        'a nullable oneOf around an object': { oneOf: [id, { type: 'null' }] },
        'a union of inline objects': { oneOf: [id, { type: 'object', properties: { name: { type: 'string' } } }] },
        'an object holding a nested object': {
          type: 'object',
          properties: { owner: { type: 'object', properties: { name: { type: 'string' } } } },
        },
      };
      const wrapperSpec = (items: unknown, schemas: Record<string, unknown> = {}) =>
        petsSpec(
          {
            responses: jsonResponse({ $ref: '#/components/schemas/Wrapper' }),
            'x-pagination': { dataPath: 'records' },
          },
          {
            schemas: {
              Wrapper: {
                type: 'object',
                properties: { records: { $ref: '#/components/schemas/PetList' }, total: { type: 'integer' } },
              },
              PetList: { type: 'array', items },
              ...schemas,
            },
          },
        );

      it.each(Object.entries(shapes))(
        'creates every model the iterator type references when the items are %s',
        async (_shape, items) => {
          const ir = await parseJson(wrapperSpec(items));
          const op = onlyOperation(ir);
          expect(op.response).toEqual({ kind: 'model', name: 'Wrapper' });
          expect(op.pagination?.dataPath).toBe('records');
          const names = ir.models.map((m) => m.name);
          const referenced = modelNamesIn(op.pagination!.itemType);
          expect(referenced.length).toBeGreaterThan(0);
          for (const name of referenced) expect(names).toContain(name);
          // ...and whatever those models' own fields reference (`owner`).
          for (const model of ir.models.filter((m) => referenced.includes(m.name))) {
            for (const field of model.fields)
              for (const nested of modelNamesIn(field.type)) expect(names).toContain(nested);
          }
          // Named from the array component as its items (`PetList` →
          // `PetListItem`, #284): never from the path (`ListPetsRecord`), the
          // response, nor the `<Op>Item` a recognized envelope's data array owns.
          for (const name of referenced) expect(name).toContain('PetListItem');
          for (const name of names) expect(name).not.toContain('ListPetsRecord');
          expect(names).not.toContain('ListPetsResponse');
          expect(names).not.toContain('ListPetsItem');
          // The iterator yields exactly what the wrapper's field holds.
          const records = ir.models.find((m) => m.name === 'Wrapper')?.fields.find((f) => f.name === 'records');
          expect(records?.type).toEqual({ kind: 'array', items: op.pagination!.itemType });
          expect(warn).not.toHaveBeenCalled();
        },
      );

      it("types Greptile's case as a nullable reference to a model that exists", async () => {
        const ir = await parseJson(wrapperSpec({ ...id, type: ['object', 'null'] }));
        expect(onlyOperation(ir).pagination?.itemType).toEqual({
          kind: 'nullable',
          inner: { kind: 'model', name: 'PetListItem' },
        });
        expect(ir.models.find((m) => m.name === 'PetListItem')?.fields.map((f) => f.name)).toEqual(['id']);
      });

      // The item type is the TypeRef the wrapper's `records` field holds, so
      // every pass that walks a model's fields reaches it: the enum lift, the
      // Json-suffix fold's guard, reference validation (Greptile, after the
      // merge with main).
      const enumItems = { type: 'string', enum: ['cat', 'dog'] };
      const enumShapes: Record<string, unknown> = {
        'an inline enum': enumItems,
        'a nullable inline enum': { oneOf: [enumItems, { type: 'null' }] },
        'an array of an inline enum': { type: 'array', items: enumItems },
        'a union holding an inline enum': { oneOf: [enumItems, { type: 'integer' }] },
      };
      it.each(Object.entries(enumShapes))(
        'promotes the inline enum the iterator yields to spec.enums when the items are %s',
        async (_shape, items) => {
          const ir = await parseJson(wrapperSpec(items));
          const referenced = enumNamesIn(onlyOperation(ir).pagination!.itemType);
          expect(referenced.length).toBeGreaterThan(0);
          for (const name of referenced) {
            expect(ir.enums.find((e) => e.name === name)?.values.map((v) => v.value)).toEqual(['cat', 'dog']);
          }
          expect(warn).not.toHaveBeenCalled();
        },
      );

      it('names the iterator enum from the array component, stepping past a component enum with other members', async () => {
        const ir = await parseJson(wrapperSpec(enumItems));
        expect(onlyOperation(ir).pagination?.itemType).toMatchObject({ kind: 'enum', name: 'PetListItem' });
        expect(ir.enums.map((e) => e.name)).toEqual(['PetListItem']);

        // The name a component enum already owns with other members is not
        // shared: the array component's items step around it when they are
        // named (`PetsItemItem`), as a named union's variants do, so the
        // reference never needs renaming before it is promoted. (`PetList`'s
        // own items cannot be claimed: a component key `PetListItem` cleans
        // to `Pet`, so the array component is `Pets` here.)
        const taken = await parseJson(
          petsSpec(
            {
              responses: jsonResponse({ $ref: '#/components/schemas/Wrapper' }),
              'x-pagination': { dataPath: 'records' },
            },
            {
              schemas: {
                Wrapper: {
                  type: 'object',
                  properties: { records: { $ref: '#/components/schemas/Pets' }, total: { type: 'integer' } },
                },
                Pets: { type: 'array', items: enumItems },
                PetsItem: { type: 'string', enum: ['fish'] },
              },
            },
          ),
        );
        const itemType = onlyOperation(taken).pagination!.itemType;
        expect(itemType).toMatchObject({ kind: 'enum', name: 'PetsItemItem' });
        expect(taken.enums.map((e) => [e.name, e.values.map((v) => v.value)])).toEqual([
          ['PetsItem', ['fish']],
          ['PetsItemItem', ['cat', 'dog']],
        ]);
        expect(warn).not.toHaveBeenCalled();
      });

      it('keeps a `…Json` component the wrapper references through the array component, as for the array written inline (Greptile)', async () => {
        const jsonModels = {
          Item: { type: 'object', properties: { id: { type: 'string' } } },
          ItemJson: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
        };
        const ir = await parseJson(wrapperSpec({ $ref: '#/components/schemas/ItemJson' }, jsonModels));
        // `Wrapper.records` is `array<ItemJson>`, a reference from a third
        // model, which the fold's guard keeps both models for.
        expect(onlyOperation(ir).pagination?.itemType).toEqual({ kind: 'model', name: 'ItemJson' });
        expect(ir.models.map((m) => m.name)).toEqual(['Wrapper', 'Item', 'ItemJson']);
        expect(ir.models.find((m) => m.name === 'Item')?.fields.map((f) => f.name)).toEqual(['id']);
        expect(warn).not.toHaveBeenCalled();

        // The same wrapper with the array written inline reads identically.
        const inline = await parseJson(
          petsSpec(
            {
              responses: jsonResponse({ $ref: '#/components/schemas/Wrapper' }),
              'x-pagination': { dataPath: 'records' },
            },
            {
              schemas: {
                Wrapper: {
                  type: 'object',
                  properties: {
                    records: { type: 'array', items: { $ref: '#/components/schemas/ItemJson' } },
                    total: { type: 'integer' },
                  },
                },
                ...jsonModels,
              },
            },
          ),
        );
        expect(inline.models).toEqual(ir.models);
        expect(onlyOperation(inline).pagination).toEqual(onlyOperation(ir).pagination);
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('an override that creates the iterator where detection found none (Greptile)', () => {
    // Only a custom query parameter, so no paging parameter is recognized,
    // and the explicit `dataPath` keeps the body as a wrapper: the stop field
    // read from the wrapper belongs to the iterator the override creates.
    const customBody = {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'string' } },
        result: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
          },
        },
        total: { type: 'integer' },
      },
    };
    const custom = { parameters: [query('p')], responses: jsonResponse(customBody) };
    const hint: PaginationHint = { strategy: 'page', param: 'p', dataPath: 'result.items' };

    it("keeps the response's stop field", async () => {
      const op = onlyOperation(await parseJson(petsSpec({ ...custom, 'x-pagination': hint })));
      expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      expect(op.pagination).toEqual({
        strategy: 'page',
        param: 'p',
        pageStart: 1,
        dataPath: 'result.items',
        itemType: { kind: 'model', name: 'ListPetsResponseResultItem' },
        endOfIteration: { kind: 'totalCount', path: 'total' },
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps it through the config hint, and lets the override name its own', async () => {
      const viaHint = onlyOperation(
        await parseJson(petsSpec(custom), { operationHints: { 'GET /pets': { pagination: hint } } }),
      );
      expect(viaHint.pagination?.endOfIteration).toEqual({ kind: 'totalCount', path: 'total' });

      // The wrapper declares the `more` the override names (#310: a path the
      // response lacks is rejected, not kept), under a name detection does
      // not read, so `total` is still what detection alone would pick.
      const withMore = jsonResponse({
        ...customBody,
        properties: { ...customBody.properties, more: { type: 'boolean' } },
      });
      const own = onlyOperation(
        await parseJson(
          petsSpec({
            ...custom,
            responses: withMore,
            'x-pagination': { ...hint, endOfIteration: { kind: 'hasMore', path: 'more' } },
          }),
        ),
      );
      expect(own.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'more' });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('an override the operation cannot satisfy (#310)', () => {
    // The issue's operation: `page` and `limit`, returning `{ data: string[], total: integer }`.
    const totalEnvelope = {
      type: 'object',
      properties: { data: { type: 'array', items: { type: 'string' } }, total: { type: 'integer' } },
      required: ['data', 'total'],
    };
    const issueSpec = (
      extension: unknown,
      params: string[] = ['page', 'limit'],
      responses: unknown = jsonResponse(totalEnvelope),
      components?: Record<string, unknown>,
    ) =>
      petsSpec(
        {
          parameters: params.map((name) => query(name)),
          responses,
          ...(extension !== undefined && { 'x-pagination': extension }),
        },
        components,
      );
    /** The IR with `extension`, beside the IR detection alone yields for the same operation (which warns about nothing). */
    const parseBeside = async (extension: unknown, params?: string[], responses?: unknown) => {
      const bare = await parseJson(issueSpec(undefined, params, responses));
      expect(warn).not.toHaveBeenCalled();
      const overridden = await parseJson(issueSpec(extension, params, responses));
      return { bare, overridden };
    };
    /** The one warning a rejected override leaves, naming its source, the operation and the problem. */
    const rejected = (problem: string, source = 'x-pagination') => {
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`[oagen] Warning: ${source} on listPets: ${problem} — ignoring the override`);
    };
    /** Every model reference resolves, and every model is a component or referenced from an operation or a field. */
    const expectSound = (ir: ApiSpec, componentNames: string[]) => {
      const names = new Set(ir.models.map((m) => m.name));
      const referenced = new Set<string>();
      for (const op of ir.services.flatMap((s) => s.operations)) {
        const refs: Array<TypeRef | undefined> = [
          op.response,
          op.requestBody,
          op.pagination?.itemType,
          ...(op.pagination?.envelopeFields ?? []).map((f) => f.type),
          ...(op.successResponses ?? []).map((r) => r.type),
          ...op.errors.map((e) => e.type),
          ...[...op.pathParams, ...op.queryParams, ...op.headerParams].map((p) => p.type),
        ];
        for (const ref of refs) if (ref) for (const name of modelNamesIn(ref)) referenced.add(name);
      }
      for (const model of ir.models) {
        for (const field of model.fields) for (const name of modelNamesIn(field.type)) referenced.add(name);
      }
      expect([...referenced].filter((name) => !names.has(name))).toEqual([]);
      expect(
        ir.models.map((m) => m.name).filter((name) => !componentNames.includes(name) && !referenced.has(name)),
      ).toEqual([]);
    };

    it('warns once and falls back to detection when the endOfIteration path resolves to no field (the issue)', async () => {
      const { bare, overridden } = await parseBeside({ endOfIteration: { kind: 'hasMore', path: 'nope.missing' } });
      rejected('endOfIteration path "nope.missing" does not resolve to a field in the response');
      // The detected stop field, not the override's, and nothing else of the override.
      expect(onlyOperation(bare).pagination?.endOfIteration).toEqual({ kind: 'totalCount', path: 'total' });
      expect(onlyOperation(overridden).pagination).toEqual(onlyOperation(bare).pagination);
      expect(overridden.models).toEqual(bare.models);
    });

    it.each([
      [
        { kind: 'hasMore', path: 'total' },
        'endOfIteration path "total" is not a boolean field, as kind "hasMore" requires',
      ],
      [
        { kind: 'totalCount', path: 'data' },
        'endOfIteration path "data" is not an integer or number field, as kind "totalCount" requires',
      ],
      [
        { kind: 'totalPages', path: 'data' },
        'endOfIteration path "data" is not an integer or number field, as kind "totalPages" requires',
      ],
    ])('warns and falls back when the field %j does not fit its kind (the issue)', async (endOfIteration, problem) => {
      const { bare, overridden } = await parseBeside({ endOfIteration });
      rejected(problem);
      expect(onlyOperation(overridden).pagination).toEqual(onlyOperation(bare).pagination);
    });

    it('keeps an endOfIteration that lands on a field of the fitting type, at any depth and through the wrappers detection reads through', async () => {
      // `meta.page.last`: a nullable `$ref` companion, an `allOf` member, a
      // `$ref` field, a nullable `oneOf` boolean. `pages` is a type list;
      // neither name is one detection knows, so `total` is its own pick.
      const components = {
        schemas: {
          Flag: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
          PageInfo: { type: 'object', properties: { last: { $ref: '#/components/schemas/Flag' } } },
          Meta: { allOf: [{ type: 'object', properties: { page: { $ref: '#/components/schemas/PageInfo' } } }] },
        },
      };
      const body = {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' } },
          meta: { oneOf: [{ $ref: '#/components/schemas/Meta' }, { type: 'null' }] },
          pages: { type: ['integer', 'null'] },
          total: { type: 'integer' },
        },
      };
      for (const endOfIteration of [
        { kind: 'hasMore', path: 'meta.page.last' },
        { kind: 'totalPages', path: 'pages' },
        { kind: 'totalCount', path: 'total' },
      ] as const) {
        const ir = await parseJson(issueSpec({ endOfIteration }, undefined, jsonResponse(body), components));
        expect(onlyOperation(ir).pagination?.endOfIteration).toEqual(endOfIteration);
        expect(warn).not.toHaveBeenCalled();
        expectSound(ir, Object.keys(components.schemas));
      }
    });

    describe('a stop field every variant of a oneOf companion declares (#437)', () => {
      // The issue's operation: `GET /pets?after` returning `{ data: string[], meta }`,
      // `meta` a `oneOf` of two objects that each declare a boolean `has_more`.
      const object = (properties: Record<string, unknown>) => ({ type: 'object', properties });
      const boolean = { type: 'boolean' };
      const cursorSpec = (meta: unknown, extension?: unknown, components?: Record<string, unknown>) =>
        petsSpec(
          {
            parameters: [query('after', { type: 'string' })],
            responses: jsonResponse(object({ data: { type: 'array', items: { type: 'string' } }, meta })),
            ...(extension !== undefined && { 'x-pagination': extension }),
          },
          components,
        );
      const endOfIteration = { kind: 'hasMore', path: 'meta.has_more' };
      const issueMeta = {
        oneOf: [
          object({ has_more: boolean, next_after: { type: 'string' } }),
          object({ has_more: boolean, next_page: { type: 'integer' } }),
        ],
      };

      it('keeps the override: whichever variant is sent, the field is a boolean (the issue)', async () => {
        // Detection reads nothing inside the union, so the override is the only way to name it.
        expect(onlyOperation(await parseJson(cursorSpec(issueMeta))).pagination?.endOfIteration).toBeUndefined();
        const ir = await parseJson(cursorSpec(issueMeta, { endOfIteration }));
        expect(onlyOperation(ir).pagination).toMatchObject({ strategy: 'cursor', param: 'after', endOfIteration });
        expect(warn).not.toHaveBeenCalled();
        expectSound(ir, []);
      });

      it('keeps it through $ref variants of an anyOf beside a null variant', async () => {
        const components = {
          schemas: {
            AfterMeta: object({ has_more: boolean, next_after: { type: 'string' } }),
            PageMeta: object({ has_more: { $ref: '#/components/schemas/Flag' }, next_page: { type: 'integer' } }),
            Flag: { type: ['boolean', 'null'] },
          },
        };
        const meta = {
          anyOf: [
            { $ref: '#/components/schemas/AfterMeta' },
            { $ref: '#/components/schemas/PageMeta' },
            { type: 'null' },
          ],
        };
        const ir = await parseJson(cursorSpec(meta, { endOfIteration }, components));
        expect(onlyOperation(ir).pagination?.endOfIteration).toEqual(endOfIteration);
        expect(warn).not.toHaveBeenCalled();
        expectSound(ir, Object.keys(components.schemas));
      });

      it('keeps it when the oneOf is one of several allOf members, as the IR model declares the field (MichaelDeBoey)', async () => {
        // Every instance carries every member, so whichever variant is sent, `has_more` is a boolean.
        const meta = { allOf: [issueMeta, object({ trace_id: { type: 'string' } })] };
        expect(onlyOperation(await parseJson(cursorSpec(meta))).pagination?.endOfIteration).toBeUndefined();
        const ir = await parseJson(cursorSpec(meta, { endOfIteration }));
        expect(onlyOperation(ir).pagination).toMatchObject({ strategy: 'cursor', param: 'after', endOfIteration });
        expect(warn).not.toHaveBeenCalled();
        expectSound(ir, []);
        const hasMore = ir.models.find((m) => m.name === 'Meta')?.fields.find((f) => f.name === 'has_more');
        expect(hasMore?.type).toEqual({ kind: 'primitive', type: 'boolean' });
      });

      it('rejects a field only some variants declare, or one a variant types otherwise', async () => {
        const cases: Array<[unknown, string]> = [
          [
            { oneOf: [object({ has_more: boolean }), object({ next_page: { type: 'integer' } })] },
            'endOfIteration path "meta.has_more" does not resolve to a field in the response',
          ],
          [
            { oneOf: [object({ has_more: boolean }), object({ has_more: { type: 'string' } })] },
            'endOfIteration path "meta.has_more" is not a boolean field, as kind "hasMore" requires',
          ],
        ];
        for (const [meta, problem] of cases) {
          const bare = onlyOperation(await parseJson(cursorSpec(meta)));
          expect(warn).not.toHaveBeenCalled();
          const overridden = onlyOperation(await parseJson(cursorSpec(meta, { endOfIteration })));
          rejected(problem);
          expect(overridden.pagination).toEqual(bare.pagination);
          warn.mockClear();
        }
      });
    });

    it('checks the stop field against the primary response, not another 2xx body', async () => {
      const hasMore = { ...totalEnvelope, properties: { ...totalEnvelope.properties, more: { type: 'boolean' } } };
      const ok = (schema: unknown) => ({ description: 'ok', content: { 'application/json': { schema } } });
      // `more` only on the 201: the 200 is primary and lacks it.
      const { bare, overridden } = await parseBeside({ endOfIteration: { kind: 'hasMore', path: 'more' } }, undefined, {
        '200': ok(totalEnvelope),
        '201': ok(hasMore),
      });
      rejected('endOfIteration path "more" does not resolve to a field in the response');
      expect(onlyOperation(overridden).pagination).toEqual(onlyOperation(bare).pagination);
      warn.mockClear();
      // `more` on the primary alone is enough.
      const op = onlyOperation(
        await parseJson(
          issueSpec({ endOfIteration: { kind: 'hasMore', path: 'more' } }, undefined, {
            '200': ok(hasMore),
            '201': ok(totalEnvelope),
          }),
        ),
      );
      expect(op.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'more' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('rejects a stop field when the primary response declares no body', async () => {
      const op = onlyOperation(
        await parseJson(
          issueSpec({ endOfIteration: { kind: 'totalCount', path: 'total' } }, undefined, {
            '200': { description: 'ok' },
          }),
        ),
      );
      rejected('endOfIteration path "total" does not resolve to a field in the response');
      // The parameters alone still make the iterator, as without the override.
      expect(op.pagination).toEqual({
        strategy: 'page',
        param: 'page',
        limitParam: 'limit',
        pageStart: 1,
        itemType: { kind: 'primitive', type: 'unknown' },
      });
    });

    it('warns and falls back when pageStart is set for a strategy other than page (the issue)', async () => {
      const { bare, overridden } = await parseBeside({ pageStart: 5 }, ['offset', 'limit']);
      rejected('pageStart 5 applies to the "page" strategy only, not to "offset"');
      expect(onlyOperation(bare).pagination).toMatchObject({ strategy: 'offset', param: 'offset' });
      expect(onlyOperation(bare).pagination).not.toHaveProperty('pageStart');
      expect(onlyOperation(overridden).pagination).toEqual(onlyOperation(bare).pagination);
      warn.mockClear();
      // The strategy the override itself names counts the same way.
      const own = onlyOperation(await parseJson(issueSpec({ strategy: 'offset', pageStart: 0 })));
      rejected('pageStart 0 applies to the "page" strategy only, not to "offset"');
      expect(own.pagination).toMatchObject({ strategy: 'page', param: 'page', pageStart: 1 });
    });

    it('warns and falls back when param and limitParam resolve to one query parameter (the issue)', async () => {
      const { bare, overridden } = await parseBeside({ param: 'limit' });
      rejected('param and limitParam both name "limit"');
      expect(onlyOperation(overridden).pagination).toEqual(onlyOperation(bare).pagination);
      warn.mockClear();
      // Whichever side the override restates, and when it names both.
      for (const extension of [{ limitParam: 'page' }, { param: 'page', limitParam: 'page' }]) {
        const op = onlyOperation(await parseJson(issueSpec(extension)));
        rejected('param and limitParam both name "page"');
        expect(op.pagination).toEqual(onlyOperation(bare).pagination);
        warn.mockClear();
      }
    });

    it("reports the problem under the config hint's name, and drops both sources together", async () => {
      const bad: PaginationHint = { endOfIteration: { kind: 'hasMore', path: 'nope' } };
      const viaHint = onlyOperation(
        await parseJson(issueSpec(undefined), { operationHints: { 'GET /pets': { pagination: bad } } }),
      );
      rejected('endOfIteration path "nope" does not resolve to a field in the response', 'operationHints pagination');
      expect(viaHint.pagination?.endOfIteration).toEqual({ kind: 'totalCount', path: 'total' });
      warn.mockClear();
      // The merged override is one override: the extension's strategy goes with the hint's stop field.
      const both = onlyOperation(
        await parseJson(issueSpec({ strategy: 'offset' }), { operationHints: { 'GET /pets': { pagination: bad } } }),
      );
      rejected(
        'endOfIteration path "nope" does not resolve to a field in the response',
        'x-pagination / operationHints pagination',
      );
      expect(both.pagination?.strategy).toBe('page');
    });

    it('leaves the response exactly as detection reads it when the stop field rejects an override that selects another array', async () => {
      // Without the rejection, `dataPath: 'result.items'` would keep the
      // envelope as a wrapper; with it, the body is unwrapped on `data` as
      // detection does, and the IR is the one parsed without the override.
      const nested = {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' } },
          result: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
            },
          },
          total: { type: 'integer' },
        },
      };
      const { bare, overridden } = await parseBeside(
        { dataPath: 'result.items', endOfIteration: { kind: 'hasMore', path: 'nope' } },
        undefined,
        jsonResponse(nested),
      );
      rejected('endOfIteration path "nope" does not resolve to a field in the response');
      expect(onlyOperation(bare).pagination?.dataPath).toBe('data');
      expect(overridden.services).toEqual(bare.services);
      expect(overridden.models).toEqual(bare.models);
      expectSound(overridden, []);
    });

    it('reports one problem per override: a dataPath that reaches no array, before the stop field', async () => {
      const { bare, overridden } = await parseBeside({
        dataPath: 'nope',
        endOfIteration: { kind: 'hasMore', path: 'nope' },
      });
      rejected('dataPath "nope" does not resolve to an array in the response');
      expect(onlyOperation(overridden).pagination).toEqual(onlyOperation(bare).pagination);
    });

    it('keeps an envelope only the override could have paged as a plain model when its stop field is rejected (#309)', async () => {
      // `p` is no name detection knows, so the override is the only source of
      // an iterator. Rejected for its stop field, it leaves the envelope as
      // nothing pages it — the wire shape, with the rejection as the one
      // warning — exactly as a `dataPath` that reaches no array does, never an
      // unwrapped envelope without an iterator.
      const cases: Array<[Record<string, unknown>, string]> = [
        [
          { strategy: 'page', param: 'p', endOfIteration: { kind: 'hasMore', path: 'nope' } },
          'endOfIteration path "nope" does not resolve to a field in the response',
        ],
        [
          { strategy: 'page', param: 'p', dataPath: 'data', endOfIteration: { kind: 'hasMore', path: 'total' } },
          'endOfIteration path "total" is not a boolean field, as kind "hasMore" requires',
        ],
      ];
      for (const [extension, problem] of cases) {
        const ir = await parseJson(issueSpec(extension, ['p']));
        const op = onlyOperation(ir);
        rejected(problem);
        expect(op.pagination).toBeUndefined();
        expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
        expect(ir.models.find((m) => m.name === 'ListPetsResponse')?.fields.map((f) => f.name)).toEqual([
          'data',
          'total',
        ]);
        expectSound(ir, []);
        warn.mockClear();
      }
    });

    it('reads a stop field behind a lone allOf member, as the IR types it, for an override and for detection (MichaelDeBoey)', async () => {
      const components = {
        schemas: {
          Flag: { type: 'boolean' },
          Count: { type: 'integer' },
          Meta: { type: 'object', properties: { total: { allOf: [{ $ref: '#/components/schemas/Count' }] } } },
        },
      };
      // `flag` and `meta.total` are names detection does not know, so
      // `total` is its own pick; each override lands on a field read through
      // the lone member — a `$ref` with a description beside it, an inline
      // boolean, a `$ref` one segment down.
      const body = {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' } },
          flag: { allOf: [{ $ref: '#/components/schemas/Flag' }], description: 'More pets' },
          inline_flag: { allOf: [{ type: 'boolean' }] },
          meta: { $ref: '#/components/schemas/Meta' },
          total: { type: 'integer' },
        },
      };
      for (const endOfIteration of [
        { kind: 'hasMore', path: 'flag' },
        { kind: 'hasMore', path: 'inline_flag' },
        { kind: 'totalCount', path: 'meta.total' },
      ] as const) {
        const ir = await parseJson(issueSpec({ endOfIteration }, undefined, jsonResponse(body), components));
        expect(onlyOperation(ir).pagination?.endOfIteration).toEqual(endOfIteration);
        expect(warn).not.toHaveBeenCalled();
        expectSound(ir, Object.keys(components.schemas));
      }
      // Detection reads the same fields: a `has_more` declared through the
      // lone member is the stop field without any override.
      const detected = {
        ...body,
        properties: { ...body.properties, has_more: { allOf: [{ $ref: '#/components/schemas/Flag' }] } },
      };
      const op = onlyOperation(await parseJson(issueSpec(undefined, undefined, jsonResponse(detected), components)));
      expect(op.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });
      expect(warn).not.toHaveBeenCalled();
    });

    describe('the override is decided once, on the primary, before any success body is read (Greptile)', () => {
      const ok = (schema: unknown) => ({ description: 'ok', content: { 'application/json': { schema } } });
      const nested = (extra: Record<string, unknown> = {}) => ({
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' } },
          result: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
            },
          },
          total: { type: 'integer' },
          ...extra,
        },
      });
      const more = { more: { type: 'boolean' } };
      const selecting = { dataPath: 'result.items', endOfIteration: { kind: 'hasMore', path: 'more' } };
      const unwrapped = { kind: 'array', items: { kind: 'primitive', type: 'string' } };

      const unknown = { kind: 'primitive', type: 'unknown' };
      const hasMore = { endOfIteration: { kind: 'hasMore', path: 'more' } };

      it.each([
        [
          'a single-entry type list naming array',
          { type: ['array'], items: { type: 'string' } },
          { kind: 'array', items: { kind: 'primitive', type: 'string' } },
        ],
        [
          'a single-entry type list naming object',
          { type: ['object'], properties: { id: { type: 'string' } } },
          { kind: 'model', name: 'ListPetsResponse' },
        ],
        [
          'a nullable type list, array first',
          { type: ['array', 'null'], items: { type: 'string' } },
          { kind: 'nullable', inner: { kind: 'array', items: { kind: 'primitive', type: 'string' } } },
        ],
        [
          'a nullable type list, null first',
          { type: ['null', 'array'], items: { type: 'string' } },
          { kind: 'nullable', inner: { kind: 'array', items: { kind: 'primitive', type: 'string' } } },
        ],
      ])(
        'keeps a 200 typed by classification as primary over a typed 201, without any override: %s (Greptile)',
        async (_label, schema, type) => {
          // Typed-ness is read the way classification reads the body, not the
          // way `schemaToTypeRef` alone types it: `type: ['array']` is an
          // array to classification, so the 200 is primary and the 201 string
          // never becomes `Operation.response`.
          const ir = await parseJson(
            issueSpec(undefined, undefined, { '200': ok(schema), '201': ok({ type: 'string' }) }),
          );
          const op = onlyOperation(ir);
          expect(warn).not.toHaveBeenCalled();
          expect(op.responseStatusCode).toBe(200);
          expect(op.response).toEqual(type);
          expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
            [200, type],
            [201, { kind: 'primitive', type: 'string' }],
          ]);
          expectSound(ir, []);
        },
      );

      it('is decided against the primary Operation.response describes: a 200 whose schema describes nothing yields to the typed 201 (Greptile)', async () => {
        const ir = await parseJson(issueSpec(hasMore, undefined, { '200': ok({}), '201': ok(nested(more)) }));
        const op = onlyOperation(ir);
        expect(warn).not.toHaveBeenCalled();
        expect(op.responseStatusCode).toBe(201);
        expect(op.response).toEqual(unwrapped);
        expect(op.pagination).toMatchObject({ dataPath: 'data', endOfIteration: { kind: 'hasMore', path: 'more' } });
        expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
          [200, unknown],
          [201, unwrapped],
        ]);
        expectSound(ir, []);
      });

      it('keeps the 200 as primary when the 201 is the one whose schema describes nothing', async () => {
        const ir = await parseJson(issueSpec(hasMore, undefined, { '200': ok(nested(more)), '201': ok({}) }));
        const op = onlyOperation(ir);
        expect(warn).not.toHaveBeenCalled();
        expect(op.responseStatusCode).toBe(200);
        expect(op.response).toEqual(unwrapped);
        expect(op.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'more' });
        expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
          [200, unwrapped],
          [201, unknown],
        ]);
      });

      it.each([
        [
          'no responses at all',
          undefined,
          { dataPath: 'data' },
          'dataPath "data" does not resolve to an array in the response',
        ],
        [
          'no 2xx',
          { '404': { description: 'missing' } },
          { endOfIteration: { kind: 'hasMore', path: 'more' } },
          'endOfIteration path "more" does not resolve to a field in the response',
        ],
        [
          'a 204 primary',
          { '204': { description: 'no content' } },
          { dataPath: 'data' },
          'dataPath "data" does not resolve to an array in the response',
        ],
      ])(
        'rejects an override that asks of the response when there is %s',
        async (_label, responses, fields, problem) => {
          // `p` alone: the override is the only possible source of an iterator.
          const op = onlyOperation(
            await parseJson(
              petsSpec({
                parameters: [query('p')],
                responses,
                'x-pagination': { strategy: 'page', param: 'p', ...fields },
              }),
            ),
          );
          rejected(problem);
          expect(op.pagination).toBeUndefined();
          expect(op.response).toEqual(unknown);
        },
      );

      it("a rejection on the primary reaches every 2xx: the 201 unwraps on data as detection does, not on the override's wrapper", async () => {
        // Only the 201 declares `more`; the 200 is primary and rejects the
        // override, so the 201 is read exactly as detection reads it.
        const responses = { '200': ok(nested()), '201': ok(nested(more)) };
        const { bare, overridden } = await parseBeside(selecting, undefined, responses);
        rejected('endOfIteration path "more" does not resolve to a field in the response');
        const op = onlyOperation(overridden);
        expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
          [200, unwrapped],
          [201, unwrapped],
        ]);
        expect(overridden.services).toEqual(bare.services);
        expect(overridden.models).toEqual(bare.models);
        expectSound(overridden, []);
      });

      it('an acceptance on the primary applies to every 2xx body the dataPath reaches an array in', async () => {
        const responses = { '200': ok(nested(more)), '201': ok(nested(more)) };
        const ir = await parseJson(issueSpec(selecting, undefined, responses));
        const op = onlyOperation(ir);
        expect(warn).not.toHaveBeenCalled();
        expect(op.pagination).toMatchObject({
          dataPath: 'result.items',
          itemType: { kind: 'model', name: 'ListPetsResponseResultItem' },
          endOfIteration: { kind: 'hasMore', path: 'more' },
        });
        // Both bodies keep the wrapper the override iterates.
        expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
          [200, { kind: 'model', name: 'ListPetsResponse' }],
          [201, { kind: 'model', name: 'ListPetsResponse' }],
        ]);
        expectSound(ir, []);
      });

      it('an override only a secondary 2xx could satisfy is rejected, since only the primary decides', async () => {
        const responses = { '200': ok(totalEnvelope), '201': ok(nested(more)) };
        const { bare, overridden } = await parseBeside(selecting, undefined, responses);
        rejected('dataPath "result.items" does not resolve to an array in the response');
        const op = onlyOperation(overridden);
        expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
          [200, unwrapped],
          [201, unwrapped],
        ]);
        expect(overridden.services).toEqual(bare.services);
        expect(overridden.models).toEqual(bare.models);
      });
    });

    it('checks only the shape under strategy none: there is no iterator for the other fields to serve', async () => {
      const op = onlyOperation(
        await parseJson(
          issueSpec({ strategy: 'none', pageStart: 3, endOfIteration: { kind: 'hasMore', path: 'nope' } }),
        ),
      );
      expect(op.pagination).toBeUndefined();
      expect(op.response.kind).toBe('model');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('the stop field of a wrapper kept under an explicit dataPath (#308)', () => {
    // The issue's shapes: `Pet`, `PetList: { data: Pet[], has_more }`, and
    // `GET /pets?page&limit` (plain integers) returning the list under
    // `x-pagination: { dataPath }`. The stop field belongs to whatever wrapper
    // the override iterates — a component or an inline body detection did not
    // recognize — not only to an envelope detection recognized.
    const Pet = { type: 'object', properties: { name: { type: 'string' } } };
    const petArray = { type: 'array', items: { $ref: '#/components/schemas/Pet' } };
    const PetList = { type: 'object', properties: { data: petArray, has_more: { type: 'boolean' } } };
    const PetListRef = { $ref: '#/components/schemas/PetList' };
    const nested = { type: 'object', properties: { items: petArray } };
    const page = { strategy: 'page', param: 'page', limitParam: 'limit', pageStart: 1 };
    const listOp = (
      schema: unknown,
      pagination: Record<string, unknown>,
      schemas: Record<string, unknown> = {},
      extra: Record<string, unknown> = {},
    ) =>
      petsSpec(
        {
          parameters: [query('page'), query('limit')],
          responses: jsonResponse(schema),
          'x-pagination': pagination,
          ...extra,
        },
        { schemas: { Pet, PetList, ...schemas } },
      );

    /** The issue's projection of the pagination entry: item and companion names in place of types. */
    const projection = (op: Operation) => {
      const { envelopeFields, itemType, ...rest } = op.pagination!;
      return {
        ...rest,
        itemType: itemType.kind === 'model' ? itemType.name : itemType.kind,
        ...(envelopeFields && { envelopeFields: envelopeFields.map((f) => f.name) }),
      };
    };

    /** Every model the operation or a model field references exists, and no non-component model is orphaned. */
    const expectModelsConsistent = (ir: ApiSpec, op: Operation, components: string[]) => {
      const names = new Set(ir.models.map((m) => m.name));
      const refs = [op.response, op.pagination?.itemType, ...(op.pagination?.envelopeFields ?? []).map((f) => f.type)];
      const referenced = new Set<string>();
      for (const ref of refs) if (ref) for (const name of modelNamesIn(ref)) referenced.add(name);
      for (const model of ir.models)
        for (const field of model.fields) for (const name of modelNamesIn(field.type)) referenced.add(name);
      expect([...referenced].filter((name) => !names.has(name))).toEqual([]);
      expect([...names].filter((name) => !components.includes(name) && !referenced.has(name))).toEqual([]);
    };

    it('reads the stop field of a $ref list response (the issue repro)', async () => {
      const ir = await parseJson(listOp(PetListRef, { dataPath: 'data' }));
      const op = onlyOperation(ir);
      expect(op.response).toEqual({ kind: 'model', name: 'PetList' });
      expect(projection(op)).toEqual({
        ...page,
        dataPath: 'data',
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
        itemType: 'Pet',
      });
      expectModelsConsistent(ir, op, ['Pet', 'PetList']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('unwraps the same body written inline, reading the stop field beside the data array', async () => {
      const op = onlyOperation(await parseJson(listOp(PetList, { dataPath: 'data' })));
      expect(op.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'Pet' } });
      expect(projection(op)).toEqual({
        ...page,
        dataPath: 'data',
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
        itemType: 'Pet',
        envelopeFields: ['has_more'],
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads the stop field of an inline wrapper detection did not recognize (the issue repro)', async () => {
      // No top-level array beside `total_pages`, so the body is not a list envelope.
      const body = { type: 'object', properties: { result: nested, total_pages: { type: 'integer' } } };
      const ir = await parseJson(listOp(body, { dataPath: 'result.items' }));
      const op = onlyOperation(ir);
      expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      expect(projection(op)).toEqual({
        ...page,
        dataPath: 'result.items',
        endOfIteration: { kind: 'totalPages', path: 'total_pages' },
        itemType: 'Pet',
      });
      expectModelsConsistent(ir, op, ['Pet', 'PetList']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads it the same way when a data array beside makes the body a recognized envelope', async () => {
      const body = {
        type: 'object',
        properties: { data: petArray, result: nested, total_pages: { type: 'integer' } },
      };
      const op = onlyOperation(await parseJson(listOp(body, { dataPath: 'result.items' })));
      expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      expect(projection(op)).toEqual({
        ...page,
        dataPath: 'result.items',
        endOfIteration: { kind: 'totalPages', path: 'total_pages' },
        itemType: 'Pet',
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads it one level down inside a $ref wrapper’s pagination companion, and beside its nested array', async () => {
      const PagedList = {
        type: 'object',
        properties: { pets: petArray, pagination: { type: 'object', properties: { totalPages: { type: 'integer' } } } },
      };
      const down = onlyOperation(
        await parseJson(listOp({ $ref: '#/components/schemas/PagedList' }, { dataPath: 'pets' }, { PagedList })),
      );
      expect(down.pagination).toMatchObject({
        dataPath: 'pets',
        itemType: { kind: 'model', name: 'Pet' },
        endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
      });

      // The full path is excluded, not its root: `pagination.has_more` stays
      // visible beside `pagination.items`, and the array is never a stop field.
      const NestedList = {
        type: 'object',
        properties: { pagination: { type: 'object', properties: { items: petArray, has_more: { type: 'boolean' } } } },
      };
      const beside = onlyOperation(
        await parseJson(
          listOp({ $ref: '#/components/schemas/NestedList' }, { dataPath: 'pagination.items' }, { NestedList }),
        ),
      );
      expect(beside.pagination).toMatchObject({
        dataPath: 'pagination.items',
        itemType: { kind: 'model', name: 'Pet' },
        endOfIteration: { kind: 'hasMore', path: 'pagination.has_more' },
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads it from a $ref wrapper’s allOf base, and through a nullable wrapper around the body', async () => {
      const Base = { type: 'object', properties: { has_more: { type: 'boolean' } } };
      const PetPage = {
        allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { data: petArray } }],
      };
      const fromBase = onlyOperation(
        await parseJson(listOp({ $ref: '#/components/schemas/PetPage' }, { dataPath: 'data' }, { Base, PetPage })),
      );
      expect(fromBase.pagination).toMatchObject({
        dataPath: 'data',
        itemType: { kind: 'model', name: 'Pet' },
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
      });

      const nullable = onlyOperation(
        await parseJson(listOp({ oneOf: [PetListRef, { type: 'null' }] }, { dataPath: 'data' })),
      );
      expect(nullable.pagination).toMatchObject({
        dataPath: 'data',
        itemType: { kind: 'model', name: 'Pet' },
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads it through the config hint, and lets the override name its own stop field', async () => {
      const viaHint = onlyOperation(
        await parseJson(
          petsSpec(
            { parameters: [query('page'), query('limit')], responses: jsonResponse(PetListRef) },
            { schemas: { Pet, PetList } },
          ),
          { operationHints: { 'GET /pets': { pagination: { dataPath: 'data' } } } },
        ),
      );
      expect(viaHint.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });

      // The component declares the `meta.total` the override names beside
      // the `has_more` detection reads (#310: a path the wrapper lacks is
      // rejected, not kept), so the override's own choice is visible.
      const PetListWithMeta = {
        ...PetList,
        properties: {
          ...PetList.properties,
          meta: { type: 'object', properties: { total: { type: 'integer' } } },
        },
      };
      const own = onlyOperation(
        await parseJson(
          listOp(
            { $ref: '#/components/schemas/PetListWithMeta' },
            { dataPath: 'data', endOfIteration: { kind: 'totalCount', path: 'meta.total' } },
            { PetListWithMeta },
          ),
        ),
      );
      expect(own.pagination?.endOfIteration).toEqual({ kind: 'totalCount', path: 'meta.total' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads nothing under strategy none, which leaves no iterator to stop', async () => {
      const op = onlyOperation(await parseJson(listOp(PetListRef, { strategy: 'none', dataPath: 'data' })));
      expect(op.response).toEqual({ kind: 'model', name: 'PetList' });
      expect(op.pagination).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('leaves endOfIteration unset when the kept wrapper declares nothing recognizable', async () => {
      const Plain = { type: 'object', properties: { data: petArray, count: { type: 'integer' } } };
      const op = onlyOperation(
        await parseJson(listOp({ $ref: '#/components/schemas/Plain' }, { dataPath: 'data' }, { Plain })),
      );
      expect(op.pagination).toMatchObject({ dataPath: 'data', itemType: { kind: 'model', name: 'Pet' } });
      expect(op.pagination?.endOfIteration).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads it inside a nullable allOf member: a $ref, an inline object, a nested allOf, a $ref chain (Greptile)', async () => {
      // The member that carries the stop field is nullable in every spelling
      // the dataPath walk looks through, so the reader must look through it
      // too; `data` always comes from the plain member beside it.
      const Base = { type: 'object', properties: { has_more: { type: 'boolean' } } };
      const nullOf = (variant: unknown) => ({ oneOf: [variant, { type: 'null' }] });
      const baseRef = { $ref: '#/components/schemas/Base' };
      const NullableLink = nullOf(baseRef);
      const Hop = { $ref: '#/components/schemas/NullableLink' };
      const members: Record<string, unknown> = {
        nullableRef: nullOf(baseRef),
        nullableInline: nullOf({ type: 'object', properties: { has_more: { type: 'boolean' } } }),
        nullableTypeList: { type: ['object', 'null'], properties: { has_more: { type: 'boolean' } } },
        nestedAllOf: nullOf({ allOf: [baseRef, { type: 'object', properties: { page: { type: 'integer' } } }] }),
        refChain: { $ref: '#/components/schemas/Hop' },
      };
      const expected = {
        dataPath: 'data',
        itemType: { kind: 'model', name: 'Pet' },
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
      };
      // The wrapper's model declares the field the iterator stops on: a
      // nullable member applies as its one non-null variant for the model as
      // for the stop field, as a component and as an inline body (MichaelDeBoey).
      const fieldsOf = (ir: ApiSpec, model: string) =>
        ir.models.find((m) => m.name === model)?.fields.map((f) => f.name);
      for (const [label, member] of Object.entries(members)) {
        const PetPage = { allOf: [member, { type: 'object', properties: { data: petArray } }] };
        const schemas = { Base, NullableLink, Hop, PetPage };
        const fields = label === 'nestedAllOf' ? ['has_more', 'page', 'data'] : ['has_more', 'data'];
        // Greptile's case: the wrapper is a referenced component.
        const referencedIr = await parseJson(
          listOp({ $ref: '#/components/schemas/PetPage' }, { dataPath: 'data' }, schemas),
        );
        const referenced = onlyOperation(referencedIr);
        expect(referenced.pagination, `${label} ($ref wrapper)`).toMatchObject(expected);
        expect(fieldsOf(referencedIr, 'PetPage'), `${label} ($ref wrapper model)`).toEqual(fields);
        // The same wrapper written inline is not a recognized envelope — the
        // nullable member declares no properties of its own — and is read alike.
        const inlineIr = await parseJson(listOp(PetPage, { dataPath: 'data' }, schemas));
        const inline = onlyOperation(inlineIr);
        expect(inline.pagination, `${label} (inline wrapper)`).toMatchObject(expected);
        if (label === 'nullableTypeList') {
          // A type-list member declares `has_more` as a property of its own,
          // so written inline the body is a recognized envelope and is
          // unwrapped on `data`, the stop field among its companions.
          expect(inline.response, label).toEqual({ kind: 'array', items: { kind: 'model', name: 'Pet' } });
          expect(
            inline.pagination?.envelopeFields?.map((f) => f.name),
            label,
          ).toEqual(['has_more']);
        } else {
          expect(inline.response, `${label} (inline wrapper)`).toEqual({ kind: 'model', name: 'ListPetsResponse' });
          expect(fieldsOf(inlineIr, 'ListPetsResponse'), `${label} (inline wrapper model)`).toEqual(fields);
        }
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('gives a nullable member’s fields to a recognized envelope and its stop field, with no override (MichaelDeBoey)', async () => {
      const nullOf = (variant: unknown) => ({ oneOf: [variant, { type: 'null' }] });
      const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
      const Meta = { type: 'object', properties: { trace_id: { type: 'string' } } };
      const Base = { type: 'object', properties: { has_more: { type: 'boolean' } } };
      const detected = (schema: unknown) =>
        petsSpec(
          { parameters: [query('page'), query('limit')], responses: jsonResponse(schema) },
          { schemas: { Pet, Meta, Base } },
        );
      // `Meta`'s `trace_id` is a companion of the envelope beside it.
      const withMeta = {
        allOf: [nullOf(ref('Meta')), { type: 'object', properties: { data: petArray, has_more: { type: 'boolean' } } }],
      };
      expect(projection(onlyOperation(await parseJson(detected(withMeta))))).toEqual({
        ...page,
        dataPath: 'data',
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
        itemType: 'Pet',
        envelopeFields: ['trace_id', 'has_more'],
      });
      // `Base`'s `has_more` ends the iteration of an envelope whose own
      // companion only says it is one.
      const meta = { type: 'object', properties: { page: { type: 'integer' } } };
      const fromBase = { allOf: [nullOf(ref('Base')), { type: 'object', properties: { data: petArray, meta } }] };
      expect(projection(onlyOperation(await parseJson(detected(fromBase))))).toEqual({
        ...page,
        dataPath: 'data',
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
        itemType: 'Pet',
        envelopeFields: ['has_more', 'meta'],
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps a stop field’s type against a typeless declaration of it, in the model and in the read alike (Greptile)', async () => {
      const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
      const boolean = { type: 'boolean' };
      const doc = { description: 'More pages' };
      const member = (has_more: unknown) => ({ type: 'object', properties: { has_more } });
      // Greptile's case: the component's own boolean beside its `allOf`, folded
      // in first, against a member's description; then the reverse order; then
      // a typeless override written in the wrapper beside the data array.
      const cases: Record<string, { Base: unknown; beside: Record<string, unknown> }> = {
        ownTyped: { Base: { properties: { has_more: boolean }, allOf: [member(doc)] }, beside: {} },
        ownTypeless: { Base: { properties: { has_more: doc }, allOf: [member(boolean)] }, beside: {} },
        siblingOverride: { Base: member(boolean), beside: { has_more: doc } },
      };
      const expectedField = {
        name: 'has_more',
        type: { kind: 'primitive', type: 'boolean' },
        description: 'More pages',
      };
      for (const [label, { Base, beside }] of Object.entries(cases)) {
        const PetPage = { allOf: [ref('Base'), { type: 'object', properties: { data: petArray, ...beside } }] };
        const schemas = { Base, PetPage };
        const fieldOf = (ir: ApiSpec, model: string) =>
          ir.models.find((m) => m.name === model)?.fields.find((f) => f.name === 'has_more');
        for (const [kind, body, model] of [
          ['$ref wrapper', ref('PetPage'), 'PetPage'],
          ['inline wrapper', PetPage, 'ListPetsResponse'],
        ] as const) {
          const ir = await parseJson(listOp(body, { dataPath: 'data' }, schemas));
          const op = onlyOperation(ir);
          expect(op.pagination?.endOfIteration, `${label} (${kind})`).toEqual({ kind: 'hasMore', path: 'has_more' });
          // The field as the wrapper model declares it — or, when the typeless
          // declaration written beside `data` makes the inline body a recognized
          // envelope, as the unwrapped envelope's companion.
          const field = op.pagination?.envelopeFields?.find((f) => f.name === 'has_more') ?? fieldOf(ir, model);
          expect(field, `${label} (${kind} model)`).toMatchObject(expectedField);
          expect(fieldOf(ir, 'Base'), `${label} (${kind}, Base)`).toMatchObject({
            ...expectedField,
            ...(label === 'siblingOverride' && { description: undefined }),
          });
        }
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('names a stop field the wrapper model declares when two members declare the parent object (Greptile)', async () => {
      // Two `allOf` members declare `result`: the first with the array, the
      // second with the stop field. The model's `result` conjoins both, as the
      // stop-field read does, so `result.total_pages` is a field it has.
      const withItems = { type: 'object', properties: { result: { type: 'object', properties: { items: petArray } } } };
      const withTotal = {
        type: 'object',
        properties: { result: { type: 'object', properties: { total_pages: { type: 'integer' } } } },
      };
      const expected = {
        dataPath: 'result.items',
        itemType: { kind: 'model', name: 'Pet' },
        endOfIteration: { kind: 'totalPages', path: 'result.total_pages' },
      };
      for (const members of [
        [withItems, withTotal],
        [withTotal, withItems],
      ]) {
        const PetPage = { allOf: members };
        const schemas = { PetPage };
        const resultFields = (ir: ApiSpec, model: string) =>
          ir.models.find((m) => m.name === model)?.fields.map((f) => f.name);
        const referencedIr = await parseJson(
          listOp({ $ref: '#/components/schemas/PetPage' }, { dataPath: 'result.items' }, schemas),
        );
        const referenced = onlyOperation(referencedIr);
        expect(referenced.pagination, '$ref wrapper').toMatchObject(expected);
        expect(resultFields(referencedIr, 'PetPage'), '$ref wrapper').toEqual(['result']);
        expect(resultFields(referencedIr, 'PetPageResult')?.sort(), '$ref wrapper').toEqual(['items', 'total_pages']);
        const inlineIr = await parseJson(listOp(PetPage, { dataPath: 'result.items' }, schemas));
        const inline = onlyOperation(inlineIr);
        expect(inline.pagination, 'inline wrapper').toMatchObject(expected);
        expect(resultFields(inlineIr, 'ListPetsResponse'), 'inline wrapper').toEqual(['result']);
        expect(resultFields(inlineIr, 'ListPetsResponseResult')?.sort(), 'inline wrapper').toEqual([
          'items',
          'total_pages',
        ]);
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads the stop field beside a nested array under a parent of any name, before the top level (MichaelDeBoey)', async () => {
      const boolean = { type: 'boolean' };
      const nested = (fields: Record<string, unknown>) => ({
        type: 'object',
        properties: { items: petArray, ...fields },
      });
      const cases: Array<[string, Record<string, unknown>, { kind: string; path: string }]> = [
        [
          'result.items',
          { result: nested({ total_pages: { type: 'integer' } }) },
          { kind: 'totalPages', path: 'result.total_pages' },
        ],
        ['data.items', { data: nested({ has_more: boolean }) }, { kind: 'hasMore', path: 'data.has_more' }],
        [
          'data.page.items',
          { data: { type: 'object', properties: { page: nested({ has_more: boolean }) } } },
          { kind: 'hasMore', path: 'data.page.has_more' },
        ],
        // Beside the array first within one kind; the kind order still decides across levels.
        [
          'result.items',
          { result: nested({ has_more: boolean }), has_more: boolean },
          { kind: 'hasMore', path: 'result.has_more' },
        ],
        [
          'result.items',
          { result: nested({ total: { type: 'integer' } }), has_more: boolean },
          { kind: 'hasMore', path: 'has_more' },
        ],
      ];
      for (const [dataPath, properties, endOfIteration] of cases) {
        const op = onlyOperation(await parseJson(listOp({ type: 'object', properties }, { dataPath })));
        expect(op.pagination, `${dataPath} beside ${Object.keys(properties).join(',')}`).toMatchObject({
          dataPath,
          itemType: { kind: 'model', name: 'Pet' },
          endOfIteration,
        });
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads the stop field beside every object the path passes through, nearest the array first (#433)', async () => {
      // The issue's three bodies, written inline and as a `$ref` to a
      // component of the same shape.
      const object = (properties: Record<string, unknown>) => ({ type: 'object', properties });
      const total_pages = { type: 'integer' };
      const bodies: Array<[string, string, Record<string, unknown>, string]> = [
        [
          'grandparent',
          'result.page.items',
          { result: object({ page: object({ items: petArray }), total_pages }) },
          'result.total_pages',
        ],
        ['parent', 'result.items', { result: object({ items: petArray, total_pages }) }, 'result.total_pages'],
        [
          'top',
          'result.page.items',
          { result: object({ page: object({ items: petArray }) }), total_pages },
          'total_pages',
        ],
      ];
      for (const [label, dataPath, properties, path] of bodies) {
        const expected = {
          dataPath,
          itemType: { kind: 'model', name: 'Pet' },
          endOfIteration: { kind: 'totalPages', path },
        };
        const inline = onlyOperation(await parseJson(listOp(object(properties), { dataPath })));
        expect(inline.pagination, `${label} (inline)`).toMatchObject(expected);
        const Envelope = object(properties);
        const referenced = onlyOperation(
          await parseJson(listOp({ $ref: '#/components/schemas/Envelope' }, { dataPath }, { Envelope })),
        );
        expect(referenced.pagination, `${label} ($ref)`).toMatchObject(expected);
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it("ends the walk where a component reaches itself through a nullable allOf member (Greptile's cycle)", async () => {
      // `Base.allOf` holds a nullable reference back to `Base`; beside it
      // `{ data, has_more }` makes the body a recognized envelope, so the
      // cycle is met with and without an override, and as a kept wrapper.
      const nullOf = (variant: unknown) => ({ oneOf: [variant, { type: 'null' }] });
      const baseRef = { $ref: '#/components/schemas/Base' };
      const Base = { allOf: [nullOf(baseRef)] };
      const PetPage = {
        allOf: [nullOf(baseRef), { type: 'object', properties: { data: petArray, has_more: { type: 'boolean' } } }],
      };
      const schemas = { Base, PetPage };
      const unwrapped = {
        ...page,
        dataPath: 'data',
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
        itemType: 'Pet',
        envelopeFields: ['has_more'],
      };
      const detected = onlyOperation(
        await parseJson(
          petsSpec(
            { parameters: [query('page'), query('limit')], responses: jsonResponse(PetPage) },
            { schemas: { Pet, ...schemas } },
          ),
        ),
      );
      expect(projection(detected)).toEqual(unwrapped);
      const restated = onlyOperation(await parseJson(listOp(PetPage, { dataPath: 'data' }, schemas)));
      expect(projection(restated)).toEqual(unwrapped);
      const kept = onlyOperation(
        await parseJson(listOp({ $ref: '#/components/schemas/PetPage' }, { dataPath: 'data' }, schemas)),
      );
      expect(kept.response).toEqual({ kind: 'model', name: 'PetPage' });
      expect(projection(kept)).toEqual({
        ...page,
        dataPath: 'data',
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
        itemType: 'Pet',
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads the stop field once through a direct self-reference, a two-schema cycle, and an inline object that loops (Greptile)', async () => {
      // The stop field lives in the cyclic component; the wrapper beside
      // `data` is kept under the override, written as a `$ref` and inline.
      const nullOf = (variant: unknown) => ({ oneOf: [variant, { type: 'null' }] });
      const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
      const hasMore = { type: 'object', properties: { has_more: { type: 'boolean' } } };
      const cycles: Record<string, Record<string, unknown>> = {
        directSelf: { Base: { allOf: [ref('Base'), hasMore] } },
        nullableSelf: { Base: { allOf: [nullOf(ref('Base')), hasMore] } },
        twoSchemas: {
          Base: { allOf: [nullOf(ref('Other')), hasMore] },
          Other: { allOf: [nullOf(ref('Base')), { type: 'object', properties: { page: { type: 'integer' } } }] },
        },
        inlineObject: {
          Base: { type: 'object', properties: { has_more: { type: 'boolean' } }, allOf: [nullOf(ref('Base'))] },
        },
      };
      const expected = {
        dataPath: 'data',
        itemType: { kind: 'model', name: 'Pet' },
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
      };
      for (const [label, components] of Object.entries(cycles)) {
        const PetPage = { allOf: [nullOf(ref('Base')), { type: 'object', properties: { data: petArray } }] };
        const schemas = { ...components, PetPage };
        const referenced = onlyOperation(await parseJson(listOp(ref('PetPage'), { dataPath: 'data' }, schemas)));
        expect(referenced.pagination, `${label} ($ref wrapper)`).toMatchObject(expected);
        const inline = onlyOperation(await parseJson(listOp(PetPage, { dataPath: 'data' }, schemas)));
        expect(inline.pagination, `${label} (inline wrapper)`).toMatchObject(expected);
      }
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('operationHints[...].pagination from ParseOptions', () => {
    it('applies the hint keyed by "METHOD /path"', async () => {
      const op = onlyOperation(
        await parseJson(petsSpec({}), { operationHints: { 'GET /pets': { pagination: { strategy: 'offset' } } } }),
      );
      expect(op.pagination?.strategy).toBe('offset');
    });

    it('wins over x-pagination field by field', async () => {
      // The companion declares the `total` the hint names beside the
      // `totalPages` detection prefers (#310: a path the response lacks is
      // rejected, not kept), so the hint's choice is visible.
      const withTotal = envelope({
        pagination: {
          type: 'object',
          properties: { page: { type: 'integer' }, totalPages: { type: 'integer' }, total: { type: 'integer' } },
          required: ['page', 'totalPages', 'total'],
        },
      });
      const op = onlyOperation(
        await parseJson(
          petsSpec({ responses: jsonResponse(withTotal), 'x-pagination': { strategy: 'offset', dataPath: 'pets' } }),
          {
            operationHints: {
              'GET /pets': {
                pagination: { strategy: 'page', endOfIteration: { kind: 'totalCount', path: 'pagination.total' } },
              },
            },
          },
        ),
      );
      expect(op.pagination).toMatchObject({
        strategy: 'page',
        dataPath: 'pets',
        endOfIteration: { kind: 'totalCount', path: 'pagination.total' },
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('ignores hints for other operations and hints without a pagination entry', async () => {
      const op = onlyOperation(
        await parseJson(petsSpec({}), {
          operationHints: {
            'POST /pets': { pagination: { strategy: 'none' } },
            'GET /pets': { name: 'list_all_pets' },
          },
        }),
      );
      expect(op.pagination?.strategy).toBe('page');
      expect(warn).not.toHaveBeenCalled();
    });

    it('reports an invalid hint under its own name and keeps a valid extension', async () => {
      // A config file is not type-checked at runtime, so a typo reaches the parser as-is.
      const bogus = { strategy: 'bogus' } as unknown as PaginationHint;
      const op = onlyOperation(
        await parseJson(petsSpec({ 'x-pagination': { strategy: 'offset' } }), {
          operationHints: { 'GET /pets': { pagination: bogus } },
        }),
      );
      expect(op.pagination?.strategy).toBe('offset');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('operationHints pagination on listPets: unknown strategy "bogus"'),
      );
    });
  });
});
