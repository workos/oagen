import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { axisDiscriminatorOf, besideUnionsCompose, classifyInlineSchema } from '../../src/parser/schemas.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #680: a schema that writes a typing `oneOf` beside a typing `anyOf`
 * was read as both unions only as a component beside an `allOf` that
 * annotates it (#613 review). The same component with the description
 * written beside the unions was the named union of the `oneOf`'s variants,
 * and the same schema inline, in either spelling, the union of the `oneOf`
 * alone: four sites, two readings, the `anyOf` dropped at three of them
 * without a word. An instance has to match both keywords, so the two
 * unions compose wherever they are written: each is one more member, as
 * `{ allOf: [{ oneOf }, { anyOf }] }` is read.
 */

type Doc = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' };
const object = (properties: Doc, required: string[] = []): Doc => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});
const json = (schema: unknown) => ({ 'application/json': { schema } });
const oneOf = [ref('Pet'), ref('Toy')];
const anyOf = [ref('Owner'), ref('Shelter')];

/** The issue's `plain.json`: the description written beside the two unions. */
const plainPick = { description: 'A pick.', oneOf, anyOf };
/** The issue's `beside.json`: the description written as an `allOf` member. */
const besidePick = { allOf: [{ description: 'A pick.' }], oneOf, anyOf };
/** The composition written out: each union one member. */
const memberPick = { description: 'A pick.', allOf: [{ oneOf }, { anyOf }] };

/** The three spellings of one pair of unions, with what is written beside them. */
const spellings = (
  unions: { oneOf: unknown[]; anyOf: unknown[] },
  extra: Doc = {},
  onFirst: Doc = {},
): Record<'plain' | 'beside' | 'member', Doc> => ({
  plain: { description: 'A pick.', ...extra, ...onFirst, ...unions },
  beside: { allOf: [{ description: 'A pick.' }], ...extra, ...onFirst, ...unions },
  member: { description: 'A pick.', ...extra, allOf: [{ oneOf: unions.oneOf, ...onFirst }, { anyOf: unions.anyOf }] },
});

const show = (type: TypeRef | undefined): string => {
  if (!type) return String(type);
  switch (type.kind) {
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'array':
      return `${show(type.items)}[]`;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'model':
    case 'enum':
      return type.name;
    case 'literal':
      return JSON.stringify(type.value);
    case 'primitive':
      return type.type;
  }
};

describe.each(['3.1.0', '3.0.3'])('#680 a oneOf beside an anyOf (OAS %s)', (openapi) => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let written = 0;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-680-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function write(doc: unknown): Promise<string> {
    const file = path.join(tmpDir, `spec-${written++}.json`);
    await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
    return file;
  }

  /** One document parsed: its IR and the warnings it printed. */
  const read = async (doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> => {
    warn.mockClear();
    const spec = await parseSpec(await write(doc));
    return { spec, warnings: warn.mock.calls.map((call: unknown[]) => String(call[0])) };
  };
  const parse = async (doc: unknown): Promise<ApiSpec> => (await read(doc)).spec;

  const model = (spec: ApiSpec, name: string): Model => {
    const found = spec.models.find((m) => m.name === name);
    if (!found) throw new Error(`no model ${name} among ${spec.models.map((m) => m.name).join(', ')}`);
    return found;
  };
  const operation = (spec: ApiSpec): Operation => spec.services.flatMap((s) => s.operations)[0];
  const fieldsOf = (m: Model) => m.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`);
  const modelNames = (spec: ApiSpec) => spec.models.map((m) => m.name);
  const basesOf = (m: Model) => m.bases?.map(show);

  /** A property pinned to one string, in this version's spelling. */
  const pinned = (value: string) =>
    openapi === '3.0.3' ? { type: 'string', enum: [value] } : { type: 'string', const: value };
  /** A union that admits `null`, in this version's spelling: a `null` variant, or OAS 3.0 `nullable: true`. */
  const withNull = (keyword: 'oneOf' | 'anyOf', variants: unknown[]): Doc =>
    openapi === '3.0.3' ? { [keyword]: variants, nullable: true } : { [keyword]: [...variants, { type: 'null' }] };

  const components: Record<string, Doc> = {
    Owner: object({ ownerId: str }),
    Pet: object({ name: str }),
    Shelter: object({ shelterId: str }),
    Toy: object({ toy: str }),
    Cat: object({ kind: pinned('cat'), meow: str }, ['kind']),
    Dog: object({ kind: pinned('dog'), bark: str }, ['kind']),
    Base: object({ id: str }, ['id']),
  };
  const getBase = { '/base': { get: { operationId: 'getBase', responses: { '200': okBody(ref('Base')) } } } };
  function okBody(schema: unknown) {
    return { description: 'OK', content: json(schema) };
  }
  const doc = (schemas: Record<string, unknown>, paths: Doc = {}, extra: Doc = {}) => ({
    openapi,
    info: { title: 'repro', version: '1.0.0' },
    paths: { ...getBase, ...paths },
    components: { schemas: { ...components, ...schemas } },
    ...extra,
  });

  /** The issue's document: `Pick` as given, the same schema inline as `createPick`'s request body, `Pick` returned. */
  const issueDoc = (Pick: Doc, extra: Record<string, unknown> = {}) => ({
    openapi,
    info: { title: 'repro', version: '1.0.0' },
    paths: {
      '/picks': {
        post: {
          operationId: 'createPick',
          requestBody: { required: true, content: json(Pick) },
          responses: { '200': okBody(ref('Pick')) },
        },
      },
    },
    components: {
      schemas: {
        Owner: components.Owner,
        Pet: components.Pet,
        Shelter: components.Shelter,
        Toy: components.Toy,
        Pick,
        ...extra,
      },
    },
  });

  /** What the issue's script prints for one document. */
  const reading = (spec: ApiSpec) => {
    const { fields, variants } = model(spec, 'Pick');
    return {
      fields: fields.map(({ name }) => name),
      requestBody: show(operation(spec).requestBody),
      variants: variants?.map(show),
    };
  };
  const composed = {
    fields: ['name', 'toy', 'ownerId', 'shelterId'],
    requestBody: 'CreatePickRequest',
    variants: undefined,
  };
  const four = ['name?: string', 'toy?: string', 'ownerId?: string', 'shelterId?: string'];

  /** Two documents give one IR, print the same warnings, and `diffSpecs` reports nothing between them. */
  const expectSameReading = async (left: unknown, right: unknown, label?: string) => {
    const a = await read(left);
    const b = await read(right);
    expect(a.spec, label).toEqual(b.spec);
    expect(a.warnings, label).toEqual(b.warnings);
    expect(diffSpecs(a.spec, b.spec).changes, label).toEqual([]);
    expect(diffSpecs(b.spec, a.spec).changes, label).toEqual([]);
    return a;
  };

  describe('the issue', () => {
    it('`plain.json` and `beside.json` read one way, the component and the request body composed of both unions', async () => {
      const plain = await read(issueDoc(plainPick));
      const beside = await read(issueDoc(besidePick));
      expect(reading(plain.spec)).toEqual(composed);
      expect(reading(beside.spec)).toEqual(composed);
      expect(plain.spec).toEqual(beside.spec);
      expect(diffSpecs(plain.spec, beside.spec).changes).toEqual([]);
      expect(diffSpecs(beside.spec, plain.spec).changes).toEqual([]);
      expect(plain.warnings).toEqual([]);
      expect(beside.warnings).toEqual([]);
    });

    it('`oagen diff --old plain.json --new beside.json` exits 0, in either direction', async () => {
      const plain = await write(issueDoc(plainPick));
      const beside = await write(issueDoc(besidePick));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      for (const [from, to] of [
        [plain, beside],
        [beside, plain],
      ]) {
        const error = (await diffCommand({ old: from, new: to }).catch((e: unknown) => e)) as { exitCode: number };
        expect(error.exitCode).toBe(0);
      }
    });

    it('`Pick` is a model of the four components’ properties, no named union, and so is the request body', async () => {
      const spec = await parse(issueDoc(plainPick));
      expect(modelNames(spec)).toEqual(['Owner', 'Pet', 'Shelter', 'Toy', 'Pick', 'CreatePickRequest']);
      const { name, description, fields, variants, compositionKind, discriminator, bases } = model(spec, 'Pick');
      expect({
        name,
        description,
        fields: fields.map((field) => ({ name: field.name, required: field.required, type: field.type })),
        variants,
        compositionKind,
        discriminator,
        bases,
      }).toMatchInlineSnapshot(`
        {
          "bases": undefined,
          "compositionKind": undefined,
          "description": "A pick.",
          "discriminator": undefined,
          "fields": [
            {
              "name": "name",
              "required": false,
              "type": {
                "kind": "primitive",
                "type": "string",
              },
            },
            {
              "name": "toy",
              "required": false,
              "type": {
                "kind": "primitive",
                "type": "string",
              },
            },
            {
              "name": "ownerId",
              "required": false,
              "type": {
                "kind": "primitive",
                "type": "string",
              },
            },
            {
              "name": "shelterId",
              "required": false,
              "type": {
                "kind": "primitive",
                "type": "string",
              },
            },
          ],
          "name": "Pick",
          "variants": undefined,
        }
      `);
      expect(model(spec, 'Pick').variants).toBeUndefined();
      expect(model(spec, 'Pick').compositionKind).toBeUndefined();
      expect(fieldsOf(model(spec, 'CreatePickRequest'))).toEqual(four);
      expect(model(spec, 'CreatePickRequest').description).toBe('A pick.');
      expect(show(operation(spec).requestBody)).toBe('CreatePickRequest');
      expect(show(operation(spec).response)).toBe('Pick');
    });

    it('both read as the composition written out, `allOf: [{ oneOf }, { anyOf }]`', async () => {
      for (const Pick of [plainPick, besidePick]) await expectSameReading(issueDoc(Pick), issueDoc(memberPick));
    });

    it('either order of the two keywords, and of the components, gives the same models', async () => {
      const reversedKeys = { anyOf, oneOf, description: 'A pick.' };
      await expectSameReading(issueDoc(plainPick), issueDoc(reversedKeys));
      const reordered = issueDoc(plainPick);
      reordered.components.schemas = Object.fromEntries(
        Object.entries(reordered.components.schemas).reverse(),
      ) as never;
      const spec = await parse(reordered);
      expect(reading(spec)).toEqual(composed);
      expect(model(spec, 'Pick')).toEqual(model(await parse(issueDoc(plainPick)), 'Pick'));
    });
  });

  describe('every site', () => {
    const op = (operationId: string, extra: Doc = {}, response: unknown = ref('Base')) => ({
      operationId,
      responses: { '200': okBody(response) },
      ...extra,
    });
    /** Where the schema is written; `strict` sites read the composition written out the same way too. */
    const sites: Array<[string, (s: Doc) => unknown, boolean]> = [
      ['a component and a `$ref` to it', (s) => doc({ Pick: s, Holder: object({ pick: ref('Pick') }) }), true],
      ['a field', (s) => doc({ Holder: object({ pick: s }) }), true],
      ['an array’s items', (s) => doc({ Holder: object({ picks: { type: 'array', items: s } }) }), true],
      ['a map’s values', (s) => doc({ Holder: object({ picks: { type: 'object', additionalProperties: s } }) }), true],
      [
        'a variant of another union',
        (s) => doc({ Holder: object({ pick: { oneOf: [s, { type: 'boolean' }] } }) }),
        true,
      ],
      ['under a nullable wrapper', (s) => doc({ Holder: object({ pick: withNull('oneOf', [s]) }) }), true],
      ['a lone `allOf` member', (s) => doc({ Holder: object({ pick: { allOf: [s] } }) }), true],
      [
        'an array component’s items',
        (s) => doc({ Picks: { type: 'array', items: s } }, { '/picks': { get: op('listPicks', {}, ref('Picks')) } }),
        true,
      ],
      [
        'a query parameter',
        (s) =>
          doc({}, { '/picks': { get: op('listPicks', { parameters: [{ name: 'pick', in: 'query', schema: s }] }) } }),
        true,
      ],
      [
        'a response header',
        (s) =>
          doc(
            {},
            {
              '/picks': {
                get: {
                  operationId: 'getPick',
                  responses: { '200': { ...okBody(ref('Base')), headers: { 'X-Pick': { schema: s } } } },
                },
              },
            },
          ),
        true,
      ],
      [
        'a request body',
        (s) => doc({}, { '/picks': { post: op('createPick', { requestBody: { required: true, content: json(s) } }) } }),
        true,
      ],
      [
        'a form request body',
        (s) =>
          doc(
            {},
            {
              '/picks': {
                post: op('createPick', {
                  requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: s } } },
                }),
              },
            },
          ),
        true,
      ],
      [
        'a field of a request body',
        (s) =>
          doc({}, { '/picks': { post: op('createPick', { requestBody: { content: json(object({ pick: s })) } }) } }),
        true,
      ],
      ['a response body', (s) => doc({}, { '/picks': { get: op('getPick', {}, s) } }), true],
      [
        'the items of a response body',
        (s) => doc({}, { '/picks': { get: op('listPicks', {}, { type: 'array', items: s }) } }),
        true,
      ],
      [
        'an error body',
        (s) =>
          doc(
            {},
            {
              '/picks': {
                get: {
                  operationId: 'getPick',
                  responses: { '200': okBody(ref('Base')), '400': { description: 'Bad', content: json(s) } },
                },
              },
            },
          ),
        true,
      ],
      [
        'a secondary media type',
        (s) =>
          doc(
            {},
            {
              '/picks': {
                get: {
                  operationId: 'getPick',
                  responses: {
                    '200': {
                      description: 'OK',
                      content: { ...json(ref('Base')), 'application/hal+json': { schema: s } },
                    },
                  },
                },
              },
            },
          ),
        true,
      ],
      [
        'a callback body',
        (s) =>
          doc(
            {},
            {
              '/picks': {
                post: op('createPick', {
                  callbacks: {
                    onPick: {
                      '{$request.body#/url}': {
                        post: { requestBody: { content: json(s) }, responses: { '200': { description: 'OK' } } },
                      },
                    },
                  },
                }),
              },
            },
          ),
        true,
      ],
      // A member that writes both unions is a typing member, read per keyword since #597: its own text is
      // not the model's, where a bare `allOf` wrapper's is (#675), so the composition written out differs there.
      ['an inline `allOf` member', (s) => doc({ Holder: object({ pick: { allOf: [ref('Base'), s] } }) }), false],
      ['a member of a component’s `allOf`', (s) => doc({ Combo: { allOf: [ref('Base'), s] } }), false],
    ];
    if (openapi !== '3.0.3') {
      sites.push([
        'a webhook payload',
        (s) =>
          doc(
            {},
            {},
            {
              webhooks: {
                picked: {
                  post: {
                    operationId: 'onPicked',
                    requestBody: { content: json(s) },
                    responses: { '200': { description: 'OK' } },
                  },
                },
              },
            },
          ),
        true,
      ]);
    }
    const shapes: Array<[string, Record<'plain' | 'beside' | 'member', Doc>]> = [
      ['two unions of `$ref`s', spellings({ oneOf, anyOf })],
      [
        'two unions of inline objects',
        spellings({
          oneOf: [object({ a: str }), object({ b: str })],
          anyOf: [object({ c: { type: 'string', enum: ['p', 'q'] } }), object({ d: object({ x: str }) })],
        }),
      ],
      ['a union of `$ref`s beside one of primitives', spellings({ oneOf, anyOf: [str, { type: 'integer' }] })],
      ['`properties` beside the two', spellings({ oneOf, anyOf }, { properties: { id: str }, required: ['id'] })],
      [
        'a discriminated `oneOf`',
        spellings({ oneOf: [ref('Cat'), ref('Dog')], anyOf }, {}, { discriminator: { propertyName: 'kind' } }),
      ],
    ];

    // `properties` beside a composition are read on their own at two sites, whatever the composition: a
    // variant of another union that writes them is the object they declare, and under a nullable `oneOf`
    // wrapper that object is built beside the merge. Both are the readings `{ properties, allOf }` has
    // there, and the composed schema follows them; they are no reading of the two unions.
    const ownProperties = new Set(['a variant of another union', 'under a nullable wrapper']);

    it.each(sites)('reads the two spellings alike at %s', async (site, at, strict) => {
      for (const [shape, { plain, beside, member }] of shapes) {
        if (shape === '`properties` beside the two' && ownProperties.has(site)) continue;
        const read = await expectSameReading(at(structuredClone(plain)), at(structuredClone(beside)), shape);
        expect(read.warnings, shape).toEqual([]);
        if (strict) await expectSameReading(at(structuredClone(plain)), at(structuredClone(member)), shape);
      }
    });

    it('builds the model each site names: no union of the `oneOf`, no variant models', async () => {
      const { plain } = spellings({
        oneOf: [object({ a: str }), object({ b: str })],
        anyOf: [object({ c: str }), object({ d: str })],
      });
      const abcd = ['a?: string', 'b?: string', 'c?: string', 'd?: string'];
      const field = await parse(doc({ Holder: object({ pick: plain }) }));
      expect(fieldsOf(model(field, 'Holder'))).toEqual(['pick?: HolderPick']);
      expect(fieldsOf(model(field, 'HolderPick'))).toEqual(abcd);
      expect(modelNames(field).filter((name) => name.startsWith('HolderPick'))).toEqual(['HolderPick']);
      const items = await parse(doc({ Holder: object({ picks: { type: 'array', items: plain } }) }));
      expect(fieldsOf(model(items, 'Holder'))).toEqual(['picks?: HolderPick[]']);
      expect(fieldsOf(model(items, 'HolderPick'))).toEqual(abcd);
      const component = await parse(doc({ Pick: plain }));
      expect(fieldsOf(model(component, 'Pick'))).toEqual(abcd);
      expect(modelNames(component).filter((name) => name.startsWith('Pick'))).toEqual(['Pick']);
      const body = await parse(
        doc(
          {},
          {
            '/picks': {
              get: {
                operationId: 'listPicks',
                parameters: [{ name: 'pick', in: 'query', schema: plain }],
                responses: { '200': okBody(plain) },
              },
            },
          },
        ),
      );
      const listPicks = body.services.flatMap((s) => s.operations).find((o) => o.name === 'listPicks')!;
      expect(show(listPicks.response)).toBe('ListPicksResponse');
      expect(fieldsOf(model(body, 'ListPicksResponse'))).toEqual(abcd);
      expect(show(listPicks.queryParams[0]!.type)).toBe('PicksPick');
      expect(fieldsOf(model(body, 'PicksPick'))).toEqual(abcd);
    });
  });

  describe('what is written beside the two unions', () => {
    it('`properties` and `required` are the first member, at a field as on the component', async () => {
      const { plain } = spellings({ oneOf, anyOf }, { properties: { id: str }, required: ['id'] });
      const { spec, warnings } = await read(doc({ Pick: plain, Holder: object({ pick: plain }) }));
      for (const name of ['Pick', 'HolderPick'])
        expect(fieldsOf(model(spec, name)), name).toEqual(['id: string', ...four]);
      expect(warnings).toEqual([]);
    });

    it('`type: object`, a `required` list, limits, flags, links and `x-*` keys are the model’s own', async () => {
      const extra = {
        type: 'object',
        required: ['a', 'd'],
        deprecated: true,
        minProperties: 1,
        externalDocs: { url: 'https://example.com/pick' },
        'x-internal': true,
      };
      const unions = {
        oneOf: [object({ a: str }, ['a']), object({ b: str }, ['b'])],
        anyOf: [object({ c: str }, ['c']), object({ d: str })],
      };
      const { plain, beside, member } = spellings(unions, extra);
      const spec = await parse(doc({ Pick: plain, Holder: object({ pick: plain }) }));
      for (const name of ['Pick', 'HolderPick']) {
        // A variant's own `required` holds on its branch alone; the schema's own list is read.
        expect(fieldsOf(model(spec, name)), name).toEqual(['a: string', 'b?: string', 'c?: string', 'd: string']);
        expect(model(spec, name), name).toMatchObject({
          description: 'A pick.',
          deprecated: true,
          constraints: { minProperties: 1 },
          externalDocs: { url: 'https://example.com/pick' },
          extensions: { 'x-internal': true },
        });
      }
      const at = (s: Doc) => doc({ Pick: s, Holder: object({ pick: s }) });
      await expectSameReading(at(plain), at(beside));
      await expectSameReading(at(plain), at(member));
    });

    it('a type list naming `null` makes the composed model nullable, in every spelling', async () => {
      if (openapi === '3.0.3') return;
      const { plain, beside, member } = spellings({ oneOf, anyOf }, { type: ['object', 'null'] });
      const at = (s: Doc) => doc({ Pick: s, Holder: object({ pick: s, named: ref('Pick') }) });
      const { spec } = await expectSameReading(at(plain), at(beside));
      await expectSameReading(at(plain), at(member));
      expect(fieldsOf(model(spec, 'Holder'))).toEqual(['pick?: nullable<HolderPick>', 'named?: nullable<Pick>']);
      expect(fieldsOf(model(spec, 'Pick'))).toEqual(four);
    });

    it('beside an `allOf` that types the schema both unions were members already (#597): unchanged', async () => {
      const typed = { allOf: [ref('Base')], oneOf, anyOf };
      const written = { allOf: [ref('Base'), { oneOf }, { anyOf }] };
      const at = (s: Doc) => doc({ Pick: s, Holder: object({ pick: s }) });
      const { spec, warnings } = await expectSameReading(at(typed), at(written));
      for (const name of ['Pick', 'HolderPick'])
        expect(fieldsOf(model(spec, name)), name).toEqual(['id: string', ...four]);
      expect(warnings).toEqual([]);
    });
  });

  describe('null', () => {
    it('admits `null` exactly as the composition written out does, whichever union lists it', async () => {
      const lists: Array<[string, Doc]> = [
        ['the oneOf', { ...withNull('oneOf', oneOf), anyOf }],
        ['the anyOf', { oneOf, ...withNull('anyOf', anyOf) }],
      ];
      if (openapi !== '3.0.3') lists.push(['both', { ...withNull('oneOf', oneOf), ...withNull('anyOf', anyOf) }]);
      for (const [label, unions] of lists) {
        const { oneOf: first, anyOf: second, ...flag } = unions as { oneOf: unknown[]; anyOf: unknown[] };
        const plain = { description: 'A pick.', ...unions };
        const beside = { allOf: [{ description: 'A pick.' }], ...unions };
        // The flag goes with every union, as a `null` variant stays in the list it is written in.
        const member = {
          description: 'A pick.',
          allOf: [
            { oneOf: first, ...flag },
            { anyOf: second, ...flag },
          ],
        };
        const at = (s: Doc) => doc({ Pick: s, Holder: object({ pick: s, named: ref('Pick') }) });
        const { spec } = await expectSameReading(at(plain), at(beside), label);
        await expectSameReading(at(plain), at(member), label);
        expect(fieldsOf(model(spec, 'Pick')), label).toEqual(four);
        expect(model(spec, 'Pick').variants, label).toBeUndefined();
      }
    });

    it('a nullable wrapper on one axis is its one variant, always applying, beside the other union flattened', async () => {
      const unions = { ...withNull('oneOf', [ref('Pet')]), anyOf } as { oneOf: unknown[]; anyOf: unknown[] };
      const { oneOf: first, anyOf: second, ...flag } = unions;
      const plain = { description: 'A pick.', ...unions };
      const beside = { allOf: [{ description: 'A pick.' }], ...unions };
      const member = {
        description: 'A pick.',
        allOf: [
          { oneOf: first, ...flag },
          { anyOf: second, ...flag },
        ],
      };
      const at = (s: Doc) =>
        doc({ Pick: s, Holder: object({ pick: s, named: ref('Pick') }), Combo: { allOf: [ref('Base'), ref('Pick')] } });
      const { spec } = await expectSameReading(at(plain), at(beside));
      await expectSameReading(at(plain), at(member));
      // No wrapper around `Pet`: the `anyOf` is read, and a `$ref` to the component is nullable by neither axis alone.
      expect(fieldsOf(model(spec, 'Pick'))).toEqual(['name?: string', 'ownerId?: string', 'shelterId?: string']);
      expect(basesOf(model(spec, 'Pick'))).toEqual(['Pet']);
      expect(fieldsOf(model(spec, 'HolderPick'))).toEqual(['name?: string', 'ownerId?: string', 'shelterId?: string']);
      expect(fieldsOf(model(spec, 'Holder'))).toEqual(['pick?: HolderPick', 'named?: Pick']);
      // A model naming the component carries what the component's own model does, the component its base.
      expect(fieldsOf(model(spec, 'Combo'))).toEqual([
        'id: string',
        'name?: string',
        'ownerId?: string',
        'shelterId?: string',
      ]);
      expect(basesOf(model(spec, 'Combo'))).toEqual(['Base', 'Pick']);
    });
  });

  describe('a discriminator', () => {
    const cats = { oneOf: [ref('Cat'), ref('Dog')], anyOf };
    const mapping = { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' };
    const dispatched = { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } };
    const cases: Array<[string, Doc]> = [
      ['the keyword', { discriminator: { propertyName: 'kind' } }],
      ['the keyword with a mapping', { discriminator: { propertyName: 'kind', mapping } }],
      ['no keyword, the variants pinning one property', {}],
    ];

    it.each(cases)(
      'with %s: the component dispatches its oneOf and flattens its anyOf; inline both are flattened',
      async (_label, keyword) => {
        const { plain, beside, member } = spellings(cats, {}, keyword);
        const at = (s: Doc) => doc({ Pick: s, Holder: object({ pick: s }) });
        const { spec, warnings } = await expectSameReading(at(plain), at(beside));
        await expectSameReading(at(plain), at(member));
        expect(warnings).toEqual([]);
        expect(fieldsOf(model(spec, 'Pick'))).toEqual(['ownerId?: string', 'shelterId?: string']);
        expect(model(spec, 'Pick').discriminator).toEqual(dispatched);
        expect(model(spec, 'Pick').variants).toBeUndefined();
        // On a field no `allOf` dispatches: the merge carries every variant's properties.
        expect(fieldsOf(model(spec, 'HolderPick'))).toEqual([
          'kind?: HolderPickKind',
          'meow?: string',
          'bark?: string',
          'ownerId?: string',
          'shelterId?: string',
        ]);
        expect(model(spec, 'HolderPick').discriminator).toBeUndefined();
        expect(spec.enums.find((e) => e.name === 'HolderPickKind')?.values.map((v) => v.value)).toEqual(['cat', 'dog']);
      },
    );

    it('inline variants that pin the property are built as the dispatcher’s variant models, the anyOf their base', async () => {
      const unions = {
        oneOf: [
          object({ kind: pinned('cat'), meow: str }, ['kind']),
          object({ kind: pinned('dog'), bark: str }, ['kind']),
        ],
        anyOf,
      };
      const { plain, beside } = spellings(unions);
      const { spec } = await expectSameReading(doc({ Pick: plain }), doc({ Pick: beside }));
      expect(model(spec, 'Pick').discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'PickCat', dog: 'PickDog' },
      });
      expect(fieldsOf(model(spec, 'Pick'))).toEqual(['ownerId?: string', 'shelterId?: string']);
      expect(fieldsOf(model(spec, 'PickCat'))).toEqual([
        'ownerId?: string',
        'shelterId?: string',
        'kind: "cat"',
        'meow?: string',
      ]);
      expect(fieldsOf(model(spec, 'PickDog'))).toEqual([
        'ownerId?: string',
        'shelterId?: string',
        'kind: "dog"',
        'bark?: string',
      ]);
    });

    it.each(cases)(
      'with %s: a model naming the component, or writing the schema as a member, dispatches it in either spelling',
      async (_label, keyword) => {
        const { plain, beside } = spellings(cats, {}, keyword);
        const at = (s: Doc) =>
          doc({
            Pick: s,
            Through: { allOf: [ref('Base'), ref('Pick')] },
            Inline: { allOf: [ref('Base'), s] },
            Alias: ref('Pick'),
            Holder: object({ merged: { allOf: [ref('Base'), ref('Pick')] } }),
          });
        const { spec, warnings } = await expectSameReading(at(plain), at(beside));
        expect(warnings).toEqual([]);
        // The `anyOf` is flattened into each, never dropped beside the mapped `oneOf`.
        for (const name of ['Through', 'Inline']) {
          expect(fieldsOf(model(spec, name)), name).toEqual(['id: string', 'ownerId?: string', 'shelterId?: string']);
          expect(model(spec, name).discriminator, name).toEqual(dispatched);
        }
        expect(basesOf(model(spec, 'Through'))).toEqual(['Base', 'Pick']);
        expect(basesOf(model(spec, 'Inline'))).toEqual(['Base']);
        expect(fieldsOf(model(spec, 'Alias'))).toEqual(['ownerId?: string', 'shelterId?: string']);
        expect(model(spec, 'Alias').discriminator).toEqual(dispatched);
        // An inline merge leaves the union the component dispatches to the component, and keeps the one it flattens.
        expect(fieldsOf(model(spec, 'HolderMerged'))).toEqual(['id: string', 'ownerId?: string', 'shelterId?: string']);
      },
    );

    it('`axisDiscriminatorOf` hands a schema’s keyword to the first typing union alone', () => {
      const discriminator = { propertyName: 'kind' };
      const both: SchemaObject = { oneOf: [ref('Cat'), ref('Dog')], anyOf: [ref('Owner')], discriminator };
      expect(axisDiscriminatorOf(both, both.oneOf!)).toBe(discriminator);
      expect(axisDiscriminatorOf(both, both.anyOf!)).toBeUndefined();
      // A `oneOf` of bare limits types nothing: the keyword is the `anyOf`'s.
      const limits: SchemaObject = { oneOf: [{ required: ['a'] }], anyOf: [ref('Cat'), ref('Dog')], discriminator };
      expect(axisDiscriminatorOf(limits, limits.oneOf!)).toBeUndefined();
      expect(axisDiscriminatorOf(limits, limits.anyOf!)).toBe(discriminator);
      const one: SchemaObject = { anyOf: [ref('Cat'), ref('Dog')], discriminator };
      expect(axisDiscriminatorOf(one, one.anyOf!)).toBe(discriminator);
      expect(axisDiscriminatorOf({ oneOf: [ref('Cat')], anyOf: [ref('Owner')] }, [])).toBeUndefined();
    });
  });

  describe('a model naming the component', () => {
    it('carries both unions’ properties, the component its base, in either spelling', async () => {
      const at = (s: Doc, inline = true) =>
        doc({
          Pick: s,
          Through: { allOf: [ref('Base'), ref('Pick')] },
          ...(inline ? { Inline: { allOf: [ref('Base'), s] } } : {}),
          Alias: ref('Pick'),
          Either: { oneOf: [ref('Pick'), ref('Base')] },
          Holder: object({ merged: { allOf: [ref('Base'), ref('Pick')] }, aliased: ref('Alias') }),
        });
      const { spec, warnings } = await expectSameReading(at(plainPick), at(besidePick));
      // Written as a member, the composition written out hands its own text to the model (#675): left out.
      await expectSameReading(at(plainPick, false), at(memberPick, false));
      expect(warnings).toEqual([]);
      for (const name of ['Through', 'Inline', 'HolderMerged']) {
        expect(fieldsOf(model(spec, name)), name).toEqual(['id: string', ...four]);
      }
      expect(basesOf(model(spec, 'Through'))).toEqual(['Base', 'Pick']);
      expect(fieldsOf(model(spec, 'Alias'))).toEqual(four);
      expect(basesOf(model(spec, 'Alias'))).toEqual(['Pick']);
      expect(model(spec, 'Either').variants?.map(show)).toEqual(['Pick', 'Base']);
    });

    it('types a nested object the component inherits under the component’s name, as the component’s own model does', async () => {
      const nested = { ...withNull('oneOf', [ref('Nest')]), anyOf };
      const at = (s: Doc) =>
        doc({
          Nest: object({ meta: object({ x: str }) }),
          Pick: s,
          Holder: object({ merged: { allOf: [ref('Base'), ref('Pick')] } }),
        });
      const { spec } = await expectSameReading(
        at({ description: 'A pick.', ...nested }),
        at({ allOf: [{ description: 'A pick.' }], ...nested }),
      );
      expect(fieldsOf(model(spec, 'Pick'))).toEqual(['meta?: PickMeta', 'ownerId?: string', 'shelterId?: string']);
      expect(fieldsOf(model(spec, 'HolderMerged'))).toEqual([
        'id: string',
        'meta?: PickMeta',
        'ownerId?: string',
        'shelterId?: string',
      ]);
    });
  });

  describe('what types the schema', () => {
    it('a union of bare limits beside a typing oneOf types nothing: the single union, as before (#613)', async () => {
      const limits = [{ required: ['name'] }, { required: ['toy'] }];
      for (const Pick of [
        { description: 'A pick.', oneOf },
        { allOf: [{ description: 'A pick.' }], oneOf },
      ]) {
        const alone = await read(issueDoc(Pick));
        const both = await read(issueDoc({ ...Pick, anyOf: limits }));
        expect(reading(both.spec)).toEqual({ fields: [], requestBody: '(Pet | Toy)', variants: ['Pet', 'Toy'] });
        expect(both.spec).toEqual(alone.spec);
        expect(both.warnings).toEqual([]);
      }
    });

    it('`besideUnionsCompose` and `classifyInlineSchema` agree before the fold', () => {
      const prims = [str, { type: 'integer' }];
      const cases: Array<[SchemaObject, boolean]> = [
        [{ oneOf, anyOf }, true],
        [{ allOf: [{ description: 'A pick.' }], oneOf, anyOf }, true],
        [{ oneOf, anyOf: prims }, true],
        [{ oneOf: prims, anyOf }, true],
        [{ oneOf: [ref('Pet')], anyOf }, true],
        [{ properties: { id: str }, oneOf, anyOf }, true],
        // One union, or one that only limits the schema.
        [{ oneOf }, false],
        [{ oneOf, anyOf: [{ required: ['name'] }] }, false],
        [{ oneOf: [{ maxProperties: 1 }], anyOf }, false],
        [{ oneOf, anyOf: [] }, false],
        // Two that compose no object.
        [{ oneOf: prims, anyOf: prims }, false],
        [{ oneOf: [ref('Pet')], anyOf: [ref('Owner')] }, false],
        [{ oneOf: [ref('Pet'), { type: 'null' }], anyOf: [ref('Owner'), { type: 'null' }] }, false],
        [{ oneOf: [{ type: 'array', items: str }], anyOf: [{ type: 'array', items: str }] }, false],
        // A `oneOf` of string consts is decided first.
        [{ oneOf: [{ const: 'a' }, { const: 'b' }], anyOf }, false],
        // A `$ref` is the reference, whatever sits beside it.
        [{ $ref: '#/components/schemas/Pet', oneOf, anyOf }, false],
      ];
      for (const [schema, composes] of cases) {
        expect(besideUnionsCompose(schema), JSON.stringify(schema)).toBe(composes);
        if (composes) expect(classifyInlineSchema(schema), JSON.stringify(schema)).toBe('allOf');
      }
      // Beside an `allOf` that types the schema the unions are members already, and the question is not asked.
      expect(classifyInlineSchema({ allOf: [ref('Base')], oneOf: prims, anyOf: prims })).toBe('allOf');
      expect(classifyInlineSchema({ oneOf: prims, anyOf: prims })).toBe('union');
    });
  });

  describe('two unions that compose no object', () => {
    const unread = (context: string) =>
      `[oagen] Warning: \`anyOf\` beside \`oneOf\` is not read: the two compose no object, so the schema is typed by its \`oneOf\` alone (context: ${context})`;
    const prims = { oneOf: [str, { type: 'integer' }], anyOf: [{ type: 'boolean' }, { type: 'number' }] };

    it('two unions of primitives stay the union of the oneOf at every site, and the anyOf is reported once per schema', async () => {
      const at = (s: Doc) =>
        doc(
          { Pick: s, Holder: object({ pick: s }) },
          {
            '/picks': {
              post: {
                operationId: 'createPick',
                requestBody: { content: json(s) },
                responses: { '200': okBody(ref('Pick')) },
              },
            },
          },
        );
      const { plain, beside } = spellings(prims);
      for (const Pick of [plain, beside]) {
        const { spec, warnings } = await read(at(structuredClone(Pick)));
        expect(model(spec, 'Pick').variants?.map(show)).toEqual(['string', 'integer']);
        expect(model(spec, 'Pick').compositionKind).toBe('oneOf');
        expect(fieldsOf(model(spec, 'Pick'))).toEqual([]);
        expect(fieldsOf(model(spec, 'Holder'))).toEqual(['pick?: (string | integer)']);
        expect(show(spec.services.flatMap((s) => s.operations).find((o) => o.name === 'createPick')!.requestBody)).toBe(
          '(string | integer)',
        );
        expect(warnings).toEqual([unread('Pick'), unread('Holder.pick'), unread('CreatePickRequest')]);
      }
      // The two component spellings are one reading (the component beside the `allOf` was a model with no fields).
      const a = await parse(doc({ Pick: plain }));
      const b = await parse(doc({ Pick: beside }));
      expect(a.models).toEqual(b.models);
      expect(diffSpecs(a, b).changes).toEqual([]);
    });

    it('is the reading the oneOf has alone: nothing but the warning changes', async () => {
      const shapes: Array<[string, { oneOf: unknown[]; anyOf: unknown[] }]> = [
        ['primitives', prims],
        ['one `$ref` each', { oneOf: [ref('Pet')], anyOf: [ref('Owner')] }],
        ['arrays', { oneOf: [{ type: 'array', items: str }], anyOf: [{ type: 'array', items: { type: 'integer' } }] }],
        ['consts', { oneOf: [pinned('a'), pinned('b')], anyOf: [pinned('a'), pinned('c')] }],
        ['consts beside objects', { oneOf: [pinned('a'), pinned('b')], anyOf }],
      ];
      for (const [label, unions] of shapes) {
        const at = (s: Doc) => doc({ Pick: s, Holder: object({ pick: s }) });
        const both = await read(at({ description: 'A pick.', ...unions }));
        const alone = await read(at({ description: 'A pick.', oneOf: unions.oneOf }));
        expect(both.spec, label).toEqual(alone.spec);
        expect(both.warnings, label).toEqual([unread('Pick'), unread('Holder.pick')]);
        expect(alone.warnings, label).toEqual([]);
      }
    });

    it('a oneOf of string consts stays the enum beside an anyOf of objects', async () => {
      const { plain, beside } = spellings({ oneOf: [pinned('a'), pinned('b')], anyOf });
      for (const Kind of [plain, beside]) {
        const { spec, warnings } = await read(doc({ Kind, Holder: object({ kind: ref('Kind') }) }));
        expect(spec.enums.find((e) => e.name === 'Kind')?.values.map((v) => v.value)).toEqual(['a', 'b']);
        expect(modelNames(spec)).not.toContain('Kind');
        expect(fieldsOf(model(spec, 'Holder'))).toEqual(['kind?: Kind']);
        expect(warnings).toEqual([unread('Kind')]);
      }
    });

    it('`properties` of its own compose a component with both unions as members: nothing is reported', async () => {
      const { spec, warnings } = await read(doc({ Pick: { properties: { id: str }, ...prims } }));
      expect(fieldsOf(model(spec, 'Pick'))).toEqual(['id?: string']);
      expect(warnings).toEqual([]);
    });
  });

  describe('the passes that follow the reading', () => {
    it('pagination: a stop field only the anyOf’s variants declare resolves, as the model carries it', async () => {
      const meta = {
        oneOf: [object({ a: str }), object({ b: str })],
        anyOf: [ref('CursorMeta'), ref('PageMeta')],
      };
      const endOfIteration = { kind: 'hasMore', path: 'meta.has_more' };
      const at = (s: Doc) =>
        doc(
          {
            CursorMeta: object({ has_more: { type: 'boolean' }, next_after: str }),
            PageMeta: object({ has_more: { type: 'boolean' }, next_page: { type: 'integer' } }),
          },
          {
            '/picks': {
              get: {
                operationId: 'listPicks',
                parameters: [{ name: 'after', in: 'query', schema: str }],
                responses: { '200': okBody(object({ data: { type: 'array', items: str }, meta: s })) },
                'x-pagination': { endOfIteration },
              },
            },
          },
        );
      const { spec, warnings } = await expectSameReading(
        at({ description: 'Meta.', ...meta }),
        at({ allOf: [{ description: 'Meta.' }], ...meta }),
      );
      const listPicks = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'listPicks')!;
      expect(listPicks.pagination?.endOfIteration).toEqual(endOfIteration);
      expect(fieldsOf(model(spec, 'Meta'))).toEqual([
        'a?: string',
        'b?: string',
        'has_more?: boolean',
        'next_after?: string',
        'next_page?: integer',
      ]);
      expect(warnings).toEqual([]);
    });

    it('a single-resource wrapper is not unwrapped onto the oneOf’s one object with the anyOf dropped', async () => {
      const tagged = { oneOf: [object({ object: pinned('pick'), a: str }, ['object'])], anyOf };
      const at = (s: Doc) =>
        doc(
          {},
          {
            '/picks': {
              get: {
                operationId: 'getPick',
                responses: { '200': okBody({ type: 'object', required: ['pick'], properties: { pick: s } }) },
              },
            },
          },
        );
      const { spec } = await expectSameReading(
        at({ description: 'A pick.', ...tagged }),
        at({ allOf: [{ description: 'A pick.' }], ...tagged }),
      );
      const getPick = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'getPick')!;
      expect(show(getPick.response)).toBe('GetPickResponse');
      expect(fieldsOf(model(spec, 'GetPickResponse'))).toEqual(['pick: GetPickResponsePick']);
      expect(fieldsOf(model(spec, 'GetPickResponsePick'))).toEqual([
        'object?: "pick"',
        'a?: string',
        'ownerId?: string',
        'shelterId?: string',
      ]);
    });

    it('contested titles: the variants of a composed schema mint no model, so their titles contest nothing', async () => {
      const titled = (title: string, property: string, tag: string) => ({
        title,
        ...object({ [property]: str, tag: pinned(tag) }),
      });
      const other = { oneOf: [titled('Alpha', 'z', 'x'), titled('Zed', 'w', 'y')] };
      const both = {
        oneOf: [titled('Alpha', 'a', 'cat'), titled('Beta', 'b', 'dog')],
        anyOf: [object({ c: str }), object({ d: str })],
      };
      const at = (s: Doc) => doc({ Holder: object({ pick: s, other }) });
      const { spec, warnings } = await expectSameReading(
        at({ description: 'A pick.', ...both }),
        at({ allOf: [{ description: 'A pick.' }], ...both }),
      );
      // `Alpha` names the other union's variant alone; the composed schema builds one model, `HolderPick`.
      expect(fieldsOf(model(spec, 'Holder'))).toEqual(['pick?: HolderPick', 'other?: (Alpha | Zed)']);
      expect(fieldsOf(model(spec, 'Alpha'))).toEqual(['z?: string', 'tag?: "x"']);
      expect(modelNames(spec).filter((name) => name.includes('Alpha') || name.includes('Beta'))).toEqual(['Alpha']);
      expect(warnings).toEqual([]);
    });

    it('a JSON Pointer into a union of a composed component finds no union to read, and is reported', async () => {
      for (const Pick of [plainPick, besidePick]) {
        const { spec, warnings } = await read(
          doc({ Pick, Holder: object({ first: { $ref: '#/components/schemas/Pick/oneOf/0' } }) }),
        );
        expect(fieldsOf(model(spec, 'Holder'))).toEqual(['first?: unknown']);
        expect(warnings).toEqual([
          '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Pick/oneOf/0" in Holder.first: model "Pick" is no union to read "oneOf/0" from — typing the site as unknown',
        ]);
      }
    });

    it('`oagen diff` from the union of the oneOf to the composed reading reports the variants removed and the fields added', async () => {
      // What a document that writes both unions shows between two versions of the parser: the named union it
      // was, written here as the `oneOf` alone, against the model it is.
      const before = await parse(issueDoc({ description: 'A pick.', oneOf }));
      const after = await parse(issueDoc(plainPick));
      const pick = diffSpecs(before, after).changes.find((change) => 'name' in change && change.name === 'Pick');
      expect(pick).toMatchObject({
        kind: 'model-modified',
        classification: 'breaking',
        fieldChanges: four.map((field) => ({ kind: 'field-added', fieldName: field.split('?')[0] })),
        variantChanges: [
          { kind: 'variant-removed', variant: 'Pet' },
          { kind: 'variant-removed', variant: 'Toy' },
        ],
      });
    });
  });
});
