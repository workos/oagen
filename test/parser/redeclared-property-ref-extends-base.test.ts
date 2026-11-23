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
  isArrayComponentEntry,
  mergeDeclaresNull,
  schemaAdmitsNull,
  schemaToTypeRef,
  type SchemaObject,
} from '../../src/parser/schemas.js';
import {
  allOfReferenceMember,
  combineDeclarations,
  extendsComponent,
  readAllOfReference,
  readInlineAllOf,
  typingReferences,
} from '../../src/parser/inline-models.js';
import { collectObjectProperties, resolveBareSchema, resolveDataPathArray } from '../../src/parser/pagination.js';
import type { ApiSpec, Field, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #733: two `allOf` members that declare one property are conjoined
 * as the `allOf` of both (#653), and an `allOf` of two `$ref`s was always a
 * merge. So a model that narrows an inherited `tag: { $ref: Tag }` to `{
 * $ref: TagOutput }`, where `TagOutput` is `allOf: [{ $ref: Tag }, {
 * required: [...] }]`, got a new model with `TagOutput`'s fields under the
 * field's own name — one copy per model that narrows the property — and
 * no field named `TagOutput`. Every `TagOutput` is a `Tag`, so `Tag` adds
 * nothing to the conjunction: a `$ref` to a component another `$ref`
 * member's component already is — the same one, or one it extends through
 * its own `allOf` chain — is now no second `$ref`, and the `allOf` is the
 * reference to the component that stands.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-733-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}
const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeDoc(doc));

type Doc = Record<string, unknown>;
const ref = (name: string, beside: Doc = {}) => ({ $ref: `#/components/schemas/${name}`, ...beside });
const string = { type: 'string' };
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const all = (...members: unknown[]) => ({ allOf: members });

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

/** The issue's `Tag { label?, color }` and `TagOutput`, which composes it and requires `label`. */
const Tag = { type: 'object', required: ['color'], properties: { label: string, color: string } };
const TagOutput = all(ref('Tag'), { required: ['label'] });
const tags = { Tag, TagOutput };
/** `Tag` admitting `null`, in the version's own spelling. */
const nullableTag = (openapi: Version) =>
  openapi === '3.0.3' ? { ...Tag, nullable: true } : { ...Tag, type: ['object', 'null'] };
const notNull = { not: { type: 'null' } };
const Other = { type: 'object', properties: { other: string } };

const get = (route: string, operationId: string, schema: unknown) => ({
  [route]: { get: { operationId, responses: { '200': { description: 'OK', ...json(schema) } } } },
});
const document = (openapi: Version, paths: Doc, schemas: Doc, more: Doc = {}) => ({
  openapi,
  info: { title: 'Repro', version: '1.0.0' },
  paths,
  components: { schemas },
  ...more,
});

/** The issue's `repro.json`: `PetOutput` and `ToyOutput` narrow the `tag` they inherit to `TagOutput`. */
const repro = (
  openapi: Version,
  narrowing: (base: string, tag: unknown) => unknown = narrowedAfter,
  tag = 'TagOutput',
) =>
  document(
    openapi,
    { ...get('/pets', 'listPets', ref('PetOutput')), ...get('/toys', 'listToys', ref('ToyOutput')) },
    {
      ...tags,
      Pet: { type: 'object', properties: { name: string, tag: ref(tag === 'TagOutput' ? 'Tag' : 'TagOutput') } },
      Toy: { type: 'object', properties: { size: string, tag: ref(tag === 'TagOutput' ? 'Tag' : 'TagOutput') } },
      PetOutput: narrowing('Pet', ref(tag)),
      ToyOutput: narrowing('Toy', ref(tag)),
    },
  );
function narrowedAfter(base: string, tag: unknown): unknown {
  return all(ref(base), { properties: { tag } });
}
const narrowedBefore = (base: string, tag: unknown) => all({ properties: { tag } }, ref(base));
const narrowedTyped = (base: string, tag: unknown) => all(ref(base), { type: 'object', properties: { tag } });
const narrowedBeside = (base: string, tag: unknown) => ({ ...all(ref(base)), properties: { tag } });
/** The issue's `direct.json`: the same API with both models declaring their properties themselves. */
const direct = (openapi: Version) =>
  document(
    openapi,
    { ...get('/pets', 'listPets', ref('PetOutput')), ...get('/toys', 'listToys', ref('ToyOutput')) },
    {
      ...tags,
      Pet: { type: 'object', properties: { name: string, tag: ref('Tag') } },
      Toy: { type: 'object', properties: { size: string, tag: ref('Tag') } },
      PetOutput: { type: 'object', properties: { name: string, tag: ref('TagOutput') } },
      ToyOutput: { type: 'object', properties: { size: string, tag: ref('TagOutput') } },
    },
  );

/** A type in a word: `nullable<TagOutput>`, `TagOutput[]`, `(TagOutput | string)`, `string`. */
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

/** The issue's script: one line per model, its bases and its fields. */
const script = (spec: ApiSpec): string =>
  spec.models
    .map(({ bases, fields, name }) => {
      const extendsList = bases?.length ? ` extends ${bases.map(show).join(', ')}` : '';
      return `${name}${extendsList} { ${fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`).join(', ')} }`;
    })
    .join('\n');

/** The script's line for the model `name`. */
const lineOf = (spec: ApiSpec, name: string): string | undefined =>
  script(spec)
    .split('\n')
    .find((line) => line.startsWith(`${name} `));

const modelOf = (spec: ApiSpec, name: string): Model | undefined => spec.models.find((m) => m.name === name);
const fieldOf = (spec: ApiSpec, model: string, field: string): Field | undefined =>
  modelOf(spec, model)?.fields.find((f) => f.name === field);
const operations = (spec: ApiSpec): Operation[] => spec.services.flatMap((s) => s.operations);
const names = (spec: ApiSpec): string => spec.models.map((m) => m.name).join(', ');

/** What a field carries beside its type, as `key=value` words. */
const carried = (field: Field | undefined): string => {
  if (!field) return '';
  const { description, deprecated, readOnly, constraints, extensions, inheritedFrom } = field;
  const words = Object.entries({ description, deprecated, readOnly, constraints, extensions })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  if (inheritedFrom) words.push(`from=${show(inheritedFrom)}`);
  return words.length > 0 ? ` <${words.join(' ')}>` : '';
};

/** `Holder.tag` written as `tag`, beside `schemas`: a document with one field to read. */
const holder = (openapi: Version, tag: unknown, schemas: Doc = tags, more: Doc = {}) =>
  document(openapi, get('/holders', 'getHolder', ref('Holder')), {
    ...schemas,
    Holder: { type: 'object', properties: { tag, ...more } },
  });
/**
 * `Holder.tag`: its type and what the field carries, with the fields of
 * `HolderTag`, the model minted under the field, when the document builds
 * one — which it does exactly when the field names it.
 */
const tagLine = (spec: ApiSpec): string => {
  const field = fieldOf(spec, 'Holder', 'tag');
  const minted = modelOf(spec, 'HolderTag');
  const named = show(field?.type).includes('HolderTag');
  expect(minted !== undefined, 'a model is minted exactly when the field names it').toBe(named);
  const fields = minted ? ` { ${minted.fields.map((f) => `${f.name}${f.required ? '' : '?'}`).join(', ')} }` : '';
  return `${show(field?.type)}${fields}${carried(field)}`;
};
async function tagOf(openapi: Version, tag: unknown, schemas: Doc = tags): Promise<string> {
  return tagLine(await parse(holder(openapi, tag, schemas)));
}
type Row = readonly [label: string, tag: unknown, schemas?: Doc];
const table = async (openapi: Version, rows: readonly Row[]): Promise<string> => {
  const lines: string[] = [];
  for (const [label, tag, schemas] of rows) lines.push(`${label}: ${await tagOf(openapi, tag, schemas)}`);
  return lines.join('\n');
};

/** `first` and `second` as two members' declarations of `X.tag`, beside `schemas`. */
const declared = (openapi: Version, first: unknown, second: unknown, schemas: Doc = tags) =>
  document(openapi, get('/x', 'getX', ref('X')), {
    ...schemas,
    X: all({ properties: { tag: first } }, { properties: { tag: second } }),
  });
/** `X.tag`: its type and what the field carries, and every model the document builds. */
const declaredLine = (spec: ApiSpec): string => {
  const field = fieldOf(spec, 'X', 'tag');
  return `${show(field?.type)}${carried(field)} [${names(spec)}]`;
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
/** `diffSpecs` reports nothing between the two documents, in either direction, and `oagen diff` exits 0. */
async function expectNoDiff(first: unknown, second: unknown, label = ''): Promise<void> {
  const [a, b] = [await parse(first), await parse(second)];
  expect(diffSpecs(a, b).changes, label).toEqual([]);
  expect(diffSpecs(b, a).changes, label).toEqual([]);
  expect(await diffExit(first, second), label).toBe(0);
  expect(await diffExit(second, first), label).toBe(0);
}

/** Read `run` with `schemas` as the document's components, as the parser reads a schema while it extracts them. */
const within = <T>(schemas: Doc, run: () => T): T => {
  const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    extractSchemas(schemas as Record<string, SchemaObject>);
    return run();
  } finally {
    clearSchemaNameTransform();
    quiet.mockRestore();
  }
};
const at = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });

describe('#733 a property redeclared as a `$ref` to a component extending the base’s type', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('is typed as that component: the issue’s `repro.json`, and its `direct.json`', async () => {
      const spec = await parse(repro(openapi));
      expect(script(spec)).toMatchInlineSnapshot(`
        "Tag { label?: string, color: string }
        TagOutput extends Tag { label: string, color: string }
        Pet { name?: string, tag?: Tag }
        Toy { size?: string, tag?: Tag }
        PetOutput extends Pet { name?: string, tag?: TagOutput }
        ToyOutput extends Toy { size?: string, tag?: TagOutput }"
      `);
      expect(script(await parse(direct(openapi)))).toMatchInlineSnapshot(`
        "Tag { label?: string, color: string }
        TagOutput extends Tag { label: string, color: string }
        Pet { name?: string, tag?: Tag }
        Toy { size?: string, tag?: Tag }
        PetOutput { name?: string, tag?: TagOutput }
        ToyOutput { size?: string, tag?: TagOutput }"
      `);
      // No copy of `TagOutput` is minted, and the two spellings are one API to `oagen diff`.
      expect(names(spec)).not.toMatch(/OutputTag/);
      await expectNoDiff(repro(openapi), direct(openapi));
      expect(warnings()).toEqual([]);
    });

    it('in either member order, with `type: object` beside the member’s `properties`, and beside the `allOf`', async () => {
      const spellings = {
        'override member second': narrowedAfter,
        'override member first': narrowedBefore,
        'override member typed `object`': narrowedTyped,
        'override beside the `allOf`': narrowedBeside,
      };
      for (const [label, narrowing] of Object.entries(spellings)) {
        const spec = await parse(repro(openapi, narrowing));
        expect(show(fieldOf(spec, 'PetOutput', 'tag')?.type), label).toBe('TagOutput');
        expect(show(fieldOf(spec, 'ToyOutput', 'tag')?.type), label).toBe('TagOutput');
        expect(names(spec), label).toBe('Tag, TagOutput, Pet, Toy, PetOutput, ToyOutput');
        await expectNoDiff(repro(openapi, narrowing), direct(openapi), label);
      }
    });

    it('for the reverse pair: a base’s `$ref: TagOutput` redeclared as `$ref: Tag` stays `TagOutput`', async () => {
      for (const narrowing of [narrowedAfter, narrowedBefore, narrowedTyped, narrowedBeside]) {
        const spec = await parse(repro(openapi, narrowing, 'Tag'));
        expect(show(fieldOf(spec, 'Pet', 'tag')?.type)).toBe('TagOutput');
        expect(show(fieldOf(spec, 'PetOutput', 'tag')?.type)).toBe('TagOutput');
        expect(show(fieldOf(spec, 'ToyOutput', 'tag')?.type)).toBe('TagOutput');
        expect(names(spec)).toBe('Tag, TagOutput, Pet, Toy, PetOutput, ToyOutput');
      }
    });

    it('as the `allOf` of both written by hand is, in either order', async () => {
      expect(
        await table(openapi, [
          ['the wider first', all(ref('Tag'), ref('TagOutput'))],
          ['the narrower first', all(ref('TagOutput'), ref('Tag'))],
          ['the narrower alone', all(ref('TagOutput'))],
          ['the bare `$ref`', ref('TagOutput')],
        ]),
      ).toMatchInlineSnapshot(`
        "the wider first: TagOutput
        the narrower first: TagOutput
        the narrower alone: TagOutput
        the bare \`$ref\`: TagOutput"
      `);
      await expectNoDiff(holder(openapi, all(ref('Tag'), ref('TagOutput'))), holder(openapi, ref('TagOutput')));
      await expectNoDiff(holder(openapi, all(ref('TagOutput'), ref('Tag'))), holder(openapi, ref('TagOutput')));
    });

    it('leaves a property the base does not declare the component it names', async () => {
      const spec = await parse(repro(openapi, (base) => all(ref(base), { properties: { badge: ref('TagOutput') } })));
      expect(script(spec).split('\n').slice(4)).toEqual([
        'PetOutput extends Pet { name?: string, tag?: Tag, badge?: TagOutput }',
        'ToyOutput extends Toy { size?: string, tag?: Tag, badge?: TagOutput }',
      ]);
    });
  });
});

describe('#733 `extendsComponent`: a component already is another it reaches through its own `allOf` chain', () => {
  const Mid = all(ref('TagOutput'), { properties: { mid: string } });
  const Final = all(ref('Mid'), { properties: { final: string } });
  const components: Doc = {
    ...tags,
    Other,
    Mid,
    Final,
    // Aliases: each is a component of its own.
    TagAlias: ref('Tag'),
    OutputAlias: ref('TagOutput'),
    // Reaches `Tag` inside members that are themselves an `allOf`, a closed wrapper among them.
    Deep: all({ additionalProperties: false, allOf: [all(ref('Tag'))] }, { properties: { deep: string } }),
    // Writes its own properties, and a union, beside the `allOf`.
    Beside: { type: 'object', properties: { beside: string }, allOf: [ref('Tag')] },
    WithUnion: { allOf: [ref('Tag')], oneOf: [{ properties: { a: string } }, { properties: { b: string } }] },
    // A JSON Schema boolean among the members.
    WithTrue: all(ref('Tag'), true),
    // Names `Tag` where not every instance is one, or where the model readers read it otherwise.
    Either: all({ oneOf: [ref('Tag'), ref('Other')] }, { required: ['label'] }),
    One: all({ oneOf: [ref('Tag')] }, { required: ['label'] }),
    Maybe: all({ anyOf: [ref('Tag'), { type: 'null' }] }, { required: ['label'] }),
    MaybeAlias: { anyOf: [ref('Tag'), { type: 'null' }] },
    OneOfAlias: { oneOf: [ref('Tag')] },
    NotTag: { type: 'object', properties: { a: string }, not: ref('Tag') },
    HasTag: { type: 'object', properties: { tag: ref('Tag') } },
    Tags: { type: 'array', items: ref('Tag') },
    TagMap: { type: 'object', additionalProperties: ref('Tag') },
    // Each reaches the other, and one reaches itself.
    A: all(ref('B'), { properties: { a: string } }),
    B: all(ref('A'), { properties: { b: string } }),
    Node: all(ref('Node'), { properties: { n: string } }),
    Leaf: all(ref('Node'), { properties: { l: string } }),
    // No objects: the rule is asked of components a merge reads properties from.
    Pets: { type: 'array', items: string },
    PetsNonEmpty: all(ref('Pets'), { minItems: 1 }),
    Kind: { type: 'string', enum: ['cat', 'dog'] },
    KindAlias: all(ref('Kind'), { description: 'An alias.' }),
    Name: string,
    ShortName: all(ref('Name'), { maxLength: 3 }),
    Meta: { type: 'object', additionalProperties: string },
    MetaOutput: all(ref('Meta'), { minProperties: 1 }),
    Described: { description: 'From a component.' },
    DescribedMore: all(ref('Described'), { deprecated: true }),
    // An object's chain that says an instance is something else.
    EnumOverTag: { enum: ['a', 'b'], allOf: [ref('Tag')] },
    StringOverTag: { type: 'string', allOf: [ref('Tag')] },
    ArrayOverTag: { type: 'array', items: string, allOf: [ref('Tag')] },
    ListOverTag: { type: ['string', 'object'], allOf: [ref('Tag')] },
    AliasOfEnumOverTag: all(ref('EnumOverTag')),
    // Admits `null`, in its own word or its base's: no matter here.
    Loose: { type: ['object', 'null'], allOf: [ref('Tag')] },
  };
  const extended = (narrow: string, wide: string): boolean =>
    within(components, () => extendsComponent(at(narrow), at(wide)));

  it('follows a `$ref` and the members of an `allOf`, at any depth', () => {
    const pairs: Array<[string, string]> = [
      ['TagOutput', 'Tag'],
      ['Mid', 'TagOutput'],
      ['Mid', 'Tag'],
      ['Final', 'Mid'],
      ['Final', 'TagOutput'],
      ['Final', 'Tag'],
      ['TagAlias', 'Tag'],
      ['OutputAlias', 'TagOutput'],
      ['OutputAlias', 'Tag'],
      ['Deep', 'Tag'],
      ['Beside', 'Tag'],
      ['WithUnion', 'Tag'],
      ['WithTrue', 'Tag'],
      ['Leaf', 'Node'],
      ['Loose', 'Tag'],
    ];
    for (const [narrow, wide] of pairs) {
      expect(extended(narrow, wide), `${narrow} extends ${wide}`).toBe(true);
      // Never the other way round.
      expect(extended(wide, narrow), `${wide} extends ${narrow}`).toBe(false);
    }
  });

  it('follows no union, no `not`, no property, no items and no map values', () => {
    for (const name of ['Either', 'One', 'Maybe', 'MaybeAlias', 'OneOfAlias', 'NotTag', 'HasTag', 'Tags', 'TagMap']) {
      expect(extended(name, 'Tag'), name).toBe(false);
      expect(extended('Tag', name), name).toBe(false);
    }
  });

  it('answers no for one component, two that reach each other and strangers', () => {
    const pairs: Array<[string, string]> = [
      // One component is no extension of itself: `typingReferences` keeps the first of two `$ref`s to it.
      ['Tag', 'Tag'],
      ['TagOutput', 'TagOutput'],
      ['Node', 'Node'],
      // Each reaches the other: neither is the narrower.
      ['A', 'B'],
      ['B', 'A'],
      ['Tag', 'Other'],
      ['Other', 'Tag'],
      ['TagOutput', 'Other'],
      ['Mid', 'Final'],
    ];
    for (const [narrow, wide] of pairs) expect(extended(narrow, wide), `${narrow} extends ${wide}`).toBe(false);
  });

  /** `Tag` under every spelling of another name for it, and under spellings that say something of their own. */
  const named: Doc = {
    ...tags,
    Other,
    // Each another name for `Tag`: it adds no constraint of its own.
    Bare: ref('Tag'),
    Described: ref('Tag', { description: 'A tag.' }),
    Annotated: ref('Tag', {
      title: 'Tag',
      deprecated: true,
      readOnly: true,
      default: null,
      example: { color: 'red' },
      externalDocs: { url: 'https://example.com/tags' },
      'x-note': 'n',
      $comment: 'An alias.',
    }),
    Wrapped: all(ref('Tag')),
    WrappedDescribed: { ...all(ref('Tag')), title: 'Tag', description: 'A tag.' },
    WrappedInner: all(ref('Tag', { description: 'Inner.' })),
    Twice: ref('Bare'),
    Thrice: ref('Twice'),
    WrappedTwice: all(ref('Wrapped')),
    // Each says something of its own, read by the parser or not: a component like any other.
    Limited: ref('Tag', { minProperties: 1 }),
    Requiring: ref('Tag', { required: ['label'] }),
    Typed: ref('Tag', { type: 'object' }),
    Flagged: ref('Tag', { nullable: true }),
    WithProperties: ref('Tag', { properties: { more: string } }),
    WithNot: ref('Tag', notNull),
    WithUnknown: ref('Tag', { propertyNames: { maxLength: 3 } }),
    WrappedLimited: { ...all(ref('Tag')), minProperties: 1 },
    WrappedRequiring: { ...all(ref('Tag')), required: ['label'] },
    WrappedTyped: { type: 'object', ...all(ref('Tag')) },
    WrappedNullable: { type: ['object', 'null'], ...all(ref('Tag')) },
    WrappedFlagged: { nullable: true, ...all(ref('Tag')) },
    WrappedInnerLimited: all(ref('Tag', { minProperties: 1 })),
    TwoMembers: all(ref('Tag'), { description: 'A tag.' }),
    WithBoolean: all(ref('Tag'), true),
    // The narrower under a name of its own.
    OutputAlias: ref('TagOutput'),
    OutputWrapped: { description: 'An output tag.', ...all(ref('TagOutput')) },
  };
  const NAMES = [
    'Bare',
    'Described',
    'Annotated',
    'Wrapped',
    'WrappedDescribed',
    'WrappedInner',
    'Twice',
    'Thrice',
    'WrappedTwice',
  ];
  const NO_NAMES = [
    'Limited',
    'Requiring',
    'Typed',
    'Flagged',
    'WithProperties',
    'WithNot',
    'WithUnknown',
    'WrappedLimited',
    'WrappedRequiring',
    'WrappedTyped',
    'WrappedNullable',
    'WrappedFlagged',
    'WrappedInnerLimited',
    'TwoMembers',
    'WithBoolean',
  ];

  it('reads the wider through its names: a `$ref`, or an `allOf` of one, beside documentation only', () => {
    within(named, () => {
      for (const name of NAMES) {
        // Every `TagOutput` is a `Tag`, and so one of whatever is only another name for `Tag`.
        for (const narrow of ['TagOutput', 'OutputAlias', 'OutputWrapped']) {
          expect(extendsComponent(at(narrow), at(name)), `${narrow} extends ${name}`).toBe(true);
          expect(extendsComponent(at(name), at(narrow)), `${name} extends ${narrow}`).toBe(false);
        }
        // The name is a component of its own, which names `Tag` in its chain.
        expect(extendsComponent(at(name), at('Tag')), name).toBe(true);
        expect(extendsComponent(at('Tag'), at(name)), name).toBe(false);
        expect(extendsComponent(at('Other'), at(name)), name).toBe(false);
        expect(extendsComponent(at(name), at('Other')), name).toBe(false);
      }
    });
  });

  it('takes a name that says anything of its own for a component like any other', () => {
    within(named, () => {
      for (const name of NO_NAMES) {
        // `TagOutput`'s chain does not name it, and it is no mere name for what that chain names.
        expect(extendsComponent(at('TagOutput'), at(name)), `TagOutput extends ${name}`).toBe(false);
        expect(extendsComponent(at(name), at('TagOutput')), `${name} extends TagOutput`).toBe(false);
        // It still names `Tag` in its own chain, so it extends `Tag`, and `Tag` under another name.
        expect(extendsComponent(at(name), at('Tag')), `${name} extends Tag`).toBe(true);
        expect(extendsComponent(at(name), at('Bare')), `${name} extends Bare`).toBe(true);
        expect(extendsComponent(at('Bare'), at(name)), `Bare extends ${name}`).toBe(false);
      }
    });
  });

  it('tells two names for one component apart by neither, unless one names the other', () => {
    within(named, () => {
      const strangers: Array<[string, string]> = [
        ['Bare', 'Described'],
        ['Described', 'Wrapped'],
        ['Wrapped', 'WrappedInner'],
        ['Thrice', 'WrappedTwice'],
        ['Annotated', 'Twice'],
      ];
      for (const [first, second] of strangers) {
        expect(extendsComponent(at(first), at(second)), `${first} extends ${second}`).toBe(false);
        expect(extendsComponent(at(second), at(first)), `${second} extends ${first}`).toBe(false);
      }
      const chained: Array<[string, string]> = [
        ['Twice', 'Bare'],
        ['Thrice', 'Twice'],
        ['Thrice', 'Bare'],
        ['WrappedTwice', 'Wrapped'],
      ];
      for (const [narrow, wide] of chained) {
        expect(extendsComponent(at(narrow), at(wide)), `${narrow} extends ${wide}`).toBe(true);
        expect(extendsComponent(at(wide), at(narrow)), `${wide} extends ${narrow}`).toBe(false);
      }
    });
  });

  it('ends on names that name each other', () => {
    // The bundler refuses such a document; a reader handed the map must still answer.
    const looped = { ...tags, LoopA: ref('LoopB'), LoopB: ref('LoopA'), LoopC: all(ref('LoopC')) } as unknown;
    const map = looped as Record<string, SchemaObject>;
    for (const name of ['LoopA', 'LoopB', 'LoopC']) {
      expect(extendsComponent(at('TagOutput'), at(name), map), name).toBe(false);
      expect(extendsComponent(at(name), at('Tag'), map), name).toBe(false);
      expect(extendsComponent(at(name), at(name), map), name).toBe(false);
    }
    expect(extendsComponent(at('LoopA'), at('LoopB'), map)).toBe(false);
    expect(extendsComponent(at('TagOutput'), at('Tag'), map)).toBe(true);
  });

  it('is asked of objects alone: the wider declares properties, and nothing the narrower is made of says another type', () => {
    const pairs: Array<[string, string]> = [
      ['PetsNonEmpty', 'Pets'],
      ['KindAlias', 'Kind'],
      ['ShortName', 'Name'],
      ['MetaOutput', 'Meta'],
      ['DescribedMore', 'Described'],
      ['EnumOverTag', 'Tag'],
      ['StringOverTag', 'Tag'],
      ['ArrayOverTag', 'Tag'],
      ['ListOverTag', 'Tag'],
      ['AliasOfEnumOverTag', 'Tag'],
      ['AliasOfEnumOverTag', 'EnumOverTag'],
    ];
    for (const [narrow, wide] of pairs) expect(extended(narrow, wide), `${narrow} extends ${wide}`).toBe(false);
  });

  it('answers no for a `$ref` no schema answers, a value that is no Schema Object, and a member that is no `$ref`', () => {
    const odd: Doc = {
      ...tags,
      Anything: true,
      Nothing: false,
      Five: 5,
      Text: 'text',
      List: [string],
      OverTrue: all(ref('Anything'), { properties: { a: string } }),
      OverMissing: all(ref('Missing'), { properties: { a: string } }),
      OddRef: all({ $ref: 5 }, { properties: { a: string } }),
    };
    within(odd, () => {
      for (const name of ['Anything', 'Nothing', 'Five', 'Text', 'List', 'Missing']) {
        expect(extendsComponent(at('TagOutput'), at(name)), name).toBe(false);
        expect(extendsComponent(at(name), at('Tag')), name).toBe(false);
        expect(extendsComponent(at(`Over${name}`), at(name)), name).toBe(false);
      }
      expect(extendsComponent(at('OddRef'), at('Tag'))).toBe(false);
      expect(extendsComponent(at('TagOutput'), { type: 'object' })).toBe(false);
      expect(extendsComponent({ type: 'object' }, at('Tag'))).toBe(false);
      expect(extendsComponent(true as unknown as SchemaObject, at('Tag'))).toBe(false);
      expect(extendsComponent(at('TagOutput'), null as unknown as SchemaObject)).toBe(false);
      expect(extendsComponent({ $ref: 5 } as unknown as SchemaObject, at('Tag'))).toBe(false);
    });
    // An `allOf` that holds no list is made of nothing, and a `null` where a component goes is none.
    const unlisted = { ...tags, NoList: { allOf: 5, properties: { a: string } }, Null: null } as unknown;
    const map = unlisted as Record<string, SchemaObject>;
    expect(extendsComponent(at('NoList'), at('Tag'), map)).toBe(false);
    expect(extendsComponent(at('TagOutput'), at('NoList'), map)).toBe(false);
    expect(extendsComponent(at('Null'), at('Tag'), map)).toBe(false);
    expect(extendsComponent(at('TagOutput'), at('Null'), map)).toBe(false);
    expect(extendsComponent(at('TagOutput'), at('Tag'), map)).toBe(true);
  });

  it('follows a pointer deeper into a component to the schema it lands on', () => {
    const pointer = { $ref: '#/components/schemas/Shelf/properties/tag' };
    const schemas: Doc = {
      Shelf: { type: 'object', properties: { tag: { type: 'object', properties: { label: string } } } },
      Narrow: all(pointer, { properties: { n: string } }),
    };
    within(schemas, () => {
      expect(extendsComponent(at('Narrow'), pointer)).toBe(true);
      expect(extendsComponent(pointer, at('Narrow'))).toBe(false);
      expect(extendsComponent(at('Narrow'), at('Shelf'))).toBe(false);
    });
  });

  it('resolves against the map it is handed, with no document being read', () => {
    const schemas = components as Record<string, SchemaObject>;
    expect(extendsComponent(at('Final'), at('Tag'), schemas)).toBe(true);
    expect(extendsComponent(at('Tag'), at('Final'), schemas)).toBe(false);
    expect(extendsComponent(at('TagOutput'), at('TagAlias'), schemas)).toBe(true);
    expect(extendsComponent(at('TagAlias'), at('TagOutput'), schemas)).toBe(false);
    // Outside a document, and with no map, no `$ref` resolves.
    expect(extendsComponent(at('Final'), at('Tag'))).toBe(false);
    expect(extendsComponent(at('Final'), at('Tag'), {})).toBe(false);
  });
});

describe('#733 `typingReferences`: the `$ref` members that type an `allOf`', () => {
  const Mid = all(ref('TagOutput'), { properties: { mid: string } });
  const schemas: Doc = { ...tags, Other, Mid, Pets: { type: 'array', items: string } };
  const typing = (...members: SchemaObject[]): string =>
    within(schemas, () =>
      typingReferences(members)
        .map((member) => String(member.$ref).split('/').pop())
        .join(', '),
    );

  it('leaves out a `$ref` to a component another names too, or extends, wherever it stands', () => {
    expect(typing(at('Tag'), at('TagOutput'))).toBe('TagOutput');
    expect(typing(at('TagOutput'), at('Tag'))).toBe('TagOutput');
    expect(typing(at('Tag'), at('TagOutput'), at('Mid'))).toBe('Mid');
    expect(typing(at('Mid'), at('Tag'), at('TagOutput'))).toBe('Mid');
    expect(typing(at('TagOutput'), at('Mid'), at('Tag'))).toBe('Mid');
    expect(typing(at('Tag'), at('Tag'))).toBe('Tag');
    expect(typing(at('Tag'), at('TagOutput'), at('Tag'), at('TagOutput'))).toBe('TagOutput');
    expect(typing(at('TagOutput'), at('Tag'), at('TagOutput'))).toBe('TagOutput');
  });

  it('keeps two `$ref`s neither of which the other already is, a covered one beside them or not', () => {
    expect(typing(at('Tag'), at('Other'))).toBe('Tag, Other');
    expect(typing(at('TagOutput'), at('Other'))).toBe('TagOutput, Other');
    expect(typing(at('Tag'), at('TagOutput'), at('Other'))).toBe('TagOutput, Other');
    expect(typing(at('Other'), at('Tag'), at('Mid'), at('Other'))).toBe('Other, Mid');
    // No object: both stand, as two `$ref`s to one array always did.
    expect(typing(at('Pets'), at('Pets'))).toBe('Pets, Pets');
    expect(typing(at('Tag'))).toBe('Tag');
    expect(typing()).toBe('');
  });

  it('reads the other members past, and an `allOf` that holds no list as none', () => {
    const members = [at('Tag'), { description: 'A tag.' }, true, null, 5, at('TagOutput')] as unknown as SchemaObject[];
    expect(typing(...members)).toBe('TagOutput');
    within(schemas, () => {
      for (const value of [undefined, null, 5, 'text', {}, true]) {
        expect(typingReferences(value as unknown as SchemaObject[])).toEqual([]);
      }
    });
  });

  it('counts every `$ref` of a component’s own `allOf`, which composes a model of its own', () => {
    const Both = all(ref('Tag'), ref('TagOutput'));
    const twice = all(ref('Tag'), ref('Tag'));
    const components = { ...schemas, Both, Twice: twice } as Record<string, SchemaObject>;
    within(components, () => {
      const both = components.Both!;
      expect(typingReferences(both.allOf!, undefined, both).map((member) => member.$ref)).toEqual([
        '#/components/schemas/Tag',
        '#/components/schemas/TagOutput',
      ]);
      expect(readInlineAllOf(both.allOf!, both)).toBe('merged');
      expect(allOfReferenceMember(both)).toBe(both.allOf![0]);
      expect(readInlineAllOf(components.Twice!.allOf!, components.Twice)).toBe('merged');
      // The same members written anywhere else are the reference to the one that stands.
      const inline: SchemaObject = { allOf: [at('Tag'), at('TagOutput')] };
      expect(readInlineAllOf(inline.allOf!, inline)).toBe('reference');
      expect(allOfReferenceMember(inline)).toBe(inline.allOf![1]);
      expect(schemaToTypeRef(inline, 'tag', 'Holder')).toEqual({ kind: 'model', name: 'TagOutput' });
      const again: SchemaObject = { allOf: [at('Tag'), at('Tag')] };
      expect(readInlineAllOf(again.allOf!, again)).toBe('reference');
      expect(allOfReferenceMember(again)).toBe(again.allOf![0]);
    });
    // Read against a map handed in, as the readers before the extraction read it.
    expect(readInlineAllOf(Both.allOf as SchemaObject[], components.Both, components)).toBe('merged');
    const inline = all(ref('Tag'), ref('TagOutput')) as SchemaObject;
    expect(readInlineAllOf(inline.allOf!, inline, components)).toBe('reference');
  });
});

describe('#733 an inline `allOf` of two `$ref`s, one to a component the other already is', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('is the component that stands: a chain, an alias, a wrapper on the way, three members', async () => {
      const Mid = all(ref('TagOutput'), { properties: { mid: string } });
      const schemas = {
        ...tags,
        Mid,
        TagAlias: ref('Tag'),
        OutputAlias: ref('TagOutput'),
        Deep: all({ additionalProperties: false, allOf: [all(ref('Tag'))] }, { properties: { deep: string } }),
        WithTrue: all(ref('Tag'), true),
        Node: all(ref('Node'), { properties: { n: string } }),
        Leaf: all(ref('Node'), { properties: { l: string } }),
      };
      expect(
        await table(openapi, [
          ['one component twice', all(ref('Tag'), ref('Tag')), schemas],
          ['three levels, the ends', all(ref('Tag'), ref('Mid')), schemas],
          ['three levels, all three', all(ref('Tag'), ref('TagOutput'), ref('Mid')), schemas],
          ['three levels, all three, the widest last', all(ref('Mid'), ref('TagOutput'), ref('Tag')), schemas],
          ['a component and an alias of it', all(ref('Tag'), ref('TagAlias')), schemas],
          ['an alias of it first', all(ref('TagAlias'), ref('Tag')), schemas],
          ['a component and an alias of one extending it', all(ref('Tag'), ref('OutputAlias')), schemas],
          ['an alias of the wider beside the narrower', all(ref('TagAlias'), ref('TagOutput')), schemas],
          ['the narrower beside an alias of the wider', all(ref('TagOutput'), ref('TagAlias')), schemas],
          ['an alias on both sides', all(ref('TagAlias'), ref('OutputAlias')), schemas],
          ['the wider, an alias of it and the narrower', all(ref('Tag'), ref('TagAlias'), ref('TagOutput')), schemas],
          ['a component reached inside nested members', all(ref('Tag'), ref('Deep')), schemas],
          ['a boolean among the narrower’s members', all(ref('Tag'), ref('WithTrue')), schemas],
          ['a component that names itself, and one extending it', all(ref('Node'), ref('Leaf')), schemas],
          ['the wider inside a bare `allOf` member', all(all(ref('Tag')), ref('TagOutput')), schemas],
          ['both inside bare `allOf` members', all(all(ref('Tag')), all(ref('TagOutput'))), schemas],
        ]),
      ).toMatchInlineSnapshot(`
        "one component twice: Tag
        three levels, the ends: Mid
        three levels, all three: Mid
        three levels, all three, the widest last: Mid
        a component and an alias of it: TagAlias
        an alias of it first: TagAlias
        a component and an alias of one extending it: OutputAlias
        an alias of the wider beside the narrower: TagOutput
        the narrower beside an alias of the wider: TagOutput
        an alias on both sides: OutputAlias
        the wider, an alias of it and the narrower: TagOutput
        a component reached inside nested members: Deep
        a boolean among the narrower’s members: WithTrue
        a component that names itself, and one extending it: Leaf
        the wider inside a bare \`allOf\` member: TagOutput
        both inside bare \`allOf\` members: TagOutput"
      `);
      expect(warnings()).toEqual([]);
    });

    it('stays the merge where neither `$ref` already is the other', async () => {
      const schemas = {
        ...tags,
        Other,
        TagAlias: ref('Tag'),
        OtherAlias: ref('Tag'),
        Either: all({ oneOf: [ref('Tag'), ref('Other')] }, { required: ['label'] }),
        One: all({ oneOf: [ref('Tag')] }, { required: ['label'] }),
        Maybe: all({ anyOf: [ref('Tag'), { type: 'null' }] }, { required: ['label'] }),
        MaybeAlias: { anyOf: [ref('Tag'), { type: 'null' }] },
        NotTag: { type: 'object', properties: { a: string }, not: ref('Tag') },
        A: all(ref('B'), { properties: { a: string } }),
        B: all(ref('A'), { properties: { b: string } }),
      };
      expect(
        await table(openapi, [
          ['two strangers', all(ref('Tag'), ref('Other')), schemas],
          // Two names for one component, neither naming the other: no narrower one to stand for both.
          ['two aliases of one component', all(ref('TagAlias'), ref('OtherAlias')), schemas],
          ['two aliases of one component, the other first', all(ref('OtherAlias'), ref('TagAlias')), schemas],
          ['the wider under a union of two', all(ref('Tag'), ref('Either')), schemas],
          ['the wider under a union of one', all(ref('Tag'), ref('One')), schemas],
          ['the wider under a nullable wrapper', all(ref('Tag'), ref('Maybe')), schemas],
          ['a nullable alias of the wider', all(ref('Tag'), ref('MaybeAlias')), schemas],
          ['the wider under a `not`', all(ref('Tag'), ref('NotTag')), schemas],
          ['two components that reach each other', all(ref('A'), ref('B')), schemas],
        ]),
      ).toMatchInlineSnapshot(`
        "two strangers: HolderTag { label?, color, other? }
        two aliases of one component: HolderTag { label?, color }
        two aliases of one component, the other first: HolderTag { label?, color }
        the wider under a union of two: HolderTag { label, color, other? }
        the wider under a union of one: HolderTag { label, color }
        the wider under a nullable wrapper: HolderTag { label, color }
        a nullable alias of the wider: HolderTag { label?, color }
        the wider under a \`not\`: HolderTag { label?, color, a? }
        two components that reach each other: HolderTag { b?, a? }"
      `);
    });

    it('stays the merge beside a member that makes it one, read as beside the `$ref` that stands alone', async () => {
      const schemas = { ...tags, Other };
      const pairs: ReadonlyArray<readonly [string, unknown]> = [
        ['an inline object member', { properties: { extra: string } }],
        ['a `$ref` to a component neither extends', ref('Other')],
        ['a union member that names a component', { oneOf: [ref('Other'), string] }],
        ['a member that requires a field', { required: ['label'] }],
      ];
      const lines: string[] = [];
      for (const [label, member] of pairs) {
        const both = await tagOf(openapi, all(ref('Tag'), ref('TagOutput'), member), schemas);
        // The same fields, required alike, as the `allOf` without the `$ref` that adds nothing.
        const alone = await parse(holder(openapi, all(ref('TagOutput'), member), schemas));
        const merged = await parse(holder(openapi, all(ref('Tag'), ref('TagOutput'), member), schemas));
        expect(modelOf(merged, 'HolderTag')?.fields, label).toEqual(modelOf(alone, 'HolderTag')?.fields);
        lines.push(`${label}: ${both}`);
      }
      const required = { ...all(ref('Tag'), ref('TagOutput')), required: ['label'] };
      lines.push(`\`required\` beside the \`allOf\`: ${await tagOf(openapi, required, schemas)}`);
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "an inline object member: HolderTag { label, color, extra? }
        a \`$ref\` to a component neither extends: HolderTag { label, color, other? }
        a union member that names a component: HolderTag { label, color, other? }
        a member that requires a field: HolderTag { label, color }
        \`required\` beside the \`allOf\`: HolderTag { label, color }"
      `);
    });

    it('is asked of objects alone, and where a member names a schema that says what an instance is', async () => {
      const schemas = {
        ...tags,
        Pets: { type: 'array', items: string },
        PetsNonEmpty: all(ref('Pets'), { minItems: 1 }),
        Kind: { type: 'string', enum: ['cat', 'dog'] },
        KindAlias: all(ref('Kind'), { description: 'An alias.' }),
        Described: { description: 'From a component.' },
        DescribedMore: all(ref('Described'), { deprecated: true }),
        EnumOverTag: { enum: ['a', 'b'], allOf: [ref('Tag')] },
      };
      expect(
        await table(openapi, [
          ['an array and one composing it', all(ref('Pets'), ref('PetsNonEmpty')), schemas],
          ['one array twice', all(ref('Pets'), ref('Pets')), schemas],
          ['an enum and an alias of it', all(ref('Kind'), ref('KindAlias')), schemas],
          // #715: two `$ref`s to schemas that say nothing of what an instance is.
          ['two annotating components, one composing the other', all(ref('Described'), ref('DescribedMore')), schemas],
          ['one annotating component twice', all(ref('Described'), ref('Described')), schemas],
          ['an enum written over an object', all(ref('Tag'), ref('EnumOverTag')), schemas],
        ]),
      ).toMatchInlineSnapshot(`
        "an array and one composing it: HolderTag {  }
        one array twice: HolderTag {  }
        an enum and an alias of it: HolderTag {  }
        two annotating components, one composing the other: HolderTag {  }
        one annotating component twice: HolderTag {  }
        an enum written over an object: HolderTag { label?, color }"
      `);
    });

    it('is the component with what its own model says, where a merge read the properties alone', async () => {
      const schemas = {
        ...tags,
        // `Narrow` narrows `color` before it names `Tag`: its model keeps the narrower declaration.
        Narrow: all({ properties: { color: { type: 'string', enum: ['red'] } } }, ref('Tag')),
        Kinded: all(ref('Tag'), {
          oneOf: [
            { type: 'object', properties: { kind: { const: 'cat' }, lives: { type: 'integer' } } },
            { type: 'object', properties: { kind: { const: 'dog' }, breed: string } },
          ],
        }),
        Nested: { type: 'object', properties: { meta: { type: 'object', properties: { m: string } } } },
        NestedOutput: all(ref('Nested'), { required: ['meta'] }),
      };
      const narrow = await parse(holder(openapi, all(ref('Tag'), ref('Narrow')), schemas));
      expect(show(fieldOf(narrow, 'Holder', 'tag')?.type)).toBe('Narrow');
      expect(names(narrow)).not.toMatch(/HolderTag/);
      expect(lineOf(narrow, 'Narrow')).toBe('Narrow extends Tag { color: "red", label?: string }');
      const kinded = await parse(holder(openapi, all(ref('Tag'), ref('Kinded')), schemas));
      expect(show(fieldOf(kinded, 'Holder', 'tag')?.type)).toBe('Kinded');
      expect(modelOf(kinded, 'Kinded')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'KindedCat', dog: 'KindedDog' },
      });
      const nested = await parse(holder(openapi, all(ref('Nested'), ref('NestedOutput')), schemas));
      expect(show(fieldOf(nested, 'Holder', 'tag')?.type)).toBe('NestedOutput');
      expect(lineOf(nested, 'NestedOutput')).toBe('NestedOutput extends Nested { meta: NestedOutputMeta }');
    });
  });
});

describe('#733 the wider component under another name', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const nullableTyped = (...members: unknown[]) =>
      openapi === '3.0.3'
        ? { type: 'object', nullable: true, allOf: members }
        : { type: ['object', 'null'], allOf: members };
    /** `TagAlias`, in spellings that only name `Tag` and in spellings that say something of their own. */
    const names: ReadonlyArray<readonly [string, unknown]> = [
      ['a `$ref`', ref('Tag')],
      ['a `$ref` beside a `description`', ref('Tag', { description: 'An alias.' })],
      [
        'a `$ref` beside a `title`, flags, an example and an `x-*` key',
        ref('Tag', { title: 'Alias', deprecated: true, example: { color: 'red' }, 'x-note': 'n' }),
      ],
      ['an `allOf` of one `$ref`', all(ref('Tag'))],
      ['an `allOf` of one `$ref` beside a `description`', { ...all(ref('Tag')), description: 'An alias.' }],
      ['an `allOf` of one described `$ref`', all(ref('Tag', { description: 'Inner.' }))],
      ['a name for a name', ref('Inner')],
      ['a name for a name for a name', ref('Middle')],
    ];
    const noNames: ReadonlyArray<readonly [string, unknown]> = [
      ['a `$ref` beside a limit', ref('Tag', { minProperties: 1 })],
      ['a `$ref` beside `required`', ref('Tag', { required: ['label'] })],
      ['a `$ref` beside `type: object`', ref('Tag', { type: 'object' })],
      ['a `$ref` beside `nullable: true`', ref('Tag', { nullable: true })],
      ['a `$ref` beside `properties`', ref('Tag', { properties: { more: string } })],
      ['a `$ref` beside a `not`', ref('Tag', notNull)],
      ['an `allOf` of one `$ref` beside a limit', { ...all(ref('Tag')), minProperties: 1 }],
      ['an `allOf` of one `$ref` beside `required`', { ...all(ref('Tag')), required: ['label'] }],
      ['an `allOf` of one `$ref` beside `type: object`', { type: 'object', ...all(ref('Tag')) }],
      ['an `allOf` of one `$ref` beside a nullable `type`', nullableTyped(ref('Tag'))],
      ['an `allOf` of one `$ref` beside `nullable: true`', { nullable: true, ...all(ref('Tag')) }],
      ['an `allOf` of one limited `$ref`', all(ref('Tag', { minProperties: 1 }))],
      ['an `allOf` of a `$ref` and a `description` member', all(ref('Tag'), { description: 'A member.' })],
      ['an `allOf` of a `$ref` and a `not` member', all(ref('Tag'), notNull)],
    ];
    const others = { Inner: ref('Tag'), Middle: ref('Inner'), OutputAlias: ref('TagOutput'), OtherAlias: ref('Tag') };
    /** `[TagAlias, TagOutput]` by hand in both orders, then as two declarations in both orders. */
    const row = async (TagAlias: unknown, Tag_: unknown = Tag): Promise<string> => {
      const schemas = { Tag: Tag_, TagOutput, TagAlias, ...others };
      const types: string[] = [];
      for (const members of [
        [ref('TagAlias'), ref('TagOutput')],
        [ref('TagOutput'), ref('TagAlias')],
      ]) {
        types.push(await tagOf(openapi, all(...members), schemas));
        const spec = await parse(declared(openapi, members[0], members[1], schemas));
        const field = fieldOf(spec, 'X', 'tag');
        expect(modelOf(spec, 'XTag') !== undefined).toBe(show(field?.type).includes('XTag'));
        types.push(show(field?.type));
      }
      return types.join(' | ');
    };

    it('is the narrower component: a `$ref`, or an `allOf` of one, beside documentation only', async () => {
      for (const [label, TagAlias] of names) {
        // By hand and for two declarations, in either order: every `TagOutput` is a `TagAlias`.
        expect(await row(TagAlias), label).toBe('TagOutput | TagOutput | TagOutput | TagOutput');
      }
      expect(warnings()).toEqual([]);
    });

    it('stays the merge where the name says anything of its own', async () => {
      const lines: string[] = [];
      for (const [label, TagAlias] of noNames) lines.push(`${label}: ${await row(TagAlias)}`);
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a \`$ref\` beside a limit: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        a \`$ref\` beside \`required\`: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        a \`$ref\` beside \`type: object\`: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        a \`$ref\` beside \`nullable: true\`: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        a \`$ref\` beside \`properties\`: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        a \`$ref\` beside a \`not\`: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        an \`allOf\` of one \`$ref\` beside a limit: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        an \`allOf\` of one \`$ref\` beside \`required\`: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        an \`allOf\` of one \`$ref\` beside \`type: object\`: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        an \`allOf\` of one \`$ref\` beside a nullable \`type\`: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        an \`allOf\` of one \`$ref\` beside \`nullable: true\`: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        an \`allOf\` of one limited \`$ref\`: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        an \`allOf\` of a \`$ref\` and a \`description\` member: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag
        an \`allOf\` of a \`$ref\` and a \`not\` member: HolderTag { label, color } | XTag | HolderTag { label, color } | XTag"
      `);
    });

    it('the issue’s documents with the base’s property typed by an alias', async () => {
      const aliased = (output: unknown) =>
        document(openapi, get('/pets', 'listPets', ref('PetOutput')), {
          ...tags,
          TagAlias: ref('Tag', { description: 'An alias.' }),
          Pet: { type: 'object', properties: { name: string, tag: ref('TagAlias') } },
          PetOutput: output,
        });
      const narrowing = aliased(all(ref('Pet'), { properties: { tag: ref('TagOutput') } }));
      const written = aliased({ type: 'object', properties: { name: string, tag: ref('TagOutput') } });
      expect(script(await parse(narrowing))).toMatchInlineSnapshot(`
        "Tag { label?: string, color: string }
        TagOutput extends Tag { label: string, color: string }
        TagAlias extends Tag { label?: string, color: string }
        Pet { name?: string, tag?: TagAlias }
        PetOutput extends Pet { name?: string, tag?: TagOutput }"
      `);
      await expectNoDiff(narrowing, written);
      // The reverse pair, and the override written first.
      const reverse = document(openapi, get('/pets', 'listPets', ref('PetOutput')), {
        ...tags,
        TagAlias: ref('Tag'),
        Pet: { type: 'object', properties: { name: string, tag: ref('TagOutput') } },
        PetOutput: all({ properties: { tag: ref('TagAlias') } }, ref('Pet')),
      });
      expect(lineOf(await parse(reverse), 'PetOutput')).toBe(
        'PetOutput extends Pet { tag?: TagOutput, name?: string }',
      );
    });

    it('with a name on both sides, three in a row, and two names with nothing narrower', async () => {
      const schemas = { ...tags, TagAlias: ref('Tag'), ...others, OutputWrapped: all(ref('TagOutput')) };
      expect(
        await table(openapi, [
          ['a name for each', all(ref('TagAlias'), ref('OutputAlias')), schemas],
          ['a name for each, the narrower first', all(ref('OutputAlias'), ref('TagAlias')), schemas],
          ['a name for each, the narrower an `allOf`', all(ref('Middle'), ref('OutputWrapped')), schemas],
          ['the wider, a name for it and the narrower', all(ref('Tag'), ref('TagAlias'), ref('TagOutput')), schemas],
          [
            'two names for the wider and the narrower',
            all(ref('TagAlias'), ref('OtherAlias'), ref('TagOutput')),
            schemas,
          ],
          ['a name for the wider beside the wider', all(ref('TagAlias'), ref('Tag')), schemas],
          ['a name for a name beside the name', all(ref('Inner'), ref('Middle')), schemas],
          // Neither is the narrower, and neither name is the other's: both stand, as they did.
          ['two names for one component', all(ref('TagAlias'), ref('OtherAlias')), schemas],
          ['two names for one component, the other first', all(ref('OtherAlias'), ref('TagAlias')), schemas],
          ['two names of different depth', all(ref('Middle'), ref('OtherAlias')), schemas],
        ]),
      ).toMatchInlineSnapshot(`
        "a name for each: OutputAlias
        a name for each, the narrower first: OutputAlias
        a name for each, the narrower an \`allOf\`: OutputWrapped
        the wider, a name for it and the narrower: TagOutput
        two names for the wider and the narrower: TagOutput
        a name for the wider beside the wider: TagAlias
        a name for a name beside the name: Middle
        two names for one component: HolderTag { label?, color }
        two names for one component, the other first: HolderTag { label?, color }
        two names of different depth: HolderTag { label?, color }"
      `);
    });

    it('admits `null` as the merge of both did', async () => {
      const NullableTag = nullableTag(openapi);
      const lines: string[] = [];
      for (const [label, TagAlias, Tag_] of [
        ['a name for a nullable component', ref('Tag'), NullableTag],
        ['an `allOf` name for a nullable component', all(ref('Tag')), NullableTag],
        ['a name for a component that admits none', ref('Tag'), Tag],
        // No names: a nullable `type` is the alias's own word.
        ['a nullable wrapper around a component that admits none', nullableTyped(ref('Tag')), Tag],
        ['a nullable wrapper around a nullable component', nullableTyped(ref('Tag')), NullableTag],
      ] as const) {
        const schemas = { Tag: Tag_, TagOutput, TagAlias, NotNull: notNull };
        const both = all(ref('TagAlias'), ref('TagOutput'));
        const types: string[] = [];
        for (const tag of [
          both,
          { type: 'object', ...both },
          all(ref('TagAlias'), ref('TagOutput'), notNull),
          all(ref('TagAlias'), ref('TagOutput'), ref('NotNull')),
        ]) {
          types.push(await tagOf(openapi, tag, schemas));
        }
        const spec = await parse(declared(openapi, ref('TagAlias'), ref('TagOutput'), schemas));
        types.push(show(fieldOf(spec, 'X', 'tag')?.type));
        lines.push(`${label}: ${types.join(' | ')}`);
      }
      expect(
        `both | \`type: object\` beside | a \`not\` member | a \`$ref\` to a \`not\` | two declarations\n${lines.join('\n')}`,
      ).toMatchInlineSnapshot(`
        "both | \`type: object\` beside | a \`not\` member | a \`$ref\` to a \`not\` | two declarations
        a name for a nullable component: nullable<TagOutput> | TagOutput | TagOutput | TagOutput | nullable<TagOutput>
        an \`allOf\` name for a nullable component: nullable<TagOutput> | TagOutput | TagOutput | TagOutput | nullable<TagOutput>
        a name for a component that admits none: TagOutput | TagOutput | TagOutput | TagOutput | TagOutput
        a nullable wrapper around a component that admits none: HolderTag { label, color } | HolderTag { label, color } | HolderTag { label, color } | HolderTag { label, color } | XTag
        a nullable wrapper around a nullable component: nullable<HolderTag> { label, color } | HolderTag { label, color } | HolderTag { label, color } | HolderTag { label, color } | nullable<XTag>"
      `);
    });
  });
});

describe('#733 `null`: the `allOf` admits what the conjunction of both admits', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const NullableTag = nullableTag(openapi);
    const nullableTyped = (...members: unknown[]) =>
      openapi === '3.0.3'
        ? { type: 'object', nullable: true, allOf: members }
        : { type: ['object', 'null'], allOf: members };
    const sets: ReadonlyArray<readonly [string, Doc]> = [
      ['both admit `null`', { Tag: NullableTag, TagOutput }],
      ['the narrower vetoes it', { Tag: NullableTag, TagOutput: all(ref('Tag'), { required: ['label'] }, notNull) }],
      ['the narrower is typed `object`', { Tag: NullableTag, TagOutput: { type: 'object', ...TagOutput } }],
      // The parser reads a nullable `type` beside an `allOf` as the nullable wrapper around it.
      ['the narrower admits it over a base that admits none', { Tag, TagOutput: nullableTyped(...TagOutput.allOf) }],
      ['neither admits it', tags],
    ];
    const both = all(ref('Tag'), ref('TagOutput'));
    const spellings: ReadonlyArray<readonly [string, unknown]> = [
      ['the `$ref` alone', ref('TagOutput')],
      ['both', both],
      ['both, the narrower first', all(ref('TagOutput'), ref('Tag'))],
      ['both, `type: object` beside', { type: 'object', ...both }],
      ['both, a nullable `type` beside', nullableTyped(ref('Tag'), ref('TagOutput'))],
      ['both, a `not` member', all(ref('Tag'), ref('TagOutput'), notNull)],
      ['both, a `$ref` to a `not`', all(ref('Tag'), ref('TagOutput'), ref('NotNull'))],
      ['both, a `description` member', all(ref('Tag'), ref('TagOutput'), { description: 'A tag.' })],
      ['both in bare `allOf` members', all(all(ref('Tag')), all(ref('TagOutput')))],
    ];

    it('by hand, at every spelling of the `allOf` and of the components', async () => {
      const lines: string[] = [];
      for (const [set, schemas] of sets) {
        const types: string[] = [];
        for (const [, tag] of spellings) {
          const spec = await parse(holder(openapi, tag, { ...schemas, NotNull: notNull }));
          // Never a copy, whatever it admits.
          expect(names(spec), set).toBe('Tag, TagOutput, Holder');
          types.push(show(fieldOf(spec, 'Holder', 'tag')?.type));
        }
        lines.push(`${set}: ${types.join(' | ')}`);
      }
      expect(`${spellings.map(([label]) => label).join(' | ')}\n${lines.join('\n')}`).toMatchInlineSnapshot(`
        "the \`$ref\` alone | both | both, the narrower first | both, \`type: object\` beside | both, a nullable \`type\` beside | both, a \`not\` member | both, a \`$ref\` to a \`not\` | both, a \`description\` member | both in bare \`allOf\` members
        both admit \`null\`: nullable<TagOutput> | nullable<TagOutput> | nullable<TagOutput> | TagOutput | nullable<TagOutput> | TagOutput | TagOutput | nullable<TagOutput> | nullable<TagOutput>
        the narrower vetoes it: TagOutput | TagOutput | TagOutput | TagOutput | nullable<TagOutput> | TagOutput | TagOutput | TagOutput | TagOutput
        the narrower is typed \`object\`: TagOutput | TagOutput | TagOutput | TagOutput | nullable<TagOutput> | TagOutput | TagOutput | TagOutput | TagOutput
        the narrower admits it over a base that admits none: nullable<TagOutput> | TagOutput | TagOutput | TagOutput | nullable<TagOutput> | TagOutput | TagOutput | TagOutput | TagOutput
        neither admits it: TagOutput | TagOutput | TagOutput | TagOutput | nullable<TagOutput> | TagOutput | TagOutput | TagOutput | TagOutput"
      `);
    });

    it('conjoined from two declarations, as the same two written by hand', async () => {
      const declarations: ReadonlyArray<readonly [string, unknown, unknown]> = [
        ['the wider, then the narrower', ref('Tag'), ref('TagOutput')],
        ['the narrower, then the wider', ref('TagOutput'), ref('Tag')],
        [
          'a wrapper typed `object` around the wider, then the narrower',
          { type: 'object', ...all(ref('Tag')) },
          ref('TagOutput'),
        ],
        [
          'the wider, then a wrapper typed `object` around the narrower',
          ref('Tag'),
          { type: 'object', ...all(ref('TagOutput')) },
        ],
        ['the wider beside a `not`, then the narrower', all(ref('Tag'), notNull), ref('TagOutput')],
        ['both by hand, then a wrapper typed `object` around the wider', both, { type: 'object', ...all(ref('Tag')) }],
        ['both by hand, then a string', both, string],
        ['both by hand, then a `description`', both, { description: 'A tag.' }],
      ];
      const lines: string[] = [];
      for (const [set, schemas] of sets) {
        const types: string[] = [];
        for (const [label, first, second] of declarations) {
          const spec = await parse(declared(openapi, first, second, schemas));
          expect(names(spec), `${set}: ${label}`).toBe('Tag, TagOutput, X');
          types.push(show(fieldOf(spec, 'X', 'tag')?.type));
        }
        lines.push(`${set}: ${types.join(' | ')}`);
      }
      expect(`${declarations.map(([label]) => label).join(' | ')}\n${lines.join('\n')}`).toMatchInlineSnapshot(`
        "the wider, then the narrower | the narrower, then the wider | a wrapper typed \`object\` around the wider, then the narrower | the wider, then a wrapper typed \`object\` around the narrower | the wider beside a \`not\`, then the narrower | both by hand, then a wrapper typed \`object\` around the wider | both by hand, then a string | both by hand, then a \`description\`
        both admit \`null\`: nullable<TagOutput> | nullable<TagOutput> | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | nullable<TagOutput>
        the narrower vetoes it: TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput
        the narrower is typed \`object\`: TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput
        the narrower admits it over a base that admits none: TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput
        neither admits it: TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | TagOutput"
      `);
    });

    it('for the readers that ask a schema of its own `null`', () => {
      within(
        { Tag: NullableTag, TagOutput, Plain: Tag, PlainOutput: all(ref('Plain'), { required: ['label'] }) },
        () => {
          const nullable: SchemaObject = { allOf: [at('Tag'), at('TagOutput')] };
          const typed: SchemaObject = { type: 'object', allOf: [at('Tag'), at('TagOutput')] };
          const vetoed: SchemaObject = { allOf: [at('Tag'), at('TagOutput'), notNull as SchemaObject] };
          const plain: SchemaObject = { allOf: [at('Plain'), at('PlainOutput')] };
          // As the merge of the two it was: the `null` every member admits is the schema's own.
          expect([nullable, typed, vetoed, plain].map(declaresNull)).toEqual([true, false, false, false]);
          expect([nullable, typed, vetoed, plain].map(mergeDeclaresNull)).toEqual([true, false, false, false]);
          expect([nullable, typed, vetoed, plain].map((schema) => schemaAdmitsNull(schema))).toEqual([
            true,
            false,
            false,
            false,
          ]);
          expect([nullable, typed, vetoed, plain].map((schema) => schemaToTypeRef(schema, 'tag', 'Holder'))).toEqual([
            { kind: 'nullable', inner: { kind: 'model', name: 'TagOutput' } },
            { kind: 'model', name: 'TagOutput' },
            { kind: 'model', name: 'TagOutput' },
            { kind: 'model', name: 'PlainOutput' },
          ]);
          // One `$ref` alone keeps the reading it had: the reference carries its component's `null` (#716).
          const alone: SchemaObject = { type: 'object', allOf: [at('TagOutput')] };
          expect(declaresNull(alone)).toBe(false);
          expect(schemaToTypeRef(alone, 'tag', 'Holder')).toEqual({
            kind: 'nullable',
            inner: { kind: 'model', name: 'TagOutput' },
          });
        },
      );
    });
  });
});

describe('#733 what is written beside the `$ref`s is carried as it was', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('by the conjunction of two declarations: text, flags and limits of both, the later’s over the earlier’s', async () => {
      const rows: ReadonlyArray<readonly [string, unknown, unknown]> = [
        ['the wider described', ref('Tag', { description: 'First.' }), ref('TagOutput')],
        ['the narrower described', ref('Tag'), ref('TagOutput', { description: 'Second.' })],
        ['both described', ref('Tag', { description: 'First.' }), ref('TagOutput', { description: 'Second.' })],
        ['the wider deprecated and limited', ref('Tag', { deprecated: true, minProperties: 1 }), ref('TagOutput')],
        ['the narrower deprecated and limited', ref('Tag'), ref('TagOutput', { deprecated: true, minProperties: 2 })],
        ['both limited', ref('Tag', { minProperties: 1 }), ref('TagOutput', { minProperties: 2 })],
        ['an extension on the wider', ref('Tag', { 'x-note': 'n' }), ref('TagOutput')],
        ['reverse pair, the narrower described', ref('TagOutput', { description: 'First.' }), ref('Tag')],
        ['reverse pair, the wider described', ref('TagOutput'), ref('Tag', { description: 'Second.' })],
        ['the narrower beside a member that annotates', ref('Tag'), all(ref('TagOutput'), { description: 'Member.' })],
      ];
      const lines: string[] = [];
      for (const [label, first, second] of rows) {
        lines.push(`${label}: ${declaredLine(await parse(declared(openapi, first, second)))}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "the wider described: TagOutput <description="First."> [Tag, TagOutput, X]
        the narrower described: TagOutput <description="Second."> [Tag, TagOutput, X]
        both described: TagOutput <description="Second."> [Tag, TagOutput, X]
        the wider deprecated and limited: TagOutput <deprecated=true constraints={"minProperties":1}> [Tag, TagOutput, X]
        the narrower deprecated and limited: TagOutput <deprecated=true constraints={"minProperties":2}> [Tag, TagOutput, X]
        both limited: TagOutput <constraints={"minProperties":2}> [Tag, TagOutput, X]
        an extension on the wider: TagOutput <extensions={"x-note":"n"}> [Tag, TagOutput, X]
        reverse pair, the narrower described: TagOutput <description="First."> [Tag, TagOutput, X]
        reverse pair, the wider described: TagOutput <description="Second."> [Tag, TagOutput, X]
        the narrower beside a member that annotates: TagOutput <description="Member."> [Tag, TagOutput, X]"
      `);
    });

    it('by the `allOf` written by hand: its own keywords, an annotating member’s, and every limit', async () => {
      const both = all(ref('Tag'), ref('TagOutput'));
      expect(
        await table(openapi, [
          ['text beside the `allOf`', { ...both, description: 'Wrapper.' }],
          ['a member that annotates', all(ref('Tag'), ref('TagOutput'), { description: 'Member.', deprecated: true })],
          [
            'a `$ref` to a component that annotates',
            all(ref('Tag'), ref('TagOutput'), ref('Described')),
            { ...tags, Described: { description: 'From a component.' } },
          ],
          ['a limit beside the `$ref` that adds nothing', all(ref('Tag', { minProperties: 2 }), ref('TagOutput'))],
          ['a limit beside the `$ref` that stands', all(ref('Tag'), ref('TagOutput', { minProperties: 3 }))],
          ['a limit beside the `allOf`', { ...both, minProperties: 1 }],
          ['text beside the `$ref` that adds nothing', all(ref('Tag', { description: 'First.' }), ref('TagOutput'))],
        ]),
      ).toMatchInlineSnapshot(`
        "text beside the \`allOf\`: TagOutput <description="Wrapper.">
        a member that annotates: TagOutput <description="Member." deprecated=true>
        a \`$ref\` to a component that annotates: TagOutput <description="From a component.">
        a limit beside the \`$ref\` that adds nothing: TagOutput <constraints={"minProperties":2}>
        a limit beside the \`$ref\` that stands: TagOutput <constraints={"minProperties":3}>
        a limit beside the \`allOf\`: TagOutput <constraints={"minProperties":1}>
        text beside the \`$ref\` that adds nothing: TagOutput"
      `);
    });

    it('`required` on the model requires the field, typed as the component', async () => {
      const spec = await parse(
        document(openapi, get('/pets', 'listPets', ref('PetOutput')), {
          ...tags,
          Pet: { type: 'object', properties: { name: string, tag: ref('Tag') } },
          PetOutput: all(ref('Pet'), { required: ['tag'], properties: { tag: ref('TagOutput') } }),
        }),
      );
      expect(lineOf(spec, 'PetOutput')).toBe('PetOutput extends Pet { name?: string, tag: TagOutput }');
    });
  });
});

describe('#733 at every site an `allOf` is written, and wherever a property is redeclared', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const both = all(ref('Tag'), ref('TagOutput'));
    const reversed = all(ref('TagOutput'), ref('Tag'));
    const parameter = (schema: unknown) => ({
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [{ name: 'filter', in: 'query', schema }],
          responses: { '200': { description: 'OK', ...json(ref('Tag')) } },
        },
      },
    });
    const requestBody = (schema: unknown) => ({
      '/pets': {
        post: { operationId: 'createPet', requestBody: json(schema), responses: { '204': { description: 'OK' } } },
      },
    });
    const header = (schema: unknown) => ({
      '/pets': {
        get: {
          operationId: 'getPet',
          responses: { '200': { description: 'OK', headers: { 'X-Tag': { schema } }, ...json(ref('Tag')) } },
        },
      },
    });
    /** Each site as a document writing `schema` there. */
    const sites: ReadonlyArray<readonly [string, (schema: unknown) => unknown]> = [
      ['a field', (schema) => holder(openapi, schema)],
      ['array items', (schema) => holder(openapi, { type: 'array', items: schema })],
      ['map values', (schema) => holder(openapi, { type: 'object', additionalProperties: schema })],
      ['a union variant', (schema) => holder(openapi, { oneOf: [schema, string] })],
      ['a response body', (schema) => document(openapi, get('/pets', 'listPets', schema), tags)],
      [
        'a response body’s items',
        (schema) => document(openapi, get('/pets', 'listPets', { type: 'array', items: schema }), tags),
      ],
      ['a request body', (schema) => document(openapi, requestBody(schema), tags)],
      ['a query parameter', (schema) => document(openapi, parameter(schema), tags)],
      ['a response header', (schema) => document(openapi, header(schema), tags)],
    ];

    it('the hand-written `allOf` is the component, in either order, as the `$ref` written there is', async () => {
      for (const [site, at] of sites) {
        for (const schema of [both, reversed]) {
          const spec = await parse(at(schema));
          // No model but the components', and whatever holds the site.
          expect(names(spec).replace(', Holder', ''), site).toBe('Tag, TagOutput');
          expect(spec, site).toEqual(await parse(at(all(ref('TagOutput')))));
          await expectNoDiff(at(schema), at(ref('TagOutput')), site);
        }
      }
      expect(warnings()).toEqual([]);
    });

    it('types each site as the component', async () => {
      const typed: string[] = [];
      for (const [site, at] of sites) {
        const spec = await parse(at(both));
        const [operation] = operations(spec);
        const type =
          fieldOf(spec, 'Holder', 'tag')?.type ??
          operation?.requestBody ??
          operation?.queryParams[0]?.type ??
          operation?.responseHeaders?.[0]?.type ??
          operation?.response;
        typed.push(`${site}: ${show(type)}`);
      }
      expect(typed.join('\n')).toMatchInlineSnapshot(`
        "a field: TagOutput
        array items: TagOutput[]
        map values: map<TagOutput>
        a union variant: (TagOutput | string)
        a response body: TagOutput
        a response body’s items: TagOutput[]
        a request body: TagOutput
        a query parameter: TagOutput
        a response header: TagOutput"
      `);
    });

    it('a webhook payload written so is the component', async () => {
      if (openapi !== '3.1.0') return;
      const webhook = (schema: unknown) => ({
        ...document(openapi, {}, tags),
        webhooks: {
          tagged: {
            post: { operationId: 'onTagged', requestBody: json(schema), responses: { '200': { description: 'OK' } } },
          },
        },
      });
      const spec = await parse(webhook(both));
      expect(names(spec)).toBe('Tag, TagOutput');
      expect(spec).toEqual(await parse(webhook(all(ref('TagOutput')))));
    });

    it('a property redeclared in an inline `allOf`, two levels deep, in an array’s items and across three members', async () => {
      const Pet = { type: 'object', properties: { name: string, tag: ref('Tag') } };
      const inline = await parse(
        document(openapi, get('/pets', 'listPets', all(ref('Pet'), { properties: { tag: ref('TagOutput') } })), {
          ...tags,
          Pet,
        }),
      );
      expect(script(inline).split('\n').slice(3)).toEqual(['ListPetsResponse { name?: string, tag?: TagOutput }']);

      const owner = (tag: string) => ({ type: 'object', properties: { tag: ref(tag) } });
      const deep = await parse(
        document(openapi, get('/pets', 'listPets', ref('PetOutput')), {
          ...tags,
          Pet: { type: 'object', properties: { owner: owner('Tag') } },
          PetOutput: all(ref('Pet'), { properties: { owner: owner('TagOutput') } }),
        }),
      );
      expect(script(deep).split('\n').slice(2)).toEqual([
        'Pet { owner?: PetOwner }',
        'PetOutput extends Pet { owner?: PetOutputOwner }',
        'PetOutputOwner { tag?: TagOutput }',
        'PetOwner { tag?: Tag }',
      ]);

      const items = (tag: string) => ({ type: 'array', items: ref(tag) });
      const listed = await parse(declared(openapi, items('Tag'), items('TagOutput')));
      expect(declaredLine(listed)).toBe('TagOutput[] [Tag, TagOutput, X]');

      const Mid = all(ref('TagOutput'), { properties: { mid: string } });
      const three = await parse(
        document(openapi, get('/x', 'getX', ref('X')), {
          ...tags,
          Mid,
          X: all(
            { properties: { tag: ref('Tag') } },
            { properties: { tag: ref('Mid') } },
            { properties: { tag: ref('TagOutput') } },
          ),
        }),
      );
      expect(declaredLine(three)).toBe('Mid [Tag, TagOutput, Mid, X]');
    });

    it('several variants declaring the property, one by hand and one as the `$ref`, declare one type', async () => {
      const spec = await parse(
        document(openapi, get('/x', 'getX', ref('X')), {
          ...tags,
          X: {
            type: 'object',
            properties: { id: string },
            oneOf: [{ properties: { tag: both } }, { properties: { tag: ref('TagOutput') } }],
          },
        }),
      );
      expect(declaredLine(spec)).toBe('TagOutput [Tag, TagOutput, X]');
    });

    it('a list envelope whose items and metadata are written so pages as the one written with the `$ref`s does', async () => {
      const envelope = (items: unknown, metadata: unknown) =>
        document(
          openapi,
          get('/tags', 'listTags', {
            type: 'object',
            properties: { data: { type: 'array', items }, list_metadata: metadata },
          }),
          {
            ...tags,
            Meta: { type: 'object', properties: { after: string } },
            MetaOutput: all(ref('Meta'), { required: ['after'] }),
          },
        );
      const byHand = envelope(both, all(ref('Meta'), ref('MetaOutput')));
      const byRef = envelope(all(ref('TagOutput')), all(ref('MetaOutput')));
      const spec = await parse(byHand);
      expect(spec).toEqual(await parse(byRef));
      expect(names(spec)).toBe('Tag, TagOutput, Meta, MetaOutput, ListTagsResponse');
      expect(lineOf(spec, 'ListTagsResponse')).toBe(
        'ListTagsResponse { data?: TagOutput[], list_metadata?: MetaOutput }',
      );
    });
  });
});

describe('#733 `bases` and `inheritedFrom` say what they said', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const lines = (spec: ApiSpec, ...models: string[]): string[] =>
      models.map((name) => {
        const model = modelOf(spec, name)!;
        const bases = model.bases?.length ? ` extends ${model.bases.map(show).join(', ')}` : '';
        return `${name}${bases} { ${model.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}${carried(f)}`).join(', ')} }`;
      });

    it('the narrowed field is the model’s own, and the base stays a base', async () => {
      // `tag` is `PetOutput`'s to write: its type is narrower than `Pet.tag`'s, and fits it.
      expect(lines(await parse(repro(openapi)), 'PetOutput')).toEqual([
        'PetOutput extends Pet { name?: string <from=Pet>, tag?: TagOutput }',
      ]);
      expect(lines(await parse(repro(openapi, narrowedBefore)), 'PetOutput')).toEqual([
        'PetOutput extends Pet { tag?: TagOutput, name?: string <from=Pet> }',
      ]);
      // The reverse pair: the conjunction of both declarations, as it was, typed as `Pet.tag` is.
      expect(lines(await parse(repro(openapi, narrowedAfter, 'Tag')), 'Pet', 'PetOutput')).toEqual([
        'Pet { name?: string, tag?: TagOutput }',
        'PetOutput extends Pet { name?: string <from=Pet>, tag?: TagOutput }',
      ]);
    });

    it('a base the copy had cost the model is kept: the component fits where the copy, without its limits, did not', async () => {
      // `Limited` writes a limit of its own, which a merged copy of `[Limited, Tag]` never carried, so the copy
      // was looser than `Pet.tag` and `Pet` was dropped as a base. The field is `Limited` now, as `Pet.tag` is.
      const limited = (narrowing: (base: string, tag: unknown) => unknown) =>
        document(openapi, get('/pets', 'listPets', ref('PetOutput')), {
          Tag,
          Limited: all(ref('Tag'), { minProperties: 1 }),
          Pet: { type: 'object', properties: { name: string, tag: ref('Limited') } },
          PetOutput: narrowing('Pet', ref('Tag')),
        });
      expect(lines(await parse(limited(narrowedAfter)), 'PetOutput')).toEqual([
        'PetOutput extends Pet { name?: string <from=Pet>, tag?: Limited }',
      ]);
      expect(lines(await parse(limited(narrowedBefore)), 'PetOutput')).toEqual([
        'PetOutput extends Pet { tag?: Limited, name?: string <from=Pet> }',
      ]);
    });

    it('two bases that declare the property, one narrower, both stay bases', async () => {
      const bases = {
        ...tags,
        A: { type: 'object', properties: { a: string, tag: ref('Tag') } },
        B: { type: 'object', properties: { b: string, tag: ref('TagOutput') } },
      };
      const forward = await parse(
        document(openapi, get('/x', 'getX', ref('X')), { ...bases, X: all(ref('A'), ref('B')) }),
      );
      expect(lines(forward, 'X')).toEqual([
        'X extends A, B { a?: string <from=A>, tag?: TagOutput, b?: string <from=B> }',
      ]);
      const backward = await parse(
        document(openapi, get('/x', 'getX', ref('X')), { ...bases, X: all(ref('B'), ref('A')) }),
      );
      expect(lines(backward, 'X')).toEqual([
        'X extends B, A { b?: string <from=B>, tag?: TagOutput, a?: string <from=A> }',
      ]);
    });

    it('a component composed of both keeps both as bases, and its own model', async () => {
      for (const [members, expected] of [
        [[ref('Tag'), ref('TagOutput')], 'Both extends Tag, TagOutput { label: string, color: string <from=Tag> }'],
        [
          [ref('TagOutput'), ref('Tag')],
          'Both extends TagOutput { label: string <from=TagOutput>, color: string <from=TagOutput> }',
        ],
        [[ref('Tag'), ref('Tag')], 'Both extends Tag { label?: string <from=Tag>, color: string <from=Tag> }'],
      ] as const) {
        const spec = await parse(
          document(openapi, get('/pets', 'listPets', ref('Both')), { ...tags, Both: { allOf: members } }),
        );
        expect(lines(spec, 'Both')).toEqual([expected]);
        expect(show(operations(spec)[0]!.response)).toBe('Both');
      }
    });
  });
});

describe('#733 where the rule meets #731, #732, #728 and #716', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('reads the other members as beside the one `$ref` that stands', async () => {
      const schemas = {
        ...tags,
        Other,
        Described: { description: 'From a component.' },
        NotNull: notNull,
        Limits: { description: 'Limited.', allOf: [{ minProperties: 1 }] },
        WithTrue: all(ref('Tag'), true),
        WithFalse: all(ref('Tag'), false),
      };
      expect(
        await table(openapi, [
          // #731: a `$ref` to a component that only annotates is the keywords in its place.
          ['beside a `$ref` to a `description`', all(ref('Tag'), ref('TagOutput'), ref('Described')), schemas],
          ['a `$ref` to a `description` first', all(ref('Described'), ref('Tag'), ref('TagOutput')), schemas],
          ['beside a `$ref` to a wrapper of limits', all(ref('Tag'), ref('TagOutput'), ref('Limits')), schemas],
          // #716: a `not` that vetoes `null`, written inline or through a `$ref`.
          ['beside a `not` member', all(ref('Tag'), ref('TagOutput'), notNull), schemas],
          ['beside a `$ref` to a `not`', all(ref('Tag'), ref('TagOutput'), ref('NotNull')), schemas],
          // #728: a JSON Schema boolean, as a member and inside the narrower component.
          ['beside `true`', all(ref('Tag'), ref('TagOutput'), true), schemas],
          ['beside `false`', all(ref('Tag'), ref('TagOutput'), false), schemas],
          ['a narrower component that holds `true`', all(ref('Tag'), ref('WithTrue')), schemas],
          ['a narrower component that holds `false`', all(ref('Tag'), ref('WithFalse')), schemas],
          // #732: a union member that names a component is one of the objects the merge conjoins.
          [
            'beside a union naming a component',
            all(ref('Tag'), ref('TagOutput'), { anyOf: [ref('Other'), string] }),
            schemas,
          ],
          ['the narrower alone beside that union', all(ref('TagOutput'), { anyOf: [ref('Other'), string] }), schemas],
          [
            'beside a union of primitives',
            all(ref('Tag'), ref('TagOutput'), { anyOf: [string, { type: 'integer' }] }),
            schemas,
          ],
          [
            'the narrower alone beside that union',
            all(ref('TagOutput'), { anyOf: [string, { type: 'integer' }] }),
            schemas,
          ],
        ]),
      ).toMatchInlineSnapshot(`
        "beside a \`$ref\` to a \`description\`: TagOutput <description="From a component.">
        a \`$ref\` to a \`description\` first: TagOutput <description="From a component.">
        beside a \`$ref\` to a wrapper of limits: TagOutput <description="Limited." constraints={"minProperties":1}>
        beside a \`not\` member: TagOutput
        beside a \`$ref\` to a \`not\`: TagOutput
        beside \`true\`: TagOutput
        beside \`false\`: TagOutput
        a narrower component that holds \`true\`: WithTrue
        a narrower component that holds \`false\`: WithFalse
        beside a union naming a component: HolderTag { label, color, other? }
        the narrower alone beside that union: HolderTag { label, color, other? }
        beside a union of primitives: TagOutput
        the narrower alone beside that union: TagOutput"
      `);
    });
  });

  it('a merge that names one component twice still asks each member of `null`', async () => {
    // #676: `{ allOf: [A, A] }` over a nullable `A` admits `null`; beside a third component it is still a merge.
    const Owner = { type: ['object', 'null'], properties: { name: string } };
    const Pal = { type: ['object', 'null'], properties: { pal: string } };
    const whole = await parse(
      holder(
        '3.1.0',
        all(ref('Owner'), ref('Owner'), ref('Pal')),
        { Owner, Pal, Plain: Other },
        {
          plain: all(ref('Owner'), ref('Owner'), ref('Plain')),
          twice: all(ref('Owner'), ref('Owner')),
        },
      ),
    );
    expect(Object.fromEntries(modelOf(whole, 'Holder')!.fields.map((f) => [f.name, show(f.type)]))).toEqual({
      tag: 'nullable<HolderTag>',
      plain: 'HolderPlain',
      twice: 'nullable<Owner>',
    });
    expect(modelOf(whole, 'HolderTag')!.fields.map((f) => f.name)).toEqual(['name', 'pal']);
  });
});

describe('#733 two declarations: `combineDeclarations` writes both, and the readers type the one that stands', () => {
  it('conjoins a component and one extending it as the `allOf` of both, as it did', () => {
    within(tags, () => {
      const [wide, narrow] = [at('Tag'), at('TagOutput')];
      const forward = combineDeclarations(wide, narrow);
      expect(forward).toEqual({ allOf: [wide, narrow], type: 'object' });
      expect(readInlineAllOf(forward.allOf!, forward)).toBe('reference');
      expect(allOfReferenceMember(forward)).toBe(narrow);
      expect(schemaToTypeRef(forward, 'tag', 'PetOutput')).toEqual({ kind: 'model', name: 'TagOutput' });
      const backward = combineDeclarations(narrow, wide);
      expect(backward).toEqual({ allOf: [narrow, wide], type: 'object' });
      expect(allOfReferenceMember(backward)).toBe(narrow);
      expect(schemaToTypeRef(backward, 'tag', 'PetOutput')).toEqual({ kind: 'model', name: 'TagOutput' });
      // Two `$ref`s to one component keep the first, as before.
      expect(combineDeclarations(wide, at('Tag'))).toBe(wide);
    });
  });
});

describe('#733 components that share bases many ways are read once', () => {
  it('reads a chain, a tower of components that each name the one before twice, and a lattice of diamonds', async () => {
    const depth = 40;
    const chain: Doc = { T0: { type: 'object', properties: { p0: string } } };
    for (let level = 1; level <= depth; level++) {
      chain[`T${level}`] = all(ref(`T${level - 1}`), { properties: { [`p${level}`]: string } });
    }
    // `A0` is an object and each `AN` the `allOf` of two `$ref`s to the level before: 2^40 paths to `A0`.
    const tower: Doc = { A0: { type: 'object', properties: { name: string } } };
    for (let level = 1; level <= depth; level++) tower[`A${level}`] = all(ref(`A${level - 1}`), ref(`A${level - 1}`));
    // `LN` and `RN` each compose both of the level before: 2^40 paths to `L0`, and neither reaches the other.
    const lattice: Doc = {
      L0: { type: 'object', properties: { name: string } },
      R0: { type: 'object', properties: { id: string } },
    };
    for (let level = 1; level <= depth; level++) {
      lattice[`L${level}`] = all(ref(`L${level - 1}`), ref(`R${level - 1}`));
      lattice[`R${level}`] = all(ref(`R${level - 1}`), ref(`L${level - 1}`));
    }
    const spec = await parse(
      holder(
        '3.1.0',
        all(ref('T0'), ref(`T${depth}`)),
        { ...chain, ...tower, ...lattice },
        {
          every_level: { allOf: Array.from({ length: depth + 1 }, (_, level) => ref(`T${level}`)) },
          every_level_reversed: { allOf: Array.from({ length: depth + 1 }, (_, level) => ref(`T${depth - level}`)) },
          tower_ends: all(ref('A0'), ref(`A${depth}`)),
          tower_top: all(ref(`A${depth}`), ref(`A${depth - 1}`)),
          tower_twice: all(ref(`A${depth}`), ref(`A${depth}`)),
          lattice_left: all(ref('L0'), ref(`L${depth}`)),
          lattice_right: all(ref(`R${depth}`), ref('R0')),
          lattice_mixed: all(ref(`L${depth - 1}`), ref(`R${depth}`), ref('L0')),
          lattice_both: all(ref(`L${depth}`), ref(`R${depth}`)),
        },
      ),
    );
    expect(Object.fromEntries(modelOf(spec, 'Holder')!.fields.map((f) => [f.name, show(f.type)]))).toEqual({
      tag: `T${depth}`,
      every_level: `T${depth}`,
      every_level_reversed: `T${depth}`,
      tower_ends: `A${depth}`,
      tower_top: `A${depth}`,
      tower_twice: `A${depth}`,
      lattice_left: `L${depth}`,
      lattice_right: `R${depth}`,
      lattice_mixed: `R${depth}`,
      // Neither composes the other: still the merge.
      lattice_both: 'HolderLatticeBoth',
    });
    // The components themselves are read as they were, every `$ref` member a base.
    expect(modelOf(spec, `A${depth}`)!.bases?.map(show)).toEqual([`A${depth - 1}`]);
    expect(modelOf(spec, `L${depth}`)!.bases?.map(show)).toEqual([`L${depth - 1}`, `R${depth - 1}`]);
  });
});

describe('#733 a walker handed a component map names the reference by that map', () => {
  // Greptile, #733 review: `resolveBareSchema` read the `allOf` by the map it
  // was handed and then named its `$ref` by the document's components
  // (`allOfReferenceMember`). Where no document was being read, or one with
  // other components, an envelope `allOf: [Wide, Narrow]` was the reference
  // by the map and `Wide`, the first `$ref` written, by the picker — so a
  // `dataPath` under what `Narrow` adds resolved to nothing, where the two
  // had been merged and the path found.
  const Pet = { type: 'object', required: ['id'], properties: { id: string } };
  const Wide = { type: 'object', properties: { id: string } };
  const page = { items: { type: 'array', items: ref('Pet') }, has_more: { type: 'boolean' } };
  const Narrow = all(ref('Wide'), { properties: page });
  const Described = { description: 'A page.' };
  const WideName = { description: 'Another name.', ...all(ref('Wide')) };
  const Pets = { type: 'array', items: ref('Pet') };
  const map = { Pet, Wide, Narrow, Described, WideName, Pets } as Record<string, SchemaObject>;
  /** Components by which `Narrow` composes nothing: `Wide` and `Narrow` are two components to merge. */
  const apart = { ...map, Narrow: { type: 'object', properties: page } } as Record<string, SchemaObject>;
  const of = (...members: unknown[]) => all(...members) as SchemaObject;
  /** Envelopes that are `Narrow` by `map`, however `Wide` is written beside it. */
  const envelopes = (): ReadonlyArray<readonly [string, SchemaObject]> => [
    ['[Wide, Narrow]', of(at('Wide'), at('Narrow'))],
    ['[Narrow, Wide]', of(at('Narrow'), at('Wide'))],
    ['[Wide, Wide, Narrow]', of(at('Wide'), at('Wide'), at('Narrow'))],
    ['[Narrow, Narrow]', of(at('Narrow'), at('Narrow'))],
    ['[WideName, Narrow]', of(at('WideName'), at('Narrow'))],
    ['[Narrow, WideName]', of(at('Narrow'), at('WideName'))],
    ['[{ allOf: [Wide] }, Narrow]', of(of(at('Wide')), at('Narrow'))],
    ['[{ allOf: [Wide, Narrow] }]', of(of(at('Wide'), at('Narrow')))],
    ['[Wide, Narrow], described', { description: 'A page.', ...of(at('Wide'), at('Narrow')) }],
    ['[Described, Wide, Narrow]', of(at('Described'), at('Wide'), at('Narrow'))],
    // #731's `$ref` read as the keywords in its place, named by the map as well.
    ['[Described, Narrow]', of(at('Described'), at('Narrow'))],
    ['[Narrow, Described]', of(at('Narrow'), at('Described'))],
  ];
  const nullable = (): SchemaObject => ({ oneOf: [of(at('Wide'), at('Narrow')), { type: 'null' }] });
  const expectNarrow = (envelope: SchemaObject, label: string): void => {
    expect(resolveBareSchema(envelope, map), label).toBe(map.Narrow);
    expect(resolveDataPathArray(envelope, 'items', map), label).toEqual({ items: Pets.items });
    expect(Object.keys(collectObjectProperties(envelope, map).properties).sort(), label).toEqual([
      'has_more',
      'id',
      'items',
    ]);
  };

  it('with no document being read: the envelope is `Narrow`, and a path under what it adds resolves', () => {
    for (const [label, envelope] of envelopes()) expectNarrow(envelope, label);
    expectNarrow(nullable(), 'nullable');
  });

  it('with another document being read: by the map handed, whichever of the two says one extends the other', () => {
    within(structuredClone(apart), () => {
      for (const [label, envelope] of envelopes()) expectNarrow(envelope, label);
      expectNarrow(nullable(), 'nullable');
    });
    // The other way about: the document says `Narrow` extends `Wide` and
    // the map handed that it does not, so the two are merged as written.
    within(structuredClone(map), () => {
      for (const envelope of [of(at('Wide'), at('Narrow')), of(at('Narrow'), at('Wide'))]) {
        expect(readInlineAllOf(envelope.allOf!, envelope, apart)).toBe('merged');
        expect(resolveBareSchema(envelope, apart)).toBe(envelope);
        expect(resolveDataPathArray(envelope, 'items', apart)).toEqual({ items: page.items.items });
        expect(Object.keys(collectObjectProperties(envelope, apart).properties).sort()).toEqual([
          'has_more',
          'id',
          'items',
        ]);
      }
    });
  });

  it('`readAllOfReference` names the member the reading weighed, by the map it read by', () => {
    const named = (schema: SchemaObject, components?: Record<string, SchemaObject>): string => {
      const { reading, reference } = readAllOfReference(schema, components);
      return reference ? `${reading} to ${String(reference.$ref).split('/').pop()}` : reading;
    };
    expect(named(of(at('Wide'), at('Narrow')), map)).toBe('reference to Narrow');
    expect(named(of(at('Narrow'), at('Wide')), map)).toBe('reference to Narrow');
    expect(named(of(at('Wide'), at('Wide')), map)).toBe('reference to Wide');
    expect(named(of(at('WideName'), at('Narrow')), map)).toBe('reference to Narrow');
    expect(named(of(of(at('Wide')), at('Narrow')), map)).toBe('reference to Narrow');
    expect(named(of(at('Described'), at('Narrow')), map)).toBe('reference to Narrow');
    expect(named(of(at('Described'), at('Wide'), at('Narrow')), map)).toBe('reference to Narrow');
    // The member itself, as the document writes it.
    const envelope = of(at('Wide'), at('Narrow'));
    expect(readAllOfReference(envelope, map).reference).toBe(envelope.allOf![1]);
    // By components that say otherwise, and by none, the two are a merge and name no reference.
    expect(named(of(at('Wide'), at('Narrow')), apart)).toBe('merged');
    expect(named(of(at('Wide'), at('Narrow')))).toBe('merged');
    expect(named(of(at('Wide'), at('Pet')), map)).toBe('merged');
    // A component's own `allOf` composes a model of its own (`typingReferences`).
    const components = { ...map, Both: of(at('Wide'), at('Narrow')) };
    expect(named(components.Both, components)).toBe('merged');
    // No reference is named for a member read as the schema, nor where no member is a `$ref`.
    expect(named(of({ type: 'string' }), map)).toBe('unwrapped');
    expect(named(of(of(at('Wide'), at('Narrow'))), map)).toBe('unwrapped');
    expect(named(of({ type: 'string' }, { type: 'integer' }), map)).toBe('reference');
  });

  it('agrees with `readInlineAllOf` and `allOfReferenceMember` where the map is the document’s', () => {
    within(map, () => {
      const rows: ReadonlyArray<readonly [string, SchemaObject]> = [
        ...envelopes(),
        ['[Wide, Pet]', of(at('Wide'), at('Pet'))],
        ['[Pets, Pets]', of(at('Pets'), at('Pets'))],
        ['[string]', of({ type: 'string' })],
        ['[string, integer]', of({ type: 'string' }, { type: 'integer' })],
        ['[Narrow], required', { required: ['id'], ...of(at('Narrow')) }],
      ];
      for (const [label, schema] of rows) {
        const reading = readInlineAllOf(schema.allOf!, schema);
        const reference = reading === 'reference' ? allOfReferenceMember(schema) : undefined;
        for (const read of [readAllOfReference(schema), readAllOfReference(schema, map)]) {
          expect(read.reading, label).toBe(reading);
          expect(read.reference, label).toBe(reference);
        }
      }
    });
  });

  it('so does the walk through a component’s aliases, which names what an alias is an alias of', () => {
    // By `map`, `[Described, Pets]` is the reference to `Pets` (#731), and the alias of an array.
    expect(isArrayComponentEntry(of(at('Described'), at('Pets')), map)).toBe(true);
    expect(isArrayComponentEntry(of(at('Pets'), at('Described')), map)).toBe(true);
    within(structuredClone(apart), () => {
      expect(isArrayComponentEntry(of(at('Described'), at('Pets')), map)).toBe(true);
    });
    // Two `$ref`s one of which the other already is name an object: no array either way.
    expect(isArrayComponentEntry(of(at('Wide'), at('Narrow')), map)).toBe(false);
    expect(isArrayComponentEntry(of(at('Narrow'), at('Wide')), map)).toBe(false);
  });

  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const list = (schema: unknown) => ({
      '/things': {
        get: {
          operationId: 'listThings',
          parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }],
          'x-pagination': {
            strategy: 'page',
            dataPath: 'items',
            endOfIteration: { kind: 'hasMore', path: 'has_more' },
          },
          responses: { '200': { description: 'OK', ...json(schema) } },
        },
      },
    });

    it('a list operation whose envelope is written as both is paged by what the narrower adds', async () => {
      const lines: string[] = [];
      for (const [label, envelope] of envelopes()) {
        const [operation] = operations(await parse(document(openapi, list(envelope), map)));
        const paging = operation!.pagination;
        lines.push(
          `${label}: ${show(operation!.response)}, ${paging?.strategy} over ${paging?.dataPath} of ${show(paging?.itemType)}`,
        );
      }
      expect(warnings()).toEqual([]);
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "[Wide, Narrow]: Narrow, page over items of Pet
        [Narrow, Wide]: Narrow, page over items of Pet
        [Wide, Wide, Narrow]: Narrow, page over items of Pet
        [Narrow, Narrow]: Narrow, page over items of Pet
        [WideName, Narrow]: Narrow, page over items of Pet
        [Narrow, WideName]: Narrow, page over items of Pet
        [{ allOf: [Wide] }, Narrow]: Narrow, page over items of Pet
        [{ allOf: [Wide, Narrow] }]: Narrow, page over items of Pet
        [Wide, Narrow], described: Narrow, page over items of Pet
        [Described, Wide, Narrow]: Narrow, page over items of Pet
        [Described, Narrow]: Narrow, page over items of Pet
        [Narrow, Described]: Narrow, page over items of Pet"
      `);
    });
  });
});

describe('#733 a document that parsed still parses', () => {
  /** A value of every kind a document may write where a schema, a list of schemas or a `$ref` goes. */
  const kinds: ReadonlyArray<readonly [string, unknown]> = [
    ['true', true],
    ['false', false],
    ['a number', 5],
    ['a string', 'text'],
    ['a list', [string]],
    ['an empty list', []],
    ['{}', {}],
    ['a `$ref` that is a number', { $ref: 5 }],
    ['a `$ref` that is a list', { $ref: ['#/components/schemas/Tag'] }],
    ['a `$ref` that is `null`', { $ref: null }],
    ['a component that composes itself', ref('LoopA')],
  ];
  const loops = {
    LoopA: all(ref('LoopB'), { properties: { a: string } }),
    LoopB: all(ref('LoopA'), { properties: { b: string } }),
  };

  it('with any value as the wider component, inside the narrower one, or among the members', async () => {
    const both = all(ref('Tag'), ref('TagOutput'));
    const parsed: string[] = [];
    for (const [kind, value] of kinds) {
      const documents: ReadonlyArray<readonly [string, unknown]> = [
        ['the wider component', holder('3.1.0', both, { ...loops, Tag: value, TagOutput })],
        ['a member of the narrower', holder('3.1.0', both, { ...loops, Tag, TagOutput: all(ref('Tag'), value) })],
        ['the narrower’s first member', holder('3.1.0', both, { ...loops, Tag, TagOutput: all(value, ref('Tag')) })],
        ['inside a nested member', holder('3.1.0', both, { ...loops, Tag, TagOutput: all(all(value, ref('Tag'))) })],
        [
          'the wider’s properties',
          holder('3.1.0', both, { ...loops, Tag: { type: 'object', properties: value }, TagOutput }),
        ],
        ['a member beside the two', holder('3.1.0', all(ref('Tag'), ref('TagOutput'), value), { ...loops, ...tags })],
        ['a member before the two', holder('3.1.0', all(value, ref('Tag'), ref('TagOutput')), { ...loops, ...tags })],
        ['in place of the wider', holder('3.1.0', all(value, ref('TagOutput')), { ...loops, ...tags })],
        ['in place of the narrower', holder('3.1.0', all(ref('Tag'), value), { ...loops, ...tags })],
        ['declared before the narrower', declared('3.1.0', value, ref('TagOutput'), { ...loops, ...tags })],
        ['declared after the wider', declared('3.1.0', ref('Tag'), value, { ...loops, ...tags })],
      ];
      const outcomes: string[] = [];
      for (const [where, doc] of documents) {
        // Every one of these parses without any of this: none may fail with it.
        const spec = await parse(doc).catch((error: Error) => error);
        expect(spec instanceof Error ? spec.message : 'parses', `${kind} as ${where}`).toBe('parses');
        const read = spec as ApiSpec;
        outcomes.push(show((fieldOf(read, 'Holder', 'tag') ?? fieldOf(read, 'X', 'tag'))?.type));
      }
      parsed.push(`${kind}: ${outcomes.join(' | ')}`);
    }
    // Each row as before, but for the copy that is now the component.
    expect(parsed.join('\n')).toMatchInlineSnapshot(`
      "true: HolderTag | TagOutput | TagOutput | TagOutput | HolderTag | TagOutput | TagOutput | TagOutput | Tag | TagOutput | Tag
      false: HolderTag | TagOutput | TagOutput | TagOutput | HolderTag | TagOutput | TagOutput | TagOutput | Tag | TagOutput | Tag
      a number: HolderTag | TagOutput | TagOutput | TagOutput | HolderTag | TagOutput | TagOutput | TagOutput | Tag | TagOutput | Tag
      a string: HolderTag | TagOutput | TagOutput | TagOutput | HolderTag | TagOutput | TagOutput | TagOutput | Tag | TagOutput | Tag
      a list: HolderTag | TagOutput | TagOutput | TagOutput | HolderTag | TagOutput | TagOutput | TagOutput | Tag | TagOutput | Tag
      an empty list: HolderTag | TagOutput | TagOutput | TagOutput | HolderTag | TagOutput | TagOutput | TagOutput | Tag | TagOutput | Tag
      {}: HolderTag | TagOutput | TagOutput | TagOutput | HolderTag | TagOutput | TagOutput | TagOutput | Tag | TagOutput | Tag
      a \`$ref\` that is a number: HolderTag | TagOutput | TagOutput | TagOutput | TagOutput | HolderTag | HolderTag | HolderTag | HolderTag | unknown | Tag
      a \`$ref\` that is a list: HolderTag | TagOutput | TagOutput | TagOutput | TagOutput | HolderTag | HolderTag | HolderTag | HolderTag | Tag | Tag
      a \`$ref\` that is \`null\`: HolderTag | TagOutput | TagOutput | TagOutput | TagOutput | HolderTag | HolderTag | HolderTag | HolderTag | unknown | Tag
      a component that composes itself: TagOutput | TagOutput | TagOutput | TagOutput | TagOutput | HolderTag | HolderTag | HolderTag | HolderTag | XTag | XTag"
    `);
  });
});
