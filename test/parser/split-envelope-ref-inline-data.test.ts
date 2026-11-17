import { describe, it, expect, afterAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { unionOfDeclarations } from '../../src/parser/inline-models.js';
import { typedDeclaration, withNullVariant } from '../../src/parser/schemas.js';
import { componentKeyOf, schemaRefOf, schemaRefTokens } from '../../src/parser/schema-refs.js';
import type { ApiSpec, Field, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #669: a property several variants of a flattened `oneOf`/`anyOf`
 * declare is typed by `unionOfDeclarations`, which compared the
 * declarations as written. `data: { $ref: Pets }` in one variant and `data:
 * { type: 'array', items: { $ref: Pet } }` in the other — both typed `Pet[]`
 * — were two shapes, the field was `Pet[] | Pet[]`, list detection saw no
 * array, and the body stayed the model `ListPetsResponse` while the same
 * envelope spelled one way in both variants was `Pet[]`. Declarations the
 * parser types identically are now one shape.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});
const warnings = (): string[] => warn.mock.calls.map(([m]) => String(m));

async function writeDoc(doc: unknown, name = 'spec.json'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-669-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}
const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeDoc(doc));

/** `oagen diff --old <old> --new <new>`: the exit code it ends with. */
async function diffExit(oldDoc: unknown, newDoc: unknown): Promise<number> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const files = { old: await writeDoc(oldDoc, 'old.json'), new: await writeDoc(newDoc, 'new.json') };
    const error = (await diffCommand(files).catch((e: unknown) => e)) as { exitCode: number };
    return error.exitCode;
  } finally {
    log.mockRestore();
  }
}

type Schema = Record<string, unknown>;
const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const Pet = ref('Pet');
const Pets = ref('Pets');
const inlineArray = (): Schema => ({ type: 'array', items: Pet });
const boolean: Schema = { type: 'boolean' };
const string: Schema = { type: 'string' };
const integer: Schema = { type: 'integer' };
const object = (properties: Schema, required: string[] = Object.keys(properties)): Schema => ({
  type: 'object',
  required,
  properties,
});
/** A nullable wrapper around `variant`, in the version's own spelling: a `null` variant, or the flag that stands for one. */
const nullableWrapper = (openapi: Version, variant: Schema): Schema =>
  openapi === '3.0.3' ? { oneOf: [variant], nullable: true } : { oneOf: [variant, { type: 'null' }] };
/** `schema` admitting `null` on its own `type`, in the version's own spelling. */
const ownNull = (openapi: Version, schema: Schema): Schema =>
  openapi === '3.0.3' ? { ...schema, nullable: true } : { ...schema, type: [schema.type, 'null'] };

/** A type in a word: `Pet[]`, `nullable<string>`, `(Pet[] | Pet[])`. */
const show = (type: TypeRef | undefined): string => {
  if (!type) return 'undefined';
  switch (type.kind) {
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'array':
      return `${show(type.items)}[]`;
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'literal':
      return JSON.stringify(type.value);
    case 'enum':
      return `enum ${type.name}`;
    case 'model':
      return type.name;
    default:
      return type.format ? `${type.type}:${type.format}` : type.type;
  }
};

const operations = (spec: ApiSpec): Operation[] => spec.services.flatMap((s) => s.operations);
const modelOf = (spec: ApiSpec, name: string) => spec.models.find((m) => m.name === name);
const fieldOf = (spec: ApiSpec, name: string, field: string): Field | undefined =>
  modelOf(spec, name)?.fields.find((f) => f.name === field);
const fieldsOf = (spec: ApiSpec, name: string): string[] | undefined =>
  modelOf(spec, name)?.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`);

/** The components every document of this file declares beside its own. */
const components = (openapi: Version): Record<string, Schema> => ({
  Pet: { type: 'object', properties: { name: string } },
  Pets: { type: 'array', items: Pet },
  PetsAlias: Pets,
  NullablePets: ownNull(openapi, inlineArray()),
  LimitedPets: { type: 'array', items: Pet, maxItems: 10, minItems: 1, description: 'Some pets.' },
  InlinePets: { type: 'array', items: { type: 'object', properties: { id: string } } },
  Flag: boolean,
  DescribedFlag: { type: 'boolean', description: 'A flag.', default: true, deprecated: true, 'x-flag': 1 },
  Count: { type: 'integer', minimum: 0 },
  Name: { type: 'string', maxLength: 5, pattern: '^a' },
  Names: { type: 'array', items: ref('Name') },
  Timestamp: { type: 'string', format: 'date-time' },
  Kind: { type: 'string', enum: ['cat', 'dog'] },
  KindAlias: ref('Kind'),
  CatKind: { const: 'cat' },
  Anything: {},
  Meta: { type: 'object', properties: { after: string } },
  Holder: {
    type: 'object',
    properties: {
      pets: inlineArray(),
      petsRef: Pets,
      pet: Pet,
      flag: boolean,
      name: { type: 'string', maxLength: 5, pattern: '^a' },
      owner: { type: 'object', properties: { id: string } },
    },
  },
});
const pointer = (to: string): Schema => ({ $ref: `#/components/schemas/Holder/properties/${to}` });

/**
 * The issue's document: `GET /pets` (`listPets`, an `after` query
 * parameter) returning `schema`, beside `Pet: { name?: string }`, `Pets: {
 * type: 'array', items: { $ref: Pet } }` and the components the cases below
 * name.
 */
const document = (openapi: Version, schema: Schema, operation: Schema = {}, schemas: Record<string, Schema> = {}) => ({
  openapi,
  info: { title: 'repro', version: '1' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        parameters: [{ name: 'after', in: 'query', schema: string }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
        ...operation,
      },
    },
  },
  components: { schemas: { ...components(openapi), ...schemas } },
});

/** `allOf: [{ has_more: boolean }]` (`has_more` required) beside a `oneOf` of `{ data }` and `{ data, total: integer }` (`data` required in both). */
const envelope = (first: Schema, second: Schema): Schema => ({
  allOf: [object({ has_more: boolean })],
  oneOf: [object({ data: first }), object({ data: second, total: integer }, ['data'])],
});
/** `allOf: [{ data: Pet[] }]` (`data` required) beside a `oneOf` of the two variants. */
const companions = (first: Schema, second: Schema): Schema => ({
  allOf: [object({ data: inlineArray() })],
  oneOf: [first, second],
});

/** What the issue's script prints for a document, with the envelope's fields and the models the body mints. */
const summary = (spec: ApiSpec) => {
  const [{ pagination, response }] = operations(spec);
  return {
    data: show(fieldOf(spec, 'ListPetsResponse', 'data')?.type),
    dataPath: pagination?.dataPath,
    response: show(response),
    endOfIteration: pagination?.endOfIteration,
    envelopeFields: pagination?.envelopeFields?.map((field) => `${field.name}: ${show(field.type)}`),
    listModel: modelOf(spec, 'ListPetsResponse') !== undefined,
  };
};

const LIST = {
  data: 'undefined',
  dataPath: 'data',
  response: 'Pet[]',
  endOfIteration: { kind: 'hasMore', path: 'has_more' },
  envelopeFields: ['has_more: boolean', 'total: integer'],
  listModel: false,
};

/**
 * A component `Holder2` whose `allOf` flattens a `oneOf`, each variant
 * declaring `x` as one of `declarations` and a field of its own: the model
 * `Holder2 { id, x?, only_0?, only_1?, … }`.
 */
const flattened = (openapi: Version, declarations: Schema[], schemas: Record<string, Schema> = {}) => ({
  openapi,
  info: { title: 'repro', version: '1' },
  paths: {},
  components: {
    schemas: {
      ...components(openapi),
      ...schemas,
      Holder2: {
        allOf: [
          { type: 'object', properties: { id: string } },
          {
            oneOf: declarations.map((x, index) => ({ type: 'object', properties: { x, [`only_${index}`]: integer } })),
          },
        ],
      },
    },
  },
});
/** The field `x` several variants declare, without its name: its type in a word and everything else it carries. */
const xOf = async (openapi: Version, declarations: Schema[], schemas: Record<string, Schema> = {}) => {
  const field = fieldOf(await parse(flattened(openapi, declarations, schemas)), 'Holder2', 'x')!;
  const { name: _name, type, required: _required, ...settings } = field;
  const kept = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
  return { type: show(type), ...kept };
};

describe('#669 declarations of one property the parser types identically are one shape', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const refDoc = () => document(openapi, envelope(Pets, Pets));
    const inlineDoc = () => document(openapi, envelope(inlineArray(), inlineArray()));
    const mixedDoc = () => document(openapi, envelope(Pets, inlineArray()));

    describe('the split list envelope', () => {
      it("reads the issue's `mixed.json` as the list `ref.json` and `inline.json` are", async () => {
        expect(summary(await parse(inlineDoc()))).toEqual(LIST);
        expect(summary(await parse(refDoc()))).toEqual(LIST);
        expect(summary(await parse(mixedDoc()))).toEqual(LIST);
        expect(await parse(mixedDoc())).toEqual(await parse(inlineDoc()));
        expect(warnings()).toEqual([]);
      });

      it('gives the same IR with the two spellings swapped between the variants', async () => {
        const swapped = await parse(document(openapi, envelope(inlineArray(), Pets)));
        expect(summary(swapped)).toEqual(LIST);
        expect(swapped).toEqual(await parse(mixedDoc()));
      });

      it('reports no change between the three spellings, in any direction (`oagen diff` exits 0)', async () => {
        const docs = [refDoc(), inlineDoc(), mixedDoc()];
        for (const oldDoc of docs) {
          for (const newDoc of docs) {
            expect(diffSpecs(await parse(oldDoc), await parse(newDoc)).changes).toEqual([]);
          }
        }
        expect(await diffExit(refDoc(), mixedDoc())).toBe(0);
        expect(await diffExit(mixedDoc(), refDoc())).toBe(0);
        expect(await diffExit(inlineDoc(), mixedDoc())).toBe(0);
        expect(await diffExit(mixedDoc(), inlineDoc())).toBe(0);
      });

      // Every spelling of `Pet[]` the issue names, and their neighbors, in
      // one variant beside every other in the second.
      const spellings: Array<[string, Schema]> = [
        ['a `$ref` to the array component', Pets],
        ['the array inline', inlineArray()],
        ['a JSON Pointer to an array (#609)', pointer('pets')],
        ['a JSON Pointer to a `$ref` to the array component', pointer('petsRef')],
        ['`allOf` of the inline array', { allOf: [inlineArray()] }],
        ['`allOf` of the `$ref`', { allOf: [Pets] }],
        ['a `$ref` to an alias of the array component', ref('PetsAlias')],
        ['the array with no `type`', { items: Pet }],
        ['the array with its items under an `allOf`', { type: 'array', items: { allOf: [Pet] } }],
      ];
      it.each(spellings)('unwraps the envelope on `data` written as %s beside every other spelling', async (_, a) => {
        for (const [label, b] of spellings) {
          const spec = await parse(document(openapi, envelope(a, b)));
          expect(summary(spec), label).toEqual(LIST);
          expect(diffSpecs(spec, await parse(inlineDoc())).changes, label).toEqual([]);
          expect(diffSpecs(await parse(inlineDoc()), spec).changes, label).toEqual([]);
        }
        expect(warnings()).toEqual([]);
      });

      it('unwraps it with three variants written two or three ways, and not when one variant lacks the array', async () => {
        const three = (third: Schema): Schema => ({
          allOf: [object({ has_more: boolean })],
          oneOf: [object({ data: Pets }), object({ data: inlineArray() }), third],
        });
        expect(
          summary(await parse(document(openapi, three(object({ data: Pets, total: integer }, ['data']))))),
        ).toEqual(LIST);
        expect(
          summary(await parse(document(openapi, three(object({ data: pointer('pets'), total: integer }, ['data']))))),
        ).toEqual(LIST);
        const lacking = await parse(document(openapi, three(object({ total: integer }))));
        expect(summary(lacking)).toMatchObject({ response: 'ListPetsResponse', dataPath: undefined, data: 'Pet[]' });
        expect(fieldsOf(lacking, 'ListPetsResponse')).toEqual(['has_more: boolean', 'data?: Pet[]', 'total?: integer']);
      });

      it('reads the variants of an `anyOf`, and of a union written as a member, the same way', async () => {
        const variants = [object({ data: Pets }), object({ data: inlineArray(), total: integer }, ['data'])];
        const member = object({ has_more: boolean });
        expect(summary(await parse(document(openapi, { allOf: [member], anyOf: variants })))).toEqual(LIST);
        expect(summary(await parse(document(openapi, { allOf: [member, { oneOf: variants }] })))).toEqual(LIST);
      });

      it('unwraps it on a nullable array when a spelling of `data` admits `null`', async () => {
        const flat = await parse(
          document(
            openapi,
            object({ data: ownNull(openapi, inlineArray()), has_more: boolean, total: integer }, ['data', 'has_more']),
          ),
        );
        const nullableList = { ...LIST, response: 'nullable<Pet[]>' };
        expect(summary(flat)).toEqual(nullableList);
        for (const admitting of [
          ownNull(openapi, inlineArray()),
          nullableWrapper(openapi, Pets),
          nullableWrapper(openapi, inlineArray()),
          ref('NullablePets'),
        ]) {
          for (const other of [Pets, inlineArray(), pointer('pets'), admitting]) {
            const label = JSON.stringify([admitting, other]);
            expect(summary(await parse(document(openapi, envelope(admitting, other)))), label).toEqual(nullableList);
            expect(summary(await parse(document(openapi, envelope(other, admitting)))), label).toEqual(nullableList);
          }
        }
      });

      it('accepts an explicit `dataPath` on the mixed envelope as on the other two, and unwraps it', async () => {
        const override = { 'x-pagination': { dataPath: 'data' } };
        const mixed = await parse(document(openapi, envelope(Pets, inlineArray()), override));
        expect(summary(mixed)).toEqual(LIST);
        expect(mixed).toEqual(await parse(document(openapi, envelope(inlineArray(), inlineArray()), override)));
        expect(diffSpecs(mixed, await parse(document(openapi, envelope(Pets, Pets), override))).changes).toEqual([]);
        expect(warnings()).toEqual([]);
      });

      it('keeps the mixed envelope one model with `data` typed once where nothing pages the operation', async () => {
        const kept = await parse(document(openapi, envelope(Pets, inlineArray()), { parameters: [] }));
        expect(show(operations(kept)[0]!.response)).toBe('ListPetsResponse');
        expect(fieldsOf(kept, 'ListPetsResponse')).toEqual(['has_more: boolean', 'data?: Pet[]', 'total?: integer']);
      });

      it('leaves the body the model it is when the variants type `data` as two arrays', async () => {
        // A `$ref` to an array component with inline object items is
        // `InlinePetsItem[]`, which the same array written inline is not.
        const inlineItems = { type: 'array', items: { type: 'object', properties: { id: string } } };
        const spec = await parse(document(openapi, envelope(ref('InlinePets'), inlineItems)));
        expect(summary(spec)).toMatchObject({
          response: 'ListPetsResponse',
          dataPath: undefined,
          data: '(InlinePetsItem[] | ListPetsResponseDataItem[])',
        });
        expect(summary(await parse(document(openapi, envelope(Pets, ref('InlinePets')))))).toMatchObject({
          response: 'ListPetsResponse',
          data: '(Pet[] | InlinePetsItem[])',
        });
      });
    });

    describe('the stop field and the other companions', () => {
      it("types the issue's `has_more`, a `$ref` in one variant and inline in the other, `boolean`", async () => {
        const flag = companions(object({ has_more: ref('Flag') }, []), object({ has_more: boolean }, []));
        const spec = await parse(document(openapi, flag));
        expect(summary(spec)).toEqual({ ...LIST, envelopeFields: ['has_more: boolean'] });
        const inline = document(
          openapi,
          companions(object({ has_more: boolean }, []), object({ has_more: boolean }, [])),
        );
        expect(spec).toEqual(await parse(inline));
        expect(await diffExit(document(openapi, flag), inline)).toBe(0);
        expect(await diffExit(inline, document(openapi, flag))).toBe(0);
        expect(warnings()).toEqual([]);
      });

      it.each([
        ['a JSON Pointer beside the boolean', pointer('flag'), boolean, 'has_more?: boolean'],
        ['`allOf` of the boolean beside a `$ref`', { allOf: [boolean] }, ref('Flag'), 'has_more?: boolean'],
        ['`allOf` of the `$ref` beside the `$ref`', { allOf: [ref('Flag')] }, ref('Flag'), 'has_more?: boolean'],
      ])('stops on `has_more` written as %s', async (_, first, second, field) => {
        for (const [a, b] of [
          [first, second],
          [second, first],
        ]) {
          const spec = await parse(
            document(openapi, companions(object({ has_more: a }, []), object({ has_more: b }, []))),
          );
          const [{ pagination, response }] = operations(spec);
          expect(show(response)).toBe('Pet[]');
          expect(pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });
          expect(pagination?.envelopeFields?.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`)).toEqual([
            field,
          ]);
        }
      });

      it('types a stop field one spelling of which admits `null` once, nullable', async () => {
        const spec = await parse(
          document(
            openapi,
            companions(object({ has_more: boolean }, []), object({ has_more: ownNull(openapi, boolean) }, [])),
          ),
        );
        const [{ pagination }] = operations(spec);
        expect(pagination?.envelopeFields?.map((f) => show(f.type))).toEqual(['nullable<boolean>']);
        expect(pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });
      });

      it('still stops on a field the variants type apart, each declaration a boolean', async () => {
        // `Flag` beside a boolean `const` is `boolean | true`: two shapes, both of which fit.
        const pinned = companions(
          object({ has_more: ref('Flag') }, []),
          object({ has_more: { type: 'boolean', const: true } }, []),
        );
        const [{ pagination, response }] = operations(await parse(document(openapi, pinned)));
        expect(show(response)).toBe('Pet[]');
        expect(pagination?.endOfIteration).toEqual({ kind: 'hasMore', path: 'has_more' });
        expect(pagination?.envelopeFields?.map((f) => show(f.type))).toEqual(['(boolean | true)']);
      });

      it('types every other companion once, with the limits and text its declarations agree on', async () => {
        const companion = async (name: string, first: Schema, second: Schema) => {
          const spec = await parse(
            document(openapi, companions(object({ [name]: first }, []), object({ [name]: second }, []))),
          );
          const [{ pagination, response }] = operations(spec);
          expect(show(response), name).toBe('Pet[]');
          const [{ name: _name, required: _required, type, ...rest }] = pagination!.envelopeFields!;
          return { type: show(type), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
        };
        // `Count: { type: 'integer', minimum: 0 }`: a limit only one declaration carries is not the field's.
        expect(await companion('total', ref('Count'), integer)).toEqual({ type: 'integer' });
        expect(await companion('total', integer, ref('Count'))).toEqual({ type: 'integer' });
        expect(await companion('total', ref('Count'), { type: 'integer', minimum: 0 })).toEqual({
          type: 'integer',
          constraints: { minimum: 0 },
        });
        expect(await companion('next_cursor', ref('Name'), { ...string, maxLength: 5, pattern: '^a' })).toEqual({
          type: 'string',
          constraints: { maxLength: 5, pattern: '^a' },
        });
        expect(await companion('list_metadata', ref('Meta'), { allOf: [ref('Meta')] })).toEqual({ type: 'Meta' });
        // A `$ref` to an object component is the named model, which the
        // same object written inline is not: two shapes, as before.
        expect(
          await companion('list_metadata', ref('Meta'), { type: 'object', properties: { after: string } }),
        ).toEqual({ type: '(Meta | ListMetadata)' });
      });

      it('accepts an explicit `endOfIteration` naming the mixed stop field', async () => {
        const flag = companions(object({ has_more: ref('Flag') }, []), object({ has_more: boolean }, []));
        const override = { 'x-pagination': { endOfIteration: { kind: 'hasMore', path: 'has_more' } } };
        const spec = await parse(document(openapi, flag, override));
        expect(summary(spec)).toEqual({ ...LIST, envelopeFields: ['has_more: boolean'] });
        expect(warnings()).toEqual([]);
      });
    });

    describe('a field several variants declare, outside a list envelope', () => {
      /** Spellings the parser types identically, by the type each is. */
      const families: Array<[type: string, spellings: Schema[]]> = [
        [
          'Pet[]',
          [
            Pets,
            inlineArray(),
            ref('PetsAlias'),
            { allOf: [Pets] },
            { allOf: [inlineArray()] },
            { allOf: [{ allOf: [inlineArray()] }] },
            pointer('pets'),
            pointer('petsRef'),
            { items: Pet },
            { type: 'array', items: { allOf: [Pet] } },
            { type: 'array', items: pointer('pet') },
            { type: 'array', items: { $ref: '#/components/schemas/Pets/items' } },
          ],
        ],
        ['boolean', [boolean, ref('Flag'), { allOf: [boolean] }, { allOf: [ref('Flag')] }, pointer('flag')]],
        ['string:date-time', [ref('Timestamp'), { type: 'string', format: 'date-time' }]],
        [
          '"cat"',
          [{ const: 'cat' }, { type: 'string', const: 'cat' }, { type: 'string', enum: ['cat'] }, ref('CatKind')],
        ],
        ['unknown', [{}, ref('Anything')]],
        ['Pet', [Pet, { allOf: [Pet] }, pointer('pet'), { $ref: '#/components/schemas/%50et' }]],
        ['enum Kind', [ref('Kind'), ref('KindAlias'), { allOf: [ref('Kind')] }]],
        [
          'map<string>',
          [
            { type: 'object', additionalProperties: string },
            { type: 'object', patternProperties: { '^x': string } },
            { allOf: [{ type: 'object', additionalProperties: string }] },
          ],
        ],
        [
          '(Pet | string)',
          [{ oneOf: [Pet, string] }, { oneOf: [{ allOf: [Pet] }, string] }, { allOf: [{ oneOf: [Pet, string] }] }],
        ],
        ['InlinePetsItem[]', [ref('InlinePets'), { allOf: [ref('InlinePets')] }]],
        ['HolderOwner', [pointer('owner'), { allOf: [pointer('owner')] }]],
      ];

      it.each(families)('types %s once, whichever two spellings of it the variants write', async (type, spellings) => {
        for (const a of spellings) {
          const alone = await xOf(openapi, [a, a]);
          expect(alone, JSON.stringify(a)).toEqual({ type });
          for (const b of spellings) {
            const label = JSON.stringify([a, b]);
            expect(await xOf(openapi, [a, b]), label).toEqual({ type });
          }
        }
        expect(warnings()).toEqual([]);
      });

      it('gives one IR whichever spelling is written, and whichever comes first', async () => {
        const inline = await parse(flattened(openapi, [inlineArray(), inlineArray()]));
        for (const pair of [
          [Pets, inlineArray()],
          [inlineArray(), Pets],
          [pointer('pets'), { allOf: [inlineArray()] }],
          [Pets, Pets],
        ]) {
          const spec = await parse(flattened(openapi, pair));
          expect(spec, JSON.stringify(pair)).toEqual(inline);
          expect(diffSpecs(spec, inline).changes).toEqual([]);
          expect(diffSpecs(inline, spec).changes).toEqual([]);
        }
      });

      it('types a shape once among several: three spellings beside another type, in every order', async () => {
        expect(await xOf(openapi, [Pets, inlineArray(), integer])).toEqual({ type: '(Pet[] | integer)' });
        expect(await xOf(openapi, [Pets, integer, inlineArray()])).toEqual({ type: '(Pet[] | integer)' });
        expect(await xOf(openapi, [integer, pointer('pets'), Pets, { allOf: [inlineArray()] }])).toEqual({
          type: '(integer | Pet[])',
        });
        expect(await xOf(openapi, [ref('Flag'), boolean, ref('Kind'), ref('KindAlias')])).toEqual({
          type: '(boolean | enum Kind)',
        });
      });

      it('reads the keywords of a shape written several ways by agreement, as each declaration reads them', async () => {
        // `DescribedFlag: { type: 'boolean', description, default: true,
        // deprecated: true, x-flag: 1 }`: a bare `$ref` to it reads all of
        // them, the same boolean written inline none.
        const described = {
          type: 'boolean',
          description: 'A flag.',
          deprecated: true,
          default: true,
          extensions: { 'x-flag': 1 },
        };
        expect(await xOf(openapi, [ref('DescribedFlag'), ref('DescribedFlag')])).toEqual(described);
        for (const pair of [
          [ref('DescribedFlag'), boolean],
          [boolean, ref('DescribedFlag')],
        ]) {
          expect(await xOf(openapi, pair)).toEqual({ type: 'boolean' });
        }
        const written = { type: 'boolean', description: 'A flag.', default: true, deprecated: true, 'x-flag': 1 };
        for (const pair of [
          [ref('DescribedFlag'), written],
          [written, ref('DescribedFlag')],
          [
            ref('DescribedFlag'),
            { allOf: [boolean, { description: 'A flag.', default: true, deprecated: true, 'x-flag': 1 }] },
          ],
        ]) {
          expect(await xOf(openapi, pair)).toEqual(described);
        }
        // One keyword disputed: that one alone is not the field's.
        expect(await xOf(openapi, [ref('DescribedFlag'), { ...written, description: 'Another.' }])).toEqual({
          type: 'boolean',
          deprecated: true,
          default: true,
          extensions: { 'x-flag': 1 },
        });
        // A wrapped `$ref` documents itself and reads no text from the
        // component, so beside the bare `$ref` the text is disputed.
        for (const pair of [
          [{ allOf: [ref('DescribedFlag')] }, ref('DescribedFlag')],
          [ref('DescribedFlag'), { allOf: [ref('DescribedFlag')] }],
        ]) {
          expect(await xOf(openapi, pair)).toEqual({ type: 'boolean' });
        }
      });

      it('reads the limits of a shape written several ways by agreement, on the field and on its type', async () => {
        const limited = async (declarations: Schema[]) => {
          const field = fieldOf(await parse(flattened(openapi, declarations)), 'Holder2', 'x')!;
          const bare = field.type.kind === 'nullable' ? field.type.inner : field.type;
          return {
            type: show(field.type),
            field: field.constraints,
            onType: 'constraints' in bare ? bare.constraints : undefined,
          };
        };
        const none = { type: 'string', field: undefined, onType: undefined };
        // `Name: { type: 'string', maxLength: 5, pattern: '^a' }`.
        expect(await limited([ref('Name'), string])).toEqual(none);
        expect(await limited([string, ref('Name')])).toEqual(none);
        const both = { maxLength: 5, pattern: '^a' };
        for (const pair of [
          [ref('Name'), { ...string, ...both }],
          [{ ...string, ...both }, ref('Name')],
          [pointer('name'), ref('Name')],
          [{ allOf: [ref('Name')] }, { allOf: [string, both] }],
        ]) {
          expect(await limited(pair), JSON.stringify(pair)).toEqual({ type: 'string', field: both, onType: both });
        }
        const five = { maxLength: 5 };
        expect(await limited([ref('Name'), { ...string, maxLength: 5, pattern: 'b$' }])).toEqual({
          type: 'string',
          field: five,
          onType: five,
        });
        expect(await limited([ref('Name'), { ...string, maxLength: 3 }])).toEqual(none);
        // `LimitedPets: { …, maxItems: 10, minItems: 1, description }`.
        const ten = { maxItems: 10 };
        expect(await limited([ref('LimitedPets'), { ...inlineArray(), maxItems: 10 }])).toEqual({
          type: 'Pet[]',
          field: ten,
          onType: ten,
        });
        expect(await limited([{ ...inlineArray(), maxItems: 10 }, ref('LimitedPets')])).toEqual({
          type: 'Pet[]',
          field: ten,
          onType: ten,
        });
      });

      it('reads the limits inside array items and map values by agreement too', async () => {
        const items = async (declarations: Schema[]) => {
          const type = fieldOf(await parse(flattened(openapi, declarations)), 'Holder2', 'x')!.type;
          const inner = type.kind === 'array' ? type.items : type.kind === 'map' ? type.valueType : type;
          return { type: show(type), inner: 'constraints' in inner ? inner.constraints : undefined };
        };
        const both = { maxLength: 5, pattern: '^a' };
        const stringArray = (more: Schema = {}): Schema => ({ type: 'array', items: { ...string, ...more } });
        for (const pair of [
          [ref('Names'), stringArray(both)],
          [stringArray(both), { type: 'array', items: ref('Name') }],
          [{ type: 'array', items: ref('Name') }, ref('Names')],
        ]) {
          expect(await items(pair), JSON.stringify(pair)).toEqual({ type: 'string[]', inner: both });
        }
        expect(await items([ref('Names'), stringArray()])).toEqual({ type: 'string[]', inner: undefined });
        expect(await items([stringArray(), ref('Names')])).toEqual({ type: 'string[]', inner: undefined });
        const map = (values: Schema): Schema => ({ type: 'object', additionalProperties: values });
        expect(await items([map(ref('Name')), map({ ...string, ...both })])).toEqual({
          type: 'map<string>',
          inner: both,
        });
        expect(await items([map(ref('Name')), map(string)])).toEqual({ type: 'map<string>', inner: undefined });
        expect(await items([map(string), map(ref('Name'))])).toEqual({ type: 'map<string>', inner: undefined });
      });

      it('types a shape one spelling of which admits `null` once, nullable', async () => {
        const nullableString = [ownNull(openapi, string), nullableWrapper(openapi, string)];
        for (const admitting of nullableString) {
          for (const other of [string, ...nullableString]) {
            if (other === admitting) continue;
            expect(await xOf(openapi, [admitting, other]), JSON.stringify([admitting, other])).toEqual({
              type: 'nullable<string>',
            });
            expect(await xOf(openapi, [other, admitting])).toEqual({ type: 'nullable<string>' });
          }
        }
        expect(await xOf(openapi, [nullableWrapper(openapi, Pet), Pet])).toEqual({ type: 'nullable<Pet>' });
        expect(await xOf(openapi, [Pet, nullableWrapper(openapi, { allOf: [Pet] })])).toEqual({
          type: 'nullable<Pet>',
        });
        expect(await xOf(openapi, [ref('NullablePets'), inlineArray()])).toEqual({ type: 'nullable<Pet[]>' });
        expect(await xOf(openapi, [inlineArray(), ref('NullablePets')])).toEqual({ type: 'nullable<Pet[]>' });
        expect(await xOf(openapi, [ref('NullablePets'), ownNull(openapi, inlineArray())])).toEqual({
          type: 'nullable<Pet[]>',
        });
        // Among several shapes the `null` is the union's, as a `type` list's was.
        expect(await xOf(openapi, [Pets, ownNull(openapi, inlineArray()), integer])).toEqual({
          type: 'nullable<(Pet[] | integer)>',
        });
        expect(await xOf(openapi, [integer, nullableWrapper(openapi, inlineArray()), Pets])).toEqual({
          type: 'nullable<(integer | Pet[])>',
        });
        expect(await xOf(openapi, [string, integer, ownNull(openapi, string)])).toEqual({
          type: 'nullable<(string | integer)>',
        });
      });

      it('carries the agreed keywords of a nullable shape on the field', async () => {
        const text = { description: 'A name.', maxLength: 5 };
        expect(await xOf(openapi, [{ ...string, ...text }, ownNull(openapi, { ...string, ...text })])).toEqual({
          type: 'nullable<string>',
          description: 'A name.',
          constraints: { maxLength: 5 },
        });
        expect(await xOf(openapi, [{ ...string, ...text }, ownNull(openapi, string)])).toEqual({
          type: 'nullable<string>',
        });
      });

      it('types an object, an enum and an array of objects one spelling of which admits `null` once', async () => {
        const thing = { type: 'object', properties: { a: string } };
        const spec = await parse(flattened(openapi, [thing, ownNull(openapi, thing)]));
        expect(show(fieldOf(spec, 'Holder2', 'x')?.type)).toBe('nullable<Holder2X>');
        expect(spec.models.map((m) => m.name).filter((name) => name.startsWith('Holder2'))).toEqual([
          'Holder2',
          'Holder2X',
        ]);
        expect(await parse(flattened(openapi, [ownNull(openapi, thing), thing]))).toEqual(spec);
        expect(spec).toEqual(await parse(flattened(openapi, [ownNull(openapi, thing), ownNull(openapi, thing)])));
        const kind = { type: 'string', enum: ['a', 'b'] };
        expect(await xOf(openapi, [kind, ownNull(openapi, kind)])).toEqual({ type: 'nullable<enum Holder2X>' });
        const things = { type: 'array', items: thing };
        expect(await xOf(openapi, [things, ownNull(openapi, things)])).toEqual({ type: 'nullable<Holder2X[]>' });
      });

      it('keeps a shape written one way as written, and declarations typed apart two shapes', async () => {
        // A nullable wrapper written the same way throughout keeps its
        // `null` on its own variant, as before.
        const wrapper = nullableWrapper(openapi, string);
        expect(await xOf(openapi, [wrapper, integer])).toEqual({ type: '(nullable<string> | integer)' });
        expect(await xOf(openapi, [wrapper, wrapper, integer])).toEqual({ type: '(nullable<string> | integer)' });
        // Typed apart: another format, another model, an enum component and
        // the same members inline, an object component and the same object
        // inline, an array component with inline items and the same array.
        expect(await xOf(openapi, [ref('Timestamp'), string])).toEqual({ type: '(string:date-time | string)' });
        expect(await xOf(openapi, [Pet, ref('Meta')])).toEqual({ type: '(Pet | Meta)' });
        expect(await xOf(openapi, [ref('Kind'), { type: 'string', enum: ['cat', 'dog'] }])).toEqual({
          type: '(enum Kind | enum Holder2X)',
        });
        expect(await xOf(openapi, [ref('Meta'), { type: 'object', properties: { after: string } }])).toEqual({
          type: '(Meta | Holder2X)',
        });
        expect(
          await xOf(openapi, [
            ref('InlinePets'),
            { type: 'array', items: { type: 'object', properties: { id: string } } },
          ]),
        ).toEqual({ type: '(InlinePetsItem[] | Holder2XItem[])' });
        expect(await xOf(openapi, [{ oneOf: [Pet, string] }, { anyOf: [Pet, string] }])).toEqual({
          type: '((Pet | string) | (Pet | string))',
        });
        // A union's variants keep their own limits: a field reads none of them.
        expect(await xOf(openapi, [{ oneOf: [Pet, { ...string, maxLength: 5 }] }, { oneOf: [Pet, string] }])).toEqual({
          type: '((Pet | string) | (Pet | string))',
        });
        // A declaration typed under a name minted where it stands is
        // compared as written: an inline object beside the same object
        // under a one-member `allOf` stays two variant models.
        const thing = { type: 'object', properties: { a: string } };
        expect(await xOf(openapi, [thing, { allOf: [thing] }])).toEqual({ type: '(Holder2X | Holder2XVariant2)' });
      });

      it('reads a variant that is itself a union the same way', async () => {
        const doc = flattened(openapi, [string]);
        (doc.components.schemas.Holder2 as { allOf: Schema[] }).allOf[1] = {
          oneOf: [
            { oneOf: [object({ x: Pets }, []), object({ x: inlineArray(), z: integer }, [])] },
            object({ x: { allOf: [inlineArray()] }, w: integer }, []),
          ],
        };
        expect(fieldsOf(await parse(doc), 'Holder2')).toEqual([
          'id?: string',
          'x?: Pet[]',
          'z?: integer',
          'w?: integer',
        ]);
      });

      it('types the fields of a response body, a request body and a webhook payload the same way', async () => {
        const body = {
          allOf: [object({ id: string })],
          oneOf: [
            object({ pets: Pets, flag: ref('Flag') }, []),
            object({ pets: inlineArray(), flag: boolean, extra: integer }, []),
          ],
        };
        const doc = document(openapi, body) as { paths: Record<string, Schema>; webhooks?: Schema };
        const json = { content: { 'application/json': { schema: body } } };
        doc.paths['/pets']!.post = {
          operationId: 'createPet',
          requestBody: json,
          responses: { '201': { description: 'ok', ...json } },
        };
        if (openapi === '3.1.0') {
          doc.webhooks = {
            petAdded: {
              post: { operationId: 'petAdded', requestBody: json, responses: { '200': { description: 'ok' } } },
            },
          };
        }
        const spec = await parse(doc);
        const fields = ['id: string', 'pets?: Pet[]', 'flag?: boolean', 'extra?: integer'];
        expect(fieldsOf(spec, 'ListPetsResponse')).toEqual(fields);
        expect(fieldsOf(spec, 'CreatePetRequest')).toEqual(fields);
        expect(fieldsOf(spec, 'CreatePetResponse')).toEqual(fields);
        if (openapi === '3.1.0') expect(fieldsOf(spec, 'PetAddedPayload')).toEqual(fields);
        expect(warnings()).toEqual([]);
      });
    });

    describe('references that are not read through', () => {
      it('leaves a pointer the settle refuses to the settle, which reports it as before', async () => {
        // A pointer into a variant of the union the model flattens: the
        // settle reads a variant only off a union, and `Holder2` is none.
        const doc = flattened(openapi, [
          { $ref: '#/components/schemas/Holder2/allOf/1/oneOf/1/properties/x' },
          { type: 'array', items: string },
        ]);
        const spec = await parse(doc);
        expect(show(fieldOf(spec, 'Holder2', 'x')?.type)).toBe('(unknown | string[])');
        expect(warnings()).toEqual([
          '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Holder2/allOf/1/oneOf/1/properties/x" in Holder2.x: model "Holder2" is no union to read "oneOf/1" from — typing the site as unknown',
        ]);
      });

      it('reads a pointer into the model that declares it, a property of an `allOf` member', async () => {
        const doc = flattened(openapi, [
          { $ref: '#/components/schemas/Holder2/allOf/0/properties/tags' },
          { type: 'array', items: string },
        ]);
        const members = (doc.components.schemas.Holder2 as { allOf: Array<{ properties: Schema }> }).allOf;
        members[0]!.properties.tags = { type: 'array', items: string };
        expect(fieldsOf(await parse(doc), 'Holder2')).toEqual([
          'id?: string',
          'tags?: string[]',
          'x?: string[]',
          'only_0?: integer',
          'only_1?: integer',
        ]);
        expect(warnings()).toEqual([]);
      });

      it('compares a declaration the type builder reports as written, so it is reported in either order', async () => {
        // `type: 'array'` without `items` is typed `unknown`, with a warning; `{}` is `unknown` on purpose.
        for (const pair of [
          [{ type: 'array' }, {}],
          [{}, { type: 'array' }],
        ]) {
          warn.mockClear();
          expect(await xOf(openapi, pair)).toEqual({ type: '(unknown | unknown)' });
          expect(warnings()).toEqual(['[oagen] Warning: Unknown schema shape treated as unknown (context: x)']);
        }
        // `properties` a `oneOf` of `$ref`s cannot carry: alone it is the union, and reported.
        const carried = { properties: { p: string }, oneOf: [Pet, ref('Meta')] };
        warn.mockClear();
        expect(await xOf(openapi, [carried, carried])).toEqual({ type: '(Pet | Meta)' });
        expect(warnings()).toHaveLength(1);
        expect(await xOf(openapi, [carried, { oneOf: [Pet, ref('Meta')] }])).toEqual({
          type: '(Holder2X | (Pet | Meta))',
        });
        expect(await xOf(openapi, [{ oneOf: [Pet, ref('Meta')] }, carried])).toEqual({
          type: '((Pet | Meta) | Holder2X)',
        });
      });

      it('leaves an array component that reaches itself the reference it is', async () => {
        // `Tree: { type: 'array', items: { $ref: Tree } }`: the inner
        // reference is typed `unknown` and reported, once.
        const schemas = { Tree: { type: 'array', items: ref('Tree') } };
        const reported = [
          '[oagen] Warning: Array component "Tree" refers to itself through its items — the inner reference is typed as unknown',
        ];
        expect(await xOf(openapi, [ref('Tree'), { type: 'array', items: ref('Tree') }], schemas)).toEqual({
          type: '(unknown[] | unknown[][])',
        });
        expect(warnings()).toEqual(reported);
        warn.mockClear();
        expect(await xOf(openapi, [ref('Tree'), { allOf: [ref('Tree')] }], schemas)).toEqual({
          type: '(unknown[] | unknown[])',
        });
        expect(warnings()).toEqual(reported);
        // Beside declarations that are read, the others are one shape still.
        warn.mockClear();
        expect(await xOf(openapi, [ref('Flag'), ref('Tree'), boolean], schemas)).toEqual({
          type: '(boolean | unknown[])',
        });
        expect(warnings()).toEqual(reported);
      });
    });
  });

  describe('`unionOfDeclarations`, `typedDeclaration` and `schemaRefOf` directly', () => {
    it('reads the declarations outside an extraction, where every `$ref` is a model reference', () => {
      expect(unionOfDeclarations([string, { type: ['string', 'null'] }])).toEqual({
        oneOf: [string, { type: 'null' }],
      });
      expect(unionOfDeclarations([{ type: 'string', nullable: true }, string, integer])).toEqual({
        oneOf: [string, integer, { type: 'null' }],
      });
      expect(
        unionOfDeclarations([Pet, { allOf: [Pet], description: 'A pet.' }, { ...Pet, description: 'A pet.' }]),
      ).toEqual({
        allOf: [Pet],
      });
      expect(
        unionOfDeclarations([{ ...Pet, description: 'A pet.' }, { allOf: [Pet, { description: 'A pet.' }] }]),
      ).toEqual({
        allOf: [Pet],
        description: 'A pet.',
      });
      // An inline object keeps the `null` on its own `type`, as one of the declarations writes it.
      const thing = { type: 'object', properties: { a: string }, description: 'A thing.' };
      expect(unionOfDeclarations([thing, { ...thing, type: ['object', 'null'] }])).toEqual({
        ...thing,
        type: ['object', 'null'],
      });
      expect(
        unionOfDeclarations([
          { ...thing, nullable: true },
          { ...thing, description: 'Another.' },
        ]),
      ).toEqual({
        type: 'object',
        properties: { a: string },
        nullable: true,
      });
      // One spelling, and several shapes each written one way: as before.
      const described = { type: 'string', description: 'A' };
      expect(unionOfDeclarations([described, { type: 'string', readOnly: true }])).toEqual(string);
      expect(unionOfDeclarations([string, integer])).toEqual({ oneOf: [string, integer] });
      const first = { oneOf: [string, { type: 'null' }] };
      const result = unionOfDeclarations([first, integer]) as { oneOf: Schema[] };
      expect(result.oneOf[0]).toBe(first);
    });

    it('answers for a declaration typed alike wherever it is written, and for no other', () => {
      expect(typedDeclaration({ type: 'object', properties: { a: string } })).toBeUndefined();
      expect(typedDeclaration({ type: 'string', enum: ['a', 'b'] })).toBeUndefined();
      expect(typedDeclaration({ type: 'array', items: { type: 'object', properties: { a: string } } })).toBeUndefined();
      expect(
        typedDeclaration({ oneOf: [{ type: 'object', properties: { a: string } }, { type: 'null' }] }),
      ).toBeUndefined();
      const plain = typedDeclaration({ type: ['string', 'null'], maxLength: 5, description: 'A name.', 'x-a': 1 })!;
      expect(plain.schema).toEqual({ type: 'string', maxLength: 5, description: 'A name.', 'x-a': 1 });
      expect(plain.nullable).toBe(true);
      const wrapped = typedDeclaration({
        oneOf: [{ allOf: [{ type: 'string' }, { maxLength: 5 }] }, { type: 'null' }],
        description: 'A name.',
        'x-a': 1,
      })!;
      expect(wrapped.schema).toEqual(plain.schema);
      expect(wrapped.shape).toBe(plain.shape);
      expect(wrapped.nullable).toBe(true);
      // The limits a field reads by agreement make no shape, at the top
      // level or inside items; a union's variants keep theirs.
      const shape = (schema: Schema) => typedDeclaration(schema)!.shape;
      expect(shape({ type: 'string', maxLength: 5 })).toBe(shape(string));
      expect(shape({ type: 'array', items: { type: 'string', maxLength: 5 } })).toBe(shape({ items: string }));
      expect(shape({ type: 'string', format: 'uuid' })).not.toBe(shape(string));
      expect(shape({ oneOf: [{ type: 'string', maxLength: 5 }, integer] })).not.toBe(
        shape({ oneOf: [string, integer] }),
      );
      // A reference that stays is wrapped, its `$ref` in one spelling.
      expect(typedDeclaration({ $ref: '#/components/schemas/%50et', description: 'A pet.' })!.schema).toEqual({
        allOf: [Pet],
        description: 'A pet.',
      });
      expect(typedDeclaration({ oneOf: [{ allOf: [Pet] }, { type: 'null' }] })).toMatchObject({
        schema: { allOf: [Pet] },
        nullable: true,
      });
      // Array items and map values are read in turn, a nullable one under one wrapper.
      expect(
        typedDeclaration({ type: 'array', items: { oneOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'null' }] } })!
          .schema,
      ).toEqual({ type: 'array', items: { oneOf: [{ allOf: [Pet] }, { type: 'null' }] } });
      expect(
        typedDeclaration({ type: 'object', patternProperties: { '^x': { type: ['string', 'null'] } } })!.schema,
      ).toEqual({
        type: 'object',
        patternProperties: { '^x': { type: ['string', 'null'] } },
        additionalProperties: { oneOf: [string, { type: 'null' }] },
      });
    });

    it('writes a `null` as a nullable wrapper that carries what the field reads', () => {
      expect(withNullVariant({ type: 'string', maxLength: 5, description: 'A name.', 'x-a': 1 })).toEqual({
        maxLength: 5,
        description: 'A name.',
        'x-a': 1,
        oneOf: [string, { type: 'null' }],
      });
      expect(withNullVariant({ allOf: [Pet], description: 'A pet.' })).toEqual({
        description: 'A pet.',
        oneOf: [{ allOf: [Pet] }, { type: 'null' }],
      });
    });

    it('spells a `$ref` to one place one way, which reads back as the same tokens', () => {
      for (const tokens of [
        ['Pet'],
        ['Pet Owner'],
        ['a/b'],
        ['a~b'],
        ['~1'],
        ['a%20b'],
        ['Pet', 'properties', 'due date'],
      ]) {
        expect(schemaRefTokens(schemaRefOf(tokens)), JSON.stringify(tokens)).toEqual(tokens);
      }
      expect(schemaRefOf(['Pet'])).toBe('#/components/schemas/Pet');
      expect(schemaRefOf(['Pet Owner'])).toBe('#/components/schemas/Pet%20Owner');
      expect(componentKeyOf(schemaRefOf(['a/b~c']))).toBe('a/b~c');
    });
  });
});
