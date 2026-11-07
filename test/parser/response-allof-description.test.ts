import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec, type ParseOptions } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Model, Operation } from '../../src/ir/types.js';

/**
 * Issue #604: a response body merged from an inline `allOf` dropped the
 * wrapper layer's `description` — the text beside the `allOf`, else an
 * annotating member's — though the same schema as a request body, a field,
 * a header or a parameter kept it, and a plain object response kept its
 * own. `mergedObjectSchema` rebuilt the merge with the layer's `deprecated`,
 * link and `x-*` keys but not its text, a leftover from before the merge
 * read the wrapper layer at all. The rebuilt schema now carries the text
 * too, so the model built from it at every response site is documented as
 * the model built from the merged list is.
 */

const VERSIONS = ['3.0.3', '3.1.0'] as const;

const base = { $ref: '#/components/schemas/Base' };
const typing = { type: 'object', properties: { name: { type: 'string' } } };
/** The issue's schema: the text and the flag in an annotating member. */
const mergeInMember = { allOf: [base, typing, { description: 'A pet.', deprecated: true }] };
/** The issue's second spelling: the same keys beside the `allOf`. */
const mergeBeside = { allOf: [base, typing], description: 'A pet.', deprecated: true };

function json(schema: unknown) {
  return { 'application/json': { schema } };
}

function documentWith(openapi: string, paths: Record<string, unknown>, extraSchemas: Record<string, unknown> = {}) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths,
    components: { schemas: { Base: { type: 'object', properties: { id: { type: 'string' } } }, ...extraSchemas } },
  };
}

/** A `GET` operation answering `schema` as its `200` body, with `extraResponses` beside it. */
function getting(operationId: string, schema: unknown, extraResponses: Record<string, unknown> = {}) {
  return { operationId, responses: { '200': { description: 'ok', content: json(schema) }, ...extraResponses } };
}

/** The issue's repro, verbatim: `createPet` takes and answers the in-member merge; `getPet` answers the beside spelling. */
function issueRepro(openapi: string) {
  return documentWith(openapi, {
    '/pets': {
      post: {
        operationId: 'createPet',
        requestBody: { content: json(mergeInMember) },
        responses: { '201': { description: 'Created.', content: json(mergeInMember) } },
      },
    },
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: json(mergeBeside) } },
      },
    },
  });
}

describe('#604', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-604-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function parseJson(doc: unknown, options?: ParseOptions): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return await parseSpec(specFile, options);
  }

  function modelOf(spec: ApiSpec, name: string): Model {
    const model = spec.models.find((m) => m.name === name);
    if (!model) throw new Error(`no model ${name} among ${spec.models.map((m) => m.name).join(', ')}`);
    return model;
  }

  function operationOf(spec: ApiSpec, name: string): Operation {
    const operation = spec.services.flatMap((s) => s.operations).find((o) => o.name === name);
    if (!operation) throw new Error(`no operation ${name}`);
    return operation;
  }

  /** The issue's script output: each model's name with its `deprecated` and `description`. */
  function documented(spec: ApiSpec): string[] {
    return spec.models.map(
      ({ deprecated, description, name }) => `${name} ${JSON.stringify({ deprecated, description })}`,
    );
  }

  for (const openapi of VERSIONS) {
    describe(`OAS ${openapi}`, () => {
      it("the issue's repro: both response models are described 'A pet.' and deprecated, as the request model is", async () => {
        const spec = await parseJson(issueRepro(openapi));
        expect(documented(spec)).toEqual([
          'Base {}',
          'CreatePetResponse {"deprecated":true,"description":"A pet."}',
          'CreatePetRequest {"deprecated":true,"description":"A pet."}',
          'GetPetResponse {"deprecated":true,"description":"A pet."}',
        ]);
        // The Response Object's own text is the operation's, never the model's,
        // and the schema's never reaches the operation.
        expect(operationOf(spec, 'createPet').responseDescription).toBe('Created.');
        expect(operationOf(spec, 'getPet').responseDescription).toBe('ok');
      });

      it('the two spellings of the issue are one IR: `oagen diff` between them reports nothing', async () => {
        const beside = await parseJson(documentWith(openapi, { '/pets': { get: getting('getPet', mergeBeside) } }));
        const inMember = await parseJson(documentWith(openapi, { '/pets': { get: getting('getPet', mergeInMember) } }));
        expect(modelOf(beside, 'GetPetResponse')).toEqual(modelOf(inMember, 'GetPetResponse'));
        expect(diffSpecs(beside, inMember).changes).toEqual([]);
        expect(diffSpecs(inMember, beside).changes).toEqual([]);
      });

      it.each([
        ['beside the allOf', { allOf: [base, typing], description: 'A pet.' }, 'A pet.'],
        ['in an annotating member, last', { allOf: [base, typing, { description: 'A pet.' }] }, 'A pet.'],
        ['in an annotating member, first', { allOf: [{ description: 'A pet.' }, base, typing] }, 'A pet.'],
        [
          "both: the wrapper's own wins",
          { allOf: [base, typing, { description: 'Member.' }], description: 'Own.' },
          'Own.',
        ],
        [
          'two annotating members: the first wins',
          { allOf: [base, { description: 'First.' }, typing, { description: 'Second.' }] },
          'First.',
        ],
        [
          "a blank own text leaves the member's standing",
          { allOf: [base, typing, { description: 'Member.' }], description: '  ' },
          'Member.',
        ],
      ])('the merged response model reads the wrapper layer: %s', async (_label, schema, expected) => {
        const spec = await parseJson(documentWith(openapi, { '/pets': { get: getting('getPet', schema) } }));
        const model = modelOf(spec, 'GetPetResponse');
        expect(model.description).toBe(expected);
        expect(model.fields.map((f) => f.name)).toEqual(['id', 'name']);
      });

      it("a typing member's text stays on that member, as it does for a field", async () => {
        const schema = { allOf: [base, { ...typing, description: 'The typing member.' }] };
        const spec = await parseJson(documentWith(openapi, { '/pets': { get: getting('getPet', schema) } }));
        expect(modelOf(spec, 'GetPetResponse').description).toBeUndefined();
      });

      it('the plain-object control is unchanged: a described object body documents its model', async () => {
        const schema = {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' } },
          description: 'A pet.',
        };
        const spec = await parseJson(documentWith(openapi, { '/pets': { get: getting('getPet', schema) } }));
        expect(modelOf(spec, 'GetPetResponse').description).toBe('A pet.');
      });

      it("a union written beside the allOf is one more member; the model keeps the wrapper's text", async () => {
        const schema = {
          allOf: [base, typing],
          oneOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'string' } } }],
          description: 'A pet.',
        };
        const spec = await parseJson(documentWith(openapi, { '/pets': { get: getting('getPet', schema) } }));
        const model = modelOf(spec, 'GetPetResponse');
        expect(model.description).toBe('A pet.');
        expect(model.fields.map((f) => f.name)).toEqual(['id', 'name', 'a', 'b']);
      });

      it('a merge of two `$ref` members, kept under the operation name, is documented too', async () => {
        const schema = {
          allOf: [base, { $ref: '#/components/schemas/Owner' }, { description: 'A pet with its owner.' }],
        };
        const spec = await parseJson(
          documentWith(
            openapi,
            { '/pets': { get: getting('getPet', schema) } },
            { Owner: { type: 'object', properties: { owner: { type: 'string' } } } },
          ),
        );
        const model = modelOf(spec, 'GetPetResponse');
        expect(model.description).toBe('A pet with its owner.');
        expect(model.fields.map((f) => f.name)).toEqual(['id', 'owner']);
      });

      it('a wrapper around the merge composes outermost-first, as the same schema does on a field', async () => {
        const inner = { allOf: [base, typing, { description: 'Inner.' }] };
        for (const [wrapper, expected] of [
          [{ allOf: [inner], description: 'Outer.' }, 'Outer.'],
          [{ allOf: [inner] }, 'Inner.'],
        ] as const) {
          const spec = await parseJson(
            documentWith(
              openapi,
              { '/pets': { get: getting('getPet', wrapper) } },
              { Holder: { type: 'object', properties: { thing: wrapper } } },
            ),
          );
          expect(modelOf(spec, 'GetPetResponse').description).toBe(expected);
          expect(modelOf(spec, 'HolderThing').description).toBe(expected);
        }
      });

      // The primary body and each further success code's are rebuilt through
      // `mergedObjectSchema`, the site that dropped the text; a secondary media
      // type's body and the fallback are built from the merged list and kept
      // it already — pinned together so every response site agrees.
      it('every response site reads the text: a second success code, a secondary media type, the fallback body', async () => {
        const merge = (text: string, field: string) => ({
          allOf: [base, { type: 'object', properties: { [field]: { type: 'string' } } }, { description: text }],
        });
        const spec = await parseJson(
          documentWith(openapi, {
            '/pets': {
              post: {
                operationId: 'createPet',
                responses: {
                  '201': {
                    description: 'Created.',
                    content: {
                      ...json(merge('A pet.', 'name')),
                      'application/vnd.api+json': { schema: merge('A JSON:API pet.', 'links') },
                    },
                  },
                  '202': { description: 'Accepted.', content: json(merge('A queued pet.', 'queued')) },
                  default: { description: 'Fallback.', content: json(merge('A fallback.', 'fallback')) },
                },
              },
            },
          }),
        );
        expect(modelOf(spec, 'CreatePetResponse').description).toBe('A pet.');
        expect(modelOf(spec, 'CreatePetApplicationVndApiJsonResponse').description).toBe('A JSON:API pet.');
        expect(modelOf(spec, 'CreatePetResponse202').description).toBe('A queued pet.');
        expect(modelOf(spec, 'CreatePetDefaultResponse').description).toBe('A fallback.');
        // Each entry's own `description` is the Response Object's.
        const createPet = operationOf(spec, 'createPet');
        expect(createPet.responseDescription).toBe('Created.');
        expect(createPet.successResponses?.map((r) => r.description)).toEqual(['Created.', 'Accepted.']);
      });

      it('an error body and a range body read the text, when the fold leaves them as they are', async () => {
        const merge = (text: string, field: string) => ({
          allOf: [base, { type: 'object', properties: { [field]: { type: 'string' } } }, { description: text }],
        });
        const spec = await parseJson(
          documentWith(openapi, {
            '/pets': {
              get: getting('getPet', typing, {
                '400': { description: 'Bad.', content: json(merge('An error.', 'message')) },
                '5XX': { description: 'Broken.', content: json(merge('A server error.', 'reason')) },
              }),
            },
          }),
          { collapseErrorBodies: false },
        );
        expect(modelOf(spec, 'GetPetError400').description).toBe('An error.');
        expect(modelOf(spec, 'GetPetError5Xx').description).toBe('A server error.');
        expect(operationOf(spec, 'getPet').errors?.map((e) => e.description)).toEqual(['Bad.']);
      });

      it("the error-body fold's own rule is unchanged: the shared model carries no text, as two plain bodies' does", async () => {
        const merged = (text: string) => ({
          allOf: [base, { type: 'object', properties: { message: { type: 'string' } } }, { description: text }],
        });
        const plain = (text: string) => ({
          type: 'object',
          properties: { id: { type: 'string' }, message: { type: 'string' } },
          description: text,
        });
        const twoErrors = (a: unknown, b: unknown) =>
          documentWith(openapi, {
            '/a': {
              get: getting(
                'getA',
                { type: 'object', properties: { a: { type: 'string' } } },
                { '400': { description: 'Bad.', content: json(a) } },
              ),
            },
            '/b': {
              get: getting(
                'getB',
                { type: 'object', properties: { b: { type: 'string' } } },
                { '400': { description: 'Bad.', content: json(b) } },
              ),
            },
          });
        for (const [a, b] of [
          [merged('An error.'), merged('An error.')],
          [merged('An error.'), merged('Another error.')],
          [plain('An error.'), plain('An error.')],
        ]) {
          const spec = await parseJson(twoErrors(a, b));
          const shared = modelOf(spec, 'OptionalErrorBodyWithId');
          expect(shared.description).toBeUndefined();
          expect(shared.fields.map((f) => f.name)).toEqual(['id', 'message']);
          expect(operationOf(spec, 'getA').errors?.[0]?.type).toEqual({
            kind: 'model',
            name: 'OptionalErrorBodyWithId',
          });
        }
      });

      it('a list envelope kept as a plain model, a webhook and a callback payload, a header and a parameter read the text', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const merge = (text: string, field: string) => ({
          allOf: [base, { type: 'object', properties: { [field]: { type: 'string' } } }, { description: text }],
        });
        const envelope = {
          allOf: [
            { type: 'object', properties: { data: { type: 'array', items: base } }, required: ['data'] },
            {
              type: 'object',
              properties: { list_metadata: { type: 'object', properties: { after: { type: 'string' } } } },
            },
            { description: 'A page of pets.' },
          ],
        };
        const spec = await parseJson({
          ...documentWith(openapi, {
            '/pets': {
              get: {
                operationId: 'listPets',
                parameters: [{ name: 'filter', in: 'query', schema: merge('A filter.', 'kind') }],
                responses: {
                  '200': {
                    description: 'ok',
                    headers: { 'X-Meta': { description: 'Meta.', schema: merge('Header meta.', 'etag') } },
                    content: json(envelope),
                  },
                },
                callbacks: {
                  onPet: {
                    '{$request.body#/url}': {
                      post: {
                        operationId: 'onPetCallback',
                        requestBody: { content: json(merge('A callback payload.', 'payload')) },
                        responses: { '200': { description: 'ok' } },
                      },
                    },
                  },
                },
              },
            },
          }),
          webhooks: {
            petCreated: {
              post: {
                operationId: 'petCreated',
                requestBody: { content: json(merge('A webhook payload.', 'event')) },
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        });
        expect(modelOf(spec, 'ListPetsResponse').description).toBe('A page of pets.');
        expect(modelOf(spec, 'PetsXMeta').description).toBe('Header meta.');
        expect(modelOf(spec, 'PetsFilter').description).toBe('A filter.');
        expect(modelOf(spec, 'OnPetCallbackPayload').description).toBe('A callback payload.');
        expect(modelOf(spec, 'PetCreatedPayload').description).toBe('A webhook payload.');
      });
    });
  }
});
