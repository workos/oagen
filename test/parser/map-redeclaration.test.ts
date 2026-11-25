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
  mapSchemaOf,
  schemaToTypeRef,
  type SchemaObject,
} from '../../src/parser/schemas.js';
import { combineDeclarations } from '../../src/parser/inline-models.js';
import { collectObjectProperties } from '../../src/parser/pagination.js';
import type { ApiSpec, Field, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #744: two `allOf` members that declare one property are conjoined
 * (#653), and two arrays conjoin their `items`, so `tags: { type: 'array',
 * items: { $ref: Tag } }` redeclared with `items: { $ref: TagOutput }` is
 * a `TagOutput[]`. Two maps were not conjoined: neither an inline object
 * with `properties` nor a `$ref` that composes one, a map fell through
 * every step, the pair kept the first declaration, and a map redeclared
 * with narrower values kept the wider ones. Two maps now conjoin their
 * values as two arrays conjoin their `items`.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-744-'));
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

/** The issue's `Tag { label?, color }` and `TagOutput`, which composes it and requires `label`. */
const Tag = { type: 'object', properties: { label: string, color: string }, required: ['color'] };
const TagOutput = all(ref('Tag'), { required: ['label'] });
const Other = { type: 'object', properties: { other: string } };
const tags = { Tag, TagOutput, Other };

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

/** A map by `additionalProperties`, as the issue writes it, and by `patternProperties`. */
const map = (values: unknown, beside: Doc = {}) => ({ type: 'object', additionalProperties: values, ...beside });
const pattern = (values: unknown, key = '^x-') => ({ type: 'object', patternProperties: { [key]: values } });
const array = (items: unknown) => ({ type: 'array', items });

/** How `PetOutput` redeclares the `tags` it inherits from `Pet`: the override member after the base, as the issue writes it, or another way. */
type Narrowing = (base: string, tags: unknown) => unknown;
const narrowedAfter: Narrowing = (base, value) => all(ref(base), { properties: { tags: value } });
const narrowedBefore: Narrowing = (base, value) => all({ properties: { tags: value } }, ref(base));
const narrowedTyped: Narrowing = (base, value) => all(ref(base), { type: 'object', properties: { tags: value } });
const narrowedBeside: Narrowing = (base, value) => ({ ...all(ref(base)), properties: { tags: value } });

/** The issue's documents: `Pet.tags` declared `first`, and `PetOutput`, which composes `Pet`, redeclaring it `second` (and then each of `more`). */
const redeclared = (
  openapi: Version,
  first: unknown,
  second: unknown,
  { narrowing = narrowedAfter, schemas = tags as Doc, more = [] as unknown[] } = {},
) =>
  document(openapi, get('/pets', 'listPets', ref('PetOutput')), {
    ...schemas,
    Pet: { type: 'object', properties: { name: string, tags: first } },
    PetOutput:
      more.length === 0
        ? narrowing('Pet', second)
        : all(ref('Pet'), { properties: { tags: second } }, ...more.map((value) => ({ properties: { tags: value } }))),
  });
/**
 * The issue's `map-direct.json`: `PetOutput` declaring its properties
 * itself — `alone`, as the issue writes it, or beside the `Pet` it no
 * longer composes, whose own `tags` is `pet`.
 */
const direct = (
  openapi: Version,
  value: unknown,
  { alone = false, pet = map(ref('Tag')) as unknown, schemas = tags as Doc } = {},
) =>
  document(openapi, get('/pets', 'listPets', ref('PetOutput')), {
    ...schemas,
    ...(alone ? {} : { Pet: { type: 'object', properties: { name: string, tags: pet } } }),
    PetOutput: { type: 'object', properties: { name: string, tags: value } },
  });

/** A type as the issue's script prints it: `Record<string, TagOutput>`, `TagOutput[]`, with `| null` where nullable. */
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
  const words = Object.entries({
    description,
    deprecated,
    readOnly,
    writeOnly,
    default: field.default,
    constraints,
    extensions,
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  if (inheritedFrom) words.push(`from=${typeOf(inheritedFrom)}`);
  return words.length > 0 ? ` <${words.join(' ')}>` : '';
};
/**
 * `PetOutput.tags`: its type and what the field carries, with the fields
 * of each model minted under the field (`PetOutputTag…`), which the
 * document builds exactly when the field names one.
 */
const tagsLine = (spec: ApiSpec): string => {
  const field = fieldOf(spec, 'PetOutput', 'tags');
  const minted = spec.models.filter((m) => m.name.startsWith('PetOutputTag'));
  const type = typeOf(field?.type);
  for (const model of minted)
    expect(type, 'a model minted under the field is one the field names').toContain(model.name);
  return `${type}${minted.map((m) => ` ${m.name} { ${fieldsOf(m)} }`).join('')}${carried(field)}`;
};
type Row = readonly [label: string, first: unknown, second: unknown, schemas?: Doc];
/** One line per row: `PetOutput.tags` with `Pet.tags` declared `first` and the override member declaring `second`. */
const table = async (openapi: Version, rows: readonly Row[]): Promise<string> => {
  const lines: string[] = [];
  for (const [label, first, second, schemas] of rows) {
    lines.push(`${label}: ${tagsLine(await parse(redeclared(openapi, first, second, { schemas })))}`);
  }
  return lines.join('\n');
};
/** The same, with each pair in both member orders on one line: `first then second / second then first`. */
const bothOrders = async (openapi: Version, rows: readonly Row[]): Promise<string> => {
  const lines: string[] = [];
  for (const [label, first, second, schemas] of rows) {
    const forth = tagsLine(await parse(redeclared(openapi, first, second, { schemas })));
    const back = tagsLine(await parse(redeclared(openapi, second, first, { schemas })));
    lines.push(`${label}: ${forth} / ${back}`);
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
const mapOf = (values: unknown, beside: Doc = {}): SchemaObject => map(values, beside) as SchemaObject;

describe('#744 a map property redeclared with narrower values', () => {
  it('the issue’s documents, and its script’s output', async () => {
    const files: Record<string, unknown> = {
      'map.json': redeclared('3.1.0', map(ref('Tag')), map(ref('TagOutput'))),
      'pattern.json': redeclared('3.1.0', pattern(ref('Tag')), pattern(ref('TagOutput'))),
      'array.json': redeclared('3.1.0', array(ref('Tag')), array(ref('TagOutput'))),
      'map-direct.json': direct('3.1.0', map(ref('TagOutput')), { alone: true }),
    };
    const lines: string[] = [];
    for (const [name, doc] of Object.entries(files)) lines.push(`${name}: ${script(await parse(doc))}`);
    // The first two were `tags?: Record<string, Tag>`.
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "map.json: name?: string, tags?: Record<string, TagOutput>
      pattern.json: name?: string, tags?: Record<string, TagOutput>
      array.json: name?: string, tags?: TagOutput[]
      map-direct.json: name?: string, tags?: Record<string, TagOutput>"
    `);

    // `oagen diff --old map.json --new map-direct.json` reported a breaking `field-type-changed` on
    // `tags`. Nothing is reported for `tags` now, in either direction: what is left is `Pet`, which
    // `map-direct.json` does not declare.
    const [composed, alone] = [await parse(files['map.json']), await parse(files['map-direct.json'])];
    expect(changesOf(composed, alone)).toEqual(['model-removed!(Pet)']);
    expect(changesOf(alone, composed)).toEqual(['model-added(Pet)']);
    expect(await diffExit(files['map.json'], files['map-direct.json'])).toBe(2);
    expect(await diffExit(files['map-direct.json'], files['map.json'])).toBe(1);
    // No model is minted for the values.
    expect(names(composed)).toBe('Tag, TagOutput, Other, Pet, PetOutput');
    expect(warnings()).toEqual([]);
  });

  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    /** A nullable map of `name` in the version's own words. */
    const nullable = (name: string) =>
      openapi === '3.0.3' ? map(ref(name), { nullable: true }) : map(ref(name), { type: ['object', 'null'] });
    /** The union spelling of the same: OAS 3.0 has no `null` type, and `nullable: true` beside the union stands for the variant. */
    const union = (name: string) =>
      openapi === '3.0.3' ? { anyOf: [map(ref(name))], nullable: true } : { anyOf: [map(ref(name)), nul] };

    it('is the document that declares the property once, to `oagen diff`', async () => {
      // With `Pet` declared in both, the two spellings are one API: exit 0 in either direction.
      const once = direct(openapi, map(ref('TagOutput')));
      await expectNoDiff(redeclared(openapi, map(ref('Tag')), map(ref('TagOutput'))), once);
      // The `patternProperties` spelling of the pair, and one keyword each, are the same API.
      const patterned = { pet: pattern(ref('Tag')) };
      await expectNoDiff(
        redeclared(openapi, pattern(ref('Tag')), pattern(ref('TagOutput'))),
        direct(openapi, pattern(ref('TagOutput')), patterned),
      );
      await expectNoDiff(redeclared(openapi, map(ref('Tag')), pattern(ref('TagOutput'))), once);
      await expectNoDiff(
        redeclared(openapi, pattern(ref('Tag')), map(ref('TagOutput'))),
        direct(openapi, map(ref('TagOutput')), patterned),
      );
      // Two nullable maps are the nullable map declared once, in either spelling.
      await expectNoDiff(
        redeclared(openapi, nullable('Tag'), nullable('TagOutput')),
        direct(openapi, nullable('TagOutput'), { pet: nullable('Tag') }),
      );
      await expectNoDiff(
        redeclared(openapi, union('Tag'), union('TagOutput')),
        redeclared(openapi, nullable('Tag'), nullable('TagOutput')),
      );
    });

    it('wherever the override member stands, and for the reverse pair', async () => {
      const spellings = { narrowedAfter, narrowedBefore, narrowedTyped, narrowedBeside };
      for (const [label, narrowing] of Object.entries(spellings)) {
        const narrower = redeclared(openapi, map(ref('Tag')), map(ref('TagOutput')), { narrowing });
        expect(tagsLine(await parse(narrower)), label).toBe('Record<string, TagOutput>');
        await expectNoDiff(narrower, direct(openapi, map(ref('TagOutput'))), label);
        // The reverse pair: every `TagOutput` is a `Tag`, so `Tag` adds nothing to the values (#733).
        const wider = redeclared(openapi, map(ref('TagOutput')), map(ref('Tag')), { narrowing });
        expect(tagsLine(await parse(wider)), label).toBe('Record<string, TagOutput>');
      }
    });

    it('admits `null` exactly when both declarations do, in either member order', async () => {
      const plain = (name: string) => map(ref(name));
      const wrapped = (name: string) => all(nullable(name));
      const rows: Row[] = [];
      const spellings = { 'nullable type': nullable, union, 'allOf of nullable': wrapped, plain };
      for (const [a, first] of Object.entries(spellings)) {
        for (const [b, second] of Object.entries(spellings)) {
          rows.push([`${a} then ${b}`, first('Tag'), second('TagOutput')]);
        }
      }
      expect(await table(openapi, rows)).toMatchInlineSnapshot(`
        "nullable type then nullable type: Record<string, TagOutput> | null
        nullable type then union: Record<string, TagOutput> | null
        nullable type then allOf of nullable: Record<string, TagOutput> | null
        nullable type then plain: Record<string, TagOutput>
        union then nullable type: Record<string, TagOutput> | null
        union then union: Record<string, TagOutput> | null
        union then allOf of nullable: Record<string, TagOutput> | null
        union then plain: Record<string, TagOutput>
        allOf of nullable then nullable type: Record<string, TagOutput> | null
        allOf of nullable then union: Record<string, TagOutput> | null
        allOf of nullable then allOf of nullable: Record<string, TagOutput> | null
        allOf of nullable then plain: Record<string, TagOutput>
        plain then nullable type: Record<string, TagOutput>
        plain then union: Record<string, TagOutput>
        plain then allOf of nullable: Record<string, TagOutput>
        plain then plain: Record<string, TagOutput>"
      `);
    });

    it('with three declarations, in every order', async () => {
      const three = async (first: unknown, second: unknown, third: unknown): Promise<string> =>
        tagsLine(await parse(redeclared(openapi, first, second, { more: [third] })));
      const [bare, wide, narrow] = [{ type: 'object' }, map(ref('Tag')), map(ref('TagOutput'))];
      for (const [first, second, third] of [
        [bare, wide, narrow],
        [bare, narrow, wide],
        [wide, bare, narrow],
        [wide, narrow, bare],
        [narrow, bare, wide],
        [narrow, wide, bare],
      ]) {
        expect(await three(first, second, third)).toBe('Record<string, TagOutput>');
      }
      // `null` when all three admit it; one that rejects it, wherever it stands, and the field admits none.
      expect(await three(nullable('Tag'), union('TagOutput'), nullable('Tag'))).toBe(
        'Record<string, TagOutput> | null',
      );
      expect(await three(nullable('Tag'), union('TagOutput'), wide)).toBe('Record<string, TagOutput>');
      expect(await three(nullable('Tag'), wide, union('TagOutput'))).toBe('Record<string, TagOutput>');
      expect(await three(wide, nullable('Tag'), union('TagOutput'))).toBe('Record<string, TagOutput>');
      // A member that only documents the property annotates the conjunction, wherever it stands.
      const text = { description: 'Tags by name.' };
      for (const order of [
        [text, wide, narrow],
        [wide, text, narrow],
        [wide, narrow, text],
      ]) {
        expect(await three(order[0], order[1], order[2])).toBe(
          'Record<string, TagOutput> <description="Tags by name.">',
        );
      }
    });
  });

  it('by whichever keyword each map writes its values under', async () => {
    const closed = { type: 'object', patternProperties: { '^x-': ref('TagOutput') }, additionalProperties: false };
    const several = { type: 'object', patternProperties: { '^x-': ref('Tag'), '^y-': ref('Other') } };
    const both = { ...map(ref('Tag')), patternProperties: { '^x-': ref('Other') } };
    expect(
      await bothOrders('3.1.0', [
        ['additionalProperties, both', map(ref('Tag')), map(ref('TagOutput'))],
        ['one pattern, both', pattern(ref('Tag')), pattern(ref('TagOutput'))],
        // Each side is typed by its values for every key alone, so each says what every value is.
        ['two patterns that differ', pattern(ref('Tag'), '^x-'), pattern(ref('TagOutput'), '^y-')],
        ['one keyword each', map(ref('Tag')), pattern(ref('TagOutput'))],
        ['a closed pattern map', map(ref('Tag')), closed],
        // A map of several patterns is typed by the first, and one that writes both keywords by
        // `additionalProperties` (`mapValueSchema`): those are the values each brings.
        ['several patterns, the first `Tag`', several, pattern(ref('TagOutput'), '^z-')],
        ['both keywords on one side', both, pattern(ref('TagOutput'))],
      ]),
    ).toMatchInlineSnapshot(`
      "additionalProperties, both: Record<string, TagOutput> / Record<string, TagOutput>
      one pattern, both: Record<string, TagOutput> / Record<string, TagOutput>
      two patterns that differ: Record<string, TagOutput> / Record<string, TagOutput>
      one keyword each: Record<string, TagOutput> / Record<string, TagOutput>
      a closed pattern map: Record<string, TagOutput> / Record<string, TagOutput>
      several patterns, the first \`Tag\`: Record<string, TagOutput> / Record<string, TagOutput>
      both keywords on one side: Record<string, TagOutput> / Record<string, TagOutput>"
    `);
  });

  it('a map that declares no values takes the other’s, in either member order', async () => {
    const schemas = { ...tags, Never: false, NeverAlias: ref('Never') };
    const narrow = map(ref('TagOutput'));
    expect(
      await bothOrders('3.1.0', [
        ['no values written', { type: 'object' }, narrow],
        ['`additionalProperties: true`', map(true), narrow],
        ['`additionalProperties: {}`', map({}), narrow],
        // `false`, and a `$ref` that leads to it (#746), say what no value is: none to conjoin.
        ['`additionalProperties: false`', map(false), narrow],
        ['a `$ref` to `false`', map(ref('Never')), narrow, schemas],
        ['a `$ref` to an alias of it', map(ref('NeverAlias', { description: 'Never.' })), narrow, schemas],
        ['a pattern written `false`', pattern(false), narrow],
        ['a pattern that is a `$ref` to `false`', pattern(ref('Never')), narrow, schemas],
        ['`unevaluatedProperties` alone', { type: 'object', unevaluatedProperties: ref('Tag') }, narrow],
      ]),
    ).toMatchInlineSnapshot(`
      "no values written: Record<string, TagOutput> / Record<string, TagOutput> <from=Pet>
      \`additionalProperties: true\`: Record<string, TagOutput> / Record<string, TagOutput> <from=Pet>
      \`additionalProperties: {}\`: Record<string, TagOutput> / Record<string, TagOutput> <from=Pet>
      \`additionalProperties: false\`: Record<string, TagOutput> / Record<string, TagOutput> <from=Pet>
      a \`$ref\` to \`false\`: Record<string, TagOutput> / Record<string, TagOutput> <from=Pet>
      a \`$ref\` to an alias of it: Record<string, TagOutput> / Record<string, TagOutput> <from=Pet>
      a pattern written \`false\`: Record<string, TagOutput> / Record<string, TagOutput> <from=Pet>
      a pattern that is a \`$ref\` to \`false\`: Record<string, TagOutput> / Record<string, TagOutput> <from=Pet>
      \`unevaluatedProperties\` alone: Record<string, TagOutput> / Record<string, TagOutput> <from=Pet>"
    `);
    // Two maps that declare none are the map of `unknown` each is alone.
    expect(
      await bothOrders('3.1.0', [
        ['none and `true`', { type: 'object' }, map(true)],
        ['`{}` and `false`', map({}), map(false)],
        ['`false` and a `$ref` to it', map(false), map(ref('Never')), schemas],
      ]),
    ).toMatchInlineSnapshot(`
      "none and \`true\`: Record<string, unknown> <from=Pet> / Record<string, unknown> <from=Pet>
      \`{}\` and \`false\`: Record<string, unknown> <from=Pet> / Record<string, unknown> <from=Pet>
      \`false\` and a \`$ref\` to it: Record<string, unknown> <from=Pet> / Record<string, unknown> <from=Pet>"
    `);
  });

  it('whatever the values are, as two declarations of a property combine', async () => {
    const a = { type: 'object', properties: { a: string } };
    const b = { type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] };
    expect(
      await bothOrders('3.1.0', [
        // Two inline objects merge into the one model the field's values name; beside a `$ref` it has the component's fields too.
        ['two inline objects', map(a), map(b)],
        ['an inline object and a `$ref`', map(a), map(ref('Tag'))],
        ['two components neither of which is the other', map(ref('Tag')), map(ref('Other'))],
        // Two primitives, and two enums, keep the first, as they do declared for a property.
        ['a string with limits, twice', map({ type: 'string', maxLength: 5 }), map({ type: 'string', minLength: 2 })],
        ['a string and an integer', map(string), map({ type: 'integer' })],
        ['two enums', map({ type: 'string', enum: ['a', 'b'] }), map({ type: 'string', enum: ['b', 'c'] })],
        // A member that only documents the values annotates them.
        ['a `$ref` and a description', map(ref('Tag')), map({ description: 'A tag.' })],
      ]),
    ).toMatchInlineSnapshot(`
      "two inline objects: Record<string, PetOutputTags> PetOutputTags { a?: string, b: integer } / Record<string, PetOutputTags> PetOutputTags { b: integer, a?: string }
      an inline object and a \`$ref\`: Record<string, PetOutputTags> PetOutputTags { a?: string, label?: string, color: string } / Record<string, PetOutputTags> PetOutputTags { label?: string, color: string, a?: string }
      two components neither of which is the other: Record<string, PetOutputTags> PetOutputTags { label?: string, color: string, other?: string } / Record<string, PetOutputTags> PetOutputTags { other?: string, label?: string, color: string }
      a string with limits, twice: Record<string, string> <from=Pet> / Record<string, string> <from=Pet>
      a string and an integer: Record<string, string> <from=Pet> / Record<string, integer> <from=Pet>
      two enums: Record<string, PetOutputTags> <from=Pet> / Record<string, PetOutputTags> <from=Pet>
      a \`$ref\` and a description: Record<string, Tag> / Record<string, Tag>"
    `);
  });
});

describe('#744 where the rule meets #743: `null`, on the values and on the map', () => {
  /** A nullable `$ref`, in the union spelling #743 conjoins. */
  const maybe = (name: string) => ({ anyOf: [ref(name), nul] });

  it('map values that are nullable unions of a `$ref`, on both sides and on one', async () => {
    expect(
      await bothOrders('3.1.0', [
        ['both nullable', map(maybe('Tag')), map(maybe('TagOutput'))],
        ['the wider nullable', map(maybe('Tag')), map(ref('TagOutput'))],
        ['the narrower nullable', map(ref('Tag')), map(maybe('TagOutput'))],
        [
          'the type-list spelling of both',
          map({ type: ['object', 'null'], allOf: [ref('Tag')] }),
          map(maybe('TagOutput')),
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "both nullable: Record<string, TagOutput | null> / Record<string, TagOutput | null>
      the wider nullable: Record<string, TagOutput> / Record<string, TagOutput>
      the narrower nullable: Record<string, TagOutput> / Record<string, TagOutput>
      the type-list spelling of both: Record<string, TagOutput | null> / Record<string, TagOutput | null>"
    `);
  });

  it('a nullable map in every spelling, on one side or both (OAS 3.1.0)', async () => {
    const spellings: Record<string, (name: string) => unknown> = {
      'type list': (name) => map(ref(name), { type: ['object', 'null'] }),
      anyOf: (name) => ({ anyOf: [map(ref(name)), nul] }),
      oneOf: (name) => ({ oneOf: [nul, map(ref(name))] }),
      '`const: null` variant': (name) => ({ anyOf: [map(ref(name)), { const: null }] }),
      'a wrapper around a wrapper': (name) => ({ oneOf: [{ anyOf: [map(ref(name)), nul] }, { enum: [null] }] }),
      '`allOf` of a nullable map': (name) => all(map(ref(name), { type: ['object', 'null'] })),
    };
    const rows: Row[] = [];
    for (const [label, spelling] of Object.entries(spellings)) {
      rows.push([`${label}, both`, spelling('Tag'), spelling('TagOutput')]);
      rows.push([`${label}, then a plain map`, spelling('Tag'), map(ref('TagOutput'))]);
      rows.push([`a plain map, then ${label}`, map(ref('Tag')), spelling('TagOutput')]);
    }
    expect(await table('3.1.0', rows)).toMatchInlineSnapshot(`
      "type list, both: Record<string, TagOutput> | null
      type list, then a plain map: Record<string, TagOutput>
      a plain map, then type list: Record<string, TagOutput>
      anyOf, both: Record<string, TagOutput> | null
      anyOf, then a plain map: Record<string, TagOutput>
      a plain map, then anyOf: Record<string, TagOutput>
      oneOf, both: Record<string, TagOutput> | null
      oneOf, then a plain map: Record<string, TagOutput>
      a plain map, then oneOf: Record<string, TagOutput>
      \`const: null\` variant, both: Record<string, TagOutput> | null
      \`const: null\` variant, then a plain map: Record<string, TagOutput>
      a plain map, then \`const: null\` variant: Record<string, TagOutput>
      a wrapper around a wrapper, both: Record<string, TagOutput> | null
      a wrapper around a wrapper, then a plain map: Record<string, TagOutput>
      a plain map, then a wrapper around a wrapper: Record<string, TagOutput>
      \`allOf\` of a nullable map, both: Record<string, TagOutput> | null
      \`allOf\` of a nullable map, then a plain map: Record<string, TagOutput>
      a plain map, then \`allOf\` of a nullable map: Record<string, TagOutput>"
    `);
  });

  it('a nullable map in the spellings of OAS 3.0.3', async () => {
    const spellings: Record<string, (name: string) => unknown> = {
      '`nullable: true`': (name) => map(ref(name), { nullable: true }),
      'a union of one, flagged': (name) => ({ oneOf: [map(ref(name))], nullable: true }),
      '`allOf` of a flagged map': (name) => all(map(ref(name), { nullable: true })),
    };
    const rows: Row[] = [];
    for (const [label, spelling] of Object.entries(spellings)) {
      rows.push([`${label}, both`, spelling('Tag'), spelling('TagOutput')]);
      rows.push([`${label}, then a plain map`, spelling('Tag'), map(ref('TagOutput'))]);
      rows.push([`a plain map, then ${label}`, map(ref('Tag')), spelling('TagOutput')]);
    }
    expect(await table('3.0.3', rows)).toMatchInlineSnapshot(`
      "\`nullable: true\`, both: Record<string, TagOutput> | null
      \`nullable: true\`, then a plain map: Record<string, TagOutput>
      a plain map, then \`nullable: true\`: Record<string, TagOutput>
      a union of one, flagged, both: Record<string, TagOutput> | null
      a union of one, flagged, then a plain map: Record<string, TagOutput>
      a plain map, then a union of one, flagged: Record<string, TagOutput>
      \`allOf\` of a flagged map, both: Record<string, TagOutput> | null
      \`allOf\` of a flagged map, then a plain map: Record<string, TagOutput>
      a plain map, then \`allOf\` of a flagged map: Record<string, TagOutput>"
    `);
  });

  it('a map of arrays, an array of maps and a map of maps conjoin in turn', async () => {
    expect(
      await bothOrders('3.1.0', [
        ['a map of maps', map(map(ref('Tag'))), map(map(ref('TagOutput')))],
        ['an array of maps', array(map(ref('Tag'))), array(map(ref('TagOutput')))],
        ['a map of arrays', map(array(ref('Tag'))), map(array(ref('TagOutput')))],
        [
          'a map of nullable maps',
          map(map(ref('Tag'), { type: ['object', 'null'] })),
          map({ anyOf: [map(ref('TagOutput')), nul] }),
        ],
        ['a map of maps beside a map of arrays', map(map(ref('Tag'))), map(array(ref('TagOutput')))],
      ]),
    ).toMatchInlineSnapshot(`
      "a map of maps: Record<string, Record<string, TagOutput>> / Record<string, Record<string, TagOutput>>
      an array of maps: Record<string, TagOutput>[] / Record<string, TagOutput>[]
      a map of arrays: Record<string, TagOutput[]> / Record<string, TagOutput[]>
      a map of nullable maps: Record<string, Record<string, TagOutput> | null> / Record<string, Record<string, TagOutput> | null>
      a map of maps beside a map of arrays: Record<string, Record<string, Tag>> <from=Pet> / Record<string, TagOutput[]> <from=Pet>"
    `);
  });
});

describe('#744 what a field reads from the two maps', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('its text, flags and keys from both, the later’s over the earlier’s, and the stricter limit of each', async () => {
      const first = map(ref('Tag'), { description: 'Tags by name.', minProperties: 1, maxProperties: 9, 'x-first': 1 });
      const second = map(ref('TagOutput'), {
        description: 'Output tags.',
        minProperties: 3,
        deprecated: true,
        'x-second': 2,
      });
      expect(
        await bothOrders(openapi, [
          ['documented and limited, both', first, second],
          [
            'a looser limit redeclared',
            map(ref('Tag'), { minProperties: 3 }),
            map(ref('TagOutput'), { minProperties: 1 }),
          ],
          [
            'read-only then write-only',
            map(ref('Tag'), { readOnly: true }),
            map(ref('TagOutput'), { writeOnly: true }),
          ],
          // A flag either declaration sets stands, as JSON Schema reads several occurrences of it:
          // a later `deprecated: false` lifts none.
          [
            'deprecated, then `deprecated: false`',
            map(ref('Tag'), { deprecated: true }),
            map(ref('TagOutput'), { deprecated: false }),
          ],
          ['a default redeclared', map(ref('Tag'), { default: {} }), map(ref('TagOutput'), { default: { a: null } })],
        ]),
      ).toMatchInlineSnapshot(`
        "documented and limited, both: Record<string, TagOutput> <description="Output tags." deprecated=true constraints={"minProperties":3,"maxProperties":9} extensions={"x-first":1,"x-second":2}> / Record<string, TagOutput> <description="Tags by name." deprecated=true constraints={"minProperties":3,"maxProperties":9} extensions={"x-second":2,"x-first":1}>
        a looser limit redeclared: Record<string, TagOutput> <constraints={"minProperties":3}> / Record<string, TagOutput> <constraints={"minProperties":3}>
        read-only then write-only: Record<string, TagOutput> <readOnly=true writeOnly=true> / Record<string, TagOutput> <readOnly=true writeOnly=true>
        deprecated, then \`deprecated: false\`: Record<string, TagOutput> <deprecated=true> / Record<string, TagOutput> <deprecated=true>
        a default redeclared: Record<string, TagOutput> <default={"a":null}> / Record<string, TagOutput> <default={}>"
      `);
    });
  });

  it('through a wrapper: the wrapper’s own and its annotating members’, never a variant’s or a typing member’s', async () => {
    const union = {
      description: 'Wrapper text.',
      anyOf: [map(ref('TagOutput'), { description: 'Variant text.', deprecated: true, minProperties: 2 }), nul],
    };
    const member = {
      allOf: [
        map(ref('TagOutput'), { description: 'Member text.', minProperties: 2 }),
        { maxProperties: 7 },
        { description: 'Annotated.' },
      ],
    };
    // Each wrapper alone, as the one declaration of the property: what a field reads through it.
    const alone: string[] = [];
    for (const [label, schema] of Object.entries({ union, member })) {
      alone.push(`${label}: ${tagsLine(await parse(direct('3.1.0', schema)))}`);
    }
    expect(alone.join('\n')).toMatchInlineSnapshot(`
      "union: Record<string, TagOutput> | null <description="Wrapper text." constraints={"minProperties":2}>
      member: Record<string, TagOutput> <description="Annotated." constraints={"minProperties":2,"maxProperties":7}>"
    `);
    expect(
      await bothOrders('3.1.0', [
        ['a union wrapper', map(ref('Tag')), union],
        ['an `allOf` wrapper', map(ref('Tag')), member],
        ['the two wrappers', union, member],
        [
          'a wrapper beside a documented map',
          union,
          map(ref('Tag'), { description: 'Tags by name.', minProperties: 1 }),
        ],
      ]),
    ).toMatchInlineSnapshot(`
      "a union wrapper: Record<string, TagOutput> <description="Wrapper text." constraints={"minProperties":2}> / Record<string, TagOutput> <description="Wrapper text." constraints={"minProperties":2}>
      an \`allOf\` wrapper: Record<string, TagOutput> <description="Annotated." constraints={"minProperties":2,"maxProperties":7}> / Record<string, TagOutput> <description="Annotated." constraints={"minProperties":2,"maxProperties":7}>
      the two wrappers: Record<string, TagOutput> <description="Annotated." constraints={"minProperties":2,"maxProperties":7}> / Record<string, TagOutput> <description="Wrapper text." constraints={"minProperties":2,"maxProperties":7}>
      a wrapper beside a documented map: Record<string, TagOutput> <description="Tags by name." constraints={"minProperties":2}> / Record<string, TagOutput> <description="Wrapper text." constraints={"minProperties":2}>"
    `);
  });
});

describe('#744 a pair that is not two maps keeps the first, as before', () => {
  it('a declaration typed as no map alone is none beside a map', async () => {
    const schemas = { ...tags, TagMap: map(ref('Tag')), TagOutputMap: map(ref('TagOutput')) };
    const narrow = map(ref('TagOutput'));
    const object = { type: 'object', properties: { a: string } };
    const objectAndValues = { type: 'object', properties: { a: string }, additionalProperties: ref('TagOutput') };
    const rows: Row[] = [
      // Typed `unknown` alone: `additionalProperties` with no `type: 'object'` beside it.
      ['`additionalProperties` with no `type`', { additionalProperties: ref('Tag') }, narrow],
      ['`patternProperties` with no `type`', { patternProperties: { '^x-': ref('Tag') } }, narrow],
      // A model alone: an object that declares `properties`, with `additionalProperties` beside them or not.
      ['an inline object', object, narrow],
      ['an inline object with `additionalProperties`', objectAndValues, narrow],
      // A reference alone: a `$ref` to a map component is the model the component is.
      ['a `$ref` to a map component', ref('TagMap'), narrow, schemas],
      ['two `$ref`s to map components', ref('TagMap'), ref('TagOutputMap'), schemas],
      // A union, a pinned value, a string, an array, a `$ref` to a model.
      ['a type list naming another type', map(ref('Tag'), { type: ['object', 'string'] }), narrow],
      ['a `const` object', map(ref('Tag'), { const: {} }), narrow],
      ['a string', string, narrow],
      ['an array', array(ref('Tag')), narrow],
      ['a `$ref` to a model', ref('Tag'), narrow],
    ];
    // What each first declaration is alone, and the pair in both member orders.
    const lines: string[] = [];
    for (const [label, first, second, extra] of rows) {
      const alone = tagsLine(await parse(direct('3.1.0', first, { schemas: extra })));
      const forth = tagsLine(await parse(redeclared('3.1.0', first, second, { schemas: extra })));
      const back = tagsLine(await parse(redeclared('3.1.0', second, first, { schemas: extra })));
      lines.push(`${label}: alone ${alone}`, `  then the map: ${forth}`, `  after the map: ${back}`);
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "\`additionalProperties\` with no \`type\`: alone unknown
        then the map: unknown <from=Pet>
        after the map: Record<string, TagOutput> <from=Pet>
      \`patternProperties\` with no \`type\`: alone unknown
        then the map: unknown <from=Pet>
        after the map: Record<string, TagOutput> <from=Pet>
      an inline object: alone PetOutputTags PetOutputTags { a?: string }
        then the map: PetOutputTags PetOutputTags { a?: string } <from=Pet>
        after the map: Record<string, TagOutput> <from=Pet>
      an inline object with \`additionalProperties\`: alone PetOutputTags PetOutputTags { a?: string }
        then the map: PetOutputTags PetOutputTags { a?: string } <from=Pet>
        after the map: Record<string, TagOutput> <from=Pet>
      a \`$ref\` to a map component: alone TagMap
        then the map: TagMap <from=Pet>
        after the map: Record<string, TagOutput> <from=Pet>
      two \`$ref\`s to map components: alone TagMap
        then the map: TagMap <from=Pet>
        after the map: TagOutputMap <from=Pet>
      a type list naming another type: alone (Record<string, Tag> | string)
        then the map: (Record<string, Tag> | string) <from=Pet>
        after the map: Record<string, TagOutput> <from=Pet>
      a \`const\` object: alone Record<string, unknown>
        then the map: Record<string, unknown> <from=Pet>
        after the map: Record<string, TagOutput> <from=Pet>
      a string: alone string
        then the map: string <from=Pet>
        after the map: Record<string, TagOutput> <from=Pet>
      an array: alone Tag[]
        then the map: Tag[] <from=Pet>
        after the map: Record<string, TagOutput> <from=Pet>
      a \`$ref\` to a model: alone Tag
        then the map: Tag <from=Pet>
        after the map: Record<string, TagOutput> <from=Pet>"
    `);
  });

  it('two inline objects that both write `additionalProperties` are the model of their properties, as before', async () => {
    const first = { type: 'object', properties: { a: string }, additionalProperties: ref('Tag') };
    const second = { type: 'object', properties: { b: string }, additionalProperties: ref('TagOutput') };
    expect(await bothOrders('3.1.0', [['properties and values, both', first, second]])).toMatchInlineSnapshot(
      `"properties and values, both: PetOutputTags PetOutputTags { a?: string, b?: string } / PetOutputTags PetOutputTags { b?: string, a?: string }"`,
    );
  });

  it('`mapSchemaOf` answers for the schemas the type builder types by its map branch', () => {
    within({ ...tags, TagMap: map(ref('Tag')) }, () => {
      const cases: Record<string, SchemaObject> = {
        'a map': mapOf(at('Tag')),
        'a map by patternProperties': pattern(at('Tag')) as SchemaObject,
        'a bare object': { type: 'object' },
        'a closed object': mapOf(false),
        'a nullable map': mapOf(at('Tag'), { type: ['object', 'null'] }),
        'a flagged map': mapOf(at('Tag'), { nullable: true }),
        'a union wrapper': { anyOf: [mapOf(at('Tag')), { type: 'null' }] },
        'an allOf of one map': { allOf: [mapOf(at('Tag'))] },
        'an allOf of a map and a limit': { allOf: [mapOf(at('Tag')), { minProperties: 1 }] },
        'a map beside limits in an allOf': mapOf(at('Tag'), { allOf: [{ minProperties: 1 }] }),
        'additionalProperties with no type': { additionalProperties: at('Tag') },
        'an inline object': { type: 'object', properties: { a: { type: 'string' } } },
        'an inline object with values': {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: at('Tag'),
        },
        'a $ref to a map component': at('TagMap'),
        'an allOf of a $ref to one': { allOf: [at('TagMap')] },
        'a type list of two types': mapOf(at('Tag'), { type: ['object', 'string'] }),
        'an array': { type: 'array', items: at('Tag') },
        'a union of two maps': { anyOf: [mapOf(at('Tag')), mapOf(at('Other'))] },
        'an allOf of two maps': { allOf: [mapOf(at('Tag')), mapOf(at('TagOutput'))] },
      };
      const typedAsMap = (schema: SchemaObject): { map: boolean; type: string } => {
        const type = schemaToTypeRef(schema, 'tags', 'PetOutput');
        return { map: (type.kind === 'nullable' ? type.inner : type).kind === 'map', type: typeOf(type) };
      };
      const lines = Object.entries(cases).map(([label, schema]) => {
        const typed = typedAsMap(schema);
        // The one definition: a map here exactly when the type builder types one.
        expect(mapSchemaOf(schema) !== undefined, label).toBe(typed.map);
        return `${label}: ${typed.map ? 'a map' : `no map (${typed.type})`}`;
      });
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a map: a map
        a map by patternProperties: a map
        a bare object: a map
        a closed object: a map
        a nullable map: a map
        a flagged map: a map
        a union wrapper: a map
        an allOf of one map: a map
        an allOf of a map and a limit: a map
        a map beside limits in an allOf: a map
        additionalProperties with no type: no map (unknown)
        an inline object: no map (PetOutputTags)
        an inline object with values: no map (PetOutputTags)
        a $ref to a map component: no map (TagMap)
        an allOf of a $ref to one: no map (TagMap)
        a type list of two types: no map ((Record<string, Tag> | string))
        an array: no map (Tag[])
        a union of two maps: no map ((Record<string, Tag> | Record<string, Other>))
        an allOf of two maps: no map (unknown)"
      `);
      // But for a value pinned to an object: a `const`, or an `enum:` of one value, is typed by the
      // value it pins — a map of `unknown` — whatever the schema declares beside it, and is no map here.
      for (const pinned of [mapOf(at('Tag'), { const: {} }), mapOf(at('Tag'), { enum: [{ a: 1 }] })]) {
        expect(typedAsMap(pinned)).toEqual({ map: true, type: 'Record<string, unknown>' });
        expect(mapSchemaOf(pinned)).toBeUndefined();
      }
    });
  });
});

describe('#744 at every site a property is redeclared', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const Pet = { type: 'object', properties: { name: string, tags: map(ref('Tag')) } };
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
    const errorBody = (schema: unknown) => ({
      '/pets': {
        get: {
          operationId: 'getPet',
          responses: {
            '200': { description: 'OK', ...json(ref('Tag')) },
            '404': { description: 'No', ...json(schema) },
          },
        },
      },
    });
    const sitesOf = (inline: unknown): ReadonlyArray<readonly [string, unknown]> => [
      ['a response body', document(openapi, get('/pets', 'getPet', inline), schemas)],
      ['a request body', document(openapi, requestBody(inline), schemas)],
      ['an error body', document(openapi, errorBody(inline), schemas)],
      ['a query parameter', document(openapi, parameter(inline), schemas)],
      ['a response header', document(openapi, header(inline), schemas)],
      ['a response body’s items', document(openapi, get('/pets', 'listPets', array(inline)), schemas)],
      [
        'a field of a component',
        document(openapi, get('/holders', 'getHolder', ref('Holder')), {
          ...schemas,
          Holder: { type: 'object', properties: { pet: inline } },
        }),
      ],
      [
        'array items of a field',
        document(openapi, get('/holders', 'getHolder', ref('Holder')), {
          ...schemas,
          Holder: { type: 'object', properties: { pets: array(inline) } },
        }),
      ],
      [
        'map values of a field',
        document(openapi, get('/holders', 'getHolder', ref('Holder')), {
          ...schemas,
          Holder: { type: 'object', properties: { pets: map(inline) } },
        }),
      ],
    ];
    /** The one model the document builds from the inline `allOf`: the one beside `Pet` that has a `tags`. */
    const merged = (spec: ApiSpec): Model | undefined =>
      spec.models.find((m) => m.name !== 'Pet' && m.fields.some((f) => f.name === 'tags'));

    it('an inline `allOf` that redeclares it is read as the component that does, in either member order', async () => {
      const after = all(ref('Pet'), { properties: { tags: map(ref('TagOutput')) } });
      const before = all({ properties: { tags: map(ref('TagOutput')) } }, ref('Pet'));
      const lines: string[] = [];
      for (const [[label, doc], [, swapped]] of sitesOf(after).map((site, i) => [site, sitesOf(before)[i]!] as const)) {
        const model = merged(await parse(doc));
        lines.push(`${label}: ${model?.name} { ${fieldsOf(model)} }`);
        const other = merged(await parse(swapped));
        expect(typeOf(other?.fields.find((f) => f.name === 'tags')?.type), label).toBe('Record<string, TagOutput>');
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a response body: GetPetResponse { name?: string, tags?: Record<string, TagOutput> }
        a request body: CreatePetRequest { name?: string, tags?: Record<string, TagOutput> }
        an error body: OptionalErrorBodyWithNameTagsWithoutMessage { name?: string, tags?: Record<string, TagOutput> }
        a query parameter: PetsFilter { name?: string, tags?: Record<string, TagOutput> }
        a response header: PetsXPet { name?: string, tags?: Record<string, TagOutput> }
        a response body’s items: ListPetsItem { name?: string, tags?: Record<string, TagOutput> }
        a field of a component: HolderPet { name?: string, tags?: Record<string, TagOutput> }
        array items of a field: HolderPets { name?: string, tags?: Record<string, TagOutput> }
        map values of a field: HolderPets { name?: string, tags?: Record<string, TagOutput> }"
      `);
    });

    it('two inline members, two bases and a chain of components that each declare it', async () => {
      const declares = (value: unknown) => ({ type: 'object', properties: { tags: value } });
      const [wide, narrow] = [map(ref('Tag')), map(ref('TagOutput'))];
      const line = (spec: ApiSpec): string => {
        const model = modelOf(spec, 'PetOutput')!;
        const bases = model.bases?.length ? ` extends ${model.bases.map(typeOf).join(', ')}` : '';
        return `PetOutput${bases} { ${model.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${typeOf(f.type)}${carried(f)}`).join(', ')} }`;
      };
      const pets = get('/pets', 'listPets', ref('PetOutput'));
      const docs: Record<string, unknown> = {
        'two inline members': document(openapi, pets, { ...tags, PetOutput: all(declares(wide), declares(narrow)) }),
        'the narrower first': document(openapi, pets, { ...tags, PetOutput: all(declares(narrow), declares(wide)) }),
        'two bases': document(openapi, pets, {
          ...schemas,
          Tagged: declares(narrow),
          PetOutput: all(ref('Pet'), ref('Tagged')),
        }),
        'two bases, the narrower first': document(openapi, pets, {
          ...schemas,
          Tagged: declares(narrow),
          PetOutput: all(ref('Tagged'), ref('Pet')),
        }),
        'a chain of three': document(openapi, pets, {
          ...tags,
          PetBase: { type: 'object', properties: { name: string, tags: { type: 'object' } } },
          Pet: all(ref('PetBase'), { properties: { tags: map(ref('Tag'), { description: 'Pet tags.' }) } }),
          PetOutput: all(ref('Pet'), { properties: { tags: narrow } }),
        }),
      };
      const lines: string[] = [];
      for (const [label, doc] of Object.entries(docs)) lines.push(`${label}: ${line(await parse(doc))}`);
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "two inline members: PetOutput { tags?: Record<string, TagOutput> }
        the narrower first: PetOutput { tags?: Record<string, TagOutput> }
        two bases: PetOutput extends Pet, Tagged { name?: string <from=Pet>, tags?: Record<string, TagOutput> }
        two bases, the narrower first: PetOutput extends Tagged, Pet { tags?: Record<string, TagOutput>, name?: string <from=Pet> }
        a chain of three: PetOutput extends Pet { name?: string <from=Pet>, tags?: Record<string, TagOutput> <description="Pet tags."> }"
      `);
    });
  });

  it('a webhook payload that redeclares it', async () => {
    const Pet = { type: 'object', properties: { name: string, tags: map(ref('Tag')) } };
    const payload = all(ref('Pet'), { properties: { tags: map(ref('TagOutput')) } });
    const doc = document(
      '3.1.0',
      {},
      { ...tags, Pet },
      {
        webhooks: {
          petTagged: {
            post: { operationId: 'petTagged', requestBody: json(payload), responses: { '204': { description: 'OK' } } },
          },
        },
      },
    );
    const spec = await parse(doc);
    const model = spec.models.find((m) => m.name !== 'Pet' && m.fields.some((f) => f.name === 'tags'));
    expect(`${model?.name} { ${fieldsOf(model)} }`).toMatchInlineSnapshot(
      `"PetTaggedPayload { name?: string, tags?: Record<string, TagOutput> }"`,
    );
  });

  it('a component that redeclares its own recursive map, and two that redeclare each other’s', async () => {
    const tree = document('3.1.0', get('/trees', 'getTree', ref('TreeOutput')), {
      Tree: { type: 'object', properties: { name: string, children: map(ref('Tree')) } },
      TreeOutput: all(ref('Tree'), { properties: { children: map(ref('TreeOutput')) }, required: ['name'] }),
    });
    expect((await parse(tree)).models.map((m) => `${m.name} { ${fieldsOf(m)} }`)).toMatchInlineSnapshot(`
      [
        "Tree { name?: string, children?: Record<string, Tree> }",
        "TreeOutput { name: string, children?: Record<string, TreeOutput> }",
      ]
    `);
    const mutual = document('3.1.0', get('/a', 'getA', ref('AOut')), {
      A: { type: 'object', properties: { bs: map(ref('B')) } },
      B: { type: 'object', properties: { as: map(ref('A')) } },
      AOut: all(ref('A'), { properties: { bs: map(ref('BOut')) } }),
      BOut: all(ref('B'), { properties: { as: map(ref('AOut')) } }),
    });
    expect((await parse(mutual)).models.map((m) => `${m.name} { ${fieldsOf(m)} }`)).toMatchInlineSnapshot(`
      [
        "A { bs?: Record<string, B> }",
        "B { as?: Record<string, A> }",
        "AOut { bs?: Record<string, BOut> }",
        "BOut { as?: Record<string, AOut> }",
      ]
    `);
    expect(warnings()).toEqual([]);
  });
});

describe('#744 `bases` and `inheritedFrom` say what the same pair of arrays or `$ref`s says', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    const line = (spec: ApiSpec): string => {
      const model = modelOf(spec, 'PetOutput')!;
      const bases = model.bases?.length ? ` extends ${model.bases.map(typeOf).join(', ')}` : '';
      return `PetOutput${bases} { ${model.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${typeOf(f.type)}${carried(f)}`).join(', ')} }`;
    };

    it('the narrowed field is the model’s own, and the base stays a base', async () => {
      const maps = [
        line(await parse(redeclared(openapi, map(ref('Tag')), map(ref('TagOutput'))))),
        line(await parse(redeclared(openapi, map(ref('Tag')), map(ref('TagOutput')), { narrowing: narrowedBefore }))),
        line(await parse(redeclared(openapi, map(ref('TagOutput')), map(ref('Tag'))))),
      ];
      expect(maps).toMatchInlineSnapshot(`
        [
          "PetOutput extends Pet { name?: string <from=Pet>, tags?: Record<string, TagOutput> }",
          "PetOutput extends Pet { tags?: Record<string, TagOutput>, name?: string <from=Pet> }",
          "PetOutput extends Pet { name?: string <from=Pet>, tags?: Record<string, TagOutput> }",
        ]
      `);
      // The same three with the values declared for the property itself, which conjoined before (#733).
      const plain = [
        line(await parse(redeclared(openapi, ref('Tag'), ref('TagOutput')))),
        line(await parse(redeclared(openapi, ref('Tag'), ref('TagOutput'), { narrowing: narrowedBefore }))),
        line(await parse(redeclared(openapi, ref('TagOutput'), ref('Tag')))),
      ];
      expect(maps.map((text) => text.replaceAll('Record<string, TagOutput>', 'TagOutput'))).toEqual(plain);
    });

    it('a redeclaration that adds nothing leaves the field the base’s', async () => {
      const inherited = 'PetOutput extends Pet { name?: string <from=Pet>, tags?: Record<string, Tag> <from=Pet> }';
      // The same map; one that declares no values; and the same values under the other keyword.
      expect(line(await parse(redeclared(openapi, map(ref('Tag')), map(ref('Tag')))))).toBe(inherited);
      expect(line(await parse(redeclared(openapi, map(ref('Tag')), { type: 'object' })))).toBe(inherited);
      expect(line(await parse(redeclared(openapi, map(ref('Tag')), map(true))))).toBe(inherited);
      expect(line(await parse(redeclared(openapi, map(ref('Tag')), pattern(ref('Tag')))))).toBe(inherited);
      // A limit no stricter than the base's, and a text it already has.
      const documented = map(ref('Tag'), { description: 'Tags by name.', minProperties: 2 });
      expect(
        line(
          await parse(
            redeclared(openapi, documented, map(ref('Tag'), { description: 'Tags by name.', minProperties: 1 })),
          ),
        ),
      ).toBe(
        'PetOutput extends Pet { name?: string <from=Pet>, tags?: Record<string, Tag> <description="Tags by name." constraints={"minProperties":2} from=Pet> }',
      );
    });

    it('a map whose array values are narrowed costs the base, as the array narrowed for the property does (#681)', async () => {
      const mapOfArrays = line(await parse(redeclared(openapi, map(array(ref('Tag'))), map(array(ref('TagOutput'))))));
      const arrays = line(await parse(redeclared(openapi, array(ref('Tag')), array(ref('TagOutput')))));
      expect([mapOfArrays, arrays]).toMatchInlineSnapshot(`
        [
          "PetOutput { name?: string, tags?: Record<string, TagOutput[]> }",
          "PetOutput { name?: string, tags?: TagOutput[] }",
        ]
      `);
    });
  });
});

describe('#744 where the rule meets #746: values that are a `$ref` to `false`', () => {
  const schemas = { ...tags, Never: false };

  it('are none to conjoin, with either spelling of `false`, and the map alone is the map of `unknown` it was', async () => {
    const lines: string[] = [];
    for (const [label, never] of [
      ['false', false],
      ['a `$ref` to `false`', ref('Never')],
    ] as const) {
      const alone = tagsLine(await parse(direct('3.1.0', map(never), { schemas })));
      const forth = tagsLine(await parse(redeclared('3.1.0', map(never), map(ref('TagOutput')), { schemas })));
      const back = tagsLine(await parse(redeclared('3.1.0', map(ref('TagOutput')), map(never), { schemas })));
      lines.push(`${label}: alone ${alone}; then a map ${forth}; after a map ${back}`);
    }
    expect(lines).toMatchInlineSnapshot(`
      [
        "false: alone Record<string, unknown>; then a map Record<string, TagOutput>; after a map Record<string, TagOutput> <from=Pet>",
        "a \`$ref\` to \`false\`: alone Record<string, unknown>; then a map Record<string, TagOutput>; after a map Record<string, TagOutput> <from=Pet>",
      ]
    `);
    // To `oagen diff`, the two spellings of the pair are one API.
    await expectNoDiff(
      redeclared('3.1.0', map(ref('Never')), map(ref('TagOutput')), { schemas }),
      redeclared('3.1.0', map(false), map(ref('TagOutput')), { schemas }),
    );
  });

  it('a property of the values that is one is no field of the values the two maps conjoin', async () => {
    const values = (properties: Doc) => map({ type: 'object', properties });
    expect(
      await table('3.1.0', [
        ['on the first', values({ a: string, gone: ref('Never') }), values({ b: string }), schemas],
        ['on the second', values({ a: string }), values({ b: string, gone: ref('Never') }), schemas],
        ['on the first, declared by the second', values({ gone: ref('Never') }), values({ gone: string }), schemas],
      ]),
    ).toMatchInlineSnapshot(`
      "on the first: Record<string, PetOutputTags> PetOutputTags { a?: string, b?: string }
      on the second: Record<string, PetOutputTags> PetOutputTags { a?: string, b?: string }
      on the first, declared by the second: Record<string, PetOutputTags> PetOutputTags { gone?: string }"
    `);
  });
});

describe('#744 `combineDeclarations`: the conjunction it writes for two maps', () => {
  it('is one map whose values are the two combined, nullable exactly when both admit `null`', () => {
    within(tags, () => {
      const [wide, narrow] = [mapOf(at('Tag')), mapOf(at('TagOutput'))];
      const both = combineDeclarations(wide, narrow);
      expect(both).toEqual({
        type: 'object',
        additionalProperties: { allOf: [at('Tag'), at('TagOutput')], type: 'object' },
      });
      // The values are the conjunction the same two `$ref`s declared for a property give (#733).
      expect(both.additionalProperties).toBe(
        combineDeclarations(wide.additionalProperties as SchemaObject, narrow.additionalProperties as SchemaObject),
      );
      expect(schemaToTypeRef(both, 'tags', 'PetOutput')).toEqual({
        kind: 'map',
        valueType: { kind: 'model', name: 'TagOutput' },
      });
      // The same two declarations combine into the same object throughout the document.
      expect(combineDeclarations(wide, narrow)).toBe(both);

      const list = mapOf(at('TagOutput'), { type: ['object', 'null'] });
      const union: SchemaObject = { anyOf: [mapOf(at('Tag')), { type: 'null' }] };
      expect(combineDeclarations(union, list).type).toEqual(['object', 'null']);
      expect(combineDeclarations(list, union).type).toEqual(['object', 'null']);
      expect(combineDeclarations(union, narrow).type).toBe('object');
      expect(combineDeclarations(wide, list).type).toBe('object');
    });
  });

  it('writes the values under `additionalProperties`, whichever keyword each side wrote them under', () => {
    within(tags, () => {
      const narrow = at('TagOutput');
      const values = { allOf: [at('Tag'), narrow], type: 'object' };
      const byPattern = pattern(at('Tag')) as SchemaObject;
      expect(combineDeclarations(byPattern, pattern(narrow) as SchemaObject)).toEqual({
        type: 'object',
        additionalProperties: values,
      });
      expect(combineDeclarations(byPattern, mapOf(narrow))).toEqual({ type: 'object', additionalProperties: values });
      // A map that declares no values takes the other's, the schema itself.
      const taken = combineDeclarations({ type: 'object' }, mapOf(narrow));
      expect(taken).toEqual({ type: 'object', additionalProperties: narrow });
      expect(taken.additionalProperties).toBe(narrow);
      expect(combineDeclarations(mapOf(false), pattern(narrow) as SchemaObject)).toEqual({
        type: 'object',
        additionalProperties: narrow,
      });
    });
  });

  it('returns the first declaration itself where the second adds nothing to it', () => {
    within(tags, () => {
      const first = mapOf(at('Tag'), { description: 'Tags by name.', minProperties: 2 });
      expect(combineDeclarations(first, mapOf(at('Tag')))).toBe(first);
      expect(combineDeclarations(first, { type: 'object' })).toBe(first);
      expect(combineDeclarations(first, mapOf(true))).toBe(first);
      expect(combineDeclarations(first, mapOf({}))).toBe(first);
      expect(combineDeclarations(first, mapOf(false))).toBe(first);
      expect(combineDeclarations(first, mapOf(at('Tag'), { description: 'Tags by name.', minProperties: 1 }))).toBe(
        first,
      );
      // A nullable second declaration adds no `null`: the first rejects it.
      expect(combineDeclarations(first, mapOf(at('Tag'), { type: ['object', 'null'] }))).toBe(first);
      // A nullable first beside a second that rejects `null` is the conjunction, which says so.
      const nullable = mapOf(at('Tag'), { type: ['object', 'null'] });
      expect(combineDeclarations(nullable, mapOf(at('Tag')))).toEqual({
        type: 'object',
        additionalProperties: at('Tag'),
      });
      expect(combineDeclarations(nullable, mapOf(at('Tag'), { nullable: true }))).toBe(nullable);
      // And a second declaration that is no map keeps the first as written.
      expect(combineDeclarations(first, { type: 'string' })).toBe(first);
      expect(combineDeclarations(first, { additionalProperties: at('TagOutput') })).toBe(first);
      expect(combineDeclarations(first, { type: 'object', properties: { a: { type: 'string' } } })).toBe(first);
    });
  });

  it('carries what a field reads from each declaration, and the stricter limit of both', () => {
    within(tags, () => {
      const first = mapOf(at('Tag'), { description: 'First.', minProperties: 3, maxProperties: 9, title: 'Tags' });
      const second = mapOf(at('TagOutput'), {
        description: 'Second.',
        minProperties: 1,
        readOnly: true,
        'x-flag': true,
      });
      expect(combineDeclarations(first, second)).toEqual({
        description: 'Second.',
        readOnly: true,
        'x-flag': true,
        minProperties: 3,
        maxProperties: 9,
        type: 'object',
        additionalProperties: { allOf: [at('Tag'), at('TagOutput')], type: 'object' },
      });
      // Through a wrapper: the wrapper's text, the limits under it, and no text or flag of the variant.
      const wrapper: SchemaObject = {
        description: 'Wrapper.',
        allOf: [{ deprecated: true }],
        anyOf: [
          mapOf(at('TagOutput'), { description: 'Variant.', readOnly: true, minProperties: 2 }),
          { type: 'null' },
        ],
      };
      expect(combineDeclarations(mapOf(at('Tag')), wrapper)).toEqual({
        description: 'Wrapper.',
        deprecated: true,
        minProperties: 2,
        type: 'object',
        additionalProperties: { allOf: [at('Tag'), at('TagOutput')], type: 'object' },
      });
    });
  });
});

describe('#744 the pagination walk reads the same conjunction', () => {
  it('a property two members of an envelope declare as maps is one map of the narrower values', () => {
    const schemas = tags as unknown as Record<string, SchemaObject>;
    within(tags, () => {
      const envelope: SchemaObject = {
        allOf: [{ properties: { meta: mapOf(at('Tag')) } }, { properties: { meta: mapOf(at('TagOutput')) } }],
      };
      const { properties } = collectObjectProperties(envelope, schemas);
      expect(properties.meta).toEqual({
        type: 'object',
        additionalProperties: { allOf: [at('Tag'), at('TagOutput')], type: 'object' },
      });
    });
  });
});

describe('#744 a document that parsed still parses', () => {
  /** A value of every kind a document may write where a schema, or a map or list of schemas, goes. */
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
  const narrow = ref('TagOutput');
  /** Each position the conjunction now reads inside a map declared second. */
  const positions: ReadonlyArray<readonly [string, (value: unknown) => unknown]> = [
    ['the declaration', (value) => value],
    ['`additionalProperties`', (value) => ({ type: 'object', additionalProperties: value })],
    ['`patternProperties`', (value) => ({ type: 'object', patternProperties: value })],
    ['a pattern’s schema', (value) => ({ type: 'object', patternProperties: { '^x-': value } })],
    ['a second pattern’s schema', (value) => ({ type: 'object', patternProperties: { '^x-': narrow, '^y-': value } })],
    ['`type`', (value) => ({ type: value, additionalProperties: narrow })],
    ['a member of the `type` list', (value) => ({ type: ['object', value], additionalProperties: narrow })],
    ['`nullable`', (value) => ({ ...map(narrow), nullable: value })],
    ['the union of a wrapper', (value) => ({ anyOf: value })],
    ['the variant of a wrapper', (value) => ({ anyOf: [value, nul] })],
    ['the `null` variant of a wrapper', (value) => ({ anyOf: [map(narrow), value] })],
    ['a union beside the map', (value) => ({ ...map(narrow), anyOf: value })],
    ['the `allOf` of a wrapper', (value) => ({ allOf: value })],
    ['the member of an `allOf` wrapper', (value) => ({ allOf: [value] })],
    ['a member beside the map in an `allOf`', (value) => ({ allOf: [map(narrow), value] })],
    ['an `allOf` beside the map', (value) => ({ ...map(narrow), allOf: value })],
    ['a member of an `allOf` beside the map', (value) => ({ ...map(narrow), allOf: [value] })],
    ['the values’ `properties`', (value) => map({ type: 'object', properties: value })],
    ['a property of the values', (value) => map({ type: 'object', properties: { a: value } })],
    ['the values’ `items`', (value) => map({ type: 'array', items: value })],
    ['the values’ `allOf`', (value) => map({ allOf: value })],
    ['a member of the values’ `allOf`', (value) => map(all(narrow, value))],
    ['the values’ values', (value) => map(map(value))],
    ['the values’ `enum`', (value) => map({ type: 'string', enum: value })],
    ['the values’ `required`', (value) => map({ type: 'object', properties: { a: string }, required: value })],
    ['`description`', (value) => ({ ...map(narrow), description: value })],
    ['`externalDocs`', (value) => ({ ...map(narrow), externalDocs: value })],
    ['`examples`', (value) => ({ ...map(narrow), examples: value })],
    ['`deprecated`', (value) => ({ ...map(narrow), deprecated: value })],
    ['`minProperties`', (value) => ({ ...map(narrow), minProperties: value })],
    ['`dependentRequired`', (value) => ({ ...map(narrow), dependentRequired: value })],
    ['`not`', (value) => ({ ...map(narrow), not: value })],
    ['`discriminator`', (value) => ({ ...map(narrow), discriminator: value })],
  ];

  it('with any value at any position of a map declared second, which no reader read before', async () => {
    const lines: string[] = [];
    for (const [position, at_] of positions) {
      /** The kinds of value by what `PetOutput.tags` is with one there: after a plain map, and after a nullable one. */
      const outcomes = new Map<string, string[]>();
      for (const [kind, value] of kinds) {
        const read: string[] = [];
        for (const first of [map(ref('Tag')), { anyOf: [map(ref('Tag')), nul] }]) {
          const spec = await parse(redeclared('3.1.0', first, at_(value), { schemas })).catch((error: Error) => error);
          read.push(spec instanceof Error ? 'fails' : typeOf(fieldOf(spec, 'PetOutput', 'tags')?.type));
        }
        const outcome = read.join(' / ').replaceAll('Record<string, ', 'map<');
        outcomes.set(outcome, [...(outcomes.get(outcome) ?? []), kind]);
      }
      lines.push(`${position}:`, ...[...outcomes].map(([outcome, among]) => `  ${outcome}: ${among.join(', ')}`));
    }
    // `fails / fails` is a document that failed before too: a walker that reads every schema of the
    // document met the value first. Every other row parsed with the second map dropped unread, and
    // parses now — conjoined where both declarations are ones a reader can read at every depth, else
    // the first, as it was.
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "the declaration:
        map<Tag> / map<Tag> | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`additionalProperties\`:
        map<Tag> / map<Tag>: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        map<Tag> / map<Tag> | null: null
        map<PetOutputTags> / map<PetOutputTags>: a component that composes itself
      \`patternProperties\`:
        map<Tag> / map<Tag> | null: true, false, null, a number, a string, an empty list, a list of \`null\`
        map<Tag> / map<Tag>: {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      a pattern’s schema:
        map<Tag> / map<Tag>: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        map<Tag> / map<Tag> | null: null
        map<PetOutputTags> / map<PetOutputTags>: a component that composes itself
      a second pattern’s schema:
        map<TagOutput> / map<TagOutput>: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<Tag> / map<Tag> | null: null
      \`type\`:
        map<Tag> / map<Tag> | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      a member of the \`type\` list:
        map<Tag> / map<Tag> | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`nullable\`:
        map<TagOutput> / map<TagOutput> | null: true
        map<TagOutput> / map<TagOutput>: false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      the union of a wrapper:
        map<Tag> / map<Tag> | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      the variant of a wrapper:
        map<Tag> / map<Tag> | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      the \`null\` variant of a wrapper:
        map<Tag> / map<Tag> | null: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      a union beside the map:
        map<Tag> / map<Tag> | null: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<TagOutput> / map<TagOutput>: an empty list
      the \`allOf\` of a wrapper:
        fails / fails: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<Tag> / map<Tag> | null: an empty list
      the member of an \`allOf\` wrapper:
        map<Tag> / map<Tag> | null: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        fails / fails: null
      a member beside the map in an \`allOf\`:
        map<TagOutput> / map<TagOutput>: true, false, a number, a string, an empty list, a list of \`null\`, {}
        fails / fails: null
        map<Tag> / map<Tag> | null: a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      an \`allOf\` beside the map:
        fails / fails: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<TagOutput> / map<TagOutput>: an empty list
      a member of an \`allOf\` beside the map:
        map<TagOutput> / map<TagOutput>: true, false, a number, a string, an empty list, a list of \`null\`, {}
        fails / fails: null
        map<Tag> / map<Tag> | null: a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      the values’ \`properties\`:
        map<Tag> / map<Tag> | null: true, false, a number, a string, an empty list, a list of \`null\`
        fails / fails: null
        map<PetOutputTags> / map<PetOutputTags>: {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      a property of the values:
        map<PetOutputTags> / map<PetOutputTags>: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<Tag> / map<Tag> | null: null
      the values’ \`items\`:
        map<Tag> / map<Tag>: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<Tag> / map<Tag> | null: null
      the values’ \`allOf\`:
        fails / fails: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<Tag> / map<Tag>: an empty list
      a member of the values’ \`allOf\`:
        map<TagOutput> / map<TagOutput>: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` to a boolean schema
        fails / fails: null
        map<PetOutputTags> / map<PetOutputTags>: a \`$ref\` that is a number, a component that composes itself
      the values’ values:
        map<Tag> / map<Tag>: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<Tag> / map<Tag> | null: null
      the values’ \`enum\`:
        map<Tag> / map<Tag> | null: true, false, null, a number, a string, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<Tag> / map<Tag>: an empty list, a list of \`null\`
      the values’ \`required\`:
        map<Tag> / map<Tag> | null: true, false, null, a number, a string, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<PetOutputTags> / map<PetOutputTags>: an empty list, a list of \`null\`
      \`description\`:
        map<TagOutput> / map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`externalDocs\`:
        map<TagOutput> / map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`examples\`:
        map<TagOutput> / map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`deprecated\`:
        map<TagOutput> / map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`minProperties\`:
        map<TagOutput> / map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`dependentRequired\`:
        map<TagOutput> / map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`not\`:
        map<TagOutput> / map<TagOutput>: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<Tag> / map<Tag> | null: null
      \`discriminator\`:
        map<Tag> / map<Tag> | null: true, false, a number, a string, an empty list, a list of \`null\`
        fails / fails: null
        map<TagOutput> / map<TagOutput>: {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema"
    `);
  });

  it('with the same values in a map declared first, beside a map declared second', async () => {
    const lines: string[] = [];
    for (const [position, at_] of positions) {
      const outcomes = new Map<string, string[]>();
      for (const [kind, value] of kinds) {
        const spec = await parse(redeclared('3.1.0', at_(value), map(ref('Tag')), { schemas })).catch(
          (error: Error) => error,
        );
        const outcome = (spec instanceof Error ? 'fails' : typeOf(fieldOf(spec, 'PetOutput', 'tags')?.type)).replaceAll(
          'Record<string, ',
          'map<',
        );
        outcomes.set(outcome, [...(outcomes.get(outcome) ?? []), kind]);
      }
      lines.push(`${position}:`, ...[...outcomes].map(([outcome, among]) => `  ${outcome}: ${among.join(', ')}`));
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "the declaration:
        map<Tag>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}
        unknown: a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        LoopA: a component that composes itself
      \`additionalProperties\`:
        map<Tag>: true, false, a number, a string, an empty list, a list of \`null\`, {}
        map<unknown>: null, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        map<PetOutputTags>: a component that composes itself
      \`patternProperties\`:
        map<unknown>: true, false, null, a number, a string, an empty list, a list of \`null\`
        map<Tag>: {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      a pattern’s schema:
        map<Tag>: true, false, a number, a string, an empty list, a list of \`null\`, {}
        map<unknown>: null, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        map<PetOutputTags>: a component that composes itself
      a second pattern’s schema:
        map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`type\`:
        unknown: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        unknown | null: an empty list
      a member of the \`type\` list:
        (map<TagOutput> | unknown): true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        (map<TagOutput> | unknown | null): an empty list
      \`nullable\`:
        map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      the union of a wrapper:
        fails: true, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        unknown: false, null, an empty list
      the variant of a wrapper:
        unknown | null: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        fails: null
        LoopA | null: a component that composes itself
      the \`null\` variant of a wrapper:
        (map<TagOutput> | unknown): true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        fails: null
        (map<TagOutput> | LoopA): a component that composes itself
      a union beside the map:
        fails: true, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<TagOutput>: false, null, an empty list
      the \`allOf\` of a wrapper:
        fails: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        unknown: an empty list
      the member of an \`allOf\` wrapper:
        unknown: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        fails: null
        LoopA: a component that composes itself
      a member beside the map in an \`allOf\`:
        map<TagOutput>: true, false, a number, a string, an empty list, a list of \`null\`, {}
        fails: null
        PetOutputTags: a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      an \`allOf\` beside the map:
        fails: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<TagOutput>: an empty list
      a member of an \`allOf\` beside the map:
        map<TagOutput>: true, false, a number, a string, an empty list, a list of \`null\`, {}
        fails: null
        unknown: a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        LoopA: a component that composes itself
      the values’ \`properties\`:
        map<PetOutputTags>: true, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<map<unknown>>: false
        fails: null
      a property of the values:
        map<PetOutputTags>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      the values’ \`items\`:
        map<unknown[]>: true, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        map<unknown>: false, null
        map<LoopA[]>: a component that composes itself
      the values’ \`allOf\`:
        fails: true, false, null, a number, a string, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<unknown>: an empty list
      a member of the values’ \`allOf\`:
        map<TagOutput>: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` to a boolean schema
        fails: null
        map<PetOutputTags>: a \`$ref\` that is a number, a component that composes itself
      the values’ values:
        map<map<unknown>>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a \`$ref\` to a boolean schema
        map<map<LoopA>>: a component that composes itself
      the values’ \`enum\`:
        fails: true, false, null, a number, a string, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<PetOutputTags>: an empty list
        map<unknown | null>: a list of \`null\`
      the values’ \`required\`:
        fails: true, false, a number, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        map<PetOutputTags>: null, a string, an empty list, a list of \`null\`
      \`description\`:
        map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`externalDocs\`:
        map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`examples\`:
        map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`deprecated\`:
        map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`minProperties\`:
        map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`dependentRequired\`:
        map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`not\`:
        map<TagOutput>: true, false, null, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
      \`discriminator\`:
        map<TagOutput>: true, false, a number, a string, an empty list, a list of \`null\`, {}, a \`$ref\` that is a number, a component that composes itself, a \`$ref\` to a boolean schema
        fails: null"
    `);
  });
});
