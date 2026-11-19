import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import {
  namesHeldAcrossStems,
  resolveContestedBodyNames,
  type OperationBodyNames,
} from '../../src/parser/contested-body-names.js';
import type { ApiSpec, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #712: a response named from its `object` const (`get_pet_response` →
 * `GetPetResponse`) can take the name another operation mints for its own
 * response from its stem (`getPet` → `GetPetResponse`). The contest #694
 * settles up front read names minted from two stems only, so the two
 * definitions met in the merge, which kept the one with more fields for both
 * operations: one was typed with fields it does not return, and adding the
 * other operation to a document retyped it. Now a name an operation mints
 * from its stem is that operation's against the document's names too: what
 * the document names so keeps the name only while it is that very model, and
 * takes the next free numbered name otherwise, with a note.
 */

describe('#712', () => {
  const str = { type: 'string' };
  const int = { type: 'integer' };
  type Schema = Record<string, unknown>;
  /** An object schema; no property is required unless `extra` says so, as in the issue's document. */
  const obj = (properties: Record<string, Schema>, extra: Schema = {}): Schema => ({
    type: 'object',
    properties,
    ...extra,
  });
  const konst = (value: string): Schema => ({ type: 'string', const: value });
  const json = (schema: Schema) => ({ content: { 'application/json': { schema } } });
  const ok = (schema: Schema, code = '200') => ({ [code]: { description: 'ok', ...json(schema) } });
  const document = (openapi: string, paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    openapi,
    info: { title: 'Repro', version: '1.0.0' },
    paths,
    components: { schemas: {} },
    ...extra,
  });
  /** `paths` with its entries in the reverse order. */
  const reversed = (paths: Record<string, unknown>) => Object.fromEntries(Object.entries(paths).reverse());
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
    responses: { '204': { description: 'ok' } },
  });
  const petId = [{ name: 'petId', in: 'path', required: true, schema: str }];
  /** `GET /pets/{petId}` (`getPet`) returning `schema`, `{ name }` in the issue. */
  const getPet = (schema: Schema = obj({ name: str })) => ({
    '/pets/{petId}': { get: returning('getPet', schema, { parameters: petId }) },
  });
  /** An object the document names from its `object` const: `{ object: <value>, breed }` in the issue. */
  const named = (value = 'get_pet_response', fields: Record<string, Schema> = { breed: str }, extra: Schema = {}) =>
    obj({ object: konst(value), ...fields }, extra);
  /** `GET /dogs` (`listDogs`) returning `schema`, the issue's `{ object: 'get_pet_response', breed }` by default. */
  const listDogs = (schema: Schema = named()) => ({ '/dogs': { get: returning('listDogs', schema) } });
  /** A union of two titled objects, the first titled `title`. */
  const titled = (title = 'GetPetResponse', fields: Record<string, Schema> = { breed: str }): Schema => ({
    oneOf: [obj({ kind: konst('a'), ...fields }, { title }), obj({ kind: konst('b'), x: int }, { title: 'Other' })],
  });
  /** The note a document's name is moved with. */
  const note = (name: string, renamed: string, keeper: string, shared = '', kind = 'model') =>
    `[oagen] Renamed inline ${kind} "${name}" → "${renamed}": its shape differs from operation ${keeper}'s own "${name}"${shared}`;

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
      ...spec.models.map(
        (m) =>
          `${m.name}${m.deprecated ? ' (deprecated)' : ''} { ${m.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`).join(', ')} }`,
      ),
      ...spec.enums.map((e) => `enum ${e.name} [${e.values.map((v) => v.value).join(', ')}]`),
      ...spec.services
        .flatMap((service) => service.operations)
        .map((op) => {
          const later = (op.successResponses ?? [])
            .filter((entry) => entry.type !== op.response)
            .map((entry) => `, ${entry.statusCode} → ${show(entry.type)}`);
          return `${op.httpMethod.toUpperCase()} ${op.path} (${op.name}): ${show(op.requestBody)} → ${show(op.response)}${later.join('')}`;
        }),
      ...(spec.webhooks ?? []).map((webhook) => `webhook ${webhook.name}: ${show(webhook.requestBody)}`),
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
    dir = await mkdtemp(join(tmpdir(), 'oagen-712-'));
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
  const parse = async (doc: Record<string, unknown>) => parseSpec(await write(doc));
  /** What the parse of the last document warned, in order. */
  const warnings = () => warn.mock.calls.map((call: unknown[]) => call[0]);
  /** The exit code of `oagen diff --old <before> --new <after>`. */
  const exitCodeOf = async (before: string, after: string) => {
    const err: unknown = await diffCommand({ old: before, new: after }).catch((e: unknown) => e);
    return (err as { exitCode: number }).exitCode;
  };
  /**
   * `paths` parsed as written and with the paths reversed: the two must give
   * one IR — the same models, enums and operation types, the same warnings,
   * and nothing for `oagen diff` to report in either direction. Returns the
   * summary both give, followed by the warnings.
   */
  const settled = async (openapi: string, paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    warn.mockClear();
    const forward = await parse(document(openapi, paths, extra));
    const forwardWarnings = warnings();
    warn.mockClear();
    const backward = await parse(document(openapi, reversed(paths), extra));
    expect(summary(backward)).toEqual(summary(forward));
    expect(warnings()).toEqual(forwardWarnings);
    expect(changes(forward, backward)).toEqual([]);
    expect(changes(backward, forward)).toEqual([]);
    return [...summary(forward), ...forwardWarnings.map((warning: unknown) => `! ${String(warning)}`)];
  };

  for (const openapi of ['3.1.0', '3.0.3']) {
    describe(`OpenAPI ${openapi}`, () => {
      it('gives the issue’s `repro.json` each operation a model of its own shape, in either path order', async () => {
        // The issue's script: every model with its field names, and each operation's response.
        const script = ({ models, services }: ApiSpec) => ({
          models: models.map(({ fields, name }) => `${name} { ${fields.map((field) => field.name).join(', ')} }`),
          responses: services.flatMap(({ operations }) =>
            operations.map(({ name, response }) => `${name} → ${show(response)}`),
          ),
        });
        expect(script(await parse(document(openapi, { ...getPet(), ...listDogs() })))).toEqual({
          models: ['GetPetResponse { name }', 'GetPetResponse2 { object, breed }'],
          responses: ['getPet → GetPetResponse', 'listDogs → GetPetResponse2'],
        });
        expect(warnings()).toEqual([note('GetPetResponse', 'GetPetResponse2', 'GET /pets/{petId}')]);

        expect(await settled(openapi, { ...getPet(), ...listDogs() })).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { object?: "get_pet_response", breed?: string }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
      });

      it('keeps the name with the operation that mints it whichever body is larger', async () => {
        // With `getPet` returning more fields than `listDogs`, the merge typed `listDogs`
        // with `getPet`'s fields; the two keep their own all the same.
        expect(await settled(openapi, { ...getPet(obj({ name: str, age: int, color: str })), ...listDogs() }))
          .toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string, age?: integer, color?: string }",
            "GetPetResponse2 { object?: "get_pet_response", breed?: string }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
      });

      it('reports adding `listDogs` beside `getPet` as an addition: `oagen diff` exits 1, and 0 between the path orders', async () => {
        const old = await write(document(openapi, getPet()));
        const repro = await write(document(openapi, { ...getPet(), ...listDogs() }));
        const swapped = await write(document(openapi, { ...listDogs(), ...getPet() }));
        // `getPet`'s response is what it was: nothing of `old.json` is modified.
        expect(changes(await parseSpec(old), await parseSpec(repro))).toEqual([
          'model-added GetPetResponse2',
          'service-added Dogs',
        ]);
        expect(await exitCodeOf(old, repro)).toBe(1);
        expect(changes(await parseSpec(repro), await parseSpec(old))).toEqual([
          'model-removed GetPetResponse2 (breaking)',
          'service-removed Dogs (breaking)',
        ]);
        expect(await exitCodeOf(repro, old)).toBe(2);
        expect(await exitCodeOf(repro, swapped)).toBe(0);
        expect(await exitCodeOf(swapped, repro)).toBe(0);
      });

      it('moves the document’s name when the minting operation is the one added: the mirror image is breaking', async () => {
        // A document with `listDogs` alone names its response `GetPetResponse`: no stem
        // mints the name. Adding `getPet` gives the name to `getPet`, so `listDogs`'s
        // response moves — the one change the rule makes to a document that had neither
        // clash nor warning — and `oagen diff` says so.
        const dogs = await write(document(openapi, listDogs()));
        const repro = await write(document(openapi, { ...getPet(), ...listDogs() }));
        expect(summary(await parseSpec(dogs))).toEqual([
          'GET /dogs (listDogs): none → GetPetResponse',
          'GetPetResponse { object?: "get_pet_response", breed?: string }',
        ]);
        expect(changes(await parseSpec(dogs), await parseSpec(repro))).toEqual([
          'model-added GetPetResponse2',
          'model-modified GetPetResponse (breaking)',
          'service-added Pets',
          'operation-modified  (breaking)',
        ]);
        expect(await exitCodeOf(dogs, repro)).toBe(2);
        expect(await exitCodeOf(repro, dogs)).toBe(2);
      });

      it('pins what did not clash: a one-value `enum` names nothing, and a component keeps its name', async () => {
        // `enum: ['get_pet_response']` is no const: the response is named from the operation.
        expect(
          await settled(openapi, {
            ...getPet(),
            ...listDogs(obj({ object: { type: 'string', enum: ['get_pet_response'] }, breed: str })),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → ListDogsResponse",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "ListDogsResponse { object?: "get_pet_response", breed?: string }",
          ]
        `);
        // A component schema `GetPetResponse` of `listDogs`'s shape: `getPet`'s body is
        // settled against it by the merge, as before.
        expect(await settled(openapi, getPet(), { components: { schemas: { GetPetResponse: named() } } }))
          .toMatchInlineSnapshot(`
          [
            "GET /pets/{petId} (getPet): none → GetPetResponse2",
            "GetPetResponse { object?: "get_pet_response", breed?: string }",
            "GetPetResponse2 { name?: string }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from component schema "GetPetResponse"",
          ]
        `);
      });

      it('leaves a name a component holds to the component: every copy is settled against it, as before', async () => {
        // The name is the component's, so neither operation's: `getPet`'s body and the body
        // `listDogs` names from its const are each measured against the component.
        const spec = await parse(
          document(
            openapi,
            { ...getPet(), ...listDogs() },
            { components: { schemas: { GetPetResponse: obj({ other: str }) } } },
          ),
        );
        expect(summary(spec)).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → ListDogsGetPetResponse",
            "GET /pets/{petId} (getPet): none → GetPetResponse2",
            "GetPetResponse { other?: string }",
            "GetPetResponse2 { name?: string }",
            "ListDogsGetPetResponse { object?: "get_pet_response", breed?: string }",
          ]
        `);
        expect(warnings()).toEqual([
          '[oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from component schema "GetPetResponse"',
          '[oagen] Renamed inline model "GetPetResponse" → "ListDogsGetPetResponse": its shape differs from component schema "GetPetResponse"',
        ]);
        // A component that admits the document's copy still takes it.
        expect(
          await settled(
            openapi,
            { ...getPet(), ...listDogs() },
            { components: { schemas: { GetPetResponse: named() } } },
          ),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse",
            "GET /pets/{petId} (getPet): none → GetPetResponse2",
            "GetPetResponse { object?: "get_pet_response", breed?: string }",
            "GetPetResponse2 { name?: string }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from component schema "GetPetResponse"",
          ]
        `);
      });

      it('settles every name an operation mints from its stem: a request body, a nested model, array items, a later status code', async () => {
        // `<Op>Request`.
        expect(
          await settled(openapi, {
            '/pets': { post: taking('createPet', obj({ name: str })) },
            ...listDogs(named('create_pet_request')),
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetRequest { name?: string }",
            "CreatePetRequest2 { object?: "create_pet_request", breed?: string }",
            "GET /dogs (listDogs): none → CreatePetRequest2",
            "POST /pets (createPet): CreatePetRequest → unknown",
            "! [oagen] Renamed inline model "CreatePetRequest" → "CreatePetRequest2": its shape differs from operation POST /pets's own "CreatePetRequest"",
          ]
        `);
        // `<Op>Response<Field>`.
        expect(
          await settled(openapi, {
            ...getPet(obj({ id: str, owner: obj({ name: str }) })),
            ...listDogs(named('get_pet_response_owner')),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponseOwner2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { id?: string, owner?: GetPetResponseOwner }",
            "GetPetResponseOwner { name?: string }",
            "GetPetResponseOwner2 { object?: "get_pet_response_owner", breed?: string }",
            "! [oagen] Renamed inline model "GetPetResponseOwner" → "GetPetResponseOwner2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponseOwner"",
          ]
        `);
        // `<Op>Item`, an array body's items: settled against the registry as the operation
        // is read, so the items stepped to `ListPetsResponseItem` when `/dogs` came first.
        expect(
          await settled(openapi, {
            '/pets': { get: returning('listPets', { type: 'array', items: obj({ name: str }) }) },
            ...listDogs(named('list_pets_item')),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → ListPetsItem2",
            "GET /pets (listPets): none → ListPetsItem[]",
            "ListPetsItem { name?: string }",
            "ListPetsItem2 { object?: "list_pets_item", breed?: string }",
            "! [oagen] Renamed inline model "ListPetsItem" → "ListPetsItem2": its shape differs from operation GET /pets's own "ListPetsItem"",
          ]
        `);
        // `<Op>Response201`, a later status code's body; the numbered name is set off by `No`.
        expect(
          await settled(openapi, {
            '/pets/{petId}': {
              get: {
                operationId: 'getPet',
                parameters: petId,
                responses: { ...ok(obj({ name: str })), ...ok(obj({ made: str }), '201') },
              },
            },
            ...listDogs(named('get_pet_response201')),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse201No2",
            "GET /pets/{petId} (getPet): none → GetPetResponse, 201 → GetPetResponse201",
            "GetPetResponse { name?: string }",
            "GetPetResponse201 { made?: string }",
            "GetPetResponse201No2 { object?: "get_pet_response201", breed?: string }",
            "! [oagen] Renamed inline model "GetPetResponse201" → "GetPetResponse201No2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse201"",
          ]
        `);
      });

      it('settles a list operation’s items and its envelope companion, and a stem derived from the path', async () => {
        const list = returning(
          'listPets',
          obj({
            object: konst('list'),
            data: { type: 'array', items: obj({ name: str }) },
            list_metadata: obj({ after: str }),
          }),
          { parameters: [{ name: 'after', in: 'query', schema: str }] },
        );
        expect(await settled(openapi, { '/pets': { get: list }, ...listDogs(named('list_pets_item')) }))
          .toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → ListPetsItem2",
            "GET /pets (listPets): none → ListPetsItem[]",
            "ListMetadata { after?: string }",
            "ListPetsItem { name?: string }",
            "ListPetsItem2 { object?: "list_pets_item", breed?: string }",
            "! [oagen] Renamed inline model "ListPetsItem" → "ListPetsItem2": its shape differs from operation GET /pets's own "ListPetsItem"",
          ]
        `);
        // The companion is `ListPetsListMetadata` to its operation, whether or not it ends
        // up sharing the bare `ListMetadata` with every other envelope of its shape: the
        // document's name leaves it either way, so it never depends on the other lists.
        expect(await settled(openapi, { '/pets': { get: list }, ...listDogs(named('list_pets_list_metadata')) }))
          .toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → ListPetsListMetadata2",
            "GET /pets (listPets): none → ListPetsItem[]",
            "ListMetadata { after?: string }",
            "ListPetsItem { name?: string }",
            "ListPetsListMetadata2 { object?: "list_pets_list_metadata", breed?: string }",
            "! [oagen] Renamed inline model "ListPetsListMetadata" → "ListPetsListMetadata2": its shape differs from operation GET /pets's own "ListPetsListMetadata"",
          ]
        `);
        // No `operationId` on either side: `PetsGetResponse` is minted from the path.
        expect(
          await settled(openapi, {
            '/pets': { get: returning(undefined, obj({ name: str })) },
            '/dogs': { get: returning(undefined, named('pets_get_response')) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (list): none → PetsGetResponse2",
            "GET /pets (list): none → PetsGetResponse",
            "PetsGetResponse { name?: string }",
            "PetsGetResponse2 { object?: "pets_get_response", breed?: string }",
            "! [oagen] Renamed inline model "PetsGetResponse" → "PetsGetResponse2": its shape differs from operation GET /pets's own "PetsGetResponse"",
          ]
        `);
      });

      it('settles every way the document names a body: a wrapped resource, an `allOf` merge, a later status code', async () => {
        const expected = [
          'GetPetResponse { name?: string }',
          'GetPetResponse2 { object?: "get_pet_response", breed?: string }',
          `! ${note('GetPetResponse', 'GetPetResponse2', 'GET /pets/{petId}')}`,
        ];
        const models = (lines: string[]) => lines.filter((line) => !/^(GET|POST) /.test(line));
        // `{ dog: { object, breed } }`: the one resource the body wraps.
        expect(
          models(await settled(openapi, { ...getPet(), ...listDogs(obj({ dog: named() }, { required: ['dog'] })) })),
        ).toEqual(expected);
        // `allOf` merged into one model.
        expect(
          models(
            await settled(openapi, {
              ...getPet(),
              ...listDogs({ allOf: [obj({ object: konst('get_pet_response') }), obj({ breed: str })] }),
            }),
          ),
        ).toEqual(expected);
        // The 201 of an operation whose 200 is its own `CreateDogResponse`.
        expect(
          await settled(openapi, {
            ...getPet(),
            '/dogs': {
              post: { operationId: 'createDog', responses: { ...ok(obj({ id: str })), ...ok(named(), '201') } },
            },
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreateDogResponse { id?: string }",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { object?: "get_pet_response", breed?: string }",
            "POST /dogs (createDog): none → CreateDogResponse, 201 → GetPetResponse2",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
      });

      it('settles a variant the document titles, wherever a body holds it: a field, a request body’s field, array items', async () => {
        expect(await settled(openapi, { ...getPet(), ...listDogs(obj({ shape: titled() })) })).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → ListDogsResponse",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { kind?: "a", breed?: string }",
            "ListDogsResponse { shape?: GetPetResponse2 | Other }",
            "Other { kind?: "b", x?: integer }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
        // The union itself as the response.
        expect(await settled(openapi, { ...getPet(), ...listDogs(titled()) })).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse2 | Other",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { kind?: "a", breed?: string }",
            "Other { kind?: "b", x?: integer }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
        expect(
          await settled(openapi, { ...getPet(), '/dogs': { post: taking('createDog', obj({ shape: titled() })) } }),
        ).toMatchInlineSnapshot(`
          [
            "CreateDogRequest { shape?: GetPetResponse2 | Other }",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { kind?: "a", breed?: string }",
            "Other { kind?: "b", x?: integer }",
            "POST /dogs (createDog): CreateDogRequest → unknown",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
        // Inside array items, which the registry settles as the operation is read: the
        // variant was `ListDogsItemGetPetResponse` after `getPet` and the merge's before it.
        expect(await settled(openapi, { ...getPet(), ...listDogs({ type: 'array', items: obj({ shape: titled() }) }) }))
          .toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → ListDogsItem[]",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { kind?: "a", breed?: string }",
            "ListDogsItem { shape?: GetPetResponse2 | Other }",
            "Other { kind?: "b", x?: integer }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
      });

      it('shares the name while the document’s model is the operation’s very model, and parts them on any difference of shape', async () => {
        /** `getPet` returning `{ id, owner }`: the nested `owner` is `GetPetResponseOwner`, minted from the stem. */
        const nesting = (owner: Schema) => getPet(obj({ id: str, owner }));
        const owner = (fields: Record<string, Schema> = { breed: str }, extra: Schema = {}) =>
          named('get_pet_response_owner', fields, extra);
        const shared = [
          'GET /dogs (listDogs): none → GetPetResponseOwner',
          'GET /pets/{petId} (getPet): none → GetPetResponse',
          'GetPetResponse { id?: string, owner?: GetPetResponseOwner }',
          'GetPetResponseOwner { object?: "get_pet_response_owner", breed?: string }',
        ];
        // The same object on both sides is one model, as before, and so is one that differs
        // in its documentation alone.
        expect(await settled(openapi, { ...nesting(owner()), ...listDogs(owner()) })).toEqual(shared);
        expect(
          await settled(openapi, {
            ...nesting(owner({ breed: str }, { description: 'One.' })),
            ...listDogs(owner({ breed: { type: 'string', description: 'A breed.' } }, { description: 'Two.' })),
          }),
        ).toEqual(shared);
        // A variant titled `GetPetResponseOwner` that repeats the `owner` `getPet` nests.
        expect(
          await settled(openapi, {
            ...nesting(obj({ kind: konst('a'), breed: str })),
            ...listDogs(obj({ shape: titled('GetPetResponseOwner') })),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → ListDogsResponse",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { id?: string, owner?: GetPetResponseOwner }",
            "GetPetResponseOwner { kind?: "a", breed?: string }",
            "ListDogsResponse { shape?: GetPetResponseOwner | Other }",
            "Other { kind?: "b", x?: integer }",
          ]
        `);
        // A request body that pins the const the response does.
        expect(
          await settled(openapi, {
            '/pets': { post: taking('createPet', named('create_pet_request')) },
            ...listDogs(named('create_pet_request')),
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetRequest { object?: "create_pet_request", breed?: string }",
            "GET /dogs (listDogs): none → CreatePetRequest",
            "POST /pets (createPet): CreatePetRequest → unknown",
          ]
        `);
        // Requiredness, a field's type and a limit are each another shape: the merge folded
        // the first silently and kept the first definition of the other two.
        for (const [differing, kept] of [
          [owner({ breed: str }, { required: ['breed'] }), 'breed: string'],
          [owner({ breed: int }), 'breed?: integer'],
          [owner({ breed: { type: 'string', minLength: 2 } }), 'breed?: string'],
        ] as const) {
          expect(await settled(openapi, { ...nesting(differing), ...listDogs(owner()) })).toEqual([
            'GET /dogs (listDogs): none → GetPetResponseOwner2',
            'GET /pets/{petId} (getPet): none → GetPetResponse',
            'GetPetResponse { id?: string, owner?: GetPetResponseOwner }',
            `GetPetResponseOwner { object?: "get_pet_response_owner", ${kept} }`,
            'GetPetResponseOwner2 { object?: "get_pet_response_owner", breed?: string }',
            `! ${note('GetPetResponseOwner', 'GetPetResponseOwner2', 'GET /pets/{petId}')}`,
          ]);
        }
      });

      it('leaves the model’s own `deprecated` to the merge passes, which keep the live definition of one shape', async () => {
        const nesting = (owner: Schema) => getPet(obj({ id: str, owner }));
        const owner = (extra: Schema = {}, fields: Record<string, Schema> = { breed: str }) =>
          named('get_pet_response_owner', fields, extra);
        const folded = [
          'GET /dogs (listDogs): none → GetPetResponseOwner',
          'GET /pets/{petId} (getPet): none → GetPetResponse',
          'GetPetResponse { id?: string, owner?: GetPetResponseOwner }',
          'GetPetResponseOwner { object?: "get_pet_response_owner", breed?: string }',
          '! [oagen] Warning: Inline model "GetPetResponseOwner" is declared both deprecated and live with the same shape — keeping the live definition under the shared name',
        ];
        expect(await settled(openapi, { ...nesting(owner()), ...listDogs(owner({ deprecated: true })) })).toEqual(
          folded,
        );
        expect(await settled(openapi, { ...nesting(owner({ deprecated: true })), ...listDogs(owner()) })).toEqual(
          folded,
        );
        // Of another shape, the deprecated copy leaves the name as a live one does.
        expect(await settled(openapi, { ...nesting(owner()), ...listDogs(owner({ deprecated: true }, { meow: str })) }))
          .toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponseOwner2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { id?: string, owner?: GetPetResponseOwner }",
            "GetPetResponseOwner { object?: "get_pet_response_owner", breed?: string }",
            "GetPetResponseOwner2 (deprecated) { object?: "get_pet_response_owner", meow?: string }",
            "! [oagen] Renamed inline model "GetPetResponseOwner" → "GetPetResponseOwner2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponseOwner"",
          ]
        `);
      });

      it('moves the document’s name as one: every operation that returns it keeps sharing it', async () => {
        // `listDogs` and `listCats` return one `get_pet_response` resource: one model, as
        // before, beside `getPet`'s own.
        expect(await settled(openapi, { ...getPet(), ...listDogs(), '/cats': { get: returning('listCats', named()) } }))
          .toMatchInlineSnapshot(`
          [
            "GET /cats (listCats): none → GetPetResponse2",
            "GET /dogs (listDogs): none → GetPetResponse2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { object?: "get_pet_response", breed?: string }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse" (shared by 2 operations)",
          ]
        `);
        // One returns the minting operation's very model and the other does not: only the
        // other leaves.
        const owner = (fields: Record<string, Schema> = { breed: str }) => named('get_pet_response_owner', fields);
        expect(
          await settled(openapi, {
            ...getPet(obj({ id: str, owner: owner() })),
            ...listDogs(owner()),
            '/cats': { get: returning('listCats', owner({ meow: str })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /cats (listCats): none → GetPetResponseOwner2",
            "GET /dogs (listDogs): none → GetPetResponseOwner",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { id?: string, owner?: GetPetResponseOwner }",
            "GetPetResponseOwner { object?: "get_pet_response_owner", breed?: string }",
            "GetPetResponseOwner2 { object?: "get_pet_response_owner", meow?: string }",
            "! [oagen] Renamed inline model "GetPetResponseOwner" → "GetPetResponseOwner2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponseOwner"",
          ]
        `);
        // Two paths that `$ref` one Path Item read one Operation Object and give up the same name.
        if (openapi.startsWith('3.1')) {
          expect(
            await settled(
              openapi,
              {
                ...getPet(),
                '/dogs': { $ref: '#/components/pathItems/Dogs' },
                '/hounds': { $ref: '#/components/pathItems/Dogs' },
              },
              { components: { pathItems: { Dogs: { get: returning('listDogs', named()) } } } },
            ),
          ).toMatchInlineSnapshot(`
            [
              "GET /dogs (listDogs): none → GetPetResponse2",
              "GET /hounds (listDogs): none → GetPetResponse2",
              "GET /pets/{petId} (getPet): none → GetPetResponse",
              "GetPetResponse { name?: string }",
              "GetPetResponse2 { object?: "get_pet_response", breed?: string }",
              "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
            ]
          `);
        }
      });

      it('reads every definition an operation holds under the name: one copy that is the minting operation’s does not stand for another', async () => {
        // Greptile, #724: `createDog` returns a variant titled `GetPetResponseOwner` that is
        // `getPet`'s very `owner` and takes one of that title with other fields. Only the
        // first was compared, so nothing left the name and the merge kept the larger
        // request shape for `getPet`'s `owner` too. An operation's bodies are named as one:
        // both of its copies leave, and are settled between themselves as before.
        const keeper = getPet(obj({ id: str, owner: obj({ kind: konst('a'), name: str }) }));
        const createDog = (request: Schema, response: Schema) => ({
          '/dogs': { post: { operationId: 'createDog', requestBody: json(request), responses: ok(response) } },
        });
        const same = obj({ shape: titled('GetPetResponseOwner', { name: str }) });
        const other = obj({ shape: titled('GetPetResponseOwner', { breed: str, age: int }) });
        for (const [request, response, counts] of [
          [other, same, '3 vs 2'],
          [same, other, '2 vs 3'],
        ] as const) {
          expect(await settled(openapi, { ...keeper, ...createDog(request, response) })).toEqual([
            'CreateDogRequest { shape?: GetPetResponseOwner2 | Other }',
            'CreateDogResponse { shape?: GetPetResponseOwner2 | Other }',
            'GET /pets/{petId} (getPet): none → GetPetResponse',
            'GetPetResponse { id?: string, owner?: GetPetResponseOwner }',
            'GetPetResponseOwner { kind?: "a", name?: string }',
            'GetPetResponseOwner2 { kind?: "a", breed?: string, age?: integer }',
            'Other { kind?: "b", x?: integer }',
            'POST /dogs (createDog): CreateDogRequest → CreateDogResponse',
            `! ${note('GetPetResponseOwner', 'GetPetResponseOwner2', 'GET /pets/{petId}')}`,
            `! [oagen] Warning: Inline model "GetPetResponseOwner2" has more than one definition with different fields or field types (${counts}) — keeping the one with more fields`,
          ]);
        }
        // Both copies the minting operation's very model: one `GetPetResponseOwner`, as before.
        expect(await settled(openapi, { ...keeper, ...createDog(same, same) })).toEqual([
          'CreateDogRequest { shape?: GetPetResponseOwner | Other }',
          'CreateDogResponse { shape?: GetPetResponseOwner | Other }',
          'GET /pets/{petId} (getPet): none → GetPetResponse',
          'GetPetResponse { id?: string, owner?: GetPetResponseOwner }',
          'GetPetResponseOwner { kind?: "a", name?: string }',
          'Other { kind?: "b", x?: integer }',
          'POST /dogs (createDog): CreateDogRequest → CreateDogResponse',
        ]);
        // The same of an inline enum the two copies carry: the request's members differ.
        const status = (...values: string[]): Schema => ({ type: 'string', enum: values });
        const lines = await settled(openapi, {
          ...getPet(obj({ id: str, owner: obj({ kind: konst('a'), status: status('x', 'y') }) })),
          ...createDog(
            obj({ shape: titled('GetPetResponseOwner', { status: status('p', 'q') }) }),
            obj({ shape: titled('GetPetResponseOwner', { status: status('x', 'y') }) }),
          ),
        });
        expect(lines).toContain('GetPetResponseOwner { kind?: "a", status?: GetPetResponseOwnerStatus }');
        expect(lines).toContain('enum GetPetResponseOwnerStatus [x, y]');
        expect(lines).toContain('CreateDogRequest { shape?: GetPetResponseOwner2 | Other }');
        expect(lines).toContain('CreateDogResponse { shape?: GetPetResponseOwner2 | Other }');
        expect(lines).toContain(
          `! ${note('GetPetResponseOwnerStatus', 'GetPetResponseOwnerStatus2', 'GET /pets/{petId}', '', 'enum')}`,
        );
      });

      it('decides a name after the names its model references: a parent follows its child, and keeps a child that is the operation’s own', async () => {
        // Both nest an `owner`, of two shapes: the child leaves, and so does the parent.
        expect(
          await settled(openapi, {
            ...getPet(obj({ name: str, owner: obj({ name: str }) })),
            ...listDogs(named('get_pet_response', { breed: str, owner: obj({ id: int }) })),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string, owner?: GetPetResponseOwner }",
            "GetPetResponse2 { object?: "get_pet_response", breed?: string, owner?: GetPetResponseOwner2 }",
            "GetPetResponseOwner { name?: string }",
            "GetPetResponseOwner2 { id?: integer }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
            "! [oagen] Renamed inline model "GetPetResponseOwner" → "GetPetResponseOwner2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponseOwner"",
          ]
        `);
        // The same `owner` on both sides is one model; the parents still differ.
        expect(
          await settled(openapi, {
            ...getPet(obj({ name: str, owner: obj({ id: int }) })),
            ...listDogs(named('get_pet_response', { breed: str, owner: obj({ id: int }) })),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string, owner?: GetPetResponseOwner }",
            "GetPetResponse2 { object?: "get_pet_response", breed?: string, owner?: GetPetResponseOwner }",
            "GetPetResponseOwner { id?: integer }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
        // A model nested under the document's name that `getPet` does not mint keeps its
        // name: only what an operation mints is given up to it.
        expect(
          await settled(openapi, {
            ...getPet(),
            ...listDogs(named('get_pet_response', { breed: str, owner: obj({ id: int }) })),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { object?: "get_pet_response", breed?: string, owner?: GetPetResponseOwner }",
            "GetPetResponseOwner { id?: integer }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
        // The parents read alike — one `owner` field each — until the child has left its
        // name: the parent then references `GetPetResponsePetOwner2` and leaves too.
        expect(
          await settled(openapi, {
            ...getPet(obj({ id: str, pet: obj({ object: konst('get_pet_response_pet'), owner: obj({ id: int }) }) })),
            ...listDogs(named('get_pet_response_pet', { owner: obj({ id: str }) })),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponsePet2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { id?: string, pet?: GetPetResponsePet }",
            "GetPetResponsePet { object?: "get_pet_response_pet", owner?: GetPetResponsePetOwner }",
            "GetPetResponsePet2 { object?: "get_pet_response_pet", owner?: GetPetResponsePetOwner2 }",
            "GetPetResponsePetOwner { id?: integer }",
            "GetPetResponsePetOwner2 { id?: string }",
            "! [oagen] Renamed inline model "GetPetResponsePet" → "GetPetResponsePet2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponsePet"",
            "! [oagen] Renamed inline model "GetPetResponsePetOwner" → "GetPetResponsePetOwner2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponsePetOwner"",
          ]
        `);
      });

      it('settles an inline enum as it settles a model: enum beside enum, and enum beside model either way', async () => {
        const status = (...values: string[]): Schema => ({ type: 'string', enum: values });
        // The enum the document's model carries is named under it, and so is the enum of
        // `getPet`'s own: the merge dropped `getPet`'s members with its model.
        expect(
          await settled(openapi, {
            ...getPet(obj({ status: status('a', 'b') })),
            ...listDogs(named('get_pet_response', { status: status('c', 'd') })),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { status?: GetPetResponseStatus }",
            "GetPetResponse2 { object?: "get_pet_response", status?: GetPetResponseStatus2 }",
            "enum GetPetResponseStatus [a, b]",
            "enum GetPetResponseStatus2 [c, d]",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
            "! [oagen] Renamed inline enum "GetPetResponseStatus" → "GetPetResponseStatus2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponseStatus"",
          ]
        `);
        // The same members in the same order are one enum; in another order they are two,
        // as a model's shape reads them, so the order of the members never follows the paths'.
        expect(
          await settled(openapi, {
            ...getPet(obj({ status: status('a', 'b') })),
            ...listDogs(named('get_pet_response', { status: status('a', 'b') })),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { status?: GetPetResponseStatus }",
            "GetPetResponse2 { object?: "get_pet_response", status?: GetPetResponseStatus }",
            "enum GetPetResponseStatus [a, b]",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
        expect(
          (
            await settled(openapi, {
              ...getPet(obj({ status: status('a', 'b') })),
              ...listDogs(named('get_pet_response', { status: status('b', 'a') })),
            })
          ).filter((line) => line.startsWith('enum')),
        ).toEqual(['enum GetPetResponseStatus [a, b]', 'enum GetPetResponseStatus2 [b, a]']);
        // An enum the document names like `getPet`'s own response: a variant titled `GetPet`
        // with a `response` enum. The model stepped to `GetPetResponse2` for the enum.
        expect(
          await settled(openapi, {
            ...getPet(),
            ...listDogs(obj({ shape: titled('GetPet', { response: status('c', 'd') }) })),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → ListDogsResponse",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPet { kind?: "a", response?: GetPetResponse2 }",
            "GetPetResponse { name?: string }",
            "ListDogsResponse { shape?: GetPet | Other }",
            "Other { kind?: "b", x?: integer }",
            "enum GetPetResponse2 [c, d]",
            "! [oagen] Renamed inline enum "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
        // A model the document names like an enum `getPet` mints for its `owner`.
        expect(
          await settled(openapi, {
            ...getPet(obj({ owner: status('a', 'b') })),
            ...listDogs(named('get_pet_response_owner')),
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponseOwner2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { owner?: GetPetResponseOwner }",
            "GetPetResponseOwner2 { object?: "get_pet_response_owner", breed?: string }",
            "enum GetPetResponseOwner [a, b]",
            "! [oagen] Renamed inline model "GetPetResponseOwner" → "GetPetResponseOwner2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponseOwner"",
          ]
        `);
      });

      it('numbers the document’s name past every name in play, and after the stems that give the name up', async () => {
        // `GetPetResponse2` is another operation's, from its own const.
        expect(
          await settled(openapi, {
            ...getPet(),
            ...listDogs(),
            '/cats': { get: returning('listCats', named('get_pet_response2', { meow: str })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /cats (listCats): none → GetPetResponse2",
            "GET /dogs (listDogs): none → GetPetResponse3",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { object?: "get_pet_response2", meow?: string }",
            "GetPetResponse3 { object?: "get_pet_response", breed?: string }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse3": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
        // A component's, and the model of a response header named after the operations.
        expect(
          (
            await settled(
              openapi,
              { ...getPet(), ...listDogs() },
              { components: { schemas: { GetPetResponse2: obj({ z: str }) } } },
            )
          ).filter((line) => line.startsWith('GetPetResponse')),
        ).toEqual([
          'GetPetResponse { name?: string }',
          'GetPetResponse2 { z?: string }',
          'GetPetResponse3 { object?: "get_pet_response", breed?: string }',
        ]);
        expect(
          (
            await settled(openapi, {
              ...getPet(),
              ...listDogs(),
              '/x': {
                get: {
                  operationId: 'x',
                  tags: ['GetPet'],
                  responses: {
                    '200': {
                      description: 'ok',
                      headers: { Response2: { schema: obj({ h: str }) } },
                      ...json(obj({ id: str })),
                    },
                  },
                },
              },
            })
          ).filter((line) => line.startsWith('GetPetResponse')),
        ).toEqual([
          'GetPetResponse { name?: string }',
          'GetPetResponse2 { h?: string }',
          'GetPetResponse3 { object?: "get_pet_response", breed?: string }',
        ]);
        // `createPet` gives `CreatePetResponseDraftResponse` up to `createPetResponseDraft`
        // (#683) and takes `…2`; what the document names so takes the next number.
        expect(
          await settled(openapi, {
            '/pets': { post: returning('createPet', obj({ id: str, draft_response: obj({ draftId: str }) })) },
            '/pet-drafts': { post: returning('createPetResponseDraft', obj({ draftNumber: int })) },
            ...listDogs(named('create_pet_response_draft_response')),
          }),
        ).toMatchInlineSnapshot(`
          [
            "CreatePetResponse { id?: string, draft_response?: CreatePetResponseDraftResponse2 }",
            "CreatePetResponseDraftResponse { draftNumber?: integer }",
            "CreatePetResponseDraftResponse2 { draftId?: string }",
            "CreatePetResponseDraftResponse3 { object?: "create_pet_response_draft_response", breed?: string }",
            "GET /dogs (listDogs): none → CreatePetResponseDraftResponse3",
            "POST /pet-drafts (createPetResponseDraft): none → CreatePetResponseDraftResponse",
            "POST /pets (createPet): none → CreatePetResponse",
            "! [oagen] Renamed inline model "CreatePetResponseDraftResponse" → "CreatePetResponseDraftResponse3": its shape differs from operation POST /pet-drafts's own "CreatePetResponseDraftResponse"",
          ]
        `);
      });

      it('settles the name whatever the two stems are: one containing the other, and each naming the other’s', async () => {
        // `pet`'s stem is part of `GetPet`, and of the name: it is still the document's name.
        expect(await settled(openapi, { ...getPet(), '/pet': { get: returning('pet', named()) } }))
          .toMatchInlineSnapshot(`
          [
            "GET /pet (pet): none → GetPetResponse2",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { object?: "get_pet_response", breed?: string }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
          ]
        `);
        // Each returns an object pinned to the other's response name: neither mints the
        // name it is given, so the two simply hold each other's.
        expect(await settled(openapi, { ...getPet(named('list_dogs_response', { name: str })), ...listDogs() }))
          .toMatchInlineSnapshot(`
          [
            "GET /dogs (listDogs): none → GetPetResponse",
            "GET /pets/{petId} (getPet): none → ListDogsResponse",
            "GetPetResponse { object?: "get_pet_response", breed?: string }",
            "ListDogsResponse { object?: "list_dogs_response", name?: string }",
          ]
        `);
        // Beside two operations that do mint them, both leave.
        expect(
          await settled(openapi, {
            ...getPet(),
            ...listDogs(obj({ id: str })),
            '/a': { get: returning('a', named('list_dogs_response', { p: str })) },
            '/b': { get: returning('b', named('get_pet_response', { q: str })) },
          }),
        ).toMatchInlineSnapshot(`
          [
            "GET /a (a): none → ListDogsResponse2",
            "GET /b (b): none → GetPetResponse2",
            "GET /dogs (listDogs): none → ListDogsResponse",
            "GET /pets/{petId} (getPet): none → GetPetResponse",
            "GetPetResponse { name?: string }",
            "GetPetResponse2 { object?: "get_pet_response", q?: string }",
            "ListDogsResponse { id?: string }",
            "ListDogsResponse2 { object?: "list_dogs_response", p?: string }",
            "! [oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}'s own "GetPetResponse"",
            "! [oagen] Renamed inline model "ListDogsResponse" → "ListDogsResponse2": its shape differs from operation GET /dogs's own "ListDogsResponse"",
          ]
        `);
      });

      it('leaves two bodies the document names alike to the merge, as before: no operation mints the name', async () => {
        // Two operations pinning one const to two shapes: the name is no operation's own,
        // and the merge keeps the larger definition for both with its warning.
        const spec = await parse(
          document(openapi, {
            ...listDogs(),
            '/cats': { get: returning('listCats', named('get_pet_response', { whiskers: int, tail: int })) },
          }),
        );
        expect(summary(spec)).toEqual([
          'GET /cats (listCats): none → GetPetResponse',
          'GET /dogs (listDogs): none → GetPetResponse',
          'GetPetResponse { object?: "get_pet_response", whiskers?: integer, tail?: integer }',
        ]);
        expect(warnings()).toEqual([
          '[oagen] Warning: Inline model "GetPetResponse" has more than one definition with different fields or field types (3 vs 2) — keeping the one with more fields',
        ]);
        // Beside `getPet`'s own, the two leave for one name and are settled there the same way.
        warn.mockClear();
        const beside = await parse(
          document(openapi, {
            ...getPet(),
            ...listDogs(),
            '/cats': { get: returning('listCats', named('get_pet_response', { whiskers: int, tail: int })) },
          }),
        );
        expect(summary(beside)).toEqual([
          'GET /cats (listCats): none → GetPetResponse2',
          'GET /dogs (listDogs): none → GetPetResponse2',
          'GET /pets/{petId} (getPet): none → GetPetResponse',
          'GetPetResponse { name?: string }',
          'GetPetResponse2 { object?: "get_pet_response", whiskers?: integer, tail?: integer }',
        ]);
        expect(warnings()).toEqual([
          note('GetPetResponse', 'GetPetResponse2', 'GET /pets/{petId}', ' (shared by 2 operations)'),
          '[oagen] Warning: Inline model "GetPetResponse2" has more than one definition with different fields or field types (3 vs 2) — keeping the one with more fields',
        ]);
        // `getPet` pinning the const itself is named from the const too: its name is the
        // document's, as `listDogs`'s is.
        warn.mockClear();
        const pinned = await parse(
          document(openapi, { ...getPet(named('get_pet_response', { name: str })), ...listDogs() }),
        );
        expect(summary(pinned)).toEqual([
          'GET /dogs (listDogs): none → GetPetResponse',
          'GET /pets/{petId} (getPet): none → GetPetResponse',
          'GetPetResponse { object?: "get_pet_response", name?: string }',
        ]);
        expect(warnings()).toEqual([
          '[oagen] Warning: Inline model "GetPetResponse" has more than one definition with different fields or field types (2 vs 2) — keeping the first definition',
        ]);
      });

      it('leaves the sites that are no operation’s own body as they were: a component response, a callback, the operation itself', async () => {
        // The body of a `components/responses` entry is the component's, wherever it is
        // mounted: its names are no operation's to give up.
        const mounted = await parse(
          document(
            openapi,
            {
              ...getPet(),
              '/dogs': {
                get: { operationId: 'listDogs', responses: { '200': { $ref: '#/components/responses/Dogs' } } },
              },
            },
            { components: { responses: { Dogs: { description: 'ok', ...json(named()) } } } },
          ),
        );
        expect(summary(mounted)).toEqual([
          'GET /dogs (listDogs): none → GetPetResponse',
          'GET /pets/{petId} (getPet): none → GetPetResponse',
          'GetPetResponse { object?: "get_pet_response", breed?: string }',
        ]);
        expect(warnings()).toEqual([
          '[oagen] Warning: Inline model "GetPetResponse" has more than one definition with different fields or field types (2 vs 1) — keeping the one with more fields',
        ]);
        // A callback's payload is read after the operations.
        warn.mockClear();
        const callback = await parse(
          document(openapi, {
            ...getPet(),
            '/dogs': {
              post: {
                operationId: 'createDog',
                responses: { '204': { description: 'ok' } },
                callbacks: {
                  onDog: {
                    '{$request.body#/url}': {
                      post: { requestBody: json(titled()), responses: { '200': { description: 'ok' } } },
                    },
                  },
                },
              },
            },
          }),
        );
        expect(summary(callback).filter((line) => !/^(GET|POST) /.test(line))).toEqual([
          'GetPetResponse { kind?: "a", breed?: string }',
          'Other { kind?: "b", x?: integer }',
        ]);
        expect(warnings()).toEqual([
          '[oagen] Warning: Inline model "GetPetResponse" has more than one definition with different fields or field types (2 vs 1) — keeping the one with more fields',
        ]);
        // A variant the operation's own body titles like the body: one operation, one reading.
        warn.mockClear();
        const own = await parse(document(openapi, getPet(obj({ name: str, shape: titled() }))));
        expect(summary(own)).toEqual([
          'GET /pets/{petId} (getPet): none → GetPetResponse',
          'GetPetResponse { name?: string, shape?: GetPetResponse | Other }',
          'Other { kind?: "b", x?: integer }',
        ]);
        expect(warnings()).toEqual([
          '[oagen] Warning: Inline model "GetPetResponse" from the 200 response has different fields than the 200 response\'s — using the 200 response\'s',
        ]);
      });

      it('steps the models named after the operations past the body’s name, as before: an error body, a default body, a parameter, a header', async () => {
        const dogs = (operation: Record<string, unknown>) => ({
          '/dogs': { get: { operationId: 'listDogs', ...operation } },
        });
        const none = { '200': { description: 'ok' } };
        for (const [operation, model] of [
          [
            { responses: { ...none, '404': { description: 'no', ...json(named()) } } },
            'GetPetResponseObjectOptionalErrorBodyWithBreedWithoutMessage',
          ],
          [
            { responses: { ...none, default: { description: 'no', ...json(titled()) } } },
            'GetPetResponseListDogsDefaultResponse',
          ],
          [{ parameters: [{ name: 'f', in: 'query', schema: titled() }], responses: none }, 'GetPetResponseDogsF'],
          [
            { responses: { '200': { description: 'ok', headers: { 'X-Meta': { schema: titled() } } } } },
            'GetPetResponseDogsXMeta',
          ],
        ] as const) {
          const lines = await settled(openapi, { ...getPet(), ...dogs(operation) });
          expect(lines).toContain('GetPetResponse { name?: string }');
          expect(lines.some((line) => line.startsWith(`${model} {`))).toBe(true);
          expect(lines.filter((line) => line.startsWith('!'))).toEqual([]);
        }
      });
    });
  }

  it('leaves a webhook’s payload as it was: read after the operations, its titled variant meets the merge', async () => {
    const spec = await parse(
      document('3.1.0', getPet(), {
        webhooks: {
          dogCreated: {
            post: {
              operationId: 'dogCreated',
              requestBody: json(titled()),
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      }),
    );
    expect(summary(spec)).toEqual([
      'GET /pets/{petId} (getPet): none → GetPetResponse',
      'GetPetResponse { kind?: "a", breed?: string }',
      'Other { kind?: "b", x?: integer }',
      'webhook dogCreated: GetPetResponse | Other',
    ]);
    expect(warnings()).toEqual([
      '[oagen] Warning: Inline model "GetPetResponse" has more than one definition with different fields or field types (2 vs 1) — keeping the one with more fields',
    ]);
  });

  describe('resolveContestedBodyNames', () => {
    const model = (name: string, fields: Record<string, TypeRef>): Model => ({
      name,
      fields: Object.entries(fields).map(([field, type]) => ({ name: field, type, required: false })),
    });
    const string: TypeRef = { kind: 'primitive', type: 'string' };
    const ref = (name: string): TypeRef => ({ kind: 'model', name });
    /** An operation's reading: what it mints from its stem, what the document names in it, and the models behind both. */
    const body = (
      key: string,
      stem: string,
      minted: string[],
      documentNames: string[],
      models: Model[],
      enums: { minted?: string[]; documentNames?: string[] } = {},
    ): OperationBodyNames => ({
      key,
      stem,
      models: minted,
      enums: enums.minted ?? [],
      documentNames: { models: documentNames, enums: enums.documentNames ?? [] },
      definitions: { roots: models.slice(0, 1).map((first) => ref(first.name)), models },
    });
    const settle = (bodies: OperationBodyNames[], taken: string[] = []) =>
      Object.fromEntries([...resolveContestedBodyNames(bodies, () => taken)].map(([key, given]) => [key, [...given]]));
    const getPetBody = () =>
      body('get /pets/{petId}', 'GetPet', ['GetPetResponse'], [], [model('GetPetResponse', { name: string })]);
    const listDogsBody = (fields: Record<string, TypeRef> = { breed: string }, key = 'get /dogs', stem = 'ListDogs') =>
      body(key, stem, [], ['GetPetResponse'], [model('GetPetResponse', fields)]);

    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('gives the document’s name up to the operation that mints it, whatever the order of the bodies', () => {
      const expected = { 'get /dogs': [['GetPetResponse', 'GetPetResponse2']] };
      expect(settle([getPetBody(), listDogsBody()])).toEqual(expected);
      expect(settle([listDogsBody(), getPetBody()])).toEqual(expected);
      expect(warn.mock.calls.map((call: unknown[]) => call[0])).toEqual([
        '[oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}\'s own "GetPetResponse"',
        '[oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from operation GET /pets/{petId}\'s own "GetPetResponse"',
      ]);
    });

    it('gives nothing up for the operation’s very model, nor without an operation that mints the name', () => {
      expect(settle([getPetBody(), listDogsBody({ name: string })])).toEqual({});
      expect(settle([listDogsBody(), listDogsBody({ meow: string }, 'get /cats', 'ListCats')])).toEqual({});
      expect(warn).not.toHaveBeenCalled();
    });

    it('moves the name as one for every operation that holds another shape under it, past every name in play', () => {
      expect(
        settle(
          [
            getPetBody(),
            listDogsBody(),
            listDogsBody({ meow: string }, 'get /cats', 'ListCats'),
            listDogsBody({ name: string }, 'get /birds', 'ListBirds'),
          ],
          ['GetPetResponse2'],
        ),
      ).toEqual({
        'get /dogs': [['GetPetResponse', 'GetPetResponse3']],
        'get /cats': [['GetPetResponse', 'GetPetResponse3']],
      });
      expect(warn.mock.calls.map((call: unknown[]) => call[0])).toEqual([
        '[oagen] Renamed inline model "GetPetResponse" → "GetPetResponse3": its shape differs from operation GET /pets/{petId}\'s own "GetPetResponse" (shared by 2 operations)',
      ]);
    });

    it('reads the names in play only when a name is given up, and sets the document’s name aside under no stem without them', () => {
      const taken = vi.fn(() => []);
      expect([...resolveContestedBodyNames([getPetBody(), listDogsBody({ name: string })], taken)]).toEqual([]);
      expect(taken).not.toHaveBeenCalled();
      expect(
        Object.fromEntries(
          [...resolveContestedBodyNames([getPetBody(), listDogsBody()])].map(([key, given]) => [key, [...given]]),
        ),
      ).toEqual({ 'get /dogs': [['GetPetResponse', 'GetPetResponse#']] });
      // Nothing is announced by the reading that only learns the names.
      expect(warn).not.toHaveBeenCalled();
    });

    it('compares a model as it ends: a parent follows the child that left, in the keeper’s body and in its own', () => {
      // `listDogs`'s `Parent` reads as `getPet`'s until its `Child` has left the name.
      const keeper = body(
        'get /pets',
        'GetPet',
        ['GetPetParent', 'GetPetParentChild'],
        [],
        [model('GetPetParent', { child: ref('GetPetParentChild') }), model('GetPetParentChild', { a: string })],
      );
      const holder = (child: Record<string, TypeRef>) =>
        body(
          'get /dogs',
          'ListDogs',
          [],
          ['GetPetParent', 'GetPetParentChild'],
          [model('GetPetParent', { child: ref('GetPetParentChild') }), model('GetPetParentChild', child)],
        );
      expect(settle([keeper, holder({ b: string })])).toEqual({
        'get /dogs': [
          ['GetPetParent', 'GetPetParent2'],
          ['GetPetParentChild', 'GetPetParentChild2'],
        ],
      });
      expect(settle([keeper, holder({ a: string })])).toEqual({});
      // The keeper's own child has left for another stem's (`GetPetParent` contains
      // `GetPet`): the document's parent, identical field for field, no longer is.
      const outer = body(
        'get /x',
        'GetPetParent',
        ['GetPetParentChild'],
        [],
        [model('GetPetParentChild', { z: string })],
      );
      expect(settle([keeper, outer, holder({ z: string })])).toEqual({
        'get /pets': [['GetPetParentChild', 'GetPetParentChild2']],
        'get /dogs': [['GetPetParent', 'GetPetParent2']],
      });
    });

    it('settles an inline enum by its members, and a model and an enum of one name as two', () => {
      const status = (...values: string[]): TypeRef => ({ kind: 'enum', name: 'GetPetStatus', values });
      const keeper = (type: TypeRef) =>
        body('get /pets', 'GetPet', ['GetPetResponse'], [], [model('GetPetResponse', { status: type })], {
          minted: ['GetPetStatus'],
        });
      const holder = (type: TypeRef) =>
        body('get /dogs', 'ListDogs', ['ListDogsResponse'], [], [model('ListDogsResponse', { status: type })], {
          documentNames: ['GetPetStatus'],
        });
      expect(settle([keeper(status('a', 'b')), holder(status('a', 'b'))])).toEqual({});
      expect(settle([keeper(status('a', 'b')), holder(status('a', 'c'))])).toEqual({
        'get /dogs': [['GetPetStatus', 'GetPetStatus2']],
      });
      expect(warn.mock.calls.map((call: unknown[]) => call[0])).toEqual([
        '[oagen] Renamed inline enum "GetPetStatus" → "GetPetStatus2": its shape differs from operation GET /pets\'s own "GetPetStatus"',
      ]);
      // A model the document names like the enum.
      const modelHolder = body('get /dogs', 'ListDogs', [], ['GetPetStatus'], [model('GetPetStatus', { a: string })]);
      expect(settle([keeper(status('a', 'b')), modelHolder])).toEqual({
        'get /dogs': [['GetPetStatus', 'GetPetStatus2']],
      });
    });

    it('reads every definition a body holds under the name, on either side', () => {
      // The holder's first copy is the keeper's very model; its second is not.
      const holder = (first: Record<string, TypeRef>, second: Record<string, TypeRef>) =>
        body(
          'post /dogs',
          'CreateDog',
          [],
          ['GetPetResponse'],
          [model('GetPetResponse', first), model('GetPetResponse', second)],
        );
      const expected = { 'post /dogs': [['GetPetResponse', 'GetPetResponse2']] };
      expect(settle([getPetBody(), holder({ name: string }, { breed: string })])).toEqual(expected);
      expect(settle([getPetBody(), holder({ breed: string }, { name: string })])).toEqual(expected);
      expect(settle([getPetBody(), holder({ name: string }, { name: string })])).toEqual({});
      // A keeper that holds two shapes under the name has no one model to be.
      const keeper = body(
        'get /pets/{petId}',
        'GetPet',
        ['GetPetResponse'],
        [],
        [model('GetPetResponse', { name: string }), model('GetPetResponse', { id: string })],
      );
      expect(settle([keeper, listDogsBody({ name: string })])).toEqual({
        'get /dogs': [['GetPetResponse', 'GetPetResponse2']],
      });
      // An inline enum of the name beside a model of it, in one body.
      const mixed = body(
        'post /dogs',
        'CreateDog',
        [],
        ['GetPetResponse'],
        [
          model('GetPetResponse', { name: string }),
          model('CreateDogRequest', { kind: { kind: 'enum', name: 'GetPetResponse', values: ['a'] } }),
        ],
        { documentNames: ['GetPetResponse'] },
      );
      expect(settle([getPetBody(), mixed])).toEqual(expected);
    });

    it('takes no part without the bodies to compare: a reading that names no definitions gives nothing up', () => {
      const keeper: OperationBodyNames = { key: 'a', stem: 'GetPet', models: ['GetPetResponse'], enums: [] };
      expect(settle([keeper, listDogsBody()])).toEqual({});
      const holder: OperationBodyNames = {
        key: 'b',
        stem: 'ListDogs',
        models: [],
        enums: [],
        documentNames: { models: ['GetPetResponse'], enums: [] },
      };
      expect(settle([getPetBody(), holder])).toEqual({});
    });
  });

  describe('namesHeldAcrossStems', () => {
    it('keeps the names more than one stem holds of which one of those stems is a part', () => {
      expect([
        ...namesHeldAcrossStems([
          { stem: 'GetPet', names: ['GetPetResponse', 'Pet', 'GetPetResponseOwner'] },
          { stem: 'ListDogs', names: ['GetPetResponse', 'Pet', 'ListDogsResponse'] },
          { stem: 'ListCats', names: ['Pet', 'ListDogsResponse'] },
        ]),
      ]).toEqual(['GetPetResponse', 'ListDogsResponse']);
      // One stem, however many operations are named from it, shares nothing with itself;
      // an empty stem is part of no name.
      expect([
        ...namesHeldAcrossStems([
          { stem: 'GetPet', names: ['GetPetResponse'] },
          { stem: 'GetPet', names: ['GetPetResponse'] },
          { stem: '', names: ['Response'] },
          { stem: 'ListDogs', names: ['Response'] },
        ]),
      ]).toEqual([]);
    });
  });
});
