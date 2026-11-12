import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec, type OpenApiDocument } from '../../src/parser/parse.js';
import { pointerTypesAsArray } from '../../src/parser/schema-pointers.js';
import { isArrayPointerRef, type SchemaObject } from '../../src/parser/schemas.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Operation, PaginationEndOfIteration, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #609: a list envelope `{ data, has_more }` whose `data` is a JSON
 * Pointer deeper into a component (`#/components/schemas/Holder/properties/
 * owners`) was kept as a plain response model with no `dataPath` and no
 * `endOfIteration`, so the iterator yielded the envelope: `detectListEnvelope`
 * counted a property as the array only when it was written as one or as a
 * `$ref` to an array component, and a pointer is neither. The envelope is now
 * recognized from what the pointer lands on (`isArrayPointerRef`, read ahead
 * from the document as the settle types it), `response` is the pointed array
 * once settled, and `itemType` its items — the model the pointed schema's
 * items built, never a copy.
 */

const Owner = { type: 'object', properties: { name: { type: 'string' } } };
const ownerRef = { $ref: '#/components/schemas/Owner' };
const ownersArray = { type: 'array', items: ownerRef };
const Owners = ownersArray;
const Holder = { type: 'object', properties: { owners: ownersArray } };
const pointer = (path: string): { $ref: string } => ({ $ref: `#/components/schemas/${path}` });
const cursorParam = { name: 'cursor', in: 'query', schema: { type: 'string' } };

const boolean: TypeRef = { kind: 'primitive', type: 'boolean' };
const unknown: TypeRef = { kind: 'primitive', type: 'unknown' };
const model = (name: string): TypeRef => ({ kind: 'model', name });
const array = (items: TypeRef): TypeRef => ({ kind: 'array', items });
const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });

/** The issue's envelope, `{ data, has_more: boolean }`, its properties in either order. */
function envelope(data: unknown, hasMoreFirst = false): Record<string, unknown> {
  const has_more = { type: 'boolean' };
  return { type: 'object', properties: hasMoreFirst ? { has_more, data } : { data, has_more } };
}

/** `GET /owners` (`operationId: listOwners`, a `cursor` query parameter) returning `schema`. */
function listOwners(
  schema: unknown,
  options: { parameters?: unknown[]; extra?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    '/owners': {
      get: {
        operationId: 'listOwners',
        parameters: options.parameters ?? [cursorParam],
        ...options.extra,
        responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
      },
    },
  };
}

function document(
  openapi: string,
  schemas: Record<string, unknown>,
  paths: Record<string, unknown>,
  components: Record<string, unknown> = {},
): Record<string, unknown> {
  return { openapi, info: { title: 'Owners', version: '1' }, paths, components: { schemas, ...components } };
}

/** Write `data` into the bundled document's `listOwners` envelope: the one way a pointer the bundler rejects reaches the parser. */
function withData(data: unknown): (doc: OpenApiDocument) => OpenApiDocument {
  return (doc) => {
    const paths = doc.paths as Record<
      string,
      {
        get: {
          responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }>;
        };
      }
    >;
    paths['/owners'].get.responses['200'].content['application/json'].schema.properties.data = data;
    return doc;
  };
}

/** What the issue's script prints, plus the fields its Expected names and the models built. */
interface Reading {
  response: TypeRef;
  dataPath: string | undefined;
  itemType: TypeRef | undefined;
  envelopeFields: string[] | undefined;
  endOfIteration: PaginationEndOfIteration | undefined;
  models: string[];
}

/** The reading `inline.json` and `component.json` give, which `repro.json` must give too. */
const unwrapped: Reading = {
  response: array(model('Owner')),
  dataPath: 'data',
  itemType: model('Owner'),
  envelopeFields: ['has_more'],
  endOfIteration: { kind: 'hasMore', path: 'has_more' },
  models: ['Holder', 'Owner'],
};

describe('#609', () => {
  let dir: string;
  let files = 0;
  let warnings: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oagen-609-'));
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function write(doc: unknown): Promise<string> {
    const file = join(dir, `spec-${files++}.json`);
    await writeFile(file, JSON.stringify(doc));
    return file;
  }

  async function parse(doc: unknown, transformSpec?: (doc: OpenApiDocument) => OpenApiDocument): Promise<ApiSpec> {
    return parseSpec(await write(doc), transformSpec ? { transformSpec } : undefined);
  }

  const list = (spec: ApiSpec): Operation =>
    spec.services.flatMap((s) => s.operations).find((o) => o.name === 'listOwners')!;
  const modelNames = (spec: ApiSpec): string[] => spec.models.map((m) => m.name).sort();
  const fieldsOf = (spec: ApiSpec, name: string): [string, TypeRef][] | undefined =>
    spec.models.find((m) => m.name === name)?.fields.map((f) => [f.name, f.type]);
  const read = (spec: ApiSpec): Reading => {
    const { response, pagination } = list(spec);
    return {
      response,
      dataPath: pagination?.dataPath,
      itemType: pagination?.itemType,
      envelopeFields: pagination?.envelopeFields?.map((f) => f.name),
      endOfIteration: pagination?.endOfIteration,
      models: modelNames(spec),
    };
  };

  describe.each(['3.1.0', '3.0.3'])('on OAS %s', (openapi) => {
    const schemas = { Owner, Owners, Holder };
    /** The issue's three documents: `data` written inline, as a `$ref` to the array component, and as a pointer into `Holder`. */
    const spellings = {
      'inline.json': ownersArray,
      'component.json': pointer('Owners'),
      'repro.json': pointer('Holder/properties/owners'),
    };

    it('reads repro.json as inline.json and component.json: response Owner[], dataPath data, itemType Owner, has_more among envelopeFields', async () => {
      for (const data of Object.values(spellings)) {
        const spec = await parse(document(openapi, schemas, listOwners(envelope(data))));
        expect(read(spec)).toEqual(unwrapped);
        expect(list(spec).pagination?.strategy).toBe('cursor');
      }
      expect(warnings).toEqual([]);
    });

    it('decides from the document alone: the envelope’s property order and the components’ order change nothing', async () => {
      const data = pointer('Holder/properties/owners');
      const swapped = await parse(document(openapi, { Holder, Owners, Owner }, listOwners(envelope(data, true))));
      expect(read(swapped)).toEqual(unwrapped);
      expect(warnings).toEqual([]);
    });

    it('`oagen diff component.json → repro.json` reports no change and exits 0', async () => {
      const component = await write(document(openapi, schemas, listOwners(envelope(spellings['component.json']))));
      const repro = await write(document(openapi, schemas, listOwners(envelope(spellings['repro.json']))));
      expect(diffSpecs(await parseSpec(component), await parseSpec(repro)).changes).toEqual([]);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const exit = await diffCommand({ old: component, new: repro }).catch((error: unknown) => error);
      expect((exit as { exitCode?: number }).exitCode).toBe(0);
    });

    it('takes the items from the pointed array: inline items reuse the model Holder.owners built, and nothing is minted', async () => {
      const inlineItems = { type: 'object', properties: { owners: { type: 'array', items: Owner } } };
      const data = pointer('Holder/properties/owners');
      const spec = await parse(document(openapi, { Holder: inlineItems }, listOwners(envelope(data))));
      expect(read(spec)).toEqual({
        ...unwrapped,
        response: array(model('HolderOwner')),
        itemType: model('HolderOwner'),
        models: ['Holder', 'HolderOwner'],
      });
      expect(fieldsOf(spec, 'Holder')).toEqual([['owners', array(model('HolderOwner'))]]);
      expect(warnings).toEqual([]);
    });

    it('reads a pointer that lands on a `$ref` to an array component as that array', async () => {
      const holder = { type: 'object', properties: { owners: pointer('Owners') } };
      const data = pointer('Holder/properties/owners');
      const spec = await parse(document(openapi, { Owner, Owners, Holder: holder }, listOwners(envelope(data))));
      expect(read(spec)).toEqual(unwrapped);
      expect(warnings).toEqual([]);
    });

    it('reads a pointer through an `allOf` member to the merged model’s field', async () => {
      const Base = { type: 'object', properties: { id: { type: 'string' } } };
      const composed = { allOf: [pointer('Base'), { type: 'object', properties: { owners: ownersArray } }] };
      const data = pointer('Holder/allOf/1/properties/owners');
      const spec = await parse(document(openapi, { Owner, Base, Holder: composed }, listOwners(envelope(data))));
      expect(read(spec)).toEqual({ ...unwrapped, models: ['Base', 'Holder', 'Owner'] });
      expect(fieldsOf(spec, 'Holder')?.map(([name]) => name)).toEqual(['id', 'owners']);
      expect(warnings).toEqual([]);
    });

    it('reads a pointer that lands on another pointer as what that pointer is', async () => {
      const Other = { type: 'object', properties: { list: ownersArray } };
      const holder = { type: 'object', properties: { owners: pointer('Other/properties/list') } };
      const data = pointer('Holder/properties/owners');
      const spec = await parse(document(openapi, { Owner, Other, Holder: holder }, listOwners(envelope(data))));
      expect(read(spec)).toEqual({ ...unwrapped, models: ['Holder', 'Other', 'Owner'] });
      expect(warnings).toEqual([]);
    });

    it('unwraps the envelope the same under an `x-pagination` `dataPath` restating the array', async () => {
      const data = pointer('Holder/properties/owners');
      const extra = { 'x-pagination': { dataPath: 'data' } };
      const spec = await parse(document(openapi, schemas, listOwners(envelope(data), { extra })));
      expect(read(spec)).toEqual(unwrapped);
      expect(list(spec).pagination?.strategy).toBe('cursor');
      expect(warnings).toEqual([]);
    });

    it('reads the pointer under an `allOf` read as the reference, with the wrapper’s own description', async () => {
      const described = { allOf: [pointer('Holder/properties/owners')], description: 'The owners.' };
      const spec = await parse(document(openapi, schemas, listOwners(envelope(described))));
      expect(read(spec)).toEqual(unwrapped);
      expect(list(spec).pagination?.dataDescription).toBe('The owners.');
      expect(warnings).toEqual([]);
    });

    it('conjoins the limits written beside the pointer with the pointed array’s, the item type still the element', async () => {
      const bounded = { type: 'object', properties: { owners: { ...ownersArray, minItems: 1 } } };
      const limited = { ...pointer('Holder/properties/owners'), maxItems: 3 };
      const spec = await parse(document(openapi, { Owner, Holder: bounded }, listOwners(envelope(limited))));
      const op = list(spec);
      expect(op.response).toEqual({ ...array(model('Owner')), constraints: { minItems: 1, maxItems: 3 } });
      expect(op.pagination?.itemType).toEqual(model('Owner'));
      expect(op.pagination?.dataPath).toBe('data');
    });

    it('reads a pointer to a nullable array as the nullable array, the item type still the element', async () => {
      const nullableOwners =
        openapi === '3.0.3' ? { ...ownersArray, nullable: true } : { ...ownersArray, type: ['array', 'null'] };
      const holder = { type: 'object', properties: { owners: nullableOwners } };
      const data = pointer('Holder/properties/owners');
      const spec = await parse(document(openapi, { Owner, Holder: holder }, listOwners(envelope(data))));
      expect(read(spec)).toEqual({ ...unwrapped, response: nullable(array(model('Owner'))) });
      expect(warnings).toEqual([]);
    });

    it('keeps an envelope nothing pages as the wire shape, warning as it does for an array written inline', async () => {
      const data = pointer('Holder/properties/owners');
      const spec = await parse(document(openapi, schemas, listOwners(envelope(data), { parameters: [] })));
      const op = list(spec);
      expect(op.response).toEqual(model('ListOwnersResponse'));
      expect(op.pagination).toBeUndefined();
      expect(fieldsOf(spec, 'ListOwnersResponse')).toEqual([
        ['data', array(model('Owner'))],
        ['has_more', boolean],
      ]);
      expect(warnings).toEqual([
        expect.stringContaining('listOwners returns a list envelope but no query parameter drives an iterator'),
      ]);
    });

    it('unwraps a shared component response the same', async () => {
      const OwnerPage = {
        description: 'A page of owners.',
        content: { 'application/json': { schema: envelope(pointer('Holder/properties/owners')) } },
      };
      const paths = {
        '/owners': {
          get: {
            operationId: 'listOwners',
            parameters: [cursorParam],
            responses: { '200': { $ref: '#/components/responses/OwnerPage' } },
          },
        },
      };
      const spec = await parse(document(openapi, schemas, paths, { responses: { OwnerPage } }));
      expect(read(spec)).toEqual(unwrapped);
      expect(warnings).toEqual([]);
    });

    it('leaves a pointer to no array, and one that leads nowhere, a plain response model as before', async () => {
      const kept: Reading = {
        response: model('ListOwnersResponse'),
        dataPath: undefined,
        itemType: model('ListOwnersResponse'),
        envelopeFields: undefined,
        endOfIteration: undefined,
        models: ['Holder', 'ListOwnersResponse', 'Owner'],
      };
      const toItems = await parse(
        document(openapi, schemas, listOwners(envelope(pointer('Holder/properties/owners/items')))),
      );
      expect(read(toItems)).toEqual(kept);
      expect(fieldsOf(toItems, 'ListOwnersResponse')).toEqual([
        ['data', model('Owner')],
        ['has_more', boolean],
      ]);
      expect(warnings).toEqual([]);

      // The bundler rejects a dangling pointer, so it is written after bundling.
      const placeholder = document(openapi, schemas, listOwners(envelope({ type: 'string' })));
      const dangling = await parse(placeholder, withData(pointer('Holder/properties/nope')));
      expect(read(dangling)).toEqual(kept);
      expect(fieldsOf(dangling, 'ListOwnersResponse')).toEqual([
        ['data', unknown],
        ['has_more', boolean],
      ]);
      expect(warnings).toEqual([
        '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Holder/properties/nope" in ListOwnersResponse.data: no schema at that pointer — typing the site as unknown',
      ]);
    });

    it('leaves to the settle what the document alone cannot refuse: a pointer through a primitive component’s `properties` unwraps the envelope on a `data` the settle reports and types `unknown`', async () => {
      const Code = { type: 'string', properties: { x: ownersArray } };
      const spec = await parse(document(openapi, { Owner, Code }, listOwners(envelope(pointer('Code/properties/x')))));
      expect(read(spec)).toEqual({
        response: unknown,
        dataPath: 'data',
        itemType: unknown,
        envelopeFields: ['has_more'],
        endOfIteration: { kind: 'hasMore', path: 'has_more' },
        models: ['Owner'],
      });
      expect(warnings).toEqual([
        '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Code/properties/x" in Owners.listOwners.response: primitive has no fields to read "x" from — typing the site as unknown',
      ]);
    });

    it('reads a `properties` step as the merged field the settle types: a member’s description-only declaration beside a typed one is the array (Greptile review)', async () => {
      const typed = { type: 'object', properties: { owners: ownersArray } };
      const annotating = { type: 'object', properties: { owners: { description: 'The owners.' } } };
      const expectUnwrapped = async (schemas: Record<string, unknown>, path: string, models: string[]) => {
        const spec = await parse(document(openapi, schemas, listOwners(envelope(pointer(path)))));
        expect(read(spec)).toEqual({ ...unwrapped, models });
      };
      // The annotating member after the typed one, and before it.
      await expectUnwrapped({ Owner, Holder: { allOf: [typed, annotating] } }, 'Holder/allOf/1/properties/owners', [
        'Holder',
        'Owner',
      ]);
      await expectUnwrapped({ Owner, Holder: { allOf: [annotating, typed] } }, 'Holder/allOf/0/properties/owners', [
        'Holder',
        'Owner',
      ]);
      // The typed declaration behind a `$ref` member.
      await expectUnwrapped(
        { Owner, Base: typed, Holder: { allOf: [pointer('Base'), annotating] } },
        'Holder/allOf/1/properties/owners',
        ['Base', 'Holder', 'Owner'],
      );
      // Sibling `properties` beside the `allOf`, read through the schema itself.
      await expectUnwrapped(
        { Owner, Holder: { allOf: [typed], properties: { owners: { description: 'The owners.' } } } },
        'Holder/properties/owners',
        ['Holder', 'Owner'],
      );
      // The merge of a nested field's own `allOf`.
      await expectUnwrapped(
        { Owner, Holder: { type: 'object', properties: { box: { allOf: [typed, annotating] } } } },
        'Holder/properties/box/allOf/1/properties/owners',
        ['Holder', 'HolderBox', 'Owner'],
      );
      expect(warnings).toEqual([]);
    });

    it('picks the primary response through the same merged reading: a 200 pointing at the annotating member’s declaration keeps the 200', async () => {
      const typed = { type: 'object', properties: { owners: ownersArray } };
      const annotating = { type: 'object', properties: { owners: { description: 'The owners.' } } };
      const paths = {
        '/owners': {
          get: {
            operationId: 'getOwners',
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: pointer('Holder/allOf/1/properties/owners') } },
              },
              '201': { description: 'made', content: { 'application/json': { schema: pointer('Owner') } } },
            },
          },
        },
      };
      const spec = await parse(document(openapi, { Owner, Holder: { allOf: [typed, annotating] } }, paths));
      const op = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'getOwners')!;
      expect(op.responseStatusCode).toBe(200);
      expect(op.response).toEqual(array(model('Owner')));
      expect(warnings).toEqual([]);
    });

    it('reads no array through a chain of pointers that reaches itself', async () => {
      const self = pointer('Holder/properties/owners');
      // The bundler rejects a self-referencing pointer, so it is written after bundling.
      const placeholder = document(
        openapi,
        { Owner, Holder: { type: 'object', properties: { owners: { type: 'string' } } } },
        listOwners(envelope({ type: 'string' })),
      );
      const spec = await parse(placeholder, (doc) => {
        (
          doc.components as { schemas: { Holder: { properties: Record<string, unknown> } } }
        ).schemas.Holder.properties.owners = self;
        return withData(self)(doc);
      });
      expect(read(spec)).toEqual({
        response: model('ListOwnersResponse'),
        dataPath: undefined,
        itemType: model('ListOwnersResponse'),
        envelopeFields: undefined,
        endOfIteration: undefined,
        models: ['Holder', 'ListOwnersResponse', 'Owner'],
      });
      expect(fieldsOf(spec, 'ListOwnersResponse')).toEqual([
        ['data', unknown],
        ['has_more', boolean],
      ]);
      expect(warnings).toEqual([
        '[oagen] Warning: Circular schema $ref chain starting at "#/components/schemas/Holder/properties/owners" in Holder.owners — typing the site as unknown',
      ]);
    });
  });

  describe('a pointer under a nullable wrapper (OAS 3.1)', () => {
    const site = { oneOf: [pointer('Holder/properties/owners'), { type: 'null' }] };
    const nullableOwners = { type: 'object', properties: { owners: { ...ownersArray, type: ['array', 'null'] } } };

    it('is the nullable array; to a nullable array it wears both wrappers, as the settle leaves them, the item type the element either way', async () => {
      const spec = await parse(document('3.1.0', { Owner, Holder }, listOwners(envelope(site))));
      expect(read(spec)).toEqual({ ...unwrapped, response: nullable(array(model('Owner'))) });
      const both = await parse(document('3.1.0', { Owner, Holder: nullableOwners }, listOwners(envelope(site))));
      expect(read(both)).toEqual({ ...unwrapped, response: nullable(nullable(array(model('Owner')))) });
      expect(warnings).toEqual([]);
    });

    it('yields the items of a body that is such a pointer too: `paginatedItemType` reads through every wrapper', async () => {
      const spec = await parse(document('3.1.0', { Owner, Holder: nullableOwners }, listOwners(site)));
      const op = list(spec);
      expect(op.response).toEqual(nullable(nullable(array(model('Owner')))));
      expect(op.pagination?.itemType).toEqual(model('Owner'));
      expect(op.pagination?.dataPath).toBeUndefined();
      expect(warnings).toEqual([]);
    });
  });

  describe.each(['3.1.0', '3.0.3'])(
    'the readings the BREAKING CHANGE note lists (MichaelDeBoey), on OAS %s',
    (openapi) => {
      const Pet = { type: 'object', properties: { name: { type: 'string' } } };
      const petRef = { $ref: '#/components/schemas/Pet' };
      const pets = { type: 'array', items: petRef };
      const pet: TypeRef = model('Pet');

      it('a pointer to an array beside `data` is a second array property: the envelope is kept as a plain model the iterator runs over, as beside `related: { $ref: Pets }`', async () => {
        const listPets = (related: unknown) => ({
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [cursorParam],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { type: 'object', properties: { data: pets, related, has_more: { type: 'boolean' } } },
                    },
                  },
                },
              },
            },
          },
        });
        const Shelter = { type: 'object', properties: { pets } };
        const viaPointer = await parse(
          document(openapi, { Pet, Shelter }, listPets(pointer('Shelter/properties/pets'))),
        );
        const viaComponent = await parse(document(openapi, { Pet, Pets: pets }, listPets(pointer('Pets'))));
        for (const spec of [viaPointer, viaComponent]) {
          const op = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'listPets')!;
          expect(op.response).toEqual(model('ListPetsResponse'));
          expect(op.pagination).toMatchObject({
            strategy: 'cursor',
            param: 'cursor',
            itemType: model('ListPetsResponse'),
          });
          expect(op.pagination?.dataPath).toBeUndefined();
          expect(op.pagination?.envelopeFields).toBeUndefined();
          expect(fieldsOf(spec, 'ListPetsResponse')).toEqual([
            ['data', array(pet)],
            ['related', array(pet)],
            ['has_more', boolean],
          ]);
        }
        expect(modelNames(viaPointer)).toEqual(['ListPetsResponse', 'Pet', 'Shelter']);
        expect(warnings).toEqual([]);
      });

      it('a 200 pointing at an `allOf` member that only describes a field a `$ref` member types is typed, so it is the primary response over a typed 201', async () => {
        const Note = { type: 'object', properties: { text: { type: 'string' } } };
        const Base = { type: 'object', properties: { pet: petRef } };
        const Sh = { allOf: [pointer('Base'), { type: 'object', properties: { pet: { description: 'The pet.' } } }] };
        const paths = {
          '/pet': {
            get: {
              operationId: 'getPet',
              responses: {
                '200': {
                  description: 'ok',
                  content: { 'application/json': { schema: pointer('Sh/allOf/1/properties/pet') } },
                },
                '201': { description: 'made', content: { 'application/json': { schema: pointer('Note') } } },
              },
            },
          },
        };
        const spec = await parse(document(openapi, { Pet, Note, Base, Sh }, paths));
        const op = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'getPet')!;
        expect(op.responseStatusCode).toBe(200);
        expect(op.response).toEqual(pet);
        expect(op.successResponses?.map(({ statusCode, type }) => ({ statusCode, type }))).toEqual([
          { statusCode: 200, type: pet },
          { statusCode: 201, type: model('Note') },
        ]);
        expect(warnings).toEqual([]);
      });
    },
  );

  describe('pointerTypesAsArray', () => {
    const schemas: Record<string, SchemaObject> = {
      Owner,
      Merged: {
        allOf: [
          { type: 'object', properties: { owners: ownersArray } },
          { type: 'object', properties: { owners: { description: 'x' } } },
        ],
      },
      Holder: {
        type: 'object',
        properties: {
          owners: ownersArray,
          maybe: { ...ownersArray, type: ['array', 'null'] },
          wrapped: { allOf: [{ ...ownersArray }], description: 'wrapped' },
          first: ownerRef,
          chained: pointer('Holder/properties/owners'),
          self: pointer('Holder/properties/self'),
        },
      },
    };
    const lands = (path: string): boolean => pointerTypesAsArray(`#/components/schemas/${path}`, schemas);

    it('answers from the document alone: an array in any spelling, through a chain, and not past a cycle, a model or a dangling pointer', () => {
      expect(lands('Holder/properties/owners')).toBe(true);
      expect(lands('Holder/properties/maybe')).toBe(true);
      expect(lands('Holder/properties/wrapped')).toBe(true);
      expect(lands('Holder/properties/chained')).toBe(true);
      expect(lands('Merged/allOf/1/properties/owners')).toBe(true);
      expect(lands('Holder/properties/self')).toBe(false);
      expect(lands('Holder/properties/first')).toBe(false);
      expect(lands('Holder/properties/owners/items')).toBe(false);
      expect(lands('Holder/properties/nope')).toBe(false);
      expect(lands('Nope/properties/owners')).toBe(false);
      expect(pointerTypesAsArray('#/components/responses/Problem', schemas)).toBe(false);
    });

    it('is false outside an extraction for `isArrayPointerRef`, as `isArrayComponentRef` is', () => {
      expect(isArrayPointerRef(pointer('Holder/properties/owners'))).toBe(false);
      expect(isArrayPointerRef(pointer('Owners'))).toBe(false);
      expect(isArrayPointerRef(undefined)).toBe(false);
    });
  });
});
