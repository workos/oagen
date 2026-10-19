import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';
import { isArraySchema } from '../../src/parser/schemas.js';
import { collectModelRefs } from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * JSON Schema does not require `type` beside `items`, and `schemaToTypeRef`
 * types such a schema as an array. Every site that decides whether to
 * materialize the item model must agree with it, or the array's items point
 * at a model nobody creates (#238). These tests pin that agreement for the
 * response body, the list-envelope data array, and inline fields.
 */

const petItems = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

const shapeVariants = {
  oneOf: [
    { type: 'object', properties: { radius: { type: 'number' } }, required: ['radius'] },
    { type: 'object', properties: { side: { type: 'number' } }, required: ['side'] },
  ],
};

describe('isArraySchema', () => {
  it('accepts every spelling schemaToTypeRef types as an array', () => {
    expect(isArraySchema({ type: 'array', items: { type: 'string' } })).toBe(true);
    expect(isArraySchema({ type: 'array' })).toBe(true);
    expect(isArraySchema({ items: { type: 'string' } })).toBe(true);
    expect(isArraySchema({ items: petItems })).toBe(true);
    expect(isArraySchema({ type: ['array', 'null'], items: { type: 'string' } })).toBe(true);
    expect(isArraySchema({ type: ['null', 'array'], items: {} })).toBe(true);
  });

  it('rejects what schemaToTypeRef types as something else', () => {
    expect(isArraySchema(undefined)).toBe(false);
    expect(isArraySchema({})).toBe(false);
    expect(isArraySchema({ type: 'string' })).toBe(false);
    expect(isArraySchema({ type: 'object', properties: {} })).toBe(false);
    expect(isArraySchema({ properties: { a: { type: 'string' } } })).toBe(false);
    // A `$ref` is a reference whatever it carries beside it.
    expect(isArraySchema({ $ref: '#/components/schemas/List', items: { type: 'string' } })).toBe(false);
    // A type list naming another type beside `array` is a union.
    expect(isArraySchema({ type: ['array', 'string'], items: { type: 'string' } })).toBe(false);
    expect(isArraySchema({ type: ['null'] })).toBe(false);
    // No tuple support: `prefixItems` alone is not an array to schemaToTypeRef.
    expect(isArraySchema({ prefixItems: [{ type: 'string' }] })).toBe(false);
  });
});

describe('classifyAndExtractResponse — array response without type', () => {
  it('extracts the item model of a bare `items` response exactly like a typed array (#238 repro)', () => {
    const untyped = classifyAndExtractResponse({ items: petItems }, 'ListPetsResponse');
    const typed = classifyAndExtractResponse({ type: 'array', items: petItems }, 'ListPetsResponse');

    expect(untyped.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } });
    expect(untyped.inlineModels.map((m) => m.name)).toEqual(['ListPetsItem']);
    expect(untyped.inlineModels[0].fields).toEqual([
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ]);
    expect(untyped.isPaginated).toBe(false);
    expect(untyped).toEqual(typed);
  });

  it('types $ref and primitive items as before', () => {
    expect(classifyAndExtractResponse({ items: { $ref: '#/components/schemas/Pet' } }, 'ListPetsResponse')).toEqual({
      response: { kind: 'array', items: { kind: 'model', name: 'Pet' } },
      inlineModels: [],
      isPaginated: false,
    });
    expect(classifyAndExtractResponse({ items: { type: 'string' } }, 'ListTagsResponse')).toEqual({
      response: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
      inlineModels: [],
      isPaginated: false,
    });
  });

  it('keeps the nullable wrapper of `type: [array, null]` around the extracted item model', () => {
    const result = classifyAndExtractResponse({ type: ['array', 'null'], items: petItems }, 'ListPetsResponse');

    expect(result.response).toEqual({
      kind: 'nullable',
      inner: { kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } },
    });
    expect(result.inlineModels.map((m) => m.name)).toEqual(['ListPetsItem']);

    // The OAS 3.0 spelling of the same schema yields the same IR.
    const oas30 = classifyAndExtractResponse({ type: 'array', nullable: true, items: petItems }, 'ListPetsResponse');
    expect(oas30).toEqual(result);
  });

  it('wraps a nullable array of $ref items the way schemaToTypeRef does', () => {
    const expected: TypeRef = { kind: 'nullable', inner: { kind: 'array', items: { kind: 'model', name: 'Pet' } } };
    const ref = { $ref: '#/components/schemas/Pet' };

    expect(classifyAndExtractResponse({ type: ['array', 'null'], items: ref }, 'ListPetsResponse').response).toEqual(
      expected,
    );
    expect(
      classifyAndExtractResponse({ type: 'array', nullable: true, items: ref }, 'ListPetsResponse').response,
    ).toEqual(expected);
  });

  it('materializes the inline object variants of `items.oneOf`, typed or not', () => {
    const untyped = classifyAndExtractResponse({ items: shapeVariants }, 'ListShapesResponse');
    const typed = classifyAndExtractResponse({ type: 'array', items: shapeVariants }, 'ListShapesResponse');

    expect(untyped.response).toEqual({
      kind: 'array',
      items: {
        kind: 'union',
        variants: [
          { kind: 'model', name: 'ListShapesResponse' },
          { kind: 'model', name: 'ListShapesResponseWithSide' },
        ],
        compositionKind: 'oneOf',
      },
    });
    expect(untyped.inlineModels.map((m) => m.name)).toEqual(['ListShapesResponse', 'ListShapesResponseWithSide']);
    expect(untyped.inlineModels.map((m) => m.fields.map((f) => f.name))).toEqual([['radius'], ['side']]);
    expect(typed).toEqual(untyped);
  });

  it('materializes nullable object items under the name the array references', () => {
    const result = classifyAndExtractResponse(
      { items: { type: ['object', 'null'], properties: { name: { type: 'string' } } } },
      'ListPetsResponse',
    );

    expect(result.response).toEqual({
      kind: 'array',
      items: { kind: 'nullable', inner: { kind: 'model', name: 'ListPetsResponse' } },
    });
    expect(result.inlineModels.map((m) => m.name)).toEqual(['ListPetsResponse']);
  });

  it('leaves a prefixItems-only tuple as unknown, referencing no model', () => {
    // No tuple support yet: without `items` the schema is not an array to
    // schemaToTypeRef, which types it `unknown` — unchanged by #238.
    const result = classifyAndExtractResponse(
      { prefixItems: [{ type: 'string' }, { type: 'integer' }] },
      'GetPairResponse',
    );

    expect(result).toEqual({ response: { kind: 'primitive', type: 'unknown' }, inlineModels: [], isPaginated: false });
  });
});

describe('classifyAndExtractResponse — list envelope whose data array has no type', () => {
  const eventItems = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  const envelope = (data: Record<string, unknown>) => ({
    type: 'object',
    properties: {
      data,
      list_metadata: { type: 'object', properties: { after: { type: 'string' } } },
    },
    required: ['data', 'list_metadata'],
  });

  it('detects the envelope and extracts the item model exactly like a typed data array', () => {
    const untyped = classifyAndExtractResponse(envelope({ items: eventItems }), 'ListEventsResponse');
    const typed = classifyAndExtractResponse(envelope({ type: 'array', items: eventItems }), 'ListEventsResponse');

    expect(untyped.isPaginated).toBe(true);
    expect(untyped.dataPath).toBe('data');
    expect(untyped.itemType).toEqual({ kind: 'model', name: 'ListEventsItem' });
    expect(untyped.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'ListEventsItem' } });
    expect(untyped.inlineModels.map((m) => m.name)).toEqual(['ListEventsItem']);
    expect(untyped.envelopeFields?.map((f) => f.name)).toEqual(['list_metadata']);
    expect(untyped).toEqual(typed);
  });

  it('detects a nullable data array', () => {
    const result = classifyAndExtractResponse(
      envelope({ type: ['array', 'null'], items: { $ref: '#/components/schemas/Event' } }),
      'ListEventsResponse',
    );

    expect(result.isPaginated).toBe(true);
    expect(result.dataPath).toBe('data');
    expect(result.itemType).toEqual({ kind: 'model', name: 'Event' });
  });

  it('keeps the untyped data items when a later allOf branch only constrains the array', () => {
    const result = classifyAndExtractResponse(
      {
        allOf: [
          {
            type: 'object',
            properties: {
              data: { items: { $ref: '#/components/schemas/User' } },
              list_metadata: { $ref: '#/components/schemas/ListMetadata' },
            },
          },
          { type: 'object', properties: { data: { type: 'array', minItems: 1 } }, required: ['data'] },
        ],
      },
      'ListUsersResponse',
    );

    expect(result.isPaginated).toBe(true);
    expect(result.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'User' } });
    expect(result.itemType).toEqual({ kind: 'model', name: 'User' });
  });
});

describe('parseSpec — arrays without type', () => {
  let tmpDir: string;
  let warn: MockInstance<typeof console.warn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-untyped-array-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, `spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  function warnings(): string[] {
    return warn.mock.calls.map((call) => String(call[0]));
  }

  function operation(ir: ApiSpec, name: string): Operation {
    const op = ir.services.flatMap((s) => s.operations).find((o) => o.name === name);
    if (!op) throw new Error(`operation ${name} not found`);
    return op;
  }

  /** Every model reference reachable from the IR that no model or enum answers to. */
  function danglingRefs(ir: ApiSpec): string[] {
    const known = new Set([...ir.models.map((m) => m.name), ...ir.enums.map((e) => e.name)]);
    const dangling: string[] = [];
    const check = (ref: TypeRef | undefined, context: string): void => {
      if (!ref) return;
      for (const name of collectModelRefs(ref)) if (!known.has(name)) dangling.push(`${context} -> ${name}`);
    };
    for (const model of ir.models) for (const field of model.fields) check(field.type, `${model.name}.${field.name}`);
    for (const service of ir.services) {
      for (const op of service.operations) {
        check(op.response, `${op.name}.response`);
        check(op.requestBody, `${op.name}.requestBody`);
        for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams])
          check(p.type, `${op.name}.${p.name}`);
        check(op.pagination?.itemType, `${op.name}.pagination.itemType`);
        for (const field of op.pagination?.envelopeFields ?? [])
          check(field.type, `${op.name}.pagination.${field.name}`);
        for (const r of op.successResponses ?? []) check(r.type, `${op.name}.${r.statusCode}`);
      }
    }
    return dangling;
  }

  const jsonResponse = (schema: unknown) => ({
    '200': { description: 'ok', content: { 'application/json': { schema } } },
  });

  it('creates the item model the response references (#238 repro)', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: { '/pets': { get: { operationId: 'listPets', responses: jsonResponse({ items: petItems }) } } },
      components: {},
    });
    const [op] = ir.services.flatMap(({ operations }) => operations);

    expect(op.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } });
    expect(ir.models.map((m) => m.name)).toEqual(['ListPetsItem']);
    expect(ir.models[0].fields).toEqual([
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ]);
    expect(warnings()).toEqual([]);
    expect(danglingRefs(ir)).toEqual([]);
  });

  it('paginates a list envelope whose data array has no type', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'envelope', version: '1' },
      paths: {
        '/events': {
          get: {
            operationId: 'listEvents',
            parameters: [
              { name: 'after', in: 'query', schema: { type: 'string' } },
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
            ],
            responses: jsonResponse({
              type: 'object',
              properties: {
                data: { items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
                list_metadata: {
                  type: 'object',
                  properties: { after: { type: 'string' }, before: { type: 'string' } },
                },
              },
              required: ['data', 'list_metadata'],
            }),
          },
        },
      },
    });
    const op = operation(ir, 'listEvents');

    expect(op.pagination).toMatchObject({
      strategy: 'cursor',
      param: 'after',
      dataPath: 'data',
      itemType: { kind: 'model', name: 'ListEventsItem' },
    });
    expect(op.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'ListEventsItem' } });
    expect(ir.models.map((m) => m.name)).toContain('ListEventsItem');
    expect(warnings()).toEqual([]);
    expect(danglingRefs(ir)).toEqual([]);
  });

  /** The same document with `type: 'array'` spelled out beside every bare `items`. */
  function withArrayTypes<T>(doc: T): T {
    const walk = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) copy[key] = walk(value);
        if ('items' in record && !('type' in record) && !('$ref' in record)) copy.type = 'array';
        return copy;
      }
      return node;
    };
    return walk(doc) as T;
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

  it('parses every untyped array exactly as if `type: array` were spelled out', async () => {
    const doc = {
      openapi: '3.1.0',
      info: { title: 'untyped arrays', version: '1' },
      paths: {
        '/pets': { get: { operationId: 'listPets', responses: jsonResponse({ items: petItems }) } },
        '/refs': {
          get: { operationId: 'listRefs', responses: jsonResponse({ items: { $ref: '#/components/schemas/Pet' } }) },
        },
        '/nullable': {
          get: { operationId: 'listNullable', responses: jsonResponse({ type: ['array', 'null'], items: petItems }) },
        },
        '/shapes': { get: { operationId: 'listShapes', responses: jsonResponse({ items: shapeVariants }) } },
        '/nullable-items': {
          get: {
            operationId: 'listNullableItems',
            responses: jsonResponse({ items: { type: ['object', 'null'], properties: { name: { type: 'string' } } } }),
          },
        },
        '/events': {
          get: {
            operationId: 'listEvents',
            parameters: [
              { name: 'after', in: 'query', schema: { type: 'string' } },
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
            ],
            responses: jsonResponse({
              type: 'object',
              properties: {
                data: { items: { type: 'object', properties: { id: { type: 'string' } } } },
                list_metadata: { type: 'object', properties: { after: { type: 'string' } } },
              },
            }),
          },
        },
        '/profile': {
          get: {
            operationId: 'getProfile',
            responses: jsonResponse({
              type: 'object',
              properties: { tags: { items: { type: 'object', properties: { label: { type: 'string' } } } } },
            }),
          },
          post: {
            operationId: 'createProfile',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { tags: { items: { type: 'object', properties: { label: { type: 'string' } } } } },
                  },
                },
              },
            },
            responses: { '204': { description: 'ok' } },
          },
        },
      },
      components: {
        schemas: {
          Pet: { type: 'object', properties: { name: { type: 'string' } } },
          Owner: {
            type: 'object',
            properties: { pets: { items: { type: 'object', properties: { nick: { type: 'string' } } } } },
          },
        },
      },
    };

    const untyped = await parseJson(doc);
    const typed = await parseJson(withArrayTypes(doc));

    expect(warnings()).toEqual([]);
    expect(danglingRefs(untyped)).toEqual([]);
    expect(untyped.services).toEqual(typed.services);
    expect(untyped.enums).toEqual(typed.enums);
    // Sorted: a component field's item model is created by a different pass
    // when the array is typed, which places it earlier in the list.
    expect([...untyped.models].sort(byName)).toEqual([...typed.models].sort(byName));
    expect(untyped.models.map((m) => m.name).sort()).toEqual(
      [
        'Pet',
        'Owner',
        'OwnerPets',
        'ListPetsItem',
        'ListNullableItem',
        'ListShapesResponse',
        'ListShapesResponseWithSide',
        'ListNullableItemsResponse',
        'ListEventsItem',
        'ListMetadata',
        'GetProfileResponse',
        'GetProfileResponseTags',
        'CreateProfileRequest',
        'CreateProfileRequestTags',
      ].sort(),
    );
  });
});
