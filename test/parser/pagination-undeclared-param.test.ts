import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { collectEnumRefs, collectModelRefs, collectOperationTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, Operation } from '../../src/ir/types.js';

/**
 * Issue #309: an iterator is driven only by a query parameter the operation
 * declares. A recognized list envelope on an operation whose parameters
 * yield no strategy — a `page` or `offset` parameter without a page size, a
 * page size alone, no paging parameter at all — used to get `strategy:
 * 'cursor'` on an invented `after`, with the envelope's `total_pages` as a
 * stop on an iterator that counts no pages. Now it gets no `pagination`: the
 * envelope is kept as a plain response model, as `strategy: 'none'` keeps
 * it, with one warning naming what is missing. An override naming a declared
 * parameter still creates the iterator, built around that envelope.
 */
describe('a list envelope on an operation without a paging parameter (issue #309)', () => {
  let tmpDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-undeclared-param-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  const query = (name: string, type = 'integer') => ({ name, in: 'query', schema: { type } });

  /** `GET /pets` (`listPets`) with `parameters`, returning `schema` at 200, plus any other operation fields. */
  const petsSpec = (parameters: unknown[], schema: unknown, operation: Record<string, unknown> = {}) => ({
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters,
          ...operation,
          responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
        },
      },
    },
  });

  /** The issue's envelope: `{ data: string[], total_pages: integer }`. */
  const totalPagesEnvelope = {
    type: 'object',
    properties: { data: { type: 'array', items: { type: 'string' } }, total_pages: { type: 'integer' } },
  };

  const onlyOperation = (ir: ApiSpec): Operation => {
    const operations = ir.services.flatMap((s) => s.operations);
    expect(operations).toHaveLength(1);
    return operations[0];
  };

  const warnings = (): string[] => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  /** Every model and enum reference, from operations and model fields alike, resolves, and every model is referenced. */
  function expectSound(ir: ApiSpec): void {
    const modelNames = new Set(ir.models.map((m) => m.name));
    const enumNames = new Set(ir.enums.map((e) => e.name));
    const referenced = new Set<string>();
    const refs = [
      ...ir.services.flatMap((s) => s.operations).flatMap((op) => collectOperationTypeRefs(op)),
      ...ir.models.flatMap((m) => m.fields.map((f) => f.type)),
    ];
    const unresolved: string[] = [];
    for (const ref of refs) {
      for (const name of collectModelRefs(ref)) {
        referenced.add(name);
        if (!modelNames.has(name)) unresolved.push(name);
      }
      for (const name of collectEnumRefs(ref)) if (!enumNames.has(name)) unresolved.push(name);
    }
    expect(unresolved).toEqual([]);
    expect([...modelNames].filter((name) => !referenced.has(name))).toEqual([]);
  }

  /** The operation has no iterator, and its response is the envelope as a plain model with exactly `fields`. */
  function expectEnvelopeKept(ir: ApiSpec, fields: string[]): Operation {
    const op = onlyOperation(ir);
    expect(op.pagination).toBeUndefined();
    expect(op.response.kind).toBe('model');
    const wrapper = ir.models.find((m) => op.response.kind === 'model' && m.name === op.response.name);
    expect(wrapper?.fields.map((f) => f.name)).toEqual(fields);
    expectSound(ir);
    return op;
  }

  const warningFor = (reason: string) =>
    `[oagen] Warning: listPets returns a list envelope but no query parameter drives an iterator (${reason}) — ` +
    'keeping the body as a plain response model with no pagination; declare the parameter, set x-pagination / ' +
    'operationHints pagination naming a query parameter the operation declares, or set strategy "none" to accept ' +
    'the plain model';

  it('the issue repro: a page parameter without a page size gets no iterator, not a cursor one on an undeclared after', async () => {
    const ir = await parseJson(petsSpec([query('page')], totalPagesEnvelope));
    const op = expectEnvelopeKept(ir, ['data', 'total_pages']);
    expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
    expect(op.queryParams.map((p) => p.name)).toEqual(['page']);
    const wrapper = ir.models.find((m) => m.name === 'ListPetsResponse')!;
    expect(wrapper.fields.map((f) => [f.name, f.type])).toEqual([
      ['data', { kind: 'array', items: { kind: 'primitive', type: 'string' } }],
      ['total_pages', { kind: 'primitive', type: 'integer' }],
    ]);
    expect(warnings()).toEqual([
      warningFor('"page" is declared without a page-size parameter: limit, page_size, per_page, size, count'),
    ]);
  });

  it.each([
    ['page with a camelCase pageSize (the issue)', [query('page'), query('pageSize')], '"page" is'],
    ['pageNumber with pageSize (the issue): neither is a known name', [query('pageNumber'), query('pageSize')], null],
    ['page_number alone', [query('page_number')], '"page_number" is'],
    ['page_num alone', [query('page_num')], '"page_num" is'],
    ['offset alone', [query('offset')], '"offset" is'],
    ['skip alone', [query('skip')], '"skip" is'],
    ['offset and page, both without a size', [query('offset'), query('page')], '"offset" and "page" are'],
    [
      'three selectors without a size',
      [query('page'), query('offset'), query('skip')],
      '"offset", "skip" and "page" are',
    ],
  ])('%s: the envelope is kept and the warning names the declared parameter', async (_label, parameters, named) => {
    const ir = await parseJson(petsSpec(parameters, totalPagesEnvelope));
    expectEnvelopeKept(ir, ['data', 'total_pages']);
    expect(warnings()).toEqual([
      warningFor(
        named === null
          ? 'no cursor, offset or page query parameter is declared'
          : `${named} declared without a page-size parameter: limit, page_size, per_page, size, count`,
      ),
    ]);
  });

  it.each([
    ['a page-size parameter alone', [query('limit')], '"limit" is'],
    ['two page-size parameters alone', [query('limit'), query('per_page')], '"limit" and "per_page" are'],
  ])('%s selects no page either', async (_label, parameters, named) => {
    const ir = await parseJson(petsSpec(parameters, totalPagesEnvelope));
    expectEnvelopeKept(ir, ['data', 'total_pages']);
    expect(warnings()).toEqual([warningFor(`${named} declared without a cursor, offset or page parameter`)]);
  });

  it('a POST taking its cursor in the body is kept too, and the warning offers strategy "none" (MichaelDeBoey)', async () => {
    // No query parameter can drive this iterator and no override can name
    // one, so `strategy: 'none'` is the way to accept the plain model.
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets/search': {
          post: {
            operationId: 'searchPets',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { query: { type: 'string' }, cursor: { type: 'string' } } },
                },
              },
            },
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema: totalPagesEnvelope } } },
            },
          },
        },
      },
    });
    const op = expectEnvelopeKept(ir, ['data', 'total_pages']);
    expect(op.response).toEqual({ kind: 'model', name: 'SearchPetsResponse' });
    expect(warnings()).toEqual([
      expect.stringMatching(
        /^\[oagen\] Warning: searchPets returns a list envelope but no query parameter drives an iterator \(no cursor, offset or page query parameter is declared\) — .*, or set strategy "none" to accept the plain model$/,
      ),
    ]);
  });

  it('no paging parameter at all (the WorkOS waitlists shape) gets no iterator on an undeclared after', async () => {
    // `GET /user_management/waitlists`: `parameters: []`, and the spec says the
    // endpoint is not paginated — the `list_metadata` cursors are always null.
    const ir = await parseJson({
      ...petsSpec([], {
        type: 'object',
        properties: {
          object: { type: 'string', const: 'list' },
          data: { type: 'array', items: { $ref: '#/components/schemas/Waitlist' } },
          list_metadata: {
            type: 'object',
            properties: { before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] } },
          },
        },
      }),
      components: { schemas: { Waitlist: { type: 'object', properties: { id: { type: 'string' } } } } },
    });
    const op = expectEnvelopeKept(ir, ['object', 'data', 'list_metadata']);
    expect(op.queryParams).toEqual([]);
    // The wrapper's data array still types the component's items.
    const wrapper = ir.models.find((m) => op.response.kind === 'model' && m.name === op.response.name)!;
    expect(wrapper.fields.find((f) => f.name === 'data')?.type).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'Waitlist' },
    });
    expect(warnings()).toEqual([warningFor('no cursor, offset or page query parameter is declared')]);
  });

  it.each([
    [
      'a page size beside the page parameter',
      [query('page'), query('limit')],
      { strategy: 'page', param: 'page', limitParam: 'limit', pageStart: 1 },
    ],
    ['a cursor parameter', [query('after', 'string')], { strategy: 'cursor', param: 'after' }],
    [
      'a page size beside an offset parameter',
      [query('offset'), query('limit')],
      { strategy: 'offset', param: 'offset', limitParam: 'limit' },
    ],
  ])('declaring %s drives the iterator, which unwraps the envelope as before', async (_label, parameters, iterator) => {
    const ir = await parseJson(petsSpec(parameters, totalPagesEnvelope));
    const op = onlyOperation(ir);
    expect(op.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
    expect(op.pagination).toEqual({
      ...iterator,
      dataPath: 'data',
      itemType: { kind: 'primitive', type: 'string' },
      envelopeFields: [{ name: 'total_pages', type: { kind: 'primitive', type: 'integer' }, required: false }],
      endOfIteration: { kind: 'totalPages', path: 'total_pages' },
    });
    expect(warnings()).toEqual([]);
    expectSound(ir);
  });

  describe('an override naming a declared parameter creates the iterator around the envelope', () => {
    it('{ strategy: "page" } on the issue repro drives page, with the envelope and its stop field', async () => {
      const ir = await parseJson(
        petsSpec([query('page')], totalPagesEnvelope, { 'x-pagination': { strategy: 'page' } }),
      );
      const op = onlyOperation(ir);
      expect(op.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
      expect(op.pagination).toEqual({
        strategy: 'page',
        param: 'page',
        pageStart: 1,
        dataPath: 'data',
        itemType: { kind: 'primitive', type: 'string' },
        envelopeFields: [{ name: 'total_pages', type: { kind: 'primitive', type: 'integer' }, required: false }],
        endOfIteration: { kind: 'totalPages', path: 'total_pages' },
      });
      expect(warnings()).toEqual([]);
      expectSound(ir);
    });

    it('a cursor on a parameter detection does not know keeps the data description and the companions', async () => {
      const described = {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' }, description: 'The pets on this page.' },
          total_pages: { type: 'integer' },
        },
      };
      const ir = await parseJson(
        petsSpec([query('c', 'string')], described, { 'x-pagination': { strategy: 'cursor', param: 'c' } }),
      );
      const op = onlyOperation(ir);
      expect(op.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
      expect(op.pagination).toEqual({
        strategy: 'cursor',
        param: 'c',
        dataPath: 'data',
        dataDescription: 'The pets on this page.',
        itemType: { kind: 'primitive', type: 'string' },
        envelopeFields: [{ name: 'total_pages', type: { kind: 'primitive', type: 'integer' }, required: false }],
        endOfIteration: { kind: 'totalPages', path: 'total_pages' },
      });
      expect(warnings()).toEqual([]);
      expectSound(ir);
    });

    it('an operationHints entry works like the extension', async () => {
      const specFile = path.join(tmpDir, 'spec.json');
      await fs.writeFile(specFile, JSON.stringify(petsSpec([query('page')], totalPagesEnvelope)), 'utf-8');
      const ir = await parseSpec(specFile, { operationHints: { 'GET /pets': { pagination: { strategy: 'page' } } } });
      const op = onlyOperation(ir);
      expect(op.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
      expect(op.pagination).toMatchObject({ strategy: 'page', param: 'page', dataPath: 'data' });
      expect(warnings()).toEqual([]);
    });
  });

  describe('an override that cannot apply leaves the envelope kept, with the rejection as the one warning', () => {
    it('a param the operation does not declare', async () => {
      const ir = await parseJson(
        petsSpec([], totalPagesEnvelope, { 'x-pagination': { strategy: 'cursor', param: 'after' } }),
      );
      expectEnvelopeKept(ir, ['data', 'total_pages']);
      expect(warnings()).toEqual([
        '[oagen] Warning: x-pagination on listPets: param "after" is not a query parameter of the operation — ignoring the override',
      ]);
    });

    it('a strategy with no param from any source', async () => {
      const ir = await parseJson(
        petsSpec([query('limit')], totalPagesEnvelope, { 'x-pagination': { strategy: 'page' } }),
      );
      expectEnvelopeKept(ir, ['data', 'total_pages']);
      expect(warnings()).toEqual([
        '[oagen] Warning: x-pagination on listPets: strategy "page" needs a param, and none was given or detected — ignoring the override',
      ]);
    });

    it('a dataPath that reaches no array, when only the override could have paged the body', async () => {
      const ir = await parseJson(
        petsSpec([query('c', 'string')], totalPagesEnvelope, {
          'x-pagination': { strategy: 'cursor', param: 'c', dataPath: 'nope' },
        }),
      );
      const op = expectEnvelopeKept(ir, ['data', 'total_pages']);
      expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      expect(warnings()).toEqual([
        '[oagen] Warning: x-pagination on listPets: dataPath "nope" does not resolve to an array in the response — ignoring the override',
      ]);
    });

    it('a malformed extension', async () => {
      const ir = await parseJson(petsSpec([query('page')], totalPagesEnvelope, { 'x-pagination': 'page' }));
      expectEnvelopeKept(ir, ['data', 'total_pages']);
      expect(warnings()).toEqual(['[oagen] Warning: x-pagination on listPets must be an object — ignoring it']);
    });
  });

  describe('a kept envelope is read as the wire shape, never as a single-resource wrapper (Greptile)', () => {
    // One required companion carrying a constant `type` is exactly the shape
    // `isSingleResourceWrapper` accepts, so an envelope that reached that
    // check was unwrapped onto its pagination object and lost `data`. Every
    // reason that keeps an envelope must read it as one model with every
    // field.
    const constCompanion = {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'string' } },
        pagination: {
          type: 'object',
          properties: { type: { type: 'string', const: 'pagination' }, total: { type: 'integer' } },
          required: ['type', 'total'],
        },
      },
      required: ['pagination'],
    };

    /** The response is one model with `data` and `pagination`, and `pagination` is the companion model. */
    function expectWireShape(ir: ApiSpec): Operation {
      const op = expectEnvelopeKept(ir, ['data', 'pagination']);
      expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      const wrapper = ir.models.find((m) => m.name === 'ListPetsResponse')!;
      expect(wrapper.fields.find((f) => f.name === 'data')?.type).toEqual({
        kind: 'array',
        items: { kind: 'primitive', type: 'string' },
      });
      const companionRef = wrapper.fields.find((f) => f.name === 'pagination')?.type;
      expect(companionRef?.kind).toBe('model');
      const companion = ir.models.find((m) => companionRef?.kind === 'model' && m.name === companionRef.name);
      expect(companion?.fields.map((f) => [f.name, f.type])).toEqual([
        ['type', { kind: 'literal', value: 'pagination' }],
        ['total', { kind: 'primitive', type: 'integer' }],
      ]);
      return op;
    }

    it("Greptile's example: no paging parameter keeps data beside the pagination object", async () => {
      expectWireShape(await parseJson(petsSpec([], constCompanion)));
      expect(warnings()).toEqual([warningFor('no cursor, offset or page query parameter is declared')]);
    });

    it('the same under strategy "none", with a declared cursor parameter', async () => {
      expectWireShape(
        await parseJson(petsSpec([query('after', 'string')], constCompanion, { 'x-pagination': { strategy: 'none' } })),
      );
      expect(warnings()).toEqual([]);
    });

    it('the same under a rejected override, with the rejection as the one warning', async () => {
      expectWireShape(
        await parseJson(petsSpec([], constCompanion, { 'x-pagination': { strategy: 'cursor', param: 'after' } })),
      );
      expect(warnings()).toEqual([
        '[oagen] Warning: x-pagination on listPets: param "after" is not a query parameter of the operation — ignoring the override',
      ]);
    });

    it('the same when only the override could page the body and its dataPath reaches no array', async () => {
      expectWireShape(
        await parseJson(
          petsSpec([query('c', 'string')], constCompanion, {
            'x-pagination': { strategy: 'cursor', param: 'c', dataPath: 'nope' },
          }),
        ),
      );
      expect(warnings()).toEqual([
        '[oagen] Warning: x-pagination on listPets: dataPath "nope" does not resolve to an array in the response — ignoring the override',
      ]);
    });

    it('the same for an envelope kept as a wrapper under a dataPath that names another array', async () => {
      const nested = {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' } },
          pagination: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'pagination' },
              items: { type: 'array', items: { type: 'integer' } },
            },
            required: ['type', 'items'],
          },
        },
        required: ['pagination'],
      };
      const ir = await parseJson(
        petsSpec([query('after', 'string')], nested, { 'x-pagination': { dataPath: 'pagination.items' } }),
      );
      const op = onlyOperation(ir);
      expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      const wrapper = ir.models.find((m) => m.name === 'ListPetsResponse')!;
      expect(wrapper.fields.map((f) => f.name)).toEqual(['data', 'pagination']);
      expect(op.pagination).toMatchObject({
        strategy: 'cursor',
        param: 'after',
        dataPath: 'pagination.items',
        itemType: { kind: 'primitive', type: 'integer' },
      });
      expect(op.pagination).not.toHaveProperty('envelopeFields');
      expect(warnings()).toEqual([]);
      expectSound(ir);
    });

    it('a single-resource wrapper that is not an envelope still unwraps onto its resource', async () => {
      const ir = await parseJson(
        petsSpec([], {
          type: 'object',
          properties: {
            pet: {
              type: 'object',
              properties: { object: { type: 'string', const: 'pet' }, name: { type: 'string' } },
              required: ['object', 'name'],
            },
          },
          required: ['pet'],
        }),
      );
      const op = onlyOperation(ir);
      expect(op.response).toEqual({ kind: 'model', name: 'Pet' });
      expect(op.pagination).toBeUndefined();
      expect(ir.models.find((m) => m.name === 'Pet')?.fields.map((f) => f.name)).toEqual(['object', 'name']);
      expect(warnings()).toEqual([]);
      expectSound(ir);
    });
  });

  describe('a kept envelope on a later status code keeps its own shape (Greptile, round 2)', () => {
    const plainId = {
      description: 'ok',
      content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
    };
    const envelopeAt = (description: string) => ({
      description,
      content: { 'application/json': { schema: totalPagesEnvelope } },
    });
    const withResponses = (responses: Record<string, unknown>, parameters: unknown[] = []) => {
      const doc = petsSpec(parameters, totalPagesEnvelope);
      doc.paths['/pets'].get.responses = responses as (typeof doc.paths)['/pets']['get']['responses'];
      return doc;
    };
    const fieldsOf = (ir: ApiSpec, model: string) => ir.models.find((m) => m.name === model)?.fields.map((f) => f.name);

    it("Greptile's case: a 200 { id } and a 201 kept envelope are two models, the 201 keeping data and total_pages", async () => {
      const ir = await parseJson(withResponses({ '200': plainId, '201': envelopeAt('created') }));
      const op = onlyOperation(ir);
      expect(op.pagination).toBeUndefined();
      expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
        [200, { kind: 'model', name: 'ListPetsResponse' }],
        [201, { kind: 'model', name: 'ListPetsResponse201' }],
      ]);
      expect(fieldsOf(ir, 'ListPetsResponse')).toEqual(['id']);
      expect(fieldsOf(ir, 'ListPetsResponse201')).toEqual(['data', 'total_pages']);
      // The warning concerns the primary body, which is no envelope here.
      expect(warnings()).toEqual([]);
      expectSound(ir);
    });

    it('identical kept envelopes on a 200 and a 201 share one model', async () => {
      const ir = await parseJson(withResponses({ '200': envelopeAt('ok'), '201': envelopeAt('created') }));
      const op = onlyOperation(ir);
      expect(op.pagination).toBeUndefined();
      expect(op.successResponses?.map((r) => r.type)).toEqual([
        { kind: 'model', name: 'ListPetsResponse' },
        { kind: 'model', name: 'ListPetsResponse' },
      ]);
      expect(ir.models.map((m) => m.name)).toEqual(['ListPetsResponse']);
      expect(fieldsOf(ir, 'ListPetsResponse')).toEqual(['data', 'total_pages']);
      expect(warnings()).toEqual([warningFor('no cursor, offset or page query parameter is declared')]);
      expectSound(ir);
    });

    it('an envelope on a 3xx is never paged: the redirect entry stays untyped and its body is a plain content model', async () => {
      const ir = await parseJson(withResponses({ '200': plainId, '302': envelopeAt('moved') }));
      const op = onlyOperation(ir);
      expect(op.pagination).toBeUndefined();
      expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
        [200, { kind: 'model', name: 'ListPetsResponse' }],
        [302, { kind: 'primitive', type: 'unknown' }],
      ]);
      // A 3xx body is typed on its own content entry, as every 3xx body is,
      // never unwrapped and never the operation's response.
      const redirect = op.successResponses?.find((r) => r.statusCode === 302);
      expect(redirect?.contents?.map((c) => [c.contentType, c.type])).toEqual([
        ['application/json', { kind: 'model', name: 'ListPetsApplicationJsonResponse' }],
      ]);
      expect(fieldsOf(ir, 'ListPetsApplicationJsonResponse')).toEqual(['data', 'total_pages']);
      expect(ir.models.map((m) => m.name)).toEqual(['ListPetsResponse', 'ListPetsApplicationJsonResponse']);
      expect(warnings()).toEqual([]);
      expectSound(ir);
    });

    it('an unwrapped 201 envelope beside a 200 { id } still becomes the bare array when a parameter pages it', async () => {
      const ir = await parseJson(
        withResponses({ '200': plainId, '201': envelopeAt('created') }, [query('after', 'string')]),
      );
      const op = onlyOperation(ir);
      expect(op.successResponses?.map((r) => r.type)).toEqual([
        { kind: 'model', name: 'ListPetsResponse' },
        { kind: 'array', items: { kind: 'primitive', type: 'string' } },
      ]);
      expect(ir.models.map((m) => m.name)).toEqual(['ListPetsResponse']);
      expect(warnings()).toEqual([]);
      expectSound(ir);
    });
  });

  it('strategy "none" asks for the plain model and gets no warning', async () => {
    const ir = await parseJson(petsSpec([query('page')], totalPagesEnvelope, { 'x-pagination': { strategy: 'none' } }));
    expectEnvelopeKept(ir, ['data', 'total_pages']);
    expect(warnings()).toEqual([]);
  });

  it('a secondary 2xx envelope the override cannot read is kept too, while the primary is iterated', async () => {
    // Only the override pages the operation (`c` is no name detection knows).
    // Its `dataPath` reaches the 200's array and not the 202's, so the 202's
    // envelope — which nothing will page — stays the wire shape instead of
    // being unwrapped into a bare array that drops its companions.
    const doc = petsSpec([query('c', 'string')], totalPagesEnvelope, {
      'x-pagination': { strategy: 'cursor', param: 'c', dataPath: 'data' },
    });
    const queued = {
      description: 'queued',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              results: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
              total: { type: 'integer' },
            },
          },
        },
      },
    };
    Object.assign(doc.paths['/pets'].get.responses, { '202': queued });
    const withSecondary = await parseJson(doc);

    const op = onlyOperation(withSecondary);
    expect(op.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
    expect(op.pagination).toMatchObject({
      strategy: 'cursor',
      param: 'c',
      dataPath: 'data',
      envelopeFields: [{ name: 'total_pages' }],
      endOfIteration: { kind: 'totalPages', path: 'total_pages' },
    });
    const secondary = op.successResponses?.find((r) => r.statusCode === 202)?.type;
    expect(secondary?.kind).toBe('model');
    const wrapper = withSecondary.models.find((m) => secondary?.kind === 'model' && m.name === secondary.name);
    expect(wrapper?.fields.map((f) => f.name)).toEqual(['results', 'total']);
    expect(warnings()).toEqual([]);
    expectSound(withSecondary);
  });
});
