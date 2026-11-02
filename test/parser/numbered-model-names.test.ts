import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { derivePathBasedName } from '../../src/parser/operations.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import { toPascalCase } from '../../src/utils/naming.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

// workos/oagen#403: #339 set an operation's number off from a name that ends
// in a digit (`listTop10No2`, never `listTop102`), but model and enum names
// still ran the number, or the hash that sets a path-derived prefix apart,
// into the digit: a numbered enum beside a component `PetSizeV2` read as
// version 22 (`PetSizeV22`), and the hash of `/pets/top10/` as part of
// `Top10` (`PetsTop10567B59GetResponse`). Every numbered model and enum name
// and every such hash is now spelled as an operation's number is
// (`numberedName`): behind `No` after a digit, bare after a letter.

type Doc = Record<string, unknown>;

const str = { type: 'string' };
const en = (values: string[]) => ({ type: 'string', enum: values });
const obj = (property: string) => ({ type: 'object', properties: { [property]: str } });
const json = (schema: Doc) => ({ description: 'ok', content: { 'application/json': { schema } } });
const id = [{ name: 'id', in: 'path', required: true, schema: str }];
const component = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Parse `doc` as the issue's repro does, with every warning the parse prints. */
async function parse(doc: Doc): Promise<{ ir: ApiSpec; warnings: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-numbered-model-names-'));
  dirs.push(dir);
  const file = path.join(dir, 'repro.json');
  await fs.writeFile(file, JSON.stringify({ openapi: '3.1.0', info: { title: 'repro', version: '1' }, ...doc }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parseSpec(file);
    return { ir, warnings: warn.mock.calls.map(([message]) => String(message)) };
  } finally {
    warn.mockRestore();
  }
}

/** `enum PetSizeV2No2`, `model Pet`, `primitive string`, `union<model A | model B>`. */
const ref = (type: TypeRef | undefined): string => {
  if (type === undefined) return 'none';
  if (type.kind === 'union') return `union<${type.variants.map(ref).join(' | ')}>`;
  return `${type.kind} ${'name' in type ? type.name : 'type' in type ? type.type : ''}`;
};

/** `Name { field: type, … }` for every model, in order. */
const models = (ir: ApiSpec): string[] =>
  ir.models.map(({ fields, name }) => `${name} { ${fields.map((f) => `${f.name}: ${ref(f.type)}`).join(', ')} }`);

const operation = (ir: ApiSpec, name: string): Operation => {
  const found = ir.services.flatMap((s) => s.operations).find((op) => op.name === name);
  expect(found, name).toBeDefined();
  return found!;
};

describe('a numbered or hashed model or enum name is set off from a trailing digit (#403)', () => {
  it("the issue's repro: `PetSizeV2No2`, `PetTagV2No2`, and a hash that cannot be read as part of `Top10`", async () => {
    const { ir, warnings } = await parse({
      paths: {
        '/pets/top10': { get: { responses: { '200': json({ type: 'object', properties: { a: str } }) } } },
        '/pets/top10/': { get: { responses: { '200': json({ type: 'object', properties: { b: str } }) } } },
        '/pets/{id}': { get: { operationId: 'getPet', parameters: id, responses: { '200': json(component('Pet')) } } },
      },
      components: {
        schemas: {
          Pet: {
            type: 'object',
            properties: {
              sizeV2: en(['s', 'm']),
              tagV2: obj('label'),
              size: component('PetSizeV2'),
              tag: component('PetTagV2'),
            },
          },
          PetSizeV2: en(['small', 'medium']),
          PetTagV2: obj('id'),
        },
      },
    });

    // The issue's print-out. Before: `PetSizeV22`, `PetTagV22` and
    // `PetsTop10567B59GetResponse`.
    expect({
      enums: ir.enums.map(({ name }) => name),
      models: ir.models.map(({ name }) => name),
      operations: ir.services
        .flatMap(({ operations }) => operations)
        .map(({ name, response }) => `${name}: ${'name' in response ? response.name : response.kind}`),
    }).toEqual({
      enums: ['PetSizeV2', 'PetSizeV2No2'],
      models: ['Pet', 'PetTagV2', 'PetsTop10GetResponse', 'PetsTop10No567B59GetResponse', 'PetTagV2No2'],
      operations: ['listTop10: PetsTop10GetResponse', 'listTop10No2: PetsTop10No567B59GetResponse', 'getPet: Pet'],
    });
    expect(warnings).toEqual([
      '[oagen] Renamed inline model "PetTagV2" → "PetTagV2No2": its shape differs from component schema "PetTagV2"',
    ]);
    // Each field still reaches its own members and fields.
    const pet = ir.models.find((m) => m.name === 'Pet');
    expect(pet?.fields.map(({ name, type }) => `${name}: ${ref(type)}`)).toEqual([
      'sizeV2: enum PetSizeV2No2',
      'tagV2: model PetTagV2No2',
      'size: enum PetSizeV2',
      'tag: model PetTagV2',
    ]);
    expect(ir.enums.find((e) => e.name === 'PetSizeV2No2')?.values.map((v) => v.value)).toEqual(['s', 'm']);
    expect(ir.models.find((m) => m.name === 'PetTagV2No2')?.fields.map((f) => f.name)).toEqual(['label']);
    expect(ir.models.find((m) => m.name === 'PetsTop10No567B59GetResponse')?.fields.map((f) => f.name)).toEqual(['b']);
  });

  it("the comment's repro: a model leaving the name of `getPet`'s 404 enum is `GetPetError404No2`, not a 4042 error", async () => {
    const { ir, warnings } = await parse({
      paths: {
        '/pets/{id}': {
          get: {
            operationId: 'getPet',
            parameters: id,
            responses: { '200': json(component('GetPet')), '404': json(en(['gone', 'missing'])) },
          },
        },
      },
      components: { schemas: { GetPet: { type: 'object', properties: { error404: obj('reason') } } } },
    });

    // Before: `GetPetError4042`.
    expect({
      enums: ir.enums.map(({ name }) => name),
      errors: operation(ir, 'getPet').errors.map(({ statusCode, type }) => `${statusCode}: ${ref(type)}`),
      models: models(ir),
    }).toEqual({
      enums: ['GetPetError404'],
      errors: ['404: enum GetPetError404'],
      models: ['GetPet { error404: model GetPetError404No2 }', 'GetPetError404No2 { reason: primitive string }'],
    });
    expect(warnings).toEqual([
      '[oagen] Renamed inline model "GetPetError404" → "GetPetError404No2": enum "GetPetError404" owns the name',
    ]);
  });

  it('a path-derived prefix that ends in a digit sets off only a hash that starts with one', () => {
    // `567b59` and `ba41b5` are the hashes of `/pets/top10/` and `/notes/by-id`.
    const names = [
      derivePathBasedName('/pets/top10/', 'get', 'Response', '567b59'),
      derivePathBasedName('/pets/top10/', 'get', 'Response', 'ba41b5'),
      derivePathBasedName('/pets/top10/', 'get', 'Response'),
    ];
    expect(names).toEqual(['PetsTop10No567B59GetResponse', 'PetsTop10Ba41B5GetResponse', 'PetsTop10GetResponse']);
    for (const name of names) expect(toPascalCase(name)).toBe(name);
  });

  it('a webhook stem that ends in a digit sets its hash off the same way', () => {
    // `pet.v2` and `petV2` both flatten to `PetV2`, so both are hashed:
    // `2780a4` and `931202`. Before: `PetV22780A4Payload`, `PetV2931202Payload`.
    const payload = { requestBody: { content: { 'application/json': { schema: obj('pet_id') } } }, responses: {} };
    const { inlineModels } = extractWebhooks({ 'pet.v2': { post: payload }, petV2: { post: payload } });
    expect(inlineModels.map((m) => m.name)).toEqual(['PetV2No2780A4Payload', 'PetV2No931202Payload']);
  });

  it('a webhook parameter moved past a taken name is numbered behind `No` too', () => {
    // The query `v2` would mint the header's `PetAdoptedV2`, then the cookie
    // `query_v2`'s `PetAdoptedQueryV2`. Before: `PetAdoptedQueryV22`.
    const { webhooks, inlineModels } = extractWebhooks({
      petAdopted: {
        post: {
          parameters: [
            { name: 'query_v2', in: 'cookie', schema: obj('a') },
            { name: 'v2', in: 'header', schema: obj('b') },
            { name: 'v2', in: 'query', schema: obj('c') },
          ],
          responses: {},
        },
      },
    });
    expect(inlineModels.map((m) => `${m.name} { ${m.fields.map((f) => f.name).join(', ')} }`)).toEqual([
      'PetAdoptedQueryV2 { a }',
      'PetAdoptedV2 { b }',
      'PetAdoptedQueryV2No2 { c }',
    ]);
    expect(webhooks[0].queryParams.map((p) => ref(p.type))).toEqual(['model PetAdoptedQueryV2No2']);
  });

  it('a union variant numbered by its position is `PetShapeV2No2`', async () => {
    // Two variants with the same property set are told apart by position.
    const { ir } = await parse({
      paths: {},
      components: {
        schemas: {
          Pet: {
            type: 'object',
            properties: { shapeV2: { oneOf: [obj('a'), { type: 'object', properties: { a: { type: 'integer' } } }] } },
          },
        },
      },
    });
    expect(models(ir)).toEqual([
      'Pet { shapeV2: union<model PetShapeV2 | model PetShapeV2No2> }',
      'PetShapeV2 { a: primitive string }',
      'PetShapeV2No2 { a: primitive integer }',
    ]);
  });

  it('a header model the shape registry numbers is `PetsXMetaV2No2`', async () => {
    // Every candidate before the number is owned by a component of another
    // shape: the bare name, the status code, the operation, and both.
    const { ir } = await parse({
      paths: {
        '/pets/{id}': {
          get: {
            operationId: 'getPet',
            parameters: id,
            responses: { '200': { description: 'ok', headers: { 'X-Meta-V2': { schema: obj('mine') } } } },
          },
        },
      },
      components: {
        schemas: {
          PetsXMetaV2: obj('a'),
          PetsXMetaV2200: obj('b'),
          PetsGetPetXMetaV2: obj('c'),
          PetsGetPetXMetaV2200: obj('d'),
        },
      },
    });
    expect(operation(ir, 'getPet').responseHeaders?.map((h) => ref(h.type))).toEqual(['model PetsXMetaV2No2']);
    expect(ir.models.find((m) => m.name === 'PetsXMetaV2No2')?.fields.map((f) => f.name)).toEqual(['mine']);
  });

  it("an enum's numbered step is still shared by a later status code of the same operation", async () => {
    // The lone 2xx header steps past the component by number; the 503's
    // identical header shares that step (`isNumericStep` reads `…No2` as
    // one) rather than minting `PetsXModeV2503`.
    const mode = (values: string[]) => ({ 'X-Mode-V2': { schema: en(values) } });
    const { ir } = await parse({
      paths: {
        '/pets/{id}': {
          get: {
            operationId: 'getPet',
            parameters: id,
            responses: {
              '200': { description: 'ok', headers: mode(['retry', 'stop']) },
              '503': { description: 'down', headers: mode(['retry', 'stop']) },
            },
          },
        },
      },
      components: { schemas: { PetsXModeV2: en(['auto']) } },
    });
    const op = operation(ir, 'getPet');
    expect([
      ...(op.responseHeaders ?? []).map((h) => `200: ${ref(h.type)}`),
      ...op.errors.flatMap((e) => (e.headers ?? []).map((h) => `${e.statusCode}: ${ref(h.type)}`)),
    ]).toEqual(['200: enum PetsXModeV2No2', '503: enum PetsXModeV2No2']);
    expect(ir.enums.map((e) => e.name)).toEqual(['PetsXModeV2', 'PetsXModeV2No2']);
  });
});
