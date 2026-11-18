import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { schemaToTypeRef, unionFlaggedNullable, type SchemaObject } from '../../src/parser/schemas.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #677: OAS 3.0 `nullable: true` beside an inline `oneOf`/`anyOf` was
 * dropped. The type builder read the flag only beside a `type` and counted
 * only `null` variants in a union, so `{ oneOf: [...], nullable: true }` on
 * a field, a parameter or a body was a non-nullable union, while a `$ref`
 * to the same schema as a component was nullable — and moving the document
 * to OAS 3.1.0, where `null` is written as a variant, made those fields
 * nullable. The flag beside a union with no `type` stands for the `null`
 * variant an OAS 3.0 document cannot write, at every site that reads a
 * union: the 3.0.3 spelling and the 3.1.0 one give one IR.
 */

type Doc = Record<string, unknown>;
type Keyword = 'oneOf' | 'anyOf';
/** A union in one spelling of "admits `null`", from its non-null variants and whatever is written beside them. */
type Spelling = (variants: Doc[], beside?: Doc) => Doc;

const ref = (name: string): Doc => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown): Doc => ({ 'application/json': { schema } });
const object = (properties: Doc, required: string[] = Object.keys(properties)): Doc => ({
  type: 'object',
  required,
  properties,
});

/** OAS 3.0: `nullable: true` beside the union. */
const flagged =
  (keyword: Keyword): Spelling =>
  (variants, beside = {}) => ({ [keyword]: variants, nullable: true, ...beside });
/** OAS 3.1: a `null` variant among the union's own. */
const nullVariant =
  (keyword: Keyword): Spelling =>
  (variants, beside = {}) => ({ [keyword]: [...variants, { type: 'null' }], ...beside });

const kindEnum = (): Doc => ({ type: 'string', enum: ['cat', 'dog'] });
const stringOrInteger = (): Doc[] => [{ type: 'string' }, { type: 'integer' }];

/** Components every probe document declares beside its own. */
const shared = (): Record<string, Doc> => ({
  Owner: object({ kind: { type: 'string', enum: ['owner'] }, name: { type: 'string' } }),
  Shelter: object({ kind: { type: 'string', enum: ['shelter'] }, city: { type: 'string' } }),
  Base: object({ id: { type: 'string' } }),
  Color: { type: 'string', enum: ['red', 'blue'] },
  Names: { type: 'array', items: { type: 'string' } },
  Either: { oneOf: [ref('Owner'), ref('Shelter')] },
});

interface Pieces {
  paths?: Doc;
  schemas?: Record<string, Doc>;
  components?: Doc;
  webhooks?: Doc;
}

/** `GET /pets/{petId}` (`getPet`) answering `response`, with `more` on the operation. */
const getPet = (response: Doc, more: Doc = {}): Doc => ({
  '/pets/{petId}': {
    get: {
      operationId: 'getPet',
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK', content: json(response) } },
      ...more,
    },
  },
});
/** `GET /pets` (`listPets`) with `more` on the operation, answering `Base` unless `more` says otherwise. */
const listPets = (more: Doc): Doc => ({
  '/pets': {
    get: {
      operationId: 'listPets',
      responses: { '200': { description: 'OK', content: json(ref('Base')) } },
      ...more,
    },
  },
});
/** `POST /pets` (`createPet`) with `more` on the operation, answering `Base`. */
const createPet = (more: Doc): Doc => ({
  '/pets': {
    post: {
      operationId: 'createPet',
      responses: { '200': { description: 'OK', content: json(ref('Base')) } },
      ...more,
    },
  },
});

function document(openapi: string, pieces: Pieces): Doc {
  return {
    openapi,
    info: { title: 'Repro 677', version: '1.0.0' },
    paths: pieces.paths ?? {},
    ...(pieces.webhooks ? { webhooks: pieces.webhooks } : {}),
    components: { schemas: { ...shared(), ...pieces.schemas }, ...pieces.components },
  };
}

/**
 * Every site a union is written at: `s()` is the union under test, a fresh
 * copy per call, and `keyword` the one it is spelled with (for the sites
 * that point into it).
 */
const sites: Array<[string, (s: () => Doc, keyword: Keyword) => Pieces]> = [
  [
    'a component, and a $ref to it',
    (s) => ({ paths: getPet(ref('Pet')), schemas: { Kind: s(), Pet: object({ named: ref('Kind') }) } }),
  ],
  ['a component returned by an operation', (s) => ({ paths: getPet(ref('Kind')), schemas: { Kind: s() } })],
  [
    'an alias of the component',
    (s) => ({
      paths: getPet(ref('Pet')),
      schemas: { Kind: s(), Alias: ref('Kind'), Pet: object({ named: ref('Alias') }) },
    }),
  ],
  [
    "an array component's items",
    (s) => ({
      paths: getPet(ref('Pet')),
      schemas: { Kinds: { type: 'array', items: s() }, Pet: object({ kinds: ref('Kinds') }) },
    }),
  ],
  ['a required field', (s) => ({ paths: getPet(ref('Pet')), schemas: { Pet: object({ kind: s() }) } })],
  ['an optional field', (s) => ({ paths: getPet(ref('Pet')), schemas: { Pet: object({ kind: s() }, []) } })],
  [
    'a field beside a $ref to the same schema as a component',
    (s) => ({
      paths: getPet(ref('Pet')),
      schemas: { Kind: s(), Pet: object({ kind: s(), named: ref('Kind') }) },
    }),
  ],
  [
    "a nested object's field",
    (s) => ({ paths: getPet(ref('Pet')), schemas: { Pet: object({ owner: object({ kind: s() }) }) } }),
  ],
  [
    "an array field's items",
    (s) => ({ paths: getPet(ref('Pet')), schemas: { Pet: object({ kinds: { type: 'array', items: s() } }) } }),
  ],
  [
    "a map field's values",
    (s) => ({
      paths: getPet(ref('Pet')),
      schemas: { Pet: object({ kinds: { type: 'object', additionalProperties: s() } }) },
    }),
  ],
  [
    'the one member of an allOf',
    (s) => ({ paths: getPet(ref('Pet')), schemas: { Pet: object({ kind: { allOf: [s()] } }) } }),
  ],
  [
    'the typing member of an allOf beside one that annotates',
    (s) => ({
      paths: getPet(ref('Pet')),
      schemas: { Pet: object({ kind: { allOf: [s(), { description: 'A kind.' }] } }) },
    }),
  ],
  [
    "a member of a component's allOf",
    (s) => ({ paths: getPet(ref('Pet')), schemas: { Pet: { allOf: [ref('Base'), s()] } } }),
  ],
  [
    "a member of a field's allOf",
    (s) => ({ paths: getPet(ref('Pet')), schemas: { Pet: object({ kind: { allOf: [ref('Base'), s()] } }) } }),
  ],
  [
    'a property two allOf members declare',
    (s) => ({
      paths: getPet(ref('Pet')),
      schemas: { Pet: { allOf: [object({ kind: s() }), object({ kind: s(), other: { type: 'string' } })] } },
    }),
  ],
  [
    'a property two branches of a flattened union declare',
    (s) => ({
      paths: getPet(ref('Pet')),
      schemas: {
        Pet: { allOf: [ref('Base'), { oneOf: [object({ kind: s() }), object({ kind: { type: 'boolean' } })] }] },
      },
    }),
  ],
  [
    'a property a branch declares beside one that admits null by its type',
    (s) => ({
      paths: getPet(ref('Pet')),
      schemas: {
        Pet: {
          type: 'object',
          properties: { id: { type: 'string' } },
          anyOf: [object({ kind: s() }), object({ kind: { type: 'boolean', nullable: true } })],
        },
      },
    }),
  ],
  [
    'a variant of another union',
    (s) => ({
      paths: getPet(ref('Pet')),
      schemas: { Pet: object({ kind: { oneOf: [s(), { type: 'boolean' }] } }) },
    }),
  ],
  [
    'a JSON Pointer $ref to the field',
    (s) => ({
      paths: getPet(ref('Pet')),
      schemas: { Pet: object({ kind: s(), copy: { $ref: '#/components/schemas/Pet/properties/kind' } }) },
    }),
  ],
  [
    "a JSON Pointer $ref to the union's first variant",
    (s, keyword) => ({
      paths: getPet(ref('Pet')),
      schemas: {
        Pet: object({ kind: s(), copy: { $ref: `#/components/schemas/Pet/properties/kind/${keyword}/0` } }),
      },
    }),
  ],
  [
    "a JSON Pointer $ref to the component's first variant",
    (s, keyword) => ({
      paths: getPet(ref('Pet')),
      schemas: { Kind: s(), Pet: object({ copy: { $ref: `#/components/schemas/Kind/${keyword}/0` } }) },
    }),
  ],
  ["an inline response body's field", (s) => ({ paths: getPet(object({ kind: s() })) })],
  ['a response body', (s) => ({ paths: getPet(s()) })],
  ["a response body's array items", (s) => ({ paths: getPet({ type: 'array', items: s() }) })],
  [
    'a second success response',
    (s) => ({
      paths: getPet(ref('Base'), {
        responses: {
          '200': { description: 'OK', content: json(ref('Base')) },
          '201': { description: 'Created', content: json(s()) },
        },
      }),
    }),
  ],
  [
    'an error body',
    (s) => ({
      paths: getPet(ref('Base'), {
        responses: {
          '200': { description: 'OK', content: json(ref('Base')) },
          '404': { description: 'Missing', content: json(s()) },
        },
      }),
    }),
  ],
  [
    "an error body's field",
    (s) => ({
      paths: getPet(ref('Base'), {
        responses: {
          '200': { description: 'OK', content: json(ref('Base')) },
          '404': { description: 'Missing', content: json(object({ kind: s() })) },
        },
      }),
    }),
  ],
  [
    'the default response',
    (s) => ({
      paths: getPet(ref('Base'), {
        responses: {
          '200': { description: 'OK', content: json(ref('Base')) },
          default: { description: 'Other', content: json(s()) },
        },
      }),
    }),
  ],
  [
    'a second response media type',
    (s) => ({
      paths: listPets({
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: ref('Base') }, 'application/xml': { schema: s() } },
          },
        },
      }),
    }),
  ],
  [
    'a component response',
    (s) => ({
      paths: listPets({ responses: { '200': { $ref: '#/components/responses/Pets' } } }),
      components: { responses: { Pets: { description: 'OK', content: json(s()) } } },
    }),
  ],
  [
    'a response header',
    (s) => ({
      paths: listPets({
        responses: {
          '200': { description: 'OK', headers: { 'X-Kind': { schema: s() } }, content: json(ref('Base')) },
        },
      }),
    }),
  ],
  ['a query parameter', (s) => ({ paths: listPets({ parameters: [{ name: 'kind', in: 'query', schema: s() }] }) })],
  ['a header parameter', (s) => ({ paths: listPets({ parameters: [{ name: 'X-Kind', in: 'header', schema: s() }] }) })],
  ['a cookie parameter', (s) => ({ paths: listPets({ parameters: [{ name: 'kind', in: 'cookie', schema: s() }] }) })],
  [
    "a parameter's content",
    (s) => ({ paths: listPets({ parameters: [{ name: 'kind', in: 'query', content: json(s()) }] }) }),
  ],
  [
    'a component parameter',
    (s) => ({
      paths: listPets({ parameters: [{ $ref: '#/components/parameters/Kind' }] }),
      components: { parameters: { Kind: { name: 'kind', in: 'query', schema: s() } } },
    }),
  ],
  ['a request body', (s) => ({ paths: createPet({ requestBody: { required: true, content: json(s()) } }) })],
  [
    "a request body's field",
    (s) => ({ paths: createPet({ requestBody: { required: true, content: json(object({ kind: s() })) } }) }),
  ],
  [
    'a second request media type',
    (s) => ({
      paths: createPet({
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('Base') }, 'application/xml': { schema: s() } },
        },
      }),
    }),
  ],
  [
    'a component request body',
    (s) => ({
      paths: createPet({ requestBody: { $ref: '#/components/requestBodies/NewPet' } }),
      components: { requestBodies: { NewPet: { required: true, content: json(s()) } } },
    }),
  ],
  [
    "a list envelope's items",
    (s) => ({
      paths: listPets({
        parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            content: json(
              object({ data: { type: 'array', items: s() }, list_metadata: object({ after: { type: 'string' } }) }),
            ),
          },
        },
      }),
    }),
  ],
  [
    'a webhook payload',
    (s) => ({
      paths: getPet(ref('Base')),
      webhooks: {
        petChanged: {
          post: {
            operationId: 'petChanged',
            requestBody: { content: json(s()) },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    }),
  ],
  [
    "a callback payload's field",
    (s) => ({
      paths: createPet({
        requestBody: { required: true, content: json(ref('Base')) },
        callbacks: {
          onChange: {
            '{$request.body#/url}': {
              post: {
                operationId: 'petChangedCallback',
                requestBody: { content: json(object({ kind: s() })) },
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        },
      }),
    }),
  ],
];

/** The variant lists probed at every site; `wrap` spells a nested union as the outer one is spelled. */
const variantSets: Array<[string, (wrap: Spelling) => Doc[]]> = [
  ['one inline enum', () => [kindEnum()]],
  ['two primitives', () => stringOrInteger()],
  ['one $ref to an object', () => [ref('Owner')]],
  ['two inline objects', () => [object({ a: { type: 'string' } }), object({ b: { type: 'integer' } })]],
  ['string consts', () => [{ const: 'a' }, { const: 'b' }]],
  ['a variant that is itself such a union', (wrap) => [wrap(stringOrInteger()), { type: 'boolean' }]],
];

const show = (type: TypeRef | undefined): string => {
  if (type === undefined) return 'none';
  switch (type.kind) {
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'union':
      return `union<${type.variants.map(show).join(' | ')}>`;
    case 'array':
      return `array<${show(type.items)}>`;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'literal':
      return JSON.stringify(type.value);
    case 'model':
    case 'enum':
      return type.name;
    case 'primitive':
      return type.type;
  }
};

/** What `oagen diff` compares and an emitter reads: everything but the document's own title and version. */
const ir = ({ models, enums, services, webhooks }: ApiSpec) => ({ models, enums, services, webhooks });

describe('#677 OAS 3.0 nullable: true beside an inline oneOf/anyOf', () => {
  let tmpDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-677-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** The parsed document and the warnings parsing it printed. */
  async function parseJson(doc: unknown): Promise<ApiSpec & { warnings: string[] }> {
    const specFile = path.join(tmpDir, `spec-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    warn.mockClear();
    const spec = await parseSpec(specFile);
    return { ...spec, warnings: warn.mock.calls.map((call: unknown[]) => call.join(' ')) };
  }

  const model = (spec: ApiSpec, name: string): Model => {
    const found = spec.models.find((m) => m.name === name);
    expect(found, name).toBeDefined();
    return found!;
  };
  const fields = (spec: ApiSpec, name: string): string =>
    model(spec, name)
      .fields.map((field) => `${field.name}${field.required ? '' : '?'}: ${show(field.type)}`)
      .join(', ');
  const operation = (spec: ApiSpec, name: string): Operation => {
    const found = spec.services.flatMap((service) => service.operations).find((op) => op.name === name);
    expect(found, name).toBeDefined();
    return found!;
  };

  /** `oagen diff` between two parsed documents: its changes, and the exit code the CLI gives. */
  function diffOf(before: ApiSpec, after: ApiSpec): { changes: unknown[]; exit: number } {
    const { changes, behaviorChanges, summary } = diffSpecs(before, after);
    const exit = summary.breaking > 0 ? 2 : summary.modified > 0 || summary.removed > 0 || summary.added > 0 ? 1 : 0;
    return { changes: [...changes, ...behaviorChanges], exit };
  }

  /** Both spellings parse to one IR, with the same warnings, and `oagen diff` between them reports nothing either way. */
  async function expectOneReading(label: string, older: Doc, newer: Doc): Promise<ApiSpec> {
    const before = await parseJson(older);
    const after = await parseJson(newer);
    expect(ir(before), label).toEqual(ir(after));
    expect(before.warnings, label).toEqual(after.warnings);
    expect(diffOf(before, after), label).toEqual({ changes: [], exit: 0 });
    expect(diffOf(after, before), label).toEqual({ changes: [], exit: 0 });
    return before;
  }

  describe("the issue's documents", () => {
    /** `old.json` (OAS 3.0.3, the flag) or `new.json` (OAS 3.1.0, a `null` variant), the properties in `order`. */
    function issueDocument(openapi: '3.0.3' | '3.1.0', order: string[] = ['kind', 'named', 'tag']): Doc {
      const nullable = openapi === '3.0.3' ? flagged('oneOf') : nullVariant('oneOf');
      const properties: Record<string, Doc> = {
        kind: nullable([kindEnum()]),
        named: ref('Kind'),
        tag: nullable(stringOrInteger()),
      };
      const pet = {
        type: 'object',
        required: ['kind', 'named', 'tag'],
        properties: Object.fromEntries(order.map((name) => [name, properties[name]])),
      };
      const kind = nullable([kindEnum()]);
      return {
        openapi,
        info: { title: 'Repro 677', version: '1.0.0' },
        paths: getPet(ref('Pet')),
        // The reversed order declares `Pet` before `Kind` too.
        components: { schemas: order[0] === 'kind' ? { Kind: kind, Pet: pet } : { Pet: pet, Kind: kind } },
      };
    }

    it('old.json reads kind and tag as nullable, as new.json does and as named is', async () => {
      const old = await parseJson(issueDocument('3.0.3'));
      const fresh = await parseJson(issueDocument('3.1.0'));
      expect(fields(old, 'Pet')).toMatchInlineSnapshot(
        `"kind: nullable<PetKind>, named: nullable<Kind>, tag: nullable<union<string | integer>>"`,
      );
      expect(fields(fresh, 'Pet')).toBe(fields(old, 'Pet'));
      // `kind` is the enum under `nullable`, not a union of one under it.
      expect(model(old, 'Pet').fields[0]!.type).toEqual({
        kind: 'nullable',
        inner: { kind: 'enum', name: 'PetKind', values: ['cat', 'dog'] },
      });
      expect(model(old, 'Pet').fields[2]!.type).toMatchInlineSnapshot(`
        {
          "inner": {
            "compositionKind": "oneOf",
            "kind": "union",
            "variants": [
              {
                "kind": "primitive",
                "type": "string",
              },
              {
                "kind": "primitive",
                "type": "integer",
              },
            ],
          },
          "kind": "nullable",
        }
      `);
      expect(ir(old)).toEqual(ir(fresh));
      expect(old.warnings).toEqual([]);
    });

    it('oagen diff between old.json and new.json exits 0, in either direction', async () => {
      const old = await parseJson(issueDocument('3.0.3'));
      const fresh = await parseJson(issueDocument('3.1.0'));
      expect(diffOf(old, fresh)).toEqual({ changes: [], exit: 0 });
      expect(diffOf(fresh, old)).toEqual({ changes: [], exit: 0 });
    });

    it('reads the same types whatever order the document declares them in', async () => {
      const old = await parseJson(issueDocument('3.0.3'));
      const reversed = await parseJson(issueDocument('3.0.3', ['tag', 'named', 'kind']));
      expect(fields(reversed, 'Pet')).toMatchInlineSnapshot(
        `"tag: nullable<union<string | integer>>, named: nullable<Kind>, kind: nullable<PetKind>"`,
      );
      expect(reversed.enums).toEqual(old.enums);
      await expectOneReading(
        'reversed',
        issueDocument('3.0.3', ['tag', 'named', 'kind']),
        issueDocument('3.1.0', ['tag', 'named', 'kind']),
      );
    });

    it('a query parameter, an inline response body field and a body written the same way are nullable too', async () => {
      const sitesDocument = (openapi: string, nullable: Spelling): Doc => ({
        openapi,
        info: { title: 'Repro 677 sites', version: '1.0.0' },
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [
                { name: 'kind', in: 'query', schema: nullable([kindEnum()]) },
                { name: 'tag', in: 'query', schema: nullable(stringOrInteger()) },
              ],
              responses: {
                '200': {
                  description: 'OK',
                  content: json(object({ kind: nullable([kindEnum()]), tag: nullable(stringOrInteger()) })),
                },
              },
            },
          },
          '/tags': {
            post: {
              operationId: 'createTag',
              requestBody: { required: true, content: json(nullable(stringOrInteger())) },
              responses: { '200': { description: 'OK', content: json(nullable(stringOrInteger())) } },
            },
          },
        },
      });
      const old = await expectOneReading(
        'sites',
        sitesDocument('3.0.3', flagged('oneOf')),
        sitesDocument('3.1.0', nullVariant('oneOf')),
      );
      const list = operation(old, 'listPets');
      const create = operation(old, 'createTag');
      expect({
        queryParams: list.queryParams.map(({ name, type }) => `${name}: ${show(type)}`).join(', '),
        responseModel: fields(old, 'ListPetsResponse'),
        requestBody: show(create.requestBody),
        response: show(create.response),
      }).toMatchInlineSnapshot(`
        {
          "queryParams": "kind: nullable<PetsKind>, tag: nullable<union<string | integer>>",
          "requestBody": "nullable<union<string | integer>>",
          "response": "nullable<union<string | integer>>",
          "responseModel": "kind: nullable<ListPetsResponseKind>, tag: nullable<union<string | integer>>",
        }
      `);
    });
  });

  describe.each(['oneOf', 'anyOf'] as const)('the flag beside %s is the null variant at every site', (keyword) => {
    it.each(sites)('%s', async (_, site) => {
      for (const [setName, variants] of variantSets) {
        const flag = flagged(keyword);
        const nul = nullVariant(keyword);
        // The 3.0.3 document against the 3.1.0 one, as the issue moves it.
        await expectOneReading(
          setName,
          document(
            '3.0.3',
            site(() => flag(variants(flag)), keyword),
          ),
          document(
            '3.1.0',
            site(() => nul(variants(nul)), keyword),
          ),
        );
      }
    });
  });

  describe('the shapes a flagged union takes', () => {
    /** `Pet.<name>` typed from each property written in `properties`, in an OAS 3.0.3 document. */
    async function petFields(properties: Record<string, Doc>, schemas: Record<string, Doc> = {}): Promise<string[]> {
      const spec = await parseJson(
        document('3.0.3', { paths: getPet(ref('Pet')), schemas: { ...schemas, Pet: object(properties) } }),
      );
      return model(spec, 'Pet').fields.map((field) => `${field.name}: ${show(field.type)}`);
    }

    it('wraps a union of several variants and collapses a union of one, whatever the one variant is', async () => {
      expect(
        await petFields({
          two: flagged('oneOf')(stringOrInteger()),
          any: flagged('anyOf')(stringOrInteger()),
          refs: flagged('oneOf')([ref('Owner'), ref('Shelter')]),
          primitive: flagged('oneOf')([{ type: 'string' }]),
          inlineEnum: flagged('anyOf')([kindEnum()]),
          object: flagged('oneOf')([object({ a: { type: 'string' } })]),
          array: flagged('oneOf')([{ type: 'array', items: { type: 'string' } }]),
          map: flagged('oneOf')([{ type: 'object', additionalProperties: { type: 'integer' } }]),
          model: flagged('oneOf')([ref('Owner')]),
          enumRef: flagged('oneOf')([ref('Color')]),
          arrayRef: flagged('oneOf')([ref('Names')]),
          unionRef: flagged('oneOf')([ref('Either')]),
          literal: flagged('oneOf')([{ const: 'a' }]),
          consts: flagged('oneOf')([{ const: 'a' }, { const: 'b' }]),
        }),
      ).toMatchInlineSnapshot(`
        [
          "two: nullable<union<string | integer>>",
          "any: nullable<union<string | integer>>",
          "refs: nullable<union<Owner | Shelter>>",
          "primitive: nullable<string>",
          "inlineEnum: nullable<PetInlineEnum>",
          "object: nullable<PetObject>",
          "array: nullable<array<string>>",
          "map: nullable<map<integer>>",
          "model: nullable<Owner>",
          "enumRef: nullable<Color>",
          "arrayRef: nullable<array<string>>",
          "unionRef: nullable<Either>",
          "literal: nullable<"a">",
          "consts: nullable<PetConsts>",
        ]
      `);
    });

    it('does not wrap twice: a null variant beside the flag, a nullable variant, a flagged union under a flagged union', async () => {
      const both = flagged('oneOf')([...stringOrInteger(), { type: 'null' }]);
      const bothOne = flagged('oneOf')([kindEnum(), { type: 'null' }]);
      const nested = flagged('oneOf')([flagged('oneOf')(stringOrInteger())]);
      const nestedOne = flagged('oneOf')([flagged('anyOf')([kindEnum()])]);
      const nullableVariant = flagged('oneOf')([{ type: 'string', nullable: true }]);
      const nullableRef = flagged('oneOf')([ref('Kind')]);
      expect(
        await petFields(
          { both, bothOne, nested, nestedOne, nullableVariant, nullableRef },
          { Kind: flagged('oneOf')([kindEnum()]) },
        ),
      ).toMatchInlineSnapshot(`
        [
          "both: nullable<union<string | integer>>",
          "bothOne: nullable<PetBothOne>",
          "nested: nullable<union<string | integer>>",
          "nestedOne: nullable<PetNestedOne>",
          "nullableVariant: nullable<string>",
          "nullableRef: nullable<Kind>",
        ]
      `);
      // The same six with a `null` variant in the flag's place, and with both.
      await expectOneReading(
        'no double wrap',
        document('3.0.3', {
          paths: getPet(ref('Pet')),
          schemas: { Pet: object({ both, bothOne }) },
        }),
        document('3.1.0', {
          paths: getPet(ref('Pet')),
          schemas: {
            Pet: object({
              both: nullVariant('oneOf')(stringOrInteger()),
              bothOne: nullVariant('oneOf')([kindEnum()]),
            }),
          },
        }),
      );
    });

    it('nullable: false, or no flag, leaves the union what it was: a union of one stays a union of one', async () => {
      expect(
        await petFields({
          off: { oneOf: [kindEnum()], nullable: false },
          none: { oneOf: [kindEnum()] },
          offTwo: { anyOf: stringOrInteger(), nullable: false },
        }),
      ).toMatchInlineSnapshot(`
        [
          "off: union<PetOff>",
          "none: union<PetNone>",
          "offTwo: union<string | integer>",
        ]
      `);
    });

    it('keeps the discriminator and its mapping, entry for entry', async () => {
      const mapping = { owner: '#/components/schemas/Owner', shelter: '#/components/schemas/Shelter' };
      const explicit = { discriminator: { propertyName: 'kind', mapping } };
      const derived = { discriminator: { propertyName: 'kind' } };
      const refs = (): Doc[] => [ref('Owner'), ref('Shelter')];
      const spec = await expectOneReading(
        'discriminator',
        document('3.0.3', {
          paths: getPet(ref('Pet')),
          schemas: {
            Pet: object({
              explicit: flagged('oneOf')(refs(), explicit),
              derived: flagged('oneOf')(refs(), derived),
              implicit: flagged('oneOf')(refs()),
              plain: { oneOf: refs(), ...explicit },
            }),
          },
        }),
        document('3.1.0', {
          paths: getPet(ref('Pet')),
          schemas: {
            Pet: object({
              explicit: nullVariant('oneOf')(refs(), explicit),
              derived: nullVariant('oneOf')(refs(), derived),
              implicit: nullVariant('oneOf')(refs()),
              plain: { oneOf: refs(), ...explicit },
            }),
          },
        }),
      );
      const [first, second, third, plain] = model(spec, 'Pet').fields.map((field) => field.type);
      const union = {
        kind: 'union',
        variants: [
          { kind: 'model', name: 'Owner' },
          { kind: 'model', name: 'Shelter' },
        ],
      };
      const discriminator = { property: 'kind', mapping: { owner: 'Owner', shelter: 'Shelter' } };
      expect(plain).toEqual({ ...union, compositionKind: 'oneOf', discriminator });
      // The flagged union is the unflagged one under `nullable`, the mapping untouched.
      for (const type of [first, second, third]) expect(type).toEqual({ kind: 'nullable', inner: plain });
    });

    it('reads a flagged oneOf/anyOf of string consts as the nullable enum, as the component is — an enum: list beside it or not', async () => {
      const consts = (): Doc[] => [{ const: 'a' }, { const: 'b' }];
      const listed = { enum: ['a'] };
      const spec = await parseJson(
        document('3.0.3', {
          paths: getPet(ref('Pet')),
          schemas: {
            Status: flagged('oneOf')(consts()),
            Listed: flagged('oneOf')(consts(), listed),
            Pet: object({
              status: ref('Status'),
              inlineStatus: flagged('oneOf')(consts()),
              listed: ref('Listed'),
              inlineListed: flagged('oneOf')(consts(), listed),
              // A `null` variant, which the list forbids, is no flag.
              forbidden: { oneOf: [...consts(), { type: 'null' }], ...listed },
            }),
          },
        }),
      );
      expect(fields(spec, 'Pet')).toMatchInlineSnapshot(
        `"status: nullable<Status>, inlineStatus: nullable<PetInlineStatus>, listed: nullable<Listed>, inlineListed: nullable<PetInlineListed>, forbidden: PetForbidden"`,
      );
      expect(spec.enums.map(({ name, values }) => `${name}: ${values.map((v) => v.value).join(' | ')}`))
        .toMatchInlineSnapshot(`
          [
            "Color: red | blue",
            "Status: a | b",
            "Listed: a",
            "PetInlineStatus: a | b",
            "PetInlineListed: a",
            "PetForbidden: a",
          ]
        `);
    });

    it('reads the flag beside a union and an allOf that types the schema as the null variant there is read: the wrapper, collapsed to a member', async () => {
      const variant = (): Doc => object({ a: { type: 'string' } });
      const spec = await expectOneReading(
        'beside a typing allOf',
        document('3.0.3', {
          paths: getPet(ref('Pet')),
          schemas: {
            Composed: { allOf: [ref('Base')], ...flagged('oneOf')([variant()]) },
            WithProperties: { properties: { shared: { type: 'string' } }, ...flagged('oneOf')([variant()]) },
            Pet: object({
              composed: ref('Composed'),
              inline: { allOf: [ref('Base')], ...flagged('oneOf')([variant()]) },
              // No flag: a union of one, flattened, its variant's fields optional.
              unflagged: { allOf: [ref('Base')], oneOf: [variant()] },
            }),
          },
        }),
        document('3.1.0', {
          paths: getPet(ref('Pet')),
          schemas: {
            Composed: { allOf: [ref('Base')], ...nullVariant('oneOf')([variant()]) },
            WithProperties: { properties: { shared: { type: 'string' } }, ...nullVariant('oneOf')([variant()]) },
            Pet: object({
              composed: ref('Composed'),
              inline: { allOf: [ref('Base')], ...nullVariant('oneOf')([variant()]) },
              unflagged: { allOf: [ref('Base')], oneOf: [variant()] },
            }),
          },
        }),
      );
      expect(spec.models.map((m) => `${m.name} { ${fields(spec, m.name)} }`)).toMatchInlineSnapshot(`
        [
          "Owner { kind: "owner", name: string }",
          "Shelter { kind: "shelter", city: string }",
          "Base { id: string }",
          "Either {  }",
          "Composed { id: string, a: string }",
          "WithProperties { shared?: string, a: string }",
          "Pet { composed: Composed, inline: PetInline, unflagged: PetUnflagged }",
          "PetInline { id: string, a: string }",
          "PetUnflagged { id: string, a?: string }",
        ]
      `);
    });

    it('reads the flag beside an annotating allOf, a description, limits and a default as the wrapper they sit on', async () => {
      const beside: Array<[string, Doc]> = [
        ['a description', { description: 'A kind.' }],
        ['deprecated', { deprecated: true }],
        ['a title', { title: 'Kindly' }],
        ['limits', { minLength: 2 }],
        ['a default', { default: 'cat' }],
        ['an extension', { 'x-internal': true }],
        ['an annotating allOf', { allOf: [{ description: 'From the layer.' }] }],
        ['properties', { properties: { shared: { type: 'string' } } }],
        ['the other keyword', { anyOf: [{ minLength: 1 }, { maxLength: 9 }] }],
      ];
      for (const [label, extra] of beside) {
        for (const variants of [() => [kindEnum()], stringOrInteger, () => [object({ a: { type: 'string' } })]]) {
          const pieces = (nullable: Spelling): Pieces => ({
            paths: {
              ...getPet(ref('Pet')),
              ...listPets({ parameters: [{ name: 'kind', in: 'query', schema: nullable(variants(), extra) }] }),
            },
            schemas: {
              Kind: nullable(variants(), extra),
              Pet: object({ kind: nullable(variants(), extra), named: ref('Kind') }),
            },
          });
          await expectOneReading(
            label,
            document('3.0.3', pieces(flagged('oneOf'))),
            document('3.1.0', pieces(nullVariant('oneOf'))),
          );
        }
      }
    });

    it('a component that is a flagged union is what the null-variant spelling makes it: a primitive or array component, an alias, the nullable object or named union', async () => {
      const components = (nullable: Spelling): Record<string, Doc> => ({
        Text: nullable([{ type: 'string' }]),
        Thing: nullable([object({ a: { type: 'string' } })]),
        List: nullable([{ type: 'array', items: { type: 'string' } }]),
        Shade: nullable([ref('Color')]),
        NameList: nullable([ref('Names')]),
        Keeper: nullable([ref('Owner')]),
        Pair: nullable([ref('Owner'), ref('Shelter')]),
      });
      const pieces = (nullable: Spelling): Pieces => ({
        paths: getPet(ref('Pet')),
        schemas: {
          ...components(nullable),
          Pet: object(Object.fromEntries(Object.keys(components(nullable)).map((name) => [name, ref(name)]))),
        },
      });
      const spec = await expectOneReading(
        'components',
        document('3.0.3', pieces(flagged('oneOf'))),
        document('3.1.0', pieces(nullVariant('oneOf'))),
      );
      expect(model(spec, 'Pet').fields.map((field) => `${field.name}: ${show(field.type)}`)).toMatchInlineSnapshot(`
        [
          "Text: nullable<string>",
          "Thing: nullable<Thing>",
          "List: nullable<array<string>>",
          "Shade: nullable<Color>",
          "NameList: nullable<array<string>>",
          "Keeper: nullable<Keeper>",
          "Pair: nullable<Pair>",
        ]
      `);
      // A primitive component, an array component, and aliases of an enum and of an array build no model;
      // a `$ref` to an object keeps the named union of one it is with a `null` variant.
      expect(spec.models.map((m) => `${m.name}${m.variants ? ` = ${m.variants.map(show).join(' | ')}` : ''}`))
        .toMatchInlineSnapshot(`
          [
            "Owner",
            "Shelter",
            "Base",
            "Either = Owner | Shelter",
            "Thing",
            "Keeper = Owner",
            "Pair = Owner | Shelter",
            "Pet",
          ]
        `);
    });

    it('a declaration that writes properties beside the flagged union keeps its null where two allOf members declare it', async () => {
      const declared = (nullable: Spelling): Doc =>
        nullable(stringOrInteger(), { properties: { shared: { type: 'string' } } });
      const pieces = (nullable: Spelling): Pieces => ({
        paths: getPet(ref('Pet')),
        schemas: {
          Pet: {
            allOf: [
              object({ kind: declared(nullable) }),
              object({ kind: declared(nullable), other: { type: 'string' } }),
            ],
          },
        },
      });
      const spec = await expectOneReading(
        'conjunction',
        document('3.0.3', pieces(flagged('oneOf'))),
        document('3.1.0', pieces(nullVariant('oneOf'))),
      );
      expect(fields(spec, 'Pet')).toMatchInlineSnapshot(`"kind: nullable<union<string | integer>>, other: string"`);
    });

    it('left as it was: a variant of another union that writes properties beside its own union is the object they declare, the flag its own', async () => {
      const pieces = (nullable: Spelling): Pieces => ({
        paths: getPet(ref('Pet')),
        schemas: {
          Pet: object({
            kind: {
              oneOf: [nullable(stringOrInteger(), { properties: { shared: { type: 'string' } } }), { type: 'boolean' }],
            },
          }),
        },
      });
      const withFlag = await parseJson(document('3.0.3', pieces(flagged('oneOf'))));
      const withVariant = await parseJson(document('3.1.0', pieces(nullVariant('oneOf'))));
      // The variant's own union is read in neither spelling: `PetKind` is `{ shared }` alone.
      expect([fields(withFlag, 'Pet'), fields(withFlag, 'PetKind')]).toMatchInlineSnapshot(`
        [
          "kind: union<nullable<PetKind> | boolean>",
          "shared?: string",
        ]
      `);
      expect([fields(withVariant, 'Pet'), fields(withVariant, 'PetKind')]).toMatchInlineSnapshot(`
        [
          "kind: union<PetKind | boolean>",
          "shared?: string",
        ]
      `);
    });

    it('a request body: a nullable union of its variants, a nullable wrapper around one, and no object folded from a flagged discriminated union', async () => {
      const tagged = (tag: string, extra: Doc): Doc => object({ object: { type: 'string', enum: [tag] }, ...extra });
      const bodies: Record<string, (nullable: Spelling) => Doc> = {
        refs: (nullable) => nullable([ref('Owner'), ref('Shelter')]),
        objects: (nullable) => nullable([object({ a: { type: 'string' } }), object({ b: { type: 'integer' } })]),
        oneObject: (nullable) => nullable([object({ a: { type: 'string' } })]),
        oneRef: (nullable) => nullable([ref('Owner')]),
        discriminated: (nullable) =>
          nullable([tagged('pet', { name: { type: 'string' } }), tagged('toy', { price: { type: 'integer' } })], {
            discriminator: { propertyName: 'object' },
          }),
      };
      const read: Record<string, string> = {};
      for (const [name, body] of Object.entries(bodies)) {
        const pieces = (nullable: Spelling): Pieces => ({
          paths: createPet({ requestBody: { required: true, content: json(body(nullable)) } }),
        });
        const spec = await expectOneReading(
          name,
          document('3.0.3', pieces(flagged('oneOf'))),
          document('3.1.0', pieces(nullVariant('oneOf'))),
        );
        read[name] = show(operation(spec, 'createPet').requestBody);
      }
      expect(read).toMatchInlineSnapshot(`
        {
          "discriminated": "nullable<union<CreatePetRequest | CreatePetRequestWithPrice>>",
          "objects": "nullable<union<CreatePetRequest | CreatePetRequestWithB>>",
          "oneObject": "nullable<union<CreatePetRequest>>",
          "oneRef": "nullable<Owner>",
          "refs": "nullable<union<Owner | Shelter>>",
        }
      `);
      // Without the flag the discriminated body still folds to the one object.
      const unflagged = await parseJson(
        document('3.0.3', {
          paths: createPet({
            requestBody: {
              required: true,
              content: json({
                oneOf: [tagged('pet', { name: { type: 'string' } }), tagged('toy', { price: { type: 'integer' } })],
                discriminator: { propertyName: 'object' },
              }),
            },
          }),
        }),
      );
      expect(show(operation(unflagged, 'createPet').requestBody)).toBe('CreatePetRequest');
    });

    it('a discriminator pin written as a flagged union of consts admits null in the request-body fold, as the variant field does', async () => {
      // `kind` pins `cat`: a union of consts an `enum:` list narrows to one member, nullable in each spelling.
      const pins: Record<string, Doc> = {
        flagged: { oneOf: [{ const: 'cat' }, { const: 'lion' }], enum: ['cat'], nullable: true },
        nullVariant: { oneOf: [{ const: 'cat' }, { const: 'lion' }, { type: 'null' }], enum: ['cat', null] },
        // Neither: the list forbids the `null` variant, and no flag stands for one.
        forbidden: { oneOf: [{ const: 'cat' }, { const: 'lion' }, { type: 'null' }], enum: ['cat'] },
        plain: { oneOf: [{ const: 'cat' }, { const: 'lion' }], enum: ['cat'] },
      };
      const read: Record<string, string> = {};
      for (const [name, kind] of Object.entries(pins)) {
        const cat = (): Doc => object({ kind: structuredClone(kind), lives: { type: 'integer' } });
        const dog = (): Doc => object({ kind: { type: 'string', enum: ['dog'] }, barks: { type: 'boolean' } });
        const spec = await parseJson(
          document('3.0.3', {
            paths: createPet({
              requestBody: {
                required: true,
                content: json({ oneOf: [cat(), dog()], discriminator: { propertyName: 'kind' } }),
              },
            }),
            schemas: { Cat: cat(), Dog: dog() },
          }),
        );
        // The variant's own field beside the field the fold rebuilds from every variant's pin.
        const variantField = model(spec, 'Cat').fields[0]!.type;
        const folded = model(spec, 'CreatePetRequest').fields[0]!.type;
        expect(folded.kind === 'nullable', name).toBe(variantField.kind === 'nullable');
        read[name] = `Cat.kind: ${show(variantField)}, CreatePetRequest.kind: ${show(folded)}`;
      }
      expect(read).toMatchInlineSnapshot(`
        {
          "flagged": "Cat.kind: nullable<CatKind>, CreatePetRequest.kind: nullable<CreatePetRequestKind>",
          "forbidden": "Cat.kind: CatKind, CreatePetRequest.kind: CreatePetRequestKind",
          "nullVariant": "Cat.kind: nullable<CatKind>, CreatePetRequest.kind: nullable<CreatePetRequestKind>",
          "plain": "Cat.kind: CatKind, CreatePetRequest.kind: CreatePetRequestKind",
        }
      `);
    });

    it('a response that wraps one resource is nullable when the flag stands beside its oneOf', async () => {
      const resource = (): Doc => object({ object: { type: 'string', enum: ['pet'] }, name: { type: 'string' } });
      const pieces = (nullable: Spelling): Pieces => ({ paths: getPet(object({ pet: nullable([resource()]) })) });
      const spec = await expectOneReading(
        'wrapped resource',
        document('3.0.3', pieces(flagged('oneOf'))),
        document('3.1.0', pieces(nullVariant('oneOf'))),
      );
      expect(show(operation(spec, 'getPet').response)).toMatchInlineSnapshot(`"nullable<GetPet>"`);
      const unflagged = await parseJson(document('3.0.3', { paths: getPet(object({ pet: { oneOf: [resource()] } })) }));
      expect(show(operation(unflagged, 'getPet').response)).toMatchInlineSnapshot(`"GetPet"`);
    });

    it('a JSON Pointer into a flagged wrapper reads its one variant whole, as one into the null-variant wrapper does', async () => {
      const pieces = (nullable: Spelling): Pieces => ({
        paths: getPet(ref('Pet')),
        schemas: {
          Pet: object({
            either: nullable([ref('Either')]),
            nested: nullable([{ oneOf: stringOrInteger() }]),
            copyEither: { $ref: '#/components/schemas/Pet/properties/either/oneOf/0' },
            copyNested: { $ref: '#/components/schemas/Pet/properties/nested/oneOf/0' },
          }),
        },
      });
      const spec = await expectOneReading(
        'pointer',
        document('3.0.3', pieces(flagged('oneOf'))),
        document('3.1.0', pieces(nullVariant('oneOf'))),
      );
      expect(fields(spec, 'Pet')).toMatchInlineSnapshot(
        `"either: nullable<Either>, nested: nullable<union<string | integer>>, copyEither: Either, copyNested: union<string | integer>"`,
      );
    });

    it('beside a type the flag is read with the type, as type: [T, "null"] is, and the union stays the one it is', async () => {
      const typedFlag = (type: string, variants: Doc[]): Doc => ({ type, nullable: true, oneOf: variants });
      const typeList = (type: string, variants: Doc[]): Doc => ({ type: [type, 'null'], oneOf: variants });
      const pieces = (typed: (type: string, variants: Doc[]) => Doc): Pieces => ({
        paths: {
          ...getPet(ref('Pet')),
          ...listPets({ parameters: [{ name: 'tag', in: 'query', schema: typed('string', stringOrInteger()) }] }),
        },
        schemas: {
          Pet: object({
            kind: typed('string', [kindEnum()]),
            tag: typed('string', stringOrInteger()),
            owner: typed('object', [ref('Owner'), ref('Shelter')]),
          }),
        },
      });
      const spec = await expectOneReading(
        'typed',
        document('3.0.3', pieces(typedFlag)),
        document('3.1.0', pieces(typeList)),
      );
      expect(fields(spec, 'Pet')).toMatchInlineSnapshot(
        `"kind: nullable<union<PetKind>>, tag: nullable<union<string | integer>>, owner: nullable<union<Owner | Shelter>>"`,
      );
    });

    it('beside an allOf alone, a union of bare limits, or a schema with neither a type nor a union, the flag still declares nothing', async () => {
      expect(
        await petFields({
          allOf: { allOf: [ref('Owner')], nullable: true },
          properties: { properties: { a: { type: 'string' } }, nullable: true },
          empty: { nullable: true },
          // A `oneOf`/`anyOf` of bare limits types nothing: the schema is its own keywords.
          limited: {
            properties: { a: { type: 'string' } },
            anyOf: [{ required: ['a'] }, { maxProperties: 1 }],
            nullable: true,
          },
          items: { items: { type: 'string' }, oneOf: [{ minItems: 1 }, { maxItems: 9 }], nullable: true },
        }),
      ).toMatchInlineSnapshot(`
        [
          "allOf: Owner",
          "properties: PetProperty",
          "empty: unknown",
          "limited: PetLimited",
          "items: array<string>",
        ]
      `);
    });

    it('reads the flag in an OAS 3.1 document as in a 3.0 one, as the component and the flag beside a type are read there', async () => {
      const pieces = (nullable: Spelling): Pieces => ({
        paths: getPet(ref('Pet')),
        schemas: {
          Kind: nullable([kindEnum()]),
          Tag: nullable(stringOrInteger()),
          Pet: object({
            kind: nullable([kindEnum()]),
            named: ref('Kind'),
            tag: nullable(stringOrInteger()),
            tagged: ref('Tag'),
            typed: { type: 'string', nullable: true },
          }),
        },
      });
      const flaggedIn31 = await parseJson(document('3.1.0', pieces(flagged('oneOf'))));
      const flaggedIn30 = await parseJson(document('3.0.3', pieces(flagged('oneOf'))));
      expect(fields(flaggedIn31, 'Pet')).toMatchInlineSnapshot(
        `"kind: nullable<PetKind>, named: nullable<Kind>, tag: nullable<union<string | integer>>, tagged: nullable<Tag>, typed: nullable<string>"`,
      );
      expect(ir(flaggedIn31)).toEqual(ir(flaggedIn30));
    });
  });

  describe('the type builder itself', () => {
    it('unionFlaggedNullable: the flag beside a union that types the schema, and no type', () => {
      expect(unionFlaggedNullable({ oneOf: [{ type: 'string' }], nullable: true })).toBe(true);
      expect(unionFlaggedNullable({ anyOf: [{ type: 'string' }, { type: 'integer' }], nullable: true })).toBe(true);
      expect(unionFlaggedNullable({ oneOf: [{ type: 'string' }] })).toBe(false);
      expect(unionFlaggedNullable({ oneOf: [{ type: 'string' }], nullable: false })).toBe(false);
      expect(unionFlaggedNullable({ type: 'string', oneOf: [{ type: 'string' }], nullable: true })).toBe(false);
      expect(unionFlaggedNullable({ allOf: [{ type: 'string' }], nullable: true })).toBe(false);
      expect(unionFlaggedNullable({ nullable: true })).toBe(false);
      // A union of bare limits types nothing, so the flag stands for no variant of it.
      expect(unionFlaggedNullable({ anyOf: [{ minLength: 1 }, { maxLength: 9 }], nullable: true })).toBe(false);
      expect(unionFlaggedNullable({ oneOf: [], nullable: true })).toBe(false);
      // Either keyword that types the schema makes it one.
      expect(unionFlaggedNullable({ oneOf: [{ minLength: 1 }], anyOf: [{ type: 'string' }], nullable: true })).toBe(
        true,
      );
    });

    it('schemaToTypeRef types a flagged union as the null variant types it', () => {
      const pairs: Array<[SchemaObject, SchemaObject]> = [
        [
          { oneOf: [{ type: 'string' }, { type: 'integer' }], nullable: true },
          { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] },
        ],
        [
          { anyOf: [{ type: 'string' }, { type: 'integer' }], nullable: true },
          { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] },
        ],
        [{ oneOf: [{ type: 'string' }], nullable: true }, { oneOf: [{ type: 'string' }, { type: 'null' }] }],
        [
          { oneOf: [{ type: 'array', items: { type: 'string' } }], nullable: true, minItems: 1 },
          { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }], minItems: 1 },
        ],
      ];
      for (const [flag, variant] of pairs) expect(schemaToTypeRef(flag)).toEqual(schemaToTypeRef(variant));
      expect(schemaToTypeRef({ oneOf: [{ type: 'string' }, { type: 'integer' }], nullable: true })).toEqual({
        kind: 'nullable',
        inner: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [
            { kind: 'primitive', type: 'string' },
            { kind: 'primitive', type: 'integer' },
          ],
        },
      });
      expect(schemaToTypeRef({ oneOf: [{ type: 'string' }], nullable: true })).toEqual({
        kind: 'nullable',
        inner: { kind: 'primitive', type: 'string' },
      });
    });
  });
});
