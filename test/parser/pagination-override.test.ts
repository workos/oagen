import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Operation } from '../../src/ir/types.js';
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

  it('reads the end-of-iteration field through a $ref companion', async () => {
    const schema = envelope({ meta: { $ref: '#/components/schemas/Meta' } });
    const components = { schemas: { Meta: { type: 'object', properties: { total_pages: { type: 'integer' } } } } };
    const op = onlyOperation(await parseJson(petsSpec({ responses: jsonResponse(schema) }, components)));
    expect(op.pagination?.endOfIteration).toEqual({ kind: 'totalPages', path: 'meta.total_pages' });
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
      const op = onlyOperation(
        await parseJson(
          petsSpec({
            'x-pagination': { dataPath: 'pets', endOfIteration: { kind: 'hasMore', path: 'pagination.more' } },
          }),
        ),
      );
      expect(op.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'pagination.more' });
      expect(op.pagination?.strategy).toBe('page');
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
        // The 202's own model is kept as well, so `successResponses` never dangles.
        const job = op.successResponses?.find((r) => r.statusCode === 202)?.type;
        expect(job?.kind).toBe('model');
        if (job?.kind === 'model') expect(ir.models.some((m) => m.name === job.name)).toBe(true);
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
  });

  describe('operationHints[...].pagination from ParseOptions', () => {
    it('applies the hint keyed by "METHOD /path"', async () => {
      const op = onlyOperation(
        await parseJson(petsSpec({}), { operationHints: { 'GET /pets': { pagination: { strategy: 'offset' } } } }),
      );
      expect(op.pagination?.strategy).toBe('offset');
    });

    it('wins over x-pagination field by field', async () => {
      const op = onlyOperation(
        await parseJson(petsSpec({ 'x-pagination': { strategy: 'offset', dataPath: 'pets' } }), {
          operationHints: {
            'GET /pets': {
              pagination: { strategy: 'page', endOfIteration: { kind: 'totalCount', path: 'pagination.total' } },
            },
          },
        }),
      );
      expect(op.pagination).toMatchObject({
        strategy: 'page',
        dataPath: 'pets',
        endOfIteration: { kind: 'totalCount', path: 'pagination.total' },
      });
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
