import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Field, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #711: a type list's limits are the union's, and its variants carry
 * none. Each variant is built from a per-type copy of the list's schema
 * without the site's limits, but the builder re-entered `schemaToTypeRef`
 * wherever a copy was read one level down — a lone `allOf` member
 * unwrapped, a `$ref` member's component, a nullable wrapper's branch, the
 * OAS 3.0 flag's unwrap — and that level's limits came back on the variant:
 * `{ type: ['array', 'string'], allOf: [{ items, minItems: 2 }] }` had `{
 * minItems: 2 }` on the union and on its array variant, where the same
 * `items` and `minItems` beside the list, or in two members, left the
 * variant bare. The variants now carry none, whichever level wrote the
 * limit (`typeListVariants`), and the union reads the limits of an array
 * or primitive component that only one per-type copy references
 * (`schemaConstraints`), so what is taken off such a variant is the
 * union's and the field's.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
const LIST = ['array', 'string'];

/** The issue's four spellings of `string[] | string` with `minItems: 2`. */
const beside = (type: string[] = LIST) => ({ type, items: string, minItems: 2 });
const two = (type: string[] = LIST) => ({ type, allOf: [{ items: string }, { minItems: 2 }] });
const one = (type: string[] = LIST) => ({ type, allOf: [{ items: string, minItems: 2 }] });
const nested = (type: string[] = LIST) => ({ type, allOf: [{ allOf: [{ items: string }, { minItems: 2 }] }] });
const ISSUE = { 'beside.json': beside, 'two.json': two, 'one.json': one, 'nested.json': nested };

/** The issue's document: `POST /notes` (`createNote`) taking `$ref: Note`, `Note.tags` as given. */
function document(openapi: string, tags: unknown, schemas: Record<string, unknown> = {}) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/notes': {
        post: {
          operationId: 'createNote',
          requestBody: { content: { 'application/json': { schema: ref('Note') } } },
          responses: { '204': { description: 'none' } },
        },
      },
    },
    components: { schemas: { Note: { type: 'object', properties: { tags } }, ...schemas } },
  };
}

/** A type with its limits, nested unions in parentheses. */
function show(type: TypeRef): string {
  const limits = 'constraints' in type && type.constraints ? ` ${JSON.stringify(type.constraints)}` : '';
  switch (type.kind) {
    case 'union':
      return `(${type.variants.map(show).join(' | ')})${limits}`;
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'array':
      return `array<${show(type.items)}>${limits}`;
    case 'map':
      return `map<${show(type.valueType)}>${limits}`;
    case 'literal':
      return `${JSON.stringify(type.value)}${limits}`;
    case 'primitive':
      return `${type.type}${type.format ? `:${type.format}` : ''}${limits}`;
    case 'enum':
      return `enum ${type.name}`;
    default:
      return type.name;
  }
}

/** The limits a type carries where `oagen diff` reads a variant's: its own, or under `nullable` its inner type's. */
const limitsOf = (type: TypeRef): unknown =>
  type.kind === 'nullable' ? limitsOf(type.inner) : 'constraints' in type ? type.constraints : undefined;

describe('#711 a type list’s variants carry none of the limits an `allOf` member writes', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-type-list-member-limits-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  let specs = 0;
  async function writeJson(doc: unknown): Promise<string> {
    const specFile = path.join(tmpDir, `spec-${specs++}.json`);
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return specFile;
  }
  const parseJson = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeJson(doc));

  const tags = (spec: ApiSpec): Field =>
    spec.models.find(({ name }) => name === 'Note')!.fields.find(({ name }) => name === 'tags')!;
  /** `Note.tags` written as `schema`: the field. */
  const field = async (schema: unknown, schemas?: Record<string, unknown>, openapi = '3.1.0'): Promise<Field> =>
    tags(await parseJson(document(openapi, schema, schemas)));
  /** `Note.tags` written as `schema`, as `show` prints its type. */
  const typed = async (schema: unknown, schemas?: Record<string, unknown>, openapi = '3.1.0'): Promise<string> =>
    show((await field(schema, schemas, openapi)).type);
  /** Each `[label, schema]` typed, one `label: type` per line. */
  const table = async (
    rows: ReadonlyArray<readonly [string, unknown]>,
    schemas?: Record<string, unknown>,
    openapi = '3.1.0',
  ): Promise<string> => {
    const lines: string[] = [];
    for (const [label, schema] of rows) lines.push(`${label}: ${await typed(schema, schemas, openapi)}`);
    return lines.join('\n');
  };
  /** The union a type list is, under its nullable wrapper. */
  const unionOf = (type: TypeRef): Extract<TypeRef, { kind: 'union' }> => {
    const bare = type.kind === 'nullable' ? type.inner : type;
    if (bare.kind !== 'union') throw new Error(`not a union: ${show(type)}`);
    return bare;
  };
  /** `oagen diff` between two parsed documents, both directions: nothing moved. */
  const expectNoDiff = (a: ApiSpec, b: ApiSpec, label: string) => {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const diff = diffSpecs(from, to);
      expect(diff.changes, label).toEqual([]);
      expect(diff.summary.breaking, label).toBe(0);
    }
  };

  describe('the issue', () => {
    it.each(['3.0.3', '3.1.0'])(
      'reads the four documents alike: `{ minItems: 2 }` on the union, nothing on the array variant (the repro), under OAS %s',
      async (openapi) => {
        const lines: string[] = [];
        const parsed: Record<string, ApiSpec> = {};
        for (const [file, schema] of Object.entries(ISSUE)) {
          parsed[file] = await parseJson(document(openapi, schema()));
          // The issue's script.
          const { type } = tags(parsed[file]!);
          const union = unionOf(type);
          lines.push(
            `${file} ${JSON.stringify({ union: union.constraints, array: limitsOf(union.variants[0]!) ?? null })}`,
          );
        }
        expect(lines.join('\n')).toMatchInlineSnapshot(`
          "beside.json {"union":{"minItems":2},"array":null}
          two.json {"union":{"minItems":2},"array":null}
          one.json {"union":{"minItems":2},"array":null}
          nested.json {"union":{"minItems":2},"array":null}"
        `);
        // The whole type and the field's own limits, which equal its type's.
        for (const [file, spec] of Object.entries(parsed)) {
          expect(tags(spec).type, file).toEqual({
            kind: 'union',
            variants: [
              { kind: 'array', items: { kind: 'primitive', type: 'string' } },
              { kind: 'primitive', type: 'string' },
            ],
            constraints: { minItems: 2 },
          });
          expect(tags(spec).constraints, file).toEqual({ minItems: 2 });
          expect(spec, file).toEqual(parsed['beside.json']);
        }
        expect(warn).not.toHaveBeenCalled();

        // `oagen diff` between any two of the four reports nothing.
        const files = Object.keys(parsed);
        for (const from of files) {
          for (const to of files) expectNoDiff(parsed[from]!, parsed[to]!, `${from} -> ${to}`);
        }
      },
    );

    it('types the four as fields of one model alike, each written where it is typed', async () => {
      // The example `docs/architecture/ir-types.md` gives under "A type list's limits".
      const Note = { type: 'object', properties: { beside: beside(), two: two(), one: one(), nested: nested() } };
      const spec = await parseJson(document('3.1.0', undefined, { Note }));
      const { fields } = spec.models.find(({ name }) => name === 'Note')!;
      expect(fields.map(({ name, type, constraints }) => `${name}: ${show(type)} / ${JSON.stringify(constraints)}`))
        .toMatchInlineSnapshot(`
          [
            "beside: (array<string> | string) {"minItems":2} / {"minItems":2}",
            "two: (array<string> | string) {"minItems":2} / {"minItems":2}",
            "one: (array<string> | string) {"minItems":2} / {"minItems":2}",
            "nested: (array<string> | string) {"minItems":2} / {"minItems":2}",
          ]
        `);
    });

    it('`oagen diff` between any two of the four exits 0, in either direction', async () => {
      const written: Record<string, string> = {};
      for (const [file, schema] of Object.entries(ISSUE)) written[file] = await writeJson(document('3.1.0', schema()));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      for (const from of Object.keys(written)) {
        for (const to of Object.keys(written)) {
          if (from === to) continue;
          const error = (await diffCommand({ old: written[from]!, new: written[to]! }).catch((e: unknown) => e)) as {
            exitCode: number;
          };
          expect(error.exitCode, `--old ${from} --new ${to}`).toBe(0);
        }
      }
    });
  });

  describe('every spelling of the members', () => {
    it.each([
      [['array', 'string'], '(array<string> | string) {"minItems":2}'],
      [['string', 'array'], '(string | array<string>) {"minItems":2}'],
      [['array', 'string', 'null'], 'nullable<(array<string> | string) {"minItems":2}>'],
      [['null', 'string', 'array'], 'nullable<(string | array<string>) {"minItems":2}>'],
      [['array', 'integer', 'boolean'], '(array<string> | integer | boolean) {"minItems":2}'],
      [['array', 'object'], '(array<string> | map<unknown>) {"minItems":2}'],
    ])('reads the list %j as %s wherever the `items` and the limit are written', async (type, expected) => {
      const limit = { minItems: 2 };
      const items = { items: string };
      const spellings: Array<[string, unknown]> = [
        ['beside the list', beside(type)],
        ['two members', two(type)],
        ['two members, the limit first', { type, allOf: [limit, items] }],
        ['one member', one(type)],
        ['one member, one level down', { type, allOf: [{ allOf: [{ ...items, ...limit }] }] }],
        [
          'one member, three levels down',
          { type, allOf: [{ allOf: [{ allOf: [{ allOf: [{ ...items, ...limit }] }] }] }] },
        ],
        ['two members, one level down', nested(type)],
        ['two members, one level down, the limit first', { type, allOf: [{ allOf: [limit, items] }] }],
        ['two members, two levels down', { type, allOf: [{ allOf: [{ allOf: [items, limit] }] }] }],
        ['each member wrapped on its own', { type, allOf: [{ allOf: [items] }, { allOf: [limit] }] }],
        ['the limit beside the inner `allOf`', { type, allOf: [{ ...limit, allOf: [items] }] }],
        ['the `items` beside the inner `allOf`', { type, allOf: [{ ...items, allOf: [limit] }] }],
        ['the limit beside the list, the `items` in a member', { type, ...limit, allOf: [items] }],
        ['the `items` beside the list, the limit in a member', { type, ...items, allOf: [limit] }],
        ['the limit beside the list and in the member', { type, ...limit, allOf: [{ ...items, ...limit }] }],
        [
          'a `description` member beside the one member',
          { type, allOf: [{ ...items, ...limit }, { description: 'Tags.' }] },
        ],
        [
          'a `description` beside the inner `allOf`',
          { type, allOf: [{ description: 'Tags.', allOf: [items, limit] }] },
        ],
        ['an empty member beside the two', { type, allOf: [items, {}, limit] }],
      ];
      const reference = await parseJson(document('3.1.0', beside(type)));
      for (const [label, schema] of spellings) {
        const spec = await parseJson(document('3.1.0', schema));
        expect(show(tags(spec).type), label).toBe(expected);
        expect(tags(spec).constraints, label).toEqual({ minItems: 2 });
        for (const variant of unionOf(tags(spec).type).variants) expect(limitsOf(variant), label).toBeUndefined();
        // The `description` a member writes is the field's; nothing else moves.
        expectNoDiff(reference, spec, label);
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('conjoins what the list and its members write into the union’s limits, once', async () => {
      expect(
        await table([
          ['beside and in the member', { type: LIST, minItems: 2, allOf: [{ items: string, maxItems: 5 }] }],
          ['two limits in one member', { type: LIST, allOf: [{ items: string, minItems: 2, maxItems: 5 }] }],
          ['the stricter of two', { type: LIST, minItems: 1, allOf: [{ items: string, minItems: 2 }] }],
          ['at two depths', { type: LIST, allOf: [{ maxItems: 5, allOf: [{ items: string, minItems: 2 }] }] }],
          ['another type’s beside the list', { type: LIST, minLength: 3, allOf: [{ items: string, minItems: 2 }] }],
          ['another type’s in the member', { type: LIST, allOf: [{ items: string, minItems: 2, minLength: 3 }] }],
        ]),
      ).toMatchInlineSnapshot(`
        "beside and in the member: (array<string> | string) {"minItems":2,"maxItems":5}
        two limits in one member: (array<string> | string) {"minItems":2,"maxItems":5}
        the stricter of two: (array<string> | string) {"minItems":2}
        at two depths: (array<string> | string) {"maxItems":5,"minItems":2}
        another type’s beside the list: (array<string> | string) {"minLength":3,"minItems":2}
        another type’s in the member: (array<string> | string) {"minLength":3,"minItems":2}"
      `);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('every kind of variant', () => {
    it('an array: `minItems`, `maxItems`, `uniqueItems`, `minContains`, `maxContains`', async () => {
      const limits = { minItems: 2, maxItems: 5, uniqueItems: true, minContains: 1, maxContains: 3 };
      const written = await field({ type: LIST, items: string, ...limits });
      expect(written.type).toEqual({
        kind: 'union',
        variants: [
          { kind: 'array', items: { kind: 'primitive', type: 'string' } },
          { kind: 'primitive', type: 'string' },
        ],
        constraints: limits,
      });
      for (const [label, schema] of [
        ['two members', { type: LIST, allOf: [{ items: string }, limits] }],
        ['one member', { type: LIST, allOf: [{ items: string, ...limits }] }],
        ['nested', { type: LIST, allOf: [{ allOf: [{ items: string }, limits] }] }],
        ['one member, nested', { type: LIST, allOf: [{ allOf: [{ items: string, ...limits }] }] }],
        [
          'a member for each limit',
          {
            type: LIST,
            allOf: [{ items: string }, ...Object.entries(limits).map(([key, value]) => ({ [key]: value }))],
          },
        ],
      ] as const) {
        const read = await field(schema);
        expect(read.type, label).toEqual(written.type);
        expect(read.constraints, label).toEqual(limits);
      }
    });

    it('a string, a number, an integer, a map and an object: the limits in a member, in two, or nested', async () => {
      // `rest` is what types the copy beside the list; the limits are written
      // beside the list, in one member, split over two, and one level down.
      const kinds: Array<
        [string, string[], Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]
      > = [
        ['string', ['string', 'integer'], {}, { minLength: 2 }, { maxLength: 5, pattern: '^a' }],
        ['number', ['number', 'string'], {}, { minimum: 1 }, { maximum: 9, multipleOf: 2 }],
        ['integer', ['integer', 'string'], {}, { exclusiveMinimum: 1 }, { exclusiveMaximum: 9, multipleOf: 2 }],
        ['map', ['object', 'string'], { additionalProperties: string }, { minProperties: 2 }, { maxProperties: 5 }],
        ['object', ['object', 'string'], { properties: { a: string } }, { minProperties: 2 }, { maxProperties: 5 }],
        ['array', ['array', 'string'], { items: string }, { minItems: 2 }, { maxItems: 5, uniqueItems: true }],
      ];
      const lines: string[] = [];
      for (const [kind, type, rest, first, second] of kinds) {
        const written = await parseJson(document('3.1.0', { type, ...rest, ...first, ...second }));
        lines.push(`${kind}: ${show(tags(written).type)}`);
        // One level down, the limits sit with the `items` that type the
        // array copy. An object copy's `properties` or `additionalProperties`
        // stay beside the list, where a member that is an `allOf` of limits
        // alone is read as it is beside a single `type`, so those spellings
        // are left to that reading.
        const besideList = 'properties' in rest || 'additionalProperties' in rest;
        const inner = 'items' in rest ? [rest] : [];
        for (const [label, schema] of [
          ['one member', { type, ...rest, allOf: [{ ...first, ...second }] }],
          ['two members', { type, ...rest, allOf: [first, second] }],
          ['two members, reversed', { type, ...rest, allOf: [second, first] }],
          ['one beside the list, one in a member', { type, ...rest, ...first, allOf: [second] }],
          ...(besideList
            ? []
            : ([
                ['nested', { type, allOf: [{ allOf: [...inner, first, second] }] }],
                ['one beside the inner `allOf`', { type, allOf: [{ ...first, allOf: [...inner, second] }] }],
              ] as const)),
        ] as const) {
          const read = await parseJson(document('3.1.0', schema));
          expect(tags(read).type, `${kind}, ${label}`).toEqual(tags(written).type);
          expect(tags(read).constraints, `${kind}, ${label}`).toEqual({ ...first, ...second });
          for (const variant of unionOf(tags(read).type).variants) {
            expect(limitsOf(variant), `${kind}, ${label}`).toBeUndefined();
          }
          expectNoDiff(written, read, `${kind}, ${label}`);
        }
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "string: (string | integer) {"minLength":2,"maxLength":5,"pattern":"^a"}
        number: (number | string) {"minimum":1,"maximum":9,"multipleOf":2}
        integer: (integer | string) {"exclusiveMinimum":1,"exclusiveMaximum":9,"multipleOf":2}
        map: (map<string> | string) {"minProperties":2,"maxProperties":5}
        object: (NoteTags | string) {"minProperties":2,"maxProperties":5}
        array: (array<string> | string) {"minItems":2,"maxItems":5,"uniqueItems":true}"
      `);
      expect(warn).not.toHaveBeenCalled();
    });

    it('an array keeps its items’ own limits, and a type list among them is read the same way', async () => {
      expect(
        await table([
          ['items’ limits', { type: LIST, allOf: [{ items: { type: 'string', minLength: 3 }, minItems: 2 }] }],
          [
            'a type list as the items',
            { type: LIST, allOf: [{ items: { type: LIST, allOf: [{ items: string, minItems: 3 }] }, minItems: 2 }] },
          ],
        ]),
      ).toMatchInlineSnapshot(`
        "items’ limits: (array<string {"minLength":3}> | string) {"minItems":2}
        a type list as the items: (array<(array<string> | string) {"minItems":3}> | string) {"minItems":2}"
      `);
    });

    it('a string, a number, an integer and a map, under OAS 3.0 `nullable: true` beside the list', async () => {
      // The flag is read on each copy, whose own keywords were re-read as
      // its limits: the copy's family alone, so the variant carried them.
      for (const openapi of ['3.0.3', '3.1.0']) {
        expect(
          await table(
            [
              ['string', { type: ['string', 'integer'], nullable: true, minLength: 2, maxLength: 5, pattern: '^a' }],
              ['number', { type: ['number', 'string'], nullable: true, minimum: 1, maximum: 9, multipleOf: 2 }],
              [
                'integer',
                {
                  type: ['integer', 'string'],
                  nullable: true,
                  exclusiveMinimum: 1,
                  exclusiveMaximum: 9,
                  multipleOf: 2,
                },
              ],
              [
                'map',
                {
                  type: ['object', 'string'],
                  nullable: true,
                  additionalProperties: string,
                  minProperties: 2,
                  maxProperties: 5,
                },
              ],
              ['array', { type: LIST, nullable: true, items: string, minItems: 2 }],
              ['array, one member', { type: LIST, nullable: true, allOf: [{ items: string, minItems: 2 }] }],
            ],
            {},
            openapi,
          ),
          openapi,
        ).toMatchInlineSnapshot(`
          "string: (nullable<string> | nullable<integer>) {"minLength":2,"maxLength":5,"pattern":"^a"}
          number: (nullable<number> | nullable<string>) {"minimum":1,"maximum":9,"multipleOf":2}
          integer: (nullable<integer> | nullable<string>) {"exclusiveMinimum":1,"exclusiveMaximum":9,"multipleOf":2}
          map: (nullable<map<string>> | nullable<string>) {"minProperties":2,"maxProperties":5}
          array: (nullable<array<string>> | nullable<string>) {"minItems":2}
          array, one member: (nullable<array<string>> | nullable<string>) {"minItems":2}"
        `);
      }
    });

    it('a literal: two copies typed alike but for a limit one of them read are one variant', async () => {
      // The `string` copy read the member's `minLength`, the `integer` copy
      // shed it: the literal twice, once with the limit. Beside the list the
      // two copies were the one literal, which carries the list's limits.
      expect(
        await table([
          ['const beside', { type: ['string', 'integer'], const: 'ab', minLength: 2 }],
          ['const in one member', { type: ['string', 'integer'], allOf: [{ const: 'ab', minLength: 2 }] }],
          [
            'const in one member, the list reversed',
            { type: ['integer', 'string'], allOf: [{ const: 'ab', minLength: 2 }] },
          ],
          ['const nested', { type: ['string', 'integer'], allOf: [{ allOf: [{ const: 'ab' }, { minLength: 2 }] }] }],
          ['a number', { type: ['integer', 'string'], allOf: [{ const: 4, minimum: 1 }] }],
          [
            'a third type beside them',
            { type: ['string', 'integer', 'array'], items: string, allOf: [{ const: 'ab', minLength: 2 }] },
          ],
        ]),
      ).toMatchInlineSnapshot(`
        "const beside: "ab" {"minLength":2}
        const in one member: "ab" {"minLength":2}
        const in one member, the list reversed: "ab" {"minLength":2}
        const nested: "ab" {"minLength":2}
        a number: 4 {"minimum":1}
        a third type beside them: "ab" {"minLength":2}"
      `);
    });

    it('an object: the model reference carries none, the union the list’s', async () => {
      const spec = await parseJson(
        document('3.1.0', { type: ['object', 'string'], allOf: [{ properties: { a: string }, minProperties: 2 }] }),
      );
      expect(tags(spec).type).toEqual({
        kind: 'union',
        variants: [
          { kind: 'model', name: 'NoteTags' },
          { kind: 'primitive', type: 'string' },
        ],
        constraints: { minProperties: 2 },
      });
    });

    it('a union: the one a member’s `oneOf` types the copy as carries none, its own variants theirs', async () => {
      const arrays = [{ items: string, maxItems: 3 }, { items: { type: 'integer' } }];
      expect(
        await table([
          ['a member’s oneOf beside its limit', { type: LIST, allOf: [{ oneOf: arrays, minItems: 2 }] }],
          ['the oneOf beside the list', { type: LIST, oneOf: arrays, minItems: 2 }],
          ['a member that names several types', { type: LIST, allOf: [{ type: LIST, items: string, minItems: 2 }] }],
        ]),
      ).toMatchInlineSnapshot(`
        "a member’s oneOf beside its limit: ((array<string> {"maxItems":3} | array<integer>) | string) {"minItems":2}
        the oneOf beside the list: ((array<string> {"maxItems":3} | array<integer>) | string) {"minItems":2}
        a member that names several types: (array<string> | string) {"minItems":2}"
      `);
    });
  });

  describe('a `$ref` member', () => {
    const schemas = {
      // An array component that declares no `type`: an array copy is the reference, a string copy sheds it.
      TagList: { items: string, minItems: 2 },
      TagListAlias: { allOf: [ref('TagList'), { maxItems: 5 }] },
      // Array and string components that declare their type: no other copy survives them.
      Tags: { type: 'array', items: string, minItems: 2 },
      Name: { type: 'string', minLength: 2 },
    };

    it('to an array component: the component’s limits are the union’s, as the site reads them', async () => {
      const expected = '(array<string> | string) {"minItems":2}';
      for (const [label, schema] of [
        ['one member', { type: LIST, allOf: [ref('TagList')] }],
        ['beside a `description` member', { type: LIST, allOf: [ref('TagList'), { description: 'Tags.' }] }],
        ['one level down', { type: LIST, allOf: [{ allOf: [ref('TagList')] }] }],
        ['two levels down', { type: LIST, allOf: [{ allOf: [{ allOf: [ref('TagList')] }] }] }],
        ['the list reversed', { type: ['string', 'array'], allOf: [ref('TagList')] }],
      ] as const) {
        const { type, constraints } = await field(schema, schemas);
        expect(show(type), label).toBe(
          label === 'the list reversed' ? '(string | array<string>) {"minItems":2}' : expected,
        );
        expect(constraints, label).toEqual({ minItems: 2 });
      }
      // Limits written beside the reference conjoin with the component's, on the union.
      expect(
        await table(
          [
            ['a limit member beside it', { type: LIST, allOf: [ref('TagList'), { maxItems: 5 }] }],
            ['a limit beside the list', { type: LIST, maxItems: 5, allOf: [ref('TagList')] }],
            ['through an alias', { type: LIST, allOf: [ref('TagListAlias')] }],
            ['under `null`', { type: [...LIST, 'null'], allOf: [ref('TagList')] }],
          ],
          schemas,
        ),
      ).toMatchInlineSnapshot(`
        "a limit member beside it: (array<string> | string) {"minItems":2,"maxItems":5}
        a limit beside the list: (array<string> | string) {"minItems":2,"maxItems":5}
        through an alias: (array<string> | string) {"minItems":2,"maxItems":5}
        under \`null\`: nullable<(array<string> | string) {"minItems":2}>"
      `);
      expect(warn).not.toHaveBeenCalled();
    });

    it('to a component of limits alone: every spelling of the members agrees, the union carrying them', async () => {
      const limits = { Limits: { minItems: 2 }, StrLimits: { minLength: 2 } };
      for (const [label, expected, spellings] of [
        [
          'beside `items`',
          { minItems: 2 },
          [
            { type: LIST, items: string, allOf: [ref('Limits')] },
            { type: LIST, allOf: [{ items: string }, ref('Limits')] },
            { type: LIST, allOf: [ref('Limits'), { items: string }] },
            { type: LIST, allOf: [{ allOf: [{ items: string }, ref('Limits')] }] },
            { type: LIST, items: string, allOf: [{ allOf: [ref('Limits')] }] },
          ],
        ],
        [
          'beside primitives',
          { minLength: 2 },
          [
            { type: ['string', 'integer'], allOf: [ref('StrLimits')] },
            { type: ['string', 'integer'], allOf: [{ allOf: [ref('StrLimits')] }] },
            { type: ['string', 'integer'], allOf: [ref('StrLimits'), { description: 'A tag.' }] },
          ],
        ],
      ] as const) {
        const written = await parseJson(document('3.1.0', spellings[0], limits));
        for (const schema of spellings) {
          const read = await parseJson(document('3.1.0', schema, limits));
          expect(show(tags(read).type), `${label}: ${JSON.stringify(schema)}`).toBe(show(tags(written).type));
          expect(tags(read).constraints, label).toEqual(expected);
          expect(unionOf(tags(read).type).constraints, label).toEqual(expected);
          for (const variant of unionOf(tags(read).type).variants) expect(limitsOf(variant), label).toBeUndefined();
          expectNoDiff(written, read, `${label}: ${JSON.stringify(schema)}`);
        }
      }
    });

    it('to a component that declares its type: the list is that one type, which carries the limits as before', async () => {
      expect(
        await table(
          [
            ['an array component', { type: LIST, allOf: [ref('Tags')] }],
            ['an array component, nested', { type: LIST, allOf: [{ allOf: [ref('Tags')] }] }],
            ['an array component beside a limit', { type: LIST, allOf: [ref('Tags'), { maxItems: 5 }] }],
            ['a string component', { type: ['string', 'integer'], allOf: [ref('Name')] }],
            ['a string component under `null`', { type: ['string', 'integer', 'null'], allOf: [ref('Name')] }],
            ['a typed member', { type: LIST, allOf: [{ type: 'array', items: string, minItems: 2 }] }],
          ],
          schemas,
        ),
      ).toMatchInlineSnapshot(`
        "an array component: array<string> {"minItems":2}
        an array component, nested: array<string> {"minItems":2}
        an array component beside a limit: array<string> {"minItems":2,"maxItems":5}
        a string component: string {"minLength":2}
        a string component under \`null\`: nullable<string {"minLength":2}>
        a typed member: array<string> {"minItems":2}"
      `);
      expect(warn).not.toHaveBeenCalled();
    });

    it('to a schema deeper in a component: what the member writes beside the pointer is the union’s', async () => {
      const Pet = { type: 'object', properties: { tags: { items: string } } };
      const pointer = { $ref: '#/components/schemas/Pet/properties/tags', maxItems: 5 };
      const { type, constraints } = await field({ type: LIST, allOf: [pointer] }, { Pet });
      expect(show(type)).toBe('(array<string> | string) {"maxItems":5}');
      expect(constraints).toEqual({ maxItems: 5 });
    });
  });

  describe('a component one copy alone references', () => {
    // The union reads the limits of an array or primitive component its
    // schema references. Where only a per-type copy reaches the component,
    // the whole was no such reference: the limits sat on the variant alone,
    // and the union and the field carried none.
    const schemas = {
      TagList: { items: string, minItems: 2 },
      Tags: { type: 'array', items: string, minItems: 2 },
      Owner: { properties: { name: string } },
      StrLimits: { minLength: 2 },
    };

    it('gives its limits to the union and the field, and none to the variant', async () => {
      const lines: string[] = [];
      for (const [label, schema] of [
        ['a nullable oneOf around the `$ref`', { type: LIST, oneOf: [ref('TagList'), { type: 'null' }] }],
        ['the same in an `allOf` member', { type: LIST, allOf: [{ oneOf: [ref('TagList'), { type: 'null' }] }] }],
        ['a limit beside the `$ref`', { type: LIST, oneOf: [{ ...ref('TagList'), maxItems: 5 }, { type: 'null' }] }],
        ['a limit beside the list', { type: LIST, maxItems: 5, anyOf: [ref('TagList'), { type: 'null' }] }],
        [
          '`properties` beside the `allOf`',
          { type: ['array', 'object'], properties: { a: string }, allOf: [ref('TagList')] },
        ],
        ['a list the `$ref` narrows to one type', { type: LIST, anyOf: [ref('Tags'), { type: 'null' }] }],
      ] as const) {
        const { type, constraints } = await field(schema, schemas);
        lines.push(`${label}: ${show(type)} / ${JSON.stringify(constraints)}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a nullable oneOf around the \`$ref\`: (nullable<array<string>> | string) {"minItems":2} / {"minItems":2}
        the same in an \`allOf\` member: (nullable<array<string>> | string) {"minItems":2} / {"minItems":2}
        a limit beside the \`$ref\`: (nullable<array<string>> | string) {"minItems":2,"maxItems":5} / {"minItems":2,"maxItems":5}
        a limit beside the list: (nullable<array<string>> | string) {"maxItems":5,"minItems":2} / {"maxItems":5,"minItems":2}
        \`properties\` beside the \`allOf\`: (array<string> | NoteTags) {"minItems":2} / {"minItems":2}
        a list the \`$ref\` narrows to one type: nullable<array<string> {"minItems":2}> / {"minItems":2}"
      `);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads the nullable wrapper beside the list as the one in an `allOf` member: `oagen diff` reports nothing', async () => {
      const wrapper = { oneOf: [ref('TagList'), { type: 'null' }] };
      const besideList = await parseJson(document('3.1.0', { type: LIST, ...wrapper }, schemas));
      const inMember = await parseJson(document('3.1.0', { type: LIST, allOf: [wrapper] }, schemas));
      expect(tags(besideList)).toEqual(tags(inMember));
      expectNoDiff(besideList, inMember, 'beside the list -> in a member');
    });

    it('reads a parameter as the field: its limits equal its type’s', async () => {
      const schema = { type: LIST, oneOf: [ref('TagList'), { type: 'null' }] };
      const doc = document('3.1.0', schema, schemas);
      (doc.paths['/notes'].post as Record<string, unknown>).parameters = [{ name: 'filter', in: 'query', schema }];
      const spec = await parseJson(doc);
      const [parameter] = spec.services.flatMap(({ operations }) => operations)[0]!.queryParams;
      expect(`${show(parameter!.type)} / ${JSON.stringify(parameter!.constraints)}`).toBe(
        '(nullable<array<string>> | string) {"minItems":2} / {"minItems":2}',
      );
    });

    it('leaves what a primitive copy reads through a `$ref` member the component’s own, with or without the OAS 3.0 flag', async () => {
      // The `string` copy reads `Named` in the member's place; the list as
      // a whole is the merge of the two components, which carries none.
      const merge = { ...schemas, Named: { properties: { label: string }, minLength: 2 } };
      expect(
        await table(
          [
            ['merged', { type: ['object', 'string'], allOf: [ref('Owner'), ref('Named')] }],
            ['merged, nullable', { type: ['object', 'string'], nullable: true, allOf: [ref('Owner'), ref('Named')] }],
          ],
          merge,
        ),
      ).toMatchInlineSnapshot(`
        "merged: (NoteTags | string)
        merged, nullable: (nullable<NoteTags> | nullable<string>)"
      `);
      // A `$ref` to a component of limits alone is no second `$ref`, and
      // the list no merge (#731: it was `(NoteTags | string)`, a copy of
      // `Owner`, the limit read by the `string` copy alone): `StrLimits`
      // is read as the limit written in its place, so the `object` copy is
      // the reference to `Owner` and the union carries the limit, as the
      // same limit written as the member gives.
      expect(
        await table(
          [
            ['a `$ref` to limits', { type: ['object', 'string'], allOf: [ref('Owner'), ref('StrLimits')] }],
            ['the limits inline', { type: ['object', 'string'], allOf: [ref('Owner'), { minLength: 2 }] }],
            [
              'a `$ref` to limits, nullable',
              { type: ['object', 'string'], nullable: true, allOf: [ref('Owner'), ref('StrLimits')] },
            ],
            [
              'the limits inline, nullable',
              { type: ['object', 'string'], nullable: true, allOf: [ref('Owner'), { minLength: 2 }] },
            ],
          ],
          schemas,
        ),
      ).toMatchInlineSnapshot(`
        "a \`$ref\` to limits: (Owner | string) {"minLength":2}
        the limits inline: (Owner | string) {"minLength":2}
        a \`$ref\` to limits, nullable: (nullable<Owner> | nullable<string>) {"minLength":2}
        the limits inline, nullable: (nullable<Owner> | nullable<string>) {"minLength":2}"
      `);
    });
  });

  describe('a nullable wrapper beside the list', () => {
    it('reads the one branch’s limits as the union’s, not the nullable variant’s', async () => {
      expect(
        await table([
          ['oneOf', { type: LIST, oneOf: [{ items: string, minItems: 2 }, { type: 'null' }] }],
          ['anyOf', { type: LIST, anyOf: [{ items: string, minItems: 2 }, { type: 'null' }] }],
          ['oneOf, `null` first', { type: LIST, oneOf: [{ const: null }, { items: string, minItems: 2 }] }],
          ['the limit beside the list', { type: LIST, minItems: 2, oneOf: [{ items: string }, { type: 'null' }] }],
          ['in a member', { type: LIST, allOf: [{ oneOf: [{ items: string, minItems: 2 }, { type: 'null' }] }] }],
        ]),
      ).toMatchInlineSnapshot(`
        "oneOf: (nullable<array<string>> | string) {"minItems":2}
        anyOf: (nullable<array<string>> | string) {"minItems":2}
        oneOf, \`null\` first: (nullable<array<string>> | string) {"minItems":2}
        the limit beside the list: (nullable<array<string>> | string) {"minItems":2}
        in a member: (nullable<array<string>> | string) {"minItems":2}"
      `);
    });
  });

  describe('every site', () => {
    /** One operation and one model writing `schema()` at every site a schema is typed at. */
    const sites = (openapi: string, schema: () => unknown) => ({
      openapi,
      info: { title: 'repro', version: '1' },
      paths: {
        '/notes/{id}': {
          put: {
            operationId: 'putNote',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: string },
              { name: 'tags', in: 'query', schema: schema() },
              { name: 'X-Tags', in: 'header', schema: schema() },
              { name: 'tags_cookie', in: 'cookie', schema: schema() },
            ],
            requestBody: { content: { 'application/json': { schema: schema() } } },
            responses: {
              '200': {
                description: 'ok',
                headers: { 'X-Tags': { schema: schema() } },
                content: { 'application/json': { schema: schema() } },
              },
              '201': { description: 'created', content: { 'application/json': { schema: schema() } } },
              '400': { description: 'bad', content: { 'application/json': { schema: schema() } } },
            },
          },
        },
      },
      ...(openapi.startsWith('3.1') && {
        webhooks: {
          noteTagged: {
            post: {
              operationId: 'noteTagged',
              requestBody: { content: { 'application/json': { schema: schema() } } },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      }),
      components: {
        schemas: {
          Note: {
            type: 'object',
            properties: {
              tags: schema(),
              lists: { type: 'array', items: schema() },
              by_name: { type: 'object', additionalProperties: schema() },
              either: { oneOf: [schema(), { type: 'boolean' }] },
              maybe: { anyOf: [schema(), { type: 'null' }] },
              both: { allOf: [schema(), { description: 'Tags.' }] },
            },
          },
        },
      },
    });
    const summary = (spec: ApiSpec) => {
      const [operation] = spec.services.flatMap(({ operations }) => operations);
      return [
        ...[...operation!.queryParams, ...operation!.headerParams, ...(operation!.cookieParams ?? [])].map(
          ({ name, type, constraints }) => `${name}: ${show(type)} / ${JSON.stringify(constraints)}`,
        ),
        `requestBody: ${show(operation!.requestBody!)}`,
        `response: ${show(operation!.response)}`,
        ...(operation!.successResponses ?? []).map(({ statusCode, type }) => `${statusCode}: ${show(type)}`),
        ...operation!.errors.map(({ statusCode, type }) => `${statusCode}: ${show(type!)}`),
        ...(operation!.responseHeaders ?? []).map(({ name, type }) => `response ${name}: ${show(type)}`),
        ...(spec.webhooks ?? []).map(({ name, requestBody }) => `webhook ${name}: ${show(requestBody!)}`),
        ...spec.models
          .find(({ name }) => name === 'Note')!
          .fields.map(({ name, type, constraints }) => `${name}: ${show(type)} / ${JSON.stringify(constraints)}`),
        `models: ${spec.models.map(({ name }) => name).join(', ')}`,
      ].join('\n');
    };

    it.each(['3.0.3', '3.1.0'])(
      'types a field, items, values, a variant, a parameter, a header and a body as the limit beside the list does, under OAS %s',
      async (openapi) => {
        for (const type of [LIST, [...LIST, 'null']]) {
          const written = await parseJson(sites(openapi, () => beside(type)));
          for (const spelling of [
            two(type),
            one(type),
            nested(type),
            { type, allOf: [{ allOf: [one(type).allOf[0]] }] },
          ]) {
            const read = await parseJson(sites(openapi, () => spelling));
            expect(summary(read), JSON.stringify(spelling)).toBe(summary(written));
            expectNoDiff(written, read, JSON.stringify(spelling));
          }
          if (openapi === '3.1.0' && type === LIST) {
            expect(summary(written)).toMatchInlineSnapshot(`
              "tags: (array<string> | string) {"minItems":2} / {"minItems":2}
              X-Tags: (array<string> | string) {"minItems":2} / {"minItems":2}
              tags_cookie: (array<string> | string) {"minItems":2} / {"minItems":2}
              requestBody: (array<string> | string) {"minItems":2}
              response: (array<string> | string) {"minItems":2}
              200: (array<string> | string) {"minItems":2}
              201: (array<string> | string) {"minItems":2}
              400: (array<string> | string) {"minItems":2}
              response X-Tags: (array<string> | string) {"minItems":2}
              webhook noteTagged: (array<string> | string) {"minItems":2}
              tags: (array<string> | string) {"minItems":2} / {"minItems":2}
              lists: array<(array<string> | string) {"minItems":2}> / undefined
              by_name: map<(array<string> | string) {"minItems":2}> / undefined
              either: ((array<string> | string) {"minItems":2} | boolean) / undefined
              maybe: nullable<(array<string> | string) {"minItems":2}> / {"minItems":2}
              both: (array<string> | string) {"minItems":2} / {"minItems":2}
              models: Note"
            `);
          }
          if (openapi === '3.0.3' && type !== LIST) {
            expect(summary(written)).toMatchInlineSnapshot(`
              "tags: nullable<(array<string> | string) {"minItems":2}> / {"minItems":2}
              X-Tags: nullable<(array<string> | string) {"minItems":2}> / {"minItems":2}
              tags_cookie: nullable<(array<string> | string) {"minItems":2}> / {"minItems":2}
              requestBody: nullable<(array<string> | string) {"minItems":2}>
              response: nullable<(array<string> | string) {"minItems":2}>
              200: nullable<(array<string> | string) {"minItems":2}>
              201: nullable<(array<string> | string) {"minItems":2}>
              400: nullable<(array<string> | string) {"minItems":2}>
              response X-Tags: nullable<(array<string> | string) {"minItems":2}>
              tags: nullable<(array<string> | string) {"minItems":2}> / {"minItems":2}
              lists: array<nullable<(array<string> | string) {"minItems":2}>> / undefined
              by_name: map<nullable<(array<string> | string) {"minItems":2}>> / undefined
              either: (nullable<(array<string> | string) {"minItems":2}> | boolean) / undefined
              maybe: nullable<(array<string> | string) {"minItems":2}> / {"minItems":2}
              both: nullable<(array<string> | string) {"minItems":2}> / {"minItems":2}
              models: Note"
            `);
          }
        }
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('types a multi-type inline variant of a `oneOf` the same way, inline and on a named union', async () => {
      // The variant's other members are built from the same copies
      // (`inlineVariantTypeRef`), and its limits are the union's it is typed as.
      const variant = (rest: Record<string, unknown>) => ({
        type: ['object', 'array'],
        properties: { a: string },
        ...rest,
      });
      const spellings: Array<[string, Record<string, unknown>]> = [
        ['beside', { items: string, minItems: 2 }],
        ['two members', { allOf: [{ items: string }, { minItems: 2 }] }],
        ['one member', { allOf: [{ items: string, minItems: 2 }] }],
        ['nested', { allOf: [{ allOf: [{ items: string }, { minItems: 2 }] }] }],
      ];
      const lines: string[] = [];
      const parsed: ApiSpec[] = [];
      for (const [label, rest] of spellings) {
        const union = { oneOf: [variant(rest), { type: 'boolean' }] };
        const spec = await parseJson(document('3.1.0', union, { Shape: union }));
        parsed.push(spec);
        const shape = spec.models.find(({ name }) => name === 'Shape')!;
        lines.push(`${label}: ${show(tags(spec).type)} / Shape: ${show(shape.variants![0]!)}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "beside: ((NoteTags | array<string>) {"minItems":2} | boolean) / Shape: (ShapeWithA | array<string>) {"minItems":2}
        two members: ((NoteTags | array<string>) {"minItems":2} | boolean) / Shape: (ShapeWithA | array<string>) {"minItems":2}
        one member: ((NoteTags | array<string>) {"minItems":2} | boolean) / Shape: (ShapeWithA | array<string>) {"minItems":2}
        nested: ((NoteTags | array<string>) {"minItems":2} | boolean) / Shape: (ShapeWithA | array<string>) {"minItems":2}"
      `);
      for (const spec of parsed) expectNoDiff(parsed[0]!, spec, 'inline variant');
      // A nullable wrapper's branch inside the variant is read the same way.
      expect(
        await typed({
          oneOf: [variant({ oneOf: [{ items: string, minItems: 2 }, { type: 'null' }] }), { type: 'boolean' }],
        }),
      ).toMatchInlineSnapshot(`"((NoteTags | nullable<array<string>>) {"minItems":2} | boolean)"`);
    });
  });

  describe('a component that is the type list', () => {
    it.each(['3.0.3', '3.1.0'])(
      'written through an `allOf` is typed where a `$ref` names it as the list written in place is, under OAS %s',
      async (openapi) => {
        // The limit in two members types the component in place; in one member,
        // or nested, the array variant carried it too.
        for (const type of [LIST, [...LIST, 'null']]) {
          const named = async (schema: unknown) => {
            const spec = await parseJson(document(openapi, ref('TagsOrTag'), { TagsOrTag: schema }));
            return { spec, line: `${show(tags(spec).type)} / ${JSON.stringify(tags(spec).constraints)}` };
          };
          const written = await named(two(type));
          expect(written.line).toBe(
            type === LIST
              ? '(array<string> | string) {"minItems":2} / {"minItems":2}'
              : 'nullable<(array<string> | string) {"minItems":2}> / {"minItems":2}',
          );
          for (const spelling of [one(type), nested(type), { type, allOf: [{ allOf: [one(type).allOf[0]] }] }]) {
            const read = await named(spelling);
            expect(read.line, JSON.stringify(spelling)).toBe(written.line);
            expectNoDiff(written.spec, read.spec, JSON.stringify(spelling));
          }
        }
        expect(warn).not.toHaveBeenCalled();
      },
    );
  });

  describe('a component that is the type list, with `items` beside the list', () => {
    // Not this issue, and as it was: what a component is read as is decided
    // from its own schema. A type list naming `array` with `items` beside it
    // is neither an array component nor a primitive one, so it is the
    // fieldless model it always became, where the same list written through
    // an `allOf` is an array component, typed in place (MichaelDeBoey, #721
    // review: the docs showed the four spellings as named schemas and said
    // `oagen diff` between any two reports nothing, which holds where the
    // list is written, not for a component).
    it.each(['3.0.3', '3.1.0'])(
      'is the fieldless model `Tags`, so `oagen diff` to the other three spellings reports the model removed, under OAS %s',
      async (openapi) => {
        const parsed: Record<string, ApiSpec> = {};
        for (const [file, schema] of Object.entries(ISSUE)) {
          parsed[file] = await parseJson(document(openapi, ref('Tags'), { Tags: schema() }));
        }

        // `Tags` written as `beside`: a model of no fields and no variants,
        // the list's limits its own; the field a reference to it.
        expect(parsed['beside.json']!.models).toEqual([
          { name: 'Note', fields: [{ name: 'tags', type: { kind: 'model', name: 'Tags' }, required: false }] },
          { name: 'Tags', fields: [], constraints: { minItems: 2 } },
        ]);
        // Written as `two`, `one` or `nested`: no `Tags` model, the field typed in place.
        for (const file of ['two.json', 'one.json', 'nested.json']) {
          expect(parsed[file]!.models, file).toEqual([
            {
              name: 'Note',
              fields: [
                {
                  name: 'tags',
                  type: {
                    kind: 'union',
                    variants: [
                      { kind: 'array', items: { kind: 'primitive', type: 'string' } },
                      { kind: 'primitive', type: 'string' },
                    ],
                    constraints: { minItems: 2 },
                  },
                  required: false,
                  constraints: { minItems: 2 },
                },
              ],
            },
          ]);
        }

        const changes = (from: string, to: string) =>
          diffSpecs(parsed[from]!, parsed[to]!).changes.map((change) =>
            'name' in change ? `${change.kind} ${change.name}` : change.kind,
          );
        const lines: string[] = [];
        for (const from of Object.keys(parsed)) {
          for (const to of Object.keys(parsed)) {
            if (from !== to) lines.push(`${from} -> ${to}: ${changes(from, to).join(', ') || 'nothing'}`);
          }
        }
        expect(lines.join('\n')).toBe(
          [
            'beside.json -> two.json: model-removed Tags, model-modified Note',
            'beside.json -> one.json: model-removed Tags, model-modified Note',
            'beside.json -> nested.json: model-removed Tags, model-modified Note',
            'two.json -> beside.json: model-added Tags, model-modified Note',
            'two.json -> one.json: nothing',
            'two.json -> nested.json: nothing',
            'one.json -> beside.json: model-added Tags, model-modified Note',
            'one.json -> two.json: nothing',
            'one.json -> nested.json: nothing',
            'nested.json -> beside.json: model-added Tags, model-modified Note',
            'nested.json -> two.json: nothing',
            'nested.json -> one.json: nothing',
          ].join('\n'),
        );
      },
    );
  });

  describe('what must not change', () => {
    it('a single type keeps its `allOf` member’s limits as its own: there is no union to carry them', async () => {
      expect(
        await table([
          ['array', { type: 'array', allOf: [{ items: string, minItems: 2 }] }],
          ['array, nested', { type: 'array', allOf: [{ allOf: [{ items: string }, { minItems: 2 }] }] }],
          ['array or null', { type: ['array', 'null'], allOf: [{ items: string, minItems: 2 }] }],
          ['array, OAS 3.0 nullable', { type: 'array', nullable: true, allOf: [{ items: string, minItems: 2 }] }],
          ['a list of one type', { type: ['array'], allOf: [{ items: string, minItems: 2 }] }],
          ['no type', { allOf: [{ type: 'array', items: string, minItems: 2 }] }],
          ['string', { type: 'string', allOf: [{ format: 'date', minLength: 2 }] }],
          ['string or null, a const member', { type: ['string', 'null'], allOf: [{ const: 'ab', minLength: 2 }] }],
        ]),
      ).toMatchInlineSnapshot(`
        "array: array<string> {"minItems":2}
        array, nested: array<string> {"minItems":2}
        array or null: nullable<array<string> {"minItems":2}>
        array, OAS 3.0 nullable: nullable<array<string> {"minItems":2}>
        a list of one type: array<string> {"minItems":2}
        no type: array<string> {"minItems":2}
        string: string {"minLength":2}
        string or null, a const member: nullable<"ab" {"minLength":2}>"
      `);
      const single = await field({ type: 'array', allOf: [{ items: string, minItems: 2 }] });
      expect(single.constraints).toEqual({ minItems: 2 });
    });

    it('a `oneOf`/`anyOf` variant keeps its own limits, beside a type list and as a copy’s own union', async () => {
      expect(
        await table([
          ['a oneOf of the two', { oneOf: [{ type: 'array', items: string, minItems: 2 }, string] }],
          ['a oneOf of one variant', { oneOf: [{ type: 'array', items: string, minItems: 2 }] }],
          [
            'a oneOf beside the list',
            {
              type: LIST,
              oneOf: [
                { items: string, minItems: 2 },
                { items: { type: 'integer' }, maxItems: 3 },
              ],
            },
          ],
          ['a oneOf of one variant beside the list', { type: LIST, oneOf: [{ items: string, minItems: 2 }] }],
        ]),
      ).toMatchInlineSnapshot(`
        "a oneOf of the two: (array<string> {"minItems":2} | string)
        a oneOf of one variant: (array<string> {"minItems":2}) {"minItems":2}
        a oneOf beside the list: ((array<string> {"minItems":2} | array<integer> {"maxItems":3}) | string)
        a oneOf of one variant beside the list: ((array<string> {"minItems":2}) | string) {"minItems":2}"
      `);
    });

    it('a list a member narrows to one type is that type, built as before', async () => {
      const schemas = { Tags: { type: 'array', items: string, minItems: 2 } };
      for (const [label, schema, expected] of [
        [
          'a typed member',
          { type: LIST, allOf: [{ type: 'array', items: string, minItems: 2 }] },
          'array<string> {"minItems":2}',
        ],
        ['a `$ref` member', { type: LIST, allOf: [ref('Tags')] }, 'array<string> {"minItems":2}'],
        // `properties` beside the list say nothing of an array.
        [
          '`properties` beside the list',
          { type: LIST, properties: { a: string }, allOf: [ref('Tags')] },
          'array<string> {"minItems":2}',
        ],
        ['under `null`', { type: [...LIST, 'null'], allOf: [ref('Tags')] }, 'nullable<array<string> {"minItems":2}>'],
      ] as const) {
        const { type, constraints } = await field(schema, schemas);
        expect(show(type), label).toBe(expected);
        expect(constraints, label).toEqual({ minItems: 2 });
      }
    });
  });
});
