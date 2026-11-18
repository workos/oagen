import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { declaredParameterEntries, resolveParameterRef, resolveRequestBodyRef } from '../../src/parser/operations.js';
import {
  endsOnNonObject,
  followReference,
  isReferenceEntry,
  malformedRefOf,
} from '../../src/parser/reference-objects.js';
import { isResponseEntry } from '../../src/parser/response-refs.js';
import { resolvePathItemRef } from '../../src/parser/path-item-refs.js';
import { extractCallbacks } from '../../src/parser/callbacks.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Operation, Webhook } from '../../src/ir/types.js';

/**
 * Issue #664: a `$ref` to a `components/parameters` or
 * `components/requestBodies` entry that is not an object — `Limit: []`,
 * `null`, `"oops"`, `7`, `true` — failed the whole parse with an error that
 * said the entry did not exist (`Unresolved parameter $ref … no matching
 * entry under components/parameters`), while the same value written inline
 * parsed (`[]`) or failed with a `TypeError` naming neither the operation
 * nor the entry (the other four). Both spellings now go through one check:
 * the entry is warned about once, naming it and the operation, and skipped,
 * so the two spellings give one IR. A ref nothing answers, one that loops
 * and one whose `$ref` is not a string still fail the parse.
 */

const VERSIONS = ['3.0.3', '3.1.0'] as const;
/** Every non-object kind a JSON or YAML document can write, with how the warning renders it. */
const NON_OBJECTS: Array<[kind: string, value: unknown, rendered: string]> = [
  ['an array', [], '[]'],
  ['null', null, 'null'],
  ['a string', 'oops', '"oops"'],
  ['a number', 7, '7'],
  ['a boolean', true, 'true'],
];
/** Every value that is no object an entry can hold, the falsy ones a truthiness test would take for a missing entry first. */
const ENTRIES: Array<[kind: string, value: unknown]> = [
  ['null', null],
  ['false', false],
  ['zero', 0],
  ['an empty string', ''],
  ['an array', []],
  ['a string', 'oops'],
  ['a number', 7],
  ['true', true],
];
/** Everything but an array a `parameters` field can hold, with how the warning renders it. */
const NON_ARRAYS: Array<[kind: string, value: unknown, rendered: string]> = [
  ['a string', 'oops', '"oops"'],
  ['null', null, 'null'],
  ['a number', 7, '7'],
  ['a boolean', true, 'true'],
  ['an object', { limit: 'oops' }, '{"limit":"oops"}'],
];
const info = { title: 'repro', version: '1' };
const ok = { '200': { description: 'OK' } };
const noContent = { '204': { description: 'No content' } };
const limitRef = { $ref: '#/components/parameters/Limit' };
const newPetRef = { $ref: '#/components/requestBodies/NewPet' };
/** A parameter declared beside the malformed one, which every reading keeps. */
const offset = { name: 'offset', in: 'query', schema: { type: 'integer' } };
const payload = {
  content: { 'application/json': { schema: { type: 'object', properties: { petId: { type: 'string' } } } } },
};
/** `components/parameters` holding `Limit` as the given value. */
const limitAs = (value: unknown) => ({ components: { parameters: { Limit: value } } });
/** `components/requestBodies` holding `NewPet` as the given value. */
const newPetAs = (value: unknown) => ({ components: { requestBodies: { NewPet: value } } });

let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Write `doc` to a temp file. */
function write(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-664-'));
  dirs.push(dir);
  const file = join(dir, 'spec.json');
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

/** Parse `doc` from a file, as the issue does, collecting every warning the parse prints. */
async function parse(doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const spec = await parseSpec(write(doc));
    return { spec, warnings: warn.mock.calls.map((call) => String(call[0])) };
  } finally {
    warn.mockRestore();
  }
}

/** The exit code `oagen diff` ends with for the two documents. */
async function diffExitCode(oldDoc: unknown, newDoc: unknown): Promise<number> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const err: any = await diffCommand({ old: write(oldDoc), new: write(newDoc) }).catch((e) => e);
  expect(err).toBeDefined();
  return err.exitCode;
}

/** The issue's `param.json`: `GET /pets` (`listPets`) returning `200`, with the given `parameters`. */
function paramDoc(parameters: unknown[], openapi: string, extra: Record<string, unknown> = {}) {
  return {
    openapi,
    info,
    paths: { '/pets': { get: { operationId: 'listPets', parameters, responses: ok } } },
    ...extra,
  };
}

/** The same with the parameters among the path item's. */
function pathItemParamDoc(parameters: unknown[], openapi: string, extra: Record<string, unknown> = {}) {
  return {
    openapi,
    info,
    paths: { '/pets': { parameters, get: { operationId: 'listPets', responses: ok } } },
    ...extra,
  };
}

/** The issue's `body.json`: `POST /pets` (`createPet`) returning `204`, with the given `requestBody`. */
function bodyDoc(requestBody: unknown, openapi: string, extra: Record<string, unknown> = {}) {
  return {
    openapi,
    info,
    paths: { '/pets': { post: { operationId: 'createPet', requestBody, responses: noContent } } },
    ...extra,
  };
}

/** A `petAdopted` webhook whose `post` is the given Operation Object, beside the given path item fields. */
function webhookDoc(
  operation: Record<string, unknown>,
  openapi: string,
  extra: Record<string, unknown> = {},
  pathItem: Record<string, unknown> = {},
) {
  return {
    openapi,
    info,
    paths: {},
    webhooks: { petAdopted: { ...pathItem, post: { responses: ok, ...operation } } },
    ...extra,
  };
}

/** `createPet`, declaring a `petAdopted` callback whose `post` is the given Operation Object, beside the given path item fields. */
function callbackDoc(
  operation: Record<string, unknown>,
  openapi: string,
  extra: Record<string, unknown> = {},
  pathItem: Record<string, unknown> = {},
) {
  const callback = { '{$request.body#/callbackUrl}': { ...pathItem, post: { responses: ok, ...operation } } };
  return {
    openapi,
    info,
    paths: {
      '/pets': { post: { operationId: 'createPet', responses: ok, callbacks: { petAdopted: callback } } },
    },
    ...extra,
  };
}

const WEBHOOK = 'webhooks.petAdopted.post';
const CALLBACK = 'createPet.callbacks.petAdopted.{$request.body#/callbackUrl}.post';

/** The one operation a document declares. */
function onlyOperation(spec: ApiSpec): Operation {
  const operations = spec.services.flatMap((service) => service.operations);
  expect(operations).toHaveLength(1);
  return operations[0];
}

/** Every parameter name an operation, a webhook or a callback carries, by location. */
function parameterNames(node: {
  pathParams?: Array<{ name: string }>;
  queryParams: Array<{ name: string }>;
  headerParams: Array<{ name: string }>;
  cookieParams?: Array<{ name: string }>;
}) {
  return {
    path: (node.pathParams ?? []).map((p) => p.name),
    query: node.queryParams.map((p) => p.name),
    header: node.headerParams.map((p) => p.name),
    cookie: (node.cookieParams ?? []).map((p) => p.name),
  };
}
const onlyOffset = { path: [], query: ['offset'], header: [], cookie: [] };
const noParameters = { path: [], query: [], header: [], cookie: [] };

const warning = (text: string) => `[oagen] Warning: ${text}`;
/** The warning for a parameter entry written inline as a non-object. */
const parameterSkipped = (label: string, rendered: string) =>
  warning(`a parameter of ${label} is not a Parameter Object (${rendered}); skipping it.`);
/** The warning for a `$ref` to `components/parameters/<name>` holding a non-object. */
const limitSkipped = (label: string, rendered: string, name = 'Limit') =>
  warning(
    `components/parameters/${name} (a parameter of ${label}) is not a Parameter Object (${rendered}); skipping it.`,
  );
/** The warning for a `parameters` field that is not an array; `owner` is the operation, or `the path item of` it. */
const noParameterList = (owner: string, rendered: string) =>
  warning(`parameters of ${owner} is not an array (${rendered}); reading no parameter from it.`);
/** The warning for a `requestBody` written inline as a non-object. */
const bodySkipped = (label: string, rendered: string) =>
  warning(`the request body of ${label} is not a Request Body Object (${rendered}); skipping it.`);
/** The warning for a `$ref` to `components/requestBodies/<name>` holding a non-object. */
const newPetSkipped = (label: string, rendered: string, name = 'NewPet') =>
  warning(
    `components/requestBodies/${name} (the request body of ${label}) is not a Request Body Object (${rendered}); skipping it.`,
  );

describe('#664', () => {
  it("runs the issue's script over param.json and body.json: both parse, each entry named as the malformed entry it is", async () => {
    const run = async (doc: unknown) => {
      const { spec, warnings } = await parse(doc);
      const [{ name, queryParams, requestBody }] = spec.services.flatMap(({ operations }) => operations);
      return { name, queryParams: queryParams.map(({ name }) => name), requestBody: requestBody?.kind, warnings };
    };

    expect(await run(paramDoc([limitRef], '3.1.0', limitAs([])))).toEqual({
      name: 'listPets',
      queryParams: [],
      requestBody: undefined,
      warnings: [
        '[oagen] Warning: components/parameters/Limit (a parameter of listPets) is not a Parameter Object ([]); skipping it.',
      ],
    });
    expect(await run(bodyDoc(newPetRef, '3.1.0', newPetAs([])))).toEqual({
      name: 'createPet',
      queryParams: [],
      requestBody: undefined,
      warnings: [
        '[oagen] Warning: components/requestBodies/NewPet (the request body of createPet) is not a Request Body Object ([]); skipping it.',
      ],
    });
  });

  for (const openapi of VERSIONS) {
    describe(`OpenAPI ${openapi}`, () => {
      describe('a parameter', () => {
        it.each(NON_OBJECTS)(
          'skips an operation parameter that points at %s, warning once naming the component and the operation',
          async (_kind, value, rendered) => {
            const { spec, warnings } = await parse(paramDoc([limitRef, offset], openapi, limitAs(value)));

            expect(warnings).toEqual([limitSkipped('listPets', rendered)]);
            const op = onlyOperation(spec);
            expect(parameterNames(op)).toEqual(onlyOffset);
            expect(op.requestBody).toBeUndefined();
            expect(spec.models).toEqual([]);
            // One IR for the inline and the `$ref` spelling of the same malformed entry.
            const inline = await parse(paramDoc([value, offset], openapi));
            expect(inline.warnings).toEqual([parameterSkipped('listPets', rendered)]);
            expect(spec).toEqual(inline.spec);
            expect(diffSpecs(inline.spec, spec).changes).toEqual([]);
          },
        );

        it.each(NON_OBJECTS)(
          "skips a path item parameter that points at %s, once per operation the path item's parameters apply to",
          async (_kind, value, rendered) => {
            const doc = pathItemParamDoc([limitRef, offset], openapi, limitAs(value));
            (doc.paths['/pets'] as Record<string, unknown>).delete = { operationId: 'deletePets', responses: ok };
            const { spec, warnings } = await parse(doc);

            expect(warnings).toEqual([limitSkipped('listPets', rendered), limitSkipped('deletePets', rendered)]);
            const operations = spec.services.flatMap((service) => service.operations);
            expect(operations.map((op) => [op.name, parameterNames(op)])).toEqual([
              ['listPets', onlyOffset],
              ['deletePets', onlyOffset],
            ]);
            const inlineDoc = pathItemParamDoc([value, offset], openapi);
            (inlineDoc.paths['/pets'] as Record<string, unknown>).delete = { operationId: 'deletePets', responses: ok };
            const inline = await parse(inlineDoc);
            expect(inline.warnings).toEqual([
              parameterSkipped('listPets', rendered),
              parameterSkipped('deletePets', rendered),
            ]);
            expect(spec).toEqual(inline.spec);
          },
        );

        it('reads the same operation wherever the malformed entry sits among the parameters', async () => {
          const first = await parse(paramDoc([limitRef, offset], openapi, limitAs([])));
          const last = await parse(paramDoc([offset, limitRef], openapi, limitAs([])));

          expect(last.spec).toEqual(first.spec);
          expect(last.warnings).toEqual(first.warnings);
          expect(parameterNames(onlyOperation(last.spec))).toEqual(onlyOffset);
        });

        it('keeps the path item parameter an operation parameter of its identity would have replaced', async () => {
          // `Limit` is no parameter, so it replaces nothing: the path item's `offset` stays.
          const doc = {
            openapi,
            info,
            paths: {
              '/pets': {
                parameters: [offset],
                get: { operationId: 'listPets', parameters: [limitRef], responses: ok },
              },
            },
            ...limitAs('offset'),
          };
          const { spec, warnings } = await parse(doc);

          expect(warnings).toEqual([limitSkipped('listPets', '"offset"')]);
          expect(parameterNames(onlyOperation(spec))).toEqual(onlyOffset);
        });

        it('names the last hop of a chain, by its decoded name', async () => {
          const components = {
            parameters: { Limit: { $ref: '#/components/parameters/Also~1Gone' }, 'Also/Gone': 'oops' },
          };
          const { spec, warnings } = await parse(paramDoc([limitRef, offset], openapi, { components }));

          expect(warnings).toEqual([limitSkipped('listPets', '"oops"', 'Also/Gone')]);
          expect(parameterNames(onlyOperation(spec))).toEqual(onlyOffset);
        });

        it('names an operation without an operationId by its method and path', async () => {
          const doc = {
            openapi,
            info,
            paths: { '/pets': { get: { parameters: [limitRef, null], responses: ok } } },
            ...limitAs(7),
          };
          const { spec, warnings } = await parse(doc);

          expect(warnings).toEqual([limitSkipped('GET /pets', '7'), parameterSkipped('GET /pets', 'null')]);
          expect(parameterNames(onlyOperation(spec))).toEqual(noParameters);
        });

        it('warns about each malformed entry, in document order, and reads the parameters between them', async () => {
          const components = { parameters: { Limit: [], Page: null } };
          const parameters = [limitRef, offset, 'oops', { $ref: '#/components/parameters/Page' }];
          const { spec, warnings } = await parse(paramDoc(parameters, openapi, { components }));

          expect(warnings).toEqual([
            limitSkipped('listPets', '[]'),
            parameterSkipped('listPets', '"oops"'),
            limitSkipped('listPets', 'null', 'Page'),
          ]);
          expect(parameterNames(onlyOperation(spec))).toEqual(onlyOffset);
        });

        it('parses a components/parameters entry that is not an object silently when nothing refers to it', async () => {
          const components = { parameters: { Limit: [], Page: null, Sort: 'oops' } };
          const { spec, warnings } = await parse(paramDoc([offset], openapi, { components }));

          expect(warnings).toEqual([]);
          expect(parameterNames(onlyOperation(spec))).toEqual(onlyOffset);
        });

        it('still reads an entry that is an object, whatever it holds: an empty one is a parameter in no location', async () => {
          const { spec, warnings } = await parse(paramDoc([limitRef, offset], openapi, limitAs({})));

          expect(warnings).toEqual([]);
          expect(parameterNames(onlyOperation(spec))).toEqual(onlyOffset);
        });

        it('still fails the parse on a ref the section holds nothing under, one into another section included', async () => {
          // A pointer to a `components/parameters` name that does not exist never
          // reaches the parser: the bundler rejects it first.
          const components = { schemas: { Limit: { type: 'integer' } }, parameters: { Limit: [] } };
          const doc = paramDoc([{ $ref: '#/components/schemas/Limit' }], openapi, { components });

          await expect(parse(doc)).rejects.toThrow(
            'Unresolved parameter $ref "#/components/schemas/Limit" in listPets: no matching entry under components/parameters.',
          );
        });

        it.each([
          ['a number', 42, '42'],
          ['null', null, 'null'],
          ['a boolean', true, 'true'],
          ['an array', [], '[]'],
          ['an array holding a pointer', ['#/components/parameters/Limit'], '["#/components/parameters/Limit"]'],
          ['an object', { name: 'x' }, '{"name":"x"}'],
        ])('fails the parse on a $ref that is %s, naming the value as JSON', async (_kind, ref, rendered) => {
          const direct = paramDoc([{ $ref: ref }], openapi, limitAs(offset));
          await expect(parse(direct)).rejects.toThrow(
            `Malformed parameter $ref ${rendered} in listPets: a $ref must be a string.`,
          );
          // At the end of a chain, too.
          const chained = paramDoc([limitRef], openapi, limitAs({ $ref: ref }));
          await expect(parse(chained)).rejects.toThrow(
            `Malformed parameter $ref ${rendered} in listPets: a $ref must be a string.`,
          );
        });

        it.each(NON_OBJECTS)(
          'skips a webhook parameter that points at %s, on the operation and on the path item, as the inline entry',
          async (_kind, value, rendered) => {
            const onOperation = await parse(
              webhookDoc({ parameters: [limitRef, offset], requestBody: payload }, openapi, limitAs(value)),
            );
            expect(onOperation.warnings).toEqual([limitSkipped(WEBHOOK, rendered)]);
            expect(onOperation.spec.webhooks).toHaveLength(1);
            expect(parameterNames(onOperation.spec.webhooks![0])).toEqual(onlyOffset);
            expect(onOperation.spec.webhooks![0].requestBody).toEqual({ kind: 'model', name: 'PetAdoptedPayload' });

            const onPathItem = await parse(
              webhookDoc({ requestBody: payload }, openapi, limitAs(value), { parameters: [limitRef, offset] }),
            );
            expect(onPathItem.warnings).toEqual([limitSkipped(WEBHOOK, rendered)]);
            expect(onPathItem.spec).toEqual(onOperation.spec);

            const inline = await parse(webhookDoc({ parameters: [value, offset], requestBody: payload }, openapi));
            expect(inline.warnings).toEqual([parameterSkipped(WEBHOOK, rendered)]);
            expect(inline.spec).toEqual(onOperation.spec);
            const inlineOnPathItem = await parse(
              webhookDoc({ requestBody: payload }, openapi, {}, { parameters: [value, offset] }),
            );
            expect(inlineOnPathItem.warnings).toEqual([parameterSkipped(WEBHOOK, rendered)]);
            expect(inlineOnPathItem.spec).toEqual(onOperation.spec);
          },
        );

        it.each(NON_OBJECTS)(
          'skips a callback parameter that points at %s, as the inline entry',
          async (_kind, value, rendered) => {
            const { spec, warnings } = await parse(
              callbackDoc({ parameters: [limitRef, offset], requestBody: payload }, openapi, limitAs(value)),
            );

            expect(warnings).toEqual([limitSkipped(CALLBACK, rendered)]);
            const op = onlyOperation(spec);
            expect(op.callbacks).toHaveLength(1);
            expect(parameterNames(op.callbacks![0])).toEqual(onlyOffset);
            const inline = await parse(callbackDoc({ parameters: [value, offset], requestBody: payload }, openapi));
            expect(inline.warnings).toEqual([parameterSkipped(CALLBACK, rendered)]);
            expect(spec).toEqual(inline.spec);
            // Among the parameters of the callback's path item, too.
            const onPathItem = await parse(
              callbackDoc({ requestBody: payload }, openapi, limitAs(value), { parameters: [limitRef, offset] }),
            );
            expect(onPathItem.warnings).toEqual([limitSkipped(CALLBACK, rendered)]);
            expect(onPathItem.spec).toEqual(spec);
          },
        );

        it('oagen diff on the issue document, and between its inline and $ref spellings, exits 0', async () => {
          const viaRef = paramDoc([limitRef], openapi, limitAs([]));
          const inline = paramDoc([[]], openapi);

          expect(await diffExitCode(viaRef, viaRef)).toBe(0);
          expect(await diffExitCode(inline, viaRef)).toBe(0);
          expect(await diffExitCode(viaRef, inline)).toBe(0);
        });
      });

      describe('a parameters field that is not an array', () => {
        it.each(NON_ARRAYS)(
          "reads an operation's parameters written as %s as absent, with one warning, and still reads the path item's",
          async (_kind, value, rendered) => {
            const doc = {
              openapi,
              info,
              paths: {
                '/pets': { parameters: [offset], get: { operationId: 'listPets', parameters: value, responses: ok } },
              },
            };
            const { spec, warnings } = await parse(doc);

            expect(warnings).toEqual([noParameterList('listPets', rendered)]);
            expect(parameterNames(onlyOperation(spec))).toEqual(onlyOffset);
            // The IR of the operation that writes no `parameters` of its own.
            const absent = await parse(pathItemParamDoc([offset], openapi));
            expect(spec).toEqual(absent.spec);
          },
        );

        it.each(NON_ARRAYS)(
          "reads a path item's parameters written as %s as absent, once per operation that reads them",
          async (_kind, value, rendered) => {
            const doc = {
              openapi,
              info,
              paths: {
                '/pets': {
                  parameters: value,
                  get: { operationId: 'listPets', parameters: [offset], responses: ok },
                  delete: { operationId: 'deletePets', responses: ok },
                },
              },
            };
            const { spec, warnings } = await parse(doc);

            expect(warnings).toEqual([
              noParameterList('the path item of listPets', rendered),
              noParameterList('the path item of deletePets', rendered),
            ]);
            const operations = spec.services.flatMap((service) => service.operations);
            expect(operations.map((op) => [op.name, parameterNames(op)])).toEqual([
              ['listPets', onlyOffset],
              ['deletePets', noParameters],
            ]);
          },
        );

        it('never reads a string as the list of its characters, nor an object as a parameter', async () => {
          const asString = await parse(paramDoc('oops' as never, openapi));
          const asObject = await parse(paramDoc(offset as never, openapi));

          expect(asString.warnings).toEqual([noParameterList('listPets', '"oops"')]);
          expect(asObject.warnings).toEqual([
            noParameterList('listPets', '{"name":"offset","in":"query","schema":{"type":"integer"}}'),
          ]);
          expect(parameterNames(onlyOperation(asString.spec))).toEqual(noParameters);
          expect(parameterNames(onlyOperation(asObject.spec))).toEqual(noParameters);
        });

        it.each(NON_ARRAYS)(
          "reads a webhook's and a callback's parameters written as %s as absent, on the operation and on the path item",
          async (_kind, value, rendered) => {
            const onOperation = await parse(webhookDoc({ parameters: value, requestBody: payload }, openapi));
            expect(onOperation.warnings).toEqual([noParameterList(WEBHOOK, rendered)]);
            expect(parameterNames(onOperation.spec.webhooks![0])).toEqual(noParameters);

            const onPathItem = await parse(
              webhookDoc({ parameters: [offset], requestBody: payload }, openapi, {}, { parameters: value }),
            );
            expect(onPathItem.warnings).toEqual([noParameterList(`the path item of ${WEBHOOK}`, rendered)]);
            expect(parameterNames(onPathItem.spec.webhooks![0])).toEqual(onlyOffset);

            const onCallback = await parse(callbackDoc({ parameters: value, requestBody: payload }, openapi));
            expect(onCallback.warnings).toEqual([noParameterList(CALLBACK, rendered)]);
            expect(parameterNames(onlyOperation(onCallback.spec).callbacks![0])).toEqual(noParameters);
          },
        );
      });

      describe('a request body', () => {
        it.each(NON_OBJECTS)(
          'reads createPet without a request body that points at %s, warning once naming the component and the operation',
          async (_kind, value, rendered) => {
            const { spec, warnings } = await parse(bodyDoc(newPetRef, openapi, newPetAs(value)));

            expect(warnings).toEqual([newPetSkipped('createPet', rendered)]);
            const op = onlyOperation(spec);
            expect(op.requestBody).toBeUndefined();
            expect(op.requestBodyEncoding).toBeUndefined();
            expect(op.requestBodyRequired).toBeUndefined();
            expect(op.requestBodyDescription).toBeUndefined();
            expect(op.responseStatusCode).toBe(204);
            expect(spec.models).toEqual([]);
            // One IR for the inline and the `$ref` spelling of the same malformed entry.
            const inline = await parse(bodyDoc(value, openapi));
            expect(inline.warnings).toEqual([bodySkipped('createPet', rendered)]);
            expect(spec).toEqual(inline.spec);
            expect(diffSpecs(inline.spec, spec).changes).toEqual([]);
            // And the IR of the operation that declares no request body at all.
            const absent = await parse(bodyDoc(undefined, openapi));
            expect(absent.warnings).toEqual([]);
            expect(spec).toEqual(absent.spec);
          },
        );

        it.each([
          ['zero', 0, '0'],
          ['false', false, 'false'],
          ['an empty string', '', '""'],
        ])(
          'checks a request body written as %s too, a value like any other non-object',
          async (_kind, value, rendered) => {
            const inline = await parse(bodyDoc(value, openapi));
            const viaRef = await parse(bodyDoc(newPetRef, openapi, newPetAs(value)));

            expect(inline.warnings).toEqual([bodySkipped('createPet', rendered)]);
            expect(viaRef.warnings).toEqual([newPetSkipped('createPet', rendered)]);
            expect(onlyOperation(inline.spec).requestBody).toBeUndefined();
            expect(viaRef.spec).toEqual(inline.spec);
          },
        );

        it('does not read the text beside a $ref to an entry that is not an object', async () => {
          const requestBody = { ...newPetRef, description: 'A pet to add.' };
          const { spec, warnings } = await parse(bodyDoc(requestBody, openapi, newPetAs([])));

          expect(warnings).toEqual([newPetSkipped('createPet', '[]')]);
          expect(onlyOperation(spec).requestBodyDescription).toBeUndefined();
        });

        it('keeps the query parameters a request body of that name would have owned', async () => {
          // With no body there is nothing to own `code`: it stays a query parameter, as with the inline `[]`.
          const code = { name: 'code', in: 'query', schema: { type: 'string' } };
          const doc = {
            openapi,
            info,
            paths: {
              '/pets': {
                post: { operationId: 'createPet', parameters: [code], requestBody: newPetRef, responses: noContent },
              },
            },
            ...newPetAs([]),
          };
          const { spec, warnings } = await parse(doc);

          expect(warnings).toEqual([newPetSkipped('createPet', '[]')]);
          const op = onlyOperation(spec);
          expect(op.queryParams.map((p) => p.name)).toEqual(['code']);
          expect(op.bodyOwnedQueryParams).toBeUndefined();
        });

        it('names the last hop of a chain, by its decoded name', async () => {
          const components = {
            requestBodies: { NewPet: { $ref: '#/components/requestBodies/Also~1Gone' }, 'Also/Gone': 7 },
          };
          const { spec, warnings } = await parse(bodyDoc(newPetRef, openapi, { components }));

          expect(warnings).toEqual([newPetSkipped('createPet', '7', 'Also/Gone')]);
          expect(onlyOperation(spec).requestBody).toBeUndefined();
        });

        it('warns once for an operation named from its path, too: the name rehearsals read the body silently', async () => {
          const viaRef = {
            openapi,
            info,
            paths: { '/pets': { post: { requestBody: newPetRef, responses: noContent } } },
            ...newPetAs('oops'),
          };
          const inline = { openapi, info, paths: { '/pets': { post: { requestBody: 'oops', responses: noContent } } } };
          const first = await parse(viaRef);
          const second = await parse(inline);

          expect(first.warnings).toEqual([newPetSkipped('POST /pets', '"oops"')]);
          expect(second.warnings).toEqual([bodySkipped('POST /pets', '"oops"')]);
          expect(onlyOperation(first.spec).requestBody).toBeUndefined();
          expect(first.spec).toEqual(second.spec);
        });

        it('parses a components/requestBodies entry that is not an object silently when nothing refers to it', async () => {
          const components = { requestBodies: { NewPet: [], Other: null, Third: 'oops' } };
          const { spec, warnings } = await parse(bodyDoc(payload, openapi, { components }));

          expect(warnings).toEqual([]);
          expect(onlyOperation(spec).requestBody).toEqual({ kind: 'model', name: 'CreatePetRequest' });
        });

        it('still fails the parse on a ref the section holds nothing under, one into another section included', async () => {
          const components = { schemas: { NewPet: { type: 'object' } }, requestBodies: { NewPet: [] } };
          const doc = bodyDoc({ $ref: '#/components/schemas/NewPet' }, openapi, { components });

          await expect(parse(doc)).rejects.toThrow(
            'Unresolved request body $ref "#/components/schemas/NewPet" in createPet: no matching entry under components/requestBodies.',
          );
        });

        it.each([
          ['a number', 42, '42'],
          ['null', null, 'null'],
          ['a boolean', true, 'true'],
          ['an array', [], '[]'],
          ['an object', { name: 'x' }, '{"name":"x"}'],
        ])('fails the parse on a $ref that is %s, naming the value as JSON', async (_kind, ref, rendered) => {
          const direct = bodyDoc({ $ref: ref }, openapi, newPetAs(payload));
          await expect(parse(direct)).rejects.toThrow(
            `Malformed request body $ref ${rendered} in createPet: a $ref must be a string.`,
          );
          const chained = bodyDoc(newPetRef, openapi, newPetAs({ $ref: ref }));
          await expect(parse(chained)).rejects.toThrow(
            `Malformed request body $ref ${rendered} in createPet: a $ref must be a string.`,
          );
        });

        it.each(NON_OBJECTS)(
          'reads a webhook without a request body that points at %s, as the inline entry',
          async (_kind, value, rendered) => {
            const { spec, warnings } = await parse(
              webhookDoc({ parameters: [offset], requestBody: newPetRef }, openapi, newPetAs(value)),
            );

            expect(warnings).toEqual([newPetSkipped(WEBHOOK, rendered)]);
            expect(spec.webhooks).toHaveLength(1);
            expect(spec.webhooks![0].requestBody).toBeUndefined();
            expect(parameterNames(spec.webhooks![0])).toEqual(onlyOffset);
            const inline = await parse(webhookDoc({ parameters: [offset], requestBody: value }, openapi));
            expect(inline.warnings).toEqual([bodySkipped(WEBHOOK, rendered)]);
            expect(spec).toEqual(inline.spec);
          },
        );

        it.each(NON_OBJECTS)(
          'reads a callback without a request body that points at %s, as the inline entry',
          async (_kind, value, rendered) => {
            const { spec, warnings } = await parse(callbackDoc({ requestBody: newPetRef }, openapi, newPetAs(value)));

            expect(warnings).toEqual([newPetSkipped(CALLBACK, rendered)]);
            const op = onlyOperation(spec);
            expect(op.callbacks).toHaveLength(1);
            expect(op.callbacks![0].requestBody).toBeUndefined();
            const inline = await parse(callbackDoc({ requestBody: value }, openapi));
            expect(inline.warnings).toEqual([bodySkipped(CALLBACK, rendered)]);
            expect(spec).toEqual(inline.spec);
          },
        );

        it('oagen diff on the issue document, and between its inline and $ref spellings, exits 0', async () => {
          const viaRef = bodyDoc(newPetRef, openapi, newPetAs([]));
          const inline = bodyDoc([], openapi);

          expect(await diffExitCode(viaRef, viaRef)).toBe(0);
          expect(await diffExitCode(inline, viaRef)).toBe(0);
          expect(await diffExitCode(viaRef, inline)).toBe(0);
        });
      });

      describe('written inline, where every value but an array failed the parse with a TypeError', () => {
        // On the base: `TypeError: Cannot use 'in' operator to search for '$ref' in null` for a
        // parameter entry that is `null`, a string, a number or a boolean, and for a request body
        // that is a string, a number or `true`; an array parsed without a word.
        it.each(NON_OBJECTS)(
          'skips a parameter entry that is %s at every site that reads one, with one warning naming the operation',
          async (_kind, value, rendered) => {
            const onOperation = await parse(paramDoc([value, offset], openapi));
            expect(onOperation.warnings).toEqual([parameterSkipped('listPets', rendered)]);
            expect(parameterNames(onlyOperation(onOperation.spec))).toEqual(onlyOffset);

            const onPathItem = await parse(pathItemParamDoc([value, offset], openapi));
            expect(onPathItem.warnings).toEqual([parameterSkipped('listPets', rendered)]);
            expect(parameterNames(onlyOperation(onPathItem.spec))).toEqual(onlyOffset);

            const onWebhook = await parse(webhookDoc({ parameters: [value, offset], requestBody: payload }, openapi));
            expect(onWebhook.warnings).toEqual([parameterSkipped(WEBHOOK, rendered)]);
            expect(parameterNames(onWebhook.spec.webhooks![0])).toEqual(onlyOffset);

            const onWebhookPathItem = await parse(
              webhookDoc({ requestBody: payload }, openapi, {}, { parameters: [value, offset] }),
            );
            expect(onWebhookPathItem.warnings).toEqual([parameterSkipped(WEBHOOK, rendered)]);
            expect(parameterNames(onWebhookPathItem.spec.webhooks![0])).toEqual(onlyOffset);

            const onCallback = await parse(callbackDoc({ parameters: [value, offset], requestBody: payload }, openapi));
            expect(onCallback.warnings).toEqual([parameterSkipped(CALLBACK, rendered)]);
            expect(parameterNames(onlyOperation(onCallback.spec).callbacks![0])).toEqual(onlyOffset);

            const onCallbackPathItem = await parse(
              callbackDoc({ requestBody: payload }, openapi, {}, { parameters: [value, offset] }),
            );
            expect(onCallbackPathItem.warnings).toEqual([parameterSkipped(CALLBACK, rendered)]);
            expect(parameterNames(onlyOperation(onCallbackPathItem.spec).callbacks![0])).toEqual(onlyOffset);
          },
        );

        it.each(NON_OBJECTS)(
          'reads an operation, a webhook and a callback without a request body that is %s, with one warning each',
          async (_kind, value, rendered) => {
            const onOperation = await parse(bodyDoc(value, openapi));
            expect(onOperation.warnings).toEqual([bodySkipped('createPet', rendered)]);
            const op = onlyOperation(onOperation.spec);
            expect(op.requestBody).toBeUndefined();
            expect(op.responseStatusCode).toBe(204);

            const onWebhook = await parse(webhookDoc({ parameters: [offset], requestBody: value }, openapi));
            expect(onWebhook.warnings).toEqual([bodySkipped(WEBHOOK, rendered)]);
            expect(onWebhook.spec.webhooks).toHaveLength(1);
            expect(onWebhook.spec.webhooks![0].requestBody).toBeUndefined();
            expect(parameterNames(onWebhook.spec.webhooks![0])).toEqual(onlyOffset);

            const onCallback = await parse(callbackDoc({ parameters: [offset], requestBody: value }, openapi));
            expect(onCallback.warnings).toEqual([bodySkipped(CALLBACK, rendered)]);
            const [callback] = onlyOperation(onCallback.spec).callbacks!;
            expect(callback.requestBody).toBeUndefined();
            expect(parameterNames(callback)).toEqual(onlyOffset);
          },
        );
      });

      describe('a path item or callback $ref to an entry that is not an object', () => {
        // Both spellings were skipped already; the ref to an entry holding `null`, `false`, `0`
        // or `""` was reported as one with `no matching entry`, though the entry is there.
        const kept = { get: { operationId: 'listKept', responses: ok } };
        const notAPathItem = (label: string) => warning(`${label} is not a path item object; skipping it.`);
        const notACallback = (site: string) => warning(`Callback "${site}" is not a Callback Object; skipping it.`);
        const petsRef = { $ref: '#/components/pathItems/Pets' };
        const adoptedRef = { $ref: '#/components/callbacks/Adopted' };
        const withCallbacks = (callbacks: unknown, components?: Record<string, unknown>) => ({
          openapi,
          info,
          paths: { '/pets': { post: { operationId: 'createPet', responses: ok, callbacks } } },
          ...(components ? { components } : {}),
        });
        const EXPRESSION = 'createPet.callbacks.petAdopted.{$request.body#/callbackUrl}';

        it.each(ENTRIES)(
          'names a components/pathItems entry that is %s as no path item object, behind a path, a chain and a webhook',
          async (_kind, value) => {
            const inline = await parse({ openapi, info, paths: { '/pets': value, '/kept': kept } });
            expect(inline.warnings).toEqual([notAPathItem('Path "/pets"')]);
            expect(inline.spec.services.flatMap((service) => service.operations).map((op) => op.name)).toEqual([
              'listKept',
            ]);

            const viaRef = await parse({
              openapi,
              info,
              paths: { '/pets': petsRef, '/kept': kept },
              components: { pathItems: { Pets: value } },
            });
            expect(viaRef.warnings).toEqual(inline.warnings);
            expect(viaRef.spec).toEqual(inline.spec);

            const viaChain = await parse({
              openapi,
              info,
              paths: { '/pets': { $ref: '#/components/pathItems/Alias' }, '/kept': kept },
              components: { pathItems: { Alias: petsRef, Pets: value } },
            });
            expect(viaChain.warnings).toEqual(inline.warnings);
            expect(viaChain.spec).toEqual(inline.spec);

            const webhookInline = await parse({
              openapi,
              info,
              paths: { '/kept': kept },
              webhooks: { petAdopted: value },
            });
            const webhookViaRef = await parse({
              openapi,
              info,
              paths: { '/kept': kept },
              webhooks: { petAdopted: petsRef },
              components: { pathItems: { Pets: value } },
            });
            expect(webhookInline.warnings).toEqual([notAPathItem('Webhook "petAdopted"')]);
            expect(webhookViaRef.warnings).toEqual(webhookInline.warnings);
            expect(webhookViaRef.spec).toEqual(webhookInline.spec);
            expect(webhookViaRef.spec.webhooks ?? []).toEqual([]);
          },
        );

        it.each(ENTRIES)(
          'names a paths or webhooks entry that is %s as no path item object, behind a pointer into either map',
          async (_kind, value) => {
            const intoPaths = await parse({
              openapi,
              info,
              paths: { '/animals': { $ref: '#/paths/~1pets' }, '/pets': value, '/kept': kept },
            });
            expect(intoPaths.warnings).toEqual([notAPathItem('Path "/animals"'), notAPathItem('Path "/pets"')]);

            const intoWebhooks = await parse({
              openapi,
              info,
              paths: { '/animals': { $ref: '#/webhooks/petAdopted' }, '/kept': kept },
              webhooks: { petAdopted: value },
            });
            expect(intoWebhooks.warnings).toEqual([
              notAPathItem('Path "/animals"'),
              notAPathItem('Webhook "petAdopted"'),
            ]);
            for (const { spec } of [intoPaths, intoWebhooks]) {
              expect(spec.services.flatMap((service) => service.operations).map((op) => op.name)).toEqual(['listKept']);
            }
          },
        );

        it.each(ENTRIES)(
          'names a components/callbacks entry that is %s as no Callback Object, direct and at the end of a chain',
          async (_kind, value) => {
            const inline = await parse(withCallbacks({ petAdopted: value }));
            expect(inline.warnings).toEqual([notACallback('createPet.callbacks.petAdopted')]);
            expect(onlyOperation(inline.spec).callbacks).toBeUndefined();

            const viaRef = await parse(withCallbacks({ petAdopted: adoptedRef }, { callbacks: { Adopted: value } }));
            expect(viaRef.warnings).toEqual(inline.warnings);
            expect(viaRef.spec).toEqual(inline.spec);

            const viaChain = await parse(
              withCallbacks(
                { petAdopted: { $ref: '#/components/callbacks/Alias' } },
                { callbacks: { Alias: adoptedRef, Adopted: value } },
              ),
            );
            expect(viaChain.warnings).toEqual(inline.warnings);
            expect(viaChain.spec).toEqual(inline.spec);
          },
        );

        it.each(ENTRIES)(
          "names a components/pathItems entry that is %s as no path item object behind a callback's expression",
          async (_kind, value) => {
            const inline = await parse(withCallbacks({ petAdopted: { '{$request.body#/callbackUrl}': value } }));
            const viaRef = await parse(
              withCallbacks(
                { petAdopted: { '{$request.body#/callbackUrl}': petsRef } },
                { pathItems: { Pets: value } },
              ),
            );

            expect(inline.warnings).toEqual([notAPathItem(`Callback "${EXPRESSION}"`)]);
            expect(viaRef.warnings).toEqual(inline.warnings);
            expect(viaRef.spec).toEqual(inline.spec);
            expect(onlyOperation(viaRef.spec).callbacks).toBeUndefined();
          },
        );

        it('still reports a pointer that names no entry as unresolved, a same-named entry of the section notwithstanding', async () => {
          const components = { schemas: { Pets: { type: 'object' }, Adopted: { type: 'object' } } };
          const path = await parse({
            openapi,
            info,
            paths: { '/pets': { $ref: '#/components/schemas/Pets' }, '/kept': kept },
            components: { ...components, pathItems: { Pets: null } },
          });
          const callback = await parse(
            withCallbacks(
              { petAdopted: { $ref: '#/components/schemas/Adopted' } },
              { ...components, callbacks: { Adopted: null } },
            ),
          );

          expect(path.warnings).toEqual([
            warning(
              'Unresolved path item $ref "#/components/schemas/Pets" for path "/pets": no matching entry under components/pathItems. Skipping the path.',
            ),
          ]);
          expect(callback.warnings).toEqual([
            warning(
              'Unresolved callback $ref "#/components/schemas/Adopted" for callback "createPet.callbacks.petAdopted": no matching entry under components/callbacks. Skipping the callback.',
            ),
          ]);
        });
      });

      describe('a response header and a parameter example, which were already dropped', () => {
        const rateRef = { $ref: '#/components/headers/Rate' };
        const headerDoc = (header: unknown, extra: Record<string, unknown> = {}) => ({
          openapi,
          info,
          paths: {
            '/pets': {
              get: {
                operationId: 'listPets',
                responses: {
                  '200': { description: 'OK', headers: { 'X-Rate': header, 'X-Kept': { schema: { type: 'string' } } } },
                },
              },
            },
          },
          ...extra,
        });
        const smallRef = { $ref: '#/components/examples/Small' };
        const exampleDoc = (example: unknown, extra: Record<string, unknown> = {}) =>
          paramDoc([{ ...offset, examples: { small: example, large: { value: 100 } } }], openapi, extra);

        it.each(NON_OBJECTS)(
          'names a components/headers entry that is %s as the malformed entry it is, not as missing',
          async (_kind, value, rendered) => {
            const { spec, warnings } = await parse(headerDoc(rateRef, { components: { headers: { Rate: value } } }));

            expect(warnings).toEqual([
              warning(
                `components/headers/Rate (the response header "X-Rate" of listPets) is not a Header Object (${rendered}); skipping it.`,
              ),
            ]);
            expect(onlyOperation(spec).responseHeaders?.map((header) => header.name)).toEqual(['X-Kept']);
          },
        );

        it('still reports a header ref the section holds nothing under as unresolved', async () => {
          const components = { schemas: { Rate: { type: 'integer' } }, headers: { Rate: [] } };
          const { spec, warnings } = await parse(headerDoc({ $ref: '#/components/schemas/Rate' }, { components }));

          expect(warnings).toEqual([
            warning(
              'Unresolved header $ref "#/components/schemas/Rate" for response header "X-Rate" in listPets: no matching entry under components/headers. Skipping the header.',
            ),
          ]);
          expect(onlyOperation(spec).responseHeaders?.map((header) => header.name)).toEqual(['X-Kept']);
        });

        it.each(NON_OBJECTS)(
          'names a components/examples entry that is %s as the malformed entry it is, as the inline entry is skipped',
          async (_kind, value, rendered) => {
            const { spec, warnings } = await parse(
              exampleDoc(smallRef, { components: { examples: { Small: value } } }),
            );

            expect(warnings).toEqual([
              warning(
                `components/examples/Small (an example of parameter "offset" in listPets) is not an Example Object (${rendered}); skipping it.`,
              ),
            ]);
            const [param] = onlyOperation(spec).queryParams;
            expect(param.examples).toEqual([100]);
            // The inline entry is no example either, and is skipped without a word, as before.
            const inline = await parse(exampleDoc(value));
            expect(inline.warnings).toEqual([]);
            expect(spec).toEqual(inline.spec);
          },
        );

        it.each([
          ['a number', 42, '42'],
          ['null', null, 'null'],
          ['an array', [], '[]'],
          ['an object', { name: 'x' }, '{"name":"x"}'],
        ])(
          'names a header or example $ref that is %s as malformed, the value as JSON',
          async (_kind, ref, rendered) => {
            const header = await parse(headerDoc({ $ref: ref }));
            expect(header.warnings).toEqual([
              warning(
                `Malformed header $ref ${rendered} for response header "X-Rate" in listPets: a $ref must be a string. Skipping the header.`,
              ),
            ]);
            expect(onlyOperation(header.spec).responseHeaders?.map((entry) => entry.name)).toEqual(['X-Kept']);

            const example = await parse(exampleDoc({ $ref: ref }));
            expect(example.warnings).toEqual([
              warning(
                `Malformed example $ref ${rendered} on parameter "offset" in listPets: a $ref must be a string; skipping`,
              ),
            ]);
            expect(onlyOperation(example.spec).queryParams[0].examples).toEqual([100]);
          },
        );

        it('still reports an example ref the section holds nothing under as unresolved', async () => {
          const components = { schemas: { Small: { type: 'integer' } }, examples: { Small: [] } };
          const { spec, warnings } = await parse(exampleDoc({ $ref: '#/components/schemas/Small' }, { components }));

          expect(warnings).toEqual([
            warning('Unresolved example $ref "#/components/schemas/Small" on parameter "offset" in listPets; skipping'),
          ]);
          expect(onlyOperation(spec).queryParams[0].examples).toEqual([100]);
        });
      });
    });
  }

  describe('a name the map holds nothing under, beside an entry that holds a falsy value', () => {
    // Called directly: the bundler rejects a document with such a pointer before the parser reads it.
    const components = (entries: Record<string, unknown>) => entries as Record<string, Record<string, unknown>>;
    const FALSY: Array<[kind: string, value: unknown]> = [
      ['null', null],
      ['false', false],
      ['zero', 0],
      ['an empty string', ''],
    ];

    it.each(FALSY)(
      'resolvePathItemRef keeps `no matching entry` for a missing name and names an entry that is %s as no path item object',
      (_kind, value) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const said = () => warn.mock.calls.map((call) => String(call[0]));
        const site = { kind: 'path' as const, key: '/pets' };
        const pathItems = components({ Pets: value });
        const document = { paths: { '/cats': value }, webhooks: { catAdopted: value } };
        const resolve = (ref: string) => resolvePathItemRef({ $ref: ref }, pathItems, site, document);

        expect(resolve('#/components/pathItems/Missing')).toBeUndefined();
        expect(resolve('#/paths/~1missing')).toBeUndefined();
        expect(resolve('#/webhooks/missing')).toBeUndefined();
        expect(said()).toEqual([
          warning(
            'Unresolved path item $ref "#/components/pathItems/Missing" for path "/pets": no matching entry under components/pathItems. Skipping the path.',
          ),
          warning(
            'Unresolved path item $ref "#/paths/~1missing" for path "/pets": no matching entry under paths. Skipping the path.',
          ),
          warning(
            'Unresolved path item $ref "#/webhooks/missing" for path "/pets": no matching entry under webhooks. Skipping the path.',
          ),
        ]);
        warn.mockClear();

        expect(resolve('#/components/pathItems/Pets')).toBeUndefined();
        expect(resolve('#/paths/~1cats')).toBeUndefined();
        expect(resolve('#/webhooks/catAdopted')).toBeUndefined();
        const notAPathItem = warning('Path "/pets" is not a path item object; skipping it.');
        expect(said()).toEqual([notAPathItem, notAPathItem, notAPathItem]);
      },
    );

    it.each(FALSY)(
      'a callback keeps `no matching entry` for a missing name and names an entry that is %s as no Callback Object',
      (_kind, value) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const owner: Webhook = { name: 'x', httpMethod: 'post', headerParams: [], queryParams: [], responses: [] };
        const callbacks = {
          missing: { $ref: '#/components/callbacks/Missing' },
          falsy: { $ref: '#/components/callbacks/Adopted' },
          chained: { $ref: '#/components/callbacks/Alias' },
        };
        const entries = { Adopted: value, Alias: { $ref: '#/components/callbacks/Adopted' } };

        const result = extractCallbacks(
          [{ owner, callbacks, label: 'webhooks.x.post', stem: 'Hook' }],
          { callbacks: components(entries) },
          [],
          [],
          'override',
        );

        expect(result).toEqual({ inlineModels: [], inlineModelBundles: [] });
        expect(owner).not.toHaveProperty('callbacks');
        expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
          warning(
            'Unresolved callback $ref "#/components/callbacks/Missing" for callback "webhooks.x.post.callbacks.missing": no matching entry under components/callbacks. Skipping the callback.',
          ),
          warning('Callback "webhooks.x.post.callbacks.falsy" is not a Callback Object; skipping it.'),
          warning('Callback "webhooks.x.post.callbacks.chained" is not a Callback Object; skipping it.'),
        ]);
      },
    );
  });

  describe('resolveParameterRef', () => {
    const components = (entries: Record<string, unknown>) => entries as Record<string, Record<string, unknown>>;

    it('returns the Parameter Object an inline entry or a chain of refs denotes, without a word', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const limit = { name: 'limit', in: 'query' as const };

      expect(resolveParameterRef(limit, undefined, 'listPets')).toBe(limit);
      expect(resolveParameterRef(limitRef, components({ Limit: limit }), 'listPets')).toBe(limit);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(NON_OBJECTS)(
      'returns undefined for %s, inline or behind a ref, warning once each',
      (_kind, value, rendered) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(resolveParameterRef(value as never, undefined, 'listPets')).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenLastCalledWith(parameterSkipped('listPets', rendered));
        expect(resolveParameterRef(limitRef, components({ Limit: value }), 'listPets')).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenLastCalledWith(limitSkipped('listPets', rendered));
      },
    );

    it('throws for a ref nothing answers, a $ref that is not a string and a chain that loops', () => {
      const loop = components({ A: { $ref: '#/components/parameters/B' }, B: { $ref: '#/components/parameters/A' } });

      expect(() => resolveParameterRef({ $ref: '#/components/parameters/Nope' }, components({}), 'listPets')).toThrow(
        'Unresolved parameter $ref "#/components/parameters/Nope" in listPets: no matching entry under components/parameters.',
      );
      expect(() => resolveParameterRef({ $ref: 42 } as never, components({}), 'listPets')).toThrow(
        'Malformed parameter $ref 42 in listPets: a $ref must be a string.',
      );
      expect(() => resolveParameterRef({ $ref: '#/components/parameters/A' }, loop, 'listPets')).toThrow(
        'Circular parameter $ref chain starting at "#/components/parameters/A" in listPets.',
      );
    });
  });

  describe('declaredParameterEntries', () => {
    it("lists the path item's entries ahead of the operation's, without a word, and none for an absent field", () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(declaredParameterEntries([limitRef], [offset], 'listPets')).toEqual([limitRef, offset]);
      expect(declaredParameterEntries(undefined, [offset], 'listPets')).toEqual([offset]);
      expect(declaredParameterEntries([limitRef], undefined, 'listPets')).toEqual([limitRef]);
      expect(declaredParameterEntries(undefined, undefined, 'listPets')).toEqual([]);
      expect(declaredParameterEntries([], [], 'listPets')).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(NON_ARRAYS)(
      'reads a field that is %s as absent, warning once and naming whose it is',
      (_kind, value, rendered) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(declaredParameterEntries(value, [offset], 'listPets')).toEqual([offset]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenLastCalledWith(noParameterList('the path item of listPets', rendered));
        expect(declaredParameterEntries([limitRef], value, 'listPets')).toEqual([limitRef]);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenLastCalledWith(noParameterList('listPets', rendered));
      },
    );
  });

  describe('resolveRequestBodyRef', () => {
    const components = (entries: Record<string, unknown>) => entries as Record<string, Record<string, unknown>>;

    it('returns undefined without a word for an operation that declares no request body', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(resolveRequestBodyRef(undefined, undefined, 'createPet')).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(NON_OBJECTS)(
      'returns undefined for %s, inline or behind a ref, warning once each',
      (_kind, value, rendered) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(resolveRequestBodyRef(value as never, undefined, 'createPet')).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenLastCalledWith(bodySkipped('createPet', rendered));
        expect(resolveRequestBodyRef(newPetRef, components({ NewPet: value }), 'createPet')).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenLastCalledWith(newPetSkipped('createPet', rendered));
      },
    );

    it('reads silently for a reader that only pre-computes names: no warning and no throw, whatever the ref', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const loop = components({ A: { $ref: '#/components/requestBodies/A' } });
      const silently = (raw: unknown, entries: Record<string, Record<string, unknown>>) =>
        resolveRequestBodyRef(raw as never, entries, 'createPet', 'override', 'silent');

      expect(silently('oops', components({}))).toBeUndefined();
      expect(silently(newPetRef, components({ NewPet: [] }))).toBeUndefined();
      expect(silently(newPetRef, components({}))).toBeUndefined();
      expect(silently({ $ref: 42 }, components({}))).toBeUndefined();
      expect(silently({ $ref: '#/components/requestBodies/A' }, loop)).toBeUndefined();
      expect(silently(newPetRef, components({ NewPet: payload }))).toBe(payload);
      expect(warn).not.toHaveBeenCalled();
    });

    it('throws for a ref nothing answers, a $ref that is not a string and a chain that loops', () => {
      const loop = components({ A: { $ref: '#/components/requestBodies/A' } });

      expect(() => resolveRequestBodyRef(newPetRef, components({}), 'createPet')).toThrow(
        'Unresolved request body $ref "#/components/requestBodies/NewPet" in createPet: no matching entry under components/requestBodies.',
      );
      expect(() => resolveRequestBodyRef({ $ref: [] } as never, components({}), 'createPet')).toThrow(
        'Malformed request body $ref [] in createPet: a $ref must be a string.',
      );
      expect(() => resolveRequestBodyRef({ $ref: '#/components/requestBodies/A' }, loop, 'createPet')).toThrow(
        'Circular request body $ref chain starting at "#/components/requestBodies/A" in createPet.',
      );
    });
  });

  describe('endsOnNonObject and malformedRefOf', () => {
    const components = (entries: Record<string, unknown>) => entries as Record<string, Record<string, unknown>>;
    const follow = (raw: object, entries: Record<string, unknown>) =>
      followReference<object>(raw, 'parameters', components(entries), 'override');

    it('reports the entry a walk ended on, the component named ahead of the site, and says nothing without a site', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const followed = follow(limitRef, { Limit: { $ref: '#/components/parameters/a~1b~0c' }, 'a/b~c': [] });

      expect(endsOnNonObject(followed, 'parameters', 'a parameter of listPets')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenLastCalledWith(limitSkipped('listPets', '[]', 'a/b~c'));
      expect(endsOnNonObject(followed, 'parameters')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('is false, without a word, for every other way a walk ends', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const loop = { Limit: limitRef };

      for (const followed of [
        follow(offset, {}),
        follow(limitRef, { Limit: offset }),
        follow(limitRef, {}),
        follow({ $ref: '#/components/schemas/Limit' }, { Limit: [] }),
        follow({ $ref: 42 }, { Limit: [] }),
        follow(limitRef, loop),
      ]) {
        expect(endsOnNonObject(followed, 'parameters', 'a parameter of listPets')).toBe(false);
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      [42, '42'],
      [null, 'null'],
      [[], '[]'],
      [['#/components/parameters/Limit'], '["#/components/parameters/Limit"]'],
      [{ name: 'x' }, '{"name":"x"}'],
    ])('renders a $ref of %j as JSON, direct or at the end of a chain', (ref, rendered) => {
      expect(malformedRefOf(follow({ $ref: ref }, {}))).toBe(rendered);
      expect(malformedRefOf(follow(limitRef, { Limit: { $ref: ref, description: 'kept' } }))).toBe(rendered);
    });
  });

  describe('isReferenceEntry', () => {
    it('accepts an object without a word, whatever it holds', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(isReferenceEntry({ name: 'limit', in: 'query' }, 'parameters', 'a parameter of listPets')).toBe(true);
      expect(isReferenceEntry(limitRef, 'parameters', 'a parameter of listPets')).toBe(true);
      expect(isReferenceEntry({}, 'requestBodies', 'the request body of createPet')).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(NON_OBJECTS)(
      'rejects %s, warning once with the site when given one and silently otherwise',
      (_kind, value, rendered) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(isReferenceEntry(value, 'parameters', 'a parameter of listPets')).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenLastCalledWith(parameterSkipped('listPets', rendered));
        expect(isReferenceEntry(value, 'requestBodies')).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
      },
    );

    it('names each object type as OpenAPI does, and words a response as isResponseEntry does', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const said = () => String(warn.mock.calls.at(-1)?.[0]);

      isReferenceEntry(null, 'parameters', 'x');
      expect(said()).toBe(warning('x is not a Parameter Object (null); skipping it.'));
      isReferenceEntry(null, 'requestBodies', 'x');
      expect(said()).toBe(warning('x is not a Request Body Object (null); skipping it.'));
      isReferenceEntry(null, 'headers', 'x');
      expect(said()).toBe(warning('x is not a Header Object (null); skipping it.'));
      isReferenceEntry(null, 'examples', 'x');
      expect(said()).toBe(warning('x is not an Example Object (null); skipping it.'));
      isReferenceEntry(null, 'securitySchemes', 'x');
      expect(said()).toBe(warning('x is not a Security Scheme Object (null); skipping it.'));
      isReferenceEntry(null, 'responses', 'x');
      const viaReference = said();
      isResponseEntry(null, 'x');
      expect(said()).toBe(viaReference);
      expect(viaReference).toBe(warning('x is not a Response Object (null); skipping it.'));
    });
  });
});
