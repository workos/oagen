import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #571: two `allOf` members declaring one property were conjoined
 * only when one was an inline object (#483). A `$ref` to an object
 * component beside an inline `allOf` (`result: { allOf: [{ properties: {
 * items } }] }`), or beside another `$ref`, kept the first declaration, so
 * `result` had the component's fields or the inline ones by member order,
 * and a `dataPath` through the other was rejected or lost its stop field.
 * Any two declarations that each describe an object — an inline object, a
 * `$ref` to an object component, an `allOf` that reaches one — now conjoin
 * as the `allOf` of both, in the model and in the pagination walk alike.
 */

const Meta = { type: 'object', properties: { total_pages: { type: 'integer' } } };
const petArray = { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } };
const refMeta = { $ref: '#/components/schemas/Meta' };
const inlineObject = { type: 'object', properties: { items: petArray } };
/** The issue's inner `allOf`, with `extra` written beside it. */
const inlineAllOf = (extra: Record<string, unknown> = {}) => ({ ...extra, allOf: [inlineObject] });
/** An `allOf` member declaring `result`. */
const declaring = (result: unknown) => ({ type: 'object', properties: { result } });

const listPets = {
  operationId: 'listPets',
  parameters: [
    { name: 'page', in: 'query', schema: { type: 'integer' } },
    { name: 'limit', in: 'query', schema: { type: 'integer' } },
  ],
  'x-pagination': { dataPath: 'result.items' },
  responses: {
    '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/PetPage' } } } },
  },
};

/** The issue's document: `GET /pets` returning `PetPage`, which composes `members`, beside `Meta` and `schemas`. */
function pageDocument(openapi: string, members: readonly unknown[], schemas: Record<string, unknown> = {}) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: { '/pets': { get: listPets } },
    components: { schemas: { Meta, ...schemas, PetPage: { allOf: members } } },
  };
}

const show = (type: TypeRef): string =>
  type.kind === 'array'
    ? `${show(type.items)}[]`
    : type.kind === 'nullable'
      ? `${show(type.inner)}?`
      : type.kind === 'model' || type.kind === 'enum'
        ? type.name
        : type.kind === 'primitive'
          ? type.type
          : type.kind;

/** `Name { field: type, … }` per model, in order — the issue's script's output. */
const shapes = (spec: ApiSpec) =>
  spec.models.map(({ fields, name }) => `${name} { ${fields.map((f) => `${f.name}: ${show(f.type)}`).join(', ')} }`);

const onlyOperation = (spec: ApiSpec): Operation => {
  const [operation, ...rest] = spec.services.flatMap((service) => service.operations);
  expect(rest).toEqual([]);
  return operation!;
};

const modelNamed = (spec: ApiSpec, name: string) => spec.models.find((model) => model.name === name);

describe('#571', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-571-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  /** The issue's Expected: `result` is `PetPageResult`, which has both parts, and the override resolves through it. */
  function expectConjoined(spec: ApiSpec, label: string, resultFields: string[]): void {
    expect(shapes(spec).slice(0, 2), label).toEqual([
      'Meta { total_pages: integer }',
      'PetPage { result: PetPageResult }',
    ]);
    expect(
      modelNamed(spec, 'PetPageResult')?.fields.map((f) => f.name),
      label,
    ).toEqual(resultFields);
    const { pagination } = onlyOperation(spec);
    expect(pagination?.dataPath, label).toBe('result.items');
    expect(pagination?.endOfIteration, label).toEqual({ kind: 'totalPages', path: 'result.total_pages' });
    expect(pagination?.itemType, label).toEqual({ kind: 'model', name: 'PetPageResultItem' });
  }

  describe.each(['3.1.0', '3.0.3'])('on OAS %s', (openapi) => {
    it('conjoins a $ref to an object component and an inline allOf declaring one property, in either member order', async () => {
      // `repro.json`: the `$ref` first; `swapped.json`: the inline `allOf` first.
      const repro = await parseJson(pageDocument(openapi, [declaring(refMeta), declaring(inlineAllOf())]));
      expect(shapes(repro)).toEqual([
        'Meta { total_pages: integer }',
        'PetPage { result: PetPageResult }',
        'PetPageResult { total_pages: integer, items: PetPageResultItem[] }',
        'PetPageResultItem { name: string }',
      ]);
      expectConjoined(repro, 'repro', ['total_pages', 'items']);
      const swapped = await parseJson(pageDocument(openapi, [declaring(inlineAllOf()), declaring(refMeta)]));
      expect(shapes(swapped)).toEqual([
        'Meta { total_pages: integer }',
        'PetPage { result: PetPageResult }',
        'PetPageResult { items: PetPageResultItem[], total_pages: integer }',
        'PetPageResultItem { name: string }',
      ]);
      expectConjoined(swapped, 'swapped', ['items', 'total_pages']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads the same conjunction with nullable, type: object or a description beside the inner allOf', async () => {
      const nullable = openapi === '3.0.3' ? { nullable: true } : { type: ['object', 'null'] };
      for (const [label, extra] of [
        ['nullable', nullable],
        ['typed', { type: 'object' }],
        ['described', { description: 'The page' }],
      ] as const) {
        for (const [order, members] of [
          ['ref first', [declaring(refMeta), declaring(inlineAllOf(extra))]],
          ['inline first', [declaring(inlineAllOf(extra)), declaring(refMeta)]],
        ] as const) {
          const spec = await parseJson(pageDocument(openapi, members));
          expectConjoined(
            spec,
            `${label}, ${order}`,
            order === 'ref first' ? ['total_pages', 'items'] : ['items', 'total_pages'],
          );
          const result = modelNamed(spec, 'PetPage')!.fields[0]!;
          // The field is typed from the conjunction, an inline `allOf` of the
          // two members: `Meta` admits no `null`, so neither does it, and the
          // text written beside the inner `allOf` is the field's.
          expect(result.type, `${label}, ${order}`).toEqual({ kind: 'model', name: 'PetPageResult' });
          expect(result.description, `${label}, ${order}`).toBe(label === 'described' ? 'The page' : undefined);
        }
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('conjoins two $refs to object components, and an allOf that reaches an object through a chain', async () => {
      const Listing = inlineObject;
      const refListing = { $ref: '#/components/schemas/Listing' };
      for (const [label, members] of [
        ['two refs', [declaring(refMeta), declaring(refListing)]],
        ['two refs, swapped', [declaring(refListing), declaring(refMeta)]],
        ['ref under an allOf', [declaring({ allOf: [refMeta] }), declaring(inlineAllOf())]],
        ['allOf of allOf', [declaring(refMeta), declaring({ allOf: [{ allOf: [inlineObject] }] })]],
        ['allOf of allOf, swapped', [declaring({ allOf: [{ allOf: [inlineObject] }] }), declaring(refMeta)]],
      ] as const) {
        const spec = await parseJson(pageDocument(openapi, members, { Listing }));
        expect(shapes(spec).includes('PetPage { result: PetPageResult }'), label).toBe(true);
        expect(
          modelNamed(spec, 'PetPageResult')
            ?.fields.map((f) => f.name)
            .sort(),
          label,
        ).toEqual(['items', 'total_pages']);
        const { pagination } = onlyOperation(spec);
        expect(pagination?.dataPath, label).toBe('result.items');
        expect(pagination?.endOfIteration, label).toEqual({ kind: 'totalPages', path: 'result.total_pages' });
        // The items are typed as the declaration that declares them types
        // them: the component's own item model, or the page's.
        expect(pagination?.itemType, label).toEqual({
          kind: 'model',
          name: label.startsWith('two refs') ? 'ListingItem' : 'PetPageResultItem',
        });
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('conjoins three members declaring the property, in every order', async () => {
      const more = { type: 'object', properties: { has_more: { type: 'boolean' } } };
      const members = [declaring(refMeta), declaring(inlineAllOf()), declaring(more)];
      const orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ];
      for (const order of orders) {
        const spec = await parseJson(
          pageDocument(
            openapi,
            order.map((index) => members[index]),
          ),
        );
        expect(shapes(spec).slice(0, 2), order.join('')).toEqual([
          'Meta { total_pages: integer }',
          'PetPage { result: PetPageResult }',
        ]);
        expect(
          modelNamed(spec, 'PetPageResult')
            ?.fields.map((f) => f.name)
            .sort(),
          order.join(''),
        ).toEqual(['has_more', 'items', 'total_pages']);
        expect(onlyOperation(spec).pagination?.itemType, order.join('')).toEqual({
          kind: 'model',
          name: 'PetPageResultItem',
        });
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps the first declaration when the two do not both describe an object, as before', async () => {
      // A string beside the inline `allOf` is no object to conjoin: the
      // first declaration types `result`, whichever it is, and the override
      // through a string is rejected as it was.
      const stringFirst = await parseJson(
        pageDocument(openapi, [declaring({ type: 'string' }), declaring(inlineAllOf())]),
      );
      expect(shapes(stringFirst)).toEqual(['Meta { total_pages: integer }', 'PetPage { result: string }']);
      expect(warn.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
        '[oagen] Warning: x-pagination on listPets: dataPath "result.items" does not resolve to an array in the response — ignoring the override',
      ]);
      warn.mockClear();
      const allOfFirst = await parseJson(
        pageDocument(openapi, [declaring(inlineAllOf()), declaring({ type: 'string' })]),
      );
      expect(shapes(allOfFirst)).toEqual([
        'Meta { total_pages: integer }',
        'PetPage { result: PetPageResult }',
        'PetPageResult { items: PetPageResultItem[] }',
        'PetPageResultItem { name: string }',
      ]);
      expect(onlyOperation(allOfFirst).pagination?.itemType).toEqual({ kind: 'model', name: 'PetPageResultItem' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps a $ref two members write to one component, which adds nothing to itself', async () => {
      const spec = await parseJson(pageDocument(openapi, [declaring(refMeta), declaring({ ...refMeta })]));
      expect(shapes(spec)).toEqual(['Meta { total_pages: integer }', 'PetPage { result: Meta }']);
      expect(warn.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
        '[oagen] Warning: x-pagination on listPets: dataPath "result.items" does not resolve to an array in the response — ignoring the override',
      ]);
    });

    it('conjoins the same allOf written inline as the response body, a request body and a webhook body', async () => {
      const members = [declaring(refMeta), declaring(inlineAllOf())];
      const content = (schema: unknown) => ({ content: { 'application/json': { schema } } });
      const spec = await parseJson({
        openapi,
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets': {
            get: { ...listPets, responses: { '200': { description: 'ok', ...content({ allOf: members }) } } },
            post: {
              operationId: 'createPet',
              requestBody: content({ allOf: members }),
              responses: { '204': { description: 'created' } },
            },
          },
        },
        webhooks: {
          petsListed: {
            post: { requestBody: content({ allOf: members }), responses: { '200': { description: 'ok' } } },
          },
        },
        components: { schemas: { Meta } },
      });
      const conjoined = spec.models.filter((model) => model.fields.map((f) => f.name).join() === 'total_pages,items');
      expect(conjoined.map((model) => model.name).sort()).toEqual([
        'CreatePetRequestResult',
        'ListPetsResponseResult',
        'PetsListedPayloadResult',
      ]);
      for (const owner of ['ListPetsResponse', 'CreatePetRequest', 'PetsListedPayload']) {
        expect(
          modelNamed(spec, owner)?.fields.map((f) => `${f.name}: ${show(f.type)}`),
          owner,
        ).toEqual([`result: ${owner}Result`]);
      }
      const list = spec.services.flatMap((service) => service.operations).find((op) => op.name === 'listPets');
      expect(list?.pagination?.itemType).toEqual({ kind: 'model', name: 'ListPetsResponseResultItem' });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
