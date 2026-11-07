import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffCommand } from '../../src/cli/diff.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { isContestedTitle, markContestedTitles } from '../../src/parser/inline-models.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * Issue #601: a `content` or `headers` written beside a `$ref` — in a
 * response, a request body, a parameter or a header — is ignored for
 * typing (#574), but `schemaRootsOf` still read the schemas under it, so a
 * titled union there contested a title with a component's variant of
 * another shape (`markContestedTitles`): the component's variant was
 * renamed (`Tag` → `TagPetCollar`) and `oagen diff` reported that as
 * breaking. A Reference Object is now stepped over whole, as the readers
 * step over it, at every site that takes one.
 */

type Doc = Record<string, unknown>;

const str: SchemaObject = { type: 'string' };
/** A titled object variant pinning `kind` to one value beside one string field. */
const variant = (title: string, kind: string, field: string): SchemaObject => ({
  type: 'object',
  title,
  properties: { kind: { type: 'string', enum: [kind] }, [field]: str },
});
/** The issue's `Pet`: a `collar` that is a `oneOf` of `Tag` and `Chip`. */
const petSchema = (): SchemaObject => ({
  type: 'object',
  properties: { id: str, collar: { oneOf: [variant('Tag', 'tag', 'text'), variant('Chip', 'chip', 'code')] } },
});
/** The issue's `content`: `Pet` extended with a `note` whose `Tag` has another shape than the collar's. */
const noteSchema = (): SchemaObject => ({
  allOf: [
    { $ref: '#/components/schemas/Pet' },
    {
      type: 'object',
      properties: { note: { oneOf: [variant('Tag', 'note', 'body'), variant('Sticker', 'sticker', 'color')] } },
    },
  ],
});
const noteContent = (schema: SchemaObject = noteSchema()) => ({ 'application/json': { schema } });

const petIdParam = { name: 'petId', in: 'path', required: true, schema: str };
const petResponse = () => ({
  description: 'ok',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
});
const filterBody = { content: { 'application/json': { schema: { type: 'object', properties: { q: str } } } } };
const limitParam = { name: 'limit', in: 'query', schema: { type: 'integer' } };
const rateHeader = { schema: str };

/** The issue's document: `getPet` returning `Pet` for `200`, with `operation` merged over it and `components` beside `Pet`. */
function document(openapi: string, operation: Doc, components: Doc = {}): Doc {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets/{petId}': {
        get: { operationId: 'getPet', parameters: [petIdParam], responses: { '200': petResponse() }, ...operation },
      },
    },
    components: { schemas: { Pet: petSchema() }, ...components },
  };
}

interface Site {
  label: string;
  /** What the document writes beside the `$ref`: the issue's `content`, or a `headers` map typed from the same schema. */
  beside: Doc;
  /** The document with the `$ref` bare, or with `beside` written beside it. */
  document: (openapi: string, beside: Doc | undefined) => Doc;
}

const content = { content: noteContent() };
const headers = { headers: { 'X-Note': { schema: noteSchema() } } };

const sites: Site[] = [
  {
    label:
      "the issue's `404` `$ref` into `components/schemas`, which resolves to no response, with `content` beside it",
    beside: content,
    document: (openapi, beside) =>
      document(openapi, {
        responses: { '200': petResponse(), '404': { $ref: '#/components/schemas/Pet', ...beside } },
      }),
  },
  {
    label: 'a `404` `$ref` into `components/responses`, which resolves, with `content` beside it',
    beside: content,
    document: (openapi, beside) =>
      document(
        openapi,
        { responses: { '200': petResponse(), '404': { $ref: '#/components/responses/PetMissing', ...beside } } },
        { responses: { PetMissing: { description: 'missing' } } },
      ),
  },
  {
    label: 'a `404` `$ref` into `components/responses`, which resolves, with `headers` beside it',
    beside: headers,
    document: (openapi, beside) =>
      document(
        openapi,
        { responses: { '200': petResponse(), '404': { $ref: '#/components/responses/PetMissing', ...beside } } },
        { responses: { PetMissing: { description: 'missing' } } },
      ),
  },
  {
    label: 'a `requestBody` `$ref` into `components/requestBodies`, with `content` beside it',
    beside: content,
    document: (openapi, beside) =>
      document(
        openapi,
        { requestBody: { $ref: '#/components/requestBodies/Filter', ...beside } },
        { requestBodies: { Filter: filterBody } },
      ),
  },
  {
    label: "a `parameters` entry's `$ref` into `components/parameters`, with `content` beside it",
    beside: content,
    document: (openapi, beside) =>
      document(
        openapi,
        { parameters: [petIdParam, { $ref: '#/components/parameters/Limit', ...beside }] },
        { parameters: { Limit: limitParam } },
      ),
  },
  {
    label: "a response header's `$ref` into `components/headers`, with `content` beside it",
    beside: content,
    document: (openapi, beside) =>
      document(
        openapi,
        {
          responses: {
            '200': { ...petResponse(), headers: { 'X-Rate': { $ref: '#/components/headers/XRate', ...beside } } },
          },
        },
        { headers: { XRate: rateHeader } },
      ),
  },
  {
    label: "a webhook operation's `requestBody` `$ref`, with `content` beside it",
    beside: content,
    document: (openapi, beside) => ({
      ...document(openapi, {}, { requestBodies: { Filter: filterBody } }),
      webhooks: {
        petAdopted: {
          post: {
            requestBody: { $ref: '#/components/requestBodies/Filter', ...beside },
            responses: { '204': { description: 'acknowledged' } },
          },
        },
      },
    }),
  },
  {
    label: "a callback operation's `requestBody` `$ref`, with `content` beside it",
    beside: content,
    document: (openapi, beside) =>
      document(
        openapi,
        {
          callbacks: {
            onNote: {
              '{$request.query.url}': {
                post: {
                  requestBody: { $ref: '#/components/requestBodies/Filter', ...beside },
                  responses: { '204': { description: 'acknowledged' } },
                },
              },
            },
          },
        },
        { requestBodies: { Filter: filterBody } },
      ),
  },
];

/** Each change as the issue's script prints it. */
const changesOf = ({ changes }: ReturnType<typeof diffSpecs>): string[] =>
  changes.map((change) => {
    const { classification, kind, name, operationName } = change as typeof change & {
      name?: string;
      operationName?: string;
    };
    return `${kind} ${name ?? operationName} (${classification})`;
  });
/** Each model with its fields, so a renamed variant and a retyped reference both show. */
const modelsOf = (spec: ApiSpec): string[] =>
  spec.models.map(
    ({ fields, name }) => `${name} { ${fields.map((f) => `${f.name}: ${JSON.stringify(f.type)}`).join(', ')} }`,
  );

describe('#601', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-601-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    // The unresolved `404` ref warns, and `diffCommand` prints its report.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Write `doc` under `name` and parse it. */
  async function parse(name: string, doc: Doc): Promise<{ file: string; spec: ApiSpec }> {
    const file = path.join(dir, `${name}.json`);
    await fs.writeFile(file, JSON.stringify(doc));
    return { file, spec: await parseSpec(file) };
  }

  describe.each(['3.0.3', '3.1.0'])('OAS %s', (openapi) => {
    it("the issue's repro: `new.json` gives the same models as `old.json`, and the diff is empty", async () => {
      const site = sites[0]!;
      const { spec: old } = await parse(`issue-old-${openapi}`, site.document(openapi, undefined));
      const { spec: next } = await parse(`issue-new-${openapi}`, site.document(openapi, site.beside));
      expect(old.models.map(({ name }) => name)).toEqual(['Pet', 'Tag', 'Chip']);
      expect(next.models.map(({ name }) => name)).toEqual(['Pet', 'Tag', 'Chip']);
      expect(modelsOf(next)).toEqual(modelsOf(old));
      expect(changesOf(diffSpecs(old, next))).toEqual([]);
      // What #574 decided stands: the `content` beside the `$ref` types no body.
      const error = next.services[0]!.operations[0]!.errors.find(({ statusCode }) => statusCode === 404);
      expect(error).toBeDefined();
      expect(error!.type).toBeUndefined();
    });

    describe.each(sites.map((site, index) => ({ ...site, index })))('$label', ({ beside, document: build, index }) => {
      it('types the same models as without it, and `oagen diff` finds no change (exit 0)', async () => {
        const { file: oldFile, spec: old } = await parse(`old-${openapi}-${index}`, build(openapi, undefined));
        const { file: newFile, spec: next } = await parse(`new-${openapi}-${index}`, build(openapi, beside));
        // The component's own variants keep their titles on both sides.
        expect(old.models.map(({ name }) => name)).toEqual(expect.arrayContaining(['Pet', 'Tag', 'Chip']));
        expect(modelsOf(next)).toEqual(modelsOf(old));
        expect(next.enums.map(({ name }) => name)).toEqual(old.enums.map(({ name }) => name));
        expect(diffSpecs(old, next).changes).toEqual([]);
        const err: unknown = await diffCommand({ old: oldFile, new: newFile }).catch((e: unknown) => e);
        expect((err as { exitCode?: number }).exitCode).toBe(0);
      });
    });
  });

  describe('markContestedTitles steps over an object written as a `$ref` whole', () => {
    /** The marks on the collar's `Tag` and the note's `Tag` after marking the document `build` makes around `Pet`, the issue's `content` and a `headers` map from it. */
    const marks = (build: (content: Doc, headers: Doc, schema: SchemaObject) => Doc): boolean[] => {
      const pet = petSchema();
      const schema = noteSchema();
      const doc = build(noteContent(schema), { 'X-Note': { schema } }, schema);
      const components = (doc['components'] as Doc | undefined) ?? {};
      doc['components'] = { ...components, schemas: { ...(components['schemas'] as Doc | undefined), Pet: pet } };
      markContestedTitles(doc);
      const collarTag = (pet.properties!['collar'] as SchemaObject).oneOf![0]!;
      const noteTag = ((schema.allOf![1] as SchemaObject).properties!['note'] as SchemaObject).oneOf![0]!;
      return [isContestedTitle(collarTag), isContestedTitle(noteTag)];
    };
    const getOp = (op: Doc): Doc => ({ paths: { '/pets': { get: { responses: { '200': petResponse() }, ...op } } } });
    const okBody = { responses: { '204': { description: 'acknowledged' } } };

    it.each<{ label: string; build: (content: Doc, headers: Doc, schema: SchemaObject) => Doc }>([
      {
        label: 'a response `$ref` that resolves to nothing, `content` beside it',
        build: (content) => getOp({ responses: { '404': { $ref: '#/components/schemas/Pet', content } } }),
      },
      {
        label: 'a response `$ref` into `components/responses`, `content` beside it',
        build: (content) => ({
          ...getOp({ responses: { '404': { $ref: '#/components/responses/Missing', content } } }),
          components: { responses: { Missing: { description: 'missing' } } },
        }),
      },
      {
        label: 'a response `$ref` into `components/responses`, `headers` beside it',
        build: (_content, headers) => ({
          ...getOp({ responses: { '404': { $ref: '#/components/responses/Missing', headers } } }),
          components: { responses: { Missing: { description: 'missing' } } },
        }),
      },
      {
        label: 'a `requestBody` `$ref`, `content` beside it',
        build: (content) => ({
          ...getOp({ requestBody: { $ref: '#/components/requestBodies/Filter', content } }),
          components: { requestBodies: { Filter: filterBody } },
        }),
      },
      {
        label: "an operation parameter's `$ref`, `content` beside it",
        build: (content) => ({
          ...getOp({ parameters: [{ $ref: '#/components/parameters/Limit', content }] }),
          components: { parameters: { Limit: limitParam } },
        }),
      },
      {
        label: "a path item parameter's `$ref`, `content` beside it",
        build: (content) => ({
          paths: {
            '/pets': {
              parameters: [{ $ref: '#/components/parameters/Limit', content }],
              get: { responses: { '200': petResponse() } },
            },
          },
          components: { parameters: { Limit: limitParam } },
        }),
      },
      {
        label: "a response header's `$ref`, `content` beside it",
        build: (content) => ({
          ...getOp({
            responses: {
              '200': { ...petResponse(), headers: { 'X-Rate': { $ref: '#/components/headers/XRate', content } } },
            },
          }),
          components: { headers: { XRate: rateHeader } },
        }),
      },
      {
        label: "a response header's `$ref`, `schema` beside it",
        build: (_content, _headers, schema) => ({
          ...getOp({
            responses: {
              '200': { ...petResponse(), headers: { 'X-Rate': { $ref: '#/components/headers/XRate', schema } } },
            },
          }),
          components: { headers: { XRate: rateHeader } },
        }),
      },
      {
        label: "an encoding header's `$ref`, `schema` beside it",
        build: (_content, _headers, schema) => ({
          ...getOp({
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
                  encoding: { file: { headers: { 'X-Rate': { $ref: '#/components/headers/XRate', schema } } } },
                },
              },
            },
          }),
          components: { headers: { XRate: rateHeader } },
        }),
      },
      {
        label: 'a `components/responses` entry written as a `$ref`, `content` beside it',
        build: (content) => ({
          components: {
            responses: {
              Missing: { description: 'missing' },
              Gone: { $ref: '#/components/responses/Missing', content },
            },
          },
        }),
      },
      {
        label: 'a `components/requestBodies` entry written as a `$ref`, `content` beside it',
        build: (content) => ({
          components: {
            requestBodies: { Filter: filterBody, Search: { $ref: '#/components/requestBodies/Filter', content } },
          },
        }),
      },
      {
        label: 'a `components/parameters` entry written as a `$ref`, `content` beside it',
        build: (content) => ({
          components: { parameters: { Limit: limitParam, Max: { $ref: '#/components/parameters/Limit', content } } },
        }),
      },
      {
        label: 'a `components/headers` entry written as a `$ref`, `content` beside it',
        build: (content) => ({
          components: { headers: { XRate: rateHeader, XLimit: { $ref: '#/components/headers/XRate', content } } },
        }),
      },
      {
        label: "a webhook operation's `requestBody` `$ref`, `content` beside it",
        build: (content) => ({
          webhooks: {
            petAdopted: { post: { requestBody: { $ref: '#/components/requestBodies/Filter', content }, ...okBody } },
          },
          components: { requestBodies: { Filter: filterBody } },
        }),
      },
      {
        label: "a webhook operation's response `$ref`, `content` beside it",
        build: (content) => ({
          webhooks: {
            petAdopted: { post: { responses: { '404': { $ref: '#/components/responses/Missing', content } } } },
          },
          components: { responses: { Missing: { description: 'missing' } } },
        }),
      },
      {
        label: "a callback operation's `requestBody` `$ref`, `content` beside it",
        build: (content) => ({
          ...getOp({
            callbacks: {
              onNote: {
                '{$request.query.url}': {
                  post: { requestBody: { $ref: '#/components/requestBodies/Filter', content }, ...okBody },
                },
              },
            },
          }),
          components: { requestBodies: { Filter: filterBody } },
        }),
      },
      {
        label: 'a Callback Object written as a `$ref`, a path item beside it',
        build: (content) => ({
          ...getOp({
            callbacks: {
              onNote: {
                $ref: '#/components/callbacks/OnNote',
                '{$request.query.url}': { post: { requestBody: { content }, ...okBody } },
              },
            },
          }),
          components: { callbacks: { OnNote: {} } },
        }),
      },
      {
        label: 'a `components/callbacks` entry written as a `$ref`, a path item beside it',
        build: (content) => ({
          components: {
            callbacks: {
              OnNote: {},
              OnTag: {
                $ref: '#/components/callbacks/OnNote',
                '{$request.query.url}': { post: { requestBody: { content }, ...okBody } },
              },
            },
          },
        }),
      },
      {
        label: 'a `paths` entry written as a `$ref`, a `get` beside it',
        build: (content) => ({
          paths: {
            '/pets': { get: { responses: { '200': petResponse() } } },
            '/animals': { $ref: '#/paths/~1pets', get: { responses: { '200': { description: 'ok', content } } } },
          },
        }),
      },
      {
        label: 'a `webhooks` entry written as a `$ref`, a `post` beside it',
        build: (content) => ({
          webhooks: {
            petAdopted: { post: okBody },
            petReturned: { $ref: '#/webhooks/petAdopted', post: { requestBody: { content }, ...okBody } },
          },
        }),
      },
      {
        label: 'a `components/pathItems` entry written as a `$ref`, a `get` beside it',
        build: (content) => ({
          components: {
            pathItems: {
              Pets: { get: { responses: { '200': petResponse() } } },
              Animals: {
                $ref: '#/components/pathItems/Pets',
                get: { responses: { '200': { description: 'ok', content } } },
              },
            },
          },
        }),
      },
      {
        label: 'a malformed `$ref` (`42`), `content` beside it: still a reference',
        build: (content) => getOp({ responses: { '404': { $ref: 42, content } } }),
      },
    ])('$label contests nothing', ({ build }) => {
      expect(marks(build)).toEqual([false, false]);
    });

    it.each<{ label: string; build: (content: Doc, headers: Doc, schema: SchemaObject) => Doc }>([
      {
        label: 'an inline `404` response carrying the `content`',
        build: (content) => getOp({ responses: { '404': { description: 'missing', content } } }),
      },
      {
        label: 'a `$ref` key holding `undefined`, which is no reference',
        build: (content) => getOp({ responses: { '404': { $ref: undefined, description: 'missing', content } } }),
      },
      {
        label: 'an inline parameter carrying the `content`',
        build: (content) => getOp({ parameters: [{ name: 'filter', in: 'query', content }] }),
      },
      {
        label: 'an inline response header carrying the `schema`',
        build: (_content, _headers, schema) =>
          getOp({ responses: { '200': { ...petResponse(), headers: { 'X-Note': { schema } } } } }),
      },
    ])('$label still contests the title (control)', ({ build }) => {
      expect(marks(build)).toEqual([true, true]);
    });
  });
});
