import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractOperations } from '../../src/parser/operations.js';
import { extractSchemas, clearSchemaNameTransform } from '../../src/parser/schemas.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Enum, ExternalDocs, Field, Operation, Parameter, ResponseHeader } from '../../src/ir/types.js';

/**
 * Issue #247: a Schema Object's `externalDocs` must reach the IR wherever
 * that schema does not become a model of its own — a property (`Field`), a
 * parameter, a response header, and an inline enum lifted into `spec.enums`.
 * Model, Enum (component), Operation, Service and ApiSpec links are covered
 * by `external-docs.test.ts` (#217).
 */

const responses = { '204': { description: 'ok' } };
const link = (slug: string): ExternalDocs => ({ url: `https://docs.example.com/${slug}` });

async function parseDocument(document: unknown, tag: string): Promise<ApiSpec> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `oagen-issue-247-${tag}-`));
  const specFile = path.join(tmpDir, 'repro.json');
  try {
    await fs.writeFile(specFile, JSON.stringify(document), 'utf-8');
    return await parseSpec(specFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function byName<T extends { name: string }>(nodes: readonly T[] | undefined, name: string): T {
  const node = nodes?.find((n) => n.name === name);
  if (!node) throw new Error(`no node named ${name} among ${(nodes ?? []).map((n) => n.name).join(', ')}`);
  return node;
}

const hasLink = (node: object): boolean => 'externalDocs' in node;

/** `{ name, externalDocs }` of each node, the projection the issue prints. */
const links = (nodes: ReadonlyArray<{ name: string; externalDocs?: ExternalDocs }>) =>
  nodes.map(({ name, externalDocs }) => ({ name, externalDocs }));

const allOperations = (spec: ApiSpec): Operation[] => spec.services.flatMap((s) => s.operations);

describe('parseSpec – a Schema Object externalDocs reaches the IR (issue #247)', () => {
  it('reproduces the issue: fields, inline enums, parameters and response headers carry their links', async () => {
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets/{petId}': {
            get: {
              operationId: 'getPet',
              parameters: [
                {
                  name: 'petId',
                  in: 'path',
                  required: true,
                  schema: { type: 'string', externalDocs: link('pet-ids') },
                },
                {
                  name: 'species',
                  in: 'query',
                  schema: { type: 'string', enum: ['cat', 'dog'], externalDocs: link('species') },
                },
              ],
              responses: {
                '200': {
                  description: 'The pet',
                  headers: {
                    'X-Rate-Limit': { schema: { type: 'integer', externalDocs: link('rate-limits') } },
                  },
                  content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Owner: {
              type: 'object',
              properties: { email: { type: 'string' } },
              externalDocs: link('owners'),
            },
            Pet: {
              type: 'object',
              properties: {
                microchip: { type: 'string', externalDocs: link('microchips') },
                nicknames: { type: 'array', items: { type: 'string' }, externalDocs: link('nicknames') },
                owner: { $ref: '#/components/schemas/Owner', externalDocs: link('pet-owners') },
                status: { type: 'string', enum: ['available', 'sold'], externalDocs: link('statuses') },
              },
            },
          },
        },
      },
      'repro',
    );
    const [operation] = allOperations(spec);

    expect({
      enums: links(spec.enums),
      fields: links(byName(spec.models, 'Pet').fields),
      pathParams: links(operation.pathParams),
      queryParams: links(operation.queryParams),
      responseHeaders: links(operation.responseHeaders!),
    }).toEqual({
      enums: [
        { name: 'PetStatus', externalDocs: link('statuses') },
        { name: 'PetsSpecies', externalDocs: link('species') },
      ],
      fields: [
        { name: 'microchip', externalDocs: link('microchips') },
        { name: 'nicknames', externalDocs: link('nicknames') },
        { name: 'owner', externalDocs: link('pet-owners') },
        { name: 'status', externalDocs: link('statuses') },
      ],
      pathParams: [{ name: 'petId', externalDocs: link('pet-ids') }],
      queryParams: [{ name: 'species', externalDocs: link('species') }],
      responseHeaders: [{ name: 'X-Rate-Limit', externalDocs: link('rate-limits') }],
    });
    // The referenced model keeps its own link; `Pet` declares none.
    expect(byName(spec.models, 'Owner').externalDocs).toEqual(link('owners'));
    expect(hasLink(byName(spec.models, 'Pet'))).toBe(false);
  });

  it('keeps every key absent for a document whose schemas declare no externalDocs', async () => {
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets/{petId}': {
            get: {
              operationId: 'getPet',
              parameters: [
                { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
                { name: 'species', in: 'query', schema: { type: 'string', enum: ['cat', 'dog'] } },
                // A malformed entry is dropped silently, as everywhere else.
                { name: 'sort', in: 'query', schema: { type: 'string', externalDocs: { description: 'no url' } } },
              ],
              responses: {
                '200': {
                  description: 'The pet',
                  headers: { 'X-Rate-Limit': { schema: { type: 'integer', externalDocs: { url: '  ' } } } },
                  content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
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
                microchip: { type: 'string', externalDocs: 'https://docs.example.com/microchips' },
                status: { type: 'string', enum: ['available', 'sold'], externalDocs: null },
              },
            },
          },
        },
      },
      'absent',
    );

    expect(JSON.stringify(spec).includes('externalDocs')).toBe(false);
    const [operation] = allOperations(spec);
    for (const node of [
      ...byName(spec.models, 'Pet').fields,
      ...spec.enums,
      ...operation.pathParams,
      ...operation.queryParams,
      ...operation.responseHeaders!,
    ]) {
      expect(hasLink(node), node.name).toBe(false);
    }
  });
});

describe('Field.externalDocs', () => {
  afterEach(() => {
    clearSchemaNameTransform();
  });

  it('carries the property schema own link and leaves the key absent otherwise', () => {
    const { models } = extractSchemas({
      Pet: {
        type: 'object',
        properties: {
          microchip: { type: 'string', externalDocs: link('microchips') },
          name: { type: 'string', description: 'Display name.' },
          weight: { type: 'number', externalDocs: { description: 'A link without a url is not a link.' } },
        },
      },
    });

    const fields = byName(models, 'Pet').fields;
    expect(byName(fields, 'microchip').externalDocs).toEqual(link('microchips'));
    expect(hasLink(byName(fields, 'name'))).toBe(false);
    expect(hasLink(byName(fields, 'weight'))).toBe(false);
  });

  it('a $ref with a sibling link: the field carries the sibling, the model keeps its own; a bare $ref carries none', () => {
    const { models } = extractSchemas({
      Owner: { type: 'object', properties: { email: { type: 'string' } }, externalDocs: link('owners') },
      Pet: {
        type: 'object',
        properties: {
          owner: { $ref: '#/components/schemas/Owner', externalDocs: link('pet-owners') },
          // Unlike `example`, a link is never taken from the referenced
          // component: that link documents `Owner`, and the model carries it.
          keeper: { $ref: '#/components/schemas/Owner' },
        },
      },
    });

    const fields = byName(models, 'Pet').fields;
    expect(byName(fields, 'owner').externalDocs).toEqual(link('pet-owners'));
    expect(hasLink(byName(fields, 'keeper'))).toBe(false);
    expect(byName(models, 'Owner').externalDocs).toEqual(link('owners'));
  });

  it('survives every path that builds a field: allOf merges, variant flattening, inline bodies, responses, nested objects and header models', async () => {
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        name: { type: 'string', externalDocs: link('names') },
                        // A nested inline object: its own fields are built by the
                        // request-body recursion.
                        tag: {
                          type: 'object',
                          properties: { color: { type: 'string', externalDocs: link('colors') } },
                        },
                      },
                    },
                  },
                },
              },
              responses: {
                '201': {
                  description: 'Created',
                  headers: {
                    'X-Meta': {
                      schema: {
                        type: 'object',
                        properties: { count: { type: 'integer', externalDocs: link('counts') } },
                      },
                    },
                  },
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { id: { type: 'string', externalDocs: link('ids') } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Base: { type: 'object', properties: { id: { type: 'string', externalDocs: link('base-ids') } } },
            // An allOf merge: a `$ref` member's fields and the inline member's.
            Pet: {
              allOf: [
                { $ref: '#/components/schemas/Base' },
                { type: 'object', properties: { microchip: { type: 'string', externalDocs: link('microchips') } } },
              ],
            },
            // A pure oneOf: variant fields are flattened as optional.
            Update: {
              oneOf: [
                { type: 'object', properties: { role: { type: 'string', externalDocs: link('roles') } } },
                { type: 'object', properties: { roles: { type: 'array', items: { type: 'string' } } } },
              ],
            },
            // A nested inline object in a component field (the field extractor).
            Kennel: {
              type: 'object',
              properties: {
                address: {
                  type: 'object',
                  properties: { street: { type: 'string', externalDocs: link('streets') } },
                },
              },
            },
          },
        },
      },
      'paths',
    );

    const fieldLink = (model: string, field: string) => byName(byName(spec.models, model).fields, field).externalDocs;
    expect(fieldLink('Pet', 'id')).toEqual(link('base-ids'));
    expect(fieldLink('Pet', 'microchip')).toEqual(link('microchips'));
    expect(fieldLink('Update', 'role')).toEqual(link('roles'));
    expect(hasLink(byName(byName(spec.models, 'Update').fields, 'roles'))).toBe(false);
    expect(fieldLink('KennelAddress', 'street')).toEqual(link('streets'));
    expect(fieldLink('CreatePetRequest', 'name')).toEqual(link('names'));
    expect(fieldLink('CreatePetRequestTag', 'color')).toEqual(link('colors'));
    expect(fieldLink('CreatePetResponse', 'id')).toEqual(link('ids'));
    expect(fieldLink('PetsXMeta', 'count')).toEqual(link('counts'));
  });

  it('carries the link on list-envelope companion fields and on the companion model fields', async () => {
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/users': {
            get: {
              operationId: 'listUsers',
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { $ref: '#/components/schemas/User' } },
                          list_metadata: {
                            type: 'object',
                            externalDocs: link('pagination'),
                            properties: {
                              before: { type: ['string', 'null'], externalDocs: link('cursors') },
                              after: { type: ['string', 'null'] },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: { schemas: { User: { type: 'object', properties: { id: { type: 'string' } } } } },
      },
      'envelope',
    );

    const [operation] = allOperations(spec);
    const [metadata] = operation.pagination!.envelopeFields!;
    expect(metadata.name).toBe('list_metadata');
    expect(metadata.externalDocs).toEqual(link('pagination'));
    const companion = byName(spec.models, (metadata.type as { name: string }).name);
    expect(companion.externalDocs).toEqual(link('pagination'));
    expect(byName(companion.fields, 'before').externalDocs).toEqual(link('cursors'));
    expect(hasLink(byName(companion.fields, 'after'))).toBe(false);
  });

  it('is documentation, not shape: two header models that differ only in a field link share one name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = (externalDocs?: ExternalDocs) => ({
        schema: {
          type: 'object',
          properties: { count: { type: 'integer', ...(externalDocs ? { externalDocs } : {}) } },
        },
      });
      const { services, inlineModels } = extractOperations({
        '/documents': {
          get: {
            operationId: 'listDocuments',
            responses: { '200': { description: 'ok', headers: { 'X-Meta': meta(link('counts')) } } },
          },
          post: {
            operationId: 'createDocument',
            responses: { '201': { description: 'ok', headers: { 'X-Meta': meta() } } },
          },
        },
      } as never);

      const [list, create] = services.flatMap((s) => s.operations);
      // Same shape by `modelFingerprint`, so the second operation shares the
      // first's model instead of minting `DocumentsXMeta201` or the like; the
      // link is kept from the declaration that materialized the model.
      expect(list.responseHeaders![0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta' });
      expect(create.responseHeaders![0].type).toEqual({ kind: 'model', name: 'DocumentsXMeta' });
      const metas = inlineModels.filter((m) => m.name.startsWith('DocumentsXMeta'));
      expect(metas.map((m) => m.name)).toEqual(['DocumentsXMeta']);
      expect(metas[0].fields[0].externalDocs).toEqual(link('counts'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Enum.externalDocs on inline enums', () => {
  afterEach(() => {
    clearSchemaNameTransform();
  });

  const enumLink = (enums: Enum[], name: string) => byName(enums, name).externalDocs;

  it('a property enum lifts with its link beside the field own, like a component enum; one without stays bare', () => {
    const { models, enums } = extractSchemas({
      Status: { type: 'string', enum: ['active'], externalDocs: link('status') },
      Pet: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['available', 'sold'], externalDocs: link('statuses') },
          size: { type: 'string', enum: ['s', 'm', 'l'] },
          kind: { $ref: '#/components/schemas/Status' },
        },
      },
    });

    expect(enumLink(enums, 'Status')).toEqual(link('status'));
    expect(enumLink(enums, 'PetStatus')).toEqual(link('statuses'));
    expect(hasLink(byName(enums, 'PetSize'))).toBe(false);
    const fields = byName(models, 'Pet').fields;
    expect(byName(fields, 'status').externalDocs).toEqual(link('statuses'));
    // The link lives on the `Enum`, not on the field's type.
    expect(byName(fields, 'status').type).toEqual({
      kind: 'enum',
      name: 'PetStatus',
      values: ['available', 'sold'],
    });
  });

  it('lifts parameter, header, array-item, oneOf-variant and const-union enums with their links', async () => {
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [
                {
                  name: 'species',
                  in: 'query',
                  schema: { type: 'string', enum: ['cat', 'dog'], externalDocs: link('species') },
                },
                {
                  name: 'X-Mode',
                  in: 'header',
                  schema: { type: 'string', enum: ['fast', 'slow'], externalDocs: link('modes') },
                },
              ],
              responses: {
                '200': {
                  description: 'ok',
                  headers: {
                    'X-Policy': { schema: { type: 'string', enum: ['retry', 'stop'], externalDocs: link('policies') } },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Owner: { type: 'object', properties: { email: { type: 'string' } } },
            Pet: {
              type: 'object',
              properties: {
                tags: { type: 'array', items: { type: 'string', enum: ['cute', 'loud'], externalDocs: link('tags') } },
                kind: {
                  oneOf: [
                    { type: 'string', enum: ['stray', 'owned'], externalDocs: link('kinds') },
                    { $ref: '#/components/schemas/Owner' },
                  ],
                },
                // A union of string consts collapses into one enum: the wrapper
                // is the schema that declares it, so its link is the enum's.
                provider: { externalDocs: link('providers'), oneOf: [{ const: 'apple' }, { const: 'github' }] },
              },
            },
          },
        },
      },
      'sites',
    );

    expect(links(spec.enums)).toEqual([
      { name: 'PetTags', externalDocs: link('tags') },
      { name: 'PetKind', externalDocs: link('kinds') },
      { name: 'PetProvider', externalDocs: link('providers') },
      { name: 'PetsSpecies', externalDocs: link('species') },
      { name: 'PetsXMode', externalDocs: link('modes') },
      { name: 'PetsXPolicy', externalDocs: link('policies') },
    ]);
  });

  it('a nullable or single-member wrapper carries its link onto the enum, in every form', async () => {
    const wrapper = link('wrapper');
    const member = link('member');
    const values = ['a', 'b'];
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: { '/pets': { get: { operationId: 'listPets', responses } } },
        components: {
          schemas: {
            Pet: {
              type: 'object',
              properties: {
                a: { externalDocs: wrapper, oneOf: [{ type: 'string', enum: values }, { type: 'null' }] },
                b: { externalDocs: wrapper, anyOf: [{ type: 'null' }, { type: 'string', enum: values }] },
                c: { externalDocs: wrapper, type: ['string', 'null'], enum: values },
                d: { externalDocs: wrapper, nullable: true, type: 'string', enum: values },
                // A `null` member marks nullability on the same schema.
                e: { externalDocs: wrapper, type: 'string', enum: [...values, null] },
                // The branch documents itself and the wrapper says nothing.
                f: { oneOf: [{ type: 'string', enum: values, externalDocs: member }, { type: 'null' }] },
                // Both: the wrapper is the field's schema, so its link wins.
                g: {
                  externalDocs: wrapper,
                  oneOf: [{ type: 'string', enum: values, externalDocs: member }, { type: 'null' }],
                },
                // A single-member allOf is unwrapped the same way.
                h: { externalDocs: wrapper, allOf: [{ type: 'string', enum: values, externalDocs: member }] },
                i: { allOf: [{ type: 'string', enum: values, externalDocs: member }] },
              },
            },
          },
        },
      },
      'nullable',
    );

    const expected: Record<string, ExternalDocs> = {
      PetA: wrapper,
      PetB: wrapper,
      PetC: wrapper,
      PetD: wrapper,
      PetE: wrapper,
      PetF: member,
      PetG: wrapper,
      PetH: wrapper,
      PetI: member,
    };
    for (const [name, docs] of Object.entries(expected)) {
      expect(byName(spec.enums, name).externalDocs, name).toEqual(docs);
    }
    // The types are unchanged: nullable enum refs, with no link on the ref.
    const fields = byName(spec.models, 'Pet').fields;
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect(byName(fields, name).type, name).toEqual({
        kind: 'nullable',
        inner: { kind: 'enum', name: `Pet${name.toUpperCase()}`, values },
      });
    }
    // The field carries its own schema's link — the wrapper's, as written.
    expect(byName(fields, 'a').externalDocs).toEqual(wrapper);
    expect(hasLink(byName(fields, 'f'))).toBe(false);
  });

  it('the first inline schema lifted under a name decides the link, as it decides the values', async () => {
    const sort = (externalDocs?: ExternalDocs) => ({
      name: 'sort',
      in: 'query',
      schema: { type: 'string', enum: ['asc', 'desc'], ...(externalDocs ? { externalDocs } : {}) },
    });
    const document = (first: ReturnType<typeof sort>, second: ReturnType<typeof sort>) => ({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': { get: { operationId: 'listPets', parameters: [first], responses } },
        '/pets/{id}': { get: { operationId: 'getPet', parameters: [second], responses } },
      },
    });

    const bareFirst = await parseDocument(document(sort(), sort(link('sorting'))), 'bare-first');
    expect(bareFirst.enums.map((e) => e.name)).toEqual(['PetsSort']);
    expect(hasLink(bareFirst.enums[0])).toBe(false);

    const linkedFirst = await parseDocument(document(sort(link('sorting')), sort()), 'linked-first');
    expect(linkedFirst.enums.map((e) => e.name)).toEqual(['PetsSort']);
    expect(linkedFirst.enums[0].externalDocs).toEqual(link('sorting'));
  });

  it('a header enum renamed apart from a same-named one keeps its link through the rename', async () => {
    const policy = (values: string[], externalDocs: ExternalDocs) => ({
      'X-Policy': { schema: { type: 'string', enum: values, externalDocs } },
    });
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/documents': {
            get: {
              operationId: 'listDocuments',
              responses: {
                '200': { description: 'ok', headers: policy(['fast', 'slow'], link('policies')) },
                '429': { description: 'slow down', headers: policy(['retry', 'stop'], link('throttling')) },
              },
            },
          },
        },
      },
      'rename',
    );

    expect(links(spec.enums)).toEqual([
      { name: 'DocumentsXPolicy', externalDocs: link('policies') },
      { name: 'DocumentsXPolicy429', externalDocs: link('throttling') },
    ]);
  });
});

describe('Parameter.externalDocs', () => {
  const componentSchemas = {
    Id: { type: 'string', externalDocs: link('ids') },
    Plain: { type: 'string' },
  };

  function paramsOf(parameters: unknown[], componentParameters?: Record<string, Record<string, unknown>>): Parameter[] {
    const { services } = extractOperations(
      { '/pets': { get: { operationId: 'listPets', parameters, responses } } } as never,
      undefined,
      componentSchemas as never,
      componentParameters,
    );
    const [op] = services.flatMap((s) => s.operations);
    return [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])];
  }

  it('reads the schema link, else the $ref target, the way description and deprecated fall back', () => {
    const params = paramsOf([
      { name: 'own', in: 'query', schema: { type: 'string', externalDocs: link('own') } },
      { name: 'target', in: 'query', schema: { $ref: '#/components/schemas/Id' } },
      { name: 'sibling', in: 'query', schema: { $ref: '#/components/schemas/Id', externalDocs: link('sibling') } },
      // An unusable entry falls through to the next level, as an empty description does.
      { name: 'fallthrough', in: 'query', schema: { $ref: '#/components/schemas/Id', externalDocs: { url: '' } } },
      { name: 'bare', in: 'query', schema: { type: 'string' } },
      { name: 'plain', in: 'query', schema: { $ref: '#/components/schemas/Plain' } },
      { name: 'schemaless', in: 'query' },
      { name: 'X-Trace', in: 'header', schema: { type: 'string', externalDocs: link('tracing') } },
      { name: 'session', in: 'cookie', schema: { type: 'string', externalDocs: link('sessions') } },
    ]);

    expect(links(params)).toEqual([
      { name: 'own', externalDocs: link('own') },
      { name: 'target', externalDocs: link('ids') },
      { name: 'sibling', externalDocs: link('sibling') },
      { name: 'fallthrough', externalDocs: link('ids') },
      { name: 'bare', externalDocs: undefined },
      { name: 'plain', externalDocs: undefined },
      { name: 'schemaless', externalDocs: undefined },
      { name: 'X-Trace', externalDocs: link('tracing') },
      { name: 'session', externalDocs: link('sessions') },
    ]);
    for (const name of ['bare', 'plain', 'schemaless']) expect(hasLink(byName(params, name)), name).toBe(false);
  });

  it('a component parameter carries its schema link, with the same $ref fallback', () => {
    const params = paramsOf([{ $ref: '#/components/parameters/PetId' }, { $ref: '#/components/parameters/Limit' }], {
      PetId: { name: 'petId', in: 'path', required: true, schema: { type: 'string', externalDocs: link('pet-ids') } },
      Limit: { name: 'limit', in: 'query', schema: { $ref: '#/components/schemas/Id' } },
    });

    expect(links(params)).toEqual([
      { name: 'petId', externalDocs: link('pet-ids') },
      { name: 'limit', externalDocs: link('ids') },
    ]);
  });

  it('a path-level parameter carries its link too', () => {
    const { services } = extractOperations({
      '/pets/{petId}': {
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'string', externalDocs: link('pet-ids') } },
        ],
        get: { operationId: 'getPet', responses },
      },
    } as never);
    const [op] = services.flatMap((s) => s.operations);
    expect(links(op.pathParams)).toEqual([{ name: 'petId', externalDocs: link('pet-ids') }]);
  });
});

describe('ResponseHeader.externalDocs', () => {
  function headersOf(
    responseMap: Record<string, unknown>,
    componentHeaders?: Record<string, Record<string, unknown>>,
  ): { op: Operation; headers: ResponseHeader[] } {
    const { services } = extractOperations(
      { '/documents': { get: { operationId: 'listDocuments', responses: responseMap } } } as never,
      undefined,
      { Id: { type: 'string', externalDocs: link('ids') } } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      componentHeaders,
    );
    const [op] = services.flatMap((s) => s.operations);
    return { op, headers: op.responseHeaders ?? [] };
  }

  it('reads the header schema link, from `schema` or `content`, and through components/headers', () => {
    const { headers } = headersOf(
      {
        '200': {
          description: 'ok',
          headers: {
            'X-Schema': { schema: { type: 'integer', externalDocs: link('schema') } },
            'X-Content': { content: { 'text/plain': { schema: { type: 'string', externalDocs: link('content') } } } },
            'X-Component': { $ref: '#/components/headers/Rate', description: 'Overridden.' },
            'X-Sibling': { schema: { $ref: '#/components/schemas/Id', externalDocs: link('sibling') } },
            // A header reads only its own schema, as its description and
            // deprecated read only the Header Object: the referenced model
            // carries its own link.
            'X-Ref': { schema: { $ref: '#/components/schemas/Id' } },
            'X-Bare': { schema: { type: 'string' } },
            'X-Malformed': { schema: { type: 'string', externalDocs: { url: 42 } } },
            'X-Schemaless': { description: 'Typed as a string.' },
          },
        },
      },
      { Rate: { description: 'From the component.', schema: { type: 'integer', externalDocs: link('rate') } } },
    );

    expect(links(headers)).toEqual([
      { name: 'X-Schema', externalDocs: link('schema') },
      { name: 'X-Content', externalDocs: link('content') },
      { name: 'X-Component', externalDocs: link('rate') },
      { name: 'X-Sibling', externalDocs: link('sibling') },
      { name: 'X-Ref', externalDocs: undefined },
      { name: 'X-Bare', externalDocs: undefined },
      { name: 'X-Malformed', externalDocs: undefined },
      { name: 'X-Schemaless', externalDocs: undefined },
    ]);
    // The `$ref` sibling description still overrides the component's, beside the link.
    expect(byName(headers, 'X-Component').description).toBe('Overridden.');
    for (const name of ['X-Ref', 'X-Bare', 'X-Malformed', 'X-Schemaless']) {
      expect(hasLink(byName(headers, name)), name).toBe(false);
    }
  });

  it('carries the link on error-response headers and on each of several 2xx responses', () => {
    const header = (slug: string) => ({ 'X-Policy': { schema: { type: 'string', externalDocs: link(slug) } } });
    const { op } = headersOf({
      '200': { description: 'ok', headers: header('ok') },
      '202': { description: 'accepted', headers: header('accepted') },
      '429': { description: 'slow down', headers: header('throttled') },
    });

    expect(op.successResponses!.map((r) => links(r.headers!))).toEqual([
      [{ name: 'X-Policy', externalDocs: link('ok') }],
      [{ name: 'X-Policy', externalDocs: link('accepted') }],
    ]);
    expect(links(op.errors[0].headers!)).toEqual([{ name: 'X-Policy', externalDocs: link('throttled') }]);
  });
});

/** Type-level check: the new keys exist on every node the issue names. */
const _typeCheck: [Field, Parameter, ResponseHeader, Enum] = [
  { name: 'f', type: { kind: 'primitive', type: 'string' }, required: false, externalDocs: link('f') },
  { name: 'p', type: { kind: 'primitive', type: 'string' }, required: false, externalDocs: link('p') },
  { name: 'h', type: { kind: 'primitive', type: 'string' }, required: false, externalDocs: link('h') },
  { name: 'E', values: [], externalDocs: link('e') },
];
void _typeCheck;
