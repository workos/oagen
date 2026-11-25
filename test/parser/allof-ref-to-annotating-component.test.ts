import { describe, it, expect, afterAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import {
  clearSchemaNameTransform,
  extractSchemas,
  nullVote,
  schemaToTypeRef,
  type SchemaObject,
} from '../../src/parser/schemas.js';
import {
  readInlineAllOf,
  saysWhatInstanceIs,
  splicedAllOfMembers,
  unionReferencesOf,
} from '../../src/parser/inline-models.js';
import type { ApiSpec, Field, Model, Operation, Parameter, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #731: an `allOf` of a `$ref` and a member that only annotates the
 * schema or vetoes `null` (`{ description }`, `{ not: { type: 'null' } }`)
 * is read as the `$ref`. The same member written as a `$ref` to a component
 * that holds it was a second `$ref`, and two `$ref` members were always a
 * merge, so the `allOf` became a new model with the first component's
 * fields — a second class for the one component — and `oagen diff` between
 * the two spellings was breaking. A `$ref` to a schema that says nothing of
 * what an instance is now reads as the keywords written in its place,
 * beside a member that names a schema that says what one is, as it already
 * did for `null` (#715, #716), and the `allOf` is read by its other
 * members.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-731-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}
const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeDoc(doc));
/** `doc` parsed, with the warnings that one parse printed. */
async function read(doc: unknown): Promise<{ spec: ApiSpec; warned: string[] }> {
  warn.mockClear();
  const spec = await parse(doc);
  return { spec, warned: warnings() };
}

type Doc = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

/** An object that admits `null`, in the version's own spelling, with one optional string field. */
const nullableObject = (openapi: Version, field: string) => ({
  ...(openapi === '3.0.3' ? { type: 'object', nullable: true } : { type: ['object', 'null'] }),
  properties: { [field]: string },
});

const Owner = ref('Owner');
const Tag = ref('Tag');
const NotNull = ref('NotNull');
const Described = ref('Described');
const notNull = { not: { type: 'null' } };
const text = { description: 'Any owner.' };

/**
 * The issue's document: `Owner { name }`, a nullable object, `NotNull: {
 * not: { type: 'null' } }`, `Described: { description: 'Any owner.' }` and
 * `GET /pets/{petId}` (`getPet`) returning `$ref: Pet`, beside `schemas`.
 */
const document = (openapi: Version, schemas: Doc, paths: Doc = {}, more: Doc = {}) => ({
  openapi,
  info: { title: 'Repro', version: '1.0.0' },
  paths: {
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: string }],
        responses: { '200': { description: 'OK', ...json(ref('Pet')) } },
      },
    },
    ...paths,
  },
  components: {
    schemas: {
      Owner: nullableObject(openapi, 'name'),
      NotNull: notNull,
      Described: text,
      ...schemas,
    },
  },
  ...more,
});

/** `Pet.owner` written as `owner`, beside `schemas`. */
const ownerDoc = (openapi: Version, owner: unknown, schemas: Doc = {}) =>
  document(openapi, { Pet: { type: 'object', properties: { owner } }, ...schemas });

const modelOf = (spec: ApiSpec, name: string): Model | undefined => spec.models.find((m) => m.name === name);
const fieldOf = (spec: ApiSpec, name: string, field: string): Field | undefined =>
  modelOf(spec, name)?.fields.find((f) => f.name === field);
const operations = (spec: ApiSpec): Operation[] => spec.services.flatMap((s) => s.operations);
const operation = (spec: ApiSpec, name: string): Operation => operations(spec).find((op) => op.name === name)!;

/** A type in a word: `nullable<Owner>`, `Owner[]`, `(Owner | string)`, `string`. */
const show = (type: TypeRef | undefined): string => {
  if (!type) return 'none';
  switch (type.kind) {
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'array':
      return `${show(type.items)}[]`;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'primitive':
      return type.type;
    case 'literal':
      return JSON.stringify(type.value);
    default:
      return type.name;
  }
};

/** The issue's script: each field of `Pet` with its type, then the names of the models. */
const script = (spec: ApiSpec): string =>
  `${modelOf(spec, 'Pet')!
    .fields.map(({ name, type }) => `${name}: ${show(type)}`)
    .join(', ')} [${spec.models.map(({ name }) => name).join(', ')}]`;

/** What a field or a parameter carries beside its type, as `key=value` words; empty when it carries nothing. */
const carried = (node: Field | Parameter | undefined): string => {
  if (!node) return '';
  const { description, deprecated, readOnly, writeOnly, constraints, extensions, externalDocs } = node as Field;
  const { default: fallback, example } = node as Field;
  const words = Object.entries({
    description,
    deprecated,
    readOnly,
    writeOnly,
    default: fallback,
    example,
    constraints,
    extensions,
    externalDocs,
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return words.length > 0 ? ` <${words.join(' ')}>` : '';
};

/** `Pet.owner`: its type, what the field carries, and the fields of the merged model when it names one. */
const ownerLine = (spec: ApiSpec): string => {
  const field = fieldOf(spec, 'Pet', 'owner');
  const named = field?.type.kind === 'nullable' ? field.type.inner : field?.type;
  const merged = named?.kind === 'model' && named.name === 'PetOwner' ? modelOf(spec, 'PetOwner') : undefined;
  const fields = merged
    ? ` { ${merged.fields.map((f) => `${f.name}${f.required ? '' : '?'}`).join(', ')} }${merged.description ? ` "${merged.description}"` : ''}`
    : '';
  return `${show(field?.type)}${fields}${carried(field)}`;
};
async function ownerOf(openapi: Version, owner: unknown, schemas: Doc = {}): Promise<string> {
  return ownerLine(await parse(ownerDoc(openapi, owner, schemas)));
}
type Row = readonly [label: string, owner: unknown, schemas?: Doc];
const table = async (openapi: Version, rows: readonly Row[]): Promise<string> => {
  const lines: string[] = [];
  for (const [label, owner, schemas] of rows) lines.push(`${label}: ${await ownerOf(openapi, owner, schemas)}`);
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

/**
 * The two documents are one IR — every model, enum, operation and warning —
 * and `diffSpecs` reports nothing between them, in either direction.
 */
async function expectOneIr(first: unknown, second: unknown, label = ''): Promise<ApiSpec> {
  const [a, b] = [await read(first), await read(second)];
  expect(a.spec, label).toEqual(b.spec);
  expect(a.warned, label).toEqual(b.warned);
  expect(diffSpecs(a.spec, b.spec).changes, label).toEqual([]);
  expect(diffSpecs(b.spec, a.spec).changes, label).toEqual([]);
  return a.spec;
}

/** Read `run` with `schemas` as the document's components, as the parser reads a schema while it extracts them. */
const within = <T>(schemas: Record<string, SchemaObject>, run: () => T): T => {
  const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    extractSchemas(schemas);
    return run();
  } finally {
    clearSchemaNameTransform();
    quiet.mockRestore();
  }
};

/**
 * Every way a component says nothing of what an instance is: what it
 * writes, which is also the member written inline in its place.
 */
const SAYS_NOTHING: ReadonlyArray<readonly [string, Doc]> = [
  ['a `description`', text],
  ['a `title`', { title: 'Titled' }],
  ['a `not` that vetoes `null`', notNull],
  ['a `not` that vetoes none', { not: string }],
  ['a `minProperties` limit', { minProperties: 1 }],
  ['a `minLength` limit', { minLength: 1 }],
  ['`deprecated: true`', { deprecated: true }],
  ['`readOnly: true`', { readOnly: true }],
  ['an `example`', { example: { name: 'Ada' } }],
  ['a `default`', { default: null }],
  ['an `externalDocs` link', { externalDocs: { url: 'https://example.com/owners' } }],
  ['an `x-*` key', { 'x-note': 'n' }],
  ['a `required` list', { required: ['name'] }],
  ['an empty schema', {}],
  ['`nullable: true` with no `type`', { description: 'Any owner.', nullable: true }],
  ['a `format` alone', { format: 'uuid' }],
  ['`items` that say nothing', { items: {} }],
  ['`items` that only document', { items: { description: 'An item.' } }],
  ['a union of bare limits', { anyOf: [{ required: ['name'] }, { maxProperties: 9 }] }],
  ['several keywords', { description: 'Any owner.', deprecated: true, minProperties: 1, not: { type: 'null' } }],
  ['a wrapper around a `description`', { allOf: [text] }],
  ['a wrapper around two members', { allOf: [text, { minProperties: 1 }] }],
  ['a wrapper around a wrapper', { allOf: [{ allOf: [text] }] }],
  ['a documented wrapper around a limit', { ...text, allOf: [{ minProperties: 1 }] }],
  ['an empty `allOf`', { allOf: [] }],
];

describe('#731 an `allOf` member that is a `$ref` to a component that only annotates is no second `$ref`', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    /** `Tag { label }`, a second nullable object, for the merges. */
    const tag = { Tag: nullableObject(openapi, 'label') };
    /** The issue's four documents. */
    const files = {
      'inline.json': ownerDoc(openapi, { allOf: [Owner, notNull] }),
      'ref.json': ownerDoc(openapi, { allOf: [Owner, NotNull] }),
      'described-inline.json': ownerDoc(openapi, { allOf: [Owner, text] }),
      'described-ref.json': ownerDoc(openapi, { allOf: [Owner, Described] }),
    };

    it("types the issue's `ref.json` and `described-ref.json` as the inline spellings (the issue's script)", async () => {
      const lines: string[] = [];
      for (const [name, doc] of Object.entries(files)) lines.push(`${name} ${script(await parse(doc))}`);
      // The issue's output was `ref.json owner: PetOwner [Owner, Pet, PetOwner]` and
      // `described-ref.json owner: nullable<PetOwner> [Owner, Pet, PetOwner]`.
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "inline.json owner: Owner [Owner, Pet]
        ref.json owner: Owner [Owner, Pet]
        described-inline.json owner: nullable<Owner> [Owner, Pet]
        described-ref.json owner: nullable<Owner> [Owner, Pet]"
      `);
      expect(warnings()).toEqual([]);
    });

    it('reports nothing between the inline and the `$ref` spelling, in both directions (`oagen diff` exits 0)', async () => {
      for (const [inline, byRef] of [
        ['inline.json', 'ref.json'],
        ['described-inline.json', 'described-ref.json'],
      ] as const) {
        // The issue: exit 2, `model-added` `PetOwner` and a breaking `field-type-changed` on `owner`, either way.
        await expectOneIr(files[inline], files[byRef], inline);
        expect(await diffExit(files[inline], files[byRef]), inline).toBe(0);
        expect(await diffExit(files[byRef], files[inline]), inline).toBe(0);
      }
    });

    it('reads the `$ref` as the keywords in its place however the component says nothing', async () => {
      const lines: string[] = [];
      for (const [label, component] of SAYS_NOTHING) {
        // The models the document declares, the `allOf` apart: `Owner` and `Pet` (and the model a union component
        // is, which a union of bare limits is on its own).
        const declared = (await parse(ownerDoc(openapi, Owner, { Ann: component }))).models.map((m) => m.name);
        const read: string[] = [];
        for (const members of [(member: unknown) => [Owner, member], (member: unknown) => [member, Owner]]) {
          // Both documents hold the component; only the member's spelling differs.
          const inline = ownerDoc(openapi, { allOf: members(component) }, { Ann: component });
          const byRef = ownerDoc(openapi, { allOf: members(ref('Ann')) }, { Ann: component });
          const spec = await expectOneIr(byRef, inline, label);
          // No copy of `Owner` under a name of its own, unless a `required` list adds to it.
          const names = spec.models.map((m) => m.name);
          expect(names, label).toEqual('required' in component ? [...declared, 'PetOwner'] : declared);
          expect(spec.enums, label).toEqual([]);
          read.push(ownerLine(spec));
        }
        // In either order of the members.
        expect(read[1], label).toBe(read[0]);
        lines.push(`${label}: ${read[0]}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a \`description\`: nullable<Owner> <description="Any owner.">
        a \`title\`: nullable<Owner>
        a \`not\` that vetoes \`null\`: Owner
        a \`not\` that vetoes none: nullable<Owner>
        a \`minProperties\` limit: nullable<Owner> <constraints={"minProperties":1}>
        a \`minLength\` limit: nullable<Owner> <constraints={"minLength":1}>
        \`deprecated: true\`: nullable<Owner> <deprecated=true>
        \`readOnly: true\`: nullable<Owner> <readOnly=true>
        an \`example\`: nullable<Owner> <example={"name":"Ada"}>
        a \`default\`: nullable<Owner> <default=null>
        an \`externalDocs\` link: nullable<Owner> <externalDocs={"url":"https://example.com/owners"}>
        an \`x-*\` key: nullable<Owner> <extensions={"x-note":"n"}>
        a \`required\` list: nullable<PetOwner> { name }
        an empty schema: nullable<Owner>
        \`nullable: true\` with no \`type\`: nullable<Owner> <description="Any owner.">
        a \`format\` alone: nullable<Owner>
        \`items\` that say nothing: nullable<Owner>
        \`items\` that only document: nullable<Owner>
        a union of bare limits: nullable<Owner>
        several keywords: Owner <description="Any owner." deprecated=true constraints={"minProperties":1}>
        a wrapper around a \`description\`: nullable<Owner> <description="Any owner.">
        a wrapper around two members: nullable<Owner> <description="Any owner." constraints={"minProperties":1}>
        a wrapper around a wrapper: nullable<Owner> <description="Any owner.">
        a documented wrapper around a limit: nullable<Owner> <description="Any owner." constraints={"minProperties":1}>
        an empty \`allOf\`: nullable<Owner>"
      `);
    });

    it('gives each such component no vote on `null`, or a veto alone (`nullVote`)', () => {
      const schemas: Record<string, SchemaObject> = { Owner: nullableObject(openapi, 'name') };
      SAYS_NOTHING.forEach(([, component], index) => (schemas[`K${index}`] = component));
      within(schemas, () => {
        for (const [index, [label, component]] of SAYS_NOTHING.entries()) {
          const member: SchemaObject = ref(`K${index}`);
          expect(saysWhatInstanceIs(member), label).toBe(false);
          // The `allOf` is its one other `$ref`, unless a `required` list adds to it.
          expect(readInlineAllOf([Owner, member]), label).toBe('required' in component ? 'merged' : 'reference');
          // The one reading of "says what an instance is": no vote, or the veto a `not` casts.
          const vetoes = JSON.stringify(component).includes('"not":{"type":"null"}');
          expect(nullVote(member), label).toBe(vetoes ? 'rejects' : 'abstains');
        }
      });
    });

    it('follows the `$ref` through every alias, wrapper and pointer to the schema it names', async () => {
      const schemas = {
        Alias: Described,
        AliasOfAlias: ref('Alias'),
        AllOfAlias: { allOf: [Described] },
        Both: { allOf: [Described, NotNull] },
        Documented: { description: 'Outer.', allOf: [NotNull] },
        TextAlias: { ...Described, description: 'Alias text.' },
        Holder: { type: 'object', properties: { note: { description: 'A note.' }, never: notNull } },
        Limits: { minProperties: 1 },
      };
      const pointer = (property: string) => ({ $ref: `#/components/schemas/Holder/properties/${property}` });
      expect(
        await table(openapi, [
          ['an alias of the component', { allOf: [Owner, ref('Alias')] }, schemas],
          ['an alias of an alias', { allOf: [Owner, ref('AliasOfAlias')] }, schemas],
          ['an `allOf` alias', { allOf: [Owner, ref('AllOfAlias')] }, schemas],
          ['an `allOf` of two such components', { allOf: [Owner, ref('Both')] }, schemas],
          ['a documented wrapper around a `$ref`', { allOf: [Owner, ref('Documented')] }, schemas],
          ['an alias that writes its own text', { allOf: [Owner, ref('TextAlias')] }, schemas],
          ['a JSON Pointer to a field that only annotates', { allOf: [Owner, pointer('note')] }, schemas],
          ['a JSON Pointer to a field that vetoes `null`', { allOf: [Owner, pointer('never')] }, schemas],
          ['the `$ref` wrapped in an `allOf`', { allOf: [Owner, { allOf: [NotNull] }] }, schemas],
          ['wrapped twice', { allOf: [Owner, { allOf: [{ allOf: [Described] }] }] }, schemas],
          ['in a documented wrapper', { allOf: [Owner, { description: 'Inner.', allOf: [ref('Limits')] }] }, schemas],
          ['both `$ref`s in one wrapper', { allOf: [{ allOf: [Owner, NotNull] }] }, schemas],
          ['each `$ref` in a wrapper of its own', { allOf: [{ allOf: [Owner] }, { allOf: [Described] }] }, schemas],
          ['a limit beside the `$ref`', { allOf: [Owner, { ...ref('Limits'), maxProperties: 5 }] }, schemas],
          ['a `description` beside the `$ref`', { allOf: [Owner, { ...Described, description: 'Beside.' }] }, schemas],
        ]),
      ).toMatchInlineSnapshot(`
        "an alias of the component: nullable<Owner> <description="Any owner.">
        an alias of an alias: nullable<Owner> <description="Any owner.">
        an \`allOf\` alias: nullable<Owner> <description="Any owner.">
        an \`allOf\` of two such components: Owner <description="Any owner.">
        a documented wrapper around a \`$ref\`: Owner <description="Outer.">
        an alias that writes its own text: nullable<Owner> <description="Alias text.">
        a JSON Pointer to a field that only annotates: nullable<Owner> <description="A note.">
        a JSON Pointer to a field that vetoes \`null\`: Owner
        the \`$ref\` wrapped in an \`allOf\`: Owner
        wrapped twice: nullable<Owner> <description="Any owner.">
        in a documented wrapper: nullable<Owner> <description="Inner." constraints={"minProperties":1}>
        both \`$ref\`s in one wrapper: Owner
        each \`$ref\` in a wrapper of its own: nullable<Owner> <description="Any owner.">
        a limit beside the \`$ref\`: nullable<Owner> <constraints={"maxProperties":5,"minProperties":1}>
        a \`description\` beside the \`$ref\`: nullable<Owner> <description="Beside.">"
      `);
      expect(warnings()).toEqual([]);
    });

    it('reads it where it is named again beside a wrapper that keeps one to itself', async () => {
      // A wrapper the splice leaves closed reads its own `allOf` itself: what it names stands under it alone, and
      // the same component named beside it stands there too, as the same keywords written twice do.
      const typed = (member: unknown) => ({ type: 'object', allOf: [member] });
      const rows: ReadonlyArray<readonly [string, unknown[], unknown[]]> = [
        [
          'beside the one typing wrapper',
          [{ allOf: [Owner, Described] }, { allOf: [Described] }],
          [{ allOf: [Owner, text] }, { allOf: [text] }],
        ],
        ['beside a wrapper typed `object`', [Owner, typed(Described), Described], [Owner, typed(text), text]],
        ['after a wrapper typed `object`', [typed(NotNull), Owner, NotNull], [typed(notNull), Owner, notNull]],
        ['twice', [Owner, Described, Described], [Owner, text, text]],
      ];
      const lines: string[] = [];
      for (const [label, byRef, inline] of rows) {
        const spec = await expectOneIr(
          ownerDoc(openapi, { allOf: byRef }),
          ownerDoc(openapi, { allOf: inline }),
          label,
        );
        lines.push(`${label}: ${ownerLine(spec)}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "beside the one typing wrapper: nullable<Owner> <description="Any owner.">
        beside a wrapper typed \`object\`: PetOwner { name? } "Any owner." <description="Any owner.">
        after a wrapper typed \`object\`: PetOwner { name? }
        twice: nullable<Owner> <description="Any owner.">"
      `);
    });

    it('reads a schema two `$ref`s under one wrapper name where the document first reaches it', async () => {
      // A schema stands once under a wrapper, and what stands first is what the inline spelling writes first:
      // the members in order, each wrapper opened before the member after it. (Greptile, #739 review: the
      // members of a wrapper were all placed before the first was opened, so the `D` under `B` found `D`
      // standing and `B`'s text and pattern came first, where the same members written out give `D`'s.)
      const D = { description: 'D', pattern: '^D' };
      const b = { description: 'B', pattern: '^B' };
      const c = { description: 'C', pattern: '^C' };
      const rows: ReadonlyArray<readonly [string, Doc, unknown[], unknown[]]> = [
        [
          'a wrapper first, then the schema it names',
          { D, B: { allOf: [ref('D'), b] }, A: { allOf: [ref('B'), ref('D')] } },
          [Owner, ref('A')],
          [Owner, { allOf: [{ allOf: [D, b] }, D] }],
        ],
        [
          'the schema first, then a wrapper that names it',
          { D, B: { allOf: [b, ref('D')] }, A: { allOf: [ref('D'), ref('B')] } },
          [Owner, ref('A')],
          [Owner, { allOf: [D, { allOf: [b, D] }] }],
        ],
        [
          'two wrappers that name it',
          { D, B: { allOf: [b, ref('D')] }, C: { allOf: [ref('D'), c] }, A: { allOf: [ref('B'), ref('C')] } },
          [Owner, ref('A')],
          [Owner, { allOf: [{ allOf: [b, D] }, { allOf: [D, c] }] }],
        ],
        [
          'two wrappers that name it, the other way round',
          { D, B: { allOf: [b, ref('D')] }, C: { allOf: [ref('D'), c] }, A: { allOf: [ref('C'), ref('B')] } },
          [Owner, ref('A')],
          [Owner, { allOf: [{ allOf: [D, c] }, { allOf: [b, D] }] }],
        ],
        [
          'beside the `$ref`, not under a wrapper',
          { D, B: { allOf: [ref('D'), b] } },
          [Owner, ref('B'), ref('D')],
          [Owner, { allOf: [D, b] }, D],
        ],
        [
          'under a wrapper written inline',
          { D, B: { allOf: [ref('D'), b] } },
          [Owner, { allOf: [ref('B'), ref('D')] }],
          [Owner, { allOf: [{ allOf: [D, b] }, D] }],
        ],
        [
          'through an alias of the wrapper',
          { D, B: { allOf: [ref('D'), b] }, Alias: ref('B'), A: { allOf: [ref('Alias'), ref('D')] } },
          [Owner, ref('A')],
          [Owner, { allOf: [{ allOf: [D, b] }, D] }],
        ],
      ];
      const lines: string[] = [];
      for (const [label, schemas, byRef, inline] of rows) {
        const spec = await expectOneIr(
          ownerDoc(openapi, { allOf: byRef }, schemas),
          ownerDoc(openapi, { allOf: inline }, schemas),
          label,
        );
        lines.push(`${label}: ${ownerLine(spec)}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a wrapper first, then the schema it names: nullable<Owner> <description="D" constraints={"pattern":"^D"}>
        the schema first, then a wrapper that names it: nullable<Owner> <description="D" constraints={"pattern":"^D"}>
        two wrappers that name it: nullable<Owner> <description="B" constraints={"pattern":"^B"}>
        two wrappers that name it, the other way round: nullable<Owner> <description="D" constraints={"pattern":"^D"}>
        beside the \`$ref\`, not under a wrapper: nullable<Owner> <description="D" constraints={"pattern":"^D"}>
        under a wrapper written inline: nullable<Owner> <description="D" constraints={"pattern":"^D"}>
        through an alias of the wrapper: nullable<Owner> <description="D" constraints={"pattern":"^D"}>"
      `);
    });

    it('reads it so wherever it stands among the members, and however many there are', async () => {
      const schemas = { Limits: { minProperties: 1 } };
      expect(
        await table(openapi, [
          ['second', { allOf: [Owner, NotNull] }],
          ['first', { allOf: [NotNull, Owner] }],
          ['two, after', { allOf: [Owner, Described, NotNull] }],
          ['two, around', { allOf: [Described, Owner, NotNull] }],
          ['two, before', { allOf: [NotNull, Described, Owner] }],
          ['three', { allOf: [Described, Owner, ref('Limits'), NotNull] }, schemas],
          ['the same one twice', { allOf: [Described, Owner, Described] }],
          ['beside an inline member that annotates', { allOf: [Owner, Described, { deprecated: true }] }],
          ['beside a `description` on the `allOf`', { description: 'Own text.', allOf: [Owner, Described] }],
          ['beside `required` on the `allOf`', { allOf: [Owner, Described], required: ['name'] }],
          // Two `$ref`s that each say what an instance is are a merge, as they were: the third only annotates it.
          ['between two typing `$ref`s', { allOf: [Owner, Described, Tag] }, tag],
          ['after two typing `$ref`s', { allOf: [Owner, Tag, NotNull] }, tag],
          ['before two typing `$ref`s', { allOf: [ref('Limits'), Owner, Tag] }, { ...schemas, ...tag }],
        ]),
      ).toMatchInlineSnapshot(`
        "second: Owner
        first: Owner
        two, after: Owner <description="Any owner.">
        two, around: Owner <description="Any owner.">
        two, before: Owner <description="Any owner.">
        three: Owner <description="Any owner." constraints={"minProperties":1}>
        the same one twice: nullable<Owner> <description="Any owner.">
        beside an inline member that annotates: nullable<Owner> <description="Any owner." deprecated=true>
        beside a \`description\` on the \`allOf\`: nullable<Owner> <description="Own text.">
        beside \`required\` on the \`allOf\`: nullable<PetOwner> { name } "Any owner." <description="Any owner.">
        between two typing \`$ref\`s: nullable<PetOwner> { name?, label? } "Any owner." <description="Any owner.">
        after two typing \`$ref\`s: PetOwner { name?, label? }
        before two typing \`$ref\`s: nullable<PetOwner> { name?, label? } <constraints={"minProperties":1}>"
      `);
      expect(warnings()).toEqual([]);
    });

    it('reads it so at every site an `allOf` is written at', async () => {
      const pet = { Pet: { type: 'object', properties: { id: string } } };
      const sites: ReadonlyArray<readonly [string, (schema: unknown) => unknown, (spec: ApiSpec) => string]> = [
        ['a field', (s) => ownerDoc(openapi, s), (spec) => ownerLine(spec)],
        [
          'array items',
          (s) => document(openapi, { Pet: { type: 'object', properties: { owners: { type: 'array', items: s } } } }),
          (spec) => show(fieldOf(spec, 'Pet', 'owners')?.type),
        ],
        [
          'map values',
          (s) =>
            document(openapi, {
              Pet: { type: 'object', properties: { owners: { type: 'object', additionalProperties: s } } },
            }),
          (spec) => show(fieldOf(spec, 'Pet', 'owners')?.type),
        ],
        [
          'a union variant',
          (s) => ownerDoc(openapi, { oneOf: [s, { type: 'integer' }] }),
          (spec) => show(fieldOf(spec, 'Pet', 'owner')?.type),
        ],
        [
          'a query parameter',
          (s) =>
            document(openapi, pet, {
              '/owners': {
                get: {
                  operationId: 'listOwners',
                  parameters: [{ name: 'filter', in: 'query', schema: s }],
                  responses: { '204': { description: 'OK' } },
                },
              },
            }),
          (spec) => {
            const [parameter] = operation(spec, 'listOwners').queryParams;
            return `${show(parameter?.type)}${carried(parameter)}`;
          },
        ],
        [
          'a header parameter',
          (s) =>
            document(openapi, pet, {
              '/owners': {
                get: {
                  operationId: 'listOwners',
                  parameters: [{ name: 'X-Owner', in: 'header', schema: s }],
                  responses: { '204': { description: 'OK' } },
                },
              },
            }),
          (spec) => show(operation(spec, 'listOwners').headerParams[0]?.type),
        ],
        [
          'a request body',
          (s) =>
            document(openapi, pet, {
              '/owners': {
                post: { operationId: 'createOwner', requestBody: json(s), responses: { '204': { description: 'OK' } } },
              },
            }),
          (spec) => show(operation(spec, 'createOwner').requestBody),
        ],
        [
          'a response body',
          (s) =>
            document(openapi, pet, {
              '/owners': { get: { operationId: 'getOwner', responses: { '200': { description: 'OK', ...json(s) } } } },
            }),
          (spec) => show(operation(spec, 'getOwner').response),
        ],
        [
          'an error body',
          (s) =>
            document(openapi, pet, {
              '/owners': {
                get: {
                  operationId: 'getOwner',
                  responses: { '204': { description: 'OK' }, '400': { description: 'Bad', ...json(s) } },
                },
              },
            }),
          (spec) => show(operation(spec, 'getOwner').errors[0]?.type),
        ],
        [
          'a response header',
          (s) =>
            document(openapi, pet, {
              '/owners': {
                get: {
                  operationId: 'getOwner',
                  responses: {
                    '200': { description: 'OK', headers: { 'X-Owner': { schema: s } }, ...json(ref('Pet')) },
                  },
                },
              },
            }),
          (spec) => show(operation(spec, 'getOwner').responseHeaders?.[0]?.type),
        ],
        [
          'a component',
          (s) => document(openapi, { Pet: { type: 'object', properties: { owner: ref('Alias') } }, Alias: s }),
          (spec) =>
            `${show(fieldOf(spec, 'Pet', 'owner')?.type)}, bases ${JSON.stringify(modelOf(spec, 'Alias')?.bases?.map(show))}`,
        ],
      ];
      const lines: string[] = [];
      for (const [site, at, line] of sites) {
        for (const [label, byRef, inline] of [
          ['a veto', [Owner, NotNull], [Owner, notNull]],
          ['a veto, first', [NotNull, Owner], [notNull, Owner]],
          ['a `description`', [Owner, Described], [Owner, text]],
        ] as const) {
          const spec = await expectOneIr(at({ allOf: byRef }), at({ allOf: inline }), `${site}: ${label}`);
          // Nothing is minted for the `allOf`: every model is a component the document declares.
          const declared = site === 'a component' ? ['Owner', 'Pet', 'Alias'] : ['Owner', 'Pet'];
          expect(spec.models.map((m) => m.name).sort(), `${site}: ${label}`).toEqual([...declared].sort());
          lines.push(`${site}, ${label}: ${line(spec)}`);
        }
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a field, a veto: Owner
        a field, a veto, first: Owner
        a field, a \`description\`: nullable<Owner> <description="Any owner.">
        array items, a veto: Owner[]
        array items, a veto, first: Owner[]
        array items, a \`description\`: nullable<Owner>[]
        map values, a veto: map<Owner>
        map values, a veto, first: map<Owner>
        map values, a \`description\`: map<nullable<Owner>>
        a union variant, a veto: (Owner | integer)
        a union variant, a veto, first: (Owner | integer)
        a union variant, a \`description\`: (nullable<Owner> | integer)
        a query parameter, a veto: Owner
        a query parameter, a veto, first: Owner
        a query parameter, a \`description\`: nullable<Owner> <description="Any owner.">
        a header parameter, a veto: Owner
        a header parameter, a veto, first: Owner
        a header parameter, a \`description\`: nullable<Owner>
        a request body, a veto: Owner
        a request body, a veto, first: Owner
        a request body, a \`description\`: nullable<Owner>
        a response body, a veto: Owner
        a response body, a veto, first: Owner
        a response body, a \`description\`: nullable<Owner>
        an error body, a veto: Owner
        an error body, a veto, first: Owner
        an error body, a \`description\`: nullable<Owner>
        a response header, a veto: Owner
        a response header, a veto, first: Owner
        a response header, a \`description\`: nullable<Owner>
        a component, a veto: Alias, bases ["Owner"]
        a component, a veto, first: Alias, bases ["Owner"]
        a component, a \`description\`: nullable<Alias>, bases ["Owner"]"
      `);
    });

    it.runIf(openapi === '3.1.0')('reads it so on a webhook payload', async () => {
      const webhook = (schema: unknown) =>
        document(
          openapi,
          { Pet: { type: 'object', properties: { id: string } } },
          {},
          {
            webhooks: {
              ownerChanged: {
                post: {
                  operationId: 'ownerChanged',
                  requestBody: json(schema),
                  responses: { '204': { description: 'OK' } },
                },
              },
            },
          },
        );
      const spec = await expectOneIr(webhook({ allOf: [Owner, NotNull] }), webhook({ allOf: [Owner, notNull] }));
      expect(spec.models.map((m) => m.name)).toEqual(['Owner', 'Pet']);
      expect(show(spec.webhooks?.[0]?.requestBody)).toBe('Owner');
    });

    it('reads a component composed of a `$ref` and such a `$ref` as the one base it has', async () => {
      const Base = { type: 'object', properties: { id: string }, required: ['id'] };
      const composed = (members: unknown[]) => document(openapi, { Base, Pet: { allOf: members } });
      for (const [byRef, inline] of [
        [
          [ref('Base'), Described],
          [ref('Base'), text],
        ],
        [
          [Described, ref('Base')],
          [text, ref('Base')],
        ],
        [
          [ref('Base'), Described, NotNull],
          [ref('Base'), text, notNull],
        ],
      ]) {
        const spec = await expectOneIr(composed(byRef!), composed(inline!));
        const pet = modelOf(spec, 'Pet')!;
        // `Described` is no base and no model: its text is `Pet`'s, as the inline member's is.
        expect(pet.bases?.map(show)).toEqual(['Base']);
        expect(pet.description).toBe('Any owner.');
        expect(pet.fields.map((f) => `${f.name}: ${show(f.type)}${f.required ? '' : '?'}`)).toEqual(['id: string']);
        expect(spec.models.map((m) => m.name).sort()).toEqual(['Base', 'Owner', 'Pet']);
      }
    });

    it('reads it so whatever the other `$ref` names', async () => {
      const schemas = {
        Plain: { type: 'object', properties: { label: string }, required: ['label'] },
        Kind: { type: 'string', enum: ['cat', 'dog'] },
        Names: { type: 'array', items: string, minItems: 1 },
        PetId: { type: 'string', format: 'uuid', minLength: 3 },
        Either: { oneOf: [ref('Plain'), string] },
        Composed: { allOf: [ref('Plain'), { type: 'object', properties: { extra: string } }] },
        OwnerAlias: Owner,
        Limits: { minLength: 1 },
      };
      const lines: string[] = [];
      for (const [label, name] of [
        ['a model', 'Plain'],
        ['an enum', 'Kind'],
        ['an array', 'Names'],
        ['a primitive', 'PetId'],
        ['a named union', 'Either'],
        ['a composed model', 'Composed'],
        ['an alias of a nullable model', 'OwnerAlias'],
      ] as const) {
        const read: string[] = [];
        for (const [byRef, inline] of [
          [
            [ref(name), Described, ref('Limits')],
            [ref(name), text, schemas.Limits],
          ],
          [
            [ref('Limits'), Described, ref(name)],
            [schemas.Limits, text, ref(name)],
          ],
        ]) {
          const spec = await expectOneIr(
            ownerDoc(openapi, { allOf: byRef }, schemas),
            ownerDoc(openapi, { allOf: inline }, schemas),
            label,
          );
          // The reference, and no merge of it under a name of its own.
          expect(modelOf(spec, 'PetOwner'), label).toBeUndefined();
          read.push(ownerLine(spec));
        }
        // In either order of the members.
        expect(read[1], label).toBe(read[0]);
        lines.push(`${label}: ${read[0]}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a model: Plain <description="Any owner." constraints={"minLength":1}>
        an enum: Kind <description="Any owner." constraints={"minLength":1}>
        an array: string[] <description="Any owner." constraints={"minItems":1,"minLength":1}>
        a primitive: string <description="Any owner." constraints={"minLength":3}>
        a named union: Either <description="Any owner." constraints={"minLength":1}>
        a composed model: Composed <description="Any owner." constraints={"minLength":1}>
        an alias of a nullable model: nullable<OwnerAlias> <description="Any owner." constraints={"minLength":1}>"
      `);
    });

    it('keeps a list envelope named beside such a `$ref` the list it is', async () => {
      const schemas = {
        Plain: { type: 'object', properties: { label: string } },
        List: {
          type: 'object',
          properties: { data: { type: 'array', items: ref('Plain') }, has_more: { type: 'boolean' } },
          required: ['data', 'has_more'],
        },
        Pet: { type: 'object', properties: { id: string } },
      };
      const listed = (schema: unknown) =>
        document(openapi, schemas, {
          '/plains': {
            get: { operationId: 'listPlains', responses: { '200': { description: 'OK', ...json(schema) } } },
          },
        });
      const spec = await expectOneIr(
        listed({ allOf: [ref('List'), Described] }),
        listed({ allOf: [ref('List'), text] }),
      );
      // The same as the bare `$ref`, but for the text.
      const bare = operation(await parse(listed(ref('List'))), 'listPlains');
      const read = operation(spec, 'listPlains');
      expect(show(read.response)).toBe(show(bare.response));
      expect(read.pagination).toEqual(bare.pagination);
      expect(spec.models.map((m) => m.name).sort()).toEqual(
        (await parse(listed(ref('List')))).models.map((m) => m.name).sort(),
      );
    });

    it('reads what the component writes as the schema’s own, as an inline member’s is', async () => {
      const schemas = {
        ...tag,
        Limits: { minProperties: 2, maxProperties: 9 },
        Flags: { deprecated: true, readOnly: true, default: null, example: { name: 'Ada' }, 'x-note': 'n' },
        Linked: { externalDocs: { url: 'https://example.com/owners', description: 'Owners.' } },
        Named: { required: ['name'] },
        TextAlias: { ...Described, description: 'Alias text.' },
      };
      expect(
        await table(openapi, [
          // The wrapper's own text wins, then each member's in document order.
          ['its text', { allOf: [Owner, Described] }, schemas],
          ['its text under the schema’s own', { description: 'Own text.', allOf: [Owner, Described] }, schemas],
          [
            'its text after an earlier member’s',
            { allOf: [Owner, { description: 'Inline text.' }, Described] },
            schemas,
          ],
          ['its text before a later member’s', { allOf: [Owner, Described, { description: 'Inline text.' }] }, schemas],
          ['an alias’s text before the component’s', { allOf: [Owner, ref('TextAlias')] }, schemas],
          ['its flags, default, example and keys', { allOf: [Owner, ref('Flags')] }, schemas],
          ['its link', { allOf: [Owner, ref('Linked')] }, schemas],
          // Limits conjoin, the stricter bound winning.
          ['its limits', { allOf: [Owner, ref('Limits')] }, schemas],
          ['its limits beside the schema’s own', { minProperties: 3, allOf: [Owner, ref('Limits')] }, schemas],
          ['its limits beside a member’s', { allOf: [Owner, ref('Limits'), { maxProperties: 5 }] }, schemas],
          // A `required` list adds to the other `$ref`, as one written inline does: the merge, `name` required.
          ['its `required` list', { allOf: [Owner, ref('Named')] }, schemas],
          ['the same list inline', { allOf: [Owner, { required: ['name'] }] }, schemas],
          // A `not` vetoes the `null` the other `$ref` admits.
          ['its veto', { allOf: [Owner, NotNull] }, schemas],
          ['its veto, in a merge', { allOf: [Owner, Tag, NotNull] }, schemas],
        ]),
      ).toMatchInlineSnapshot(`
        "its text: nullable<Owner> <description="Any owner.">
        its text under the schema’s own: nullable<Owner> <description="Own text.">
        its text after an earlier member’s: nullable<Owner> <description="Inline text.">
        its text before a later member’s: nullable<Owner> <description="Any owner.">
        an alias’s text before the component’s: nullable<Owner> <description="Alias text.">
        its flags, default, example and keys: nullable<Owner> <deprecated=true readOnly=true default=null example={"name":"Ada"} extensions={"x-note":"n"}>
        its link: nullable<Owner> <externalDocs={"url":"https://example.com/owners","description":"Owners."}>
        its limits: nullable<Owner> <constraints={"minProperties":2,"maxProperties":9}>
        its limits beside the schema’s own: nullable<Owner> <constraints={"minProperties":3,"maxProperties":9}>
        its limits beside a member’s: nullable<Owner> <constraints={"minProperties":2,"maxProperties":5}>
        its \`required\` list: nullable<PetOwner> { name }
        the same list inline: nullable<PetOwner> { name }
        its veto: Owner
        its veto, in a merge: PetOwner { name?, label? }"
      `);
      expect(warnings()).toEqual([]);
    });

    it('leaves a merge a merge, and adds no field and no base to it', async () => {
      const extra = { type: 'object', properties: { extra: string } };
      // The bases are the typing `$ref`s' components alone (#755: a merge
      // written inline names them as a component's does), never the
      // component that only annotates.
      const rows: ReadonlyArray<readonly [string, unknown[], unknown[], string[], string[]]> = [
        ['two typing `$ref`s', [Owner, Tag, Described], [Owner, Tag, text], ['name', 'label'], ['Owner', 'Tag']],
        [
          'a `$ref` and an inline object',
          [Owner, extra, Described],
          [Owner, extra, text],
          ['name', 'extra'],
          ['Owner'],
        ],
        ['the same, the `$ref` first', [Described, Owner, extra], [text, Owner, extra], ['name', 'extra'], ['Owner']],
        [
          'a `$ref` and inline properties',
          [Owner, { properties: { extra: string } }, NotNull],
          [Owner, { properties: { extra: string } }, notNull],
          ['name', 'extra'],
          ['Owner'],
        ],
      ];
      for (const [label, byRef, inline, fields, bases] of rows) {
        const spec = await expectOneIr(
          ownerDoc(openapi, { allOf: byRef }, tag),
          ownerDoc(openapi, { allOf: inline }, tag),
          label,
        );
        const merged = modelOf(spec, 'PetOwner')!;
        expect(
          merged.bases?.map((base) => (base.kind === 'model' ? base.name : base.kind)),
          label,
        ).toEqual(bases);
        expect(
          merged.fields.map((f) => f.name),
          label,
        ).toEqual(fields);
        expect(
          spec.models.map((m) => m.name),
          label,
        ).toEqual(['Owner', 'Pet', 'Tag', 'PetOwner']);
      }
    });

    it('leaves a `$ref` to a component that says what an instance is a second `$ref`', async () => {
      const typing: ReadonlyArray<readonly [string, Doc]> = [
        ['`properties`', { properties: { label: string } }],
        ['a `type`', { type: 'object' }],
        ['`type: null`', { type: 'null' }],
        ['a primitive `type`', string],
        ['an `enum`', { enum: ['a', 'b'] }],
        ['a `const`', { const: 'a' }],
        ['`items` that declare a type', { items: string }],
        ['a union that types it', { oneOf: [string, { type: 'integer' }] }],
        ['an `additionalProperties` map', { additionalProperties: string }],
        ['an `allOf` reaching `properties`', { allOf: [text, { properties: { label: string } }] }],
        ['an alias of a typing component', Tag],
        ['an `allOf` that reaches itself', { allOf: [ref('Ann'), text] }],
      ];
      const lines: string[] = [];
      for (const [label, component] of typing) {
        const spec = await parse(ownerDoc(openapi, { allOf: [Owner, ref('Ann')] }, { ...tag, Ann: component }));
        // Still the merge two `$ref`s are.
        expect(show(fieldOf(spec, 'Pet', 'owner')?.type).replace(/^nullable<(.*)>$/, '$1'), label).toBe('PetOwner');
        lines.push(`${label}: ${ownerLine(spec)}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "\`properties\`: PetOwner { name?, label? }
        a \`type\`: PetOwner { name? }
        \`type: null\`: nullable<PetOwner> { name? }
        a primitive \`type\`: PetOwner { name? }
        an \`enum\`: PetOwner { name? }
        a \`const\`: PetOwner { name? }
        \`items\` that declare a type: PetOwner { name? }
        a union that types it: PetOwner { name? }
        an \`additionalProperties\` map: PetOwner { name? }
        an \`allOf\` reaching \`properties\`: PetOwner { name?, label? }
        an alias of a typing component: nullable<PetOwner> { name?, label? }
        an \`allOf\` that reaches itself: PetOwner { name? }"
      `);
    });

    it('reads an `allOf` no member of which names a schema that says what an instance is as it did', async () => {
      const schemas = { Limits: { minProperties: 1 } };
      expect(
        await table(openapi, [
          // One such `$ref` is the reference the `allOf` is read as: `unknown`, the field documenting itself (#569).
          ['alone', { allOf: [Described] }, schemas],
          ['beside an inline annotation', { allOf: [Described, { deprecated: true }] }, schemas],
          [
            'beside a `description` of the field’s own',
            { allOf: [Described, { description: 'Documented.' }] },
            schemas,
          ],
          ['beside an inline limit', { allOf: [ref('Limits'), { maxProperties: 5 }] }, schemas],
          ['beside an inline `type`', { allOf: [Described, string] }, schemas],
          ['beside a `type` on the `allOf`', { type: 'string', allOf: [Described] }, schemas],
          ['under a union of one', { allOf: [{ oneOf: [Described] }] }, schemas],
          // Two are the model with no fields two `$ref`s were (#715).
          ['two such `$ref`s', { allOf: [Described, ref('Limits')] }, schemas],
          // And beside an inline object it is the merge it was, the object's fields alone.
          [
            'beside an inline object',
            { allOf: [Described, { type: 'object', properties: { extra: string } }] },
            schemas,
          ],
          ['the `$ref` itself', Described, schemas],
        ]),
      ).toMatchInlineSnapshot(`
        "alone: unknown
        beside an inline annotation: unknown <deprecated=true>
        beside a \`description\` of the field’s own: unknown <description="Documented.">
        beside an inline limit: unknown <constraints={"minProperties":1,"maxProperties":5}>
        beside an inline \`type\`: unknown
        beside a \`type\` on the \`allOf\`: unknown
        under a union of one: (unknown)
        two such \`$ref\`s: PetOwner {  }
        beside an inline object: PetOwner { extra? }
        the \`$ref\` itself: unknown <description="Any owner.">"
      `);
      expect(warnings()).toEqual([]);
    });

    it('weighs a union of one around such a `$ref` as the `$ref` in its place (#717)', async () => {
      const spellings: ReadonlyArray<readonly [string, (name: string) => unknown, (schema: unknown) => unknown]> = [
        ['a `oneOf` of one', (name) => ({ oneOf: [ref(name)] }), (schema) => ({ oneOf: [schema] })],
        ['an `anyOf` of one', (name) => ({ anyOf: [ref(name)] }), (schema) => ({ anyOf: [schema] })],
        [
          'in an `allOf`',
          (name) => ({ allOf: [{ oneOf: [ref(name)] }] }),
          (schema) => ({ allOf: [{ oneOf: [schema] }] }),
        ],
      ];
      for (const [label, around, aroundInline] of spellings) {
        for (const [name, written] of [
          ['Described', text],
          ['NotNull', notNull],
        ] as const) {
          for (const members of [(member: unknown) => [member, Owner], (member: unknown) => [Owner, member]]) {
            // The reference to `Owner`, as beside the `$ref` itself — it was the merge, a copy of `Owner` — and
            // one IR with the same keywords written under the union.
            const spec = await expectOneIr(
              ownerDoc(openapi, { allOf: members(around(name)) }),
              ownerDoc(openapi, { allOf: members(aroundInline(written)) }),
              `${label}: ${name}`,
            );
            expect(show(fieldOf(spec, 'Pet', 'owner')?.type), `${label}: ${name}`).toBe('nullable<Owner>');
            expect(
              spec.models.map((m) => m.name),
              `${label}: ${name}`,
            ).toEqual(['Owner', 'Pet']);
          }
        }
      }
      expect(warnings()).toEqual([]);
    });

    it('weighs a union of nothing but such `$ref`s as bringing no object to a merge either', async () => {
      // A `$ref` on a branch of two or more variants counted as declaring properties, whatever it named, so the
      // `allOf` was the merge, a copy of `Owner`.
      const spec = await expectOneIr(
        ownerDoc(openapi, { allOf: [Owner, { oneOf: [Described, NotNull] }] }),
        ownerDoc(openapi, { allOf: [Owner, { oneOf: [text, notNull] }] }),
      );
      expect(ownerLine(spec)).toBe('nullable<Owner>');
      expect(spec.models.map((m) => m.name)).toEqual(['Owner', 'Pet']);
      // Beside a variant that names a component the union is flattened into the merge, as before.
      expect(await ownerOf(openapi, { allOf: [Owner, { oneOf: [Described, Tag] }] }, tag)).toBe(
        'PetOwner { name?, label? }',
      );
    });

    it('reads it in place beside a member that names a component through a union', async () => {
      // Where the one member that types the `allOf` is a union (#732), the `$ref` beside it only annotates it,
      // as the same keywords written inline do: the `allOf` is that union, and no merge of its variants. (Each
      // `$ref` spelling was the merged `PetOwner`, the second `$ref` making a merge of what #732 reads as the
      // union.)
      const Nick = { Nick: string, ...tag };
      const rows: ReadonlyArray<readonly [string, unknown[], unknown[]]> = [
        [
          'a union of a `$ref` and a primitive',
          [{ anyOf: [Owner, string] }, Described],
          [{ anyOf: [Owner, string] }, text],
        ],
        ['the same, the `$ref` first', [Described, { anyOf: [Owner, string] }], [text, { anyOf: [Owner, string] }]],
        ['the same beside a veto', [{ anyOf: [Owner, string] }, NotNull], [{ anyOf: [Owner, string] }, notNull]],
        ['a union of two `$ref`s', [{ oneOf: [Owner, Tag] }, Described], [{ oneOf: [Owner, Tag] }, text]],
        [
          'a union of two `$ref`s beside a veto and a text',
          [{ oneOf: [Owner, Tag] }, NotNull, Described],
          [{ oneOf: [Owner, Tag] }, notNull, text],
        ],
        [
          'a union of a primitive component and a primitive',
          [{ anyOf: [ref('Nick'), { type: 'integer' }] }, Described],
          [{ anyOf: [ref('Nick'), { type: 'integer' }] }, text],
        ],
        // A union of one `$ref` is the union of one variant it is beside the inline member (#445, #555).
        ['a union of one `$ref`', [{ oneOf: [Owner] }, Described], [{ oneOf: [Owner] }, text]],
        [
          'a nullable wrapper around a `$ref`',
          [{ anyOf: [Tag, { type: 'null' }] }, Described],
          [{ anyOf: [Tag, { type: 'null' }] }, text],
        ],
        // What still makes a merge beside the union: a `required` list, and a second member that types the schema.
        [
          'a `required` list on the `allOf`',
          [{ anyOf: [Owner, string] }, Described],
          [{ anyOf: [Owner, string] }, text],
        ],
        [
          'a second typing `$ref`',
          [{ anyOf: [Owner, string] }, Described, Tag],
          [{ anyOf: [Owner, string] }, text, Tag],
        ],
      ];
      const lines: string[] = [];
      for (const [label, byRef, inline] of rows) {
        const beside = label === 'a `required` list on the `allOf`' ? { required: ['name'] } : {};
        const spec = await expectOneIr(
          ownerDoc(openapi, { allOf: byRef, ...beside }, Nick),
          ownerDoc(openapi, { allOf: inline, ...beside }, Nick),
          label,
        );
        lines.push(`${label}: ${ownerLine(spec)}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a union of a \`$ref\` and a primitive: (nullable<Owner> | string) <description="Any owner.">
        the same, the \`$ref\` first: (nullable<Owner> | string) <description="Any owner.">
        the same beside a veto: (Owner | string)
        a union of two \`$ref\`s: (nullable<Owner> | nullable<Tag>) <description="Any owner.">
        a union of two \`$ref\`s beside a veto and a text: (Owner | Tag) <description="Any owner.">
        a union of a primitive component and a primitive: (string | integer) <description="Any owner.">
        a union of one \`$ref\`: (nullable<Owner>) <description="Any owner.">
        a nullable wrapper around a \`$ref\`: nullable<Tag> <description="Any owner.">
        a \`required\` list on the \`allOf\`: PetOwner { name } "Any owner." <description="Any owner.">
        a second typing \`$ref\`: PetOwner { name?, label? } "Any owner." <description="Any owner.">"
      `);
      expect(warnings()).toEqual([]);
    });

    it('reads a `$ref` to a component that is `true`, `false` or `{}` as that member in its place (#728)', async () => {
      // Where this meets #728, which reads a boolean component. `true` and `{}` admit every instance and say
      // nothing of what one is. `false` admits none, so it is no annotation, and it says nothing of what an
      // instance is either: it stands in the `$ref`'s place as the other two do, and is read as the `false`
      // member the document could have written there (the readers of an `allOf` read it as they read `true`, the
      // parser having no type for a schema that admits nothing). The other reading, a second `$ref` that types
      // the schema, is the copy of `Owner` the issue is about.
      const Anything = ref('Anything');
      const lines: string[] = [];
      for (const value of [true, false, {}]) {
        const written = JSON.stringify(value);
        const schemas = { Anything: value, ...tag };
        const rows: ReadonlyArray<readonly [string, unknown[], unknown[]]> = [
          ['after the `$ref`', [Owner, Anything], [Owner, value]],
          ['before the `$ref`', [Anything, Owner], [value, Owner]],
          ['beside a text and a veto', [Owner, Anything, Described, NotNull], [Owner, value, text, notNull]],
          ['under a wrapper', [Owner, { allOf: [Anything] }], [Owner, { allOf: [value] }]],
          ['beside two typing `$ref`s', [Owner, Anything, Tag], [Owner, value, Tag]],
        ];
        for (const [label, byRef, inline] of rows) {
          const spec = await expectOneIr(
            ownerDoc(openapi, { allOf: byRef }, schemas),
            ownerDoc(openapi, { allOf: inline }, schemas),
            `${written} ${label}`,
          );
          lines.push(`${written} ${label}: ${ownerLine(spec)}`);
        }
        // Beside no member that names a schema that says what an instance is, the `$ref` is read as before.
        lines.push(`${written} alone: ${await ownerOf(openapi, { allOf: [Anything] }, schemas)}`);
        // As the property's own schema, a `$ref` to `false` is the `false` it names: no field, as `owner: false`
        // is none (#746: it was the field `owner: unknown`).
        lines.push(`${written} as the field: ${await ownerOf(openapi, Anything, schemas)}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "true after the \`$ref\`: nullable<Owner>
        true before the \`$ref\`: nullable<Owner>
        true beside a text and a veto: Owner <description="Any owner.">
        true under a wrapper: nullable<Owner>
        true beside two typing \`$ref\`s: nullable<PetOwner> { name?, label? }
        true alone: unknown
        true as the field: unknown
        false after the \`$ref\`: nullable<Owner>
        false before the \`$ref\`: nullable<Owner>
        false beside a text and a veto: Owner <description="Any owner.">
        false under a wrapper: nullable<Owner>
        false beside two typing \`$ref\`s: nullable<PetOwner> { name?, label? }
        false alone: unknown
        false as the field: none
        {} after the \`$ref\`: nullable<Owner>
        {} before the \`$ref\`: nullable<Owner>
        {} beside a text and a veto: Owner <description="Any owner.">
        {} under a wrapper: nullable<Owner>
        {} beside two typing \`$ref\`s: nullable<PetOwner> { name?, label? }
        {} alone: unknown
        {} as the field: unknown"
      `);
    });

    it('keeps a `required` list that reaches a `$ref` variant through a wrapper, beside such a `$ref` (#732)', async () => {
      // Where this meets #732's reading of a `required` list beside the one union member of an `allOf`: the list
      // makes the merge where a `$ref` variant's component reaches properties, whatever stands between the
      // reference and the object — a nullable wrapper, a description around a `$ref`, an alias. A `$ref` member
      // that says nothing, read in its place, leaves that reading to the union and the list: the merged model
      // with `name` required, as with the keywords written inline, and the union where no list is written or the
      // variant reaches no property (`Nick`, a string).
      const object = { type: 'object', properties: { name: string } };
      const legacy = openapi === '3.0.3';
      const components = {
        MaybeOwner: legacy ? { nullable: true, oneOf: [object] } : { oneOf: [object, { type: 'null' }] },
        NullableOwner: legacy ? { nullable: true, allOf: [Owner] } : { anyOf: [Owner, { type: 'null' }] },
        DescribedOwner: { description: 'An owner.', allOf: [Owner] },
        OwnerAlias: Owner,
        Nick: string,
      };
      const required = ['name'];
      const union = (name: string) => ({ anyOf: [ref(name), string] });
      const lines: string[] = [];
      for (const name of ['Owner', 'MaybeOwner', 'NullableOwner', 'DescribedOwner', 'OwnerAlias', 'Nick']) {
        const rows: ReadonlyArray<readonly [string, Doc, Doc]> = [
          ['a text after', { allOf: [union(name), Described], required }, { allOf: [union(name), text], required }],
          ['a text before', { allOf: [Described, union(name)], required }, { allOf: [text, union(name)], required }],
          ['a veto', { allOf: [union(name), NotNull], required }, { allOf: [union(name), notNull], required }],
          [
            'the list on a member',
            { allOf: [union(name), { required }, Described] },
            { allOf: [union(name), { required }, text] },
          ],
          // Such a `$ref` as a variant of the union, beside the variant that reaches the properties.
          [
            'such a `$ref` a variant',
            { allOf: [{ anyOf: [Described, ref(name)] }], required },
            { allOf: [{ anyOf: [text, ref(name)] }], required },
          ],
          ['no list', { allOf: [union(name), Described] }, { allOf: [union(name), text] }],
        ];
        for (const [label, byRef, inline] of rows) {
          const spec = await expectOneIr(
            ownerDoc(openapi, byRef, components),
            ownerDoc(openapi, inline, components),
            `${name}, ${label}`,
          );
          lines.push(`${name}, ${label}: ${ownerLine(spec)}`);
        }
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "Owner, a text after: PetOwner { name } "Any owner." <description="Any owner.">
        Owner, a text before: PetOwner { name } "Any owner." <description="Any owner.">
        Owner, a veto: PetOwner { name }
        Owner, the list on a member: PetOwner { name } "Any owner." <description="Any owner.">
        Owner, such a \`$ref\` a variant: PetOwner { name }
        Owner, no list: (nullable<Owner> | string) <description="Any owner.">
        MaybeOwner, a text after: PetOwner { name } "Any owner." <description="Any owner.">
        MaybeOwner, a text before: PetOwner { name } "Any owner." <description="Any owner.">
        MaybeOwner, a veto: PetOwner { name }
        MaybeOwner, the list on a member: PetOwner { name } "Any owner." <description="Any owner.">
        MaybeOwner, such a \`$ref\` a variant: PetOwner { name }
        MaybeOwner, no list: (nullable<MaybeOwner> | string) <description="Any owner.">
        NullableOwner, a text after: PetOwner { name } "Any owner." <description="Any owner.">
        NullableOwner, a text before: PetOwner { name } "Any owner." <description="Any owner.">
        NullableOwner, a veto: PetOwner { name }
        NullableOwner, the list on a member: PetOwner { name } "Any owner." <description="Any owner.">
        NullableOwner, such a \`$ref\` a variant: PetOwner { name }
        NullableOwner, no list: (nullable<NullableOwner> | string) <description="Any owner.">
        DescribedOwner, a text after: PetOwner { name } "Any owner." <description="Any owner.">
        DescribedOwner, a text before: PetOwner { name } "Any owner." <description="Any owner.">
        DescribedOwner, a veto: PetOwner { name }
        DescribedOwner, the list on a member: PetOwner { name } "Any owner." <description="Any owner.">
        DescribedOwner, such a \`$ref\` a variant: PetOwner { name }
        DescribedOwner, no list: (nullable<DescribedOwner> | string) <description="Any owner.">
        OwnerAlias, a text after: PetOwner { name } "Any owner." <description="Any owner.">
        OwnerAlias, a text before: PetOwner { name } "Any owner." <description="Any owner.">
        OwnerAlias, a veto: PetOwner { name }
        OwnerAlias, the list on a member: PetOwner { name } "Any owner." <description="Any owner.">
        OwnerAlias, such a \`$ref\` a variant: PetOwner { name }
        OwnerAlias, no list: (nullable<OwnerAlias> | string) <description="Any owner.">
        Nick, a text after: (string | string) <description="Any owner.">
        Nick, a text before: (string | string) <description="Any owner.">
        Nick, a veto: (string | string)
        Nick, the list on a member: (string | string) <description="Any owner.">
        Nick, such a \`$ref\` a variant: (unknown | string)
        Nick, no list: (string | string) <description="Any owner.">"
      `);
      expect(warnings()).toEqual([]);
    });
  });

  describe('`saysWhatInstanceIs`', () => {
    const at = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
    const schemas: Record<string, SchemaObject> = {
      Owner: { type: 'object', properties: { name: string } },
      Described: { description: 'Any owner.' },
      Alias: at('Described'),
      Wrapped: { allOf: [at('Described'), { minProperties: 1 }] },
      OwnerAlias: at('Owner'),
      Extended: { allOf: [at('Described'), at('Owner')] },
      // Bare `$ref`s that only name each other, one that names itself, and an `allOf` that does.
      A: at('B'),
      B: at('A'),
      Self: at('Self'),
      Loop: { allOf: [at('Loop'), { description: 'Text.' }] },
      // A loop two components long, beside a member that says nothing.
      Ping: { allOf: [{ allOf: [at('Pong')] }, at('Described')] },
      Pong: { allOf: [at('Ping')] },
      Holder: { type: 'object', properties: { note: { description: 'A note.' }, name: string } },
    };

    it('answers for what a `$ref` and an `allOf` hold, in either reading order', () => {
      const names = Object.keys(schemas);
      for (const order of [names, [...names].reverse()]) {
        expect(within(schemas, () => order.map((name) => `${name}: ${saysWhatInstanceIs(at(name))}`).sort())).toEqual(
          [
            'A: true',
            'Alias: false',
            'B: true',
            'Described: false',
            'Extended: true',
            'Holder: true',
            'Loop: true',
            'Owner: true',
            'OwnerAlias: true',
            'Ping: true',
            'Pong: true',
            'Self: true',
            'Wrapped: false',
          ].sort(),
        );
      }
    });

    it('follows a pointer into a component, and takes a `$ref` no schema answers for the reference it is', () => {
      within(schemas, () => {
        expect(saysWhatInstanceIs({ $ref: '#/components/schemas/Holder/properties/note' })).toBe(false);
        expect(saysWhatInstanceIs({ $ref: '#/components/schemas/Holder/properties/name' })).toBe(true);
        expect(saysWhatInstanceIs(at('Missing'))).toBe(true);
        expect(saysWhatInstanceIs({ $ref: '#/components/parameters/Limit' })).toBe(true);
        expect(saysWhatInstanceIs({ $ref: '#/components/schemas/Holder/properties/nope' })).toBe(true);
      });
      // With no document being read, every `$ref` names no schema.
      expect(saysWhatInstanceIs(at('Described'))).toBe(true);
    });

    it('answers for a schema that is no `$ref` by its own keywords and its members’', () => {
      const cases: ReadonlyArray<readonly [SchemaObject, boolean]> = [
        [{}, false],
        [{ description: 'x' }, false],
        [{ not: { type: 'null' } }, false],
        [{ required: ['a'] }, false],
        [{ nullable: true }, false],
        [{ items: {} }, false],
        [{ anyOf: [{ required: ['a'] }, { maxProperties: 1 }] }, false],
        [{ allOf: [] }, false],
        [{ allOf: [{ allOf: [{ description: 'x' }] }] }, false],
        [{ type: 'object' }, true],
        [{ type: 'null' }, true],
        [{ properties: {} }, true],
        [{ enum: ['a'] }, true],
        [{ const: null }, true],
        [{ items: { type: 'string' } }, true],
        [{ additionalProperties: false }, true],
        [{ oneOf: [{ type: 'string' }] }, true],
        [{ allOf: [{ description: 'x' }, { type: 'string' }] }, true],
      ];
      for (const [schema, says] of cases) expect(saysWhatInstanceIs(schema), JSON.stringify(schema)).toBe(says);
    });

    it('takes a value that is no Schema Object to say nothing, without a memo to key by it', () => {
      for (const value of [true, false, null, 5, 'x', []]) {
        expect(saysWhatInstanceIs(value as unknown as SchemaObject), JSON.stringify(value)).toBe(false);
        // As a member, as the component a `$ref` names, and as a member of that component's `allOf`.
        const components = { Owner: schemas.Owner!, Value: value as unknown as SchemaObject };
        expect(saysWhatInstanceIs(at('Value'), components), JSON.stringify(value)).toBe(false);
        expect(
          saysWhatInstanceIs({ allOf: [value as unknown as SchemaObject, { description: 'x' }] }),
          JSON.stringify(value),
        ).toBe(false);
      }
    });

    it('reads a component many members name once, however the components name each other', () => {
      // `A1: { allOf: [{ $ref: A0 }, { $ref: A0 }] }`, `A2` the same over `A1`, and so on: read twice per level
      // the fortieth would be read a trillion times, and written in place as often.
      const chain: Record<string, SchemaObject> = { A0: { description: 'Any owner.' }, Owner: schemas.Owner! };
      for (let level = 1; level <= 40; level++)
        chain[`A${level}`] = { allOf: [at(`A${level - 1}`), at(`A${level - 1}`)] };
      const started = Date.now();
      within(chain, () => {
        expect(saysWhatInstanceIs(at('A40'))).toBe(false);
        expect(readInlineAllOf([at('Owner'), at('A40')])).toBe('reference');
        // Each schema stands in place once: the reference, then the text the fortieth component reaches.
        expect(splicedAllOfMembers([at('Owner'), at('A40')]).members).toEqual([at('Owner'), chain.A0]);
        expect(schemaToTypeRef({ allOf: [at('Owner'), at('A40')] }, 'owner')).toEqual({ kind: 'model', name: 'Owner' });
      });
      // With an explicit map too, where nothing is kept between readings.
      expect(saysWhatInstanceIs(at('A40'), chain)).toBe(false);
      expect(readInlineAllOf([at('Owner'), at('A40')], undefined, chain)).toBe('reference');
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  describe('the readers of the members', () => {
    const at = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
    const Pet: SchemaObject = { type: 'object', properties: { name: string } };
    const Toy: SchemaObject = { type: 'object', properties: { toy: string } };

    it('`readInlineAllOf` counts the `$ref`s that type the schema, with the components it is handed', () => {
      const components: Record<string, SchemaObject> = {
        Pet,
        Toy,
        Described: { description: 'Any.' },
        Named: { required: ['name'] },
        Kind: { type: 'string', enum: ['cat'] },
      };
      const read = (members: SchemaObject[], wrapper?: SchemaObject) => readInlineAllOf(members, wrapper, components);
      expect(read([at('Pet'), at('Described')])).toBe('reference');
      expect(read([at('Described'), at('Pet')])).toBe('reference');
      expect(read([at('Described'), at('Pet'), at('Described')])).toBe('reference');
      expect(read([at('Pet'), at('Toy'), at('Described')])).toBe('merged');
      expect(read([at('Pet'), at('Described'), { properties: { extra: string } }])).toBe('merged');
      // A `required` list adds to the other `$ref`, written by the component, by a member or beside the `allOf`.
      expect(read([at('Pet'), at('Named')])).toBe('merged');
      expect(read([at('Pet'), at('Described')], { required: ['name'] })).toBe('merged');
      // …but to no array, primitive or enum (#359 review).
      expect(read([at('Kind'), at('Named')])).toBe('reference');
      // No member names a schema that says what an instance is: read as before.
      expect(read([at('Described')])).toBe('reference');
      expect(read([at('Described'), at('Named')])).toBe('merged');
      expect(read([at('Described'), { type: 'string' }])).toBe('reference');
    });

    it('reads a `$ref` to a JSON Schema boolean as the boolean in its place', () => {
      // `Anything: true` admits every instance, as `{}` does, and says nothing of what one is. A number, a string
      // and a list written where a schema goes are read as a boolean member is (#728), and stand in place too.
      for (const value of [true, false, 1.5, 0, 'x', '', []]) {
        const label = JSON.stringify(value);
        const written = value as unknown as SchemaObject;
        const components = { Pet, Toy, Anything: written };
        expect(readInlineAllOf([at('Pet'), at('Anything')], undefined, components), label).toBe(
          readInlineAllOf([at('Pet'), written], undefined, components),
        );
        expect(readInlineAllOf([at('Pet'), at('Anything')], undefined, components), label).toBe('reference');
        expect(readInlineAllOf([at('Anything'), at('Pet'), at('Toy')], undefined, components), label).toBe('merged');
        expect(splicedAllOfMembers([at('Pet'), at('Anything')], components).members, label).toEqual([at('Pet'), value]);
        // Under a union it names no component a merge conjoins either (asked of the document's components).
        within(components, () => {
          expect(unionReferencesOf({ oneOf: [at('Anything')] }), label).toEqual([]);
          expect(readInlineAllOf([at('Pet'), { oneOf: [at('Anything')] }]), label).toBe('reference');
        });
      }
    });

    it('leaves a `$ref` to `null` the `$ref` it was', () => {
      // No reader of a member reads `null` written as one, so the `$ref` to it is not read in its place.
      const components = { Pet, Value: null as unknown as SchemaObject };
      const members = [at('Pet'), at('Value')];
      expect(splicedAllOfMembers(members, components).members).toBe(members);
      expect(readInlineAllOf(members, undefined, components)).toBe('merged');
      expect(saysWhatInstanceIs(at('Value'), components)).toBe(false);
    });

    it('`splicedAllOfMembers` writes what the `$ref` names in its place, an alias’s own text first', () => {
      const Described: SchemaObject = { description: 'Any.' };
      const Limits: SchemaObject = { description: 'Outer.', allOf: [{ minProperties: 1 }, at('Described')] };
      const components: Record<string, SchemaObject> = {
        Pet,
        Described,
        Limits,
        Alias: { ...at('Described'), description: 'Alias text.', required: ['unread'] },
      };
      const spliced = (members: SchemaObject[]) => splicedAllOfMembers(members, components);
      expect(spliced([at('Pet'), at('Described')])).toEqual({
        members: [at('Pet'), Described],
        required: [],
        spliced: true,
      });
      // The document's own object stands in the member's place.
      expect(spliced([at('Described'), at('Pet')]).members[0]).toBe(Described);
      // An alias: what it writes beside its `$ref` that a schema reads, then what it names.
      expect(spliced([at('Pet'), at('Alias')]).members).toEqual([at('Pet'), { description: 'Alias text.' }, Described]);
      // A wrapper is opened as one written there is, the `$ref` under it read the same way.
      expect(spliced([at('Pet'), at('Limits')]).members).toEqual([
        at('Pet'),
        { description: 'Outer.' },
        { minProperties: 1 },
        Described,
      ]);
      // A schema two members name stands in each one's place, as the same keywords written twice do…
      expect(spliced([at('Described'), at('Pet'), at('Limits')]).members).toEqual([
        Described,
        at('Pet'),
        { description: 'Outer.' },
        { minProperties: 1 },
        Described,
      ]);
      // …and one that two `$ref`s under one wrapper name, itself or through a wrapper on the way, stands under
      // it once.
      components.Twice = { allOf: [at('Described'), at('Described'), at('Limits')] };
      expect(spliced([at('Pet'), at('Twice')]).members).toEqual([
        at('Pet'),
        Described,
        { description: 'Outer.' },
        { minProperties: 1 },
      ]);
      // …where the document first reaches it: a wrapper is opened before the member after it.
      const inlineOfLimits: SchemaObject = { pattern: '^B' };
      components.First = { allOf: [at('Described'), inlineOfLimits] };
      components.Both = { allOf: [at('First'), at('Described')] };
      expect(spliced([at('Pet'), at('Both')]).members).toEqual([at('Pet'), Described, inlineOfLimits]);
      // Where no member names a schema that says what an instance is, nothing is read in place.
      const alone = [at('Described'), { deprecated: true }];
      expect(spliced(alone)).toEqual({ members: alone, required: [], spliced: false });
      expect(spliced(alone).members).toBe(alone);
    });

    it('`unionReferencesOf` names the components a merge conjoins, and none that says nothing', () => {
      const components: Record<string, SchemaObject> = {
        Pet,
        Described: { description: 'Any.' },
        Alias: at('Described'),
      };
      within(components, () => {
        expect(unionReferencesOf({ oneOf: [at('Pet')] })).toEqual([at('Pet')]);
        expect(unionReferencesOf({ oneOf: [at('Described')] })).toEqual([]);
        expect(unionReferencesOf({ anyOf: [at('Alias'), { type: 'null' }] })).toEqual([]);
        expect(unionReferencesOf({ oneOf: [at('Described'), at('Pet')] })).toEqual([at('Pet')]);
        // A `$ref` no schema answers is the reference it is.
        expect(unionReferencesOf({ oneOf: [at('Missing')] })).toEqual([at('Missing')]);
      });
    });
  });

  describe('every document that parsed before parses still', () => {
    const Base = { type: 'object', properties: { id: string } };
    /** `value` as the component `Ann` named beside `Owner`, and as that member written inline. */
    const rows = (value: unknown): ReadonlyArray<readonly [string, unknown]> => [
      ['the component, second', ownerDoc('3.1.0', { allOf: [Owner, ref('Ann')] }, { Ann: value })],
      ['the component, first', ownerDoc('3.1.0', { allOf: [ref('Ann'), Owner] }, { Ann: value })],
      [
        'a member of the component',
        ownerDoc('3.1.0', { allOf: [Owner, ref('Ann')] }, { Ann: { allOf: [text, value] } }),
      ],
      ['a member beside the `$ref`s', ownerDoc('3.1.0', { allOf: [Owner, Described, value] })],
      ['a member of a component `allOf`', document('3.1.0', { Base, Pet: { allOf: [ref('Base'), Described, value] } })],
      ['under a union beside the `$ref`', ownerDoc('3.1.0', { allOf: [{ anyOf: [Owner, value] }, Described] })],
    ];

    it('reads a malformed value where the `$ref`, its component or a member beside it stands', async () => {
      // Each value parsed at each place before #731 read through the `$ref`; a value the parse failed on before is
      // none of this test's.
      const all = [0, 1, 2, 3, 4, 5];
      const values: ReadonlyArray<readonly [string, unknown, readonly number[]]> = [
        ['`true`', true, all],
        ['`false`', false, all],
        ['a number', 5, all],
        ['a string', 'x', all],
        ['a list', [], all],
        ['a list of schemas', [{ description: 'x' }], all],
        ['`{}`', {}, all],
        ['an `allOf` that holds a string', { allOf: 'x' }, [4]],
        ['an `allOf` of `true`', { allOf: [true] }, all],
        ['an `allOf` of `false`', { allOf: [false] }, all],
        ['an `allOf` of a number', { allOf: [5] }, all],
        ['an `allOf` of a string', { allOf: ['x'] }, all],
        ['an `allOf` of a list', { allOf: [[]] }, all],
        ['an `enum` that holds a number', { enum: 5 }, [4, 5]],
        ['a `required` that holds a string', { required: 'x' }, all],
        ['`items: true`', { items: true }, all],
        ['`not: true`', { not: true }, all],
        ['a `not` that holds a number', { not: 5 }, all],
        ['a `description` that holds a number', { description: 5 }, all],
        ['a `title` that holds a number', { title: 5 }, all],
        ['a `type` that holds a number', { type: 5 }, all],
        ['`properties` that hold a number', { properties: 5 }, all],
        ['a `nullable` that holds a string', { nullable: 'yes' }, all],
        ['a `minProperties` that holds a string', { minProperties: 'x' }, all],
        ['a `deprecated` that holds a string', { deprecated: 'yes' }, all],
      ];
      for (const [label, value, places] of values) {
        const at = rows(value);
        for (const place of places) {
          const [where, doc] = at[place]!;
          await expect(parse(doc), `${label} as ${where}`).resolves.toBeDefined();
        }
      }
    });

    it('leaves a `$ref` to a schema it cannot read the `$ref` it was', async () => {
      // `items: null` is read by no reader of a field, so a document that points at one parsed. The reader that
      // asks what a `$ref` member names takes it to say what an instance is, and the parse goes on as it did.
      const pointer = { $ref: '#/components/schemas/Holder/properties/x' };
      const Holder = { type: 'object', properties: { x: { items: null } } };
      for (const owner of [{ allOf: [pointer] }, { allOf: [{ oneOf: [pointer] }, Owner] }]) {
        await expect(parse(ownerDoc('3.1.0', owner, { Holder })), JSON.stringify(owner)).resolves.toBeDefined();
      }
      within({ Holder: Holder as unknown as SchemaObject }, () => {
        expect(saysWhatInstanceIs(pointer)).toBe(true);
        expect(saysWhatInstanceIs({ oneOf: 5 } as unknown as SchemaObject)).toBe(true);
      });
    });
  });
});
