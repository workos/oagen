import { describe, it, expect, afterAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { declaresNull, schemaAdmitsNull, type SchemaObject } from '../../src/parser/schemas.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #676: two `allOf` members that declare one property are conjoined
 * as the `allOf` of both, and that conjunction admits `null` exactly when
 * every declaration does (#653). Written by hand as that `allOf`, the
 * property was not nullable — `null` was read through an `allOf` only when
 * the `allOf` was read as one member — so `owner: { allOf: [{ $ref: Owner
 * }, { $ref: Tag }] }` over two nullable components was the bare
 * `PetOwner` where the two-member spelling was `nullable<PetOwner>`, and
 * `oagen diff` between the two spellings was breaking. An `allOf` merged
 * into one model now admits `null` exactly when every member that types it
 * does, by the one reading the conjunction settles its own by
 * (`schemaAdmitsNull`), at every site and as a component.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-676-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}
const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeDoc(doc));

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const model = (name: string): TypeRef => ({ kind: 'model', name });
const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
const string = { type: 'string' };

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

/** An object that admits `null`, in the version's own spelling, with one optional string field. */
const nullableObject = (openapi: Version, field: string, more: Record<string, unknown> = {}) => ({
  ...(openapi === '3.0.3' ? { type: 'object', nullable: true } : { type: ['object', 'null'] }),
  properties: { [field]: string },
  ...more,
});
/** A nullable wrapper around `variant`, in the version's own spelling: a `null` variant, or the flag that stands for one. */
const nullableWrapper = (openapi: Version, variant: unknown) =>
  openapi === '3.0.3' ? { oneOf: [variant], nullable: true } : { oneOf: [variant, { type: 'null' }] };

const Owner = ref('Owner');
const Tag = ref('Tag');
const Plain = ref('Plain');
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });

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
  info: { title: 'repro', version: '1' },
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

/** `members.json`: `Pet` as an `allOf` of two members, each declaring `owner`. */
const membersDoc = (openapi: Version, first: unknown, second: unknown, schemas: Record<string, unknown> = {}) =>
  document(openapi, {
    Pet: {
      allOf: [
        { type: 'object', properties: { owner: first } },
        { type: 'object', properties: { owner: second } },
      ],
    },
    ...schemas,
  });
/** `repro.json`: `Pet.owner` as the `allOf` of both, written by hand. */
const byHandDoc = (openapi: Version, members: unknown[], schemas: Record<string, unknown> = {}) =>
  document(openapi, { Pet: { type: 'object', properties: { owner: { allOf: members } } }, ...schemas });

const modelOf = (spec: ApiSpec, name: string) => spec.models.find((m) => m.name === name);
const fieldNames = (spec: ApiSpec, name: string) => modelOf(spec, name)?.fields.map((f) => f.name);
const fieldType = (spec: ApiSpec, name: string, field: string) =>
  modelOf(spec, name)?.fields.find((f) => f.name === field)?.type;
const operations = (spec: ApiSpec): Operation[] => spec.services.flatMap((s) => s.operations);
const operation = (spec: ApiSpec, name: string) => operations(spec).find((op) => op.name === name)!;

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

describe('#676 an `allOf` merged into one model admits `null` exactly when every member that types it does', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it("types the issue's `allOf` of two nullable `$ref`s as the two-member spelling is typed", async () => {
      const members = await parse(membersDoc(openapi, Owner, Tag));
      const repro = await parse(byHandDoc(openapi, [Owner, Tag]));
      expect(fieldType(members, 'Pet', 'owner')).toEqual(nullable(model('PetOwner')));
      expect(fieldType(repro, 'Pet', 'owner')).toEqual(nullable(model('PetOwner')));
      expect(fieldNames(repro, 'PetOwner')).toEqual(['name', 'label']);
      expect(repro).toEqual(members);
      expect(warnings()).toEqual([]);
    });

    it('reports no change between the two spellings, in either direction (`oagen diff` exits 0)', async () => {
      const members = membersDoc(openapi, Owner, Tag);
      const repro = byHandDoc(openapi, [Owner, Tag]);
      expect(diffSpecs(await parse(members), await parse(repro)).changes).toEqual([]);
      expect(diffSpecs(await parse(repro), await parse(members)).changes).toEqual([]);
      expect(await diffExit(members, repro)).toBe(0);
      expect(await diffExit(repro, members)).toBe(0);
    });

    it('types two nullable inline objects in place of the `$ref`s the same way', async () => {
      const first = nullableObject(openapi, 'name');
      const second = nullableObject(openapi, 'label');
      const members = await parse(membersDoc(openapi, first, second));
      const repro = await parse(byHandDoc(openapi, [first, second]));
      expect(fieldType(members, 'Pet', 'owner')).toEqual(nullable(model('PetOwner')));
      expect(fieldType(repro, 'Pet', 'owner')).toEqual(nullable(model('PetOwner')));
      expect(fieldNames(repro, 'PetOwner')).toEqual(['name', 'label']);
      expect(diffSpecs(members, repro).changes).toEqual([]);
      expect(diffSpecs(repro, members).changes).toEqual([]);
    });

    it('wraps a `$ref` to a component that is the `allOf` of two nullable `$ref`s', async () => {
      const spec = await parse(
        document(openapi, {
          OwnerTag: { allOf: [Owner, Tag] },
          Pet: { type: 'object', properties: { owner: ref('OwnerTag') } },
        }),
      );
      expect(fieldType(spec, 'Pet', 'owner')).toEqual(nullable(model('OwnerTag')));
      expect(fieldNames(spec, 'OwnerTag')).toEqual(['name', 'label']);
      expect(warnings()).toEqual([]);
    });
  });
});

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

/** `owner` written by hand as `schema`: its type, and the fields of the model it names. */
async function byHand(openapi: Version, schema: unknown, schemas: Record<string, unknown> = {}): Promise<string> {
  const spec = await parse(document(openapi, { Pet: { type: 'object', properties: { owner: schema } }, ...schemas }));
  const type = fieldType(spec, 'Pet', 'owner');
  const named = type?.kind === 'nullable' ? type.inner : type;
  const fields =
    named?.kind === 'model' && named.name === 'PetOwner' ? ` { ${fieldNames(spec, 'PetOwner')?.join(', ')} }` : '';
  return `${show(type)}${fields}`;
}
const table = async (
  openapi: Version,
  rows: ReadonlyArray<readonly [string, unknown]>,
  schemas: Record<string, unknown> = {},
): Promise<string> => {
  const lines: string[] = [];
  for (const [label, schema] of rows) lines.push(`${label}: ${await byHand(openapi, schema, schemas)}`);
  return lines.join('\n');
};

/** `first` and `second` as two members' declarations of `owner`, and as the `allOf` of both by hand: one type, and no `oagen diff` either way. */
async function expectSpellingsAgree(openapi: Version, first: unknown, second: unknown, label: string): Promise<string> {
  const members = await parse(membersDoc(openapi, first, second));
  const hand = await parse(byHandDoc(openapi, [first, second]));
  expect(show(fieldType(hand, 'Pet', 'owner')), label).toBe(show(fieldType(members, 'Pet', 'owner')));
  expect(diffSpecs(members, hand).changes, label).toEqual([]);
  expect(diffSpecs(hand, members).changes, label).toEqual([]);
  return show(fieldType(hand, 'Pet', 'owner'));
}

describe('#676 the members of an `allOf` vote on `null` by one rule, written by hand or conjoined from two declarations', () => {
  const extra = { type: 'object', properties: { extra: string } };
  const untyped = { properties: { extra: string } };
  const text = { description: 'The owner.' };

  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const inlineNullable = nullableObject(openapi, 'extra');
    const nullableTyped = (...members: unknown[]) =>
      openapi === '3.0.3'
        ? { type: 'object', nullable: true, allOf: members }
        : { type: ['object', 'null'], allOf: members };

    it('admits `null` exactly when every member that types the `allOf` does, in either member order, as the conjunction of the same two declarations does', async () => {
      const pairs: ReadonlyArray<readonly [string, unknown, unknown]> = [
        ['two nullable `$ref`s', Owner, Tag],
        ['a nullable `$ref` and one that admits no `null`', Owner, Plain],
        ['a nullable `$ref` and a nullable inline object', Owner, inlineNullable],
        ['a nullable `$ref` and an inline object typed `object`', Owner, extra],
        ['a nullable `$ref` and an inline object with no `type`', Owner, untyped],
        ['a nullable `$ref` and a wrapper around another', Owner, { allOf: [Tag] }],
        ['a nullable `$ref` and a wrapper around one that admits no `null`', Owner, { allOf: [Plain] }],
        ['a wrapper around two nullable `$ref`s and a nullable inline object', { allOf: [Owner, Tag] }, inlineNullable],
        ['a nullable `$ref` and a wrapper typed `object` around another', Owner, { type: 'object', allOf: [Tag] }],
        [
          'a nullable `$ref` and a wrapper typed nullable around one that admits no `null`',
          Owner,
          nullableTyped(Plain),
        ],
        [
          'a nullable `$ref` and a wrapper flagged `nullable: true` with no `type`',
          Owner,
          { nullable: true, allOf: [Plain] },
        ],
        ['a nullable `$ref` and a wrapper that also requires a field', Tag, { allOf: [Owner], required: ['name'] }],
        ['a nullable `$ref` and a `$ref` to an alias of another', Owner, ref('TagAlias')],
        ['a nullable `$ref` and a `$ref` to a component that merges two nullable ones', Owner, ref('OwnerTag')],
        ['a `$ref` that admits no `null` and a `$ref` to that component', Plain, ref('OwnerTag')],
      ];
      const lines: string[] = [];
      const schemas = { TagAlias: { allOf: [Tag] }, OwnerTag: { allOf: [Owner, Tag] } };
      for (const [label, first, second] of pairs) {
        const types: string[] = [];
        for (const [a, b] of [
          [first, second],
          [second, first],
        ]) {
          const members = await parse(membersDoc(openapi, a, b, schemas));
          const hand = await parse(byHandDoc(openapi, [a, b], schemas));
          const type = show(fieldType(hand, 'Pet', 'owner'));
          expect(type, label).toBe(show(fieldType(members, 'Pet', 'owner')));
          expect(diffSpecs(members, hand).changes, label).toEqual([]);
          expect(diffSpecs(hand, members).changes, label).toEqual([]);
          types.push(type);
        }
        expect(types[1], label).toBe(types[0]);
        lines.push(`${label}: ${types[0]}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "two nullable \`$ref\`s: nullable<PetOwner>
        a nullable \`$ref\` and one that admits no \`null\`: PetOwner
        a nullable \`$ref\` and a nullable inline object: nullable<PetOwner>
        a nullable \`$ref\` and an inline object typed \`object\`: PetOwner
        a nullable \`$ref\` and an inline object with no \`type\`: PetOwner
        a nullable \`$ref\` and a wrapper around another: nullable<PetOwner>
        a nullable \`$ref\` and a wrapper around one that admits no \`null\`: PetOwner
        a wrapper around two nullable \`$ref\`s and a nullable inline object: nullable<PetOwner>
        a nullable \`$ref\` and a wrapper typed \`object\` around another: PetOwner
        a nullable \`$ref\` and a wrapper typed nullable around one that admits no \`null\`: nullable<PetOwner>
        a nullable \`$ref\` and a wrapper flagged \`nullable: true\` with no \`type\`: PetOwner
        a nullable \`$ref\` and a wrapper that also requires a field: nullable<PetOwner>
        a nullable \`$ref\` and a \`$ref\` to an alias of another: nullable<PetOwner>
        a nullable \`$ref\` and a \`$ref\` to a component that merges two nullable ones: nullable<PetOwner>
        a \`$ref\` that admits no \`null\` and a \`$ref\` to that component: PetOwner"
      `);
      expect(warnings()).toEqual([]);
    });

    it('gives a member that declares no type no vote, and a `type` beside the `allOf` the last word', async () => {
      expect(
        await table(openapi, [
          // Members that only annotate or limit the schema say nothing of `null`.
          ['a `description` member', { allOf: [Owner, Tag, text] }],
          ['a `required` member', { allOf: [Owner, Tag, { required: ['name'] }] }],
          ['a `minProperties` member', { allOf: [Owner, Tag, { minProperties: 1 }] }],
          ['one nullable `$ref` and `required` beside the `allOf`', { allOf: [Owner], required: ['name'] }],
          ['the same beside a `$ref` that admits no `null`', { allOf: [Plain], required: ['id'] }],
          // What is written beside the `allOf`.
          ['a `description` beside it', { ...text, allOf: [Owner, Tag] }],
          ['`type: object` beside it', { type: 'object', allOf: [Owner, Tag] }],
          ['a nullable `type` beside members that admit no `null`', nullableTyped(Owner, Plain)],
          ['`nullable: true` with no `type`, beside nullable members', { nullable: true, allOf: [Owner, Tag] }],
          [
            '`nullable: true` with no `type`, beside a member that admits no `null`',
            { nullable: true, allOf: [Owner, Plain] },
          ],
          ['`properties` beside it', { properties: { extra: string }, allOf: [Owner, Tag] }],
          // Nothing beside a `$ref` is read.
          [
            'a `type` list naming `null` beside a `$ref` member',
            { allOf: [{ ...Plain, type: ['object', 'null'] }, Owner] },
          ],
        ]),
      ).toMatchInlineSnapshot(`
        "a \`description\` member: nullable<PetOwner> { name, label }
        a \`required\` member: nullable<PetOwner> { name, label }
        a \`minProperties\` member: nullable<PetOwner> { name, label }
        one nullable \`$ref\` and \`required\` beside the \`allOf\`: nullable<PetOwner> { name }
        the same beside a \`$ref\` that admits no \`null\`: PetOwner { id }
        a \`description\` beside it: nullable<PetOwner> { name, label }
        \`type: object\` beside it: PetOwner { name, label }
        a nullable \`type\` beside members that admit no \`null\`: nullable<PetOwner> { name, id }
        \`nullable: true\` with no \`type\`, beside nullable members: nullable<PetOwner> { name, label }
        \`nullable: true\` with no \`type\`, beside a member that admits no \`null\`: PetOwner { name, id }
        \`properties\` beside it: PetOwner { extra, name, label }
        a \`type\` list naming \`null\` beside a \`$ref\` member: PetOwner { id, name }"
      `);
      expect(warnings()).toEqual([]);
    });

    it('reads a `oneOf`/`anyOf` member, and one written beside the `allOf`, as the union votes', async () => {
      const a = { type: 'object', properties: { a: string } };
      const b = { type: 'object', properties: { b: string } };
      const nullVariant = openapi === '3.0.3' ? [] : [{ type: 'null' }];
      const flag = openapi === '3.0.3' ? { nullable: true } : {};
      expect(
        await table(
          openapi,
          [
            [
              'a nullable wrapper around a `$ref` that admits no `null`',
              { allOf: [Owner, nullableWrapper(openapi, a)] },
            ],
            ['an `anyOf` wrapper', { allOf: [Owner, { anyOf: [a, ...nullVariant], ...flag }] }],
            ['a union of two objects and `null`', { allOf: [Owner, { oneOf: [a, b, ...nullVariant], ...flag }] }],
            ['a union of two objects', { allOf: [Owner, { oneOf: [a, b] }] }],
            ['a union with `null` beside the `allOf`', { allOf: [Owner, Tag], oneOf: [a, b, ...nullVariant], ...flag }],
            ['a union without `null` beside the `allOf`', { allOf: [Owner, Tag], oneOf: [a, b] }],
            [
              'a union with `null` beside a member that admits none',
              { allOf: [Owner, Plain], oneOf: [a, ...nullVariant], ...flag },
            ],
            ['a `$ref` to a nullable union component', { allOf: [Owner, ref('Shape')] }],
          ],
          {
            Cat: { type: 'object', properties: { meow: string } },
            Dog: { type: 'object', properties: { bark: string } },
            Shape: { oneOf: [ref('Cat'), ref('Dog'), ...nullVariant], ...flag },
          },
        ),
      ).toMatchInlineSnapshot(`
        "a nullable wrapper around a \`$ref\` that admits no \`null\`: nullable<PetOwner> { name, a }
        an \`anyOf\` wrapper: nullable<PetOwner> { name, a }
        a union of two objects and \`null\`: nullable<PetOwner> { name, a, b }
        a union of two objects: PetOwner { name, a, b }
        a union with \`null\` beside the \`allOf\`: nullable<PetOwner> { name, label, a, b }
        a union without \`null\` beside the \`allOf\`: PetOwner { name, label, a, b }
        a union with \`null\` beside a member that admits none: PetOwner { name, id, a }
        a \`$ref\` to a nullable union component: nullable<PetOwner> { name, meow, bark }"
      `);
    });
  });

  it('reads a member that admits `null` alone, and an `enum:` list naming it, as admitting it', async () => {
    expect(
      await table('3.1.0', [
        ['`const: null`', { allOf: [Owner, Tag, { const: null }] }],
        ['`type: null`', { allOf: [Owner, Tag, { type: 'null' }] }],
        ['`enum: [null]`', { allOf: [Owner, Tag, { enum: [null] }] }],
        ['a member typed `string`', { allOf: [Owner, Tag, { type: 'string' }] }],
      ]),
    ).toMatchInlineSnapshot(`
      "\`const: null\`: nullable<PetOwner> { name, label }
      \`type: null\`: nullable<PetOwner> { name, label }
      \`enum: [null]\`: nullable<PetOwner> { name, label }
      a member typed \`string\`: PetOwner { name, label }"
    `);
  });

  it('keeps `required` beside the `allOf` on the merged model, and the `null` on the reference to it', async () => {
    const required = await parse(
      document('3.1.0', {
        Required: { allOf: [Owner], required: ['name'] },
        Typed: { type: 'object', allOf: [Owner, Tag] },
        Pet: {
          type: 'object',
          properties: {
            owner: { allOf: [Owner], required: ['name'] },
            required: ref('Required'),
            typed: ref('Typed'),
          },
        },
      }),
    );
    expect(Object.fromEntries(modelOf(required, 'Pet')!.fields.map((f) => [f.name, show(f.type)]))).toEqual({
      owner: 'nullable<PetOwner>',
      required: 'nullable<Required>',
      // `type: 'object'` beside a component's `allOf` rejects `null`, whatever its members admit.
      typed: 'Typed',
    });
    for (const name of ['PetOwner', 'Required']) {
      expect(modelOf(required, name)!.fields.map((f) => [f.name, f.required])).toEqual([['name', true]]);
    }
  });

  it('leaves an `allOf` read as one member the member it is read as, beside a `type` that names no `null` too', async () => {
    // Not a merge: the reference carries the component's own `null`, as it did.
    expect(
      await table('3.1.0', [
        ['a lone nullable `$ref`', { allOf: [Owner] }],
        ['a nullable `$ref` beside a `description` member', { allOf: [Owner, text] }],
        ['`type: object` beside a lone nullable `$ref`', { type: 'object', allOf: [Owner] }],
        ['a lone nullable inline object', { allOf: [nullableObject('3.1.0', 'extra')] }],
      ]),
    ).toMatchInlineSnapshot(`
      "a lone nullable \`$ref\`: nullable<Owner>
      a nullable \`$ref\` beside a \`description\` member: nullable<Owner>
      \`type: object\` beside a lone nullable \`$ref\`: nullable<Owner>
      a lone nullable inline object: nullable<PetOwner> { extra }"
    `);
  });

  it('ends on a component that composes itself, and reads a component two members name for each', async () => {
    const spec = await parse(
      document('3.1.0', {
        // `Loop` composes itself: it admits nothing through the loop.
        Loop: { allOf: [ref('Loop'), Owner] },
        Mutual1: { allOf: [ref('Mutual2'), Owner] },
        Mutual2: { allOf: [ref('Mutual1'), Tag] },
        Pet: {
          type: 'object',
          properties: {
            loop: ref('Loop'),
            mutual: ref('Mutual1'),
            twice: { allOf: [Owner, Owner] },
            twice_wrapped: { allOf: [{ allOf: [Owner] }, { allOf: [Owner, text] }] },
          },
        },
      }),
    );
    expect(Object.fromEntries(modelOf(spec, 'Pet')!.fields.map((f) => [f.name, show(f.type)]))).toEqual({
      loop: 'Loop',
      mutual: 'Mutual1',
      twice: 'nullable<PetTwice>',
      twice_wrapped: 'nullable<PetTwiceWrapped>',
    });
  });
});

describe('#676 `declaresNull` and `schemaAdmitsNull`', () => {
  const nullableInline = (field: string): SchemaObject => ({
    type: ['object', 'null'],
    properties: { [field]: string },
  });
  const plainInline: SchemaObject = { type: 'object', properties: { id: string } };

  it('declares the `null` of a merge whose every typing member admits it, and of no other merge', () => {
    expect(declaresNull({ allOf: [nullableInline('a'), nullableInline('b')] })).toBe(true);
    expect(declaresNull({ allOf: [nullableInline('a'), nullableInline('b'), { description: 'Both.' }] })).toBe(true);
    expect(declaresNull({ allOf: [nullableInline('a'), plainInline] })).toBe(false);
    expect(declaresNull({ allOf: [nullableInline('a'), { properties: { b: string } }] })).toBe(false);
    expect(declaresNull({ type: 'object', allOf: [nullableInline('a'), nullableInline('b')] })).toBe(false);
    expect(declaresNull({ properties: { own: string }, allOf: [nullableInline('a'), nullableInline('b')] })).toBe(
      false,
    );
    // A member that is itself an `allOf` votes through its own members, its `type` first.
    expect(declaresNull({ allOf: [{ allOf: [nullableInline('a')] }, nullableInline('b')] })).toBe(true);
    expect(declaresNull({ allOf: [{ type: 'object', allOf: [nullableInline('a')] }, nullableInline('b')] })).toBe(
      false,
    );
  });

  it('reads each spelling of `null` a schema writes, and a `type` that names none as rejecting it', () => {
    const admitting: SchemaObject[] = [
      { type: ['object', 'null'] },
      { type: 'object', nullable: true },
      { type: 'null' },
      { const: null },
      { enum: [null] },
      { type: 'string', enum: ['a', null] },
      { oneOf: [plainInline, { type: 'null' }] },
      { anyOf: [plainInline, nullableInline('a'), { type: 'null' }] },
      { oneOf: [plainInline, nullableInline('a')], nullable: true },
      { allOf: [nullableInline('a')] },
      { allOf: [nullableInline('a'), { minProperties: 1 }] },
    ];
    const rejecting: SchemaObject[] = [
      {},
      { description: 'Nothing typed.' },
      { nullable: true },
      plainInline,
      { properties: { a: string } },
      { type: 'string', enum: ['a', 'b'] },
      { oneOf: [plainInline, nullableInline('a')] },
      { oneOf: [{ const: 'a' }, { const: 'b' }, { type: 'null' }], enum: ['a', 'b'] },
      { type: 'object', allOf: [nullableInline('a')] },
      { allOf: [{ minProperties: 1 }] },
      { nullable: true, allOf: [plainInline] },
    ];
    expect(admitting.filter((schema) => !schemaAdmitsNull(schema))).toEqual([]);
    expect(rejecting.filter((schema) => schemaAdmitsNull(schema))).toEqual([]);
  });
});

describe('#676 at every site', () => {
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

  /** Every site's type, one per line. */
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
    // The shape alone: the model each site mints is named by that site.
    return lines.map(([site, type]) => `${site}: ${show(type, () => 'model')}`).join('\n');
  }

  it('types the `allOf` of two nullable `$ref`s nullable wherever it is written (3.1.0)', async () => {
    expect(await sites('3.1.0', { allOf: [Owner, Tag] })).toMatchInlineSnapshot(`
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
    expect(warnings()).toEqual([]);
  });

  it('types the `allOf` of two nullable `$ref`s nullable wherever it is written (3.0.3)', async () => {
    expect(await sites('3.0.3', { allOf: [Owner, Tag] })).toMatchInlineSnapshot(`
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
      component as a response body: nullable<model>"
    `);
    expect(warnings()).toEqual([]);
  });

  it.each(VERSIONS)(
    'leaves the `allOf` beside a member that admits no `null` bare at every site (%s)',
    async (openapi) => {
      const lines = (await sites(openapi, { allOf: [Owner, Plain] })).split('\n');
      expect(lines.filter((line) => line.includes('nullable'))).toEqual([]);
      // A wrapper typed `object` rejects `null` for the members it is spliced open into.
      const typed = (await sites(openapi, { allOf: [{ type: 'object', allOf: [Owner] }, Tag] })).split('\n');
      expect(typed.filter((line) => line.includes('nullable'))).toEqual([]);
    },
  );

  it.each(VERSIONS)(
    'wraps the model a response body merges into, as the same body on a field (%s)',
    async (openapi) => {
      const merge = [Plain, { type: 'object', properties: { extra: string } }];
      const body =
        openapi === '3.0.3'
          ? { type: 'object', nullable: true, allOf: merge }
          : { type: ['object', 'null'], allOf: merge };
      const spec = await parse(
        document(
          openapi,
          { Pet: { type: 'object', properties: { owner: body } } },
          {
            '/owner': { get: { operationId: 'getOwner', responses: { '200': { description: 'ok', ...json(body) } } } },
          },
        ),
      );
      expect(show(fieldType(spec, 'Pet', 'owner'))).toBe('nullable<PetOwner>');
      expect(show(operation(spec, 'getOwner').response)).toBe('nullable<GetOwnerResponse>');
      expect(fieldNames(spec, 'GetOwnerResponse')).toEqual(['id', 'extra']);
    },
  );
});

describe('#676 the conjunction of two declarations settles `null` by the same reading', () => {
  it('keeps the keywords both declarations write when the second adds no part, in either member order', async () => {
    const described = { ...Owner, description: 'The owner.' };
    for (const [first, second] of [
      [{ allOf: [Owner, Tag] }, described],
      [described, { allOf: [Owner, Tag] }],
    ]) {
      const spec = await parse(membersDoc('3.1.0', first, second));
      const owner = modelOf(spec, 'Pet')!.fields.find((f) => f.name === 'owner')!;
      expect(show(owner.type)).toBe('nullable<PetOwner>');
      expect(owner.description).toBe('The owner.');
      expect(fieldNames(spec, 'PetOwner')).toEqual(['name', 'label']);
    }
  });

  it('admits no `null` where a declaration that adds no part rejects it, in either member order', async () => {
    const rejecting = { type: 'object', allOf: [Owner] };
    for (const merged of [
      { allOf: [Owner, Tag] },
      { type: ['object', 'null'], allOf: [Owner, Tag] },
      { allOf: [Owner], required: ['name'] },
    ]) {
      for (const [first, second] of [
        [merged, rejecting],
        [rejecting, merged],
      ]) {
        const spec = await parse(membersDoc('3.1.0', first, second));
        expect(show(fieldType(spec, 'Pet', 'owner')), JSON.stringify([first, second])).toBe('PetOwner');
      }
    }
  });

  it('keeps a first the pair does not conjoin from admitting a `null` the second rejects', async () => {
    const merge = { allOf: [Owner, Tag] };
    const closed = (member: unknown) => ({ additionalProperties: false, allOf: [member] });
    const owner = async (first: unknown, second: unknown) =>
      show(fieldType(await parse(membersDoc('3.1.0', first, second)), 'Pet', 'owner'));
    // An object beside a string keeps the first, as the same two written by hand as one `allOf` are read.
    expect(await expectSpellingsAgree('3.1.0', merge, string, 'a string')).toBe('PetOwner');
    expect(await owner({ nullable: true, ...merge }, string)).toBe('PetOwner');
    expect(await owner(merge, { type: ['string', 'null'] })).toBe('nullable<PetOwner>');
    // A pair the readers would not all read keeps the first too.
    expect(await owner(merge, closed(Plain))).toBe('PetOwner');
    expect(await owner(merge, closed(Owner))).toBe('nullable<PetOwner>');
    // A first that says `null` itself is kept as written, as it was.
    expect(await owner({ type: ['object', 'null'], ...merge }, closed(Plain))).toBe('nullable<PetOwner>');
  });

  it('reads nothing beside a `$ref` declaration, and the `properties` beside an `allOf` as the object they are', async () => {
    // Each declaration rejects `null` as the type builder types it alone, so the conjunction does.
    expect(await expectSpellingsAgree('3.1.0', { ...Plain, type: ['object', 'null'] }, Owner, 'type beside $ref')).toBe(
      'PetOwner',
    );
    expect(
      await expectSpellingsAgree('3.1.0', { properties: { extra: string }, allOf: [Owner] }, Tag, 'own properties'),
    ).toBe('PetOwner');
  });
});
