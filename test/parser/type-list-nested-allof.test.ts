import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { typesAsUnknown } from '../../src/parser/schemas.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Field, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #674: a primitive copy of a type list kept of its `allOf` the
 * members that say something about its type alone (#616 review), one level
 * deep. A member that was itself an `allOf` stayed whole when any of its
 * own members applied, so `{ type: ['object', 'string'], allOf: [{ allOf:
 * [{ $ref: Owner }, { minLength: 1 }] }] }` kept the `$ref` on the `string`
 * copy, which typed it `Owner`: the `string` was lost, though `allOf: [{
 * allOf: [A, B] }]` says what `allOf: [A, B]` says. The copy now reads each
 * member at any depth, an inline member's own keywords as its own are read
 * and a `$ref` by what its component says (`allOfMemberReadAs`).
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
const owner = ref('Owner');
const min = { minLength: 1 };
/** `Owner: { name: string }` with no `type`, as the issue writes it. */
const untypedOwner = { properties: { name: string } };
/** The two members written flat in the type list's `allOf`. */
const flat = (type: string[]) => ({ type, allOf: [owner, min] });
/** The same two members `depth` levels down, each level an `allOf` of its own with `beside` written beside it. */
const nested = (type: string[], depth = 1, beside: Record<string, unknown> = {}) => {
  let members: unknown[] = [owner, min];
  for (let level = 0; level < depth; level++) members = [{ ...beside, allOf: members }];
  return { type, allOf: members };
};

/** The issue's document: `GET /notes/{id}` (`getNote`) returning `$ref: Note`, `Owner` untyped, `Note.author` as given. */
function document(openapi: string, author: unknown, schemas: Record<string, unknown> = {}) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/notes/{id}': {
        get: {
          operationId: 'getNote',
          parameters: [{ name: 'id', in: 'path', required: true, schema: string }],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('Note') } } } },
        },
      },
    },
    components: {
      schemas: { Owner: untypedOwner, Note: { type: 'object', properties: { author } }, ...schemas },
    },
  };
}

/** A type as the issue's script prints it. */
const issueShow = (type: TypeRef): string =>
  type.kind === 'union'
    ? type.variants.map(issueShow).join(' | ')
    : ((type as { name?: string; type?: string }).name ?? (type as { type?: string }).type ?? type.kind);

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

describe('#674 a type list’s primitive copy reads its `allOf` at any depth', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-type-list-nested-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  let specs = 0;
  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, `spec-${specs++}.json`);
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  const fieldOf = (spec: ApiSpec, model: string, field: string): Field =>
    spec.models.find(({ name }) => name === model)!.fields.find(({ name }) => name === field)!;
  const author = (spec: ApiSpec): Field => fieldOf(spec, 'Note', 'author');
  const modelNames = (spec: ApiSpec) => spec.models.map(({ name }) => name);
  /** `Note.author` written as `schema`, as `show` prints its type. */
  const typed = async (schema: unknown, schemas?: Record<string, unknown>, openapi = '3.1.0'): Promise<string> =>
    show(author(await parseJson(document(openapi, schema, schemas))).type);
  /** Each `[label, schema]` typed, one `label: type` per line. */
  const table = async (
    rows: ReadonlyArray<readonly [string, unknown]>,
    schemas?: Record<string, unknown>,
  ): Promise<string> => {
    const lines: string[] = [];
    for (const [label, schema] of rows) lines.push(`${label}: ${await typed(schema, schemas)}`);
    return lines.join('\n');
  };

  it.each(['3.0.3', '3.1.0'])(
    'types the issue’s four documents as the flat spellings are: `Owner | string` and `string | integer` (the repro), under OAS %s',
    async (openapi) => {
      const documents = {
        'flat.json': flat(['object', 'string']),
        'nested.json': nested(['object', 'string']),
        'flat-int.json': flat(['string', 'integer']),
        'nested-int.json': nested(['string', 'integer']),
      };
      const lines: string[] = [];
      const parsed: Record<string, ApiSpec> = {};
      for (const [file, schema] of Object.entries(documents)) {
        parsed[file] = await parseJson(document(openapi, schema));
        lines.push(`${file} ${issueShow(author(parsed[file]!).type)}`);
        expect(modelNames(parsed[file]!), file).toEqual(['Owner', 'Note']);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "flat.json Owner | string
        nested.json Owner | string
        flat-int.json string | integer
        nested-int.json string | integer"
      `);
      // The whole type, the limit the union carries included.
      expect(author(parsed['nested.json']!).type).toEqual(author(parsed['flat.json']!).type);
      expect(author(parsed['nested.json']!).type).toEqual({
        kind: 'union',
        variants: [
          { kind: 'model', name: 'Owner' },
          { kind: 'primitive', type: 'string' },
        ],
        constraints: { minLength: 1 },
      });
      expect(author(parsed['nested-int.json']!).type).toEqual(author(parsed['flat-int.json']!).type);
      // "With nothing printed before it".
      expect(warn).not.toHaveBeenCalled();

      // `oagen diff` between the spellings, both directions: nothing moved (exit 0).
      for (const [from, to] of [
        ['flat.json', 'nested.json'],
        ['nested.json', 'flat.json'],
        ['flat-int.json', 'nested-int.json'],
        ['nested-int.json', 'flat-int.json'],
      ] as const) {
        const diff = diffSpecs(parsed[from]!, parsed[to]!);
        expect(diff.changes, `${from} -> ${to}`).toEqual([]);
        expect(diff.summary.breaking, `${from} -> ${to}`).toBe(0);
      }
    },
  );

  it.each(['3.0.3', '3.1.0'])(
    'types a request body, a response body and every parameter as the flat spelling does, under OAS %s',
    async (openapi) => {
      const sites = (schema: () => unknown) => ({
        openapi,
        info: { title: 'repro', version: '1' },
        paths: {
          '/notes/{id}': {
            put: {
              operationId: 'putNote',
              parameters: [
                { name: 'id', in: 'path', required: true, schema: string },
                { name: 'author', in: 'query', schema: schema() },
                { name: 'X-Author', in: 'header', schema: schema() },
                { name: 'author_cookie', in: 'cookie', schema: schema() },
              ],
              requestBody: { content: { 'application/json': { schema: schema() } } },
              responses: {
                '200': {
                  description: 'ok',
                  headers: { 'X-Author': { schema: schema() } },
                  content: { 'application/json': { schema: schema() } },
                },
                '201': { description: 'created', content: { 'application/json': { schema: schema() } } },
                '400': { description: 'bad', content: { 'application/json': { schema: schema() } } },
              },
            },
          },
        },
        components: {
          schemas: {
            Owner: untypedOwner,
            Note: {
              type: 'object',
              properties: {
                authors: { type: 'array', items: schema() },
                by_name: { type: 'object', additionalProperties: schema() },
                either: { oneOf: [schema(), { type: 'boolean' }] },
                maybe: { anyOf: [schema(), { type: 'null' }] },
                variant: { oneOf: [{ ...(schema() as object), properties: { kind: string } }, { type: 'boolean' }] },
              },
            },
          },
        },
      });
      const summary = (spec: ApiSpec) => {
        const [operation] = spec.services.flatMap(({ operations }) => operations);
        const lines = [
          ...[...operation!.queryParams, ...operation!.headerParams, ...(operation!.cookieParams ?? [])].map(
            ({ name, type }) => `${name}: ${show(type)}`,
          ),
          `requestBody: ${show(operation!.requestBody!)}`,
          `response: ${show(operation!.response)}`,
          ...(operation!.successResponses ?? []).map(({ statusCode, type }) => `${statusCode}: ${show(type)}`),
          ...operation!.errors.map(({ statusCode, type }) => `${statusCode}: ${show(type!)}`),
          ...(operation!.responseHeaders ?? []).map(({ name, type }) => `response ${name}: ${show(type)}`),
          ...spec.models.find(({ name }) => name === 'Note')!.fields.map(({ name, type }) => `${name}: ${show(type)}`),
          `models: ${modelNames(spec).join(', ')}`,
        ];
        return lines.join('\n');
      };

      for (const type of [
        ['object', 'string'],
        ['string', 'integer'],
      ]) {
        const written = await parseJson(sites(() => flat(type)));
        for (const spelling of [nested(type), nested(type, 2), nested(type, 3, { description: 'Who wrote it.' })]) {
          const read = await parseJson(sites(() => spelling));
          expect(summary(read), JSON.stringify(spelling)).toBe(summary(written));
          expect(diffSpecs(written, read).changes, JSON.stringify(spelling)).toEqual([]);
          expect(diffSpecs(read, written).changes, JSON.stringify(spelling)).toEqual([]);
        }
        if (type.includes('object')) {
          expect(summary(written)).toMatchInlineSnapshot(`
            "author: (Owner | string) {"minLength":1}
            X-Author: (Owner | string) {"minLength":1}
            author_cookie: (Owner | string) {"minLength":1}
            requestBody: (Owner | string) {"minLength":1}
            response: (Owner | string) {"minLength":1}
            200: (Owner | string) {"minLength":1}
            201: (Owner | string) {"minLength":1}
            400: (Owner | string) {"minLength":1}
            response X-Author: (Owner | string) {"minLength":1}
            authors: array<(Owner | string) {"minLength":1}>
            by_name: map<(Owner | string) {"minLength":1}>
            either: ((Owner | string) {"minLength":1} | boolean)
            maybe: nullable<(Owner | string) {"minLength":1}>
            variant: ((NoteVariant | string) {"minLength":1} | boolean)
            models: Owner, Note, NoteVariant"
          `);
        } else {
          expect(summary(written)).toMatchInlineSnapshot(`
            "author: (string | integer) {"minLength":1}
            X-Author: (string | integer) {"minLength":1}
            author_cookie: (string | integer) {"minLength":1}
            requestBody: (string | integer) {"minLength":1}
            response: (string | integer) {"minLength":1}
            200: (string | integer) {"minLength":1}
            201: (string | integer) {"minLength":1}
            400: (string | integer) {"minLength":1}
            response X-Author: (string | integer) {"minLength":1}
            authors: array<(string | integer) {"minLength":1}>
            by_name: map<(string | integer) {"minLength":1}>
            either: ((string | integer) {"minLength":1} | boolean)
            maybe: nullable<(string | integer) {"minLength":1}>
            variant: ((string | integer) {"minLength":1} | boolean)
            models: Owner, Note"
          `);
        }
      }
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    [['object', 'string'], '(Owner | string) {"minLength":1}'],
    [['string', 'object'], '(string | Owner) {"minLength":1}'],
    [['string', 'integer'], '(string | integer) {"minLength":1}'],
    [['integer', 'string'], '(integer | string) {"minLength":1}'],
    [['object', 'string', 'null'], 'nullable<(Owner | string) {"minLength":1}>'],
    [['object', 'string', 'integer'], '(Owner | string | integer) {"minLength":1}'],
    [['string', 'integer', 'null'], 'nullable<(string | integer) {"minLength":1}>'],
    [['object', 'boolean'], '(Owner | boolean) {"minLength":1}'],
    [['string', 'boolean', 'number'], '(string | boolean | number) {"minLength":1}'],
  ])('reads the list %j as %s in every spelling of the two members', async (type, expected) => {
    const spellings: Array<[string, unknown]> = [
      ['flat', flat(type)],
      ['one level down', nested(type)],
      ['two levels down', nested(type, 2)],
      ['three levels down', nested(type, 3)],
      ['a `description` beside each inner `allOf`', nested(type, 2, { description: 'Who wrote it.' })],
      ['a `title` beside the inner `allOf`', nested(type, 1, { title: 'Author' })],
      ['an `x-*` key beside the inner `allOf`', nested(type, 1, { 'x-note': 'internal' })],
      ['`required` beside the inner `allOf`', { type, allOf: [{ allOf: [owner, min] }], required: ['name'] }],
      ['the `$ref` wrapped, the limit flat', { type, allOf: [{ allOf: [owner] }, min] }],
      ['the `$ref` flat, the limit wrapped', { type, allOf: [owner, { allOf: [min] }] }],
      ['the limit beside the inner `allOf`', { type, allOf: [{ minLength: 1, allOf: [owner] }] }],
      ['the limit beside the list', { type, minLength: 1, allOf: [{ allOf: [owner] }] }],
      ['an empty schema beside the two', { type, allOf: [{ allOf: [owner, {}, min] }] }],
      ['the two members in the other order', { type, allOf: [{ allOf: [min, owner] }] }],
      [
        'the limit first, each member wrapped at its own depth',
        { type, allOf: [{ allOf: [{ allOf: [min] }] }, owner] },
      ],
    ];
    const reference = await parseJson(document('3.1.0', flat(type)));
    for (const [label, schema] of spellings) {
      const spec = await parseJson(document('3.1.0', schema));
      expect(show(author(spec).type), label).toBe(expected);
      expect(modelNames(spec), label).toEqual(['Owner', 'Note']);
      expect(diffSpecs(reference, spec).changes, label).toEqual([]);
      expect(diffSpecs(spec, reference).changes, label).toEqual([]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps what a nested member says about each copy’s own type: a numeric bound for the number, nothing for a boolean', async () => {
    const bound = { minimum: 1 };
    expect(
      await table([
        ['flat', { type: ['string', 'integer'], allOf: [owner, bound] }],
        ['nested', { type: ['string', 'integer'], allOf: [{ allOf: [owner, bound] }] }],
        ['number', { type: ['object', 'number'], allOf: [{ allOf: [owner, bound] }] }],
        ['boolean', { type: ['boolean', 'string'], allOf: [{ allOf: [owner, bound, min] }] }],
        ['nothing applies', { type: ['object', 'string'], allOf: [{ allOf: [owner, { description: 'Who.' }] }] }],
        ['an empty inner allOf', { type: ['string', 'integer'], allOf: [{ allOf: [] }] }],
      ]),
    ).toMatchInlineSnapshot(`
      "flat: (string | integer) {"minimum":1}
      nested: (string | integer) {"minimum":1}
      number: (Owner | number) {"minimum":1}
      boolean: (boolean | string) {"minimum":1,"minLength":1}
      nothing applies: (Owner | string)
      an empty inner allOf: (string | integer)"
    `);
    expect(warn).not.toHaveBeenCalled();
  });

  it('types a value a nested member pins as the flat spelling does: an `enum`, a `const`, a `$ref` to an enum, a `format`', async () => {
    const Status = { type: 'string', enum: ['draft', 'sent'] };
    for (const [label, member, expected] of [
      ['enum', { enum: ['a', 'b'] }, '(Owner | enum NoteAuthor)'],
      ['const', { const: 'a' }, '(Owner | "a")'],
      // `Status` is a string: no object satisfies the `allOf`, so the list is the enum alone.
      ['$ref to an enum', ref('Status'), 'enum Status'],
      ['format', { format: 'date-time' }, '(Owner | string)'],
    ] as const) {
      const written = await typed({ type: ['object', 'string'], allOf: [owner, member] }, { Status });
      expect(written, label).toBe(expected);
      for (const spelling of [
        { type: ['object', 'string'], allOf: [{ allOf: [owner, member] }] },
        { type: ['object', 'string'], allOf: [{ allOf: [{ allOf: [owner, member] }] }] },
        { type: ['object', 'string'], allOf: [{ description: 'Who.', allOf: [owner, { allOf: [member] }] }] },
      ]) {
        expect(await typed(spelling, { Status }), `${label}: ${JSON.stringify(spelling)}`).toBe(expected);
      }
    }
    // Both members wrapped, beside primitives alone: the `boolean` copy sheds
    // every member but the value, the `string` copy the `$ref`.
    const wrapped = (member: unknown) => ({
      type: ['string', 'boolean'],
      allOf: [{ allOf: [owner] }, { allOf: [member] }],
    });
    expect(
      await table(
        [
          ['enum', wrapped({ enum: ['a', 'b'] })],
          ['const', wrapped({ const: 'a' })],
          ['$ref to an enum', wrapped(ref('Status'))],
          ['format', wrapped({ format: 'date-time' })],
        ],
        { Status },
      ),
    ).toMatchInlineSnapshot(`
      "enum: enum NoteAuthor
      const: "a"
      $ref to an enum: enum Status
      format: (string | boolean)"
    `);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a member’s own keywords as the copy’s own are read: another type’s family shed, flat or nested', async () => {
    const name = { properties: { name: string } };
    const spec = await parseJson(
      document('3.1.0', { type: ['object', 'string'], allOf: [{ ...name, minLength: 1 }] }, {}),
    );
    // The member writes both: `properties` for the object, `minLength` for the string.
    expect(author(spec).type).toEqual({
      kind: 'union',
      variants: [
        { kind: 'model', name: 'NoteAuthor' },
        { kind: 'primitive', type: 'string' },
      ],
      constraints: { minLength: 1 },
    });
    expect(fieldOf(spec, 'NoteAuthor', 'name').type).toEqual({ kind: 'primitive', type: 'string' });

    expect(
      await table([
        ['two members', { type: ['object', 'string'], allOf: [name, min] }],
        ['one member', { type: ['object', 'string'], allOf: [{ ...name, minLength: 1 }] }],
        ['one member, nested', { type: ['object', 'string'], allOf: [{ allOf: [{ ...name, minLength: 1 }] }] }],
        ['two members, nested', { type: ['object', 'string'], allOf: [{ allOf: [name, min] }] }],
        [
          '`required` beside the inner allOf',
          { type: ['object', 'string'], allOf: [{ required: ['name'], allOf: [owner, min] }] },
        ],
        [
          'beside `properties` on the list',
          { type: ['object', 'string'], properties: { extra: string }, allOf: [{ allOf: [owner, min] }] },
        ],
        ['primitives only', { type: ['string', 'integer'], allOf: [{ allOf: [{ ...name, minLength: 1 }] }] }],
      ]),
    ).toMatchInlineSnapshot(`
      "two members: (NoteAuthor | string) {"minLength":1}
      one member: (NoteAuthor | string) {"minLength":1}
      one member, nested: (NoteAuthor | string) {"minLength":1}
      two members, nested: (NoteAuthor | string) {"minLength":1}
      \`required\` beside the inner allOf: (NoteAuthor | string) {"minLength":1}
      beside \`properties\` on the list: (NoteAuthor | string) {"minLength":1}
      primitives only: (string | integer) {"minLength":1}"
    `);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a nested member that declares a type by that type: `string` alone, or the object alone', async () => {
    expect(
      await table([
        // No object satisfies the member's `type: 'string'`: the `string` copy alone, its `$ref` shed.
        ['string wrapper', { type: ['object', 'string'], allOf: [{ type: 'string', allOf: [owner, min] }] }],
        ['string member, flat', { type: ['object', 'string'], allOf: [{ type: 'string' }, owner, min] }],
        // No string satisfies `type: 'object'`: the `object` copy alone.
        ['object wrapper', { type: ['object', 'string'], allOf: [{ type: 'object', allOf: [owner, min] }] }],
      ]),
    ).toMatchInlineSnapshot(`
      "string wrapper: string {"minLength":1}
      string member, flat: string {"minLength":1}
      object wrapper: Owner"
    `);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a member that declares a type the wrapper the readers read, its values with it (Greptile, round 1)', async () => {
    // Opened into `{ type: 'string' }` beside `{ enum }`, the wrapper was two
    // typing members, which the readers read as neither: the values were
    // lost, where the base read the wrapper whole.
    const kinds = { enum: ['a', 'b'] };
    const pinned = { const: 'a' };
    expect(
      await table([
        ['enum under a typed wrapper', { type: ['string', 'integer'], allOf: [{ type: 'string', allOf: [kinds] }] }],
        ['const under a typed wrapper', { type: ['string', 'integer'], allOf: [{ type: 'string', allOf: [pinned] }] }],
        [
          'two typed wrappers',
          { type: ['string', 'integer'], allOf: [{ type: 'string', allOf: [{ type: 'string', allOf: [kinds] }] }] },
        ],
        [
          'a nullable typed wrapper',
          { type: ['string', 'integer'], allOf: [{ type: ['string', 'null'], allOf: [kinds] }] },
        ],
        [
          'a limit beside the inner allOf',
          { type: ['string', 'integer'], allOf: [{ minLength: 1, allOf: [{ type: 'string', ...kinds }] }] },
        ],
        [
          'a format beside the type',
          { type: ['string', 'integer'], allOf: [{ type: 'string', format: 'date-time', allOf: [min] }] },
        ],
        // The wrapper sheds its `$ref` and stays the wrapper of what is left.
        [
          'enum and `$ref` under a typed wrapper',
          { type: ['object', 'string'], allOf: [{ type: 'string', allOf: [owner, kinds] }] },
        ],
        [
          'const and `$ref` under a typed wrapper',
          { type: ['string', 'integer'], allOf: [{ type: 'string', allOf: [owner, pinned] }] },
        ],
        [
          'enum and `$ref` under a described wrapper',
          { type: ['object', 'string'], allOf: [{ description: 'Kinds.', allOf: [owner, kinds] }] },
        ],
        [
          'enum and `$ref` under a limit',
          { type: ['object', 'string'], allOf: [{ maxLength: 9, allOf: [owner, kinds] }] },
        ],
        [
          'a wrapper that pins the value itself',
          { type: ['object', 'string'], allOf: [{ ...kinds, allOf: [owner, min] }] },
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "enum under a typed wrapper: enum NoteAuthor
      const under a typed wrapper: "a"
      two typed wrappers: enum NoteAuthor
      a nullable typed wrapper: nullable<enum NoteAuthor>
      a limit beside the inner allOf: enum NoteAuthor
      a format beside the type: string:date-time {"minLength":1}
      enum and \`$ref\` under a typed wrapper: enum NoteAuthor
      const and \`$ref\` under a typed wrapper: "a"
      enum and \`$ref\` under a described wrapper: (Owner | enum NoteAuthor)
      enum and \`$ref\` under a limit: (Owner | enum NoteAuthor) {"maxLength":9}
      a wrapper that pins the value itself: (Owner | enum NoteAuthor) {"minLength":1}"
    `);

    // A wrapper that sheds nothing is the document's own object: its text
    // and keys reach the enum as they do without a type list.
    const described = { description: 'Kinds.', 'x-note': 'n', allOf: [{ type: 'string', ...kinds }] };
    const listed = await parseJson(document('3.1.0', { type: ['string', 'integer'], allOf: [described] }));
    const single = await parseJson(document('3.1.0', { allOf: [described] }));
    expect(author(listed).type).toEqual({ kind: 'enum', name: 'NoteAuthor', values: ['a', 'b'] });
    expect(listed.enums).toEqual(single.enums);
    expect(listed.enums).toMatchObject([{ name: 'NoteAuthor', description: 'Kinds.' }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a `$ref` to a component that composes or mixes the two as the model beside the primitive', async () => {
    const schemas = {
      Named: { allOf: [owner, min] },
      Deep: { allOf: [{ description: 'Who.', allOf: [owner, min] }] },
      Alias: { allOf: [ref('Named')] },
      Bare: ref('Named'),
      Mixed: { properties: { name: string }, minLength: 1 },
      Limits: { minLength: 1 },
      Loop: { allOf: [ref('Loop'), min] },
    };
    const rows = Object.keys(schemas).flatMap((name): Array<[string, unknown]> => [
      [`${name} beside [object, string]`, { type: ['object', 'string'], allOf: [ref(name)] }],
      [`${name} beside [string, integer]`, { type: ['string', 'integer'], allOf: [ref(name)] }],
      [`${name} nested`, { type: ['string', 'integer'], allOf: [{ allOf: [{ allOf: [ref(name)] }] }] }],
    ]);
    expect(await table(rows, schemas)).toMatchInlineSnapshot(`
      "Named beside [object, string]: (Named | string)
      Named beside [string, integer]: (string | integer)
      Named nested: (string | integer)
      Deep beside [object, string]: (Deep | string)
      Deep beside [string, integer]: (string | integer)
      Deep nested: (string | integer)
      Alias beside [object, string]: (Alias | string)
      Alias beside [string, integer]: (string | integer)
      Alias nested: (string | integer)
      Bare beside [object, string]: (Bare | string)
      Bare beside [string, integer]: (string | integer)
      Bare nested: (string | integer)
      Mixed beside [object, string]: (Mixed | string)
      Mixed beside [string, integer]: (string | integer)
      Mixed nested: (string | integer)
      Limits beside [object, string]: (map<unknown> | string) {"minLength":1}
      Limits beside [string, integer]: (string | integer) {"minLength":1}
      Limits nested: (string | integer) {"minLength":1}
      Loop beside [object, string]: (map<unknown> | string)
      Loop beside [string, integer]: (string | integer)
      Loop nested: (string | integer)"
    `);

    // The model is the component's, built once. The union carries the limits
    // of the site alone, none of a model component's.
    const spec = await parseJson(document('3.1.0', { type: ['object', 'string'], allOf: [ref('Named')] }, schemas));
    expect(author(spec).type).toEqual({
      kind: 'union',
      variants: [
        { kind: 'model', name: 'Named' },
        { kind: 'primitive', type: 'string' },
      ],
    });
    expect(spec.models.find(({ name }) => name === 'Named')!.fields.map(({ name }) => name)).toEqual(['name']);
    expect(modelNames(spec)).toEqual(['Owner', 'Note', 'Named', 'Deep', 'Alias', 'Bare', 'Mixed', 'Loop']);

    // A JSON Pointer `$ref` deeper into a component is read by the schema it lands on.
    const inner = { $ref: '#/components/schemas/Holder/properties/inner' };
    const Holder = { type: 'object', properties: { inner: { allOf: [owner, min] } } };
    expect(await typed({ type: ['object', 'string'], allOf: [inner] }, { Holder })).toBe('(Owner | string)');
    expect(await typed({ type: ['string', 'integer'], allOf: [{ allOf: [inner] }] }, { Holder })).toBe(
      '(string | integer)',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a `$ref` to a component of a type of its own as the reference: one that declares a type, an enum, a union', async () => {
    const schemas = {
      Status: { type: 'string', enum: ['draft', 'sent'] },
      Any: { enum: ['a', 1] },
      Wrapped: { allOf: [{ enum: ['a', 1] }] },
      Uuid: { type: 'string', format: 'uuid' },
      Name: { type: 'string', minLength: 1 },
      NameAlias: { allOf: [ref('Name'), { maxLength: 5 }] },
      Tag: { type: ['string', 'integer'] },
      Pet: { oneOf: [owner, { type: 'string' }] },
    };
    const rows = Object.keys(schemas).flatMap((name): Array<[string, unknown]> => [
      [`${name} flat`, { type: ['string', 'integer'], allOf: [owner, ref(name)] }],
      [`${name} nested`, { type: ['string', 'integer'], allOf: [{ allOf: [owner, ref(name)] }] }],
    ]);
    expect(await table(rows, schemas)).toMatchInlineSnapshot(`
      "Status flat: enum Status
      Status nested: enum Status
      Any flat: enum Any
      Any nested: enum Any
      Wrapped flat: enum Wrapped
      Wrapped nested: enum Wrapped
      Uuid flat: string:uuid
      Uuid nested: string:uuid
      Name flat: string {"minLength":1}
      Name nested: string {"minLength":1}
      NameAlias flat: string {"minLength":1,"maxLength":5}
      NameAlias nested: string {"minLength":1,"maxLength":5}
      Tag flat: (string | integer)
      Tag nested: (string | integer)
      Pet flat: (Pet | integer)
      Pet nested: (Pet | integer)"
    `);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a union a `$ref`’s component composes to the component, minting nothing at the site', async () => {
    // Read in the member's place, the union would name its inline variant
    // `NoteAuthor`, a model only the component builds (as `Comp`'s own).
    const schemas = { Comp: { allOf: [owner, { oneOf: [{ properties: { a: string } }, { minLength: 1 }] }] } };
    for (const [type, expected] of [
      [['object', 'string'], '(Comp | string)'],
      [['string', 'integer'], '(string | integer)'],
    ] as const) {
      const spec = await parseJson(document('3.1.0', { type, allOf: [ref('Comp')] }, schemas));
      expect(show(author(spec).type)).toBe(expected);
      expect(modelNames(spec)).toEqual(['Owner', 'Note', 'Comp']);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a `oneOf`/`anyOf` inside a member whole, nested as flat', async () => {
    // Every variant is a string, so no integer satisfies the member: the
    // `string` copy alone, typed by the union the document wrote.
    const variants = [
      { type: 'string', format: 'date' },
      { type: 'string', format: 'uuid' },
    ];
    for (const keyword of ['oneOf', 'anyOf'] as const) {
      const written = await typed({ type: ['string', 'integer'], allOf: [owner, { [keyword]: variants }] });
      expect(written, keyword).toBe('(string:date | string:uuid)');
      for (const spelling of [
        { type: ['string', 'integer'], allOf: [{ allOf: [owner, { [keyword]: variants }] }] },
        { type: ['string', 'integer'], allOf: [{ allOf: [owner], [keyword]: variants }] },
        { type: ['string', 'integer'], allOf: [{ allOf: [{ allOf: [owner] }, { allOf: [{ [keyword]: variants }] }] }] },
      ]) {
        expect(await typed(spelling), `${keyword}: ${JSON.stringify(spelling)}`).toBe(written);
      }
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a member that names several types itself as written, as before', async () => {
    // A union of its own, read per type in turn where it types the copy.
    const member = { type: ['object', 'string'], allOf: [owner, min] };
    expect(await typed({ type: ['object', 'string'], allOf: [member] })).toBe('(Owner | string) {"minLength":1}');
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves an `object` or `array` copy’s composition as written (the #616 review’s rule)', async () => {
    // The object copy of the nested spelling is the reference the inner
    // `allOf` is read as, never a composition trimmed to the members that
    // apply; no model is minted for it.
    const spec = await parseJson(document('3.1.0', nested(['object', 'integer'], 2)));
    expect(show(author(spec).type)).toBe('(Owner | integer) {"minLength":1}');
    expect(modelNames(spec)).toEqual(['Owner', 'Note']);

    // An array copy keeps the merge the extractor builds, as the flat spelling does.
    const items = { type: 'object', properties: { id: string } };
    const merged = await parseJson(
      document('3.1.0', { type: ['array', 'string'], allOf: [{ properties: { name: string } }, { items }, min] }, {}),
    );
    expect(show(author(merged).type)).toBe('(NoteAuthor | string) {"minLength":1}');
    expect(modelNames(merged)).toEqual(['Owner', 'Note', 'NoteAuthor']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers `typesAsUnknown` for a list as the type it builds from the nested spelling', async () => {
    const schema = { type: ['string', 'integer'], allOf: [{ allOf: [{ minLength: 1 }] }] };
    expect(typesAsUnknown(schema)).toBe(false);
    expect(typesAsUnknown({ type: ['string', 'weird'], allOf: [{ allOf: [{ minLength: 1 }] }] })).toBe(false);
    expect(await typed(schema)).toBe('(string | integer) {"minLength":1}');
    expect(warn).not.toHaveBeenCalled();
  });
});
