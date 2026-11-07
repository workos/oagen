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
  });

  describe('the rule: a stop field counts when every variant declares it with one shape', () => {
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
});
