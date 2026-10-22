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
    // An untyped schema that also composes is read as the composition first.
    expect(isArraySchema({ items: petItems, oneOf: shapeVariants.oneOf })).toBe(false);
    expect(isArraySchema({ items: petItems, anyOf: shapeVariants.oneOf })).toBe(false);
    expect(isArraySchema({ items: petItems, allOf: [{ type: 'object', properties: {} }] })).toBe(false);
    expect(isArraySchema({ items: petItems, allOf: [{ $ref: '#/components/schemas/List' }] })).toBe(false);
    expect(isArraySchema({ items: petItems, allOf: [{ type: 'string' }] })).toBe(false);
    // A composition beside `type: 'array'` is read first too (`classifyInlineSchema`).
    expect(
      isArraySchema({ type: 'array', items: petItems, oneOf: [{ type: 'array', items: petItems }, { type: 'null' }] }),
    ).toBe(false);
    expect(isArraySchema({ type: 'array', items: petItems, anyOf: shapeVariants.oneOf })).toBe(false);
    expect(isArraySchema({ type: 'array', items: petItems, allOf: [{ $ref: '#/components/schemas/List' }] })).toBe(
      false,
    );
    // An allOf of bare limits — one member or several — types nothing and
    // falls through to the array branch in schemaToTypeRef; so does a oneOf of them.
    expect(isArraySchema({ items: petItems, allOf: [{ minItems: 1 }] })).toBe(true);
    expect(isArraySchema({ items: petItems, allOf: [{ minItems: 1 }, { maxItems: 10 }] })).toBe(true);
    expect(isArraySchema({ type: 'array', items: petItems, oneOf: [{ minItems: 1 }, { maxItems: 10 }] })).toBe(true);
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

  it('keeps a $ref item reference even when sibling properties sit beside the $ref', () => {
    // The reference wins, as in `schemaToTypeRef`: no `<Operation>Item` model
    // is built from the siblings alone, so the referenced fields are not lost.
    const refWithSiblings = { $ref: '#/components/schemas/Pet', properties: { label: { type: 'string' } } };
    const expected = {
      response: { kind: 'array', items: { kind: 'model', name: 'Pet' } } as TypeRef,
      inlineModels: [],
      isPaginated: false,
    };

    expect(classifyAndExtractResponse({ items: refWithSiblings }, 'ListPetsResponse')).toEqual(expected);
    expect(classifyAndExtractResponse({ type: 'array', items: refWithSiblings }, 'ListPetsResponse')).toEqual(expected);
    expect(classifyAndExtractResponse({ type: ['array', 'null'], items: refWithSiblings }, 'ListPetsResponse')).toEqual(
      {
        ...expected,
        response: { kind: 'nullable', inner: expected.response },
      },
    );
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

  it('reads a nullable array written as a oneOf beside `type: array` as the array it is, null kept', () => {
    // `{ type: 'array', items, oneOf: [{ type: 'array', items }, { type: 'null' }] }`
    // is a union to `classifyInlineSchema` — a nullable array to
    // `schemaToTypeRef` — whether or not `type: 'array'` is spelled out. The
    // response path reads the array under the wrapper (`arraySchemaOf`,
    // #282), so the items are `<Op>Item` as under `type: ['array', 'null']`
    // and the null is kept.
    for (const type of ['array', undefined]) {
      const result = classifyAndExtractResponse(
        { ...(type && { type }), items: petItems, oneOf: [{ type: 'array', items: petItems }, { type: 'null' }] },
        'ListPetsResponse',
      );
      expect(result.response, String(type)).toEqual({
        kind: 'nullable',
        inner: { kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } },
      });
      expect(result.inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
        ['ListPetsItem', ['name']],
      ]);
    }
  });

  it('materializes the inline object variants of `items.oneOf` under `<Op>Item`, typed or not', () => {
    const untyped = classifyAndExtractResponse({ items: shapeVariants }, 'ListShapesResponse');
    const typed = classifyAndExtractResponse({ type: 'array', items: shapeVariants }, 'ListShapesResponse');

    // The items of an array body are typed as `<Op>Item` whatever their
    // shape (#282: `typeInlineItems`), as a list envelope's data items are.
    expect(untyped.response).toEqual({
      kind: 'array',
      items: {
        kind: 'union',
        variants: [
          { kind: 'model', name: 'ListShapesItem' },
          { kind: 'model', name: 'ListShapesItemWithSide' },
        ],
        compositionKind: 'oneOf',
      },
    });
    expect(untyped.inlineModels.map((m) => m.name)).toEqual(['ListShapesItem', 'ListShapesItemWithSide']);
    expect(untyped.inlineModels.map((m) => m.fields.map((f) => f.name))).toEqual([['radius'], ['side']]);
    expect(typed).toEqual(untyped);
  });

  it('materializes nullable object items under `<Op>Item`, the name the array references', () => {
    const result = classifyAndExtractResponse(
      { items: { type: ['object', 'null'], properties: { name: { type: 'string' } } } },
      'ListPetsResponse',
    );

    expect(result.response).toEqual({
      kind: 'array',
      items: { kind: 'nullable', inner: { kind: 'model', name: 'ListPetsItem' } },
    });
    expect(result.inlineModels.map((m) => m.name)).toEqual(['ListPetsItem']);
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

  it('detects a nullable data array and keeps its null on the response, with the element as the item type', () => {
    const result = classifyAndExtractResponse(
      envelope({ type: ['array', 'null'], items: { $ref: '#/components/schemas/Event' } }),
      'ListEventsResponse',
    );

    expect(result.isPaginated).toBe(true);
    expect(result.dataPath).toBe('data');
    expect(result.itemType).toEqual({ kind: 'model', name: 'Event' });
    // `envelopeFields` leaves `data` out, so the response is the one place
    // that records the list may be null.
    expect(result.response).toEqual({
      kind: 'nullable',
      inner: { kind: 'array', items: { kind: 'model', name: 'Event' } },
    });
    expect(result.envelopeFields?.map((f) => f.name)).toEqual(['list_metadata']);

    // The OAS 3.0 spelling yields the same IR; a plain data array stays plain.
    const oas30 = classifyAndExtractResponse(
      envelope({ type: 'array', nullable: true, items: { $ref: '#/components/schemas/Event' } }),
      'ListEventsResponse',
    );
    expect(oas30).toEqual(result);
    expect(
      classifyAndExtractResponse(envelope({ items: { $ref: '#/components/schemas/Event' } }), 'ListEventsResponse')
        .response,
    ).toEqual({ kind: 'array', items: { kind: 'model', name: 'Event' } });
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

  it('types primitive data items instead of defaulting to string, typed or not', () => {
    const untyped = classifyAndExtractResponse(envelope({ items: { type: 'integer' } }), 'ListCountsResponse');
    const typed = classifyAndExtractResponse(
      envelope({ type: 'array', items: { type: 'integer' } }),
      'ListCountsResponse',
    );

    expect(untyped.isPaginated).toBe(true);
    expect(untyped.response).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'integer' } });
    expect(untyped.itemType).toEqual({ kind: 'primitive', type: 'integer' });
    expect(untyped.inlineModels).toEqual([]);
    expect(untyped).toEqual(typed);
  });

  it('types enum, oneOf, nested-array, nullable-object and untyped-object data items under `<Operation>Item`', () => {
    const cases: Array<{ label: string; items: Record<string, unknown>; itemType: TypeRef; models: string[] }> = [
      {
        label: 'inline enum',
        items: { type: 'string', enum: ['a', 'b'] },
        itemType: { kind: 'enum', name: 'ListEventsItem', values: ['a', 'b'] },
        models: [],
      },
      {
        label: 'oneOf of inline objects',
        items: shapeVariants,
        itemType: {
          kind: 'union',
          variants: [
            { kind: 'model', name: 'ListEventsItem' },
            { kind: 'model', name: 'ListEventsItemWithSide' },
          ],
          compositionKind: 'oneOf',
        },
        models: ['ListEventsItem', 'ListEventsItemWithSide'],
      },
      {
        label: 'nested array of objects',
        items: { type: 'array', items: eventItems },
        itemType: { kind: 'array', items: { kind: 'model', name: 'ListEventsItem' } },
        models: ['ListEventsItem'],
      },
      {
        label: 'nullable object',
        items: { type: ['object', 'null'], properties: { id: { type: 'string' } } },
        itemType: { kind: 'nullable', inner: { kind: 'model', name: 'ListEventsItem' } },
        models: ['ListEventsItem'],
      },
      {
        label: 'object without type',
        items: { properties: { id: { type: 'string' } } },
        itemType: { kind: 'model', name: 'ListEventsItem' },
        models: ['ListEventsItem'],
      },
    ];

    for (const { label, items, itemType, models } of cases) {
      const result = classifyAndExtractResponse(envelope({ items }), 'ListEventsResponse');
      expect(result.isPaginated, label).toBe(true);
      expect(result.itemType, label).toEqual(itemType);
      expect(result.response, label).toEqual({ kind: 'array', items: itemType });
      expect(
        result.inlineModels.map((m) => m.name),
        label,
      ).toEqual(models);
    }
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

  // A discriminated `oneOf` component: its variants' fields are typed under
  // the component, and a missing item model is recovered by the component
  // repair pass (`extractNestedSchema`).
  const shapeComponent = {
    oneOf: [
      {
        title: 'Circle',
        type: 'object',
        properties: {
          kind: { type: 'string', const: 'circle' },
          rings: { items: { type: 'object', properties: { r: { type: 'number' } } } },
        },
        required: ['kind'],
      },
      {
        title: 'Square',
        type: 'object',
        properties: { kind: { type: 'string', const: 'square' }, side: { type: 'number' } },
        required: ['kind'],
      },
    ],
    discriminator: { propertyName: 'kind' },
  };

  // An `allOf` base with a `oneOf` of const-discriminated variants: each
  // variant becomes its own model through `extractInlineModelDeep`.
  const eventComponent = {
    allOf: [
      { type: 'object', required: ['id', 'event'], properties: { id: { type: 'string' }, event: { type: 'string' } } },
      {
        oneOf: [
          {
            type: 'object',
            required: ['id', 'event'],
            properties: {
              id: { type: 'string' },
              event: { type: 'string', const: 'session.created' },
              tags: { items: { type: 'object', properties: { label: { type: 'string' } } } },
            },
          },
          {
            type: 'object',
            required: ['id', 'event'],
            properties: {
              id: { type: 'string' },
              event: { type: 'string', const: 'session.revoked' },
              reason: { type: 'string' },
            },
          },
        ],
      },
    ],
  };

  function model(ir: ApiSpec, name: string) {
    const found = ir.models.find((m) => m.name === name);
    if (!found) throw new Error(`model ${name} not found in ${ir.models.map((m) => m.name).join(', ')}`);
    return found;
  }

  it('creates the item model of an untyped array field inside a discriminated oneOf component', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'shapes', version: '1' },
      paths: {
        '/shape': { get: { operationId: 'getShape', responses: jsonResponse({ $ref: '#/components/schemas/Shape' }) } },
      },
      components: { schemas: { Shape: shapeComponent } },
    });

    expect(model(ir, 'Shape').fields.find((f) => f.name === 'rings')?.type).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'ShapeRing' },
    });
    expect(model(ir, 'ShapeRing').fields).toEqual([
      { name: 'r', type: { kind: 'primitive', type: 'number' }, required: false },
    ]);
    expect(warnings()).toEqual([]);
    expect(danglingRefs(ir)).toEqual([]);
  });

  it('creates the item model of an untyped array field inside a discriminated allOf variant', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'events', version: '1' },
      paths: {
        '/event': {
          get: { operationId: 'getEvent', responses: jsonResponse({ $ref: '#/components/schemas/EventSchema' }) },
        },
      },
      components: { schemas: { EventSchema: eventComponent } },
    });

    expect(model(ir, 'SessionCreated').fields.find((f) => f.name === 'tags')?.type).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'SessionCreatedTags' },
    });
    expect(model(ir, 'SessionCreatedTags').fields).toEqual([
      { name: 'label', type: { kind: 'primitive', type: 'string' }, required: false },
    ]);
    expect(warnings()).toEqual([]);
    expect(danglingRefs(ir)).toEqual([]);
  });

  const cursorParams = [
    { name: 'after', in: 'query', schema: { type: 'string' } },
    { name: 'limit', in: 'query', schema: { type: 'integer' } },
  ];

  /** A cursor-paginated list operation whose untyped data array holds `items`. */
  const listOp = (operationId: string, items: unknown) => ({
    get: {
      operationId,
      parameters: cursorParams,
      responses: jsonResponse({
        type: 'object',
        properties: { data: { items }, list_metadata: { type: 'object', properties: { after: { type: 'string' } } } },
      }),
    },
  });

  it('reports the same item type on the response and on pagination for every envelope item shape', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'envelopes', version: '1' },
      paths: {
        '/counts': listOp('listCounts', { type: 'integer' }),
        '/levels': listOp('listLevels', { type: 'string', enum: ['low', 'high'] }),
        '/marks': listOp('listMarks', shapeVariants),
        '/grids': listOp('listGrids', {
          type: 'array',
          items: { type: 'object', properties: { x: { type: 'number' } } },
        }),
      },
    });

    const expected: Record<string, TypeRef> = {
      listCounts: { kind: 'primitive', type: 'integer' },
      listLevels: { kind: 'enum', name: 'ListLevelsItem', values: ['low', 'high'] },
      listMarks: {
        kind: 'union',
        variants: [
          { kind: 'model', name: 'ListMarksItem' },
          { kind: 'model', name: 'ListMarksItemWithSide' },
        ],
        compositionKind: 'oneOf',
      },
      listGrids: { kind: 'array', items: { kind: 'model', name: 'ListGridsItem' } },
    };
    for (const [name, itemType] of Object.entries(expected)) {
      const op = operation(ir, name);
      expect(op.response, name).toEqual({ kind: 'array', items: itemType });
      expect(op.pagination?.itemType, name).toEqual(itemType);
      expect(op.pagination?.dataPath, name).toBe('data');
    }
    expect(model(ir, 'ListGridsItem').fields.map((f) => f.name)).toEqual(['x']);
    expect(model(ir, 'ListMarksItem').fields.map((f) => f.name)).toEqual(['radius']);
    expect(model(ir, 'ListMarksItemWithSide').fields.map((f) => f.name)).toEqual(['side']);
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

  it('types an untyped field with both items and oneOf as the union, with the right fields (Greptile)', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/things': {
          post: {
            operationId: 'createThing',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      thing: {
                        items: { type: 'object', properties: { id: { type: 'string' } } },
                        oneOf: [{ type: 'object', properties: { message: { type: 'string' } } }, { type: 'array' }],
                      },
                    },
                  },
                },
              },
            },
            responses: { '204': { description: 'ok' } },
          },
        },
      },
      components: {},
    });
    const body = ir.models.find((m) => m.name === 'CreateThingRequest');
    const thing = body?.fields.find((f) => f.name === 'thing')?.type;
    expect(thing?.kind).toBe('union');
    const first = thing?.kind === 'union' ? thing.variants[0] : undefined;
    expect(first).toEqual({ kind: 'model', name: 'CreateThingRequestThing' });
    // The object alternative owns the name, not the `items` schema.
    expect(ir.models.find((m) => m.name === 'CreateThingRequestThing')?.fields.map((f) => f.name)).toEqual(['message']);
    expect(danglingRefs(ir)).toEqual([]);
  });

  it('creates the item model of an untyped array whose allOf only adds limits (Greptile)', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: jsonResponse({ items: petItems, allOf: [{ minItems: 1 }, { maxItems: 10 }] }),
          },
        },
      },
      components: {},
    });
    expect(operation(ir, 'listPets').response).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'ListPetsItem' },
    });
    expect(danglingRefs(ir)).toEqual([]);
  });

  it('iterates the items of a nullable array response, not the whole nullable array (Greptile)', async () => {
    const ir = await parseJson({
      openapi: '3.0.3',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
            responses: jsonResponse({ type: 'array', nullable: true, items: petItems }),
          },
        },
      },
      components: {},
    });
    const op = operation(ir, 'listPets');
    expect(op.response).toEqual({
      kind: 'nullable',
      inner: { kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } },
    });
    expect(op.pagination).toMatchObject({
      strategy: 'cursor',
      param: 'after',
      itemType: { kind: 'model', name: 'ListPetsItem' },
    });
    expect(danglingRefs(ir)).toEqual([]);
  });

  it('pages a list envelope whose data array is nullable by its items, keeping the null on the response (Greptile)', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
            responses: jsonResponse({
              type: 'object',
              properties: {
                data: { type: ['array', 'null'], items: petItems },
                list_metadata: { type: 'object', properties: { after: { type: 'string' } } },
              },
              required: ['data', 'list_metadata'],
            }),
          },
        },
      },
      components: {},
    });
    const op = operation(ir, 'listPets');
    expect(op.response).toEqual({
      kind: 'nullable',
      inner: { kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } },
    });
    expect(op.pagination).toMatchObject({
      strategy: 'cursor',
      param: 'after',
      dataPath: 'data',
      itemType: { kind: 'model', name: 'ListPetsItem' },
    });
    expect(danglingRefs(ir)).toEqual([]);
  });

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
        '/shape': {
          get: { operationId: 'getShape', responses: jsonResponse({ $ref: '#/components/schemas/Shape' }) },
        },
        '/event': {
          get: { operationId: 'getEvent', responses: jsonResponse({ $ref: '#/components/schemas/EventSchema' }) },
        },
        '/counts': listOp('listCounts', { type: 'integer' }),
        '/marks': listOp('listMarks', shapeVariants),
        '/pet-refs': {
          get: {
            operationId: 'listPetRefs',
            responses: jsonResponse({
              items: { $ref: '#/components/schemas/Pet', properties: { label: { type: 'string' } } },
            }),
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
          Shape: shapeComponent,
          EventSchema: eventComponent,
        },
      },
    };

    const untyped = await parseJson(doc);
    const typed = await parseJson(withArrayTypes(doc));

    expect(warnings()).toEqual([]);
    expect(danglingRefs(untyped)).toEqual([]);
    // Whole IR, models in document order included: the same passes create
    // the same models in the same places whether or not `type` is spelled out.
    expect(untyped.services).toEqual(typed.services);
    expect(untyped.enums).toEqual(typed.enums);
    expect(untyped.models).toEqual(typed.models);
    expect(untyped.models.map((m) => m.name).sort()).toEqual(
      [
        'Pet',
        'Owner',
        'OwnerPets',
        'Shape',
        'ShapeRing',
        // The named union's variants are materialized (#244), typed or not.
        'CircleShape',
        'CircleShapeRing',
        'SquareShape',
        'EventSchema',
        'SessionCreated',
        'SessionCreatedTags',
        'SessionRevoked',
        'ListPetsItem',
        'ListNullableItem',
        // An array body's items are `<Op>Item` whatever their shape (#282).
        'ListShapesItem',
        'ListShapesItemWithSide',
        'ListNullableItemsItem',
        'ListEventsItem',
        'ListMarksItem',
        'ListMarksItemWithSide',
        'ListMetadata',
        'GetProfileResponse',
        'GetProfileResponseTags',
        'CreateProfileRequest',
        'CreateProfileRequestTags',
      ].sort(),
    );
  });
});
