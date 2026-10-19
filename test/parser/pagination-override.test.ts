import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Operation } from '../../src/ir/types.js';
import type { PaginationHint } from '../../src/ir/operation-hints.js';

/**
 * End-to-end coverage for #221: a page-numbered list comes out as the `page`
 * strategy with the field that ends the iteration, and the operation's
 * `x-pagination` extension or an `operationHints` entry can override the
 * guess — config hint over extension over detection.
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

  const petsSpec = (operation: Record<string, unknown>, components?: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: pageParams,
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: totalPagesEnvelope } } } },
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
      dataPath: 'pets',
      itemType: { kind: 'primitive', type: 'string' },
      envelopeFields: [{ name: 'pagination', type: { kind: 'model', name: 'Pagination' }, required: true }],
      endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('detects a top-level has_more boolean as the end of iteration', async () => {
    const schema = envelope({ has_more: { type: 'boolean' } });
    const op = onlyOperation(
      await parseJson(
        petsSpec({ responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } } }),
      ),
    );
    expect(op.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });
  });

  it('reads the end-of-iteration field through a $ref companion', async () => {
    const schema = envelope({ meta: { $ref: '#/components/schemas/Meta' } });
    const components = { schemas: { Meta: { type: 'object', properties: { total_pages: { type: 'integer' } } } } };
    const op = onlyOperation(
      await parseJson(
        petsSpec(
          { responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } } },
          components,
        ),
      ),
    );
    expect(op.pagination?.endOfIteration).toEqual({ kind: 'totalPages', path: 'meta.total_pages' });
  });

  it('leaves endOfIteration unset when the envelope declares nothing recognizable', async () => {
    const schema = envelope({ list_metadata: { type: 'object', properties: { after: { type: 'string' } } } });
    const op = onlyOperation(
      await parseJson(
        petsSpec({ responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } } }),
      ),
    );
    expect(op.pagination).toBeDefined();
    expect(op.pagination?.endOfIteration).toBeUndefined();
  });

  it('keeps a page parameter without a page-size parameter unpaginated unless overridden', async () => {
    const bare = { parameters: [query('page')], responses: { '200': { description: 'ok' } } };
    expect(onlyOperation(await parseJson(petsSpec(bare))).pagination).toBeUndefined();

    const overridden = { ...bare, 'x-pagination': { strategy: 'page', param: 'page' } };
    expect(onlyOperation(await parseJson(petsSpec(overridden))).pagination).toEqual({
      strategy: 'page',
      param: 'page',
      itemType: { kind: 'primitive', type: 'unknown' },
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

    it('disables pagination with strategy none', async () => {
      const op = onlyOperation(await parseJson(petsSpec({ 'x-pagination': { strategy: 'none' } })));
      expect(op.pagination).toBeUndefined();
      // The response is still the list envelope's data array.
      expect(op.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
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
