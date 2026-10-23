import { describe, it, expect } from 'vitest';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

/**
 * Covers `envelopeFields` on the list-envelope path of `classifyAndExtractResponse`:
 * everything a list response carries besides the data array must survive into
 * the IR so an emitter can type the envelope and read its page details (#183).
 *
 * At this level a lifted companion model is still operation-qualified and
 * travels in `envelopeCompanions`, not `inlineModels`; the bare name it may
 * collapse to is recorded beside it for `resolveEnvelopeCompanionNames`.
 */
describe('classifyAndExtractResponse — list envelope companion fields', () => {
  it('keeps a $ref companion as a model-typed field next to dataPath', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          customers: { type: 'array', items: { $ref: '#/components/schemas/Customer' } },
          pagination: { $ref: '#/components/schemas/Pagination' },
        },
        required: ['customers', 'pagination'],
      },
      'GetCustomersResponse',
    );

    expect(result.isPaginated).toBe(true);
    expect(result.dataPath).toBe('customers');
    expect(result.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'Customer' } });
    expect(result.envelopeFields).toEqual([
      { name: 'pagination', type: { kind: 'model', name: 'Pagination' }, required: true },
    ]);
    // A $ref companion lifts nothing.
    expect(result.inlineModels).toEqual([]);
    expect(result.envelopeCompanions).toBeUndefined();
  });

  it('lifts an inline companion object under the operation name, remembering its bare name', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
          list_metadata: {
            type: 'object',
            description: 'Cursors.',
            properties: {
              before: { type: ['string', 'null'] },
              after: { type: ['string', 'null'] },
            },
          },
        },
      },
      'ListUsersResponse',
    );

    const [field] = result.envelopeFields!;
    expect(field).toMatchObject({
      name: 'list_metadata',
      type: { kind: 'model', name: 'ListUsersListMetadata' },
      required: false,
      description: 'Cursors.',
    });
    expect(result.inlineModels).toEqual([]);
    expect(result.envelopeCompanions).toHaveLength(1);
    const [companion] = result.envelopeCompanions!;
    // The field object is shared by identity so a later rename reaches the operation.
    expect(companion.field).toBe(field);
    expect(companion.models.map((m) => m.name)).toEqual(['ListUsersListMetadata']);
    expect(companion.models[0].fields.map((f) => f.name)).toEqual(['before', 'after']);
    expect(companion.bareNames).toEqual(['ListMetadata']);
  });

  it('extracts objects nested inside an inline companion, qualified and bare alike', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Issue' } },
          pagination: {
            type: 'object',
            properties: {
              page: { type: 'integer' },
              links: { type: 'object', properties: { next: { type: 'string' } } },
            },
          },
        },
      },
      'ListIssuesResponse',
    );

    const [companion] = result.envelopeCompanions!;
    expect(companion.models.map((m) => m.name)).toEqual(['ListIssuesPagination', 'ListIssuesPaginationLink']);
    expect(companion.bareNames).toEqual(['Pagination', 'PaginationLink']);
    expect(companion.models[0].fields.find((f) => f.name === 'links')?.type).toEqual({
      kind: 'model',
      name: 'ListIssuesPaginationLink',
    });
  });

  it('lifts a nullable companion object and an anyOf object-or-null companion', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Issue' } },
          pagination: { type: ['object', 'null'], properties: { page: { type: 'integer' } } },
          meta: { anyOf: [{ type: 'object', properties: { total: { type: 'integer' } } }, { type: 'null' }] },
        },
      },
      'ListIssuesResponse',
    );

    expect(result.envelopeFields).toEqual([
      {
        name: 'pagination',
        type: { kind: 'nullable', inner: { kind: 'model', name: 'ListIssuesPagination' } },
        required: false,
      },
      { name: 'meta', type: { kind: 'nullable', inner: { kind: 'model', name: 'ListIssuesMeta' } }, required: false },
    ]);
    // Both references have a model behind them.
    expect(result.envelopeCompanions!.map((c) => c.models.map((m) => m.name))).toEqual([
      ['ListIssuesPagination'],
      ['ListIssuesMeta'],
    ]);
  });

  it('keeps every companion of a flat envelope; an inline enum is qualified like a parameter enum', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
          total: { type: 'integer', description: 'Total matches.' },
          has_more: { type: 'boolean' },
          sort: { type: 'string', enum: ['asc', 'desc'] },
        },
        required: ['items', 'total'],
      },
      'ListThingsResponse',
    );

    expect(result.envelopeFields).toEqual([
      { name: 'total', type: { kind: 'primitive', type: 'integer' }, required: true, description: 'Total matches.' },
      { name: 'has_more', type: { kind: 'primitive', type: 'boolean' }, required: false },
      { name: 'sort', type: { kind: 'enum', name: 'ListThingsSort', values: ['asc', 'desc'] }, required: false },
    ]);
    expect(result.envelopeCompanions).toBeUndefined();
  });

  it('never lists the data array among the companions', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          results: { type: 'array', items: { $ref: '#/components/schemas/Repo' } },
          meta: { type: 'object', properties: { next_cursor: { type: 'string' } } },
        },
      },
      'ListReposResponse',
    );

    expect(result.envelopeFields?.map((f) => f.name)).toEqual(['meta']);
  });

  it('merges companions and required lists across allOf branches', () => {
    const result = classifyAndExtractResponse(
      {
        allOf: [
          {
            type: 'object',
            properties: {
              object: { type: 'string', const: 'list', description: 'Indicates this is a list response.' },
              list_metadata: { $ref: '#/components/schemas/ListMetadata' },
            },
          },
          {
            type: 'object',
            properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Connection' } } },
            required: ['data', 'list_metadata'],
          },
        ],
      },
      'ListConnectionsResponse',
    );

    expect(result.dataPath).toBe('data');
    expect(result.envelopeFields).toEqual([
      {
        name: 'object',
        type: { kind: 'literal', value: 'list' },
        required: false,
        description: 'Indicates this is a list response.',
      },
      { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
    ]);
  });

  it('includes companions an allOf $ref branch contributes, with their required flags', () => {
    const componentSchemas = {
      ResponseBase: {
        type: 'object',
        properties: { trace_id: { type: 'string' } },
        required: ['trace_id'],
      },
    };
    const result = classifyAndExtractResponse(
      {
        allOf: [
          { $ref: '#/components/schemas/ResponseBase' },
          {
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/Thing' } },
              total: { type: 'integer' },
            },
          },
        ],
      },
      'ListThingsResponse',
      componentSchemas,
    );

    expect(result.isPaginated).toBe(true);
    expect(result.envelopeFields).toEqual([
      { name: 'trace_id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'total', type: { kind: 'primitive', type: 'integer' }, required: false },
    ]);
  });

  it('combines a companion object declared by more than one allOf branch', () => {
    const result = classifyAndExtractResponse(
      {
        allOf: [
          {
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/Thing' } },
              pagination: { type: 'object', properties: { next: { type: 'string' } }, required: ['next'] },
            },
          },
          {
            type: 'object',
            properties: {
              pagination: { type: 'object', properties: { total: { type: 'integer' } } },
            },
          },
        ],
      },
      'ListThingsResponse',
    );

    const [companion] = result.envelopeCompanions!;
    expect(companion.models[0].fields.map((f) => `${f.name}${f.required ? '!' : ''}`)).toEqual(['next!', 'total']);
  });

  it('keeps the data array item type when a later allOf branch only constrains the array', () => {
    const result = classifyAndExtractResponse(
      {
        allOf: [
          {
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
              list_metadata: { $ref: '#/components/schemas/ListMetadata' },
            },
          },
          { type: 'object', properties: { data: { type: 'array', minItems: 1 } }, required: ['data'] },
        ],
      },
      'ListUsersResponse',
    );

    expect(result.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'User' } });
    expect(result.itemType).toEqual({ kind: 'model', name: 'User' });
    expect(result.envelopeFields).toEqual([
      { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: false },
    ]);
  });

  it('keeps inline list items in inlineModels and companions beside them', () => {
    const result = classifyAndExtractResponse(
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
          page_info: { type: 'object', properties: { end_cursor: { type: 'string' } } },
        },
      },
      'ListNodesResponse',
    );

    expect(result.itemType).toEqual({ kind: 'model', name: 'ListNodesItem' });
    expect(result.inlineModels.map((m) => m.name)).toEqual(['ListNodesItem']);
    expect(result.envelopeFields).toEqual([
      { name: 'page_info', type: { kind: 'model', name: 'ListNodesPageInfo' }, required: false },
    ]);
    expect(result.envelopeCompanions![0].bareNames).toEqual(['PageInfo']);
  });

  it('leaves envelopeFields unset when the response is not a list envelope', () => {
    const direct = classifyAndExtractResponse(
      { type: 'object', properties: { object: { type: 'string', const: 'user' }, id: { type: 'string' } } },
      'GetUserResponse',
    );
    expect(direct.isPaginated).toBe(false);
    expect(direct.envelopeFields).toBeUndefined();

    const ref = classifyAndExtractResponse({ $ref: '#/components/schemas/UserList' }, 'ListUsersResponse');
    expect(ref.envelopeFields).toBeUndefined();

    const bareArray = classifyAndExtractResponse(
      { type: 'array', items: { $ref: '#/components/schemas/User' } },
      'ListUsersResponse',
    );
    expect(bareArray.envelopeFields).toBeUndefined();
  });

  it('reads the companions once when an allOf member loops back, by reference or by identity (Greptile)', () => {
    const list = { type: 'array', items: { type: 'string' } };
    const expectRead = (result: ReturnType<typeof classifyAndExtractResponse>) => {
      expect(result.isPaginated).toBe(true);
      expect(result.dataPath).toBe('data');
      expect(result.envelopeFields).toEqual([
        { name: 'has_more', type: { kind: 'primitive', type: 'boolean' }, required: true },
      ]);
      expect(result.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });
    };

    // Greptile's cycle: `Base.allOf` holds a nullable reference back to `Base`,
    // and the envelope combines that wrapper with `{ data, has_more }`.
    const baseRef = { $ref: '#/components/schemas/Base' };
    const nullableBase = { oneOf: [baseRef, { type: 'null' }] };
    const companions = {
      type: 'object',
      properties: { data: list, has_more: { type: 'boolean' } },
      required: ['data', 'has_more'],
    };
    expectRead(
      classifyAndExtractResponse({ type: 'object', allOf: [nullableBase, companions] }, 'ListPetsResponse', {
        Base: { allOf: [nullableBase] },
      }),
    );

    // The same loop in the document's own objects: the nullable member is the
    // envelope itself, so the walk meets one object twice rather than one name.
    const envelope: SchemaObject = { type: 'object', allOf: [companions] };
    envelope.allOf!.unshift({ oneOf: [envelope, { type: 'null' }] });
    expectRead(classifyAndExtractResponse(envelope, 'ListPetsResponse'));
  });
});
