import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { fieldAdmits, modelAdmits, typeShapeKey } from '../../src/parser/inline-models.js';
import { collectModelRefs, collectResponseHeaders, collectResponseBodyTypes } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #285: an inline model named like a component schema — a response or
 * request body, a component field's object, a nested object, a fallback body
 * — folds onto the component only when the component admits it (the same
 * fields and types, the component no stricter on requiredness or
 * nullability, everything else identical). Otherwise it takes a name
 * qualified by its site and the component stays exactly as the document
 * declares it: it is never replaced, whatever the inline shape's field
 * count, and no reference is silently typed as a shape it did not declare.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-component-fold-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** A minimal OpenAPI 3.1 document around `schemas` and `paths`. */
const specDoc = (schemas: Record<string, unknown>, paths: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'fold', version: '1' },
  paths,
  components: { schemas },
});

const str = { type: 'string' };
const int = { type: 'integer' };
const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties,
  ...extra,
});

/** A GET whose 200 body is `schema`, with any other responses in `responses`. */
const getOp = (operationId: string, schema: unknown, responses: Record<string, unknown> = {}) => ({
  get: {
    operationId,
    responses: { '200': { description: 'OK', content: { 'application/json': { schema } } }, ...responses },
  },
});

/** A POST whose request body is `schema` and whose 200 body is a string. */
const postOp = (operationId: string, schema: unknown) => ({
  post: {
    operationId,
    requestBody: { content: { 'application/json': { schema } } },
    responses: { '200': { description: 'OK', content: { 'application/json': { schema: str } } } },
  },
});

/** The issue's projection of a model: `name { field: type, … }`, with `!` on a required field and `?` on a nullable type. */
const describeModels = (spec: ApiSpec): string[] =>
  spec.models.map(({ fields, name }) => {
    const typeOf = (t: TypeRef): string =>
      t.kind === 'nullable' ? `${typeOf(t.inner)}?` : 'name' in t ? t.name : 'type' in t ? String(t.type) : t.kind;
    return `${name} { ${fields.map((f) => `${f.name}${f.required ? '!' : ''}: ${typeOf(f.type)}`).join(', ')} }`;
  });

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

/** Every type reference an operation holds, labelled by where it sits. */
function operationRefs(op: Operation): Array<[string, TypeRef]> {
  const refs: Array<[string, TypeRef]> = [[`${op.name}.response`, op.response]];
  if (op.requestBody) refs.push([`${op.name}.requestBody`, op.requestBody]);
  for (const r of op.successResponses ?? []) refs.push([`${op.name}.${r.statusCode}`, r.type]);
  for (const e of op.errors) if (e.type) refs.push([`${op.name}.${e.statusCode}`, e.type]);
  for (const f of op.pagination?.envelopeFields ?? []) refs.push([`${op.name}.${f.name}`, f.type]);
  if (op.pagination) refs.push([`${op.name}.items`, op.pagination.itemType]);
  for (const h of collectResponseHeaders(op)) refs.push([`${op.name}.${h.name}`, h.type]);
  for (const { source, type } of collectResponseBodyTypes(op)) refs.push([`${op.name}.${source}`, type]);
  for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
    refs.push([`${op.name}(${p.name})`, p.type]);
  }
  return refs;
}

/** Every model reference, from operations and model fields alike, that names no model. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const names = new Set(spec.models.map((m) => m.name));
  const found: string[] = [];
  for (const op of Object.values(opsOf(spec))) {
    for (const [owner, ref] of operationRefs(op)) {
      for (const name of collectModelRefs(ref)) if (!names.has(name)) found.push(`${owner} → ${name}`);
    }
  }
  for (const model of spec.models) {
    for (const field of model.fields) {
      for (const name of collectModelRefs(field.type))
        if (!names.has(name)) found.push(`${model.name}.${field.name} → ${name}`);
    }
  }
  return found.sort();
}

/** Every model that is neither a component nor referenced by any operation or model field. */
function orphanedModels(spec: ApiSpec, componentNames: string[]): string[] {
  const referenced = new Set<string>();
  for (const op of Object.values(opsOf(spec))) {
    for (const [, ref] of operationRefs(op)) for (const name of collectModelRefs(ref)) referenced.add(name);
  }
  for (const model of spec.models) {
    for (const field of model.fields) for (const name of collectModelRefs(field.type)) referenced.add(name);
  }
  return spec.models
    .map((m) => m.name)
    .filter((name) => !componentNames.includes(name) && !referenced.has(name))
    .sort();
}

/** The invariants every case below holds: nothing dangles, nothing is orphaned, every name is unique, and each component keeps the fields it declared. */
function expectSound(spec: ApiSpec, components: Record<string, string[]>): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphanedModels(spec, Object.keys(components))).toEqual([]);
  expect(new Set(spec.models.map((m) => m.name)).size).toBe(spec.models.length);
  for (const [name, fields] of Object.entries(components)) {
    expect(
      spec.models.find((m) => m.name === name)?.fields.map((f) => f.name),
      name,
    ).toEqual(fields);
  }
}

/** Parse `paths` in both orders and return both results with their warnings. */
async function parseBothOrders(
  label: string,
  schemas: Record<string, unknown>,
  paths: Array<[string, unknown]>,
): Promise<Array<{ order: string; spec: ApiSpec; warnings: string[] }>> {
  const results = [];
  for (const [order, ordered] of [
    ['as-written', paths],
    ['swapped', [...paths].reverse()],
  ] as const) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spec = await parseSpec(
        await writeSpec(`${label}-${order}.json`, specDoc(schemas, Object.fromEntries(ordered))),
      );
      results.push({ order, spec, warnings: warn.mock.calls.map(([m]) => String(m)) });
    } finally {
      warn.mockRestore();
    }
  }
  return results;
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

const renamed = (name: string, to: string): string =>
  `[oagen] Renamed inline model "${name}" → "${to}": its shape differs from component schema "${name}"`;

describe('an inline response body named like a component (issue #285)', () => {
  it('gives the body a name of its own and leaves the component as declared (the issue’s first repro)', async () => {
    // `getPet` returns `{ name }` inline; a component `GetPetResponse` is `{ legacyId }`.
    const { spec, warnings } = await parse(
      'repro-1',
      specDoc(
        { GetPetResponse: obj({ legacyId: int }) },
        { '/pets/{id}': getOp('getPet', obj({ name: str }, { required: ['name'] })) },
      ),
    );
    expect(describeModels(spec)).toEqual(['GetPetResponse { legacyId: integer }', 'GetPetResponse2 { name!: string }']);
    expect(opsOf(spec).getPet?.response).toEqual({ kind: 'model', name: 'GetPetResponse2' });
    expect(warnings).toEqual([renamed('GetPetResponse', 'GetPetResponse2')]);
    expectSound(spec, { GetPetResponse: ['legacyId'] });
  });

  it('never replaces the component for the operations that `$ref` it, even when the body has more fields (the issue’s second repro), in either path order', async () => {
    const results = await parseBothOrders('repro-2', { GetPetResponse: obj({ legacyId: int }) }, [
      ['/pets/{id}', getOp('getPet', obj({ legacyId: int, name: str }, { required: ['legacyId', 'name'] }))],
      ['/legacy-pets/{id}', getOp('getLegacyPet', { $ref: '#/components/schemas/GetPetResponse' })],
    ]);
    for (const { order, spec, warnings } of results) {
      const ops = opsOf(spec);
      expect(describeModels(spec), order).toEqual([
        'GetPetResponse { legacyId: integer }',
        'GetPetResponse2 { legacyId!: integer, name!: string }',
      ]);
      expect(ops.getPet?.response, order).toEqual({ kind: 'model', name: 'GetPetResponse2' });
      expect(ops.getLegacyPet?.response, order).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(warnings, order).toEqual([renamed('GetPetResponse', 'GetPetResponse2')]);
      expectSound(spec, { GetPetResponse: ['legacyId'] });
    }
    expect(describeModels(results[0]!.spec)).toEqual(describeModels(results[1]!.spec));
  });

  it('shares the component when the body matches it exactly, minting nothing and saying nothing', async () => {
    const { spec, warnings } = await parse(
      'exact',
      specDoc({ GetPetResponse: obj({ legacyId: int }) }, { '/pets/{id}': getOp('getPet', obj({ legacyId: int })) }),
    );
    expect(describeModels(spec)).toEqual(['GetPetResponse { legacyId: integer }']);
    expect(opsOf(spec).getPet?.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
    expect(warnings).toEqual([]);
    expectSound(spec, { GetPetResponse: ['legacyId'] });
  });

  it('shares the component when it is looser than the body on requiredness and nullability, and renames the body when it is stricter', async () => {
    const required = obj({ name: str }, { required: ['name'] });
    const optionalNullable = obj({ name: { type: ['string', 'null'] } });
    // Looser component: every value the required, non-null body describes is one the component describes.
    const admitted = await parse(
      'looser-component',
      specDoc({ GetPetResponse: optionalNullable }, { '/pets/{id}': getOp('getPet', required) }),
    );
    expect(describeModels(admitted.spec)).toEqual(['GetPetResponse { name: string? }']);
    expect(opsOf(admitted.spec).getPet?.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
    expect(admitted.warnings).toEqual([]);
    expectSound(admitted.spec, { GetPetResponse: ['name'] });
    // Stricter component: typing the optional, nullable body as it would promise a `name` the wire may omit or null.
    const stricter = await parse(
      'stricter-component',
      specDoc({ GetPetResponse: required }, { '/pets/{id}': getOp('getPet', optionalNullable) }),
    );
    expect(describeModels(stricter.spec)).toEqual([
      'GetPetResponse { name!: string }',
      'GetPetResponse2 { name: string? }',
    ]);
    expect(opsOf(stricter.spec).getPet?.response).toEqual({ kind: 'model', name: 'GetPetResponse2' });
    expect(stricter.warnings).toEqual([renamed('GetPetResponse', 'GetPetResponse2')]);
    expectSound(stricter.spec, { GetPetResponse: ['name'] });
  });

  it('renames a body whose fields have the same names but another type, instead of typing it as the component', async () => {
    const { spec, warnings } = await parse(
      'same-names-other-type',
      specDoc({ GetPetResponse: obj({ legacyId: int }) }, { '/pets/{id}': getOp('getPet', obj({ legacyId: str })) }),
    );
    expect(describeModels(spec)).toEqual([
      'GetPetResponse { legacyId: integer }',
      'GetPetResponse2 { legacyId: string }',
    ]);
    expect(opsOf(spec).getPet?.response).toEqual({ kind: 'model', name: 'GetPetResponse2' });
    expect(warnings).toEqual([renamed('GetPetResponse', 'GetPetResponse2')]);
    expectSound(spec, { GetPetResponse: ['legacyId'] });
  });

  it('qualifies a body pinned by an `object` const with its operation (`GetWidgetWidget`)', async () => {
    const { spec, warnings } = await parse(
      'object-const',
      specDoc(
        { Widget: obj({ id: str }) },
        {
          '/widgets/{id}': getOp('getWidget', obj({ object: { type: 'string', const: 'widget' }, id: str, name: str })),
        },
      ),
    );
    expect(describeModels(spec)).toEqual([
      'Widget { id: string }',
      'GetWidgetWidget { object: literal, id: string, name: string }',
    ]);
    expect(opsOf(spec).getWidget?.response).toEqual({ kind: 'model', name: 'GetWidgetWidget' });
    expect(warnings).toEqual([renamed('Widget', 'GetWidgetWidget')]);
    expectSound(spec, { Widget: ['id'] });
  });

  it('decides a nested object before its parent, so a parent whose child was renamed is renamed with it', async () => {
    // Both the body and its nested `owner` are named like components; the
    // component parent references the component child.
    const { spec, warnings } = await parse(
      'nested',
      specDoc(
        {
          GetPetResponse: obj({ owner: { $ref: '#/components/schemas/GetPetResponseOwner' } }),
          GetPetResponseOwner: obj({ legacyId: int }),
        },
        { '/pets/{id}': getOp('getPet', obj({ owner: obj({ name: str }) })) },
      ),
    );
    expect(describeModels(spec)).toEqual([
      'GetPetResponse { owner: GetPetResponseOwner }',
      'GetPetResponseOwner { legacyId: integer }',
      'GetPetResponse2 { owner: GetPetResponseOwner2 }',
      'GetPetResponseOwner2 { name: string }',
    ]);
    expect(opsOf(spec).getPet?.response).toEqual({ kind: 'model', name: 'GetPetResponse2' });
    expect(warnings).toEqual([
      renamed('GetPetResponseOwner', 'GetPetResponseOwner2'),
      renamed('GetPetResponse', 'GetPetResponse2'),
    ]);
    expectSound(spec, { GetPetResponse: ['owner'], GetPetResponseOwner: ['legacyId'] });
  });
});

describe('the same rule at every other site an inline model is named like a component', () => {
  it('an inline request body (`CreateNoteRequest2`)', async () => {
    const { spec, warnings } = await parse(
      'request-body',
      specDoc({ CreateNoteRequest: obj({ body: str }) }, { '/notes': postOp('createNote', obj({ title: str })) }),
    );
    expect(describeModels(spec)).toEqual([
      'CreateNoteRequest { body: string }',
      'CreateNoteRequest2 { title: string }',
    ]);
    expect(opsOf(spec).createNote?.requestBody).toEqual({ kind: 'model', name: 'CreateNoteRequest2' });
    expect(warnings).toEqual([renamed('CreateNoteRequest', 'CreateNoteRequest2')]);
    expectSound(spec, { CreateNoteRequest: ['body'] });
  });

  it('a component field’s object (`PetOwner2`), while a field object the component admits shares it', async () => {
    const differs = await parse(
      'field-object',
      specDoc({ Pet: obj({ owner: obj({ name: str }) }), PetOwner: obj({ legacyId: int }) }),
    );
    expect(describeModels(differs.spec)).toEqual([
      'Pet { owner: PetOwner2 }',
      'PetOwner { legacyId: integer }',
      'PetOwner2 { name: string }',
    ]);
    expect(differs.warnings).toEqual([renamed('PetOwner', 'PetOwner2')]);
    expectSound(differs.spec, { Pet: ['owner'], PetOwner: ['legacyId'] });

    const admitted = await parse(
      'field-object-admitted',
      specDoc({
        Pet: obj({ owner: obj({ name: str }, { required: ['name'] }) }),
        PetOwner: obj({ name: str }),
      }),
    );
    expect(describeModels(admitted.spec)).toEqual(['Pet { owner: PetOwner }', 'PetOwner { name: string }']);
    expect(admitted.warnings).toEqual([]);
    expectSound(admitted.spec, { Pet: ['owner'], PetOwner: ['name'] });
  });

  it('a fallback body, through the shape registry: shared when the component admits it, stepped to a numbered name otherwise', async () => {
    const fallback = (schema: unknown) => ({
      default: { description: 'err', content: { 'application/json': { schema } } },
    });
    const body = obj({ code: str }, { required: ['code'] });
    const admitted = await parse(
      'fallback-admitted',
      specDoc(
        { Pet: obj({ id: str }), ListPetsDefaultResponse: obj({ code: str }) },
        { '/pets': getOp('listPets', { $ref: '#/components/schemas/Pet' }, fallback(body)) },
      ),
    );
    expect(describeModels(admitted.spec)).toEqual(['Pet { id: string }', 'ListPetsDefaultResponse { code: string }']);
    expect(opsOf(admitted.spec).listPets?.defaultResponse?.type).toEqual({
      kind: 'model',
      name: 'ListPetsDefaultResponse',
    });
    expect(admitted.warnings).toEqual([]);
    expectSound(admitted.spec, { Pet: ['id'], ListPetsDefaultResponse: ['code'] });

    const stepped = await parse(
      'fallback-stepped',
      specDoc(
        { Pet: obj({ id: str }), ListPetsDefaultResponse: obj({ code: int }) },
        { '/pets': getOp('listPets', { $ref: '#/components/schemas/Pet' }, fallback(body)) },
      ),
    );
    expect(describeModels(stepped.spec)).toEqual([
      'Pet { id: string }',
      'ListPetsDefaultResponse { code: integer }',
      'ListPetsDefaultResponse2 { code!: string }',
    ]);
    expect(opsOf(stepped.spec).listPets?.defaultResponse?.type).toEqual({
      kind: 'model',
      name: 'ListPetsDefaultResponse2',
    });
    expect(stepped.warnings).toEqual([]);
    expectSound(stepped.spec, { Pet: ['id'], ListPetsDefaultResponse: ['code'] });
  });
});

describe('modelAdmits', () => {
  const string = { kind: 'primitive', type: 'string' } as const;
  const model = (fields: Model['fields'], extra: Partial<Model> = {}): Model => ({ name: 'M', fields, ...extra });
  const field = (name: string, required: boolean, type: TypeRef = string): Model['fields'][number] => ({
    name,
    type,
    required,
  });

  it('admits an identical shape, and a candidate stricter on requiredness or nullability, never the reverse', () => {
    const optional = model([field('a', false)]);
    const required = model([field('a', true)]);
    const nullable = model([field('a', false, { kind: 'nullable', inner: string })]);
    expect(modelAdmits(optional, optional)).toBe(true);
    expect(modelAdmits(optional, required)).toBe(true);
    expect(modelAdmits(required, optional)).toBe(false);
    expect(modelAdmits(nullable, optional)).toBe(true);
    expect(modelAdmits(optional, nullable)).toBe(false);
  });

  it('reads the field type’s own nullable wrapper only: a nullable deeper down must agree', () => {
    const items = (inner: TypeRef): TypeRef => ({ kind: 'array', items: inner });
    expect(
      modelAdmits(
        model([field('a', false, items({ kind: 'nullable', inner: string }))]),
        model([field('a', false, items(string))]),
      ),
    ).toBe(false);
  });

  it('never admits another field set, another type, or a difference in anything else the fingerprint reads', () => {
    const base = model([field('a', false)]);
    expect(modelAdmits(base, model([field('b', false)]))).toBe(false);
    expect(modelAdmits(base, model([field('a', false), field('b', false)]))).toBe(false);
    expect(modelAdmits(model([field('a', false), field('b', false)]), base)).toBe(false);
    expect(modelAdmits(base, model([field('a', false, { kind: 'primitive', type: 'integer' })]))).toBe(false);
    expect(modelAdmits(base, model([{ ...field('a', false), readOnly: true }]))).toBe(false);
    expect(modelAdmits(base, model([{ ...field('a', false), default: 'x' }]))).toBe(false);
    expect(modelAdmits(base, model([{ ...field('a', false), constraints: { minLength: 1 } }]))).toBe(false);
    expect(modelAdmits(base, model([{ ...field('a', false), deprecated: true }]))).toBe(false);
    expect(modelAdmits(base, model([field('a', false)], { deprecated: true }))).toBe(false);
    expect(modelAdmits(base, model([field('a', false)], { constraints: { minProperties: 1 } }))).toBe(false);
    // Documentation is not shape.
    expect(modelAdmits(base, model([{ ...field('a', false), description: 'doc' }], { description: 'doc' }))).toBe(true);
  });

  it('reads every model reference under `modelName` when given — fields, variants and mapping targets, both sides', () => {
    const ref = (name: string): TypeRef => ({ kind: 'model', name });
    // The `…Json` fold's reading: `PetJson…` as `Pet…`.
    const fold = { modelName: (name: string) => (name.startsWith('PetJson') ? `Pet${name.slice(7)}` : name) };
    const owner = model([field('inner', false, ref('PetInner'))]);
    const candidate = model([field('inner', false, ref('PetJsonInner'))]);
    expect(modelAdmits(owner, candidate)).toBe(false);
    expect(modelAdmits(owner, candidate, fold)).toBe(true);
    expect(modelAdmits(candidate, owner, fold)).toBe(true);
    expect(modelAdmits(owner, model([field('inner', false, ref('PetOther'))]), fold)).toBe(false);
    // A reference deeper down is read the same way; the model itself is never touched.
    const items = (inner: TypeRef): TypeRef => ({ kind: 'array', items: inner });
    expect(
      modelAdmits(
        model([field('a', false, items(ref('PetInner')))]),
        model([field('a', false, items(ref('PetJsonInner')))]),
        fold,
      ),
    ).toBe(true);
    expect(candidate.fields[0]?.type).toEqual(ref('PetJsonInner'));

    const union = (name: string): Model =>
      model([], {
        variants: [ref(name)],
        compositionKind: 'oneOf',
        discriminator: { property: 'kind', mapping: { a: name } },
      });
    expect(modelAdmits(union('PetA'), union('PetJsonA'))).toBe(false);
    expect(modelAdmits(union('PetA'), union('PetJsonA'), fold)).toBe(true);
    expect(union('PetJsonA').discriminator).toEqual({ property: 'kind', mapping: { a: 'PetJsonA' } });

    // An enum reference is read as it is: no pass renames enums.
    const enumRef = (name: string): TypeRef => ({ kind: 'enum', name });
    expect(
      modelAdmits(
        model([field('s', false, enumRef('PetState'))]),
        model([field('s', false, enumRef('PetJsonState'))]),
        fold,
      ),
    ).toBe(false);

    // The per-field rule and the type key read the same way.
    expect(fieldAdmits(field('inner', false, ref('PetInner')), field('inner', true, ref('PetJsonInner')), fold)).toBe(
      true,
    );
    expect(fieldAdmits(field('inner', true, ref('PetInner')), field('inner', false, ref('PetJsonInner')), fold)).toBe(
      false,
    );
    expect(fieldAdmits(field('inner', false, ref('PetInner')), field('inner', false, ref('PetJsonInner')))).toBe(false);
    expect(typeShapeKey(items(ref('PetJsonInner')), fold)).toBe(typeShapeKey(items(ref('PetInner'))));
    expect(typeShapeKey(items(ref('PetJsonInner')))).not.toBe(typeShapeKey(items(ref('PetInner'))));
  });
});
