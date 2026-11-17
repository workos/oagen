import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { readInlineAllOf, spliceNestedAllOf } from '../../src/parser/inline-models.js';
import { sourceDeclaration, type SchemaObject } from '../../src/parser/schemas.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Field, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #675: an inline `allOf` was decided by the members written on it —
 * a `$ref`, an inline object, the one member that types it
 * (`readInlineAllOf`) — so a member that was itself an `allOf` around a
 * `$ref` was neither: `{ allOf: [{ allOf: [{ $ref: Owner }] }, { $ref: Tag
 * }] }` was read as the reference to `Tag`, `Owner`'s fields lost, and with
 * both members wrapped the schema was `unknown`, though JSON Schema reads
 * `{ allOf: [{ allOf: [A] }, B] }` as it reads `{ allOf: [A, B] }`. A member
 * that is a bare `allOf` is now spliced open into its own members wherever
 * two or more members type the `allOf` (`spliceNestedAllOf`), and a wrapper
 * no splicing opens that composes an object is one of the objects the
 * `allOf` merges (`composesObjectMember`).
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
/** `{ allOf: members }`: a bare wrapper around `members`. */
const W = (...members: unknown[]) => ({ allOf: members });
/** A wrapper around `members` with `keywords` written beside its `allOf`. */
const beside = (keywords: Record<string, unknown>, ...members: unknown[]) => ({ ...keywords, allOf: members });

const string = { type: 'string' };
const integer = { type: 'integer' };
const Owner = ref('Owner');
const Tag = ref('Tag');
const text = { description: 'The owner.' };
const extra = { properties: { extra: string } };
const a = { properties: { a: string } };
const b = { properties: { b: integer } };

const petIdParam = { name: 'petId', in: 'path', required: true, schema: string };
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });

/** `Owner { name }`, `Tag { label }` and the components the spellings below name, beside `schemas`. */
const components = (openapi: string, schemas: Record<string, unknown>) => ({
  Owner: { type: 'object', properties: { name: string } },
  Tag: { type: 'object', properties: { label: string } },
  Kind: { type: 'string', enum: ['cat', 'dog'] },
  Name: { type: 'string', minLength: 1 },
  Pets: { type: 'array', items: Owner },
  Shape: { oneOf: [Owner, Tag] },
  NullableOwner:
    openapi === '3.0.3'
      ? { type: 'object', nullable: true, properties: { name: string } }
      : { type: ['object', 'null'], properties: { name: string } },
  ...schemas,
});

/** The issue's document: `GET /pets/{petId}` (`getPet`) returning `response`, with `operation` laid over the operation and `more` over the document. */
function document(
  openapi: string,
  schemas: Record<string, unknown>,
  response: unknown = Tag,
  operation: Record<string, unknown> = {},
  more: Record<string, unknown> = {},
) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [petIdParam],
          responses: { '200': { description: 'ok', ...json(response) } },
          ...operation,
        },
      },
    },
    components: { schemas: components(openapi, schemas) },
    ...more,
  };
}

/** `Pet.owner` written as `owner`, `GET /pets/{petId}` returning `Pet`. */
const petWithOwner = (openapi: string, owner: unknown, schemas: Record<string, unknown> = {}) =>
  document(openapi, { Pet: { type: 'object', properties: { owner } }, ...schemas }, ref('Pet'));

/** What one entry of a site's document adds to it: components, the `200` body, keys of the operation, a webhook. */
interface SitePart {
  schemas?: Record<string, unknown>;
  response?: unknown;
  operation?: Record<string, unknown>;
  webhook?: unknown;
}

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties });
const ok = (schema: unknown) => ({ description: 'ok', ...json(schema) });

/** Every site a schema is read at: what an entry writing `schema` there adds, its own component named `pet`. */
const sites: Record<string, (schema: unknown, pet: string) => SitePart> = {
  'a field': (schema, pet) => ({ schemas: { [pet]: object({ owner: schema }) }, response: ref(pet) }),
  'array items': (schema, pet) => ({
    schemas: { [pet]: object({ owners: { type: 'array', items: schema } }) },
    response: ref(pet),
  }),
  'map values': (schema, pet) => ({
    schemas: { [pet]: object({ owners: { type: 'object', additionalProperties: schema } }) },
    response: ref(pet),
  }),
  'a `oneOf` variant': (schema, pet) => ({
    schemas: { [pet]: object({ owner: { oneOf: [schema, integer] } }) },
    response: ref(pet),
  }),
  'an `anyOf` variant': (schema, pet) => ({
    schemas: { [pet]: object({ owner: { anyOf: [integer, schema] } }) },
    response: ref(pet),
  }),
  'a field of a merged `allOf`': (schema, pet) => ({
    schemas: { [pet]: { allOf: [Tag, { properties: { owner: schema } }] } },
    response: ref(pet),
  }),
  'the `200` body': (schema) => ({ response: schema }),
  'the items of the `200` body': (schema) => ({ response: { type: 'array', items: schema } }),
  'a `201` body': (schema) => ({ operation: { responses: { '200': ok(Tag), '201': ok(schema) } } }),
  'a `400` body': (schema) => ({ operation: { responses: { '200': ok(Tag), '400': ok(schema) } } }),
  'a `default` body': (schema) => ({ operation: { responses: { '200': ok(Tag), default: ok(schema) } } }),
  'a second media type of the `200` body': (schema) => ({
    operation: {
      responses: {
        '200': { description: 'ok', content: { 'application/json': { schema: Tag }, 'application/xml': { schema } } },
      },
    },
  }),
  'a request body': (schema) => ({ operation: { requestBody: json(schema) } }),
  'a field of an inline request body': (schema) => ({ operation: { requestBody: json(object({ owner: schema })) } }),
  'a query parameter': (schema) => ({
    operation: { parameters: [petIdParam, { name: 'filter', in: 'query', schema }] },
  }),
  'a header parameter': (schema) => ({
    operation: { parameters: [petIdParam, { name: 'X-Filter', in: 'header', schema }] },
  }),
  'a response header': (schema) => ({
    operation: { responses: { '200': { ...ok(Tag), headers: { 'X-Owner': { schema } } } } },
  }),
  'a webhook body': (schema) => ({
    webhook: { post: { requestBody: json(schema), responses: { '200': { description: 'ok' } } } },
  }),
  'a callback body': (schema) => ({
    operation: {
      callbacks: {
        onChange: {
          '{$request.query.url}': { post: { requestBody: json(schema), responses: { '200': { description: 'ok' } } } },
        },
      },
    },
  }),
};

/** One document writing each of `schemas` at `site`: entry `n` is `GET /pets<n>/{petId}` (`getPet<n>`) with the component `Pet<n>` and the webhook `petChanged<n>`. */
function siteDocument(openapi: string, site: (schema: unknown, pet: string) => SitePart, schemas: readonly unknown[]) {
  const paths: Record<string, unknown> = {};
  const own: Record<string, unknown> = {};
  const webhooks: Record<string, unknown> = {};
  schemas.forEach((schema, n) => {
    const part = site(schema, `Pet${n}`);
    Object.assign(own, part.schemas);
    paths[`/pets${n}/{petId}`] = {
      get: {
        operationId: `getPet${n}`,
        parameters: [petIdParam],
        responses: { '200': ok(part.response ?? Tag) },
        ...part.operation,
      },
    };
    if (part.webhook) webhooks[`petChanged${n}`] = part.webhook;
  });
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths,
    components: { schemas: components(openapi, own) },
    ...(Object.keys(webhooks).length > 0 && { webhooks }),
  };
}

/** A nested spelling and the flat spelling JSON Schema reads it as. */
type Spelling = readonly [label: string, nested: unknown, flat: unknown];

/** The issue's spellings, and the same members wrapped every other way. */
const refSpellings: Spelling[] = [
  ['the first member wrapped (nested.json)', W(W(Owner), Tag), W(Owner, Tag)],
  ['both members wrapped (both.json)', W(W(Owner), W(Tag)), W(Owner, Tag)],
  ['the second member wrapped', W(Owner, W(Tag)), W(Owner, Tag)],
  ['the members in the other order', W(Tag, W(Owner)), W(Tag, Owner)],
  ['two levels down', W(W(W(Owner)), Tag), W(Owner, Tag)],
  ['each member at its own depth', W(W(W(Owner)), W(W(W(Tag)))), W(Owner, Tag)],
  ['both members in one wrapper', W(W(Owner, Tag)), W(Owner, Tag)],
];

/** Wrappers around anything else an `allOf` conjoins. */
const memberSpellings: Spelling[] = [
  ['a wrapped `$ref` beside an inline object', W(W(Owner), extra), W(Owner, extra)],
  ['a `$ref` beside a wrapped inline object', W(Owner, W(extra)), W(Owner, extra)],
  ['two wrapped inline objects', W(W(a), W(b)), W(a, b)],
  ['a wrapped union beside an inline object', W(W({ oneOf: [a, b] }), extra), W({ oneOf: [a, b] }, extra)],
  ['a wrapped `$ref` beside a wrapped union', W(W(Owner), W({ oneOf: [a, b] })), W(Owner, { oneOf: [a, b] })],
  ['a wrapped `$ref` beside a wrapped description', W(W(Owner), W(text)), W(Owner, text)],
  ['a `$ref` beside a wrapped description', W(Owner, W(text)), W(Owner, text)],
  ['a wrapped `$ref` beside a wrapped limit', W(W(Owner), W({ maxProperties: 3 })), W(Owner, { maxProperties: 3 })],
  ['a wrapped primitive beside a wrapped limit', W(W(string), W({ minLength: 1 })), W(string, { minLength: 1 })],
  [
    'a wrapped enum beside a wrapped description',
    W(W({ type: 'string', enum: ['cat', 'dog'] }), W(text)),
    W({ type: 'string', enum: ['cat', 'dog'] }, text),
  ],
  ['a wrapped `$ref` to an enum', W(W(ref('Kind')), W(text)), W(ref('Kind'), text)],
  ['a wrapped `$ref` to a primitive', W(W(ref('Name')), W({ maxLength: 5 })), W(ref('Name'), { maxLength: 5 })],
  ['a wrapped `$ref` to an array', W(W(ref('Pets')), W(text)), W(ref('Pets'), text)],
  [
    'a wrapped array beside a wrapped description',
    W(W({ type: 'array', items: Owner }), W(text)),
    W({ type: 'array', items: Owner }, text),
  ],
  ['a wrapped `$ref` to a union', W(W(ref('Shape')), W(text)), W(ref('Shape'), text)],
  ['a wrapped `$ref` to a nullable component', W(W(ref('NullableOwner')), Tag), W(ref('NullableOwner'), Tag)],
];

/** What a bare `allOf` may write beside its `allOf`, each read as the flat spelling writes it. */
const keywordSpellings: Spelling[] = [
  ['a `description` beside the inner `allOf`', W(beside(text, Owner), Tag), W(text, Owner, Tag)],
  ['a `description` beside the second inner `allOf`', W(Owner, beside(text, Tag)), W(Owner, text, Tag)],
  [
    'a `description` beside both `allOf`s',
    { description: 'Outer.', ...W(beside(text, Owner), Tag) },
    { description: 'Outer.', ...W(text, Owner, Tag) },
  ],
  [
    '`deprecated` beside the inner `allOf`',
    W(beside({ deprecated: true }, Owner), Tag),
    W({ deprecated: true }, Owner, Tag),
  ],
  ['`readOnly` beside the inner `allOf`', W(beside({ readOnly: true }, Owner), Tag), W({ readOnly: true }, Owner, Tag)],
  [
    'a limit beside the inner `allOf`',
    W(beside({ minProperties: 1 }, Owner), Tag),
    W({ minProperties: 1 }, Owner, Tag),
  ],
  ['an `x-*` key beside the inner `allOf`', W(beside({ 'x-note': 'n' }, Owner), Tag), W({ 'x-note': 'n' }, Owner, Tag)],
  [
    '`required` beside the inner `allOf`',
    W(beside({ required: ['name'] }, Owner), Tag),
    { required: ['name'], ...W(Owner, Tag) },
  ],
  [
    '`required` beside a lone inner `allOf`',
    W(beside({ required: ['name'] }, Owner)),
    { required: ['name'], ...W(Owner) },
  ],
  [
    '`required` beside the `allOf`, its one member wrapped',
    { required: ['name'], ...W(W(Owner)) },
    { required: ['name'], ...W(Owner) },
  ],
  ['`required` in a member beside the wrapper', W(W(Owner), { required: ['name'] }), W(Owner, { required: ['name'] })],
  ['a `title` beside the inner `allOf`', W(beside({ title: 'Titled' }, Owner), Tag), W(Owner, Tag)],
  ['a `$comment` beside the inner `allOf`', W(beside({ $comment: 'why' }, Owner), Tag), W(Owner, Tag)],
  ['`type: object` beside the inner `allOf`', W(beside({ type: 'object' }, Owner), Tag), W(Owner, Tag)],
  [
    '`type: object` beside both inner `allOf`s',
    W(beside({ type: 'object' }, Owner), beside({ type: 'object' }, Tag)),
    W(Owner, Tag),
  ],
  [
    '`properties` beside the `allOf`',
    { properties: { id: string }, ...W(W(Owner), Tag) },
    { properties: { id: string }, ...W(Owner, Tag) },
  ],
  [
    '`properties` beside the `allOf`, its one member wrapped',
    { properties: { id: string }, ...W(W(Owner)) },
    { properties: { id: string }, ...W(Owner) },
  ],
  [
    'a `oneOf` beside the `allOf`, its one member wrapped',
    { ...W(W(Owner)), oneOf: [a, b] },
    { ...W(Owner), oneOf: [a, b] },
  ],
  [
    'a nullable `oneOf` around the `allOf`',
    { oneOf: [W(W(Owner), Tag), { type: 'null' }] },
    { oneOf: [W(Owner, Tag), { type: 'null' }] },
  ],
];

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
      return `${type.type}${limits}`;
    case 'enum':
      return `enum ${type.name}`;
    default:
      return type.name;
  }
}

/** A model as the issue's script prints it: `Pet { owner: PetOwner }`. */
const issueShow = ({ fields, name }: Model): string =>
  `${name} { ${fields
    .map((field) => {
      const type = field.type as { name?: string; type?: string; kind: string };
      return `${field.name}: ${type.name ?? type.type ?? type.kind}`;
    })
    .join(', ')} }`;

/** A model with what each field requires: `PetOwner { name!: string, label?: string }`. */
const showModel = ({ fields, name }: Model): string =>
  `${name} { ${fields.map((field) => `${field.name}${field.required ? '!' : '?'}: ${show(field.type)}`).join(', ')} }`;

describe('#675 an inline `allOf` member that is itself an `allOf` is read as its members', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-inline-allof-nested-'));
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
  const fieldOf = (spec: ApiSpec, model: string, field: string): Field =>
    modelOf(spec, model).fields.find(({ name }) => name === field)!;
  const owner = (spec: ApiSpec): Field => fieldOf(spec, 'Pet', 'owner');
  /** The models a document adds to the fixture's components. */
  const fixture = new Set(Object.keys(components('3.1.0', {})));
  const ownModels = (spec: ApiSpec): string[] => spec.models.filter(({ name }) => !fixture.has(name)).map(showModel);
  /** `Pet.owner` written as `schema`: its type, then the models the document adds. */
  const read = async (schema: unknown, openapi = '3.1.0', schemas?: Record<string, unknown>): Promise<string> => {
    const spec = await parseJson(petWithOwner(openapi, schema, schemas));
    return [show(owner(spec).type), ...ownModels(spec).filter((model) => !model.startsWith('Pet {'))].join(' ; ');
  };
  /** Each `[label, schema]` read, one `label: reading` per line. */
  const table = async (rows: ReadonlyArray<readonly [string, unknown]>, openapi = '3.1.0'): Promise<string> => {
    const lines: string[] = [];
    for (const [label, schema] of rows) lines.push(`${label}: ${await read(schema, openapi)}`);
    return lines.join('\n');
  };

  /** Parses every nested spelling and every flat twin at `site`, one document each, and expects one IR, one set of warnings and no `oagen diff` either way. */
  async function expectReadAsFlat(siteName: string, openapi: string, spellings: readonly Spelling[]) {
    const site = sites[siteName]!;
    warn.mockClear();
    const flatSpec = await parseJson(
      siteDocument(
        openapi,
        site,
        spellings.map(([, , flat]) => flat),
      ),
    );
    const flatWarnings = warnings();
    warn.mockClear();
    const nestedSpec = await parseJson(
      siteDocument(
        openapi,
        site,
        spellings.map(([, nested]) => nested),
      ),
    );
    expect(nestedSpec, siteName).toEqual(flatSpec);
    expect(warnings(), siteName).toEqual(flatWarnings);
    expect(diffSpecs(flatSpec, nestedSpec).changes, siteName).toEqual([]);
    expect(diffSpecs(nestedSpec, flatSpec).changes, siteName).toEqual([]);
  }

  it.each(['3.0.3', '3.1.0'])(
    'reads `nested.json` and `both.json` as `flat.json`: `Pet { owner: PetOwner }` with `PetOwner { name, label }` (the repro), under OAS %s',
    async (openapi) => {
      const documents: Record<string, unknown> = {
        'flat.json': petWithOwner(openapi, W(Owner, Tag)),
        'nested.json': petWithOwner(openapi, W(W(Owner), Tag)),
        'both.json': petWithOwner(openapi, W(W(Owner), W(Tag))),
        // `nested.json`'s `allOf` as `Pet` itself
        'component.json': document(openapi, { Pet: W(W(Owner), Tag) }, ref('Pet')),
      };
      const parsed: Record<string, ApiSpec> = {};
      const lines: string[] = [];
      for (const [file, doc] of Object.entries(documents)) {
        parsed[file] = await parseJson(doc);
        const pets = parsed[file]!.models.filter(({ name }) => name.startsWith('Pet') && name !== 'Pets');
        lines.push(`${file} ${JSON.stringify(pets.map(issueShow))}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "flat.json ["Pet { owner: PetOwner }","PetOwner { name: string, label: string }"]
        nested.json ["Pet { owner: PetOwner }","PetOwner { name: string, label: string }"]
        both.json ["Pet { owner: PetOwner }","PetOwner { name: string, label: string }"]
        component.json ["Pet { name: string, label: string }"]"
      `);
      // `oagen diff` between the spellings reports no change, in either direction.
      for (const from of ['flat.json', 'nested.json', 'both.json']) {
        for (const to of ['flat.json', 'nested.json', 'both.json']) {
          expect(diffSpecs(parsed[from]!, parsed[to]!).changes, `${from} → ${to}`).toEqual([]);
        }
        expect(parsed[from], from).toEqual(parsed['flat.json']);
      }
      // `both.json` was `unknown` with "Unknown schema shape treated as unknown (context: owner)".
      expect(warnings()).toEqual([]);
    },
  );

  it.each(['3.0.3', '3.1.0'])(
    'reads the same `allOf` as the `200` body as the flat one: `GetPetResponse { name, label }`, under OAS %s',
    async (openapi) => {
      const lines: string[] = [];
      const parsed: ApiSpec[] = [];
      for (const [file, body] of [
        ['body-flat.json', W(Owner, Tag)],
        ['body-nested.json', W(W(Owner), Tag)],
        ['body-both.json', W(W(Owner), W(Tag))],
      ] as const) {
        const spec = await parseJson(document(openapi, {}, body));
        parsed.push(spec);
        const [operation] = spec.services.flatMap(({ operations }) => operations);
        lines.push(`${file} ${show(operation!.response)} ; ${ownModels(spec).join(' ; ')}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "body-flat.json GetPetResponse ; GetPetResponse { name?: string, label?: string }
        body-nested.json GetPetResponse ; GetPetResponse { name?: string, label?: string }
        body-both.json GetPetResponse ; GetPetResponse { name?: string, label?: string }"
      `);
      for (const spec of parsed) {
        expect(spec).toEqual(parsed[0]);
        expect(diffSpecs(parsed[0]!, spec).changes).toEqual([]);
        expect(diffSpecs(spec, parsed[0]!).changes).toEqual([]);
      }
      expect(warnings()).toEqual([]);
    },
  );

  it('reads a `description` beside the inner `allOf` as the flat spelling writes it: the merge, documented', async () => {
    const spec = await parseJson(petWithOwner('3.1.0', W(beside(text, Owner), Tag)));
    expect(spec.models.filter(({ name }) => name.startsWith('Pet') && name !== 'Pets').map(issueShow)).toEqual([
      'Pet { owner: PetOwner }',
      'PetOwner { name: string, label: string }',
    ]);
    // The text is the schema's own where it writes none, as `{ allOf: [{ description }, { $ref: Owner }, { $ref: Tag }] }` reads it.
    expect(owner(spec).description).toBe('The owner.');
    expect(modelOf(spec, 'PetOwner').description).toBe('The owner.');
    expect(modelOf(spec, 'Owner').description).toBeUndefined();
  });

  describe.each(['3.0.3', '3.1.0'])('at every site, under OAS %s', (openapi) => {
    it.each(Object.keys(sites))('reads the wrapped `$ref`s as the flat `allOf`, as %s', async (siteName) => {
      await expectReadAsFlat(siteName, openapi, refSpellings);
    });

    it.each(Object.keys(sites))('reads a wrapper around any member as the member, as %s', async (siteName) => {
      await expectReadAsFlat(siteName, openapi, memberSpellings);
    });

    it.each(Object.keys(sites))(
      'reads what a bare `allOf` writes beside its `allOf` as the flat spelling writes it, as %s',
      async (siteName) => {
        await expectReadAsFlat(siteName, openapi, keywordSpellings);
      },
    );
  });

  it('types each spelling of the two members as the one merged model', async () => {
    expect(await table(refSpellings.map(([label, nested]) => [label, nested] as const))).toMatchInlineSnapshot(`
      "the first member wrapped (nested.json): PetOwner ; PetOwner { name?: string, label?: string }
      both members wrapped (both.json): PetOwner ; PetOwner { name?: string, label?: string }
      the second member wrapped: PetOwner ; PetOwner { name?: string, label?: string }
      the members in the other order: PetOwner ; PetOwner { label?: string, name?: string }
      two levels down: PetOwner ; PetOwner { name?: string, label?: string }
      each member at its own depth: PetOwner ; PetOwner { name?: string, label?: string }
      both members in one wrapper: PetOwner ; PetOwner { name?: string, label?: string }"
    `);
    expect(await table(memberSpellings.map(([label, nested]) => [label, nested] as const))).toMatchInlineSnapshot(`
      "a wrapped \`$ref\` beside an inline object: PetOwner ; PetOwner { name?: string, extra?: string }
      a \`$ref\` beside a wrapped inline object: PetOwner ; PetOwner { name?: string, extra?: string }
      two wrapped inline objects: PetOwner ; PetOwner { a?: string, b?: integer }
      a wrapped union beside an inline object: PetOwner ; PetOwner { a?: string, b?: integer, extra?: string }
      a wrapped \`$ref\` beside a wrapped union: PetOwner ; PetOwner { name?: string, a?: string, b?: integer }
      a wrapped \`$ref\` beside a wrapped description: Owner
      a \`$ref\` beside a wrapped description: Owner
      a wrapped \`$ref\` beside a wrapped limit: Owner
      a wrapped primitive beside a wrapped limit: string {"minLength":1}
      a wrapped enum beside a wrapped description: enum PetOwner
      a wrapped \`$ref\` to an enum: enum Kind
      a wrapped \`$ref\` to a primitive: string {"minLength":1,"maxLength":5}
      a wrapped \`$ref\` to an array: array<Owner>
      a wrapped array beside a wrapped description: array<Owner>
      a wrapped \`$ref\` to a union: Shape
      a wrapped \`$ref\` to a nullable component: PetOwner ; PetOwner { name?: string, label?: string }"
    `);
    expect(warnings()).toEqual([]);
  });

  it('keeps a lone wrapped `$ref` the reference, at any depth, with what the wrapper writes its own', async () => {
    expect(
      await table([
        ['one wrapper', W(W(Owner))],
        ['two wrappers', W(W(W(Owner)))],
        ['a description beside the wrapper', W(W(Owner), text)],
        ['a limit beside the wrapper', W(W(Owner), { maxProperties: 3 })],
        ['a description on the wrapper', W(beside(text, Owner))],
        ['`type: object` on the wrapper', W(beside({ type: 'object' }, Owner))],
        ['a wrapped `$ref` to an enum', W(W(ref('Kind')))],
        ['a wrapped `$ref` to a nullable component', W(W(ref('NullableOwner')))],
        ['a wrapped inline object', W(W(a))],
      ]),
    ).toMatchInlineSnapshot(`
      "one wrapper: Owner
      two wrappers: Owner
      a description beside the wrapper: Owner
      a limit beside the wrapper: Owner
      a description on the wrapper: Owner
      \`type: object\` on the wrapper: Owner
      a wrapped \`$ref\` to an enum: enum Kind
      a wrapped \`$ref\` to a nullable component: nullable<NullableOwner>
      a wrapped inline object: PetOwner ; PetOwner { a?: string }"
    `);
    // One member types the `allOf`, so it is read as that member, as before
    // (#555): the wrapper's own text and flag stay the member's own, as a
    // lone typing member's always did (#399, #555), and the text of a member
    // that declares no type beside it documents the field.
    const lone = await parseJson(petWithOwner('3.1.0', W(beside({ ...text, deprecated: true }, Owner))));
    expect(owner(lone)).toMatchObject({ type: { kind: 'model', name: 'Owner' } });
    expect(owner(lone).description).toBeUndefined();
    expect(owner(lone).deprecated).toBeUndefined();
    const documented = await parseJson(petWithOwner('3.1.0', W(W(Owner), text)));
    expect(owner(documented)).toMatchObject({ type: { kind: 'model', name: 'Owner' }, description: 'The owner.' });
    // It is that member beside a wrapped annotation too: the wrapper around
    // the description is read as its member, the one around the `$ref` kept.
    for (const annotation of [
      { description: 'Beside.' },
      W({ description: 'Beside.' }),
      W(W({ description: 'Beside.' })),
    ]) {
      const beside2 = await parseJson(
        petWithOwner('3.1.0', W(beside({ ...text, deprecated: true }, Owner), annotation)),
      );
      expect(owner(beside2)).toMatchObject({ type: { kind: 'model', name: 'Owner' }, description: 'Beside.' });
      expect(owner(beside2).deprecated).toBeUndefined();
    }
    expect(warnings()).toEqual([]);
  });

  it('gives the schema what a spliced wrapper writes: text, flags, extensions, limits and `required`', async () => {
    const spec = await parseJson(
      petWithOwner(
        '3.1.0',
        W(
          beside(
            { ...text, deprecated: true, readOnly: true, minProperties: 1, 'x-note': 'n', required: ['name'] },
            Owner,
          ),
          beside({ description: 'Second.', maxProperties: 5, required: ['label'] }, Tag),
        ),
      ),
    );
    expect(owner(spec)).toMatchObject({
      type: { kind: 'model', name: 'PetOwner' },
      // The first member's text, as the first of two annotating members' is.
      description: 'The owner.',
      deprecated: true,
      readOnly: true,
      constraints: { minProperties: 1, maxProperties: 5 },
      extensions: { 'x-note': 'n' },
    });
    expect(modelOf(spec, 'PetOwner')).toMatchObject({
      description: 'The owner.',
      deprecated: true,
      constraints: { minProperties: 1, maxProperties: 5 },
      extensions: { 'x-note': 'n' },
    });
    expect(showModel(modelOf(spec, 'PetOwner'))).toBe('PetOwner { name!: string, label!: string }');
    // The schema's own text wins over a wrapper's, as over an annotating member's.
    const own = await parseJson(petWithOwner('3.1.0', { description: 'Outer.', ...W(beside(text, Owner), Tag) }));
    expect(owner(own).description).toBe('Outer.');
    expect(modelOf(own, 'PetOwner').description).toBe('Outer.');
  });

  it('reads a `required` written anywhere around a wrapped `$ref` as beside the `$ref` itself', async () => {
    expect(
      await table([
        ['flat, beside the `allOf`', { required: ['name'], ...W(Owner) }],
        ['beside the `allOf`, the `$ref` wrapped', { required: ['name'], ...W(W(Owner)) }],
        ['beside the `allOf`, the `$ref` wrapped twice', { required: ['name'], ...W(W(W(Owner))) }],
        ['beside the inner `allOf`', W(beside({ required: ['name'] }, Owner))],
        ['in a member beside the wrapper', W(W(Owner), { required: ['name'] })],
        ['beside the inner `allOf`, a second `$ref` beside it', W(beside({ required: ['name'] }, Owner), Tag)],
        ['beside both inner `allOf`s', W(beside({ required: ['name'] }, Owner), beside({ required: ['label'] }, Tag))],
        [
          'beside a wrapped array, where it constrains nothing',
          { required: ['name'], ...W(W({ type: 'array', items: Owner })) },
        ],
        ['beside a wrapped `$ref` to a primitive', { required: ['name'], ...W(W(ref('Name'))) }],
        ['beside a wrapped `$ref` to an enum', { required: ['name'], ...W(W(ref('Kind'))) }],
      ]),
    ).toMatchInlineSnapshot(`
      "flat, beside the \`allOf\`: PetOwner ; PetOwner { name!: string }
      beside the \`allOf\`, the \`$ref\` wrapped: PetOwner ; PetOwner { name!: string }
      beside the \`allOf\`, the \`$ref\` wrapped twice: PetOwner ; PetOwner { name!: string }
      beside the inner \`allOf\`: PetOwner ; PetOwner { name!: string }
      in a member beside the wrapper: PetOwner ; PetOwner { name!: string }
      beside the inner \`allOf\`, a second \`$ref\` beside it: PetOwner ; PetOwner { name!: string, label?: string }
      beside both inner \`allOf\`s: PetOwner ; PetOwner { name!: string, label!: string }
      beside a wrapped array, where it constrains nothing: array<Owner>
      beside a wrapped \`$ref\` to a primitive: string {"minLength":1}
      beside a wrapped \`$ref\` to an enum: enum Kind"
    `);
  });

  it('splices a wrapper open exactly when it is a bare `allOf`; any other wrapper around a `$ref` is merged as the object it composes, never dropped', async () => {
    const nullable = { type: ['object', 'null'] };
    expect(
      await table([
        // Bare: read as its members.
        ['`title`', W(beside({ title: 'Titled' }, Owner), Tag)],
        ['`$comment`', W(beside({ $comment: 'why' }, Owner), Tag)],
        ['`xml`', W(beside({ xml: { name: 'owner' } }, Owner), Tag)],
        ['`type: object`', W(beside({ type: 'object' }, Owner), Tag)],
        ['an empty wrapper', W(W(), Owner, Tag)],
        ['an empty wrapper beside one `$ref`', W(W(), Tag)],
        // Not bare: the wrapper says more than its members do and stays a member.
        ['`type: [object, null]`', W(beside(nullable, Owner), Tag)],
        ['`type: [object, null]` on both', W(beside(nullable, Owner), beside(nullable, Tag))],
        ['`type: [object, string]`', W(beside({ type: ['object', 'string'] }, Owner), Tag)],
        ['`additionalProperties`', W(beside({ additionalProperties: false }, Owner), Tag)],
        [
          '`additionalProperties` on both',
          W(beside({ additionalProperties: false }, Owner), beside({ additionalProperties: false }, Tag)),
        ],
        ['a `discriminator`', W(beside({ discriminator: { propertyName: 'name' } }, Owner), Tag)],
        ['`not`', W(beside({ not: { required: ['x'] } }, Owner), Tag)],
        ['`properties`', W({ properties: { id: string }, ...W(Owner) }, Tag)],
        ['a `oneOf` of objects', W({ ...W(Owner), oneOf: [a, b] }, Tag)],
        ['`type: object` around a limit', W(beside({ type: 'object' }, { minProperties: 1 }), Owner)],
        // A lone wrapper is the member the `allOf` is read as, bare or not.
        ['`type: [object, null]`, lone', W(beside(nullable, Owner))],
        ['`type: [object, null]`, a description beside it', W(beside(nullable, Owner), text)],
        ['`additionalProperties`, lone', W(beside({ additionalProperties: false }, Owner))],
        ['`type: object` around a limit, lone', W(beside({ type: 'object' }, { minProperties: 1 }))],
      ]),
    ).toMatchInlineSnapshot(`
      "\`title\`: PetOwner ; PetOwner { name?: string, label?: string }
      \`$comment\`: PetOwner ; PetOwner { name?: string, label?: string }
      \`xml\`: PetOwner ; PetOwner { name?: string, label?: string }
      \`type: object\`: PetOwner ; PetOwner { name?: string, label?: string }
      an empty wrapper: PetOwner ; PetOwner { name?: string, label?: string }
      an empty wrapper beside one \`$ref\`: Tag
      \`type: [object, null]\`: PetOwner ; PetOwner { name?: string, label?: string }
      \`type: [object, null]\` on both: PetOwner ; PetOwner { name?: string, label?: string }
      \`type: [object, string]\`: PetOwner ; PetOwner { name?: string, label?: string }
      \`additionalProperties\`: PetOwner ; PetOwner { name?: string, label?: string }
      \`additionalProperties\` on both: PetOwner ; PetOwner { name?: string, label?: string }
      a \`discriminator\`: PetOwner ; PetOwner { name?: string, label?: string }
      \`not\`: PetOwner ; PetOwner { name?: string, label?: string }
      \`properties\`: PetOwner ; PetOwner { id?: string, name?: string, label?: string }
      a \`oneOf\` of objects: PetOwner ; PetOwner { name?: string, a?: string, b?: integer, label?: string }
      \`type: object\` around a limit: PetOwner ; PetOwner { name?: string }
      \`type: [object, null]\`, lone: nullable<Owner>
      \`type: [object, null]\`, a description beside it: nullable<Owner>
      \`additionalProperties\`, lone: Owner
      \`type: object\` around a limit, lone: map<unknown> {"minProperties":1}"
    `);
    expect(
      await table(
        [
          ['`nullable: true` with no `type`', W(beside({ nullable: true }, Owner), Tag)],
          ['`nullable: true` beside `type: object`', W(beside({ type: 'object', nullable: true }, Owner), Tag)],
          [
            '`nullable: true` beside `type: object`, on both',
            W(beside({ type: 'object', nullable: true }, Owner), beside({ type: 'object', nullable: true }, Tag)),
          ],
          ['`nullable: true` beside `type: object`, lone', W(beside({ type: 'object', nullable: true }, Owner))],
        ],
        '3.0.3',
      ),
    ).toMatchInlineSnapshot(`
      "\`nullable: true\` with no \`type\`: PetOwner ; PetOwner { name?: string, label?: string }
      \`nullable: true\` beside \`type: object\`: PetOwner ; PetOwner { name?: string, label?: string }
      \`nullable: true\` beside \`type: object\`, on both: PetOwner ; PetOwner { name?: string, label?: string }
      \`nullable: true\` beside \`type: object\`, lone: nullable<Owner>"
    `);
    expect(warnings()).toEqual([]);
  });

  it('ends a cycle through a wrapped `$ref` as it ends one through the `$ref` itself', async () => {
    const node = (next: unknown) =>
      document('3.1.0', { Node: { type: 'object', properties: { id: string, next } } }, ref('Node'));
    const nested = await parseJson(node(W(W(ref('Node')), W(Tag))));
    const flat = await parseJson(node(W(ref('Node'), Tag)));
    expect(nested).toEqual(flat);
    expect(nested.models.filter(({ name }) => name.startsWith('Node')).map(showModel)).toMatchInlineSnapshot(`
      [
        "Node { id?: string, next?: NodeNext }",
        "NodeNext { id?: string, next?: NodeNext, label?: string }",
      ]
    `);
    // A merge that redeclares the field it sits on is built once (#566).
    const redeclared = (wrap: (...members: unknown[]) => unknown[]) =>
      node({ allOf: [...wrap(ref('Node')), ...wrap({ properties: { next: { properties: { depth: integer } } } })] });
    const redeclaredNested = await parseJson(redeclared((...members) => [W(...members)]));
    expect(redeclaredNested).toEqual(await parseJson(redeclared((...members) => members)));
    expect(warnings()).toEqual([]);
  });

  it('reads a component written with wrapped members as the flat component', async () => {
    const pet = (schema: unknown) =>
      document('3.1.0', { Thing: schema, Pet: { type: 'object', properties: { thing: ref('Thing') } } }, ref('Pet'));
    const lines: string[] = [];
    for (const [label, nested, flat] of [
      ['a string', W(W(string), W({ minLength: 1 })), W(string, { minLength: 1 })],
      [
        'an enum',
        W(W({ type: 'string', enum: ['cat', 'dog'] }), W(text)),
        W({ type: 'string', enum: ['cat', 'dog'] }, text),
      ],
      ['an alias of an enum', W(W(ref('Kind')), W(text)), W(ref('Kind'), text)],
      ['an alias of an array', W(W(ref('Pets')), W({ maxItems: 5 })), W(ref('Pets'), { maxItems: 5 })],
      ['a schema of no type', W(W(text), W({ maxLength: 3 })), W(text, { maxLength: 3 })],
      ['a model', W(beside(text, Owner), W(Tag)), W(text, Owner, Tag)],
    ] as const) {
      const spec = await parseJson(pet(nested));
      expect(spec, label).toEqual(await parseJson(pet(flat)));
      const thing = spec.models.find(({ name }) => name === 'Thing');
      lines.push(
        `${label}: ${show(fieldOf(spec, 'Pet', 'thing').type)}${thing ? ` ; ${showModel(thing)} "${thing.description}"` : ''}`,
      );
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "a string: string {"minLength":1}
      an enum: enum Thing
      an alias of an enum: enum Kind
      an alias of an array: array<Owner> {"maxItems":5}
      a schema of no type: unknown {"maxLength":3}
      a model: Thing ; Thing { name?: string, label?: string } "The owner.""
    `);
    expect(warnings()).toEqual([]);
  });

  it.each(['3.0.3', '3.1.0'])(
    'reads the `object` copy of a type list whose `allOf` is wrappers as the flat spelling’s, on a field and on a body (#674), under OAS %s',
    async (openapi) => {
      // `Owner` and `Tag` with no `type`, as #674 writes `Owner`: their
      // `properties` say nothing of a string, so the list keeps both copies.
      const untyped = { Owner: { properties: { name: string } }, Tag: { properties: { label: string } } };
      const list = (...members: unknown[]) => ({ type: ['object', 'string'], allOf: members });
      const spellings: Spelling[] = [
        // #674 left this one `map<unknown> | string`: no reader typed the two wrappers of the `object` copy.
        ['a wrapped `$ref` beside a wrapped limit', list(W(Owner), W({ minLength: 1 })), list(Owner, { minLength: 1 })],
        ['two wrapped `$ref`s', list(W(Owner), W(Tag)), list(Owner, Tag)],
        [
          '`required` beside the list, the members one level down',
          { ...list(W(Owner, { minLength: 1 })), required: ['name'] },
          { ...list(Owner, { minLength: 1 }), required: ['name'] },
        ],
      ];
      const typeSites: Record<string, { site: (schema: unknown) => unknown; typed: (spec: ApiSpec) => TypeRef }> = {
        'a field': {
          site: (schema) => document(openapi, { ...untyped, Pet: object({ owner: schema }) }, ref('Pet')),
          typed: (spec) => owner(spec).type,
        },
        'the `200` body': {
          site: (schema) => document(openapi, untyped, schema),
          typed: (spec) => spec.services.flatMap(({ operations }) => operations)[0]!.response,
        },
        'a request body': {
          site: (schema) => document(openapi, untyped, Tag, { requestBody: json(schema) }),
          typed: (spec) => spec.services.flatMap(({ operations }) => operations)[0]!.requestBody!,
        },
      };
      const lines: string[] = [];
      for (const [siteName, { site, typed }] of Object.entries(typeSites)) {
        for (const [label, nested, flat] of spellings) {
          const nestedSpec = await parseJson(site(nested));
          const flatSpec = await parseJson(site(flat));
          expect(nestedSpec, `${label}, as ${siteName}`).toEqual(flatSpec);
          expect(diffSpecs(flatSpec, nestedSpec).changes, `${label}, as ${siteName}`).toEqual([]);
          expect(diffSpecs(nestedSpec, flatSpec).changes, `${label}, as ${siteName}`).toEqual([]);
          const minted = ownModels(nestedSpec).filter((model) => !model.startsWith('Pet {'));
          lines.push(`${label}, as ${siteName}: ${[show(typed(nestedSpec)), ...minted].join(' ; ')}`);
        }
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "a wrapped \`$ref\` beside a wrapped limit, as a field: (Owner | string) {"minLength":1}
        two wrapped \`$ref\`s, as a field: (PetOwner | string) ; PetOwner { name?: string, label?: string }
        \`required\` beside the list, the members one level down, as a field: (PetOwner | string) {"minLength":1} ; PetOwner { name!: string }
        a wrapped \`$ref\` beside a wrapped limit, as the \`200\` body: (Owner | string) {"minLength":1}
        two wrapped \`$ref\`s, as the \`200\` body: (GetPetResponse | string) ; GetPetResponse { name?: string, label?: string }
        \`required\` beside the list, the members one level down, as the \`200\` body: (GetPetResponse | string) {"minLength":1} ; GetPetResponse { name!: string }
        a wrapped \`$ref\` beside a wrapped limit, as a request body: (Owner | string) {"minLength":1}
        two wrapped \`$ref\`s, as a request body: (GetPetRequest | string) ; GetPetRequest { name?: string, label?: string }
        \`required\` beside the list, the members one level down, as a request body: (GetPetRequest | string) {"minLength":1} ; GetPetRequest { name!: string }"
      `);
      // With `Owner` typed `object`, which no string satisfies, the list is the one copy in either spelling.
      expect(await read(list(W(Owner), W({ minLength: 1 })), openapi)).toBe('Owner');
      expect(await read(list(Owner, { minLength: 1 }), openapi)).toBe('Owner');
      expect(warnings()).toEqual([]);
    },
  );

  it('follows a pointer through a wrapper to the `$ref` it holds', async () => {
    const spec = await parseJson(
      document(
        '3.1.0',
        {
          Pet: { type: 'object', properties: { owner: W(W(Owner), Tag) } },
          Other: {
            type: 'object',
            properties: {
              whole: { $ref: '#/components/schemas/Pet/properties/owner' },
              inner: { $ref: '#/components/schemas/Pet/properties/owner/allOf/0/allOf/0' },
              second: { $ref: '#/components/schemas/Pet/properties/owner/allOf/1' },
            },
          },
        },
        ref('Other'),
      ),
    );
    expect(showModel(modelOf(spec, 'Other'))).toBe('Other { whole?: PetOwner, inner?: Owner, second?: Tag }');
    expect(warnings()).toEqual([]);
  });

  it('is decided once, by the readers every site shares', () => {
    const wrappedOwner: SchemaObject = { allOf: [Owner] };
    // Two members that type the `allOf`: the wrapper is read as its members.
    expect(readInlineAllOf([wrappedOwner, Tag])).toBe('merged');
    expect(readInlineAllOf([wrappedOwner, { allOf: [Tag] }])).toBe('merged');
    expect(readInlineAllOf([{ allOf: [{ allOf: [Owner] }] }, { allOf: [{ allOf: [{ allOf: [Tag] }] }] }])).toBe(
      'merged',
    );
    expect(readInlineAllOf([Owner, { allOf: [{ description: 'd' }] }])).toBe('reference');
    // One member that types it: read as that member, as before, the wrappers
    // beside it that only annotate or limit it read as their members.
    expect(readInlineAllOf([wrappedOwner])).toBe('unwrapped');
    expect(readInlineAllOf([wrappedOwner, { description: 'd' }])).toBe('unwrapped');
    expect(readInlineAllOf([wrappedOwner, { allOf: [{ description: 'd' }] }])).toBe('unwrapped');
    expect(readInlineAllOf([{ allOf: [{ type: 'string' }] }, { allOf: [{ minLength: 1 }] }])).toBe('unwrapped');
    // A wrapper's `required` is the schema's.
    expect(
      readInlineAllOf([{ allOf: [{ properties: { a: string } }], required: ['a'] }, { allOf: [{ description: 'd' }] }]),
    ).toBe('merged');

    const flat: SchemaObject = { allOf: [Owner, Tag] };
    expect(spliceNestedAllOf(flat)).toBe(flat);
    const lone: SchemaObject = { allOf: [wrappedOwner, { description: 'd' }] };
    expect(spliceNestedAllOf(lone)).toBe(lone);
    const beyond: SchemaObject = { $ref: '#/components/schemas/Owner', allOf: [wrappedOwner, Tag] };
    expect(spliceNestedAllOf(beyond)).toBe(beyond);
    const documented: SchemaObject = { description: 'Inner.', allOf: [Owner] };
    expect(
      spliceNestedAllOf({ allOf: [documented, { allOf: [{ description: 'd' }, { allOf: [{ maxProperties: 3 }] }] }] }),
    ).toEqual({
      allOf: [documented, { description: 'd' }, { maxProperties: 3 }],
    });

    const nested: SchemaObject = {
      description: 'Outer.',
      required: ['label'],
      allOf: [
        { description: 'Inner.', minProperties: 1, title: 'T', required: ['name', 'label'], allOf: [Owner] },
        Tag,
      ],
    };
    const spliced = spliceNestedAllOf(nested);
    expect(spliced).toEqual({
      description: 'Outer.',
      required: ['label', 'name'],
      allOf: [{ description: 'Inner.', minProperties: 1 }, Owner, Tag],
    });
    // The members that are not opened are the document's own objects, and the
    // copy stands for the schema it was spliced from, the same one each time.
    expect(spliced.allOf![1]).toBe(Owner);
    expect(spliced.allOf![2]).toBe(Tag);
    expect(sourceDeclaration(spliced)).toBe(nested);
    expect(spliceNestedAllOf(nested)).toBe(spliced);
    expect(spliceNestedAllOf(spliced)).toBe(spliced);
    // The document is left as written.
    expect(nested.allOf).toHaveLength(2);
    expect(nested.required).toEqual(['label']);
  });
});
