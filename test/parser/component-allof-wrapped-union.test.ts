import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #714: a member of a component's `allOf` that was itself an `allOf`
 * around a union — `Pet: { allOf: [{ $ref: Animal }, { allOf: [{ oneOf: [{
 * $ref: Cat }, { $ref: Dog }] }] }] }` — was read as a composed component
 * of its own, and the dispatcher that reading found among the wrapper's
 * members was dropped, since a component's own dispatcher is its own
 * model's. An inline wrapper has no model, so the union was no model's:
 * `Pet` was `{ id }` with neither the `discriminator` nor the variants'
 * fields, where `{ oneOf: [...] }` written as the member dispatches, and
 * `oagen diff` between the two spellings reported a breaking change.
 *
 * A bare `allOf` among a component's members is now read as its own
 * members, by the one reading every reader of an `allOf` makes
 * (`spliceNestedAllOf`; #675), and a wrapper that reading leaves closed —
 * a lone member, or one that says more than its members do — is followed
 * as it was, with what its members declare the model's own, the
 * dispatcher included.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
/** `{ allOf: members }`: a bare wrapper around `members`. */
const W = (...members: unknown[]) => ({ allOf: members });
/** A wrapper around `members` with `keywords` written beside its `allOf`. */
const beside = (keywords: Record<string, unknown>, ...members: unknown[]) => ({ ...keywords, allOf: members });

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const integer = { type: 'integer' };
const object = (properties: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
  type: 'object',
  properties,
  ...rest,
});
/** An object that pins `kind` to `value`, as the issue writes it: required, an `enum` of one value. */
const tagged = (value: string, own: Record<string, unknown>) =>
  object({ kind: { type: 'string', enum: [value] }, ...own }, { required: ['kind'] });

const Animal = ref('Animal');
const Cat = ref('Cat');
const Dog = ref('Dog');
const Pet = ref('Pet');
const D = { propertyName: 'kind' };
/** The issue's union: its variants pin `kind`. */
const union = { oneOf: [Cat, Dog] };
const dunion = { discriminator: D, ...union };
/** A union no variant of which pins anything, dispatched by a `mapping` alone. */
const munion = { oneOf: [ref('Bird'), ref('Fish')] };
const M = { propertyName: 'kind', mapping: { bird: '#/components/schemas/Bird', fish: '#/components/schemas/Fish' } };
/** A union of inline variants, whose models the component builds (`PetCat`, `PetDog`). */
const iunion = { oneOf: [tagged('cat', { meows: boolean }), tagged('dog', { barks: boolean })] };
/** A second union of inline variants, pinning a property of its own (`PetRound`, `PetSquare`). */
const shaped = (value: string, own: Record<string, unknown>) =>
  object({ shape: { type: 'string', enum: [value] }, ...own }, { required: ['shape'] });
const sunion = { oneOf: [shaped('round', { radius: integer }), shaped('square', { side: integer })] };
/** A union nothing dispatches, flattened into the model. */
const funion = { oneOf: [object({ a: string }), object({ b: integer })] };
const text = { description: 'A pet.' };
const extra = object({ extra: string });

const petIdParam = { name: 'petId', in: 'path', required: true, schema: string };
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const ok = (schema: unknown) => ({ description: 'ok', ...json(schema) });

/** The issue's components — `Animal { id }`, `Cat` and `Dog` pinning `kind` — and the ones the spellings below name, beside `schemas`. */
const components = (schemas: Record<string, unknown>): Record<string, unknown> => ({
  Animal: object({ id: string }, { required: ['id'] }),
  Cat: tagged('cat', { meows: boolean }),
  Dog: tagged('dog', { barks: boolean }),
  Bird: object({ kind: string, sings: boolean }),
  Fish: object({ kind: string, swims: boolean }),
  ...schemas,
});

/** Every site that names `Pet`: a field, an inline merge, array items, map values, a union variant, a component that extends it and an alias of it. */
const sitesOfPet = {
  Owner: object({
    pet: Pet,
    merged: W(Pet, object({ note: string })),
    pets: { type: 'array', items: Pet },
    byName: { type: 'object', additionalProperties: Pet },
    either: { oneOf: [Pet, string] },
  }),
  Puppy: W(Pet, object({ age: integer })),
  PetAlias: Pet,
};

/** The issue's document — `GET /pets/{petId}` (`getPet`) returning `$ref: Pet` — with `Pet` written as `pet`; `sites` adds every site that names `Pet` and a `createPet` that takes one. */
function document(
  openapi: string,
  pet: unknown,
  { schemas = {}, sites = false }: { schemas?: Record<string, unknown>; sites?: boolean } = {},
) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets/{petId}': {
        get: { operationId: 'getPet', parameters: [petIdParam], responses: { '200': ok(Pet) } },
      },
      ...(sites && {
        '/pets': {
          post: { operationId: 'createPet', requestBody: json(Pet), responses: { '200': ok(ref('Owner')) } },
        },
      }),
    },
    components: { schemas: components({ Pet: pet, ...schemas, ...(sites && sitesOfPet) }) },
  };
}

/** `document`, with the components and the paths in the opposite order. */
function reversed(doc: ReturnType<typeof document>) {
  const backwards = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).reverse());
  return { ...doc, paths: backwards(doc.paths), components: { schemas: backwards(doc.components.schemas) } };
}

/** A nested spelling of `Pet` and the flat spelling JSON Schema reads it as, with the components both name. */
type Spelling = readonly [label: string, nested: unknown, flat: unknown, schemas?: Record<string, unknown>];

/** The issue's document and every variation its prose lists. */
const issueSpellings: Spelling[] = [
  ['the second member wrapped (nested.json)', W(Animal, W(dunion)), W(Animal, dunion)],
  ['without the `discriminator` keyword', W(Animal, W(union)), W(Animal, union)],
  ['the wrapper alone', W(W(dunion)), W(dunion)],
  ['the wrapper alone, without the keyword', W(W(union)), W(union)],
  ['a `description` beside the inner `allOf`', W(Animal, beside(text, dunion)), W(Animal, text, dunion)],
  [
    'an `anyOf` in place of the `oneOf`',
    W(Animal, W({ discriminator: D, anyOf: [Cat, Dog] })),
    W(Animal, { discriminator: D, anyOf: [Cat, Dog] }),
  ],
  [
    'the `discriminator` beside `Pet`’s own `allOf`',
    { discriminator: D, ...W(Animal, W(union)) },
    { discriminator: D, ...W(Animal, union) },
  ],
];

/** The same wrapper at every depth, in every position and around every other member. */
const wrapperSpellings: Spelling[] = [
  ['two levels down', W(Animal, W(W(dunion))), W(Animal, dunion)],
  ['three levels down', W(Animal, W(W(W(dunion)))), W(Animal, dunion)],
  ['the wrapper alone, three levels down', W(W(W(W(dunion)))), W(dunion)],
  ['the wrapper first', W(W(dunion), Animal), W(dunion, Animal)],
  ['every member wrapped', W(W(Animal), W(dunion)), W(Animal, dunion)],
  ['both members in one wrapper', W(W(Animal, dunion)), W(Animal, dunion)],
  ['the union and another member in the wrapper', W(Animal, W(dunion, extra)), W(Animal, dunion, extra)],
  ['another member and the union in the wrapper', W(Animal, W(extra, dunion)), W(Animal, extra, dunion)],
  ['the variants in the other order', W(Animal, W({ oneOf: [Dog, Cat] })), W(Animal, { oneOf: [Dog, Cat] })],
  ['an empty wrapper beside the union', W(Animal, W(), dunion), W(Animal, dunion)],
  ['an empty wrapper beside the union, in a wrapper', W(Animal, W(W(), dunion)), W(Animal, dunion)],
  ['a wrapper that only annotates, beside the union', W(Animal, W(text), dunion), W(Animal, text, dunion)],
  ['inline variants', W(Animal, W(iunion)), W(Animal, iunion)],
  ['inline variants, three levels down', W(Animal, W(W(W(iunion)))), W(Animal, iunion)],
  ['inline variants, both members in one wrapper', W(W(Animal, iunion)), W(Animal, iunion)],
  ['a union nothing dispatches', W(Animal, W(funion)), W(Animal, funion)],
  ['a union nothing dispatches, both members in one wrapper', W(W(Animal, funion)), W(Animal, funion)],
  [
    '`properties` beside `Pet`’s `allOf`',
    { properties: { id: string }, ...W(W(dunion)) },
    { properties: { id: string }, ...W(dunion) },
  ],
  [
    'the union beside `Pet`’s `allOf`, its one member wrapped',
    { ...W(W(Animal)), ...union },
    { ...W(Animal), ...union },
  ],
];

/** A `discriminator` written for the union on any `allOf` around it. */
const discriminatorSpellings: Spelling[] = [
  [
    'a `mapping` beside `Pet`’s `allOf`',
    { discriminator: M, ...W(Animal, W(munion)) },
    { discriminator: M, ...W(Animal, munion) },
  ],
  [
    'a `mapping` beside `Pet`’s `allOf`, two levels up',
    { discriminator: M, ...W(Animal, W(W(munion))) },
    { discriminator: M, ...W(Animal, munion) },
  ],
  [
    'a `mapping` beside `Pet`’s `allOf`, around one wrapper',
    { discriminator: M, ...W(W(Animal, munion)) },
    { discriminator: M, ...W(Animal, munion) },
  ],
  [
    'a `mapping` beside the inner `allOf`',
    W(Animal, beside({ discriminator: M }, munion)),
    W(Animal, { discriminator: M, ...munion }),
  ],
  [
    'a `mapping` beside a lone inner `allOf`',
    W(beside({ discriminator: M }, Animal, munion)),
    { discriminator: M, ...W(Animal, munion) },
  ],
  ['a `discriminator` beside the inner `allOf`', W(Animal, beside({ discriminator: D }, union)), W(Animal, dunion)],
  [
    'a `mapping` on the union, in a wrapper',
    W(Animal, W({ discriminator: M, ...munion })),
    W(Animal, { discriminator: M, ...munion }),
  ],
];

/** What a wrapper may write beside its `allOf`, each read as the flat spelling writes it. */
const keywordSpellings = (openapi: string): Spelling[] => [
  [
    '`deprecated` and an `x-*` key beside the inner `allOf`',
    W(Animal, beside({ deprecated: true, 'x-since': '2' }, iunion)),
    W(Animal, { deprecated: true, 'x-since': '2' }, iunion),
  ],
  [
    'a limit beside the inner `allOf`',
    W(Animal, beside({ maxProperties: 5 }, extra, { maxProperties: 3, ...iunion })),
    W(Animal, { maxProperties: 5 }, extra, { maxProperties: 3, ...iunion }),
  ],
  [
    '`required` beside the inner `allOf`',
    W(Animal, beside({ required: ['extra'] }, extra, iunion)),
    { required: ['extra'], ...W(Animal, extra, iunion) },
  ],
  ['a `title` beside the inner `allOf`', W(Animal, beside({ title: 'Wrapper' }, iunion)), W(Animal, iunion)],
  ['`type: object` beside the inner `allOf`', W(Animal, beside({ type: 'object' }, iunion)), W(Animal, iunion)],
  // Wrappers the splice leaves closed: they say more than their members do.
  [
    '`properties` beside the inner `allOf`',
    W(Animal, beside({ properties: { extra: string } }, iunion)),
    W(Animal, extra, iunion),
  ],
  [
    '`properties` and `required` beside the inner `allOf`',
    W(Animal, beside({ properties: { extra: string }, required: ['extra'] }, iunion)),
    W(Animal, object({ extra: string }, { required: ['extra'] }), iunion),
  ],
  [
    '`properties` beside a lone inner `allOf`',
    W(beside({ properties: { extra: string } }, Animal, iunion)),
    W(extra, Animal, iunion),
  ],
  [
    '`additionalProperties` beside the inner `allOf`',
    W(Animal, beside({ additionalProperties: false }, iunion)),
    W(Animal, iunion),
  ],
  [
    '`additionalProperties` beside the inner `allOf`, two levels down',
    W(Animal, beside({ additionalProperties: false }, beside({ additionalProperties: false }, iunion))),
    W(Animal, iunion),
  ],
  ['`not` beside the inner `allOf`', W(Animal, beside({ not: string }, iunion)), W(Animal, iunion)],
  [
    'a `type` naming `null` beside the inner `allOf`',
    W(Animal, beside(openapi === '3.0.3' ? { type: 'object', nullable: true } : { type: ['object', 'null'] }, iunion)),
    W(Animal, iunion),
  ],
  [
    'a limit beside a closed inner `allOf`',
    W(Animal, beside({ maxProperties: 5, properties: { extra: string } }, { maxProperties: 3, ...iunion })),
    W(Animal, { maxProperties: 5 }, extra, { maxProperties: 3, ...iunion }),
  ],
  ['the union beside the inner `allOf`', W(Animal, { ...W(extra), ...iunion }), W(Animal, extra, iunion)],
  [
    'the union beside the inner `allOf`, with its `discriminator`',
    W(Animal, { ...W(extra), discriminator: M, ...munion }),
    W(Animal, extra, { discriminator: M, ...munion }),
  ],
  [
    'a nullable wrapper around the inner `allOf`',
    W(Animal, { oneOf: [W(iunion), { type: 'null' }] }),
    W(Animal, { oneOf: [iunion, { type: 'null' }] }),
  ],
  [
    'a nullable wrapper around the inner `allOf` of two',
    W(Animal, { oneOf: [W(extra, iunion), { type: 'null' }] }),
    W(Animal, extra, iunion),
  ],
  // Greptile on #725: what a nullable wrapper's one variant writes binds every variant, as the model.
  [
    'a nullable wrapper around a limited inner `allOf`',
    W(Animal, { oneOf: [beside({ maxProperties: 3 }, iunion), { type: 'null' }] }),
    W(Animal, { maxProperties: 3 }, iunion),
  ],
  [
    'a nullable wrapper around a limited inner `allOf`, another union beside it',
    W(Animal, sunion, { oneOf: [beside({ maxProperties: 3 }, iunion), { type: 'null' }] }),
    W(Animal, sunion, { maxProperties: 3 }, iunion),
  ],
  [
    'a nullable wrapper around a limited union',
    W(Animal, { oneOf: [{ maxProperties: 3, ...iunion }, { type: 'null' }] }),
    W(Animal, { maxProperties: 3, ...iunion }),
  ],
  [
    'a nullable wrapper around a limited object, a union beside it',
    W(Animal, { oneOf: [object({ extra: string }, { maxProperties: 3 }), { type: 'null' }] }, iunion),
    W(Animal, object({ extra: string }, { maxProperties: 3 }), iunion),
  ],
  [
    'a limited closed wrapper around a nullable wrapper around a limited union',
    W(
      Animal,
      beside(
        { additionalProperties: false, maxProperties: 5 },
        { oneOf: [{ maxProperties: 3, ...iunion }, { type: 'null' }] },
      ),
    ),
    W(Animal, { maxProperties: 5 }, { maxProperties: 3, ...iunion }),
  ],
];

/** A member that names a plain object carrying the union, whose union is the reading model's to dispatch (#429). */
const Plain = { Plain: { ...object({ tag: string }), ...iunion } };
const plainSpellings: Spelling[] = [
  ['a wrapped `$ref` to an object carrying the union', W(Animal, W(ref('Plain'))), W(Animal, ref('Plain')), Plain],
  [
    'a `$ref` to an object carrying the union and another member in the wrapper',
    W(Animal, W(ref('Plain'), extra)),
    W(Animal, ref('Plain'), extra),
    Plain,
  ],
  [
    'a `$ref` to an object carrying the union in a closed wrapper',
    W(Animal, beside({ additionalProperties: false }, ref('Plain'), extra)),
    W(Animal, ref('Plain'), extra),
    Plain,
  ],
];

/** A type, nested unions in parentheses. */
function show(type: TypeRef): string {
  switch (type.kind) {
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'array':
      return `array<${show(type.items)}>`;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'literal':
      return JSON.stringify(type.value);
    case 'primitive':
      return type.type;
    case 'enum':
      return `enum ${type.name}`;
    default:
      return type.name;
  }
}

/** A model with its bases, what each field requires, the dispatch it makes and its limits: `Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog`. */
function showModel({ bases, constraints, discriminator, fields, name }: Model): string {
  const extended = bases ? ` extends ${bases.map(show).join(', ')}` : '';
  const members = fields.map((field) => `${field.name}${field.required ? '!' : '?'}: ${show(field.type)}`).join(', ');
  const mapping = Object.entries(discriminator?.mapping ?? {}).map(([value, model]) => `${value}: ${model}`);
  const dispatch = discriminator ? ` by ${discriminator.property} to ${mapping.join(', ')}` : '';
  const limits = constraints ? ` ${JSON.stringify(constraints)}` : '';
  return `${name}${extended} { ${members} }${dispatch}${limits}`;
}

/** What the issue's script prints of a document's `Pet`. */
function issueScript(file: string, { models }: ApiSpec): string {
  const { discriminator, fields } = models.find(({ name }) => name === 'Pet')!;
  return `${file} ${JSON.stringify({ discriminator, fields: fields.map(({ name }) => name) })}`;
}

describe('#714 a component’s `allOf` member that is an `allOf` around a union keeps the union', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-component-allof-wrapped-union-'));
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

  const warnings = (): string[] => warn.mock.calls.map((call: unknown[]) => call.join(' '));
  const modelOf = (spec: ApiSpec, name: string): Model => spec.models.find((model) => model.name === name)!;
  /** The models a document adds to the fixture's components. */
  const fixture = new Set(Object.keys(components({})));
  const ownModels = (spec: ApiSpec): string[] => spec.models.filter(({ name }) => !fixture.has(name)).map(showModel);

  /** Every model a dispatcher's mapping names is a model of the document. */
  function expectMappingsBuilt(spec: ApiSpec, label: string) {
    const names = new Set(spec.models.map(({ name }) => name));
    for (const { discriminator, name } of spec.models) {
      for (const target of Object.values(discriminator?.mapping ?? {})) {
        expect(names.has(target), `${label}: ${name} dispatches to ${target}`).toBe(true);
      }
    }
  }

  /** Parses a spelling and its flat twin, each `Pet` beside every site that names it, and expects one IR, one set of warnings and no `oagen diff` either way; returns the nested reading. */
  async function expectReadAsFlat(
    openapi: string,
    [label, nested, flat, schemas]: Spelling,
    order: (doc: ReturnType<typeof document>) => unknown = (doc) => doc,
  ): Promise<ApiSpec> {
    warn.mockClear();
    const flatSpec = await parseJson(order(document(openapi, flat, { schemas, sites: true })));
    const flatWarnings = warnings();
    warn.mockClear();
    const nestedSpec = await parseJson(order(document(openapi, nested, { schemas, sites: true })));
    expect(nestedSpec, label).toEqual(flatSpec);
    expect(warnings(), label).toEqual(flatWarnings);
    for (const [from, to] of [
      [flatSpec, nestedSpec],
      [nestedSpec, flatSpec],
    ] as const) {
      // `oagen diff` exits 0 on a summary of nothing (`diffCommand`).
      const { changes, summary } = diffSpecs(from, to);
      expect(changes, label).toEqual([]);
      expect(summary, label).toMatchObject({ added: 0, removed: 0, modified: 0, breaking: 0 });
    }
    expectMappingsBuilt(nestedSpec, label);
    return nestedSpec;
  }

  /** `expectReadAsFlat` over `spellings`, one line per spelling: the models the nested document's `Pet` adds. */
  async function readings(openapi: string, spellings: readonly Spelling[]): Promise<string> {
    const lines: string[] = [];
    for (const spelling of spellings) {
      const spec = await expectReadAsFlat(openapi, spelling);
      const pets = ownModels(spec).filter((model) => !/^(Owner|OwnerMerged|Puppy|PetAlias|Plain\w*)\b/.test(model));
      lines.push(`${spelling[0]}: ${pets.join(' ; ')}`);
    }
    return lines.join('\n');
  }

  it.each(['3.0.3', '3.1.0'])(
    'reads `nested.json` as `flat.json`: `Pet` dispatching on `kind` to `Cat` and `Dog` (the repro), under OAS %s',
    async (openapi) => {
      const parsed: Record<string, ApiSpec> = {
        'flat.json': await parseJson(document(openapi, W(Animal, dunion))),
        'nested.json': await parseJson(document(openapi, W(Animal, W(dunion)))),
      };
      const lines = Object.entries(parsed).map(([file, spec]) => issueScript(file, spec));
      // `nested.json` was `{"fields":["id"]}`: no dispatch, and no `meows` or `barks`.
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "flat.json {"discriminator":{"property":"kind","mapping":{"cat":"Cat","dog":"Dog"}},"fields":["id"]}
        nested.json {"discriminator":{"property":"kind","mapping":{"cat":"Cat","dog":"Dog"}},"fields":["id"]}"
      `);
      expect(parsed['nested.json']).toEqual(parsed['flat.json']);
      // `oagen diff` exited 2 with a breaking `model-modified` on `Pet`, in either direction.
      for (const [from, to] of [
        ['flat.json', 'nested.json'],
        ['nested.json', 'flat.json'],
      ] as const) {
        const { changes, summary } = diffSpecs(parsed[from]!, parsed[to]!);
        expect(changes, `${from} → ${to}`).toEqual([]);
        expect(summary, `${from} → ${to}`).toMatchObject({ added: 0, removed: 0, modified: 0, breaking: 0 });
      }
      expect(warnings()).toEqual([]);
    },
  );

  it.each(['3.0.3', '3.1.0'])(
    'reads every variation the issue lists as its flat spelling, wherever `Pet` is named, under OAS %s',
    async (openapi) => {
      expect(await readings(openapi, issueSpellings)).toMatchInlineSnapshot(`
        "the second member wrapped (nested.json): Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        without the \`discriminator\` keyword: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        the wrapper alone: Pet {  } by kind to cat: Cat, dog: Dog
        the wrapper alone, without the keyword: Pet {  } by kind to cat: Cat, dog: Dog
        a \`description\` beside the inner \`allOf\`: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        an \`anyOf\` in place of the \`oneOf\`: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        the \`discriminator\` beside \`Pet\`’s own \`allOf\`: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog"
      `);
    },
  );

  it.each(['3.0.3', '3.1.0'])(
    'reads the wrapper at every depth, in every position and around every other member as its flat spelling, under OAS %s',
    async (openapi) => {
      expect(await readings(openapi, wrapperSpellings)).toMatchInlineSnapshot(`
        "two levels down: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        three levels down: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        the wrapper alone, three levels down: Pet {  } by kind to cat: Cat, dog: Dog
        the wrapper first: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        every member wrapped: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        both members in one wrapper: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        the union and another member in the wrapper: Pet extends Animal { id!: string, extra?: string } by kind to cat: Cat, dog: Dog
        another member and the union in the wrapper: Pet extends Animal { id!: string, extra?: string } by kind to cat: Cat, dog: Dog
        the variants in the other order: Pet extends Animal { id!: string } by kind to dog: Dog, cat: Cat
        an empty wrapper beside the union: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        an empty wrapper beside the union, in a wrapper: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        a wrapper that only annotates, beside the union: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        inline variants: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        inline variants, three levels down: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        inline variants, both members in one wrapper: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        a union nothing dispatches: Pet extends Animal { id!: string, a?: string, b?: integer }
        a union nothing dispatches, both members in one wrapper: Pet extends Animal { id!: string, a?: string, b?: integer }
        \`properties\` beside \`Pet\`’s \`allOf\`: Pet { id?: string } by kind to cat: Cat, dog: Dog
        the union beside \`Pet\`’s \`allOf\`, its one member wrapped: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog"
      `);
    },
  );

  it.each(['3.0.3', '3.1.0'])(
    'hands a `discriminator` written on any `allOf` around the union down to it, under OAS %s',
    async (openapi) => {
      expect(await readings(openapi, discriminatorSpellings)).toMatchInlineSnapshot(`
        "a \`mapping\` beside \`Pet\`’s \`allOf\`: Pet extends Animal { id!: string } by kind to bird: Bird, fish: Fish
        a \`mapping\` beside \`Pet\`’s \`allOf\`, two levels up: Pet extends Animal { id!: string } by kind to bird: Bird, fish: Fish
        a \`mapping\` beside \`Pet\`’s \`allOf\`, around one wrapper: Pet extends Animal { id!: string } by kind to bird: Bird, fish: Fish
        a \`mapping\` beside the inner \`allOf\`: Pet extends Animal { id!: string } by kind to bird: Bird, fish: Fish
        a \`mapping\` beside a lone inner \`allOf\`: Pet extends Animal { id!: string } by kind to bird: Bird, fish: Fish
        a \`discriminator\` beside the inner \`allOf\`: Pet extends Animal { id!: string } by kind to cat: Cat, dog: Dog
        a \`mapping\` on the union, in a wrapper: Pet extends Animal { id!: string } by kind to bird: Bird, fish: Fish"
      `);
    },
  );

  it.each(['3.0.3', '3.1.0'])(
    'reads what a wrapper writes beside its `allOf` as the flat spelling writes it, a wrapper that says more than its members included, under OAS %s',
    async (openapi) => {
      expect(await readings(openapi, keywordSpellings(openapi))).toMatchInlineSnapshot(`
        "\`deprecated\` and an \`x-*\` key beside the inner \`allOf\`: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        a limit beside the inner \`allOf\`: Pet extends Animal { id!: string, extra?: string } by kind to cat: PetCat, dog: PetDog {"maxProperties":3} ; PetCat { id!: string, extra?: string, kind!: "cat", meows?: boolean } {"maxProperties":3} ; PetDog { id!: string, extra?: string, kind!: "dog", barks?: boolean } {"maxProperties":3}
        \`required\` beside the inner \`allOf\`: Pet extends Animal { id!: string, extra!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, extra!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, extra!: string, kind!: "dog", barks?: boolean }
        a \`title\` beside the inner \`allOf\`: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        \`type: object\` beside the inner \`allOf\`: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        \`properties\` beside the inner \`allOf\`: Pet extends Animal { id!: string, extra?: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, extra?: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, extra?: string, kind!: "dog", barks?: boolean }
        \`properties\` and \`required\` beside the inner \`allOf\`: Pet extends Animal { id!: string, extra!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, extra!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, extra!: string, kind!: "dog", barks?: boolean }
        \`properties\` beside a lone inner \`allOf\`: Pet extends Animal { extra?: string, id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { extra?: string, id!: string, kind!: "cat", meows?: boolean } ; PetDog { extra?: string, id!: string, kind!: "dog", barks?: boolean }
        \`additionalProperties\` beside the inner \`allOf\`: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        \`additionalProperties\` beside the inner \`allOf\`, two levels down: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        \`not\` beside the inner \`allOf\`: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        a \`type\` naming \`null\` beside the inner \`allOf\`: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        a limit beside a closed inner \`allOf\`: Pet extends Animal { id!: string, extra?: string } by kind to cat: PetCat, dog: PetDog {"maxProperties":3} ; PetCat { id!: string, extra?: string, kind!: "cat", meows?: boolean } {"maxProperties":3} ; PetDog { id!: string, extra?: string, kind!: "dog", barks?: boolean } {"maxProperties":3}
        the union beside the inner \`allOf\`: Pet extends Animal { id!: string, extra?: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, extra?: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, extra?: string, kind!: "dog", barks?: boolean }
        the union beside the inner \`allOf\`, with its \`discriminator\`: Pet extends Animal { id!: string, extra?: string } by kind to bird: Bird, fish: Fish
        a nullable wrapper around the inner \`allOf\`: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
        a nullable wrapper around the inner \`allOf\` of two: Pet extends Animal { id!: string, extra?: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, extra?: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, extra?: string, kind!: "dog", barks?: boolean }
        a nullable wrapper around a limited inner \`allOf\`: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog {"maxProperties":3} ; PetCat { id!: string, kind!: "cat", meows?: boolean } {"maxProperties":3} ; PetDog { id!: string, kind!: "dog", barks?: boolean } {"maxProperties":3}
        a nullable wrapper around a limited inner \`allOf\`, another union beside it: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog {"maxProperties":3} ; PetRound { id!: string, shape!: "round", radius?: integer } {"maxProperties":3} ; PetSquare { id!: string, shape!: "square", side?: integer } {"maxProperties":3} ; PetCat { id!: string, kind!: "cat", meows?: boolean } {"maxProperties":3} ; PetDog { id!: string, kind!: "dog", barks?: boolean } {"maxProperties":3}
        a nullable wrapper around a limited union: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog {"maxProperties":3} ; PetCat { id!: string, kind!: "cat", meows?: boolean } {"maxProperties":3} ; PetDog { id!: string, kind!: "dog", barks?: boolean } {"maxProperties":3}
        a nullable wrapper around a limited object, a union beside it: Pet extends Animal { id!: string, extra?: string } by kind to cat: PetCat, dog: PetDog {"maxProperties":3} ; PetCat { id!: string, extra?: string, kind!: "cat", meows?: boolean } {"maxProperties":3} ; PetDog { id!: string, extra?: string, kind!: "dog", barks?: boolean } {"maxProperties":3}
        a limited closed wrapper around a nullable wrapper around a limited union: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog {"maxProperties":3} ; PetCat { id!: string, kind!: "cat", meows?: boolean } {"maxProperties":3} ; PetDog { id!: string, kind!: "dog", barks?: boolean } {"maxProperties":3}"
      `);
    },
  );

  it.each(['3.0.3', '3.1.0'])(
    'dispatches the union of an object a wrapped `$ref` member names, as the member written flat does, under OAS %s',
    async (openapi) => {
      expect(await readings(openapi, plainSpellings)).toMatchInlineSnapshot(`
        "a wrapped \`$ref\` to an object carrying the union: Pet extends Animal, Plain { id!: string, tag?: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, tag?: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, tag?: string, kind!: "dog", barks?: boolean }
        a \`$ref\` to an object carrying the union and another member in the wrapper: Pet extends Animal, Plain { id!: string, tag?: string, extra?: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, tag?: string, extra?: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, tag?: string, extra?: string, kind!: "dog", barks?: boolean }
        a \`$ref\` to an object carrying the union in a closed wrapper: Pet extends Animal, Plain { id!: string, tag?: string, extra?: string } by kind to cat: PetCat, dog: PetDog ; PetCat { id!: string, tag?: string, extra?: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, tag?: string, extra?: string, kind!: "dog", barks?: boolean }"
      `);
    },
  );

  it.each(['3.0.3', '3.1.0'])(
    'reads the spellings alike with the components and the paths in the other order, under OAS %s',
    async (openapi) => {
      for (const spelling of [...issueSpellings, ...wrapperSpellings, ...discriminatorSpellings]) {
        await expectReadAsFlat(openapi, spelling, reversed);
      }
    },
  );

  it('reads two unions in one wrapper as the flat spelling reads them: each dispatched and built where nothing says which dispatches, the keyword’s union alone where one does (#718)', async () => {
    const byMapping = { discriminator: M, ...munion };
    const closed = { additionalProperties: false };
    const spellings: Spelling[] = [
      ['two pinned unions in a wrapper', W(Animal, W(iunion, sunion)), W(Animal, iunion, sunion)],
      ['two pinned unions in a closed wrapper', W(Animal, beside(closed, iunion, sunion)), W(Animal, iunion, sunion)],
      ['the same, the other order', W(Animal, beside(closed, sunion, iunion)), W(Animal, sunion, iunion)],
      [
        'a pinned union in each of two closed wrappers',
        W(Animal, beside(closed, iunion), beside(closed, sunion)),
        W(Animal, iunion, sunion),
      ],
      [
        'a pinned union beside one with a `mapping`, in a wrapper',
        W(Animal, W(iunion, byMapping)),
        W(Animal, iunion, byMapping),
      ],
      ['the same in a closed wrapper', W(Animal, beside(closed, iunion, byMapping)), W(Animal, iunion, byMapping)],
      [
        'the same in a closed wrapper, the other order',
        W(Animal, beside(closed, byMapping, iunion)),
        W(Animal, byMapping, iunion),
      ],
      [
        'the two in a closed wrapper each',
        W(Animal, beside(closed, iunion), beside(closed, byMapping)),
        W(Animal, iunion, byMapping),
      ],
      [
        'the `mapping` beside `Pet`’s `allOf`, the unions in a closed wrapper',
        { discriminator: M, ...W(Animal, beside(closed, iunion, munion)) },
        { discriminator: M, ...W(Animal, iunion, munion) },
      ],
      [
        'the `mapping` beside the closed inner `allOf`',
        W(Animal, beside({ ...closed, discriminator: M }, iunion, munion)),
        { discriminator: M, ...W(Animal, iunion, munion) },
      ],
      [
        'the `mapping` beside `Pet`’s `allOf`, one union in a closed wrapper',
        { discriminator: M, ...W(Animal, iunion, beside(closed, munion)) },
        { discriminator: M, ...W(Animal, iunion, munion) },
      ],
      [
        'the `mapping` beside `Pet`’s `allOf`, the other union in a closed wrapper',
        { discriminator: M, ...W(Animal, beside(closed, iunion), munion) },
        { discriminator: M, ...W(Animal, iunion, munion) },
      ],
    ];
    expect(await readings('3.1.0', spellings)).toMatchInlineSnapshot(`
      "two pinned unions in a wrapper: Pet extends Animal { id!: string } by shape to round: PetRound, square: PetSquare ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean } ; PetRound { id!: string, shape!: "round", radius?: integer } ; PetSquare { id!: string, shape!: "square", side?: integer }
      two pinned unions in a closed wrapper: Pet extends Animal { id!: string } by shape to round: PetRound, square: PetSquare ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean } ; PetRound { id!: string, shape!: "round", radius?: integer } ; PetSquare { id!: string, shape!: "square", side?: integer }
      the same, the other order: Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog ; PetRound { id!: string, shape!: "round", radius?: integer } ; PetSquare { id!: string, shape!: "square", side?: integer } ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean }
      a pinned union in each of two closed wrappers: Pet extends Animal { id!: string } by shape to round: PetRound, square: PetSquare ; PetCat { id!: string, kind!: "cat", meows?: boolean } ; PetDog { id!: string, kind!: "dog", barks?: boolean } ; PetRound { id!: string, shape!: "round", radius?: integer } ; PetSquare { id!: string, shape!: "square", side?: integer }
      a pinned union beside one with a \`mapping\`, in a wrapper: Pet extends Animal { id!: string, kind?: enum PetKind, meows?: boolean, barks?: boolean } by kind to bird: Bird, fish: Fish
      the same in a closed wrapper: Pet extends Animal { id!: string, kind?: enum PetKind, meows?: boolean, barks?: boolean } by kind to bird: Bird, fish: Fish
      the same in a closed wrapper, the other order: Pet extends Animal { id!: string, kind?: enum PetKind, meows?: boolean, barks?: boolean } by kind to bird: Bird, fish: Fish
      the two in a closed wrapper each: Pet extends Animal { id!: string, kind?: enum PetKind, meows?: boolean, barks?: boolean } by kind to bird: Bird, fish: Fish
      the \`mapping\` beside \`Pet\`’s \`allOf\`, the unions in a closed wrapper: Pet extends Animal { id!: string, kind?: enum PetKind, meows?: boolean, barks?: boolean } by kind to bird: Bird, fish: Fish
      the \`mapping\` beside the closed inner \`allOf\`: Pet extends Animal { id!: string, kind?: enum PetKind, meows?: boolean, barks?: boolean } by kind to bird: Bird, fish: Fish
      the \`mapping\` beside \`Pet\`’s \`allOf\`, one union in a closed wrapper: Pet extends Animal { id!: string, kind?: enum PetKind, meows?: boolean, barks?: boolean } by kind to bird: Bird, fish: Fish
      the \`mapping\` beside \`Pet\`’s \`allOf\`, the other union in a closed wrapper: Pet extends Animal { id!: string, kind?: enum PetKind, meows?: boolean, barks?: boolean } by kind to bird: Bird, fish: Fish"
    `);
  });

  it('leaves a `$ref` member to a composed component as it was: a base with a model of its own, which keeps its dispatcher', async () => {
    const lines: string[] = [];
    for (const [label, pet, schemas] of [
      ['a `$ref` to a component around the union', W(Animal, ref('Wrapped')), { Wrapped: W(dunion) }],
      ['the same `$ref`, wrapped', W(Animal, W(ref('Wrapped'))), { Wrapped: W(dunion) }],
      [
        'the same `$ref`, in a closed wrapper',
        W(Animal, beside({ additionalProperties: false }, ref('Wrapped'))),
        { Wrapped: W(dunion) },
      ],
      ['a `$ref` to a component that dispatches', W(ref('Base'), extra), { Base: W(Animal, dunion) }],
      ['a `$ref` to a plain object carrying the union (#429)', W(Animal, ref('Wrapped')), { Wrapped: dunion }],
    ] as const) {
      const spec = await parseJson(document('3.1.0', pet, { schemas }));
      lines.push(`${label}: ${ownModels(spec).join(' ; ')}`);
      expectMappingsBuilt(spec, label);
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "a \`$ref\` to a component around the union: Pet extends Animal, Wrapped { id!: string } ; Wrapped {  } by kind to cat: Cat, dog: Dog
      the same \`$ref\`, wrapped: Pet extends Animal, Wrapped { id!: string } ; Wrapped {  } by kind to cat: Cat, dog: Dog
      the same \`$ref\`, in a closed wrapper: Pet extends Animal, Wrapped { id!: string } ; Wrapped {  } by kind to cat: Cat, dog: Dog
      a \`$ref\` to a component that dispatches: Pet extends Base { id!: string, extra?: string } ; Base extends Animal { id!: string } by kind to cat: Cat, dog: Dog
      a \`$ref\` to a plain object carrying the union (#429): Pet extends Animal, Wrapped { id!: string } by kind to cat: Cat, dog: Dog ; Wrapped {  } by kind to cat: Cat, dog: Dog"
    `);
    expect(warnings()).toEqual([]);
  });

  it('reads a component a `$ref` member names through its own wrappers: it dispatches, and the model naming it carries its base fields', async () => {
    const read = async (base: unknown) =>
      ownModels(await parseJson(document('3.1.0', W(ref('Base'), extra), { schemas: { Base: base } })));
    const flat = await read(W(Animal, dunion));
    expect(flat).toMatchInlineSnapshot(`
      [
        "Pet extends Base { id!: string, extra?: string }",
        "Base extends Animal { id!: string } by kind to cat: Cat, dog: Dog",
      ]
    `);
    // `Base` was `{ id }` with no dispatch, in each of these spellings.
    expect(await read(W(Animal, W(dunion)))).toEqual(flat);
    expect(await read(W(W(Animal, dunion)))).toEqual(flat);
    expect(await read(W(Animal, beside({ additionalProperties: false }, dunion)))).toEqual(flat);
    expect(warnings()).toEqual([]);
  });

  it('keeps the text and the flag of a wrapper that stays a member its own, and conjoins its limits either way', async () => {
    const annotations = { description: 'Inner.', deprecated: true, maxProperties: 4 };
    const layer = (spec: ApiSpec) => {
      const { constraints, deprecated, description } = modelOf(spec, 'Pet');
      return {
        constraints,
        deprecated,
        description,
        variants: ownModels(spec).filter((model) => model.startsWith('PetCat')),
      };
    };
    const read = async (pet: unknown) => layer(await parseJson(document('3.1.0', pet)));
    // Beside another member that declares a type the wrapper is spliced open,
    // and what it writes beside its `allOf` is the model's, as a member that
    // declares no type writes it.
    const spliced = await read(W(Animal, beside(annotations, iunion)));
    expect(spliced).toEqual(await read(W(Animal, annotations, iunion)));
    expect(spliced).toMatchInlineSnapshot(`
      {
        "constraints": {
          "maxProperties": 4,
        },
        "deprecated": true,
        "description": "Inner.",
        "variants": [
          "PetCat { id!: string, kind!: "cat", meows?: boolean } {"maxProperties":4}",
        ],
      }
    `);
    // A wrapper that stays a member — alone, or saying more than its members
    // do — types the model, so its text and flag are its own, as those of
    // `{ description, deprecated, oneOf: [...] }` written as the member are.
    const typing = await read(W(Animal, { ...annotations, ...iunion }));
    expect(typing).toMatchInlineSnapshot(`
      {
        "constraints": {
          "maxProperties": 4,
        },
        "deprecated": undefined,
        "description": undefined,
        "variants": [
          "PetCat { id!: string, kind!: "cat", meows?: boolean } {"maxProperties":4}",
        ],
      }
    `);
    expect(await read(W(beside(annotations, Animal, iunion)))).toEqual(typing);
    expect(await read(W(Animal, beside({ ...annotations, additionalProperties: false }, iunion)))).toEqual(typing);
    expect(warnings()).toEqual([]);
  });

  it('reads a pointer member that lands on a wrapper around the union as one that lands on the union', async () => {
    const schemas = {
      Holder: object({ plain: iunion, wrapped: W(iunion), closed: beside({ additionalProperties: false }, iunion) }),
    };
    const pointer = (property: string) => ({ $ref: `#/components/schemas/Holder/properties/${property}` });
    const read = async (property: string) => {
      const spec = await parseJson(document('3.1.0', W(Animal, pointer(property)), { schemas }));
      expectMappingsBuilt(spec, property);
      return ownModels(spec).filter((model) => model.startsWith('Pet'));
    };
    const plain = await read('plain');
    expect(plain).toMatchInlineSnapshot(`
      [
        "Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog",
        "PetCat { id!: string, kind!: "cat", meows?: boolean }",
        "PetDog { id!: string, kind!: "dog", barks?: boolean }",
      ]
    `);
    expect(await read('wrapped')).toEqual(plain);
    expect(await read('closed')).toEqual(plain);
  });

  it('hands the keyword beside `Pet`’s `allOf` through a pointer member, for `Pet` and for a merge that names it', async () => {
    // Greptile on #725: the merge cleared the keyword past the pointer, so
    // `Owner.merged` carried the fields of the variants `Pet` dispatches.
    const schemas = {
      Holder: object({
        plain: munion,
        wrapped: W(munion),
        closed: beside({ additionalProperties: false }, munion),
        both: beside({ additionalProperties: false }, extra, munion),
      }),
    };
    const pointer = (property: string) => ({ $ref: `#/components/schemas/Holder/properties/${property}` });
    const read = async (pet: unknown) => {
      const spec = await parseJson(document('3.1.0', pet, { schemas, sites: true }));
      expectMappingsBuilt(spec, JSON.stringify(pet));
      return ownModels(spec).filter((model) => /^(Pet|OwnerMerged|Puppy)\b/.test(model));
    };
    const written = await read({ discriminator: M, ...W(Animal, munion) });
    expect(written).toMatchInlineSnapshot(`
      [
        "Pet extends Animal { id!: string } by kind to bird: Bird, fish: Fish",
        "Puppy extends Pet { id!: string, age?: integer }",
        "OwnerMerged { id!: string, note?: string }",
      ]
    `);
    for (const property of ['plain', 'wrapped', 'closed']) {
      expect(await read({ discriminator: M, ...W(Animal, pointer(property)) }), property).toEqual(written);
      expect(await read({ discriminator: M, ...W(Animal, W(pointer(property))) }), property).toEqual(written);
      expect(await read(W(Animal, beside({ discriminator: M }, pointer(property)))), property).toEqual(written);
    }
    // A pointer to a wrapper of two members reads as the wrapper written in its place.
    expect(await read({ discriminator: M, ...W(Animal, pointer('both')) })).toEqual(
      await read({ discriminator: M, ...W(Animal, beside({ additionalProperties: false }, extra, munion)) }),
    );
    expect(warnings()).toEqual([]);
  });

  it('ends on a component that names itself inside a wrapper, and on a wrapper that holds itself', async () => {
    const self = (pet: unknown): Spelling => ['a member naming `Pet`', pet, W(Animal, Pet, iunion)];
    for (const pet of [
      W(Animal, W(Pet, iunion)),
      W(W(Animal, Pet, iunion)),
      W(Animal, beside({ additionalProperties: false }, Pet, iunion)),
      // The closed wrapper holds a pointer to itself.
      W(Animal, beside({ additionalProperties: false }, { $ref: '#/components/schemas/Pet/allOf/1' }, iunion)),
      // The pointer names a sibling wrapper the splice opened.
      W(Animal, W(iunion), { $ref: '#/components/schemas/Pet/allOf/1' }),
    ]) {
      const spec = await expectReadAsFlat('3.1.0', self(pet));
      expect(showModel(modelOf(spec, 'Pet'))).toBe(
        'Pet extends Animal { id!: string } by kind to cat: PetCat, dog: PetDog',
      );
    }
  });

  it.each(['3.0.3', '3.1.0'])(
    'reads the same two schemas inline alike, as every site flattens them, under OAS %s',
    async (openapi) => {
      const inlineSites: Record<string, (schema: unknown) => unknown> = {
        'a field': (schema) => document(openapi, object({ pet: schema })),
        'array items': (schema) => document(openapi, object({ pets: { type: 'array', items: schema } })),
        'map values': (schema) => document(openapi, object({ pets: { type: 'object', additionalProperties: schema } })),
        'a `oneOf` variant': (schema) => document(openapi, object({ pet: { oneOf: [schema, integer] } })),
        'the `200` body': (schema) => {
          const doc = document(openapi, object({}));
          doc.paths['/pets/{petId}'].get.responses['200'] = ok(schema);
          return doc;
        },
        'a request body': (schema) => {
          const doc = document(openapi, object({}));
          Object.assign(doc.paths['/pets/{petId}'].get, { requestBody: json(schema) });
          return doc;
        },
        'a webhook body': (schema) => ({
          ...document(openapi, object({})),
          webhooks: {
            petChanged: { post: { requestBody: json(schema), responses: { '200': { description: 'ok' } } } },
          },
        }),
      };
      const lines: string[] = [];
      for (const [siteName, site] of Object.entries(inlineSites)) {
        for (const [label, nested, flat] of [
          ...issueSpellings,
          [
            '`properties` beside the inner `allOf`',
            W(Animal, beside({ properties: { extra: string } }, dunion)),
            W(Animal, extra, dunion),
          ],
        ] as Spelling[]) {
          const flatSpec = await parseJson(site(flat));
          const nestedSpec = await parseJson(site(nested));
          expect(nestedSpec, `${label}, as ${siteName}`).toEqual(flatSpec);
          expect(diffSpecs(flatSpec, nestedSpec).changes, `${label}, as ${siteName}`).toEqual([]);
          expect(diffSpecs(nestedSpec, flatSpec).changes, `${label}, as ${siteName}`).toEqual([]);
          // An inline `allOf` never dispatches: the variants' fields are the merged model's, optional.
          if (label === issueSpellings[0]![0]) {
            const minted = ownModels(nestedSpec).filter((model) => !model.startsWith('Pet {'));
            lines.push(`${siteName}: ${minted.join(' ; ')}`);
          }
        }
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a field: PetPet { id!: string, kind?: enum PetPetKind, meows?: boolean, barks?: boolean }
        array items: Pets { id!: string, kind?: enum PetsKind, meows?: boolean, barks?: boolean }
        map values: Pets { id!: string, kind?: enum PetsKind, meows?: boolean, barks?: boolean }
        a \`oneOf\` variant: PetPet { id!: string, kind?: enum PetPetKind, meows?: boolean, barks?: boolean }
        the \`200\` body: GetPetResponse { id!: string, kind?: enum GetPetResponseKind, meows?: boolean, barks?: boolean }
        a request body: GetPetRequest { id!: string, kind?: enum GetPetRequestKind, meows?: boolean, barks?: boolean }
        a webhook body: PetChangedPayload { id!: string, kind?: enum PetChangedPayloadKind, meows?: boolean, barks?: boolean }"
      `);
      expect(warnings()).toEqual([]);
    },
  );

  it.each(['3.0.3', '3.1.0'])(
    'resolves a stop field every variant declares where the model dispatches through a wrapper, as it does flat, under OAS %s',
    async (openapi) => {
      const cursor = object({ kind: { type: 'string', enum: ['cursor'] }, has_more: boolean, next_after: string });
      const page = object({ kind: { type: 'string', enum: ['page'] }, has_more: boolean, next_page: integer });
      const endOfIteration = { kind: 'hasMore', path: 'meta.has_more' };
      const trace = object({ trace_id: string });
      const PetMeta = ref('PetMeta');
      const listPets = (meta: unknown) => ({
        openapi,
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [{ name: 'after', in: 'query', schema: string }],
              responses: { '200': ok(object({ data: { type: 'array', items: string }, meta: ref('Meta') })) },
              'x-pagination': { endOfIteration },
            },
          },
        },
        components: {
          schemas: {
            Base: object({ id: string }),
            // A plain object carrying the union: a model naming it as a member dispatches the union itself (#429).
            PetMeta: { ...object({ base: string }), oneOf: [cursor, page] },
            // A composed component: its dispatcher is its own model's.
            AliasMeta: W(PetMeta),
            Meta: meta,
          },
        },
      });
      const pagination = (spec: ApiSpec) => spec.services.flatMap(({ operations }) => operations)[0]!.pagination;
      const kept: Spelling[] = [
        [
          'the `$ref` and another member in a wrapper',
          W(ref('Base'), W(PetMeta, trace)),
          W(ref('Base'), PetMeta, trace),
        ],
        ['the `$ref` and another member in a lone wrapper', W(W(PetMeta, trace)), W(PetMeta, trace)],
        [
          'the `$ref` and another member in a closed wrapper',
          W(ref('Base'), beside({ additionalProperties: false }, PetMeta, trace)),
          W(ref('Base'), PetMeta, trace),
        ],
        [
          'the `$ref` in a closed wrapper beside `properties`',
          W(ref('Base'), beside({ properties: { trace_id: string } }, PetMeta, object({ x: string }))),
          W(ref('Base'), trace, PetMeta, object({ x: string })),
        ],
        [
          'the `$ref` two closed wrappers down',
          W(ref('Base'), beside({ not: string }, beside({ not: string }, PetMeta, trace), object({ x: string }))),
          W(ref('Base'), PetMeta, trace, object({ x: string })),
        ],
        [
          'the union in a closed wrapper',
          W(object({ base: string }), beside({ additionalProperties: false }, { oneOf: [cursor, page] }, trace)),
          W(object({ base: string }), { oneOf: [cursor, page] }, trace),
        ],
      ];
      for (const [label, nested, flat] of kept) {
        const flatSpec = await parseJson(listPets(flat));
        const nestedSpec = await parseJson(listPets(nested));
        expect(nestedSpec, label).toEqual(flatSpec);
        expect(pagination(nestedSpec)?.endOfIteration, label).toEqual(endOfIteration);
        expect(modelOf(nestedSpec, 'Meta').discriminator, label).toEqual({
          property: 'kind',
          mapping: { cursor: 'MetaCursor', page: 'MetaPage' },
        });
        // The variant models carry the stop field the iterator reads.
        for (const variant of ['MetaCursor', 'MetaPage']) {
          expect(
            modelOf(nestedSpec, variant).fields.map(({ name }) => name),
            label,
          ).toContain('has_more');
        }
        expect(warnings(), label).toEqual([]);
      }
      // A `$ref` to a composed component keeps its dispatcher, wrapped or
      // not: the model carries the base fields alone, and the field is none of its.
      for (const [label, meta] of [
        ['a `$ref` to a composed component', W(ref('AliasMeta'), trace)],
        ['the same `$ref`, wrapped', W(W(ref('AliasMeta')), trace)],
        [
          'the same `$ref` and another member in a closed wrapper',
          W(ref('Base'), beside({ additionalProperties: false }, ref('AliasMeta'), trace)),
        ],
      ] as const) {
        warn.mockClear();
        const spec = await parseJson(listPets(meta));
        expect(pagination(spec)?.endOfIteration, label).toBeUndefined();
        expect(modelOf(spec, 'Meta').discriminator, label).toBeUndefined();
        expect(warnings(), label).toEqual([
          expect.stringContaining('endOfIteration path "meta.has_more" does not resolve to a field'),
        ]);
      }
    },
  );
  it.each(['3.0.3', '3.1.0'])(
    'leaves a stop field to the variants a referenced component dispatches to, wherever the `mapping` it dispatches by is written around the wrapper, under OAS %s',
    async (openapi) => {
      const endOfIteration = { kind: 'hasMore', path: 'meta.has_more' };
      // The variants pin nothing: the union dispatches by the `mapping` alone.
      const byMapping = {
        propertyName: 'kind',
        mapping: { cursor: '#/components/schemas/Cursor', page: '#/components/schemas/Page' },
      };
      const pages = { oneOf: [ref('Cursor'), ref('Page')] };
      const Base = ref('Base');
      const x = object({ x: string });
      const closed = { additionalProperties: false };
      const nullable = (schema: unknown) => ({ oneOf: [schema, { type: 'null' }] });
      const listPets = (dispatcher: unknown, meta: unknown) => ({
        openapi,
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [{ name: 'after', in: 'query', schema: string }],
              responses: { '200': ok(object({ data: { type: 'array', items: string }, meta })) },
              'x-pagination': { endOfIteration },
            },
          },
        },
        components: {
          schemas: {
            Base: object({ base: string }),
            Cursor: object({ kind: string, has_more: boolean, next_after: string }),
            Page: object({ kind: string, has_more: boolean, next_page: integer }),
            MetaDispatcher: dispatcher,
            Via: W(ref('MetaDispatcher'), object({ trace_id: string })),
          },
        },
      });
      const flat = { discriminator: byMapping, ...W(Base, pages, x) };
      const dispatchers: Array<readonly [label: string, dispatcher: unknown]> = [
        ['the member written flat', flat],
        ['the union and another member in a wrapper', { discriminator: byMapping, ...W(Base, W(pages, x)) }],
        ['the same in a closed wrapper', { discriminator: byMapping, ...W(Base, beside(closed, pages, x)) }],
        [
          'two closed wrappers down',
          { discriminator: byMapping, ...W(Base, beside(closed, beside(closed, pages), x)) },
        ],
        ['every member in a lone wrapper', { discriminator: byMapping, ...W(W(Base, pages, x)) }],
        ['every member two lone wrappers down', { discriminator: byMapping, ...W(W(W(Base, pages, x))) }],
        ['the `mapping` on the lone wrapper', W(beside({ discriminator: byMapping }, Base, pages, x))],
        ['a closed wrapper in a lone wrapper', { discriminator: byMapping, ...W(W(Base, beside(closed, pages, x))) }],
        [
          'the `mapping` on a nullable wrapper around the wrapper',
          W(Base, { discriminator: byMapping, ...nullable(W(pages, x)) }),
        ],
        ['a nullable wrapper around the wrapper', { discriminator: byMapping, ...W(Base, nullable(W(pages, x))) }],
        ['a lone nullable wrapper around the wrapper', { discriminator: byMapping, ...W(nullable(W(Base, pages, x))) }],
        ['the `mapping` on the union, in a wrapper', W(Base, W({ discriminator: byMapping, ...pages }, x))],
        // Greptile on #725: the keyword of a wrapper the walk reads through on its way to the union.
        [
          'a closed wrapper around a wrapper that writes the `mapping`',
          W(Base, beside(closed, beside({ discriminator: byMapping }, pages)), x),
        ],
        [
          'two wrappers around a wrapper that writes the `mapping`',
          W(Base, beside(closed, W(beside({ discriminator: byMapping }, pages))), x),
        ],
        [
          'a nullable wrapper around a wrapper that writes the `mapping`',
          W(Base, nullable(beside({ discriminator: byMapping }, pages)), x),
        ],
        [
          'a closed wrapper around a nullable wrapper that writes the `mapping`',
          W(Base, beside(closed, { discriminator: byMapping, ...nullable(W(pages)) }), x),
        ],
      ];
      const metas: Array<readonly [site: string, meta: unknown, model: string]> = [
        ['an inline merge naming the component', W(ref('MetaDispatcher'), object({ trace_id: string })), 'Meta'],
        ['a component naming it as a base', ref('Via'), 'Via'],
      ];
      for (const [site, meta, model] of metas) {
        warn.mockClear();
        const flatSpec = await parseJson(listPets(flat, meta));
        const flatWarnings = warnings();
        for (const [label, dispatcher] of dispatchers) {
          warn.mockClear();
          const spec = await parseJson(listPets(dispatcher, meta));
          const at = `${label}, read by ${site}`;
          expect(spec, at).toEqual(flatSpec);
          // The component dispatches, so the model that names it carries the base fields alone …
          expect(modelOf(spec, 'MetaDispatcher').discriminator, at).toEqual({
            property: 'kind',
            mapping: { cursor: 'Cursor', page: 'Page' },
          });
          expect(
            modelOf(spec, model).fields.map(({ name }) => name),
            at,
          ).toEqual(['base', 'x', 'trace_id']);
          // … and the stop field is none of its: the path is reported, in every spelling.
          expect(
            spec.services.flatMap(({ operations }) => operations)[0]!.pagination?.endOfIteration,
            at,
          ).toBeUndefined();
          expect(warnings(), at).toEqual(flatWarnings);
          expect(warnings(), at).toEqual([
            expect.stringContaining('endOfIteration path "meta.has_more" does not resolve to a field'),
          ]);
        }
      }
    },
  );
  it('resolves a stop field on the union flattened beside the one a `mapping` dispatches, through the wrappers the two sit in (#718)', async () => {
    const endOfIteration = { kind: 'hasMore', path: 'meta.has_more' };
    const byMapping = {
      propertyName: 'kind',
      mapping: { cursor: '#/components/schemas/Cursor', page: '#/components/schemas/Page' },
    };
    // The keyword goes with the union its `mapping` names; the other is flattened, `has_more` with it.
    const pages = { oneOf: [ref('Cursor'), ref('Page')] };
    const counts = { oneOf: [object({ has_more: boolean, a: string }), object({ has_more: boolean, b: string })] };
    const Base = ref('Base');
    const closed = { additionalProperties: false };
    const listPets = (dispatcher: unknown, meta: unknown) => ({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'after', in: 'query', schema: string }],
            responses: { '200': ok(object({ data: { type: 'array', items: string }, meta })) },
            'x-pagination': { endOfIteration },
          },
        },
      },
      components: {
        schemas: {
          Base: object({ base: string }),
          Cursor: object({ kind: string, next_after: string }),
          Page: object({ kind: string, next_page: integer }),
          MetaDispatcher: dispatcher,
          Via: W(ref('MetaDispatcher'), object({ trace_id: string })),
        },
      },
    });
    const flat = { discriminator: byMapping, ...W(Base, pages, counts) };
    const dispatchers: Array<readonly [label: string, dispatcher: unknown]> = [
      ['the members written flat', flat],
      ['both unions in a wrapper', { discriminator: byMapping, ...W(Base, W(pages, counts)) }],
      ['both unions in a closed wrapper', { discriminator: byMapping, ...W(Base, beside(closed, pages, counts)) }],
      [
        'a closed wrapper around each union',
        { discriminator: byMapping, ...W(Base, beside(closed, pages), beside(closed, counts)) },
      ],
      ['every member in a lone wrapper', { discriminator: byMapping, ...W(W(Base, pages, counts)) }],
      ['the `mapping` on the closed wrapper', W(Base, beside({ ...closed, discriminator: byMapping }, pages, counts))],
      [
        'the `mapping` on its union, in a closed wrapper',
        W(Base, beside(closed, { discriminator: byMapping, ...pages }, counts)),
      ],
      [
        'a lone nullable wrapper around the wrapper',
        { discriminator: byMapping, ...W({ oneOf: [W(Base, pages, counts), { type: 'null' }] }) },
      ],
    ];
    for (const [site, meta, model] of [
      ['an inline merge naming the component', W(ref('MetaDispatcher'), object({ trace_id: string })), 'Meta'],
      ['a component naming it as a base', ref('Via'), 'Via'],
    ] as const) {
      const flatSpec = await parseJson(listPets(flat, meta));
      for (const [label, dispatcher] of dispatchers) {
        const spec = await parseJson(listPets(dispatcher, meta));
        const at = `${label}, read by ${site}`;
        expect(spec, at).toEqual(flatSpec);
        expect(modelOf(spec, 'MetaDispatcher').discriminator, at).toEqual({
          property: 'kind',
          mapping: { cursor: 'Cursor', page: 'Page' },
        });
        expect(
          modelOf(spec, model).fields.map(({ name }) => name),
          at,
        ).toEqual(['base', 'has_more', 'a', 'b', 'trace_id']);
        expect(spec.services.flatMap(({ operations }) => operations)[0]!.pagination?.endOfIteration, at).toEqual(
          endOfIteration,
        );
      }
    }
    expect(warnings()).toEqual([]);
  });
});
