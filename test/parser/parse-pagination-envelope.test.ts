import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Operation } from '../../src/ir/types.js';

/**
 * End-to-end coverage for `PaginationMeta.envelopeFields` (#183): a list
 * response's pagination companion reaches `Operation.pagination` with a type an
 * emitter can resolve, and the models behind it survive every later pass.
 */
describe('parseSpec — pagination envelope fields', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-parse-envelope-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  function listOp(doc: Record<string, unknown>, operationId: string, parameters: unknown[], schema: unknown) {
    return {
      get: {
        operationId,
        parameters,
        responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
      },
      ...doc,
    };
  }

  const offsetParams = [
    { name: 'page', in: 'query', schema: { type: 'number', default: 1 } },
    { name: 'limit', in: 'query', schema: { type: 'number', default: 10 } },
  ];

  it('keeps the companion on PaginationMeta with the model it references (#183 repro)', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/customers': listOp({}, 'getCustomers', offsetParams, {
          type: 'object',
          properties: {
            customers: { type: 'array', items: { $ref: '#/components/schemas/Customer' } },
            pagination: { $ref: '#/components/schemas/Pagination' },
          },
          required: ['customers', 'pagination'],
        }),
      },
      components: {
        schemas: {
          Customer: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          Pagination: {
            type: 'object',
            properties: { page: { type: 'number' }, total: { type: 'number' }, totalPages: { type: 'number' } },
            required: ['page', 'total', 'totalPages'],
          },
        },
      },
    });

    const [operation] = ir.services.flatMap((s) => s.operations);
    expect(operation.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'Customer' } });
    expect(operation.pagination).toEqual({
      strategy: 'offset',
      param: 'page',
      limitParam: 'limit',
      dataPath: 'customers',
      itemType: { kind: 'model', name: 'Customer' },
      envelopeFields: [{ name: 'pagination', type: { kind: 'model', name: 'Pagination' }, required: true }],
    });
    expect(ir.models.map((m) => m.name)).toContain('Pagination');
  });

  it('collapses the inline companion shared by every list endpoint onto one model', async () => {
    const listMetadata = {
      type: 'object',
      properties: { before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] } },
    };
    const envelope = (item: string) => ({
      allOf: [
        { type: 'object', properties: { object: { type: 'string', const: 'list' }, list_metadata: listMetadata } },
        { type: 'object', properties: { data: { type: 'array', items: { $ref: `#/components/schemas/${item}` } } } },
      ],
    });
    const cursorParams = [{ name: 'after', in: 'query', schema: { type: 'string' } }];

    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/users': listOp({}, 'listUsers', cursorParams, envelope('User')),
        '/orgs': listOp({}, 'listOrganizations', cursorParams, envelope('Organization')),
      },
      components: {
        schemas: {
          User: { type: 'object', properties: { id: { type: 'string' } } },
          Organization: { type: 'object', properties: { id: { type: 'string' } } },
        },
      },
    });

    const operations = ir.services.flatMap((s) => s.operations);
    expect(operations).toHaveLength(2);
    for (const op of operations) {
      expect(op.pagination?.envelopeFields).toEqual([
        { name: 'object', type: { kind: 'literal', value: 'list' }, required: false },
        { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: false },
      ]);
    }
    expect(ir.models.filter((m) => m.name === 'ListMetadata')).toHaveLength(1);
    expect(ir.models.map((m) => m.name)).not.toContain('ListUsersListMetadata');
  });

  it('prefers the component schema when the document declares one of the same name', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/users': listOp({}, 'listUsers', [{ name: 'after', in: 'query', schema: { type: 'string' } }], {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
            list_metadata: { type: 'object', properties: { after: { type: ['string', 'null'] } } },
          },
        }),
      },
      components: {
        schemas: {
          User: { type: 'object', properties: { id: { type: 'string' } } },
          ListMetadata: {
            description: 'Cursor-based pagination metadata.',
            type: 'object',
            properties: { before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] } },
          },
        },
      },
    });

    const listMetadata = ir.models.filter((m) => m.name === 'ListMetadata');
    expect(listMetadata).toHaveLength(1);
    expect(listMetadata[0].description).toBe('Cursor-based pagination metadata.');
    expect(listMetadata[0].fields.map((f) => f.name)).toEqual(['before', 'after']);
  });

  it('promotes an inline enum companion to a top-level enum', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/items': listOp({}, 'listItems', offsetParams, {
          type: 'object',
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
            total: { type: 'integer' },
            sort_order: { type: 'string', enum: ['asc', 'desc'] },
          },
        }),
      },
      components: { schemas: { Item: { type: 'object', properties: { id: { type: 'string' } } } } },
    });

    const [op] = ir.services.flatMap((s) => s.operations);
    expect(op.pagination?.envelopeFields?.find((f) => f.name === 'sort_order')?.type).toMatchObject({
      kind: 'enum',
      name: 'SortOrder',
    });
    expect(ir.enums.find((e) => e.name === 'SortOrder')?.values.map((v) => v.value)).toEqual(['asc', 'desc']);
  });

  it('leaves envelopeFields unset for a $ref list wrapper and for parameter-only pagination', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/wrapped': listOp({}, 'listWrapped', [{ name: 'after', in: 'query', schema: { type: 'string' } }], {
          $ref: '#/components/schemas/UserList',
        }),
        '/bare': listOp({}, 'listBare', [{ name: 'after', in: 'query', schema: { type: 'string' } }], {
          type: 'array',
          items: { $ref: '#/components/schemas/User' },
        }),
      },
      components: {
        schemas: {
          User: { type: 'object', properties: { id: { type: 'string' } } },
          UserList: {
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
              list_metadata: { type: 'object', properties: { after: { type: 'string' } } },
            },
          },
        },
      },
    });

    for (const op of ir.services.flatMap((s) => s.operations)) {
      expect(op.pagination, op.name).toBeDefined();
      expect(op.pagination?.envelopeFields, op.name).toBeUndefined();
    }
  });
});

describe('validateModelRefs — pagination envelope fields', () => {
  const op = (over: Partial<Operation>): Operation => ({
    name: 'list',
    httpMethod: 'get',
    path: '/things',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'array', items: { kind: 'model', name: 'Thing' } },
    errors: [],
    injectIdempotencyKey: false,
    ...over,
  });

  const spec = (operations: Operation[]): ApiSpec => ({
    name: 'test',
    version: '1.0.0',
    baseUrl: 'https://api.example.com',
    services: [{ name: 'Things', operations }],
    models: [{ name: 'Thing', fields: [] }],
    enums: [],
    sdk: defaultSdkBehavior(),
  });

  it('warns about a companion whose model does not exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      validateModelRefs(
        spec([
          op({
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Thing' },
              envelopeFields: [{ name: 'meta', type: { kind: 'model', name: 'Missing' }, required: false }],
            },
          }),
        ]),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Missing" (context: Things.list.pagination.meta)'));
    } finally {
      warn.mockRestore();
    }
  });
});
