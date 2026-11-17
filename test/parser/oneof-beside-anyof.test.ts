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
  /** A nullable wrapper around `variants`: a `null` variant beside them, in this version's spelling. */
  const withNull = (keyword: 'oneOf' | 'anyOf', variants: unknown[]): Doc => ({
    [keyword]: [...variants, openapi === '3.0.3' ? { enum: [null] } : { type: 'null' }],
  });

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
  /** The one warning for a typing `anyOf` that is not read beside a typing `oneOf`, under the site's context. */
  const unread = (context: string) =>
    `[oagen] Warning: \`anyOf\` beside \`oneOf\` is not read: the two unions cannot both type the schema, which is typed by its \`oneOf\` alone (context: ${context})`;

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
    /** The `null` variant a union lists, in this version's spelling. */
    const nullVariant = openapi === '3.0.3' ? { enum: [null] } : { type: 'null' };
    const at = (s: Doc) => doc({ Pick: s, Holder: object({ pick: s, named: ref('Pick') }) });
    /** The three spellings of two unions; `flag` is written beside both, and on every member once written out. */
    const three = (unions: { oneOf: unknown[]; anyOf: unknown[] }, flag: Doc = {}) => ({
      plain: { description: 'A pick.', ...unions, ...flag },
      beside: { allOf: [{ description: 'A pick.' }], ...unions, ...flag },
      member: {
        description: 'A pick.',
        allOf: [
          { oneOf: unions.oneOf, ...flag },
          { anyOf: unions.anyOf, ...flag },
        ],
      },
    });
    const readThree = async ({ plain, beside, member }: ReturnType<typeof three>, label?: string) => {
      const read = await expectSameReading(at(plain), at(beside), label);
      await expectSameReading(at(plain), at(member), label);
      return read.spec;
    };

    it('a `null` variant in one union alone admits no `null`: the other union forbids it', async () => {
      const lists: Array<[string, { oneOf: unknown[]; anyOf: unknown[] }]> = [
        ['the oneOf', { oneOf: [...oneOf, nullVariant], anyOf }],
        ['the anyOf', { oneOf, anyOf: [...anyOf, nullVariant] }],
      ];
      for (const [label, unions] of lists) {
        const spec = await readThree(three(unions), label);
        expect(fieldsOf(model(spec, 'Pick')), label).toEqual(four);
        expect(fieldsOf(model(spec, 'HolderPick')), label).toEqual(four);
        expect(fieldsOf(model(spec, 'Holder')), label).toEqual(['pick?: HolderPick', 'named?: Pick']);
      }
    });

    it('a `null` variant in both admits `null`, as the `allOf` of the two does (#676)', async () => {
      const spec = await readThree(three({ oneOf: [...oneOf, nullVariant], anyOf: [...anyOf, nullVariant] }));
      expect(fieldsOf(model(spec, 'Pick'))).toEqual(four);
      expect(model(spec, 'Pick').variants).toBeUndefined();
      expect(fieldsOf(model(spec, 'Holder'))).toEqual(['pick?: nullable<HolderPick>', 'named?: nullable<Pick>']);
    });

    it('OAS 3.0 `nullable: true` beside the two stands for a `null` variant of each (#677)', async () => {
      const flagged = three({ oneOf, anyOf }, { nullable: true });
      const spec = await readThree(flagged);
      expect(fieldsOf(model(spec, 'Holder'))).toEqual(['pick?: nullable<HolderPick>', 'named?: nullable<Pick>']);
      const listed = three({ oneOf: [...oneOf, nullVariant], anyOf: [...anyOf, nullVariant] });
      await expectSameReading(at(flagged.plain), at(listed.plain));
    });

    it('a nullable wrapper on one axis is its one variant, always applying, beside the other union flattened', async () => {
      const { plain, beside, member } = three({ oneOf: [ref('Pet'), nullVariant], anyOf });
      const wide = (s: Doc) =>
        doc({ Pick: s, Holder: object({ pick: s, named: ref('Pick') }), Combo: { allOf: [ref('Base'), ref('Pick')] } });
      const { spec } = await expectSameReading(wide(plain), wide(beside));
      await expectSameReading(wide(plain), wide(member));
      // No wrapper around `Pet`: the `anyOf` is read, and it admits no `null`.
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

  describe('the matrix', () => {
    /** One pair of unions, with what is written beside them, and how the pair is read. */
    interface Shape {
      oneOf: unknown[];
      anyOf: unknown[];
      /** Keywords written beside the two. */
      extra?: Doc;
      /** Components the variants name beside the suite's own. */
      schemas?: Record<string, Doc>;
      /** Whether the two compose (`besideUnionsCompose`): read as the `allOf` of the two. */
      composes: boolean;
      /** The contexts the `anyOf` is reported under; none unless two typing unions do not compose. */
      unread?: string[];
    }
    const nullVariant = openapi === '3.0.3' ? { enum: [null] } : { type: 'null' };
    const int = { type: 'integer' };
    const prims = [str, int];
    const objects = (...names: string[]) => names.map((name) => object({ [name]: str }));
    const cat = object({ kind: pinned('cat'), meow: str }, ['kind']);
    const dog = object({ kind: pinned('dog'), bark: str }, ['kind']);
    const mapping = { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' };
    const titled = (title: string, name: string) => ({ title, ...object({ [name]: str }) });
    const both = ['Pick', 'Holder.pick'];
    const nested = { Nest: object({ meta: object({ x: str }) }), Other: object({ info: object({ y: str }) }) };
    const metas = {
      CursorMeta: object({ has_more: { type: 'boolean' }, next_after: str }),
      PageMeta: object({ has_more: { type: 'boolean' }, next_page: { type: 'integer' } }),
    };
    const rows: Array<[string, Shape]> = [
      // The two compose: one model of both unions' properties, or a dispatcher.
      ['two unions of `$ref`s', { oneOf, anyOf, composes: true }],
      ['two unions of inline objects', { oneOf: objects('a', 'b'), anyOf: objects('c', 'd'), composes: true }],
      ['`$ref`s beside inline objects', { oneOf, anyOf: objects('c', 'd'), composes: true }],
      ['the same union twice', { oneOf, anyOf: oneOf, composes: true }],
      ['`$ref`s beside primitives', { oneOf, anyOf: prims, composes: true }],
      ['primitives beside `$ref`s', { oneOf: prims, anyOf, composes: true }],
      ['one `$ref` beside two', { oneOf: [ref('Pet')], anyOf, composes: true }],
      [
        '`properties` beside the two',
        { oneOf, anyOf, extra: { properties: { id: str }, required: ['id'] }, composes: true },
      ],
      [
        '`properties` beside `$ref`s and inline objects',
        { oneOf, anyOf: objects('c', 'd'), extra: { properties: { id: str }, required: ['id'] }, composes: true },
      ],
      ['an empty `properties` beside the two', { oneOf, anyOf, extra: { properties: {} }, composes: true }],
      ['`type: object` beside the two', { oneOf, anyOf, extra: { type: 'object' }, composes: true }],
      [
        '`additionalProperties: false` beside the two',
        { oneOf, anyOf, extra: { additionalProperties: false }, composes: true },
      ],
      [
        'a `required` list beside the two',
        {
          oneOf: [object({ a: str }, ['a']), object({ b: str }, ['b'])],
          anyOf: [object({ c: str }, ['c']), object({ d: str })],
          extra: { required: ['a', 'd'] },
          composes: true,
        },
      ],
      [
        'limits, flags, links and `x-*` keys beside the two',
        {
          oneOf,
          anyOf,
          extra: {
            deprecated: true,
            minProperties: 1,
            'x-internal': true,
            externalDocs: { url: 'https://example.com/pick' },
          },
          composes: true,
        },
      ],
      [
        'a property several variants declare',
        {
          oneOf: [object({ id: str, a: str }), object({ id: int, b: str })],
          anyOf: [object({ id: str, c: str }), object({ a: { type: 'boolean' } })],
          composes: true,
        },
      ],
      [
        '`$ref`s to components with nested objects',
        { oneOf: [ref('Nest'), ref('Toy')], anyOf: [ref('Other'), ref('Shelter')], schemas: nested, composes: true },
      ],
      [
        'inline variants with nested objects, arrays and enums',
        {
          oneOf: [object({ meta: object({ x: str }) }), object({ b: { type: 'string', enum: ['p', 'q'] } })],
          anyOf: [object({ info: { type: 'array', items: object({ y: str }) } }), object({ d: str })],
          composes: true,
        },
      ],
      [
        'titled inline variants',
        {
          oneOf: [titled('Alpha', 'a'), titled('Beta', 'b')],
          anyOf: [titled('Gamma', 'c'), titled('Alpha', 'd')],
          composes: true,
        },
      ],
      [
        'a `discriminator` beside the two, the oneOf pinning its property',
        { oneOf: [ref('Cat'), ref('Dog')], anyOf, extra: { discriminator: { propertyName: 'kind' } }, composes: true },
      ],
      [
        'a mapped `discriminator` beside the two',
        {
          oneOf: [ref('Cat'), ref('Dog')],
          anyOf,
          extra: { discriminator: { propertyName: 'kind', mapping } },
          composes: true,
        },
      ],
      ['oneOf variants that pin one property, no keyword', { oneOf: [ref('Cat'), ref('Dog')], anyOf, composes: true }],
      ['inline oneOf variants that pin one property', { oneOf: [cat, dog], anyOf, composes: true }],
      [
        'a `discriminator` beside the two, the anyOf pinning its property',
        {
          oneOf: anyOf,
          anyOf: [ref('Cat'), ref('Dog')],
          extra: { discriminator: { propertyName: 'kind' } },
          composes: true,
        },
      ],
      [
        'one tagged object beside `$ref`s',
        { oneOf: [object({ object: pinned('pick'), a: str }, ['object'])], anyOf, composes: true },
      ],
      ['a `null` variant in the oneOf', { oneOf: [...oneOf, nullVariant], anyOf, composes: true }],
      ['a `null` variant in the anyOf', { oneOf, anyOf: [...anyOf, nullVariant], composes: true }],
      ['a `null` variant in both', { oneOf: [...oneOf, nullVariant], anyOf: [...anyOf, nullVariant], composes: true }],
      ['OAS 3.0 `nullable: true` beside the two', { oneOf, anyOf, extra: { nullable: true }, composes: true }],
      ['a nullable wrapper beside `$ref`s', { oneOf: [ref('Pet'), nullVariant], anyOf, composes: true }],
      ['`$ref`s beside a nullable wrapper', { oneOf, anyOf: [ref('Owner'), nullVariant], composes: true }],
      [
        'a nullable wrapper around a nested object beside `$ref`s',
        { oneOf: [ref('Nest'), nullVariant], anyOf, schemas: nested, composes: true },
      ],
      [
        'stop fields on the anyOf’s variants',
        { oneOf: objects('a', 'b'), anyOf: [ref('CursorMeta'), ref('PageMeta')], schemas: metas, composes: true },
      ],
      // One union types the schema: the single union (#613).
      ['an anyOf of bare limits', { oneOf, anyOf: [{ required: ['name'] }, { required: ['toy'] }], composes: false }],
      ['an empty anyOf', { oneOf, anyOf: [], composes: false }],
      [
        'two unions of bare limits beside `properties`',
        {
          oneOf: [{ required: ['a'] }, { required: ['b'] }],
          anyOf: [{ maxProperties: 1 }, { minProperties: 1 }],
          extra: { properties: { a: str, b: str } },
          composes: false,
        },
      ],
      // Two typing unions the `allOf` of which types nothing: the oneOf's reading, the anyOf reported.
      [
        'two unions of primitives',
        { oneOf: prims, anyOf: [{ type: 'boolean' }, { type: 'number' }], composes: false, unread: both },
      ],
      ['the same union of primitives twice', { oneOf: prims, anyOf: prims, composes: false, unread: both }],
      [
        'two unions of strings beside `type: string`',
        {
          oneOf: [
            { type: 'string', maxLength: 3 },
            { type: 'string', minLength: 9 },
          ],
          anyOf: [
            { type: 'string', pattern: '^a' },
            { type: 'string', pattern: '^b' },
          ],
          extra: { type: 'string' },
          composes: false,
          unread: both,
        },
      ],
      [
        'two unions of arrays',
        {
          oneOf: [{ type: 'array', items: str }],
          anyOf: [{ type: 'array', items: int }],
          composes: false,
          unread: both,
        },
      ],
      ['one `$ref` each', { oneOf: [ref('Pet')], anyOf: [ref('Owner')], composes: false, unread: both }],
      [
        'two nullable wrappers',
        { oneOf: [ref('Pet'), nullVariant], anyOf: [ref('Owner'), nullVariant], composes: false, unread: both },
      ],
      [
        'one `$ref` each beside OAS 3.0 `nullable: true`',
        { oneOf: [ref('Pet')], anyOf: [ref('Owner')], extra: { nullable: true }, composes: false, unread: both },
      ],
      [
        'two unions of string consts',
        { oneOf: [pinned('a'), pinned('b')], anyOf: [pinned('a'), pinned('c')], composes: false, unread: both },
      ],
      ['string consts beside `$ref`s', { oneOf: [pinned('a'), pinned('b')], anyOf, composes: false, unread: both }],
      // `properties` of its own compose the component, both unions members; inline the oneOf types the schema.
      [
        'two unions of primitives beside `properties`',
        {
          oneOf: prims,
          anyOf: [{ type: 'boolean' }, { type: 'number' }],
          extra: { properties: { id: str } },
          composes: false,
          unread: ['Holder.pick'],
        },
      ],
    ];
    /** The four sites: the component and a `$ref` to it, and the same schema on a field, in one spelling. */
    const at = (s: Doc, shape: Shape) =>
      doc({ ...shape.schemas, Pick: s, Named: object({ pick: ref('Pick') }), Holder: object({ pick: s }) });
    const plainOf = ({ oneOf: first, anyOf: second, extra = {} }: Shape): Doc => ({
      description: 'A pick.',
      ...extra,
      oneOf: first,
      anyOf: second,
    });
    const besideOf = ({ oneOf: first, anyOf: second, extra = {} }: Shape): Doc => ({
      allOf: [{ description: 'A pick.' }],
      ...extra,
      oneOf: first,
      anyOf: second,
    });
    const describeModel = (m: Model): string =>
      [
        `${m.name} { ${fieldsOf(m).join(', ')} }`,
        m.variants ? `${m.compositionKind} ${show({ kind: 'union', variants: m.variants })}` : '',
        m.discriminator ? `dispatches on ${m.discriminator.property}: ${JSON.stringify(m.discriminator.mapping)}` : '',
        m.bases ? `bases [${basesOf(m)!.join(', ')}]` : '',
      ]
        .filter(Boolean)
        .join(' ');
    /** What a document's types are, whatever documents them. */
    const typesOf = (spec: ApiSpec) => ({
      models: spec.models.map(describeModel),
      enums: spec.enums.map((e) => `${e.name} [${e.values.map((v) => v.value).join(', ')}]`),
    });

    it.each(rows)('%s: the component and the schema inline read one way in both spellings', async (_name, shape) => {
      const plain = plainOf(shape);
      const beside = besideOf(shape);
      expect(besideUnionsCompose(plain as SchemaObject)).toBe(shape.composes);
      expect(besideUnionsCompose(beside as SchemaObject)).toBe(shape.composes);
      const a = await read(at(plain, shape));
      const b = await read(at(beside, shape));
      expect(typesOf(a.spec)).toEqual(typesOf(b.spec));
      expect(diffSpecs(a.spec, b.spec).changes).toEqual([]);
      expect(diffSpecs(b.spec, a.spec).changes).toEqual([]);
      // The union that is not read is named once per schema, in either spelling; a composition drops nothing.
      const reported = (shape.unread ?? []).map(unread);
      expect(a.warnings).toEqual(reported);
      expect(b.warnings).toEqual(reported);
      // Where the two compose the whole IR is one, documentation included.
      if (shape.composes) expect(a.spec).toEqual(b.spec);
    });

    it('reads every shape as written here: the component, a `$ref` to it, the field, and what they mint', async () => {
      const readings: string[][] = [];
      for (const [name, shape] of rows) {
        const { spec, warnings } = await read(at(plainOf(shape), shape));
        const given = new Set([...Object.keys(components), ...Object.keys(shape.schemas ?? {}), 'Named', 'Holder']);
        const pick = spec.models.find((m) => m.name === 'Pick');
        const pickEnum = spec.enums.find((e) => e.name === 'Pick');
        const listed = (e: { name: string; values: Array<{ value: unknown }> }) =>
          `enum ${e.name} [${e.values.map((v) => v.value).join(', ')}]`;
        readings.push([
          name,
          `component: ${pick ? describeModel(pick) : pickEnum ? listed(pickEnum) : 'no model'}`,
          `$ref: ${show(model(spec, 'Named').fields[0]!.type)}`,
          `field: ${show(model(spec, 'Holder').fields[0]!.type)}`,
          ...spec.models.filter((m) => m !== pick && !given.has(m.name)).map((m) => `model ${describeModel(m)}`),
          ...spec.enums.filter((e) => e !== pickEnum).map(listed),
          ...(warnings.length > 0 ? [`warnings: ${warnings.length}`] : []),
        ]);
      }
      expect(readings).toMatchInlineSnapshot(`
        [
          [
            "two unions of \`$ref\`s",
            "component: Pick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "two unions of inline objects",
            "component: Pick { a?: string, b?: string, c?: string, d?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { a?: string, b?: string, c?: string, d?: string }",
          ],
          [
            "\`$ref\`s beside inline objects",
            "component: Pick { name?: string, toy?: string, c?: string, d?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string, c?: string, d?: string }",
          ],
          [
            "the same union twice",
            "component: Pick { name?: string, toy?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string }",
          ],
          [
            "\`$ref\`s beside primitives",
            "component: Pick { name?: string, toy?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string }",
          ],
          [
            "primitives beside \`$ref\`s",
            "component: Pick { ownerId?: string, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { ownerId?: string, shelterId?: string }",
          ],
          [
            "one \`$ref\` beside two",
            "component: Pick { name?: string, ownerId?: string, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "\`properties\` beside the two",
            "component: Pick { id: string, name?: string, toy?: string, ownerId?: string, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { id: string, name?: string, toy?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "\`properties\` beside \`$ref\`s and inline objects",
            "component: Pick { id: string, name?: string, toy?: string, c?: string, d?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { id: string, name?: string, toy?: string, c?: string, d?: string }",
          ],
          [
            "an empty \`properties\` beside the two",
            "component: Pick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "\`type: object\` beside the two",
            "component: Pick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "\`additionalProperties: false\` beside the two",
            "component: Pick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "a \`required\` list beside the two",
            "component: Pick { a: string, b?: string, c?: string, d: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { a: string, b?: string, c?: string, d: string }",
          ],
          [
            "limits, flags, links and \`x-*\` keys beside the two",
            "component: Pick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "a property several variants declare",
            "component: Pick { id?: (string | integer), a?: (string | boolean), b?: string, c?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { id?: (string | integer), a?: (string | boolean), b?: string, c?: string }",
          ],
          [
            "\`$ref\`s to components with nested objects",
            "component: Pick { meta?: PickMeta, toy?: string, info?: PickInfo, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model PickMeta { x?: string }",
            "model PickInfo { y?: string }",
            "model OtherInfo { y?: string }",
            "model NestMeta { x?: string }",
            "model HolderPick { meta?: HolderPickMeta, toy?: string, info?: HolderPickInfo, shelterId?: string }",
            "model HolderPickMeta { x?: string }",
            "model HolderPickInfo { y?: string }",
          ],
          [
            "inline variants with nested objects, arrays and enums",
            "component: Pick { meta?: PickMeta, b?: PickB, info?: PickInfo[], d?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model PickMeta { x?: string }",
            "model PickInfo { y?: string }",
            "model HolderPick { meta?: HolderPickMeta, b?: HolderPickB, info?: HolderPickInfo[], d?: string }",
            "model HolderPickMeta { x?: string }",
            "model HolderPickInfo { y?: string }",
            "enum PickB [p, q]",
            "enum HolderPickB [p, q]",
          ],
          [
            "titled inline variants",
            "component: Pick { a?: string, b?: string, c?: string, d?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { a?: string, b?: string, c?: string, d?: string }",
          ],
          [
            "a \`discriminator\` beside the two, the oneOf pinning its property",
            "component: Pick { ownerId?: string, shelterId?: string } dispatches on kind: {"cat":"Cat","dog":"Dog"}",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { kind?: HolderPickKind, meow?: string, bark?: string, ownerId?: string, shelterId?: string }",
            "enum HolderPickKind [cat, dog]",
          ],
          [
            "a mapped \`discriminator\` beside the two",
            "component: Pick { ownerId?: string, shelterId?: string } dispatches on kind: {"cat":"Cat","dog":"Dog"}",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { kind?: HolderPickKind, meow?: string, bark?: string, ownerId?: string, shelterId?: string }",
            "enum HolderPickKind [cat, dog]",
          ],
          [
            "oneOf variants that pin one property, no keyword",
            "component: Pick { ownerId?: string, shelterId?: string } dispatches on kind: {"cat":"Cat","dog":"Dog"}",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { kind?: HolderPickKind, meow?: string, bark?: string, ownerId?: string, shelterId?: string }",
            "enum HolderPickKind [cat, dog]",
          ],
          [
            "inline oneOf variants that pin one property",
            "component: Pick { ownerId?: string, shelterId?: string } dispatches on kind: {"cat":"PickCat","dog":"PickDog"}",
            "$ref: Pick",
            "field: HolderPick",
            "model PickCat { ownerId?: string, shelterId?: string, kind: "cat", meow?: string }",
            "model PickDog { ownerId?: string, shelterId?: string, kind: "dog", bark?: string }",
            "model HolderPick { kind?: HolderPickKind, meow?: string, bark?: string, ownerId?: string, shelterId?: string }",
            "enum HolderPickKind [cat, dog]",
          ],
          [
            "a \`discriminator\` beside the two, the anyOf pinning its property",
            "component: Pick { ownerId?: string, shelterId?: string } dispatches on kind: {"cat":"Cat","dog":"Dog"}",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { ownerId?: string, shelterId?: string, kind?: HolderPickKind, meow?: string, bark?: string }",
            "enum HolderPickKind [cat, dog]",
          ],
          [
            "one tagged object beside \`$ref\`s",
            "component: Pick { ownerId?: string, shelterId?: string } dispatches on object: {"pick":"PickPick"}",
            "$ref: Pick",
            "field: HolderPick",
            "model PickPick { ownerId?: string, shelterId?: string, object: "pick", a?: string }",
            "model HolderPick { object?: "pick", a?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "a \`null\` variant in the oneOf",
            "component: Pick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "a \`null\` variant in the anyOf",
            "component: Pick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "a \`null\` variant in both",
            "component: Pick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
            "$ref: nullable<Pick>",
            "field: nullable<HolderPick>",
            "model HolderPick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "OAS 3.0 \`nullable: true\` beside the two",
            "component: Pick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
            "$ref: nullable<Pick>",
            "field: nullable<HolderPick>",
            "model HolderPick { name?: string, toy?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "a nullable wrapper beside \`$ref\`s",
            "component: Pick { name?: string, ownerId?: string, shelterId?: string } bases [Pet]",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, ownerId?: string, shelterId?: string }",
          ],
          [
            "\`$ref\`s beside a nullable wrapper",
            "component: Pick { name?: string, toy?: string, ownerId?: string } bases [Owner]",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { name?: string, toy?: string, ownerId?: string }",
          ],
          [
            "a nullable wrapper around a nested object beside \`$ref\`s",
            "component: Pick { meta?: PickMeta, ownerId?: string, shelterId?: string } bases [Nest]",
            "$ref: Pick",
            "field: HolderPick",
            "model PickMeta { x?: string }",
            "model OtherInfo { y?: string }",
            "model NestMeta { x?: string }",
            "model HolderPick { meta?: NestMeta, ownerId?: string, shelterId?: string }",
          ],
          [
            "stop fields on the anyOf’s variants",
            "component: Pick { a?: string, b?: string, has_more?: boolean, next_after?: string, next_page?: integer }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { a?: string, b?: string, has_more?: boolean, next_after?: string, next_page?: integer }",
          ],
          [
            "an anyOf of bare limits",
            "component: Pick {  } oneOf (Pet | Toy)",
            "$ref: Pick",
            "field: (Pet | Toy)",
          ],
          [
            "an empty anyOf",
            "component: Pick {  } oneOf (Pet | Toy)",
            "$ref: Pick",
            "field: (Pet | Toy)",
          ],
          [
            "two unions of bare limits beside \`properties\`",
            "component: Pick { a?: string, b?: string }",
            "$ref: Pick",
            "field: HolderPick",
            "model HolderPick { a?: string, b?: string }",
          ],
          [
            "two unions of primitives",
            "component: Pick {  } oneOf (string | integer)",
            "$ref: Pick",
            "field: (string | integer)",
            "warnings: 2",
          ],
          [
            "the same union of primitives twice",
            "component: Pick {  } oneOf (string | integer)",
            "$ref: Pick",
            "field: (string | integer)",
            "warnings: 2",
          ],
          [
            "two unions of strings beside \`type: string\`",
            "component: Pick {  } oneOf (string | string)",
            "$ref: Pick",
            "field: (string | string)",
            "warnings: 2",
          ],
          [
            "two unions of arrays",
            "component: Pick {  } oneOf (string[])",
            "$ref: Pick",
            "field: (string[])",
            "warnings: 2",
          ],
          [
            "one \`$ref\` each",
            "component: Pick {  } oneOf (Pet)",
            "$ref: Pick",
            "field: (Pet)",
            "warnings: 2",
          ],
          [
            "two nullable wrappers",
            "component: Pick {  } oneOf (Pet)",
            "$ref: nullable<Pick>",
            "field: nullable<Pet>",
            "warnings: 2",
          ],
          [
            "one \`$ref\` each beside OAS 3.0 \`nullable: true\`",
            "component: Pick {  } oneOf (Pet)",
            "$ref: nullable<Pick>",
            "field: nullable<Pet>",
            "warnings: 2",
          ],
          [
            "two unions of string consts",
            "component: enum Pick [a, b]",
            "$ref: Pick",
            "field: HolderPick",
            "enum HolderPick [a, b]",
            "warnings: 2",
          ],
          [
            "string consts beside \`$ref\`s",
            "component: enum Pick [a, b]",
            "$ref: Pick",
            "field: HolderPick",
            "enum HolderPick [a, b]",
            "warnings: 2",
          ],
          [
            "two unions of primitives beside \`properties\`",
            "component: Pick { id?: string }",
            "$ref: Pick",
            "field: (string | integer)",
            "warnings: 1",
          ],
        ]
      `);
    });

    /** The types and enums a document adds to the fixtures, exactly as the IR holds them. */
    const exact = (spec: ApiSpec) =>
      JSON.parse(
        JSON.stringify({
          models: spec.models.filter((m) => !Object.hasOwn(components, m.name)),
          enums: spec.enums,
        }),
      );

    it('cell 1, neither union brings properties: the oneOf’s union at all four sites, the anyOf named in the warning', async () => {
      const shape: Shape = { oneOf: prims, anyOf: [{ type: 'boolean' }, { type: 'number' }], composes: false };
      const plain = await read(at(plainOf(shape), shape));
      const beside = await read(at(besideOf(shape), shape));
      // The component beside the annotating `allOf` was a model with no fields and no variants (#613 review).
      expect(typesOf(beside.spec)).toEqual(typesOf(plain.spec));
      expect(model(beside.spec, 'Pick')).toEqual(model(plain.spec, 'Pick'));
      expect(beside.warnings).toEqual(plain.warnings);
      expect(plain.warnings).toEqual([unread('Pick'), unread('Holder.pick')]);
      expect(exact(plain.spec)).toMatchInlineSnapshot(`
        {
          "enums": [],
          "models": [
            {
              "compositionKind": "oneOf",
              "description": "A pick.",
              "fields": [],
              "name": "Pick",
              "variants": [
                {
                  "kind": "primitive",
                  "type": "string",
                },
                {
                  "kind": "primitive",
                  "type": "integer",
                },
              ],
            },
            {
              "fields": [
                {
                  "name": "pick",
                  "required": false,
                  "type": {
                    "kind": "model",
                    "name": "Pick",
                  },
                },
              ],
              "name": "Named",
            },
            {
              "fields": [
                {
                  "description": "A pick.",
                  "name": "pick",
                  "required": false,
                  "type": {
                    "compositionKind": "oneOf",
                    "kind": "union",
                    "variants": [
                      {
                        "kind": "primitive",
                        "type": "string",
                      },
                      {
                        "kind": "primitive",
                        "type": "integer",
                      },
                    ],
                  },
                },
              ],
              "name": "Holder",
            },
          ],
        }
      `);
    });

    it('cell 2, a discriminator on the oneOf: the component dispatches, the field is one model of optional fields', async () => {
      const shape: Shape = {
        oneOf: [ref('Cat'), ref('Dog')],
        anyOf,
        extra: { discriminator: { propertyName: 'kind' } },
        composes: true,
      };
      const plain = await read(at(plainOf(shape), shape));
      const beside = await read(at(besideOf(shape), shape));
      expect(beside.spec).toEqual(plain.spec);
      expect(plain.warnings).toEqual([]);
      expect(exact(plain.spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            {
              "name": "HolderPickKind",
              "values": [
                {
                  "name": "CAT",
                  "value": "cat",
                },
                {
                  "name": "DOG",
                  "value": "dog",
                },
              ],
            },
          ],
          "models": [
            {
              "description": "A pick.",
              "discriminator": {
                "mapping": {
                  "cat": "Cat",
                  "dog": "Dog",
                },
                "property": "kind",
              },
              "fields": [
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
            },
            {
              "fields": [
                {
                  "name": "pick",
                  "required": false,
                  "type": {
                    "kind": "model",
                    "name": "Pick",
                  },
                },
              ],
              "name": "Named",
            },
            {
              "fields": [
                {
                  "description": "A pick.",
                  "name": "pick",
                  "required": false,
                  "type": {
                    "kind": "model",
                    "name": "HolderPick",
                  },
                },
              ],
              "name": "Holder",
            },
            {
              "description": "A pick.",
              "fields": [
                {
                  "name": "kind",
                  "required": false,
                  "type": {
                    "kind": "enum",
                    "name": "HolderPickKind",
                    "values": [
                      "cat",
                      "dog",
                    ],
                  },
                },
                {
                  "name": "meow",
                  "required": false,
                  "type": {
                    "kind": "primitive",
                    "type": "string",
                  },
                },
                {
                  "name": "bark",
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
              "name": "HolderPick",
            },
          ],
        }
      `);
    });

    it('cell 3, a oneOf of string consts beside an anyOf of objects: the enum, the anyOf named in the warning', async () => {
      const shape: Shape = { oneOf: [pinned('a'), pinned('b')], anyOf, composes: false };
      const plain = await read(at(plainOf(shape), shape));
      const beside = await read(at(besideOf(shape), shape));
      expect(typesOf(beside.spec)).toEqual(typesOf(plain.spec));
      expect(beside.warnings).toEqual(plain.warnings);
      expect(plain.warnings).toEqual([unread('Pick'), unread('Holder.pick')]);
      expect(exact(plain.spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            {
              "description": "A pick.",
              "name": "Pick",
              "values": [
                {
                  "name": "A",
                  "value": "a",
                },
                {
                  "name": "B",
                  "value": "b",
                },
              ],
            },
            {
              "description": "A pick.",
              "name": "HolderPick",
              "values": [
                {
                  "name": "A",
                  "value": "a",
                },
                {
                  "name": "B",
                  "value": "b",
                },
              ],
            },
          ],
          "models": [
            {
              "fields": [
                {
                  "name": "pick",
                  "required": false,
                  "type": {
                    "kind": "enum",
                    "name": "Pick",
                  },
                },
              ],
              "name": "Named",
            },
            {
              "fields": [
                {
                  "description": "A pick.",
                  "name": "pick",
                  "required": false,
                  "type": {
                    "kind": "enum",
                    "name": "HolderPick",
                    "values": [
                      "a",
                      "b",
                    ],
                  },
                },
              ],
              "name": "Holder",
            },
          ],
        }
      `);
    });

    it('names the unread anyOf once per schema, however often the schema is read', async () => {
      const s = () => ({ oneOf: prims, anyOf: [{ type: 'boolean' }, { type: 'number' }] });
      const { warnings } = await read(
        doc(
          {
            // Read as the component, at three `$ref`s, as an array's items and as an `allOf` member.
            Pick: s(),
            Holder: object({ first: ref('Pick'), second: ref('Pick'), picks: { type: 'array', items: ref('Pick') } }),
            Combo: { allOf: [ref('Base'), ref('Pick')] },
          },
          {
            '/picks': {
              post: {
                operationId: 'createPick',
                parameters: [{ name: 'pick', in: 'query', schema: s() }],
                requestBody: { content: { ...json(s()), 'application/x-www-form-urlencoded': { schema: s() } } },
                responses: {
                  '200': { description: 'OK', content: { ...json(s()), 'application/hal+json': { schema: s() } } },
                  '400': { description: 'Bad', content: json(s()) },
                },
                callbacks: {
                  onPick: {
                    '{$request.body#/url}': {
                      post: { requestBody: { content: json(s()) }, responses: { '200': { description: 'OK' } } },
                    },
                  },
                },
              },
            },
          },
          openapi === '3.0.3'
            ? {}
            : {
                webhooks: {
                  picked: {
                    post: {
                      operationId: 'onPicked',
                      requestBody: { content: json(s()) },
                      responses: { '200': { description: 'OK' } },
                    },
                  },
                },
              },
        ),
      );
      const notRead = warnings.filter((message) => message.includes('is not read'));
      // One per schema written in the document: the component, and each inline body, parameter and payload.
      expect(notRead).toHaveLength(openapi === '3.0.3' ? 8 : 9);
      expect(new Set(notRead).size).toBe(notRead.length);
      expect(notRead).toContain(unread('Pick'));
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

    it('a JSON Pointer to the schema is the composed model; one into either union finds no union to read, and is reported', async () => {
      const unresolved = (pointer: string, field: string, owner: string, step: string) =>
        `[oagen] Warning: Unresolved schema $ref "#/components/schemas/${pointer}" in Holder.${field}: model "${owner}" is no union to read "${step}" from — typing the site as unknown`;
      for (const Pick of [plainPick, besidePick]) {
        const { spec, warnings } = await read(
          doc({
            Pick,
            Holder: object({
              pick: structuredClone(Pick),
              // The field itself, as the model built for it.
              whole: { $ref: '#/components/schemas/Holder/properties/pick' },
              // Into each union, of the component and of the field: the variants are flattened, no union holds them.
              first: { $ref: '#/components/schemas/Pick/oneOf/0' },
              second: { $ref: '#/components/schemas/Pick/anyOf/1' },
              inField: { $ref: '#/components/schemas/Holder/properties/pick/anyOf/0' },
            }),
          }),
        );
        expect(fieldsOf(model(spec, 'Holder'))).toEqual([
          'pick?: HolderPick',
          'whole?: HolderPick',
          'first?: unknown',
          'second?: unknown',
          'inField?: unknown',
        ]);
        expect(fieldsOf(model(spec, 'HolderPick'))).toEqual(four);
        expect(warnings).toEqual([
          unresolved('Pick/oneOf/0', 'first', 'Pick', 'oneOf/0'),
          unresolved('Pick/anyOf/1', 'second', 'Pick', 'anyOf/1'),
          unresolved('Holder/properties/pick/anyOf/0', 'inField', 'HolderPick', 'anyOf/0'),
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
