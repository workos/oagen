import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import {
  collectModelTypeRefs,
  collectOperationTypeRefs,
  collectResponseHeaders,
  collectWebhookTypeRefs,
  walkTypeRef,
} from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

/**
 * workos/oagen#303: an inline body named like a component schema of the
 * other kind — an object body beside a component enum, an enum body beside
 * a component model — kept the name, so `spec.models` and `spec.enums` both
 * held a `GetPetError404` and an emitter was handed a model and an enum of
 * one name. The error body, the `default` body and the header model step in
 * the deferred pass's shape registry, which reserves every enum name in play
 * (`reserveEnumNames`) — the name of a body that is itself an enum before
 * any deferred model is named (`deferredEnumName`). The sites the merge
 * passes name — a request body or primary response named from its
 * operation, a model nested under one, a list-envelope companion, a
 * component field's object — are settled there (`settleSharedNames`): a
 * name an enum holds — the document's own, or one an operation or webhook
 * carries — is no model's, whatever its shape, so the copy takes the
 * qualified name an inline model named like a component schema of another
 * shape takes (`GetPetResponse2`), identical copies sharing one model under
 * it. One rule: the model steps wherever an enum of its name exists.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-model-enum-collision-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** Parse `doc`, collecting every warning instead of printing it. */
async function parse(label: string, doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const spec = await parseSpec(await writeSpec(`${label}.json`, doc));
    return { spec, warnings: warn.mock.calls.map(([m]) => String(m)) };
  } finally {
    warn.mockRestore();
  }
}

const str: SchemaObject = { type: 'string' };
const en = (values: string[]): SchemaObject => ({ type: 'string', enum: values });
const obj = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', properties });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const response = (schema: unknown, extra: Record<string, unknown> = {}) => ({
  description: 'ok',
  ...json(schema),
  ...extra,
});
const idParam = { name: 'id', in: 'path', required: true, schema: str };
/** `GET /pets/{id}` (`getPet`, tag `pets`) with the given responses. */
const getPet = (responses: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  '/pets/{id}': { get: { operationId: 'getPet', tags: ['pets'], parameters: [idParam], responses, ...extra } },
});
const specDoc = (
  paths: Record<string, unknown>,
  schemas: Record<string, unknown> = {},
  components: Record<string, unknown> = {},
) => ({
  openapi: '3.1.0',
  info: { title: 'model enum collision', version: '1' },
  paths,
  components: { schemas, ...components },
});

/** `Model[]`, `T | null`, `(A | B)`, `map<T>`. */
function show(type: TypeRef | undefined): string {
  if (!type) return '-';
  switch (type.kind) {
    case 'array':
      return `${show(type.items)}[]`;
    case 'nullable':
      return `${show(type.inner)} | null`;
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'model':
      return `model ${type.name}`;
    case 'enum':
      return `enum ${type.name}`;
    case 'primitive':
      return type.type;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'literal':
      return JSON.stringify(type.value);
  }
}

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
/** The issue's projections: `Name [values]` per enum, `Name {fields}` per model, `code: kind Name` per error. */
const enumsOf = (spec: ApiSpec): string[] =>
  spec.enums.map(({ name, values }) => `${name} [${values.map(({ value }) => value)}]`);
const modelsOf = (spec: ApiSpec): string[] =>
  spec.models.map(({ fields, name }) => `${name} {${fields.map(({ name: f }) => f)}}`);
const errorsOf = (op: Operation): string[] => op.errors.map(({ statusCode, type }) => `${statusCode}: ${show(type)}`);
/** Every name both a model and an enum hold — the issue's own check. */
const bothKinds = (spec: ApiSpec): string[] => {
  const enums = new Set(spec.enums.map(({ name }) => name));
  return spec.models
    .map(({ name }) => name)
    .filter((name) => enums.has(name))
    .sort();
};
const headersOf = (op: Operation): Record<string, string> =>
  Object.fromEntries(collectResponseHeaders(op).map((h) => [h.name, show(h.type)]));
const renamed = (from: string, to: string): string =>
  `[oagen] Renamed inline model "${from}" → "${to}": enum "${from}" owns the name`;

/**
 * The IR is sound: no name is both a model's and an enum's, every model and
 * enum reference resolves, and every model or enum that is not a component
 * is reachable from an operation, a webhook or a model — nothing minted is
 * left orphaned.
 */
function expectSound(spec: ApiSpec, components: readonly string[] = []): void {
  const models = new Set(spec.models.map((m) => m.name));
  const enums = new Set(spec.enums.map((e) => e.name));
  expect([...models].filter((name) => enums.has(name))).toEqual([]);
  const dangling: string[] = [];
  const reached = new Set<string>();
  const visit = (label: string, type: TypeRef): void => {
    walkTypeRef(type, {
      model: (ref) => {
        if (!models.has(ref.name)) dangling.push(`${label} -> model ${ref.name}`);
        reached.add(ref.name);
      },
      enum: (ref) => {
        if (!enums.has(ref.name)) dangling.push(`${label} -> enum ${ref.name}`);
        reached.add(ref.name);
      },
    });
  };
  for (const op of spec.services.flatMap((s) => s.operations)) {
    for (const ref of collectOperationTypeRefs(op)) visit(op.name, ref);
  }
  for (const hook of spec.webhooks ?? []) for (const ref of collectWebhookTypeRefs(hook)) visit(hook.name, ref);
  for (const model of spec.models) for (const ref of collectModelTypeRefs(model)) visit(model.name, ref);
  expect(dangling).toEqual([]);
  const orphans = [...models, ...enums].filter((name) => !reached.has(name) && !components.includes(name));
  expect(orphans).toEqual([]);
}

describe('the issue, verbatim', () => {
  it('steps an inline object 404 body past the component enum of its name (`GetPetError404Body`)', async () => {
    const { spec, warnings } = await parse(
      'object-body',
      specDoc(getPet({ '200': response({ $ref: '#/components/schemas/Pet' }), '404': response(obj({ a: str })) }), {
        Pet: obj({ id: str }),
        GetPetError404: en(['old', 'new']),
      }),
    );
    expect(warnings).toEqual([]);
    expect(enumsOf(spec)).toEqual(['GetPetError404 [old,new]']);
    expect(errorsOf(opsOf(spec).getPet)).toEqual(['404: model GetPetError404Body']);
    expect(modelsOf(spec)).toEqual(['Pet {id}', 'GetPetError404Body {a}']);
    expect(bothKinds(spec)).toEqual([]);
    expectSound(spec, ['GetPetError404']);
  });

  it('steps an inline enum 404 body past the component model of its name, the other way round', async () => {
    const { spec, warnings } = await parse(
      'enum-body',
      specDoc(
        getPet({ '200': response({ $ref: '#/components/schemas/Pet' }), '404': response(en(['gone', 'missing'])) }),
        { Pet: obj({ id: str }), GetPetError404: obj({ z: str }) },
      ),
    );
    expect(warnings).toEqual([]);
    expect(enumsOf(spec)).toEqual(['GetPetError404Body [gone,missing]']);
    expect(errorsOf(opsOf(spec).getPet)).toEqual(['404: enum GetPetError404Body']);
    expect(modelsOf(spec)).toEqual(['Pet {id}', 'GetPetError404 {z}']);
    expect(bothKinds(spec)).toEqual([]);
    expectSound(spec, ['GetPetError404']);
  });

  it('steps a primary body, a `default` body, a header model and an enum `default` body past the component schemas of their names', async () => {
    // `getPet` (tag `pets`) returns an inline object as its 200 body, its
    // `default` body and its `X-Meta` header; `getNote` returns an inline
    // enum as its `default` body. Each name is a component schema of the
    // other kind.
    const { spec, warnings } = await parse(
      'four-sites',
      specDoc(
        {
          ...getPet({
            '200': response(obj({ a: str }), { headers: { 'X-Meta': { schema: obj({ m: str }) } } }),
            default: response(obj({ b: str })),
          }),
          '/notes/{id}': {
            get: {
              operationId: 'getNote',
              tags: ['notes'],
              parameters: [idParam],
              responses: {
                '200': response({ $ref: '#/components/schemas/Note' }),
                default: response(en(['x', 'y'])),
              },
            },
          },
        },
        {
          Note: obj({ id: str }),
          GetNoteDefaultResponse: obj({ q: str }),
          GetPetDefaultResponse: en(['p', 'q']),
          GetPetResponse: en(['r', 's']),
          PetsXMeta: en(['u', 'v']),
        },
      ),
    );
    expect(bothKinds(spec)).toEqual([]);
    expect(enumsOf(spec)).toEqual([
      'GetPetDefaultResponse [p,q]',
      'GetPetResponse [r,s]',
      'PetsXMeta [u,v]',
      'GetNoteDefaultResponse2 [x,y]',
    ]);
    expect(modelsOf(spec)).toEqual([
      'Note {id}',
      'GetNoteDefaultResponse {q}',
      'GetPetResponse2 {a}',
      'PetsGetPetXMeta {m}',
      'GetPetDefaultResponse2 {b}',
    ]);
    const { getPet: pet, getNote: note } = opsOf(spec);
    expect(show(pet.response)).toBe('model GetPetResponse2');
    expect(show(pet.defaultResponse?.type)).toBe('model GetPetDefaultResponse2');
    expect(headersOf(pet)).toEqual({ 'X-Meta': 'model PetsGetPetXMeta' });
    expect(show(note.response)).toBe('model Note');
    expect(show(note.defaultResponse?.type)).toBe('enum GetNoteDefaultResponse2');
    // The primary body is renamed by the merge pass, which says so; the
    // deferred sites and the lifted enum step silently, as they always did.
    expect(warnings).toEqual([renamed('GetPetResponse', 'GetPetResponse2')]);
    expectSound(spec, ['GetNoteDefaultResponse', 'GetPetDefaultResponse', 'GetPetResponse', 'PetsXMeta']);
  });
});

describe('the same rule at every other site the merge passes name', () => {
  it('an inline request body (`CreatePetRequest2`) and primary response (`CreatePetResponse2`)', async () => {
    const { spec, warnings } = await parse(
      'request-and-response',
      specDoc(
        {
          '/pets': {
            post: {
              operationId: 'createPet',
              tags: ['pets'],
              requestBody: json(obj({ n: str })),
              responses: { '200': response(obj({ a: str })) },
            },
          },
        },
        { CreatePetRequest: en(['q', 'r']), CreatePetResponse: en(['s', 't']) },
      ),
    );
    expect(bothKinds(spec)).toEqual([]);
    expect(modelsOf(spec)).toEqual(['CreatePetResponse2 {a}', 'CreatePetRequest2 {n}']);
    expect(enumsOf(spec)).toEqual(['CreatePetRequest [q,r]', 'CreatePetResponse [s,t]']);
    const { createPet } = opsOf(spec);
    expect(show(createPet.requestBody)).toBe('model CreatePetRequest2');
    expect(show(createPet.response)).toBe('model CreatePetResponse2');
    expect(warnings).toEqual([
      renamed('CreatePetResponse', 'CreatePetResponse2'),
      renamed('CreatePetRequest', 'CreatePetRequest2'),
    ]);
    expectSound(spec, ['CreatePetRequest', 'CreatePetResponse']);
  });

  it('a second success body sharing the primary model follows it to the new name', async () => {
    const { spec, warnings } = await parse(
      'second-success',
      specDoc(getPet({ '200': response(obj({ a: str })), '202': response(obj({ a: str })) }), {
        GetPetResponse: en(['s', 't']),
      }),
    );
    expect(bothKinds(spec)).toEqual([]);
    expect(modelsOf(spec)).toEqual(['GetPetResponse2 {a}']);
    const { getPet: pet } = opsOf(spec);
    expect(show(pet.response)).toBe('model GetPetResponse2');
    expect(pet.successResponses?.map(({ statusCode, type }) => `${statusCode}: ${show(type)}`)).toEqual([
      '200: model GetPetResponse2',
      '202: model GetPetResponse2',
    ]);
    expect(warnings).toEqual([renamed('GetPetResponse', 'GetPetResponse2')]);
    expectSound(spec, ['GetPetResponse']);
  });

  it('the primary body of an operation named from its path', async () => {
    const { spec, warnings } = await parse(
      'path-named',
      specDoc(
        {
          '/pets/{petId}': {
            get: {
              tags: ['pets'],
              parameters: [{ ...idParam, name: 'petId' }],
              responses: { '200': response(obj({ a: str })) },
            },
          },
        },
        { PetsByPetIdGetResponse: en(['a', 'b']) },
      ),
    );
    expect(bothKinds(spec)).toEqual([]);
    expect(modelsOf(spec)).toEqual(['GetPetsByPetIdGetResponse {a}']);
    expect(enumsOf(spec)).toEqual(['PetsByPetIdGetResponse [a,b]']);
    expect(show(opsOf(spec).get.response)).toBe('model GetPetsByPetIdGetResponse');
    expect(warnings).toEqual([renamed('PetsByPetIdGetResponse', 'GetPetsByPetIdGetResponse')]);
    expectSound(spec, ['PetsByPetIdGetResponse']);
  });

  it('an object nested under a primary body (`GetPetResponseOwner2`), its parent keeping its own name', async () => {
    const { spec, warnings } = await parse(
      'nested',
      specDoc(getPet({ '200': response(obj({ a: str, owner: obj({ name: str }) })) }), {
        GetPetResponseOwner: en(['a', 'b']),
      }),
    );
    expect(bothKinds(spec)).toEqual([]);
    expect(modelsOf(spec)).toEqual(['GetPetResponse {a,owner}', 'GetPetResponseOwner2 {name}']);
    expect(enumsOf(spec)).toEqual(['GetPetResponseOwner [a,b]']);
    const owner = spec.models.find((m) => m.name === 'GetPetResponse')?.fields.find((f) => f.name === 'owner');
    expect(show(owner?.type)).toBe('model GetPetResponseOwner2');
    expect(warnings).toEqual([renamed('GetPetResponseOwner', 'GetPetResponseOwner2')]);
    expectSound(spec, ['GetPetResponseOwner']);
  });

  it('a list-envelope companion (`ListPetsListMetadata`), past a second enum of that name too', async () => {
    const listPets = {
      '/pets': {
        get: {
          operationId: 'listPets',
          tags: ['pets'],
          parameters: [{ name: 'after', in: 'query', schema: str }],
          responses: {
            '200': response(
              obj({
                data: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
                list_metadata: obj({ before: str, after: str }),
              }),
            ),
          },
        },
      },
    };
    const one = await parse('companion', specDoc(listPets, { Pet: obj({ id: str }), ListMetadata: en(['a', 'b']) }));
    expect(bothKinds(one.spec)).toEqual([]);
    expect(modelsOf(one.spec)).toEqual(['Pet {id}', 'ListPetsListMetadata {before,after}']);
    expect(one.warnings).toEqual([renamed('ListMetadata', 'ListPetsListMetadata')]);
    expectSound(one.spec, ['ListMetadata']);

    const two = await parse(
      'companion-2',
      specDoc(listPets, {
        Pet: obj({ id: str }),
        ListMetadata: en(['a', 'b']),
        ListPetsListMetadata: en(['c', 'd']),
      }),
    );
    expect(bothKinds(two.spec)).toEqual([]);
    expect(modelsOf(two.spec)).toEqual(['Pet {id}', 'ListPetsListMetadata2 {before,after}']);
    expect(enumsOf(two.spec)).toEqual(['ListMetadata [a,b]', 'ListPetsListMetadata [c,d]']);
    expect(two.warnings).toEqual([renamed('ListMetadata', 'ListPetsListMetadata2')]);
    expectSound(two.spec, ['ListMetadata', 'ListPetsListMetadata']);
  });

  it('a component field’s object (`PetOwner2`)', async () => {
    const { spec, warnings } = await parse(
      'field-object',
      specDoc(getPet({ '200': response({ $ref: '#/components/schemas/Pet' }) }), {
        Pet: obj({ id: str, owner: obj({ name: str }) }),
        PetOwner: en(['a', 'b']),
      }),
    );
    expect(bothKinds(spec)).toEqual([]);
    expect(modelsOf(spec)).toEqual(['Pet {id,owner}', 'PetOwner2 {name}']);
    expect(enumsOf(spec)).toEqual(['PetOwner [a,b]']);
    const owner = spec.models.find((m) => m.name === 'Pet')?.fields.find((f) => f.name === 'owner');
    expect(show(owner?.type)).toBe('model PetOwner2');
    expect(warnings).toEqual([renamed('PetOwner', 'PetOwner2')]);
    expectSound(spec, ['PetOwner']);
  });

  it('a component response’s inline body steps in the shape registry, silently, by number (`NotFoundResponse2`)', async () => {
    const { spec, warnings } = await parse(
      'component-response',
      specDoc(
        getPet({
          '200': response({ $ref: '#/components/schemas/Pet' }),
          '404': { $ref: '#/components/responses/NotFound' },
        }),
        { Pet: obj({ id: str }), NotFoundResponse: en(['a', 'b']) },
        { responses: { NotFound: response(obj({ a: str })) } },
      ),
    );
    expect(warnings).toEqual([]);
    expect(bothKinds(spec)).toEqual([]);
    expect(modelsOf(spec)).toEqual(['Pet {id}', 'NotFoundResponse2 {a}']);
    expect(errorsOf(opsOf(spec).getPet)).toEqual(['404: model NotFoundResponse2']);
    expectSound(spec, ['NotFoundResponse']);
  });

  it('an inline enum request or success body steps past the component model of its name, in the collectors', async () => {
    const { spec, warnings } = await parse(
      'enum-bodies',
      specDoc(
        {
          '/pets': {
            post: {
              operationId: 'createPet',
              tags: ['pets'],
              requestBody: json(en(['q', 'r'])),
              responses: { '200': response(en(['s', 't'])), '202': response(en(['u', 'v'])) },
            },
          },
        },
        {
          CreatePetRequest: obj({ z: str }),
          CreatePetResponse: obj({ z: str }),
          CreatePetResponse202: obj({ z: str }),
        },
      ),
    );
    expect(warnings).toEqual([]);
    expect(bothKinds(spec)).toEqual([]);
    expect(enumsOf(spec)).toEqual([
      'CreatePetRequest2 [q,r]',
      'CreatePetResponse200 [s,t]',
      'CreatePetResponse2 [u,v]',
    ]);
    expect(modelsOf(spec)).toEqual(['CreatePetRequest {z}', 'CreatePetResponse {z}', 'CreatePetResponse202 {z}']);
    const { createPet } = opsOf(spec);
    expect(show(createPet.requestBody)).toBe('enum CreatePetRequest2');
    expect(show(createPet.response)).toBe('enum CreatePetResponse200');
    expect(createPet.successResponses?.map(({ statusCode, type }) => `${statusCode}: ${show(type)}`)).toEqual([
      '200: enum CreatePetResponse200',
      '202: enum CreatePetResponse2',
    ]);
    expectSound(spec, ['CreatePetRequest', 'CreatePetResponse', 'CreatePetResponse202']);
  });
});

/** The query parameter `name` of an operation, rendered. */
const queryType = (op: Operation, name: string): string => show(op.queryParams.find((p) => p.name === name)?.type);
const opsIn = (spec: ApiSpec): Operation[] => spec.services.flatMap((s) => s.operations);

describe('review: one rule — the model steps wherever an enum of its name exists', () => {
  it('shares one model between identical copies that leave an enum’s name (bodies pinned by `object: widget`)', async () => {
    const widget = obj({ object: { const: 'widget' } as SchemaObject, name: str });
    const { spec, warnings } = await parse(
      'identical-widgets',
      specDoc(
        {
          '/a': { get: { operationId: 'getA', tags: ['widgets'], responses: { '200': response(widget) } } },
          '/b': { get: { operationId: 'getB', tags: ['widgets'], responses: { '200': response(widget) } } },
        },
        { Widget: en(['a', 'b']) },
      ),
    );
    expect(bothKinds(spec)).toEqual([]);
    expect(modelsOf(spec)).toEqual(['GetAWidget {object,name}']);
    expect(opsIn(spec).map((op) => show(op.response))).toEqual(['model GetAWidget', 'model GetAWidget']);
    expect(warnings).toEqual([`${renamed('Widget', 'GetAWidget')} (shared by 2 sites)`]);
    expectSound(spec, ['Widget']);
  });

  it('shares one model between two identical `getPet` bodies beside a component enum `GetPetResponse`', async () => {
    const { spec, warnings } = await parse(
      'identical-get-pet',
      specDoc(
        {
          ...getPet({ '200': response(obj({ a: str })) }),
          '/pet/{id}': {
            get: {
              operationId: 'get_pet',
              tags: ['pets'],
              parameters: [idParam],
              responses: { '200': response(obj({ a: str })) },
            },
          },
        },
        { GetPetResponse: en(['r', 's']) },
      ),
    );
    expect(bothKinds(spec)).toEqual([]);
    expect(modelsOf(spec)).toEqual(['GetPetResponse2 {a}']);
    expect(opsIn(spec).map((op) => show(op.response))).toEqual(['model GetPetResponse2', 'model GetPetResponse2']);
    expect(warnings).toEqual([`${renamed('GetPetResponse', 'GetPetResponse2')} (shared by 2 sites)`]);
    expectSound(spec, ['GetPetResponse']);
  });

  it('a `createPet` request body beside a `request` query enum of its service: the body steps (`CreatePetRequest2`)', async () => {
    const { spec, warnings } = await parse(
      'body-beside-query-enum',
      specDoc({
        '/pets': {
          post: {
            operationId: 'createPet',
            tags: ['createPet'],
            parameters: [{ name: 'request', in: 'query', schema: en(['x', 'y']) }],
            requestBody: json(obj({ n: str })),
            responses: { '200': { description: 'ok' } },
          },
        },
      }),
    );
    expect(bothKinds(spec)).toEqual([]);
    expect(enumsOf(spec)).toEqual(['CreatePetRequest [x,y]']);
    expect(modelsOf(spec)).toEqual(['CreatePetRequest2 {n}']);
    const { createPet } = opsOf(spec);
    expect(show(createPet.requestBody)).toBe('model CreatePetRequest2');
    expect(queryType(createPet, 'request')).toBe('enum CreatePetRequest');
    expect(warnings).toEqual([renamed('CreatePetRequest', 'CreatePetRequest2')]);
    expectSound(spec);
  });

  it('a `request` query parameter object beside that enum: the object steps in the registry (`CreatePetListPetsRequest`)', async () => {
    const { spec, warnings } = await parse(
      'param-beside-query-enum',
      specDoc({
        '/pets': {
          get: {
            operationId: 'listPets',
            tags: ['createPet'],
            parameters: [{ name: 'request', in: 'query', style: 'deepObject', schema: obj({ q: str }) }],
            responses: { '200': { description: 'ok' } },
          },
        },
        '/pets/search': {
          get: {
            operationId: 'searchPets',
            tags: ['createPet'],
            parameters: [{ name: 'request', in: 'query', schema: en(['x', 'y']) }],
            responses: { '200': { description: 'ok' } },
          },
        },
      }),
    );
    expect(warnings).toEqual([]);
    expect(bothKinds(spec)).toEqual([]);
    expect(enumsOf(spec)).toEqual(['CreatePetRequest [x,y]']);
    expect(modelsOf(spec)).toEqual(['CreatePetListPetsRequest {q}']);
    const { listPets, searchPets } = opsOf(spec);
    expect(queryType(listPets, 'request')).toBe('model CreatePetListPetsRequest');
    expect(queryType(searchPets, 'request')).toBe('enum CreatePetRequest');
    expectSound(spec);
  });

  it('a `Pet.status` object beside a `status` query enum: the object steps at the merges (`PetStatus2`), a header sharing it following', async () => {
    const pet = obj({ id: str, status: obj({ code: str }) });
    const listPets = (headers: Record<string, unknown> = {}) => ({
      '/pets': {
        get: {
          operationId: 'listPets',
          tags: ['pet'],
          parameters: [{ name: 'status', in: 'query', schema: en(['x', 'y']) }],
          responses: { '200': response({ $ref: '#/components/schemas/Pet' }, { headers }) },
        },
      },
    });
    const plain = await parse('field-beside-query-enum', specDoc(listPets(), { Pet: pet }));
    expect(bothKinds(plain.spec)).toEqual([]);
    expect(enumsOf(plain.spec)).toEqual(['PetStatus [x,y]']);
    expect(modelsOf(plain.spec)).toEqual(['Pet {id,status}', 'PetStatus2 {code}']);
    expect(show(plain.spec.models[0].fields[1].type)).toBe('model PetStatus2');
    expect(queryType(opsOf(plain.spec).listPets, 'status')).toBe('enum PetStatus');
    expect(plain.warnings).toEqual([renamed('PetStatus', 'PetStatus2')]);
    expectSound(plain.spec, ['Pet']);

    // A `Status` header of the same shape shared the object's model in the
    // registry; the reference it wrote follows the rename.
    const shared = await parse(
      'field-beside-query-enum-shared',
      specDoc(listPets({ Status: { schema: obj({ code: str }) } }), { Pet: pet }),
    );
    expect(bothKinds(shared.spec)).toEqual([]);
    expect(modelsOf(shared.spec)).toEqual(['Pet {id,status}', 'PetStatus2 {code}']);
    expect(headersOf(opsOf(shared.spec).listPets)).toEqual({ Status: 'model PetStatus2' });
    expect(shared.warnings).toEqual([renamed('PetStatus', 'PetStatus2')]);
    expectSound(shared.spec, ['Pet']);
  });

  it('an object `404` body and an enum `404` body under one stem: the object steps (`GetPetError404Body`) in either order', async () => {
    const objectBody = {
      '/pets/{id}': {
        get: {
          operationId: 'getPet',
          tags: ['pets'],
          parameters: [idParam],
          responses: { '200': { description: 'ok' }, '404': response(obj({ reason: str })) },
        },
      },
    };
    const enumBody = {
      '/pet/{petId}': {
        get: {
          operationId: 'get-pet',
          tags: ['pets'],
          parameters: [{ ...idParam, name: 'petId' }],
          responses: { '200': { description: 'ok' }, '404': response(en(['absent', 'unknown'])) },
        },
      },
    };
    for (const [label, paths] of [
      ['object-first', { ...objectBody, ...enumBody }],
      ['enum-first', { ...enumBody, ...objectBody }],
    ] as const) {
      const { spec, warnings } = await parse(label, specDoc(paths));
      expect(warnings).toEqual([]);
      expect(bothKinds(spec)).toEqual([]);
      expect(enumsOf(spec)).toEqual(['GetPetError404 [absent,unknown]']);
      expect(modelsOf(spec)).toEqual(['GetPetError404Body {reason}']);
      expect(opsIn(spec).map((op) => errorsOf(op)[0])).toEqual(
        label === 'object-first'
          ? ['404: model GetPetError404Body', '404: enum GetPetError404']
          : ['404: enum GetPetError404', '404: model GetPetError404Body'],
      );
      expectSound(spec);
    }
  });
});
