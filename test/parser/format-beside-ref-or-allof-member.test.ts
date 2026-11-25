import { describe, it, expect, afterAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { createExampleBuilder } from '../../src/snippets/index.js';
import { extractConstraints, schemaFormat, schemaToTypeRef, withTypeFormat } from '../../src/parser/schemas.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #745: a primitive's `format` reached the IR only when it was
 * written beside the `type` that makes the schema a primitive. Written in
 * another `allOf` member, beside an `allOf`, or beside a `$ref`, it was
 * dropped, while the `description` and the limits written at the same place
 * were kept — so a `date-time` field written that way was a plain string,
 * its snippet sample `string_example`, and `oagen diff` between the two
 * spellings reported a `field-format-changed`. The format is now read where
 * the limits are: a type built without one takes the format its site
 * writes, read from the levels the site's limits are conjoined from.
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

async function writeDoc(doc: unknown, name = 'spec.json'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-745-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}
const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeDoc(doc));

type Schema = Record<string, unknown>;
type Schemas = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const pointer = (to: string) => ({ $ref: `#/components/schemas/${to}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const string = { type: 'string' };
const nil = { type: 'null' };

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

/** A type on one line: `string(date-time){"maxLength":40}`, `nullable<…>`, `…[]`, `map<…>`, `(a | b)`, a model or enum by name. */
function show(type: TypeRef | undefined): string {
  if (!type) return String(type);
  const limits = 'constraints' in type && type.constraints ? JSON.stringify(type.constraints) : '';
  switch (type.kind) {
    case 'primitive':
      return `${type.type}${type.format === undefined ? '' : `(${type.format})`}${limits}`;
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'array':
      return `${show(type.items)}[]${limits}`;
    case 'map':
      return `map<${show(type.valueType)}>${limits}`;
    case 'union':
      return `(${type.variants.map(show).join(' | ')})${limits}`;
    case 'literal':
      return `${JSON.stringify(type.value)}${limits}`;
    case 'model':
    case 'enum':
      return type.name;
  }
}

/** A document that writes one schema at one site, and the type the parser gives that site. */
interface Site {
  name: string;
  doc: (x: unknown, schemas: Schemas, openapi: Version) => unknown;
  pick: (spec: ApiSpec) => TypeRef | undefined;
}

const document = (openapi: Version, paths: unknown, schemas: Schemas, more: Schema = {}) => ({
  openapi,
  info: { title: 'Repro', version: '1.0.0' },
  paths,
  components: { schemas },
  ...more,
});
/** The issue's operation: `POST /notes` (`createNote`) taking `$ref: Note` and returning `204`. */
const createNote = (openapi: Version, schemas: Schemas) =>
  document(
    openapi,
    {
      '/notes': {
        post: {
          operationId: 'createNote',
          requestBody: { required: true, ...json(ref('Note')) },
          responses: { '204': { description: 'No Content' } },
        },
      },
    },
    schemas,
  );
const note = (at: unknown) => ({ type: 'object', properties: { at } });
const listNotes = (openapi: Version, operation: Schema, schemas: Schemas, more: Schema = {}) =>
  document(openapi, { '/notes': { get: { operationId: 'listNotes', ...operation } } }, schemas, more);
const ok = { '200': { description: 'OK', ...json({ type: 'object', properties: { id: string } }) } };

const modelOf = (spec: ApiSpec, name: string): Model => {
  const found = spec.models.find((model) => model.name === name);
  if (!found) throw new Error(`no model ${name} among ${spec.models.map((model) => model.name).join(', ')}`);
  return found;
};
const fieldType = (spec: ApiSpec, model = 'Note', field = 'at'): TypeRef | undefined =>
  modelOf(spec, model).fields.find(({ name }) => name === field)?.type;
const operation = (spec: ApiSpec): Operation => spec.services.flatMap((service) => service.operations)[0]!;
const items = (type: TypeRef | undefined) => (type?.kind === 'array' ? type.items : undefined);
const values = (type: TypeRef | undefined) => (type?.kind === 'map' ? type.valueType : undefined);
const firstVariant = (type: TypeRef | undefined) => (type?.kind === 'union' ? type.variants[0] : undefined);

/** Every site a primitive is typed at. */
const SITES: Site[] = [
  {
    name: 'field',
    doc: (x, schemas, v) => createNote(v, { ...schemas, Note: note(x) }),
    pick: (spec) => fieldType(spec),
  },
  {
    name: 'array items',
    doc: (x, schemas, v) => createNote(v, { ...schemas, Note: note({ type: 'array', items: x }) }),
    pick: (spec) => items(fieldType(spec)),
  },
  {
    name: 'map values',
    doc: (x, schemas, v) => createNote(v, { ...schemas, Note: note({ type: 'object', additionalProperties: x }) }),
    pick: (spec) => values(fieldType(spec)),
  },
  {
    name: 'union variant',
    doc: (x, schemas, v) => createNote(v, { ...schemas, Note: note({ oneOf: [x, { type: 'boolean' }] }) }),
    pick: (spec) => firstVariant(fieldType(spec)),
  },
  {
    name: 'component',
    doc: (x, schemas, v) => createNote(v, { ...schemas, At: x, Note: note(ref('At')) }),
    pick: (spec) => fieldType(spec),
  },
  {
    name: '$ref chain',
    doc: (x, schemas, v) =>
      createNote(v, {
        ...schemas,
        At: x,
        AtAlias: ref('At'),
        AtAliasAlias: ref('AtAlias'),
        Note: note(ref('AtAliasAlias')),
      }),
    pick: (spec) => fieldType(spec),
  },
  {
    name: 'JSON Pointer $ref',
    doc: (x, schemas, v) =>
      createNote(v, {
        ...schemas,
        Holder: { type: 'object', properties: { at: x } },
        Note: note(pointer('Holder/properties/at')),
      }),
    pick: (spec) => fieldType(spec),
  },
  {
    name: 'query parameter',
    doc: (x, schemas, v) =>
      listNotes(v, { parameters: [{ name: 'at', in: 'query', schema: x }], responses: ok }, schemas),
    pick: (spec) => operation(spec).queryParams[0]?.type,
  },
  {
    name: 'header parameter',
    doc: (x, schemas, v) =>
      listNotes(v, { parameters: [{ name: 'X-At', in: 'header', schema: x }], responses: ok }, schemas),
    pick: (spec) => operation(spec).headerParams[0]?.type,
  },
  {
    name: 'path parameter',
    doc: (x, schemas, v) =>
      document(
        v,
        {
          '/notes/{at}': {
            get: {
              operationId: 'getNote',
              parameters: [{ name: 'at', in: 'path', required: true, schema: x }],
              responses: ok,
            },
          },
        },
        schemas,
      ),
    pick: (spec) => operation(spec).pathParams[0]?.type,
  },
  {
    name: 'component parameter',
    doc: (x, schemas, v) =>
      listNotes(v, { parameters: [{ $ref: '#/components/parameters/At' }], responses: ok }, schemas, {
        components: { schemas, parameters: { At: { name: 'at', in: 'query', schema: x } } },
      }),
    pick: (spec) => operation(spec).queryParams[0]?.type,
  },
  {
    name: 'response header',
    doc: (x, schemas, v) =>
      listNotes(v, { responses: { '200': { ...ok['200'], headers: { 'X-At': { schema: x } } } } }, schemas),
    pick: (spec) => operation(spec).responseHeaders?.[0]?.type,
  },
  {
    name: 'request body',
    doc: (x, schemas, v) =>
      document(
        v,
        {
          '/notes': {
            post: {
              operationId: 'createNote',
              requestBody: { required: true, ...json(x) },
              responses: { '204': { description: 'No Content' } },
            },
          },
        },
        schemas,
      ),
    pick: (spec) => operation(spec).requestBody,
  },
  {
    name: 'response body',
    doc: (x, schemas, v) => listNotes(v, { responses: { '200': { description: 'OK', ...json(x) } } }, schemas),
    pick: (spec) => operation(spec).response,
  },
  {
    name: 'webhook payload',
    doc: (x, schemas, v) =>
      document(v, {}, schemas, {
        webhooks: {
          noteMade: {
            post: {
              operationId: 'noteMade',
              requestBody: { required: true, ...json(ref('Note')) },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
        components: { schemas: { ...schemas, Note: note(x) } },
      }),
    pick: (spec) => fieldType(spec),
  },
];
const FIELD = SITES[0]!;

/** The type `site` gives `x`, on one line. */
async function typed(
  x: unknown,
  schemas: Schemas = {},
  openapi: Version = '3.1.0',
  site: Site = FIELD,
): Promise<string> {
  return show(site.pick(await parse(site.doc(x, schemas, openapi))));
}

type Row = readonly [label: string, x: unknown, schemas?: Schemas];
/** One line per row: the type a field written as the row's schema gets. */
async function table(rows: readonly Row[], openapi: Version = '3.1.0', site: Site = FIELD): Promise<string> {
  const lines: string[] = [];
  for (const [label, x, schemas] of rows) lines.push(`${label}: ${await typed(x, schemas, openapi, site)}`);
  return lines.join('\n');
}

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

/** What the issue writes beside the type: a format, a description and a limit. */
const extra = { format: 'date-time', description: 'When to remind.', maxLength: 40 };
/** The format alone, and with a limit: what the spellings below write apart from the `type`. */
const stamp = { format: 'date-time', maxLength: 40 };

/**
 * Every spelling of "a string whose format is written apart from its
 * type", each with the components it names: the issue's six, and their
 * neighbors. `direct` writes the format beside the `type`.
 */
const SPELLINGS: Record<string, { x: unknown; schemas?: Schemas; only?: Version }> = {
  direct: { x: { ...string, ...stamp } },
  'an allOf member': { x: { allOf: [string, stamp] } },
  'an allOf member, reversed': { x: { allOf: [stamp, string] } },
  'a member of its own allOf': { x: { ...string, allOf: [stamp] } },
  'beside an allOf': { x: { allOf: [string], ...stamp } },
  'a nested allOf': { x: { allOf: [{ allOf: [string, stamp] }] } },
  'two nested allOfs': { x: { allOf: [{ allOf: [string] }, { allOf: [stamp] }] } },
  'a member that wraps the type': { x: { allOf: [{ format: 'date-time', allOf: [string] }, { maxLength: 40 }] } },
  'beside a $ref': { x: { ...ref('Text'), ...stamp }, schemas: { Text: string } },
  'a member beside a $ref': { x: { allOf: [ref('Text'), stamp] }, schemas: { Text: string } },
  'a member beside a $ref, reversed': { x: { allOf: [stamp, ref('Text')] }, schemas: { Text: string } },
  'beside an allOf of a $ref': { x: { allOf: [ref('Text')], ...stamp }, schemas: { Text: string } },
  'beside a $ref member': {
    x: { allOf: [{ ...ref('Text'), format: 'date-time' }, { maxLength: 40 }] },
    schemas: { Text: string },
  },
  'a $ref to the keywords': { x: { allOf: [ref('Text'), ref('Stamp')] }, schemas: { Text: string, Stamp: stamp } },
  'a $ref to the keywords, reversed': {
    x: { allOf: [ref('Stamp'), ref('Text')] },
    schemas: { Text: string, Stamp: stamp },
  },
  'beside a $ref to the limits': {
    x: { allOf: [ref('Text'), { ...ref('Limits'), format: 'date-time' }] },
    schemas: { Text: string, Limits: { maxLength: 40 } },
  },
  'an alias that writes it beside its $ref': {
    x: ref('Alias'),
    schemas: { Text: string, Alias: { ...ref('Text'), ...stamp } },
  },
  'an alias that writes it in a member': {
    x: ref('Alias'),
    schemas: { Text: string, Alias: { allOf: [ref('Text'), stamp] } },
  },
  'a component that writes it in a member': { x: ref('Stamp'), schemas: { Stamp: { allOf: [string, stamp] } } },
  'a component that writes it beside the type': { x: ref('Stamp'), schemas: { Stamp: { ...string, ...stamp } } },
};

/** A nullable string whose format is written apart from its type, in the spellings OAS 3.1 has for `null`. */
const NULLABLE_31: Record<string, { x: unknown; schemas?: Schemas }> = {
  direct: { x: { type: ['string', 'null'], ...stamp } },
  'beside a oneOf with null': { x: { oneOf: [string, nil], ...stamp } },
  'beside an anyOf with null': { x: { anyOf: [nil, string], ...stamp } },
  'in the branch': { x: { oneOf: [{ allOf: [string, stamp] }, nil] } },
  'beside a oneOf of a $ref and null': { x: { oneOf: [ref('Text'), nil], ...stamp }, schemas: { Text: string } },
  'beside the $ref branch': { x: { oneOf: [{ ...ref('Text'), ...stamp }, nil] }, schemas: { Text: string } },
  'a member beside the wrapper': { x: { allOf: [{ oneOf: [string, nil] }, stamp] } },
  'a member of a type list naming null': { x: { type: ['string', 'null'], allOf: [stamp] } },
  'a member beside a type list naming null': { x: { allOf: [{ type: ['string', 'null'] }, stamp] } },
  'beside a $ref to a nullable component': {
    x: { ...ref('Text'), ...stamp },
    schemas: { Text: { type: ['string', 'null'] } },
  },
};
/** The same, in the spellings OAS 3.0 has. */
const NULLABLE_30: Record<string, { x: unknown; schemas?: Schemas }> = {
  direct: { x: { ...string, nullable: true, ...stamp } },
  'a member beside nullable: true': { x: { ...string, nullable: true, allOf: [stamp] } },
  'a member beside a nullable member': { x: { allOf: [{ ...string, nullable: true }, stamp] } },
  'beside a $ref to a nullable component': {
    x: { ...ref('Text'), ...stamp },
    schemas: { Text: { ...string, nullable: true } },
  },
  'a member beside a $ref to a nullable component': {
    x: { allOf: [ref('Text'), stamp] },
    schemas: { Text: { ...string, nullable: true } },
  },
};

describe("#745 the issue's documents", () => {
  /** `Note.remindAt` written as `remindAt`, beside `Text: { type: 'string' }`. */
  const noteDoc = (remindAt: unknown, openapi: Version = '3.1.0') =>
    createNote(openapi, { Text: string, Note: { type: 'object', properties: { remindAt } } });
  const FILES: Record<string, unknown> = {
    'direct.json': noteDoc({ ...string, ...extra }),
    'member.json': noteDoc({ allOf: [string, extra] }),
    'member-reversed.json': noteDoc({ allOf: [extra, string] }),
    'member-3.0.json': noteDoc({ allOf: [string, extra] }, '3.0.3'),
    'ref-member.json': noteDoc({ allOf: [ref('Text'), extra] }),
    'ref-sibling.json': noteDoc({ ...ref('Text'), ...extra }),
    'allof-sibling.json': noteDoc({ allOf: [ref('Text')], ...extra }),
  };

  /** The two lines the issue's script prints: the field's description and type, and the model's sample. */
  async function script(doc: unknown): Promise<string> {
    const spec = await parse(doc);
    const model = modelOf(spec, 'Note');
    const [{ description, type }] = model.fields as [Model['fields'][number]];
    return `${JSON.stringify({ description, type })}\n${JSON.stringify(createExampleBuilder(spec).forModel(model))}`;
  }

  it('prints the same two lines for every spelling', async () => {
    const direct = await script(FILES['direct.json']);
    expect(direct).toMatchInlineSnapshot(`
      "{"description":"When to remind.","type":{"kind":"primitive","type":"string","format":"date-time","constraints":{"maxLength":40}}}
      {"remindAt":"2026-01-15T12:00:00.000Z"}"
    `);
    for (const [name, doc] of Object.entries(FILES)) expect(await script(doc), name).toBe(direct);
  });

  it('reports nothing between the spellings, in either direction', async () => {
    const direct = FILES['direct.json'];
    for (const [name, doc] of Object.entries(FILES)) {
      const [a, b] = [await parse(direct), await parse(doc)];
      expect(diffSpecs(a, b).changes, name).toEqual([]);
      expect(diffSpecs(b, a).changes, name).toEqual([]);
      expect(await diffExit(direct, doc), name).toBe(0);
      expect(await diffExit(doc, direct), name).toBe(0);
    }
  });

  it('builds one IR for every spelling, key for key', async () => {
    // The key order too: the format before the limits, as beside the `type`.
    const direct = JSON.stringify(await parse(FILES['direct.json']));
    for (const [name, doc] of Object.entries(FILES)) expect(JSON.stringify(await parse(doc)), name).toBe(direct);
  });
});

describe('#745 the documented example', () => {
  /** The properties `docs/architecture/ir-types.md` lists under Primitive Formats. */
  const properties = {
    direct: { ...string, format: 'date-time' },
    member: { allOf: [string, { format: 'date-time' }] },
    reversed: { allOf: [{ format: 'date-time' }, string] },
    besideAllOf: { allOf: [ref('Text')], format: 'date-time' },
    refMember: { allOf: [ref('Text'), { format: 'date-time' }] },
    besideRef: { ...ref('Text'), format: 'date-time' },
    nullable: { oneOf: [string, nil], format: 'date-time' },
  };

  it('types each property as a date-time string and samples it as one', async () => {
    const spec = await parse(createNote('3.1.0', { Text: string, Note: { type: 'object', properties } }));
    const model = modelOf(spec, 'Note');
    expect(Object.fromEntries(model.fields.map(({ name, type }) => [name, show(type)]))).toEqual({
      direct: 'string(date-time)',
      member: 'string(date-time)',
      reversed: 'string(date-time)',
      besideAllOf: 'string(date-time)',
      refMember: 'string(date-time)',
      besideRef: 'string(date-time)',
      nullable: 'nullable<string(date-time)>',
    });
    const sample = createExampleBuilder(spec).forModel(model);
    expect(sample).toEqual(
      Object.fromEntries(Object.keys(properties).map((name) => [name, '2026-01-15T12:00:00.000Z'])),
    );
  });

  it('reports nothing between any two of the spellings', async () => {
    const written = (at: unknown) => createNote('3.1.0', { Text: string, Note: note(at) });
    const { nullable: _nullable, ...spellings } = properties;
    for (const [first, a] of Object.entries(spellings)) {
      for (const [second, b] of Object.entries(spellings)) {
        expect(diffSpecs(await parse(written(a)), await parse(written(b))).changes, `${first} -> ${second}`).toEqual(
          [],
        );
      }
    }
  });
});

describe('#745 every spelling, at every site', () => {
  for (const openapi of VERSIONS) {
    it(`types every spelling as the format beside the type is typed (OAS ${openapi})`, async () => {
      for (const site of SITES) {
        const direct = await parse(site.doc(SPELLINGS.direct!.x, {}, openapi));
        expect(show(site.pick(direct)), site.name).toBe('string(date-time){"maxLength":40}');
        for (const [name, { x, schemas = {}, only }] of Object.entries(SPELLINGS)) {
          if (only && only !== openapi) continue;
          const label = `${name} at a ${site.name}`;
          const spec = await parse(site.doc(x, schemas, openapi));
          expect(site.pick(spec), label).toEqual(site.pick(direct));
          // And `oagen diff` reports nothing between the two documents.
          expect(diffSpecs(direct, spec).changes, label).toEqual([]);
          expect(diffSpecs(spec, direct).changes, label).toEqual([]);
        }
      }
    });

    it(`types every spelling under a nullable wrapper alike (OAS ${openapi})`, async () => {
      const nullable = openapi === '3.1.0' ? NULLABLE_31 : NULLABLE_30;
      for (const site of SITES) {
        const direct = site.pick(await parse(site.doc(nullable.direct!.x, {}, openapi)));
        expect(show(direct), site.name).toBe('nullable<string(date-time){"maxLength":40}>');
        for (const [name, { x, schemas = {} }] of Object.entries(nullable)) {
          expect(site.pick(await parse(site.doc(x, schemas, openapi))), `${name} at a ${site.name}`).toEqual(direct);
        }
      }
    });
  }

  it('gives the format one site writes beside a $ref to that site alone', async () => {
    // Each `$ref` to a primitive component is a type of its own: what one
    // site writes around it never reaches another site, or the component.
    const spec = await parse(
      createNote('3.1.0', {
        Text: string,
        Note: {
          type: 'object',
          properties: {
            first: { ...ref('Text'), format: 'uuid' },
            second: { allOf: [ref('Text'), { format: 'date-time' }] },
            third: ref('Text'),
            fourth: { type: 'array', items: ref('Text') },
          },
        },
      }),
    );
    const fields = Object.fromEntries(modelOf(spec, 'Note').fields.map(({ name, type }) => [name, show(type)]));
    expect(fields).toEqual({ first: 'string(uuid)', second: 'string(date-time)', third: 'string', fourth: 'string[]' });
  });

  it('types the items of a list response, and what its iterator yields, with the format', async () => {
    const spec = await parse(
      listNotes(
        '3.1.0',
        {
          parameters: [{ name: 'after', in: 'query', schema: string }],
          responses: {
            '200': {
              description: 'OK',
              ...json({
                type: 'object',
                properties: {
                  data: { type: 'array', items: { allOf: [ref('Text'), { format: 'date-time' }] } },
                  list_metadata: { type: 'object', properties: { after: { type: ['string', 'null'] } } },
                },
              }),
            },
          },
        },
        { Text: string },
      ),
    );
    const { response, pagination } = operation(spec);
    expect(show(response)).toBe('string(date-time)[]');
    expect(show(pagination?.itemType)).toBe('string(date-time)');
  });

  it('reads a format beside a $ref in OAS 3.0.3 too, as the limits beside it are read there', async () => {
    // OAS 3.0 says what is written beside a `$ref` is ignored; the parser
    // reads a description and the limits there in either version, and the
    // format with them.
    expect(await typed({ ...ref('Text'), ...stamp }, { Text: string }, '3.0.3')).toBe(
      'string(date-time){"maxLength":40}',
    );
  });
});

describe('#745 every primitive', () => {
  it('carries the format of every primitive kind, as written', async () => {
    expect(
      await table([
        ['int32 in a member', { allOf: [{ type: 'integer' }, { format: 'int32', maximum: 9 }] }],
        ['int64 beside a $ref', { ...ref('Count'), format: 'int64' }, { Count: { type: 'integer' } }],
        ['float in a member of its own allOf', { type: 'number', allOf: [{ format: 'float' }] }],
        ['double beside an allOf', { allOf: [ref('Amount')], format: 'double' }, { Amount: { type: 'number' } }],
        ['uuid in a member', { allOf: [string, { format: 'uuid' }] }],
        ['binary beside a $ref', { ...ref('Text'), format: 'binary' }, { Text: string }],
        ['a format the parser does not know', { allOf: [string, { format: 'x-ulid' }] }],
      ]),
    ).toMatchInlineSnapshot(`
      "int32 in a member: integer(int32){"maximum":9}
      int64 beside a $ref: integer(int64)
      float in a member of its own allOf: number(float)
      double beside an allOf: number(double)
      uuid in a member: string(uuid)
      binary beside a $ref: string(binary)
      a format the parser does not know: string(x-ulid)"
    `);
  });

  it('carries a format whose kind is not the type, as beside the type', async () => {
    // The parser reads `format` as written and never checks it against the
    // `type`: `int32` on a string was `string(int32)` beside the `type`, and
    // is in a member too.
    expect(
      await table([
        ['int32 beside a string type', { ...string, format: 'int32' }],
        ['int32 in a member beside a string', { allOf: [string, { format: 'int32' }] }],
        ['int32 beside a $ref to a string', { ...ref('Text'), format: 'int32' }, { Text: string }],
        ['date-time beside a boolean type', { type: 'boolean', format: 'date-time' }],
        ['date-time in a member beside a boolean', { allOf: [{ type: 'boolean' }, { format: 'date-time' }] }],
      ]),
    ).toMatchInlineSnapshot(`
      "int32 beside a string type: string(int32)
      int32 in a member beside a string: string(int32)
      int32 beside a $ref to a string: string(int32)
      date-time beside a boolean type: boolean(date-time)
      date-time in a member beside a boolean: boolean(date-time)"
    `);
  });
});

describe('#745 under a nullable wrapper', () => {
  it('gives the format to the type under the wrapper (OAS 3.1.0)', async () => {
    expect(
      await table([
        ['beside a oneOf with null', { oneOf: [string, nil], ...stamp }],
        ['beside an anyOf with null', { anyOf: [nil, string], ...stamp }],
        ['in the branch', { oneOf: [{ allOf: [string, stamp] }, nil] }],
        ['beside a oneOf of a $ref and null', { oneOf: [ref('Text'), nil], ...stamp }, { Text: string }],
        ['beside the $ref branch', { oneOf: [{ ...ref('Text'), ...stamp }, nil] }, { Text: string }],
        ['a member beside the wrapper', { allOf: [{ oneOf: [string, nil] }, stamp] }],
        ['a member of a type list naming null', { type: ['string', 'null'], allOf: [stamp] }],
        ['a member beside a type list naming null', { allOf: [{ type: ['string', 'null'] }, stamp] }],
        ['a nullable component', ref('Stamp'), { Stamp: { oneOf: [string, nil], ...stamp } }],
      ]),
    ).toMatchInlineSnapshot(`
      "beside a oneOf with null: nullable<string(date-time){"maxLength":40}>
      beside an anyOf with null: nullable<string(date-time){"maxLength":40}>
      in the branch: nullable<string(date-time){"maxLength":40}>
      beside a oneOf of a $ref and null: nullable<string(date-time){"maxLength":40}>
      beside the $ref branch: nullable<string(date-time){"maxLength":40}>
      a member beside the wrapper: nullable<string(date-time){"maxLength":40}>
      a member of a type list naming null: nullable<string(date-time){"maxLength":40}>
      a member beside a type list naming null: nullable<string(date-time){"maxLength":40}>
      a nullable component: nullable<string(date-time){"maxLength":40}>"
    `);
  });

  it('gives the format to the type under the wrapper (OAS 3.0.3)', async () => {
    expect(
      await table(
        [
          ['a member beside nullable: true', { ...string, nullable: true, allOf: [stamp] }],
          ['a member beside a nullable member', { allOf: [{ ...string, nullable: true }, stamp] }],
          ['beside a nullable $ref component', { ...ref('Text'), ...stamp }, { Text: { ...string, nullable: true } }],
        ],
        '3.0.3',
      ),
    ).toMatchInlineSnapshot(`
      "a member beside nullable: true: nullable<string(date-time){"maxLength":40}>
      a member beside a nullable member: nullable<string(date-time){"maxLength":40}>
      beside a nullable $ref component: nullable<string(date-time){"maxLength":40}>"
    `);
  });
});

describe('#745 formats that disagree', () => {
  it('keeps the format written beside the type, whatever is written elsewhere', async () => {
    const Uuid = { Uuid: { ...string, format: 'uuid' } };
    expect(
      await table([
        ['a typing member, then another format', { allOf: [{ ...string, format: 'uuid' }, { format: 'date-time' }] }],
        ['another format, then the typing member', { allOf: [{ format: 'date-time' }, { ...string, format: 'uuid' }] }],
        [
          'the type and its format, another in its allOf',
          { ...string, format: 'uuid', allOf: [{ format: 'date-time' }] },
        ],
        ['beside a $ref to a formatted component', { ...ref('Uuid'), format: 'date-time' }, Uuid],
        ['a member beside a $ref to one', { allOf: [ref('Uuid'), { format: 'date-time' }] }, Uuid],
        ['a member beside a $ref to one, reversed', { allOf: [{ format: 'date-time' }, ref('Uuid')] }, Uuid],
        ['beside a nullable wrapper around one', { oneOf: [{ ...string, format: 'uuid' }, nil], format: 'date-time' }],
        ['the same format twice', { ...ref('Uuid'), format: 'uuid' }, Uuid],
      ]),
    ).toMatchInlineSnapshot(`
      "a typing member, then another format: string(uuid)
      another format, then the typing member: string(uuid)
      the type and its format, another in its allOf: string(uuid)
      beside a $ref to a formatted component: string(uuid)
      a member beside a $ref to one: string(uuid)
      a member beside a $ref to one, reversed: string(uuid)
      beside a nullable wrapper around one: nullable<string(uuid)>
      the same format twice: string(uuid)"
    `);
  });

  it('keeps the format the type took nearest to it: a component before the schema that names it', async () => {
    const Alias = { Text: string, Alias: { allOf: [ref('Text'), { format: 'uuid' }] } };
    expect(
      await table([
        ['an alias that formats, alone', ref('Alias'), Alias],
        ['another format beside a $ref to it', { ...ref('Alias'), format: 'date-time' }, Alias],
        ['another format in a member beside it', { allOf: [{ format: 'date-time' }, ref('Alias')] }, Alias],
        [
          'a branch that formats under a wrapper that formats',
          { oneOf: [{ allOf: [string, { format: 'uuid' }] }, nil], format: 'date-time' },
        ],
        [
          'beside a $ref member, another in the member beside it',
          { allOf: [{ ...ref('Text'), format: 'uuid' }, { format: 'date-time' }] },
          Alias,
        ],
        ['the same, reversed', { allOf: [{ format: 'date-time' }, { ...ref('Text'), format: 'uuid' }] }, Alias],
        [
          'a member that wraps the type and formats, another beside it',
          { allOf: [{ format: 'uuid', allOf: [string] }, { format: 'date-time' }] },
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "an alias that formats, alone: string(uuid)
      another format beside a $ref to it: string(uuid)
      another format in a member beside it: string(uuid)
      a branch that formats under a wrapper that formats: nullable<string(uuid)>
      beside a $ref member, another in the member beside it: string(uuid)
      the same, reversed: string(uuid)
      a member that wraps the type and formats, another beside it: string(uuid)"
    `);
  });

  it('takes a format through a chain of aliases alike, whatever the component is', async () => {
    // A string, a type list and a model that admits a string, nullable or
    // not, each named through `Base` -> `Alias` -> `AliasAlias` -> the field,
    // with a format or none at each of the four places: the string takes the
    // one written nearest the component, whatever the component is (Greptile,
    // #749: the model's chain was read as one level, so two formats on it
    // gave none).
    const kinds: Record<string, Schema> = {
      string,
      'a nullable string': { type: ['string', 'null'] },
      'a string under a nullable wrapper': { oneOf: [string, nil] },
      'a type list': { type: ['string', 'boolean'] },
      'a nullable type list': { type: ['string', 'boolean', 'null'] },
      'a type list naming an array': { type: ['array', 'string'], items: { type: 'integer' } },
      'a model that admits a string': { type: ['object', 'string'], properties: { name: string } },
      'a nullable model that admits a string': { type: ['object', 'string', 'null'], properties: { name: string } },
      'a model that admits an array and a string': {
        type: ['object', 'array', 'string'],
        properties: { name: string },
        items: { type: 'integer' },
      },
    };
    const FORMATS = [undefined, 'uuid', 'date-time'] as const;
    const f = (format: string | undefined) => (format ? { format } : {});
    const stringOf = (type: TypeRef | undefined): string => {
      if (type?.kind === 'nullable') return stringOf(type.inner);
      if (type?.kind === 'union')
        return stringOf(type.variants.find((v) => v.kind === 'primitive' && v.type === 'string'));
      return type?.kind === 'primitive' ? (type.format ?? 'none') : 'no string';
    };
    for (const beside of [true, false]) {
      for (const f0 of FORMATS) {
        for (const f1 of FORMATS) {
          for (const f2 of FORMATS) {
            for (const f3 of FORMATS) {
              const formats: string[] = [];
              for (const base of Object.values(kinds)) {
                const spec = await parse(
                  createNote('3.1.0', {
                    Base: beside ? { ...base, ...f(f0) } : { ...base, allOf: [f(f0)] },
                    Alias: { allOf: [ref('Base'), f(f1)] },
                    AliasAlias: { allOf: [ref('Alias')], ...f(f2) },
                    Note: note({ ...ref('AliasAlias'), ...f(f3) }),
                  }),
                );
                formats.push(stringOf(fieldType(spec)));
              }
              const label = `${beside ? 'beside the type' : 'in a member'}: ${[f0, f1, f2, f3].join(' / ')}`;
              expect(formats, label).toEqual(Object.keys(kinds).map(() => f0 ?? f1 ?? f2 ?? f3 ?? 'none'));
            }
          }
        }
      }
    }
  });

  it('keeps the format a model that admits a string writes, under an alias that writes another', async () => {
    const owner = (extra: Schema) => ({ type: ['object', 'string'], properties: { name: string }, ...extra });
    expect(
      await table([
        ['the model', ref('Owner'), { Owner: owner({ allOf: [{ format: 'uuid' }] }) }],
        [
          'an alias that writes another',
          ref('Alias'),
          { Owner: owner({ allOf: [{ format: 'uuid' }] }), Alias: { allOf: [ref('Owner'), { format: 'date-time' }] } },
        ],
        [
          'an alias of an alias that formats',
          ref('AliasAlias'),
          {
            Owner: owner({}),
            Alias: { allOf: [ref('Owner'), { format: 'date-time' }] },
            AliasAlias: { allOf: [ref('Alias'), { format: 'uuid' }] },
          },
        ],
        [
          'an alias that writes two',
          ref('Alias'),
          { Owner: owner({}), Alias: { allOf: [ref('Owner'), { format: 'uuid' }, { format: 'date-time' }] } },
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "the model: (Owner | string(uuid))
      an alias that writes another: (Alias | string(uuid))
      an alias of an alias that formats: (AliasAlias | string(date-time))
      an alias that writes two: (Alias | string)"
    `);
  });

  it('reads no format from levels that write two, in either order', async () => {
    // No one format describes a value two levels format differently, and
    // neither is nearer the type than the other.
    expect(
      await table([
        ['two members', { allOf: [string, { format: 'uuid' }, { format: 'date-time' }] }],
        ['two members, reversed', { allOf: [string, { format: 'date-time' }, { format: 'uuid' }] }],
        ['two members around the type', { allOf: [{ format: 'uuid' }, string, { format: 'date-time' }] }],
        ['a member and the allOf itself', { allOf: [string, { format: 'uuid' }], format: 'date-time' }],
        [
          'two members beside a $ref',
          { allOf: [ref('Text'), { format: 'uuid' }, { format: 'date-time' }] },
          { Text: string },
        ],
        ['two members that agree', { allOf: [string, { format: 'uuid' }, { format: 'uuid' }] }],
      ]),
    ).toMatchInlineSnapshot(`
      "two members: string
      two members, reversed: string
      two members around the type: string
      a member and the allOf itself: string
      two members beside a $ref: string
      two members that agree: string(uuid)"
    `);
  });
});

describe('#745 a schema around levels that disagree', () => {
  it('reads them again with its own, and gives no format either', async () => {
    // A site reads every level its limits are conjoined from: the entries a
    // `$ref` passes, a wrapper's branch, a member's own members. Two formats
    // among them are two formats to every schema around them.
    const Clash = { Text: string, Clash: { allOf: [ref('Text'), { format: 'uuid' }, { format: 'date-time' }] } };
    expect(
      await table([
        ['a component whose members disagree', ref('Clash'), Clash],
        ['a format beside a $ref to it', { ...ref('Clash'), format: 'time' }, Clash],
        ['a format in a member beside a $ref to it', { allOf: [ref('Clash'), { format: 'time' }] }, Clash],
        [
          'a format beside a wrapper whose branch disagrees',
          { oneOf: [{ ...string, allOf: [{ format: 'uuid' }, { format: 'date-time' }] }, nil], format: 'time' },
        ],
        [
          'a format beside an allOf whose member disagrees',
          { allOf: [{ ...string, allOf: [{ format: 'uuid' }, { format: 'date-time' }] }], format: 'time' },
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "a component whose members disagree: string
      a format beside a $ref to it: string
      a format in a member beside a $ref to it: string
      a format beside a wrapper whose branch disagrees: nullable<string>
      a format beside an allOf whose member disagrees: string"
    `);
  });
});

describe('#745 where a format cannot apply', () => {
  it('leaves a type that carries no format as it was', async () => {
    const schemas = {
      Kind: { type: 'string', enum: ['a', 'b'] },
      Owner: { type: 'object', properties: { name: string } },
    };
    expect(
      await table([
        ['a member beside a $ref to an enum', { allOf: [ref('Kind'), stamp] }, schemas],
        ['beside a $ref to an enum', { ...ref('Kind'), format: 'date-time' }, schemas],
        ['a member beside a $ref to a model', { allOf: [ref('Owner'), { format: 'date-time' }] }, schemas],
        ['beside a $ref to a model', { ...ref('Owner'), format: 'date-time' }, schemas],
        ['a member beside a const', { allOf: [{ const: 'x' }, { format: 'date-time' }] }],
        ['a member beside an inline enum', { allOf: [{ ...string, enum: ['a', 'b'] }, { format: 'date-time' }] }],
        ['beside an array', { type: 'array', items: string, format: 'date-time' }],
        ['beside a map', { type: 'object', additionalProperties: string, format: 'date-time' }],
        ['beside a union of several variants', { oneOf: [string, { type: 'integer' }], format: 'date-time' }],
      ]),
    ).toMatchInlineSnapshot(`
      "a member beside a $ref to an enum: Kind
      beside a $ref to an enum: Kind
      a member beside a $ref to a model: Owner
      beside a $ref to a model: Owner
      a member beside a const: "x"
      a member beside an inline enum: NoteAt
      beside an array: string[]
      beside a map: map<string>
      beside a union of several variants: (string | integer)"
    `);
  });

  it('leaves a schema that writes a format and no type unknown', async () => {
    expect(
      await table([
        ['a format alone', { format: 'date-time' }],
        ['a format and a description', { description: 'Any.', format: 'date-time' }],
        ['a format in a member beside a description', { allOf: [{ description: 'Any.' }, { format: 'date-time' }] }],
        [
          'beside a $ref to a schema that declares no type',
          { ...ref('Anything'), format: 'date-time' },
          { Anything: { description: 'Any.' } },
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "a format alone: unknown
      a format and a description: unknown
      a format in a member beside a description: unknown
      beside a $ref to a schema that declares no type: unknown"
    `);
  });

  it('reads a format that is no string, written apart from the type, as none', async () => {
    // As a limit of the wrong type is read: `maxLength: '3'` is no limit.
    expect(
      await table([
        ['a number in a member', { allOf: [string, { format: 5 }] }],
        ['true beside a $ref', { ...ref('Text'), format: true }, { Text: string }],
        ['an object in a member', { allOf: [string, { format: { name: 'date-time' } }] }],
        ['a list beside an allOf', { allOf: [string], format: ['date-time'] }],
        ['an empty string in a member', { allOf: [string, { format: '' }] }],
        ['null beside a nullable wrapper', { oneOf: [string, nil], format: null }],
        ['a number in one member, a format in another', { allOf: [string, { format: 5 }, { format: 'date-time' }] }],
      ]),
    ).toMatchInlineSnapshot(`
      "a number in a member: string
      true beside a $ref: string
      an object in a member: string
      a list beside an allOf: string
      an empty string in a member: string
      null beside a nullable wrapper: nullable<string>
      a number in one member, a format in another: string(date-time)"
    `);
  });

  it('carries whatever is written as the format beside the type, as before', async () => {
    // Beside the `type` the keyword is carried as the document writes it,
    // whatever it holds, and nothing written elsewhere replaces it.
    const type = async (x: unknown) => fieldType(await parse(createNote('3.1.0', { Note: note(x) })));
    expect(await type({ ...string, format: 5 })).toEqual({ kind: 'primitive', type: 'string', format: 5 });
    expect(await type({ allOf: [{ ...string, format: 5 }, { format: 'date-time' }] })).toEqual({
      kind: 'primitive',
      type: 'string',
      format: 5,
    });
    expect(await type({ ...string, format: '' })).toEqual({ kind: 'primitive', type: 'string' });
  });
});

describe('#745 a union', () => {
  it('gives the variants of a type list the format, as the list keeps it beside it', async () => {
    const Tag = { Tag: { type: ['string', 'boolean'] } };
    expect(
      await table([
        ['beside the list', { type: ['string', 'boolean'], ...stamp }],
        ['a member of the list', { type: ['string', 'boolean'], allOf: [stamp] }],
        ['a member beside the list', { allOf: [{ type: ['string', 'boolean'] }, stamp] }],
        ['beside a $ref to the list', { ...ref('Tag'), ...stamp }, Tag],
        ['a member beside a $ref to the list', { allOf: [stamp, ref('Tag')] }, Tag],
        ['a nullable list', { type: ['string', 'integer', 'null'], allOf: [{ format: 'int64' }] }],
        ['a list of numbers', { allOf: [{ type: ['integer', 'number'] }, { format: 'int64' }] }],
        [
          'a list whose string writes its own',
          { allOf: [{ type: ['string', 'integer'], format: 'uuid' }, { format: 'int64' }] },
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "beside the list: (string(date-time) | boolean){"maxLength":40}
      a member of the list: (string(date-time) | boolean){"maxLength":40}
      a member beside the list: (string(date-time) | boolean){"maxLength":40}
      beside a $ref to the list: (string(date-time) | boolean){"maxLength":40}
      a member beside a $ref to the list: (string(date-time) | boolean){"maxLength":40}
      a nullable list: nullable<(string(int64) | integer(int64))>
      a list of numbers: (integer(int64) | number(int64))
      a list whose string writes its own: (string(uuid) | integer(uuid))"
    `);
  });

  it('gives a model that admits a string the format, on the string', async () => {
    const schemas = { Owner: { type: ['object', 'string'], properties: { name: string } } };
    expect(
      await table([
        ['beside a $ref to the model', { ...ref('Owner'), format: 'date-time' }, schemas],
        ['a member beside a $ref to it', { allOf: [ref('Owner'), { format: 'date-time' }] }, schemas],
        [
          'a member of the component',
          ref('Stamped'),
          { Stamped: { type: ['object', 'string'], properties: { name: string }, allOf: [{ format: 'date-time' }] } },
        ],
        [
          'a multi-type inline variant',
          {
            oneOf: [
              { type: ['object', 'string'], properties: { name: string }, allOf: [{ format: 'date-time' }] },
              { type: 'integer' },
            ],
          },
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "beside a $ref to the model: (Owner | string(date-time))
      a member beside a $ref to it: (Owner | string(date-time))
      a member of the component: (Stamped | string(date-time))
      a multi-type inline variant: ((NoteAt | string(date-time)) | integer)"
    `);
  });

  it('gives the one variant of a union of one the format', async () => {
    expect(
      await table([
        ['beside a oneOf of one', { oneOf: [string], ...stamp }],
        ['beside an anyOf of one', { anyOf: [string], ...stamp }],
        ['a member beside a oneOf of one', { allOf: [{ oneOf: [string] }, stamp] }],
        ['a member beside a oneOf of one $ref', { allOf: [{ oneOf: [ref('Text')] }, stamp] }, { Text: string }],
        ['a variant that writes its own', { oneOf: [{ ...string, format: 'uuid' }], format: 'date-time' }],
      ]),
    ).toMatchInlineSnapshot(`
      "beside a oneOf of one: (string(date-time)){"maxLength":40}
      beside an anyOf of one: (string(date-time)){"maxLength":40}
      a member beside a oneOf of one: (string(date-time)){"maxLength":40}
      a member beside a oneOf of one $ref: (string(date-time)){"maxLength":40}
      a variant that writes its own: (string(uuid))"
    `);
  });

  it('gives the one variant of a named union of one the format', async () => {
    const spec = await parse(
      createNote('3.1.0', {
        Text: string,
        One: { oneOf: [string], ...stamp },
        OneRef: { anyOf: [ref('Text')], format: 'date-time' },
        Two: { oneOf: [string, { type: 'integer' }], ...stamp },
        Note: { type: 'object', properties: { one: ref('One'), oneRef: ref('OneRef'), two: ref('Two') } },
      }),
    );
    const variants = (name: string) => `${(modelOf(spec, name).variants ?? []).map(show).join(' | ')}`;
    expect({ One: variants('One'), OneRef: variants('OneRef'), Two: variants('Two') }).toMatchInlineSnapshot(`
      {
        "One": "string(date-time)",
        "OneRef": "string(date-time)",
        "Two": "string | integer",
      }
    `);
    expect(modelOf(spec, 'One').constraints).toEqual({ maxLength: 40 });
  });
});

describe('#745 a type list that collapsed, among the variants of another union', () => {
  // Greptile, #749: a type list that collapses to one type leaves a type
  // like any other. It was still recorded as a list's variant, and a union
  // read every variant so recorded as one of its own list's, so a format
  // beside a `oneOf` of several variants reached it.
  const uuid = { format: 'uuid' };
  const integer = { type: 'integer' };
  const LISTS: Schemas = {
    Text: string,
    Flag: { type: 'boolean' },
    Tag: { type: ['string', 'boolean'] },
    Collapsed: { type: ['string', 'boolean'], allOf: [string] },
    CollapsedFlag: { type: ['boolean', 'string'], allOf: [{ type: 'boolean' }] },
    NullableCollapsed: { type: ['string', 'boolean', 'null'], allOf: [string] },
    Owner: { type: ['object', 'string'], properties: { name: string } },
    Holder: {
      type: 'object',
      properties: { tag: { type: ['string', 'boolean'] }, collapsed: { type: ['string', 'boolean'], allOf: [string] } },
    },
  };
  /** Each group: the plain spelling of a type first, then spellings that are that type by a type list. */
  const GROUPS: Record<string, Record<string, unknown>> = {
    string: {
      plain: string,
      'a list a member types': { type: ['string', 'boolean'], allOf: [string] },
      'the list reversed': { type: ['boolean', 'string'], allOf: [string] },
      'a list a $ref member types': { type: ['string', 'boolean'], allOf: [ref('Text')] },
      'a $ref to a collapsed list': ref('Collapsed'),
      'a list narrowed by the type beside it': { type: 'string', allOf: [ref('Tag')] },
      'a list narrowed by a member': { allOf: [ref('Tag'), string] },
      'a member that is a collapsed list': { allOf: [{ type: ['string', 'boolean'], allOf: [string] }] },
      'a list of one type around a list': { type: ['string'], allOf: [{ type: ['string', 'boolean'] }] },
    },
    boolean: {
      plain: { type: 'boolean' },
      'a list a member types': { type: ['boolean', 'string'], allOf: [{ type: 'boolean' }] },
      'a list a $ref member types': { type: ['string', 'boolean'], allOf: [ref('Flag')] },
      'a $ref to a collapsed list': ref('CollapsedFlag'),
      'a list narrowed by the type beside it': { type: 'boolean', allOf: [ref('Tag')] },
    },
    'nullable string': {
      plain: { type: ['string', 'null'] },
      'a list naming null that a member types': { type: ['string', 'boolean', 'null'], allOf: [string] },
      'a collapsed list under a nullable wrapper': { oneOf: [{ type: ['string', 'boolean'], allOf: [string] }, nil] },
      'a $ref to a nullable collapsed list': ref('NullableCollapsed'),
      'a nullable wrapper around a $ref to a collapsed list': { anyOf: [nil, ref('Collapsed')] },
    },
  };
  /** Where a format written around `x` reaches no node: beside a union of several variants, an array or a map. */
  const NOWHERE: Record<string, (x: unknown) => Schema> = {
    'beside a oneOf of x and an integer': (x) => ({ oneOf: [x, integer], ...uuid }),
    'beside a oneOf of an integer and x': (x) => ({ oneOf: [integer, x], ...uuid }),
    'beside an anyOf of x and an integer': (x) => ({ anyOf: [x, integer], ...uuid }),
    'beside a nullable oneOf of x and an integer': (x) => ({ oneOf: [x, integer, nil], ...uuid }),
    'a member beside a oneOf of x and an integer': (x) => ({ allOf: [{ oneOf: [x, integer] }, uuid] }),
    'a member before an anyOf of an integer and x': (x) => ({ allOf: [uuid, { anyOf: [integer, x] }] }),
    'beside a oneOf of an array of x and an integer': (x) => ({
      oneOf: [{ type: 'array', items: x }, integer],
      ...uuid,
    }),
    'beside a oneOf of a map of x and an integer': (x) => ({
      oneOf: [{ type: 'object', additionalProperties: x }, integer],
      ...uuid,
    }),
    'beside a oneOf that nests a oneOf of x': (x) => ({
      oneOf: [{ oneOf: [x, { type: 'number' }] }, integer],
      ...uuid,
    }),
    'beside an array of x': (x) => ({ type: 'array', items: x, ...uuid }),
    'beside a map of x': (x) => ({ type: 'object', additionalProperties: x, ...uuid }),
  };
  /** Where a format written around `x` reaches it. */
  const SOMEWHERE: Record<string, (x: unknown) => Schema> = {
    'a member beside x': (x) => ({ allOf: [x, uuid] }),
    'a member before x': (x) => ({ allOf: [uuid, x] }),
    'beside an allOf of x': (x) => ({ allOf: [x], ...uuid }),
    'beside a nullable wrapper around x': (x) => ({ oneOf: [x, nil], ...uuid }),
    'beside a oneOf of x alone': (x) => ({ oneOf: [x], ...uuid }),
    'x alone': (x) => x as Schema,
  };
  const at = async (x: unknown, openapi: Version) =>
    show(fieldType(await parse(createNote(openapi, { ...LISTS, Note: note(x) }))));

  it("types the finding's document as it types a plain string in its place", async () => {
    const collapsed = { type: ['string', 'boolean'], allOf: [string] };
    expect(
      await table([
        ['a oneOf of a collapsed list and an integer', { oneOf: [collapsed, integer], ...uuid }],
        ['the same, of a plain string', { oneOf: [string, integer], ...uuid }],
        ['the variants reversed', { oneOf: [integer, collapsed], ...uuid }],
        ['an anyOf', { anyOf: [collapsed, integer], ...uuid }],
        ['the format in a member beside the oneOf', { allOf: [{ oneOf: [collapsed, integer] }, uuid] }],
        ['the collapsed list alone, a format beside it', { ...collapsed, ...uuid }],
        ['the collapsed list, a format in a member beside it', { allOf: [collapsed, uuid] }],
      ]),
    ).toMatchInlineSnapshot(`
      "a oneOf of a collapsed list and an integer: (string | integer)
      the same, of a plain string: (string | integer)
      the variants reversed: (integer | string)
      an anyOf: (string | integer)
      the format in a member beside the oneOf: (string | integer)
      the collapsed list alone, a format beside it: string(uuid)
      the collapsed list, a format in a member beside it: string(uuid)"
    `);
  });

  for (const openapi of VERSIONS) {
    it(`types a list that collapsed as the type it collapsed to, wherever a format is written (OAS ${openapi})`, async () => {
      for (const [group, { plain, ...spellings }] of Object.entries(GROUPS)) {
        for (const [context, around] of Object.entries({ ...NOWHERE, ...SOMEWHERE })) {
          const expected = await at(around(plain), openapi);
          for (const [name, x] of Object.entries(spellings)) {
            expect(await at(around(x), openapi), `${group}, ${name}: ${context}`).toBe(expected);
          }
        }
      }
    });

    it(`gives no variant a format written beside a union of several, an array or a map (OAS ${openapi})`, async () => {
      const slots: Record<string, unknown> = {
        ...Object.fromEntries(
          Object.entries(GROUPS).flatMap(([group, spellings]) =>
            Object.entries(spellings).map(([name, x]) => [`${group}, ${name}`, x]),
          ),
        ),
        'a type list': { type: ['string', 'boolean'] },
        'a type list of numbers': { type: ['integer', 'number'] },
        'a nullable type list': { type: ['string', 'boolean', 'null'] },
        'a $ref to a type list': ref('Tag'),
        'a type list naming an array': { type: ['array', 'string'], items: string },
        'a $ref to a model that admits a string': ref('Owner'),
        'an inline object that admits a string': { type: ['object', 'string'], properties: { name: string } },
        'a JSON Pointer to a type list': pointer('Holder/properties/tag'),
        'a JSON Pointer to a collapsed list': pointer('Holder/properties/collapsed'),
        'a union of one type list': { oneOf: [{ type: ['string', 'boolean'] }] },
      };
      /** `schema` without the format the context wrote: beside it, or as the `{ format }` member of its `allOf`. */
      const bare = ({ format: _format, ...rest }: Schema): Schema =>
        Array.isArray(rest.allOf) ? { ...rest, allOf: rest.allOf.filter((member) => member !== uuid) } : rest;
      for (const [slot, x] of Object.entries(slots)) {
        for (const [context, around] of Object.entries(NOWHERE)) {
          expect(await at(around(x), openapi), `${slot}: ${context}`).toBe(await at(bare(around(x)), openapi));
        }
      }
    });
  }

  it('gives a list that collapses the format it writes itself as its per-type copy keeps it', async () => {
    // Where the list is written, its one variant is the list's copy of that
    // type: a `boolean` copy sheds the list's `format`, as it always did.
    expect(
      await table(
        [
          ['a string, the format beside the list', { type: ['string', 'boolean'], ...uuid, allOf: [ref('Text')] }],
          ['a string, the format in a member', { type: ['string', 'boolean'], allOf: [ref('Text'), uuid] }],
          ['a boolean, the format beside the list', { type: ['boolean', 'string'], ...uuid, allOf: [ref('Flag')] }],
          ['a boolean, the format in a member', { type: ['boolean', 'string'], allOf: [ref('Flag'), uuid] }],
          [
            'a nullable boolean, the format beside the list',
            { type: ['boolean', 'string', 'null'], ...uuid, allOf: [ref('Flag')] },
          ],
          [
            'that boolean list in a member, a format beside it',
            { allOf: [{ type: ['boolean', 'string'], allOf: [ref('Flag')] }, uuid] },
          ],
          ['a boolean, the format beside its type', { type: 'boolean', ...uuid }],
        ],
        '3.1.0',
        { ...FIELD, doc: (x, schemas, v) => createNote(v, { ...LISTS, ...schemas, Note: note(x) }) },
      ),
    ).toMatchInlineSnapshot(`
      "a string, the format beside the list: string(uuid)
      a string, the format in a member: string(uuid)
      a boolean, the format beside the list: boolean
      a boolean, the format in a member: boolean
      a nullable boolean, the format beside the list: nullable<boolean>
      that boolean list in a member, a format beside it: boolean(uuid)
      a boolean, the format beside its type: boolean(uuid)"
    `);
  });
});

describe('#745 a JSON Pointer $ref', () => {
  it('gives the type the pointer settles into the format written around the pointer', async () => {
    const schemas = {
      Holder: {
        type: 'object',
        properties: {
          plain: string,
          stamped: { allOf: [string, stamp] },
          uuid: { ...string, format: 'uuid' },
          nullable: { type: ['string', 'null'] },
          tag: { type: ['string', 'boolean'] },
          owner: { type: 'object', properties: { name: string } },
        },
      },
    };
    const to = (name: string) => pointer(`Holder/properties/${name}`);
    expect(
      await table([
        ['a pointer to a formatted field', to('stamped'), schemas],
        ['a format beside a pointer', { ...to('plain'), ...stamp }, schemas],
        ['a member beside a pointer', { allOf: [to('plain'), stamp] }, schemas],
        [
          'beside the pointer under a nullable wrapper',
          { oneOf: [{ ...to('plain'), format: 'date-time' }, nil] },
          schemas,
        ],
        ['beside a nullable wrapper around a pointer', { oneOf: [to('plain'), nil], format: 'date-time' }, schemas],
        ['beside a pointer to a nullable field', { ...to('nullable'), format: 'date-time' }, schemas],
        ['another format beside a pointer to a formatted field', { ...to('uuid'), format: 'date-time' }, schemas],
        ['beside a pointer to a type list', { ...to('tag'), format: 'date-time' }, schemas],
        ['beside a pointer to a model', { ...to('owner'), format: 'date-time' }, schemas],
      ]),
    ).toMatchInlineSnapshot(`
      "a pointer to a formatted field: string(date-time){"maxLength":40}
      a format beside a pointer: string(date-time){"maxLength":40}
      a member beside a pointer: string(date-time){"maxLength":40}
      beside the pointer under a nullable wrapper: nullable<string(date-time)>
      beside a nullable wrapper around a pointer: nullable<string(date-time)>
      beside a pointer to a nullable field: nullable<string(date-time)>
      another format beside a pointer to a formatted field: string(uuid)
      beside a pointer to a type list: (string(date-time) | boolean)
      beside a pointer to a model: HolderOwner"
    `);
  });
});

describe('#745 two declarations of one property', () => {
  /** `Note.at` declared by two variants of a merged `allOf`, as `first` and as `second`. */
  const declared = (first: unknown, second: unknown, schemas: Schemas = {}) =>
    createNote('3.1.0', {
      Text: string,
      ...schemas,
      Note: {
        allOf: [
          { type: 'object', properties: { id: string } },
          {
            oneOf: [
              { type: 'object', properties: { at: first, a: string } },
              { type: 'object', properties: { at: second, b: string } },
            ],
          },
        ],
      },
    });

  it('reads two spellings of one formatted string as one shape, in either order', async () => {
    const direct = { ...string, format: 'date-time' };
    const spellings: Array<[string, unknown]> = [
      ['an allOf member', { allOf: [string, { format: 'date-time' }] }],
      ['a member of its own allOf', { ...string, allOf: [{ format: 'date-time' }] }],
      ['beside a $ref', { ...ref('Text'), format: 'date-time' }],
      ['a member beside a $ref', { allOf: [ref('Text'), { format: 'date-time' }] }],
      ['a $ref to an alias that writes it', ref('Alias')],
      ['a JSON Pointer to a formatted field', pointer('Holder/properties/at')],
      ['a format beside a JSON Pointer', { ...pointer('Holder/properties/plain'), format: 'date-time' }],
    ];
    const schemas = {
      Alias: { allOf: [ref('Text'), { format: 'date-time' }] },
      Holder: { type: 'object', properties: { at: { allOf: [string, { format: 'date-time' }] }, plain: string } },
    };
    for (const [name, spelling] of spellings) {
      expect(show(fieldType(await parse(declared(direct, spelling, schemas)))), `direct, then ${name}`).toBe(
        'string(date-time)',
      );
      expect(show(fieldType(await parse(declared(spelling, direct, schemas)))), `${name}, then direct`).toBe(
        'string(date-time)',
      );
      for (const [other, second] of spellings) {
        expect(show(fieldType(await parse(declared(spelling, second, schemas)))), `${name}, then ${other}`).toBe(
          'string(date-time)',
        );
      }
    }
  });

  it('keeps a formatted string and a plain one two shapes', async () => {
    const member = { allOf: [string, { format: 'date-time' }] };
    expect(show(fieldType(await parse(declared(member, string))))).toBe('(string(date-time) | string)');
    expect(show(fieldType(await parse(declared(string, member))))).toBe('(string | string(date-time))');
    expect(show(fieldType(await parse(declared(member, { ...string, format: 'uuid' }))))).toBe(
      '(string(date-time) | string(uuid))',
    );
  });

  it('reads the null one spelling admits with the format both write', async () => {
    const nullable = { oneOf: [string, nil], format: 'date-time' };
    const direct = { ...string, format: 'date-time' };
    expect(show(fieldType(await parse(declared(direct, nullable))))).toBe('nullable<string(date-time)>');
    expect(show(fieldType(await parse(declared(nullable, direct))))).toBe('nullable<string(date-time)>');
  });

  it('reads the format a second member writes for a property the first one types', async () => {
    const spec = await parse(
      createNote('3.1.0', {
        Base: { type: 'object', properties: { at: string, id: { ...string, format: 'uuid' } } },
        Note: { allOf: [ref('Base'), { properties: { at: { format: 'date-time' }, id: { format: 'date-time' } } }] },
      }),
    );
    // A typeless declaration fills in what the typing one leaves unset
    // (`combineDeclarations`), as before: the format with the rest.
    expect(show(fieldType(spec, 'Note', 'at'))).toBe('string(date-time)');
    expect(show(fieldType(spec, 'Note', 'id'))).toBe('string(uuid)');
  });
});

describe('#745 beside the fixes it is stacked on', () => {
  it('formats a property a second member annotates under the nullable $ref the first one writes (#743)', async () => {
    const spec = await parse(
      createNote('3.1.0', {
        Text: string,
        Base: {
          type: 'object',
          properties: { at: { anyOf: [ref('Text'), nil] }, plain: { anyOf: [ref('Text'), nil] } },
        },
        Note: { allOf: [ref('Base'), { properties: { at: { format: 'date-time', maxLength: 40 } } }] },
      }),
    );
    // The typeless declaration fills in the first one's keywords, so the
    // format stands beside the nullable wrapper: the type under it takes it.
    expect(show(fieldType(spec, 'Note', 'at'))).toBe('nullable<string(date-time){"maxLength":40}>');
    expect(show(fieldType(spec, 'Note', 'plain'))).toBe('nullable<string>');
    expect(show(fieldType(spec, 'Base', 'at'))).toBe('nullable<string>');
  });

  it('declares no property for a $ref to false, whatever format is written beside it (#746)', async () => {
    const spec = await parse(
      createNote('3.1.0', {
        Never: false,
        Text: string,
        Note: {
          type: 'object',
          properties: {
            never: { ...ref('Never'), format: 'date-time' },
            at: { ...ref('Text'), format: 'date-time' },
          },
        },
      }),
    );
    expect(modelOf(spec, 'Note').fields.map(({ name, type }) => `${name}: ${show(type)}`)).toEqual([
      'at: string(date-time)',
    ]);
  });
});

describe('#745 the readers the type builder shares its reading with', () => {
  it('reads the format where the limits are read: schemaFormat beside extractConstraints', () => {
    const member = { allOf: [string, { format: 'date-time', maxLength: 40 }] };
    expect(schemaFormat(member, undefined)).toBe('date-time');
    expect(extractConstraints(member)).toEqual({ maxLength: 40 });
    // A nullable wrapper's one branch, and what is written beside the wrapper.
    expect(schemaFormat({ oneOf: [{ ...string, format: 'uuid' }, nil] }, undefined)).toBe('uuid');
    expect(schemaFormat({ oneOf: [string, nil], format: 'uuid' }, undefined)).toBe('uuid');
    // A `$ref` branch keeps its keywords, as it keeps its limits.
    expect(schemaFormat({ oneOf: [{ ...ref('Text'), format: 'uuid' }, nil] }, undefined)).toBeUndefined();
    expect(extractConstraints({ oneOf: [{ ...ref('Text'), maxLength: 3 }, nil] })).toBeUndefined();
    // Levels that disagree write none, in either order.
    expect(schemaFormat({ allOf: [{ format: 'uuid' }, { format: 'date-time' }] }, undefined)).toBeUndefined();
    expect(schemaFormat({ allOf: [{ format: 'date-time' }, { format: 'uuid' }] }, undefined)).toBeUndefined();
    expect(
      schemaFormat(
        { format: 'uuid', allOf: [{ format: 'uuid' }, { format: 'date-time' }, { format: 'uuid' }] },
        undefined,
      ),
    ).toBeUndefined();
    expect(schemaFormat({ format: 'uuid', allOf: [{ format: 'uuid' }] }, undefined)).toBe('uuid');
    expect(schemaFormat({ description: 'No format.' }, undefined)).toBeUndefined();
  });

  it('gives a type the format only where it has none and can carry one', () => {
    const format = (type: TypeRef): string => show(withTypeFormat(type, 'date-time'));
    expect(format({ kind: 'primitive', type: 'string' })).toBe('string(date-time)');
    expect(format({ kind: 'primitive', type: 'string', format: 'uuid' })).toBe('string(uuid)');
    expect(format({ kind: 'primitive', type: 'unknown' })).toBe('unknown');
    expect(format({ kind: 'nullable', inner: { kind: 'primitive', type: 'integer' } })).toBe(
      'nullable<integer(date-time)>',
    );
    expect(format({ kind: 'array', items: { kind: 'primitive', type: 'string' } })).toBe('string[]');
    expect(format({ kind: 'map', valueType: { kind: 'primitive', type: 'string' } })).toBe('map<string>');
    expect(format({ kind: 'literal', value: 'x' })).toBe('"x"');
    expect(format({ kind: 'model', name: 'Owner' })).toBe('Owner');
    expect(format({ kind: 'enum', name: 'Kind' })).toBe('Kind');
    const two: TypeRef = {
      kind: 'union',
      variants: [
        { kind: 'primitive', type: 'string' },
        { kind: 'primitive', type: 'integer' },
      ],
    };
    expect(format(two)).toBe('(string | integer)');
    expect(format({ kind: 'union', variants: [{ kind: 'primitive', type: 'string' }] })).toBe('(string(date-time))');
    const string: TypeRef = { kind: 'primitive', type: 'string' };
    expect(withTypeFormat(string, undefined)).toBe(string);
    expect(string).toEqual({ kind: 'primitive', type: 'string' });
  });

  it('writes the format before the limits, as a type built from one schema carries them', () => {
    const type = schemaToTypeRef({ allOf: [{ ...string, maxLength: 40 }, { format: 'date-time' }] });
    expect(JSON.stringify(type)).toBe(
      '{"kind":"primitive","type":"string","format":"date-time","constraints":{"maxLength":40}}',
    );
  });
});

describe('#745 what must not change', () => {
  it('types a format written beside the type as before, at every site', async () => {
    const rows: Row[] = [
      ['date-time', { ...string, format: 'date-time' }],
      ['int64', { type: 'integer', format: 'int64' }],
      ['double', { type: 'number', format: 'double' }],
      ['a nullable date', { type: ['string', 'null'], format: 'date' }],
      ['a string with no format', string],
      ['a $ref to a formatted component', ref('Uuid'), { Uuid: { ...string, format: 'uuid' } }],
      ['a $ref to a plain component', ref('Text'), { Text: string }],
      ['limits and a description in a member', { allOf: [string, { description: 'D', maxLength: 3 }] }],
    ];
    const field = await table(rows);
    expect(field).toMatchInlineSnapshot(`
      "date-time: string(date-time)
      int64: integer(int64)
      double: number(double)
      a nullable date: nullable<string(date)>
      a string with no format: string
      a $ref to a formatted component: string(uuid)
      a $ref to a plain component: string
      limits and a description in a member: string{"maxLength":3}"
    `);
    for (const site of SITES) expect(await table(rows, '3.1.0', site), site.name).toBe(field);
  });

  it('parses the members no reader reads as a schema as it did', async () => {
    // Every value kind where a member, a branch or a format goes: what parsed
    // before parses still, and is typed as before.
    expect(
      await table([
        ['true as a member', { allOf: [string, true, { format: 'date-time' }] }],
        ['a number as a member', { allOf: [string, 5, { format: 'date-time' }] }],
        ['a list as a member', { allOf: [string, [], { format: 'date-time' }] }],
        [
          'a component that reaches itself, a format beside it',
          { ...ref('Loop'), format: 'date-time' },
          { Loop: { allOf: [ref('Loop'), { format: 'uuid' }] } },
        ],
        [
          'a pointer to a schema no type is built for, a format beside it',
          { ...pointer('Kind/enum/0'), format: 'date-time' },
          { Kind: { type: 'string', enum: ['a', 'b'] } },
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "true as a member: string(date-time)
      a number as a member: string(date-time)
      a list as a member: string(date-time)
      a component that reaches itself, a format beside it: Loop
      a pointer to a schema no type is built for, a format beside it: unknown"
    `);
  });
});
