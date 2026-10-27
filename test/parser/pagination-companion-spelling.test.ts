import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { detectEndOfIteration, looksLikePaginationMetadata } from '../../src/parser/pagination.js';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';
import { collectModelRefs, collectResponseHeaders } from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

/**
 * Issue #311: a pagination companion is recognized by its name in any
 * spelling. The metadata patterns are snake_case (`page_info`, `has_more`,
 * `next_page`, …) and used to be matched against the lowercased name, so
 * `pageInfo` (`pageinfo`) matched none of them: a `{ data, pageInfo: {
 * hasNextPage } }` body was not unwrapped and, beside a recognized envelope,
 * `pageInfo.hasNextPage` was skipped by the nested stop-field scan. The name
 * is now matched in its snake_case spelling, by the one recognizer both
 * list-envelope detection and the stop-field read share.
 */

const integer: SchemaObject = { type: 'integer' };
const boolean: SchemaObject = { type: 'boolean' };
const data: SchemaObject = { type: 'array', items: { type: 'string' } };
const companion = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', properties });

describe('looksLikePaginationMetadata', () => {
  it('matches a multi-word pattern in snake_case, camelCase, PascalCase and kebab-case alike', () => {
    for (const name of ['page_info', 'pageInfo', 'PageInfo', 'page-info'])
      expect(looksLikePaginationMetadata(name)).toBe(true);
    for (const name of ['has_more', 'hasMore', 'HasMore', 'has-more'])
      expect(looksLikePaginationMetadata(name)).toBe(true);
    for (const name of ['next_page', 'nextPage', 'NextPage', 'next-page'])
      expect(looksLikePaginationMetadata(name)).toBe(true);
    for (const name of ['previous_page', 'previousPage', 'PreviousPage', 'previous-page']) {
      expect(looksLikePaginationMetadata(name)).toBe(true);
    }
  });

  it('matches a single-word pattern whatever its case and whatever words surround it', () => {
    for (const name of ['meta', 'Meta', 'listMetadata', 'list_metadata', 'ListMetadata', 'Pagination', 'CURSOR']) {
      expect(looksLikePaginationMetadata(name)).toBe(true);
    }
    for (const name of ['endCursor', 'totalCount', 'Total', 'pageOffset', 'pageInfoV2']) {
      expect(looksLikePaginationMetadata(name)).toBe(true);
    }
  });

  it('reads a name by its words, so a pattern never straddles a camelCase boundary', () => {
    // `nameTag` lowercased is `nametag`, which contains `meta`; its words are
    // `name_tag`, which does not — the same reading `name_tag` always had.
    for (const name of ['nameTag', 'name_tag', 'homeTable', 'object', 'data', 'id']) {
      expect(looksLikePaginationMetadata(name)).toBe(false);
    }
  });

  it('reads a name that runs its words together as one word, which no multi-word pattern matches (#438)', () => {
    for (const name of ['pageinfo', 'PAGEINFO', 'Pageinfo', 'hasmore', 'HASMORE', 'nextpage', 'previouspage']) {
      expect(looksLikePaginationMetadata(name)).toBe(false);
    }
    // A one-word pattern is still found inside such a name.
    for (const name of ['listmetadata', 'LISTMETADATA', 'pagetotal']) {
      expect(looksLikePaginationMetadata(name)).toBe(true);
    }
  });
});

describe('detectEndOfIteration — companion object in any spelling', () => {
  it('reads the stop field inside a camelCase, PascalCase, kebab-case or snake_case companion (#311)', () => {
    expect(detectEndOfIteration({ data, pageInfo: companion({ hasNextPage: boolean }) }, 'data')).toEqual({
      kind: 'hasMore',
      path: 'pageInfo.hasNextPage',
    });
    expect(detectEndOfIteration({ data, PageInfo: companion({ hasNextPage: boolean }) }, 'data')).toEqual({
      kind: 'hasMore',
      path: 'PageInfo.hasNextPage',
    });
    expect(detectEndOfIteration({ data, 'page-info': companion({ hasNextPage: boolean }) }, 'data')).toEqual({
      kind: 'hasMore',
      path: 'page-info.hasNextPage',
    });
    expect(detectEndOfIteration({ data, page_info: companion({ has_next_page: boolean }) }, 'data')).toEqual({
      kind: 'hasMore',
      path: 'page_info.has_next_page',
    });
  });

  it('lets pageInfo.hasNextPage win over a top-level total, as page_info.has_next_page does (#311)', () => {
    expect(
      detectEndOfIteration({ data, pageInfo: companion({ hasNextPage: boolean }), total: integer }, 'data'),
    ).toEqual({ kind: 'hasMore', path: 'pageInfo.hasNextPage' });
    expect(
      detectEndOfIteration({ data, page_info: companion({ has_next_page: boolean }), total: integer }, 'data'),
    ).toEqual({ kind: 'hasMore', path: 'page_info.has_next_page' });
  });

  it('follows a camelCase $ref companion to its component, as it follows a snake_case one', () => {
    const components: Record<string, SchemaObject> = { PageInfo: companion({ page: integer, totalPages: integer }) };
    const pageInfo: SchemaObject = { $ref: '#/components/schemas/PageInfo' };
    expect(detectEndOfIteration({ data, pageInfo }, 'data', components)).toEqual({
      kind: 'totalPages',
      path: 'pageInfo.totalPages',
    });
  });

  it('does not look inside a companion whose words say nothing about pagination', () => {
    expect(detectEndOfIteration({ data, nameTag: companion({ hasMore: boolean }) }, 'data')).toBeUndefined();
  });
});

describe('classifyAndExtractResponse — envelope companion in any spelling', () => {
  const envelope = (companions: Record<string, SchemaObject>): SchemaObject => ({
    type: 'object',
    properties: { data, ...companions },
  });

  it.each([
    ['pageInfo', 'hasNextPage'],
    ['PageInfo', 'hasNextPage'],
    ['page-info', 'hasNextPage'],
    ['page_info', 'has_next_page'],
  ])('unwraps { data, %s: { %s } } as a list envelope (#311)', (name, stop) => {
    const result = classifyAndExtractResponse(envelope({ [name]: companion({ [stop]: boolean }) }), 'ListPetsResponse');
    expect(result.isPaginated).toBe(true);
    expect(result.dataPath).toBe('data');
    expect(result.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
    expect(result.itemType).toEqual({ kind: 'primitive', type: 'string' });
    expect(result.envelopeFields?.map((f) => f.name)).toEqual([name]);
    expect(result.endOfIteration).toEqual({ kind: 'hasMore', path: `${name}.${stop}` });
    expect(result.envelopeCompanions?.map((c) => c.bareNames)).toEqual([['PageInfo']]);
  });

  it('keeps a body whose only companion says nothing about pagination as a plain model', () => {
    const result = classifyAndExtractResponse(
      envelope({ nameTag: companion({ hasMore: boolean }) }),
      'ListPetsResponse',
    );
    expect(result.isPaginated).toBe(false);
    expect(result.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
    expect(result.endOfIteration).toBeUndefined();
  });

  it.each<[string, SchemaObject, string]>([
    ['HasMore', boolean, 'hasMore'],
    ['has-more', boolean, 'hasMore'],
    ['HasNext', boolean, 'hasMore'],
    ['has-next', boolean, 'hasMore'],
    ['PageCount', integer, 'totalPages'],
    ['page-count', integer, 'totalPages'],
  ])(
    'unwraps { data, %s } as a list envelope and stops on it, as on its listed spelling (#438)',
    (name, schema, kind) => {
      const result = classifyAndExtractResponse(envelope({ [name]: schema }), 'ListPetsResponse');
      expect(result.isPaginated).toBe(true);
      expect(result.dataPath).toBe('data');
      expect(result.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
      expect(result.envelopeFields?.map((f) => f.name)).toEqual([name]);
      expect(result.endOfIteration).toEqual({ kind, path: name });
    },
  );

  it('keeps { data, has.next } as a plain model: a name with a `.` is no stop field', () => {
    const result = classifyAndExtractResponse(envelope({ 'has.next': boolean }), 'ListPetsResponse');
    expect(result.isPaginated).toBe(false);
    expect(result.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
    expect(result.endOfIteration).toBeUndefined();
  });

  it.each(['hasmore', 'hasnext', 'HASNEXT', 'pagecount'])(
    'keeps { data, %s } as a plain model: a name that runs its words together is no stop field (#438)',
    (name) => {
      const result = classifyAndExtractResponse(envelope({ [name]: boolean }), 'ListPetsResponse');
      expect(result.isPaginated).toBe(false);
      expect(result.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      expect(result.endOfIteration).toBeUndefined();
    },
  );
});

describe('detectEndOfIteration — stop field in any spelling (#438)', () => {
  it('reads a top-level stop field in any spelling that separates its words, its path spelled as written', () => {
    for (const name of ['has_more', 'hasMore', 'HasMore', 'has-more', 'HAS_MORE']) {
      expect(detectEndOfIteration({ data, [name]: boolean }, 'data')).toEqual({ kind: 'hasMore', path: name });
    }
  });

  it('reads a stop field inside a metadata companion, whichever spelling each is written in', () => {
    expect(detectEndOfIteration({ data, PageInfo: companion({ HasNextPage: boolean }) }, 'data')).toEqual({
      kind: 'hasMore',
      path: 'PageInfo.HasNextPage',
    });
    expect(detectEndOfIteration({ data, 'page-info': companion({ 'has-next-page': boolean }) }, 'data')).toEqual({
      kind: 'hasMore',
      path: 'page-info.has-next-page',
    });
    expect(detectEndOfIteration({ data, pagination: companion({ 'Total-Pages': integer }) }, 'data')).toEqual({
      kind: 'totalPages',
      path: 'pagination.Total-Pages',
    });
  });

  it('gives every stop field its kind in any spelling', () => {
    const spellings: Record<string, string[]> = {
      hasMore: ['HasNext', 'has-next', 'HasNextPage', 'HAS_NEXT_PAGE'],
      totalPages: ['TotalPages', 'total-pages', 'PageCount', 'page-count', 'PAGE_COUNT'],
      totalCount: ['Total', 'TOTAL', 'TotalCount', 'total-count', 'TotalItems', 'total-items', 'TotalResults'],
    };
    for (const [kind, names] of Object.entries(spellings)) {
      const schema = kind === 'hasMore' ? boolean : integer;
      for (const name of names) {
        expect(detectEndOfIteration({ data, [name]: schema }, 'data')).toEqual({ kind, path: name });
      }
    }
  });

  it('still prefers hasMore over totalPages over a count, whatever each is spelled', () => {
    expect(detectEndOfIteration({ data, Total: integer, 'has-more': boolean }, 'data')).toEqual({
      kind: 'hasMore',
      path: 'has-more',
    });
    expect(detectEndOfIteration({ data, TOTAL: integer, PageCount: integer }, 'data')).toEqual({
      kind: 'totalPages',
      path: 'PageCount',
    });
  });

  it('tests the type of a stop field in a new spelling as in a listed one', () => {
    expect(detectEndOfIteration({ data, HasMore: integer }, 'data')).toBeUndefined();
    expect(detectEndOfIteration({ data, 'total-pages': { type: 'string' } }, 'data')).toBeUndefined();
  });

  it('reads no stop field, and looks inside no companion, whose name runs its words together', () => {
    for (const name of ['hasmore', 'HASMORE', 'Hasmore', 'hasnextpage']) {
      expect(detectEndOfIteration({ data, [name]: boolean }, 'data')).toBeUndefined();
    }
    for (const name of ['totalpages', 'TOTALCOUNT', 'pagecount']) {
      expect(detectEndOfIteration({ data, [name]: integer }, 'data')).toBeUndefined();
    }
    for (const name of ['pageinfo', 'PAGEINFO']) {
      expect(detectEndOfIteration({ data, [name]: companion({ hasNextPage: boolean }) }, 'data')).toBeUndefined();
    }
  });

  it('reads no stop field from, and looks inside no companion named with, a `.` the dotted path cannot address', () => {
    // `has.more` would be read as `more` inside `has`, so the valid `total` beside it stays the stop.
    expect(detectEndOfIteration({ data, 'has.more': boolean, total: integer }, 'data')).toEqual({
      kind: 'totalCount',
      path: 'total',
    });
    expect(detectEndOfIteration({ data, 'has.more': boolean }, 'data')).toBeUndefined();
    expect(detectEndOfIteration({ data, pagination: companion({ 'total.pages': integer }) }, 'data')).toBeUndefined();
    expect(detectEndOfIteration({ data, 'page.info': companion({ hasNextPage: boolean }) }, 'data')).toBeUndefined();
    const nested = { result: companion({ items: data, 'has.more': boolean }) };
    expect(detectEndOfIteration(nested, 'result.items')).toBeUndefined();
  });
});

describe('parseSpec — the issue #438 repro end to end', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  /** `GET /pets` (`listPets`) with an `after` query parameter, returning `{ data: string[] }` plus `companions`. */
  async function listPets(companions: Record<string, unknown>): Promise<ApiSpec> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-438-'));
    dirs.push(dir);
    const file = path.join(dir, 'repro.json');
    const schema = {
      type: 'object',
      properties: { data: { type: 'array', items: { type: 'string' } }, ...companions },
    };
    await fs.writeFile(
      file,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
              responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
            },
          },
        },
      }),
    );
    return parseSpec(file);
  }

  /** The issue's projection: the response, then the iterator's `dataPath`, envelope field names and stop field. */
  function projection(spec: ApiSpec) {
    const [{ pagination, response }] = spec.services.flatMap(({ operations }) => operations);
    const { dataPath, endOfIteration, envelopeFields = [] } = pagination!;
    const type =
      response.kind === 'model'
        ? response.name
        : response.kind === 'array' && response.items.kind === 'primitive'
          ? `${response.items.type}[]`
          : response.kind;
    return [type, dataPath, envelopeFields.map(({ name }) => name), endOfIteration];
  }

  const flag = { type: 'boolean' };
  const pageInfo = (name: string, stop: string) => ({ [name]: { type: 'object', properties: { [stop]: flag } } });

  it('reads a stop field in every spelling that separates its words, and no name that runs them together', async () => {
    const documents: Record<string, Record<string, unknown>> = {
      camel: pageInfo('pageInfo', 'hasNextPage'),
      pascal: pageInfo('PageInfo', 'HasNextPage'),
      kebab: pageInfo('page-info', 'has-next-page'),
      'top-pascal': { HasMore: flag },
      'top-kebab': { 'has-more': flag },
      flat: pageInfo('pageinfo', 'hasNextPage'),
      'flat-upper': pageInfo('PAGEINFO', 'hasNextPage'),
      'top-flat': { hasmore: flag },
    };
    const projected: Record<string, unknown> = {};
    for (const [file, companions] of Object.entries(documents))
      projected[file] = projection(await listPets(companions));
    expect(projected).toEqual({
      camel: ['string[]', 'data', ['pageInfo'], { kind: 'hasMore', path: 'pageInfo.hasNextPage' }],
      pascal: ['string[]', 'data', ['PageInfo'], { kind: 'hasMore', path: 'PageInfo.HasNextPage' }],
      kebab: ['string[]', 'data', ['page-info'], { kind: 'hasMore', path: 'page-info.has-next-page' }],
      'top-pascal': ['string[]', 'data', ['HasMore'], { kind: 'hasMore', path: 'HasMore' }],
      'top-kebab': ['string[]', 'data', ['has-more'], { kind: 'hasMore', path: 'has-more' }],
      flat: ['ListPetsResponse', undefined, [], undefined],
      'flat-upper': ['ListPetsResponse', undefined, [], undefined],
      'top-flat': ['ListPetsResponse', undefined, [], undefined],
    });
  });

  it('names the stop field by the wire names the IR carries, so the path walks the envelope fields and model', async () => {
    for (const [name, stop] of [
      ['PageInfo', 'HasNextPage'],
      ['page-info', 'has-next-page'],
    ]) {
      const spec = await listPets(pageInfo(name, stop));
      const [op] = spec.services.flatMap((s) => s.operations);
      expect(op.pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: `${name}.${stop}` });
      expect(op.pagination?.envelopeFields).toEqual([
        { name, type: { kind: 'model', name: 'PageInfo' }, required: false },
      ]);
      expect(spec.models.find((m) => m.name === 'PageInfo')?.fields).toEqual([
        { name: stop, type: { kind: 'primitive', type: 'boolean' }, required: false },
      ]);
    }
  });

  it('unwraps an envelope whose only companion is a stop field in a new spelling, as one in a listed spelling', async () => {
    expect(projection(await listPets({ HasNext: flag }))).toEqual([
      'string[]',
      'data',
      ['HasNext'],
      { kind: 'hasMore', path: 'HasNext' },
    ]);
    expect(projection(await listPets({ 'page-count': { type: 'integer' } }))).toEqual([
      'string[]',
      'data',
      ['page-count'],
      { kind: 'totalPages', path: 'page-count' },
    ]);
    expect(projection(await listPets({ hasnext: flag }))).toEqual(['ListPetsResponse', undefined, [], undefined]);
  });

  it('stops on a field the dotted path can address, never on one whose name holds a `.`', async () => {
    expect(projection(await listPets({ 'has.more': flag, total: { type: 'integer' } }))).toEqual([
      'string[]',
      'data',
      ['has.more', 'total'],
      { kind: 'totalCount', path: 'total' },
    ]);
  });
});

describe('parseSpec — the issue #311 repro end to end', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  /** `GET /pets` (`listPets`) with `page` and `limit` query parameters, returning `schema`. */
  async function parsePets(schema: unknown): Promise<ApiSpec> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-311-'));
    dirs.push(dir);
    const file = path.join(dir, 'repro.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer' } },
                { name: 'limit', in: 'query', schema: { type: 'integer' } },
              ],
              responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
            },
          },
        },
      }),
    );
    return parseSpec(file);
  }

  const envelope = (companions: Record<string, unknown>) => ({
    type: 'object',
    properties: { data: { type: 'array', items: { type: 'string' } }, ...companions },
  });

  /** The issue's projection of an operation's pagination. */
  function projection(spec: ApiSpec) {
    const [op] = spec.services.flatMap(({ operations }) => operations);
    const { envelopeFields, itemType, ...pagination } = op.pagination!;
    return {
      ...pagination,
      itemType: 'name' in itemType ? itemType.name : 'type' in itemType ? itemType.type : itemType.kind,
      ...(envelopeFields && { envelopeFields: envelopeFields.map(({ name }) => name) }),
    };
  }

  /** Every type reference an operation holds. */
  function operationRefs(op: Operation): TypeRef[] {
    const refs: TypeRef[] = [op.response];
    if (op.requestBody) refs.push(op.requestBody);
    for (const r of op.successResponses ?? []) refs.push(r.type);
    for (const e of op.errors) if (e.type) refs.push(e.type);
    for (const f of op.pagination?.envelopeFields ?? []) refs.push(f.type);
    if (op.pagination) refs.push(op.pagination.itemType);
    for (const h of collectResponseHeaders(op)) refs.push(h.type);
    for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
      refs.push(p.type);
    }
    return refs;
  }

  /** Every model reference resolves, and every model (none is a component here) is referenced. */
  function expectSound(spec: ApiSpec): void {
    const names = new Set(spec.models.map((m) => m.name));
    const referenced = new Set<string>();
    const refs = [
      ...spec.services.flatMap((s) => s.operations).flatMap(operationRefs),
      ...spec.models.flatMap((m) => m.fields.map((f) => f.type)),
    ];
    for (const ref of refs) for (const name of collectModelRefs(ref)) referenced.add(name);
    expect([...referenced].filter((name) => !names.has(name))).toEqual([]);
    expect(spec.models.map((m) => m.name).filter((name) => !referenced.has(name))).toEqual([]);
  }

  const page = { strategy: 'page', param: 'page', limitParam: 'limit', pageStart: 1 };

  it('reads pageInfo like page_info: unwrapped on data, with pageInfo.hasNextPage as the stop field', async () => {
    const spec = await parsePets(envelope({ pageInfo: { type: 'object', properties: { hasNextPage: boolean } } }));
    expect(projection(spec)).toEqual({
      ...page,
      dataPath: 'data',
      endOfIteration: { kind: 'hasMore', path: 'pageInfo.hasNextPage' },
      itemType: 'string',
      envelopeFields: ['pageInfo'],
    });
    const [op] = spec.services.flatMap((s) => s.operations);
    expect(op.pagination?.envelopeFields).toEqual([
      { name: 'pageInfo', type: { kind: 'model', name: 'PageInfo' }, required: false },
    ]);
    expect(spec.models.map((m) => m.name)).toEqual(['PageInfo']);
    expect(spec.models[0].fields).toEqual([
      { name: 'hasNextPage', type: { kind: 'primitive', type: 'boolean' }, required: false },
    ]);
    expectSound(spec);
  });

  it('reads a PascalCase PageInfo the same way', async () => {
    const spec = await parsePets(envelope({ PageInfo: { type: 'object', properties: { hasNextPage: boolean } } }));
    expect(projection(spec)).toEqual({
      ...page,
      dataPath: 'data',
      endOfIteration: { kind: 'hasMore', path: 'PageInfo.hasNextPage' },
      itemType: 'string',
      envelopeFields: ['PageInfo'],
    });
    expect(spec.models.map((m) => m.name)).toEqual(['PageInfo']);
    expectSound(spec);
  });

  it('still reads page_info as before', async () => {
    const spec = await parsePets(envelope({ page_info: { type: 'object', properties: { has_next_page: boolean } } }));
    expect(projection(spec)).toEqual({
      ...page,
      dataPath: 'data',
      endOfIteration: { kind: 'hasMore', path: 'page_info.has_next_page' },
      itemType: 'string',
      envelopeFields: ['page_info'],
    });
    expect(spec.models.map((m) => m.name)).toEqual(['PageInfo']);
    expectSound(spec);
  });

  it('still reads a top-level hasNextPage as before', async () => {
    const spec = await parsePets(envelope({ hasNextPage: boolean }));
    expect(projection(spec)).toEqual({
      ...page,
      dataPath: 'data',
      endOfIteration: { kind: 'hasMore', path: 'hasNextPage' },
      itemType: 'string',
      envelopeFields: ['hasNextPage'],
    });
    expect(spec.models).toEqual([]);
  });

  it('prefers pageInfo.hasNextPage over a total beside it, as page_info.has_next_page is preferred', async () => {
    const camel = await parsePets(
      envelope({ pageInfo: { type: 'object', properties: { hasNextPage: boolean } }, total: integer }),
    );
    expect(projection(camel)).toEqual({
      ...page,
      dataPath: 'data',
      endOfIteration: { kind: 'hasMore', path: 'pageInfo.hasNextPage' },
      itemType: 'string',
      envelopeFields: ['pageInfo', 'total'],
    });
    expectSound(camel);

    const snake = await parsePets(
      envelope({ page_info: { type: 'object', properties: { has_next_page: boolean } }, total: integer }),
    );
    expect(projection(snake)).toEqual({
      ...page,
      dataPath: 'data',
      endOfIteration: { kind: 'hasMore', path: 'page_info.has_next_page' },
      itemType: 'string',
      envelopeFields: ['page_info', 'total'],
    });
    expectSound(snake);
  });
});
