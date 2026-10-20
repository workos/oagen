import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * `PaginationMeta.dataDescription` end to end: the data array property's own
 * description reaches `Operation.pagination`, and is absent exactly where
 * `dataPath` is (#207).
 */
describe('parseSpec — pagination data description', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-parse-data-description-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  function listOp(operationId: string, parameters: unknown[], schema: unknown) {
    return {
      get: {
        operationId,
        parameters,
        responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
      },
    };
  }

  const pageParam = [{ name: 'page', in: 'query', schema: { type: 'integer' } }];
  const afterParam = [{ name: 'after', in: 'query', schema: { type: 'string' } }];

  it('keeps the data array property description on PaginationMeta (#207 repro)', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': listOp('listPets', pageParam, {
          type: 'object',
          properties: {
            pets: {
              description: 'The pets on this page, newest first.',
              type: 'array',
              items: { $ref: '#/components/schemas/Pet' },
            },
            pagination: { description: 'Where this page sits in the list.', $ref: '#/components/schemas/Pagination' },
          },
          required: ['pets', 'pagination'],
        }),
      },
      components: {
        schemas: {
          Pet: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          Pagination: {
            type: 'object',
            properties: { page: { type: 'integer' }, totalPages: { type: 'integer' } },
            required: ['page', 'totalPages'],
          },
        },
      },
    });

    const [operation] = ir.services.flatMap((s) => s.operations);
    expect(operation.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'Pet' } });
    expect(operation.pagination).toMatchObject({
      dataPath: 'pets',
      dataDescription: 'The pets on this page, newest first.',
      itemType: { kind: 'model', name: 'Pet' },
      envelopeFields: [
        {
          name: 'pagination',
          type: { kind: 'model', name: 'Pagination' },
          required: true,
          description: 'Where this page sits in the list.',
        },
      ],
    });
  });

  it('keeps it for an allOf-composed envelope whose $ref base describes the data key', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/users': listOp('listUsers', afterParam, {
          allOf: [
            { $ref: '#/components/schemas/ListResponse' },
            {
              type: 'object',
              properties: {
                data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
                list_metadata: { $ref: '#/components/schemas/ListMetadata' },
              },
              required: ['data', 'list_metadata'],
            },
          ],
        }),
      },
      components: {
        schemas: {
          User: { type: 'object', properties: { id: { type: 'string' } } },
          ListMetadata: { type: 'object', properties: { after: { type: ['string', 'null'] } } },
          ListResponse: {
            type: 'object',
            properties: {
              object: { type: 'string', const: 'list' },
              data: { type: 'array', description: 'The list of records for the current page.' },
            },
          },
        },
      },
    });

    const [operation] = ir.services.flatMap((s) => s.operations);
    expect(operation.pagination).toMatchObject({
      strategy: 'cursor',
      param: 'after',
      dataPath: 'data',
      dataDescription: 'The list of records for the current page.',
      itemType: { kind: 'model', name: 'User' },
    });
    expect(operation.pagination?.envelopeFields?.map((f) => f.name)).toEqual(['object', 'list_metadata']);
  });

  it('is absent, like dataPath, for a $ref list wrapper and for parameter-only pagination', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/wrapped': listOp('listWrapped', afterParam, { $ref: '#/components/schemas/UserList' }),
        '/bare': listOp('listBare', afterParam, {
          type: 'array',
          description: 'Every user, oldest first.',
          items: { $ref: '#/components/schemas/User' },
        }),
      },
      components: {
        schemas: {
          User: { type: 'object', properties: { id: { type: 'string' } } },
          UserList: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                description: 'The users on this page.',
                items: { $ref: '#/components/schemas/User' },
              },
              list_metadata: { type: 'object', properties: { after: { type: 'string' } } },
            },
          },
        },
      },
    });

    for (const op of ir.services.flatMap((s) => s.operations)) {
      expect(op.pagination, op.name).toBeDefined();
      expect(op.pagination?.dataPath, op.name).toBeUndefined();
      expect(op.pagination, op.name).not.toHaveProperty('dataDescription');
    }
    // The wrapper model's own data field still carries the description.
    const userList = ir.models.find((m) => m.name === 'UserList');
    expect(userList?.fields.find((f) => f.name === 'data')?.description).toBe('The users on this page.');
  });
});
