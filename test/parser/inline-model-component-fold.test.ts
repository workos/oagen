import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { modelAdmits } from '../../src/parser/inline-models.js';
import { renameTypeRefModels } from '../../src/ir/types.js';
import {
  collectModelRefs,
  collectRequestBodyTypes,
  collectResponseHeaders,
  collectResponseBodyTypes,
  collectWebhookTypeRefs,
} from '../../src/ir/types.js';
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
  for (const { source, type } of collectRequestBodyTypes(op)) refs.push([`${op.name}.${source}`, type]);
  for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
    refs.push([`${op.name}(${p.name})`, p.type]);
  }
  return refs;
}

/** Every model reference, from operations, webhooks and model fields alike, that names no model. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const names = new Set(spec.models.map((m) => m.name));
  const found: string[] = [];
  for (const op of Object.values(opsOf(spec))) {
    for (const [owner, ref] of operationRefs(op)) {
      for (const name of collectModelRefs(ref)) if (!names.has(name)) found.push(`${owner} → ${name}`);
    }
  }
  for (const webhook of spec.webhooks ?? []) {
    for (const ref of collectWebhookTypeRefs(webhook)) {
      for (const name of collectModelRefs(ref)) if (!names.has(name)) found.push(`${webhook.name} → ${name}`);
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

/** Every model that is neither a component nor referenced by any operation, webhook or model field. */
function orphanedModels(spec: ApiSpec, componentNames: string[]): string[] {
  const referenced = new Set<string>();
  for (const op of Object.values(opsOf(spec))) {
    for (const [, ref] of operationRefs(op)) for (const name of collectModelRefs(ref)) referenced.add(name);
  }
  for (const webhook of spec.webhooks ?? []) {
    for (const ref of collectWebhookTypeRefs(webhook)) for (const name of collectModelRefs(ref)) referenced.add(name);
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

describe('a renamed inline model’s references, whatever kind holds them (Greptile round 1)', () => {
  const titled = (title: string, tag: string, field: string) =>
    obj({ kind: { type: 'string', const: tag }, [field]: str }, { title });
  const comp = titled('Comp', 'c', 'c');
  const b = titled('B', 'b', 'b');
  const union = (compName: string) => ({
    kind: 'union',
    variants: [
      { kind: 'model', name: compName },
      { kind: 'model', name: 'B' },
    ],
    compositionKind: 'oneOf',
    discriminator: { property: 'kind', mapping: { c: compName, b: 'B' } },
  });

  it('repoints a union’s discriminator mapping with the renamed variant, on a component field and on a response', async () => {
    const field = await parse(
      'mapping-field',
      specDoc({ Comp: obj({ id: str }), Thing: obj({ shape: { oneOf: [comp, b] } }) }),
    );
    expect(field.spec.models.find((m) => m.name === 'Thing')?.fields[0]?.type).toEqual(union('ThingComp'));
    expect(field.warnings).toEqual([renamed('Comp', 'ThingComp')]);
    expectSound(field.spec, { Comp: ['id'], Thing: ['shape'] });

    const response = await parse(
      'mapping-response',
      specDoc({ Comp: obj({ id: str }) }, { '/shapes/{id}': getOp('getShape', { oneOf: [comp, b] }) }),
    );
    expect(opsOf(response.spec).getShape?.response).toEqual(union('GetShapeComp'));
    expect(response.warnings).toEqual([renamed('Comp', 'GetShapeComp')]);
    expectSound(response.spec, { Comp: ['id'] });
  });

  it('and on a webhook payload, whose models have a site of their own qualified by the webhook’s stem', async () => {
    const { spec, warnings } = await parse(
      'webhook-variant',
      webhookDoc({ Comp: obj({ id: str }) }, { oneOf: [comp, b] }),
    );
    expect(spec.webhooks?.[0]?.requestBody).toEqual(union('PetAdoptedComp'));
    expect(describeModels(spec).sort()).toEqual([
      'B { kind: literal, b: string }',
      'Comp { id: string }',
      'PetAdoptedComp { kind: literal, c: string }',
    ]);
    expect(warnings).toEqual([renamed('Comp', 'PetAdoptedComp')]);
    expectSound(spec, { Comp: ['id'] });
  });

  it('a webhook payload named like a component is kept off the name by its stem, and the component stands', async () => {
    const { spec, warnings } = await parse(
      'webhook-payload',
      webhookDoc({ PetAdoptedPayload: obj({ x: str }) }, obj({ y: str })),
    );
    const payload = spec.webhooks?.[0]?.requestBody;
    expect(payload?.kind).toBe('model');
    const name = (payload as { name: string }).name;
    expect(name).toMatch(/^PetAdopted[0-9A-Fa-f]{6}Payload$/);
    expect(describeModels(spec).sort()).toEqual([`${name} { y: string }`, 'PetAdoptedPayload { x: string }']);
    expect(warnings).toEqual([]);
    expectSound(spec, { PetAdoptedPayload: ['x'] });
  });
});

/** A document with one webhook, `pet.adopted`, whose POST payload is `payload`. */
const webhookDoc = (schemas: Record<string, unknown>, payload: unknown) => ({
  openapi: '3.1.0',
  info: { title: 'hooks', version: '1' },
  paths: {},
  webhooks: {
    'pet.adopted': {
      post: {
        requestBody: { content: { 'application/json': { schema: payload } } },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
  components: { schemas },
});

describe('a component whose inline child is named like another component (Greptile round 1)', () => {
  const parent = obj({ owner: obj({ name: str }) });
  const sibling = obj({ legacyId: int });

  it('settles the child before any body is compared with the component, so a body that `$ref`s the sibling keeps it, in either declaration order', async () => {
    for (const [order, schemas] of [
      ['parent-first', { GetPetResponse: parent, GetPetResponseOwner: sibling }],
      ['child-first', { GetPetResponseOwner: sibling, GetPetResponse: parent }],
    ] as const) {
      const { spec, warnings } = await parse(
        `settled-child-${order}`,
        specDoc(schemas, {
          '/pets/{id}': getOp('getPet', obj({ owner: { $ref: '#/components/schemas/GetPetResponseOwner' } })),
        }),
      );
      expect(describeModels(spec).sort(), order).toEqual([
        'GetPetResponse { owner: GetPetResponseOwner2 }',
        'GetPetResponse2 { owner: GetPetResponseOwner }',
        'GetPetResponseOwner { legacyId: integer }',
        'GetPetResponseOwner2 { name: string }',
      ]);
      expect(opsOf(spec).getPet?.response, order).toEqual({ kind: 'model', name: 'GetPetResponse2' });
      expect(warnings, order).toEqual([
        renamed('GetPetResponseOwner', 'GetPetResponseOwner2'),
        renamed('GetPetResponse', 'GetPetResponse2'),
      ]);
      expectSound(spec, { GetPetResponse: ['owner'], GetPetResponseOwner: ['legacyId'] });
    }
  });

  it('and a fallback body through the shape registry alike', async () => {
    const fallback = {
      default: {
        description: 'err',
        content: {
          'application/json': {
            schema: obj({ owner: { $ref: '#/components/schemas/ListPetsDefaultResponseOwner' } }),
          },
        },
      },
    };
    const { spec, warnings } = await parse(
      'settled-child-fallback',
      specDoc(
        { Pet: obj({ id: str }), ListPetsDefaultResponse: parent, ListPetsDefaultResponseOwner: sibling },
        { '/pets': getOp('listPets', { $ref: '#/components/schemas/Pet' }, fallback) },
      ),
    );
    expect(describeModels(spec).sort()).toEqual([
      'ListPetsDefaultResponse { owner: ListPetsDefaultResponseOwner2 }',
      'ListPetsDefaultResponse2 { owner: ListPetsDefaultResponseOwner }',
      'ListPetsDefaultResponseOwner { legacyId: integer }',
      'ListPetsDefaultResponseOwner2 { name: string }',
      'Pet { id: string }',
    ]);
    expect(opsOf(spec).listPets?.defaultResponse?.type).toEqual({ kind: 'model', name: 'ListPetsDefaultResponse2' });
    expect(warnings).toEqual([renamed('ListPetsDefaultResponseOwner', 'ListPetsDefaultResponseOwner2')]);
    expectSound(spec, { Pet: ['id'], ListPetsDefaultResponse: ['owner'], ListPetsDefaultResponseOwner: ['legacyId'] });
  });

  it('and a reference an operation’s `allOf` merge copies from the settled field is created under the settled name', async () => {
    const { spec, warnings } = await parse(
      'settled-child-inherited',
      specDoc(
        { Holder: obj({ meta: obj({ name: str }) }), HolderMeta: sibling },
        {
          '/holders': postOp('createHolder', {
            allOf: [{ $ref: '#/components/schemas/Holder' }, obj({ extra: str })],
          }),
        },
      ),
    );
    expect(describeModels(spec).sort()).toEqual([
      'CreateHolderRequest { meta: HolderMeta2, extra: string }',
      'Holder { meta: HolderMeta2 }',
      'HolderMeta { legacyId: integer }',
      'HolderMeta2 { name: string }',
    ]);
    expect(opsOf(spec).createHolder?.requestBody).toEqual({ kind: 'model', name: 'CreateHolderRequest' });
    expect(warnings).toEqual([renamed('HolderMeta', 'HolderMeta2')]);
    expectSound(spec, { Holder: ['meta'], HolderMeta: ['legacyId'] });
  });
});

describe('what the SDK sends shares a component only on an identical shape (review)', () => {
  const required = obj({ title: str }, { required: ['title'] });
  const optional = obj({ title: str });

  it('a request body: a looser component would let a caller omit what the operation requires', async () => {
    const { spec, warnings } = await parse(
      'request-looser-component',
      specDoc({ CreateNoteRequest: optional }, { '/notes': postOp('createNote', required) }),
    );
    expect(describeModels(spec)).toEqual([
      'CreateNoteRequest { title: string }',
      'CreateNoteRequest2 { title!: string }',
    ]);
    expect(opsOf(spec).createNote?.requestBody).toEqual({ kind: 'model', name: 'CreateNoteRequest2' });
    expect(warnings).toEqual([renamed('CreateNoteRequest', 'CreateNoteRequest2')]);
    expectSound(spec, { CreateNoteRequest: ['title'] });
    // An identical component is shared, as for any site.
    const same = await parse(
      'request-same-component',
      specDoc({ CreateNoteRequest: required }, { '/notes': postOp('createNote', required) }),
    );
    expect(describeModels(same.spec)).toEqual(['CreateNoteRequest { title!: string }']);
    expect(same.warnings).toEqual([]);
  });

  it('a secondary request body, through the shape registry', async () => {
    const post = {
      post: {
        operationId: 'createNote',
        requestBody: { content: { 'application/json': { schema: str }, 'application/xml': { schema: required } } },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: str } } } },
      },
    };
    const { spec, warnings } = await parse(
      'secondary-request-looser-component',
      specDoc({ CreateNoteApplicationXmlRequest: optional }, { '/notes': post }),
    );
    const types = collectRequestBodyTypes(opsOf(spec).createNote!).map(({ type }) => type);
    expect(types).toContainEqual({ kind: 'model', name: 'CreateNoteApplicationXmlRequest2' });
    expect(describeModels(spec)).toEqual([
      'CreateNoteApplicationXmlRequest { title: string }',
      'CreateNoteApplicationXmlRequest2 { title!: string }',
    ]);
    expect(warnings).toEqual([]);
    expectSound(spec, { CreateNoteApplicationXmlRequest: ['title'] });
  });
});

describe('identical bodies that must leave a component’s name share one model (review)', () => {
  const widget = obj({ object: { type: 'string', const: 'widget' }, id: str, name: str });

  it('under the first site’s qualified name, in either path order', async () => {
    for (const { order, spec, warnings } of await parseBothOrders('twins', { Widget: obj({ id: str }) }, [
      ['/a-widgets/{id}', getOp('getAWidget', widget)],
      ['/b-widgets/{id}', getOp('getBWidget', widget)],
    ])) {
      const first = order === 'as-written' ? 'GetAWidget' : 'GetBWidget';
      expect(describeModels(spec), order).toEqual([
        'Widget { id: string }',
        `${first}Widget { object: literal, id: string, name: string }`,
      ]);
      expect(opsOf(spec).getAWidget?.response, order).toEqual({ kind: 'model', name: `${first}Widget` });
      expect(opsOf(spec).getBWidget?.response, order).toEqual({ kind: 'model', name: `${first}Widget` });
      expect(warnings, order).toEqual([`${renamed('Widget', `${first}Widget`)} (shared by 2 sites)`]);
      expectSound(spec, { Widget: ['id'] });
    }
  });
});

describe('two webhook keys sharing one path item (Greptile round 2)', () => {
  const titled = (title: string, tag: string, field: string) =>
    obj({ kind: { type: 'string', const: tag }, [field]: str }, { title });
  const doc = {
    openapi: '3.1.0',
    info: { title: 'hooks', version: '1' },
    paths: {},
    webhooks: {
      'pet.adopted': { $ref: '#/components/pathItems/shared' },
      'pet.returned': { $ref: '#/components/pathItems/shared' },
    },
    components: {
      schemas: { Comp: obj({ id: str }) },
      pathItems: {
        shared: {
          post: {
            operationId: 'shared',
            parameters: [{ name: 'X-Comp', in: 'header', schema: { $ref: '#/components/schemas/Comp' } }],
            requestBody: {
              content: { 'application/json': { schema: { oneOf: [titled('Comp', 'c', 'c'), titled('B', 'b', 'b')] } } },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    },
  };

  it('renames the shared variant on both and keeps an explicit `$ref` to the component on both', async () => {
    const { spec, warnings } = await parse('shared-webhooks', doc);
    expect(spec.webhooks?.map((w) => w.name)).toEqual(['pet.adopted', 'pet.returned']);
    for (const webhook of spec.webhooks ?? []) {
      expect(webhook.requestBody, webhook.name).toEqual({
        kind: 'union',
        variants: [
          { kind: 'model', name: 'SharedComp' },
          { kind: 'model', name: 'B' },
        ],
        compositionKind: 'oneOf',
        discriminator: { property: 'kind', mapping: { c: 'SharedComp', b: 'B' } },
      });
      expect(
        webhook.headerParams.map((p) => [p.name, p.type]),
        webhook.name,
      ).toEqual([['X-Comp', { kind: 'model', name: 'Comp' }]]);
    }
    expect(describeModels(spec).sort()).toEqual([
      'B { kind: literal, b: string }',
      'Comp { id: string }',
      'SharedComp { kind: literal, c: string }',
    ]);
    expect(warnings).toEqual([renamed('Comp', 'SharedComp')]);
    expectSound(spec, { Comp: ['id'] });
  });
});

describe('a union holding a `$ref` and an inline variant of one name (Greptile)', () => {
  // The component pins `kind: legacy`; the inline variant, titled like it,
  // pins `kind: new`. The derived mapping names `Comp` twice; only the
  // inline variant moves, and only its entry follows.
  const legacy = obj({ kind: { type: 'string', const: 'legacy' }, id: str });
  const fresh = obj({ kind: { type: 'string', const: 'new' }, c: str }, { title: 'Comp' });
  const mixed = { oneOf: [{ $ref: '#/components/schemas/Comp' }, fresh] };
  it('is what the parser builds: the `$ref` keeps the component, the inline variant its context-qualified name, with no mapping, on a field, a response and a webhook payload', async () => {
    // Beside a `$ref` sibling the title is not kept, so the two never share a
    // name and no entry can be misassigned; the positional rule below guards a
    // union built any other way.
    const built = (inline: string) => ({
      kind: 'union',
      variants: [
        { kind: 'model', name: 'Comp' },
        { kind: 'model', name: inline },
      ],
      compositionKind: 'oneOf',
    });
    const field = await parse('mixed-field', specDoc({ Comp: legacy, Thing: obj({ shape: mixed }) }));
    expect(field.spec.models.find((m) => m.name === 'Thing')?.fields[0]?.type).toEqual(built('ThingShape'));
    expect(field.warnings).toEqual([]);
    expectSound(field.spec, { Comp: ['kind', 'id'], Thing: ['shape'] });

    const response = await parse(
      'mixed-response',
      specDoc({ Comp: legacy }, { '/things/{id}': getOp('getThing', mixed) }),
    );
    expect(opsOf(response.spec).getThing?.response).toEqual(built('GetThingResponse'));
    expect(response.warnings).toEqual([]);
    expectSound(response.spec, { Comp: ['kind', 'id'] });

    const webhook = await parse('mixed-webhook', webhookDoc({ Comp: legacy }, mixed));
    expect(webhook.spec.webhooks?.[0]?.requestBody).toEqual(built('PetAdoptedPayload'));
    expect(webhook.warnings).toEqual([]);
    expectSound(webhook.spec, { Comp: ['kind', 'id'] });
  });

  it('assigns mapping entries to variants by position in the rewriter itself', () => {
    const ref: TypeRef = {
      kind: 'union',
      variants: [
        { kind: 'model', name: 'Comp' },
        { kind: 'model', name: 'Comp' },
        { kind: 'model', name: 'Other' },
      ],
      discriminator: { property: 'kind', mapping: { legacy: 'Comp', new: 'Comp', o: 'Other', o2: 'Other' } },
    };
    const second = ref.variants[1]!;
    // Only the second `Comp` is admitted: its entry (`new`) follows; `Other`, one variant, owns both of its entries.
    expect(
      renameTypeRefModels(
        ref,
        new Map([
          ['Comp', 'ThingComp'],
          ['Other', 'Moved'],
        ]),
        (r) => r !== ref.variants[0],
      ),
    ).toBe(true);
    expect(ref.variants.map((v) => (v as { name: string }).name)).toEqual(['Comp', 'ThingComp', 'Moved']);
    expect(ref.discriminator?.mapping).toEqual({ legacy: 'Comp', new: 'ThingComp', o: 'Moved', o2: 'Moved' });
    expect(second).toEqual({ kind: 'model', name: 'ThingComp' });
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
});
