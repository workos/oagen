/**
 * Issue #753: `oagen diff` compared an operation's bodies by type identity
 * (`typeRefsEqual`: two model refs are equal when they name one model), so a
 * response or error body moved to a model that has every old field, with
 * the same types, plus optional ones, was breaking, and so was a request
 * body moved to a model that requires nothing more — though every reader of
 * the old body still finds what it read and every request built for the old
 * body is still valid. The diff exited 2.
 *
 * A body's type change is now judged by `compatibleShape`, from the side of
 * the wire the body is on: a reader (a response, an error, a `default` or
 * range response, a webhook's or a callback's payload) needs every old
 * field, of the same type and required wherever it was; a writer (a request
 * body) needs every old field, of the same type, and no field required that
 * was not. The change is still reported with the same flags and lists; only
 * its classification moves.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffOperations } from '../../src/differ/operations.js';
import { compatibleShape, documentTypes, sameShape, type DocumentShapes } from '../../src/differ/shapes.js';
import type { Change, DiffReport } from '../../src/differ/types.js';
import { diffCommand } from '../../src/cli/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Enum, Field, Model, Operation, TypeRef, UnionType } from '../../src/ir/types.js';

const OPENAPI_VERSIONS = ['3.1.0', '3.0.3'] as const;

type Schema = Record<string, unknown>;
type Schemas = Record<string, Schema>;

let dir: string | undefined;
let written = 0;
afterAll(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

/** Writes an OpenAPI document to this file's temp dir and returns its path. */
async function writeSpec(doc: unknown): Promise<string> {
  dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-753-'));
  const file = path.join(dir, `${written++}.json`);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** `diffSpecs` over two documents, with the parser's warnings silenced. */
async function diffDocuments(oldDoc: unknown, newDoc: unknown): Promise<DiffReport> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return diffSpecs(await parseSpec(await writeSpec(oldDoc)), await parseSpec(await writeSpec(newDoc)));
  } finally {
    warn.mockRestore();
  }
}

/** The exit code `oagen diff` ends with for the two documents. */
async function exitCodeOf(oldDoc: unknown, newDoc: unknown): Promise<number> {
  const [oldPath, newPath] = [await writeSpec(oldDoc), await writeSpec(newDoc)];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const error = (await diffCommand({ old: oldPath, new: newPath }).catch((e: unknown) => e)) as { exitCode: number };
    return error.exitCode;
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
}

/** The exit code `diffCommand` picks from a summary: 2 breaking, 1 any other change, 0 nothing. */
const exitOf = ({ summary }: DiffReport): number =>
  summary.breaking > 0 ? 2 : summary.modified + summary.removed + summary.added > 0 ? 1 : 0;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const string: Schema = { type: 'string' };
const object = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});
const json = (schema: Schema) => ({ content: { 'application/json': { schema } } });
const response = (description: string, schema?: Schema) => ({ description, ...(schema ? json(schema) : {}) });
const document = (openapi: string, paths: Schema, schemas: Schemas, webhooks?: Schema) => ({
  openapi,
  info: { title: 'Repro', version: '1.0.0' },
  paths,
  ...(webhooks ? { webhooks } : {}),
  components: { schemas },
});
const petId = [{ name: 'petId', in: 'path', required: true, schema: string }];
const getPet = (responses: Schema, parameters: unknown[] = petId) => ({
  '/pets/{petId}': { get: { operationId: 'getPet', parameters, responses } },
});
const createPet = (requestBody: Schema) => ({
  '/pets': { post: { operationId: 'createPet', requestBody, responses: { '204': response('No Content') } } },
});

/** The body's own entry: the one change about an operation, a webhook or a callback. */
type BodyChange = Extract<Change, { kind: 'operation-modified' | 'webhook-modified' | 'callback-modified' }>;
const bodyChanges = ({ changes }: DiffReport): BodyChange[] =>
  changes.filter(
    (change): change is BodyChange =>
      change.kind === 'operation-modified' || change.kind === 'webhook-modified' || change.kind === 'callback-modified',
  );
const bodyChange = (report: DiffReport): BodyChange => {
  const found = bodyChanges(report);
  expect(found).toHaveLength(1);
  return found[0];
};

// ---------------------------------------------------------------------------
// The issue's documents
// ---------------------------------------------------------------------------

const Pet = object({ id: string, name: string });
const PetError = object({ message: string });
const NewPet = object({ name: string });
const tag = { properties: { tag: string } };
const withCode = { allOf: [ref('PetError'), { type: 'object', properties: { code: string } }] };

/** The issue's seven documents, and its four controls, under one OpenAPI version. */
function issueDocuments(openapi: string) {
  const pet = (ok: Schema, badRequest: Schema) =>
    getPet({ '200': response('OK', ok), '400': response('Bad Request', badRequest) });
  const create = (body: string) => createPet({ required: true, ...json(ref(body)) });
  const old = document(openapi, pet(ref('Pet'), ref('PetError')), { PetError, Pet });
  return {
    'old.json': old,
    'new.json': document(openapi, pet(ref('Pet'), withCode), { PetError, Pet }),
    'component.json': document(openapi, pet(ref('Pet'), ref('PetErrorWithCode')), {
      PetError,
      PetErrorWithCode: withCode,
      Pet,
    }),
    'success-old.json': old,
    'success-new.json': document(openapi, pet(ref('PetWithTag'), ref('PetError')), {
      PetError,
      Pet,
      PetWithTag: { allOf: [ref('Pet'), tag] },
    }),
    'request-old.json': document(openapi, create('NewPet'), { NewPet }),
    'request-new.json': document(openapi, create('NewPetWithTag'), {
      NewPet,
      NewPetWithTag: { allOf: [ref('NewPet'), tag] },
    }),
    // "A model that drops or retypes a field, or (for a request body) requires a new one, stays breaking."
    'success-dropped.json': document(openapi, pet(ref('PetSummary'), ref('PetError')), {
      PetError,
      Pet,
      PetSummary: object({ id: string }),
    }),
    'success-retyped.json': document(openapi, pet(ref('PetWithNumericId'), ref('PetError')), {
      PetError,
      Pet,
      PetWithNumericId: object({ id: { type: 'integer' }, name: string }),
    }),
    // "required wherever it was"
    'success-optional.json': document(openapi, pet(ref('PetDraft'), ref('PetError')), {
      PetError,
      Pet,
      PetDraft: object({ id: string, name: string }, ['id']),
    }),
    'request-required.json': document(openapi, create('NewPetWithOwner'), {
      NewPet,
      NewPetWithOwner: { allOf: [ref('NewPet'), { properties: { ownerId: string }, required: ['ownerId'] }] },
    }),
  };
}

const ISSUE_PAIRS = [
  ['old.json', 'new.json'],
  ['old.json', 'component.json'],
  ['success-old.json', 'success-new.json'],
  ['request-old.json', 'request-new.json'],
] as const;

/** The lines the issue's script prints for one pair. */
function scriptLines(oldFile: string, newFile: string, { changes }: DiffReport): string[] {
  const lines = [`${oldFile} → ${newFile}`];
  for (const change of changes) {
    const { classification, kind } = change;
    const name = 'name' in change ? change.name : 'operationName' in change ? change.operationName : undefined;
    const flags =
      change.kind === 'operation-modified'
        ? JSON.stringify({
            errorsChanged: change.errorsChanged,
            requestBodyChanged: change.requestBodyChanged,
            responseChanged: change.responseChanged,
          })
        : '';
    lines.push(`  ${kind} ${name}: ${classification} ${flags}`.trimEnd());
  }
  return lines;
}

describe('#753 a body moved to a model that still serves its reader or its writer is additive', () => {
  describe.each(OPENAPI_VERSIONS)('the issue’s documents, OpenAPI %s', (openapi) => {
    const documents = issueDocuments(openapi);

    it('prints each of the four changes as additive, with the flags it printed before', async () => {
      const lines: string[] = [];
      for (const [oldFile, newFile] of ISSUE_PAIRS) {
        lines.push(...scriptLines(oldFile, newFile, await diffDocuments(documents[oldFile], documents[newFile])));
      }
      expect(lines).toMatchInlineSnapshot(`
        [
          "old.json → new.json",
          "  model-added ErrorBody: additive",
          "  operation-modified getPet: additive {"errorsChanged":true,"requestBodyChanged":false,"responseChanged":false}",
          "old.json → component.json",
          "  model-added PetErrorWithCode: additive",
          "  operation-modified getPet: additive {"errorsChanged":true,"requestBodyChanged":false,"responseChanged":false}",
          "success-old.json → success-new.json",
          "  model-added PetWithTag: additive",
          "  operation-modified getPet: additive {"errorsChanged":false,"requestBodyChanged":false,"responseChanged":true}",
          "request-old.json → request-new.json",
          "  model-added NewPetWithTag: additive",
          "  operation-modified createPet: additive {"errorsChanged":false,"requestBodyChanged":true,"responseChanged":false}",
        ]
      `);
    });

    it('`oagen diff` exits 1 for each pair, and 2 for each reverse edit, which drops a field', async () => {
      for (const [oldFile, newFile] of ISSUE_PAIRS) {
        expect(await exitCodeOf(documents[oldFile], documents[newFile]), `${oldFile} → ${newFile}`).toBe(1);
        expect(await exitCodeOf(documents[newFile], documents[oldFile]), `${newFile} → ${oldFile}`).toBe(2);
        const back = await diffDocuments(documents[newFile], documents[oldFile]);
        expect(bodyChange(back).classification, `${newFile} → ${oldFile}`).toBe('breaking');
      }
    });

    it('keeps a model that drops or retypes a field, makes one optional, or requires a new one, breaking', async () => {
      const controls = [
        ['success-old.json', 'success-dropped.json'],
        ['success-old.json', 'success-retyped.json'],
        ['success-old.json', 'success-optional.json'],
        ['request-old.json', 'request-required.json'],
      ] as const;
      for (const [oldFile, newFile] of controls) {
        const report = await diffDocuments(documents[oldFile], documents[newFile]);
        expect(bodyChange(report).classification, `${oldFile} → ${newFile}`).toBe('breaking');
        expect(await exitCodeOf(documents[oldFile], documents[newFile]), `${oldFile} → ${newFile}`).toBe(2);
      }
    });

    it('moves the classification alone: every key the change carried is still there, with the value it had', async () => {
      const report = await diffDocuments(documents['success-old.json'], documents['success-new.json']);
      expect(report.changes).toMatchInlineSnapshot(`
        [
          {
            "classification": "additive",
            "kind": "model-added",
            "name": "PetWithTag",
          },
          {
            "classification": "additive",
            "deprecatedChanged": false,
            "errorsChanged": false,
            "fallbackResponsesChanged": false,
            "httpMethodChanged": false,
            "injectIdempotencyKeyChanged": false,
            "kind": "operation-modified",
            "operationName": "getPet",
            "paginatedChanged": false,
            "paginationDataPathChanged": false,
            "paginationEndOfIterationChanged": false,
            "paginationLimitParamChanged": false,
            "paginationPageStartChanged": false,
            "paginationParamChanged": false,
            "paginationStrategyChanged": false,
            "paramChanges": [],
            "pathChanged": false,
            "requestBodyChanged": false,
            "requestBodyContentTypesChanged": false,
            "requestBodyEncodingChanged": false,
            "requestBodyRequiredChanged": false,
            "responseChanged": true,
            "responseContentTypeChanges": [],
            "responseContentTypesChanged": false,
            "responseHeaderChanges": [],
            "responseHeadersChanged": false,
            "responseStatusCodeChanged": false,
            "securityChanged": false,
            "serverChanges": [],
            "serversChanged": false,
            "serviceName": "Pets",
            "tagsChanged": false,
          },
        ]
      `);
      expect(report.summary).toEqual({
        added: 1,
        removed: 0,
        modified: 1,
        breaking: 0,
        additive: 2,
        behaviorChanges: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Every body site, both sides of the wire
  // -------------------------------------------------------------------------

  /** `Pet { id, name, nickname? }`, the model every site's body starts on. */
  const petFields = { id: string, name: string, nickname: string };
  const BasePet = object(petFields, ['id', 'name']);
  const Dog = object({ id: string, bark: { type: 'boolean' } }, ['id']);

  /** The model the body moves to, per edit. */
  const EDITS: Record<string, Schema> = {
    'an optional field added': { allOf: [ref('Pet'), tag] },
    'a required field added': { allOf: [ref('Pet'), { ...tag, required: ['tag'] }] },
    'a required field made optional': object(petFields, ['id']),
    'an optional field made required': object(petFields, ['id', 'name', 'nickname']),
    'a field dropped': object({ id: string, name: string }),
    'a field retyped': object({ ...petFields, id: { type: 'integer' } }, ['id', 'name']),
  };
  /** What the body's own entry is for the SDK's user who reads the body, and for the one who builds it. */
  const EXPECTED: Record<'reader' | 'writer', Record<string, 'additive' | 'breaking'>> = {
    reader: {
      'an optional field added': 'additive',
      'a required field added': 'additive',
      'a required field made optional': 'breaking',
      'an optional field made required': 'additive',
      'a field dropped': 'breaking',
      'a field retyped': 'breaking',
    },
    writer: {
      'an optional field added': 'additive',
      'a required field added': 'breaking',
      'a required field made optional': 'additive',
      'an optional field made required': 'breaking',
      'a field dropped': 'breaking',
      'a field retyped': 'breaking',
    },
  };

  interface Site {
    side: 'reader' | 'writer';
    paths?: (body: Schema) => Schema;
    webhooks?: (body: Schema) => Schema;
    /** What says the body changed: a flag of the change, or a media type listed as retyped. */
    reported: (change: BodyChange) => unknown;
  }
  const retypedIn = (change: BodyChange): string[] =>
    change.kind === 'operation-modified'
      ? [
          ...change.responseContentTypeChanges.flatMap((entry) => entry.retyped),
          ...(change.requestBodyContentTypeChange?.retyped ?? []),
        ]
      : (change.requestBodyContentTypeChange?.retyped ?? []);
  const flag = (name: 'responseChanged' | 'errorsChanged' | 'fallbackResponsesChanged' | 'requestBodyChanged') => {
    return (change: BodyChange): unknown => (change as unknown as Record<string, unknown>)[name];
  };
  const SITES: Record<string, Site> = {
    'the success response': {
      side: 'reader',
      paths: (body) => getPet({ '200': response('OK', body) }),
      reported: flag('responseChanged'),
    },
    'an alternate 2xx': {
      side: 'reader',
      paths: (body) => getPet({ '200': response('OK', ref('Dog')), '202': response('Accepted', body) }),
      reported: (change) => retypedIn(change).includes('application/json'),
    },
    'an error response': {
      side: 'reader',
      paths: (body) => getPet({ '200': response('OK', ref('Dog')), '400': response('Bad Request', body) }),
      reported: flag('errorsChanged'),
    },
    'the default response': {
      side: 'reader',
      paths: (body) => getPet({ '200': response('OK', ref('Dog')), default: response('Error', body) }),
      reported: flag('fallbackResponsesChanged'),
    },
    'a range response': {
      side: 'reader',
      paths: (body) => getPet({ '200': response('OK', ref('Dog')), '4XX': response('Client error', body) }),
      reported: flag('fallbackResponsesChanged'),
    },
    'a response’s second media type': {
      side: 'reader',
      paths: (body) =>
        getPet({
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: ref('Dog') }, 'application/yaml': { schema: body } },
          },
        }),
      reported: (change) => retypedIn(change).includes('application/yaml'),
    },
    'an error’s second media type': {
      side: 'reader',
      paths: (body) =>
        getPet({
          '200': response('OK', ref('Dog')),
          '400': {
            description: 'Bad Request',
            content: { 'application/json': { schema: ref('Dog') }, 'application/yaml': { schema: body } },
          },
        }),
      reported: (change) => retypedIn(change).includes('application/yaml'),
    },
    'a paginated list’s items': {
      side: 'reader',
      paths: (body) => ({
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [
              { name: 'after', in: 'query', schema: string },
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
            ],
            responses: {
              '200': response(
                'OK',
                object({
                  object: { type: 'string', enum: ['list'] },
                  data: { type: 'array', items: body },
                  list_metadata: object({ before: string, after: string }, []),
                }),
              ),
            },
          },
        },
      }),
      reported: flag('responseChanged'),
    },
    'the request body': {
      side: 'writer',
      paths: (body) => createPet({ required: true, ...json(body) }),
      reported: flag('requestBodyChanged'),
    },
    'an optional request body': {
      side: 'writer',
      paths: (body) => createPet(json(body)),
      reported: flag('requestBodyChanged'),
    },
    'a request body’s second media type': {
      side: 'writer',
      paths: (body) =>
        createPet({
          required: true,
          content: {
            'application/json': { schema: ref('Dog') },
            'application/x-www-form-urlencoded': { schema: body },
          },
        }),
      reported: (change) => retypedIn(change).includes('application/x-www-form-urlencoded'),
    },
    'a webhook’s payload': {
      side: 'reader',
      webhooks: (body) => ({
        petCreated: {
          post: {
            operationId: 'petCreated',
            requestBody: { required: true, ...json(body) },
            responses: { '200': response('OK') },
          },
        },
      }),
      reported: (change) => change.kind !== 'operation-modified' && change.details === 'payload type changed',
    },
    'a webhook payload’s second media type': {
      side: 'reader',
      webhooks: (body) => ({
        petCreated: {
          post: {
            operationId: 'petCreated',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('Dog') }, 'application/xml': { schema: body } },
            },
            responses: { '200': response('OK') },
          },
        },
      }),
      reported: (change) => retypedIn(change).includes('application/xml'),
    },
    'a callback’s payload': {
      side: 'reader',
      paths: (body) => ({
        '/subscriptions': {
          post: {
            operationId: 'subscribe',
            requestBody: { required: true, ...json(object({ url: string })) },
            responses: { '204': response('No Content') },
            callbacks: {
              onPet: {
                '{$request.body#/url}': {
                  post: { requestBody: { required: true, ...json(body) }, responses: { '200': response('OK') } },
                },
              },
            },
          },
        },
      }),
      reported: (change) => change.kind === 'callback-modified' && change.details === 'payload type changed',
    },
  };
  const siteDocument = (openapi: string, site: Site, schemas: Schemas, body: Schema) =>
    document(openapi, site.paths?.(body) ?? {}, { Dog, ...schemas }, site.webhooks?.(body));

  describe.each(OPENAPI_VERSIONS)('every body site, OpenAPI %s', (openapi) => {
    it.each(Object.entries(SITES))('%s is judged from its side of the wire', async (_, site) => {
      for (const [edit, moved] of Object.entries(EDITS)) {
        const before = siteDocument(openapi, site, { Pet: BasePet }, ref('Pet'));
        const after = siteDocument(openapi, site, { Pet: BasePet, Pet2: moved }, ref('Pet2'));
        const report = await diffDocuments(before, after);
        const change = bodyChange(report);
        const expected = EXPECTED[site.side][edit];
        // The change is reported either way; only what it is called differs.
        expect(site.reported(change), edit).toBe(true);
        expect(change.classification, edit).toBe(expected);
        expect(exitOf(report), edit).toBe(expected === 'additive' ? 1 : 2);
        expect(
          report.changes.filter((c) => c !== change),
          edit,
        ).toEqual([{ kind: 'model-added', name: 'Pet2', classification: 'additive' }]);
      }
    });

    it.each(Object.entries(SITES))('%s moved to a model both documents declare is judged the same', async (_, site) => {
      // Neither name is new to its document: the fields alone decide.
      for (const [edit, moved] of Object.entries(EDITS)) {
        const schemas = { Pet: BasePet, Pet2: moved };
        const report = await diffDocuments(
          siteDocument(openapi, site, schemas, ref('Pet')),
          siteDocument(openapi, site, schemas, ref('Pet2')),
        );
        expect(report.changes, edit).toHaveLength(1);
        expect(site.reported(bodyChange(report)), edit).toBe(true);
        expect(bodyChange(report).classification, edit).toBe(EXPECTED[site.side][edit]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Wrappers
  // -------------------------------------------------------------------------

  describe.each(OPENAPI_VERSIONS)('the same wrapper on both sides is looked through, OpenAPI %s', (openapi) => {
    const nullable = (body: Schema): Schema =>
      openapi.startsWith('3.0') ? { allOf: [body], nullable: true } : { oneOf: [body, { type: 'null' }] };
    const WRAPPERS: Record<string, (body: Schema, name: string) => Schema> = {
      'an array': (body) => ({ type: 'array', items: body }),
      'a map': (body) => ({ type: 'object', additionalProperties: body }),
      'a nullable': (body) => nullable(body),
      'an array of nullables': (body) => ({ type: 'array', items: nullable(body) }),
      'an `anyOf` union': (body) => ({ anyOf: [body, ref('Dog')] }),
      'a `oneOf` union': (body) => ({ oneOf: [body, ref('Dog')] }),
      'a `oneOf` union with a mapping': (body, name) => ({
        oneOf: [body, ref('Dog')],
        discriminator: {
          propertyName: 'id',
          mapping: { pet: `#/components/schemas/${name}`, dog: '#/components/schemas/Dog' },
        },
      }),
    };
    const sites = { response: SITES['the success response'], request: SITES['the request body'] };
    /**
     * A request body's `oneOf` asks more of a variant than the request body
     * itself would: one that admits more — a required field made optional —
     * can match a body only the other variant matched, and a body that
     * matches two is rejected (Greptile, #758 review round 3).
     */
    const expected = (wrapper: string, side: 'reader' | 'writer', edit: string): 'additive' | 'breaking' =>
      side === 'writer' && wrapper.includes('`oneOf`') && edit === 'a required field made optional'
        ? 'breaking'
        : EXPECTED[side][edit];

    it.each(Object.entries(WRAPPERS))('%s around the model', async (wrapper, wrap) => {
      for (const site of Object.values(sites)) {
        for (const [edit, moved] of Object.entries(EDITS)) {
          const report = await diffDocuments(
            siteDocument(openapi, site, { Pet: BasePet }, wrap(ref('Pet'), 'Pet')),
            siteDocument(openapi, site, { Pet: BasePet, Pet2: moved }, wrap(ref('Pet2'), 'Pet2')),
          );
          expect(site.reported(bodyChange(report)), `${site.side}: ${edit}`).toBe(true);
          expect(bodyChange(report).classification, `${site.side}: ${edit}`).toBe(expected(wrapper, site.side, edit));
        }
      }
    });

    it('keeps a wrapper added, removed or exchanged around a compatible model a breaking type change', async () => {
      const compatible = { Pet: BasePet, Pet2: EDITS['an optional field added'] };
      const array = WRAPPERS['an array'];
      const map = WRAPPERS['a map'];
      const pairs: Array<[string, Schema, Schema]> = [
        ['array added', ref('Pet'), array(ref('Pet2'), 'Pet2')],
        ['array removed', array(ref('Pet'), 'Pet'), ref('Pet2')],
        ['map added', ref('Pet'), map(ref('Pet2'), 'Pet2')],
        ['array become a map', array(ref('Pet'), 'Pet'), map(ref('Pet2'), 'Pet2')],
      ];
      for (const site of Object.values(sites)) {
        for (const [label, before, after] of pairs) {
          const report = await diffDocuments(
            siteDocument(openapi, site, compatible, before),
            siteDocument(openapi, site, compatible, after),
          );
          expect(bodyChange(report).classification, `${site.side}: ${label}`).toBe('breaking');
        }
      }
    });

    it('keeps a union whose keyword changed beside the move breaking, on both sides (Greptile, #758 review round 1)', async () => {
      const schemas = { Pet: BasePet, Pet2: EDITS['an optional field added'] };
      const union = (keyword: 'anyOf' | 'oneOf', name: string): Schema => ({ [keyword]: [ref(name), ref('Dog')] });
      for (const site of Object.values(sites)) {
        const classified = async (before: Schema, after: Schema) =>
          bodyChange(
            await diffDocuments(
              siteDocument(openapi, site, schemas, before),
              siteDocument(openapi, site, schemas, after),
            ),
          ).classification;
        expect(await classified(union('anyOf', 'Pet'), union('oneOf', 'Pet2')), site.side).toBe('breaking');
        expect(await classified(union('oneOf', 'Pet'), union('anyOf', 'Pet2')), site.side).toBe('breaking');
        expect(await classified(union('anyOf', 'Pet'), union('anyOf', 'Pet2')), site.side).toBe('additive');
        expect(await classified(union('oneOf', 'Pet'), union('oneOf', 'Pet2')), site.side).toBe('additive');
      }
    });

    it('reads two string variants that changed places with a `pattern` as the same union, beside the move (Greptile, #758 review round 2)', async () => {
      const schemas = { Pet: BasePet, Pet2: EDITS['an optional field added'] };
      const patterned = { type: 'string', pattern: '^pet_' };
      const classified = async (site: Site, before: Schema, after: Schema) =>
        bodyChange(
          await diffDocuments(
            siteDocument(openapi, site, schemas, before),
            siteDocument(openapi, site, schemas, after),
          ),
        ).classification;
      for (const site of Object.values(sites)) {
        // The finding: `anyOf: [Pet, { anyOf: [patterned, string] }]` → `anyOf: [Pet2, { anyOf: [string, patterned] }]`.
        expect(
          await classified(
            site,
            { anyOf: [ref('Pet'), { anyOf: [patterned, string] }] },
            { anyOf: [ref('Pet2'), { anyOf: [string, patterned] }] },
          ),
          site.side,
        ).toBe('additive');
      }
      // A `pattern` the old union did not have rejects a request it accepted.
      const added = [
        { anyOf: [ref('Pet'), { anyOf: [{ type: 'integer' }, string] }] },
        { anyOf: [ref('Pet2'), { anyOf: [{ type: 'integer' }, patterned] }] },
      ] as const;
      expect(await classified(sites.request, ...added)).toBe('breaking');
      expect(await classified(sites.response, ...added)).toBe('additive');
    });

    it('judges the limits of the body’s own array by side, as a field’s are', async () => {
      const schemas = { Pet: BasePet, Pet2: EDITS['an optional field added'] };
      const array = (name: string, maxItems?: number): Schema => ({
        type: 'array',
        items: ref(name),
        ...(maxItems === undefined ? {} : { maxItems }),
      });
      const classified = async (site: Site, before: Schema, after: Schema) =>
        bodyChange(
          await diffDocuments(
            siteDocument(openapi, site, schemas, before),
            siteDocument(openapi, site, schemas, after),
          ),
        ).classification;
      // Tightened: a request the old body accepted is rejected. A reader is handed fewer items.
      expect(await classified(sites.request, array('Pet', 10), array('Pet2', 5))).toBe('breaking');
      expect(await classified(sites.request, array('Pet'), array('Pet2', 5))).toBe('breaking');
      expect(await classified(sites.response, array('Pet', 10), array('Pet2', 5))).toBe('additive');
      // Loosened, or the same.
      for (const site of Object.values(sites)) {
        expect(await classified(site, array('Pet', 5), array('Pet2', 10)), site.side).toBe('additive');
        expect(await classified(site, array('Pet', 5), array('Pet2')), site.side).toBe('additive');
        expect(await classified(site, array('Pet', 5), array('Pet2', 5)), site.side).toBe('additive');
      }
    });

    it('keeps a union whose mapping lost or renamed a key breaking, and one that gained a variant beside the move', async () => {
      const mapped = WRAPPERS['a `oneOf` union with a mapping'];
      const schemas = { Pet: BasePet, Pet2: EDITS['an optional field added'], Bird: object({ id: string }) };
      const renamedKey = {
        oneOf: [ref('Pet2'), ref('Dog')],
        discriminator: {
          propertyName: 'id',
          mapping: { animal: '#/components/schemas/Pet2', dog: '#/components/schemas/Dog' },
        },
      };
      const widened = { oneOf: [ref('Pet2'), ref('Dog'), ref('Bird')] };
      for (const site of Object.values(sites)) {
        for (const [label, before, after] of [
          ['key renamed', mapped(ref('Pet'), 'Pet'), renamedKey],
          ['variant added beside the move', WRAPPERS['a `oneOf` union'](ref('Pet'), 'Pet'), widened],
        ] as const) {
          const report = await diffDocuments(
            siteDocument(openapi, site, schemas, before),
            siteDocument(openapi, site, schemas, after),
          );
          expect(bodyChange(report).classification, `${site.side}: ${label}`).toBe('breaking');
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // What the new model is spelled as, and what it may differ in
  // -------------------------------------------------------------------------

  describe.each(OPENAPI_VERSIONS)('spellings of the new model, OpenAPI %s', (openapi) => {
    const sites = { response: SITES['the success response'], request: SITES['the request body'] };
    /** Whether `after` is additive on a response, and on a request body, moved from `before`. */
    const judged = async (
      before: [Schemas, Schema],
      after: [Schemas, Schema],
    ): Promise<{ response: string; request: string }> => {
      const of = async (site: Site): Promise<string> =>
        bodyChange(await diffDocuments(siteDocument(openapi, site, ...before), siteDocument(openapi, site, ...after)))
          .classification;
      return { response: await of(sites.response), request: await of(sites.request) };
    };
    const additive = { response: 'additive', request: 'additive' };
    const breaking = { response: 'breaking', request: 'breaking' };
    const old: [Schemas, Schema] = [{ Pet: BasePet }, ref('Pet')];

    it('reads an inline `allOf` body as it reads the component it would be', async () => {
      const inline = { allOf: [ref('Pet'), { type: 'object', ...tag }] };
      expect(await judged(old, [{ Pet: BasePet }, inline])).toEqual(additive);
      expect(await judged([{ Pet: BasePet }, inline], old)).toEqual(breaking);
      const requiring = { allOf: [ref('Pet'), { type: 'object', ...tag, required: ['tag'] }] };
      expect(await judged(old, [{ Pet: BasePet }, requiring])).toEqual({ response: 'additive', request: 'breaking' });
    });

    it('reads the `allOf` members and the components in either order, and a chain of two', async () => {
      expect(await judged(old, [{ Pet2: { allOf: [tag, ref('Pet')] }, Pet: BasePet }, ref('Pet2')])).toEqual(additive);
      const chain = {
        Pet: BasePet,
        PetTagged: { allOf: [ref('Pet'), tag] },
        Pet2: { allOf: [ref('PetTagged'), { properties: { color: string } }] },
      };
      expect(await judged(old, [chain, ref('Pet2')])).toEqual(additive);
      expect(await judged([chain, ref('Pet2')], [chain, ref('PetTagged')])).toEqual(breaking);
    });

    it('reads an identical model as compatible both ways, whether it is new, renamed or declared by both', async () => {
      const copy: [Schemas, Schema] = [{ Pet: BasePet, Pet2: BasePet }, ref('Pet2')];
      expect(await judged(old, copy)).toEqual(additive);
      expect(await judged(copy, old)).toEqual(additive);
      expect(await judged([{ Pet: BasePet, Pet2: BasePet }, ref('Pet')], copy)).toEqual(additive);
      // Renamed: the operation's own change is additive, and the removed model is what breaks.
      const renamed: [Schemas, Schema] = [{ Pet2: BasePet }, ref('Pet2')];
      expect(await judged(old, renamed)).toEqual(additive);
      const report = await diffDocuments(
        siteDocument(openapi, sites.response, ...old),
        siteDocument(openapi, sites.response, ...renamed),
      );
      expect(report.changes.map((change) => `${change.kind}: ${change.classification}`)).toEqual([
        'model-added: additive',
        'model-removed: breaking',
        'operation-modified: additive',
      ]);
      expect(exitOf(report)).toBe(2);
    });

    it('judges a limit by side: tightened breaks a request body, and nothing breaks a response', async () => {
      const limited = (maxLength: number): Schema =>
        object({ ...petFields, name: { type: 'string', maxLength } }, ['id', 'name']);
      const to = (schema: Schema): [Schemas, Schema] => [{ Pet: BasePet, Pet2: schema }, ref('Pet2')];
      expect(await judged(old, to(limited(5)))).toEqual({ response: 'additive', request: 'breaking' });
      expect(await judged(to(limited(5)), old)).toEqual(additive);
      const from = (schema: Schema): [Schemas, Schema] => [{ Pet: schema, Pet2: limited(10) }, ref('Pet')];
      const moved = (schema: Schema): [Schemas, Schema] => [{ Pet: schema, Pet2: limited(10) }, ref('Pet2')];
      expect(await judged(from(limited(5)), moved(limited(5)))).toEqual(additive);
      expect(await judged(from(limited(20)), moved(limited(20)))).toEqual({
        response: 'additive',
        request: 'breaking',
      });
    });

    it('reads a limit on a union variant whose items are an identical model under another name (Greptile, #758 review round 1)', async () => {
      const Child = object({ id: string });
      const kids = (child: string, maxItems: number): Schema =>
        object({ id: string, kids: { anyOf: [{ type: 'array', items: ref(child), maxItems }, string] } }, ['id']);
      const moved = (before: number, after: number): [[Schemas, Schema], [Schemas, Schema]] => {
        const declared = { Child, ChildCopy: Child, Pet: kids('Child', before) };
        return [
          [declared, ref('Pet')],
          [{ ...declared, Pet2: kids('ChildCopy', after) }, ref('Pet2')],
        ];
      };
      expect(await judged(...moved(10, 5))).toEqual({ response: 'additive', request: 'breaking' });
      expect(await judged(...moved(5, 10))).toEqual(additive);
      expect(await judged(...moved(10, 10))).toEqual(additive);
    });

    it('keeps a `oneOf` whose branch admits more breaking for a request, since a body may now match two (Greptile, #758 review round 3)', async () => {
      const branches = (keyword: 'oneOf' | 'anyOf', maxLength: number): Schema => ({
        [keyword]: [
          { type: 'string', maxLength },
          { type: 'string', minLength: 6 },
        ],
      });
      const codes = (keyword: 'oneOf' | 'anyOf'): Schemas => ({
        Code: branches(keyword, 5),
        Code2: branches(keyword, 10),
      });
      const moved = (keyword: 'oneOf' | 'anyOf', from: string, to: string) =>
        judged([codes(keyword), ref(from)], [codes(keyword), ref(to)]);
      // `'abcdef'` matched the second branch of `Code` alone, and matches both branches of `Code2`.
      expect(await moved('oneOf', 'Code', 'Code2')).toEqual({ response: 'additive', request: 'breaking' });
      expect(await moved('oneOf', 'Code2', 'Code')).toEqual({ response: 'additive', request: 'breaking' });
      // An `anyOf` admits it either way; only the tightened branch breaks a request.
      expect(await moved('anyOf', 'Code', 'Code2')).toEqual(additive);
      expect(await moved('anyOf', 'Code2', 'Code')).toEqual({ response: 'additive', request: 'breaking' });
    });

    it('passes over deprecation, on a field and on the model, so a body can move off a deprecated model', async () => {
      const deprecatedName = object({ ...petFields, name: { type: 'string', deprecated: true } }, ['id', 'name']);
      expect(await judged(old, [{ Pet: BasePet, Pet2: deprecatedName }, ref('Pet2')])).toEqual(additive);
      const legacy = { ...BasePet, deprecated: true };
      const successor = object({ ...petFields, tag: string }, ['id', 'name']);
      expect(await judged([{ Pet: legacy }, ref('Pet')], [{ Pet: legacy, Pet2: successor }, ref('Pet2')])).toEqual(
        additive,
      );
      expect(await judged([{ Pet: BasePet }, ref('Pet')], [{ Pet: BasePet, Pet2: legacy }, ref('Pet2')])).toEqual(
        additive,
      );
    });

    it('keeps a model that changes a field’s access flag or default breaking', async () => {
      const readOnly = object({ ...petFields, nickname: { type: 'string', readOnly: true } }, ['id', 'name']);
      const defaulted = object({ ...petFields, nickname: { type: 'string', default: 'rex' } }, ['id', 'name']);
      for (const schema of [readOnly, defaulted]) {
        expect(await judged(old, [{ Pet: BasePet, Pet2: schema }, ref('Pet2')])).toEqual(breaking);
        expect(await judged([{ Pet: BasePet, Pet2: schema }, ref('Pet2')], old)).toEqual(breaking);
      }
    });

    it('reads an inline enum and an inline object the parser names after each model as one type, new or not', async () => {
      const properties = {
        id: string,
        size: { type: 'string', enum: ['small', 'large'] },
        home: object({ city: string }),
      };
      const inline = object(properties, ['id']);
      const grown = object({ ...properties, tag: string }, ['id']);
      // `Pet.size` is the enum `PetSize` and `Pet2.size` the enum `Pet2Size`; `home` likewise.
      expect(await judged([{ Pet: inline }, ref('Pet')], [{ Pet: inline, Pet2: grown }, ref('Pet2')])).toEqual(
        additive,
      );
      const declared = { Pet: inline, Pet2: grown };
      expect(await judged([declared, ref('Pet')], [declared, ref('Pet2')])).toEqual(additive);
      expect(await judged([declared, ref('Pet2')], [declared, ref('Pet')])).toEqual(breaking);
      // An enum with another value, or an object with another field, is another type.
      const widened = object({ ...properties, size: { type: 'string', enum: ['small', 'large', 'huge'] } }, ['id']);
      expect(await judged([{ Pet: inline }, ref('Pet')], [{ Pet: inline, Pet2: widened }, ref('Pet2')])).toEqual(
        breaking,
      );
      const moved = object({ ...properties, home: object({ city: string, zip: string }, ['city']) }, ['id']);
      expect(await judged([{ Pet: inline }, ref('Pet')], [{ Pet: inline, Pet2: moved }, ref('Pet2')])).toEqual(
        breaking,
      );
    });

    it('reads a model that refers to itself, and the model built on it', async () => {
      const node = object({ id: string, parent: ref('Pet') }, ['id']);
      expect(
        await judged([{ Pet: node }, ref('Pet')], [{ Pet: node, Pet2: { allOf: [ref('Pet'), tag] } }, ref('Pet2')]),
      ).toEqual(additive);
    });
  });

  // -------------------------------------------------------------------------
  // Beside another change, and what is left as it was
  // -------------------------------------------------------------------------

  describe.each(OPENAPI_VERSIONS)('beside another change, OpenAPI %s', (openapi) => {
    const moved = { Pet: BasePet, Pet2: EDITS['an optional field added'] };

    it('stays breaking when the operation also changed in a way that is breaking on its own', async () => {
      const verbose = { name: 'verbose', in: 'query', schema: string };
      const before = document(openapi, getPet({ '200': response('OK', ref('Pet')) }, [...petId, verbose]), moved);
      const after = document(openapi, getPet({ '200': response('OK', ref('Pet2')) }), moved);
      const forward = bodyChange(await diffDocuments(before, after));
      expect(forward).toMatchObject({
        responseChanged: true,
        paramChanges: [{ kind: 'param-removed', paramName: 'verbose', classification: 'breaking' }],
        classification: 'breaking',
      });
      // Backward the parameter is added, optional: additive, and the body is compatible both ways?
      // No: `Pet2` → `Pet` drops `tag`, so the body is what breaks there.
      expect(bodyChange(await diffDocuments(after, before)).classification).toBe('breaking');
      const identical = { Pet: BasePet, Pet2: BasePet };
      expect(
        bodyChange(
          await diffDocuments(
            document(openapi, getPet({ '200': response('OK', ref('Pet2')) }), identical),
            document(openapi, getPet({ '200': response('OK', ref('Pet')) }, [...petId, verbose]), identical),
          ),
        ),
      ).toMatchObject({
        responseChanged: true,
        paramChanges: [{ kind: 'param-added', paramName: 'verbose', classification: 'additive' }],
        classification: 'additive',
      });
    });

    it('judges each body of one operation on its own', async () => {
      // The response gains a required field (fine to read) while the request gains one too (breaking to build).
      const required = { allOf: [ref('Pet'), { ...tag, required: ['tag'] }] };
      const paths = (name: string) => ({
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: { required: true, ...json(ref(name)) },
            responses: { '200': response('OK', ref(name)), '400': response('Bad Request', ref(name)) },
          },
        },
      });
      const both = async (schema: Schema) =>
        bodyChange(
          await diffDocuments(
            document(openapi, paths('Pet'), { Pet: BasePet }),
            document(openapi, paths('Pet2'), { Pet: BasePet, Pet2: schema }),
          ),
        );
      expect(await both(required)).toMatchObject({
        responseChanged: true,
        requestBodyChanged: true,
        errorsChanged: true,
        classification: 'breaking',
      });
      expect(await both(EDITS['an optional field added'])).toMatchObject({
        responseChanged: true,
        requestBodyChanged: true,
        errorsChanged: true,
        classification: 'additive',
      });
    });

    it('keeps an encoding shift additive while the old representation still accepts the body', async () => {
      // The form body is read as `requestBody` until JSON is declared beside it.
      const form = (name: string) =>
        createPet({ required: true, content: { 'application/x-www-form-urlencoded': { schema: ref(name) } } });
      const formAndJson = (name: string) =>
        createPet({
          required: true,
          content: {
            'application/json': { schema: ref(name) },
            'application/x-www-form-urlencoded': { schema: ref(name) },
          },
        });
      const encoded = async (schema: Schema) =>
        bodyChange(
          await diffDocuments(
            document(openapi, form('Pet'), { Pet: BasePet }),
            document(openapi, formAndJson('Pet2'), { Pet: BasePet, Pet2: schema }),
          ),
        );
      expect(await encoded(EDITS['an optional field added'])).toMatchObject({
        requestBodyChanged: true,
        requestBodyEncodingChanged: true,
        classification: 'additive',
      });
      expect(await encoded(EDITS['a required field added'])).toMatchObject({
        requestBodyChanged: true,
        requestBodyEncodingChanged: true,
        classification: 'breaking',
      });
    });
  });

  describe.each(OPENAPI_VERSIONS)('left as it was, OpenAPI %s', (openapi) => {
    const response200 = SITES['the success response'];
    const request = SITES['the request body'];
    const breakingOnBoth = async (before: [Schemas, Schema], after: [Schemas, Schema]) => {
      for (const site of [response200, request]) {
        for (const [from, to] of [
          [before, after],
          [after, before],
        ]) {
          const report = await diffDocuments(siteDocument(openapi, site, ...from), siteDocument(openapi, site, ...to));
          expect(bodyChange(report).classification).toBe('breaking');
        }
      }
    };

    it('a field typed by another model that is itself only compatible is a retyped field', async () => {
      const Owner = object({ id: string });
      const owned = (owner: string) => object({ id: string, owner: ref(owner) }, ['id']);
      await breakingOnBoth(
        [{ Owner, Pet: owned('Owner') }, ref('Pet')],
        [
          { Owner, OwnerWithTag: { allOf: [ref('Owner'), tag] }, Pet: owned('Owner'), Pet2: owned('OwnerWithTag') },
          ref('Pet2'),
        ],
      );
      // A nested model with the same fields is the same type, renamed or declared by both documents.
      const renamed = await diffDocuments(
        siteDocument(openapi, response200, { Owner, Pet: owned('Owner') }, ref('Pet')),
        siteDocument(openapi, response200, { Owner2: Owner, Pet2: owned('Owner2') }, ref('Pet2')),
      );
      expect(bodyChange(renamed).classification).toBe('additive');
      const copies = { Owner, OwnerCopy: Owner, Pet: owned('Owner'), Pet2: owned('OwnerCopy') };
      for (const site of [response200, request]) {
        const copied = await diffDocuments(
          siteDocument(openapi, site, copies, ref('Pet')),
          siteDocument(openapi, site, copies, ref('Pet2')),
        );
        expect(bodyChange(copied).classification).toBe('additive');
      }
    });

    it('a field whose format alone differs, and a model that redeclares a self-reference as itself', async () => {
      await breakingOnBoth(
        [{ Pet: BasePet }, ref('Pet')],
        [
          { Pet: BasePet, Pet2: object({ ...petFields, name: { type: 'string', format: 'email' } }, ['id', 'name']) },
          ref('Pet2'),
        ],
      );
      const node = object({ id: string, parent: ref('Pet') }, ['id']);
      await breakingOnBoth(
        [{ Pet: node }, ref('Pet')],
        [{ Pet: node, Pet2: object({ id: string, parent: ref('Pet2'), tag: string }, ['id']) }, ref('Pet2')],
      );
    });

    it('a named union whose variant moved, and an enum moved to one with another value', async () => {
      const unions = {
        Pet: BasePet,
        PetTagged: { allOf: [ref('Pet'), tag] },
        PetOrDog: { oneOf: [ref('Pet'), ref('Dog')] },
        PetOrDog2: { oneOf: [ref('PetTagged'), ref('Dog')] },
      };
      await breakingOnBoth([unions, ref('PetOrDog')], [unions, ref('PetOrDog2')]);
      const enums = {
        Status: { type: 'string', enum: ['on', 'off'] },
        Status2: { type: 'string', enum: ['on', 'off', 'idle'] },
      };
      await breakingOnBoth([enums, ref('Status')], [enums, ref('Status2')]);
    });

    it('a parameter’s, a response header’s and a model field’s type moved to a compatible model', async () => {
      const schemas = { Pet: BasePet, Pet2: EDITS['an optional field added'] };
      const at = (name: string) =>
        document(
          openapi,
          {
            '/pets': {
              get: {
                operationId: 'listPets',
                parameters: [{ name: 'filter', in: 'query', content: { 'application/json': { schema: ref(name) } } }],
                responses: {
                  '200': {
                    description: 'OK',
                    headers: { 'X-Pet': { content: { 'application/json': { schema: ref(name) } } } },
                    ...json(object({ pet: ref(name) })),
                  },
                },
              },
            },
          },
          schemas,
        );
      const report = await diffDocuments(at('Pet'), at('Pet2'));
      expect(report.changes).toMatchObject([
        {
          kind: 'model-modified',
          name: 'ListPetsResponse',
          fieldChanges: [{ kind: 'field-type-changed', fieldName: 'pet', classification: 'breaking' }],
          classification: 'breaking',
        },
        {
          kind: 'operation-modified',
          paramChanges: [{ kind: 'param-type-changed', paramName: 'filter', classification: 'breaking' }],
          responseChanged: false,
          responseHeaderChanges: [{ kind: 'header-type-changed', headerName: 'X-Pet', classification: 'breaking' }],
          classification: 'breaking',
        },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // What earlier tests pinned as breaking for a body that only gained a field
  // -------------------------------------------------------------------------

  describe.each(OPENAPI_VERSIONS)('a secondary body under a renamed model, OpenAPI %s', (openapi) => {
    const title = { title: string };
    /** Two YAML keys beside the JSON primary; the parser names the model of `version=<v>` after the key. */
    const versioned = (v: number, properties: Record<string, Schema>, site: 'response' | 'request') => {
      const content = {
        'application/json': { schema: ref('Dog') },
        [`application/yaml; version=${v}`]: { schema: { type: 'object', properties } },
        'application/yaml; version=2': { schema: { type: 'object', properties: { summary: string } } },
      };
      return document(
        openapi,
        site === 'response'
          ? getPet({ '200': { description: 'OK', content } })
          : createPet({ required: true, content }),
        { Dog },
      );
    };

    it.each(['response', 'request'] as const)(
      'lists the %s body as retyped either way, breaking only when it lost or retyped a field',
      async (site) => {
        const lists = (change: BodyChange): unknown =>
          change.kind === 'operation-modified' &&
          (site === 'response' ? change.responseContentTypeChanges[0] : change.requestBodyContentTypeChange);
        for (const [properties, classification] of [
          [{ ...title, pages: { type: 'integer' } }, 'additive'],
          [{ pages: { type: 'integer' } }, 'breaking'],
          [{ title: { type: 'integer' } }, 'breaking'],
        ] as const) {
          const report = await diffDocuments(versioned(1, title, site), versioned(3, properties, site));
          const change = bodyChange(report);
          expect(lists(change)).toMatchObject({ retyped: ['application/yaml; version=3'], classification });
          expect(change.classification).toBe(classification);
        }
      },
    );
  });
});

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

describe('#753 compatibleShape', () => {
  const str: TypeRef = { kind: 'primitive', type: 'string' };
  const int: TypeRef = { kind: 'primitive', type: 'integer' };
  const model = (name: string): TypeRef => ({ kind: 'model', name });
  const field = (name: string, type: TypeRef, required: boolean, extra: Partial<Field> = {}): Field => ({
    name,
    type,
    required,
    ...extra,
  });
  const shapesOf = (
    old: { models?: Model[]; enums?: Enum[] },
    next: { models?: Model[]; enums?: Enum[] },
  ): DocumentShapes => ({
    old: documentTypes({ models: old.models ?? [], enums: old.enums ?? [] }),
    new: documentTypes({ models: next.models ?? [], enums: next.enums ?? [] }),
  });
  const pet: Model = { name: 'Pet', fields: [field('id', str, true), field('nickname', str, false)] };
  /** Whether a body moved from `Pet` to `next` (named `Pet2`) is compatible for a reader, and for a writer. */
  const moved = (next: Omit<Model, 'name'>, old: Model = pet) => {
    const shapes = shapesOf({ models: [old] }, { models: [old, { ...next, name: 'Pet2' }] });
    return {
      reader: compatibleShape(model(old.name), model('Pet2'), 'reader', shapes),
      writer: compatibleShape(model(old.name), model('Pet2'), 'writer', shapes),
    };
  };
  const both = { reader: true, writer: true };
  const neither = { reader: false, writer: false };

  it('judges each field edit from the side the body is on', () => {
    const [id, nickname] = pet.fields;
    expect(moved({ fields: [id, nickname] })).toEqual(both);
    expect(moved({ fields: [id, nickname, field('tag', str, false)] })).toEqual(both);
    expect(moved({ fields: [id, nickname, field('tag', str, true)] })).toEqual({ reader: true, writer: false });
    expect(moved({ fields: [field('id', str, false), nickname] })).toEqual({ reader: false, writer: true });
    expect(moved({ fields: [id, field('nickname', str, true)] })).toEqual({ reader: true, writer: false });
    expect(moved({ fields: [id] })).toEqual(neither);
    expect(moved({ fields: [field('id', int, true), nickname] })).toEqual(neither);
    // The order the fields are declared in is no shape.
    expect(moved({ fields: [nickname, id] })).toEqual(both);
    // A model with no field gives a reader nothing to miss, and accepts whatever requires nothing.
    expect(moved({ fields: [] })).toEqual(neither);
    expect(moved(pet, { name: 'Empty', fields: [] })).toEqual({ reader: true, writer: false });
    expect(moved({ fields: [field('tag', str, false)] }, { name: 'Empty', fields: [] })).toEqual(both);
  });

  it('judges limits as the differ judges them on a model of that direction, at every level of a field’s type', () => {
    const limited = (maxLength: number): TypeRef => ({ ...str, constraints: { maxLength } });
    const named = (type: TypeRef, constraints?: Field['constraints']): Model => ({
      name: 'Pet',
      fields: [field('name', type, true, constraints ? { constraints } : {})],
    });
    const tightened = { reader: true, writer: false };
    // The field's own limits, and its type's.
    expect(moved(named(limited(5), { maxLength: 5 }), named(limited(10), { maxLength: 10 }))).toEqual(tightened);
    expect(moved(named(limited(10), { maxLength: 10 }), named(limited(5), { maxLength: 5 }))).toEqual(both);
    expect(moved(named(limited(5), { maxLength: 5 }), named(str))).toEqual(tightened);
    expect(moved(named(str), named(limited(5), { maxLength: 5 }))).toEqual(both);
    // An array's items, a map's values, a nullable's inner type.
    const array = (items: TypeRef): TypeRef => ({ kind: 'array', items });
    const map = (valueType: TypeRef): TypeRef => ({ kind: 'map', valueType });
    const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
    for (const wrap of [array, map, nullable, (type: TypeRef) => array(nullable(type))]) {
      expect(moved(named(wrap(limited(5))), named(wrap(limited(10))))).toEqual(tightened);
      expect(moved(named(wrap(limited(10))), named(wrap(limited(5))))).toEqual(both);
    }
    // The model's own.
    expect(moved({ ...pet, constraints: { maxProperties: 1 } }, pet)).toEqual(tightened);
    expect(moved(pet, { ...pet, constraints: { maxProperties: 1 } })).toEqual(both);
  });

  it('passes over documentation, provenance and deprecation, and nothing else a field or a model carries', () => {
    const [id, nickname] = pet.fields;
    const documented: Omit<Model, 'name'> = {
      description: 'A pet.',
      deprecated: true,
      bases: [model('Animal')],
      extensions: { 'x-internal': true },
      fields: [
        { ...id, description: 'The id.', example: 'pet_1', inheritedFrom: model('Animal'), deprecated: true },
        { ...nickname, extensions: { 'x-order': 2 } },
      ],
    };
    expect(moved(documented)).toEqual(both);
    expect(moved(pet, { ...documented, name: 'Pet' })).toEqual(both);
    for (const changed of [
      { ...nickname, readOnly: true },
      { ...nickname, writeOnly: true },
      { ...nickname, default: 'rex' },
      { ...nickname, domainName: 'alias' },
    ]) {
      expect(moved({ fields: [id, changed] })).toEqual(neither);
      expect(moved(pet, { name: 'Pet', fields: [id, changed] })).toEqual(neither);
    }
    expect(moved({ ...pet, typeParams: [{ name: 'T' }] })).toEqual(neither);
  });

  it('compares a field’s type as one shape, whatever names it carries, and never by compatibility', () => {
    const owner: Model = { name: 'Owner', fields: [field('id', str, true)] };
    const owned = (name: string, ownerName: string): Model => ({
      name,
      fields: [field('owner', model(ownerName), true)],
    });
    const tagged: Model = { name: 'OwnerWithTag', fields: [...owner.fields, field('tag', str, false)] };
    const judge = (old: Model[], next: Model[], to: string) => {
      const shapes = shapesOf({ models: old }, { models: next });
      return {
        reader: compatibleShape(model('Pet'), model(to), 'reader', shapes),
        writer: compatibleShape(model('Pet'), model(to), 'writer', shapes),
      };
    };
    const before = [owner, owned('Pet', 'Owner')];
    // The same nested model, by name.
    expect(judge(before, [...before, owned('Pet2', 'Owner')], 'Pet2')).toEqual(both);
    // A nested model that was only renamed: one shape.
    expect(
      judge(before, [{ ...owner, name: 'Owner2' }, owned('Pet', 'Owner2'), owned('Pet2', 'Owner2')], 'Pet2'),
    ).toEqual(both);
    // An identical nested model both documents declare: one shape too. Neither
    // name has to be new, under the body as at it.
    const copy = { ...owner, name: 'OwnerCopy' };
    expect(judge([...before, copy], [...before, copy, owned('Pet2', 'OwnerCopy')], 'Pet2')).toEqual(both);
    // A nested model that is only compatible: another type, on both sides.
    expect(judge(before, [...before, tagged, owned('Pet2', 'OwnerWithTag')], 'Pet2')).toEqual(neither);
    expect(judge([...before, tagged], [...before, tagged, owned('Pet2', 'OwnerWithTag')], 'Pet2')).toEqual(neither);
    // The nested model's own limits and requiredness are its shape.
    const strict: Model = { name: 'OwnerCopy', fields: [field('id', str, false)] };
    expect(judge(before, [...before, strict, owned('Pet2', 'OwnerCopy')], 'Pet2')).toEqual(neither);
    // An enum a field is typed by, minted under each model's name.
    const size = (name: string, values = ['small', 'large']): Enum => ({
      name,
      values: values.map((value) => ({ name: value, value })),
    });
    const sized = (name: string, enumName: string): Model => ({
      name,
      fields: [field('size', { kind: 'enum', name: enumName }, true)],
    });
    const enums = (old: Enum[], next: Enum[]) => {
      const shapes = shapesOf(
        { models: [sized('Pet', 'PetSize'), sized('Pet2', 'Pet2Size')], enums: old },
        { models: [sized('Pet', 'PetSize'), sized('Pet2', 'Pet2Size')], enums: next },
      );
      return compatibleShape(model('Pet'), model('Pet2'), 'reader', shapes);
    };
    expect(enums([size('PetSize'), size('Pet2Size')], [size('PetSize'), size('Pet2Size')])).toBe(true);
    expect(enums([size('PetSize')], [size('PetSize'), size('Pet2Size')])).toBe(true);
    expect(enums([size('PetSize')], [size('PetSize'), size('Pet2Size', ['small', 'large', 'huge'])])).toBe(false);
  });

  it('does not ask whether either name is new to its document, where `sameShape` does', () => {
    const copy: Model = { ...pet, name: 'PetCopy' };
    const shapes = shapesOf({ models: [pet, copy] }, { models: [pet, copy] });
    expect(sameShape(model('Pet'), model('PetCopy'), shapes)).toBe(false);
    expect(compatibleShape(model('Pet'), model('PetCopy'), 'reader', shapes)).toBe(true);
    expect(compatibleShape(model('Pet'), model('PetCopy'), 'writer', shapes)).toBe(true);
    // An enum body is read the same way: the same values, under whatever name.
    const level = (name: string, values: string[]): Enum => ({
      name,
      values: values.map((value) => ({ name: value, value })),
    });
    const declared = [level('Level', ['low', 'high']), level('Grade', ['low', 'high']), level('Tier', ['low'])];
    const enumShapes = shapesOf({ enums: declared }, { enums: declared });
    const enumRef = (name: string): TypeRef => ({ kind: 'enum', name });
    expect(sameShape(enumRef('Level'), enumRef('Grade'), enumShapes)).toBe(false);
    for (const side of ['reader', 'writer'] as const) {
      expect(compatibleShape(enumRef('Level'), enumRef('Grade'), side, enumShapes)).toBe(true);
      expect(compatibleShape(enumRef('Level'), enumRef('Tier'), side, enumShapes)).toBe(false);
      expect(compatibleShape(enumRef('Tier'), enumRef('Level'), side, enumShapes)).toBe(false);
    }
    // The old model is read in the old document and the new one in the new document.
    const grown: Model = { ...copy, fields: [...copy.fields, field('tag', str, true)] };
    const swapped = shapesOf({ models: [pet, copy] }, { models: [pet, grown] });
    expect(compatibleShape(model('Pet'), model('PetCopy'), 'writer', swapped)).toBe(false);
    expect(compatibleShape(model('PetCopy'), model('Pet'), 'writer', swapped)).toBe(true);
  });

  it('is compatible on both sides wherever `sameShape` reads one shape with the same union keywords and limits', () => {
    const level: Enum = {
      name: 'Level',
      values: [
        { name: 'Low', value: 'low' },
        { name: 'High', value: 'high' },
      ],
    };
    const shapes = shapesOf(
      { models: [pet], enums: [level] },
      { models: [{ ...pet, name: 'Animal' }], enums: [{ ...level, name: 'Grade' }] },
    );
    const enumRef = (name: string): TypeRef => ({ kind: 'enum', name });
    const pairs: Array<[TypeRef, TypeRef]> = [
      [str, str],
      [model('Pet'), model('Pet')],
      [model('Pet'), model('Animal')],
      [enumRef('Level'), enumRef('Grade')],
      [
        { kind: 'array', items: model('Pet') },
        { kind: 'array', items: model('Animal') },
      ],
      [
        { kind: 'union', variants: [model('Pet'), str] },
        { kind: 'union', variants: [model('Animal'), str] },
      ],
    ];
    for (const [a, b] of pairs) {
      expect(sameShape(a, b, shapes)).toBe(true);
      expect(compatibleShape(a, b, 'reader', shapes)).toBe(true);
      expect(compatibleShape(a, b, 'writer', shapes)).toBe(true);
    }
    // `sameShape` passes over a union's keyword and the limits around a renamed
    // model; this vouches for the pair, so it reads both.
    const anyOf: TypeRef = { kind: 'union', compositionKind: 'anyOf', variants: [model('Pet'), str] };
    const oneOf: TypeRef = { kind: 'union', compositionKind: 'oneOf', variants: [model('Animal'), str] };
    expect(sameShape(anyOf, oneOf, shapes)).toBe(true);
    expect(compatibleShape(anyOf, oneOf, 'reader', shapes)).toBe(false);
    expect(compatibleShape(anyOf, oneOf, 'writer', shapes)).toBe(false);
    const items = (name: string, maxItems: number): TypeRef => ({
      kind: 'array',
      items: model(name),
      constraints: { maxItems },
    });
    expect(sameShape(items('Pet', 10), items('Animal', 5), shapes)).toBe(true);
    expect(compatibleShape(items('Pet', 10), items('Animal', 5), 'reader', shapes)).toBe(true);
    expect(compatibleShape(items('Pet', 10), items('Animal', 5), 'writer', shapes)).toBe(false);
    expect(compatibleShape(items('Pet', 5), items('Animal', 10), 'writer', shapes)).toBe(true);
    // Two types `typeRefsEqual` reads as one are no type change anywhere in the differ, and none here.
    const same: TypeRef = { ...anyOf, compositionKind: 'oneOf' };
    expect(compatibleShape(anyOf, same, 'writer', shapes)).toBe(true);
    expect(compatibleShape(items('Pet', 10), items('Pet', 5), 'writer', shapes)).toBe(true);
  });

  it('compares every inline union’s composition keyword, at the body and under it (Greptile, #758 review round 1)', () => {
    const dog: Model = { name: 'Dog', fields: [field('id', str, true)] };
    const pet2: Model = { name: 'Pet2', fields: [...pet.fields, field('tag', str, false)] };
    const union = (kind: 'anyOf' | 'oneOf' | undefined, first: string): TypeRef => ({
      kind: 'union',
      variants: [model(first), model('Dog')],
      ...(kind ? { compositionKind: kind } : {}),
    });
    const shapes = shapesOf({ models: [pet, dog] }, { models: [pet, pet2, dog] });
    const judge = (a: TypeRef, b: TypeRef, documents = shapes) => ({
      reader: compatibleShape(a, b, 'reader', documents),
      writer: compatibleShape(a, b, 'writer', documents),
    });
    // The finding: `anyOf: [Pet, Dog]` → `oneOf: [Pet2, Dog]` rejects a body that matches both variants.
    expect(judge(union('anyOf', 'Pet'), union('oneOf', 'Pet2'))).toEqual(neither);
    expect(judge(union('oneOf', 'Pet'), union('anyOf', 'Pet2'))).toEqual(neither);
    expect(judge(union('anyOf', 'Pet'), union('anyOf', 'Pet2'))).toEqual(both);
    expect(judge(union('oneOf', 'Pet'), union('oneOf', 'Pet2'))).toEqual(both);
    // Written on one side only is another keyword too, as `addedUnionVariants` reads it.
    expect(judge(union(undefined, 'Pet'), union('oneOf', 'Pet2'))).toEqual(neither);
    expect(judge(union(undefined, 'Pet'), union(undefined, 'Pet2'))).toEqual(both);
    // Under a wrapper, and in a variant that is a union itself.
    const array = (items: TypeRef): TypeRef => ({ kind: 'array', items });
    expect(judge(array(union('anyOf', 'Pet')), array(union('oneOf', 'Pet2')))).toEqual(neither);
    const outer = (inner: TypeRef): TypeRef => ({ kind: 'union', compositionKind: 'oneOf', variants: [inner, str] });
    expect(judge(outer(union('anyOf', 'Pet')), outer(union('oneOf', 'Pet2')))).toEqual(neither);
    expect(judge(outer(union('anyOf', 'Pet')), outer(union('anyOf', 'Pet2')))).toEqual(both);
    // A union inside the moved model: its variants are the same by name, its keyword is not.
    const holder = (name: string, kind: 'anyOf' | 'oneOf'): Model => ({
      name,
      fields: [field('pet', { kind: 'union', compositionKind: kind, variants: [model('Pet'), model('Dog')] }, true)],
    });
    const inside = (old: Model[], next: Model[]) =>
      judge(model('Home'), model('Home2'), shapesOf({ models: [pet, dog, ...old] }, { models: [pet, dog, ...next] }));
    const [any, one] = [holder('Home', 'anyOf'), holder('Home2', 'oneOf')];
    expect(inside([any], [any, one])).toEqual(neither);
    expect(inside([any], [one])).toEqual(neither);
    expect(inside([any, one], [any, one])).toEqual(neither);
    expect(inside([any], [any, holder('Home2', 'anyOf')])).toEqual(both);
    // And inside a model a field of the moved model is typed by.
    const street = (name: string, home: string): Model => ({ name, fields: [field('home', model(home), true)] });
    expect(
      judge(
        model('Street'),
        model('Street2'),
        shapesOf(
          { models: [pet, dog, any, street('Street', 'Home')] },
          { models: [pet, dog, any, one, street('Street', 'Home'), street('Street2', 'Home2')] },
        ),
      ),
    ).toEqual(neither);
  });

  it('reads the limits in the pairs the shape comparison made, around the body’s model and under a field (Greptile, #758 review round 1)', () => {
    const child = (name: string): Model => ({ name, fields: [field('id', str, true)] });
    const kids = (childName: string, maxItems: number): TypeRef => ({
      kind: 'union',
      compositionKind: 'anyOf',
      variants: [{ kind: 'array', items: model(childName), constraints: { maxItems } }, str],
    });
    const parent = (name: string, childName: string, maxItems: number): Model => ({
      name,
      fields: [field('kids', kids(childName, maxItems), true)],
    });
    const judge = (before: number, after: number, to = 'ChildCopy') => {
      const declared = [child('Child'), child('ChildCopy'), parent('Pet', 'Child', before)];
      const shapes = shapesOf({ models: declared }, { models: [...declared, parent('Pet2', to, after)] });
      return {
        reader: compatibleShape(model('Pet'), model('Pet2'), 'reader', shapes),
        writer: compatibleShape(model('Pet'), model('Pet2'), 'writer', shapes),
      };
    };
    const readerOnly = { reader: true, writer: false };
    // The finding: `anyOf: [Child[] maxItems 10, string]` → `anyOf: [ChildCopy[] maxItems 5, string]`,
    // `Child` and `ChildCopy` identical. The arrays are one shape and do not pair by name.
    expect(judge(10, 5)).toEqual(readerOnly);
    expect(judge(5, 10)).toEqual(both);
    expect(judge(10, 10)).toEqual(both);
    // The same items by name pair as on any field.
    expect(judge(10, 5, 'Child')).toEqual(readerOnly);
    expect(judge(5, 10, 'Child')).toEqual(both);
    // Two variants of one type that changed places with their limits are still the same union.
    const pattern: TypeRef = { ...str, constraints: { pattern: '^pet_' } };
    const patterned = (name: string, variants: TypeRef[]): Model => ({
      name,
      fields: [field('code', { kind: 'union', compositionKind: 'anyOf', variants }, true)],
    });
    const reordered = shapesOf(
      { models: [patterned('Pet', [pattern, str])] },
      { models: [patterned('Pet', [pattern, str]), patterned('Pet2', [str, pattern])] },
    );
    expect(compatibleShape(model('Pet'), model('Pet2'), 'writer', reordered)).toBe(true);

    // Around the body's own model: an array's, a map's, a union variant's limits.
    const grown: Model = { name: 'Pet2', fields: [...pet.fields, field('tag', str, false)] };
    const shapes = shapesOf({ models: [pet] }, { models: [pet, grown] });
    const array = (name: string, maxItems?: number): TypeRef => ({
      kind: 'array',
      items: model(name),
      ...(maxItems === undefined ? {} : { constraints: { maxItems } }),
    });
    const map = (name: string, maxProperties?: number): TypeRef => ({
      kind: 'map',
      valueType: model(name),
      ...(maxProperties === undefined ? {} : { constraints: { maxProperties } }),
    });
    const around = (a: TypeRef, b: TypeRef) => ({
      reader: compatibleShape(a, b, 'reader', shapes),
      writer: compatibleShape(a, b, 'writer', shapes),
    });
    expect(around(array('Pet', 10), array('Pet2', 5))).toEqual(readerOnly);
    expect(around(array('Pet'), array('Pet2', 5))).toEqual(readerOnly);
    expect(around(array('Pet', 5), array('Pet2', 10))).toEqual(both);
    expect(around(array('Pet', 5), array('Pet2'))).toEqual(both);
    expect(around(map('Pet', 10), map('Pet2', 5))).toEqual(readerOnly);
    expect(around(map('Pet', 5), map('Pet2', 10))).toEqual(both);
    const nested = (name: string, maxItems: number, compositionKind?: 'anyOf' | 'oneOf'): TypeRef => ({
      kind: 'nullable',
      inner: { kind: 'union', variants: [array(name, maxItems), str], ...(compositionKind ? { compositionKind } : {}) },
    });
    expect(around(nested('Pet', 10, 'anyOf'), nested('Pet2', 5, 'anyOf'))).toEqual(readerOnly);
    expect(around(nested('Pet', 5, 'anyOf'), nested('Pet2', 10, 'anyOf'))).toEqual(both);
    // A variant of a union that is not an `anyOf` keeps its limits (round 3, below).
    for (const keyword of ['oneOf', undefined] as const) {
      expect(around(nested('Pet', 10, keyword), nested('Pet2', 5, keyword))).toEqual(readerOnly);
      expect(around(nested('Pet', 5, keyword), nested('Pet2', 10, keyword))).toEqual(readerOnly);
      expect(around(nested('Pet', 5, keyword), nested('Pet2', 5, keyword))).toEqual(both);
    }
  });

  it('looks through the same wrapper on both sides, and through nothing else', () => {
    const grown: Model = { name: 'Pet2', fields: [...pet.fields, field('tag', str, true)] };
    const shapes = shapesOf({ models: [pet] }, { models: [pet, grown] });
    const judge = (a: TypeRef, b: TypeRef) => ({
      reader: compatibleShape(a, b, 'reader', shapes),
      writer: compatibleShape(a, b, 'writer', shapes),
    });
    const readerOnly = { reader: true, writer: false };
    const [a, b] = [model('Pet'), model('Pet2')];
    const array = (items: TypeRef): TypeRef => ({ kind: 'array', items });
    const map = (valueType: TypeRef): TypeRef => ({ kind: 'map', valueType });
    const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
    const union = (variants: TypeRef[], mapping?: Record<string, string>): TypeRef => ({
      kind: 'union',
      variants,
      ...(mapping ? { discriminator: { property: 'kind', mapping } } : {}),
    });
    expect(judge(a, b)).toEqual(readerOnly);
    for (const wrap of [array, map, nullable, (type: TypeRef) => array(nullable(map(type)))]) {
      expect(judge(wrap(a), wrap(b))).toEqual(readerOnly);
    }
    expect(judge(union([a, str]), union([b, str]))).toEqual(readerOnly);
    expect(judge(union([a, str], { pet: 'Pet' }), union([b, str], { pet: 'Pet2' }))).toEqual(readerOnly);
    // A wrapper on one side only, or another one.
    expect(judge(a, array(b))).toEqual(neither);
    expect(judge(array(a), b)).toEqual(neither);
    expect(judge(array(a), map(b))).toEqual(neither);
    expect(judge(a, nullable(b))).toEqual(neither);
    // A union reordered, widened or narrowed beside the move, or dispatched another way.
    expect(judge(union([a, str]), union([str, b]))).toEqual(neither);
    expect(judge(union([a, str]), union([b, str, int]))).toEqual(neither);
    expect(judge(union([a, str]), union([b]))).toEqual(neither);
    expect(judge(union([a, str], { pet: 'Pet' }), union([b, str]))).toEqual(neither);
    expect(judge(union([a, str]), union([b, str], { pet: 'Pet2' }))).toEqual(neither);
    expect(judge(union([a, str], { pet: 'Pet' }), union([b, str], { animal: 'Pet2' }))).toEqual(neither);
    expect(judge(union([a, str], { pet: 'Pet' }), union([b, str], { pet: 'Pet' }))).toEqual(readerOnly);
    expect(
      judge(union([a, str], { pet: 'Pet' }), {
        kind: 'union',
        variants: [b, str],
        discriminator: { property: 'type', mapping: { pet: 'Pet2' } },
      }),
    ).toEqual(neither);
    // A primitive, a literal or an enum is compatible only as one shape.
    expect(judge(str, int)).toEqual(neither);
    expect(judge({ kind: 'literal', value: 'a' }, { kind: 'literal', value: 'b' })).toEqual(neither);
    expect(judge(a, str)).toEqual(neither);
  });

  it('reads two variants of one type that changed places with their limits as the same union, beside a moved one (Greptile, #758 review round 2)', () => {
    const patterned: TypeRef = { ...str, constraints: { pattern: '^pet_' } };
    const union = (variants: TypeRef[]): TypeRef => ({ kind: 'union', compositionKind: 'anyOf', variants });
    const grown: Model = { name: 'Pet2', fields: [...pet.fields, field('tag', str, false)] };
    const shapes = shapesOf({ models: [pet] }, { models: [pet, grown] });
    const judge = (a: TypeRef, b: TypeRef, documents = shapes) => ({
      reader: compatibleShape(a, b, 'reader', documents),
      writer: compatibleShape(a, b, 'writer', documents),
    });
    const readerOnly = { reader: true, writer: false };
    const [a, b] = [model('Pet'), model('Pet2')];
    // The finding: the inner union admits the same strings, its variants written the other way round.
    expect(judge(union([a, union([patterned, str])]), union([b, union([str, patterned])]))).toEqual(both);
    // The same in the union the moved variant is in.
    expect(judge(union([a, patterned, str]), union([b, str, patterned]))).toEqual(both);
    expect(judge(union([patterned, a, str]), union([str, b, patterned]))).toEqual(both);
    // A `pattern` really added is still read, wherever it is written, and one dropped is loosened.
    expect(judge(union([a, str, str]), union([b, str, patterned]))).toEqual(readerOnly);
    expect(judge(union([a, str, str]), union([b, patterned, str]))).toEqual(readerOnly);
    expect(judge(union([a, union([str, str])]), union([b, union([patterned, str])]))).toEqual(readerOnly);
    expect(judge(union([a, patterned, str]), union([b, str, str]))).toEqual(both);
    // Under a field, beside a variant that is one shape under another name.
    const child = (name: string): Model => ({ name, fields: [field('id', str, true)] });
    const array = (name: string, maxItems?: number): TypeRef => ({
      kind: 'array',
      items: model(name),
      ...(maxItems === undefined ? {} : { constraints: { maxItems } }),
    });
    const holder = (name: string, variants: TypeRef[]): Model => ({
      name,
      fields: [field('value', union(variants), true)],
    });
    const under = (before: TypeRef[], after: TypeRef[]) => {
      const declared = [child('Child'), child('ChildCopy'), holder('Pet', before)];
      return judge(a, b, shapesOf({ models: declared }, { models: [...declared, holder('Pet2', after)] }));
    };
    expect(under([array('Child'), patterned, str], [array('ChildCopy'), str, patterned])).toEqual(both);
    expect(under([array('Child', 10), patterned, str], [array('ChildCopy', 5), str, patterned])).toEqual(readerOnly);
    expect(under([array('Child', 5), patterned, str], [array('ChildCopy', 10), str, patterned])).toEqual(both);
    // Two variants that are one shape under each other's name, their limits kept in place.
    expect(under([array('Child', 10), array('ChildCopy', 5)], [array('ChildCopy', 10), array('Child', 5)])).toEqual(
      both,
    );
    expect(under([array('Child', 10), array('ChildCopy', 5)], [array('ChildCopy', 5), array('Child', 5)])).toEqual(
      readerOnly,
    );
    // A named union's variants are read the same way.
    const named = (name: string, variants: TypeRef[]): Model => ({
      name,
      fields: [],
      variants,
      compositionKind: 'anyOf',
    });
    const moved = (before: TypeRef[], after: TypeRef[]) =>
      judge(
        model('Code'),
        model('Code2'),
        shapesOf({ models: [named('Code', before)] }, { models: [named('Code', before), named('Code2', after)] }),
      );
    expect(moved([patterned, str], [str, patterned])).toEqual(both);
    expect(moved([str, int], [patterned, int])).toEqual(readerOnly);
    expect(moved([patterned, int], [str, int])).toEqual(both);
  });

  it('puts two unions in step by shape across the two documents, never by a name that changed hands (Greptile, #758 review round 3)', () => {
    const literal = (value: string): TypeRef => ({ kind: 'literal', value });
    const kind = (name: string, value: string): Model => ({ name, fields: [field('kind', literal(value), true)] });
    const array = (name: string, maxItems: number): TypeRef => ({
      kind: 'array',
      items: model(name),
      constraints: { maxItems },
    });
    const union = (variants: TypeRef[]): TypeRef => ({ kind: 'union', compositionKind: 'anyOf', variants });
    const judge = (a: TypeRef, b: TypeRef, old: Model[], next: Model[]) => {
      const shapes = shapesOf({ models: old }, { models: next });
      return { reader: compatibleShape(a, b, 'reader', shapes), writer: compatibleShape(a, b, 'writer', shapes) };
    };
    const readerOnly = { reader: true, writer: false };
    const [a, b] = [kind('A', 'a'), kind('B', 'b')];
    // The finding: `A` and `B` exchange their definitions, and the union its variants. In order the
    // shapes agree (old `A` is new `B`) and `maxItems` drops from 10 to 5; by name nothing moved.
    const exchanged = [kind('A', 'b'), kind('B', 'a')];
    expect(
      judge(union([array('A', 10), array('B', 5)]), union([array('B', 5), array('A', 10)]), [a, b], exchanged),
    ).toEqual(readerOnly);
    // With the limits exchanged too, each variant kept its own: six items of kind `a` are still admitted.
    expect(
      judge(union([array('A', 10), array('B', 5)]), union([array('B', 10), array('A', 5)]), [a, b], exchanged),
    ).toEqual(both);
    // Unchanged models, the union's variants written the other way round beside a moved one.
    const patterned: TypeRef = { ...str, constraints: { pattern: '^a' } };
    const copy = kind('C', 'a');
    expect(
      judge(union([array('A', 10), patterned, str]), union([array('C', 10), str, patterned]), [a, b], [a, b, copy]),
    ).toEqual(both);
    expect(
      judge(union([array('A', 10), patterned, str]), union([array('C', 5), str, patterned]), [a, b], [a, b, copy]),
    ).toEqual(readerOnly);
  });

  it('asks an exact fit of a writer’s variants under a union that is not an `anyOf` (Greptile, #758 review round 3)', () => {
    const limited = (constraints: NonNullable<Field['constraints']>): TypeRef => ({ ...str, constraints });
    const readerOnly = { reader: true, writer: false };
    // The finding: a named `oneOf` whose first branch is loosened. `'abcdef'` matched the second
    // branch alone and now matches both, which a `oneOf` rejects.
    const named = (name: string, variants: TypeRef[], compositionKind: 'oneOf' | 'anyOf'): Model => ({
      name,
      fields: [],
      variants,
      compositionKind,
    });
    const moved = (before: TypeRef[], after: TypeRef[], keyword: 'oneOf' | 'anyOf') => {
      const shapes = shapesOf(
        { models: [named('Code', before, keyword)] },
        { models: [named('Code', before, keyword), named('Code2', after, keyword)] },
      );
      return {
        reader: compatibleShape(model('Code'), model('Code2'), 'reader', shapes),
        writer: compatibleShape(model('Code'), model('Code2'), 'writer', shapes),
      };
    };
    const [short, long, longer] = [limited({ maxLength: 5 }), limited({ minLength: 6 }), limited({ maxLength: 10 })];
    expect(moved([short, long], [longer, long], 'oneOf')).toEqual(readerOnly);
    expect(moved([longer, long], [short, long], 'oneOf')).toEqual(readerOnly);
    expect(moved([short, long], [short, long], 'oneOf')).toEqual(both);
    // Written the other way round, each branch with its own limits, is the same union.
    expect(moved([short, long], [long, short], 'oneOf')).toEqual(both);
    // An `anyOf` admits a value that matches two branches, so a branch may admit more.
    expect(moved([short, long], [longer, long], 'anyOf')).toEqual(both);
    expect(moved([longer, long], [short, long], 'anyOf')).toEqual(readerOnly);

    // An inline union at the body, with a moved model beside the branch.
    const grown: Model = { name: 'Pet2', fields: [...pet.fields, field('tag', str, false)] };
    const shapes = shapesOf({ models: [pet] }, { models: [pet, grown] });
    const union = (name: string, branch: TypeRef, compositionKind?: 'oneOf' | 'anyOf'): UnionType => ({
      kind: 'union',
      variants: [model(name), branch],
      ...(compositionKind ? { compositionKind } : {}),
    });
    const judge = (a: TypeRef, b: TypeRef, documents = shapes) => ({
      reader: compatibleShape(a, b, 'reader', documents),
      writer: compatibleShape(a, b, 'writer', documents),
    });
    // Written without a keyword is read as exclusive: the request-body parser writes none on a `oneOf`.
    for (const keyword of ['oneOf', undefined] as const) {
      expect(judge(union('Pet', short, keyword), union('Pet2', longer, keyword))).toEqual(readerOnly);
      expect(judge(union('Pet', longer, keyword), union('Pet2', short, keyword))).toEqual(readerOnly);
      expect(judge(union('Pet', short, keyword), union('Pet2', short, keyword))).toEqual(both);
    }
    expect(judge(union('Pet', short, 'anyOf'), union('Pet2', longer, 'anyOf'))).toEqual(both);
    // The limits the union's own schema carries bind the value whichever branch it takes: by side.
    const whole = (name: string, maxLength: number): TypeRef => ({
      ...union(name, str, 'oneOf'),
      constraints: { maxLength },
    });
    expect(judge(whole('Pet', 5), whole('Pet2', 10))).toEqual(both);
    expect(judge(whole('Pet', 10), whole('Pet2', 5))).toEqual(readerOnly);

    // A union under a field of the moved model.
    const holder = (name: string, type: TypeRef): Model => ({ name, fields: [field('code', type, true)] });
    const under = (keyword: 'oneOf' | 'anyOf', before: TypeRef, after: TypeRef) => {
      const type = (branch: TypeRef): TypeRef => ({ kind: 'union', compositionKind: keyword, variants: [branch, int] });
      const old = holder('Home', type(before));
      return judge(
        model('Home'),
        model('Home2'),
        shapesOf({ models: [old] }, { models: [old, holder('Home2', type(after))] }),
      );
    };
    expect(under('oneOf', short, longer)).toEqual(readerOnly);
    expect(under('oneOf', longer, short)).toEqual(readerOnly);
    expect(under('anyOf', short, longer)).toEqual(both);
    expect(under('anyOf', longer, short)).toEqual(readerOnly);

    // A variant that is a model: it may gain optional fields, and may not admit more of the old ones.
    const cat: Model = { name: 'Cat', fields: [field('id', str, true), field('name', str, true)] };
    const loose: Model = { name: 'Cat2', fields: [field('id', str, true), field('name', str, false)] };
    const wider: Model = { name: 'Cat3', fields: [...cat.fields, field('tag', str, false)] };
    const looser: Model = { name: 'Cat4', fields: [field('id', str, true), field('name', longer, true)] };
    const tight: Model = { name: 'Cat5', fields: [field('id', str, true), field('name', short, true)] };
    const cats = shapesOf({ models: [cat, tight, pet] }, { models: [cat, loose, wider, looser, tight, pet] });
    const variant = (name: string, keyword: 'oneOf' | 'anyOf'): UnionType => ({
      kind: 'union',
      compositionKind: keyword,
      variants: [model(name), model('Pet')],
    });
    const between = (from: string, to: string, keyword: 'oneOf' | 'anyOf') =>
      judge(variant(from, keyword), variant(to, keyword), cats);
    expect(between('Cat', 'Cat3', 'oneOf')).toEqual(both);
    expect(between('Cat', 'Cat2', 'oneOf')).toEqual(neither);
    expect(between('Cat', 'Cat2', 'anyOf')).toEqual({ reader: false, writer: true });
    // `name` loosened from `maxLength: 5` to `10`, under each keyword.
    expect(between('Cat5', 'Cat4', 'oneOf')).toEqual(readerOnly);
    expect(between('Cat5', 'Cat4', 'anyOf')).toEqual(both);
    // Outside any union the writer's rule is the request body's own.
    expect(judge(model('Cat'), model('Cat2'), cats)).toEqual({ reader: false, writer: true });
    expect(judge(model('Cat5'), model('Cat4'), cats)).toEqual(both);
    // Under an array inside the exclusive union, and under its discriminator's mapping.
    const listed = (name: string): TypeRef => ({
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [{ kind: 'array', items: model(name) }, model('Pet')],
    });
    expect(judge(listed('Cat'), listed('Cat2'), cats)).toEqual(neither);
    expect(judge(listed('Cat'), listed('Cat3'), cats)).toEqual(both);
    const mapped = (name: string): TypeRef => ({
      ...variant(name, 'oneOf'),
      discriminator: { property: 'id', mapping: { cat: name, pet: 'Pet' } },
    });
    expect(judge(mapped('Cat'), mapped('Cat2'), cats)).toEqual(neither);
    expect(judge(mapped('Cat'), mapped('Cat3'), cats)).toEqual(both);
  });

  it('compares a named union’s variants and a dispatcher’s mapping as `sameShape` does', () => {
    const cat: Model = { name: 'Cat', fields: [field('id', str, true)] };
    const catWithTag: Model = { name: 'CatWithTag', fields: [...cat.fields, field('tag', str, false)] };
    const union = (name: string, variant: string): Model => ({ name, fields: [], variants: [model(variant), str] });
    const judge = (old: Model, next: Model) => {
      const shapes = shapesOf({ models: [cat, old] }, { models: [cat, catWithTag, old, next] });
      return compatibleShape(model(old.name), model(next.name), 'reader', shapes);
    };
    expect(judge(union('Animal', 'Cat'), union('Animal2', 'Cat'))).toBe(true);
    expect(judge(union('Animal', 'Cat'), union('Animal2', 'CatWithTag'))).toBe(false);
    expect(judge(union('Animal', 'Cat'), { name: 'Animal2', fields: [] })).toBe(false);
    expect(judge(union('Animal', 'Cat'), { ...union('Animal2', 'Cat'), variants: [model('Cat'), str, int] })).toBe(
      false,
    );
    const dispatcher = (name: string, target: string): Model => ({
      name,
      fields: [field('kind', str, true)],
      discriminator: { property: 'kind', mapping: { cat: target } },
    });
    expect(judge(dispatcher('Animal', 'Cat'), dispatcher('Animal2', 'Cat'))).toBe(true);
    expect(judge(dispatcher('Animal', 'Cat'), dispatcher('Animal2', 'CatWithTag'))).toBe(false);
    expect(judge(dispatcher('Animal', 'Cat'), { name: 'Animal2', fields: [field('kind', str, true)] })).toBe(false);
  });

  it('terminates on models that refer to themselves and to each other', () => {
    const node = (name: string, next: string, extra: Field[] = []): Model => ({
      name,
      fields: [field('next', model(next), false), ...extra],
    });
    // `A → B → A` beside a renamed copy `C → D → C`, and a body moved from `A` to `C` with one more field.
    const old = [node('A', 'B'), node('B', 'A')];
    const renamed = [node('C', 'D'), node('D', 'C')];
    expect(compatibleShape(model('A'), model('C'), 'reader', shapesOf({ models: old }, { models: renamed }))).toBe(
      true,
    );
    const grown = [node('C', 'D', [field('tag', str, false)]), node('D', 'C')];
    // `next` is typed by `B` in the old model and by `D` in the new, and `B` is `D` only if `A` is `C`,
    // which now has another field: the field is retyped.
    expect(compatibleShape(model('A'), model('C'), 'reader', shapesOf({ models: old }, { models: grown }))).toBe(false);
    // The model built on a self-referential one keeps naming it.
    const self = node('Pet', 'Pet');
    const built: Model = { name: 'Pet2', fields: [...self.fields, field('tag', str, false)] };
    expect(
      compatibleShape(model('Pet'), model('Pet2'), 'writer', shapesOf({ models: [self] }, { models: [self, built] })),
    ).toBe(true);
  });

  it('compares by name alone without the documents, or for a name its document lacks', () => {
    const grown: Model = { name: 'Pet2', fields: [...pet.fields, field('tag', str, false)] };
    expect(compatibleShape(model('Pet'), model('Pet'), 'reader')).toBe(true);
    expect(compatibleShape(model('Pet'), model('Pet2'), 'reader')).toBe(false);
    expect(compatibleShape(model('Pet'), model('Pet2'), 'reader', shapesOf({ models: [] }, { models: [grown] }))).toBe(
      false,
    );
    expect(compatibleShape(model('Pet'), model('Pet2'), 'reader', shapesOf({ models: [pet] }, { models: [pet] }))).toBe(
      false,
    );
  });
});

describe('#753 diffOperations without the two documents', () => {
  const op = (over: Partial<Operation>): Operation => ({
    name: 'getPet',
    httpMethod: 'get',
    path: '/pets/{petId}',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'model', name: 'Pet' },
    errors: [],
    injectIdempotencyKey: false,
    ...over,
  });
  const pet: Model = {
    name: 'Pet',
    fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
  };
  const petWithTag: Model = {
    name: 'PetWithTag',
    fields: [...pet.fields, { name: 'tag', type: { kind: 'primitive', type: 'string' }, required: false }],
  };
  const moved: Partial<Operation> = {
    response: { kind: 'model', name: 'PetWithTag' },
    requestBody: { kind: 'model', name: 'PetWithTag' },
    errors: [{ statusCode: 400, type: { kind: 'model', name: 'PetWithTag' } }],
    defaultResponse: { type: { kind: 'model', name: 'PetWithTag' } },
  };
  const old: Partial<Operation> = {
    requestBody: { kind: 'model', name: 'Pet' },
    errors: [{ statusCode: 400, type: { kind: 'model', name: 'Pet' } }],
    defaultResponse: { type: { kind: 'model', name: 'Pet' } },
  };

  it('compares bodies by name alone, so a moved body stays breaking, as a direct caller always saw it', () => {
    for (const key of ['response', 'requestBody', 'errors', 'defaultResponse'] as const) {
      const [change] = diffOperations('Pets', [op(old)], [op({ ...old, [key]: moved[key] })]);
      expect(change, key).toMatchObject({ kind: 'operation-modified', classification: 'breaking' });
    }
  });

  it('reads the two documents’ models when it is handed them', () => {
    const shapes: DocumentShapes = {
      old: documentTypes({ models: [pet], enums: [] }),
      new: documentTypes({ models: [pet, petWithTag], enums: [] }),
    };
    for (const key of ['response', 'requestBody', 'errors', 'defaultResponse'] as const) {
      const [change] = diffOperations(
        'Pets',
        [op(old)],
        [op({ ...old, [key]: moved[key] })],
        undefined,
        undefined,
        shapes,
      );
      expect(change, key).toMatchObject({ kind: 'operation-modified', classification: 'additive' });
      // The other way a field is dropped.
      const [back] = diffOperations('Pets', [op({ ...old, [key]: moved[key] })], [op(old)], undefined, undefined, {
        old: shapes.new,
        new: shapes.old,
      });
      expect(back, key).toMatchObject({ kind: 'operation-modified', classification: 'breaking' });
    }
  });

  it('through diffSpecs, a hand-built IR is read the same way', () => {
    const spec = (operation: Operation, models: Model[]): ApiSpec =>
      ({
        name: 'Test',
        version: '1',
        baseUrl: '',
        services: [{ name: 'Pets', operations: [operation] }],
        webhooks: [],
        models,
        enums: [],
      }) as unknown as ApiSpec;
    const report = diffSpecs(spec(op({}), [pet]), spec(op({ response: moved.response }), [pet, petWithTag]));
    expect(report.changes.map((change) => `${change.kind}: ${change.classification}`)).toEqual([
      'model-added: additive',
      'operation-modified: additive',
    ]);
    expect(report.summary.breaking).toBe(0);
  });
});
