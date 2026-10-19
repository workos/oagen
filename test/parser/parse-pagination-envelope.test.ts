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

  async function parseJson(doc: unknown, options?: Parameters<typeof parseSpec>[1]): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile, options);
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
      strategy: 'page',
      param: 'page',
      limitParam: 'limit',
      dataPath: 'customers',
      itemType: { kind: 'model', name: 'Customer' },
      envelopeFields: [{ name: 'pagination', type: { kind: 'model', name: 'Pagination' }, required: true }],
      endOfIteration: { kind: 'totalPages', path: 'pagination.totalPages' },
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

  it('promotes an inline enum companion to a top-level enum, qualified by operation like a parameter enum', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/items': listOp({}, 'listThings', offsetParams, {
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
      name: 'ListThingsSortOrder',
    });
    expect(ir.enums.find((e) => e.name === 'ListThingsSortOrder')?.values.map((v) => v.value)).toEqual(['asc', 'desc']);
  });

  it("keeps two endpoints' same-named enum companions apart when their values differ", async () => {
    const envelope = (values: string[]) => ({
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
        total: { type: 'integer' },
        sort_order: { type: 'string', enum: values },
      },
    });
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/items': listOp({}, 'listThings', offsetParams, envelope(['asc', 'desc'])),
        '/events': listOp({}, 'listEvents', offsetParams, envelope(['newest', 'oldest'])),
      },
      components: { schemas: { Item: { type: 'object', properties: { id: { type: 'string' } } } } },
    });

    const byName = Object.fromEntries(ir.enums.map((e) => [e.name, e.values.map((v) => v.value)]));
    expect(byName).toEqual({ ListThingsSortOrder: ['asc', 'desc'], ListEventsSortOrder: ['newest', 'oldest'] });
  });

  it('keeps a divergent companion apart under its operation name while the common shape stays bare', async () => {
    const envelope = (pagination: Record<string, unknown>) => ({
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
        pagination: { type: 'object', properties: pagination },
      },
    });
    const cursor = { next: { type: 'string' } };
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/a': listOp({}, 'listA', offsetParams, envelope(cursor)),
        '/b': listOp({}, 'listB', offsetParams, envelope({ page: { type: 'integer' }, total: { type: 'integer' } })),
        '/c': listOp({}, 'listC', offsetParams, envelope(cursor)),
      },
      components: { schemas: { Item: { type: 'object', properties: { id: { type: 'string' } } } } },
    });

    const companionOf = (name: string) =>
      ir.services
        .flatMap((s) => s.operations)
        .find((o) => o.name === name)!
        .pagination!.envelopeFields!.find((f) => f.name === 'pagination')!.type;
    expect(companionOf('listA')).toEqual({ kind: 'model', name: 'Pagination' });
    expect(companionOf('listC')).toEqual({ kind: 'model', name: 'Pagination' });
    expect(companionOf('listB')).toEqual({ kind: 'model', name: 'ListBPagination' });

    const models = Object.fromEntries(ir.models.map((m) => [m.name, m.fields.map((f) => f.name)]));
    expect(models.Pagination).toEqual(['next']);
    expect(models.ListBPagination).toEqual(['page', 'total']);
    expect(ir.models.filter((m) => m.name === 'Pagination')).toHaveLength(1);
  });

  it('never overwrites an unrelated component that happens to share the companion name', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/customers': listOp({}, 'getCustomers', offsetParams, {
          type: 'object',
          properties: {
            customers: { type: 'array', items: { $ref: '#/components/schemas/Customer' } },
            pagination: {
              type: 'object',
              properties: { page: { type: 'number' }, total: { type: 'number' }, totalPages: { type: 'number' } },
            },
          },
        }),
      },
      components: {
        schemas: {
          Customer: { type: 'object', properties: { id: { type: 'string' } } },
          // Same name, one different field, fewer fields: the old "largest wins"
          // merge would have replaced it with the companion's shape.
          Pagination: { type: 'object', properties: { cursor: { type: 'string' } } },
        },
      },
    });

    const models = Object.fromEntries(ir.models.map((m) => [m.name, m.fields.map((f) => f.name)]));
    expect(models.Pagination).toEqual(['cursor']);
    expect(models.GetCustomersPagination).toEqual(['page', 'total', 'totalPages']);
    const [op] = ir.services.flatMap((s) => s.operations);
    expect(op.pagination?.envelopeFields).toEqual([
      { name: 'pagination', type: { kind: 'model', name: 'GetCustomersPagination' }, required: false },
    ]);
  });

  it("keeps a copy qualified when it shares the component's field names but not its types", async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/users': listOp({}, 'listUsers', [{ name: 'after', in: 'query', schema: { type: 'string' } }], {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
            // Same `after` / `before` names as the component, but numeric offsets.
            list_metadata: { type: 'object', properties: { after: { type: 'integer' }, before: { type: 'integer' } } },
          },
        }),
      },
      components: {
        schemas: {
          User: { type: 'object', properties: { id: { type: 'string' } } },
          ListMetadata: { type: 'object', properties: { after: { type: 'string' }, before: { type: 'string' } } },
        },
      },
    });

    const models = Object.fromEntries(
      ir.models.map((m) => [
        m.name,
        m.fields.map((f) => `${f.name}:${f.type.kind === 'primitive' ? f.type.type : f.type.kind}`),
      ]),
    );
    expect(models.ListMetadata).toEqual(['after:string', 'before:string']);
    expect(models.ListUsersListMetadata).toEqual(['after:integer', 'before:integer']);
    const [op] = ir.services.flatMap((s) => s.operations);
    expect(op.pagination?.envelopeFields?.find((f) => f.name === 'list_metadata')?.type).toEqual({
      kind: 'model',
      name: 'ListUsersListMetadata',
    });
  });

  it('recognizes a component the parser renamed, so a companion cannot overwrite it', async () => {
    const ir = await parseJson(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/customers': listOp({}, 'getCustomers', offsetParams, {
            type: 'object',
            properties: {
              customers: { type: 'array', items: { $ref: '#/components/schemas/Customer' } },
              pagination: {
                type: 'object',
                properties: { page: { type: 'number' }, total: { type: 'number' }, totalPages: { type: 'number' } },
              },
            },
          }),
        },
        components: {
          schemas: {
            Customer: { type: 'object', properties: { id: { type: 'string' } } },
            // Lands in the IR as `Pagination` once the consumer's transform strips the suffix.
            PaginationDto: { type: 'object', properties: { cursor: { type: 'string' } } },
          },
        },
      },
      { schemaNameTransform: (name) => (name.endsWith('Dto') ? name.slice(0, -3) : name) },
    );

    const models = Object.fromEntries(ir.models.map((m) => [m.name, m.fields.map((f) => f.name)]));
    expect(models.Pagination).toEqual(['cursor']);
    expect(models.GetCustomersPagination).toEqual(['page', 'total', 'totalPages']);
  });

  it('materializes every object variant of a oneOf companion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseJson({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/things': listOp({}, 'listThings', offsetParams, {
            type: 'object',
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
              meta: {
                oneOf: [
                  {
                    type: 'object',
                    properties: { kind: { type: 'string', const: 'cursor' }, next: { type: 'string' } },
                  },
                  {
                    type: 'object',
                    properties: { kind: { type: 'string', const: 'offset' }, page: { type: 'integer' } },
                  },
                ],
              },
            },
          }),
        },
        components: { schemas: { Item: { type: 'object', properties: { id: { type: 'string' } } } } },
      });

      const names = new Set(ir.models.map((m) => m.name));
      const [op] = ir.services.flatMap((s) => s.operations);
      const meta = op.pagination?.envelopeFields?.find((f) => f.name === 'meta')?.type;
      expect(meta?.kind).toBe('union');
      for (const variant of meta?.kind === 'union' ? meta.variants : []) {
        expect(variant.kind).toBe('model');
        if (variant.kind === 'model') expect(names.has(variant.name), variant.name).toBe(true);
      }
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Unresolved model reference'));
    } finally {
      warn.mockRestore();
    }
  });

  it('materializes a nullable companion object so its reference resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseJson({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/items': listOp({}, 'listThings', offsetParams, {
            type: 'object',
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
              pagination: { type: ['object', 'null'], properties: { page: { type: 'integer' } } },
            },
          }),
        },
        components: { schemas: { Item: { type: 'object', properties: { id: { type: 'string' } } } } },
      });

      const [op] = ir.services.flatMap((s) => s.operations);
      expect(op.pagination?.envelopeFields).toEqual([
        {
          name: 'pagination',
          type: { kind: 'nullable', inner: { kind: 'model', name: 'Pagination' } },
          required: false,
        },
      ]);
      expect(ir.models.find((m) => m.name === 'Pagination')?.fields.map((f) => f.name)).toEqual(['page']);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Unresolved model reference'));
    } finally {
      warn.mockRestore();
    }
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
