import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import {
  resolveContestedBodyNames,
  stemsInContest,
  yieldBodyNames,
  type OperationBodyNames,
} from '../../src/parser/contested-body-names.js';
import type { ApiSpec, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #683: two `operationId`s whose stems differ still minted one model
 * name when one id plus a body suffix equals a name the other's body nests —
 * `createPet` returning a `draft_response` object named it
 * `CreatePetResponseDraftResponse`, the response of
 * `operationId: createPetResponseDraft` — so the merge kept the first path's
 * shape for both with a warning, one operation was typed with fields it does
 * not return, and which one followed the order of the paths. Now a name two
 * operations' bodies would both mint belongs to the operation whose stem
 * contains the other's, and the other operation's model or enum takes the
 * next free numbered name, whatever the order of the paths.
 */

describe('#683', () => {
  const str = { type: 'string' };
  const int = { type: 'integer' };
  type Schema = Record<string, unknown>;
  /** An object schema, every property required. */
  const obj = (properties: Record<string, Schema>, extra: Schema = {}): Schema => ({
    type: 'object',
    required: Object.keys(properties),
    properties,
    ...extra,
  });
  const json = (schema: Schema) => ({ content: { 'application/json': { schema } } });
  const ok = (schema: Schema, code = '200') => ({ [code]: { description: 'ok', ...json(schema) } });
  const noContent = { '204': { description: 'ok' } };
  const document = (openapi: string, paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    openapi,
    info: { title: 'Repro 683', version: '1.0.0' },
    paths,
    ...extra,
  });
  /** `paths` with its entries in the reverse order. */
  const reversed = (paths: Record<string, unknown>) => Object.fromEntries(Object.entries(paths).reverse());

  /** `POST /pets` (`createPet`) taking `{ name }` and returning `201` `{ id, draft_response: { draftId } }`. */
  const pets = {
    '/pets': {
      post: {
        operationId: 'createPet',
        requestBody: { required: true, ...json(obj({ name: str })) },
        responses: ok(obj({ id: str, draft_response: obj({ draftId: str }) }), '201'),
      },
    },
  };
  /** `POST /pet-drafts` (`createPetResponseDraft`) returning `201` `{ draftNumber }`. */
  const petDrafts = {
    '/pet-drafts': { post: { operationId: 'createPetResponseDraft', responses: ok(obj({ draftNumber: int }), '201') } },
  };
  /** An operation returning `200` `schema`. */
  const returning = (operationId: string | undefined, schema: Schema, extra: Record<string, unknown> = {}) => ({
    ...(operationId ? { operationId } : {}),
    ...extra,
    responses: ok(schema),
  });
  /** An operation taking `schema` and returning nothing. */
  const taking = (operationId: string, schema: Schema) => ({
    operationId,
    requestBody: json(schema),
    responses: noContent,
  });

  const show = (type: TypeRef | undefined): string => {
    if (!type) return 'none';
    switch (type.kind) {
      case 'model':
      case 'enum':
        return type.name;
      case 'array':
        return `${show(type.items)}[]`;
      case 'nullable':
        return `${show(type.inner)} | null`;
      case 'union':
        return type.variants.map(show).join(' | ');
      case 'map':
        return `map<${show(type.valueType)}>`;
      case 'primitive':
        return type.type;
      case 'literal':
        return JSON.stringify(type.value);
    }
  };
  /** Every model and enum by name, and what each operation sends and returns, sorted so that the order of the paths does not show. */
  const summary = (spec: ApiSpec): string[] =>
    [
      ...spec.models.map((m) => `${m.name} { ${m.fields.map((f) => `${f.name}: ${show(f.type)}`).join(', ')} }`),
      ...spec.enums.map((e) => `enum ${e.name} [${e.values.map((v) => v.value).join(', ')}]`),
      ...spec.services
        .flatMap((service) => service.operations)
        .map((op) => {
          const later = (op.successResponses ?? [])
            .filter((entry) => entry.type !== op.response)
            .map((entry) => `, ${entry.statusCode} → ${show(entry.type)}`);
          return `${op.httpMethod.toUpperCase()} ${op.path} (${op.name}): ${show(op.requestBody)} → ${show(op.response)}${later.join('')}`;
        }),
    ].sort();
  /** Every change a diff reports, its breaking ones marked. */
  const changes = (before: ApiSpec, after: ApiSpec) =>
    diffSpecs(before, after).changes.map(
      (change) =>
        `${change.kind} ${'name' in change ? change.name : ''}${change.classification === 'breaking' ? ' (breaking)' : ''}`,
    );

  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oagen-683-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  let files = 0;
  const write = async (doc: Record<string, unknown>) => {
    const file = join(dir, `doc-${files++}.json`);
    await writeFile(file, JSON.stringify(doc));
    return file;
  };
  const parse = async (doc: Record<string, unknown>, options?: Parameters<typeof parseSpec>[1]) =>
    parseSpec(await write(doc), options);
  /** The exit code of `oagen diff --old <before> --new <after>`. */
  const exitCodeOf = async (before: string, after: string) => {
    const err: unknown = await diffCommand({ old: before, new: after }).catch((e: unknown) => e);
    return (err as { exitCode: number }).exitCode;
  };
  /**
   * `paths` parsed as written and with the paths reversed: the two must give
   * one IR — the same models, enums and operation types, and nothing for
   * `oagen diff` to report in either direction. Returns the summary both
   * give.
   */
  const settled = async (
    openapi: string,
    paths: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    options?: Parameters<typeof parseSpec>[1],
  ) => {
    const forward = await parse(document(openapi, paths, extra), options);
    const backward = await parse(document(openapi, reversed(paths), extra), options);
    expect(summary(backward)).toEqual(summary(forward));
    expect(changes(forward, backward)).toEqual([]);
    expect(changes(backward, forward)).toEqual([]);
    return summary(forward);
  };

  for (const openapi of ['3.1.0', '3.0.3']) {
    describe(`OpenAPI ${openapi}`, () => {
      it('gives the issue’s `repro.json` and `swapped.json` one IR: each operation typed with its own fields', async () => {
        const repro = await parse(document(openapi, { ...pets, ...petDrafts }));
        const swapped = await parse(document(openapi, { ...petDrafts, ...pets }));
        // What the issue's script prints.
        const printed = ({ models, services }: ApiSpec) => ({
          models: models.map(({ fields, name }) => `${name} { ${fields.map((field) => field.name).join(', ')} }`),
          responses: services.flatMap(({ operations }) =>
            operations.map(({ name, response }) => `${name} → ${show(response)}`),
          ),
        });
        expect(printed(repro)).toMatchInlineSnapshot(`
          {
            "models": [
              "CreatePetResponse { id, draft_response }",
              "CreatePetResponseDraftResponse2 { draftId }",
              "CreatePetRequest { name }",
              "CreatePetResponseDraftResponse { draftNumber }",
            ],
            "responses": [
              "createPet → CreatePetResponse",
              "createPetResponseDraft → CreatePetResponseDraftResponse",
            ],
          }
        `);
        expect(printed(swapped)).toMatchInlineSnapshot(`
          {
            "models": [
              "CreatePetResponseDraftResponse { draftNumber }",
              "CreatePetResponse { id, draft_response }",
              "CreatePetResponseDraftResponse2 { draftId }",
              "CreatePetRequest { name }",
            ],
            "responses": [
              "createPetResponseDraft → CreatePetResponseDraftResponse",
              "createPet → CreatePetResponse",
            ],
          }
        `);
        // `createPet`'s `draft_response` is a model of its own.
        for (const spec of [repro, swapped]) {
          const draftResponse = spec.models
            .find((model) => model.name === 'CreatePetResponse')!
            .fields.find((field) => field.name === 'draft_response')!;
          expect(draftResponse.type).toEqual({ kind: 'model', name: 'CreatePetResponseDraftResponse2' });
        }
        expect(warn).not.toHaveBeenCalled();
      });

      it('reports nothing when the paths are swapped: `oagen diff` exits 0 in both directions', async () => {
        const repro = await write(document(openapi, { ...pets, ...petDrafts }));
        const swapped = await write(document(openapi, { ...petDrafts, ...pets }));
        expect(changes(await parseSpec(repro), await parseSpec(swapped))).toEqual([]);
        expect(changes(await parseSpec(swapped), await parseSpec(repro))).toEqual([]);
        expect(await exitCodeOf(repro, swapped)).toBe(0);
        expect(await exitCodeOf(swapped, repro)).toBe(0);
        expect(warn).not.toHaveBeenCalled();
      });

      it('reports adding `POST /pet-drafts` the same wherever it is written: the nested model is renamed once, which is breaking', async () => {
        const oldFile = await write(document(openapi, pets));
        const old = await parseSpec(oldFile);
        // Alone, `createPet` holds every name its bodies mint.
        expect(summary(old)).toMatchInlineSnapshot(`
          [
            "CreatePetRequest { name: string }",
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse }",
            "CreatePetResponseDraftResponse { draftId: string }",
            "POST /pets (createPet): CreatePetRequest → CreatePetResponse",
          ]
        `);
        for (const paths of [
          { ...pets, ...petDrafts },
          { ...petDrafts, ...pets },
        ]) {
          const newFile = await write(document(openapi, paths));
          const next = await parseSpec(newFile);
          // `createPetResponseDraft` takes the name for its own response, and
          // the nested model moves to the numbered one.
          expect(changes(old, next).sort()).toMatchInlineSnapshot(`
            [
              "model-added CreatePetResponseDraftResponse2",
              "model-modified CreatePetResponse (breaking)",
              "model-modified CreatePetResponseDraftResponse (breaking)",
              "service-added PetDrafts",
            ]
          `);
          expect(await exitCodeOf(oldFile, newFile)).toBe(2);
          // Removing it again gives the name back.
          expect(changes(next, old).sort()).toMatchInlineSnapshot(`
            [
              "model-modified CreatePetResponse (breaking)",
              "model-modified CreatePetResponseDraftResponse (breaking)",
              "model-removed CreatePetResponseDraftResponse2 (breaking)",
              "service-removed PetDrafts (breaking)",
            ]
          `);
          expect(await exitCodeOf(newFile, oldFile)).toBe(2);
        }
        expect(warn).not.toHaveBeenCalled();
      });

      it('names the two models apart whatever their shapes: a field added to either later renames nothing', async () => {
        // Two models of one shape rather than one shared model, as two ids
        // that clean to one stem get (#627).
        const same = (draft: Schema) => ({
          '/pets': { post: returning('createPet', obj({ id: str, draft_response: obj({ draftId: str }) })) },
          '/pet-drafts': { post: returning('createPetResponseDraft', draft) },
        });
        expect(await settled(openapi, same(obj({ draftId: str })))).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse2 }",
            "CreatePetResponseDraftResponse { draftId: string }",
            "CreatePetResponseDraftResponse2 { draftId: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        const before = await parse(document(openapi, same(obj({ draftId: str }))));
        const after = await parse(document(openapi, same(obj({ draftId: str, draftNumber: int }))));
        expect(changes(before, after)).toEqual(['model-modified CreatePetResponseDraftResponse']);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles the request side the same way, and a `request` object in a response beside `<Id>Request`', async () => {
        // `createPet`'s `draft_request` beside the body of `createPetRequestDraft`.
        expect(
          await settled(openapi, {
            '/pets': { post: taking('createPet', obj({ name: str, draft_request: obj({ draftId: str }) })) },
            '/pet-drafts': { post: taking('createPetRequestDraft', obj({ draftNumber: int })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetRequest { name: string, draft_request: CreatePetRequestDraftRequest2 }",
            "CreatePetRequestDraftRequest { draftNumber: integer }",
            "CreatePetRequestDraftRequest2 { draftId: string }",
            "POST /pet-drafts (createPetRequestDraft): CreatePetRequestDraftRequest → unknown",
            "POST /pets (createPet): CreatePetRequest → unknown",
          ]
        `);
        // A `request` object `createPet` returns beside the body `createPetResponse` sends.
        expect(
          await settled(openapi, {
            '/pets': { post: returning('createPet', obj({ id: str, request: obj({ draftId: str }) })) },
            '/pet-responses': { post: taking('createPetResponse', obj({ draftNumber: int })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, request: CreatePetResponseRequest2 }",
            "CreatePetResponseRequest { draftNumber: integer }",
            "CreatePetResponseRequest2 { draftId: string }",
            "POST /pet-responses (createPetResponse): CreatePetResponseRequest → unknown",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles a name two bodies nest, under one parent name or under none', async () => {
        // Both `draft_response` and what it nests are contested: each is settled on its own.
        expect(
          await settled(openapi, {
            '/pets': {
              post: returning('createPet', obj({ id: str, draft_response: obj({ owner: obj({ a: str }) }) })),
            },
            '/pet-drafts': { post: returning('createPetResponseDraft', obj({ owner: obj({ b: int }) })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse2 }",
            "CreatePetResponseDraftResponse { owner: CreatePetResponseDraftResponseOwner }",
            "CreatePetResponseDraftResponse2 { owner: CreatePetResponseDraftResponseOwner2 }",
            "CreatePetResponseDraftResponseOwner { b: integer }",
            "CreatePetResponseDraftResponseOwner2 { a: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        // `draft_response_owner` on `createPet` beside `owner` on `createPetResponseDraft`.
        expect(
          await settled(openapi, {
            '/pets': { post: returning('createPet', obj({ id: str, draft_response_owner: obj({ a: str }) })) },
            '/pet-drafts': { post: returning('createPetResponseDraft', obj({ owner: obj({ b: int }) })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response_owner: CreatePetResponseDraftResponseOwner2 }",
            "CreatePetResponseDraftResponse { owner: CreatePetResponseDraftResponseOwner }",
            "CreatePetResponseDraftResponseOwner { b: integer }",
            "CreatePetResponseDraftResponseOwner2 { a: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles every way a field nests a model: array items, map values, union variants and an `allOf` merge', async () => {
        const drafts = { '/pet-drafts': { post: returning('createPetResponseDraft', obj({ draftNumber: int })) } };
        const nesting = (field: Record<string, Schema>) => ({
          '/pets': { post: returning('createPet', obj({ id: str, ...field })) },
          ...drafts,
        });
        expect(await settled(openapi, nesting({ draft_responses: { type: 'array', items: obj({ draftId: str }) } })))
          .toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_responses: CreatePetResponseDraftResponse2[] }",
            "CreatePetResponseDraftResponse { draftNumber: integer }",
            "CreatePetResponseDraftResponse2 { draftId: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        expect(
          await settled(
            openapi,
            nesting({ draft_responses: { type: 'object', additionalProperties: obj({ draftId: str }) } }),
          ),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_responses: map<CreatePetResponseDraftResponse2> }",
            "CreatePetResponseDraftResponse { draftNumber: integer }",
            "CreatePetResponseDraftResponse2 { draftId: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        expect(await settled(openapi, nesting({ draft_response: { oneOf: [obj({ a: str }), obj({ b: int })] } })))
          .toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse2 | CreatePetResponseDraftResponseWithB }",
            "CreatePetResponseDraftResponse { draftNumber: integer }",
            "CreatePetResponseDraftResponse2 { a: string }",
            "CreatePetResponseDraftResponseWithB { b: integer }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        expect(await settled(openapi, nesting({ draft_response: { allOf: [obj({ a: str }), obj({ c: str })] } })))
          .toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse2 }",
            "CreatePetResponseDraftResponse { draftNumber: integer }",
            "CreatePetResponseDraftResponse2 { a: string, c: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles an array body’s items, which are settled against the registry as each operation is read', async () => {
        // An `item` object `listPets` returns beside the items of `listPetsResponse`'s array.
        expect(
          await settled(openapi, {
            '/pets': { get: returning('listPets', obj({ id: str, item: obj({ a: str }) })) },
            '/pet-responses': { get: returning('listPetsResponse', { type: 'array', items: obj({ b: int }) }) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /pet-responses (listPetsResponse): none → ListPetsResponseItem[]",
            "GET /pets (listPets): none → ListPetsResponse",
            "ListPetsResponse { id: string, item: ListPetsResponseItem2 }",
            "ListPetsResponseItem { b: integer }",
            "ListPetsResponseItem2 { a: string }",
          ]
        `);
        // A `response` object in `listPets`'s items beside the response of `listPetsItem`:
        // the items keep `ListPetsItem` and never step to `ListPetsResponseItem`.
        expect(
          await settled(openapi, {
            '/pets': {
              get: returning('listPets', { type: 'array', items: obj({ id: str, response: obj({ a: str }) }) }),
            },
            '/pet-items': { get: returning('listPetsItem', obj({ b: int })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /pet-items (listPetsItem): none → ListPetsItemResponse",
            "GET /pets (listPets): none → ListPetsItem[]",
            "ListPetsItem { id: string, response: ListPetsItemResponse2 }",
            "ListPetsItemResponse { b: integer }",
            "ListPetsItemResponse2 { a: string }",
          ]
        `);
        // An array request body's items are `<Op>Request` itself.
        expect(
          await settled(openapi, {
            '/pets': { post: taking('createPet', { type: 'array', items: obj({ draft_request: obj({ a: str }) }) }) },
            '/pet-drafts': { post: taking('createPetRequestDraft', obj({ b: int })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetRequest { draft_request: CreatePetRequestDraftRequest2 }",
            "CreatePetRequestDraftRequest { b: integer }",
            "CreatePetRequestDraftRequest2 { a: string }",
            "POST /pet-drafts (createPetRequestDraft): CreatePetRequestDraftRequest → unknown",
            "POST /pets (createPet): CreatePetRequest[] → unknown",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles a later success body, on either side', async () => {
        // `createPetResponseDraft`'s 201 is `CreatePetResponseDraftResponse201`, the name of
        // a `draft_response201` object `createPet` returns.
        expect(
          await settled(openapi, {
            '/pets': { post: returning('createPet', obj({ id: str, draft_response201: obj({ a: str }) })) },
            '/pet-drafts': {
              post: {
                operationId: 'createPetResponseDraft',
                responses: { ...ok(obj({ b: int })), ...ok(obj({ c: int }), '201') },
              },
            },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response201: CreatePetResponseDraftResponse201No2 }",
            "CreatePetResponseDraftResponse { b: integer }",
            "CreatePetResponseDraftResponse201 { c: integer }",
            "CreatePetResponseDraftResponse201No2 { a: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse, 201 → CreatePetResponseDraftResponse201",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        // `createPet`'s 201 nests a `response`, `CreatePetResponse201Response`, the response
        // of `createPetResponse201`: the body keeps `CreatePetResponse201` in either order.
        expect(
          await settled(openapi, {
            '/pets': {
              post: {
                operationId: 'createPet',
                responses: { ...ok(obj({ id: str })), ...ok(obj({ id: str, response: obj({ a: str }) }), '201') },
              },
            },
            '/pet-201': { post: returning('createPetResponse201', obj({ b: int })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string }",
            "CreatePetResponse201 { id: string, response: CreatePetResponse201Response2 }",
            "CreatePetResponse201Response { b: integer }",
            "CreatePetResponse201Response2 { a: string }",
            "POST /pet-201 (createPetResponse201): none → CreatePetResponse201Response",
            "POST /pets (createPet): none → CreatePetResponse, 201 → CreatePetResponse201",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles an inline enum as it settles a model: enum beside enum, enum beside model, and the enum a contested model carries', async () => {
        const status = (...values: string[]) => ({ type: 'string', enum: values });
        // `draft_response_status` on `createPet` beside `status` on `createPetResponseDraft`.
        expect(
          await settled(openapi, {
            '/pets': { post: returning('createPet', obj({ id: str, draft_response_status: status('a', 'b') })) },
            '/pet-drafts': { post: returning('createPetResponseDraft', obj({ status: status('c', 'd') })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response_status: CreatePetResponseDraftResponseStatus2 }",
            "CreatePetResponseDraftResponse { status: CreatePetResponseDraftResponseStatus }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
            "enum CreatePetResponseDraftResponseStatus [c, d]",
            "enum CreatePetResponseDraftResponseStatus2 [a, b]",
          ]
        `);
        // A `draft_response` enum `createPet` returns beside the response model: the model
        // keeps its name, and no merge pass renames it for the enum.
        expect(
          await settled(openapi, {
            '/pets': { post: returning('createPet', obj({ id: str, draft_response: status('a', 'b') })) },
            '/pet-drafts': { post: returning('createPetResponseDraft', obj({ x: str })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse2 }",
            "CreatePetResponseDraftResponse { x: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
            "enum CreatePetResponseDraftResponse2 [a, b]",
          ]
        `);
        // A response that is itself an enum beside the nested model.
        expect(
          await settled(openapi, {
            '/pets': { post: returning('createPet', obj({ id: str, draft_response: obj({ a: str }) })) },
            '/pet-drafts': { post: returning('createPetResponseDraft', status('x', 'y')) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse2 }",
            "CreatePetResponseDraftResponse2 { a: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
            "enum CreatePetResponseDraftResponse [x, y]",
          ]
        `);
        // Both models carry a `status` enum of other values: the model and its enum each
        // leave the name they share with the other operation's.
        expect(
          await settled(openapi, {
            '/pets': {
              post: returning(
                'createPet',
                obj({ id: str, draft_response: obj({ draftId: str, status: status('a', 'b') }) }),
              ),
            },
            '/pet-drafts': {
              post: returning('createPetResponseDraft', obj({ draftNumber: int, status: status('c', 'd') })),
            },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse2 }",
            "CreatePetResponseDraftResponse { draftNumber: integer, status: CreatePetResponseDraftResponseStatus }",
            "CreatePetResponseDraftResponse2 { draftId: string, status: CreatePetResponseDraftResponseStatus2 }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
            "enum CreatePetResponseDraftResponseStatus [c, d]",
            "enum CreatePetResponseDraftResponseStatus2 [a, b]",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles three ids in a chain: the longest stem keeps the name and the shorter stem takes the lower number', async () => {
        const chain = {
          '/a': { get: returning('get', obj({ response_response: obj({ a: str }) })) },
          '/b': { get: returning('getResponse', obj({ response: obj({ b: str }) })) },
          '/c': { get: returning('getResponseResponse', obj({ c: str })) },
        };
        expect(await settled(openapi, chain)).toMatchInlineSnapshot(`
          [
            "GET /a (get): none → GetResponse",
            "GET /b (getResponse): none → GetResponseResponse",
            "GET /c (getResponseResponse): none → GetResponseResponseResponse",
            "GetResponse { response_response: GetResponseResponseResponse2 }",
            "GetResponseResponse { response: GetResponseResponseResponse3 }",
            "GetResponseResponseResponse { c: string }",
            "GetResponseResponseResponse2 { a: string }",
            "GetResponseResponseResponse3 { b: string }",
          ]
        `);
        // Every order of the three paths gives that IR.
        const [a, b, c] = Object.entries(chain);
        const expected = summary(await parse(document(openapi, chain)));
        for (const order of [
          [a, c, b],
          [b, a, c],
          [b, c, a],
          [c, a, b],
        ]) {
          expect(summary(await parse(document(openapi, Object.fromEntries(order))))).toEqual(expected);
        }
        // Without the longest id, the next one keeps the name and `get`'s model keeps its number.
        expect(await settled(openapi, Object.fromEntries([a, b]))).toMatchInlineSnapshot(`
          [
            "GET /a (get): none → GetResponse",
            "GET /b (getResponse): none → GetResponseResponse",
            "GetResponse { response_response: GetResponseResponseResponse2 }",
            "GetResponseResponse { response: GetResponseResponseResponse }",
            "GetResponseResponseResponse { b: string }",
            "GetResponseResponseResponse2 { a: string }",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles a variant named behind its const: `EmailCreatePetRequest` belongs to `emailCreatePet`', async () => {
        expect(
          await settled(openapi, {
            '/pets': {
              post: taking('createPet', {
                oneOf: [obj({ kind: { const: 'email' }, to: str }), obj({ kind: { const: 'sms' }, number: str })],
              }),
            },
            '/email-pets': { post: taking('emailCreatePet', obj({ b: int })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "EmailCreatePetRequest { b: integer }",
            "EmailCreatePetRequest2 { kind: "email", to: string }",
            "POST /email-pets (emailCreatePet): EmailCreatePetRequest → unknown",
            "POST /pets (createPet): EmailCreatePetRequest2 | SmsCreatePetRequest → unknown",
            "SmsCreatePetRequest { kind: "sms", number: string }",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles two operations named from their paths the same way', async () => {
        // `GET /pets` nests `foo_get_response`; `GET /pets/get/response/foo` is `PetsGetResponseFooGet`.
        expect(
          await settled(openapi, {
            '/pets': { get: returning(undefined, obj({ id: str, foo_get_response: obj({ a: str }) })) },
            '/pets/get/response/foo': { get: returning(undefined, obj({ b: int })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /pets (list): none → PetsGetResponse",
            "GET /pets/get/response/foo (listFoo): none → PetsGetResponseFooGetResponse",
            "PetsGetResponse { id: string, foo_get_response: PetsGetResponseFooGetResponse2 }",
            "PetsGetResponseFooGetResponse { b: integer }",
            "PetsGetResponseFooGetResponse2 { a: string }",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('steps past every numbered name already in play: the operation’s own field, a component, a component enum', async () => {
        const drafts = { '/pet-drafts': { post: returning('createPetResponseDraft', obj({ b: int })) } };
        const nested = { '/pets': { post: returning('createPet', obj({ id: str, draft_response: obj({ a: str }) })) } };
        // A `draft_response2` field of the same body.
        expect(
          await settled(openapi, {
            '/pets': {
              post: returning(
                'createPet',
                obj({ id: str, draft_response: obj({ a: str }), draft_response2: obj({ z: str }) }),
              ),
            },
            ...drafts,
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse3, draft_response2: CreatePetResponseDraftResponse2 }",
            "CreatePetResponseDraftResponse { b: integer }",
            "CreatePetResponseDraftResponse2 { z: string }",
            "CreatePetResponseDraftResponse3 { a: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        // A component schema.
        expect(
          await settled(
            openapi,
            { ...nested, ...drafts },
            { components: { schemas: { CreatePetResponseDraftResponse2: obj({ z: str }) } } },
          ),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse3 }",
            "CreatePetResponseDraftResponse { b: integer }",
            "CreatePetResponseDraftResponse2 { z: string }",
            "CreatePetResponseDraftResponse3 { a: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        // A component enum.
        expect(
          await settled(
            openapi,
            { ...nested, ...drafts },
            { components: { schemas: { CreatePetResponseDraftResponse2: { type: 'string', enum: ['x', 'y'] } } } },
          ),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse3 }",
            "CreatePetResponseDraftResponse { b: integer }",
            "CreatePetResponseDraftResponse3 { a: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
            "enum CreatePetResponseDraftResponse2 [x, y]",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      // Greptile (round 1): only the bodies in the contest were read when the
      // number was chosen, so the nested model took `…2` although an
      // operation outside it already used that name, and the merge kept the
      // larger of the two for both.
      it('steps past a numbered name an operation outside the contest uses, in every order of the paths', async () => {
        const contest = {
          '/pets': {
            post: returning('createPet', obj({ id: str, draft_response: obj({ a: str, b: str, c: str }) })),
          },
          '/pet-drafts': { post: returning('createPetResponseDraft', obj({ n: int })) },
        };
        /** `contest` beside `animals`, in each of the three places `animals` can stand, forward and reversed. */
        const everyOrder = async (animals: Record<string, unknown>) => {
          const [pets, drafts] = Object.entries(contest).map((entry) => Object.fromEntries([entry]));
          const first = await settled(openapi, { ...animals, ...pets, ...drafts });
          expect(await settled(openapi, { ...pets, ...animals, ...drafts })).toEqual(first);
          expect(await settled(openapi, { ...pets, ...drafts, ...animals })).toEqual(first);
          return first;
        };
        // A response named from its `object` const: `updateAnimal` keeps its own fields.
        expect(
          await everyOrder({
            '/animals': {
              put: returning('updateAnimal', obj({ object: { const: 'CreatePetResponseDraftResponse2' }, z: str })),
            },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse3 }",
            "CreatePetResponseDraftResponse { n: integer }",
            "CreatePetResponseDraftResponse2 { object: "CreatePetResponseDraftResponse2", z: string }",
            "CreatePetResponseDraftResponse3 { a: string, b: string, c: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
            "PUT /animals (updateAnimal): none → CreatePetResponseDraftResponse2",
          ]
        `);
        // An inline enum of that name, on a response named from its const: no merge pass renames the model for it.
        expect(
          await everyOrder({
            '/animals': {
              put: returning(
                'updateAnimal',
                obj({ object: { const: 'CreatePetResponseDraft' }, response2: { type: 'string', enum: ['x', 'y'] } }),
              ),
            },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse3 }",
            "CreatePetResponseDraft { object: "CreatePetResponseDraft", response2: CreatePetResponseDraftResponse2 }",
            "CreatePetResponseDraftResponse { n: integer }",
            "CreatePetResponseDraftResponse3 { a: string, b: string, c: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
            "PUT /animals (updateAnimal): none → CreatePetResponseDraft",
            "enum CreatePetResponseDraftResponse2 [x, y]",
          ]
        `);
        // A list envelope's companion, which takes its bare name.
        expect(
          await everyOrder({
            '/animals': {
              get: {
                operationId: 'listAnimals',
                parameters: [{ name: 'after', in: 'query', schema: str }],
                responses: ok(
                  obj({
                    data: { type: 'array', items: obj({ id: str }) },
                    list_metadata: obj({ after: str }),
                    create_pet_response_draft_response2: obj({ z: str }),
                  }),
                ),
              },
            },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse3 }",
            "CreatePetResponseDraftResponse { n: integer }",
            "CreatePetResponseDraftResponse2 { z: string }",
            "CreatePetResponseDraftResponse3 { a: string, b: string, c: string }",
            "GET /animals (listAnimals): none → ListAnimalsItem[]",
            "ListAnimalsItem { id: string }",
            "ListMetadata { after: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        // A query parameter's enum, named from its service (`CreatePet`) and the parameter.
        expect(
          await everyOrder({
            '/create-pet': {
              get: returning('searchAnimals', str, {
                tags: ['CreatePet'],
                parameters: [
                  { name: 'response_draft_response2', in: 'query', schema: { type: 'string', enum: ['x', 'y'] } },
                ],
              }),
            },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse3 }",
            "CreatePetResponseDraftResponse { n: integer }",
            "CreatePetResponseDraftResponse3 { a: string, b: string, c: string }",
            "GET /create-pet (searchAnimals): none → string",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
            "enum CreatePetResponseDraftResponse2 [x, y]",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      // The same class: the name a body takes was read off a hand-kept copy of
      // the rules, which gave a later status code's body `…Response201` where
      // the operation steps it to `…Response2` past a component, so the nested
      // model took that very name in one path order.
      it('reads the names off the operation as it is built: a later body that steps to a number keeps it', async () => {
        expect(
          await settled(
            openapi,
            {
              '/pets': { post: returning('createPet', obj({ id: str, draft_response: obj({ a: str }) })) },
              '/pet-drafts': {
                post: {
                  operationId: 'createPetResponseDraft',
                  responses: { ...ok(obj({ b: int })), ...ok(obj({ c: int }), '201') },
                },
              },
            },
            { components: { schemas: { CreatePetResponseDraftResponse201: obj({ z: str }) } } },
          ),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse3 }",
            "CreatePetResponseDraftResponse { b: integer }",
            "CreatePetResponseDraftResponse2 { c: integer }",
            "CreatePetResponseDraftResponse201 { z: string }",
            "CreatePetResponseDraftResponse3 { a: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse, 201 → CreatePetResponseDraftResponse2",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('leaves a component its name: the nested model is numbered, and the response is settled against the component as before', async () => {
        // `original` is an explicit `$ref` to the component, beside the inline
        // `draft_response` of its name: only the inline object's reference moves.
        expect(
          await settled(
            openapi,
            {
              '/pets': {
                post: returning(
                  'createPet',
                  obj({
                    id: str,
                    draft_response: obj({ a: str }),
                    original: { $ref: '#/components/schemas/CreatePetResponseDraftResponse' },
                  }),
                ),
              },
              '/pet-drafts': { post: returning('createPetResponseDraft', obj({ b: int })) },
            },
            { components: { schemas: { CreatePetResponseDraftResponse: obj({ z: str }) } } },
          ),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse2, original: CreatePetResponseDraftResponse }",
            "CreatePetResponseDraftResponse { z: string }",
            "CreatePetResponseDraftResponse2 { a: string }",
            "CreatePetResponseDraftResponse3 { b: integer }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse3",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        // The merge passes' note for a response a component of its name does not admit, once per parse.
        expect(warn.mock.calls.map((call: unknown[]) => call[0])).toEqual(
          Array(2).fill(
            '[oagen] Renamed inline model "CreatePetResponseDraftResponse" → "CreatePetResponseDraftResponse3": its shape differs from component schema "CreatePetResponseDraftResponse"',
          ),
        );
      });

      it('gives nothing up to an operation that does not mint the name', async () => {
        // `createPetResponseDraft` returns a component: `createPet` keeps the name.
        expect(
          await settled(
            openapi,
            {
              '/pets': { post: returning('createPet', obj({ id: str, draft_response: obj({ draftId: str }) })) },
              '/pet-drafts': { post: returning('createPetResponseDraft', { $ref: '#/components/schemas/Draft' }) },
            },
            { components: { schemas: { Draft: obj({ z: str }) } } },
          ),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse }",
            "CreatePetResponseDraftResponse { draftId: string }",
            "Draft { z: string }",
            "POST /pet-drafts (createPetResponseDraft): none → Draft",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        // Writing that response inline later renames the nested model, once.
        const withRef = await parse(
          document(
            openapi,
            {
              '/pets': { post: returning('createPet', obj({ id: str, draft_response: obj({ draftId: str }) })) },
              '/pet-drafts': { post: returning('createPetResponseDraft', { $ref: '#/components/schemas/Draft' }) },
            },
            { components: { schemas: { Draft: obj({ z: str }) } } },
          ),
        );
        const inline = await parse(
          document(
            openapi,
            {
              '/pets': { post: returning('createPet', obj({ id: str, draft_response: obj({ draftId: str }) })) },
              '/pet-drafts': { post: returning('createPetResponseDraft', obj({ z: str })) },
            },
            { components: { schemas: { Draft: obj({ z: str }) } } },
          ),
        );
        expect(changes(withRef, inline).sort()).toMatchInlineSnapshot(`
          [
            "model-added CreatePetResponseDraftResponse2",
            "model-modified CreatePetResponse (breaking)",
            "model-modified CreatePetResponseDraftResponse (breaking)",
            "operation-modified  (breaking)",
          ]
        `);
        // Nothing `createPet` nests is named like the other operation's response.
        expect(
          await settled(openapi, {
            '/pets': { post: returning('createPet', obj({ id: str, owner: obj({ a: str }) })) },
            '/pet-drafts': { post: returning('createPetResponseDraft', obj({ draftNumber: int })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, owner: CreatePetResponseOwner }",
            "CreatePetResponseDraftResponse { draftNumber: integer }",
            "CreatePetResponseOwner { a: string }",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('reads two paths that `$ref` one Path Item as the one operation they are', async () => {
        expect(
          await settled(openapi, {
            '/pets': { post: returning('createPet', obj({ id: str, draft_response: obj({ a: str }) })) },
            '/animals': { $ref: '#/paths/~1pets' },
            '/pet-drafts': { post: returning('createPetResponseDraft', obj({ b: int })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id: string, draft_response: CreatePetResponseDraftResponse2 }",
            "CreatePetResponseDraftResponse { b: integer }",
            "CreatePetResponseDraftResponse2 { a: string }",
            "POST /animals (createPet): none → CreatePetResponse",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('reads the ids as written: spelled in another case, or renamed by an `operationIdTransform`, the models are the same', async () => {
        const plain = await settled(openapi, { ...pets, ...petDrafts });
        // `create_pet_response_draft` cleans to the stem `CreatePetResponseDraft` too.
        const snake = await settled(openapi, {
          ...pets,
          '/pet-drafts': { post: { ...petDrafts['/pet-drafts'].post, operationId: 'create_pet_response_draft' } },
        });
        expect(snake).toEqual(plain);
        // A transform renames the operations only (#537).
        const transformed = await parse(document(openapi, { ...pets, ...petDrafts }), {
          operationIdTransform: (operationId) => (operationId === 'createPet' ? 'addPet' : 'addDraft'),
        });
        expect(summary(transformed).filter((line) => !line.startsWith('POST'))).toEqual(
          plain.filter((line) => !line.startsWith('POST')),
        );
        expect(summary(transformed).filter((line) => line.startsWith('POST'))).toEqual([
          'POST /pet-drafts (addDraft): none → CreatePetResponseDraftResponse',
          'POST /pets (addPet): CreatePetRequest → CreatePetResponse',
        ]);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles a list envelope’s companion kept under its operation’s name', async () => {
        /** A paged list whose envelope carries a `list_metadata` companion. */
        const list = (operationId: string, metadata: Record<string, Schema>) => ({
          get: {
            operationId,
            parameters: [{ name: 'after', in: 'query', schema: str }],
            responses: ok(obj({ data: { type: 'array', items: obj({ id: str }) }, list_metadata: obj(metadata) })),
          },
        });
        // `listPets`'s companion differs from the other two, so it keeps
        // `ListPetsListMetadata`, and the `response` it nests is the response
        // of `listPetsListMetadata`.
        expect(
          await settled(openapi, {
            '/cats': list('listCats', { after: str }),
            '/dogs': list('listDogs', { after: str }),
            '/pets': list('listPets', { after: str, response: obj({ a: str }) }),
            '/pet-meta': { get: returning('listPetsListMetadata', obj({ b: int })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /cats (listCats): none → ListCatsItem[]",
            "GET /dogs (listDogs): none → ListDogsItem[]",
            "GET /pet-meta (listPetsListMetadata): none → ListPetsListMetadataResponse",
            "GET /pets (listPets): none → ListPetsItem[]",
            "ListCatsItem { id: string }",
            "ListDogsItem { id: string }",
            "ListMetadata { after: string }",
            "ListPetsItem { id: string }",
            "ListPetsListMetadata { after: string, response: ListPetsListMetadataResponse2 }",
            "ListPetsListMetadataResponse { b: integer }",
            "ListPetsListMetadataResponse2 { a: string }",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it('still steps a model named after the operations loop past a body’s name, in either order', async () => {
        // The `text/csv` body and the `default` body of `getPetResponse` derive
        // `GetPetResponseTextCsvResponse` and `GetPetResponseDefaultResponse`, the names of
        // two objects `getPet` returns: named last, against every body's name, they step,
        // as before, and the nested models keep their names.
        expect(
          await settled(openapi, {
            '/pets': {
              get: returning(
                'getPet',
                obj({ id: str, text_csv_response: obj({ a: str }), default_response: obj({ a: str }) }),
              ),
            },
            '/pet-responses': {
              get: {
                operationId: 'getPetResponse',
                responses: {
                  '200': {
                    description: 'ok',
                    content: { 'application/json': { schema: str }, 'text/csv': { schema: obj({ b: int }) } },
                  },
                  default: { description: 'other', ...json(obj({ c: int })) },
                },
              },
            },
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /pet-responses (getPetResponse): none → string",
            "GET /pets (getPet): none → GetPetResponse",
            "GetPetResponse { id: string, text_csv_response: GetPetResponseTextCsvResponse, default_response: GetPetResponseDefaultResponse }",
            "GetPetResponseDefaultResponse { a: string }",
            "GetPetResponseDefaultResponse2 { c: integer }",
            "GetPetResponseTextCsvResponse { a: string }",
            "GetPetResponseTextCsvResponse200 { b: integer }",
          ]
        `);
        expect(warn).not.toHaveBeenCalled();
      });
    });
  }

  describe('resolveContestedBodyNames', () => {
    const body = (
      key: string,
      stem: string,
      models: string[],
      enums: string[] = [],
      others: string[] = [],
    ): OperationBodyNames => ({ key, stem, models, enums, others });
    const settle = (bodies: OperationBodyNames[], taken: string[] = []) =>
      Object.fromEntries([...resolveContestedBodyNames(bodies, () => taken)].map(([key, given]) => [key, [...given]]));

    it('gives a name up to the operation whose stem contains the other’s, whatever the order of the bodies', () => {
      const pets = body('post /pets', 'CreatePet', ['CreatePetResponse', 'CreatePetResponseDraftResponse']);
      const drafts = body('post /pet-drafts', 'CreatePetResponseDraft', ['CreatePetResponseDraftResponse']);
      const expected = { 'post /pets': [['CreatePetResponseDraftResponse', 'CreatePetResponseDraftResponse2']] };
      expect(settle([pets, drafts])).toEqual(expected);
      expect(settle([drafts, pets])).toEqual(expected);
    });

    it('settles an enum name as a model name, between an enum and a model too', () => {
      expect(
        settle([
          body('a', 'CreatePet', ['CreatePetResponse'], ['CreatePetResponseDraftResponse']),
          body('b', 'CreatePetResponseDraft', ['CreatePetResponseDraftResponse']),
        ]),
      ).toEqual({ a: [['CreatePetResponseDraftResponse', 'CreatePetResponseDraftResponse2']] });
    });

    it('settles a name that carries a stem behind a const, and leaves one that carries none', () => {
      expect(
        settle([
          body('a', 'CreatePet', ['EmailCreatePetRequest', 'Circle']),
          body('b', 'EmailCreatePet', ['EmailCreatePetRequest', 'Circle']),
        ]),
      ).toEqual({ a: [['EmailCreatePetRequest', 'EmailCreatePetRequest2']] });
    });

    it('settles nothing between stems neither of which contains the other, and nothing for an empty stem', () => {
      // `AbResponseCdRequestX` carries both `Ab` and `Cd`.
      expect(settle([body('a', 'Ab', ['AbResponseCdRequestX']), body('b', 'Cd', ['AbResponseCdRequestX'])])).toEqual(
        {},
      );
      expect(settle([body('a', '', ['GetResponse']), body('b', 'Get', ['GetResponse'])])).toEqual({});
    });

    it('numbers past every name in play, and gives the shorter stem the lower number', () => {
      const chain = [
        body('c', 'GetResponseResponse', ['GetResponseResponseResponse']),
        body('b', 'GetResponse', ['GetResponseResponse', 'GetResponseResponseResponse']),
        body('a', 'Get', ['GetResponse', 'GetResponseResponseResponse']),
      ];
      expect(settle(chain)).toEqual({
        a: [['GetResponseResponseResponse', 'GetResponseResponseResponse2']],
        b: [['GetResponseResponseResponse', 'GetResponseResponseResponse3']],
      });
      // `…2` is taken — by a component, say — and `…3` by another body's own name.
      expect(
        settle(
          [...chain, body('d', 'GetResponseResponseResponse3', ['GetResponseResponseResponse3'])],
          ['GetResponseResponseResponse2'],
        ),
      ).toEqual({
        a: [['GetResponseResponseResponse', 'GetResponseResponseResponse4']],
        b: [['GetResponseResponseResponse', 'GetResponseResponseResponse5']],
      });
      // A name that ends in a digit takes its number behind `No`.
      expect(
        settle([
          body('a', 'CreatePet', ['CreatePetResponseDraftResponse201']),
          body('b', 'CreatePetResponseDraft', ['CreatePetResponseDraftResponse201']),
        ]),
      ).toEqual({ a: [['CreatePetResponseDraftResponse201', 'CreatePetResponseDraftResponse201No2']] });
    });

    it('reads the names in play only when a name is given up, and keeps clear of the other names an operation holds', () => {
      const pets = body('a', 'CreatePet', ['CreatePetResponseDraftResponse']);
      const drafts = body('b', 'CreatePetResponseDraft', ['CreatePetResponseDraftResponse']);
      const taken = vi.fn(() => ['CreatePetResponseDraftResponse2']);
      // No name both mint: nothing is given up, and nothing else is read.
      expect([...resolveContestedBodyNames([pets, body('c', 'CreatePetRequestDraft', ['X'])], taken)]).toEqual([]);
      expect(taken).not.toHaveBeenCalled();
      expect(
        Object.fromEntries(
          [...resolveContestedBodyNames([pets, drafts], taken)].map(([key, given]) => [key, [...given]]),
        ),
      ).toEqual({ a: [['CreatePetResponseDraftResponse', 'CreatePetResponseDraftResponse3']] });
      expect(taken).toHaveBeenCalledTimes(1);
      // A companion's bare name or a parameter's enum is never claimed, only kept clear of.
      expect(
        settle([
          pets,
          body(
            'b',
            'CreatePetResponseDraft',
            ['CreatePetResponseDraftResponse'],
            [],
            ['CreatePetResponseDraftResponse2'],
          ),
        ]),
      ).toEqual({
        a: [['CreatePetResponseDraftResponse', 'CreatePetResponseDraftResponse3']],
      });
    });

    it('reads one stem as one claimant: two paths onto one Operation Object give up the same names', () => {
      expect(
        settle([
          body('post /pets', 'CreatePet', ['CreatePetResponseDraftResponse']),
          body('post /animals', 'CreatePet', ['CreatePetResponseDraftResponse']),
          body('post /pet-drafts', 'CreatePetResponseDraft', ['CreatePetResponseDraftResponse']),
        ]),
      ).toEqual({
        'post /pets': [['CreatePetResponseDraftResponse', 'CreatePetResponseDraftResponse2']],
        'post /animals': [['CreatePetResponseDraftResponse', 'CreatePetResponseDraftResponse2']],
      });
    });
  });

  describe('stemsInContest', () => {
    it('keeps the stems one of which contains another, as a prefix or anywhere else', () => {
      expect([
        ...stemsInContest(['CreatePet', 'CreatePetResponseDraft', 'EmailCreatePet', 'ListPets', 'GetPet', '']),
      ]).toEqual(['CreatePet', 'CreatePetResponseDraft', 'EmailCreatePet']);
      expect([...stemsInContest(['ListPets', 'GetPet', 'ListPets', ''])]).toEqual([]);
    });
  });

  describe('yieldBodyNames', () => {
    it('moves a model, every reference to it and an inline enum of a given-up name, and nothing else', () => {
      const yields = new Map([
        ['Nested', 'Nested2'],
        ['NestedStatus', 'NestedStatus2'],
      ]);
      const nested: Model = {
        name: 'Nested',
        fields: [
          { name: 'status', type: { kind: 'enum', name: 'NestedStatus', values: ['a', 'b'] }, required: true },
          // A `$ref` to a component enum carries no values and is not the body's to move.
          { name: 'kind', type: { kind: 'enum', name: 'NestedStatus' }, required: true },
        ],
      };
      const root: Model = {
        name: 'Root',
        fields: [
          { name: 'one', type: { kind: 'model', name: 'Nested' }, required: true },
          { name: 'many', type: { kind: 'array', items: { kind: 'model', name: 'Nested' } }, required: true },
        ],
      };
      const type: TypeRef = { kind: 'nullable', inner: { kind: 'model', name: 'Nested' } };
      yieldBodyNames(yields, [type], [root, nested]);
      expect(nested.name).toBe('Nested2');
      expect(root.fields.map((field) => show(field.type))).toEqual(['Nested2', 'Nested2[]']);
      expect(nested.fields.map((field) => show(field.type))).toEqual(['NestedStatus2', 'NestedStatus']);
      expect(show(type)).toBe('Nested2 | null');
    });
  });
});
