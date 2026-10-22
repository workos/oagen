import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { nonObjectVariantContexts, type SchemaObject } from '../../src/parser/schemas.js';
import { collectModelRefs, collectResponseHeaders } from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #266: a `oneOf`/`anyOf` variant that is itself a `oneOf` of inline
 * objects was named by `schemaToTypeRef` from the field's own context — so
 * its first variant silently reused the outer variant 0's name — and never
 * materialized by any extractor, so its other variants dangled. The same
 * held for every other variant that mints a name under the field's context:
 * a nullable wrapper around an object, an `allOf`, an inline enum, and, in
 * a request body, an array. Every such variant is now typed and extracted
 * under a context of its own (`nonObjectVariantContexts`), at every site.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-nested-union-variants-'));
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
const int: SchemaObject = { type: 'integer' };
const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
  type: 'object',
  properties,
  ...extra,
});
const json = (schema: SchemaObject) => ({ content: { 'application/json': { schema } } });

// The issue's shapes, verbatim.
const message = obj({ message: str });
const a = obj({ type: { const: 'a' }, a: str });
const b = obj({ type: { const: 'b' }, b: str });
const nestedUnion: SchemaObject = { oneOf: [message, { oneOf: [a, b] }] };

/** A minimal OpenAPI 3.1 document. */
const specDoc = (paths: Record<string, unknown>, schemas: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'nested union variants', version: '1' },
  paths,
  components: { schemas },
});

/**
 * `schema` at every site that types an inline union: `createThing`'s request
 * body (`CreateThingRequest`), its 200 (`CreateThingResponse`), its 400
 * (`CreateThingError400`) and the component field `Holder.payload`
 * (`HolderPayload`). `Base` is there for an `allOf` to reference.
 */
const everySite = (schema: SchemaObject) =>
  specDoc(
    {
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: json(schema),
          responses: {
            '200': { description: 'OK', ...json(schema) },
            '400': { description: 'Bad', ...json(schema) },
          },
        },
      },
    },
    { Holder: obj({ payload: schema }), Base: obj({ id: str }) },
  );
const everySiteComponents = ['Holder', 'Base'];

/** A compact rendering of a type: `(A | (B | C?))`, `enum:E`, `M[]`. */
function render(t: TypeRef): string {
  switch (t.kind) {
    case 'model':
      return t.name;
    case 'enum':
      return `enum:${t.name}`;
    case 'union':
      return `(${t.variants.map(render).join(' | ')})`;
    case 'nullable':
      return `${render(t.inner)}?`;
    case 'array':
      return `${render(t.items)}[]`;
    case 'map':
      return `map<${render(t.valueType)}>`;
    case 'primitive':
      return t.type;
    case 'literal':
      return JSON.stringify(t.value);
  }
}

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

const fieldsOf = (spec: ApiSpec, name: string): string[] | undefined =>
  spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);

const fieldType = (spec: ApiSpec, model: string, field: string): TypeRef | undefined =>
  spec.models.find((m) => m.name === model)?.fields.find((f) => f.name === field)?.type;

/** The four types `everySite` produces, rendered, keyed by site. */
function siteTypes(spec: ApiSpec): Record<string, string> {
  const op = opsOf(spec)['createThing']!;
  return {
    body: render(op.requestBody!),
    response: render(op.response),
    error: render(op.errors[0]!.type!),
    field: render(fieldType(spec, 'Holder', 'payload')!),
  };
}

/** The names `everySite` gives the four sites' base models, keyed by site. */
const siteBases = {
  body: 'CreateThingRequest',
  response: 'CreateThingResponse',
  error: 'CreateThingError400',
  field: 'HolderPayload',
};

/** Every type reference an operation holds, labelled by where it sits. */
function operationRefs(op: Operation): Array<[string, TypeRef]> {
  const refs: Array<[string, TypeRef]> = [[`${op.name}.response`, op.response]];
  if (op.requestBody) refs.push([`${op.name}.requestBody`, op.requestBody]);
  for (const r of op.successResponses ?? []) refs.push([`${op.name}.${r.statusCode}`, r.type]);
  for (const e of op.errors) if (e.type) refs.push([`${op.name}.${e.statusCode}`, e.type]);
  for (const f of op.pagination?.envelopeFields ?? []) refs.push([`${op.name}.${f.name}`, f.type]);
  if (op.pagination) refs.push([`${op.name}.items`, op.pagination.itemType]);
  for (const h of collectResponseHeaders(op)) refs.push([`${op.name}.${h.name}`, h.type]);
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

/** The invariants every case holds: nothing dangles, nothing is orphaned, no model is named like an enum, no two models share a name. */
function expectSound(spec: ApiSpec, componentNames: string[]): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphanedModels(spec, componentNames)).toEqual([]);
  const enumNames = new Set(spec.enums.map((e) => e.name));
  expect(spec.models.map((m) => m.name).filter((name) => enumNames.has(name))).toEqual([]);
  const names = spec.models.map((m) => m.name);
  expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
}

describe("the issue's repro: a union nested under a oneOf variant (#266)", () => {
  // `getNote`'s 400, verbatim: `{ message }` beside a `oneOf` of `{ type: 'a', a }` and `{ type: 'b', b }`.
  const getNote = specDoc({
    '/notes/{id}': {
      get: {
        operationId: 'getNote',
        parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
        responses: {
          '200': { description: 'OK', ...json(obj({ id: str })) },
          '400': { description: 'Bad', ...json(nestedUnion) },
        },
      },
    },
  });

  it("mints one model per nested inline object variant, named from the nested union's own context, and resolves to them", async () => {
    const { spec, warnings } = await parse('get-note', getNote);
    const error = opsOf(spec)['getNote']!.errors[0]!.type!;
    // Not `(GetNoteError400 | (GetNoteError400 | BGetNoteError400))`: the
    // nested `a` variant never reuses the outer variant's name, and the
    // nested `b` variant has a model behind it.
    expect(render(error)).toBe('(GetNoteError400 | (GetNoteError400Variant2 | BGetNoteError400Variant2))');
    expect(fieldsOf(spec, 'GetNoteError400')).toEqual(['message']);
    expect(fieldsOf(spec, 'GetNoteError400Variant2')).toEqual(['type', 'a']);
    expect(fieldsOf(spec, 'BGetNoteError400Variant2')).toEqual(['type', 'b']);
    // The nested union keeps its own const discriminator, mapped onto the models it now has.
    expect(error).toMatchObject({
      variants: [
        {},
        {
          kind: 'union',
          compositionKind: 'oneOf',
          discriminator: { property: 'type', mapping: { a: 'GetNoteError400Variant2', b: 'BGetNoteError400Variant2' } },
        },
      ],
    });
    expect(warnings).toEqual([]);
    expectSound(spec, []);
  });

  it('holds for a request body, a 2xx response and a component field alike, since all go through the same extractor', async () => {
    const { spec, warnings } = await parse('every-site', everySite(nestedUnion));
    expect(siteTypes(spec)).toEqual({
      body: '(CreateThingRequest | (CreateThingRequestVariant2 | BCreateThingRequestVariant2))',
      response: '(CreateThingResponse | (CreateThingResponseVariant2 | BCreateThingResponseVariant2))',
      error: '(CreateThingError400 | (CreateThingError400Variant2 | BCreateThingError400Variant2))',
      field: '(HolderPayload | (HolderPayloadVariant2 | BHolderPayloadVariant2))',
    });
    for (const base of Object.values(siteBases)) {
      expect(fieldsOf(spec, base)).toEqual(['message']);
      expect(fieldsOf(spec, `${base}Variant2`)).toEqual(['type', 'a']);
      expect(fieldsOf(spec, `B${base}Variant2`)).toEqual(['type', 'b']);
    }
    expect(warnings).toEqual([]);
    expectSound(spec, everySiteComponents);
  });
});

describe('every other variant that mints a name under the field context is typed and extracted under its own', () => {
  const cases: Array<{
    label: string;
    schema: SchemaObject;
    type: (base: string) => string;
    models: (base: string) => Record<string, string[]>;
    enums?: (base: string) => string[];
  }> = [
    {
      label: 'a nullable wrapper around an inline object',
      schema: { oneOf: [message, { oneOf: [a, { type: 'null' }] }] },
      type: (base) => `(${base} | ${base}Variant2?)`,
      models: (base) => ({ [base]: ['message'], [`${base}Variant2`]: ['type', 'a'] }),
    },
    {
      label: 'an allOf augmenting a component',
      schema: { oneOf: [message, { allOf: [{ $ref: '#/components/schemas/Base' }, obj({ extra: str })] }] },
      type: (base) => `(${base} | ${base}Variant2)`,
      models: (base) => ({ [base]: ['message'], [`${base}Variant2`]: ['id', 'extra'] }),
    },
    {
      label: 'an allOf of inline members',
      schema: { oneOf: [message, { allOf: [obj({ x: str }), obj({ y: str })] }] },
      type: (base) => `(${base} | ${base}Variant2)`,
      models: (base) => ({ [base]: ['message'], [`${base}Variant2`]: ['x', 'y'] }),
    },
    {
      label: 'an inline enum',
      schema: { oneOf: [message, { type: 'string', enum: ['x', 'y'] }] },
      type: (base) => `(${base} | enum:${base}Variant2)`,
      models: (base) => ({ [base]: ['message'] }),
      enums: (base) => [`${base}Variant2`],
    },
    {
      label: 'a oneOf of string consts',
      schema: { oneOf: [message, { oneOf: [{ const: 'x' }, { const: 'y' }] }] },
      type: (base) => `(${base} | enum:${base}Variant2)`,
      models: (base) => ({ [base]: ['message'] }),
      enums: (base) => [`${base}Variant2`],
    },
    {
      label: 'a nested union with an array variant of its own',
      schema: { oneOf: [message, { oneOf: [a, { type: 'array', items: b }] }] },
      type: (base) => `(${base} | (${base}Variant2 | ${base}Variant2Item[]))`,
      models: (base) => ({
        [base]: ['message'],
        [`${base}Variant2`]: ['type', 'a'],
        [`${base}Variant2Item`]: ['type', 'b'],
      }),
    },
    {
      label: 'two nested unions, each under its own position',
      schema: { oneOf: [message, { oneOf: [a, b] }, { oneOf: [obj({ c: str }), obj({ d: str })] }] },
      type: (base) => `(${base} | (${base}Variant2 | B${base}Variant2) | (${base}Variant3 | ${base}Variant3WithD))`,
      models: (base) => ({
        [base]: ['message'],
        [`${base}Variant2`]: ['type', 'a'],
        [`B${base}Variant2`]: ['type', 'b'],
        [`${base}Variant3`]: ['c'],
        [`${base}Variant3WithD`]: ['d'],
      }),
    },
    {
      label: 'a union nested two levels down, named from the level above',
      schema: { oneOf: [message, { oneOf: [a, { oneOf: [b, obj({ z: str })] }] }] },
      type: (base) => `(${base} | (${base}Variant2 | (${base}Variant2Variant2 | ${base}Variant2Variant2WithZ)))`,
      models: (base) => ({
        [base]: ['message'],
        [`${base}Variant2`]: ['type', 'a'],
        [`${base}Variant2Variant2`]: ['type', 'b'],
        [`${base}Variant2Variant2WithZ`]: ['z'],
      }),
    },
    {
      label: 'an anyOf nested under an anyOf',
      schema: { anyOf: [message, { anyOf: [a, b] }] },
      type: (base) => `(${base} | (${base}Variant2 | B${base}Variant2))`,
      models: (base) => ({
        [base]: ['message'],
        [`${base}Variant2`]: ['type', 'a'],
        [`B${base}Variant2`]: ['type', 'b'],
      }),
    },
    {
      label: 'a nested union among array items',
      schema: { type: 'array', items: nestedUnion },
      type: (base) => `(${base} | (${base}Variant2 | B${base}Variant2))[]`,
      models: (base) => ({
        [base]: ['message'],
        [`${base}Variant2`]: ['type', 'a'],
        [`B${base}Variant2`]: ['type', 'b'],
      }),
    },
  ];

  it.each(cases)('$label', async ({ label, schema, type, models, enums }) => {
    const { spec, warnings } = await parse(label.replace(/\W+/g, '-'), everySite(schema));
    expect(siteTypes(spec)).toEqual(
      Object.fromEntries(Object.entries(siteBases).map(([site, base]) => [site, type(base)])),
    );
    for (const base of Object.values(siteBases)) {
      for (const [name, fields] of Object.entries(models(base))) expect(fieldsOf(spec, name)).toEqual(fields);
    }
    // An inline enum under an error body or a component field is promoted to
    // `spec.enums` under the name the reference uses (a request body's or 2xx
    // response's inline enum variant is not promoted — unchanged here).
    if (enums) {
      const names = spec.enums.map((e) => e.name);
      for (const base of [siteBases.error, siteBases.field])
        for (const name of enums(base)) expect(names).toContain(name);
    }
    expect(warnings).toEqual([]);
    expectSound(spec, everySiteComponents);
  });
});

describe('a variant keeps the field context when nothing it mints there is claimed', () => {
  it('a nested union beside only a primitive names its variants from the field, as before, and now has models', async () => {
    const { spec, warnings } = await parse('no-object-variant', everySite({ oneOf: [str, { oneOf: [a, b] }] }));
    expect(siteTypes(spec)).toEqual({
      body: '(string | (CreateThingRequest | BCreateThingRequest))',
      response: '(string | (CreateThingResponse | BCreateThingResponse))',
      error: '(string | (CreateThingError400 | BCreateThingError400))',
      field: '(string | (HolderPayload | BHolderPayload))',
    });
    for (const base of Object.values(siteBases)) {
      expect(fieldsOf(spec, base)).toEqual(['type', 'a']);
      expect(fieldsOf(spec, `B${base}`)).toEqual(['type', 'b']);
    }
    expect(warnings).toEqual([]);
    expectSound(spec, everySiteComponents);
  });

  it('an inline enum beside a primitive keeps its name', async () => {
    const { spec, warnings } = await parse(
      'enum-beside-primitive',
      everySite({ oneOf: [{ type: 'string', enum: ['x', 'y'] }, int] }),
    );
    expect(siteTypes(spec)).toEqual({
      body: '(enum:CreateThingRequest | integer)',
      response: '(enum:CreateThingResponse | integer)',
      error: '(enum:CreateThingError400 | integer)',
      field: '(enum:HolderPayload | integer)',
    });
    expect(spec.enums.map((e) => e.name)).toEqual(expect.arrayContaining(['CreateThingError400', 'HolderPayload']));
    expect(warnings).toEqual([]);
    expectSound(spec, everySiteComponents);
  });
});

describe('what counts as claimed, and how the context steps', () => {
  const thing = (properties: Record<string, SchemaObject>) => specDoc({}, { Thing: obj(properties) });

  it('a sibling property that mints the stepped name pushes the nested union on to `<field>_variant_<n>_value`', async () => {
    const { spec, warnings } = await parse(
      'sibling-claims',
      thing({ shape: nestedUnion, shape_variant_2: obj({ x: str }) }),
    );
    expect(render(fieldType(spec, 'Thing', 'shape')!)).toBe(
      '(ThingShape | (ThingShapeVariant2Value | BThingShapeVariant2Value))',
    );
    expect(fieldsOf(spec, 'ThingShapeVariant2')).toEqual(['x']);
    expect(fieldsOf(spec, 'ThingShapeVariant2Value')).toEqual(['type', 'a']);
    expect(fieldsOf(spec, 'BThingShapeVariant2Value')).toEqual(['type', 'b']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Thing']);
  });

  it("an object variant's own child that takes the stepped name pushes the nested union on the same way", async () => {
    const { spec, warnings } = await parse(
      'child-claims',
      thing({ shape: { oneOf: [obj({ variant_2: obj({ x: str }) }), { oneOf: [a, b] }] } }),
    );
    expect(render(fieldType(spec, 'Thing', 'shape')!)).toBe(
      '(ThingShape | (ThingShapeVariant2Value | BThingShapeVariant2Value))',
    );
    expect(fieldsOf(spec, 'ThingShapeVariant2')).toEqual(['x']);
    expect(fieldsOf(spec, 'ThingShapeVariant2Value')).toEqual(['type', 'a']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Thing']);
  });

  it('a sibling array whose items would take the stepped name reads it as claimed too: each side reads the other in isolation, so both step', async () => {
    // `shape_variant_2`'s items would be `ThingShapeVariant2`, the name the
    // nested union's first variant takes under `shape_variant_2`; read in
    // isolation, each claims it from the other, so the items step to
    // `shape_variant_2_item` and the nested union to `shape_variant_2_value`,
    // and neither keeps `ThingShapeVariant2` — the symmetric rule two sibling
    // unions already follow for a shared title.
    const { spec, warnings } = await parse(
      'sibling-steps',
      thing({ shape: nestedUnion, shape_variant_2: { type: 'array', items: obj({ x: str }) } }),
    );
    expect(render(fieldType(spec, 'Thing', 'shape')!)).toBe(
      '(ThingShape | (ThingShapeVariant2Value | BThingShapeVariant2Value))',
    );
    expect(render(fieldType(spec, 'Thing', 'shape_variant_2')!)).toBe('ThingShapeVariant2Item[]');
    expect(fieldsOf(spec, 'ThingShapeVariant2')).toBeUndefined();
    expect(fieldsOf(spec, 'ThingShapeVariant2Value')).toEqual(['type', 'a']);
    expect(fieldsOf(spec, 'ThingShapeVariant2Item')).toEqual(['x']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Thing']);
  });

  it('the position counts non-null variants only, and a null variant still makes the union nullable', async () => {
    const { spec, warnings } = await parse(
      'null-position',
      thing({ shape: { oneOf: [{ type: 'null' }, message, { oneOf: [a, b] }] } }),
    );
    expect(render(fieldType(spec, 'Thing', 'shape')!)).toBe(
      '(ThingShape | (ThingShapeVariant2 | BThingShapeVariant2))?',
    );
    expect(warnings).toEqual([]);
    expectSound(spec, ['Thing']);
  });

  it('the inline object variants are named first, whatever their position, so a nested union before them still steps', async () => {
    const { spec, warnings } = await parse('nested-first', thing({ shape: { oneOf: [{ oneOf: [a, b] }, message] } }));
    expect(render(fieldType(spec, 'Thing', 'shape')!)).toBe(
      '((ThingShapeVariant1 | BThingShapeVariant1) | ThingShape)',
    );
    expect(fieldsOf(spec, 'ThingShape')).toEqual(['message']);
    expect(fieldsOf(spec, 'ThingShapeVariant1')).toEqual(['type', 'a']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Thing']);
  });
});

describe('a request body `oneOf`', () => {
  const post = (schema: SchemaObject) =>
    specDoc(
      {
        '/things': {
          post: {
            operationId: 'createThing',
            requestBody: json(schema),
            responses: { '204': { description: 'OK' } },
          },
        },
      },
      { Base: obj({ id: str }) },
    );
  const body = (spec: ApiSpec) => render(opsOf(spec)['createThing']!.requestBody!);

  it("types an array variant's items under `<body>_item` instead of silently reusing variant 0's model", async () => {
    const { spec, warnings } = await parse('body-array', post({ oneOf: [message, { type: 'array', items: b }] }));
    expect(body(spec)).toBe('(CreateThingRequest | CreateThingRequestItem[])');
    expect(fieldsOf(spec, 'CreateThingRequest')).toEqual(['message']);
    expect(fieldsOf(spec, 'CreateThingRequestItem')).toEqual(['type', 'b']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Base']);
  });

  it('types a `type: ["object", "null"]` variant, which the body names by its own rule only for plain objects, under its position', async () => {
    const { spec, warnings } = await parse(
      'body-nullable-object',
      post({ oneOf: [message, obj({ type: { const: 'a' }, a: str }, { type: ['object', 'null'] })] }),
    );
    // The variant keeps its own `nullable` wrapper; the trailing `?` is the
    // body path's own rule, which has always read a `null`-admitting variant
    // as making the whole body nullable.
    expect(body(spec)).toBe('(CreateThingRequest | CreateThingRequestVariant2?)?');
    expect(fieldsOf(spec, 'CreateThingRequestVariant2')).toEqual(['type', 'a']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Base']);
  });

  it('keeps the body naming rule for its own inline object variants; a const-named one leaves the body name free for a nested union', async () => {
    const { spec, warnings } = await parse(
      'body-const-named',
      post({ oneOf: [obj({ grant_type: { const: 'password' }, password: str }), { oneOf: [a, b] }] }),
    );
    expect(body(spec)).toBe('(PasswordCreateThingRequest | (CreateThingRequest | BCreateThingRequest))');
    expect(fieldsOf(spec, 'PasswordCreateThingRequest')).toEqual(['grant_type', 'password']);
    expect(fieldsOf(spec, 'CreateThingRequest')).toEqual(['type', 'a']);
    expect(fieldsOf(spec, 'BCreateThingRequest')).toEqual(['type', 'b']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Base']);
  });

  it('a body typed by schemaToTypeRef alone — an anyOf, an array — has every inline model it references materialized', async () => {
    const bodies: Array<[string, SchemaObject, string]> = [
      [
        'anyOf',
        { anyOf: [message, { anyOf: [a, b] }] },
        '(CreateThingRequest | (CreateThingRequestVariant2 | BCreateThingRequestVariant2))',
      ],
      [
        'array',
        { type: 'array', items: nestedUnion },
        '(CreateThingRequest | (CreateThingRequestVariant2 | BCreateThingRequestVariant2))[]',
      ],
    ];
    for (const [label, schema, expected] of bodies) {
      const { spec, warnings } = await parse(`body-${label}`, post(schema));
      expect(body(spec)).toBe(expected);
      expect(fieldsOf(spec, 'CreateThingRequest')).toEqual(['message']);
      expect(fieldsOf(spec, 'CreateThingRequestVariant2')).toEqual(['type', 'a']);
      expect(fieldsOf(spec, 'BCreateThingRequestVariant2')).toEqual(['type', 'b']);
      expect(warnings).toEqual([]);
      expectSound(spec, ['Base']);
    }
  });
});

describe("a discriminated allOf + oneOf variant's field", () => {
  it('materializes a nested union and an array variant under the field, as a component field does', async () => {
    const { spec, warnings } = await parse(
      'discriminated-variant-field',
      specDoc(
        {
          '/disc': {
            get: {
              operationId: 'getDisc',
              responses: { '200': { description: 'OK', ...json({ $ref: '#/components/schemas/Disc' }) } },
            },
          },
        },
        {
          Disc: {
            allOf: [
              obj({ id: str }),
              {
                oneOf: [
                  obj({ kind: { const: 'one' }, f: nestedUnion }),
                  obj({ kind: { const: 'two' }, g: { oneOf: [message, { type: 'array', items: b }] } }),
                ],
              },
            ],
          },
        },
      ),
    );
    expect(render(fieldType(spec, 'DiscOne', 'f')!)).toBe('(DiscOneF | (DiscOneFVariant2 | BDiscOneFVariant2))');
    expect(fieldsOf(spec, 'DiscOneFVariant2')).toEqual(['type', 'a']);
    expect(fieldsOf(spec, 'BDiscOneFVariant2')).toEqual(['type', 'b']);
    expect(render(fieldType(spec, 'DiscTwo', 'g')!)).toBe('(DiscTwoG | DiscTwoGItem[])');
    expect(fieldsOf(spec, 'DiscTwoGItem')).toEqual(['type', 'b']);
    expect(warnings).toEqual([]);
    expectSound(spec, ['Disc', 'DiscOne', 'DiscTwo']);
  });
});

describe('a title-mapped nested union (Greptile round 1)', () => {
  // Every variant titled and pinning the same const: `nameInlineVariants`
  // names them by their titles, which are context-free — the same under
  // every context — so no step applies, but the models must still be built.
  const titledA = obj({ kind: { const: 'a' }, a: str }, { title: 'A' });
  const titledB = obj({ kind: { const: 'b' }, b: str }, { title: 'B' });
  const titledUnion: SchemaObject = { oneOf: [titledA, titledB] };

  it("the finding's shape: two titled objects beside `{ message }` — `A` and `B` are built and the nested mapping points at them", async () => {
    const { spec, warnings } = await parse('titled', everySite({ oneOf: [message, titledUnion] }));
    expect(siteTypes(spec)).toEqual({
      body: '(CreateThingRequest | (A | B))',
      response: '(CreateThingResponse | (A | B))',
      error: '(CreateThingError400 | (A | B))',
      field: '(HolderPayload | (A | B))',
    });
    expect(fieldsOf(spec, 'A')).toEqual(['kind', 'a']);
    expect(fieldsOf(spec, 'B')).toEqual(['kind', 'b']);
    expect(opsOf(spec)['createThing']!.errors[0]!.type).toMatchObject({
      variants: [{}, { kind: 'union', discriminator: { property: 'kind', mapping: { a: 'A', b: 'B' } } }],
    });
    expect(warnings).toEqual([]);
    expectSound(spec, everySiteComponents);
  });

  const cases: Array<{
    label: string;
    schema: SchemaObject;
    type: (base: string) => string;
    models: (base: string) => Record<string, string[]>;
  }> = [
    {
      label: 'beside only a primitive',
      schema: { oneOf: [str, titledUnion] },
      type: () => '(string | (A | B))',
      models: () => ({ A: ['kind', 'a'], B: ['kind', 'b'] }),
    },
    {
      label:
        'under an anyOf, which is never title-mapped: the titles name nothing, the const prefixes and the position do',
      schema: { anyOf: [message, { anyOf: [titledA, titledB] }] },
      type: (base) => `(${base} | (${base}Variant2 | B${base}Variant2))`,
      models: (base) => ({
        [base]: ['message'],
        [`${base}Variant2`]: ['kind', 'a'],
        [`B${base}Variant2`]: ['kind', 'b'],
      }),
    },
    {
      label: 'as the items of an array variant',
      schema: { oneOf: [message, { type: 'array', items: titledUnion }] },
      type: (base) => `(${base} | (A | B)[])`,
      models: (base) => ({ [base]: ['message'], A: ['kind', 'a'], B: ['kind', 'b'] }),
    },
    {
      label: 'two levels down, under a nested union that stepped',
      schema: { oneOf: [message, { oneOf: [obj({ x: str }), titledUnion] }] },
      type: (base) => `(${base} | (${base}Variant2 | (A | B)))`,
      models: (base) => ({ [base]: ['message'], [`${base}Variant2`]: ['x'], A: ['kind', 'a'], B: ['kind', 'b'] }),
    },
    {
      label: 'with one title already taken by an earlier variant: that variant falls back to a context-qualified name',
      schema: { oneOf: [message, { oneOf: [titledA, obj({ kind: { const: 'a2' }, z: str }, { title: 'A' })] }] },
      type: (base) => `(${base} | (A | A${base}))`,
      models: (base) => ({ [base]: ['message'], A: ['kind', 'a'], [`A${base}`]: ['kind', 'z'] }),
    },
  ];

  it.each(cases)('$label', async ({ label, schema, type, models }) => {
    const { spec, warnings } = await parse(label.replace(/\W+/g, '-'), everySite(schema));
    expect(siteTypes(spec)).toEqual(
      Object.fromEntries(Object.entries(siteBases).map(([site, base]) => [site, type(base)])),
    );
    for (const base of Object.values(siteBases)) {
      for (const [name, fields] of Object.entries(models(base))) expect(fieldsOf(spec, name)).toEqual(fields);
    }
    expect(warnings).toEqual([]);
    expectSound(spec, everySiteComponents);
  });

  it('a title that names a component is treated exactly as a field-level union treats it: the component wins, with the same warning', async () => {
    const titledComp = obj({ kind: { const: 'c' }, c: str }, { title: 'Comp' });
    const comp = { Comp: obj({ id: str }) };
    const nested = await parse(
      'titled-component-nested',
      specDoc({}, { ...comp, Thing: obj({ shape: { oneOf: [message, { oneOf: [titledComp, titledB] }] } }) }),
    );
    const flat = await parse(
      'titled-component-flat',
      specDoc({}, { ...comp, Thing: obj({ shape: { oneOf: [titledComp, titledB] } }) }),
    );
    expect(render(fieldType(nested.spec, 'Thing', 'shape')!)).toBe('(ThingShape | (Comp | B))');
    expect(render(fieldType(flat.spec, 'Thing', 'shape')!)).toBe('(Comp | B)');
    for (const { spec, warnings } of [nested, flat]) {
      expect(fieldsOf(spec, 'Comp')).toEqual(['id']);
      expect(fieldsOf(spec, 'B')).toEqual(['kind', 'b']);
      expect(warnings).toEqual([
        '[oagen] Warning: Inline model "Comp" has different fields than component schema — using component schema',
      ]);
      expectSound(spec, ['Comp', 'Thing']);
    }
  });
});

describe('nonObjectVariantContexts', () => {
  const nested: SchemaObject = { oneOf: [a, b] };
  const arr: SchemaObject = { type: 'array', items: b };
  const ref: SchemaObject = { $ref: '#/components/schemas/Base' };
  const nul: SchemaObject = { type: 'null' };

  it('maps a nested title-mapped union under the field context: its names are context-free, so nothing could claim them away', () => {
    const titled: SchemaObject = {
      oneOf: [
        obj({ kind: { const: 'a' }, a: str }, { title: 'A' }),
        obj({ kind: { const: 'b' }, b: str }, { title: 'B' }),
      ],
    };
    expect([
      ...nonObjectVariantContexts('shape', [message, titled], undefined, 'Thing', new Map([[message, 'ThingShape']])),
    ]).toEqual([[titled, 'shape']]);
  });

  it('maps every variant that mints a name and is not an inline object; a `$ref`, a primitive and `null` get no entry', () => {
    const contexts = nonObjectVariantContexts(
      'shape',
      [nul, message, nested, arr, ref, str],
      undefined,
      'Thing',
      new Map([[message, 'ThingShape']]),
    );
    expect([...contexts]).toEqual([
      [nested, 'shape_variant_2'],
      [arr, 'shape_item'],
    ]);
  });

  it('keeps the field context for a nested union whose names no object variant, sibling or earlier variant claims', () => {
    expect([...nonObjectVariantContexts('shape', [str, nested], undefined, 'Thing', new Map())]).toEqual([
      [nested, 'shape'],
    ]);
    // An earlier nested union of the same union claims the field context.
    const other: SchemaObject = { oneOf: [obj({ c: str }), obj({ d: str })] };
    expect([...nonObjectVariantContexts('shape', [str, nested, other], undefined, 'Thing', new Map())]).toEqual([
      [nested, 'shape'],
      [other, 'shape_variant_3'],
    ]);
  });

  it('reads the caller-reserved names as claims, like the object variants do', () => {
    const reserved = new Set(['ThingShape', 'ThingShapeVariant2']);
    expect([...nonObjectVariantContexts('shape', [str, nested], undefined, 'Thing', new Map(), reserved)]).toEqual([
      [nested, 'shape_variant_2_value'],
    ]);
  });

  it('decides nothing without a context name', () => {
    expect(nonObjectVariantContexts(undefined, [nested], undefined, 'Thing', new Map()).size).toBe(0);
  });
});
