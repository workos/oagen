import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractSchemas, extractConstraints, clearSchemaNameTransform } from '../../src/parser/schemas.js';
import { extractOperations } from '../../src/parser/operations.js';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { Model } from '../../src/ir/types.js';

describe('extractConstraints', () => {
  it('takes the single non-null branch’s keywords from a nullable oneOf/anyOf wrapper', () => {
    expect(extractConstraints({ anyOf: [{ type: 'string', maxLength: 8 }, { type: 'null' }] })).toEqual({
      maxLength: 8,
    });
    expect(extractConstraints({ oneOf: [{ type: ['null'] }, { type: 'integer', minimum: 1 }] })).toEqual({
      minimum: 1,
    });
  });

  it('lets a wrapper’s own keywords win over its branch and ignores a $ref branch', () => {
    expect(extractConstraints({ maxLength: 4, anyOf: [{ type: 'string', maxLength: 8 }, { type: 'null' }] })).toEqual({
      maxLength: 4,
    });
    expect(
      extractConstraints({ anyOf: [{ $ref: '#/components/schemas/Name', maxLength: 8 }, { type: 'null' }] }),
    ).toBeUndefined();
  });

  it('carries nothing for a general multi-variant union', () => {
    expect(
      extractConstraints({
        oneOf: [
          { type: 'string', maxLength: 8 },
          { type: 'integer', minimum: 1 },
        ],
      }),
    ).toBeUndefined();
    expect(
      extractConstraints({
        anyOf: [{ type: 'string', maxLength: 8 }, { type: 'integer', minimum: 1 }, { type: 'null' }],
      }),
    ).toBeUndefined();
  });

  it('keeps a dependency named __proto__ as an own entry', () => {
    // Parsed from JSON the way a document arrives, so the key is an own
    // property of the input rather than an object-literal prototype slot.
    const schema = JSON.parse('{"dependentRequired":{"__proto__":["a"],"b":["c"]}}');
    const dependentRequired = extractConstraints(schema)?.dependentRequired ?? {};
    expect(Object.entries(dependentRequired)).toEqual([
      ['__proto__', ['a']],
      ['b', ['c']],
    ]);
    expect(Object.prototype.hasOwnProperty.call(dependentRequired, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(dependentRequired)).toBe(Object.prototype);
  });

  it('returns undefined for a schema with no validation keyword', () => {
    expect(
      extractConstraints({ type: 'string', format: 'uuid', description: 'An id', default: 'x', example: 'y' }),
    ).toBeUndefined();
    expect(extractConstraints({})).toBeUndefined();
  });

  it('carries every validation keyword', () => {
    expect(
      extractConstraints({
        minimum: 1,
        maximum: 10,
        multipleOf: 2,
        minLength: 3,
        maxLength: 8,
        pattern: '^[a-z]+$',
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
        minContains: 1,
        maxContains: 2,
        minProperties: 1,
        maxProperties: 4,
        dependentRequired: { credit_card: ['billing_address'] },
      }),
    ).toMatchInlineSnapshot(`
      {
        "dependentRequired": {
          "credit_card": [
            "billing_address",
          ],
        },
        "maxContains": 2,
        "maxItems": 5,
        "maxLength": 8,
        "maxProperties": 4,
        "maximum": 10,
        "minContains": 1,
        "minItems": 1,
        "minLength": 3,
        "minProperties": 1,
        "minimum": 1,
        "multipleOf": 2,
        "pattern": "^[a-z]+$",
        "uniqueItems": true,
      }
    `);
  });

  it('passes OAS 3.1 numeric exclusive bounds through unchanged', () => {
    expect(extractConstraints({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 })).toEqual({
      exclusiveMinimum: 0,
      exclusiveMaximum: 1,
    });
  });

  it('keeps both an inclusive and an exclusive bound on the same side (OAS 3.1)', () => {
    expect(extractConstraints({ type: 'integer', minimum: 0, exclusiveMinimum: -1 })).toEqual({
      minimum: 0,
      exclusiveMinimum: -1,
    });
  });

  it('normalizes the OAS 3.0 boolean exclusive form to the 3.1 shape', () => {
    expect(
      extractConstraints({
        type: 'integer',
        minimum: 0,
        exclusiveMinimum: true,
        maximum: 100,
        exclusiveMaximum: true,
      }),
    ).toEqual({ exclusiveMinimum: 0, exclusiveMaximum: 100 });
  });

  it('drops a false boolean exclusive flag and keeps the inclusive bound', () => {
    expect(
      extractConstraints({ type: 'integer', minimum: 0, exclusiveMinimum: false, maximum: 9, exclusiveMaximum: false }),
    ).toEqual({ minimum: 0, maximum: 9 });
  });

  it('drops a true exclusive flag that has no bound to apply to', () => {
    expect(extractConstraints({ type: 'integer', exclusiveMinimum: true, exclusiveMaximum: true })).toBeUndefined();
  });

  it('drops uniqueItems: false, an empty dependentRequired, and values of the wrong type', () => {
    expect(
      extractConstraints({
        type: 'array',
        uniqueItems: false,
        maxItems: '5' as never,
        pattern: 42 as never,
        dependentRequired: {},
      }),
    ).toBeUndefined();
    expect(extractConstraints({ dependentRequired: { a: ['b'], c: 'd' as never, e: [1] as never } })).toEqual({
      dependentRequired: { a: ['b'] },
    });
  });

  it('copies dependentRequired rather than aliasing the document', () => {
    const dependentRequired = { a: ['b'] };
    const constraints = extractConstraints({ dependentRequired });
    expect(constraints?.dependentRequired).toEqual(dependentRequired);
    expect(constraints?.dependentRequired).not.toBe(dependentRequired);
    expect(constraints?.dependentRequired?.a).not.toBe(dependentRequired.a);
  });
});

describe('extractSchemas – constraints', () => {
  afterEach(() => clearSchemaNameTransform());

  it('carries a discriminated allOf+oneOf variant’s own keywords, under the base object’s', () => {
    const { models } = extractSchemas({
      Event: {
        allOf: [
          { type: 'object', maxProperties: 10, properties: { id: { type: 'string' } }, required: ['id'] },
          {
            oneOf: [
              {
                type: 'object',
                minProperties: 2,
                dependentRequired: { note: ['id'] },
                properties: { event: { const: 'user.created' }, note: { type: 'string', maxLength: 80 } },
              },
              { type: 'object', properties: { event: { const: 'user.deleted' } } },
              { type: 'object', maxProperties: 3, properties: { event: { const: 'user.banned' } } },
            ],
          },
        ],
      },
    });
    const byName = new Map(models.map((m) => [m.name, m]));
    expect(byName.get('Event')?.discriminator).toEqual({
      property: 'event',
      mapping: { 'user.created': 'UserCreated', 'user.deleted': 'UserDeleted', 'user.banned': 'UserBanned' },
    });
    expect(byName.get('UserCreated')?.constraints).toEqual({
      maxProperties: 10,
      minProperties: 2,
      dependentRequired: { note: ['id'] },
    });
    expect(byName.get('UserCreated')?.fields.find((f) => f.name === 'note')?.constraints).toEqual({ maxLength: 80 });
    expect(byName.get('UserDeleted')?.constraints).toEqual({ maxProperties: 10 });
    expect(byName.get('UserBanned')?.constraints).toEqual({ maxProperties: 3 });
  });

  it('leaves a discriminated variant model without constraints when neither it nor the base declares any', () => {
    const { models } = extractSchemas({
      Event: {
        allOf: [
          { type: 'object', properties: { id: { type: 'string' } } },
          {
            oneOf: [
              { type: 'object', properties: { event: { const: 'user.created' } } },
              { type: 'object', properties: { event: { const: 'user.deleted' } } },
            ],
          },
        ],
      },
    });
    expect(models.find((m) => m.name === 'UserCreated')).not.toHaveProperty('constraints');
    expect(models.find((m) => m.name === 'UserDeleted')).not.toHaveProperty('constraints');
  });

  it('keeps the limits of a field spelled nullable via anyOf/oneOf with a null branch', () => {
    const { models } = extractSchemas({
      Thing: {
        type: 'object',
        properties: {
          nick: { anyOf: [{ type: 'string', maxLength: 8 }, { type: 'null' }] },
          count: { oneOf: [{ type: 'null' }, { type: 'integer', minimum: 1, maximum: 9 }] },
          either: {
            oneOf: [
              { type: 'string', maxLength: 8 },
              { type: 'integer', minimum: 1 },
            ],
          },
        },
      },
    });
    expect(models[0].fields.map((f) => [f.name, f.type.kind, f.constraints])).toEqual([
      ['nick', 'nullable', { maxLength: 8 }],
      ['count', 'nullable', { minimum: 1, maximum: 9 }],
      ['either', 'union', undefined],
    ]);
    expect(models[0].fields[2]).not.toHaveProperty('constraints');
  });

  it('keeps keywords written beside a field’s $ref (OAS 3.1 siblings)', () => {
    const { models } = extractSchemas({
      Name: { type: 'string', maxLength: 50 },
      Pet: {
        type: 'object',
        properties: {
          nickname: { $ref: '#/components/schemas/Name', minLength: 2 },
          name: { $ref: '#/components/schemas/Name' },
        },
      },
    });
    const pet = models.find((m) => m.name === 'Pet');
    expect(pet?.fields.map((f) => [f.name, f.constraints])).toEqual([
      ['nickname', { minLength: 2 }],
      ['name', undefined],
    ]);
    expect(pet?.fields[1]).not.toHaveProperty('constraints');
  });

  it('attaches a field’s own keywords and leaves the key absent on fields without any', () => {
    const { models } = extractSchemas({
      Pet: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 50, pattern: '^[A-Z]' },
          tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
          id: { type: 'string', format: 'uuid' },
        },
      },
    });
    const [pet] = models;
    expect(pet.fields.map((f) => [f.name, f.constraints])).toEqual([
      ['name', { minLength: 1, maxLength: 50, pattern: '^[A-Z]' }],
      ['tags', { minItems: 1, maxItems: 5 }],
      ['id', undefined],
    ]);
    expect(pet.fields[2]).not.toHaveProperty('constraints');
    expect(pet).not.toHaveProperty('constraints');
  });

  it('gives a $ref field no constraints — they live on the referenced model', () => {
    const { models } = extractSchemas({
      Owner: {
        type: 'object',
        minProperties: 1,
        maxProperties: 3,
        dependentRequired: { email: ['name'] },
        properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } },
      },
      Pet: {
        type: 'object',
        properties: { owner: { $ref: '#/components/schemas/Owner' } },
      },
    });
    const owner = models.find((m) => m.name === 'Owner');
    const pet = models.find((m) => m.name === 'Pet');
    expect(owner?.constraints).toEqual({ minProperties: 1, maxProperties: 3, dependentRequired: { email: ['name'] } });
    expect(pet?.fields[0]).not.toHaveProperty('constraints');
  });

  it('keeps a nullable field’s keywords (OAS 3.0 flag and 3.1 type array)', () => {
    const { models } = extractSchemas({
      Thing: {
        type: 'object',
        properties: {
          legacy: { type: 'integer', nullable: true, minimum: 0 },
          modern: { type: ['integer', 'null'], maximum: 9 },
        },
      },
    });
    expect(models[0].fields.map((f) => [f.name, f.type.kind, f.constraints])).toEqual([
      ['legacy', 'nullable', { minimum: 0 }],
      ['modern', 'nullable', { maximum: 9 }],
    ]);
  });

  it('attaches object-level keywords on an allOf wrapper to the merged model', () => {
    const { models } = extractSchemas({
      Base: { type: 'object', properties: { id: { type: 'string' } } },
      Extended: {
        minProperties: 2,
        allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { note: { type: 'string' } } }],
      },
    });
    const extended = models.find((m) => m.name === 'Extended');
    expect(extended?.constraints).toEqual({ minProperties: 2 });
    expect(models.find((m) => m.name === 'Base')).not.toHaveProperty('constraints');
  });

  it('attaches keywords to inline nested models and the field that references them', () => {
    const { models } = extractSchemas({
      Pet: {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            minProperties: 1,
            properties: { line1: { type: 'string', maxLength: 100 } },
          },
        },
      },
    });
    const pet = models.find((m) => m.name === 'Pet');
    const address = models.find((m) => m.name === 'PetAddress');
    expect(pet?.fields[0].constraints).toEqual({ minProperties: 1 });
    expect(address?.constraints).toEqual({ minProperties: 1 });
    expect(address?.fields[0].constraints).toEqual({ maxLength: 100 });
  });

  it('does not collect keywords nested inside array items', () => {
    const { models } = extractSchemas({
      Pet: {
        type: 'object',
        properties: {
          tags: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 10 } },
        },
      },
    });
    expect(models[0].fields[0].constraints).toEqual({ maxItems: 3 });
  });
});

describe('extractOperations – parameter constraints', () => {
  const listPets = (schema: Record<string, unknown>) => ({
    '/pets': {
      get: {
        operationId: 'listPets',
        parameters: [{ name: 'limit', in: 'query' as const, required: false, schema }],
        responses: { '200': { description: 'ok' } },
      },
    },
  });

  it('attaches the parameter schema’s keywords', () => {
    const { services } = extractOperations(listPets({ type: 'integer', minimum: 1, maximum: 100 }));
    expect(services[0].operations[0].queryParams[0].constraints).toEqual({ minimum: 1, maximum: 100 });
  });

  it('leaves the key absent when the schema declares no keyword', () => {
    const { services } = extractOperations(listPets({ type: 'integer' }));
    expect(services[0].operations[0].queryParams[0]).not.toHaveProperty('constraints');
  });

  it('falls back to the $ref target when the schema is a bare reference', () => {
    const componentSchemas = { Limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 } };
    const { services } = extractOperations(
      listPets({ $ref: '#/components/schemas/Limit' }),
      undefined,
      componentSchemas,
    );
    const limit = services[0].operations[0].queryParams[0];
    expect(limit.default).toBe(10);
    expect(limit.constraints).toEqual({ minimum: 1, maximum: 100 });
  });

  it('lets the parameter schema’s own keyword win over the $ref target’s', () => {
    const componentSchemas = { Limit: { type: 'integer', minimum: 1, maximum: 100 } };
    const { services } = extractOperations(
      listPets({ $ref: '#/components/schemas/Limit', maximum: 50 }),
      undefined,
      componentSchemas,
    );
    expect(services[0].operations[0].queryParams[0].constraints).toEqual({ minimum: 1, maximum: 50 });
  });

  it('merges the $ref target’s other keywords under a sibling override', () => {
    const componentSchemas = { Limit: { type: 'integer', minimum: 1, maximum: 100 } };
    const { services } = extractOperations(
      listPets({ $ref: '#/components/schemas/Limit', minimum: 5 }),
      undefined,
      componentSchemas,
    );
    expect(services[0].operations[0].queryParams[0].constraints).toEqual({ minimum: 5, maximum: 100 });
  });

  it('leaves the key absent when neither the schema nor the $ref target declares any', () => {
    const componentSchemas = { Order: { type: 'string', enum: ['asc', 'desc'] } };
    const { services } = extractOperations(
      listPets({ $ref: '#/components/schemas/Order' }),
      undefined,
      componentSchemas,
    );
    expect(services[0].operations[0].queryParams[0]).not.toHaveProperty('constraints');
  });

  it('normalizes a 3.0 boolean exclusive bound on a path parameter', () => {
    const paths = {
      '/pets/{page}': {
        get: {
          operationId: 'getPage',
          parameters: [
            {
              name: 'page',
              in: 'path' as const,
              required: true,
              schema: { type: 'integer', minimum: 0, exclusiveMinimum: true },
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    };
    const { services } = extractOperations(paths);
    expect(services[0].operations[0].pathParams[0].constraints).toEqual({ exclusiveMinimum: 0 });
  });

  it('carries keywords on an inline request body model and its fields', () => {
    const paths = {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  dependentRequired: { nickname: ['name'] },
                  properties: {
                    name: { type: 'string', maxLength: 50 },
                    nickname: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    };
    const { inlineModels } = extractOperations(paths);
    const body = inlineModels.find((m) => m.name === 'CreatePetRequest');
    expect(body?.constraints).toEqual({ minProperties: 1, dependentRequired: { nickname: ['name'] } });
    expect(body?.fields.map((f) => [f.name, f.constraints])).toEqual([
      ['name', { maxLength: 50 }],
      ['nickname', undefined],
    ]);
  });
});

describe('parseSpec – constraints', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function writeSpec(name: string, doc: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-constraints-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(doc));
    return file;
  }

  it('carries limits for params and fields end to end (issue #193 repro)', async () => {
    const file = await writeSpec('repro.json', {
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }],
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 50, pattern: '^[A-Z]' },
              tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
            },
            required: ['name'],
          },
        },
      },
    });

    const spec = await parseSpec(file);
    const [operation] = spec.services.flatMap(({ operations }) => operations);
    const pet = spec.models.find(({ name }) => name === 'Pet');

    expect(operation.queryParams.map((p) => [p.name, p.constraints])).toEqual([
      ['limit', { minimum: 1, maximum: 100 }],
    ]);
    expect(pet?.fields.map((f) => [f.name, f.constraints])).toEqual([
      ['name', { minLength: 1, maxLength: 50, pattern: '^[A-Z]' }],
      ['tags', { minItems: 1, maxItems: 5 }],
    ]);
    expect(pet).not.toHaveProperty('constraints');
  });

  it('normalizes an OAS 3.0 document’s boolean exclusive bounds', async () => {
    const file = await writeSpec('legacy.json', {
      openapi: '3.0.3',
      info: { title: 'legacy', version: '1' },
      paths: {
        '/items': {
          get: {
            operationId: 'listItems',
            parameters: [
              {
                name: 'limit',
                in: 'query',
                schema: { type: 'integer', minimum: 0, exclusiveMinimum: true, maximum: 100 },
              },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      components: {
        schemas: {
          Item: {
            type: 'object',
            properties: {
              price: { type: 'number', minimum: 0, exclusiveMinimum: false, maximum: 1, exclusiveMaximum: true },
            },
          },
        },
      },
    });

    const spec = await parseSpec(file);
    const [operation] = spec.services.flatMap(({ operations }) => operations);
    expect(operation.queryParams[0].constraints).toEqual({ exclusiveMinimum: 0, maximum: 100 });
    expect(spec.models.find(({ name }) => name === 'Item')?.fields[0].constraints).toEqual({
      minimum: 0,
      exclusiveMaximum: 1,
    });
  });

  it('keeps a Json-suffix twin’s limits when it is folded into the base model', async () => {
    const file = await writeSpec('json-suffix.json', {
      openapi: '3.1.0',
      info: { title: 'widgets', version: '1' },
      paths: {
        '/widgets': {
          get: {
            operationId: 'listWidgets',
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/WidgetJson' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Widget: { type: 'object', properties: { id: { type: 'string' } } },
          WidgetJson: {
            type: 'object',
            maxProperties: 10,
            dependentRequired: { name: ['id'] },
            properties: { id: { type: 'string' }, name: { type: 'string', maxLength: 20 } },
          },
        },
      },
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spec = await parseSpec(file);
      const widget = spec.models.find(({ name }) => name === 'Widget');
      expect(spec.models.some(({ name }) => name === 'WidgetJson')).toBe(false);
      expect(widget?.fields.map((f) => f.name)).toEqual(['id', 'name']);
      expect(widget?.constraints).toEqual({ maxProperties: 10, dependentRequired: { name: ['id'] } });
      expect(widget?.fields[1].constraints).toEqual({ maxLength: 20 });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('collapseJsonSuffixModels – constraints', () => {
  const field = (name: string) => ({
    name,
    type: { kind: 'primitive' as const, type: 'string' as const },
    required: false,
  });

  it('merges the Json model’s limits over the base model’s and leaves the key absent when neither has any', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const models: Model[] = [
        { name: 'Widget', fields: [field('id')], constraints: { minProperties: 1, maxProperties: 5 } },
        { name: 'WidgetJson', fields: [field('id'), field('name')], constraints: { maxProperties: 10 } },
        { name: 'Gadget', fields: [field('id')] },
        { name: 'GadgetJson', fields: [field('id'), field('name')] },
      ];
      const merged = collapseJsonSuffixModels(models, []);
      const widget = merged.find((m) => m.name === 'Widget');
      const gadget = merged.find((m) => m.name === 'Gadget');
      expect(merged.map((m) => m.name)).toEqual(['Widget', 'Gadget']);
      expect(widget?.constraints).toEqual({ minProperties: 1, maxProperties: 10 });
      expect(gadget).not.toHaveProperty('constraints');
    } finally {
      warn.mockRestore();
    }
  });
});
