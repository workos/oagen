import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import {
  collectModelRefs,
  collectResponseBodyTypes,
  collectResponseHeaders,
  collectWebhookTypeRefs,
} from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * workos/oagen#307: a schema that writes `properties` beside `allOf` — what
 * `zod-openapi` writes for `.extend()` of a registered schema — applies
 * both, so an instance has the members' properties and its own. A component
 * kept only its `allOf` members (`Dog { name }`, `breed` dropped although
 * `required` named it), and an inline response body kept only its own
 * properties. A component's own `properties` and `required` are now read as
 * its first `allOf` member (`componentAllOfMembers`), at every level of a
 * `$ref` chain and in a discriminated `allOf` + `oneOf`'s base, with the
 * first declaration of a name kept as `mergeAllOfMembers` keeps it; and a
 * primary response body reads its `allOf` the one way every other site does
 * (`readInlineAllOf`).
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-allof-sibling-properties-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

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
const int: SchemaObject = { type: 'integer' };
const bool: SchemaObject = { type: 'boolean' };
const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
  type: 'object',
  properties,
  ...extra,
});
const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const ok = (schema: unknown) => ({ '200': { description: 'ok', ...json(schema) } });
const getOp = (operationId: string, schema: unknown) => ({ get: { operationId, responses: ok(schema) } });
const specDoc = (
  paths: Record<string, unknown>,
  schemas: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  openapi: '3.1.0',
  info: { title: 'allOf sibling properties', version: '1' },
  paths,
  components: { schemas },
  ...extra,
});

/** `Pet { name }`, the issue's base component. */
const pet = obj({ name: str }, { required: ['name'] });

function show(type: TypeRef): string {
  switch (type.kind) {
    case 'array':
      return `${show(type.items)}[]`;
    case 'nullable':
      return `${show(type.inner)} | null`;
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'model':
    case 'enum':
      return type.name;
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

const modelOf = (spec: ApiSpec, name: string): Model => {
  const model = spec.models.find((m) => m.name === name);
  if (!model) throw new Error(`model ${name} not found in ${spec.models.map((m) => m.name).join(', ')}`);
  return model;
};

/** Each field as `name: type`, `?` when optional, in model order. */
const fieldsOf = (spec: ApiSpec, name: string): string[] =>
  modelOf(spec, name).fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`);

const modelNames = (spec: ApiSpec): string[] => spec.models.map((m) => m.name);

/** Every ordering of `items`. */
const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

/** Every type reference an operation holds, labelled by where it sits. */
function operationRefs(op: Operation): Array<[string, TypeRef]> {
  const refs: Array<[string, TypeRef]> = [[`${op.name}.response`, op.response]];
  if (op.requestBody) refs.push([`${op.name}.requestBody`, op.requestBody]);
  for (const r of op.successResponses ?? []) refs.push([`${op.name}.${r.statusCode}`, r.type]);
  for (const e of op.errors) if (e.type) refs.push([`${op.name}.${e.statusCode}`, e.type]);
  if (op.defaultResponse?.type) refs.push([`${op.name}.default`, op.defaultResponse.type]);
  for (const r of op.rangeResponses ?? []) if (r.type) refs.push([`${op.name}.${r.range}`, r.type]);
  for (const b of collectResponseBodyTypes(op)) refs.push([`${op.name}.${b.source}`, b.type]);
  for (const h of collectResponseHeaders(op)) refs.push([`${op.name}.${h.name}`, h.type]);
  for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
    refs.push([`${op.name}(${p.name})`, p.type]);
  }
  if (op.pagination) refs.push([`${op.name}.items`, op.pagination.itemType]);
  for (const f of op.pagination?.envelopeFields ?? []) refs.push([`${op.name}.${f.name}`, f.type]);
  return refs;
}

/** Every reference the document holds: from operations, webhooks and model fields. */
function allRefs(spec: ApiSpec): Array<[string, TypeRef]> {
  const refs: Array<[string, TypeRef]> = [];
  for (const op of Object.values(opsOf(spec))) refs.push(...operationRefs(op));
  for (const w of spec.webhooks ?? []) for (const r of collectWebhookTypeRefs(w)) refs.push([`webhook ${w.name}`, r]);
  for (const m of spec.models) for (const f of m.fields) refs.push([`${m.name}.${f.name}`, f.type]);
  return refs;
}

/** Every model reference that names no model. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const names = new Set(modelNames(spec));
  const found: string[] = [];
  for (const [owner, r] of allRefs(spec))
    for (const name of collectModelRefs(r)) if (!names.has(name)) found.push(`${owner} → ${name}`);
  return found.sort();
}

/** Every model that is neither a component nor referenced by any operation, webhook, model field or dispatcher mapping. */
function orphanedModels(spec: ApiSpec, componentNames: string[]): string[] {
  const referenced = new Set<string>();
  for (const [, r] of allRefs(spec)) for (const name of collectModelRefs(r)) referenced.add(name);
  for (const m of spec.models)
    for (const target of Object.values(m.discriminator?.mapping ?? {})) referenced.add(target);
  return modelNames(spec)
    .filter((name) => !componentNames.includes(name) && !referenced.has(name))
    .sort();
}

/** Nothing dangles, nothing is orphaned, and no name is both a model's and an enum's. */
function expectSound(spec: ApiSpec, componentNames: string[]): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphanedModels(spec, componentNames)).toEqual([]);
  const enumNames = new Set(spec.enums.map((e) => e.name));
  expect(modelNames(spec).filter((name) => enumNames.has(name))).toEqual([]);
}

describe('workos/oagen#307: properties written beside allOf', () => {
  /** The issue's document, verbatim. */
  const issueDoc = {
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1.0.0' },
    paths: {
      '/dogs/{id}': {
        get: {
          operationId: 'getDog',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'A dog',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Dog' } } },
            },
          },
        },
      },
      '/cats/{id}': {
        get: {
          operationId: 'getCat',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'A cat',
              content: {
                'application/json': {
                  schema: {
                    allOf: [{ $ref: '#/components/schemas/Pet' }],
                    properties: { indoor: { type: 'boolean' } },
                    required: ['indoor'],
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Pet: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        Dog: {
          allOf: [{ $ref: '#/components/schemas/Pet' }],
          properties: { breed: { type: 'string' } },
          required: ['breed'],
        },
      },
    },
  };

  it("the issue's repro: the component and the inline response body each carry the members' properties and their own", async () => {
    const { spec, warnings } = await parse('issue', issueDoc);
    // The issue's projection of the IR. The schema's own properties come
    // first, then the members', as every merge of a `properties`-beside-
    // composition schema orders them (`foldSiblingProperties`).
    expect(
      spec.models.map(
        ({ fields, name }) =>
          `${name} { ${fields.map(({ name, required }) => `${name}${required ? '' : '?'}`).join(', ')} }`,
      ),
    ).toEqual(['Pet { name }', 'Dog { breed, name }', 'GetCatResponse { indoor, name }']);
    expect(
      spec.services
        .flatMap(({ operations }) => operations)
        .map(({ name, response }) => `${name}: ${JSON.stringify(response)}`),
    ).toEqual(['getDog: {"kind":"model","name":"Dog"}', 'getCat: {"kind":"model","name":"GetCatResponse"}']);
    expect(fieldsOf(spec, 'Dog')).toEqual(['breed: string', 'name: string']);
    expect(fieldsOf(spec, 'GetCatResponse')).toEqual(['indoor: boolean', 'name: string']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet', 'Dog']);
  });

  it("the issue's cat body reads { indoor, name } at every other inline site", async () => {
    const cat: SchemaObject = { allOf: [ref('Pet')], properties: { indoor: bool }, required: ['indoor'] };
    const { spec, warnings } = await parse(
      'every-site',
      specDoc(
        {
          '/cats': {
            post: {
              operationId: 'createCat',
              parameters: [{ name: 'where', in: 'query', schema: cat }],
              requestBody: json(cat),
              responses: {
                '200': { description: 'ok', ...json(cat), headers: { 'X-Cat': { schema: cat } } },
                '404': { description: 'missing', ...json(cat) },
                default: { description: 'other', ...json(cat) },
              },
            },
            get: { operationId: 'listCats', responses: ok({ type: 'array', items: cat }) },
          },
          '/alt': {
            get: {
              operationId: 'altCat',
              responses: {
                '200': {
                  description: 'ok',
                  content: { 'application/json': { schema: ref('Pet') }, 'application/vnd.cat+json': { schema: cat } },
                },
              },
            },
          },
        },
        { Pet: pet, Holder: obj({ cat }) },
        {
          webhooks: {
            catAdopted: { post: { requestBody: json(cat), responses: { '200': { description: 'ok' } } } },
          },
        },
      ),
    );
    const ops = opsOf(spec);
    const items = ops.listCats!.response;
    const secondary = collectResponseBodyTypes(ops.altCat!)
      .map((b) => b.type)
      .find((t) => t.kind === 'model' && t.name !== 'Pet')!;
    const sites: Record<string, TypeRef> = {
      response: ops.createCat!.response,
      body: ops.createCat!.requestBody!,
      param: ops.createCat!.queryParams[0]!.type,
      header: ops.createCat!.responseHeaders![0]!.type,
      error: ops.createCat!.errors.find((e) => String(e.statusCode) === '404')!.type!,
      default: ops.createCat!.defaultResponse!.type!,
      items: items.kind === 'array' ? items.items : items,
      secondary,
      field: modelOf(spec, 'Holder').fields[0]!.type,
      webhook: spec.webhooks![0]!.requestBody!,
    };
    for (const [site, type] of Object.entries(sites)) {
      expect(type.kind, site).toBe('model');
      expect(fieldsOf(spec, show(type)), site).toEqual(['indoor: boolean', 'name: string']);
    }
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet', 'Holder']);
  });

  it("a $ref chain carries every level's own properties, and what they hold is materialized under each model", async () => {
    const { spec, warnings } = await parse(
      'chain',
      specDoc(
        { '/pups': getOp('getPup', ref('Pup')) },
        {
          Pet: pet,
          Dog: {
            allOf: [ref('Pet')],
            properties: { breed: str, meta: obj({ tag: str }), kind: { type: 'string', enum: ['x', 'y'] } },
            required: ['breed'],
          },
          Puppy: { allOf: [ref('Dog')], properties: { age: int } },
          // No properties of its own: its `required` names an inherited one.
          Pup: { allOf: [ref('Puppy')], required: ['age'] },
        },
      ),
    );
    expect(fieldsOf(spec, 'Dog')).toEqual(['breed: string', 'meta?: DogMeta', 'kind?: DogKind', 'name: string']);
    expect(fieldsOf(spec, 'Puppy')).toEqual([
      'age?: integer',
      'breed: string',
      'meta?: PuppyMeta',
      'kind?: PuppyKind',
      'name: string',
    ]);
    expect(fieldsOf(spec, 'Pup')).toEqual([
      'age: integer',
      'breed: string',
      'meta?: PupMeta',
      'kind?: PupKind',
      'name: string',
    ]);
    // The inline object two `$ref`s up the chain is found for `Pup` as it is
    // for `Puppy` (`findNestedFieldSchema` follows the chain).
    for (const name of ['DogMeta', 'PuppyMeta', 'PupMeta'])
      expect(fieldsOf(spec, name), name).toEqual(['tag?: string']);
    expect(spec.enums.map((e) => `${e.name} [${e.values.map((v) => v.value).join(',')}]`).sort()).toEqual([
      'DogKind [x,y]',
      'PupKind [x,y]',
      'PuppyKind [x,y]',
    ]);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet', 'Dog', 'Puppy', 'Pup']);
  });

  it("the component's own declaration wins over a member's, and a name two members declare keeps its first", async () => {
    const { spec, warnings } = await parse(
      'precedence',
      specDoc(
        {},
        {
          Pet: pet,
          Owner: obj({ id: str, name: int }, { required: ['id'] }),
          Override: { allOf: [ref('Pet')], properties: { name: { type: 'string', enum: ['p', 'q'] } } },
          // Before: `name` twice, `Pet`'s and `Owner`'s.
          TwoRefs: { allOf: [ref('Pet'), ref('Owner')] },
          // A variant's declaration is replaced in place by an always-applying
          // member's, whichever comes first (`mergeAllOfMembers` precedence).
          Late: {
            allOf: [{ oneOf: [obj({ tag: int }), obj({ other: str })] }, obj({ tag: str }, { required: ['tag'] })],
          },
        },
      ),
    );
    expect(fieldsOf(spec, 'Override')).toEqual(['name: OverrideName']);
    expect(spec.enums.find((e) => e.name === 'OverrideName')?.values.map((v) => v.value)).toEqual(['p', 'q']);
    expect(fieldsOf(spec, 'TwoRefs')).toEqual(['name: string', 'id: string']);
    expect(fieldsOf(spec, 'Late')).toEqual(['tag: string', 'other?: string']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet', 'Owner', 'Override', 'TwoRefs', 'Late']);
  });

  it('an allOf of bare limits beside properties keeps the properties, with the limits conjoined', async () => {
    const { spec, warnings } = await parse(
      'limits',
      specDoc({}, { Bounded: { allOf: [{ minProperties: 1 }], properties: { a: str }, required: ['a'] } }),
    );
    expect(fieldsOf(spec, 'Bounded')).toEqual(['a: string']);
    expect(modelOf(spec, 'Bounded').constraints).toEqual({ minProperties: 1 });
    expect(warnings).toEqual([]);
    expectSound(spec, ['Bounded']);
  });

  it('a discriminated allOf + oneOf carries the own properties into the dispatcher and every variant; a flattened one keeps them required', async () => {
    const { spec, warnings } = await parse(
      'dispatcher',
      specDoc(
        {},
        {
          Pet: pet,
          Dispatch: {
            allOf: [
              ref('Pet'),
              {
                oneOf: [obj({ event: { const: 'created' }, c: str }), obj({ event: { const: 'deleted' }, d: str })],
              },
            ],
            properties: { id: str },
            required: ['id'],
          },
          Flat: {
            allOf: [ref('Pet'), { oneOf: [obj({ c: str }), obj({ d: str })] }],
            properties: { id: str },
            required: ['id'],
          },
        },
      ),
    );
    expect(fieldsOf(spec, 'Dispatch')).toEqual(['id: string', 'name: string']);
    expect(modelOf(spec, 'Dispatch').discriminator).toEqual({
      property: 'event',
      mapping: { created: 'DispatchCreated', deleted: 'DispatchDeleted' },
    });
    // The base is read as the dispatcher model's is (`readComponentAllOfMember`):
    // a `$ref` base member's fields reach every variant too.
    expect(fieldsOf(spec, 'DispatchCreated')).toEqual([
      'id: string',
      'name: string',
      'event?: "created"',
      'c?: string',
    ]);
    expect(fieldsOf(spec, 'DispatchDeleted')).toEqual([
      'id: string',
      'name: string',
      'event?: "deleted"',
      'd?: string',
    ]);
    expect(fieldsOf(spec, 'Flat')).toEqual(['id: string', 'name: string', 'c?: string', 'd?: string']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet', 'Dispatch', 'Flat']);
  });

  it('the component model and an inline allOf naming it carry the same fields, whichever keyword is written first', async () => {
    const dog = {
      allOf: [ref('Pet')],
      properties: { breed: str, kind: { type: 'string', enum: ['x', 'y'] } },
      required: ['breed'],
    };
    const { spec, warnings } = await parse(
      'agreement',
      specDoc(
        { '/dogs': getOp('getDog', ref('Dog')), '/cats': getOp('getCat', ref('Cat')) },
        {
          Pet: pet,
          Dog: dog,
          // The same schema with `properties` written before `allOf`.
          Cat: { properties: dog.properties, required: dog.required, allOf: dog.allOf },
          Holder: obj({
            dog: { allOf: [ref('Dog'), obj({ z: str })] },
            cat: { properties: { z: str }, allOf: [ref('Cat')] },
          }),
        },
      ),
    );
    expect(fieldsOf(spec, 'Dog')).toEqual(['breed: string', 'kind?: DogKind', 'name: string']);
    expect(fieldsOf(spec, 'Cat')).toEqual(['breed: string', 'kind?: CatKind', 'name: string']);
    expect(fieldsOf(spec, 'HolderDog')).toEqual(['breed: string', 'kind?: DogKind', 'name: string', 'z?: string']);
    expect(fieldsOf(spec, 'HolderCat')).toEqual(['z?: string', 'breed: string', 'kind?: CatKind', 'name: string']);
    expect(show(opsOf(spec).getDog!.response)).toBe('Dog');
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet', 'Dog', 'Cat', 'Holder']);
  });

  it('a property named like an `Object.prototype` member beside the members is a field', async () => {
    const { spec, warnings } = await parse(
      'own-names',
      specDoc({}, { Pet: pet, Weird: { allOf: [ref('Pet')], properties: { constructor: str, toString: str } } }),
    );
    expect(fieldsOf(spec, 'Weird')).toEqual(['constructor?: string', 'toString?: string', 'name: string']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet', 'Weird']);
  });

  describe('a primary response body reads its allOf as a field of the same schema is read', () => {
    it('a lone $ref with nothing added is the reference, two $refs merge; a lone member is the body itself', async () => {
      const { spec, warnings } = await parse(
        'response-readings',
        specDoc(
          {
            '/a': getOp('loneRef', { allOf: [ref('Pet')] }),
            '/b': getOp('refPlusDoc', { allOf: [ref('Pet'), { description: 'doc' }] }),
            '/c': getOp('refPlusLimits', { allOf: [ref('Pet'), { minProperties: 1 }] }),
            // A second `$ref` adds to the first: the merge, as `Holder.two` is typed.
            '/d': getOp('twoRefs', { allOf: [ref('Pet'), ref('Owner')] }),
            '/e': getOp('loneObject', { allOf: [obj({ a: str }, { required: ['a'] })] }),
            '/f': getOp('loneArray', { allOf: [{ type: 'array', items: obj({ x: str }) }] }),
            '/g': getOp('loneEnum', { allOf: [{ type: 'string', enum: ['a', 'b'] }] }),
            '/h': getOp('merged', { allOf: [ref('Pet'), obj({ extra: str })] }),
          },
          {
            Pet: pet,
            Owner: obj({ id: str }, { required: ['id'] }),
            Holder: obj({ two: { allOf: [ref('Pet'), ref('Owner')] }, lone: { allOf: [ref('Pet')] } }),
          },
        ),
      );
      const ops = opsOf(spec);
      const responses = Object.fromEntries(Object.values(ops).map((op) => [op.name, show(op.response)]));
      expect(responses).toEqual({
        loneRef: 'Pet',
        refPlusDoc: 'Pet',
        refPlusLimits: 'Pet',
        twoRefs: 'TwoRefsResponse',
        loneObject: 'LoneObjectResponse',
        loneArray: 'LoneArrayItem[]',
        loneEnum: 'LoneEnumResponse',
        merged: 'MergedResponse',
      });
      expect(fieldsOf(spec, 'LoneObjectResponse')).toEqual(['a: string']);
      expect(fieldsOf(spec, 'LoneArrayItem')).toEqual(['x?: string']);
      expect(fieldsOf(spec, 'MergedResponse')).toEqual(['name: string', 'extra?: string']);
      expect(spec.enums.find((e) => e.name === 'LoneEnumResponse')?.values.map((v) => v.value)).toEqual(['a', 'b']);
      // Before, each reference reading minted a copy of `Pet` under the operation's name.
      expect(
        modelNames(spec)
          .filter((name) => name.endsWith('Response'))
          .sort(),
      ).toEqual(['LoneObjectResponse', 'MergedResponse', 'TwoRefsResponse']);
      expect(fieldsOf(spec, 'TwoRefsResponse')).toEqual(['name: string', 'id: string']);
      expect(fieldsOf(spec, 'Holder')).toEqual(['two?: HolderTwo', 'lone?: Pet']);
      expect(fieldsOf(spec, 'HolderTwo')).toEqual(['name: string', 'id: string']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Pet', 'Owner', 'Holder']);
    });

    it('classifyAndExtractResponse types a reference reading as the component and mints nothing', () => {
      const componentSchemas = { Pet: pet };
      for (const schema of [
        { allOf: [ref('Pet')] },
        { allOf: [ref('Pet'), { description: 'doc' }] },
        { allOf: [ref('Pet'), { minProperties: 1 }] },
      ]) {
        const result = classifyAndExtractResponse(schema, 'GetPetResponse', componentSchemas);
        expect(result.response).toEqual({ kind: 'model', name: 'Pet' });
        expect(result.inlineModels).toEqual([]);
      }
      // A second `$ref` adds to the first: the merge, under the body's name.
      const two = classifyAndExtractResponse({ allOf: [ref('Pet'), ref('Owner')] }, 'GetPetResponse', {
        Pet: pet,
        Owner: obj({ id: str }, { required: ['id'] }),
      });
      expect(two.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(two.inlineModels.map((m) => `${m.name} { ${m.fields.map((f) => f.name).join(', ')} }`)).toEqual([
        'GetPetResponse { name, id }',
      ]);
      // A ref no component schema answers is that reference too.
      const unanswered = classifyAndExtractResponse({ allOf: [ref('Pet')] }, 'GetPetResponse');
      expect(unanswered.response).toEqual({ kind: 'model', name: 'Pet' });
      expect(unanswered.inlineModels).toEqual([]);
      // A lone inline member is the body, under the body's name.
      const lone = classifyAndExtractResponse({ allOf: [obj({ a: str })] }, 'GetThingResponse', componentSchemas);
      expect(lone.response).toEqual({ kind: 'model', name: 'GetThingResponse' });
      expect(lone.inlineModels.map((m) => `${m.name} { ${m.fields.map((f) => f.name).join(', ')} }`)).toEqual([
        'GetThingResponse { a }',
      ]);
    });
  });

  describe('declaration precedence at every depth (review round 1)', () => {
    /** `tag` declared on a branch only, under a nested `allOf` on a branch only, by an enum member, and by a plain string member. */
    const branch: SchemaObject = { oneOf: [obj({ tag: int }), obj({ other: str })] };
    const nestedBranch: SchemaObject = { allOf: [branch] };
    const enumMember = obj({ tag: { type: 'string', enum: ['a', 'b'] } });
    const stringMember = obj({ tag: str });
    const tagOf = (spec: ApiSpec, name: string): string | undefined =>
      fieldsOf(spec, name).find((f) => f.startsWith('tag'));

    it('the first always-applying declaration wins, over a branch before it and a member after it', async () => {
      const { spec, warnings } = await parse(
        'three-members',
        specDoc({}, { Comp: { allOf: [branch, enumMember, stringMember] } }),
      );
      // Before: the string member replaced the enum, since the branch's entry stayed replaceable.
      expect(fieldsOf(spec, 'Comp')).toEqual(['tag?: CompTag', 'other?: string']);
      expect(spec.enums.find((e) => e.name === 'CompTag')?.values.map((v) => v.value)).toEqual(['a', 'b']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Comp']);
    });

    it("a nested union's branch literal does not beat a later outer member's string", async () => {
      const { spec, warnings } = await parse(
        'nested-literal',
        specDoc(
          {},
          {
            Comp: {
              allOf: [{ allOf: [{ oneOf: [obj({ tag: { const: 'a' } }), obj({ other: str })] }] }, obj({ tag: str })],
            },
          },
        ),
      );
      // `tag` is the string every instance carries, so a value the other
      // branch allows is accepted; before, the nested branch's literal won.
      expect(fieldsOf(spec, 'Comp')).toEqual(['tag?: string', 'other?: string']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Comp']);
    });

    it('a branch-only declaration stays branch-only two $ref levels down', async () => {
      const { spec, warnings } = await parse(
        'two-levels',
        specDoc(
          {},
          {
            Inner: { allOf: [{ oneOf: [obj({ x: int }), obj({ y: str })] }] },
            Mid: { allOf: [ref('Inner')] },
            Outer: { allOf: [ref('Mid'), obj({ x: str }, { required: ['x'] })] },
          },
        ),
      );
      expect(fieldsOf(spec, 'Inner')).toEqual(['x?: integer', 'y?: string']);
      expect(fieldsOf(spec, 'Mid')).toEqual(['x?: integer', 'y?: string']);
      expect(fieldsOf(spec, 'Outer')).toEqual(['x: string', 'y?: string']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Inner', 'Mid', 'Outer']);
    });

    it('a property named like an `Object.prototype` member reaches the dispatcher and every variant', async () => {
      // Built with `Object.fromEntries`, since `{ __proto__: … }` in a literal sets the prototype.
      const protoProps = Object.fromEntries([
        ['constructor', str],
        ['toString', str],
        ['__proto__', str],
      ]) as Record<string, SchemaObject>;
      const { spec, warnings } = await parse(
        'proto-dispatcher',
        specDoc(
          {},
          {
            Disp: {
              allOf: [
                {
                  oneOf: [
                    obj({ kind: { const: 'a' }, a: str }),
                    obj({ kind: { const: 'b' }, b: str }),
                    // A variant wrapped in its own `allOf`, narrowing `__proto__`.
                    { allOf: [obj({ kind: { const: 'c' } }), obj(Object.fromEntries([['__proto__', int]]))] },
                  ],
                },
              ],
              properties: protoProps,
              required: ['constructor'],
            },
          },
        ),
      );
      const disp = modelOf(spec, 'Disp');
      expect(fieldsOf(spec, 'Disp')).toEqual(['constructor: string', 'toString?: string', '__proto__?: string']);
      expect(disp.discriminator?.property).toBe('kind');
      const mapping = disp.discriminator!.mapping;
      expect(Object.keys(mapping).sort()).toEqual(['a', 'b', 'c']);
      expect(fieldsOf(spec, mapping.a!)).toEqual([
        'constructor: string',
        'toString?: string',
        '__proto__?: string',
        'kind?: "a"',
        'a?: string',
      ]);
      expect(fieldsOf(spec, mapping.b!)).toEqual([
        'constructor: string',
        'toString?: string',
        '__proto__?: string',
        'kind?: "b"',
        'b?: string',
      ]);
      expect(fieldsOf(spec, mapping.c!)).toEqual([
        'constructor: string',
        'toString?: string',
        '__proto__?: integer',
        'kind?: "c"',
      ]);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Disp']);
    });

    it("a field's type is the first always-applying declaration's, whatever the member order", async () => {
      const memberOf = { branch, nestedBranch, enum: enumMember, string: stringMember };
      type Kind = keyof typeof memberOf;
      const orders = permutations<Kind>(['branch', 'nestedBranch', 'enum', 'string']);
      const schemas = Object.fromEntries(
        orders.map((order, i) => [`Order${i}`, { allOf: order.map((kind) => memberOf[kind]) }]),
      );
      const { spec, warnings } = await parse('orderings', specDoc({}, schemas));
      for (const [i, order] of orders.entries()) {
        const name = `Order${i}`;
        const first = order.find((kind) => kind === 'enum' || kind === 'string');
        const expected = first === 'enum' ? `${name}Tag` : 'string';
        expect(tagOf(spec, name), `${name}: ${order.join(' > ')}`).toBe(`tag?: ${expected}`);
        expect(fieldsOf(spec, name), name).toContain('other?: string');
      }
      expect(warnings).toEqual([]);
      expectSound(spec, Object.keys(schemas));
    });
  });

  describe('nested models are built from the declaration the field is typed from (review round 2)', () => {
    /** A `oneOf` branch declaring an object `child`, under an `allOf`. */
    const Inner: SchemaObject = {
      allOf: [{ oneOf: [obj({ child: obj({ branchField: str }) }), obj({ other: str })] }],
    };
    const Base = obj({ child: obj({ realField: str }) });

    it("Greptile's case: a member's declaration types the field and builds its model, not an earlier branch's", async () => {
      const { spec, warnings } = await parse(
        'chosen-declaration',
        specDoc({}, { Inner, Base, Outer: { allOf: [ref('Inner'), ref('Base')] } }),
      );
      expect(fieldsOf(spec, 'Outer')).toEqual(['child?: OuterChild', 'other?: string']);
      // Before: `OuterChild { branchField }`, the first declaration the lookup met.
      expect(fieldsOf(spec, 'OuterChild')).toEqual(['realField?: string']);
      expect(fieldsOf(spec, 'InnerChild')).toEqual(['branchField?: string']);
      expect(fieldsOf(spec, 'BaseChild')).toEqual(['realField?: string']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Inner', 'Base', 'Outer']);
    });

    it("a branch's declaration is the fallback when no member always declares the field", async () => {
      const { spec, warnings } = await parse(
        'branch-fallback',
        specDoc({}, { Inner, Lone: { allOf: [ref('Inner'), obj({ extra: str })] } }),
      );
      expect(fieldsOf(spec, 'Lone')).toEqual(['child?: LoneChild', 'other?: string', 'extra?: string']);
      expect(fieldsOf(spec, 'LoneChild')).toEqual(['branchField?: string']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Inner', 'Lone']);
    });

    it('array items under the field come from the chosen declaration too', async () => {
      const InnerItems: SchemaObject = {
        allOf: [
          { oneOf: [obj({ children: { type: 'array', items: obj({ branchField: str }) } }), obj({ other: str })] },
        ],
      };
      const BaseItems = obj({ children: { type: 'array', items: obj({ realField: str }) } });
      const { spec, warnings } = await parse(
        'nested-items',
        specDoc({}, { InnerItems, BaseItems, OuterItems: { allOf: [ref('InnerItems'), ref('BaseItems')] } }),
      );
      const children = modelOf(spec, 'OuterItems').fields.find((f) => f.name === 'children')!.type;
      expect(children.kind).toBe('array');
      const item = children.kind === 'array' ? children.items : children;
      expect(fieldsOf(spec, show(item))).toEqual(['realField?: string']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['InnerItems', 'BaseItems', 'OuterItems']);
    });

    it("every ordering of four members builds the nested model from the chosen declaration's fields", async () => {
      const branch: SchemaObject = { oneOf: [obj({ child: obj({ branchField: str }) }), obj({ other: str })] };
      const memberOf = {
        branch,
        nestedBranch: { allOf: [branch] },
        a: obj({ child: obj({ aField: str }) }),
        b: obj({ child: obj({ bField: str }) }),
      };
      type Kind = keyof typeof memberOf;
      const orders = permutations<Kind>(['branch', 'nestedBranch', 'a', 'b']);
      const schemas = Object.fromEntries(
        orders.map((order, i) => [`Nest${i}`, { allOf: order.map((kind) => memberOf[kind]) }]),
      );
      const { spec, warnings } = await parse('nested-orderings', specDoc({}, schemas));
      for (const [i, order] of orders.entries()) {
        const name = `Nest${i}`;
        const label = `${name}: ${order.join(' > ')}`;
        const chosen = order.find((kind) => kind === 'a' || kind === 'b')!;
        const child = modelOf(spec, name).fields.find((f) => f.name === 'child')!.type;
        expect(show(child), label).toBe(`${name}Child`);
        // The one model of that name has the chosen declaration's field; the
        // other member's declaration minted nothing.
        expect(fieldsOf(spec, `${name}Child`), label).toEqual([`${chosen}Field?: string`]);
        expect(
          modelNames(spec).filter((n) => n === `${name}Child`),
          label,
        ).toHaveLength(1);
      }
      expect(warnings).toEqual([]);
      expectSound(spec, Object.keys(schemas));
    });

    it('the same without a $ref: a oneOf member on the component itself, then a member always declaring the field', async () => {
      const { spec, warnings } = await parse(
        'inline-branch-then-member',
        specDoc(
          {},
          {
            Base,
            Note: { allOf: [{ oneOf: [obj({ child: obj({ branchField: str }) }), obj({ other: str })] }, ref('Base')] },
          },
        ),
      );
      expect(fieldsOf(spec, 'Note')).toEqual(['child?: NoteChild', 'other?: string']);
      expect(fieldsOf(spec, 'NoteChild')).toEqual(['realField?: string']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Base', 'Note']);
    });
  });

  describe('review (MichaelDeBoey)', () => {
    it('a `required` beside a lone $ref, or a second $ref, makes the schema the merge at every site; a bare $ref stays the reference', async () => {
      // `Loose.tag` is optional; a `required` beside the `$ref` makes it required.
      const Loose = obj({ tag: str });
      const refRequired: SchemaObject = { allOf: [ref('Loose')], required: ['tag'] };
      const memberRequired: SchemaObject = { allOf: [ref('Loose'), { required: ['tag'] }] };
      const { spec, warnings } = await parse(
        'required-beside-ref',
        specDoc(
          {
            '/a': getOp('refRequired', refRequired),
            '/b': getOp('memberRequired', memberRequired),
            '/c': getOp('bareRef', { allOf: [ref('Loose')] }),
            '/d': getOp('refDoc', { allOf: [ref('Loose'), { description: 'doc' }] }),
          },
          {
            Loose,
            Owner: obj({ id: str }, { required: ['id'] }),
            Holder: obj({ req: refRequired, member: memberRequired, bare: { allOf: [ref('Loose')] } }),
            // The component rule, the same schema under `components.schemas`.
            Pup: { allOf: [ref('Loose')], required: ['tag'] },
          },
        ),
      );
      const ops = opsOf(spec);
      expect(show(ops.refRequired!.response)).toBe('RefRequiredResponse');
      expect(fieldsOf(spec, 'RefRequiredResponse')).toEqual(['tag: string']);
      expect(show(ops.memberRequired!.response)).toBe('MemberRequiredResponse');
      expect(fieldsOf(spec, 'MemberRequiredResponse')).toEqual(['tag: string']);
      expect(show(ops.bareRef!.response)).toBe('Loose');
      expect(show(ops.refDoc!.response)).toBe('Loose');
      expect(fieldsOf(spec, 'Holder')).toEqual(['req?: HolderReq', 'member?: HolderMember', 'bare?: Loose']);
      expect(fieldsOf(spec, 'HolderReq')).toEqual(['tag: string']);
      expect(fieldsOf(spec, 'HolderMember')).toEqual(['tag: string']);
      expect(fieldsOf(spec, 'Pup')).toEqual(['tag: string']);
      expect(fieldsOf(spec, 'Loose')).toEqual(['tag?: string']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Loose', 'Owner', 'Holder', 'Pup']);
    });

    it("a member's own properties beside its oneOf/anyOf are read: a $ref member's component, an inline member, the dispatcher axis", async () => {
      const flatMember: SchemaObject = {
        properties: { x: str },
        required: ['x'],
        oneOf: [obj({ a: str }), obj({ b: str })],
      };
      const { spec, warnings } = await parse(
        'member-properties-beside-union',
        specDoc(
          { '/dogs': getOp('getDog', { allOf: [ref('Pet'), flatMember] }) },
          {
            Pet: pet,
            // The component's own model keeps the documented rule: the object, variants not read.
            Base: { properties: { id: str }, required: ['id'], oneOf: [obj({ a: str }), obj({ b: str })] },
            Pup: { allOf: [ref('Base')], properties: { breed: str } },
            Dog: { allOf: [ref('Pet'), flatMember] },
            Disp: {
              allOf: [
                ref('Pet'),
                {
                  properties: { x: str },
                  required: ['x'],
                  oneOf: [obj({ kind: { const: 'a' }, a: str }), obj({ kind: { const: 'b' }, b: str })],
                },
              ],
            },
          },
        ),
      );
      expect(fieldsOf(spec, 'Base')).toEqual(['id: string']);
      expect(fieldsOf(spec, 'Pup')).toEqual(['breed?: string', 'id: string', 'a?: string', 'b?: string']);
      expect(fieldsOf(spec, 'Dog')).toEqual(['name: string', 'x: string', 'a?: string', 'b?: string']);
      // The same schema as a response body has the same fields.
      expect(fieldsOf(spec, show(opsOf(spec).getDog!.response))).toEqual(fieldsOf(spec, 'Dog'));
      expect(fieldsOf(spec, 'Disp')).toEqual(['name: string', 'x: string']);
      expect(modelOf(spec, 'Disp').discriminator?.property).toBe('kind');
      expect(fieldsOf(spec, 'DispA')).toEqual(['name: string', 'x: string', 'kind?: "a"', 'a?: string']);
      expect(fieldsOf(spec, 'DispB')).toEqual(['name: string', 'x: string', 'kind?: "b"', 'b?: string']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Pet', 'Base', 'Pup', 'Dog', 'Disp']);
    });

    it("a union no discriminator dispatches builds no variant model, so nothing nested under a branch takes a field model's name", async () => {
      const { spec, warnings } = await parse(
        'flattened-builds-no-variants',
        specDoc(
          {},
          {
            Flat: {
              allOf: [
                { oneOf: [obj({ child: obj({ branchField: str }) }, { title: 'Branch' }), obj({ other: str })] },
                obj({ child: obj({ realField: str }) }),
              ],
            },
          },
        ),
      );
      expect(fieldsOf(spec, 'Flat')).toEqual(['child?: FlatChild', 'other?: string']);
      expect(fieldsOf(spec, 'FlatChild')).toEqual(['realField?: string']);
      expect(modelNames(spec).sort()).toEqual(['Flat', 'FlatChild']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Flat']);
    });

    it('a single const-pinned variant dispatches: its model is built and the mapping names it', async () => {
      const { spec, warnings } = await parse(
        'single-variant-dispatch',
        specDoc(
          {},
          { Pet: pet, Single: { allOf: [ref('Pet'), { oneOf: [obj({ kind: { const: 'only' }, v: str })] }] } },
        ),
      );
      expect(fieldsOf(spec, 'Single')).toEqual(['name: string']);
      expect(modelOf(spec, 'Single').discriminator).toEqual({ property: 'kind', mapping: { only: 'SingleOnly' } });
      expect(fieldsOf(spec, 'SingleOnly')).toEqual(['name: string', 'kind?: "only"', 'v?: string']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Pet', 'Single']);
    });
  });
});
