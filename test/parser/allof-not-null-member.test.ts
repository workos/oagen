import { describe, it, expect, afterAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import {
  allOfVetoesNull,
  clearSchemaNameTransform,
  declaresNull,
  extractSchemas,
  nullVote,
  pinnedDeclarationAdmitsNull,
  schemaAdmitsNull,
  schemaToTypeRef,
  type SchemaObject,
} from '../../src/parser/schemas.js';
import { cloneTypeRef } from '../../src/parser/inline-models.js';
import { settleDeferredMappingEntries } from '../../src/parser/schema-refs.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #716: since #706 an `allOf` merged into one model admits `null`
 * when every member that types it does, and a member that says nothing of
 * what an instance is has no vote. `{ not: { type: 'null' } }` is such a
 * member, though it is the one that rejects `null` outright, so an `allOf`
 * of nullable components with it was `nullable<…>`, and so was `{ allOf:
 * [{ $ref: Owner }, { not: { type: 'null' } }] }`, a common way to write a
 * use of a nullable component that is never `null`. A `not` whose
 * subschema admits `null` now vetoes it (`vetoesNull`): as a member's vote
 * in a merge (`nullVote`), and for an `allOf` read as one member, whose
 * `null` the rest of the `allOf` takes away (`allOfVetoesNull`).
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-716-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}
const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeDoc(doc));

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

/** `schema` admitting `null` in the version's own spelling: a type list naming it, or `nullable: true` beside the `type`. */
const nullable = (openapi: Version, type: string, schema: Record<string, unknown> = {}) => ({
  ...(openapi === '3.0.3' ? { type, nullable: true } : { type: [type, 'null'] }),
  ...schema,
});
/** An object that admits `null`, with one optional string field. */
const nullableObject = (openapi: Version, field: string) =>
  nullable(openapi, 'object', { properties: { [field]: string } });

const Owner = ref('Owner');
const Tag = ref('Tag');
const Plain = ref('Plain');
/** The issue's member. */
const notNull = { not: { type: 'null' } };

/**
 * The issue's document: `Owner { name }` and `Tag { label }`, both nullable
 * objects, a `Plain { id }` that admits no `null`, and `GET /pets/{petId}`
 * (`getPet`) returning `$ref: Pet`, beside `schemas`.
 */
const document = (
  openapi: Version,
  schemas: Record<string, unknown>,
  paths: Record<string, unknown> = {},
  more: Record<string, unknown> = {},
) => ({
  openapi,
  info: { title: 'Repro', version: '1.0.0' },
  paths: {
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: string }],
        responses: { '200': { description: 'ok', ...json(ref('Pet')) } },
      },
    },
    ...paths,
  },
  components: {
    schemas: {
      Owner: nullableObject(openapi, 'name'),
      Tag: nullableObject(openapi, 'label'),
      Plain: { type: 'object', properties: { id: string } },
      ...schemas,
    },
  },
  ...more,
});

/** `Pet.owner` written as `owner`, beside `schemas`. */
const ownerDoc = (openapi: Version, owner: unknown, schemas: Record<string, unknown> = {}) =>
  document(openapi, { Pet: { type: 'object', properties: { owner } }, ...schemas });
/** The issue's `repro.json` and `one.json`. */
const reproDoc = (openapi: Version) => ownerDoc(openapi, { allOf: [Owner, Tag, notNull] });
const oneDoc = (openapi: Version) => ownerDoc(openapi, { allOf: [Owner, notNull] });
/** `Pet` as an `allOf` of members, each declaring `owner` as one of `declarations`. */
const membersDoc = (openapi: Version, declarations: unknown[], schemas: Record<string, unknown> = {}) =>
  document(openapi, {
    Pet: { allOf: declarations.map((owner) => ({ type: 'object', properties: { owner } })) },
    ...schemas,
  });

const modelOf = (spec: ApiSpec, name: string) => spec.models.find((m) => m.name === name);
const fieldNames = (spec: ApiSpec, name: string) => modelOf(spec, name)?.fields.map((f) => f.name);
const fieldType = (spec: ApiSpec, name: string, field: string) =>
  modelOf(spec, name)?.fields.find((f) => f.name === field)?.type;
const operations = (spec: ApiSpec): Operation[] => spec.services.flatMap((s) => s.operations);
const operation = (spec: ApiSpec, name: string) => operations(spec).find((op) => op.name === name)!;

/** A type in a word: `nullable<PetOwner>`, `PetOwner[]`, `string`; a model or enum as `named` words it. */
const show = (type: TypeRef | undefined, named: (name: string) => string = (name) => name): string => {
  if (!type) return 'none';
  switch (type.kind) {
    case 'nullable':
      return `nullable<${show(type.inner, named)}>`;
    case 'array':
      return type.items.kind === 'union' ? `(${show(type.items, named)})[]` : `${show(type.items, named)}[]`;
    case 'map':
      return `map<${show(type.valueType, named)}>`;
    case 'union':
      return type.variants.map((variant) => show(variant, named)).join(' | ');
    case 'primitive':
      return type.type;
    case 'literal':
      return JSON.stringify(type.value);
    default:
      return named(type.name);
  }
};

/** The issue's script: each field of `Pet` with its type. */
const script = (spec: ApiSpec): string =>
  modelOf(spec, 'Pet')!
    .fields.map(({ name, type }) => `${name}: ${show(type)}`)
    .join(', ');

/** `Pet.owner` written as `owner`: its type, and the fields of the model it mints. */
async function ownerOf(openapi: Version, owner: unknown, schemas: Record<string, unknown> = {}): Promise<string> {
  const spec = await parse(ownerDoc(openapi, owner, schemas));
  const type = fieldType(spec, 'Pet', 'owner');
  const named = type?.kind === 'nullable' ? type.inner : type;
  const fields =
    named?.kind === 'model' && named.name === 'PetOwner' ? ` { ${fieldNames(spec, 'PetOwner')?.join(', ')} }` : '';
  return `${show(type)}${fields}`;
}
type Row = readonly [string, unknown, Record<string, unknown>?];
const table = async (openapi: Version, rows: readonly Row[]): Promise<string> => {
  const lines: string[] = [];
  for (const [label, owner, schemas] of rows) lines.push(`${label}: ${await ownerOf(openapi, owner, schemas)}`);
  return lines.join('\n');
};
/** Each `member`, written as the third member of `repro.json` and as the second of `one.json`. */
const bothTable = async (openapi: Version, rows: readonly Row[]): Promise<string> => {
  const lines: string[] = [];
  for (const [label, member, schemas] of rows) {
    const merged = await ownerOf(openapi, { allOf: [Owner, Tag, member] }, schemas);
    const one = await ownerOf(openapi, { allOf: [Owner, member] }, schemas);
    lines.push(`${label}: ${merged} and ${one}`);
  }
  return lines.join('\n');
};

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

/** The two documents parse to one IR and `oagen diff` between them exits 0, in either direction. */
async function expectNoDiff(first: unknown, second: unknown, label = ''): Promise<void> {
  const [firstSpec, secondSpec] = [await parse(first), await parse(second)];
  expect(diffSpecs(firstSpec, secondSpec).changes, label).toEqual([]);
  expect(diffSpecs(secondSpec, firstSpec).changes, label).toEqual([]);
  expect(await diffExit(first, second), label).toBe(0);
  expect(await diffExit(second, first), label).toBe(0);
}

describe('#716 an `allOf` member `not: { type: null }` rejects `null`', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it("types the issue's `repro.json` and `one.json` as models that admit no `null` (the issue's script)", async () => {
      const repro = await parse(reproDoc(openapi));
      const one = await parse(oneDoc(openapi));
      // The issue's output was `repro.json owner: nullable<PetOwner>` and `one.json owner: nullable<Owner>`.
      expect(`repro.json ${script(repro)}`).toBe('repro.json owner: PetOwner');
      expect(`one.json ${script(one)}`).toBe('one.json owner: Owner');
      // The models are the ones the same members give without the `not`: only the `null` goes.
      expect(fieldNames(repro, 'PetOwner')).toEqual(['name', 'label']);
      expect(one.models.map((m) => m.name)).toEqual(['Owner', 'Tag', 'Plain', 'Pet']);
      expect(warnings()).toEqual([]);
    });

    it('leaves the same members without the `not` nullable, as they were', async () => {
      expect(
        await table(openapi, [
          ['two nullable components', { allOf: [Owner, Tag] }],
          ['one', { allOf: [Owner] }],
          ['beside a member that only annotates', { allOf: [Owner, Tag, { description: 'Both.' }] }],
        ]),
      ).toMatchInlineSnapshot(`
        "two nullable components: nullable<PetOwner> { name, label }
        one: nullable<Owner>
        beside a member that only annotates: nullable<PetOwner> { name, label }"
      `);
    });

    it('reads every variation the issue lists', async () => {
      expect(
        await table(openapi, [
          ['`{ not: { const: null } }` in place of the member', { allOf: [Owner, Tag, { not: { const: null } }] }],
          ['`{ not: { enum: [null] } }` in its place', { allOf: [Owner, Tag, { not: { enum: [null] } }] }],
          ['the `not` written beside the `allOf`', { allOf: [Owner, Tag], not: { type: 'null' } }],
          ['beside the `allOf` of one', { allOf: [Owner], not: { type: 'null' } }],
          ['the `allOf` as a component', ref('OwnerTag'), { OwnerTag: { allOf: [Owner, Tag, notNull] } }],
          [
            'the component with the `not` beside its `allOf`',
            ref('OwnerTag'),
            { OwnerTag: { allOf: [Owner, Tag], not: { type: 'null' } } },
          ],
          ['`one.json` as a component', ref('NonNullOwner'), { NonNullOwner: { allOf: [Owner, notNull] } }],
        ]),
      ).toMatchInlineSnapshot(`
        "\`{ not: { const: null } }\` in place of the member: PetOwner { name, label }
        \`{ not: { enum: [null] } }\` in its place: PetOwner { name, label }
        the \`not\` written beside the \`allOf\`: PetOwner { name, label }
        beside the \`allOf\` of one: Owner
        the \`allOf\` as a component: OwnerTag
        the component with the \`not\` beside its \`allOf\`: OwnerTag
        \`one.json\` as a component: NonNullOwner"
      `);
      // As a request body and as a response body, by a `$ref` to the component and written in place.
      const spec = await parse(
        document(
          openapi,
          { OwnerTag: { allOf: [Owner, Tag, notNull] }, Pet: { type: 'object', properties: {} } },
          {
            '/component': {
              put: {
                operationId: 'putComponent',
                requestBody: json(ref('OwnerTag')),
                responses: { '200': { description: 'ok', ...json(ref('OwnerTag')) } },
              },
            },
            '/inline': {
              put: {
                operationId: 'putInline',
                requestBody: json({ allOf: [Owner, Tag, notNull] }),
                responses: { '200': { description: 'ok', ...json({ allOf: [Owner, Tag, notNull] }) } },
              },
            },
          },
        ),
      );
      const bodies = ['putComponent', 'putInline'].map((name) => {
        const op = operation(spec, name);
        return `${name}: ${show(op.requestBody)} -> ${show(op.response)}`;
      });
      expect(bodies).toMatchInlineSnapshot(`
        [
          "putComponent: OwnerTag -> OwnerTag",
          "putInline: PutInlineRequest -> PutInlineResponse",
        ]
      `);
    });

    it('reads the veto wherever the member stands, beside one, two or three nullable components', async () => {
      const Third = { Third: nullableObject(openapi, 'third') };
      expect(
        await table(openapi, [
          ['first of two', { allOf: [notNull, Owner] }],
          ['last of two', { allOf: [Owner, notNull] }],
          ['first of three', { allOf: [notNull, Owner, Tag] }],
          ['in the middle', { allOf: [Owner, notNull, Tag] }],
          ['last of three', { allOf: [Owner, Tag, notNull] }],
          ['first of four', { allOf: [notNull, Owner, Tag, ref('Third')] }, Third],
          ['second of four', { allOf: [Owner, notNull, Tag, ref('Third')] }, Third],
          ['third of four', { allOf: [Owner, Tag, notNull, ref('Third')] }, Third],
          ['last of four', { allOf: [Owner, Tag, ref('Third'), notNull] }, Third],
          ['twice', { allOf: [notNull, Owner, Tag, notNull] }],
          // Beside a member that rejects `null` by its own `type` the `allOf` was bare, and stays so.
          ['beside a `$ref` that admits no `null`', { allOf: [Owner, Plain, notNull] }],
          ['before a `$ref` that admits no `null`', { allOf: [notNull, Owner, Plain] }],
          ['beside an inline object', { allOf: [Owner, { type: 'object', properties: { extra: string } }, notNull] }],
        ]),
      ).toMatchInlineSnapshot(`
        "first of two: Owner
        last of two: Owner
        first of three: PetOwner { name, label }
        in the middle: PetOwner { name, label }
        last of three: PetOwner { name, label }
        first of four: PetOwner { name, label, third }
        second of four: PetOwner { name, label, third }
        third of four: PetOwner { name, label, third }
        last of four: PetOwner { name, label, third }
        twice: PetOwner { name, label }
        beside a \`$ref\` that admits no \`null\`: PetOwner { name, id }
        before a \`$ref\` that admits no \`null\`: PetOwner { name, id }
        beside an inline object: PetOwner { name, extra }"
      `);
    });

    it('vetoes `null` exactly when the subschema of the `not` admits it', async () => {
      const schemas = {
        Null: { type: 'null' },
        NullAlias: { allOf: [ref('Null')] },
        BareAlias: ref('Null'),
        Described: { description: 'Says nothing.' },
        NotNull: notNull,
        NonNullOwner: { allOf: [Owner, notNull] },
      };
      const rows = (subschemas: ReadonlyArray<readonly [string, unknown]>): Row[] =>
        subschemas.map(([label, not]): Row => [label, { not }, schemas]);
      // A subschema that admits `null`, as the type builder types it: `null` fails the `not`.
      const vetoes = await bothTable(
        openapi,
        rows([
          ["`{ type: 'null' }`", { type: 'null' }],
          ["`{ type: ['null'] }`", { type: ['null'] }],
          ['`{ const: null }`', { const: null }],
          ['`{ enum: [null] }`', { enum: [null] }],
          ["a type list naming `null` among others: `{ type: ['null', 'string'] }`", { type: ['null', 'string'] }],
          ["an `enum:` list naming it: `{ enum: [null, 'x'] }`", { enum: [null, 'x'] }],
          ['OAS 3.0 `nullable: true` beside a `type`', { type: 'string', nullable: true }],
          ['a `oneOf` with a `null` variant', { oneOf: [{ type: 'null' }, string] }],
          ['an `anyOf` with a `null` variant', { anyOf: [string, { type: 'null' }] }],
          ['a `oneOf` under OAS 3.0 `nullable: true`', { oneOf: [string], nullable: true }],
          ['`{ $ref: Null }`', ref('Null')],
          ['a `$ref` to an `allOf` alias of `Null`', ref('NullAlias')],
          ['a `$ref` to a bare alias of `Null`', ref('BareAlias')],
          ['a `$ref` to a nullable component: `{ $ref: Owner }`', Owner],
          ['an `allOf` around a `null` schema', { allOf: [{ type: 'null' }] }],
          ['an `allOf` of two nullable components', { allOf: [Owner, Tag] }],
          ['a documented `null` schema', { description: 'Null.', type: 'null' }],
        ]),
      );
      expect(vetoes.split('\n').filter((line) => !line.endsWith(': PetOwner { name, label } and Owner'))).toEqual([]);
      // A subschema that admits none: one that rejects it, and one that says nothing of what an instance is.
      const none = await bothTable(
        openapi,
        rows([
          ["`{ type: 'string' }`", string],
          ["`{ type: 'object' }`", { type: 'object' }],
          ['`{}`', {}],
          ['`{ minLength: 3 }`', { minLength: 3 }],
          ['`{ description }`', { description: 'Nothing.' }],
          ["`{ required: ['name'] }`", { required: ['name'] }],
          ['a double negation', { not: { type: 'null' } }],
          ['a triple negation', { not: { not: { type: 'null' } } }],
          ['a `$ref` to a component that writes the `not`', ref('NotNull')],
          ['a `$ref` to a component that admits no `null`', Plain],
          ['a `$ref` to a component that says nothing', ref('Described')],
          ['a `$ref` to `NonNullOwner`, a nullable component under the veto', ref('NonNullOwner')],
          ['an `allOf` that vetoes `null` itself', { allOf: [Owner, notNull] }],
          ['an `allOf` beside a member that admits none', { allOf: [Owner, Plain] }],
          ['a union with no `null` variant', { oneOf: [string, { type: 'integer' }] }],
        ]),
      );
      expect(
        none.split('\n').filter((line) => !line.endsWith(': nullable<PetOwner> { name, label } and nullable<Owner>')),
      ).toEqual([]);
      expect(vetoes.split('\n')).toHaveLength(17);
      expect(none.split('\n')).toHaveLength(15);
      expect(warnings()).toEqual([]);
    });

    it('reads no veto off a `not` that holds no schema', async () => {
      const lines = await bothTable(openapi, [
        ['`not: true`', { not: true }],
        ['`not: false`', { not: false }],
        ['`not: null`', { not: null }],
        ['a list', { not: [{ type: 'null' }] }],
        ['a string', { not: 'null' }],
      ]);
      expect(
        lines.split('\n').filter((line) => !line.endsWith(': nullable<PetOwner> { name, label } and nullable<Owner>')),
      ).toEqual([]);
    });

    it('holds beside a member that is no Schema Object, which has no vote and writes no `not`', async () => {
      // A JSON Schema boolean, or anything else a document writes where a schema goes, abstains (#715), so the
      // `allOf` is what its other members make it: nullable without the `not`, bare with it.
      const lines: string[] = [];
      for (const member of [true, false, 5, 'x', [notNull]] as unknown[]) {
        const word = JSON.stringify(member);
        const merged = await ownerOf(openapi, { allOf: [Owner, Tag, member, notNull] });
        const one = await ownerOf(openapi, { allOf: [Owner, member, notNull] });
        const wrapped = await ownerOf(openapi, { allOf: [Owner, { allOf: [member], not: { type: 'null' } }] });
        expect(await ownerOf(openapi, { allOf: [Owner, Tag, member] }), word).toBe(
          'nullable<PetOwner> { name, label }',
        );
        expect(await ownerOf(openapi, { allOf: [Owner, member] }), word).toBe('nullable<Owner>');
        // Under the `not`, a member that is no Schema Object says nothing either: the subschema admits `null`.
        expect(
          await ownerOf(openapi, { allOf: [Owner, Tag, { not: { allOf: [member, { type: 'null' }] } }] }),
          word,
        ).toBe('PetOwner { name, label }');
        lines.push(`${word}: ${merged}, ${one}, ${wrapped}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "true: PetOwner { name, label }, Owner, Owner
        false: PetOwner { name, label }, Owner, Owner
        5: PetOwner { name, label }, Owner, Owner
        "x": PetOwner { name, label }, Owner, Owner
        [{"not":{"type":"null"}}]: PetOwner { name, label }, Owner, Owner"
      `);
    });

    it('casts the same vote however the member is written: inline, a `$ref`, an alias, a wrapper', async () => {
      const schemas = {
        NotNull: notNull,
        BareAlias: ref('NotNull'),
        AllOfAlias: { allOf: [ref('NotNull')] },
        Holder: { type: 'object', properties: { never: notNull } },
      };
      expect(
        await bothTable(openapi, [
          ['inline', notNull],
          ['documented', { description: 'Never null.', not: { type: 'null' } }],
          ['a `$ref` to `NotNull: { not: { type: null } }`', ref('NotNull'), schemas],
          ['a `$ref` to a bare alias of it', ref('BareAlias'), schemas],
          ['a `$ref` to an `allOf` alias of it', ref('AllOfAlias'), schemas],
          [
            'a JSON Pointer to a field that writes it',
            { $ref: '#/components/schemas/Holder/properties/never' },
            schemas,
          ],
          ['wrapped in an `allOf`', { allOf: [notNull] }],
          ['wrapped twice', { allOf: [{ allOf: [notNull] }] }],
          ['in a documented wrapper', { description: 'Outer.', allOf: [notNull] }],
          ['beside a wrapper around a `description`', { not: { type: 'null' }, allOf: [{ description: 'Inner.' }] }],
          ['beside an empty `allOf`', { not: { type: 'null' }, allOf: [] }],
          ['in a wrapper beside another `not`', { not: string, allOf: [notNull] }],
          ['in a wrapper around the `$ref`, beside another `not`', { not: string, allOf: [ref('NotNull')] }, schemas],
          ['beside a `type` that names no `null`', { type: 'object', not: { type: 'null' } }],
        ]),
      ).toMatchInlineSnapshot(`
        "inline: PetOwner { name, label } and Owner
        documented: PetOwner { name, label } and Owner
        a \`$ref\` to \`NotNull: { not: { type: null } }\`: PetOwner { name, label } and PetOwner { name }
        a \`$ref\` to a bare alias of it: PetOwner { name, label } and PetOwner { name }
        a \`$ref\` to an \`allOf\` alias of it: PetOwner { name, label } and PetOwner { name }
        a JSON Pointer to a field that writes it: PetOwner { name, label } and PetOwner { name }
        wrapped in an \`allOf\`: PetOwner { name, label } and Owner
        wrapped twice: PetOwner { name, label } and Owner
        in a documented wrapper: PetOwner { name, label } and Owner
        beside a wrapper around a \`description\`: PetOwner { name, label } and Owner
        beside an empty \`allOf\`: PetOwner { name, label } and Owner
        in a wrapper beside another \`not\`: PetOwner { name, label } and Owner
        in a wrapper around the \`$ref\`, beside another \`not\`: PetOwner { name, label } and Owner
        beside a \`type\` that names no \`null\`: PetOwner { name, label } and PetOwner { name }"
      `);
      // The inline and the `$ref` spelling of the member are one IR.
      await expectNoDiff(
        ownerDoc(openapi, { allOf: [Owner, Tag, notNull] }, schemas),
        ownerDoc(openapi, { allOf: [Owner, Tag, ref('NotNull')] }, schemas),
      );
      expect(warnings()).toEqual([]);
    });

    it('takes the `null` away from whatever member the `allOf` is read as', async () => {
      const array = nullable(openapi, 'array', { items: string });
      const kind = nullable(openapi, 'string', { enum: ['cat', 'dog', null] });
      const schemas = {
        Names: array,
        Word: nullable(openapi, 'string'),
        Kind: kind,
        AnyOwner: { oneOf: [Plain, Owner, ...(openapi === '3.0.3' ? [] : [{ type: 'null' }])], nullable: true },
      };
      const members: ReadonlyArray<readonly [string, unknown]> = [
        ['a `$ref` to a nullable object', Owner],
        ['a `$ref` to a nullable enum', ref('Kind')],
        ['a `$ref` to a nullable array component', ref('Names')],
        ['a `$ref` to a nullable primitive component', ref('Word')],
        ['a `$ref` to a union component with a `null` variant', ref('AnyOwner')],
        ['a nullable string', nullable(openapi, 'string')],
        ['a nullable array', array],
        ['a nullable map', nullable(openapi, 'object', { additionalProperties: string })],
        ['a nullable inline object', nullableObject(openapi, 'extra')],
        ['a nullable inline enum', kind],
        ['an `enum:` list naming `null`', { enum: ['a', null] }],
        ['a nullable wrapper around a `$ref`', { oneOf: [Plain, { type: 'null' }] }],
        ['a union with a `null` variant', { oneOf: [string, { type: 'integer' }, { type: 'null' }] }],
        ['a wrapper around a `$ref`', { allOf: [Owner] }],
      ];
      const lines: string[] = [];
      for (const [label, member] of members) {
        const without = show(fieldType(await parse(ownerDoc(openapi, { allOf: [member] }, schemas)), 'Pet', 'owner'));
        const withNot = show(
          fieldType(await parse(ownerDoc(openapi, { allOf: [member, notNull] }, schemas)), 'Pet', 'owner'),
        );
        const beside = show(
          fieldType(
            await parse(ownerDoc(openapi, { allOf: [member], not: { type: 'null' } }, schemas)),
            'Pet',
            'owner',
          ),
        );
        // The `not` takes the `nullable` wrapper away and nothing else, as a member and beside the `allOf`.
        expect(`nullable<${withNot}>`, label).toBe(without);
        expect(beside, label).toBe(withNot);
        lines.push(`${label}: ${without} -> ${withNot}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a \`$ref\` to a nullable object: nullable<Owner> -> Owner
        a \`$ref\` to a nullable enum: nullable<Kind> -> Kind
        a \`$ref\` to a nullable array component: nullable<string[]> -> string[]
        a \`$ref\` to a nullable primitive component: nullable<string> -> string
        a \`$ref\` to a union component with a \`null\` variant: nullable<AnyOwner> -> AnyOwner
        a nullable string: nullable<string> -> string
        a nullable array: nullable<string[]> -> string[]
        a nullable map: nullable<map<string>> -> map<string>
        a nullable inline object: nullable<PetOwner> -> PetOwner
        a nullable inline enum: nullable<PetOwner> -> PetOwner
        an \`enum:\` list naming \`null\`: nullable<"a"> -> "a"
        a nullable wrapper around a \`$ref\`: nullable<Plain> -> Plain
        a union with a \`null\` variant: nullable<string | integer> -> string | integer
        a wrapper around a \`$ref\`: nullable<Owner> -> Owner"
      `);
      expect(warnings()).toEqual([]);
    });

    it('leaves the member it is read as its `null` where nothing but a `type` rejects it', async () => {
      expect(
        await table(openapi, [
          // The reading #706 left as it was: only a `not` takes the `null` of the one member away.
          ['`type: object` beside the `allOf`', { type: 'object', allOf: [Owner] }],
          ['`type: object` beside the `allOf`, and the `not`', { type: 'object', allOf: [Owner, notNull] }],
          ['a member typed `string` beside the reference', { allOf: [Owner, string] }],
          [
            'that member with the `not` beside its `type`',
            { allOf: [Owner, { type: 'string', not: { type: 'null' } }] },
          ],
          ['a union of limits holding the `not`', { allOf: [Owner, { anyOf: [notNull, notNull] }] }],
        ]),
      ).toMatchInlineSnapshot(`
        "\`type: object\` beside the \`allOf\`: nullable<Owner>
        \`type: object\` beside the \`allOf\`, and the \`not\`: Owner
        a member typed \`string\` beside the reference: nullable<Owner>
        that member with the \`not\` beside its \`type\`: Owner
        a union of limits holding the \`not\`: nullable<Owner>"
      `);
    });

    it("keeps a nullable wrapper the schema writes itself: the schema's own word", async () => {
      const own = nullable(openapi, 'object');
      expect(
        await table(openapi, [
          // The wrapper is read before the `allOf` is, and wraps what the `allOf` describes.
          ['a nullable `type` beside the merge and the member', { ...own, allOf: [Owner, Tag, notNull] }],
          ['a nullable `type` beside the merge and the `not`', { ...own, allOf: [Owner, Tag], not: { type: 'null' } }],
          ['a nullable `type` beside the reference and the member', { ...own, allOf: [Owner, notNull] }],
          ['a nullable wrapper around the vetoing `allOf`', { oneOf: [{ allOf: [Owner, notNull] }, { type: 'null' }] }],
          [
            'a nullable wrapper around `NonNullOwner`',
            { oneOf: [ref('NonNullOwner'), { type: 'null' }] },
            { NonNullOwner: { allOf: [Owner, notNull] } },
          ],
          // A member that writes `null` itself admits it, whatever `not` it writes beside it.
          ['a member that names `null` in its own `type`', { allOf: [Owner, Tag, { ...own, not: { type: 'null' } }] }],
          // OAS 3.0 `nullable: true` with no `type` declares nothing, so the veto stands.
          ['`nullable: true` with no `type` beside the `allOf`', { nullable: true, allOf: [Owner, Tag, notNull] }],
        ]),
      ).toMatchInlineSnapshot(`
        "a nullable \`type\` beside the merge and the member: nullable<PetOwner> { name, label }
        a nullable \`type\` beside the merge and the \`not\`: nullable<PetOwner> { name, label }
        a nullable \`type\` beside the reference and the member: nullable<Owner>
        a nullable wrapper around the vetoing \`allOf\`: nullable<Owner>
        a nullable wrapper around \`NonNullOwner\`: nullable<NonNullOwner>
        a member that names \`null\` in its own \`type\`: nullable<PetOwner> { name, label }
        \`nullable: true\` with no \`type\` beside the \`allOf\`: PetOwner { name, label }"
      `);
    });

    it('wraps no reference to a component that vetoes `null`, nor to an alias of one', async () => {
      const spec = await parse(
        document(openapi, {
          OwnerTag: { allOf: [Owner, Tag, notNull] },
          NonNullOwner: { allOf: [Owner, notNull] },
          BareAlias: ref('NonNullOwner'),
          AllOfAlias: { allOf: [ref('NonNullOwner'), { description: 'An owner.' }] },
          Nullable: { allOf: [Owner, { description: 'An owner.' }] },
          Kind: nullable(openapi, 'string', { enum: ['cat', 'dog', null] }),
          NonNullKind: { allOf: [ref('Kind'), notNull] },
          Pet: {
            type: 'object',
            properties: {
              merge: ref('OwnerTag'),
              one: ref('NonNullOwner'),
              bare_alias: ref('BareAlias'),
              all_of_alias: ref('AllOfAlias'),
              still_nullable: ref('Nullable'),
              kind: ref('NonNullKind'),
              merged_again: { allOf: [ref('NonNullOwner'), Tag] },
              wrapped_again: { oneOf: [ref('NonNullOwner'), { type: 'null' }] },
            },
          },
        }),
      );
      expect(script(spec).split(', ')).toMatchInlineSnapshot(`
        [
          "merge: OwnerTag",
          "one: NonNullOwner",
          "bare_alias: BareAlias",
          "all_of_alias: AllOfAlias",
          "still_nullable: nullable<Nullable>",
          "kind: Kind",
          "merged_again: PetMergedAgain",
          "wrapped_again: nullable<NonNullOwner>",
        ]
      `);
      expect(fieldNames(spec, 'NonNullOwner')).toEqual(['name']);
      expect(warnings()).toEqual([]);
    });

    it('reads an enum component declared under an `allOf` that vetoes `null` as an enum that admits none', async () => {
      // Each spelling `isNullableEnumSchema` reads a `null` by, under `{ allOf: [<enum>, { not: { type: null } }] }`.
      const spellings: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ['a type list naming `null`, or the flag', nullable(openapi, 'string', { enum: ['cat', 'dog', null] })],
        ['a `null` in the `enum:` list alone', { enum: ['cat', 'dog', null] }],
        ['a `null` variant among consts', { oneOf: [{ const: 'cat' }, { const: 'dog' }, { type: 'null' }] }],
        ['a nullable wrapper around the enum', { oneOf: [{ type: 'string', enum: ['cat', 'dog'] }, { type: 'null' }] }],
      ];
      const lines: string[] = [];
      for (const [label, kind] of spellings) {
        const read = async (component: unknown): Promise<string> => {
          const spec = await parse(ownerDoc(openapi, ref('Kind'), { Kind: component }));
          const values = spec.enums.find((e) => e.name === 'Kind')?.values.map((value) => value.value);
          return `${show(fieldType(spec, 'Pet', 'owner'))} [${values?.join(', ')}]`;
        };
        const vetoed = await read({ allOf: [kind, notNull] });
        expect(await read({ allOf: [kind], not: { type: 'null' } }), label).toBe(vetoed);
        lines.push(`${label}: ${await read({ allOf: [kind] })} -> ${vetoed}`);
        // The same `allOf` written on the field is the bare enum too.
        const inline = await parse(ownerDoc(openapi, { allOf: [kind, notNull] }));
        expect(fieldType(inline, 'Pet', 'owner'), label).toMatchObject({ kind: 'enum', name: 'PetOwner' });
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a type list naming \`null\`, or the flag: nullable<Kind> [cat, dog] -> Kind [cat, dog]
        a \`null\` in the \`enum:\` list alone: nullable<Kind> [cat, dog] -> Kind [cat, dog]
        a \`null\` variant among consts: nullable<Kind> [cat, dog] -> Kind [cat, dog]
        a nullable wrapper around the enum: nullable<Kind> [cat, dog] -> Kind [cat, dog]"
      `);
    });

    it('keeps a component nullable where it writes a nullable `type` beside the vetoing `allOf`, as the same schema inline is', async () => {
      // Greptile, #726: the enum component read the veto past its own `type`, and was the bare `Kind`.
      const kind = nullable(openapi, 'string', { enum: ['cat', 'dog', null] });
      const schemas = { Names: nullable(openapi, 'array', { items: string }), NullableKind: kind };
      const written: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ['an enum under the `allOf`', { ...nullable(openapi, 'string'), allOf: [kind, notNull] }],
        [
          'an enum, the `not` beside the `allOf`',
          { ...nullable(openapi, 'string'), allOf: [kind], not: { type: 'null' } },
        ],
        ['an alias of an enum component', { ...nullable(openapi, 'string'), allOf: [ref('NullableKind'), notNull] }],
        ['an alias of an object component', { ...nullable(openapi, 'object'), allOf: [Owner, notNull] }],
        ['a merge', { ...nullable(openapi, 'object'), allOf: [Owner, Tag, notNull] }],
        ['an alias of an array component', { ...nullable(openapi, 'array'), allOf: [ref('Names'), notNull] }],
        ['a nullable wrapper around the vetoing `allOf`', { oneOf: [{ allOf: [kind, notNull] }, { type: 'null' }] }],
      ];
      const lines: string[] = [];
      for (const [label, schema] of written) {
        const shape = (type: TypeRef | undefined) => show(type, () => 'named');
        const component = await parse(ownerDoc(openapi, ref('Thing'), { ...schemas, Thing: schema }));
        const inline = await parse(ownerDoc(openapi, schema, schemas));
        // The component and the same schema on the field admit `null` alike.
        expect(shape(fieldType(component, 'Pet', 'owner')), label).toBe(shape(fieldType(inline, 'Pet', 'owner')));
        lines.push(`${label}: ${show(fieldType(component, 'Pet', 'owner'))}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "an enum under the \`allOf\`: nullable<Thing>
        an enum, the \`not\` beside the \`allOf\`: nullable<Thing>
        an alias of an enum component: nullable<NullableKind>
        an alias of an object component: nullable<Thing>
        a merge: nullable<Thing>
        an alias of an array component: nullable<string[]>
        a nullable wrapper around the vetoing \`allOf\`: nullable<Thing>"
      `);
      // Without a `type` of its own the enum component admits none, at any depth of the wrappers.
      const bare = await parse(
        document(openapi, {
          Vetoed: { allOf: [kind, notNull] },
          Nested: { allOf: [{ allOf: [kind, notNull] }], default: 'cat' },
          Pet: { type: 'object', properties: { vetoed: ref('Vetoed'), nested: ref('Nested') } },
        }),
      );
      expect(script(bare)).toBe('vetoed: Vetoed, nested: Nested');
    });

    it('leaves the members of an enum under a vetoing `allOf`, and their descriptions, as they are written', async () => {
      // Greptile, #726: the `null` was taken out of the member lists, so a list of descriptions aligned with them by
      // position described each member by its neighbor's text.
      const spellings: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        [
          'an `enum:` list, `null` first',
          { enum: [null, 'cat', 'dog'], 'x-enum-descriptions': ['Null', 'Cat', 'Dog'] },
        ],
        [
          'an `enum:` list, `null` in the middle, `x-enumDescriptions`',
          { enum: ['cat', null, 'dog'], 'x-enumDescriptions': ['Cat', 'Null', 'Dog'] },
        ],
        [
          'a union of consts, `null` first',
          {
            oneOf: [{ type: 'null' }, { const: 'cat' }, { const: 'dog' }],
            'x-enum-descriptions': ['Null', 'Cat', 'Dog'],
          },
        ],
        [
          'a union of consts beside an `enum:` list',
          {
            enum: ['cat', 'dog', null],
            anyOf: [{ const: 'cat' }, { type: 'null' }, { const: 'dog' }],
            'x-enum-descriptions': ['Cat', 'Null', 'Dog'],
          },
        ],
        ['descriptions by value', { enum: [null, 'cat', 'dog'], 'x-enum-descriptions': { cat: 'Cat', dog: 'Dog' } }],
      ];
      for (const [label, kind] of spellings) {
        const members = async (owner: unknown, schemas: Record<string, unknown>, name: string) => {
          const spec = await parse(ownerDoc(openapi, owner, schemas));
          const values = spec.enums.find((e) => e.name === name)?.values;
          return `${show(fieldType(spec, 'Pet', 'owner'))} ${values?.map((v) => `${v.value}: ${v.description}`).join(', ')}`;
        };
        // As a component, the `not` a member and beside the `allOf`, and written on the field.
        expect(await members(ref('Kind'), { Kind: { allOf: [kind] } }, 'Kind'), label).toBe(
          'nullable<Kind> cat: Cat, dog: Dog',
        );
        expect(await members(ref('Kind'), { Kind: { allOf: [kind, notNull] } }, 'Kind'), label).toBe(
          'Kind cat: Cat, dog: Dog',
        );
        expect(await members(ref('Kind'), { Kind: { allOf: [kind], not: { type: 'null' } } }, 'Kind'), label).toBe(
          'Kind cat: Cat, dog: Dog',
        );
        expect(await members({ allOf: [kind, notNull] }, {}, 'PetOwner'), label).toBe('PetOwner cat: Cat, dog: Dog');
      }
    });

    it('takes the `null` away from a JSON Pointer the `allOf` is read as, once the pointer is settled', async () => {
      // Greptile, #726: a pointer has no type when the `allOf` is typed, so the veto was read too early and the
      // type the pointer settled to kept its `null`.
      const Holder = {
        type: 'object',
        properties: {
          name: nullable(openapi, 'string'),
          names: nullable(openapi, 'array', { items: string }),
          held: nullableObject(openapi, 'held'),
          owner: Owner,
          kind: nullable(openapi, 'string', { enum: ['cat', 'dog', null] }),
          wrapped: { oneOf: [Plain, { type: 'null' }] },
          plain: string,
        },
      };
      const at = (field: string) => ({ $ref: `#/components/schemas/Holder/properties/${field}` });
      const lines: string[] = [];
      for (const field of Object.keys(Holder.properties)) {
        const read = async (owner: unknown) =>
          show(fieldType(await parse(ownerDoc(openapi, owner, { Holder })), 'Pet', 'owner'));
        const alone = await read(at(field));
        const vetoed = await read({ allOf: [at(field), notNull] });
        // First among the members, beside the `allOf`, and around a wrapper: the same type.
        expect(await read({ allOf: [notNull, at(field)] }), field).toBe(vetoed);
        expect(await read({ allOf: [at(field)], not: { type: 'null' } }), field).toBe(vetoed);
        expect(await read({ allOf: [{ allOf: [at(field)] }, notNull] }), field).toBe(vetoed);
        // Without the `not` the `allOf` is what the pointer alone is.
        expect(await read({ allOf: [at(field)] }), field).toBe(alone);
        lines.push(`${field}: ${alone} -> ${vetoed}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "name: nullable<string> -> string
        names: nullable<string[]> -> string[]
        held: nullable<HolderHeld> -> HolderHeld
        owner: nullable<Owner> -> Owner
        kind: nullable<HolderKind> -> HolderKind
        wrapped: nullable<Plain> -> Plain
        plain: string -> string"
      `);
      // At the other sites a schema is typed at, and through a pointer to the field that writes the `allOf`.
      const schema = { allOf: [at('name'), notNull] };
      const spec = await parse(
        document(
          openapi,
          {
            Holder,
            Pet: {
              type: 'object',
              properties: {
                field: schema,
                items: { type: 'array', items: schema },
                values: { type: 'object', additionalProperties: schema },
                pointer: { $ref: '#/components/schemas/Pet/properties/field' },
                wrapped_again: { oneOf: [schema, { type: 'null' }] },
                own_type: { ...nullable(openapi, 'string'), allOf: [at('name'), notNull] },
                merged: { allOf: [at('held'), Tag, notNull] },
              },
            },
          },
          {
            '/names': {
              post: {
                operationId: 'postName',
                parameters: [{ name: 'q', in: 'query', schema }],
                requestBody: json(schema),
                responses: { '200': { description: 'ok', headers: { 'X-Name': { schema } }, ...json(schema) } },
              },
            },
          },
        ),
      );
      const op = operation(spec, 'postName');
      expect([
        ...script(spec).split(', '),
        `query parameter: ${show(op.queryParams[0]?.type)}`,
        `request body: ${show(op.requestBody)}`,
        `response body: ${show(op.response)}`,
        `response header: ${show(op.responseHeaders?.[0]?.type)}`,
      ]).toMatchInlineSnapshot(`
        [
          "field: string",
          "items: string[]",
          "values: map<string>",
          "pointer: string",
          "wrapped_again: nullable<string>",
          "own_type: nullable<string>",
          "merged: PetMerged",
          "query parameter: string",
          "request body: string",
          "response body: string",
          "response header: string",
        ]
      `);
      expect(warnings()).toEqual([]);
    });

    it('takes the `null` a variant admits away from a union the `allOf` is read as, and leaves what a type nests', async () => {
      // Greptile, #726: the `nullable` wrapper was taken off the type alone, so a union kept the `null` one of its
      // variants admits. The `not` is written beside the `allOf` here: beside it as a member, a union of objects
      // is one of the objects the `allOf` merges.
      const text = nullable(openapi, 'string');
      const integer = { type: 'integer' };
      const schemas = {
        Holder: { type: 'object', properties: { name: text, either: { oneOf: [Owner, integer] } } },
        Shapes: { oneOf: [Plain, Tag] },
      };
      const name = { $ref: '#/components/schemas/Holder/properties/name' };
      const unions: ReadonlyArray<readonly [string, unknown]> = [
        ['a nullable primitive variant', { anyOf: [text, integer] }],
        ['two `$ref`s to nullable components', { oneOf: [Owner, Tag] }],
        ['a `null` variant and a nullable one', { oneOf: [Plain, Tag, { type: 'null' }] }],
        ['a nullable inline object variant', { oneOf: [nullableObject(openapi, 'extra'), integer] }],
        ['a union nested in a variant', { oneOf: [Plain, { anyOf: [Owner, integer] }] }],
        ['a variant that is a pointer to a nullable field', { oneOf: [name, integer] }],
        ['no variant that admits `null`', { oneOf: [Plain, integer] }],
        // What a variant nests is not the value itself: the items and the values keep their own `null`.
        ['an array of nullable items', { oneOf: [{ type: 'array', items: text }, integer] }],
        ['a map of nullable values', { oneOf: [{ type: 'object', additionalProperties: text }, integer] }],
        // Two variants alike once the `null` is gone stay two, as two written alike are.
        ['a nullable string beside a string', { anyOf: [text, string] }],
      ];
      const lines: string[] = [];
      for (const [label, union] of unions) {
        const read = async (owner: unknown) =>
          show(fieldType(await parse(ownerDoc(openapi, owner, schemas)), 'Pet', 'owner'));
        lines.push(`${label}: ${await read(union)} -> ${await read({ allOf: [union], not: { type: 'null' } })}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a nullable primitive variant: nullable<string> | integer -> string | integer
        two \`$ref\`s to nullable components: nullable<Owner> | nullable<Tag> -> Owner | Tag
        a \`null\` variant and a nullable one: nullable<Plain | nullable<Tag>> -> Plain | Tag
        a nullable inline object variant: nullable<PetOwner> | integer -> PetOwner | integer
        a union nested in a variant: Plain | nullable<Owner> | integer -> Plain | Owner | integer
        a variant that is a pointer to a nullable field: nullable<string> | integer -> string | integer
        no variant that admits \`null\`: Plain | integer -> Plain | integer
        an array of nullable items: nullable<string>[] | integer -> nullable<string>[] | integer
        a map of nullable values: map<nullable<string>> | integer -> map<nullable<string>> | integer
        a nullable string beside a string: nullable<string> | string -> string | string"
      `);
      // The member beside a union of primitives, a pointer that lands on such a union, and a parameter.
      const spec = await parse(
        document(
          openapi,
          {
            ...schemas,
            Pet: {
              type: 'object',
              properties: {
                member: { allOf: [{ anyOf: [text, integer] }, notNull] },
                landed: { allOf: [{ $ref: '#/components/schemas/Holder/properties/either' }, notNull] },
                items: { type: 'array', items: { allOf: [{ anyOf: [text, integer] }, notNull] } },
                wrapped_again: { oneOf: [{ allOf: [{ anyOf: [text, integer] }, notNull] }, { type: 'null' }] },
                // A union component is a model of its own: the reference admits no `null`, its variants are its own.
                component: { allOf: [ref('Shapes'), notNull] },
              },
            },
          },
          {
            '/unions': {
              get: {
                operationId: 'getUnion',
                parameters: [{ name: 'q', in: 'query', schema: { allOf: [{ anyOf: [text, integer] }, notNull] } }],
                responses: { '200': { description: 'ok', ...json(Plain) } },
              },
            },
          },
        ),
      );
      expect([
        ...script(spec).split(', '),
        `query parameter: ${show(operation(spec, 'getUnion').queryParams[0]?.type)}`,
      ]).toMatchInlineSnapshot(`
        [
          "member: string | integer",
          "landed: Owner | integer",
          "items: (string | integer)[]",
          "wrapped_again: nullable<string | integer>",
          "component: Shape",
          "query parameter: string | integer",
        ]
      `);
      expect(warnings()).toEqual([]);
    });
  });
});

describe('#716 at every site', () => {
  /** One document that writes `schema` at every site a schema is typed at. */
  const sitesDoc = (openapi: Version, schema: unknown) =>
    document(
      openapi,
      {
        ByHand: schema,
        ByHandAlias: { allOf: [ref('ByHand')] },
        Pet: {
          type: 'object',
          properties: {
            field: schema,
            component: ref('ByHand'),
            alias: ref('ByHandAlias'),
            items: { type: 'array', items: schema },
            values: { type: 'object', additionalProperties: schema },
            variant: { oneOf: [schema, { type: 'integer' }] },
            lone_wrapper: { allOf: [schema] },
            documented_wrapper: { allOf: [schema, { description: 'Outer.' }] },
            pointer: { $ref: '#/components/schemas/Pet/properties/field' },
          },
        },
      },
      {
        '/sites': {
          post: {
            operationId: 'postSites',
            parameters: [
              { name: 'q', in: 'query', schema },
              { name: 'X-In', in: 'header', schema },
              { name: 'c', in: 'cookie', schema },
            ],
            requestBody: json(schema),
            responses: {
              '200': { description: 'ok', headers: { 'X-Out': { schema } }, ...json(schema) },
              '404': { description: 'no', ...json(schema) },
              default: { description: 'other', ...json(schema) },
            },
            callbacks: {
              onEvent: {
                '{$request.body#/url}': {
                  post: { requestBody: json(schema), responses: { '200': { description: 'ok' } } },
                },
              },
            },
          },
        },
        '/things': {
          get: {
            operationId: 'listThings',
            parameters: [{ name: 'after', in: 'query', schema: string }],
            responses: {
              '200': {
                description: 'ok',
                ...json({
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: schema },
                    list_metadata: { type: 'object', properties: { after: string } },
                  },
                }),
              },
            },
          },
        },
        '/component': {
          put: {
            operationId: 'putComponent',
            requestBody: json(ref('ByHand')),
            responses: { '200': { description: 'ok', ...json(ref('ByHand')) } },
          },
        },
      },
      openapi === '3.1.0'
        ? {
            webhooks: {
              thingChanged: { post: { requestBody: json(schema), responses: { '200': { description: 'ok' } } } },
            },
          }
        : {},
    );

  /** Every site's type, one per line: the shape alone, since the model each site mints is named by that site. */
  async function sites(openapi: Version, schema: unknown): Promise<string> {
    const spec = await parse(sitesDoc(openapi, schema));
    const pet = modelOf(spec, 'Pet')!;
    const op = operation(spec, 'postSites');
    const put = operation(spec, 'putComponent');
    const lines: Array<[string, TypeRef | undefined]> = [
      ...pet.fields.map((f): [string, TypeRef] => [f.name, f.type]),
      ['query parameter', op.queryParams[0]?.type],
      ['header parameter', op.headerParams[0]?.type],
      ['cookie parameter', op.cookieParams?.[0]?.type],
      ['request body', op.requestBody],
      ['response body', op.response],
      ['response header', op.responseHeaders?.[0]?.type],
      ['error body', op.errors[0]?.type],
      ['default response', op.defaultResponse?.type],
      ['callback body', op.callbacks?.[0]?.requestBody],
      ['list item', operation(spec, 'listThings').pagination?.itemType],
      ['component as a request body', put.requestBody],
      ['component as a response body', put.response],
      ...(openapi === '3.1.0'
        ? [['webhook payload', spec.webhooks?.[0]?.requestBody] as [string, TypeRef | undefined]]
        : []),
    ];
    const word = (type: TypeRef | undefined) => show(type, () => 'named');
    return lines.map(([site, type]) => `${site}: ${word(type)}`).join('\n');
  }

  /** The readings of an `allOf`, each admitting `null` without the `not`. */
  const readings = (openapi: Version): ReadonlyArray<readonly [string, unknown[]]> => [
    ['a merge', [Owner, Tag]],
    ['a reference', [Owner]],
    ['a nullable inline object', [nullableObject(openapi, 'extra')]],
    ['a nullable array', [nullable(openapi, 'array', { items: string })]],
    ['a nullable string', [nullable(openapi, 'string')]],
  ];

  it.each(VERSIONS)(
    'admits no `null` wherever the `allOf` is written, whatever it is read as (%s)',
    async (openapi) => {
      for (const [label, members] of readings(openapi)) {
        const without = await sites(openapi, { allOf: members });
        const vetoed = await sites(openapi, { allOf: [...members, notNull] });
        // No site is nullable, and every site is what it was without the wrapper.
        expect(
          vetoed.split('\n').filter((line) => line.includes('nullable')),
          label,
        ).toEqual([]);
        expect(vetoed, label).toBe(without.replace(/nullable<([^>]*)>/g, '$1'));
        // The issue's two spellings were nullable at every site.
        if (members.every((member) => member === Owner || member === Tag)) {
          expect(
            without.split('\n').filter((line) => !line.includes('nullable<')),
            label,
          ).toEqual([]);
        }
        // The `not` beside the `allOf`, first among the members, and as a `$ref`: site for site the same.
        expect(await sites(openapi, { allOf: members, not: { type: 'null' } }), label).toBe(vetoed);
        expect(await sites(openapi, { allOf: [notNull, ...members] }), label).toBe(vetoed);
      }
      expect(warnings()).toEqual([]);
    },
  );

  it('lists every site of the merge and of the reference (3.1.0)', async () => {
    expect(await sites('3.1.0', { allOf: [Owner, Tag, notNull] })).toMatchInlineSnapshot(`
      "field: named
      component: named
      alias: named
      items: named[]
      values: map<named>
      variant: named | integer
      lone_wrapper: named
      documented_wrapper: named
      pointer: named
      query parameter: named
      header parameter: named
      cookie parameter: named
      request body: named
      response body: named
      response header: named
      error body: named
      default response: named
      callback body: named
      list item: named
      component as a request body: named
      component as a response body: named
      webhook payload: named"
    `);
    expect(await sites('3.1.0', { allOf: [Owner, notNull] })).toBe(
      await sites('3.1.0', { allOf: [Owner, Tag, notNull] }),
    );
  });
});

describe('#716 `oagen diff`', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('reports the `not` member as the change of type any other change of nullability is', async () => {
      const changes = async (oldDoc: unknown, newDoc: unknown) =>
        diffSpecs(await parse(oldDoc), await parse(newDoc)).changes;
      const typeChanged = [
        {
          kind: 'model-modified',
          name: 'Pet',
          fieldChanges: [
            { kind: 'field-type-changed', fieldName: 'owner', classification: 'breaking', details: 'type changed' },
          ],
          deprecatedChanged: false,
          classification: 'breaking',
        },
      ];
      // The issue: `repro.json` beside the same document without the member reported nothing and exited 0.
      for (const members of [[Owner, Tag], [Owner]]) {
        const without = ownerDoc(openapi, { allOf: members });
        const vetoed = ownerDoc(openapi, { allOf: [...members, notNull] });
        expect(await changes(without, vetoed)).toEqual(typeChanged);
        expect(await changes(vetoed, without)).toEqual(typeChanged);
        expect([await diffExit(without, vetoed), await diffExit(vetoed, without)]).toEqual([2, 2]);
      }
      // What `Plain` beside `nullable<Plain>` reports, in either direction.
      const plain = ownerDoc(openapi, Plain);
      const wrapped = ownerDoc(openapi, { oneOf: [Plain, { type: 'null' }] });
      expect(await changes(plain, wrapped)).toEqual(typeChanged);
      expect(await changes(wrapped, plain)).toEqual(typeChanged);
    });

    it('reports nothing between the spellings of the veto, in either direction', async () => {
      const schemas = { NotNull: notNull };
      const repro = ownerDoc(openapi, { allOf: [Owner, Tag, notNull] }, schemas);
      const spellings: ReadonlyArray<readonly [string, unknown]> = [
        ['beside the `allOf`', { allOf: [Owner, Tag], not: { type: 'null' } }],
        ['a `$ref` to `NotNull`', { allOf: [Owner, Tag, ref('NotNull')] }],
        ['`not: { const: null }`', { allOf: [Owner, Tag, { not: { const: null } }] }],
        ['`not: { enum: [null] }`', { allOf: [Owner, Tag, { not: { enum: [null] } }] }],
        ['wrapped in an `allOf`', { allOf: [Owner, Tag, { allOf: [notNull] }] }],
        ['first among the members', { allOf: [notNull, Owner, Tag] }],
        // A member that rejects `null` by its `type` gives the same bare model.
        ['a member typed `object` in its place', { allOf: [Owner, Tag, { type: 'object' }] }],
      ];
      for (const [label, owner] of spellings) await expectNoDiff(repro, ownerDoc(openapi, owner, schemas), label);
      await expectNoDiff(oneDoc(openapi), ownerDoc(openapi, { allOf: [Owner], not: { type: 'null' } }));
    });
  });
});

describe('#716 several declarations of one property', () => {
  const merge = { allOf: [Owner, Tag] };

  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('takes the `null` of a merge away beside a declaration that vetoes it, as the `allOf` of both by hand does', async () => {
      const schemas = { NotNull: notNull, NonNullOwner: { allOf: [Owner, notNull] } };
      const seconds: ReadonlyArray<readonly [string, unknown]> = [
        ['a `$ref` to a component that writes the `not`', ref('NotNull')],
        ['a `$ref` to a component that vetoes `null`', ref('NonNullOwner')],
        ['an `allOf` that vetoes `null`', { allOf: [Owner, notNull] }],
        ['the `not` alone', notNull],
      ];
      const lines: string[] = [];
      for (const [label, second] of seconds) {
        const members = membersDoc(openapi, [merge, second], schemas);
        const hand = ownerDoc(openapi, { allOf: [merge, second] }, schemas);
        const type = show(fieldType(await parse(members), 'Pet', 'owner'));
        expect(show(fieldType(await parse(hand), 'Pet', 'owner')), label).toBe(type);
        await expectNoDiff(members, hand, label);
        lines.push(`${label}: ${type}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a \`$ref\` to a component that writes the \`not\`: PetOwner
        a \`$ref\` to a component that vetoes \`null\`: PetOwner
        an \`allOf\` that vetoes \`null\`: PetOwner
        the \`not\` alone: PetOwner"
      `);
      // In either order of the two declarations.
      expect(script(await parse(membersDoc(openapi, [{ allOf: [Owner, notNull] }, Tag])))).toBe('owner: PetOwner');
      expect(script(await parse(membersDoc(openapi, [Tag, { allOf: [Owner, notNull] }])))).toBe('owner: PetOwner');
    });
  });

  it('leaves a `not` that lands beside a `$ref` or a nullable `type` unread, as it is on a field', async () => {
    // A declaration that declares no type is written beside the typing one's keywords (`annotateDeclaration`),
    // and beside a `$ref`, or beside a `type` that names `null`, a `not` is not read (see the next block).
    const lines: string[] = [];
    for (const [label, declarations] of [
      ['a `$ref` and the `not`', [Owner, notNull]],
      ['the `not` and a `$ref`', [notNull, Owner]],
      ['a nullable string and the `not`', [{ type: ['string', 'null'] }, notNull]],
      ['two `$ref`s and the `not`', [Owner, Tag, notNull]],
    ] as const) {
      lines.push(`${label}: ${script(await parse(membersDoc('3.1.0', [...declarations])))}`);
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "a \`$ref\` and the \`not\`: owner: nullable<Owner>
      the \`not\` and a \`$ref\`: owner: nullable<Owner>
      a nullable string and the \`not\`: owner: nullable<string>
      two \`$ref\`s and the \`not\`: owner: nullable<PetOwner>"
    `);
  });
});

describe('#716 what is left as it was', () => {
  it.each(VERSIONS)('reads no `not` outside an `allOf` (%s)', async (openapi) => {
    expect(
      await table(openapi, [
        ['beside a nullable object', { ...nullableObject(openapi, 'extra'), not: { type: 'null' } }],
        ['beside a nullable string', { ...nullable(openapi, 'string'), not: { type: 'null' } }],
        ['beside a nullable wrapper around a `$ref`', { oneOf: [Plain, { type: 'null' }], not: { type: 'null' } }],
        ['beside a union with a `null` variant', { oneOf: [Plain, Tag, { type: 'null' }], not: { type: 'null' } }],
        ['beside a `$ref` to a nullable component', { ...Owner, not: { type: 'null' } }],
        ['beside an `enum:` list naming `null`', { enum: ['a', null], not: { type: 'null' } }],
        ['alone', notNull],
        ['as the one member of an `allOf`', { allOf: [notNull] }],
      ]),
    ).toMatchInlineSnapshot(`
      "beside a nullable object: nullable<PetOwner> { extra }
      beside a nullable string: nullable<string>
      beside a nullable wrapper around a \`$ref\`: nullable<Plain>
      beside a union with a \`null\` variant: nullable<Plain | nullable<Tag>>
      beside a \`$ref\` to a nullable component: nullable<Owner>
      beside an \`enum:\` list naming \`null\`: nullable<"a">
      alone: unknown
      as the one member of an \`allOf\`: unknown"
    `);
  });
});

describe('#716 `nullVote` and the readers beside it', () => {
  const nullableInline = (field: string): SchemaObject => ({
    type: ['object', 'null'],
    properties: { [field]: string },
  });
  const plainInline: SchemaObject = { type: 'object', properties: { id: string } };
  const never: SchemaObject = { not: { type: 'null' } };
  const at = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });

  /** Read `read` with `schemas` as the document's components, as the parser reads a schema while it extracts them. */
  const within = <T>(schemas: Record<string, SchemaObject>, read: () => T): T => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      extractSchemas(schemas);
      return read();
    } finally {
      clearSchemaNameTransform();
      quiet.mockRestore();
    }
  };

  it('rejects `null` for a schema whose `not` admits it, and abstains for one whose `not` admits none', () => {
    const rejecting: SchemaObject[] = [
      never,
      { not: { const: null } },
      { not: { enum: [null] } },
      { not: { type: ['null', 'string'] } },
      { not: { enum: [null, 'x'] } },
      { not: { oneOf: [{ type: 'null' }, { type: 'string' }] } },
      { not: nullableInline('a') },
      { not: { allOf: [nullableInline('a'), nullableInline('b')] } },
      { description: 'Never null.', not: { type: 'null' } },
      { allOf: [never] },
      { allOf: [{ description: 'Text.' }], not: { type: 'null' } },
      { allOf: [nullableInline('a'), never] },
      { allOf: [never, nullableInline('a'), nullableInline('b')] },
      { allOf: [nullableInline('a'), nullableInline('b')], not: { type: 'null' } },
      { allOf: [nullableInline('a'), { allOf: [{ allOf: [never] }] }] },
      { nullable: true, allOf: [nullableInline('a'), never] },
    ];
    const abstaining: SchemaObject[] = [
      { not: {} },
      { not: { type: 'string' } },
      { not: { minLength: 3 } },
      { not: { description: 'Nothing.' } },
      { not: never },
      { not: { not: never } },
      { not: plainInline },
      { not: { allOf: [nullableInline('a'), never] } },
      { not: true },
      { not: [{ type: 'null' }] } as unknown as SchemaObject,
      { anyOf: [never, never] },
    ];
    // A schema that writes `null` itself admits it, whatever `not` it writes beside it.
    const admitting: SchemaObject[] = [
      { type: ['object', 'null'], not: { type: 'null' } },
      { type: 'object', nullable: true, not: { type: 'null' } },
      { enum: ['a', null], not: { type: 'null' } },
      { oneOf: [plainInline, { type: 'null' }], not: { type: 'null' } },
      { type: ['object', 'null'], allOf: [nullableInline('a'), never] },
      { allOf: [nullableInline('a'), { type: ['object', 'null'], not: { type: 'null' } }] },
      { allOf: [nullableInline('a'), { not: { type: 'string' } }] },
      { allOf: [nullableInline('a'), { not: never }] },
    ];
    expect(rejecting.filter((schema) => nullVote(schema) !== 'rejects')).toEqual([]);
    expect(abstaining.filter((schema) => nullVote(schema) !== 'abstains')).toEqual([]);
    expect(admitting.filter((schema) => nullVote(schema) !== 'admits')).toEqual([]);
    expect([...rejecting, ...abstaining].filter((schema) => schemaAdmitsNull(schema))).toEqual([]);
  });

  it('casts the vote of the component a `$ref` names, in the member and in the `not`', () => {
    const schemas: Record<string, SchemaObject> = {
      Owner: nullableInline('name'),
      Plain: plainInline,
      Null: { type: 'null' },
      NullAlias: { allOf: [at('Null')] },
      NotNull: never,
      NotNullAlias: at('NotNull'),
      NotOwner: { not: at('Owner') },
      NotPlain: { not: at('Plain') },
      NotNullAliasOfNull: { not: at('NullAlias') },
      NonNullOwner: { allOf: [at('Owner'), never] },
      NotNonNullOwner: { not: at('NonNullOwner') },
      Twice: { not: at('NotNull') },
      Holder: { type: 'object', properties: { never } },
    };
    const vote = (name: string) => nullVote(at(name));
    expect(
      within(schemas, () =>
        Object.fromEntries(Object.keys(schemas).map((name): [string, string] => [name, vote(name)])),
      ),
    ).toEqual({
      Owner: 'admits',
      Plain: 'rejects',
      Null: 'admits',
      NullAlias: 'admits',
      NotNull: 'rejects',
      NotNullAlias: 'rejects',
      NotOwner: 'rejects',
      NotPlain: 'abstains',
      NotNullAliasOfNull: 'rejects',
      NonNullOwner: 'rejects',
      // `NonNullOwner` rejects `null`, so what is not one may be `null`: no veto.
      NotNonNullOwner: 'abstains',
      Twice: 'abstains',
      Holder: 'rejects',
    });
    expect(within(schemas, () => nullVote({ $ref: '#/components/schemas/Holder/properties/never' }))).toBe('rejects');
    // Nothing beside a `$ref` is read, a `not` included.
    expect(within(schemas, () => nullVote({ ...at('Owner'), not: { type: 'null' } }))).toBe('admits');
    // With no document being read, a `$ref` in a `not` names no schema and admits nothing.
    expect(nullVote({ not: at('Null') })).toBe('abstains');
  });

  it('tells an `allOf` read as one member whether the rest of it vetoes `null`', () => {
    const schemas: Record<string, SchemaObject> = {
      Owner: nullableInline('name'),
      NotNull: never,
      NonNullOwner: { allOf: [at('Owner'), never] },
      FlagKind: { enum: ['cat'], nullable: true, not: { type: 'null' } },
    };
    within(schemas, () => {
      const vetoing: SchemaObject[] = [
        { allOf: [at('Owner'), never] },
        { allOf: [never, at('Owner')] },
        { allOf: [at('Owner')], not: { type: 'null' } },
        { allOf: [at('Owner'), { allOf: [never] }] },
        { allOf: [at('Owner'), { not: { type: 'null' }, allOf: [] }] },
        { allOf: [at('Owner'), { not: { type: 'string' }, allOf: [at('NotNull')] }] },
        { allOf: [{ type: ['string', 'null'] }, never] },
        { allOf: [{ type: ['string', 'null'] }, { description: 'Text.' }, never] },
        { type: 'object', allOf: [at('Owner'), never] },
      ];
      const not: SchemaObject[] = [
        { allOf: [at('Owner')] },
        { allOf: [at('Owner'), { description: 'Text.' }] },
        { allOf: [at('Owner'), { not: { type: 'string' } }] },
        { allOf: [at('Owner'), { not: never }] },
        // A `type` that names no `null` is no veto: the member keeps its `null` beside one.
        { type: 'object', allOf: [at('Owner')] },
        { allOf: [at('Owner'), { type: 'string' }] },
        // The member the `allOf` is read as is not asked: its type says what it admits.
        { allOf: [at('NonNullOwner')] },
        { allOf: [at('FlagKind'), { description: 'Text.' }] },
        { allOf: [{ allOf: [at('Owner'), never] }] },
        // A member that writes `null` itself is read no further.
        { allOf: [at('Owner'), { type: ['object', 'null'], not: { type: 'null' } }] },
      ];
      expect(vetoing.filter((schema) => !allOfVetoesNull(schema))).toEqual([]);
      expect(not.filter((schema) => allOfVetoesNull(schema))).toEqual([]);
      // `declaresNull` follows: the member's `null` is the schema's unless the `allOf` vetoes it.
      expect(declaresNull({ allOf: [{ type: ['string', 'null'] }] })).toBe(true);
      expect(declaresNull({ allOf: [{ type: ['string', 'null'] }, never] })).toBe(false);
      expect(declaresNull({ allOf: [{ type: ['string', 'null'] }], not: { type: 'null' } })).toBe(false);
      expect(declaresNull({ type: ['string', 'null'], allOf: [{ type: 'string' }, never] })).toBe(true);
      expect(declaresNull({ allOf: [nullableInline('a'), nullableInline('b')] })).toBe(true);
      expect(declaresNull({ allOf: [nullableInline('a'), nullableInline('b'), never] })).toBe(false);
    });
  });

  it('reads a `not` that leads back to the schema that writes it as no veto, in either reading order', () => {
    const schemas: Record<string, SchemaObject> = {
      Owner: nullableInline('name'),
      // A `not` of itself, outright and through an alias.
      Self: { not: at('Self') },
      SelfOwner: { allOf: [at('Owner'), { not: at('SelfOwner') }] },
      Alias: { allOf: [at('ViaAlias')] },
      ViaAlias: { allOf: [at('Owner'), { not: at('Alias') }] },
      // Two components that each name the other in a `not`.
      A: { allOf: [at('Owner'), { not: at('B') }] },
      B: { allOf: [at('Owner'), { not: at('A') }] },
      // A `not` of a component that composes itself, which rejects `null`: no veto either.
      Loop: { allOf: [at('Loop'), at('Owner')] },
      NotLoop: { allOf: [at('Owner'), { not: at('Loop') }] },
      // And one that does not lead back: a veto, as anywhere.
      NotOwner: { allOf: [at('Owner'), { not: at('Owner') }] },
    };
    const expected = {
      Self: 'abstains',
      SelfOwner: 'admits',
      Alias: 'admits',
      ViaAlias: 'admits',
      A: 'admits',
      B: 'admits',
      Loop: 'rejects',
      NotLoop: 'admits',
      NotOwner: 'rejects',
    };
    const names = Object.keys(expected);
    // What a schema says does not turn on which schema is read first.
    for (const order of [names, [...names].reverse(), ['B', 'A', 'ViaAlias', 'Alias', 'SelfOwner', 'Self']]) {
      const votes = within(schemas, () => order.map((name): [string, string] => [name, nullVote(at(name))]));
      for (const [name, vote] of votes) expect(vote, `${name} in ${order.join()}`).toBe(expected[name as 'A']);
    }
  });

  it('parses a document whose components name themselves in a `not`, in either order of its fields', async () => {
    const schemas = {
      Self: { not: ref('Self') },
      A: { allOf: [Owner, { not: ref('B') }] },
      B: { allOf: [Owner, { not: ref('A') }] },
    };
    const fields = { self: { allOf: [Owner, Tag, ref('Self')] }, a: ref('A'), b: ref('B'), one: { allOf: [ref('A')] } };
    const pet = (entries: Array<[string, unknown]>) =>
      document('3.1.0', { ...schemas, Pet: { type: 'object', properties: Object.fromEntries(entries) } });
    const forward = script(await parse(pet(Object.entries(fields))));
    expect(forward).toBe('self: nullable<PetSelf>, a: nullable<A>, b: nullable<B>, one: nullable<A>');
    const backward = script(await parse(pet(Object.entries(fields).reverse())));
    expect(backward.split(', ').reverse().join(', ')).toBe(forward);
  });

  it('reads a component many members name once, under a `not` as beside one', async () => {
    // Each level is the `allOf` of two `$ref`s to the level before: an unshared walk reads `Level0` 2^40 times.
    const depth = 40;
    const levels: Record<string, unknown> = { Level0: nullableObject('3.1.0', 'name') };
    for (let level = 1; level <= depth; level++) {
      levels[`Level${level}`] = { allOf: [ref(`Level${level - 1}`), ref(`Level${level - 1}`)] };
    }
    const top = ref(`Level${depth}`);
    const spec = await parse(
      document('3.1.0', {
        ...levels,
        Pet: {
          type: 'object',
          properties: {
            under_the_not: { allOf: [Owner, Tag, { not: top }] },
            beside_the_not: { allOf: [top, notNull] },
            in_a_wrapper: { allOf: [Owner, { not: string, allOf: [top] }] },
          },
        },
      }),
    );
    expect(script(spec)).toBe(
      `under_the_not: PetUnderTheNot, beside_the_not: Level${depth}, in_a_wrapper: nullable<PetInAWrapper>`,
    );
  });

  it("keeps a deferred discriminator mapping entry with the variant that takes its wrapper's place", async () => {
    // Greptile, #726: a variant written `oneOf: [<pointer>, { type: 'null' }]` that the mapping names has its
    // entry deferred against the nullable wrapper. The veto takes the wrapper off the variant, and the entry kept
    // following the wrapper the union no longer held, so a copy made before the pointers settle carried it as a
    // target outside the variants.
    const dog = { $ref: '#/components/schemas/Zoo/properties/dog' };
    const variant = (kind: string, extra: string): SchemaObject => ({
      type: 'object',
      required: ['kind'],
      properties: { kind: { type: 'string', enum: [kind] }, [extra]: string },
    });
    const schemas: Record<string, SchemaObject> = {
      Cat: variant('cat', 'meow'),
      Zoo: { type: 'object', properties: { dog: variant('dog', 'bark') } },
    };
    const union: SchemaObject = {
      oneOf: [at('Cat'), { oneOf: [dog, { type: 'null' }] }],
      discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat', dog: dog.$ref } },
    };
    const vetoed: SchemaObject = { allOf: [union], not: { type: 'null' } };
    within(schemas, () => {
      for (const [schema, kinds] of [
        [union, ['model', 'nullable']],
        [vetoed, ['model', 'model']],
      ] as const) {
        const copy = cloneTypeRef(schemaToTypeRef(schema, 'owner', 'Pet'));
        if (copy.kind !== 'union' || !copy.discriminator) throw new Error('a discriminated union is built');
        expect(copy.variants.map((member) => member.kind)).toEqual(kinds);
        // The copy's one deferred entry follows the copy's own second variant, with or without the wrapper.
        const followed = settleDeferredMappingEntries(copy.discriminator.mapping, () => {});
        expect(followed.map((reference) => copy.variants.indexOf(reference))).toEqual([1]);
      }
    });
    // End to end the entry is written as the model the pointer settles to, in the union and in every copy of it: a
    // pointer to the field, and a second webhook sharing the path item.
    const event = { post: { requestBody: json(vetoed), responses: { '200': { description: 'ok' } } } };
    const spec = await parse({
      ...document('3.1.0', {
        ...schemas,
        Pet: { type: 'object', properties: { a: vetoed, b: { $ref: '#/components/schemas/Pet/properties/a' } } },
      }),
      webhooks: {
        petSaved: { $ref: '#/components/pathItems/PetEvent' },
        petSavedAgain: { $ref: '#/components/pathItems/PetEvent' },
      },
      components: {
        schemas: {
          ...schemas,
          Pet: { type: 'object', properties: { a: vetoed, b: { $ref: '#/components/schemas/Pet/properties/a' } } },
        },
        pathItems: { PetEvent: event },
      },
    });
    const unions = [
      fieldType(spec, 'Pet', 'a'),
      fieldType(spec, 'Pet', 'b'),
      ...(spec.webhooks ?? []).map((webhook) => webhook.requestBody),
    ];
    expect(unions).toHaveLength(4);
    for (const type of unions) {
      expect(show(type)).toBe('Cat | ZooDog');
      expect(type?.kind === 'union' ? type.discriminator?.mapping : undefined).toEqual({ cat: 'Cat', dog: 'ZooDog' });
    }
  });

  it('counts no `null` among the values a declaration pins under an `allOf` that vetoes it', async () => {
    const schemas: Record<string, SchemaObject> = {
      CatKind: { type: ['string', 'null'], enum: ['cat', null] },
      NonNullCat: { allOf: [at('CatKind'), never] },
    };
    const inline: SchemaObject = { type: ['string', 'null'], enum: ['cat', null] };
    within(schemas, () => {
      const admits = (declaration: SchemaObject) => pinnedDeclarationAdmitsNull(declaration, schemas);
      expect(admits(at('CatKind'))).toBe(true);
      expect(admits({ allOf: [at('CatKind')] })).toBe(true);
      expect(admits({ allOf: [inline] })).toBe(true);
      expect(admits({ allOf: [at('CatKind'), never] })).toBe(false);
      expect(admits({ allOf: [at('CatKind')], not: { type: 'null' } })).toBe(false);
      expect(admits({ allOf: [inline, never] })).toBe(false);
      expect(admits({ allOf: [{ allOf: [at('CatKind'), never] }] })).toBe(false);
      expect(admits(at('NonNullCat'))).toBe(false);
      // A nullable wrapper around the vetoing `allOf` admits `null` again: the wrapper's own word.
      expect(admits({ oneOf: [{ allOf: [at('CatKind'), never] }, { type: 'null' }] })).toBe(true);
    });
    // So the discriminator a request body folds to admits `null` exactly when a variant's declaration does,
    const variant = (kind: unknown, extra: string) => ({
      type: 'object',
      required: ['kind'],
      properties: { kind, [extra]: string },
    });
    const folded = async (kind: unknown): Promise<string> => {
      const spec = await parse(
        document(
          '3.1.0',
          { ...schemas, Pet: { type: 'object', properties: {} } },
          {
            '/pets': {
              post: {
                operationId: 'createPet',
                requestBody: json({
                  oneOf: [variant(kind, 'meow'), variant({ const: 'dog' }, 'bark')],
                  discriminator: { propertyName: 'kind' },
                }),
                responses: { '200': { description: 'ok', ...json(Plain) } },
              },
            },
          },
        ),
      );
      return show(fieldType(spec, 'CreatePetRequest', 'kind'));
    };
    expect(await folded(ref('CatKind'))).toBe('nullable<CreatePetRequestKind>');
    expect(await folded({ allOf: [ref('CatKind'), notNull] })).toBe('CreatePetRequestKind');
    expect(await folded(ref('NonNullCat'))).toBe('CreatePetRequestKind');
    // and a variant's declaration is the narrower one beside an own `kind` that admits no `null`.
    const shape = async (kind: unknown): Promise<string> => {
      const spec = await parse(
        ownerDoc(
          '3.1.0',
          { properties: { kind: string }, oneOf: [variant(kind, 'meow'), variant({ const: 'dog' }, 'bark')] },
          schemas,
        ),
      );
      return show(fieldType(spec, 'PetOwner', 'kind'));
    };
    expect(await shape(ref('CatKind'))).toBe('string');
    expect(await shape({ allOf: [ref('CatKind'), notNull] })).toBe('CatKind');
  });
});
