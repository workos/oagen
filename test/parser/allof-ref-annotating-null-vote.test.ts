import { describe, it, expect, afterAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import {
  clearSchemaNameTransform,
  declaresNull,
  extractSchemas,
  nullVote,
  schemaAdmitsNull,
  schemaToTypeRef,
  type SchemaObject,
} from '../../src/parser/schemas.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #715: since #706 an `allOf` merged into one model admits `null`
 * when every member that types it does, and a member that only annotates
 * or limits the schema (`{ description }`, `{ required }`, `{
 * minProperties: 1 }`, `{}`) has no vote. A `$ref` member always voted, by
 * what its component admits, and a component of nothing but annotations
 * writes no `null`, so it voted no: the same annotating member written
 * inline or as a `$ref` to a component gave two types, and `oagen diff`
 * between the two spellings was breaking. A `$ref` now casts the vote of
 * the schema it names (`nullVote`: admits, rejects or abstains), through
 * every alias and wrapper, so a `$ref` to a component that says nothing of
 * what an instance is has no vote, as the same keywords inline have none.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-715-'));
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

/** An object that admits `null`, in the version's own spelling, with one optional string field. */
const nullableObject = (openapi: Version, field: string) => ({
  ...(openapi === '3.0.3' ? { type: 'object', nullable: true } : { type: ['object', 'null'] }),
  properties: { [field]: string },
});

const Owner = ref('Owner');
const Tag = ref('Tag');
const Plain = ref('Plain');
const Described = ref('Described');
const text = { description: 'Any owner.' };

/**
 * The issue's document: `Owner { name }` and `Tag { label }`, both nullable
 * objects, `Described: { description: 'Any owner.' }`, a `Plain { id }`
 * that admits no `null`, and `GET /pets/{petId}` (`getPet`) returning
 * `$ref: Pet`, beside `schemas`.
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
      Described: text,
      Plain: { type: 'object', properties: { id: string } },
      ...schemas,
    },
  },
  ...more,
});

/** `Pet.owner` written as `owner`, beside `schemas`. */
const ownerDoc = (openapi: Version, owner: unknown, schemas: Record<string, unknown> = {}) =>
  document(openapi, { Pet: { type: 'object', properties: { owner } }, ...schemas });
/** The issue's `inline.json` and `ref.json`: the third member written inline, and as a `$ref` to `Described`. */
const inlineDoc = (openapi: Version) => ownerDoc(openapi, { allOf: [Owner, Tag, text] });
const refDoc = (openapi: Version) => ownerDoc(openapi, { allOf: [Owner, Tag, Described] });
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
      return `${show(type.items, named)}[]`;
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

/** `Pet.owner` written as `owner`: its type, and the fields of the model it names. */
async function ownerOf(openapi: Version, owner: unknown, schemas: Record<string, unknown> = {}): Promise<string> {
  const spec = await parse(ownerDoc(openapi, owner, schemas));
  const type = fieldType(spec, 'Pet', 'owner');
  const named = type?.kind === 'nullable' ? type.inner : type;
  const fields =
    named?.kind === 'model' && named.name === 'PetOwner' ? ` { ${fieldNames(spec, 'PetOwner')?.join(', ')} }` : '';
  return `${show(type)}${fields}`;
}
const table = async (
  openapi: Version,
  rows: ReadonlyArray<readonly [string, unknown, Record<string, unknown>?]>,
): Promise<string> => {
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

/** The two documents parse to one IR and `oagen diff` between them exits 0, in either direction. */
async function expectNoDiff(first: unknown, second: unknown, label = ''): Promise<void> {
  const [firstSpec, secondSpec] = [await parse(first), await parse(second)];
  expect(diffSpecs(firstSpec, secondSpec).changes, label).toEqual([]);
  expect(diffSpecs(secondSpec, firstSpec).changes, label).toEqual([]);
  expect(await diffExit(first, second), label).toBe(0);
  expect(await diffExit(second, first), label).toBe(0);
}

describe('#715 an `allOf` member that is a `$ref` to a component that only annotates has no vote on `null`', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it("types the issue's `ref.json` as `inline.json` is typed (the issue's script)", async () => {
      const inline = await parse(inlineDoc(openapi));
      const byRef = await parse(refDoc(openapi));
      // The issue's output was `inline.json owner: nullable<PetOwner>` and `ref.json owner: PetOwner`.
      expect(`inline.json ${script(inline)}`).toBe('inline.json owner: nullable<PetOwner>');
      expect(`ref.json ${script(byRef)}`).toBe('ref.json owner: nullable<PetOwner>');
      expect(fieldNames(byRef, 'PetOwner')).toEqual(['name', 'label']);
      expect(byRef.models.map((m) => m.name)).toEqual(inline.models.map((m) => m.name));
      expect(warnings()).toEqual([]);
    });

    it('reports no change between the two spellings, in either direction (`oagen diff` exits 0)', async () => {
      await expectNoDiff(inlineDoc(openapi), refDoc(openapi));
    });

    it('gives the `$ref` no vote however the component says nothing, as the same schema inline has none', async () => {
      // Each row: what `Described` is, written as the third member inline and named by a `$ref`.
      const components: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ['a `description`', text],
        ['a `required` list', { required: ['name'] }],
        ['a `minProperties` limit', { minProperties: 1 }],
        ['an empty schema', {}],
        ['a `title` and an `example`', { title: 'Described', example: { name: 'Ada' } }],
        ['`nullable: true` with no `type`', { nullable: true }],
        ['a wrapper around a `description`', { allOf: [text] }],
        ['a wrapper around a wrapper around a limit', { allOf: [{ allOf: [{ minProperties: 1 }] }] }],
        ['a documented wrapper around a limit', { ...text, allOf: [{ minProperties: 1 }] }],
        ['an empty `allOf`', { allOf: [] }],
        ['a union of bare limits', { anyOf: [{ required: ['name'] }, { maxProperties: 9 }] }],
        ['`items` that say nothing', { items: {} }],
      ];
      // Since #731 the `$ref` is read as the component's keywords for everything they say, so the two spellings
      // agree on the limit as well (the limit stayed on the component, and `oagen diff` exited 1 for those rows).
      const lines: string[] = [];
      for (const [label, component] of components) {
        // Both documents hold the component; only the member's spelling differs.
        const inline = ownerDoc(openapi, { allOf: [Owner, Tag, component] }, { Described: component });
        const byRef = ownerDoc(openapi, { allOf: [Owner, Tag, Described] }, { Described: component });
        const type = show(fieldType(await parse(byRef), 'Pet', 'owner'));
        expect(type, label).toBe(show(fieldType(await parse(inline), 'Pet', 'owner')));
        lines.push(
          `${label}: ${type}, diff exits ${await diffExit(inline, byRef)} and ${await diffExit(byRef, inline)}`,
        );
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a \`description\`: nullable<PetOwner>, diff exits 0 and 0
        a \`required\` list: nullable<PetOwner>, diff exits 0 and 0
        a \`minProperties\` limit: nullable<PetOwner>, diff exits 0 and 0
        an empty schema: nullable<PetOwner>, diff exits 0 and 0
        a \`title\` and an \`example\`: nullable<PetOwner>, diff exits 0 and 0
        \`nullable: true\` with no \`type\`: nullable<PetOwner>, diff exits 0 and 0
        a wrapper around a \`description\`: nullable<PetOwner>, diff exits 0 and 0
        a wrapper around a wrapper around a limit: nullable<PetOwner>, diff exits 0 and 0
        a documented wrapper around a limit: nullable<PetOwner>, diff exits 0 and 0
        an empty \`allOf\`: nullable<PetOwner>, diff exits 0 and 0
        a union of bare limits: nullable<PetOwner>, diff exits 0 and 0
        \`items\` that say nothing: nullable<PetOwner>, diff exits 0 and 0"
      `);
    });

    it('follows the `$ref` through every alias, wrapper and pointer to the schema it names', async () => {
      expect(
        await table(openapi, [
          ['an alias of the component', { allOf: [Owner, Tag, ref('Alias')] }, { Alias: Described }],
          [
            'an alias of an alias',
            { allOf: [Owner, Tag, ref('Alias2')] },
            { Alias: Described, Alias2: { ...ref('Alias'), description: 'Read through.' } },
          ],
          ['an `allOf` alias', { allOf: [Owner, Tag, ref('Alias')] }, { Alias: { allOf: [Described] } }],
          [
            'an `allOf` of two such components',
            { allOf: [Owner, Tag, ref('Both')] },
            { Both: { allOf: [Described, ref('Limit')] }, Limit: { minProperties: 1 } },
          ],
          ['the member wrapped in an `allOf`', { allOf: [Owner, Tag, { allOf: [Described] }] }],
          ['wrapped twice', { allOf: [Owner, Tag, { allOf: [{ allOf: [Described] }] }] }],
          ['a documented wrapper', { allOf: [Owner, Tag, { description: 'Outer.', allOf: [Described] }] }],
          ['a wrapper that requires a field', { allOf: [Owner, Tag, { allOf: [Described], required: ['name'] }] }],
          [
            'a JSON Pointer to a field that only annotates',
            { allOf: [Owner, Tag, { $ref: '#/components/schemas/Holder/properties/note' }] },
            { Holder: { type: 'object', properties: { note: text } } },
          ],
          [
            'a JSON Pointer to a member of an `allOf`',
            { allOf: [Owner, Tag, { $ref: '#/components/schemas/Holder/properties/note/allOf/1' }] },
            { Holder: { type: 'object', properties: { note: { allOf: [string, { minLength: 1 }] } } } },
          ],
          // Nothing beside a `$ref` is read, so the keywords beside it give it no vote either.
          ['a `type` beside the `$ref`', { allOf: [Owner, Tag, { ...Described, type: 'object' }] }],
          ['a `description` beside the `$ref`', { allOf: [Owner, Tag, { ...Described, description: 'Beside.' }] }],
        ]),
      ).toMatchInlineSnapshot(`
        "an alias of the component: nullable<PetOwner> { name, label }
        an alias of an alias: nullable<PetOwner> { name, label }
        an \`allOf\` alias: nullable<PetOwner> { name, label }
        an \`allOf\` of two such components: nullable<PetOwner> { name, label }
        the member wrapped in an \`allOf\`: nullable<PetOwner> { name, label }
        wrapped twice: nullable<PetOwner> { name, label }
        a documented wrapper: nullable<PetOwner> { name, label }
        a wrapper that requires a field: nullable<PetOwner> { name, label }
        a JSON Pointer to a field that only annotates: nullable<PetOwner> { name, label }
        a JSON Pointer to a member of an \`allOf\`: nullable<PetOwner> { name, label }
        a \`type\` beside the \`$ref\`: nullable<PetOwner> { name, label }
        a \`description\` beside the \`$ref\`: nullable<PetOwner> { name, label }"
      `);
      expect(warnings()).toEqual([]);
    });

    it('gives it no vote wherever it stands among the members', async () => {
      expect(
        await table(openapi, [
          ['first', { allOf: [Described, Owner, Tag] }],
          ['in the middle', { allOf: [Owner, Described, Tag] }],
          ['last', { allOf: [Owner, Tag, Described] }],
          ['twice', { allOf: [Described, Owner, Described, Tag] }],
          // The `allOf` is read as its one other `$ref` (#731: it was a merge, `PetOwner { name }`).
          ['beside one nullable `$ref`', { allOf: [Owner, Described] }],
          ['beside one nullable `$ref`, first', { allOf: [Described, Owner] }],
          ['beside a nullable inline object', { allOf: [nullableObject(openapi, 'extra'), Described] }],
          ['beside an inline member that only annotates', { allOf: [Owner, Tag, Described, { minProperties: 1 }] }],
          ['beside `required` on the `allOf`', { allOf: [Owner, Described], required: ['name'] }],
          ['beside a `description` on the `allOf`', { description: 'Outer.', allOf: [Owner, Tag, Described] }],
        ]),
      ).toMatchInlineSnapshot(`
        "first: nullable<PetOwner> { name, label }
        in the middle: nullable<PetOwner> { name, label }
        last: nullable<PetOwner> { name, label }
        twice: nullable<PetOwner> { name, label }
        beside one nullable \`$ref\`: nullable<Owner>
        beside one nullable \`$ref\`, first: nullable<Owner>
        beside a nullable inline object: nullable<PetOwner> { extra }
        beside an inline member that only annotates: nullable<PetOwner> { name, label }
        beside \`required\` on the \`allOf\`: nullable<PetOwner> { name }
        beside a \`description\` on the \`allOf\`: nullable<PetOwner> { name, label }"
      `);
    });

    it('leaves the vote of every member that says what an instance is as it was', async () => {
      const nullVariant = openapi === '3.0.3' ? { nullable: true } : {};
      const variants = openapi === '3.0.3' ? [Plain] : [Plain, { type: 'null' }];
      expect(
        await table(openapi, [
          // The other members still vote: one that rejects `null` beside the `$ref` rejects it.
          ['beside a `$ref` that admits no `null`', { allOf: [Owner, Plain, Described] }],
          ['beside an inline object typed `object`', { allOf: [Owner, Described, { type: 'object', properties: {} }] }],
          ['beside `type: object` on the `allOf`', { type: 'object', allOf: [Owner, Tag, Described] }],
          ['beside `properties` on the `allOf`', { properties: { extra: string }, allOf: [Owner, Tag, Described] }],
          ['in a wrapper typed `object`', { allOf: [Owner, Tag, { type: 'object', allOf: [Described] }] }],
          [
            'in a wrapper that closes the object',
            { allOf: [Owner, Tag, { additionalProperties: false, allOf: [Described] }] },
          ],
          // A `$ref` to a component that says what an instance is votes by what the component admits.
          ['a `$ref` to a string', { allOf: [Owner, Tag, ref('Name')] }, { Name: string }],
          [
            'a `$ref` to an object with no `type`',
            { allOf: [Owner, Tag, ref('Extra')] },
            { Extra: { properties: { extra: string } } },
          ],
          ['a `$ref` to a map', { allOf: [Owner, Tag, ref('Map')] }, { Map: { additionalProperties: string } }],
          [
            'a `$ref` to an enum',
            { allOf: [Owner, Tag, ref('Kind')] },
            { Kind: { type: 'string', enum: ['cat', 'dog'] } },
          ],
          [
            'a `$ref` to a component typed `object` around nothing but a `description`',
            { allOf: [Owner, Tag, ref('Typed')] },
            { Typed: { type: 'object', allOf: [text] } },
          ],
          [
            'a `$ref` to a nullable union',
            { allOf: [Owner, Tag, ref('Shape')] },
            { Shape: { oneOf: variants, ...nullVariant } },
          ],
          [
            'a `$ref` to an alias of a component that admits no `null`',
            { allOf: [Owner, Tag, ref('Alias')] },
            { Alias: Plain },
          ],
        ]),
      ).toMatchInlineSnapshot(`
        "beside a \`$ref\` that admits no \`null\`: PetOwner { name, id }
        beside an inline object typed \`object\`: PetOwner { name }
        beside \`type: object\` on the \`allOf\`: PetOwner { name, label }
        beside \`properties\` on the \`allOf\`: PetOwner { extra, name, label }
        in a wrapper typed \`object\`: PetOwner { name, label }
        in a wrapper that closes the object: PetOwner { name, label }
        a \`$ref\` to a string: PetOwner { name, label }
        a \`$ref\` to an object with no \`type\`: PetOwner { name, label, extra }
        a \`$ref\` to a map: PetOwner { name, label }
        a \`$ref\` to an enum: PetOwner { name, label }
        a \`$ref\` to a component typed \`object\` around nothing but a \`description\`: PetOwner { name, label }
        a \`$ref\` to a nullable union: nullable<PetOwner> { name, label, id }
        a \`$ref\` to an alias of a component that admits no \`null\`: PetOwner { name, label, id }"
      `);
    });

    it('wraps a `$ref` to a component that is the same `allOf`, as the inline spelling of the component is wrapped', async () => {
      const byRef = ownerDoc(openapi, ref('OwnerTag'), { OwnerTag: { allOf: [Owner, Tag, Described] } });
      const inline = ownerDoc(openapi, ref('OwnerTag'), { OwnerTag: { allOf: [Owner, Tag, text] } });
      const spec = await parse(byRef);
      expect(show(fieldType(spec, 'Pet', 'owner'))).toBe('nullable<OwnerTag>');
      expect(fieldNames(spec, 'OwnerTag')).toEqual(['name', 'label']);
      expect(show(fieldType(await parse(inline), 'Pet', 'owner'))).toBe('nullable<OwnerTag>');
      await expectNoDiff(inline, byRef);
      // An alias of the component carries the `null` too, and a component whose member rejects it carries none.
      const more = await parse(
        document(openapi, {
          OwnerTag: { allOf: [Owner, Tag, Described] },
          OwnerTagAlias: { allOf: [ref('OwnerTag')] },
          OwnerPlain: { allOf: [Owner, Plain, Described] },
          Wrapped: { allOf: [Owner, Tag, { allOf: [Described] }] },
          Pet: {
            type: 'object',
            properties: {
              alias: ref('OwnerTagAlias'),
              plain: ref('OwnerPlain'),
              wrapped: ref('Wrapped'),
              nested: { allOf: [ref('OwnerTag'), Tag] },
            },
          },
        }),
      );
      expect(script(more)).toBe(
        // `OwnerTag` composes `Tag`, so `nested` is `OwnerTag` (#733; it was a copy of it, `PetNested`).
        'alias: nullable<OwnerTagAlias>, plain: OwnerPlain, wrapped: nullable<Wrapped>, nested: nullable<OwnerTag>',
      );
      expect(warnings()).toEqual([]);
    });

    it('keeps the three declarations in three members of `Pet` nullable, as they were', async () => {
      const three = await parse(membersDoc(openapi, [Owner, Tag, Described]));
      expect(script(three)).toBe('owner: nullable<PetOwner>');
      expect(fieldNames(three, 'PetOwner')).toEqual(['name', 'label']);
      // And the same three written by hand as one `allOf` now agree with them.
      await expectNoDiff(membersDoc(openapi, [Owner, Tag, Described]), refDoc(openapi));
    });
  });

  it('types an `allOf` no member of which says what an instance is as it did, admitting no `null`', async () => {
    // Two `$ref`s are a merge to the type builder (`readInlineAllOf`), so the schema is the model it mints, with
    // no fields; no member admits `null`, so nothing wraps it. Inline, the same two members type nothing.
    expect(
      await table('3.1.0', [
        ['two `$ref`s that only annotate', { allOf: [Described, ref('Limit')] }, { Limit: { minProperties: 1 } }],
        ['the same two members inline', { allOf: [text, { minProperties: 1 }] }],
        ['one alone', { allOf: [Described] }],
        ['the `$ref` itself', Described],
      ]),
    ).toMatchInlineSnapshot(`
      "two \`$ref\`s that only annotate: PetOwner {  }
      the same two members inline: unknown
      one alone: unknown
      the \`$ref\` itself: unknown"
    `);
  });
});

describe('#715 two declarations of one property settle `null` by the same vote', () => {
  const merge = { allOf: [Owner, Tag] };

  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('keeps the `null` of a merge beside a declaration that has no vote, as the `allOf` of both by hand does', async () => {
      const seconds: ReadonlyArray<readonly [string, unknown]> = [
        ['a `$ref` to a component that only annotates', Described],
        ['a wrapper around that `$ref`', { allOf: [Described] }],
        ['a wrapper around a `description`', { allOf: [text] }],
        ['a union of bare limits', { anyOf: [{ required: ['name'] }, { maxProperties: 9 }] }],
        // A declaration that rejects `null` still takes it away, and one that admits it leaves it.
        ['a `$ref` to a string', ref('Name')],
        ['a `$ref` to an object that admits no `null`', Plain],
        ['a nullable string', openapi === '3.0.3' ? { type: 'string', nullable: true } : { type: ['string', 'null'] }],
      ];
      const lines: string[] = [];
      for (const [label, second] of seconds) {
        const members = membersDoc(openapi, [merge, second], { Name: string });
        const hand = ownerDoc(openapi, { allOf: [merge, second] }, { Name: string });
        const type = show(fieldType(await parse(members), 'Pet', 'owner'));
        expect(show(fieldType(await parse(hand), 'Pet', 'owner')), label).toBe(type);
        await expectNoDiff(members, hand, label);
        lines.push(`${label}: ${type}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a \`$ref\` to a component that only annotates: nullable<PetOwner>
        a wrapper around that \`$ref\`: nullable<PetOwner>
        a wrapper around a \`description\`: nullable<PetOwner>
        a union of bare limits: nullable<PetOwner>
        a \`$ref\` to a string: PetOwner
        a \`$ref\` to an object that admits no \`null\`: PetOwner
        a nullable string: nullable<PetOwner>"
      `);
    });
  });
});

describe('#715 at every site', () => {
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
            variant: { oneOf: [schema, string] },
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
    return lines.map(([site, type]) => `${site}: ${show(type, () => 'model')}`).join('\n');
  }

  it.each(VERSIONS)('types the `ref.json` spelling nullable wherever it is written (%s)', async (openapi) => {
    const byRef = await sites(openapi, { allOf: [Owner, Tag, Described] });
    expect(byRef.split('\n').filter((line) => !line.includes('nullable<model>'))).toEqual([]);
    // Site for site what the inline spelling is, and the wrapped one.
    expect(byRef).toBe(await sites(openapi, { allOf: [Owner, Tag, text] }));
    expect(await sites(openapi, { allOf: [Owner, Tag, { allOf: [Described] }] })).toBe(byRef);
    expect(warnings()).toEqual([]);
  });

  it('lists every site (3.1.0)', async () => {
    expect(await sites('3.1.0', { allOf: [Owner, Tag, Described] })).toMatchInlineSnapshot(`
      "field: nullable<model>
      component: nullable<model>
      alias: nullable<model>
      items: nullable<model>[]
      values: map<nullable<model>>
      variant: nullable<model> | string
      lone_wrapper: nullable<model>
      documented_wrapper: nullable<model>
      pointer: nullable<model>
      query parameter: nullable<model>
      header parameter: nullable<model>
      cookie parameter: nullable<model>
      request body: nullable<model>
      response body: nullable<model>
      response header: nullable<model>
      error body: nullable<model>
      default response: nullable<model>
      callback body: nullable<model>
      list item: nullable<model>
      component as a request body: nullable<model>
      component as a response body: nullable<model>
      webhook payload: nullable<model>"
    `);
  });

  it.each(VERSIONS)('leaves it bare at every site beside a member that rejects `null` (%s)', async (openapi) => {
    const lines = (await sites(openapi, { allOf: [Owner, Plain, Described] })).split('\n');
    expect(lines.filter((line) => line.includes('nullable'))).toEqual([]);
  });

  it.each(VERSIONS)('parses a boolean member at every site, typed as `{}` in its place is (%s)', async (openapi) => {
    // #715 review: the vote was asked of the boolean at each of these sites, and each failed the parse.
    const empty = await sites(openapi, { allOf: [Owner, Tag, {}] });
    expect(empty.split('\n').filter((line) => !line.includes('nullable<model>'))).toEqual([]);
    expect(await sites(openapi, { allOf: [Owner, Tag, true] })).toBe(empty);
    expect(await sites(openapi, { allOf: [Owner, Tag, false] })).toBe(empty);
    expect(await sites(openapi, { allOf: [Owner, Tag, { allOf: [true] }] })).toBe(empty);
  });
});

describe('#715 `nullVote`', () => {
  const nullableInline = (field: string): SchemaObject => ({
    type: ['object', 'null'],
    properties: { [field]: string },
  });
  const plainInline: SchemaObject = { type: 'object', properties: { id: string } };

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

  it('casts one of three votes for a schema that is no `$ref`', () => {
    const admitting: SchemaObject[] = [
      { type: ['object', 'null'] },
      { type: 'object', nullable: true },
      { type: 'null' },
      { const: null },
      { enum: ['a', null] },
      { oneOf: [plainInline, { type: 'null' }] },
      { allOf: [nullableInline('a')] },
      { allOf: [nullableInline('a'), { minProperties: 1 }] },
      { type: ['object', 'null'], allOf: [plainInline] },
    ];
    const rejecting: SchemaObject[] = [
      plainInline,
      { properties: { a: string } },
      { type: 'string' },
      { enum: ['a', 'b'] },
      { additionalProperties: true },
      { items: string },
      { oneOf: [plainInline, nullableInline('a')] },
      { type: 'object', allOf: [nullableInline('a')] },
      { allOf: [nullableInline('a'), plainInline] },
      { nullable: true, allOf: [plainInline] },
      { additionalProperties: false, allOf: [{ description: 'Closed.' }] },
    ];
    const abstaining: SchemaObject[] = [
      {},
      { description: 'Nothing typed.' },
      { required: ['name'] },
      { minProperties: 1 },
      { nullable: true },
      { items: {} },
      { allOf: [] },
      { allOf: [{ description: 'Text.' }] },
      { allOf: [{ allOf: [{ minProperties: 1 }] }] },
      { description: 'Text.', allOf: [{ minProperties: 1 }] },
      { anyOf: [{ required: ['a'] }, { maxProperties: 1 }] },
    ];
    expect(admitting.filter((schema) => nullVote(schema) !== 'admits')).toEqual([]);
    expect(rejecting.filter((schema) => nullVote(schema) !== 'rejects')).toEqual([]);
    expect(abstaining.filter((schema) => nullVote(schema) !== 'abstains')).toEqual([]);
    // Only a schema that admits `null` admits it: one that rejects it and one that abstains admit none.
    expect([...rejecting, ...abstaining].filter((schema) => schemaAdmitsNull(schema))).toEqual([]);
    expect(admitting.filter((schema) => !schemaAdmitsNull(schema))).toEqual([]);
  });

  it('conjoins the votes of the members: one rejection rejects, else one admission admits', () => {
    const admits = nullableInline('a');
    const rejects = plainInline;
    const abstains: SchemaObject = { description: 'Text.' };
    expect(nullVote({ allOf: [admits, abstains] })).toBe('admits');
    expect(nullVote({ allOf: [abstains, admits, abstains] })).toBe('admits');
    expect(nullVote({ allOf: [admits, rejects] })).toBe('rejects');
    expect(nullVote({ allOf: [rejects, admits] })).toBe('rejects');
    expect(nullVote({ allOf: [abstains, rejects] })).toBe('rejects');
    expect(nullVote({ allOf: [abstains, abstains] })).toBe('abstains');
    // Nested, a member casts the vote its own members conjoin to.
    expect(nullVote({ allOf: [{ allOf: [abstains] }, { allOf: [admits, abstains] }] })).toBe('admits');
    expect(nullVote({ allOf: [{ allOf: [abstains] }, { allOf: [admits, rejects] }] })).toBe('rejects');
    // `schemaAdmitsNull` is the one vote, and admits none for a schema that abstains.
    expect(schemaAdmitsNull({ allOf: [admits, abstains] })).toBe(true);
    expect(schemaAdmitsNull({ allOf: [abstains] })).toBe(false);
    expect(schemaAdmitsNull(abstains)).toBe(false);
    expect(declaresNull({ allOf: [admits, { ...admits }, { allOf: [abstains] }] })).toBe(true);
  });

  it('casts the vote of the schema a `$ref` names, through every hop', () => {
    const schemas: Record<string, SchemaObject> = {
      Owner: nullableInline('name'),
      Plain: plainInline,
      Described: { description: 'Any owner.' },
      Alias: { $ref: '#/components/schemas/Described' },
      AliasOfAlias: { $ref: '#/components/schemas/Alias', type: ['object', 'null'] },
      Wrapper: { allOf: [{ $ref: '#/components/schemas/AliasOfAlias' }] },
      OwnerAlias: { $ref: '#/components/schemas/Owner' },
      PlainAlias: { $ref: '#/components/schemas/Plain', type: ['object', 'null'] },
      Holder: { type: 'object', properties: { note: { minLength: 1 }, owner: nullableInline('held') } },
    };
    const vote = (name: string) => nullVote({ $ref: `#/components/schemas/${name}` });
    expect(
      within(schemas, () =>
        Object.fromEntries(Object.keys(schemas).map((name): [string, string] => [name, vote(name)])),
      ),
    ).toEqual({
      Owner: 'admits',
      Plain: 'rejects',
      Described: 'abstains',
      Alias: 'abstains',
      AliasOfAlias: 'abstains',
      Wrapper: 'abstains',
      OwnerAlias: 'admits',
      // Nothing beside a `$ref` is read: the `type` naming `null` beside it admits none.
      PlainAlias: 'rejects',
      Holder: 'rejects',
    });
    expect(
      within(schemas, () => [
        nullVote({ $ref: '#/components/schemas/Holder/properties/note' }),
        nullVote({ $ref: '#/components/schemas/Holder/properties/owner' }),
        nullVote({ $ref: '#/components/schemas/Wrapper/allOf/0' }),
      ]),
    ).toEqual(['abstains', 'admits', 'abstains']);
  });

  it('rejects `null` for a `$ref` that names no schema, as the reference the type builder types it as', () => {
    const missing: SchemaObject = { $ref: '#/components/schemas/Missing' };
    const elsewhere: SchemaObject = { $ref: '#/components/responses/NotASchema' };
    const offTheEnd: SchemaObject = { $ref: '#/components/schemas/Owner/properties/missing' };
    const schemas = { Owner: nullableInline('name'), Tag: nullableInline('label') };
    const owner: SchemaObject = { $ref: '#/components/schemas/Owner' };
    const tag: SchemaObject = { $ref: '#/components/schemas/Tag' };
    within(schemas, () => {
      for (const dangling of [missing, elsewhere, offTheEnd]) {
        expect(nullVote(dangling), dangling.$ref).toBe('rejects');
        expect(declaresNull({ allOf: [owner, tag, dangling] }), dangling.$ref).toBe(false);
      }
      // The type builder types such a `$ref` as the model it names, which admits no `null`.
      expect(schemaToTypeRef(missing)).toEqual({ kind: 'model', name: 'Missing' });
      expect(declaresNull({ allOf: [owner, tag] })).toBe(true);
    });
    // With no document being read, every `$ref` names no schema.
    expect(nullVote(owner)).toBe('rejects');
  });

  it('ends on a schema that names itself, which rejects `null` from wherever it is read', () => {
    const schemas: Record<string, SchemaObject> = {
      Owner: nullableInline('name'),
      Tag: nullableInline('label'),
      Described: { description: 'Any owner.' },
      // Bare `$ref`s that only name each other, and one that names itself.
      A: { $ref: '#/components/schemas/B' },
      B: { $ref: '#/components/schemas/A' },
      Self: { $ref: '#/components/schemas/Self' },
      // An `allOf` that names itself, alone, beside a member with no vote, and beside one that admits `null`.
      Loop: { allOf: [{ $ref: '#/components/schemas/Loop' }] },
      LoopDescribed: { allOf: [{ $ref: '#/components/schemas/LoopDescribed' }, { description: 'Text.' }] },
      LoopOwner: { allOf: [{ $ref: '#/components/schemas/Owner' }, { $ref: '#/components/schemas/LoopOwner' }] },
      // A loop two components long, through a wrapper.
      Ping: { allOf: [{ allOf: [{ $ref: '#/components/schemas/Pong' }] }, { $ref: '#/components/schemas/Described' }] },
      Pong: { allOf: [{ $ref: '#/components/schemas/Ping' }] },
    };
    const loops = ['A', 'B', 'Self', 'Loop', 'LoopDescribed', 'LoopOwner', 'Ping', 'Pong'];
    const vote = (name: string) => nullVote({ $ref: `#/components/schemas/${name}` });
    // In either reading order: what a schema says does not turn on where the reading started.
    for (const order of [loops, [...loops].reverse()]) {
      expect(
        within(schemas, () => order.map((name) => `${name}: ${vote(name)}`).sort()),
        order.join(),
      ).toEqual(loops.map((name) => `${name}: rejects`).sort());
    }
    // So a merge beside one admits no `null`, and one beside a component both loops name still does.
    within(schemas, () => {
      const owner: SchemaObject = { $ref: '#/components/schemas/Owner' };
      const described: SchemaObject = { $ref: '#/components/schemas/Described' };
      for (const name of loops) {
        expect(declaresNull({ allOf: [owner, { $ref: `#/components/schemas/${name}` }] }), name).toBe(false);
      }
      const tag: SchemaObject = { $ref: '#/components/schemas/Tag' };
      expect(declaresNull({ allOf: [owner, tag, described, { ...described }] })).toBe(true);
      // Beside one `$ref` the `allOf` is that reference (#731: it was a merge, and declared the `null` itself),
      // whose `null` is its component's to carry: `declaresNull` leaves it to the reference, and the type has it.
      const one: SchemaObject = { allOf: [owner, described, { ...described }] };
      expect(declaresNull(one)).toBe(false);
      expect(schemaAdmitsNull(one)).toBe(true);
      expect(schemaToTypeRef(one, 'owner')).toEqual({ kind: 'nullable', inner: { kind: 'model', name: 'Owner' } });
    });
  });

  it('parses a document whose component composes itself, beside the `$ref` with no vote', async () => {
    const spec = await parse(
      document('3.1.0', {
        Loop: { allOf: [ref('Loop'), Described] },
        LoopOwner: { allOf: [ref('LoopOwner'), Owner, Described] },
        Pet: {
          type: 'object',
          properties: {
            loop: { allOf: [Owner, Tag, ref('Loop')] },
            loop_owner: ref('LoopOwner'),
            twice: { allOf: [Owner, Described, Owner, Described] },
          },
        },
      }),
    );
    // `Owner` named twice is `Owner` (#733; it was a copy of it, `PetTwice`).
    expect(script(spec)).toBe('loop: PetLoop, loop_owner: LoopOwner, twice: nullable<Owner>');
  });

  it('reads a component many members name once', async () => {
    // Each level is the `allOf` of two `$ref`s to the level before and a `$ref` with no vote: an unshared walk
    // reads `Level0` 2^40 times for the last one.
    const depth = 40;
    const levels: Record<string, unknown> = { Level0: nullableObject('3.1.0', 'name') };
    for (let level = 1; level <= depth; level++) {
      levels[`Level${level}`] = { allOf: [ref(`Level${level - 1}`), Described, ref(`Level${level - 1}`)] };
    }
    const spec = await parse(
      document('3.1.0', { ...levels, Pet: { type: 'object', properties: { top: ref(`Level${depth}`) } } }),
    );
    expect(script(spec)).toBe(`top: nullable<Level${depth}>`);
  });
});

describe('#715 review: a member that is no Schema Object has no vote', () => {
  /** `value` where a schema goes, as a document may write it. */
  const written = (value: unknown): SchemaObject => value as SchemaObject;

  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('parses a boolean schema among the members, which has no vote, as `{}` has none', async () => {
      // MichaelDeBoey's three cases: `true`, `false` and `{ allOf: [true] }` as the third member each failed the
      // parse (`TypeError: Invalid value used as weak map key`); before, each was `nullable<PetOwner>`.
      const cases: ReadonlyArray<readonly [string, unknown]> = [
        ['`true`', true],
        ['`false`', false],
        ['a wrapper around `true`', { allOf: [true] }],
      ];
      const empty = await ownerOf(openapi, { allOf: [Owner, Tag, {}] });
      expect(empty).toBe('nullable<PetOwner> { name, label }');
      for (const [label, member] of cases) {
        expect(await ownerOf(openapi, { allOf: [Owner, Tag, member] }), label).toBe(empty);
        await expectNoDiff(
          ownerDoc(openapi, { allOf: [Owner, Tag, member] }),
          ownerDoc(openapi, { allOf: [Owner, Tag, {}] }),
          label,
        );
      }
    });

    it('gives a boolean no vote wherever it stands, under any wrapper, and leaves the other members theirs', async () => {
      expect(
        await table(openapi, [
          ['a wrapper around `false`', { allOf: [Owner, Tag, { allOf: [false] }] }],
          ['`true` two wrappers down', { allOf: [Owner, Tag, { allOf: [{ allOf: [true] }] }] }],
          ['a documented wrapper around `true`', { allOf: [Owner, Tag, { description: 'Any.', allOf: [true] }] }],
          ['`true` first', { allOf: [true, Owner, Tag] }],
          ['`true` and `false`, between the others', { allOf: [Owner, true, Tag, false] }],
          ['`true` beside the annotating `$ref`', { allOf: [Owner, Tag, Described, true] }],
          ['`true` beside a nullable inline object', { allOf: [nullableObject(openapi, 'extra'), Tag, true] }],
          // A member that rejects `null` still does, and so does a wrapper that says what an instance is.
          ['`true` beside a `$ref` that admits no `null`', { allOf: [Owner, Plain, true] }],
          ['`false` beside a `$ref` that admits no `null`', { allOf: [Owner, Plain, false] }],
          ['a wrapper typed `object` around `true`', { allOf: [Owner, Tag, { type: 'object', allOf: [true] }] }],
          ['`type: object` beside the `allOf`', { type: 'object', allOf: [Owner, Tag, true] }],
          // One typing member beside a boolean is read as that member, as beside `{}`.
          ['one nullable `$ref` and `true`', { allOf: [Owner, true] }],
          ['one nullable `$ref` and `{}`', { allOf: [Owner, {}] }],
        ]),
      ).toMatchInlineSnapshot(`
        "a wrapper around \`false\`: nullable<PetOwner> { name, label }
        \`true\` two wrappers down: nullable<PetOwner> { name, label }
        a documented wrapper around \`true\`: nullable<PetOwner> { name, label }
        \`true\` first: nullable<PetOwner> { name, label }
        \`true\` and \`false\`, between the others: nullable<PetOwner> { name, label }
        \`true\` beside the annotating \`$ref\`: nullable<PetOwner> { name, label }
        \`true\` beside a nullable inline object: nullable<PetOwner> { extra, label }
        \`true\` beside a \`$ref\` that admits no \`null\`: PetOwner { name, id }
        \`false\` beside a \`$ref\` that admits no \`null\`: PetOwner { name, id }
        a wrapper typed \`object\` around \`true\`: PetOwner { name, label }
        \`type: object\` beside the \`allOf\`: PetOwner { name, label }
        one nullable \`$ref\` and \`true\`: nullable<Owner>
        one nullable \`$ref\` and \`{}\`: nullable<Owner>"
      `);
    });

    it('wraps a `$ref` to a component whose `allOf` holds a boolean', async () => {
      const spec = await parse(
        document(openapi, {
          WithTrue: { allOf: [Owner, Tag, true] },
          WithFalse: { allOf: [Owner, Tag, false] },
          Wrapped: { allOf: [Owner, Tag, { allOf: [true] }] },
          Rejecting: { allOf: [Owner, Plain, true] },
          Pet: {
            type: 'object',
            properties: {
              with_true: ref('WithTrue'),
              with_false: ref('WithFalse'),
              wrapped: ref('Wrapped'),
              rejecting: ref('Rejecting'),
              through: { allOf: [ref('WithTrue'), Tag] },
            },
          },
        }),
      );
      expect(script(spec)).toBe(
        'with_true: nullable<WithTrue>, with_false: nullable<WithFalse>, wrapped: nullable<Wrapped>, ' +
          // `WithTrue` composes `Tag`, so `through` is `WithTrue` (#733; it was a copy of it, `PetThrough`).
          'rejecting: Rejecting, through: nullable<WithTrue>',
      );
      expect(fieldNames(spec, 'WithTrue')).toEqual(['name', 'label']);
    });

    it('reads a boolean under the keywords the vote reads as it did', async () => {
      expect(
        await table(openapi, [
          // `items` that say nothing of an item give the member no vote; a map or a closed object rejects `null`.
          ['`items: true`', { allOf: [Owner, Tag, { items: true }] }],
          ['`items: false`', { allOf: [Owner, Tag, { items: false }] }],
          ['`additionalProperties: true`', { allOf: [Owner, Tag, { additionalProperties: true }] }],
          ['`additionalProperties: false`', { allOf: [Owner, Tag, { additionalProperties: false }] }],
          ['a union of booleans', { allOf: [Owner, Tag, { anyOf: [true, false] }] }],
          ['`not: true`', { allOf: [Owner, Tag, { not: true }] }],
          ['a union with a boolean variant beside the `allOf`', { allOf: [Owner, Tag], anyOf: [true, string] }],
        ]),
      ).toMatchInlineSnapshot(`
        "\`items: true\`: nullable<PetOwner> { name, label }
        \`items: false\`: nullable<PetOwner> { name, label }
        \`additionalProperties: true\`: PetOwner { name, label }
        \`additionalProperties: false\`: PetOwner { name, label }
        a union of booleans: nullable<PetOwner> { name, label }
        \`not: true\`: nullable<PetOwner> { name, label }
        a union with a boolean variant beside the \`allOf\`: PetOwner { name, label }"
      `);
    });

    it('does not fail on a member that is nothing a schema may be', async () => {
      // Malformed, and read as before: a member with no keyword says nothing, so it has no vote.
      expect(
        await table(openapi, [
          ['a number', { allOf: [Owner, Tag, 1] }],
          ['a string', { allOf: [Owner, Tag, 'text'] }],
          ['an empty list', { allOf: [Owner, Tag, []] }],
          ['a list of schemas', { allOf: [Owner, Tag, [string]] }],
          ['a wrapper around a number', { allOf: [Owner, Tag, { allOf: [1] }] }],
        ]),
      ).toMatchInlineSnapshot(`
        "a number: nullable<PetOwner> { name, label }
        a string: nullable<PetOwner> { name, label }
        an empty list: nullable<PetOwner> { name, label }
        a list of schemas: nullable<PetOwner> { name, label }
        a wrapper around a number: nullable<PetOwner> { name, label }"
      `);
    });

    it('keeps the `null` of a merge beside a declaration that wraps a boolean, as the `allOf` of both by hand does', async () => {
      const merge = { allOf: [Owner, Tag] };
      for (const second of [{ allOf: [true] }, { allOf: [false] }, { allOf: [{ allOf: [true] }] }]) {
        const members = membersDoc(openapi, [merge, second]);
        const hand = ownerDoc(openapi, { allOf: [merge, second] });
        expect(show(fieldType(await parse(members), 'Pet', 'owner')), JSON.stringify(second)).toBe(
          'nullable<PetOwner>',
        );
        expect(show(fieldType(await parse(hand), 'Pet', 'owner')), JSON.stringify(second)).toBe('nullable<PetOwner>');
        await expectNoDiff(members, hand, JSON.stringify(second));
      }
    });
  });

  it('abstains for every value that is no Schema Object, before anything is asked of it or remembered for it', () => {
    const nullableInline: SchemaObject = { type: ['object', 'null'], properties: { a: string } };
    const plainInline: SchemaObject = { type: 'object', properties: { id: string } };
    const values: unknown[] = [true, false, null, undefined, 0, 1, '', 'text', [], [nullableInline]];
    for (const value of values) {
      const label = JSON.stringify(value) ?? 'undefined';
      expect(nullVote(written(value)), label).toBe('abstains');
      // Asked twice: nothing was remembered under a key no memo can hold.
      expect(nullVote(written(value)), label).toBe('abstains');
      expect(schemaAdmitsNull(written(value)), label).toBe(false);
    }
    // As a member it changes nothing, at any depth: the others settle the `allOf`. (`null` is left out: the
    // readers that classify an `allOf` fail on a `null` member before any vote is asked, here and on the base.)
    for (const value of values.filter((value) => value !== null && value !== undefined)) {
      const label = JSON.stringify(value);
      expect(nullVote({ allOf: [nullableInline, written(value)] }), label).toBe('admits');
      expect(nullVote({ allOf: [written(value), plainInline] }), label).toBe('rejects');
      expect(nullVote({ allOf: [written(value)] }), label).toBe('abstains');
      expect(nullVote({ allOf: [{ allOf: [{ allOf: [written(value)] }] }, nullableInline] }), label).toBe('admits');
      expect(declaresNull({ allOf: [nullableInline, { ...nullableInline }, written(value)] }), label).toBe(true);
    }
    // `true` votes as `{}` does, and `false` as `true`: the readers of an `allOf` read either as no member at all.
    expect(nullVote(written(true))).toBe(nullVote({}));
    expect(nullVote(written(false))).toBe(nullVote(written(true)));
    expect(nullVote({ allOf: [written(true), written(false)] })).toBe('abstains');
  });
});

describe('#715 what the vote does not follow', () => {
  it('leaves a member that is an array or a union voting as the type builder types it alone, whatever a `$ref` in it names', async () => {
    // Only a member's own `$ref` is answered by the schema it names. A `$ref` under `items` or among the variants
    // of a union is a type to every reader (`declaresType`, `unionTypesSchema`), so the member is the array or the
    // union the type builder types it as alone, and votes as one, as it did.
    const members: ReadonlyArray<readonly [string, unknown]> = [
      ['`items` that are the `$ref`', { items: Described }],
      ['a union of two such `$ref`s', { anyOf: [Described, ref('Limit')] }],
    ];
    const lines: string[] = [];
    for (const [label, member] of members) {
      const spec = await parse(
        document('3.1.0', {
          Limit: { minProperties: 1 },
          Pet: { type: 'object', properties: { alone: member, owner: { allOf: [Owner, Tag, member] } } },
        }),
      );
      lines.push(`${label}: ${script(spec)}`);
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "\`items\` that are the \`$ref\`: alone: unknown[], owner: PetOwner
      a union of two such \`$ref\`s: alone: unknown | unknown, owner: PetOwner"
    `);
  });
});
