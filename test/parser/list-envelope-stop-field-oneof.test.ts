import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';
import {
  collectObjectProperties,
  detectEndOfIteration,
  endOfIterationProblem,
  resolveSchemaPath,
} from '../../src/parser/pagination.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import type { ApiSpec, Field, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #622: a list envelope whose stop field sits in a `oneOf` beside its
 * `allOf` was not read as a list. Since #597 such a body is one model, the
 * union's properties its optional fields — `ListPetsResponse { data,
 * has_more?, total? }`, the very fields the envelope written flat has — but
 * envelope detection read the `allOf` members' own `properties` alone, so
 * it found `data` without a companion: no `dataPath`, no `endOfIteration`,
 * and the iterator yielded `ListPetsResponse` itself. Detection and the
 * stop-field read now see the property set the model is built from; the
 * array and the stop field must be carried by every instance (a member's,
 * or every variant's), a companion may be any variant's.
 */

const openapis = ['3.1.0', '3.0.3'] as const;
const petRef = { $ref: '#/components/schemas/Pet' };
const object = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object',
  properties,
  ...(required && { required }),
});
const boolean = { type: 'boolean' };
const integer = { type: 'integer' };
const string = { type: 'string' };
const petArray = { type: 'array', items: petRef };

/** The issue's `flat.json` body: `{ data: Pet[], has_more?: boolean, total?: integer }`, `data` required. */
const flat = object({ data: petArray, has_more: boolean, total: integer }, ['data']);
/** The issue's `split.json` members: `data` in the `allOf`, `has_more` in each `oneOf` variant. */
const dataMember = object({ data: petArray }, ['data']);
const withHasMore = object({ has_more: boolean }, ['has_more']);
const withTotal = object({ has_more: boolean, total: integer }, ['has_more']);
const split = { allOf: [dataMember], oneOf: [withHasMore, withTotal] };

const info = { title: 'repro', version: '1' };
/** The issue's document: `GET /pets` (`listPets`, an `after` query parameter) returning `schema`, beside the `Pet` component. */
function listPets(
  schema: unknown,
  openapi: string = '3.1.0',
  extra: Record<string, unknown> = {},
  schemas: Record<string, unknown> = {},
) {
  return {
    openapi,
    info,
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [{ name: 'after', in: 'query', schema: string }],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
          ...extra,
        },
      },
    },
    components: { schemas: { Pet: object({ name: string }), ...schemas } },
  };
}

async function withTempDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-622-'));
  try {
    return await use(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/** Parse `doc` from a temp JSON file, as `oagen` reads it. */
async function parse(doc: unknown): Promise<ApiSpec> {
  return withTempDir(async (dir) => {
    const file = path.join(dir, 'spec.json');
    await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
    return parseSpec(file);
  });
}

/** Parse, asserting that nothing was warned about. */
async function parseQuiet(doc: unknown): Promise<ApiSpec> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parse(doc);
    expect(warn.mock.calls).toEqual([]);
    return ir;
  } finally {
    warn.mockRestore();
  }
}

/** Parse, returning the warnings issued. */
async function parseWarning(doc: unknown): Promise<{ ir: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parse(doc);
    return { ir, warnings: warn.mock.calls.map(([message]) => String(message)) };
  } finally {
    warn.mockRestore();
  }
}

const onlyOperation = (ir: ApiSpec): Operation => {
  const operations = ir.services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return operations[0]!;
};

const typeName = (type: TypeRef): string =>
  'name' in type ? type.name : 'type' in type ? String(type.type) : type.kind;
const fieldsOf = (fields: Field[] | undefined): string[] | undefined =>
  fields?.map(({ name, required, type }) => `${name}${required ? '' : '?'}: ${typeName(type)}`);
const modelsOf = (ir: ApiSpec): string[] =>
  ir.models.map(
    ({ fields, name }) => `${name} { ${fields.map((f) => `${f.name}${f.required ? '' : '?'}`).join(', ')} }`,
  );

/** The issue's projection of the parse, with the envelope fields beside it. */
function shown(ir: ApiSpec) {
  const { pagination, response } = onlyOperation(ir);
  return {
    dataPath: pagination?.dataPath,
    endOfIteration: pagination?.endOfIteration,
    itemType: pagination?.itemType ? typeName(pagination.itemType) : undefined,
    envelopeFields: fieldsOf(pagination?.envelopeFields),
    models: modelsOf(ir),
    response: response.kind === 'array' ? `${typeName(response.items)}[]` : typeName(response),
  };
}

/** What `flat.json` gives, which `split.json` must give too. */
const expected = {
  dataPath: 'data',
  endOfIteration: { kind: 'hasMore', path: 'has_more' },
  itemType: 'Pet',
  envelopeFields: ['has_more?: boolean', 'total?: integer'],
  models: ['Pet { name? }'],
  response: 'Pet[]',
};

describe('#622', () => {
  describe("the issue's documents", () => {
    it.each(openapis)(
      'reads split.json as flat.json: Pet[] on data, has_more the stop field, no ListPetsResponse model (OAS %s)',
      async (openapi) => {
        const flatIr = await parseQuiet(listPets(flat, openapi));
        const splitIr = await parseQuiet(listPets(split, openapi));
        expect(shown(flatIr)).toEqual(expected);
        expect(shown(splitIr)).toEqual(expected);
        // The whole pagination entry, not only its projection.
        expect(onlyOperation(splitIr).pagination).toEqual(onlyOperation(flatIr).pagination);
        expect(onlyOperation(splitIr).response).toEqual(onlyOperation(flatIr).response);
        expect(diffSpecs(flatIr, splitIr).changes).toEqual([]);
        expect(diffSpecs(splitIr, flatIr).changes).toEqual([]);
      },
    );

    it('oagen diff --old flat.json --new split.json reports no change and exits 0', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await withTempDir(async (dir) => {
          const flatFile = path.join(dir, 'flat.json');
          const splitFile = path.join(dir, 'split.json');
          await fs.writeFile(flatFile, JSON.stringify(listPets(flat)), 'utf-8');
          await fs.writeFile(splitFile, JSON.stringify(listPets(split)), 'utf-8');
          for (const [oldFile, newFile] of [
            [flatFile, splitFile],
            [splitFile, flatFile],
          ]) {
            const err: { exitCode?: number } = await diffCommand({ old: oldFile, new: newFile }).catch((e) => e);
            expect(err.exitCode).toBe(0);
          }
        });
      } finally {
        log.mockRestore();
      }
    });
  });

  describe('the class: the union whichever way it is written', () => {
    it.each(openapis)(
      'reads the oneOf before the allOf, an anyOf, and the union written as a member alike (OAS %s)',
      async (openapi) => {
        const spellings: Record<string, unknown> = {
          'oneOf first': { oneOf: [withHasMore, withTotal], allOf: [dataMember] },
          anyOf: { allOf: [dataMember], anyOf: [withHasMore, withTotal] },
          'anyOf first': { anyOf: [withHasMore, withTotal], allOf: [dataMember] },
          'oneOf as a member': { allOf: [dataMember, { oneOf: [withHasMore, withTotal] }] },
          'member first': { allOf: [{ oneOf: [withHasMore, withTotal] }, dataMember] },
          'anyOf as a member': { allOf: [dataMember, { anyOf: [withHasMore, withTotal] }] },
        };
        for (const [label, schema] of Object.entries(spellings)) {
          expect(shown(await parseQuiet(listPets(schema, openapi))), label).toEqual(expected);
        }
      },
    );

    it.each(openapis)(
      'reads the reverse split — the array in every variant, the stop field in the allOf (OAS %s)',
      async (openapi) => {
        const reverse = {
          allOf: [object({ has_more: boolean }, ['has_more'])],
          oneOf: [object({ data: petArray }), object({ data: petArray, total: integer })],
        };
        expect(shown(await parseQuiet(listPets(reverse, openapi)))).toEqual({
          ...expected,
          envelopeFields: ['has_more: boolean', 'total?: integer'],
        });
      },
    );

    it('reads every stop-field kind, a cursor companion and a metadata object the variants declare', async () => {
      const envelope = (...variants: unknown[]) => ({ allOf: [dataMember], oneOf: variants });
      const stops = (ir: ApiSpec) => {
        const { dataPath, endOfIteration, envelopeFields, response } = shown(ir);
        return { dataPath, endOfIteration, envelopeFields, response };
      };
      expect(
        stops(await parseQuiet(listPets(envelope(object({ total_pages: integer }), object({ total_pages: integer }))))),
      ).toEqual({
        dataPath: 'data',
        endOfIteration: { kind: 'totalPages', path: 'total_pages' },
        envelopeFields: ['total_pages?: integer'],
        response: 'Pet[]',
      });
      expect(
        stops(
          await parseQuiet(listPets(envelope(object({ total: integer }), object({ total: integer, page: integer })))),
        ),
      ).toEqual({
        dataPath: 'data',
        endOfIteration: { kind: 'totalCount', path: 'total' },
        envelopeFields: ['total?: integer', 'page?: integer'],
        response: 'Pet[]',
      });
      // A cursor is a companion by name, not a stop field: the envelope is
      // unwrapped and the iterator stops on an empty page.
      expect(
        stops(
          await parseQuiet(
            listPets(envelope(object({ next_cursor: string }), object({ next_cursor: string, total: integer }))),
          ),
        ),
      ).toEqual({
        dataPath: 'data',
        endOfIteration: undefined,
        envelopeFields: ['next_cursor?: string', 'total?: integer'],
        response: 'Pet[]',
      });
      // A metadata object every variant declares alike is the one companion model.
      const metadata = object({ after: string, has_more: boolean });
      const withMetadata = await parseQuiet(
        listPets(envelope(object({ list_metadata: metadata }), object({ list_metadata: metadata }))),
      );
      expect(stops(withMetadata)).toEqual({
        dataPath: 'data',
        endOfIteration: { kind: 'hasMore', path: 'list_metadata.has_more' },
        envelopeFields: ['list_metadata?: ListMetadata'],
        response: 'Pet[]',
      });
      expect(modelsOf(withMetadata)).toEqual(['Pet { name? }', 'ListMetadata { after?, has_more? }']);
    });

    it('reads the stop field through $ref variants, as the model reads them', async () => {
      const schemas = {
        CursorMeta: object({ has_more: boolean, next_after: string }),
        PageMeta: object({ has_more: boolean, next_page: integer }),
      };
      const refs = {
        allOf: [dataMember],
        oneOf: [{ $ref: '#/components/schemas/CursorMeta' }, { $ref: '#/components/schemas/PageMeta' }],
      };
      expect(shown(await parseQuiet(listPets(refs, '3.1.0', {}, schemas)))).toEqual({
        ...expected,
        envelopeFields: ['has_more?: boolean', 'next_after?: string', 'next_page?: integer'],
        models: ['Pet { name? }', 'CursorMeta { has_more?, next_after? }', 'PageMeta { has_more?, next_page? }'],
      });
    });

    it('reads a stop field the variants of a flattened union inside a metadata companion declare', async () => {
      const flattened = {
        allOf: [object({ trace_id: string })],
        oneOf: [object({ has_more: boolean }), object({ has_more: boolean, next: string })],
      };
      const ir = await parseQuiet(listPets(object({ data: petArray, meta: flattened }, ['data'])));
      expect(shown(ir)).toEqual({
        ...expected,
        endOfIteration: { kind: 'hasMore', path: 'meta.has_more' },
        envelopeFields: ['meta?: Meta'],
        models: ['Pet { name? }', 'Meta { trace_id?, has_more?, next? }'],
      });
      // A companion that is a union of models declares no stop field, as before.
      const union = { oneOf: [object({ has_more: boolean }), object({ has_more: boolean, next: string })] };
      const unionIr = await parseQuiet(listPets(object({ data: petArray, meta: union }, ['data'])));
      expect(shown(unionIr).endOfIteration).toBeUndefined();
      expect(shown(unionIr).dataPath).toBe('data');
    });

    it('keeps a bare oneOf body, with or without properties beside it, the union it is', async () => {
      const page = object({ data: petArray, has_more: boolean });
      const total = object({ data: petArray, total: integer });
      for (const schema of [
        { oneOf: [page, total] },
        { properties: { data: petArray }, oneOf: [withHasMore, withTotal] },
      ]) {
        const { pagination, response } = onlyOperation(await parseQuiet(listPets(schema)));
        expect(response.kind).toBe('union');
        expect(pagination?.dataPath).toBeUndefined();
        expect(pagination?.endOfIteration).toBeUndefined();
      }
    });

    it.each(openapis)(
      'keeps an allOf read as its lone union member the union it is, as the model does (PR #643 review; OAS %s)',
      async (openapi) => {
        // Every variant declares `data` and `has_more`, but the `allOf` is
        // not merged: the body is the union. It read as `string[]` with no
        // companions when the variants were read as a merge's.
        const page = object({ data: petArray, has_more: boolean });
        const total = object({ data: petArray, has_more: boolean, total: integer });
        for (const keyword of ['oneOf', 'anyOf'] as const) {
          const bare = await parseQuiet(listPets({ [keyword]: [page, total] }, openapi));
          expect(onlyOperation(bare).response.kind, keyword).toBe('union');
          for (const lone of [
            { allOf: [{ [keyword]: [page, total] }] },
            { allOf: [{ [keyword]: [page, total] }], description: 'A page' },
          ]) {
            const ir = await parseQuiet(listPets(lone, openapi));
            expect(shown(ir), keyword).toEqual(shown(bare));
            expect(onlyOperation(ir).response, keyword).toEqual(onlyOperation(bare).response);
            expect(onlyOperation(ir).pagination?.dataPath, keyword).toBeUndefined();
          }
        }
      },
    );

    it.each(openapis)(
      "leaves what is written beside a $ref member's reference unread, as the model and the walk do (PR #643 review; OAS %s)",
      async (openapi) => {
        // The model and the companion walk read a `$ref` member as its
        // component and nothing beside the reference, so a `data` every
        // sibling variant declares, or one sibling `properties` declare,
        // marks no envelope: the body is the model the sibling-less
        // document builds. Read beside the reference, it marked an envelope
        // the walk had no `data` in, and the response was `string[]`.
        const schemas = { Base: object({ id: string }) };
        const ints = { type: 'array', items: integer };
        const base = { $ref: '#/components/schemas/Base' };
        const plain = await parseQuiet(
          listPets({ allOf: [object({ has_more: boolean }), base] }, openapi, {}, schemas),
        );
        expect(shown(plain)).toMatchObject({
          dataPath: undefined,
          models: ['Pet { name? }', 'Base { id? }', 'ListPetsResponse { has_more?, id? }'],
          response: 'ListPetsResponse',
        });
        const siblings: Record<string, unknown> = {
          oneOf: { ...base, oneOf: [object({ data: ints }), object({ data: ints })] },
          anyOf: { ...base, anyOf: [object({ data: ints }), object({ data: ints })] },
          properties: { ...base, properties: { data: ints } },
        };
        for (const [label, member] of Object.entries(siblings)) {
          const ir = await parseQuiet(
            listPets({ allOf: [object({ has_more: boolean }), member] }, openapi, {}, schemas),
          );
          expect(shown(ir), label).toEqual(shown(plain));
          expect(onlyOperation(ir).response, label).toEqual(onlyOperation(plain).response);
        }
      },
    );

    it.each(openapis)(
      'unwraps only on the array the companion walk reads at that name, which a referenced or nested member may type otherwise (PR #643 review; OAS %s)',
      async (openapi) => {
        // `Base` annotates `data` without typing it, or types it an object;
        // every variant types it `integer[]`. The walk and the model keep
        // `Base`'s declaration — an always-applying one stands over a
        // branch-only one — so there is no array to unwrap on and the body
        // is the model. Read off the variants alone, detection unwrapped it
        // and the response was `string[]` with no item model.
        const ints = { type: 'array', items: integer };
        const A = object({ data: ints, has_more: boolean });
        const B = object({ data: ints, has_more: boolean, total: integer });
        const base = { $ref: '#/components/schemas/Base' };
        const typeless = { Base: object({ data: { description: 'Page data' } }) };
        const cases: Array<[string, unknown, Record<string, unknown>]> = [
          ['oneOf beside a $ref', { allOf: [base, { oneOf: [A, B] }] }, typeless],
          ['anyOf beside a $ref', { allOf: [base, { anyOf: [A, B] }] }, typeless],
          [
            'nested allOf member',
            { allOf: [{ allOf: [object({ data: { description: 'Page data' } })] }, { oneOf: [A, B] }] },
            {},
          ],
          [
            'object in the component',
            { allOf: [base, { oneOf: [A, B] }] },
            { Base: object({ data: object({ x: string }) }) },
          ],
        ];
        for (const [label, body, schemas] of cases) {
          const ir = await parseQuiet(listPets(body, openapi, {}, schemas));
          expect(shown(ir).dataPath, label).toBeUndefined();
          expect(onlyOperation(ir).response, label).toEqual({ kind: 'model', name: 'ListPetsResponse' });
          expect(modelsOf(ir), label).toContain('ListPetsResponse { data?, has_more?, total? }');
        }
        // The array `Base` types is the one the walk reads: unwrapped on it.
        const typed = await parseQuiet(
          listPets({ allOf: [base, { oneOf: [A, B] }] }, openapi, {}, { Base: object({ data: ints }) }),
        );
        expect(shown(typed)).toEqual({
          dataPath: 'data',
          endOfIteration: { kind: 'hasMore', path: 'has_more' },
          itemType: 'integer',
          envelopeFields: ['has_more?: boolean', 'total?: integer'],
          models: ['Pet { name? }', 'Base { data? }'],
          response: 'integer[]',
        });
      },
    );
  });

  describe("the rule: a stop field counts when every variant declares it with the kind's type", () => {
    const someVariants = { allOf: [dataMember], oneOf: [withHasMore, object({ total: integer })] };
    const disagreeing = { allOf: [dataMember], oneOf: [withHasMore, object({ has_more: string })] };
    const hasMore = { kind: 'hasMore', path: 'has_more' };

    it('reads it when every variant declares it, and an explicit endOfIteration restates it', async () => {
      const ir = await parseQuiet(listPets(split, '3.1.0', { 'x-pagination': { endOfIteration: hasMore } }));
      expect(shown(ir)).toEqual(expected);
    });

    it.each(openapis)(
      'leaves a stop field only some variants declare a companion of the envelope, and no stop field (OAS %s)',
      async (openapi) => {
        // `has_more?` is a field of the model, as of the envelope: the body is
        // the list it is, and the iterator stops on an empty page.
        expect(shown(await parseQuiet(listPets(someVariants, openapi)))).toEqual({
          ...expected,
          endOfIteration: undefined,
        });
        // An explicit path to it is rejected by the same rule, so detection
        // and the override agree on which fields are there to stop on.
        const { ir, warnings } = await parseWarning(
          listPets(someVariants, openapi, { 'x-pagination': { endOfIteration: hasMore } }),
        );
        expect(shown(ir).endOfIteration).toBeUndefined();
        expect(warnings).toEqual([
          expect.stringContaining('endOfIteration path "has_more" does not resolve to a field in the response'),
        ]);
      },
    );

    it.each(openapis)(
      'leaves a stop field the variants type differently a companion typed as their union, and no stop field (OAS %s)',
      async (openapi) => {
        const ir = await parseQuiet(listPets(disagreeing, openapi));
        expect(shown(ir)).toEqual({ ...expected, endOfIteration: undefined, envelopeFields: ['has_more?: union'] });
        expect(onlyOperation(ir).pagination?.envelopeFields?.[0]?.type).toEqual({
          kind: 'union',
          variants: [
            { kind: 'primitive', type: 'boolean' },
            { kind: 'primitive', type: 'string' },
          ],
          compositionKind: 'oneOf',
        });
        const { warnings } = await parseWarning(
          listPets(disagreeing, openapi, { 'x-pagination': { endOfIteration: hasMore } }),
        );
        expect(warnings).toEqual([
          expect.stringContaining('endOfIteration path "has_more" is not a boolean field, as kind "hasMore" requires'),
        ]);
      },
    );

    it("keeps a member's declaration over the variants', whatever they say", async () => {
      // A boolean every instance carries ends the iteration however a
      // variant narrows it; a string member is no stop field however the
      // variants type it.
      const member = (declaration: unknown, variant: unknown) => ({
        allOf: [object({ data: petArray, has_more: declaration }, ['data'])],
        oneOf: [object({ has_more: variant }), object({ total: integer })],
      });
      expect(shown(await parseQuiet(listPets(member(boolean, string))))).toEqual(expected);
      expect(shown(await parseQuiet(listPets(member(string, boolean))))).toEqual({
        ...expected,
        endOfIteration: undefined,
        envelopeFields: ['has_more?: string', 'total?: integer'],
      });
    });

    it('leaves a body whose array only some variants declare the model it is', async () => {
      // The array an iterator unwraps on must be there whichever variant the
      // wire sends, as an explicit `dataPath` is resolved through a union.
      const ir = await parseQuiet(
        listPets({
          allOf: [object({ has_more: boolean }, ['has_more'])],
          oneOf: [object({ data: petArray }), object({ total: integer })],
        }),
      );
      expect(shown(ir)).toEqual({
        dataPath: undefined,
        endOfIteration: undefined,
        itemType: 'ListPetsResponse',
        envelopeFields: undefined,
        models: ['Pet { name? }', 'ListPetsResponse { has_more, data?, total? }'],
        response: 'ListPetsResponse',
      });
    });

    it('keeps the split body as one model under strategy none, exactly as the flat one', async () => {
      const none = { 'x-pagination': { strategy: 'none' } };
      const flatIr = await parseQuiet(listPets(flat, '3.1.0', none));
      const splitIr = await parseQuiet(listPets(split, '3.1.0', none));
      expect(shown(splitIr)).toEqual(shown(flatIr));
      expect(shown(splitIr)).toMatchObject({
        dataPath: undefined,
        models: ['Pet { name? }', 'ListPetsResponse { data, has_more?, total? }'],
        response: 'ListPetsResponse',
      });
    });
  });

  describe('the readers', () => {
    const components: Record<string, SchemaObject> = { Pet: object({ name: string }) as SchemaObject };
    const folded: SchemaObject = { allOf: [dataMember, { oneOf: [withHasMore, withTotal] }] } as SchemaObject;

    it('collectObjectProperties reads the fields the model has, and those every instance carries', () => {
      const collected = collectObjectProperties(folded, components);
      expect(Object.keys(collected.properties)).toEqual(['data']);
      expect(Object.keys(collected.fields)).toEqual(['data', 'has_more', 'total']);
      expect(Object.keys(collected.onEveryInstance)).toEqual(['data', 'has_more']);
      expect(collected.fields['has_more']).toEqual(boolean);
      expect(collected.required).toEqual(['data']);
      // A name only some variants declare, and one they type differently.
      const some = collectObjectProperties(
        { allOf: [dataMember, { oneOf: [withHasMore, object({ total: integer })] }] } as SchemaObject,
        components,
      );
      expect(Object.keys(some.fields)).toEqual(['data', 'has_more', 'total']);
      expect(Object.keys(some.onEveryInstance)).toEqual(['data']);
      const typed = collectObjectProperties(
        { allOf: [dataMember, { oneOf: [withHasMore, object({ has_more: string })] }] } as SchemaObject,
        components,
      );
      expect(typed.onEveryInstance['has_more']).toEqual({ oneOf: [boolean, string] });
      // The node's own union is a union of models: no field of the node.
      const union = collectObjectProperties({ oneOf: [withHasMore, withTotal] } as SchemaObject, components);
      expect(union.fields).toEqual({});
      expect(union.unions).toHaveLength(1);
    });

    it('classifyAndExtractResponse, detectEndOfIteration, endOfIterationProblem and resolveSchemaPath agree', () => {
      const result = classifyAndExtractResponse(folded, 'ListPetsResponse', components);
      expect(result.isPaginated).toBe(true);
      expect(result.dataPath).toBe('data');
      expect(result.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });
      expect(fieldsOf(result.envelopeFields)).toEqual(['has_more?: boolean', 'total?: integer']);
      const { onEveryInstance } = collectObjectProperties(folded, components);
      expect(detectEndOfIteration(onEveryInstance, 'data', components)).toEqual({ kind: 'hasMore', path: 'has_more' });
      expect(endOfIterationProblem({ kind: 'hasMore', path: 'has_more' }, onEveryInstance, components)).toBeUndefined();
      // Through a companion: the flattened union's field is reached, a union
      // of models' is not.
      const flattened = {
        allOf: [object({ trace_id: string })],
        oneOf: [object({ has_more: boolean }), object({ has_more: boolean, next: string })],
      } as SchemaObject;
      expect(resolveSchemaPath({ properties: { meta: flattened } }, 'meta.has_more', components)).toEqual(boolean);
      expect(resolveSchemaPath({ properties: { meta: flattened } }, 'meta.next', components)).toBeUndefined();
      const union = { oneOf: [object({ has_more: boolean }), object({ has_more: boolean })] } as SchemaObject;
      expect(resolveSchemaPath({ properties: { meta: union } }, 'meta.has_more', components)).toBeUndefined();
    });
  });

  describe("MichaelDeBoey's review of PR #643", () => {
    const hasMore = (path: string) => ({ 'x-pagination': { endOfIteration: { kind: 'hasMore', path } } });
    const stopsOn = (path: string) => ({ kind: 'hasMore', path });

    it.each(openapis)(
      "tests each variant's declaration of a stop field at the top level, as the walk does one level down (finding 1; OAS %s)",
      async (openapi) => {
        // `top.json`: `has_more` a `const: true` boolean in one variant and a
        // `const: false` one in the other; `meta.json`: the same union as a
        // flattened `meta` companion. Their `oneOf` was tested as one schema
        // at the top level — no stop field, and the override rejected as
        // "not a boolean field" — while `meta.has_more` was accepted.
        const vTrue = object({ has_more: { type: 'boolean', const: true }, next: string });
        const vFalse = object({ has_more: { type: 'boolean', const: false } });
        const top = { allOf: [dataMember], oneOf: [vTrue, vFalse] };
        const meta = object(
          { data: petArray, meta: { allOf: [object({ trace_id: string })], oneOf: [vTrue, vFalse] } },
          ['data'],
        );
        for (const [label, body, path] of [
          ['top.json', top, 'has_more'],
          ['meta.json', meta, 'meta.has_more'],
        ] as const) {
          const detected = await parseQuiet(listPets(body, openapi));
          expect(onlyOperation(detected).pagination?.endOfIteration, label).toEqual(stopsOn(path));
          expect(shown(detected).response, label).toBe('Pet[]');
          const overridden = await parseQuiet(listPets(body, openapi, hasMore(path)));
          expect(onlyOperation(overridden).pagination, label).toEqual(onlyOperation(detected).pagination);
        }
        // As `{ data, has_more: { type: 'boolean', const: true } }` written flat already does.
        const flatConst = await parseQuiet(
          listPets(object({ data: petArray, has_more: { type: 'boolean', const: true } }, ['data']), openapi),
        );
        expect(onlyOperation(flatConst).pagination?.endOfIteration).toEqual(stopsOn('has_more'));
        // `{ $ref: Flag }` beside `{ type: 'boolean' }`: each declaration fits.
        const flag = {
          allOf: [dataMember],
          oneOf: [object({ has_more: { $ref: '#/components/schemas/Flag' } }), object({ has_more: boolean })],
        };
        const schemas = { Flag: { type: 'boolean' } };
        expect(
          onlyOperation(await parseQuiet(listPets(flag, openapi, {}, schemas))).pagination?.endOfIteration,
        ).toEqual(stopsOn('has_more'));
        expect(
          onlyOperation(await parseQuiet(listPets(flag, openapi, hasMore('has_more'), schemas))).pagination
            ?.endOfIteration,
        ).toEqual(stopsOn('has_more'));
        // A variant typing it otherwise still fits nothing, at either level.
        const vString = object({ has_more: string });
        const mixed = { allOf: [dataMember], oneOf: [vTrue, vString] };
        expect(onlyOperation(await parseQuiet(listPets(mixed, openapi))).pagination?.endOfIteration).toBeUndefined();
        const { warnings } = await parseWarning(listPets(mixed, openapi, hasMore('has_more')));
        expect(warnings).toEqual([
          expect.stringContaining('endOfIteration path "has_more" is not a boolean field, as kind "hasMore" requires'),
        ]);
      },
    );

    it.each(openapis)(
      'reads a nullable union beside the allOf as its one non-null variant, as the model does (finding 2; OAS %s)',
      async (openapi) => {
        // `one.json`: `allOf: [{ data }]` beside `oneOf: [{ has_more }, null]`;
        // `two.json`: the same with a second non-null variant. The nullable
        // axis was skipped by detection, so `one.json` stayed the model
        // `ListPetsResponse { data, has_more }` while `two.json` was a list.
        const nul = openapi === '3.1.0' ? { type: 'null' } : { enum: [null] };
        const one = { allOf: [dataMember], oneOf: [object({ has_more: boolean }), nul] };
        const two = {
          allOf: [dataMember],
          oneOf: [object({ has_more: boolean }), object({ has_more: boolean, total: integer }), nul],
        };
        const members = { allOf: [dataMember, object({ has_more: boolean })] };
        const oneIr = await parseQuiet(listPets(one, openapi));
        const twoIr = await parseQuiet(listPets(two, openapi));
        const membersIr = await parseQuiet(listPets(members, openapi));
        expect(shown(oneIr)).toEqual({ ...expected, envelopeFields: ['has_more?: boolean'] });
        expect(shown(oneIr)).toEqual(shown(membersIr));
        expect(onlyOperation(oneIr).pagination).toEqual(onlyOperation(membersIr).pagination);
        expect(shown(twoIr)).toEqual(expected);
        expect(diffSpecs(membersIr, oneIr).changes).toEqual([]);
        expect(diffSpecs(oneIr, membersIr).changes).toEqual([]);
      },
    );

    it.each(openapis)(
      'tests the outer declaration first, walking a union only where it is what types the field (Greptile; OAS %s)',
      async (openapi) => {
        // `total: { type: 'integer', anyOf: [{ maximum: 100 }, { minimum:
        // 200 }] }` is the integer its `type` says, the union only limiting
        // it; walking every union tested the limits without the `type`,
        // dropped the detected stop rule and rejected an explicit
        // `endOfIteration` naming the field.
        const limited = { type: 'integer', anyOf: [{ maximum: 100 }, { minimum: 200 }] };
        const totalCount = { 'x-pagination': { endOfIteration: { kind: 'totalCount', path: 'total' } } };
        const flat = object({ data: petArray, total: limited }, ['data']);
        const detected = await parseQuiet(listPets(flat, openapi));
        expect(onlyOperation(detected).pagination?.endOfIteration).toEqual({ kind: 'totalCount', path: 'total' });
        const overridden = await parseQuiet(listPets(flat, openapi, totalCount));
        expect(onlyOperation(overridden).pagination).toEqual(onlyOperation(detected).pagination);
        // As the variants' declarations too: their union carries no type of
        // its own, so each is tested, and each is the integer its `type` says.
        const split = { allOf: [dataMember], oneOf: [object({ total: limited }), object({ total: integer })] };
        for (const extra of [{}, totalCount]) {
          const ir = await parseQuiet(listPets(split, openapi, extra));
          expect(onlyOperation(ir).pagination?.endOfIteration).toEqual({ kind: 'totalCount', path: 'total' });
        }
        // The boolean consts of finding 1 are still read through their union.
        const consts = {
          allOf: [dataMember],
          oneOf: [
            object({ has_more: { type: 'boolean', const: true } }),
            object({ has_more: { type: 'boolean', const: false } }),
          ],
        };
        expect(onlyOperation(await parseQuiet(listPets(consts, openapi))).pagination?.endOfIteration).toEqual(
          stopsOn('has_more'),
        );
        // A union of bare limits beside another type leaves the field that type.
        const text = object({ data: petArray, total: { type: 'string', anyOf: [{ maxLength: 3 }] } }, ['data']);
        const { ir, warnings } = await parseWarning(listPets(text, openapi, totalCount));
        expect(onlyOperation(ir).pagination?.endOfIteration).toBeUndefined();
        expect(warnings).toEqual([
          expect.stringContaining('endOfIteration path "total" is not an integer or number field'),
        ]);
      },
    );

    it.each(openapis)(
      'leaves a body whose companion the walk types as a second array the model it is (Greptile; OAS %s)',
      async (openapi) => {
        // `Base` types `has_more` `integer[]`; both variants type it `boolean`.
        // The walk and the model keep `Base`'s declaration, so the body has
        // two arrays and no companion, as `{ data, has_more: integer[] }`
        // written flat has. Detection, reading `has_more` off the variants,
        // unwrapped it on `data` with the array `has_more` among the
        // companions; before the PR it was the model it is again now.
        const A = object({ has_more: boolean });
        const B = object({ has_more: boolean, total: integer });
        const base = { $ref: '#/components/schemas/Base' };
        const body = { allOf: [base, object({ data: petArray }), { oneOf: [A, B] }] };
        const ints = { type: 'array', items: integer };
        const twoArrays = await parseQuiet(listPets(body, openapi, {}, { Base: object({ has_more: ints }) }));
        expect(shown(twoArrays)).toEqual({
          dataPath: undefined,
          endOfIteration: undefined,
          itemType: 'ListPetsResponse',
          envelopeFields: undefined,
          models: ['Pet { name? }', 'Base { has_more? }', 'ListPetsResponse { has_more?, data?, total? }'],
          response: 'ListPetsResponse',
        });
        const flat = await parseQuiet(listPets(object({ data: petArray, has_more: ints, total: integer }), openapi));
        expect(onlyOperation(flat).response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
        // `Base` typing `has_more` `boolean`: the companion the walk reads is the stop field.
        const control = await parseQuiet(listPets(body, openapi, {}, { Base: object({ has_more: boolean }) }));
        expect(shown(control)).toEqual({
          ...expected,
          envelopeFields: ['has_more?: boolean', 'total?: integer'],
          models: ['Pet { name? }', 'Base { has_more? }'],
        });
      },
    );

    it.each(openapis)(
      'reads a union two variants share as a shared reference, not a cycle, and still ends on one that reaches itself (Greptile; OAS %s)',
      async (openapi) => {
        // `Flag` is an `anyOf` of boolean consts; one variant declares
        // `has_more` as `{ $ref: Flag }`, the other as `anyOf: [{ $ref: Flag
        // }, { type: 'boolean' }]`. Both are booleans, but one `seen` set
        // served both variants, so `Flag`'s second reading was taken for a
        // cycle: no stop field at the top level, the override rejected,
        // while `meta.has_more` through the same declarations passed.
        const flag = { $ref: '#/components/schemas/Flag' };
        const schemas = {
          Flag: {
            anyOf: [
              { type: 'boolean', const: true },
              { type: 'boolean', const: false },
            ],
          },
          Loop: { anyOf: [{ $ref: '#/components/schemas/Loop' }, { type: 'boolean' }] },
        };
        const vRef = object({ has_more: flag });
        const vUnion = object({ has_more: { anyOf: [flag, { type: 'boolean' }] } });
        const top = { allOf: [dataMember], oneOf: [vRef, vUnion] };
        const meta = object(
          { data: petArray, meta: { allOf: [object({ trace_id: string })], oneOf: [vRef, vUnion] } },
          ['data'],
        );
        for (const [label, body, path] of [
          ['top', top, 'has_more'],
          ['meta', meta, 'meta.has_more'],
        ] as const) {
          const detected = await parseQuiet(listPets(body, openapi, {}, schemas));
          expect(onlyOperation(detected).pagination?.endOfIteration, label).toEqual(stopsOn(path));
          const overridden = await parseQuiet(listPets(body, openapi, hasMore(path), schemas));
          expect(onlyOperation(overridden).pagination, label).toEqual(onlyOperation(detected).pagination);
        }
        // A union that reaches itself fits nothing, and the test ends there.
        const loop = object({ data: petArray, has_more: { $ref: '#/components/schemas/Loop' } }, ['data']);
        expect(
          onlyOperation(await parseQuiet(listPets(loop, openapi, {}, schemas))).pagination?.endOfIteration,
        ).toBeUndefined();
        const { warnings } = await parseWarning(listPets(loop, openapi, hasMore('has_more'), schemas));
        expect(warnings).toEqual([
          expect.stringContaining('endOfIteration path "has_more" is not a boolean field, as kind "hasMore" requires'),
        ]);
      },
    );
  });
});
