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
  schemaToTypeRef,
  type SchemaObject,
} from '../../src/parser/schemas.js';
import { allOfReferenceMember, combineDeclarations, readInlineAllOf } from '../../src/parser/inline-models.js';
import { collectObjectProperties, resolveDataPathArray } from '../../src/parser/pagination.js';
import type { ApiSpec, Field, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #743: two `allOf` members that declare one property are conjoined
 * (#653), and a `$ref` to a component that extends the other declaration's
 * types the conjunction (#733). That held for a `$ref`, an `allOf` of one,
 * an array of either and the type-list spelling of a nullable object, but
 * not for the union spelling of a nullable `$ref`: asked as written, `{
 * anyOf: [{ $ref: Tag }, { type: 'null' }] }` described no object, so the
 * pair kept the first declaration and a property redeclared as a nullable
 * union of `TagOutput` stayed a `Tag | null`. A nullable `oneOf`/`anyOf`
 * wrapper is now conjoined as the declaration it wraps, with `null`
 * exactly when both declarations admit it.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-743-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}
const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeDoc(doc));

type Doc = Record<string, unknown>;
const ref = (name: string, beside: Doc = {}) => ({ $ref: `#/components/schemas/${name}`, ...beside });
const string = { type: 'string' };
const nul = { type: 'null' };
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const all = (...members: unknown[]) => ({ allOf: members });

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

/** The issue's `Tag { label?, color }`, `TagOutput`, which composes it and requires `label`, and one more level. */
const Tag = { type: 'object', properties: { label: string, color: string }, required: ['color'] };
const TagOutput = all(ref('Tag'), { required: ['label'] });
const TagFinal = all(ref('TagOutput'), { properties: { final: { type: 'boolean' } } });
const Other = { type: 'object', properties: { other: string } };
const tags = { Tag, TagOutput, TagFinal, Other };

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

/** How `PetOutput` redeclares the `tag` it inherits from `Pet`: the override member after the base, as the issue writes it, or another way. */
type Narrowing = (base: string, tag: unknown) => unknown;
const narrowedAfter: Narrowing = (base, tag) => all(ref(base), { properties: { tag } });
const narrowedBefore: Narrowing = (base, tag) => all({ properties: { tag } }, ref(base));
const narrowedTyped: Narrowing = (base, tag) => all(ref(base), { type: 'object', properties: { tag } });
const narrowedBeside: Narrowing = (base, tag) => ({ ...all(ref(base)), properties: { tag } });

/** The issue's documents: `Pet.tag` declared `first`, and `PetOutput`, which composes `Pet`, redeclaring it `second` (and then each of `more`). */
const redeclared = (
  openapi: Version,
  first: unknown,
  second: unknown,
  { narrowing = narrowedAfter, schemas = tags as Doc, more = [] as unknown[] } = {},
) =>
  document(openapi, get('/pets', 'listPets', ref('PetOutput')), {
    ...schemas,
    Pet: { type: 'object', properties: { name: string, tag: first } },
    PetOutput:
      more.length === 0
        ? narrowing('Pet', second)
        : all(ref('Pet'), { properties: { tag: second } }, ...more.map((tag) => ({ properties: { tag } }))),
  });
/**
 * The issue's `nullable-direct.json`: `PetOutput` declaring its properties
 * itself — `alone`, as the issue writes it, or beside the `Pet` it no
 * longer composes, whose own `tag` is `pet`.
 */
const direct = (
  openapi: Version,
  tag: unknown,
  { alone = false, pet = ref('Tag') as unknown, schemas = tags as Doc } = {},
) =>
  document(openapi, get('/pets', 'listPets', ref('PetOutput')), {
    ...schemas,
    ...(alone ? {} : { Pet: { type: 'object', properties: { name: string, tag: pet } } }),
    PetOutput: { type: 'object', properties: { name: string, tag } },
  });

/** The spellings of a declaration that is `name`, or `null`. */
const anyOfNull = (name: string) => ({ anyOf: [ref(name), nul] });
const oneOfNull = (name: string) => ({ oneOf: [ref(name), nul] });
const typeList = (name: string) => ({ type: ['object', 'null'], allOf: [ref(name)] });
/** OAS 3.0 has no `null` type: `nullable: true` beside the union stands for the variant. */
const flagged = (name: string) => ({ anyOf: [ref(name)], nullable: true });
/** The union spelling of a nullable `name` in the version's own words. */
const nullable = (openapi: Version, name: string) => (openapi === '3.0.3' ? flagged(name) : anyOfNull(name));
/** The spelling that conjoined before: a nullable `type` beside an `allOf` of the `$ref`. */
const typed = (openapi: Version, name: string) =>
  openapi === '3.0.3' ? { type: 'object', nullable: true, allOf: [ref(name)] } : typeList(name);

/** A type as the issue's script prints it: `TagOutput | null`, `TagOutput[] | null`, `(Tag | Other) | null`. */
const typeOf = (type: TypeRef | undefined): string => {
  if (!type) return 'none';
  switch (type.kind) {
    case 'nullable':
      return `${typeOf(type.inner)} | null`;
    case 'array':
      return type.items.kind === 'nullable' ? `(${typeOf(type.items)})[]` : `${typeOf(type.items)}[]`;
    case 'map':
      return `Record<string, ${typeOf(type.valueType)}>`;
    case 'union':
      return `(${type.variants.map(typeOf).join(' | ')})`;
    case 'primitive':
      return type.type;
    case 'literal':
      return JSON.stringify(type.value);
    default:
      return type.name;
  }
};
const modelOf = (spec: ApiSpec, name: string): Model | undefined => spec.models.find((m) => m.name === name);
const fieldOf = (spec: ApiSpec, model: string, field: string): Field | undefined =>
  modelOf(spec, model)?.fields.find((f) => f.name === field);
const fieldsOf = (model: Model | undefined): string =>
  model ? model.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${typeOf(f.type)}`).join(', ') : 'none';
/** The issue's script: the fields of `PetOutput`. */
const script = (spec: ApiSpec): string => fieldsOf(modelOf(spec, 'PetOutput'));
const names = (spec: ApiSpec): string => spec.models.map((m) => m.name).join(', ');

/** What a field carries beside its type, as `key=value` words. */
const carried = (field: Field | undefined): string => {
  if (!field) return '';
  const { description, deprecated, readOnly, writeOnly, constraints, extensions, inheritedFrom } = field;
  const words = Object.entries({ description, deprecated, readOnly, writeOnly, constraints, extensions })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  if (inheritedFrom) words.push(`from=${typeOf(inheritedFrom)}`);
  return words.length > 0 ? ` <${words.join(' ')}>` : '';
};
/**
 * `PetOutput.tag`: its type and what the field carries, with the fields
 * of `PetOutputTag`, the model minted under the field, when the document
 * builds one — which it does exactly when the field names it.
 */
const tagLine = (spec: ApiSpec): string => {
  const field = fieldOf(spec, 'PetOutput', 'tag');
  const minted = modelOf(spec, 'PetOutputTag');
  const named = typeOf(field?.type).includes('PetOutputTag');
  expect(minted !== undefined, 'a model is minted exactly when the field names it').toBe(named);
  return `${typeOf(field?.type)}${minted ? ` { ${fieldsOf(minted)} }` : ''}${carried(field)}`;
};
type Row = readonly [label: string, first: unknown, second: unknown, schemas?: Doc];
/** One line per row: `PetOutput.tag` with `Pet.tag` declared `first` and the override member declaring `second`. */
const table = async (openapi: Version, rows: readonly Row[]): Promise<string> => {
  const lines: string[] = [];
  for (const [label, first, second, schemas] of rows) {
    lines.push(`${label}: ${tagLine(await parse(redeclared(openapi, first, second, { schemas })))}`);
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
/** `diffSpecs` reports nothing between the two documents, in either direction, and `oagen diff` exits 0. */
async function expectNoDiff(first: unknown, second: unknown, label = ''): Promise<void> {
  const [a, b] = [await parse(first), await parse(second)];
  expect(diffSpecs(a, b).changes, label).toEqual([]);
  expect(diffSpecs(b, a).changes, label).toEqual([]);
  expect(await diffExit(first, second), label).toBe(0);
  expect(await diffExit(second, first), label).toBe(0);
}
/** Each change `diffSpecs` reports, in a word: its kind, a `!` when breaking, the model, and the fields changed. */
const changesOf = (from: ApiSpec, to: ApiSpec): string[] =>
  diffSpecs(from, to).changes.map((change) => {
    const { kind, classification } = change;
    const named = change as { name?: string; modelName?: string; fieldChanges?: { kind: string; fieldName: string }[] };
    const fields = named.fieldChanges?.map((f) => `${f.kind}(${f.fieldName})`).join(', ');
    return `${kind}${classification === 'breaking' ? '!' : ''}(${named.modelName ?? named.name ?? ''})${fields ? `[${fields}]` : ''}`;
  });

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

describe('#743 a property redeclared as a nullable union of a `$ref`', () => {
  it('the issue’s documents, and its script’s output', async () => {
    const nullableArray = (name: string) => ({ anyOf: [{ type: 'array', items: ref(name) }, nul] });
    const files: Record<string, unknown> = {
      'nullable.json': redeclared('3.1.0', anyOfNull('Tag'), anyOfNull('TagOutput')),
      'nullable-oneof.json': redeclared('3.1.0', oneOfNull('Tag'), oneOfNull('TagOutput')),
      'nullable-then-ref.json': redeclared('3.1.0', anyOfNull('Tag'), ref('TagOutput')),
      'type-list.json': redeclared('3.1.0', typeList('Tag'), typeList('TagOutput')),
      'nullable-array.json': redeclared('3.1.0', nullableArray('Tag'), nullableArray('TagOutput')),
      'plain-ref.json': redeclared('3.1.0', ref('Tag'), ref('TagOutput')),
      'nullable-direct.json': direct('3.1.0', anyOfNull('TagOutput'), { alone: true }),
    };
    const lines: string[] = [];
    for (const [name, doc] of Object.entries(files)) lines.push(`${name}: ${script(await parse(doc))}`);
    // The first three were `tag?: Tag | null`.
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "nullable.json: name?: string, tag?: TagOutput | null
      nullable-oneof.json: name?: string, tag?: TagOutput | null
      nullable-then-ref.json: name?: string, tag?: TagOutput
      type-list.json: name?: string, tag?: TagOutput | null
      nullable-array.json: name?: string, tag?: TagOutput[] | null
      plain-ref.json: name?: string, tag?: TagOutput
      nullable-direct.json: name?: string, tag?: TagOutput | null"
    `);

    // `oagen diff --old nullable.json --new nullable-direct.json` reported a breaking
    // `field-type-changed` on `tag`. Nothing is reported for `tag` now, in either direction: what is
    // left is `Pet`, which `nullable-direct.json` does not declare.
    const [composed, alone] = [await parse(files['nullable.json']), await parse(files['nullable-direct.json'])];
    expect(changesOf(composed, alone)).toEqual(['model-removed!(Pet)']);
    expect(changesOf(alone, composed)).toEqual(['model-added(Pet)']);
    expect(await diffExit(files['nullable.json'], files['nullable-direct.json'])).toBe(2);
    expect(await diffExit(files['nullable-direct.json'], files['nullable.json'])).toBe(1);
    // No copy of `TagOutput` is minted for the field.
    expect(names(composed)).toBe('Tag, TagOutput, TagFinal, Other, Pet, PetOutput');
    expect(warnings()).toEqual([]);
  });

  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('is the document that declares the property once, to `oagen diff`', async () => {
      // With `Pet` declared in both, the two spellings are one API: exit 0 in either direction.
      const once = direct(openapi, nullable(openapi, 'TagOutput'), { pet: nullable(openapi, 'Tag') });
      await expectNoDiff(redeclared(openapi, nullable(openapi, 'Tag'), nullable(openapi, 'TagOutput')), once);
      // And the spelling that conjoined before is the same API as the union spelling.
      await expectNoDiff(
        redeclared(openapi, nullable(openapi, 'Tag'), nullable(openapi, 'TagOutput')),
        redeclared(openapi, typed(openapi, 'Tag'), typed(openapi, 'TagOutput')),
      );
      // A plain `$ref` second declaration: `TagOutput`, without `null`.
      await expectNoDiff(
        redeclared(openapi, nullable(openapi, 'Tag'), ref('TagOutput')),
        direct(openapi, ref('TagOutput'), { pet: nullable(openapi, 'Tag') }),
      );
      // And the other member order of that pair.
      await expectNoDiff(
        redeclared(openapi, ref('Tag'), nullable(openapi, 'TagOutput')),
        direct(openapi, ref('TagOutput')),
      );
    });

    it('admits `null` exactly when both declarations do, in either member order', async () => {
      const [maybe, plain, list] = [
        (name: string) => nullable(openapi, name),
        (name: string) => ref(name),
        (name: string) => typed(openapi, name),
      ];
      const rows: Row[] = [];
      for (const [a, first] of Object.entries({ union: maybe, 'nullable type': list, plain })) {
        for (const [b, second] of Object.entries({ union: maybe, 'nullable type': list, plain })) {
          rows.push([`${a} then ${b}`, first('Tag'), second('TagOutput')]);
        }
      }
      expect(await table(openapi, rows)).toMatchInlineSnapshot(`
        "union then union: TagOutput | null
        union then nullable type: TagOutput | null
        union then plain: TagOutput
        nullable type then union: TagOutput | null
        nullable type then nullable type: TagOutput | null
        nullable type then plain: TagOutput
        plain then union: TagOutput
        plain then nullable type: TagOutput
        plain then plain: TagOutput"
      `);
    });

    it('whichever declaration names the narrower component, and where both name one', async () => {
      const maybe = (name: string) => nullable(openapi, name);
      expect(
        await table(openapi, [
          // The reverse pair: every `TagOutput` is a `Tag`, so `Tag` adds nothing (#733).
          ['TagOutput then Tag, both nullable', maybe('TagOutput'), maybe('Tag')],
          ['TagOutput then Tag, first nullable', maybe('TagOutput'), ref('Tag')],
          ['TagOutput then Tag, second nullable', ref('TagOutput'), maybe('Tag')],
          // One component twice adds nothing: the first declaration, the field `Pet`'s — unless the
          // second rejects the `null` the first admits.
          ['Tag twice, both nullable', maybe('Tag'), maybe('Tag')],
          ['Tag twice, first nullable', maybe('Tag'), ref('Tag')],
          ['Tag twice, second nullable', ref('Tag'), maybe('Tag')],
          // Two components neither of which the other already is: the model of both, as two `$ref`s give.
          ['Tag then Other, both nullable', maybe('Tag'), maybe('Other')],
          ['Tag then Other, first nullable', maybe('Tag'), ref('Other')],
          ['Tag then Other, neither', ref('Tag'), ref('Other')],
        ]),
      ).toMatchInlineSnapshot(`
        "TagOutput then Tag, both nullable: TagOutput | null
        TagOutput then Tag, first nullable: TagOutput
        TagOutput then Tag, second nullable: TagOutput
        Tag twice, both nullable: Tag | null <from=Pet>
        Tag twice, first nullable: Tag
        Tag twice, second nullable: Tag <from=Pet>
        Tag then Other, both nullable: PetOutputTag | null { label?: string, color: string, other?: string }
        Tag then Other, first nullable: PetOutputTag { label?: string, color: string, other?: string }
        Tag then Other, neither: PetOutputTag { label?: string, color: string, other?: string }"
      `);
    });

    it('wherever the override member stands, typed `object` or written beside the `allOf`', async () => {
      const spellings = { narrowedAfter, narrowedBefore, narrowedTyped, narrowedBeside };
      for (const [label, narrowing] of Object.entries(spellings)) {
        const both = redeclared(openapi, nullable(openapi, 'Tag'), nullable(openapi, 'TagOutput'), { narrowing });
        expect(typeOf(fieldOf(await parse(both), 'PetOutput', 'tag')?.type), label).toBe('TagOutput | null');
        const thenPlain = redeclared(openapi, nullable(openapi, 'Tag'), ref('TagOutput'), { narrowing });
        expect(typeOf(fieldOf(await parse(thenPlain), 'PetOutput', 'tag')?.type), label).toBe('TagOutput');
        const plainThen = redeclared(openapi, ref('Tag'), nullable(openapi, 'TagOutput'), { narrowing });
        expect(typeOf(fieldOf(await parse(plainThen), 'PetOutput', 'tag')?.type), label).toBe('TagOutput');
        const once = direct(openapi, nullable(openapi, 'TagOutput'), { pet: nullable(openapi, 'Tag') });
        await expectNoDiff(both, once, label);
      }
    });

    it('with three declarations, the union on any of them', async () => {
      const maybe = (name: string) => nullable(openapi, name);
      const three = async (first: unknown, second: unknown, third: unknown): Promise<string> =>
        tagLine(await parse(redeclared(openapi, first, second, { more: [third] })));
      expect(await three(maybe('Tag'), maybe('TagOutput'), maybe('TagFinal'))).toBe('TagFinal | null');
      expect(await three(maybe('TagFinal'), maybe('Tag'), maybe('TagOutput'))).toBe('TagFinal | null');
      expect(await three(maybe('Tag'), typed(openapi, 'TagOutput'), maybe('TagFinal'))).toBe('TagFinal | null');
      // One declaration that rejects `null`, wherever it stands, and the field admits none.
      expect(await three(maybe('Tag'), maybe('TagOutput'), ref('TagFinal'))).toBe('TagFinal');
      expect(await three(maybe('Tag'), ref('TagOutput'), maybe('TagFinal'))).toBe('TagFinal');
      expect(await three(ref('Tag'), maybe('TagOutput'), maybe('TagFinal'))).toBe('TagFinal');
    });
  });

  it('in every spelling of the wrapper the readers strip, on either side (OAS 3.1.0)', async () => {
    const spellings: Record<string, (name: string) => unknown> = {
      '`anyOf` with `{ type: null }`': anyOfNull,
      '`oneOf` with `{ type: null }`': oneOfNull,
      'the `null` variant first': (name) => ({ anyOf: [nul, ref(name)] }),
      '`{ enum: [null] }`': (name) => ({ anyOf: [ref(name), { enum: [null] }] }),
      '`{ const: null }`': (name) => ({ oneOf: [ref(name), { const: null }] }),
      '`{ type: [null] }`': (name) => ({ anyOf: [ref(name), { type: ['null'] }] }),
      'two `null` variants': (name) => ({ anyOf: [ref(name), nul, { const: null }] }),
      'around an `allOf` of the `$ref`': (name) => ({ anyOf: [all(ref(name)), nul] }),
      'around a wrapper': (name) => ({ anyOf: [oneOfNull(name), nul] }),
      'around a nullable `type`': (name) => ({ anyOf: [typeList(name), nul] }),
      'beside a nullable `type`': (name) => ({ type: ['object', 'null'], ...anyOfNull(name) }),
      'beside `type: object`': (name) => ({ type: 'object', ...anyOfNull(name) }),
    };
    for (const [a, first] of Object.entries(spellings)) {
      // As the one declaration of the property, each spelling is `TagOutput | null`.
      expect(script(await parse(direct('3.1.0', first('TagOutput')))), a).toBe('name?: string, tag?: TagOutput | null');
      for (const [b, second] of Object.entries(spellings)) {
        const label = `${a}, then ${b}`;
        const both = await parse(redeclared('3.1.0', first('Tag'), second('TagOutput')));
        expect(script(both), label).toBe('name?: string, tag?: TagOutput | null');
        expect(names(both), label).toBe('Tag, TagOutput, TagFinal, Other, Pet, PetOutput');
      }
      // Beside a plain `$ref`, in either order, the field admits no `null`.
      expect(script(await parse(redeclared('3.1.0', first('Tag'), ref('TagOutput')))), a).toBe(
        'name?: string, tag?: TagOutput',
      );
      expect(script(await parse(redeclared('3.1.0', ref('Tag'), first('TagOutput')))), a).toBe(
        'name?: string, tag?: TagOutput',
      );
    }
    expect(warnings()).toEqual([]);
  });

  it('in the spellings of OAS 3.0.3, as far as each is a nullable wrapper', async () => {
    const maybe = flagged;
    expect(
      await table('3.0.3', [
        // `nullable: true` beside the union stands for its `null` variant (#677).
        ['`anyOf` + `nullable`, twice', maybe('Tag'), maybe('TagOutput')],
        [
          '`oneOf` + `nullable`, twice',
          { oneOf: [ref('Tag')], nullable: true },
          { oneOf: [ref('TagOutput')], nullable: true },
        ],
        ['around an `allOf` of the `$ref`', { anyOf: [all(ref('Tag'))], nullable: true }, maybe('TagOutput')],
        ['beside the `type` + `nullable` spelling', maybe('Tag'), typed('3.0.3', 'TagOutput')],
        ['the `type` + `nullable` spelling first', typed('3.0.3', 'Tag'), maybe('TagOutput')],
        ['then a plain `$ref`', maybe('Tag'), ref('TagOutput')],
        ['a plain `$ref` first', ref('Tag'), maybe('TagOutput')],
        // `nullable: true` beside an `allOf`, with no `type`, declares nothing, here as on one declaration.
        [
          '`allOf` + `nullable`, no `type`, twice',
          { ...all(ref('Tag')), nullable: true },
          { ...all(ref('TagOutput')), nullable: true },
        ],
        ['the union beside `allOf` + `nullable`', maybe('Tag'), { ...all(ref('TagOutput')), nullable: true }],
        // A variant that only says `nullable: true` is a second variant, and the union no wrapper.
        [
          'a `{ nullable: true }` variant',
          { anyOf: [ref('Tag'), { nullable: true }] },
          { anyOf: [ref('TagOutput'), { nullable: true }] },
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "\`anyOf\` + \`nullable\`, twice: TagOutput | null
      \`oneOf\` + \`nullable\`, twice: TagOutput | null
      around an \`allOf\` of the \`$ref\`: TagOutput | null
      beside the \`type\` + \`nullable\` spelling: TagOutput | null
      the \`type\` + \`nullable\` spelling first: TagOutput | null
      then a plain \`$ref\`: TagOutput
      a plain \`$ref\` first: TagOutput
      \`allOf\` + \`nullable\`, no \`type\`, twice: TagOutput
      the union beside \`allOf\` + \`nullable\`: TagOutput
      a \`{ nullable: true }\` variant: (Tag | unknown) <from=Pet>"
    `);
  });

  it('whatever the wrapper wraps: a `$ref`, an `allOf` of one, an inline object, or one of each', async () => {
    const inlineA = { type: 'object', properties: { a: string }, required: ['a'] };
    const inlineB = { type: 'object', properties: { b: { type: 'integer' } } };
    const wrap = (schema: unknown) => ({ anyOf: [schema, nul] });
    const pairs: Record<string, readonly [unknown, unknown]> = {
      'a `$ref`, an `allOf` of one': [ref('Tag'), all(ref('TagOutput'))],
      'an `allOf` of one, a `$ref`': [all(ref('Tag')), ref('TagOutput')],
      'two inline objects': [inlineA, inlineB],
      'an inline object, a `$ref`': [inlineA, ref('TagOutput')],
      'a `$ref`, an inline object': [ref('Tag'), inlineB],
      'an `allOf` of one, an inline object': [all(ref('Tag')), inlineB],
      'an `allOf` of two, a `$ref`': [all(ref('Tag'), ref('Other')), ref('TagOutput')],
    };
    const rows: Row[] = [];
    for (const [label, [a, b]] of Object.entries(pairs)) {
      rows.push([`${label}: both nullable`, wrap(a), wrap(b)]);
      rows.push([`${label}: first nullable`, wrap(a), b]);
      rows.push([`${label}: second nullable`, a, wrap(b)]);
      rows.push([`${label}: neither`, a, b]);
    }
    expect(await table('3.1.0', rows)).toMatchInlineSnapshot(`
      "a \`$ref\`, an \`allOf\` of one: both nullable: TagOutput | null
      a \`$ref\`, an \`allOf\` of one: first nullable: TagOutput
      a \`$ref\`, an \`allOf\` of one: second nullable: TagOutput
      a \`$ref\`, an \`allOf\` of one: neither: TagOutput
      an \`allOf\` of one, a \`$ref\`: both nullable: TagOutput | null
      an \`allOf\` of one, a \`$ref\`: first nullable: TagOutput
      an \`allOf\` of one, a \`$ref\`: second nullable: TagOutput
      an \`allOf\` of one, a \`$ref\`: neither: TagOutput
      two inline objects: both nullable: PetOutputTag | null { a: string, b?: integer }
      two inline objects: first nullable: PetOutputTag { a: string, b?: integer }
      two inline objects: second nullable: PetOutputTag { a: string, b?: integer }
      two inline objects: neither: PetOutputTag { a: string, b?: integer }
      an inline object, a \`$ref\`: both nullable: PetOutputTag | null { a: string, label: string, color: string }
      an inline object, a \`$ref\`: first nullable: PetOutputTag { a: string, label: string, color: string }
      an inline object, a \`$ref\`: second nullable: PetOutputTag { a: string, label: string, color: string }
      an inline object, a \`$ref\`: neither: PetOutputTag { a: string, label: string, color: string }
      a \`$ref\`, an inline object: both nullable: PetOutputTag | null { label?: string, color: string, b?: integer }
      a \`$ref\`, an inline object: first nullable: PetOutputTag { label?: string, color: string, b?: integer }
      a \`$ref\`, an inline object: second nullable: PetOutputTag { label?: string, color: string, b?: integer }
      a \`$ref\`, an inline object: neither: PetOutputTag { label?: string, color: string, b?: integer }
      an \`allOf\` of one, an inline object: both nullable: PetOutputTag | null { label?: string, color: string, b?: integer }
      an \`allOf\` of one, an inline object: first nullable: PetOutputTag { label?: string, color: string, b?: integer }
      an \`allOf\` of one, an inline object: second nullable: PetOutputTag { label?: string, color: string, b?: integer }
      an \`allOf\` of one, an inline object: neither: PetOutputTag { label?: string, color: string, b?: integer }
      an \`allOf\` of two, a \`$ref\`: both nullable: PetOutputTag | null { label: string, color: string, other?: string }
      an \`allOf\` of two, a \`$ref\`: first nullable: PetOutputTag { label: string, color: string, other?: string }
      an \`allOf\` of two, a \`$ref\`: second nullable: PetOutputTag { label: string, color: string, other?: string }
      an \`allOf\` of two, a \`$ref\`: neither: PetOutputTag { label: string, color: string, other?: string }"
    `);
  });

  it('inside array items, on both sides', async () => {
    const items = (schema: unknown) => ({ type: 'array', items: schema });
    expect(
      await table('3.1.0', [
        ['items a union on both', items(anyOfNull('Tag')), items(anyOfNull('TagOutput'))],
        ['items a union, then plain', items(anyOfNull('Tag')), items(ref('TagOutput'))],
        ['items plain, then a union', items(ref('Tag')), items(anyOfNull('TagOutput'))],
        ['items a union, then a nullable `type`', items(anyOfNull('Tag')), items(typeList('TagOutput'))],
        [
          'under nullable arrays',
          { anyOf: [items(anyOfNull('Tag')), nul] },
          { anyOf: [items(anyOfNull('TagOutput')), nul] },
        ],
        ['items of items', items(items(anyOfNull('Tag'))), items(items(anyOfNull('TagOutput')))],
      ]),
    ).toMatchInlineSnapshot(`
      "items a union on both: (TagOutput | null)[]
      items a union, then plain: TagOutput[]
      items plain, then a union: TagOutput[]
      items a union, then a nullable \`type\`: (TagOutput | null)[]
      under nullable arrays: (TagOutput | null)[] | null
      items of items: (TagOutput | null)[][]"
    `);
  });

  it('a union of two or more variants that are not `null` is no wrapper, and keeps the first as before', async () => {
    const two = (a: string, b: string) => ({ anyOf: [ref(a), ref(b), nul] });
    const schemas = {
      ...tags,
      Name: string,
      Kind: { type: 'string', enum: ['a', 'b'] },
      Tags: { type: 'array', items: ref('Tag') },
    };
    expect(
      await table('3.1.0', [
        ['two variants on both', two('Tag', 'Other'), two('TagOutput', 'Other')],
        ['two variants, then a wrapper', two('Tag', 'Other'), anyOfNull('TagOutput')],
        ['a wrapper, then two variants', anyOfNull('Tag'), two('TagOutput', 'Other')],
        // A union of one variant and no `null` is the union of one the type builder keeps (#445).
        ['a union of one on both', { anyOf: [ref('Tag')] }, { anyOf: [ref('TagOutput')] }],
        ['a union of one, then a wrapper', { anyOf: [ref('Tag')] }, anyOfNull('TagOutput')],
        // A wrapper around what is no object describes none.
        ['a wrapper around a string, twice', anyOfNull('Name'), anyOfNull('Name'), schemas],
        ['around an enum, then around an object', anyOfNull('Kind'), anyOfNull('Tag'), schemas],
        ['around an object, then around an array', anyOfNull('Tag'), anyOfNull('Tags'), schemas],
        ['a wrapper, then a string', anyOfNull('Tag'), string],
        ['a string, then a wrapper', string, anyOfNull('Tag')],
        // A declaration that declares no type only annotates the wrapper, as before.
        ['a wrapper, then a description', anyOfNull('Tag'), { description: 'The tag.' }],
        ['a description, then a wrapper', { description: 'The tag.' }, anyOfNull('TagOutput')],
      ]),
    ).toMatchInlineSnapshot(`
      "two variants on both: (Tag | Other) | null <from=Pet>
      two variants, then a wrapper: (Tag | Other) | null <from=Pet>
      a wrapper, then two variants: Tag | null <from=Pet>
      a union of one on both: (Tag) <from=Pet>
      a union of one, then a wrapper: (Tag) <from=Pet>
      a wrapper around a string, twice: string | null <from=Pet>
      around an enum, then around an object: Kind | null <from=Pet>
      around an object, then around an array: Tag | null <from=Pet>
      a wrapper, then a string: Tag | null <from=Pet>
      a string, then a wrapper: string <from=Pet>
      a wrapper, then a description: Tag | null <description="The tag.">
      a description, then a wrapper: TagOutput | null <description="The tag.">"
    `);
  });

  it('a `$ref` to a component that is a nullable union names that union, as before', async () => {
    const schemas = { ...tags, MaybeTag: anyOfNull('Tag'), MaybeTagOutput: anyOfNull('TagOutput') };
    expect(
      await table('3.1.0', [
        ['two `$ref`s to nullable unions', ref('MaybeTag'), ref('MaybeTagOutput'), schemas],
        ['a wrapper, then a `$ref` to one', anyOfNull('Tag'), ref('MaybeTagOutput'), schemas],
        ['a `$ref` to one, then a wrapper', ref('MaybeTag'), anyOfNull('TagOutput'), schemas],
      ]),
    ).toMatchInlineSnapshot(`
      "two \`$ref\`s to nullable unions: MaybeTag | null <from=Pet>
      a wrapper, then a \`$ref\` to one: Tag | null <from=Pet>
      a \`$ref\` to one, then a wrapper: MaybeTag | null <from=Pet>"
    `);
  });
});

describe('#743 the union spelling reads as the type-list spelling of the same pair', () => {
  /** What the other declaration of the property may be. */
  const partners: Record<string, unknown> = {
    'a `$ref`': ref('TagOutput'),
    'a `$ref` to the same component': ref('Tag'),
    'a `$ref` to another component': ref('Other'),
    'an `allOf` of one': all(ref('TagOutput')),
    'an `allOf` of two': all(ref('TagOutput'), ref('Other')),
    'a nullable `type` beside an `allOf`': typeList('TagOutput'),
    'the union spelling': anyOfNull('TagOutput'),
    'an inline object': { type: 'object', properties: { extra: string } },
    'a nullable inline object': { type: ['object', 'null'], properties: { extra: string } },
    'a union of two variants': { anyOf: [ref('TagOutput'), ref('Other'), nul] },
    'a string': string,
    'an array': { type: 'array', items: ref('TagOutput') },
    'a description': { description: 'The tag.' },
    'a boolean schema': true,
  };
  /** The wrapper's own keywords: text, a flag and a limit. */
  const beside = { description: 'A tag, or none.', readOnly: true, minProperties: 1, 'x-audience': 'internal' };

  it('beside every kind of declaration, in either member order: one IR for both spellings', async () => {
    for (const [label, partner] of Object.entries(partners)) {
      for (const keywords of [{}, beside]) {
        const [union, list] = [
          { ...keywords, ...anyOfNull('Tag') },
          { ...keywords, ...typeList('Tag') },
        ];
        const where = `${label}${keywords === beside ? ', with keywords on the declaration' : ''}`;
        expect(await parse(redeclared('3.1.0', union, partner)), `${where}, declared first`).toEqual(
          await parse(redeclared('3.1.0', list, partner)),
        );
        expect(await parse(redeclared('3.1.0', partner, union)), `${where}, declared second`).toEqual(
          await parse(redeclared('3.1.0', partner, list)),
        );
      }
    }
  });
});

describe('#743 what is written on the wrapper, beside its union and under it', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('rides on the conjunction: text, flags and limits of both declarations, the later’s over the earlier’s', async () => {
      const first = { description: 'A tag, or none.', minProperties: 1, 'x-first': 1, ...nullable(openapi, 'Tag') };
      const second = {
        description: 'A tag with a label.',
        readOnly: true,
        'x-second': 2,
        ...nullable(openapi, 'TagOutput'),
      };
      expect(
        await table(openapi, [
          ['both', first, second],
          ['reversed', second, first],
          ['the wrapper first, a plain `$ref` second', first, ref('TagOutput')],
          ['a plain `$ref` first, the wrapper second', ref('Tag'), second],
          [
            'a deprecated wrapper second',
            nullable(openapi, 'Tag'),
            { deprecated: true, ...nullable(openapi, 'TagOutput') },
          ],
        ]),
      ).toMatchInlineSnapshot(`
        "both: TagOutput | null <description="A tag with a label." readOnly=true constraints={"minProperties":1} extensions={"x-first":1,"x-second":2}>
        reversed: TagOutput | null <description="A tag, or none." readOnly=true constraints={"minProperties":1} extensions={"x-second":2,"x-first":1}>
        the wrapper first, a plain \`$ref\` second: TagOutput <description="A tag, or none." constraints={"minProperties":1} extensions={"x-first":1}>
        a plain \`$ref\` first, the wrapper second: TagOutput <description="A tag with a label." readOnly=true extensions={"x-second":2}>
        a deprecated wrapper second: TagOutput | null <deprecated=true>"
      `);
    });

    it('keeps the limits a field reads through the wrapper, and no text or flag of the variant', async () => {
      const wrap = (variant: unknown) =>
        openapi === '3.0.3' ? { anyOf: [variant], nullable: true } : { anyOf: [variant, nul] };
      const limited = { ...all(ref('Tag')), description: 'The variant.', deprecated: true, minProperties: 2 };
      // As the one declaration of the property: the limit, and neither the text nor the flag.
      expect(tagLine(await parse(direct(openapi, wrap(limited))))).toBe('Tag | null <constraints={"minProperties":2}>');
      expect(
        await table(openapi, [
          ['a limited `allOf` variant, then a `$ref`', wrap(limited), ref('TagOutput')],
          ['a `$ref`, then a limited `allOf` variant', ref('TagOutput'), wrap(limited)],
          [
            'the stricter of two limits',
            { minProperties: 1, ...(wrap(limited) as Doc) },
            { maxProperties: 9, ...(wrap(all(ref('TagOutput'))) as Doc) },
          ],
          [
            'a wrapper under a wrapper, limited',
            wrap({ ...(wrap(ref('Tag')) as Doc), minProperties: 3, deprecated: true }),
            ref('TagOutput'),
          ],
          // A limit written beside a `$ref` variant is no limit of the wrapper's field (the `$ref` is the
          // variant); in the conjunction the variant is a member of an `allOf`, where one written beside
          // a `$ref` is read, as `{ allOf: [{ $ref: Tag, minProperties: 5 }] }` written by hand is.
          ['a limit beside a `$ref` variant', wrap(ref('Tag', { minProperties: 5 })), ref('TagOutput')],
          // An `allOf` beside the union only annotates or limits the schema (#613), and stays a member.
          [
            'an annotating `allOf` beside the union',
            { ...all({ description: 'Annotated.', minProperties: 4 }), ...(wrap(ref('Tag')) as Doc) },
            wrap(ref('TagOutput')),
          ],
        ]),
      ).toMatchInlineSnapshot(`
        "a limited \`allOf\` variant, then a \`$ref\`: TagOutput <constraints={"minProperties":2}>
        a \`$ref\`, then a limited \`allOf\` variant: TagOutput <constraints={"minProperties":2}>
        the stricter of two limits: TagOutput | null <constraints={"minProperties":2,"maxProperties":9}>
        a wrapper under a wrapper, limited: TagOutput <constraints={"minProperties":3}>
        a limit beside a \`$ref\` variant: TagOutput <constraints={"minProperties":5}>
        an annotating \`allOf\` beside the union: TagOutput | null <description="Annotated." constraints={"minProperties":4}>"
      `);
    });
  });
});

describe('#743 a keyword the type builder reads none of beside the union', () => {
  it('is none of the conjunction’s either: the wrapper is `nullable<Tag>` to both, whatever it says', async () => {
    const unread: Doc[] = [
      { required: ['label'] },
      { additionalProperties: false },
      { discriminator: { propertyName: 'kind' } },
      { type: 'string' },
      { title: 'MaybeTag' },
      { not: { type: 'string' } },
    ];
    for (const beside of unread) {
      const label = JSON.stringify(beside);
      // The one declaration of the property, and each of two.
      expect(tagLine(await parse(direct('3.1.0', { ...beside, ...anyOfNull('TagOutput') }))), label).toBe(
        'TagOutput | null',
      );
      expect(
        tagLine(await parse(redeclared('3.1.0', { ...beside, ...anyOfNull('Tag') }, anyOfNull('TagOutput')))),
        label,
      ).toBe('TagOutput | null');
      expect(
        tagLine(await parse(redeclared('3.1.0', anyOfNull('Tag'), { ...beside, ...anyOfNull('TagOutput') }))),
        label,
      ).toBe('TagOutput | null');
    }
  });
});

describe('#743 at every site a property is redeclared', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const Pet = { type: 'object', properties: { name: string, tag: nullable(openapi, 'Tag') } };
    const inline = all(ref('Pet'), { properties: { tag: nullable(openapi, 'TagOutput') } });
    const schemas = { ...tags, Pet };
    const requestBody = (schema: unknown) => ({
      '/pets': {
        post: { operationId: 'createPet', requestBody: json(schema), responses: { '204': { description: 'OK' } } },
      },
    });
    const parameter = (schema: unknown) => ({
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [{ name: 'filter', in: 'query', schema }],
          responses: { '200': { description: 'OK', ...json(ref('Tag')) } },
        },
      },
    });
    const header = (schema: unknown) => ({
      '/pets': {
        get: {
          operationId: 'getPet',
          responses: { '200': { description: 'OK', headers: { 'X-Pet': { schema } }, ...json(ref('Tag')) } },
        },
      },
    });
    const sites: ReadonlyArray<readonly [string, unknown]> = [
      ['a response body', document(openapi, get('/pets', 'getPet', inline), schemas)],
      ['a query parameter', document(openapi, parameter(inline), schemas)],
      ['a response header', document(openapi, header(inline), schemas)],
      [
        'a response body’s items',
        document(openapi, get('/pets', 'listPets', { type: 'array', items: inline }), schemas),
      ],
      ['a request body', document(openapi, requestBody(inline), schemas)],
      [
        'a field of a component',
        document(openapi, get('/holders', 'getHolder', ref('Holder')), {
          ...schemas,
          Holder: { type: 'object', properties: { pet: inline } },
        }),
      ],
      [
        'map values of a field',
        document(openapi, get('/holders', 'getHolder', ref('Holder')), {
          ...schemas,
          Holder: { type: 'object', properties: { pets: { type: 'object', additionalProperties: inline } } },
        }),
      ],
    ];
    /** The one model the document builds from the inline `allOf`: the one beside `Pet` that has a `tag`. */
    const merged = (spec: ApiSpec): Model | undefined =>
      spec.models.find((m) => m.name !== 'Pet' && m.fields.some((f) => f.name === 'tag'));

    it('an inline `allOf` that redeclares it is read as the component that does', async () => {
      const lines: string[] = [];
      for (const [label, doc] of sites) {
        const model = merged(await parse(doc));
        lines.push(`${label}: ${model?.name} { ${fieldsOf(model)} }`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a response body: GetPetResponse { name?: string, tag?: TagOutput | null }
        a query parameter: PetsFilter { name?: string, tag?: TagOutput | null }
        a response header: PetsXPet { name?: string, tag?: TagOutput | null }
        a response body’s items: ListPetsItem { name?: string, tag?: TagOutput | null }
        a request body: CreatePetRequest { name?: string, tag?: TagOutput | null }
        a field of a component: HolderPet { name?: string, tag?: TagOutput | null }
        map values of a field: HolderPets { name?: string, tag?: TagOutput | null }"
      `);
    });

    it('a webhook payload that redeclares it', async () => {
      if (openapi !== '3.1.0') return;
      const webhook = {
        ...document(openapi, {}, schemas),
        webhooks: {
          tagged: {
            post: { operationId: 'onTagged', requestBody: json(inline), responses: { '200': { description: 'OK' } } },
          },
        },
      };
      expect(fieldsOf(merged(await parse(webhook)))).toBe('name?: string, tag?: TagOutput | null');
    });

    it('two levels deep, and a property both an inline object and its redeclaration nest', async () => {
      // `Owner.pet.tag` is redeclared by the member of `OwnerOutput` that redeclares `pet`: two inline
      // objects conjoin their properties, `tag` among them by this same rule.
      const nested = document(openapi, get('/owners', 'getOwner', ref('OwnerOutput')), {
        ...tags,
        Owner: {
          type: 'object',
          properties: { pet: { type: 'object', properties: { tag: nullable(openapi, 'Tag') } } },
        },
        OwnerOutput: all(ref('Owner'), {
          properties: { pet: { type: 'object', properties: { tag: nullable(openapi, 'TagOutput') } } },
        }),
      });
      expect(fieldsOf(modelOf(await parse(nested), 'OwnerOutputPet'))).toBe('tag?: TagOutput | null');
    });

    it('a component that redeclares its own nullable self-reference', async () => {
      // `Node.next` is a `Node` or `null`; `NodeOutput`, which composes `Node`, narrows it to itself.
      const linked = document(openapi, get('/nodes', 'getNode', ref('NodeOutput')), {
        Node: { type: 'object', properties: { id: string, next: nullable(openapi, 'Node') } },
        NodeOutput: all(ref('Node'), { required: ['id'], properties: { next: nullable(openapi, 'NodeOutput') } }),
      });
      const spec = await parse(linked);
      expect(names(spec)).toBe('Node, NodeOutput');
      expect(fieldsOf(modelOf(spec, 'NodeOutput'))).toBe('id: string, next?: NodeOutput | null');
    });
  });
});

describe('#743 whatever order the document is written in', () => {
  it('the composing model before its base, and the narrower component before the wider', async () => {
    const schemas = {
      PetOutput: all({ properties: { tag: anyOfNull('TagOutput') } }, ref('Pet')),
      TagOutput,
      Pet: { type: 'object', properties: { tag: anyOfNull('Tag'), name: string } },
      Tag,
    };
    const spec = await parse(document('3.1.0', get('/pets', 'listPets', ref('PetOutput')), schemas));
    expect(script(spec)).toBe('tag?: TagOutput | null, name?: string');
    expect(names(spec)).toBe('PetOutput, TagOutput, Pet, Tag');
  });
});

describe('#743 a component that extends itself through a field its member redeclares (#566)', () => {
  const int = { type: 'integer' };
  const obj = (properties: Doc) => ({ type: 'object', properties });
  const wrap = (schema: unknown) => ({ oneOf: [schema, nul] });
  const listed = (schema: Doc) => ({ ...schema, type: ['object', 'null'] });
  /** `Note.reply` merges `Note` back into itself, and its inline member redeclares `reply` as `inner`. */
  const selfReply = (inner: unknown) => all(ref('Note'), obj({ quoted: { type: 'boolean' }, reply: inner }));
  const notes = (schemas: Doc) => document('3.1.0', get('/notes', 'getNote', ref('Note')), schemas);
  const summary = (spec: ApiSpec): string[] => spec.models.map((m) => `${m.name} { ${fieldsOf(m)} }`);

  it('ends, with the models the type-list spelling of the same field gives', async () => {
    // The merge under a nullable union, its `reply` redeclared as an inline object: the redeclaration
    // was dropped, so `NoteReply.reply` was `NoteReply | null` and no model had `depth`.
    const union = await parse(notes({ Note: obj({ id: string, reply: wrap(selfReply(obj({ depth: int }))) }) }));
    expect(summary(union)).toMatchInlineSnapshot(`
      [
        "Note { id?: string, reply?: NoteReply | null }",
        "NoteReply { id?: string, reply?: NoteReplyReply, quoted?: boolean }",
        "NoteReplyReply { id?: string, reply?: NoteReplyReply, quoted?: boolean, depth?: integer }",
      ]
    `);
    expect(union).toEqual(
      await parse(notes({ Note: obj({ id: string, reply: listed(selfReply(obj({ depth: int }))) }) })),
    );
    // Both the merge and the redeclaration under a union: `null` at every level, as with type lists.
    const both = await parse(notes({ Note: obj({ id: string, reply: wrap(selfReply(wrap(obj({ depth: int })))) }) }));
    expect(summary(both)).toMatchInlineSnapshot(`
      [
        "Note { id?: string, reply?: NoteReply | null }",
        "NoteReply { id?: string, reply?: NoteReplyReply | null, quoted?: boolean }",
        "NoteReplyReply { id?: string, reply?: NoteReplyReply | null, quoted?: boolean, depth?: integer }",
      ]
    `);
    expect(both).toEqual(
      await parse(notes({ Note: obj({ id: string, reply: listed(selfReply(listed(obj({ depth: int })))) }) })),
    );
    expect(warnings()).toEqual([]);
  });

  it('ends two components that each merge the other under a nullable union and redeclare its field', async () => {
    const mutual = (nullable: (schema: Doc) => unknown) => ({
      Note: obj({
        id: string,
        thread: nullable(all(ref('Thread'), obj({ note: nullable(obj({ depth: int })) }))),
      }),
      Thread: obj({
        title: string,
        note: nullable(all(ref('Note'), obj({ thread: nullable(obj({ pinned: { type: 'boolean' } })) }))),
      }),
    });
    const union = await parse(notes(mutual(wrap)));
    expect(summary(union)).toMatchInlineSnapshot(`
      [
        "Note { id?: string, thread?: NoteThread | null }",
        "Thread { title?: string, note?: ThreadNote | null }",
        "NoteThread { title?: string, note?: NoteThreadNote | null }",
        "NoteThreadNote { id?: string, thread?: NoteThreadNoteThread | null, depth?: integer }",
        "NoteThreadNoteThread { title?: string, note?: NoteThreadNote | null, pinned?: boolean }",
        "ThreadNote { id?: string, thread?: ThreadNoteThread | null }",
        "ThreadNoteThread { title?: string, note?: ThreadNoteThreadNote | null, pinned?: boolean }",
        "ThreadNoteThreadNote { id?: string, thread?: ThreadNoteThread | null, depth?: integer }",
      ]
    `);
    expect(union).toEqual(await parse(notes(mutual(listed))));
  });
});

describe('#743 `bases` and `inheritedFrom` say what the same pair of plain `$ref`s says', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const line = (spec: ApiSpec): string => {
      const model = modelOf(spec, 'PetOutput')!;
      const bases = model.bases?.length ? ` extends ${model.bases.map(typeOf).join(', ')}` : '';
      return `PetOutput${bases} { ${model.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${typeOf(f.type)}${carried(f)}`).join(', ')} }`;
    };
    const maybe = (name: string) => nullable(openapi, name);

    it('the narrowed field is the model’s own, and the base stays a base', async () => {
      const wrapped = [
        line(await parse(redeclared(openapi, maybe('Tag'), maybe('TagOutput')))),
        line(await parse(redeclared(openapi, maybe('Tag'), maybe('TagOutput'), { narrowing: narrowedBefore }))),
        line(await parse(redeclared(openapi, maybe('TagOutput'), maybe('Tag')))),
      ];
      expect(wrapped).toMatchInlineSnapshot(`
        [
          "PetOutput extends Pet { name?: string <from=Pet>, tag?: TagOutput | null }",
          "PetOutput extends Pet { tag?: TagOutput | null, name?: string <from=Pet> }",
          "PetOutput extends Pet { name?: string <from=Pet>, tag?: TagOutput | null }",
        ]
      `);
      // The same three with plain `$ref`s, which conjoined before: the same lines, but for the `null`.
      const plain = [
        line(await parse(redeclared(openapi, ref('Tag'), ref('TagOutput')))),
        line(await parse(redeclared(openapi, ref('Tag'), ref('TagOutput'), { narrowing: narrowedBefore }))),
        line(await parse(redeclared(openapi, ref('TagOutput'), ref('Tag')))),
      ];
      expect(wrapped.map((text) => text.replaceAll(' | null', ''))).toEqual(plain);
    });

    it('a redeclaration that adds nothing leaves the field the base’s', async () => {
      expect(line(await parse(redeclared(openapi, maybe('Tag'), maybe('Tag'))))).toBe(
        'PetOutput extends Pet { name?: string <from=Pet>, tag?: Tag | null <from=Pet> }',
      );
    });
  });
});

describe('#743 where the rule meets #746: a property that is a `$ref` to `false`', () => {
  const schemas = { ...tags, Never: false };

  it('declares nothing, so the other declaration stands alone, a wrapper or not', async () => {
    expect(
      await table('3.1.0', [
        ['a wrapper, then a `$ref` to `false`', anyOfNull('Tag'), ref('Never'), schemas],
        ['a `$ref` to `false`, then a wrapper', ref('Never'), anyOfNull('TagOutput'), schemas],
        // A wrapper around the `$ref` declares the property (#746), and describes no object.
        ['a wrapper around it, then a wrapper', anyOfNull('Never'), anyOfNull('TagOutput'), schemas],
        ['a wrapper, then a wrapper around it', anyOfNull('Tag'), anyOfNull('Never'), schemas],
      ]),
    ).toMatchInlineSnapshot(`
      "a wrapper, then a \`$ref\` to \`false\`: Tag | null <from=Pet>
      a \`$ref\` to \`false\`, then a wrapper: TagOutput | null
      a wrapper around it, then a wrapper: unknown | null <from=Pet>
      a wrapper, then a wrapper around it: Tag | null <from=Pet>"
    `);
  });

  it('is no field of the inline objects two wrappers conjoin', async () => {
    const wrap = (properties: Doc) => ({ anyOf: [{ type: 'object', properties }, nul] });
    expect(
      await table('3.1.0', [
        ['on the first', wrap({ a: string, gone: ref('Never') }), wrap({ b: string }), schemas],
        ['on the second', wrap({ a: string }), wrap({ b: string, gone: ref('Never') }), schemas],
        ['on the first, declared by the second', wrap({ gone: ref('Never') }), wrap({ gone: string }), schemas],
        ['on both', wrap({ a: string, gone: ref('Never') }), wrap({ gone: false }), schemas],
      ]),
    ).toMatchInlineSnapshot(`
      "on the first: PetOutputTag | null { a?: string, b?: string }
      on the second: PetOutputTag | null { a?: string, b?: string }
      on the first, declared by the second: PetOutputTag | null { gone?: string }
      on both: PetOutputTag | null { a?: string }"
    `);
  });
});

describe('#743 `combineDeclarations`: the conjunction it writes for a nullable union', () => {
  const maybe = (name: string): SchemaObject => ({ anyOf: [at(name), { type: 'null' }] });

  it('is the `allOf` of what both wrap, typed nullable exactly when both admit `null`', () => {
    within(tags, () => {
      const [wide, narrow] = [maybe('Tag'), maybe('TagOutput')];
      const both = combineDeclarations(wide, narrow);
      // The parts are the document's own `$ref`s, as the type-list spelling brings them.
      expect(both).toEqual({ allOf: [at('Tag'), at('TagOutput')], type: ['object', 'null'] });
      expect(both.allOf![0]).toBe(wide.anyOf![0]);
      expect(both.allOf![1]).toBe(narrow.anyOf![0]);
      expect(readInlineAllOf(both.allOf!, both)).toBe('reference');
      expect(allOfReferenceMember(both)).toBe(narrow.anyOf![0]);
      expect(schemaToTypeRef(both, 'tag', 'PetOutput')).toEqual({
        kind: 'nullable',
        inner: { kind: 'model', name: 'TagOutput' },
      });
      // The same two declarations combine into the same object throughout the document.
      expect(combineDeclarations(wide, narrow)).toBe(both);

      const plain = at('TagOutput');
      expect(combineDeclarations(wide, plain)).toEqual({ allOf: [at('Tag'), plain], type: 'object' });
      expect(combineDeclarations(at('Tag'), narrow)).toEqual({ allOf: [at('Tag'), at('TagOutput')], type: 'object' });
      const list: SchemaObject = { type: ['object', 'null'], allOf: [at('TagOutput')] };
      expect(combineDeclarations(wide, list)).toEqual({
        allOf: [at('Tag'), at('TagOutput')],
        type: ['object', 'null'],
      });
      expect(combineDeclarations(list, wide)).toEqual({
        allOf: [at('TagOutput'), at('Tag')],
        type: ['object', 'null'],
      });
    });
  });

  it('returns the first declaration itself where the second adds nothing to it', () => {
    within(tags, () => {
      const first = maybe('Tag');
      expect(combineDeclarations(first, maybe('Tag'))).toBe(first);
      expect(combineDeclarations(first, { oneOf: [{ enum: [null] }, at('Tag')] })).toBe(first);
      // Unless the second rejects the `null` the first admits: the conjunction says so.
      expect(combineDeclarations(first, at('Tag'))).toEqual({ allOf: [at('Tag')], type: 'object' });
      // And a second declaration that describes no object keeps the first as written.
      expect(combineDeclarations(first, { type: 'string' })).toBe(first);
      expect(combineDeclarations(first, { anyOf: [at('TagOutput'), at('Other'), { type: 'null' }] })).toBe(first);
      expect(combineDeclarations({ anyOf: [at('Tag'), at('Other')] }, maybe('TagOutput'))).toEqual({
        anyOf: [at('Tag'), at('Other')],
      });
    });
  });

  it('carries each declaration’s keywords, the members beside the union, and the limits under it', () => {
    within(tags, () => {
      const first: SchemaObject = { description: 'First.', minProperties: 1, ...maybe('Tag') };
      const second: SchemaObject = { description: 'Second.', readOnly: true, 'x-flag': true, ...maybe('TagOutput') };
      expect(combineDeclarations(first, second)).toEqual({
        description: 'Second.',
        minProperties: 1,
        readOnly: true,
        'x-flag': true,
        allOf: [at('Tag'), at('TagOutput')],
        type: ['object', 'null'],
      });
      const limited: SchemaObject = {
        allOf: [{ description: 'Annotated.' }],
        anyOf: [
          { allOf: [at('Tag')], description: 'The variant.', deprecated: true, minProperties: 2 },
          { type: 'null' },
        ],
      };
      expect(combineDeclarations(limited, at('TagOutput'))).toEqual({
        allOf: [{ description: 'Annotated.' }, { minProperties: 2 }, at('Tag'), at('TagOutput')],
        type: 'object',
      });
      // A `required` the wrapped `allOf` writes is hoisted, as a bare `allOf`'s is.
      expect(
        combineDeclarations({ anyOf: [{ allOf: [at('Tag')], required: ['label'] }, { type: 'null' }] }, maybe('Other')),
      ).toEqual({ allOf: [at('Tag'), at('Other')], type: ['object', 'null'], required: ['label'] });
    });
  });

  it('leaves a wrapper that writes `properties` beside its union the inline object it is, as before', () => {
    within(tags, () => {
      const beside: SchemaObject = { properties: { extra: { type: 'string' } }, ...maybe('Tag') };
      const conjoined = combineDeclarations(beside, at('TagOutput'));
      expect(conjoined).toEqual({ allOf: [beside, at('TagOutput')], type: 'object' });
      expect(conjoined.allOf![0]).toBe(beside);
    });
  });
});

describe('#743 the pagination walk reads the same conjunction', () => {
  const page = { items: { type: 'array', items: at('Pet') }, has_more: { type: 'boolean' } };
  const map = {
    Pet: { type: 'object', properties: { id: string } },
    Page: { type: 'object', properties: { cursor: string } },
    PageOfPets: all(at('Page'), { properties: page }),
  } as unknown as Record<string, SchemaObject>;
  const maybe = (name: string): SchemaObject => ({ anyOf: [at(name), { type: 'null' }] });
  /** An envelope whose `result` two members declare: a `Page`, then the `PageOfPets` that extends it. */
  const envelope = (first: SchemaObject, second: SchemaObject): SchemaObject => ({
    allOf: [{ properties: { result: first } }, { properties: { result: second } }],
  });

  it('a `dataPath` through a property redeclared as a nullable union resolves under what the second adds', () => {
    within(map as unknown as Doc, () => {
      for (const [label, schema] of [
        ['both nullable', envelope(maybe('Page'), maybe('PageOfPets'))],
        ['first nullable', envelope(maybe('Page'), at('PageOfPets'))],
        ['second nullable', envelope(at('Page'), maybe('PageOfPets'))],
        ['the type-list spelling', envelope({ type: ['object', 'null'], allOf: [at('Page')] }, maybe('PageOfPets'))],
      ] as const) {
        expect(Object.keys(collectObjectProperties(schema, map).properties), label).toEqual(['result']);
        // `result.items` is declared by `PageOfPets` alone: the first declaration kept, it resolved to nothing.
        expect(resolveDataPathArray(schema, 'result.items', map), label).toEqual({ items: page.items.items });
      }
    });
  });
});

describe('#743 a document that parsed still parses', () => {
  /** A value of every kind a document may write where a schema, or a list of schemas, goes. */
  const kinds: ReadonlyArray<readonly [string, unknown]> = [
    ['true', true],
    ['false', false],
    ['null', null],
    ['a number', 5],
    ['a string', 'text'],
    ['an empty list', []],
    ['a list of `null`', [null]],
    ['{}', {}],
    ['a `$ref` that is a number', { $ref: 5 }],
    ['a component that composes itself', ref('LoopA')],
    ['a `$ref` to a boolean schema', ref('Anything')],
  ];
  const schemas = {
    ...tags,
    LoopA: all(ref('LoopB'), { properties: { a: string } }),
    LoopB: all(ref('LoopA'), { properties: { b: string } }),
    Anything: true,
  };
  /** Each position the conjunction now reads inside a declaration that is a wrapper. */
  const positions: ReadonlyArray<readonly [string, (value: unknown) => unknown]> = [
    ['the union', (value) => ({ anyOf: value })],
    ['the variant', (value) => ({ anyOf: [value, nul] })],
    ['a second variant', (value) => ({ anyOf: [ref('TagOutput'), nul, value] })],
    ['the `null` variant', (value) => ({ anyOf: [ref('TagOutput'), value] })],
    ['the `allOf` beside the union', (value) => ({ allOf: value, anyOf: [ref('TagOutput'), nul] })],
    ['a member beside the union', (value) => ({ allOf: [value], anyOf: [ref('TagOutput'), nul] })],
    ['the variant’s `allOf`', (value) => ({ anyOf: [{ allOf: value }, nul] })],
    ['a member of the variant’s `allOf`', (value) => ({ anyOf: [all(ref('TagOutput'), value), nul] })],
    ['the variant’s `properties`', (value) => ({ anyOf: [{ type: 'object', properties: value }, nul] })],
    ['a property of the variant', (value) => ({ anyOf: [{ type: 'object', properties: { a: value } }, nul] })],
    ['the variant of a wrapper under it', (value) => ({ anyOf: [{ oneOf: [value, nul] }, nul] })],
    ['`nullable` beside the union', (value) => ({ anyOf: [ref('TagOutput')], nullable: value })],
    ['`type` beside the union', (value) => ({ type: value, anyOf: [ref('TagOutput'), nul] })],
    ['`required` beside the union', (value) => ({ required: value, anyOf: [ref('TagOutput'), nul] })],
    ['`not` beside the union', (value) => ({ not: value, anyOf: [ref('TagOutput'), nul] })],
    ['`discriminator` beside the union', (value) => ({ discriminator: value, anyOf: [ref('TagOutput'), nul] })],
    [
      '`minProperties` on the variant',
      (value) => ({ anyOf: [{ ...all(ref('TagOutput')), minProperties: value }, nul] }),
    ],
  ];

  it('with any value at any position of a wrapper declared second, which the conjunction never read before', async () => {
    const lines: string[] = [];
    for (const [position, at_] of positions) {
      /** The kinds of value by what `PetOutput.tag` is with one there: after a plain `$ref`, and after a wrapper. */
      const outcomes = new Map<string, string[]>();
      for (const [kind, value] of kinds) {
        const read: string[] = [];
        for (const first of [ref('Tag'), anyOfNull('Tag')]) {
          const spec = await parse(redeclared('3.1.0', first, at_(value), { schemas })).catch((error: Error) => error);
          read.push(spec instanceof Error ? 'fails' : typeOf(fieldOf(spec, 'PetOutput', 'tag')?.type));
        }
        const outcome = read.join(' / ');
        outcomes.set(outcome, [...(outcomes.get(outcome) ?? []), kind]);
      }
      lines.push(`${position}:`, ...[...outcomes].map(([outcome, among]) => `  ${outcome}: ${among.join(', ')}`));
    }
    // `fails / fails` is a document that failed before too: a walker that reads every schema of the
    // document met the value first. Every other row parsed with the wrapper dropped unread, and parses
    // now — conjoined where the wrapper is one a reader can read at every depth, else the first, as it was.
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "the union:
        Tag / Tag | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      the variant:
        Tag / Tag | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        PetOutputTag / PetOutputTag | null: a component that composes itself
      a second variant:
        Tag / Tag | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      the \`null\` variant:
        Tag / Tag | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      the \`allOf\` beside the union:
        fails / fails: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        TagOutput / TagOutput | null: an empty list
      a member beside the union:
        TagOutput / TagOutput | null: true, false, a number, a string, an empty list, a list of \`null\`, {}
        fails / fails: null
        Tag / Tag | null: a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        PetOutputTag / PetOutputTag: a component that composes itself
      the variant’s \`allOf\`:
        fails / fails: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        Tag / Tag | null: an empty list
      a member of the variant’s \`allOf\`:
        TagOutput / TagOutput | null: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` to a boolean schema
        fails / fails: null
        PetOutputTag / PetOutputTag | null: a \`$ref\` that is a number, a component that composes itself
      the variant’s \`properties\`:
        Tag / Tag | null: true, false, a number, a string, an empty list, a list of \`null\`
        fails / fails: null
        PetOutputTag / PetOutputTag | null: {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      a property of the variant:
        PetOutputTag / PetOutputTag | null: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        Tag / Tag | null: null
      the variant of a wrapper under it:
        Tag / Tag | null: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        fails / fails: null
        PetOutputTag / PetOutputTag | null: a component that composes itself
      \`nullable\` beside the union:
        TagOutput / TagOutput | null: true
        Tag / Tag | null: false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`type\` beside the union:
        TagOutput / TagOutput | null: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        Tag / Tag | null: an empty list
      \`required\` beside the union:
        Tag / Tag | null: true, false, null, a number, a string, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        TagOutput / TagOutput | null: an empty list, a list of \`null\`
      \`not\` beside the union:
        TagOutput / TagOutput | null: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        Tag / Tag | null: null
      \`discriminator\` beside the union:
        Tag / Tag | null: true, false, a number, a string, an empty list, a list of \`null\`
        fails / fails: null
        TagOutput / TagOutput | null: {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`minProperties\` on the variant:
        TagOutput / TagOutput | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema"
    `);
  });
});
