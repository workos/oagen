import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';
import {
  foldSiblingProperties,
  schemaToTypeRef,
  unwrapNullableSchema,
  type SchemaObject,
} from '../../src/parser/schemas.js';
import { collectResponseHeaders, walkTypeRef } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #282: inline array items were still mistyped outside the cases #242
 * covers. (1) A request body or parameter whose items are an inline object
 * referenced a model nobody created. (2) Items that carry `properties`
 * beside a `oneOf` or `allOf` kept only the properties as a response body
 * and only the composition as a field, so one schema got two types and
 * neither had every property. (3) A list envelope's `data` written as a
 * nullable array through `oneOf`/`anyOf` was not read as a list.
 *
 * Now a parameter's inline models are created like a header's
 * (`deferParameterModels`); `properties` beside a typing composition are
 * folded into it wherever the schema sits (`foldSiblingProperties`); a
 * nullable array is the array it is however the null is written
 * (`arraySchemaOf`); and the items of every array response body are typed
 * as `<Op>Item` whatever their shape (`typeInlineItems`).
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-inline-array-items-'));
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
const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
  type: 'object',
  properties,
  ...extra,
});
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const ok = (schema: unknown) => ({ '200': { description: 'ok', ...json(schema) } });
const specDoc = (paths: Record<string, unknown>, schemas: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'inline array items', version: '1' },
  paths,
  components: { schemas },
});

// The issue's shapes, verbatim.
const pet = obj({ name: str });
const note = obj({ text: str });
const Pet = { $ref: '#/components/schemas/Pet' };
const tagged = obj({ id: str }, { oneOf: [pet, note] });
const extended = obj({ id: str }, { allOf: [Pet] });

/** The issue's rendering of a type: `Model[]`, `T | null`, `(A | B)`. */
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

const fieldsOf = (spec: ApiSpec, name: string): string[] => modelOf(spec, name).fields.map((f) => f.name);

/** The issue's projection of a model: `Name { field: type, … }`. */
const describeModel = (model: Model): string =>
  `${model.name} { ${model.fields.map((f) => `${f.name}: ${show(f.type)}`).join(', ')} }`;

/** Every type reference an operation holds, labelled by where it sits. */
function operationRefs(op: Operation): Array<[string, TypeRef]> {
  const refs: Array<[string, TypeRef]> = [[`${op.name}.response`, op.response]];
  if (op.requestBody) refs.push([`${op.name}.requestBody`, op.requestBody]);
  for (const p of [
    ...op.pathParams,
    ...op.queryParams,
    ...(op.bodyOwnedQueryParams ?? []),
    ...op.headerParams,
    ...(op.cookieParams ?? []),
  ]) {
    refs.push([`${op.name}(${p.name})`, p.type]);
  }
  for (const r of op.successResponses ?? []) refs.push([`${op.name}.${r.statusCode}`, r.type]);
  for (const e of op.errors) if (e.type) refs.push([`${op.name}.${e.statusCode}`, e.type]);
  if (op.defaultResponse?.type) refs.push([`${op.name}.default`, op.defaultResponse.type]);
  for (const r of op.rangeResponses ?? []) if (r.type) refs.push([`${op.name}.${r.range}`, r.type]);
  for (const h of collectResponseHeaders(op)) refs.push([`${op.name}.${h.name}`, h.type]);
  if (op.pagination) refs.push([`${op.name}.items`, op.pagination.itemType]);
  for (const f of op.pagination?.envelopeFields ?? []) refs.push([`${op.name}.${f.name}`, f.type]);
  return refs;
}

/**
 * The IR is sound: every model and enum reference resolves, and every model
 * or enum that is not a component is reachable from an operation, a
 * webhook or a model's field — nothing minted is left orphaned.
 */
function expectSound(spec: ApiSpec, components: readonly string[] = []): void {
  const models = new Set(spec.models.map((m) => m.name));
  const enums = new Set(spec.enums.map((e) => e.name));
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
    for (const [label, type] of operationRefs(op)) visit(label, type);
  }
  for (const hook of spec.webhooks ?? []) {
    if (hook.requestBody) visit(`${hook.name}.payload`, hook.requestBody);
    for (const p of [...hook.queryParams, ...hook.headerParams, ...(hook.cookieParams ?? [])]) {
      visit(`${hook.name}(${p.name})`, p.type);
    }
  }
  for (const model of spec.models) for (const field of model.fields) visit(`${model.name}.${field.name}`, field.type);
  for (const model of spec.models) for (const variant of model.variants ?? []) visit(`${model.name}|`, variant);
  expect(dangling).toEqual([]);
  const orphans = [...models, ...enums].filter((name) => !reached.has(name) && !components.includes(name));
  expect(orphans).toEqual([]);
  // No name is both a model's and an enum's.
  expect([...models].filter((name) => enums.has(name))).toEqual([]);
}

describe('the issue, verbatim', () => {
  const doc = specDoc(
    {
      '/pets': {
        post: { operationId: 'createPets', requestBody: json({ items: pet }), responses: ok(Pet) },
        get: {
          operationId: 'listPets',
          parameters: [{ name: 'filter', in: 'query', schema: { items: pet } }],
          responses: ok(Pet),
        },
      },
      '/pets/tagged': { get: { operationId: 'listTaggedPets', responses: ok({ items: tagged }) } },
      '/pets/extended': { get: { operationId: 'listExtendedPets', responses: ok({ items: extended }) } },
      '/owners/{id}': {
        get: {
          operationId: 'getOwner',
          parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
          responses: ok(obj({ extended: { items: extended }, tagged: { items: tagged } })),
        },
      },
      '/events': {
        get: {
          operationId: 'listEvents',
          parameters: [{ name: 'after', in: 'query', schema: str }],
          responses: ok(
            obj({
              data: { items: pet, oneOf: [{ items: pet }, { type: 'null' }] },
              list_metadata: obj({ after: str }),
            }),
          ),
        },
      },
    },
    { Pet: pet },
  );

  it('prints what the issue expects, with no warning', async () => {
    const { spec, warnings } = await parse('issue', doc);
    const ops = opsOf(spec);
    expect({
      createPets: show(ops.createPets.requestBody!),
      listPetsFilter: show(ops.listPets.queryParams[0].type),
      listTaggedPets: show(ops.listTaggedPets.response),
      listExtendedPets: show(ops.listExtendedPets.response),
      listEvents: { pagination: ops.listEvents.pagination?.dataPath, response: show(ops.listEvents.response) },
      models: spec.models.map(describeModel),
    }).toEqual({
      // (1) The item models are created, for the body and the parameter.
      createPets: 'CreatePetsRequest[]',
      listPetsFilter: 'PetsFilter[]',
      // (2) The same item schema is the same type wherever it appears,
      // carrying both its properties and its composition.
      listTaggedPets: '(ListTaggedPetsItem | ListTaggedPetsItemWithText)[]',
      listExtendedPets: 'ListExtendedPetsItem[]',
      // (3) A `data` that is a nullable array, however the null is written,
      // is read as the list it is.
      listEvents: { pagination: 'data', response: 'ListEventsItem[] | null' },
      models: [
        'Pet { name: string }',
        'CreatePetsRequest { name: string }',
        'ListTaggedPetsItem { id: string, name: string }',
        'ListTaggedPetsItemWithText { id: string, text: string }',
        'ListExtendedPetsItem { id: string, name: string }',
        'GetOwnerResponse { extended: GetOwnerResponseExtended[], tagged: (GetOwnerResponseTagged | GetOwnerResponseTaggedWithText)[] }',
        'GetOwnerResponseExtended { id: string, name: string }',
        'GetOwnerResponseTagged { id: string, name: string }',
        'GetOwnerResponseTaggedWithText { id: string, text: string }',
        'ListEventsItem { name: string }',
        'ListMetadata { after: string }',
        'PetsFilter { name: string }',
      ],
    });
    expect(ops.listEvents.pagination?.itemType).toEqual({ kind: 'model', name: 'ListEventsItem' });
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet']);
  });
});

describe('(1) a parameter creates the models its schema references', () => {
  const list = (parameters: unknown[], operationId = 'listPets') => ({
    get: { operationId, parameters, responses: ok(Pet) },
  });

  it('creates the model of an inline object parameter (`style: deepObject`) and of an array of them, in every location', async () => {
    const { spec, warnings } = await parse(
      'param-locations',
      specDoc(
        {
          '/pets': list([
            { name: 'filter', in: 'query', style: 'deepObject', schema: pet },
            { name: 'sorts', in: 'query', schema: { type: 'array', items: obj({ field: str }) } },
            { name: 'bare', in: 'query', schema: { items: obj({ field: str }) } },
            { name: 'X-Trace', in: 'header', schema: obj({ id: str }) },
            { name: 'session', in: 'cookie', schema: obj({ token: str }) },
          ]),
          '/pets/{where}': list([{ name: 'where', in: 'path', required: true, schema: obj({ lat: str }) }], 'getPet'),
        },
        { Pet: pet },
      ),
    );
    const ops = opsOf(spec);
    const paramTypes = (op: Operation) =>
      Object.fromEntries(
        [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])].map((p) => [
          p.name,
          show(p.type),
        ]),
      );
    expect(paramTypes(ops.listPets)).toEqual({
      filter: 'PetsFilter',
      sorts: 'PetsSort[]',
      bare: 'PetsBare[]',
      'X-Trace': 'PetsXTrace',
      session: 'PetsSession',
    });
    expect(paramTypes(ops.getPet)).toEqual({ where: 'PetsWhere' });
    expect(fieldsOf(spec, 'PetsFilter')).toEqual(['name']);
    expect(fieldsOf(spec, 'PetsSort')).toEqual(['field']);
    expect(fieldsOf(spec, 'PetsBare')).toEqual(['field']);
    expect(fieldsOf(spec, 'PetsXTrace')).toEqual(['id']);
    expect(fieldsOf(spec, 'PetsSession')).toEqual(['token']);
    expect(fieldsOf(spec, 'PetsWhere')).toEqual(['lat']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet']);
  });

  it('materializes what the parameter references at any depth: nested objects, union variants, map values, nullable wrappers', async () => {
    const { spec, warnings } = await parse(
      'param-depth',
      specDoc(
        {
          '/pets': list([
            { name: 'owner', in: 'query', schema: obj({ address: obj({ city: str }) }) },
            { name: 'shape', in: 'query', schema: { oneOf: [obj({ radius: str }), obj({ side: str })] } },
            { name: 'labels', in: 'query', schema: { type: 'object', additionalProperties: obj({ text: str }) } },
            { name: 'maybe', in: 'query', schema: { oneOf: [obj({ flag: str }), { type: 'null' }] } },
          ]),
        },
        { Pet: pet },
      ),
    );
    const op = opsOf(spec).listPets;
    expect(Object.fromEntries(op.queryParams.map((p) => [p.name, show(p.type)]))).toEqual({
      owner: 'PetsOwner',
      shape: '(PetsShape | PetsShapeWithSide)',
      labels: 'map<PetsLabel>',
      maybe: 'PetsMaybe | null',
    });
    expect(fieldsOf(spec, 'PetsOwner')).toEqual(['address']);
    expect(fieldsOf(spec, 'PetsOwnerAddress')).toEqual(['city']);
    expect(fieldsOf(spec, 'PetsShape')).toEqual(['radius']);
    expect(fieldsOf(spec, 'PetsShapeWithSide')).toEqual(['side']);
    expect(fieldsOf(spec, 'PetsLabel')).toEqual(['text']);
    expect(fieldsOf(spec, 'PetsMaybe')).toEqual(['flag']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet']);
  });

  it('leaves a parameter that mints no model as it was: a primitive, a `$ref`, an inline enum, an array of either', async () => {
    const { spec, warnings } = await parse(
      'param-no-model',
      specDoc(
        {
          '/pets': list([
            { name: 'name', in: 'query', schema: str },
            { name: 'pet', in: 'query', schema: Pet },
            { name: 'kind', in: 'query', schema: { type: 'string', enum: ['cat', 'dog'] } },
            { name: 'kinds', in: 'query', schema: { type: 'array', items: { type: 'string', enum: ['cat', 'dog'] } } },
            { name: 'pets', in: 'query', schema: { type: 'array', items: Pet } },
          ]),
        },
        { Pet: pet },
      ),
    );
    const op = opsOf(spec).listPets;
    expect(Object.fromEntries(op.queryParams.map((p) => [p.name, show(p.type)]))).toEqual({
      name: 'string',
      pet: 'Pet',
      kind: 'PetsKind',
      kinds: 'PetsKinds[]',
      pets: 'Pet[]',
    });
    expect(spec.models.map((m) => m.name)).toEqual(['Pet']);
    expect(spec.enums.map((e) => e.name).sort()).toEqual(['PetsKind', 'PetsKinds']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet']);
  });

  it('shares one model for the same shape and qualifies a different one, like a header', async () => {
    const { spec, warnings } = await parse(
      'param-clash',
      specDoc(
        {
          // The same `filter` shape on two operations of one service shares `PetsFilter`.
          '/pets': list([{ name: 'filter', in: 'query', schema: pet }], 'listPets'),
          '/pets/{id}/toys': list(
            [
              { name: 'id', in: 'path', required: true, schema: str },
              { name: 'filter', in: 'query', schema: pet },
            ],
            'listToys',
          ),
          // A different shape under the same name on another operation is
          // qualified by the operation.
          '/pets/{id}/vets': list(
            [
              { name: 'id', in: 'path', required: true, schema: str },
              { name: 'filter', in: 'query', schema: obj({ city: str }) },
            ],
            'listVets',
          ),
          // One name in two locations of one operation: the second is
          // qualified by its location.
          '/pets/{id}/walks': list(
            [
              { name: 'id', in: 'path', required: true, schema: str },
              { name: 'range', in: 'query', schema: obj({ from: str }) },
              { name: 'range', in: 'header', schema: obj({ unit: str }) },
            ],
            'listWalks',
          ),
          // A name a component owns with another shape moves to the operation-qualified name.
          '/pets/{id}/foods': list(
            [
              { name: 'id', in: 'path', required: true, schema: str },
              { name: 'brand', in: 'query', schema: obj({ label: str }) },
            ],
            'listFoods',
          ),
        },
        { Pet: pet, PetsBrand: obj({ code: str }) },
      ),
    );
    const ops = opsOf(spec);
    const query = (op: Operation, name: string) => show(op.queryParams.find((p) => p.name === name)!.type);
    expect(query(ops.listPets, 'filter')).toBe('PetsFilter');
    expect(query(ops.listToys, 'filter')).toBe('PetsFilter');
    expect(query(ops.listVets, 'filter')).toBe('PetsListVetsFilter');
    expect(query(ops.listWalks, 'range')).toBe('PetsRange');
    expect(show(ops.listWalks.headerParams[0].type)).toBe('PetsHeaderRange');
    expect(query(ops.listFoods, 'brand')).toBe('PetsListFoodsBrand');
    expect(fieldsOf(spec, 'PetsFilter')).toEqual(['name']);
    expect(fieldsOf(spec, 'PetsListVetsFilter')).toEqual(['city']);
    expect(fieldsOf(spec, 'PetsRange')).toEqual(['from']);
    expect(fieldsOf(spec, 'PetsHeaderRange')).toEqual(['unit']);
    expect(fieldsOf(spec, 'PetsBrand')).toEqual(['code']);
    expect(fieldsOf(spec, 'PetsListFoodsBrand')).toEqual(['label']);
    expect(spec.models.filter((m) => m.name === 'PetsFilter')).toHaveLength(1);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet', 'PetsBrand']);
  });

  it('types a query parameter the body owns too, and the body of an array of inline objects, typed or not', async () => {
    const { spec, warnings } = await parse(
      'body-owned-and-array-body',
      specDoc(
        {
          '/pets': {
            post: {
              operationId: 'createPets',
              parameters: [{ name: 'owner', in: 'query', schema: obj({ name: str }) }],
              requestBody: json(obj({ owner: obj({ name: str }), pets: { items: pet } })),
              responses: ok(Pet),
            },
          },
          '/typed': {
            post: { operationId: 'createTyped', requestBody: json({ type: 'array', items: pet }), responses: ok(Pet) },
          },
          '/untyped': { post: { operationId: 'createUntyped', requestBody: json({ items: pet }), responses: ok(Pet) } },
        },
        { Pet: pet },
      ),
    );
    const ops = opsOf(spec);
    expect(ops.createPets.queryParams).toEqual([]);
    expect(show(ops.createPets.bodyOwnedQueryParams![0].type)).toBe('PetsOwner');
    expect(fieldsOf(spec, 'PetsOwner')).toEqual(['name']);
    expect(show(ops.createTyped.requestBody!)).toBe('CreateTypedRequest[]');
    expect(show(ops.createUntyped.requestBody!)).toBe('CreateUntypedRequest[]');
    expect(fieldsOf(spec, 'CreateTypedRequest')).toEqual(['name']);
    expect(fieldsOf(spec, 'CreateUntypedRequest')).toEqual(['name']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet']);
  });
});

describe('(2) `properties` beside a composition are carried into it, wherever the schema sits', () => {
  /** `schema` as a response body, a list envelope's items, a request body, a parameter, a header and a component field. */
  const everySite = (schema: SchemaObject) =>
    specDoc(
      {
        '/things': {
          post: {
            operationId: 'createThing',
            parameters: [{ name: 'where', in: 'query', schema }],
            requestBody: json(schema),
            responses: {
              '200': { description: 'ok', ...json(schema), headers: { 'X-Thing': { schema } } },
            },
          },
          get: { operationId: 'listThings', responses: ok({ type: 'array', items: schema }) },
        },
        '/pages': {
          get: {
            operationId: 'listPages',
            parameters: [{ name: 'after', in: 'query', schema: str }],
            responses: ok(obj({ data: { items: schema }, list_metadata: obj({ after: str }) })),
          },
        },
      },
      { Holder: obj({ thing: schema }), Pet: pet },
    );
  const everySiteComponents = ['Holder', 'Pet'];

  /** The name each site's model takes. */
  const bases = {
    response: 'CreateThingResponse',
    item: 'ListThingsItem',
    page: 'ListPagesItem',
    body: 'CreateThingRequest',
    param: 'ThingsWhere',
    header: 'ThingsXThing',
    field: 'HolderThing',
  };

  function siteTypes(spec: ApiSpec): Record<keyof typeof bases, string> {
    const ops = opsOf(spec);
    return {
      response: show(ops.createThing.response),
      item: show(ops.listThings.response),
      page: show(ops.listPages.response),
      body: show(ops.createThing.requestBody!),
      param: show(ops.createThing.queryParams[0].type),
      header: show(ops.createThing.responseHeaders![0].type),
      field: show(modelOf(spec, 'Holder').fields[0].type),
    };
  }

  it("an allOf of a `$ref` becomes the augmentation, the schema's own properties first, at every site", async () => {
    const { spec, warnings } = await parse('allof-ref', everySite(extended));
    const expected = Object.fromEntries(
      Object.entries(bases).map(([site, base]) => [site, site === 'item' || site === 'page' ? `${base}[]` : base]),
    );
    expect(siteTypes(spec)).toEqual(expected);
    for (const base of Object.values(bases)) expect(fieldsOf(spec, base), base).toEqual(['id', 'name']);
    expect(opsOf(spec).listPages.pagination?.itemType).toEqual({ kind: 'model', name: 'ListPagesItem' });
    expect(warnings).toEqual([]);
    expectSound(spec, everySiteComponents);
  });

  it('a oneOf of inline objects keeps every variant, each carrying the properties, at every site', async () => {
    const { spec, warnings } = await parse('oneof-objects', everySite(tagged));
    const expected = Object.fromEntries(
      Object.entries(bases).map(([site, base]) => {
        const union = `(${base} | ${base}WithText)`;
        return [site, site === 'item' || site === 'page' ? `${union}[]` : union];
      }),
    );
    expect(siteTypes(spec)).toEqual(expected);
    for (const base of Object.values(bases)) {
      expect(fieldsOf(spec, base), base).toEqual(['id', 'name']);
      expect(fieldsOf(spec, `${base}WithText`), base).toEqual(['id', 'text']);
    }
    expect(warnings).toEqual([]);
    expectSound(spec, everySiteComponents);
  });

  it('an anyOf, a single inline allOf member, an allOf of inline members, and a nullable object variant take them too', async () => {
    const { spec, warnings } = await parse(
      'other-compositions',
      specDoc(
        {},
        {
          Pet: pet,
          Holder: obj({
            any: obj({ id: str }, { anyOf: [pet, note] }),
            single: obj({ id: str }, { allOf: [pet] }),
            members: obj({ id: str }, { allOf: [pet, note] }),
            nullable: obj({ id: str }, { oneOf: [{ type: ['object', 'null'], properties: { name: str } }, note] }),
            typed: obj({ id: str }, { oneOf: [{ nullable: true, ...pet }, note] }),
            // Required names are the union of both lists; the schema's own
            // declaration wins where both declare a property.
            required: obj(
              { id: str, name: { type: 'string', maxLength: 3 } },
              { required: ['id'], oneOf: [{ ...pet, required: ['name'] }, note] },
            ),
          }),
        },
      ),
    );
    const holder = modelOf(spec, 'Holder');
    const typeOf = (name: string) => show(holder.fields.find((f) => f.name === name)!.type);
    expect(typeOf('any')).toBe('(HolderAny | HolderAnyWithText)');
    expect(typeOf('single')).toBe('HolderSingle');
    expect(typeOf('members')).toBe('HolderMember');
    expect(typeOf('nullable')).toBe('(HolderNullable | null | HolderNullableWithText)');
    expect(typeOf('typed')).toBe('(HolderTyped | null | HolderTypedWithText)');
    expect(typeOf('required')).toBe('(HolderRequired | HolderRequiredWithText)');
    expect(fieldsOf(spec, 'HolderAny')).toEqual(['id', 'name']);
    expect(fieldsOf(spec, 'HolderAnyWithText')).toEqual(['id', 'text']);
    expect(fieldsOf(spec, 'HolderSingle')).toEqual(['id', 'name']);
    expect(fieldsOf(spec, 'HolderMember')).toEqual(['id', 'name', 'text']);
    expect(fieldsOf(spec, 'HolderNullable')).toEqual(['id', 'name']);
    expect(fieldsOf(spec, 'HolderTyped')).toEqual(['id', 'name']);
    const required = modelOf(spec, 'HolderRequired');
    expect(required.fields.map((f) => [f.name, f.required, f.constraints])).toEqual([
      ['id', true, undefined],
      ['name', true, { maxLength: 3 }],
    ]);
    expect(modelOf(spec, 'HolderRequiredWithText').fields.map((f) => [f.name, f.required])).toEqual([
      ['id', true],
      ['name', false],
      ['text', false],
    ]);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Holder', 'Pet']);
  });

  it('types a variant that cannot take them as written and says so once, with the context', async () => {
    const { spec, warnings } = await parse(
      'uncarried',
      specDoc(
        {
          '/things': {
            get: {
              operationId: 'getThing',
              responses: ok(obj({ mixed: obj({ id: str }, { oneOf: [Pet, pet, str, { allOf: [Pet] }] }) })),
            },
          },
        },
        { Pet: pet },
      ),
    );
    const response = modelOf(spec, 'GetThingResponse');
    // The `$ref` and the `allOf` are typed as written; the inline object
    // takes the properties; the string is no object and is not reported.
    expect(show(response.fields[0].type)).toBe('(Pet | GetThingResponseMixed | string | Pet)');
    expect(fieldsOf(spec, 'GetThingResponseMixed')).toEqual(['id', 'name']);
    expect(warnings).toEqual([
      '[oagen] Warning: `properties` beside `oneOf` are carried into its inline object variants only; variants 1, 4 are typed as written, without them (context: GetThingResponse.mixed)',
    ]);
    expectSound(spec, ['Pet']);
  });

  it('is not an object that only carries limits beside its composition, nor a composition of bare limits', () => {
    // `allOf`/`oneOf` of bare limits do not type the schema: it stays the object.
    const limits = obj(
      { id: str },
      { allOf: [{ minProperties: 1 }], oneOf: [{ required: ['id'] }, { maxProperties: 3 }] },
    );
    expect(foldSiblingProperties(limits)).toBe(limits);
    // A schema whose `type` admits no object is left alone.
    const typed: SchemaObject = { type: 'string', properties: { id: str }, oneOf: [pet] };
    expect(foldSiblingProperties(typed)).toBe(typed);
    // Folding a folded schema changes nothing.
    const folded = foldSiblingProperties(tagged);
    expect(folded).not.toBe(tagged);
    expect(folded.properties).toBeUndefined();
    expect(foldSiblingProperties(folded)).toBe(folded);
    // The document's schema is untouched.
    expect(tagged.properties).toEqual({ id: str });
    expect(tagged.oneOf).toEqual([pet, note]);
    // The extractors' unwrap folds first, so a nullable union beside
    // `properties` collapses onto a variant that carries them.
    expect(unwrapNullableSchema(obj({ id: str }, { oneOf: [pet, { type: 'null' }] }))).toEqual(
      obj({ id: str, name: str }),
    );
    expect(show(schemaToTypeRef(obj({ id: str }, { oneOf: [pet, { type: 'null' }] }), 'thing', 'Holder'))).toBe(
      'HolderThing | null',
    );
  });

  it("keeps a title-mapped union's title, with the model carrying the properties, and contests it by the folded shape", async () => {
    const circle = (extra: Record<string, SchemaObject>) =>
      obj({ kind: { const: 'circle' }, ...extra }, { title: 'Circle' });
    const square = obj({ kind: { const: 'square' }, side: str }, { title: 'Square' });
    const { spec, warnings } = await parse(
      'titled',
      specDoc(
        {},
        {
          Pet: pet,
          Drawing: obj({
            shape: obj({ id: str }, { oneOf: [circle({ radius: str }), square] }),
            // The same titled variants, with other properties beside the union:
            // `Circle` names two shapes under one root, so neither keeps it.
            marker: obj({ color: str }, { oneOf: [circle({ radius: str }), square] }),
          }),
        },
      ),
    );
    const drawing = modelOf(spec, 'Drawing');
    expect(show(drawing.fields[0].type)).toBe('(CircleDrawingShape | SquareDrawingShape)');
    expect(show(drawing.fields[1].type)).toBe('(CircleDrawingMarker | SquareDrawingMarker)');
    expect(fieldsOf(spec, 'CircleDrawingShape')).toEqual(['id', 'kind', 'radius']);
    expect(fieldsOf(spec, 'CircleDrawingMarker')).toEqual(['color', 'kind', 'radius']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Drawing', 'Pet']);
  });
});

describe('review round 1', () => {
  const list = (operationId: string, parameters: unknown[], extra: Record<string, unknown> = {}) => ({
    get: { operationId, parameters, responses: ok(Pet), ...extra },
  });

  it('a parameter model never takes the name of a component enum or of an enum another parameter lifts', async () => {
    const { spec, warnings } = await parse(
      'enum-names',
      specDoc(
        {
          // A component enum `PetsFilter` owns the bare name: the object parameter steps to the operation-qualified one.
          '/pets': list('listPets', [
            { name: 'filter', in: 'query', schema: obj({ name: str }) },
            // `kind` is an inline enum here, lifted as `PetsKind` …
            { name: 'kind', in: 'query', schema: { type: 'string', enum: ['cat', 'dog'] } },
          ]),
          // … and an object on this operation, which therefore cannot be `PetsKind`.
          '/pets/search': list('searchPets', [{ name: 'kind', in: 'query', schema: obj({ species: str }) }]),
        },
        { Pet: pet, PetsFilter: { type: 'string', enum: ['open', 'closed'] } },
      ),
    );
    const ops = opsOf(spec);
    expect(show(ops.listPets.queryParams[0].type)).toBe('PetsListPetsFilter');
    expect(show(ops.listPets.queryParams[1].type)).toBe('PetsKind');
    expect(show(ops.searchPets.queryParams[0].type)).toBe('PetsSearchPetsKind');
    expect(fieldsOf(spec, 'PetsListPetsFilter')).toEqual(['name']);
    expect(fieldsOf(spec, 'PetsSearchPetsKind')).toEqual(['species']);
    expect(spec.enums.map((e) => [e.name, e.values.map((v) => v.value)])).toEqual([
      ['PetsFilter', ['open', 'closed']],
      ['PetsKind', ['cat', 'dog']],
    ]);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet', 'PetsFilter']);
  });

  it('a response header keeps its name; a header parameter of the same name takes the location-qualified one', async () => {
    const { spec, warnings } = await parse(
      'header-vs-param',
      specDoc(
        {
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [{ name: 'X-Meta', in: 'header', schema: obj({ a: str }) }],
              responses: {
                '200': { description: 'ok', ...json(Pet), headers: { 'X-Meta': { schema: obj({ b: str }) } } },
              },
            },
          },
        },
        { Pet: pet },
      ),
    );
    const op = opsOf(spec).listPets;
    expect(show(op.responseHeaders![0].type)).toBe('PetsXMeta');
    expect(show(op.headerParams[0].type)).toBe('PetsHeaderXMeta');
    expect(fieldsOf(spec, 'PetsXMeta')).toEqual(['b']);
    expect(fieldsOf(spec, 'PetsHeaderXMeta')).toEqual(['a']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet']);
  });

  it("an own `kind` enum beside an allOf member's plain `kind` stays the enum at every site", async () => {
    const kindEnum: SchemaObject = { type: 'string', enum: ['cat', 'dog'] };
    const schema = obj({ kind: kindEnum, id: str }, { allOf: [{ $ref: '#/components/schemas/Base' }] });
    const { spec, warnings } = await parse(
      'own-first',
      specDoc(
        {
          '/things': {
            post: { operationId: 'createThing', requestBody: json(schema), responses: ok(schema) },
            get: { operationId: 'listThings', responses: ok({ type: 'array', items: schema }) },
          },
        },
        { Base: obj({ kind: str, name: str }), Holder: obj({ thing: schema }) },
      ),
    );
    const ops = opsOf(spec);
    for (const name of ['CreateThingResponse', 'ListThingsItem', 'CreateThingRequest', 'HolderThing']) {
      const model = modelOf(spec, name);
      expect(
        model.fields.map((f) => [f.name, show(f.type)]),
        name,
      ).toEqual([
        ['kind', `${name}Kind`],
        ['id', 'string'],
        ['name', 'string'],
      ]);
    }
    expect(show(ops.createThing.response)).toBe('CreateThingResponse');
    expect(show(ops.listThings.response)).toBe('ListThingsItem[]');
    expect(warnings).toEqual([]);
    expectSound(spec, ['Base', 'Holder']);
  });

  it('merges two allOf declarations of a nullable data array into the array that is read, in either order', () => {
    const nullable = (items: SchemaObject | undefined) => ({
      oneOf: [{ type: 'array', ...(items && { items }) }, { type: 'null' }],
    });
    const plain = (items: SchemaObject | undefined, extra: SchemaObject = {}) => ({
      type: 'array',
      ...(items && { items }),
      ...extra,
    });
    const envelope = (first: SchemaObject, second: SchemaObject) => ({
      allOf: [
        obj({ data: first, list_metadata: obj({ after: str }) }),
        { type: 'object', properties: { data: second } },
      ],
    });
    const petList: TypeRef = {
      kind: 'nullable',
      inner: { kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } },
    };
    const cases: Array<[string, SchemaObject, SchemaObject, TypeRef]> = [
      // Nullable first: the later `items: pet` narrows the earlier `items: {}`.
      ['nullable first', nullable({}), plain(pet), petList],
      // Nullable last: the later `items: {}` narrows nothing, so the earlier `pet` stays.
      ['nullable last', plain(pet), nullable({}), petList],
      // A later declaration that narrows wins whichever side is nullable.
      [
        'nullable last, narrowed',
        plain(pet),
        nullable(note),
        { ...petList, inner: { kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } } },
      ],
      // Limits alone never change the items.
      ['limits only', nullable(pet), plain(undefined, { minItems: 1 }), petList],
      ['typed limits only', plain(pet), { type: ['array', 'null'], minItems: 1 }, petList],
    ];
    for (const [label, first, second, response] of cases) {
      const result = classifyAndExtractResponse(envelope(first, second), 'ListPetsResponse');
      expect(result.isPaginated, label).toBe(true);
      expect(result.response, label).toEqual(response);
      expect(result.itemType, label).toEqual({ kind: 'model', name: 'ListPetsItem' });
      const fields = result.inlineModels.find((m) => m.name === 'ListPetsItem')?.fields.map((f) => f.name);
      expect(fields, label).toEqual(label === 'nullable last, narrowed' ? ['text'] : ['name']);
    }
    // Neither side nullable: a plain array, the later items winning.
    const plainResult = classifyAndExtractResponse(envelope(plain({}), plain(pet)), 'ListPetsResponse');
    expect(plainResult.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } });
  });

  it("reports the variants a body cannot carry its properties into, under the body's name, for both body paths", async () => {
    const mixed = obj({ id: str }, { oneOf: [Pet, note] });
    const { spec, warnings } = await parse(
      'body-warnings',
      specDoc(
        {
          '/things': {
            post: { operationId: 'createThing', requestBody: json(mixed), responses: ok(mixed) },
          },
        },
        { Pet: pet },
      ),
    );
    const op = opsOf(spec).createThing;
    expect(show(op.requestBody!)).toBe('(Pet | CreateThingRequest)');
    expect(show(op.response)).toBe('(Pet | CreateThingResponse)');
    expect(fieldsOf(spec, 'CreateThingRequest')).toEqual(['id', 'text']);
    expect(fieldsOf(spec, 'CreateThingResponse')).toEqual(['id', 'text']);
    expect(warnings).toEqual([
      '[oagen] Warning: `properties` beside `oneOf` are carried into its inline object variants only; variant 1 is typed as written, without them (context: CreateThingRequest)',
      '[oagen] Warning: `properties` beside `oneOf` are carried into its inline object variants only; variant 1 is typed as written, without them (context: CreateThingResponse)',
    ]);
    expectSound(spec, ['Pet']);
  });

  it('types a nullable request body of any spelling as a field would, its inline items named from the body', async () => {
    const bodies: Record<string, SchemaObject> = {
      typeList: { type: ['array', 'null'], items: pet },
      nullableFlag: { type: 'array', nullable: true, items: pet },
      oneOfArray: { oneOf: [{ items: pet }, { type: 'null' }] },
      anyOfArray: { anyOf: [{ type: 'array', items: pet }, { type: 'null' }] },
      oneOfRef: { oneOf: [Pet, { type: 'null' }] },
      oneOfString: { oneOf: [str, { type: 'null' }] },
      oneOfObject: { oneOf: [pet, { type: 'null' }] },
    };
    const { spec, warnings } = await parse(
      'nullable-bodies',
      specDoc(
        Object.fromEntries(
          Object.entries(bodies).map(([name, schema]) => [
            `/${name}`,
            {
              post: {
                operationId: `create${name[0].toUpperCase()}${name.slice(1)}`,
                requestBody: json(schema),
                responses: ok(Pet),
              },
            },
          ]),
        ),
        { Pet: pet },
      ),
    );
    const ops = opsOf(spec);
    expect(Object.fromEntries(Object.entries(ops).map(([name, op]) => [name, show(op.requestBody!)]))).toEqual({
      createTypeList: 'CreateTypeListRequest[] | null',
      createNullableFlag: 'CreateNullableFlagRequest[] | null',
      createOneOfArray: 'CreateOneOfArrayRequest[] | null',
      createAnyOfArray: 'CreateAnyOfArrayRequest[] | null',
      createOneOfRef: 'Pet | null',
      createOneOfString: 'string | null',
      // A lone inline object branch stays with the body's `oneOf` branch,
      // which names it from a const it may pin (`PasswordCreateTokenRequest`)
      // and keeps the union around it, as before.
      createOneOfObject: '(CreateOneOfObjectRequest) | null',
    });
    for (const name of [
      'CreateTypeListRequest',
      'CreateNullableFlagRequest',
      'CreateOneOfArrayRequest',
      'CreateAnyOfArrayRequest',
      'CreateOneOfObjectRequest',
    ]) {
      expect(fieldsOf(spec, name), name).toEqual(['name']);
    }
    expect(warnings).toEqual([]);
    expectSound(spec, ['Pet']);
  });
});

describe('review round 2', () => {
  it('keeps a property named like an `Object.prototype` member at every merge', async () => {
    const { spec, warnings } = await parse(
      'prototype-names',
      specDoc(
        {
          '/things': {
            get: {
              operationId: 'getThing',
              responses: ok(obj({ toString: str, id: str }, { allOf: [{ $ref: '#/components/schemas/Base' }] })),
            },
          },
        },
        {
          Base: obj({ constructor: { type: 'integer' }, name: str }),
          Holder: obj({
            thing: obj({ id: str }, { oneOf: [obj({ constructor: str }, { required: ['constructor'] }), note] }),
            merged: obj({ hasOwnProperty: str }, { allOf: [obj({ valueOf: str })] }),
          }),
        },
      ),
    );
    // The response merges its own `toString` and the member's `constructor`.
    expect(modelOf(spec, 'GetThingResponse').fields.map((f) => f.name)).toEqual([
      'toString',
      'id',
      'constructor',
      'name',
    ]);
    // The variant keeps its required `constructor` beside the folded `id`.
    const variant = modelOf(spec, 'HolderThing');
    expect(variant.fields.map((f) => [f.name, f.required])).toEqual([
      ['id', false],
      ['constructor', true],
    ]);
    expect(fieldsOf(spec, 'HolderThingWithText')).toEqual(['id', 'text']);
    expect(fieldsOf(spec, 'HolderMerged')).toEqual(['hasOwnProperty', 'valueOf']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Base', 'Holder']);
  });

  it('leaves an empty `properties: {}` beside a composition as written', async () => {
    const map: SchemaObject = { type: 'object', additionalProperties: str };
    const { spec, warnings } = await parse(
      'empty-properties',
      specDoc(
        {
          '/things': {
            get: { operationId: 'getThing', responses: ok({ type: 'object', properties: {}, allOf: [Pet] }) },
            post: {
              operationId: 'createThing',
              requestBody: json({ type: 'object', properties: {}, allOf: [Pet] }),
              responses: ok({ type: 'object', properties: {}, oneOf: [pet, note] }),
            },
            put: {
              operationId: 'replaceThing',
              requestBody: json({ type: 'object', properties: {}, oneOf: [pet, note] }),
              responses: ok({ type: 'object', properties: {} }),
            },
          },
        },
        {
          Pet: pet,
          Holder: obj({
            meta: { properties: {}, allOf: [map] },
            pet: { properties: {}, allOf: [Pet] },
            either: { properties: {}, oneOf: [pet, note] },
            nested: { properties: {}, allOf: [{ oneOf: [pet, note] }] },
          }),
        },
      ),
    );
    const holder = modelOf(spec, 'Holder');
    const typeOf = (name: string) => show(holder.fields.find((f) => f.name === name)!.type);
    expect(typeOf('meta')).toBe('map<string>');
    expect(typeOf('pet')).toBe('Pet');
    expect(typeOf('either')).toBe('(HolderEither | HolderEitherWithText)');
    expect(typeOf('nested')).toBe('(HolderNested | HolderNestedWithText)');
    expect(fieldsOf(spec, 'HolderEither')).toEqual(['name']);
    // At a body root the composition is read too, never an empty model: an
    // `allOf` of a lone `$ref` is the reference a field of the same schema is
    // (workos/oagen#307: a response body was a copy of `Pet` under its own
    // name), a `oneOf` the union, and a request body the reference or union
    // a field of the same schema is.
    const ops = opsOf(spec);
    expect(show(ops.getThing.response)).toBe('Pet');
    expect(spec.models.map((m) => m.name)).not.toContain('GetThingResponse');
    expect(show(ops.createThing.requestBody!)).toBe('Pet');
    expect(show(ops.createThing.response)).toBe('(CreateThingResponse | CreateThingResponseWithText)');
    expect(fieldsOf(spec, 'CreateThingResponse')).toEqual(['name']);
    expect(show(ops.replaceThing.requestBody!)).toBe('(ReplaceThingRequest | ReplaceThingRequestWithText)');
    expect(fieldsOf(spec, 'ReplaceThingRequestWithText')).toEqual(['text']);
    // An empty object with no composition is still the empty model it was.
    expect(show(ops.replaceThing.response)).toBe('ReplaceThingResponse');
    expect(fieldsOf(spec, 'ReplaceThingResponse')).toEqual([]);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Holder', 'Pet']);
  });

  it('settles `<Op>Item` against a component of the same name: another shape steps, an identical one shares', async () => {
    const shapes = { oneOf: [obj({ radius: str }), obj({ side: str })] };
    const { spec, warnings } = await parse(
      'item-vs-component',
      specDoc(
        {
          // A component `ListShapesItem { id }` owns the bare name: the items step to `ListShapesResponseItem`.
          '/shapes': { get: { operationId: 'listShapes', responses: ok({ type: 'array', items: shapes }) } },
          // The same, inside a list envelope.
          '/marks': {
            get: {
              operationId: 'listMarks',
              parameters: [{ name: 'after', in: 'query', schema: str }],
              responses: ok(obj({ data: { type: 'array', items: shapes }, list_metadata: obj({ after: str }) })),
            },
          },
          // Items identical to the component share it: no inline model, the response references `ListPetsItem`.
          '/pets': { get: { operationId: 'listPets', responses: ok({ type: 'array', items: pet }) } },
          // A plain object of another shape steps too (#242 named it `ListNotesItem` and lost to the component).
          '/notes': { get: { operationId: 'listNotes', responses: ok({ type: 'array', items: note }) } },
        },
        {
          ListShapesItem: obj({ id: str }),
          ListMarksItem: obj({ id: str }),
          ListPetsItem: pet,
          ListNotesItem: obj({ id: str }),
        },
      ),
    );
    const ops = opsOf(spec);
    expect(show(ops.listShapes.response)).toBe('(ListShapesResponseItem | ListShapesResponseItemWithSide)[]');
    expect(fieldsOf(spec, 'ListShapesResponseItem')).toEqual(['radius']);
    expect(fieldsOf(spec, 'ListShapesResponseItemWithSide')).toEqual(['side']);
    expect(fieldsOf(spec, 'ListShapesItem')).toEqual(['id']);
    expect(show(ops.listMarks.response)).toBe('(ListMarksResponseItem | ListMarksResponseItemWithSide)[]');
    expect(ops.listMarks.pagination?.itemType).toEqual({
      kind: 'union',
      variants: [
        { kind: 'model', name: 'ListMarksResponseItem' },
        { kind: 'model', name: 'ListMarksResponseItemWithSide' },
      ],
      compositionKind: 'oneOf',
    });
    expect(fieldsOf(spec, 'ListMarksItem')).toEqual(['id']);
    expect(show(ops.listPets.response)).toBe('ListPetsItem[]');
    expect(spec.models.filter((m) => m.name === 'ListPetsItem')).toHaveLength(1);
    expect(show(ops.listNotes.response)).toBe('ListNotesResponseItem[]');
    expect(fieldsOf(spec, 'ListNotesResponseItem')).toEqual(['text']);
    expect(fieldsOf(spec, 'ListNotesItem')).toEqual(['id']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['ListShapesItem', 'ListMarksItem', 'ListPetsItem', 'ListNotesItem']);
  });

  it('settles `<Op>Item` against an earlier operation and a component enum, in document order', async () => {
    const { spec, warnings } = await parse(
      'item-vs-earlier',
      specDoc(
        {
          // `getListShapesItem` mints `ListShapesItem` for a nested field before `listShapes` is read…
          '/shapes/item': {
            get: {
              operationId: 'getListShapesItem',
              responses: ok(obj({ list_shapes_item: obj({ id: str }) })),
            },
          },
          // … so the items step; and `ListKindsItem` is a component enum, which no model may take.
          '/shapes': {
            get: { operationId: 'listShapes', responses: ok({ type: 'array', items: obj({ radius: str }) }) },
          },
          '/kinds': { get: { operationId: 'listKinds', responses: ok({ type: 'array', items: obj({ label: str }) }) } },
        },
        { ListKindsItem: { type: 'string', enum: ['a', 'b'] } },
      ),
    );
    const ops = opsOf(spec);
    expect(show(ops.getListShapesItem.response)).toBe('GetListShapesItemResponse');
    expect(fieldsOf(spec, 'GetListShapesItemResponse')).toEqual(['list_shapes_item']);
    expect(show(modelOf(spec, 'GetListShapesItemResponse').fields[0].type)).toBe(
      'GetListShapesItemResponseListShapesItem',
    );
    expect(show(ops.listShapes.response)).toBe('ListShapesItem[]');
    expect(fieldsOf(spec, 'ListShapesItem')).toEqual(['radius']);
    expect(show(ops.listKinds.response)).toBe('ListKindsResponseItem[]');
    expect(fieldsOf(spec, 'ListKindsResponseItem')).toEqual(['label']);
    expect(spec.enums.map((e) => e.name)).toEqual(['ListKindsItem']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['ListKindsItem']);
  });
});

describe('merge round 1: a shared items model follows its rename', () => {
  // Two array bodies share one deprecated, title-named `Circle` variant model;
  // a direct response then mints a live `Circle` of other fields. The merge
  // renames the deprecated copy and must repoint both arrays — the second
  // shared the model and minted nothing (`attachSharedRefs`).
  const shapes: SchemaObject = {
    oneOf: [
      obj({ kind: { const: 'circle' }, radius: str }, { title: 'Circle', deprecated: true, required: ['kind'] }),
      obj({ kind: { const: 'square' }, side: str }, { title: 'Square', required: ['kind'] }),
    ],
  };
  const arrays = {
    '/a': { get: { operationId: 'listA', responses: ok({ type: 'array', items: shapes }) } },
    '/b': { get: { operationId: 'listB', responses: ok({ type: 'array', items: shapes }) } },
  };
  const direct = {
    '/circle': {
      get: { operationId: 'getCircle', responses: ok(obj({ object: { const: 'circle' }, diameter: str })) },
    },
  };

  it('repoints every array that shares the deprecated model when the live copy takes its name', async () => {
    const { spec, warnings } = await parse('shared-renamed', specDoc({ ...arrays, ...direct }));
    const ops = opsOf(spec);
    const live = modelOf(spec, 'Circle');
    expect(live.deprecated).toBeUndefined();
    expect(live.fields.map((f) => f.name)).toEqual(['object', 'diameter']);
    expect(show(ops.getCircle.response)).toBe('Circle');
    // Both arrays reference one model: the renamed deprecated copy, not the live one.
    const [variantA] = (ops.listA.response as { items: { variants: TypeRef[] } }).items.variants;
    const [variantB] = (ops.listB.response as { items: { variants: TypeRef[] } }).items.variants;
    expect(variantA).toEqual(variantB);
    expect(variantA.kind === 'model' && variantA.name).not.toBe('Circle');
    const shared = modelOf(spec, (variantA as { name: string }).name);
    expect(shared.deprecated).toBe(true);
    expect(shared.fields.map((f) => f.name)).toEqual(['kind', 'radius']);
    expect(show(ops.listA.response)).toBe(show(ops.listB.response));
    expect(show(ops.listA.response)).toBe(`(${shared.name} | Square)[]`);
    expect(spec.models.filter((m) => m.name === 'Square')).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('Renamed inline model "Circle"'))).toHaveLength(1);
    expectSound(spec);
  });

  it('steps each array off a live name the direct response minted first, in the other order', async () => {
    // The live `Circle` owns the title, so each array's variant takes its
    // context-qualified name from its own stem — two identical deprecated
    // copies with the right fields, nothing to rename and nothing shared.
    const { spec, warnings } = await parse('shared-stepped', specDoc({ ...direct, ...arrays }));
    const ops = opsOf(spec);
    expect(modelOf(spec, 'Circle').fields.map((f) => f.name)).toEqual(['object', 'diameter']);
    expect(show(ops.listA.response)).toBe('(CircleListAItem | Square)[]');
    expect(show(ops.listB.response)).toBe('(CircleListBItem | Square)[]');
    for (const name of ['CircleListAItem', 'CircleListBItem']) {
      const copy = modelOf(spec, name);
      expect(copy.deprecated, name).toBe(true);
      expect(
        copy.fields.map((f) => f.name),
        name,
      ).toEqual(['kind', 'radius']);
    }
    expect(spec.models.filter((m) => m.name === 'Square')).toHaveLength(1);
    expect(warnings).toEqual([]);
    expectSound(spec);
  });
});

describe('(3) a nullable array is the array it is, however the null is written', () => {
  const spellings: Record<string, SchemaObject> = {
    typeList: { type: ['array', 'null'], items: pet },
    nullableFlag: { type: 'array', nullable: true, items: pet },
    oneOfBesideItems: { items: pet, oneOf: [{ items: pet }, { type: 'null' }] },
    oneOfTyped: { type: 'array', items: pet, oneOf: [{ type: 'array', items: pet }, { type: 'null' }] },
    oneOfAlone: { oneOf: [{ type: 'array', items: pet }, { type: 'null' }] },
    anyOfAlone: { anyOf: [{ items: pet }, { type: 'null' }] },
  };

  it('reads a list envelope whose data array is nullable in any spelling, null kept on the response', async () => {
    const { spec, warnings } = await parse(
      'envelope',
      specDoc(
        Object.fromEntries(
          Object.entries(spellings).map(([name, data]) => [
            `/${name}`,
            {
              get: {
                operationId: `list${name[0].toUpperCase()}${name.slice(1)}`,
                parameters: [{ name: 'after', in: 'query', schema: str }],
                responses: ok(obj({ data, list_metadata: obj({ after: str }) })),
              },
            },
          ]),
        ),
      ),
    );
    for (const [name, op] of Object.entries(opsOf(spec))) {
      const item = `${name[0].toUpperCase()}${name.slice(1)}Item`;
      expect(show(op.response), name).toBe(`${item}[] | null`);
      expect(op.pagination, name).toMatchObject({
        strategy: 'cursor',
        param: 'after',
        dataPath: 'data',
        itemType: { kind: 'model', name: item },
      });
      expect(
        op.pagination?.envelopeFields?.map((f) => f.name),
        name,
      ).toEqual(['list_metadata']);
      expect(fieldsOf(spec, item), name).toEqual(['name']);
    }
    expect(warnings).toEqual([]);
    expectSound(spec);
  });

  it('reads an array response body that is nullable in any spelling, its items `<Op>Item`', () => {
    for (const [name, schema] of Object.entries(spellings)) {
      const result = classifyAndExtractResponse(schema, 'ListPetsResponse');
      expect(result.response, name).toEqual({
        kind: 'nullable',
        inner: { kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } },
      });
      expect(
        result.inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)]),
        name,
      ).toEqual([['ListPetsItem', ['name']]]);
      expect(result.isPaginated, name).toBe(false);
    }
  });

  it('keeps the items of a nullable data array when a later allOf branch only constrains it', () => {
    const result = classifyAndExtractResponse(
      {
        allOf: [
          obj({ data: spellings.oneOfAlone, list_metadata: obj({ after: str }) }),
          { type: 'object', properties: { data: { type: 'array', minItems: 1 } }, required: ['data'] },
        ],
      },
      'ListPetsResponse',
    );
    expect(result.isPaginated).toBe(true);
    expect(result.response).toEqual({
      kind: 'nullable',
      inner: { kind: 'array', items: { kind: 'model', name: 'ListPetsItem' } },
    });
    expect(result.itemType).toEqual({ kind: 'model', name: 'ListPetsItem' });
  });

  it('types the items of every array response body as `<Op>Item`, as a list envelope does', () => {
    const items: Record<string, SchemaObject> = {
      ref: Pet,
      primitive: { type: 'integer' },
      enum: { type: 'string', enum: ['a', 'b'] },
      object: pet,
      nullableObject: { type: ['object', 'null'], properties: { name: str } },
      union: { oneOf: [obj({ radius: str }), obj({ side: str })] },
      nested: { type: 'array', items: pet },
      map: { type: 'object', additionalProperties: pet },
      composed: tagged,
    };
    for (const [name, schema] of Object.entries(items)) {
      const direct = classifyAndExtractResponse({ type: 'array', items: schema }, 'ListThingsResponse');
      const envelope = classifyAndExtractResponse(
        obj({ data: { type: 'array', items: schema }, list_metadata: obj({ after: str }) }),
        'ListThingsResponse',
      );
      expect(direct.response, name).toEqual(envelope.response);
      expect(direct.inlineModels, name).toEqual(envelope.inlineModels);
      for (const model of direct.inlineModels) expect(model.name, name).toMatch(/^ListThingsItem/);
    }
    const composed = classifyAndExtractResponse({ type: 'array', items: tagged }, 'ListThingsResponse');
    expect(show(composed.response)).toBe('(ListThingsItem | ListThingsItemWithText)[]');
    expect(composed.inlineModels.map(describeModel)).toEqual([
      'ListThingsItem { id: string, name: string }',
      'ListThingsItemWithText { id: string, text: string }',
    ]);
  });
});
