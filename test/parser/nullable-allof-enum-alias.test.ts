import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Enum, Field, Parameter, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #606: a component written as a nullable `oneOf`/`anyOf` around an
 * `allOf` that declares its enum inline — `Kind: { oneOf: [{ allOf: [{
 * type: 'string', enum }] }, { type: 'null' }] }` — was recorded as an
 * alias of an enum component although it names none (`componentEntries`
 * unwraps the wrapper and the lone member, `isEnumComponentSchema` read
 * neither), so its model was skipped and `schemaToTypeRef` lifted the
 * inline enum under no name as `UnknownEnum`, `UnknownEnum2`, the
 * component's name lost. Now an alias is only a chain that passes a `$ref`
 * (`isEnumComponentAlias`), and the wrapper is read as the enum's own
 * declaration (`enumComponentDeclaration`): `Kind`, `Size` and `Color` are
 * the enums `Kind`, `Size` and `Color`, nullable, and a `$ref` to each is
 * `nullable<enum>` — the shape the same schema written inline on a field
 * has. The OAS 3.0 spelling, `nullable: true` beside a `oneOf` of one
 * variant, is no wrapper and keeps reading as before: a named union of one.
 */
describe('#606', () => {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const nul = { type: 'null' };
  const kindEnum = { type: 'string', enum: ['cat', 'dog'] };
  const sizeEnum = { type: 'string', enum: ['large', 'small'] };
  const colorEnum = { type: 'string', enum: ['black', 'white'] };
  const enumRef = (name: string): TypeRef => ({ kind: 'enum', name });
  const modelRef = (name: string): TypeRef => ({ kind: 'model', name });
  const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });

  /** The issue's `Kind`, `Size` and `Color`, OAS 3.1.0: a nullable `oneOf`/`anyOf` around a lone `allOf` of the enum, with and without an annotating member, and around the enum itself (as `Color` was already written). */
  const wrapped = {
    Kind: { oneOf: [{ allOf: [kindEnum] }, nul] },
    Size: { anyOf: [{ allOf: [sizeEnum, { description: 'The size of the pet.' }] }, nul] },
    Color: { oneOf: [colorEnum, nul] },
  };
  /** The same in OAS 3.0.3, which has no `null` type: `nullable: true` beside the `oneOf`/`anyOf`. */
  const wrapped30 = {
    Kind: { oneOf: [{ allOf: [kindEnum] }], nullable: true },
    Size: { anyOf: [{ allOf: [sizeEnum, { description: 'The size of the pet.' }] }], nullable: true },
    Color: { oneOf: [colorEnum], nullable: true },
  };
  /** The issue's `Pet`: `kind`, `size` and `color`, all required, each a `$ref` to the component of the same name. */
  const pet = (properties: Record<string, unknown> = {}) => ({
    type: 'object',
    required: ['kind', 'size', 'color'],
    properties: { kind: ref('Kind'), size: ref('Size'), color: ref('Color'), ...properties },
  });
  /** The issue's `getPet`, returning a `$ref` to `Pet`. */
  const getPet = {
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Pet') } } } },
      },
    },
  };

  /** Parse a document of `schemas`, `paths` and `webhooks` from a file, as a spec is read. */
  async function parse(
    schemas: Record<string, unknown>,
    paths: Record<string, unknown> = getPet,
    openapi = '3.1.0',
    webhooks?: Record<string, unknown>,
  ): Promise<ApiSpec> {
    const dir = await mkdtemp(join(tmpdir(), 'oagen-606-'));
    try {
      const file = join(dir, 'spec.json');
      const doc = {
        openapi,
        info: { title: 'Pets', version: '1' },
        paths,
        ...(webhooks ? { webhooks } : {}),
        components: { schemas },
      };
      await writeFile(file, JSON.stringify(doc));
      return await parseSpec(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const names = (spec: ApiSpec) => ({ enums: spec.enums.map((e) => e.name), models: spec.models.map((m) => m.name) });
  const fieldsOf = (spec: ApiSpec, model: string): Field[] => spec.models.find((m) => m.name === model)?.fields ?? [];
  const typed = ({ name, type, required }: Field) => ({ name, type, required });
  const values = (spec: ApiSpec, name: string) => spec.enums.find((e) => e.name === name)?.values.map((v) => v.value);
  const operations = (spec: ApiSpec) => spec.services.flatMap((service) => service.operations);
  /** No enum ever takes the name the type builder mints for an inline enum it has no context for. */
  const expectNoUnknownEnum = (spec: ApiSpec) =>
    expect(spec.enums.map((e) => e.name).filter((name) => name.startsWith('UnknownEnum'))).toEqual([]);

  it('reads the issue’s repro as the enums Kind, Size and Color, a $ref to each nullable<enum> (OAS 3.1.0)', async () => {
    const spec = await parse({ Pet: pet(), ...wrapped });

    expectNoUnknownEnum(spec);
    // No `Kind {}`, `Size {}` or `Color {}` model and no `…Variant1` enum: each
    // component is the enum of its own name, and the `null` variant makes a
    // `$ref` to it `nullable<enum>` — the shape the same schema has inline.
    expect(names(spec)).toEqual({ enums: ['Kind', 'Size', 'Color'], models: ['Pet'] });
    expect(fieldsOf(spec, 'Pet').map(typed)).toEqual([
      { name: 'kind', type: nullable(enumRef('Kind')), required: true },
      { name: 'size', type: nullable(enumRef('Size')), required: true },
      { name: 'color', type: nullable(enumRef('Color')), required: true },
    ]);
    // The annotating member's text is the enum's, as it is for the `allOf`
    // spelling without the wrapper.
    expect(
      spec.enums.map(({ name, description, values }) => ({ name, description, values: values.map((v) => v.value) })),
    ).toEqual([
      { name: 'Kind', description: undefined, values: ['cat', 'dog'] },
      { name: 'Size', description: 'The size of the pet.', values: ['large', 'small'] },
      { name: 'Color', description: undefined, values: ['black', 'white'] },
    ]);
    const [getPetOp] = operations(spec);
    expect(getPetOp.response).toEqual(modelRef('Pet'));

    // Whatever order the components are declared in.
    const reversed = await parse({ Color: wrapped.Color, Size: wrapped.Size, Kind: wrapped.Kind, Pet: pet() });
    expectNoUnknownEnum(reversed);
    expect(names(reversed)).toEqual({ enums: ['Color', 'Size', 'Kind'], models: ['Pet'] });
    expect(fieldsOf(reversed, 'Pet').map(typed)).toEqual(fieldsOf(spec, 'Pet').map(typed));
  });

  it('keeps the OAS 3.0.3 spelling — nullable: true beside a oneOf/anyOf of one variant — reading as before: a named union of one', async () => {
    const spec = await parse(
      { Pet: pet(), ...wrapped30, Plain: kindEnum, MaybePlain: { oneOf: [{ allOf: [ref('Plain')] }], nullable: true } },
      getPet,
      '3.0.3',
    );

    expectNoUnknownEnum(spec);
    // `nullable: true` beside the `oneOf` declares nothing (no `type`), and a
    // `oneOf` of one variant is a union of one, inline and as a component: the
    // model carries the enum as its `…Variant1`, and a `$ref` to it is the
    // model under the `nullable` the union admits.
    expect(names(spec)).toEqual({
      enums: ['Plain', 'KindVariant1', 'SizeVariant1', 'ColorVariant1'],
      models: ['Pet', 'Kind', 'Size', 'Color', 'MaybePlain'],
    });
    expect(fieldsOf(spec, 'Pet').map(typed)).toEqual([
      { name: 'kind', type: nullable(modelRef('Kind')), required: true },
      { name: 'size', type: nullable(modelRef('Size')), required: true },
      { name: 'color', type: nullable(modelRef('Color')), required: true },
    ]);
    const variants = (name: string) => spec.models.find((m) => m.name === name)?.variants;
    expect(variants('Kind')).toEqual([{ kind: 'enum', name: 'KindVariant1', values: ['cat', 'dog'] }]);
    expect(variants('Size')).toEqual([{ kind: 'enum', name: 'SizeVariant1', values: ['large', 'small'] }]);
    expect(variants('Color')).toEqual([{ kind: 'enum', name: 'ColorVariant1', values: ['black', 'white'] }]);
    expect(spec.enums.find((e) => e.name === 'SizeVariant1')?.description).toBe('The size of the pet.');
    // Nor is the same wrapper around a `$ref` an alias in this spelling: a
    // union of one whose variant is the enum.
    expect(variants('MaybePlain')).toEqual([enumRef('Plain')]);
  });

  it('reports nothing between Kind written as Color is and Kind written with the allOf (oagen diff exits 0, in either direction)', async () => {
    const before = await parse({ Pet: pet(), ...wrapped, Kind: { oneOf: [kindEnum, nul] } });
    const after = await parse({ Pet: pet(), ...wrapped });

    expectNoUnknownEnum(before);
    expectNoUnknownEnum(after);
    expect(names(before)).toEqual(names(after));
    expect(fieldsOf(before, 'Pet').map(typed)).toEqual(fieldsOf(after, 'Pet').map(typed));
    expect(diffSpecs(before, after)).toMatchObject({ changes: [], behaviorChanges: [] });
    expect(diffSpecs(after, before)).toMatchObject({ changes: [], behaviorChanges: [] });
  });

  it.each([
    ['an anyOf around the allOf', { anyOf: [{ allOf: [kindEnum] }, nul] }],
    ['the null variant first', { oneOf: [nul, { allOf: [kindEnum] }] }],
    ['two null variants', { anyOf: [nul, { allOf: [kindEnum] }, nul] }],
    [
      'null variants spelled { const: null } and { enum: [null] }',
      { oneOf: [{ const: null }, { allOf: [kindEnum] }, { enum: [null] }] },
    ],
    [
      'two annotating members',
      { oneOf: [{ allOf: [kindEnum, { description: 'The kind.' }, { 'x-owner': 'pets' }] }, nul] },
    ],
    [
      'three annotating members around a nested allOf',
      {
        oneOf: [
          {
            allOf: [
              { allOf: [kindEnum, { maxLength: 3 }] },
              { description: 'The kind.' },
              { deprecated: true },
              { example: 'cat' },
            ],
          },
          nul,
        ],
      },
    ],
    ['nested nullable wrappers', { oneOf: [{ oneOf: [kindEnum, nul] }, nul] }],
    ['an allOf around the nullable wrapper', { allOf: [{ oneOf: [kindEnum, nul] }] }],
    [
      'the member nullable by its own type list',
      { oneOf: [{ allOf: [{ type: ['string', 'null'], enum: ['cat', 'dog'] }] }, nul] },
    ],
    ['a oneOf of consts as the member', { oneOf: [{ allOf: [{ oneOf: [{ const: 'cat' }, { const: 'dog' }] }] }, nul] }],
  ])('reads a nullable wrapper around the enum declaration as the nullable enum Kind — %s', async (_spelling, Kind) => {
    const spec = await parse({ Pet: pet(), Kind, Size: wrapped.Size, Color: wrapped.Color });

    expectNoUnknownEnum(spec);
    expect(names(spec)).toEqual({ enums: ['Kind', 'Size', 'Color'], models: ['Pet'] });
    expect(values(spec, 'Kind')).toEqual(['cat', 'dog']);
    expect(fieldsOf(spec, 'Pet').map(typed)[0]).toEqual({
      name: 'kind',
      type: nullable(enumRef('Kind')),
      required: true,
    });
  });

  it('reads the wrapper’s own text, flag, default, keys and limits as the enum’s, as a field’s wrapper hands them down', async () => {
    const spec = await parse(
      {
        Pet: pet(),
        // The wrapper's own over the `allOf` layer's and the member's: text,
        // flag, default, keys; its limits conjoined for a parameter.
        Kind: {
          description: 'Wrapper.',
          deprecated: true,
          default: 'cat',
          'x-since': '2',
          maxLength: 3,
          oneOf: [{ allOf: [kindEnum, { description: 'Member.' }, { default: 'dog' }] }, nul],
        },
        // The `allOf` layer's annotating members still count under the wrapper.
        Size: {
          anyOf: [
            { allOf: [sizeEnum, { description: 'The size.' }, { deprecated: true }, { 'x-owner': 'pets' }] },
            nul,
          ],
        },
        // The branch's own stands where the wrapper declares none; the
        // wrapper's key wins where both declare one.
        Color: { oneOf: [{ ...colorEnum, description: 'Branch.', default: 'black', 'x-a': 1 }, nul], 'x-a': 2 },
      },
      {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [
              { name: 'kind', in: 'query', schema: ref('Kind') },
              { name: 'size', in: 'query', schema: ref('Size') },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    );

    expectNoUnknownEnum(spec);
    const read = ({ name, description, deprecated, default: fallback, extensions }: Enum) => ({
      name,
      description,
      deprecated,
      default: fallback,
      extensions,
    });
    expect(spec.enums.map(read)).toEqual([
      { name: 'Kind', description: 'Wrapper.', deprecated: true, default: 'cat', extensions: { 'x-since': '2' } },
      {
        name: 'Size',
        description: 'The size.',
        deprecated: true,
        default: undefined,
        extensions: { 'x-owner': 'pets' },
      },
      { name: 'Color', description: 'Branch.', deprecated: undefined, default: 'black', extensions: { 'x-a': 2 } },
    ]);
    // A parameter that names the enum reads the declaration as it reads any
    // enum component's: the wrapper's text, flag and default, its limit.
    const [listPets] = operations(spec);
    const param = ({ name, type, description, deprecated, default: fallback, constraints }: Parameter) => ({
      name,
      type,
      description,
      deprecated,
      default: fallback,
      constraints,
    });
    expect(listPets.queryParams.map(param)).toEqual([
      {
        name: 'kind',
        type: nullable(enumRef('Kind')),
        description: 'Wrapper.',
        deprecated: true,
        default: 'cat',
        constraints: { maxLength: 3 },
      },
      {
        name: 'size',
        type: nullable(enumRef('Size')),
        description: 'The size.',
        deprecated: true,
        default: undefined,
        constraints: undefined,
      },
    ]);
  });

  it('keeps a nullable lone allOf of a $ref to an enum component an alias, typed nullable<Kind>, with an alias in front of the wrapper too', async () => {
    const spec = await parse({
      Pet: {
        type: 'object',
        properties: { kind: ref('MaybeKind'), wrapped: ref('PetKind'), chained: ref('MaybeWrapped') },
      },
      Kind: kindEnum,
      // A true alias: the chain passes the `$ref`.
      MaybeKind: { oneOf: [{ allOf: [ref('Kind')] }, nul] },
      // The enum itself, nullable; a bare alias of it; an alias wrapping it again.
      Wrapped: wrapped.Kind,
      PetKind: ref('Wrapped'),
      MaybeWrapped: { anyOf: [{ allOf: [ref('Wrapped'), { description: 'Maybe.' }] }, nul] },
    });

    expectNoUnknownEnum(spec);
    expect(names(spec)).toEqual({ enums: ['Kind', 'Wrapped'], models: ['Pet'] });
    expect(fieldsOf(spec, 'Pet').map(typed)).toEqual([
      { name: 'kind', type: nullable(enumRef('Kind')), required: false },
      { name: 'wrapped', type: nullable(enumRef('Wrapped')), required: false },
      { name: 'chained', type: nullable(enumRef('Wrapped')), required: false },
    ]);
  });

  it('types the enum at every site that names it: array items, map values, a parameter, a request body, a response and a webhook payload', async () => {
    const spec = await parse(
      {
        Pet: pet({
          kinds: { type: 'array', items: ref('Kind') },
          byName: { type: 'object', additionalProperties: ref('Kind') },
        }),
        ...wrapped,
      },
      {
        ...getPet,
        '/pets': {
          post: {
            operationId: 'createPet',
            parameters: [{ name: 'kind', in: 'query', schema: ref('Kind') }],
            requestBody: { content: { 'application/json': { schema: ref('Size') } } },
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Color') } } } },
          },
        },
      },
      '3.1.0',
      {
        petKind: {
          post: {
            requestBody: { content: { 'application/json': { schema: ref('Kind') } } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    );

    expectNoUnknownEnum(spec);
    expect(names(spec)).toEqual({ enums: ['Kind', 'Size', 'Color'], models: ['Pet'] });
    expect(fieldsOf(spec, 'Pet').map(typed).slice(3)).toEqual([
      { name: 'kinds', type: { kind: 'array', items: nullable(enumRef('Kind')) }, required: false },
      { name: 'byName', type: { kind: 'map', valueType: nullable(enumRef('Kind')) }, required: false },
    ]);
    const createPet = operations(spec).find((op) => op.name === 'createPet')!;
    expect(createPet.queryParams.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: 'kind', type: nullable(enumRef('Kind')) },
    ]);
    expect(createPet.requestBody).toEqual(nullable(enumRef('Size')));
    expect(createPet.response).toEqual(nullable(enumRef('Color')));
    expect((spec.webhooks ?? []).map(({ name, requestBody }) => ({ name, requestBody }))).toEqual([
      { name: 'petKind', requestBody: nullable(enumRef('Kind')) },
    ]);
  });

  it('reads a oneOf of one variant with no null variant as the union of one it was, and properties beside the wrapper as the model they make', async () => {
    const spec = await parse({
      Pet: pet(),
      Kind: { oneOf: [{ allOf: [kindEnum] }] },
      Size: wrapped.Size,
      Color: { ...wrapped.Color, properties: { id: { type: 'string' } } },
    });

    expectNoUnknownEnum(spec);
    expect(names(spec).enums).toEqual(['Size', 'KindVariant1']);
    expect(names(spec).models).toEqual(['Pet', 'Kind', 'Color']);
    expect(fieldsOf(spec, 'Pet').map(typed).slice(0, 2)).toEqual([
      { name: 'kind', type: modelRef('Kind'), required: true },
      { name: 'size', type: nullable(enumRef('Size')), required: true },
    ]);
    expect(spec.models.find((m) => m.name === 'Kind')?.variants).toEqual([
      { kind: 'enum', name: 'KindVariant1', values: ['cat', 'dog'] },
    ]);
    expect(fieldsOf(spec, 'Color').map((f) => f.name)).toEqual(['id']);
  });
});
