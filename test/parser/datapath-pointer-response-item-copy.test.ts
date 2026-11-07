import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Field, Model, Operation, PaginationMeta, TypeRef } from '../../src/ir/types.js';
import {
  dataPathForks,
  dataPathWalkStart,
  deferDataPathItemType,
  isDeferredDataPathItemType,
  resolveDataPathItemType,
  settleDeferredDataPathItemType,
  walkDataPathItemType,
} from '../../src/parser/pagination.js';
import { pendingSchemaRef } from '../../src/parser/schema-refs.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

/**
 * Issue #608: an explicit `dataPath` on a response written as a `$ref`
 * deeper into a component (`#/components/schemas/Holder/properties/result`)
 * was resolved at extraction, while the response was still the pending
 * reference #539 leaves for the settle: the IR walk found no model to walk,
 * so the items were read from the document and minted a second time under
 * the path-derived name — `ListOwnersItem` beside the `HolderResultItem`
 * the settled response's `items` hold, two models for one item. The walk
 * now reports a pending reference, extraction leaves a placeholder, and the
 * settle walks the path again from the settled types, so the iterator
 * yields the very model the field holds and no copy is built — as
 * `component.json`, with `result` a component `Result`, reuses `ResultItem`.
 */
describe('#608', () => {
  let tmpDir: string;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-608-'));
  });

  afterEach(async () => {
    warn.mockClear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown, options?: Parameters<typeof parseSpec>[1]): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile, options);
  }

  const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: 'object',
    properties,
    ...extra,
  });
  const array = (items: unknown) => ({ type: 'array', items });
  const ref = (pointer: string) => ({ $ref: `#/components/schemas/${pointer}` });
  /** The issue's `result: { items: { name: string }[] }`, the object and its items inline. */
  const result = object({ items: array(object({ name: { type: 'string' } })) });
  const Holder = object({ result });
  /** The issue's response: a pointer into `Holder`, `#/components/schemas/Holder/properties/result`. */
  const pointer = ref('Holder/properties/result');
  /** #529's `PetPage`: two `allOf` members declaring `result`, conjoined into the field model `PetPageResult`. */
  const Meta = object({ total_pages: { type: 'integer' } });
  const PetPage = { allOf: [object({ result: ref('Meta') }), object({ result })] };

  const cursor = { name: 'cursor', in: 'query', schema: { type: 'string' } };
  /** The issue's `GET /owners`: `operationId: listOwners`, a `cursor` query parameter, `x-pagination: { dataPath }`, returning `schema`. */
  const listOwners = (schema: unknown, dataPath: string | undefined, extra: Record<string, unknown> = {}) => ({
    operationId: 'listOwners',
    parameters: [cursor],
    ...(dataPath !== undefined && { 'x-pagination': { dataPath } }),
    responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
    ...extra,
  });
  const spec = (openapi: string, operation: unknown, schemas: Record<string, unknown>) => ({
    openapi,
    info: { title: 'repro', version: '1' },
    paths: { '/owners': { get: operation } },
    components: { schemas },
  });

  const onlyOperation = (ir: ApiSpec): Operation => {
    const operations = ir.services.flatMap((s) => s.operations);
    expect(operations).toHaveLength(1);
    return operations[0];
  };
  /** A type in a word, as the issue's script prints it: a model's name, `T[]` for an array, `T?` under a nullable wrapper, else the primitive. */
  const show = (type: TypeRef): string => {
    switch (type.kind) {
      case 'array':
        return `${show(type.items)}[]`;
      case 'nullable':
        return `${show(type.inner)}?`;
      case 'model':
      case 'enum':
        return type.name;
      case 'primitive':
        return type.type;
      default:
        return type.kind;
    }
  };
  /** Every model with its fields, as the issue's script prints them (`HolderResult { items: HolderResultItem[] }`). */
  const models = (ir: ApiSpec): string[] =>
    ir.models.map(({ fields, name }) => `${name} { ${fields.map((f) => `${f.name}: ${show(f.type)}`).join(', ')} }`);
  /** The `items` TypeRef of the array `model.<field>` holds, under any nullable wrapper — the object itself. */
  const itemsOf = (ir: ApiSpec, model: string, field: string): TypeRef | undefined => {
    let type = ir.models.find((m) => m.name === model)?.fields.find((f) => f.name === field)?.type;
    while (type?.kind === 'nullable') type = type.inner;
    return type?.kind === 'array' ? type.items : undefined;
  };
  /** The iterator yields `itemType`, the very TypeRef the array `model.<field>` holds, and nothing was warned about. */
  const expectIterates = (ir: ApiSpec, dataPath: string, model: string, field: string, itemType: string) => {
    const op = onlyOperation(ir);
    expect(op.pagination).toMatchObject({ dataPath, itemType: { kind: 'model', name: itemType } });
    expect(op.pagination?.itemType).toBe(itemsOf(ir, model, field));
    expect(warn).not.toHaveBeenCalled();
  };
  const holderModels = ['Holder { result: HolderResult }', 'HolderResult { items: HolderResultItem[] }'];

  describe.each(['3.1.0', '3.0.3'])('OAS %s', (openapi) => {
    it("iterates HolderResultItem, the model the pointed schema's items hold, and builds no ListOwnersItem (repro.json)", async () => {
      const ir = await parseJson(spec(openapi, listOwners(pointer, 'items'), { Holder }));
      expect(onlyOperation(ir).response).toEqual({ kind: 'model', name: 'HolderResult' });
      expectIterates(ir, 'items', 'HolderResult', 'items', 'HolderResultItem');
      expect(models(ir)).toEqual([...holderModels, 'HolderResultItem { name: string }']);
    });

    it('reads component.json as before, and repro.json holds exactly the models component.json holds, modulo names', async () => {
      const component = await parseJson(
        spec(openapi, listOwners(ref('Result'), 'items'), {
          Holder: object({ result: ref('Result') }),
          Result: result,
        }),
      );
      expect(onlyOperation(component).response).toEqual({ kind: 'model', name: 'Result' });
      expectIterates(component, 'items', 'Result', 'items', 'ResultItem');
      expect(models(component)).toEqual([
        'Holder { result: Result }',
        'Result { items: ResultItem[] }',
        'ResultItem { name: string }',
      ]);
      const repro = await parseJson(spec(openapi, listOwners(pointer, 'items'), { Holder }));
      expect(models(repro).map((line) => line.replaceAll('HolderResult', 'Result'))).toEqual(models(component));
    });

    it('one level down: an inline body { result: pointer } with dataPath result.items iterates HolderResultItem, not a ListOwnersResultItem copy', async () => {
      const ir = await parseJson(spec(openapi, listOwners(object({ result: pointer }), 'result.items'), { Holder }));
      expect(onlyOperation(ir).response).toEqual({ kind: 'model', name: 'ListOwnersResponse' });
      expectIterates(ir, 'result.items', 'HolderResult', 'items', 'HolderResultItem');
      expect(models(ir)).toEqual([
        ...holderModels,
        'ListOwnersResponse { result: HolderResult }',
        'HolderResultItem { name: string }',
      ]);
    });

    it('two levels down: { outer: { result: pointer } } with dataPath outer.result.items', async () => {
      const ir = await parseJson(
        spec(openapi, listOwners(object({ outer: object({ result: pointer }) }), 'outer.result.items'), { Holder }),
      );
      expectIterates(ir, 'outer.result.items', 'HolderResult', 'items', 'HolderResultItem');
      expect(models(ir)).toEqual([
        ...holderModels,
        'ListOwnersResponse { outer: ListOwnersResponseOuter }',
        'ListOwnersResponseOuter { result: HolderResult }',
        'HolderResultItem { name: string }',
      ]);
    });

    it('a pointer that lands on the array itself, the dataPath naming the field written as it', async () => {
      const ir = await parseJson(
        spec(openapi, listOwners(object({ result: ref('Holder/properties/result/properties/items') }), 'result'), {
          Holder,
        }),
      );
      // The field settled to the array `HolderResult.items` is (#539), so both hold one item model.
      expectIterates(ir, 'result', 'ListOwnersResponse', 'result', 'HolderResultItem');
      expect(models(ir)).toEqual([
        ...holderModels,
        'ListOwnersResponse { result: HolderResultItem[] }',
        'HolderResultItem { name: string }',
      ]);
    });

    it("a pointer through an array component's items (Holders/items/properties/result) iterates the items model's field items", async () => {
      const ir = await parseJson(
        spec(openapi, listOwners(ref('Holders/items/properties/result'), 'items'), {
          Holders: array(object({ result })),
        }),
      );
      expect(onlyOperation(ir).response).toEqual({ kind: 'model', name: 'HolderItemResult' });
      expectIterates(ir, 'items', 'HolderItemResult', 'items', 'HolderItemResultItem');
      expect(models(ir)).toEqual([
        'HolderItem { result: HolderItemResult }',
        'HolderItemResult { items: HolderItemResultItem[] }',
        'HolderItemResultItem { name: string }',
      ]);
    });

    it("#529: a pointer into a component's allOf member reads on to the merged field, and the component as the body iterates as before", async () => {
      const petPageModels = [
        'Meta { total_pages: integer }',
        'PetPage { result: PetPageResult }',
        'PetPageResult { total_pages: integer, items: PetPageResultItem[] }',
        'PetPageResultItem { name: string }',
      ];
      const member = await parseJson(
        spec(openapi, listOwners(ref('PetPage/allOf/1/properties/result'), 'items'), { Meta, PetPage }),
      );
      expect(onlyOperation(member).response).toEqual({ kind: 'model', name: 'PetPageResult' });
      expectIterates(member, 'items', 'PetPageResult', 'items', 'PetPageResultItem');
      expect(models(member)).toEqual(petPageModels);
      const component = await parseJson(spec(openapi, listOwners(ref('PetPage'), 'result.items'), { Meta, PetPage }));
      expect(onlyOperation(component).response).toEqual({ kind: 'model', name: 'PetPage' });
      expectIterates(component, 'result.items', 'PetPageResult', 'items', 'PetPageResultItem');
      expect(models(component)).toEqual(petPageModels);
    });

    it("a pointer that lands on a $ref to a component iterates that component's items", async () => {
      const ir = await parseJson(
        spec(openapi, listOwners(pointer, 'items'), { Holder: object({ result: ref('Result') }), Result: result }),
      );
      expect(onlyOperation(ir).response).toEqual({ kind: 'model', name: 'Result' });
      expectIterates(ir, 'items', 'Result', 'items', 'ResultItem');
      expect(models(ir)).toEqual([
        'Holder { result: Result }',
        'Result { items: ResultItem[] }',
        'ResultItem { name: string }',
      ]);
    });

    it('under a nullable wrapper around the pointer', async () => {
      const nullable =
        openapi === '3.1.0' ? { oneOf: [pointer, { type: 'null' }] } : { allOf: [pointer], nullable: true };
      const ir = await parseJson(spec(openapi, listOwners(nullable, 'items'), { Holder }));
      expectIterates(ir, 'items', 'HolderResult', 'items', 'HolderResultItem');
      expect(models(ir)).toEqual([...holderModels, 'HolderResultItem { name: string }']);
    });

    it('from an operationHints pagination entry as from x-pagination', async () => {
      const ir = await parseJson(spec(openapi, listOwners(pointer, undefined), { Holder }), {
        operationHints: { 'GET /owners': { pagination: { dataPath: 'items' } } },
      });
      expectIterates(ir, 'items', 'HolderResult', 'items', 'HolderResultItem');
      expect(models(ir)).toEqual([...holderModels, 'HolderResultItem { name: string }']);
    });

    it('a pointer companion of an inline wrapper, with the dataPath through it (meta.items)', async () => {
      const wrapper = object({ data: array({ type: 'string' }), meta: pointer, has_more: { type: 'boolean' } });
      const ir = await parseJson(spec(openapi, listOwners(wrapper, 'meta.items'), { Holder }));
      expect(onlyOperation(ir).response).toEqual({ kind: 'model', name: 'ListOwnersResponse' });
      expectIterates(ir, 'meta.items', 'HolderResult', 'items', 'HolderResultItem');
      expect(models(ir)).toEqual([
        ...holderModels,
        'ListOwnersResponse { data: string[], meta: HolderResult, has_more: boolean }',
        'HolderResultItem { name: string }',
      ]);
    });

    it("follows the field's item model when a later pass renames it", async () => {
      // A `result_item` query enum of the `Holder` service is lifted as
      // `HolderResultItem`, so the field's item model moves off the name.
      const ir = await parseJson(
        spec(
          openapi,
          listOwners(pointer, 'items', {
            tags: ['Holder'],
            parameters: [cursor, { name: 'result_item', in: 'query', schema: { type: 'string', enum: ['a', 'b'] } }],
          }),
          { Holder },
        ),
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[oagen] Renamed inline model "HolderResultItem" → "HolderResultItem2": enum "HolderResultItem" owns the name',
      );
      warn.mockClear();
      expectIterates(ir, 'items', 'HolderResult', 'items', 'HolderResultItem2');
      expect(models(ir)).toEqual([
        'Holder { result: HolderResult }',
        'HolderResult { items: HolderResultItem2[] }',
        'HolderResultItem2 { name: string }',
      ]);
      expect(ir.enums.map((e) => e.name)).toEqual(['HolderResultItem']);
    });

    it('types the iterator unknown, with a warning, when the pointer is typed unknown where it stands — an inline allOf member', async () => {
      // The document walk the override was accepted on reads through the
      // pointer to the member's `result.items`; the settle types the site
      // `unknown` (#539), and the iterator cannot yield a model the response
      // does not hold. No `ListOwnersResultItem` is built either way.
      const ir = await parseJson(spec(openapi, listOwners(ref('PetPage/allOf/1'), 'result.items'), { Meta, PetPage }));
      const op = onlyOperation(ir);
      expect(op.response).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(op.pagination).toMatchObject({
        dataPath: 'result.items',
        itemType: { kind: 'primitive', type: 'unknown' },
      });
      expect(models(ir)).toEqual([
        'Meta { total_pages: integer }',
        'PetPage { result: PetPageResult }',
        'PetPageResult { total_pages: integer, items: PetPageResultItem[] }',
        'PetPageResultItem { name: string }',
      ]);
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        '[oagen] Warning: Unresolved schema $ref "#/components/schemas/PetPage/allOf/1" in Owners.listOwners.response: "allOf/1" is an inline allOf member, which has no type of its own — typing the site as unknown',
        '[oagen] Warning: dataPath "result.items" on Owners.listOwners reaches no array in the response once its schema $ref is settled — typing the iterator\'s items as unknown',
      ]);
    });

    describe('Greptile review round 1', () => {
      /** `Holder.result` a `oneOf` of two components that declare `items` alike beside companions of their own. */
      const unionOf = (items: unknown) => ({
        A: object({ items: array(items), cursor: { type: 'string' } }),
        B: object({ items: array(items), total: { type: 'integer' } }),
        Holder: object({ result: { oneOf: [ref('A'), ref('B')] } }),
      });
      const idItem = object({ id: { type: 'string' } });

      it('reads a path that forks at a union from the document at extraction, as for a union the IR already holds (#556)', async () => {
        // Each variant's model types the inline items under a name of its own
        // (`AItem`, `BItem`), so the document types them once under the
        // path-derived name — the pointer response exactly as `$ref: Holder`.
        const root = await parseJson(spec(openapi, listOwners(pointer, 'items'), unionOf(idItem)));
        expect(onlyOperation(root).pagination).toMatchObject({
          dataPath: 'items',
          itemType: { kind: 'model', name: 'ListOwnersItem' },
        });
        expect(models(root)).toEqual([
          'A { items: AItem[], cursor: string }',
          'B { items: BItem[], total: integer }',
          'Holder { result: union }',
          'BItem { id: string }',
          'AItem { id: string }',
          'ListOwnersItem { id: string }',
        ]);
        const plain = await parseJson(spec(openapi, listOwners(ref('Holder'), 'result.items'), unionOf(idItem)));
        expect(onlyOperation(plain).pagination?.itemType).toEqual({ kind: 'model', name: 'ListOwnersResultItem' });
        const oneDown = await parseJson(
          spec(openapi, listOwners(object({ result: pointer }), 'result.items'), unionOf(idItem)),
        );
        expect(onlyOperation(oneDown).pagination?.itemType).toEqual({ kind: 'model', name: 'ListOwnersResultItem' });
        expect(warn).not.toHaveBeenCalled();
      });

      it('yields the component or primitive the variants share, minting nothing', async () => {
        const component = await parseJson(
          spec(openapi, listOwners(pointer, 'items'), { Pet: idItem, ...unionOf(ref('Pet')) }),
        );
        expect(onlyOperation(component).pagination?.itemType).toEqual({ kind: 'model', name: 'Pet' });
        expect(models(component).map((line) => line.split(' ')[0])).toEqual(['Pet', 'A', 'B', 'Holder']);
        const primitive = await parseJson(spec(openapi, listOwners(pointer, 'items'), unionOf({ type: 'string' })));
        expect(onlyOperation(primitive).pagination?.itemType).toEqual({ kind: 'primitive', type: 'string' });
        expect(models(primitive).map((line) => line.split(' ')[0])).toEqual(['A', 'B', 'Holder']);
        expect(warn).not.toHaveBeenCalled();
      });

      it('walks under every nullable wrapper the settled site wears — two for a nullable pointer to a nullable schema', async () => {
        const nullable = (schema: Record<string, unknown>) =>
          openapi === '3.1.0' ? { ...schema, type: ['object', 'null'] } : { ...schema, nullable: true };
        const nullableRef = (schema: unknown) =>
          openapi === '3.1.0' ? { oneOf: [schema, { type: 'null' }] } : { allOf: [schema], nullable: true };
        const Holder = object({ result: nullable(object({ items: array(idItem) })) });
        const ir = await parseJson(spec(openapi, listOwners(nullableRef(pointer), 'items'), { Holder }));
        const op = onlyOperation(ir);
        expectIterates(ir, 'items', 'HolderResult', 'items', 'HolderResultItem');
        expect(show(op.response)).toBe(openapi === '3.1.0' ? 'HolderResult??' : 'HolderResult?');
        expect(models(ir)).toEqual([
          'Holder { result: HolderResult? }',
          'HolderResult { items: HolderResultItem[] }',
          'HolderResultItem { id: string }',
        ]);
      });

      it('and where the path lands on a doubly nullable array', async () => {
        const nullableArray =
          openapi === '3.1.0'
            ? { type: ['array', 'null'], items: idItem }
            : { type: 'array', items: idItem, nullable: true };
        const nullableRef = (schema: unknown) =>
          openapi === '3.1.0' ? { oneOf: [schema, { type: 'null' }] } : { allOf: [schema], nullable: true };
        const ir = await parseJson(
          spec(openapi, listOwners(object({ result: nullableRef(pointer) }), 'result'), {
            Holder: object({ result: nullableArray }),
          }),
        );
        expectIterates(ir, 'result', 'ListOwnersResponse', 'result', 'HolderResult');
        expect(models(ir)).toEqual([
          'Holder { result: HolderResult[]? }',
          'HolderResult { id: string }',
          `ListOwnersResponse { result: HolderResult[]${openapi === '3.1.0' ? '??' : '?'} }`,
        ]);
      });
    });

    describe("MichaelDeBoey's review", () => {
      // A fork *before* the pointer: `{ oneOf: [A, B] }`, each variant with a
      // `kind` of its own and `result` the same pointer, so every variant
      // lands on the one array `Holder.result.items` is. No fork to read the
      // document for: the settled walk agrees on `HolderResultItem`, as it
      // does on `ResultItem` when both hold `$ref: Result`.
      const variant = (kind: string, result: unknown) => object({ kind: { type: 'string', enum: [kind] }, result });
      const ab = (result: unknown) => ({ A: variant('a', result), B: variant('b', result) });

      it("settles a fork whose variants all hold one pointer onto the pointed schema's item model, minting no copy", async () => {
        const ir = await parseJson(
          spec(openapi, listOwners({ oneOf: [ref('A'), ref('B')] }, 'result.items'), { Holder, ...ab(pointer) }),
        );
        expectIterates(ir, 'result.items', 'HolderResult', 'items', 'HolderResultItem');
        expect(models(ir)).toEqual([
          'Holder { result: HolderResult }',
          'A { kind: literal, result: HolderResult }',
          'B { kind: literal, result: HolderResult }',
          'HolderResult { items: HolderResultItem[] }',
          'HolderResultItem { name: string }',
        ]);
        // The control: `result` a component, both variants `$ref: Result`.
        const control = await parseJson(
          spec(openapi, listOwners({ oneOf: [ref('A'), ref('B')] }, 'result.items'), {
            Holder: object({ result: ref('Result') }),
            Result: result,
            ...ab(ref('Result')),
          }),
        );
        expectIterates(control, 'result.items', 'Result', 'items', 'ResultItem');
        expect(models(control).map((line) => line.split(' ')[0])).toEqual(['Holder', 'Result', 'A', 'B', 'ResultItem']);
      });

      it('one level down, through an anyOf (page.result.items), minting no ListOwnersPageResultItem', async () => {
        const ir = await parseJson(
          spec(openapi, listOwners(object({ page: { anyOf: [ref('A'), ref('B')] } }), 'page.result.items'), {
            Holder,
            ...ab(pointer),
          }),
        );
        expectIterates(ir, 'page.result.items', 'HolderResult', 'items', 'HolderResultItem');
        expect(models(ir)).toEqual([
          'Holder { result: HolderResult }',
          'A { kind: literal, result: HolderResult }',
          'B { kind: literal, result: HolderResult }',
          'HolderResult { items: HolderResultItem[] }',
          'ListOwnersResponse { page: union }',
          'HolderResultItem { name: string }',
        ]);
      });

      it('and when two pointers resolve to one component, as the variants written inline do', async () => {
        const twoPointers = await parseJson(
          spec(openapi, listOwners({ oneOf: [ref('A'), ref('B')] }, 'result.items'), {
            Holder: object({ result: ref('Result') }),
            Other: object({ result: ref('Result') }),
            Result: result,
            A: variant('a', pointer),
            B: variant('b', ref('Other/properties/result')),
          }),
        );
        expectIterates(twoPointers, 'result.items', 'Result', 'items', 'ResultItem');
        expect(models(twoPointers).map((line) => line.split(' ')[0])).toEqual([
          'Holder',
          'Other',
          'Result',
          'A',
          'B',
          'ResultItem',
        ]);
        const inline = await parseJson(
          spec(openapi, listOwners({ oneOf: [variant('a', pointer), variant('b', pointer)] }, 'result.items'), {
            Holder,
          }),
        );
        expectIterates(inline, 'result.items', 'HolderResult', 'items', 'HolderResultItem');
        expect(models(inline).map((line) => line.split(' ')[0])).toEqual([
          'Holder',
          'HolderResult',
          'ListOwnersResponse',
          'BListOwnersResponse',
          'HolderResultItem',
        ]);
      });

      it('still reads the document where the variants reach distinct arrays — a pointer beside an inline array, or two pointers to two schemas (#556)', async () => {
        const beside = await parseJson(
          spec(openapi, listOwners({ oneOf: [ref('A'), ref('B')] }, 'result.items'), {
            Holder,
            A: variant('a', pointer),
            B: variant('b', result),
          }),
        );
        expect(onlyOperation(beside).pagination?.itemType).toEqual({ kind: 'model', name: 'ListOwnersResultItem' });
        expect(models(beside).map((line) => line.split(' ')[0])).toContain('ListOwnersResultItem');
        const two = await parseJson(
          spec(openapi, listOwners({ oneOf: [ref('A'), ref('B')] }, 'result.items'), {
            Holder,
            Other: object({ result }),
            A: variant('a', pointer),
            B: variant('b', ref('Other/properties/result')),
          }),
        );
        expect(onlyOperation(two).pagination?.itemType).toEqual({ kind: 'model', name: 'ListOwnersResultItem' });
        expect(models(two).map((line) => line.split(' ')[0])).toEqual([
          'Holder',
          'Other',
          'A',
          'B',
          'OtherResult',
          'HolderResult',
          'ListOwnersResultItem',
          'HolderResultItem',
          'OtherResultItem',
        ]);
        expect(warn).not.toHaveBeenCalled();
      });
    });

    it('without an override, the pointer response still yields the settled response itself (#539)', async () => {
      const ir = await parseJson(spec(openapi, listOwners(pointer, undefined), { Holder }));
      const op = onlyOperation(ir);
      expect(op.response).toEqual({ kind: 'model', name: 'HolderResult' });
      expect(op.pagination?.itemType).toBe(op.response);
      expect(models(ir)).toEqual([...holderModels, 'HolderResultItem { name: string }']);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('reads the object member of a type list on the path, through a pointer and in a plain body alike (OAS 3.1)', async () => {
    // `type: ['object', 'string']` is a union of one variant per type; the
    // document walk reads its `properties`, so the IR walk reads the object
    // member's model rather than failing on the string member — no
    // `ListOwnersResultItem` copy for the plain body either.
    const idItem = object({ id: { type: 'string' } });
    const result = object({ items: array(idItem) }, { type: ['object', 'string'] });
    const viaPointer = await parseJson(spec('3.1.0', listOwners(pointer, 'items'), { Holder: object({ result }) }));
    expectIterates(viaPointer, 'items', 'HolderResult', 'items', 'HolderResultItem');
    expect(models(viaPointer)).toEqual([
      'Holder { result: union }',
      'HolderResult { items: HolderResultItem[] }',
      'HolderResultItem { id: string }',
    ]);
    const plain = await parseJson(spec('3.1.0', listOwners(object({ result }), 'result.items'), {}));
    expectIterates(plain, 'result.items', 'ListOwnersResponseResult', 'items', 'ListOwnersResponseResultItem');
    expect(models(plain)).toEqual([
      'ListOwnersResponse { result: union }',
      'ListOwnersResponseResult { items: ListOwnersResponseResultItem[] }',
      'ListOwnersResponseResultItem { id: string }',
    ]);
  });

  describe('the IR walk and the settle', () => {
    const named = (name: string): TypeRef => ({ kind: 'model', name });
    const petArray: TypeRef = { kind: 'array', items: named('Pet') };
    const model = (name: string, fields: Record<string, TypeRef>): Model => ({
      name,
      fields: Object.entries(fields).map(([field, type]) => ({ name: field, type, required: true })),
    });
    const pool: Model[] = [model('Wrapper', { result: named('Result') }), model('Result', { items: petArray })];
    const pending = () => pendingSchemaRef('#/components/schemas/Holder/properties/result');
    const union = (...variants: TypeRef[]): TypeRef => ({ kind: 'union', variants, compositionKind: 'oneOf' });

    it('reports a pending reference at the root, on the way, as a union variant in either order, or where the path lands', () => {
      expect(walkDataPathItemType(named('Wrapper'), 'result.items', pool)).toEqual({ itemType: named('Pet') });
      expect(walkDataPathItemType(pending(), 'items', pool)).toEqual({ pending: true });
      expect(walkDataPathItemType({ kind: 'nullable', inner: pending() }, 'items', pool)).toEqual({ pending: true });
      const onTheWay = [model('Pointing', { result: pending() }), ...pool];
      expect(walkDataPathItemType(named('Pointing'), 'result.items', onTheWay)).toEqual({ pending: true });
      // Where the path lands, under its nullable wrapper too.
      expect(walkDataPathItemType(named('Pointing'), 'result', onTheWay)).toEqual({ pending: true });
      const landsNullable = [model('Pointing', { result: { kind: 'nullable', inner: pending() } }), ...pool];
      expect(walkDataPathItemType(named('Pointing'), 'result', landsNullable)).toEqual({ pending: true });
      // A pending variant is reported before any other variant is read, so the order never decides.
      for (const variants of [
        [named('Result'), pending()],
        [pending(), named('Result')],
        [named('Nope'), pending()],
      ]) {
        const root = union(...variants);
        expect(walkDataPathItemType(root, 'items', pool), JSON.stringify(variants)).toEqual({ pending: true });
      }
    });

    it('looks under every nullable wrapper on the way and where the path lands, and through a type list to its object member', () => {
      const twice = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner: { kind: 'nullable', inner } });
      const doubly = [model('Doubly', { result: twice(named('Result')) }), model('Result', { items: twice(petArray) })];
      expect(walkDataPathItemType(twice(named('Doubly')), 'result.items', doubly)).toEqual({ itemType: named('Pet') });
      expect(walkDataPathItemType(named('Doubly'), 'result', [model('Doubly', { result: twice(petArray) })])).toEqual({
        itemType: named('Pet'),
      });
      expect(walkDataPathItemType(twice(pending()), 'items', pool)).toEqual({ pending: true });
      // A type list's union carries no `compositionKind`; its object member is read, the string member stepped past.
      const typeList: TypeRef = { kind: 'union', variants: [named('Result'), { kind: 'primitive', type: 'string' }] };
      expect(walkDataPathItemType(typeList, 'items', pool)).toEqual({ itemType: named('Pet') });
      expect(
        walkDataPathItemType(named('Listed'), 'result.items', [model('Listed', { result: typeList }), ...pool]),
      ).toEqual({
        itemType: named('Pet'),
      });
      // A `oneOf` with a non-model variant still fails, as every variant must declare the segment (#556).
      expect(
        walkDataPathItemType(union(named('Result'), { kind: 'primitive', type: 'string' }), 'items', pool),
      ).toBeUndefined();
    });

    it('tells a path that forks at a union from one that does not (dataPathForks)', () => {
      const idItem: SchemaObject = { type: 'object', properties: { id: { type: 'string' } } };
      const result: SchemaObject = { type: 'object', properties: { items: { type: 'array', items: idItem } } };
      // Two components of one shape, each with an array of its own, as a document declares them.
      const other: SchemaObject = structuredClone(result);
      other.properties = { ...other.properties, total: { type: 'integer' } };
      const components: Record<string, SchemaObject> = { A: result, B: other };
      const body = (r: SchemaObject): SchemaObject => ({ type: 'object', properties: { result: r } });
      expect(dataPathForks(body(result), 'result.items', components)).toBe(false);
      expect(
        dataPathForks(
          body({ oneOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }] }),
          'result.items',
          components,
        ),
      ).toBe(true);
      expect(
        dataPathForks(
          { anyOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }] },
          'items',
          components,
        ),
      ).toBe(true);
      // A `null` variant set aside as a nullable wrapper is no fork; a path that lands on no array forks nowhere.
      expect(dataPathForks(body({ oneOf: [result, { type: 'null' }] }), 'result.items', components)).toBe(false);
      expect(dataPathForks(body(result), 'result.nope', components)).toBe(false);
      // Variants landing on one array are no fork: one pointer held by both, or two pointers to one component
      // (MichaelDeBoey, #651 review); two pointers to two schemas are.
      const pointer = { $ref: '#/components/schemas/Holder/properties/result' };
      const holders: Record<string, SchemaObject> = {
        Holder: { type: 'object', properties: { result } },
        Other: { type: 'object', properties: { result: { $ref: '#/components/schemas/Result' } } },
        Owner: { type: 'object', properties: { result: { $ref: '#/components/schemas/Result' } } },
        Result: result,
        Apart: { type: 'object', properties: { result: structuredClone(result) } },
      };
      const variants = (...results: SchemaObject[]) => ({
        oneOf: results.map((r) => ({ type: 'object', properties: { result: r } })),
      });
      expect(dataPathForks(variants(pointer, pointer), 'result.items', holders)).toBe(false);
      expect(
        dataPathForks(
          variants(
            { $ref: '#/components/schemas/Other/properties/result' },
            { $ref: '#/components/schemas/Owner/properties/result' },
          ),
          'result.items',
          holders,
        ),
      ).toBe(false);
      expect(
        dataPathForks(
          variants(pointer, { $ref: '#/components/schemas/Apart/properties/result' }),
          'result.items',
          holders,
        ),
      ).toBe(true);
      expect(dataPathForks(variants(pointer, structuredClone(result)), 'result.items', holders)).toBe(true);
    });

    it('keeps every other failure undefined, as before, so the document answers', () => {
      expect(walkDataPathItemType(named('Nope'), 'items', pool)).toBeUndefined();
      expect(walkDataPathItemType(named('Wrapper'), 'nope', pool)).toBeUndefined();
      expect(walkDataPathItemType(named('Wrapper'), 'result', pool)).toBeUndefined();
      expect(resolveDataPathItemType(named('Wrapper'), 'result.items', pool)).toBe(petArray.items);
      expect(resolveDataPathItemType(pending(), 'items', pool)).toBeUndefined();
    });

    it('starts the walk at the response, or at the companion an unwrapped envelope names', () => {
      const response = named('Wrapper');
      expect(dataPathWalkStart(response, undefined, 'result.items')).toEqual({ root: response, path: 'result.items' });
      const meta: Field = { name: 'meta', type: named('Result'), required: true };
      expect(dataPathWalkStart(petArray, [meta], 'meta.items')).toEqual({ root: meta.type, path: 'items' });
      expect(dataPathWalkStart(petArray, [meta], 'other.items')).toBeUndefined();
    });

    it('settles the placeholder to the very type the settled field holds, or to unknown with a warning', () => {
      const placeholder = deferDataPathItemType();
      expect(isDeferredDataPathItemType(placeholder)).toBe(true);
      expect(isDeferredDataPathItemType({ kind: 'primitive', type: 'unknown' })).toBe(false);
      const pagination: PaginationMeta = {
        strategy: 'cursor',
        param: 'cursor',
        dataPath: 'result.items',
        itemType: placeholder,
      };
      settleDeferredDataPathItemType(pagination, named('Wrapper'), pool, 'Owners.listOwners');
      expect(pagination.itemType).toBe(petArray.items);
      expect(warn).not.toHaveBeenCalled();

      const unresolved: PaginationMeta = {
        strategy: 'cursor',
        param: 'cursor',
        dataPath: 'result.items',
        itemType: deferDataPathItemType(),
      };
      settleDeferredDataPathItemType(unresolved, { kind: 'primitive', type: 'unknown' }, pool, 'Owners.listOwners');
      expect(unresolved.itemType).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[oagen] Warning: dataPath "result.items" on Owners.listOwners reaches no array in the response once its schema $ref is settled — typing the iterator\'s items as unknown',
      );
    });
  });
});
