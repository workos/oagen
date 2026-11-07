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

    it('reads a $ref to a component that dispatches a union beside another object as the same allOf written by hand (Greptile review)', async () => {
      // `Choice` is `Base & (Cat | Dog)`, dispatched on `kind`. Two members
      // declaring `result` as `$ref: Choice` and `$ref: Meta` are conjoined
      // as `{ allOf: [{ $ref: Choice }, { $ref: Meta }] }`, read exactly as
      // a document that writes that `allOf` on the field: the merge carries
      // the fields both parts share and leaves the union `Choice` dispatches
      // to `Choice` (#429), in either member order and whichever spelling
      // the second declaration uses. Before, the `$ref` first kept `Choice`
      // and dropped `total_pages`; `Meta` first kept `Meta` and dropped `id`
      // and the choice both.
      const str = { type: 'string' };
      const pin = (value: string) =>
        openapi === '3.0.3' ? { type: 'string', enum: [value] } : { type: 'string', const: value };
      const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
      const animals = {
        Base: { type: 'object', properties: { id: str }, required: ['id'] },
        Cat: { type: 'object', properties: { kind: pin('cat'), lives: str }, required: ['kind'] },
        Dog: { type: 'object', properties: { kind: pin('dog'), breed: str }, required: ['kind'] },
        Choice: { allOf: [ref('Base'), { oneOf: [ref('Cat'), ref('Dog')] }], discriminator: { propertyName: 'kind' } },
        Meta,
      };
      const holderDocument = (Holder: unknown) => ({
        openapi,
        info: { title: 'repro', version: '1' },
        paths: {
          '/holders/{id}': {
            get: {
              operationId: 'getHolder',
              parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
              responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('Holder') } } } },
            },
          },
        },
        components: { schemas: { ...animals, Holder } },
      });
      const holderFields = (spec: ApiSpec) =>
        modelNamed(spec, 'Holder')?.fields.map((f) => `${f.name}: ${show(f.type)}`);
      const choiceModels = (spec: ApiSpec) => spec.models.filter((model) => model.name.startsWith('Choice'));
      const written = await parseJson(
        holderDocument({ type: 'object', properties: { result: { allOf: [ref('Choice'), ref('Meta')] } } }),
      );
      expect(holderFields(written)).toEqual(['result: HolderResult']);
      expect(modelNamed(written, 'HolderResult')?.fields.map((f) => f.name)).toEqual(['id', 'total_pages']);
      for (const [label, members] of [
        ['Choice then Meta', [declaring(ref('Choice')), declaring(ref('Meta'))]],
        ['Meta then Choice', [declaring(ref('Meta')), declaring(ref('Choice'))]],
        [
          'Choice then an inline allOf',
          [
            declaring(ref('Choice')),
            declaring({ allOf: [{ type: 'object', properties: { total_pages: { type: 'integer' } } }] }),
          ],
        ],
      ] as const) {
        const spec = await parseJson(holderDocument({ allOf: members }));
        expect(holderFields(spec), label).toEqual(['result: HolderResult']);
        expect(
          modelNamed(spec, 'HolderResult')
            ?.fields.map((f) => f.name)
            .sort(),
          label,
        ).toEqual(['id', 'total_pages']);
        expect(choiceModels(spec), label).toEqual(choiceModels(written));
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('splices a bare allOf wrapper open, so wrappers around $refs conjoin as the $refs would (Greptile review)', async () => {
      // `{ allOf: [{ $ref: A }] }` beside `{ allOf: [{ $ref: B }] }` is
      // `{ allOf: [{ $ref: A }, { $ref: B }] }`: the readers type a member
      // that is a `$ref` or declares properties inline, so the `allOf` of the
      // two wrappers as written was `unknown`, and beside a bare `$ref` the
      // wrapper was dropped by the reference reading. The lifted keywords,
      // `type: 'object'`, a nullable spelling and a `required` beside the
      // wrapper do not keep it closed: the keywords are the field's, the
      // `required` the conjunction's.
      const str = { type: 'string' };
      const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
      const schemas = {
        A: { type: 'object', properties: { a: str } },
        B: { type: 'object', properties: { b: str } },
        X: { type: 'object', properties: { x: str } },
      };
      const holderDocument = (Holder: unknown) => ({
        openapi,
        info: { title: 'repro', version: '1' },
        paths: {
          '/holders/{id}': {
            get: {
              operationId: 'getHolder',
              parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
              responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('Holder') } } } },
            },
          },
        },
        components: { schemas: { ...schemas, Holder } },
      });
      const resultOf = (spec: ApiSpec) => modelNamed(spec, 'Holder')?.fields.find((f) => f.name === 'result');
      const resultFields = (spec: ApiSpec) =>
        modelNamed(spec, 'HolderResult')?.fields.map((f) => `${f.name}${f.required ? '!' : ''}`);
      const nullable = openapi === '3.0.3' ? { nullable: true } : { type: ['object', 'null'] };
      const wrapped = (name: string, extra: Record<string, unknown> = {}) => ({ ...extra, allOf: [ref(name)] });
      for (const [label, members, fields] of [
        ['two wrappers', [declaring(wrapped('A')), declaring(wrapped('B'))], ['a', 'b']],
        ['two wrappers, swapped', [declaring(wrapped('B')), declaring(wrapped('A'))], ['b', 'a']],
        ['wrapper then $ref', [declaring(wrapped('A')), declaring(ref('B'))], ['a', 'b']],
        ['$ref then wrapper', [declaring(ref('A')), declaring(wrapped('B'))], ['a', 'b']],
        [
          'nested two $refs then $ref',
          [declaring({ allOf: [ref('A'), ref('X')] }), declaring(ref('B'))],
          ['a', 'x', 'b'],
        ],
        [
          '$ref then nested two $refs',
          [declaring(ref('B')), declaring({ allOf: [ref('A'), ref('X')] })],
          ['b', 'a', 'x'],
        ],
        [
          'type: object beside both',
          [declaring(wrapped('A', { type: 'object' })), declaring(wrapped('B', { type: 'object' }))],
          ['a', 'b'],
        ],
        ['nullable beside the first', [declaring(wrapped('A', nullable)), declaring(wrapped('B'))], ['a', 'b']],
        ['wrapper of a wrapper', [declaring({ allOf: [wrapped('A')] }), declaring(wrapped('B'))], ['a', 'b']],
        [
          'required beside the first',
          [declaring(wrapped('A', { required: ['a'] })), declaring(wrapped('B'))],
          ['a!', 'b'],
        ],
        [
          'required beside the second',
          [declaring(ref('A')), declaring(wrapped('B', { required: ['b'] }))],
          ['a', 'b!'],
        ],
      ] as const) {
        const spec = await parseJson(holderDocument({ allOf: members }));
        expect(resultOf(spec)?.type, label).toEqual({ kind: 'model', name: 'HolderResult' });
        expect(resultFields(spec), label).toEqual(fields);
      }
      // The text beside the wrapper is the field's, as beside any declaration.
      const described = await parseJson(
        holderDocument({ allOf: [declaring(wrapped('A', { description: 'An A' })), declaring(wrapped('B'))] }),
      );
      expect([resultOf(described)?.description, resultFields(described)]).toEqual(['An A', ['a', 'b']]);
      // A `$ref` beside its own wrapper adds nothing: the first stands, and
      // nothing is minted.
      for (const [label, members] of [
        ['$ref then its wrapper', [declaring(ref('A')), declaring(wrapped('A'))]],
        ['wrapper then its $ref', [declaring(wrapped('A')), declaring(ref('A'))]],
      ] as const) {
        const spec = await parseJson(holderDocument({ allOf: members }));
        expect(resultOf(spec)?.type, label).toEqual({ kind: 'model', name: 'A' });
        expect(modelNamed(spec, 'HolderResult'), label).toBeUndefined();
      }
      // A `title` is an annotation like a `description`: the wrapper
      // accepts the same instances as its members, so it is spliced open
      // too (MichaelDeBoey: a titled wrapper kept the pair on the first, by
      // member order).
      const titled = await parseJson(
        holderDocument({
          allOf: [declaring(wrapped('A', { title: 'An A' })), declaring(wrapped('B', { title: 'A B' }))],
        }),
      );
      expect(resultOf(titled)?.type).toEqual({ kind: 'model', name: 'HolderResult' });
      expect(resultFields(titled)).toEqual(['a', 'b']);
      // A wrapper that says more than its members — a `discriminator` —
      // stays a member as written, which the readers would drop, so the
      // pair keeps the first, as before.
      for (const [label, members, name] of [
        [
          'dispatcher wrapper then wrapper',
          [declaring(wrapped('A', { discriminator: { propertyName: 'kind' } })), declaring(wrapped('B'))],
          'A',
        ],
        [
          'wrapper then dispatcher wrapper',
          [declaring(wrapped('B')), declaring(wrapped('A', { discriminator: { propertyName: 'kind' } }))],
          'B',
        ],
      ] as const) {
        const spec = await parseJson(holderDocument({ allOf: members }));
        expect(resultOf(spec)?.type, label).toEqual({ kind: 'model', name });
        expect(modelNamed(spec, 'HolderResult'), label).toBeUndefined();
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('conjoins a titled wrapper around a $ref beside a $ref, in either order, with the dataPath accepted (MichaelDeBoey)', async () => {
      // `{ title: 'Paging', allOf: [{ $ref: Meta }] }` beside `{ $ref:
      // Listing }` was `Meta` in one order and `Listing` in the other, and
      // the `result.items` override was rejected in the first.
      const Listing = inlineObject;
      const titled = { title: 'Paging', allOf: [refMeta] };
      const refListing = { $ref: '#/components/schemas/Listing' };
      for (const [label, members, fields] of [
        ['titled wrapper then $ref', [declaring(titled), declaring(refListing)], ['total_pages', 'items']],
        ['$ref then titled wrapper', [declaring(refListing), declaring(titled)], ['items', 'total_pages']],
      ] as const) {
        const spec = await parseJson(pageDocument(openapi, members, { Listing }));
        expect(shapes(spec), label).toEqual([
          'Meta { total_pages: integer }',
          'Listing { items: ListingItem[] }',
          'PetPage { result: PetPageResult }',
          'ListingItem { name: string }',
          `PetPageResult { ${fields.map((f) => (f === 'items' ? 'items: ListingItem[]' : 'total_pages: integer')).join(', ')} }`,
        ]);
        const { pagination } = onlyOperation(spec);
        expect(pagination?.dataPath, label).toBe('result.items');
        expect(pagination?.endOfIteration, label).toEqual({ kind: 'totalPages', path: 'result.total_pages' });
        expect(pagination?.itemType, label).toEqual({ kind: 'model', name: 'ListingItem' });
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('admits null on the conjunction exactly when every declaration does, in either order (MichaelDeBoey)', async () => {
      // `Meta` admits `null` and so does the inline `allOf` beside it, so
      // the `allOf` of both does: `PetPageResult | null`, where the base
      // gave `Meta | null` and the first fix `PetPageResult`. Two nullable
      // `$ref`s and two nullable inline objects alike; one declaration that
      // rejects `null` makes the conjunction reject it, whichever it is.
      const nul = (schema: Record<string, unknown>) =>
        openapi === '3.0.3' ? { ...schema, type: 'object', nullable: true } : { ...schema, type: ['object', 'null'] };
      const NullableMeta = nul({ properties: { total_pages: { type: 'integer' } } });
      const NullableListing = nul({ properties: { items: petArray } });
      const refListing = { $ref: '#/components/schemas/Listing' };
      const nullableAllOf = nul({ allOf: [inlineObject] });
      const nullableInline = nul({ properties: { items: petArray } });
      const nullableTotal = nul({ properties: { total_pages: { type: 'integer' } } });
      const plainTotal = { type: 'object', properties: { total_pages: { type: 'integer' } } };
      const nullableResult = { kind: 'nullable', inner: { kind: 'model', name: 'PetPageResult' } };
      const plainResult = { kind: 'model', name: 'PetPageResult' };
      for (const [label, schemas, members, type, itemType] of [
        [
          'nullable $ref then nullable allOf',
          { Meta: NullableMeta },
          [declaring(refMeta), declaring(nullableAllOf)],
          nullableResult,
          'PetPageResultItem',
        ],
        [
          'nullable allOf then nullable $ref',
          { Meta: NullableMeta },
          [declaring(nullableAllOf), declaring(refMeta)],
          nullableResult,
          'PetPageResultItem',
        ],
        [
          'two nullable $refs',
          { Meta: NullableMeta, Listing: NullableListing },
          [declaring(refMeta), declaring(refListing)],
          nullableResult,
          'ListingItem',
        ],
        [
          'two nullable $refs, swapped',
          { Meta: NullableMeta, Listing: NullableListing },
          [declaring(refListing), declaring(refMeta)],
          nullableResult,
          'ListingItem',
        ],
        [
          'two nullable inline objects',
          { Meta },
          [declaring(nullableTotal), declaring(nullableInline)],
          nullableResult,
          'PetPageResultItem',
        ],
        [
          'nullable $ref then a wrapper around a nullable $ref',
          { Meta: NullableMeta, Listing: NullableListing },
          [declaring(refMeta), declaring({ allOf: [refListing] })],
          nullableResult,
          'ListingItem',
        ],
        // One declaration rejects `null`: the conjunction does, in either order.
        [
          'plain $ref then nullable allOf',
          { Meta },
          [declaring(refMeta), declaring(nullableAllOf)],
          plainResult,
          'PetPageResultItem',
        ],
        [
          'nullable $ref then plain allOf',
          { Meta: NullableMeta },
          [declaring(refMeta), declaring(inlineAllOf())],
          plainResult,
          'PetPageResultItem',
        ],
        [
          'plain allOf then nullable $ref',
          { Meta: NullableMeta },
          [declaring(inlineAllOf()), declaring(refMeta)],
          plainResult,
          'PetPageResultItem',
        ],
        [
          'nullable $ref then plain $ref',
          { Meta: NullableMeta, Listing: inlineObject },
          [declaring(refMeta), declaring(refListing)],
          plainResult,
          'ListingItem',
        ],
        [
          'nullable inline then plain inline',
          { Meta },
          [declaring(nullableTotal), declaring(inlineObject)],
          plainResult,
          'PetPageResultItem',
        ],
        [
          'plain inline then nullable inline',
          { Meta },
          [declaring(plainTotal), declaring(nullableInline)],
          plainResult,
          'PetPageResultItem',
        ],
        [
          'typed wrapper around a nullable $ref then nullable allOf',
          { Meta: NullableMeta },
          [declaring({ type: 'object', allOf: [refMeta] }), declaring(nullableAllOf)],
          plainResult,
          'PetPageResultItem',
        ],
        // Three members: one that rejects `null` anywhere among them.
        [
          'nullable, nullable, plain',
          { Meta: NullableMeta },
          [
            declaring(refMeta),
            declaring(nullableAllOf),
            declaring({ type: 'object', properties: { has_more: { type: 'boolean' } } }),
          ],
          plainResult,
          'PetPageResultItem',
        ],
        [
          'plain, nullable, nullable',
          { Meta: NullableMeta },
          [
            declaring({ type: 'object', properties: { has_more: { type: 'boolean' } } }),
            declaring(refMeta),
            declaring(nullableAllOf),
          ],
          plainResult,
          'PetPageResultItem',
        ],
        [
          'three nullable',
          { Meta: NullableMeta },
          [
            declaring(refMeta),
            declaring(nullableAllOf),
            declaring(nul({ properties: { has_more: { type: 'boolean' } } })),
          ],
          nullableResult,
          'PetPageResultItem',
        ],
        // A component two members name is read for each, not as a cycle
        // (Greptile, round 4: a shared seen set read the second `$ref` as one).
        [
          'a $ref written twice then a nullable $ref',
          { Meta: NullableMeta, Listing: NullableListing },
          [declaring({ allOf: [refMeta, { ...refMeta }] }), declaring(refListing)],
          nullableResult,
          'ListingItem',
        ],
        [
          'a nullable $ref then a $ref written twice',
          { Meta: NullableMeta, Listing: NullableListing },
          [declaring(refListing), declaring({ allOf: [refMeta, { ...refMeta }] })],
          nullableResult,
          'ListingItem',
        ],
        [
          'a $ref beside its own wrapper then a nullable $ref',
          { Meta: NullableMeta, Listing: NullableListing },
          [declaring({ allOf: [refMeta, { allOf: [{ ...refMeta }] }] }), declaring(refListing)],
          nullableResult,
          'ListingItem',
        ],
        // A component that names itself, outright or through a hop, ends the
        // reading where it repeats and admits none; a nullable one admits it.
        [
          'a nullable $ref then a component that extends itself',
          { Meta: NullableMeta, Loop: { allOf: [{ $ref: '#/components/schemas/Loop' }, inlineObject] } },
          [declaring(refMeta), declaring({ $ref: '#/components/schemas/Loop' })],
          plainResult,
          'LoopItem',
        ],
        [
          'a nullable $ref then a component that extends itself through a hop',
          {
            Meta: NullableMeta,
            Loop: { allOf: [{ $ref: '#/components/schemas/Hop' }, inlineObject] },
            Hop: { allOf: [{ $ref: '#/components/schemas/Loop' }] },
          },
          [declaring(refMeta), declaring({ $ref: '#/components/schemas/Loop' })],
          plainResult,
          'LoopItem',
        ],
        [
          'a nullable $ref then a nullable component that extends itself',
          { Meta: NullableMeta, Loop: nul({ allOf: [{ $ref: '#/components/schemas/Loop' }, inlineObject] }) },
          [declaring(refMeta), declaring({ $ref: '#/components/schemas/Loop' })],
          nullableResult,
          'LoopItem',
        ],
      ] as const) {
        const spec = await parseJson(pageDocument(openapi, members, schemas));
        expect(modelNamed(spec, 'PetPage')?.fields[0]?.type, label).toEqual(type);
        expect(
          modelNamed(spec, 'PetPageResult')
            ?.fields.map((f) => f.name)
            .sort(),
          label,
        ).toEqual(members.length === 3 ? ['has_more', 'items', 'total_pages'] : ['items', 'total_pages']);
        const { pagination } = onlyOperation(spec);
        expect(pagination?.dataPath, label).toBe('result.items');
        expect(pagination?.itemType, label).toEqual({ kind: 'model', name: itemType });
      }
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
