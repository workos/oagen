import { describe, it, expect, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractSchemas, clearSchemaNameTransform } from '../../src/parser/schemas.js';
import { copyInlineEnumMeta, inlineEnumDescriptionOf, inlineEnumRef } from '../../src/parser/enum-members.js';
import {
  collectModelTypeRefs,
  collectResponseHeaders,
  collectWebhookTypeRefs,
  walkTypeRef,
} from '../../src/ir/types.js';
import type { ApiSpec, Enum, EnumRef, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #351: an enum schema's `description` is dropped. `Enum` now carries
 * it — a component enum's own, and, for an enum lifted from an inline
 * schema, that schema's, read the way the enum's `externalDocs` already is:
 * from the schema that declares the members, wherever it sits (a property,
 * a parameter, a response header, a request, response, error or secondary
 * body, a webhook parameter or payload), with a collapsed nullable or
 * single-member `allOf` wrapper's text winning over its branch's. Every site
 * lifts through `collectInlineEnumFromRef`, and the first schema lifted under
 * a name decides the text, as it decides the values and the link.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function parseDocument(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-351-'));
  dirs.push(dir);
  const file = path.join(dir, 'repro.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

function byName<T extends { name: string }>(nodes: readonly T[] | undefined, name: string): T {
  const node = nodes?.find((n) => n.name === name);
  if (!node) throw new Error(`no node named ${name} among ${(nodes ?? []).map((n) => n.name).join(', ')}`);
  return node;
}

/** `{ name, description }` of each enum, the projection the issue prints. */
const texts = (enums: readonly Enum[]) => enums.map(({ name, description }) => ({ name, description }));

const allOperations = (spec: ApiSpec): Operation[] => spec.services.flatMap((s) => s.operations);

const responses = { '204': { description: 'ok' } };

/** A minimal OpenAPI 3.1 document. */
const document = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'repro', version: '1' },
  paths,
  ...extra,
});

/** Every type reference an operation carries, each with the site it was read from. */
function operationRefs(op: Operation): TypeRef[] {
  const refs: TypeRef[] = [op.response];
  if (op.requestBody) refs.push(op.requestBody);
  for (const r of op.successResponses ?? []) refs.push(r.type);
  for (const e of op.errors) if (e.type) refs.push(e.type);
  for (const c of op.requestBodyContents ?? []) refs.push(c.type);
  for (const c of op.responseContents ?? []) refs.push(c.type);
  for (const h of collectResponseHeaders(op)) refs.push(h.type);
  for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
    refs.push(p.type);
  }
  if (op.defaultResponse?.type) refs.push(op.defaultResponse.type);
  for (const r of op.rangeResponses ?? []) if (r.type) refs.push(r.type);
  return refs;
}

/** Every enum name referenced from an operation, a model or a webhook. */
function referencedEnumNames(spec: ApiSpec): Set<string> {
  const names = new Set<string>();
  const visit = (ref: TypeRef): void => {
    walkTypeRef(ref, { enum: (r: EnumRef) => names.add(r.name) });
  };
  for (const op of allOperations(spec)) for (const ref of operationRefs(op)) visit(ref);
  for (const model of spec.models) for (const ref of collectModelTypeRefs(model)) visit(ref);
  for (const webhook of spec.webhooks ?? []) for (const ref of collectWebhookTypeRefs(webhook)) visit(ref);
  return names;
}

/**
 * Every `EnumRef` resolves to an entry of `spec.enums`, and every enum that
 * is not a component is referenced from somewhere: carrying text changes
 * nothing about which enums exist or who points at them.
 */
function expectEnumsSound(spec: ApiSpec, componentEnums: string[] = []): void {
  const declared = new Set(spec.enums.map((e) => e.name));
  const referenced = referencedEnumNames(spec);
  expect([...referenced].filter((name) => !declared.has(name))).toEqual([]);
  expect(
    spec.enums.map((e) => e.name).filter((name) => !componentEnums.includes(name) && !referenced.has(name)),
  ).toEqual([]);
}

describe('parseSpec – an enum schema description reaches the IR (issue #351)', () => {
  it("reproduces the issue: a component enum's description is the enum's, as a model's is", async () => {
    const spec = await parseDocument({
      openapi: '3.1.0',
      info: { title: 'Pets', version: '1.0.0' },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'species', in: 'query', schema: { $ref: '#/components/schemas/Species' } }],
            responses: {
              '200': {
                description: 'The pets',
                content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Species: {
            type: 'string',
            description: 'The kind of animal a pet is: `cat` or `dog`.',
            enum: ['cat', 'dog'],
          },
        },
      },
    });

    expect(spec.enums).toEqual([
      {
        name: 'Species',
        description: 'The kind of animal a pet is: `cat` or `dog`.',
        values: [
          { name: 'CAT', value: 'cat' },
          { name: 'DOG', value: 'dog' },
        ],
      },
    ]);
    expectEnumsSound(spec, ['Species']);
  });

  it('keeps blank text off the enum, and a $ref sibling text on the field alone', async () => {
    const spec = await parseDocument(
      document(
        { '/pets': { get: { operationId: 'listPets', responses } } },
        {
          components: {
            schemas: {
              Blank: { type: 'string', enum: ['a'], description: '   ' },
              Kind: { type: 'string', enum: ['dog', 'cat'], description: 'What kind of pet.' },
              Pet: {
                type: 'object',
                properties: {
                  blank: { $ref: '#/components/schemas/Blank' },
                  kind: { $ref: '#/components/schemas/Kind', description: 'Which kind this pet is.' },
                  size: { type: 'string', enum: ['s', 'l'], description: '' },
                },
              },
            },
          },
        },
      ),
    );

    expect(byName(spec.enums, 'Blank')).not.toHaveProperty('description');
    expect(byName(spec.enums, 'PetSize')).not.toHaveProperty('description');
    // A `$ref` is not followed: the component keeps its own text, the field the sibling's.
    expect(byName(spec.enums, 'Kind').description).toBe('What kind of pet.');
    expect(byName(byName(spec.models, 'Pet').fields, 'kind').description).toBe('Which kind this pet is.');
  });
});

describe('Enum.description on inline enums', () => {
  afterEach(() => {
    clearSchemaNameTransform();
  });

  it("a property enum lifts with its schema's text beside the field's own, like a component enum; one without stays bare", () => {
    const { models, enums } = extractSchemas({
      Status: { type: 'string', enum: ['active'], description: 'Whether the pet is active.' },
      Pet: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['available', 'sold'], description: 'Whether the pet can be bought.' },
          size: { type: 'string', enum: ['s', 'm', 'l'] },
          kind: { $ref: '#/components/schemas/Status' },
        },
      },
    });

    expect(texts(enums)).toEqual([
      { name: 'Status', description: 'Whether the pet is active.' },
      { name: 'PetStatus', description: 'Whether the pet can be bought.' },
      { name: 'PetSize', description: undefined },
    ]);
    expect(byName(enums, 'PetSize')).not.toHaveProperty('description');
    const fields = byName(models, 'Pet').fields;
    // The field keeps the same text: the schema is the field's.
    expect(byName(fields, 'status').description).toBe('Whether the pet can be bought.');
    // The text lives on the `Enum`, not on the field's type.
    expect(byName(fields, 'status').type).toEqual({
      kind: 'enum',
      name: 'PetStatus',
      values: ['available', 'sold'],
    });
  });

  it("lifts parameter, header, array-item, oneOf-variant and const-union enums with their schema's text", async () => {
    const spec = await parseDocument(
      document(
        {
          '/pets/{kind}': {
            get: {
              operationId: 'listPets',
              parameters: [
                {
                  name: 'kind',
                  in: 'path',
                  required: true,
                  schema: { type: 'string', enum: ['cat', 'dog'], description: 'The kind of animal.' },
                },
                {
                  name: 'species',
                  in: 'query',
                  // The Parameter Object's text is the parameter's; the schema's is the enum's.
                  description: 'Which species to list.',
                  schema: { type: 'string', enum: ['cat', 'dog'], description: 'The species of a pet.' },
                },
                {
                  name: 'X-Mode',
                  in: 'header',
                  schema: { type: 'string', enum: ['fast', 'slow'], description: 'How fast to answer.' },
                },
                {
                  name: 'session',
                  in: 'cookie',
                  schema: { type: 'string', enum: ['fresh', 'stale'], description: 'The session state.' },
                },
              ],
              responses: {
                '200': {
                  description: 'ok',
                  headers: {
                    'X-Policy': {
                      // The Header Object's text is the header's; the schema's is the enum's.
                      description: 'What to do next.',
                      schema: { type: 'string', enum: ['retry', 'stop'], description: 'The retry policy.' },
                    },
                  },
                },
              },
            },
          },
        },
        {
          components: {
            schemas: {
              Owner: { type: 'object', properties: { email: { type: 'string' } } },
              Pet: {
                type: 'object',
                properties: {
                  tags: {
                    type: 'array',
                    description: 'Tags on the pet.',
                    items: { type: 'string', enum: ['cute', 'loud'], description: 'One tag.' },
                  },
                  kind: {
                    description: 'Who looks after the pet.',
                    oneOf: [
                      { type: 'string', enum: ['stray', 'owned'], description: 'A pet without an owner record.' },
                      { $ref: '#/components/schemas/Owner' },
                    ],
                  },
                  // A union of string consts collapses into one enum: the wrapper
                  // is the schema that declares it, so its text is the enum's.
                  provider: {
                    description: 'The sign-in provider.',
                    oneOf: [{ const: 'apple' }, { const: 'github' }],
                  },
                },
              },
            },
          },
        },
      ),
    );

    expect(texts(spec.enums)).toEqual([
      { name: 'PetTags', description: 'One tag.' },
      { name: 'PetKind', description: 'A pet without an owner record.' },
      { name: 'PetProvider', description: 'The sign-in provider.' },
      { name: 'PetsKind', description: 'The kind of animal.' },
      { name: 'PetsSpecies', description: 'The species of a pet.' },
      { name: 'PetsXMode', description: 'How fast to answer.' },
      { name: 'PetsSession', description: 'The session state.' },
      { name: 'PetsXPolicy', description: 'The retry policy.' },
    ]);
    const [listPets] = allOperations(spec);
    expect(byName(listPets.queryParams, 'species').description).toBe('Which species to list.');
    expect(byName(collectResponseHeaders(listPets), 'X-Policy').description).toBe('What to do next.');
    // The array's and the union's own text is the field's, not the enum's.
    const fields = byName(spec.models, 'Pet').fields;
    expect(byName(fields, 'tags').description).toBe('Tags on the pet.');
    expect(byName(fields, 'kind').description).toBe('Who looks after the pet.');
    expectEnumsSound(spec);
  });

  it("a nullable or single-member wrapper gives its own text, and the branch's only when it has none, in every form", async () => {
    const wrapper = 'The wrapper says.';
    const member = 'The member says.';
    const values = ['a', 'b'];
    const spec = await parseDocument(
      document(
        { '/pets': { get: { operationId: 'listPets', responses } } },
        {
          components: {
            schemas: {
              Pet: {
                type: 'object',
                properties: {
                  a: { description: wrapper, oneOf: [{ type: 'string', enum: values }, { type: 'null' }] },
                  b: { description: wrapper, anyOf: [{ type: 'null' }, { type: 'string', enum: values }] },
                  c: { description: wrapper, type: ['string', 'null'], enum: values },
                  d: { description: wrapper, nullable: true, type: 'string', enum: values },
                  // A `null` member marks nullability on the same schema.
                  e: { description: wrapper, type: 'string', enum: [...values, null] },
                  // The branch documents itself and the wrapper says nothing.
                  f: { oneOf: [{ type: 'string', enum: values, description: member }, { type: 'null' }] },
                  // Both: the wrapper is the field's schema, so its text wins.
                  g: {
                    description: wrapper,
                    oneOf: [{ type: 'string', enum: values, description: member }, { type: 'null' }],
                  },
                  // A single-member allOf is unwrapped the same way.
                  h: { description: wrapper, allOf: [{ type: 'string', enum: values, description: member }] },
                  i: { allOf: [{ type: 'string', enum: values, description: member }] },
                  // Blank wrapper text is no text: the branch's counts.
                  j: {
                    description: '   ',
                    oneOf: [{ type: 'string', enum: values, description: member }, { type: 'null' }],
                  },
                },
              },
            },
          },
        },
      ),
    );

    const expected: Record<string, string> = {
      PetA: wrapper,
      PetB: wrapper,
      PetC: wrapper,
      PetD: wrapper,
      PetE: wrapper,
      PetF: member,
      PetG: wrapper,
      PetH: wrapper,
      PetI: member,
      PetJ: member,
    };
    for (const [name, text] of Object.entries(expected)) {
      expect(byName(spec.enums, name).description, name).toBe(text);
    }
    // The types are unchanged: nullable enum refs, with no text on the ref.
    const fields = byName(spec.models, 'Pet').fields;
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'j']) {
      expect(byName(fields, name).type, name).toEqual({
        kind: 'nullable',
        inner: { kind: 'enum', name: `Pet${name.toUpperCase()}`, values },
      });
    }
    // The field carries its own schema's text — the wrapper's, as written.
    expect(byName(fields, 'a').description).toBe(wrapper);
    expect(byName(fields, 'f').description).toBeUndefined();
    expectEnumsSound(spec);
  });

  it('lifts request, success, error, fallback, range and secondary-media-type body enums with their text', async () => {
    const enumOf = (values: string[], description: string) => ({ type: 'string', enum: values, description });
    const json = (schema: unknown) => ({ 'application/json': { schema } });
    const spec = await parseDocument(
      document({
        '/modes': {
          post: {
            operationId: 'createMode',
            requestBody: {
              description: 'The mode to create.',
              content: {
                ...json(enumOf(['on', 'off'], 'The requested mode.')),
                'text/csv': { schema: enumOf(['yes', 'no'], 'The mode as a flag.') },
              },
            },
            responses: {
              '200': {
                description: 'ok',
                content: {
                  ...json(enumOf(['on', 'off'], 'The mode in effect.')),
                  'application/yaml': { schema: enumOf(['yes', 'no'], 'The mode in effect, as YAML.') },
                },
              },
              '202': { description: 'queued', content: json(enumOf(['pending', 'done'], 'The queue state.')) },
              '404': { description: 'missing', content: json(enumOf(['unknown', 'gone'], 'Why the mode is missing.')) },
              '5XX': { description: 'down', content: json(enumOf(['retry', 'wait'], 'What to do while down.')) },
              default: { description: 'other', content: json(enumOf(['a', 'b'], 'The fallback outcome.')) },
            },
          },
        },
      }),
    );

    expect(texts(spec.enums)).toEqual([
      { name: 'CreateModeRequest', description: 'The requested mode.' },
      { name: 'CreateModeResponse', description: 'The mode in effect.' },
      { name: 'CreateModeResponse202', description: 'The queue state.' },
      { name: 'CreateModeError404', description: 'Why the mode is missing.' },
      { name: 'CreateModeApplicationYamlResponse', description: 'The mode in effect, as YAML.' },
      { name: 'CreateModeDefaultResponse', description: 'The fallback outcome.' },
      { name: 'CreateModeError5Xx', description: 'What to do while down.' },
      { name: 'CreateModeTextCsvRequest', description: 'The mode as a flag.' },
    ]);
    // The Request Body Object's own text is the operation's; the schema's is the enum's.
    expect(allOperations(spec)[0].requestBodyDescription).toBe('The mode to create.');
    expectEnumsSound(spec);
  });

  it("lifts a webhook's parameter and payload enums with their text", async () => {
    const spec = await parseDocument(
      document(
        { '/pets': { get: { operationId: 'listPets', responses } } },
        {
          webhooks: {
            petAdopted: {
              post: {
                parameters: [
                  {
                    name: 'X-Source',
                    in: 'header',
                    schema: { type: 'string', enum: ['app', 'web'], description: 'Where the adoption happened.' },
                  },
                ],
                requestBody: {
                  description: 'The adoption event.',
                  content: {
                    'application/json': {
                      schema: { type: 'string', enum: ['adopted', 'returned'], description: 'What happened.' },
                    },
                  },
                },
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        },
      ),
    );

    expect(texts(spec.enums)).toEqual([
      { name: 'PetAdoptedXSource', description: 'Where the adoption happened.' },
      { name: 'PetAdoptedPayload', description: 'What happened.' },
    ]);
    expect(spec.webhooks?.[0].requestBodyDescription).toBe('The adoption event.');
    expectEnumsSound(spec);
  });

  it("a single-member allOf wrapper at every site gives its text to the enum, and the member's only when it has none (Greptile)", async () => {
    const wrapped = (values: string[], wrapperText: string | undefined, memberText?: string) => ({
      ...(wrapperText !== undefined ? { description: wrapperText } : {}),
      allOf: [{ type: 'string', enum: values, ...(memberText !== undefined ? { description: memberText } : {}) }],
    });
    const json = (schema: unknown) => ({ 'application/json': { schema } });
    const spec = await parseDocument(
      document(
        {
          '/modes': {
            post: {
              operationId: 'createMode',
              parameters: [
                { name: 'kind', in: 'query', schema: wrapped(['x', 'y'], 'Wrapper kind.', 'Member kind.') },
                { name: 'X-Mode', in: 'header', schema: wrapped(['p', 'q'], undefined, 'Member mode.') },
              ],
              requestBody: {
                content: {
                  ...json(wrapped(['on', 'off'], 'Wrapper request.', 'Member request.')),
                  'text/csv': { schema: wrapped(['yes', 'no'], 'Wrapper csv.') },
                },
              },
              responses: {
                '200': {
                  description: 'ok',
                  headers: { 'X-Policy': { schema: wrapped(['retry', 'stop'], 'Wrapper policy.', 'Member policy.') } },
                  content: {
                    // Greptile's case: the body is unwrapped by the response path before it is typed.
                    ...json(wrapped(['a', 'b'], 'Wrapper', 'Member')),
                    'application/yaml': { schema: wrapped(['c', 'd'], 'Wrapper yaml.') },
                  },
                },
                '202': { description: 'queued', content: json(wrapped(['pending', 'done'], 'Wrapper 202.')) },
                '204': { description: 'empty', content: json(wrapped(['ok', 'skipped'], undefined, 'Member 204.')) },
                '404': { description: 'missing', content: json(wrapped(['unknown', 'gone'], 'Wrapper 404.')) },
                '5XX': { description: 'down', content: json(wrapped(['retry', 'wait'], 'Wrapper 5XX.')) },
                default: { description: 'other', content: json(wrapped(['e', 'f'], 'Wrapper default.')) },
              },
            },
          },
        },
        {
          webhooks: {
            petAdopted: {
              post: {
                parameters: [{ name: 'X-Source', in: 'header', schema: wrapped(['app', 'web'], 'Wrapper source.') }],
                requestBody: { content: json(wrapped(['adopted', 'returned'], 'Wrapper payload.', 'Member payload.')) },
                responses: { '200': { description: 'ok' } },
              },
            },
          },
          components: {
            schemas: {
              Pet: {
                type: 'object',
                properties: {
                  size: wrapped(['s', 'l'], 'Wrapper size.', 'Member size.'),
                  // Nested wrappers: the outermost text with content wins.
                  deep: {
                    description: 'Outer.',
                    allOf: [{ description: 'Middle.', allOf: [{ type: 'string', enum: ['u', 'v'] }] }],
                  },
                  deepBare: {
                    description: 'Outer bare.',
                    allOf: [{ allOf: [{ type: 'string', enum: ['u2', 'v2'], description: 'Inner bare.' }] }],
                  },
                  deepMiddle: {
                    allOf: [{ description: 'Middle only.', allOf: [{ type: 'string', enum: ['u3', 'v3'] }] }],
                  },
                  nullableUnder: {
                    description: 'Outer nullable.',
                    allOf: [{ oneOf: [{ type: 'string', enum: ['n1', 'n2'] }, { type: 'null' }] }],
                  },
                  // An object member's model takes the wrapper's text too, by the one wrapper rule (#352 round 3).
                  objectUnder: {
                    description: 'Outer object.',
                    allOf: [{ type: 'object', properties: { a: { type: 'string' } }, description: 'Inner object.' }],
                  },
                },
              },
            },
          },
        },
      ),
    );

    expect(texts(spec.enums)).toEqual([
      { name: 'PetSize', description: 'Wrapper size.' },
      { name: 'PetDeep', description: 'Outer.' },
      { name: 'PetDeepBare', description: 'Outer bare.' },
      { name: 'PetDeepMiddle', description: 'Middle only.' },
      { name: 'PetNullableUnder', description: 'Outer nullable.' },
      { name: 'ModesKind', description: 'Wrapper kind.' },
      { name: 'ModesXMode', description: 'Member mode.' },
      { name: 'ModesXPolicy', description: 'Wrapper policy.' },
      { name: 'CreateModeRequest', description: 'Wrapper request.' },
      { name: 'CreateModeResponse', description: 'Wrapper' },
      { name: 'CreateModeResponse202', description: 'Wrapper 202.' },
      { name: 'CreateModeResponse204', description: 'Member 204.' },
      { name: 'CreateModeError404', description: 'Wrapper 404.' },
      { name: 'CreateModeApplicationYamlResponse', description: 'Wrapper yaml.' },
      { name: 'CreateModeDefaultResponse', description: 'Wrapper default.' },
      { name: 'CreateModeError5Xx', description: 'Wrapper 5XX.' },
      { name: 'CreateModeTextCsvRequest', description: 'Wrapper csv.' },
      { name: 'PetAdoptedXSource', description: 'Wrapper source.' },
      { name: 'PetAdoptedPayload', description: 'Wrapper payload.' },
    ]);
    // The body types are the enums themselves, bare or nullable.
    const [createMode] = allOperations(spec);
    expect(createMode.response).toEqual({ kind: 'enum', name: 'CreateModeResponse', values: ['a', 'b'] });
    expect(createMode.requestBody).toEqual({ kind: 'enum', name: 'CreateModeRequest', values: ['on', 'off'] });
    expect(byName(byName(spec.models, 'Pet').fields, 'nullableUnder').type).toEqual({
      kind: 'nullable',
      inner: { kind: 'enum', name: 'PetNullableUnder', values: ['n1', 'n2'] },
    });
    // The model built from the object member documents itself by the same
    // wrapper rule as the enums above (`withWrapperDocs` in
    // `unwrappedAllOfMember`): the wrapper's text, the member's own only
    // when the wrapper has none (#352 round 3).
    expect(byName(spec.models, 'PetObjectUnder').description).toBe('Outer object.');
    expectEnumsSound(spec);
  });

  it('the first inline schema lifted under a name decides the text, as it decides the values and the link', async () => {
    const sort = (description?: string) => ({
      name: 'sort',
      in: 'query',
      schema: { type: 'string', enum: ['asc', 'desc'], ...(description ? { description } : {}) },
    });
    const twoOperations = (first: ReturnType<typeof sort>, second: ReturnType<typeof sort>) =>
      document({
        '/pets': { get: { operationId: 'listPets', parameters: [first], responses } },
        '/pets/{id}': { get: { operationId: 'getPet', parameters: [second], responses } },
      });

    const bareFirst = await parseDocument(twoOperations(sort(), sort('The sort order.')));
    expect(bareFirst.enums.map((e) => e.name)).toEqual(['PetsSort']);
    expect(bareFirst.enums[0]).not.toHaveProperty('description');

    const describedFirst = await parseDocument(twoOperations(sort('The sort order.'), sort()));
    expect(texts(describedFirst.enums)).toEqual([{ name: 'PetsSort', description: 'The sort order.' }]);

    const describedTwice = await parseDocument(twoOperations(sort('The sort order.'), sort('Ascending or not.')));
    expect(texts(describedTwice.enums)).toEqual([{ name: 'PetsSort', description: 'The sort order.' }]);
    // Both operations resolve to the one enum.
    for (const op of allOperations(describedTwice)) {
      expect(byName(op.queryParams, 'sort').type).toEqual({ kind: 'enum', name: 'PetsSort', values: ['asc', 'desc'] });
    }
  });

  it('a header enum renamed apart from a same-named one keeps its text through the rename', async () => {
    const policy = (values: string[], description: string) => ({
      'X-Policy': { schema: { type: 'string', enum: values, description } },
    });
    const spec = await parseDocument(
      document({
        '/documents': {
          get: {
            operationId: 'listDocuments',
            responses: {
              '200': { description: 'ok', headers: policy(['fast', 'slow'], 'How fast the documents came.') },
              '429': { description: 'slow down', headers: policy(['retry', 'stop'], 'Whether to try again.') },
            },
          },
        },
      }),
    );

    expect(texts(spec.enums)).toEqual([
      { name: 'DocumentsXPolicy', description: 'How fast the documents came.' },
      { name: 'DocumentsXPolicy429', description: 'Whether to try again.' },
    ]);
    expectEnumsSound(spec);
  });
});

describe('inlineEnumRef – the recorded text', () => {
  const members = [{ value: 'a' }, { value: 'b' }];

  it('keeps a string with content verbatim and drops blank or non-string text', () => {
    expect(inlineEnumDescriptionOf(inlineEnumRef('X', members, undefined, ' Leading and trailing. '))).toBe(
      ' Leading and trailing. ',
    );
    expect(inlineEnumDescriptionOf(inlineEnumRef('X', members, undefined, '   '))).toBeUndefined();
    expect(inlineEnumDescriptionOf(inlineEnumRef('X', members, undefined, 42))).toBeUndefined();
    expect(inlineEnumDescriptionOf(inlineEnumRef('X', members, undefined))).toBeUndefined();
    // A ref built any other way carries none.
    expect(inlineEnumDescriptionOf({ kind: 'enum', name: 'X', values: ['a'] })).toBeUndefined();
  });

  it('travels with a copy made through copyInlineEnumMeta', () => {
    const from = inlineEnumRef('X', members, undefined, 'The text.');
    const to: EnumRef = { kind: 'enum', name: 'X', values: ['a', 'b'] };
    copyInlineEnumMeta(from, to);
    expect(inlineEnumDescriptionOf(to)).toBe('The text.');
  });
});
