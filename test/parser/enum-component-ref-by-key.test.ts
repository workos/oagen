import { describe, it, expect, afterAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import {
  clearSchemaNameTransform,
  componentTypeRef,
  extractSchemas,
  schemaToTypeRef,
  type SchemaObject,
} from '../../src/parser/schemas.js';
import { sentOnlyComponentNames } from '../../src/parser/inline-models.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { buildEmitterContext, collectReferencedNames, generateAllFiles } from '../../src/engine/generate-files.js';
import type { Emitter } from '../../src/engine/types.js';
import type { ApiSpec, Enum, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #668: `componentTypeRef` read an enum component, and its
 * nullability, by the name the `$ref`'s key resolves to, not by the key.
 * `cleanSchemaName` singularizes the leading word, so `Size` and `Sizes`
 * both resolve to `Size`: a `$ref` to a non-nullable enum `Sizes` gained
 * the `null` an enum `Size` admits, and with `Size` an object a `$ref` to it
 * was typed as the enum `Sizes` declares, the model `Size` built and never
 * referenced. Each `$ref` is typed as the component its key names, two enum
 * components of one name are one `Enum`, and a model and an enum of one
 * name are both kept and reported.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});
const warnings = (): string[] => warn.mock.calls.map(([m]) => String(m));

type Doc = Record<string, unknown>;
type Schemas = Record<string, Doc>;

async function writeDoc(doc: unknown, name = 'spec.json'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-668-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}
const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeDoc(doc));

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

const ref = (key: string): Doc => ({ $ref: `#/components/schemas/${key}` });
const json = (schema: unknown): Doc => ({ 'application/json': { schema } });
const enumRef = (name: string): TypeRef => ({ kind: 'enum', name });
const model = (name: string): TypeRef => ({ kind: 'model', name });
const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });

const document = (openapi: Version, schemas: Schemas, more: Doc = {}): Doc => ({
  openapi,
  info: { title: 'Repro 668', version: '1' },
  paths: {},
  ...more,
  components: { schemas, ...(more.components as Doc | undefined) },
});
/** The same components in the opposite order. */
const reversed = (schemas: Schemas): Schemas => Object.fromEntries(Object.entries(schemas).reverse());

/** `{ type: 'string', enum: ['small', 'large'] }`: the issue's `Sizes`, admitting no `null`. */
const plainSizes = (): Doc => ({ type: 'string', enum: ['small', 'large'] });
/** The issue's `Size` admitting `null`, in the version's own spelling. */
const nullableSize = (openapi: Version): Doc =>
  openapi === '3.1.0'
    ? { type: ['string', 'null'], enum: ['small', 'large', null] }
    : { type: 'string', nullable: true, enum: ['small', 'large', null] };
/** The issue's object `Size`. */
const objectSize = (): Doc => ({ type: 'object', properties: { width: { type: 'integer' } } });
/** The issue's `Pet`: two required fields, one `$ref` each. */
const pet = (): Doc => ({
  type: 'object',
  required: ['size', 'sizes'],
  properties: { size: ref('Size'), sizes: ref('Sizes') },
});

/** The issue's documents. */
const nullableJson = (openapi: Version): Doc =>
  document(openapi, { Size: nullableSize(openapi), Sizes: plainSizes(), Pet: pet() });
const objectJson = (openapi: Version): Doc =>
  document(openapi, { Size: objectSize(), Sizes: plainSizes(), Pet: pet() });
/** `nullable.json` with `Size` no longer admitting `null`. */
const plainJson = (openapi: Version): Doc => document(openapi, { Size: plainSizes(), Sizes: plainSizes(), Pet: pet() });

/** The issue's `show`. */
const show = (type: TypeRef): string =>
  type.kind === 'nullable' ? `${show(type.inner)} | null` : `${type.kind} ${(type as { name?: string }).name}`;
/** One line of the issue's script: `Pet`'s fields and the names in `spec.enums`. */
const scriptLine = (spec: ApiSpec): string => {
  const fields = spec.models.find(({ name }) => name === 'Pet')!.fields;
  return `${JSON.stringify(Object.fromEntries(fields.map(({ name, type }) => [name, show(type)])))} ${JSON.stringify(spec.enums.map(({ name }) => name))}`;
};

const modelOf = (spec: ApiSpec, name: string): Model | undefined => spec.models.find((m) => m.name === name);
const fieldTypes = (spec: ApiSpec, name: string): Record<string, TypeRef> =>
  Object.fromEntries(modelOf(spec, name)!.fields.map((f) => [f.name, f.type]));
const operationOf = (spec: ApiSpec, name: string): Operation =>
  spec.services.flatMap((s) => s.operations).find((o) => o.name === name)!;
const enumSummary = (spec: ApiSpec): string[] =>
  spec.enums.map((e) => `${e.name}: ${e.values.map((v) => v.value).join(', ')}`);
/** An IR with its models and enums in name order, so two documents that differ in component order compare equal. */
const sortedIr = (spec: ApiSpec): unknown => ({
  ...spec,
  models: [...spec.models].sort((a, b) => (a.name < b.name ? -1 : 1)),
  enums: [...spec.enums].sort((a, b) => (a.name < b.name ? -1 : 1)),
});

describe('#668 a $ref finds an enum component by its key, not by the name the key resolves to', () => {
  describe.each(VERSIONS)("the issue's documents on OAS %s", (openapi) => {
    it('types each $ref as the component its key names', async () => {
      // The issue's script printed, with nothing before it:
      //   nullable.json { size: 'enum Size | null', sizes: 'enum Size | null' } [ 'Size', 'Size' ]
      //   object.json { size: 'enum Size', sizes: 'enum Size' } [ 'Size' ]
      expect(scriptLine(await parse(nullableJson(openapi)))).toBe(
        '{"size":"enum Size | null","sizes":"enum Size"} ["Size"]',
      );
      expect(warnings()).toEqual([]);
      expect(scriptLine(await parse(objectJson(openapi)))).toBe('{"size":"model Size","sizes":"enum Size"} ["Size"]');
      // A model and an enum now both live under `Size`, which is said once.
      expect(warnings()).toEqual([
        '[oagen] Warning: Component schemas "Size" (a model) and "Sizes" (an enum) both resolve to "Size" — keeping both, each $ref typed as the component it names; a schemaNameTransform can give one a name of its own',
      ]);
    });

    it('keeps one enum `Size` for `Size` and `Sizes`, and references the model `Size`', async () => {
      const enums = await parse(nullableJson(openapi));
      expect(enums.enums).toEqual([
        {
          name: 'Size',
          values: [
            { name: 'SMALL', value: 'small' },
            { name: 'LARGE', value: 'large' },
          ],
        },
      ]);
      expect(enums.models.map((m) => m.name)).toEqual(['Pet']);

      const object = await parse(objectJson(openapi));
      expect(object.models.map((m) => m.name)).toEqual(['Size', 'Pet']);
      expect(fieldTypes(object, 'Size')).toEqual({ width: { kind: 'primitive', type: 'integer' } });
      expect(fieldTypes(object, 'Pet')).toEqual({ size: model('Size'), sizes: enumRef('Size') });
      expect(enumSummary(object)).toEqual(['Size: small, large']);
    });

    it('holds exactly one `Size` in `spec.enums` for `nullable.json`, in either component order, unreported', async () => {
      // The issue: "`spec.enums` holds two `Size` entries for `nullable.json`, with no warning".
      const schemas = (nullableJson(openapi) as { components: { schemas: Schemas } }).components.schemas;
      for (const ordered of [schemas, reversed(schemas)]) {
        const spec = await parse(document(openapi, ordered));
        expect(spec.enums.map((e) => e.name)).toEqual(['Size']);
        expect(spec.enums.filter((e) => e.name === 'Size')).toHaveLength(1);
        expect(fieldTypes(spec, 'Pet')).toEqual({ size: nullable(enumRef('Size')), sizes: enumRef('Size') });
      }
      // The two definitions agree (nullability is each reference's), so nothing is said.
      expect(warnings()).toEqual([]);
    });

    it('gives the same IR with the components in the opposite order', async () => {
      for (const build of [nullableJson, objectJson, plainJson]) {
        const doc = build(openapi) as { components: { schemas: Schemas } };
        const forward = await parse(doc);
        const forwardWarnings = warnings();
        warn.mockClear();
        const backward = await parse(document(openapi, reversed(doc.components.schemas)));
        expect(sortedIr(backward)).toEqual(sortedIr(forward));
        expect(warnings()).toEqual(forwardWarnings);
        warn.mockClear();
      }
    });

    it('reports `size` alone when `Size` stops admitting null (`oagen diff`)', async () => {
      const files = {
        nullable: await writeDoc(nullableJson(openapi), 'nullable.json'),
        plain: await writeDoc(plainJson(openapi), 'plain.json'),
      };
      const [before, after] = [await parseSpec(files.nullable), await parseSpec(files.plain)];
      // It was a breaking `field-type-changed` on `sizes` as well.
      expect(diffSpecs(before, after).changes).toEqual([
        {
          kind: 'model-modified',
          name: 'Pet',
          fieldChanges: [
            { kind: 'field-type-changed', fieldName: 'size', classification: 'breaking', details: 'type changed' },
          ],
          deprecatedChanged: false,
          classification: 'breaking',
        },
      ]);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const exit = async (from: string, to: string): Promise<number> =>
          ((await diffCommand({ old: from, new: to }).catch((e: unknown) => e)) as { exitCode: number }).exitCode;
        // `size` did change, so the diff is still breaking.
        expect(await exit(files.nullable, files.plain)).toBe(2);
        // Nothing but the order of the components differs.
        const swapped = await writeDoc(
          document(
            openapi,
            reversed((nullableJson(openapi) as { components: { schemas: Schemas } }).components.schemas),
          ),
        );
        expect(diffSpecs(before, await parseSpec(swapped)).changes).toEqual([]);
        expect(await exit(files.nullable, swapped)).toBe(0);
      } finally {
        log.mockRestore();
      }
    });
  });

  describe.each(VERSIONS)('every reference site, on OAS %s', (openapi) => {
    /** Each kind of site that names `Size` and `Sizes` by a `$ref`, once per key. */
    const siteDocument = (size: Doc): Doc =>
      document(
        openapi,
        {
          Size: size,
          Sizes: plainSizes(),
          Pet: {
            type: 'object',
            required: ['size', 'sizes'],
            properties: {
              size: ref('Size'),
              sizes: ref('Sizes'),
              size_items: { type: 'array', items: ref('Size') },
              sizes_items: { type: 'array', items: ref('Sizes') },
              size_values: { type: 'object', additionalProperties: ref('Size') },
              sizes_values: { type: 'object', additionalProperties: ref('Sizes') },
              size_variant: { oneOf: [ref('Size'), { type: 'integer' }] },
              sizes_variant: { oneOf: [ref('Sizes'), { type: 'integer' }] },
              size_all_of: { allOf: [ref('Size')] },
              sizes_all_of: { allOf: [ref('Sizes')] },
              size_list: ref('SizeList'),
              sizes_list: ref('SizesList'),
              size_pointer: { $ref: '#/components/schemas/Holder/properties/size' },
              sizes_pointer: { $ref: '#/components/schemas/Holder/properties/sizes' },
            },
          },
          Holder: { type: 'object', properties: { size: ref('Size'), sizes: ref('Sizes') } },
          // Array components: no model of their own, the items typed by key.
          SizeList: { type: 'array', items: ref('Size') },
          SizesList: { type: 'array', items: ref('Sizes') },
          // A named union: each `$ref` variant typed by key.
          Either: { oneOf: [ref('Size'), ref('Sizes'), ref('Holder')] },
        },
        {
          paths: {
            '/pets/{size}/{sizes}': {
              get: {
                operationId: 'listPets',
                parameters: [
                  { name: 'size', in: 'path', required: true, schema: ref('Size') },
                  { name: 'sizes', in: 'path', required: true, schema: ref('Sizes') },
                  { name: 'q_size', in: 'query', schema: ref('Size') },
                  { name: 'q_sizes', in: 'query', schema: ref('Sizes') },
                  { name: 'X-Size', in: 'header', schema: ref('Size') },
                  { name: 'X-Sizes', in: 'header', schema: ref('Sizes') },
                  { name: 'c_size', in: 'cookie', schema: ref('Size') },
                  { name: 'c_sizes', in: 'cookie', schema: ref('Sizes') },
                ],
                responses: {
                  '200': {
                    description: 'OK',
                    headers: { 'X-Rate-Size': { schema: ref('Size') }, 'X-Rate-Sizes': { schema: ref('Sizes') } },
                    content: json(ref('Sizes')),
                  },
                },
              },
              post: {
                operationId: 'createPet',
                requestBody: { content: json(ref('Sizes')) },
                responses: { '200': { description: 'OK', content: json(ref('Size')) } },
                callbacks: {
                  onSized: {
                    '{$request.body#/url}': {
                      post: {
                        requestBody: { content: json(ref('Sizes')) },
                        responses: { '200': { description: 'OK' } },
                      },
                    },
                  },
                },
              },
              put: {
                operationId: 'replacePet',
                requestBody: { content: json(ref('Size')) },
                responses: { '200': { description: 'OK', content: json(ref('Pet')) } },
              },
            },
          },
        },
      );

    /** What every site reads: `sizeType` wherever the `$ref` names `Size`, `sizesType` wherever it names `Sizes`. */
    const expectSites = (spec: ApiSpec, sizeType: TypeRef, sizesType: TypeRef): void => {
      const integer: TypeRef = { kind: 'primitive', type: 'integer' };
      expect(fieldTypes(spec, 'Pet')).toEqual({
        size: sizeType,
        sizes: sizesType,
        size_items: { kind: 'array', items: sizeType },
        sizes_items: { kind: 'array', items: sizesType },
        size_values: { kind: 'map', valueType: sizeType },
        sizes_values: { kind: 'map', valueType: sizesType },
        size_variant: { kind: 'union', variants: [sizeType, integer], compositionKind: 'oneOf' },
        sizes_variant: { kind: 'union', variants: [sizesType, integer], compositionKind: 'oneOf' },
        size_all_of: sizeType,
        sizes_all_of: sizesType,
        size_list: { kind: 'array', items: sizeType },
        sizes_list: { kind: 'array', items: sizesType },
        size_pointer: sizeType,
        sizes_pointer: sizesType,
      });
      expect(modelOf(spec, 'Either')!.variants).toEqual([sizeType, sizesType, model('Holder')]);

      const list = operationOf(spec, 'listPets');
      const params = [...list.pathParams, ...list.queryParams, ...list.headerParams, ...(list.cookieParams ?? [])];
      expect(Object.fromEntries(params.map((p) => [p.name, p.type]))).toEqual({
        size: sizeType,
        sizes: sizesType,
        q_size: sizeType,
        q_sizes: sizesType,
        'X-Size': sizeType,
        'X-Sizes': sizesType,
        c_size: sizeType,
        c_sizes: sizesType,
      });
      expect(Object.fromEntries(list.responseHeaders!.map((h) => [h.name, h.type]))).toEqual({
        'X-Rate-Size': sizeType,
        'X-Rate-Sizes': sizesType,
      });
      expect(list.response).toEqual(sizesType);

      const create = operationOf(spec, 'createPet');
      expect(create.requestBody).toEqual(sizesType);
      expect(create.response).toEqual(sizeType);
      expect(create.callbacks!.map((c) => c.requestBody)).toEqual([sizesType]);
      expect(operationOf(spec, 'replacePet').requestBody).toEqual(sizeType);
    };

    it('reads the nullability of an enum component by key', async () => {
      const spec = await parse(siteDocument(nullableSize(openapi)));
      expectSites(spec, nullable(enumRef('Size')), enumRef('Size'));
      expect(enumSummary(spec)).toEqual(['Size: small, large']);
      expect(warnings()).toEqual([]);
    });

    it('reads which of an object and an enum a key names', async () => {
      const spec = await parse(siteDocument(objectSize()));
      expectSites(spec, model('Size'), enumRef('Size'));
      expect(enumSummary(spec)).toEqual(['Size: small, large']);
    });

    it('wraps a $ref the site itself makes nullable once, whichever key it names', async () => {
      const spec = await parse(
        document(openapi, {
          Size: nullableSize(openapi),
          Sizes: plainSizes(),
          Pet: {
            type: 'object',
            properties:
              openapi === '3.1.0'
                ? {
                    size: { oneOf: [ref('Size'), { type: 'null' }] },
                    sizes: { oneOf: [ref('Sizes'), { type: 'null' }] },
                  }
                : {
                    size: { oneOf: [ref('Size')], nullable: true },
                    sizes: { oneOf: [ref('Sizes')], nullable: true },
                  },
          },
        }),
      );
      expect(fieldTypes(spec, 'Pet')).toEqual({ size: nullable(enumRef('Size')), sizes: nullable(enumRef('Size')) });
    });

    it('types a webhook payload and its parameter by key', async () => {
      const spec = await parse(
        document(
          '3.1.0',
          { Size: nullableSize('3.1.0'), Sizes: plainSizes() },
          {
            webhooks: {
              petSized: {
                post: {
                  parameters: [
                    { name: 'X-Size', in: 'header', schema: ref('Size') },
                    { name: 'X-Sizes', in: 'header', schema: ref('Sizes') },
                  ],
                  requestBody: { content: json(ref('Sizes')) },
                  responses: { '200': { description: 'OK' } },
                },
              },
            },
          },
        ),
      );
      const [webhook] = spec.webhooks!;
      expect(webhook!.requestBody).toEqual(enumRef('Size'));
      expect(Object.fromEntries(webhook!.headerParams.map((p) => [p.name, p.type]))).toEqual({
        'X-Size': nullable(enumRef('Size')),
        'X-Sizes': enumRef('Size'),
      });
    });
  });

  describe('every spelling of an enum component and of the null it admits', () => {
    const cases: Array<[string, Version, Doc, Doc]> = [
      [
        'an `enum:` list with a `null` entry and no type list',
        '3.1.0',
        { enum: ['small', 'large', null] },
        { enum: ['small', 'large'] },
      ],
      ['an OAS 3.1 type list', '3.1.0', { type: ['string', 'null'], enum: ['small', 'large'] }, plainSizes()],
      ['OAS 3.0 `nullable: true`', '3.0.3', { type: 'string', nullable: true, enum: ['small', 'large'] }, plainSizes()],
      [
        'a `oneOf` of consts with a `null` variant',
        '3.1.0',
        { oneOf: [{ const: 'small' }, { const: 'large' }, { type: 'null' }] },
        { oneOf: [{ const: 'small' }, { const: 'large' }] },
      ],
      [
        'an `anyOf` of one-value enums with `nullable: true`',
        '3.0.3',
        {
          anyOf: [
            { type: 'string', enum: ['small'] },
            { type: 'string', enum: ['large'] },
          ],
          nullable: true,
        },
        {
          anyOf: [
            { type: 'string', enum: ['small'] },
            { type: 'string', enum: ['large'] },
          ],
        },
      ],
      [
        'an `allOf` around the list',
        '3.1.0',
        { allOf: [{ type: ['string', 'null'], enum: ['small', 'large'] }], description: 'A size.' },
        { allOf: [{ type: 'string', enum: ['small', 'large'] }], description: 'A size.' },
      ],
      [
        'a nullable `oneOf` wrapper around the list',
        '3.1.0',
        { oneOf: [{ type: 'string', enum: ['small', 'large'] }, { type: 'null' }] },
        plainSizes(),
      ],
      [
        'OAS 3.0 `nullable: true` beside a `oneOf` of one variant',
        '3.0.3',
        { oneOf: [{ type: 'string', enum: ['small', 'large'] }], nullable: true },
        plainSizes(),
      ],
    ];

    it.each(cases)('%s', async (_label, openapi, admitsNull, plain) => {
      for (const [nullableKey, plainKey] of [
        ['Size', 'Sizes'],
        ['Sizes', 'Size'],
      ] as const) {
        const schemas: Schemas = {
          [nullableKey]: admitsNull,
          [plainKey]: plain,
          Pet: { type: 'object', properties: { admits_null: ref(nullableKey), plain: ref(plainKey) } },
        };
        for (const ordered of [schemas, reversed(schemas)]) {
          const spec = await parse(document(openapi, ordered));
          expect(fieldTypes(spec, 'Pet'), `${nullableKey} admits null`).toEqual({
            admits_null: nullable(enumRef('Size')),
            plain: enumRef('Size'),
          });
          expect(enumSummary(spec)).toEqual(['Size: small, large']);
        }
      }
      expect(warnings()).toEqual([]);
    });
  });

  describe('keys that resolve to one name', () => {
    it.each([
      ['a singularized leading word', 'Size', 'Sizes', 'Size'],
      ['a singularized `-es`', 'Status', 'Statuses', 'Status'],
      ['a key in another case', 'Note', 'note', 'Note'],
      ['a key in snake case', 'PetSize', 'pet_size', 'PetSize'],
    ])('reads each of the pair by key: %s', async (_label, first, second, name) => {
      for (const [nullableKey, plainKey] of [
        [first, second],
        [second, first],
      ]) {
        const spec = await parse(
          document('3.1.0', {
            [nullableKey]: { type: ['string', 'null'], enum: ['a', 'b'] },
            [plainKey]: { type: 'string', enum: ['a', 'b'] },
            Holder: { type: 'object', properties: { admits_null: ref(nullableKey), plain: ref(plainKey) } },
          }),
        );
        expect(fieldTypes(spec, 'Holder'), `${nullableKey} admits null`).toEqual({
          admits_null: nullable(enumRef(name)),
          plain: enumRef(name),
        });
        expect(spec.enums.map((e) => e.name)).toEqual([name]);
      }
      expect(warnings()).toEqual([]);
    });

    it('reads a key a $ref escapes as the key it decodes to', async () => {
      const spec = await parse(
        document('3.1.0', {
          'Size s': { type: ['string', 'null'], enum: ['a', 'b'] },
          'Size~s': { type: 'string', enum: ['a', 'b'] },
          Holder: {
            type: 'object',
            properties: {
              admits_null: { $ref: '#/components/schemas/Size%20s' },
              plain: { $ref: '#/components/schemas/Size~0s' },
            },
          },
        }),
      );
      // Both keys resolve to `SizeS`.
      expect(fieldTypes(spec, 'Holder')).toEqual({ admits_null: nullable(enumRef('SizeS')), plain: enumRef('SizeS') });
      expect(spec.enums.map((e) => e.name)).toEqual(['SizeS']);
    });

    it('keeps the key-based reading under a name transform', async () => {
      const file = await writeDoc(nullableJson('3.1.0'));
      const spec = await parseSpec(file, { schemaNameTransform: (name) => `Api${name}` });
      // `Size` and `Sizes` both transform to `ApiSize`, so neither is transformed (the collision guard).
      expect(fieldTypes(spec, 'ApiPet')).toEqual({ size: nullable(enumRef('Size')), sizes: enumRef('Size') });
      expect(spec.enums.map((e) => e.name)).toEqual(['Size']);
    });
  });

  describe('two enum components of one name are one `Enum`', () => {
    const holder = (...keys: string[]): Doc => ({
      type: 'object',
      properties: Object.fromEntries(keys.map((key) => [key.toLowerCase() === key ? `${key}_lower` : key, ref(key)])),
    });

    it('folds identical definitions silently, whatever each admits and documents', async () => {
      const schemas: Schemas = {
        Sizes: { type: 'string', enum: ['large', 'small'], description: 'From Sizes.', 'x-origin': 'Sizes' },
        Size: { type: 'string', enum: ['small', 'large'], description: 'From Size.', 'x-origin': 'Size' },
        size: { type: ['string', 'null'], enum: ['small', 'large'], description: 'From size.' },
        Holder: holder('Size', 'Sizes', 'size'),
      };
      for (const ordered of [schemas, reversed(schemas)]) {
        const spec = await parse(document('3.1.0', ordered));
        // The definition of the first key in string order (`Size` < `Sizes` < `size`), not of the first in the document.
        expect(spec.enums).toEqual([
          {
            name: 'Size',
            description: 'From Size.',
            values: [
              { name: 'SMALL', value: 'small' },
              { name: 'LARGE', value: 'large' },
            ],
            extensions: { 'x-origin': 'Size' },
          },
        ]);
        expect(fieldTypes(spec, 'Holder')).toEqual({
          Size: enumRef('Size'),
          Sizes: enumRef('Size'),
          size_lower: nullable(enumRef('Size')),
        });
      }
      expect(warnings()).toEqual([]);
    });

    it('keeps the definition with more values and reports the other', async () => {
      const schemas: Schemas = {
        Size: { type: ['string', 'null'], enum: ['small', 'large'] },
        Sizes: { type: 'string', enum: ['s', 'm', 'l'] },
        Holder: holder('Size', 'Sizes'),
      };
      for (const ordered of [schemas, reversed(schemas)]) {
        warn.mockClear();
        const spec = await parse(document('3.1.0', ordered));
        expect(enumSummary(spec)).toEqual(['Size: s, m, l']);
        // Each reference still carries the nullability of the key it names.
        expect(fieldTypes(spec, 'Holder')).toEqual({ Size: nullable(enumRef('Size')), Sizes: enumRef('Size') });
        expect(warnings()).toEqual([
          '[oagen] Warning: Component schemas "Sizes" and "Size" both resolve to the enum "Size" with different values, default or deprecation (3 vs 2 values) — keeping "Sizes", the one with more values',
        ]);
      }
    });

    it('keeps the first key in string order when the counts tie, whatever the document order', async () => {
      const schemas: Schemas = {
        Sizes: { type: 'string', enum: ['s', 'l'], description: 'From Sizes.' },
        Size: { type: 'string', enum: ['small', 'large'], description: 'From Size.' },
        Holder: holder('Size', 'Sizes'),
      };
      for (const ordered of [schemas, reversed(schemas)]) {
        warn.mockClear();
        const spec = await parse(document('3.1.0', ordered));
        expect(spec.enums).toEqual([
          {
            name: 'Size',
            description: 'From Size.',
            values: [
              { name: 'SMALL', value: 'small' },
              { name: 'LARGE', value: 'large' },
            ],
          },
        ]);
        expect(warnings()).toEqual([
          '[oagen] Warning: Component schemas "Size" and "Sizes" both resolve to the enum "Size" with different values, default or deprecation (2 vs 2 values) — keeping "Size", the first key in string order',
        ]);
      }
    });

    it.each<[string, Doc, Doc]>([
      [
        "the enum's own `deprecated`",
        { type: 'string', enum: ['small', 'large'], deprecated: true },
        { type: 'string', enum: ['small', 'large'] },
      ],
      [
        'its `default`',
        { type: 'string', enum: ['small', 'large'], default: 'small' },
        { type: 'string', enum: ['small', 'large'] },
      ],
      [
        "one value's `deprecated`",
        { oneOf: [{ const: 'small' }, { const: 'large', deprecated: true }] },
        { oneOf: [{ const: 'small' }, { const: 'large' }] },
      ],
    ])('reports two definitions that differ in %s', async (_label, size, sizes) => {
      const spec = await parse(document('3.1.0', { Sizes: sizes, Size: size, Holder: holder('Size', 'Sizes') }));
      expect(spec.enums).toHaveLength(1);
      expect(warnings()).toEqual([
        '[oagen] Warning: Component schemas "Size" and "Sizes" both resolve to the enum "Size" with different values, default or deprecation (2 vs 2 values) — keeping "Size", the first key in string order',
      ]);
    });

    it('reports every key that differs from the one kept, once each', async () => {
      const spec = await parse(
        document('3.1.0', {
          size: { type: 'string', enum: ['a'] },
          Sizes: { type: 'string', enum: ['a', 'b', 'c'] },
          Size: { type: 'string', enum: ['a', 'b'] },
          SIZE: { type: 'string', enum: ['c', 'b', 'a'] },
          Holder: holder('Size'),
        }),
      );
      // `SIZE` holds as many values as `Sizes` and sorts first; `Sizes` agrees with it, so it folds unreported.
      expect(spec.enums.map((e) => e.name)).toEqual(['Size']);
      expect(enumSummary(spec)).toEqual(['Size: c, b, a']);
      expect(warnings()).toEqual([
        '[oagen] Warning: Component schemas "SIZE" and "Size" both resolve to the enum "Size" with different values, default or deprecation (3 vs 2 values) — keeping "SIZE", the one with more values',
        '[oagen] Warning: Component schemas "SIZE" and "size" both resolve to the enum "Size" with different values, default or deprecation (3 vs 1 values) — keeping "SIZE", the one with more values',
      ]);
    });

    it('keeps the enum where its name first appears among the enums', async () => {
      const spec = await parse(
        document('3.1.0', {
          Kind: { type: 'string', enum: ['cat'] },
          Sizes: { type: 'string', enum: ['s', 'm', 'l'] },
          Color: { type: 'string', enum: ['red'] },
          Size: { type: 'string', enum: ['small', 'large'] },
        }),
      );
      expect(enumSummary(spec)).toEqual(['Kind: cat', 'Size: s, m, l', 'Color: red']);
    });

    it('leaves a document whose enum keys resolve to distinct names as it was', async () => {
      const spec = await parse(
        document('3.1.0', {
          PetSize: { type: ['string', 'null'], enum: ['small', 'large'] },
          // Only the leading word is singularized, so this one is `PetSizes`.
          PetSizes: plainSizes(),
          Holder: { type: 'object', properties: { a: ref('PetSize'), b: ref('PetSizes') } },
        }),
      );
      expect(fieldTypes(spec, 'Holder')).toEqual({ a: nullable(enumRef('PetSize')), b: enumRef('PetSizes') });
      expect(enumSummary(spec)).toEqual(['PetSize: small, large', 'PetSizes: small, large']);
      expect(warnings()).toEqual([]);
    });
  });

  describe('an enum component beside another kind of component of its name', () => {
    const string: TypeRef = { kind: 'primitive', type: 'string' };
    /** Every kind of component, with the type a `$ref` to it under either key resolves to. */
    const kinds: Array<[string, Doc, TypeRef, Schemas?]> = [
      ['an object', objectSize(), model('Size')],
      [
        'a nullable object',
        { type: ['object', 'null'], properties: { width: { type: 'integer' } } },
        nullable(model('Size')),
      ],
      [
        'an `allOf` model',
        { allOf: [ref('Base'), { type: 'object', properties: { width: { type: 'integer' } } }] },
        model('Size'),
        { Base: { type: 'object', properties: { id: { type: 'string' } } } },
      ],
      [
        'a named union',
        { oneOf: [ref('Base'), { type: 'object', properties: { width: { type: 'integer' } } }] },
        model('Size'),
        { Base: { type: 'object', properties: { id: { type: 'string' } } } },
      ],
      [
        'a bare $ref to a model',
        ref('Base'),
        model('Size'),
        { Base: { type: 'object', properties: { id: { type: 'string' } } } },
      ],
      ['an array', { type: 'array', items: { type: 'string' } }, { kind: 'array', items: string }],
      ['a primitive', { type: 'string' }, string],
      [
        'an alias of another enum',
        ref('Color'),
        enumRef('Color'),
        { Color: { type: 'string', enum: ['red', 'blue'] } },
      ],
    ];

    it.each(kinds)('types each $ref as the component it names beside %s', async (_label, other, otherType, more) => {
      for (const [enumKey, otherKey] of [
        ['Sizes', 'Size'],
        ['Size', 'Sizes'],
      ] as const) {
        const schemas: Schemas = {
          [enumKey]: { type: ['string', 'null'], enum: ['small', 'large'] },
          [otherKey]: other,
          ...more,
          Holder: { type: 'object', properties: { as_enum: ref(enumKey), as_other: ref(otherKey) } },
        };
        for (const ordered of [schemas, reversed(schemas)]) {
          const spec = await parse(document('3.1.0', ordered));
          expect(fieldTypes(spec, 'Holder'), `the enum is ${enumKey}`).toEqual({
            as_enum: nullable(enumRef('Size')),
            as_other: otherType,
          });
          expect(spec.enums.filter((e) => e.name === 'Size')).toHaveLength(1);
        }
      }
    });

    it('reports a model and an enum of one name, and keeps both', async () => {
      const schemas: Schemas = { Sizes: plainSizes(), size: objectSize(), Size: objectSize(), Pet: pet() };
      for (const ordered of [schemas, reversed(schemas)]) {
        warn.mockClear();
        const spec = await parse(document('3.1.0', ordered));
        expect(spec.models.map((m) => m.name).sort()).toEqual(['Pet', 'Size']);
        expect(enumSummary(spec)).toEqual(['Size: small, large']);
        expect(warnings()).toEqual([
          '[oagen] Warning: Component schemas "Size", "size" (a model) and "Sizes" (an enum) both resolve to "Size" — keeping both, each $ref typed as the component it names; a schemaNameTransform can give one a name of its own',
        ]);
      }
    });

    it('parts the two when a name transform gives one key a name of its own', async () => {
      const file = await writeDoc(objectJson('3.1.0'));
      const spec = await parseSpec(file, {
        schemaNameTransform: (name, originalName) => (originalName === 'Sizes' ? 'Sizes' : name),
      });
      expect(fieldTypes(spec, 'Pet')).toEqual({ size: model('Size'), sizes: enumRef('Sizes') });
      expect(spec.models.map((m) => m.name)).toEqual(['Size', 'Pet']);
      expect(enumSummary(spec)).toEqual(['Sizes: small, large']);
      expect(warnings()).toEqual([]);
    });

    it('reports nothing for an enum beside a component that builds no model of its name', async () => {
      await parse(
        document('3.1.0', {
          Size: plainSizes(),
          Sizes: { type: 'array', items: ref('Size') },
          Kind: { type: 'string', enum: ['cat', 'dog'] },
          Kinds: { type: 'string' },
          Color: { type: 'string', enum: ['red', 'blue'] },
          Colors: ref('Color'),
        }),
      );
      expect(warnings()).toEqual([]);
    });

    /**
     * The model side of a document must not depend on what an enum of the
     * model's name is called: each builder is parsed with the enum under a
     * key that resolves to the model's name and under one that resolves to
     * nothing else (`Tint`), and the two IRs must agree but for the enum's
     * name.
     */
    const modelSides: Array<[string, (enumKey: string, modelKey: string) => { schemas: Schemas; paths?: Doc }]> = [
      [
        'nested inline objects, enums and unions',
        (e, m) => ({
          schemas: {
            [e]: plainSizes(),
            [m]: {
              type: 'object',
              properties: {
                box: {
                  type: 'object',
                  deprecated: true,
                  description: 'A box.',
                  properties: { w: { type: 'integer' } },
                },
                kind: { type: 'string', enum: ['a', 'b'] },
                shape: { oneOf: [{ type: 'object', properties: { r: { type: 'number' } } }, { type: 'string' }] },
                items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
              },
            },
            Pet: { type: 'object', properties: { e: ref(e), m: ref(m) } },
          },
        }),
      ],
      [
        'a named union',
        (e, m) => ({
          schemas: {
            [e]: plainSizes(),
            [m]: {
              oneOf: [
                { type: 'object', properties: { a: { type: 'string' } } },
                { type: 'object', properties: { b: { type: 'string' } } },
                { type: 'string', enum: ['x', 'y'] },
              ],
            },
            Pet: { type: 'object', properties: { e: ref(e), m: ref(m) } },
          },
        }),
      ],
      [
        'a model only a request sends, with a field object named like a looser component',
        (e, m) => ({
          schemas: {
            [e]: plainSizes(),
            [m]: {
              type: 'object',
              properties: { owner: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
            },
            SizeOwner: { type: 'object', properties: { name: { type: 'string' } } },
          },
          paths: {
            '/sizes': {
              post: {
                operationId: 'createSize',
                requestBody: { content: json(ref(m)) },
                responses: { '200': { description: 'OK', content: json(ref('SizeOwner')) } },
              },
              get: {
                operationId: 'listSizes',
                responses: { '200': { description: 'OK', content: json(ref(e)) } },
              },
            },
          },
        }),
      ],
    ];

    it.each(modelSides)('builds the model side as it is without the shared name: %s', async (_label, build) => {
      /** The IR with the enum that stands in for `Size` renamed to it, in name order. */
      const normalized = (spec: ApiSpec, enumName: string): unknown =>
        JSON.parse(
          JSON.stringify(
            sortedIr({ ...spec, enums: spec.enums.map((e) => (e.name === enumName ? { ...e, name: 'Size' } : e)) }),
          )
            .split(`"kind":"enum","name":"${enumName}"`)
            .join('"kind":"enum","name":"Size"'),
        );
      for (const [enumKey, modelKey] of [
        ['Sizes', 'Size'],
        ['Size', 'Sizes'],
      ] as const) {
        const colliding = build(enumKey, modelKey);
        const apart = build('Tint', modelKey);
        warn.mockClear();
        const expected = normalized(
          await parse(document('3.1.0', apart.schemas, apart.paths ? { paths: apart.paths } : {})),
          'Tint',
        );
        const apartWarnings = warnings();
        for (const ordered of [colliding.schemas, reversed(colliding.schemas)]) {
          warn.mockClear();
          const spec = await parse(document('3.1.0', ordered, colliding.paths ? { paths: colliding.paths } : {}));
          expect(normalized(spec, 'Size'), `the enum is ${enumKey}`).toEqual(expected);
          // The shared name is reported, and nothing else is said that the document apart does not say.
          expect(warnings(), `the enum is ${enumKey}`).toEqual([
            `[oagen] Warning: Component schemas "${modelKey}" (a model) and "${enumKey}" (an enum) both resolve to "Size" — keeping both, each $ref typed as the component it names; a schemaNameTransform can give one a name of its own`,
            ...apartWarnings,
          ]);
        }
      }
    });

    it('keeps a model only sent whatever reads an enum, array, primitive or alias of its name', () => {
      const sorted = (names: Set<string>): string[] => [...names].sort();
      const send = (key: string): Doc => ({
        post: { requestBody: { content: json(ref(key)) }, responses: { '204': { description: 'No content' } } },
      });
      const receive = (key: string): Doc => ({
        get: { responses: { '200': { description: 'OK', content: json(ref(key)) } } },
      });
      const others: Array<[string, Doc]> = [
        ['an enum', plainSizes()],
        ['an array', { type: 'array', items: { type: 'string' } }],
        ['a primitive', { type: 'string' }],
        ['an alias of an enum', ref('Color')],
      ];
      for (const [label, other] of others) {
        const schemas = { Size: objectSize(), Sizes: other, Color: { type: 'string', enum: ['red'] } };
        // `Size` is sent; `Sizes`, which builds no model, is received, or read by nothing.
        const received = { paths: { '/sizes': { ...send('Size'), ...receive('Sizes') } }, components: { schemas } };
        expect(sorted(sentOnlyComponentNames(received)), `${label}, received`).toEqual(['Size']);
        const unread = { paths: { '/sizes': send('Size') }, components: { schemas } };
        expect(sorted(sentOnlyComponentNames(unread)), `${label}, unread`).toEqual(['Size']);
        // Sending the other alone says nothing of the model, which nothing reads; the alias reaches `Color`.
        const otherSent = { paths: { '/sizes': send('Sizes') }, components: { schemas } };
        expect(sorted(sentOnlyComponentNames(otherSent)), `${label}, sent alone`).toEqual(
          label === 'an alias of an enum' ? ['Color'] : [],
        );
        // A name no model holds is read from every key that resolves to it, as before.
        const alone = { Sizes: other, Color: { type: 'string', enum: ['red'] } };
        expect(
          sorted(sentOnlyComponentNames({ paths: { '/sizes': send('Sizes') }, components: { schemas: alone } })),
          `${label}, no model of the name`,
        ).toEqual(label === 'an alias of an enum' ? ['Color', 'Size'] : ['Size']);
      }
      // Two keys whose own model takes the name still count as one, as before.
      const twoModels = { Size: objectSize(), Sizes: objectSize() };
      expect(
        sorted(
          sentOnlyComponentNames({
            paths: { '/sizes': { ...send('Size'), ...receive('Sizes') } },
            components: { schemas: twoModels },
          }),
        ),
      ).toEqual([]);
    });
  });

  /**
   * "The IR never declares a model and an enum under one name" holds for
   * every name the parser mints; a model component and an enum component
   * of one name are the document's own, and both are kept. Every pass that
   * relies on the rule must then read the name as the model's where it
   * settles a model and as the enum's where it settles an enum, and
   * neither may be dropped or overwritten downstream.
   */
  describe('what reads a name a model component and an enum component share', () => {
    /** An object with one optional `name`, or one that requires it. */
    const owner = (required: boolean): Doc => ({
      type: 'object',
      ...(required ? { required: ['name'] } : {}),
      properties: { name: { type: 'string' } },
    });
    /** An object of another shape. */
    const tall = (): Doc => ({ type: 'object', properties: { height: { type: 'integer' } } });

    /**
     * A document every inline site of which mints a model from `inline`: an
     * operation's bodies, an array body's items, a second success entry, a
     * secondary media type, a `default` response, an error body, a model
     * nested under each, a body pinned by an `object` const, a title-mapped
     * request variant, a header, a parameter object, a webhook's payload,
     * header and title-mapped variants, and a callback's payload and header.
     * `e` and `m` are the keys of the enum and of the model component.
     */
    const sites = (schemas: Schemas, e: string, m: string, inline: Doc): Doc =>
      document('3.1.0', schemas, {
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [
                { name: 'owner', in: 'query', schema: inline },
                { name: 'e', in: 'query', schema: ref(e) },
              ],
              responses: {
                '200': { description: 'OK', headers: { 'X-Owner': { schema: inline } }, content: json(inline) },
                '404': { description: 'Not found', content: json(ref(m)) },
              },
            },
            post: {
              operationId: 'createPet',
              requestBody: { content: json(inline) },
              responses: {
                '200': {
                  description: 'OK',
                  content: json({ type: 'object', properties: { owner: inline, e: ref(e) } }),
                },
              },
              callbacks: {
                onOwned: {
                  '{$request.body#/url}': {
                    post: {
                      parameters: [{ name: 'X-Cb', in: 'header', schema: inline }],
                      requestBody: { content: json({ type: 'object', properties: { owner: inline, e: ref(e) } }) },
                      responses: { '200': { description: 'OK' } },
                    },
                  },
                },
              },
            },
          },
          '/notes': {
            get: {
              operationId: 'listNotes',
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    ...json({ type: 'array', items: inline }),
                    'application/yaml': { schema: { type: 'object', properties: { alt: inline } } },
                  },
                },
                '201': { description: 'Made', content: json({ type: 'object', properties: { made: inline } }) },
                '422': {
                  description: 'Bad',
                  content: json({
                    type: 'object',
                    required: ['code'],
                    properties: { code: { type: 'integer' }, detail: inline },
                  }),
                },
                default: {
                  description: 'Other',
                  content: json({ type: 'object', properties: { fallback: inline } }),
                },
              },
            },
            put: {
              operationId: 'replaceNote',
              requestBody: {
                content: json({
                  oneOf: [
                    { title: 'Shelter', type: 'object', properties: { city: { type: 'string' } } },
                    { title: 'Keeper', ...inline },
                  ],
                }),
              },
              responses: {
                '200': {
                  description: 'OK',
                  content: json({
                    type: 'object',
                    properties: { object: { type: 'string', const: 'note_thing' }, at: inline },
                  }),
                },
              },
            },
          },
        },
        webhooks: {
          petOwned: {
            post: {
              parameters: [{ name: 'X-Owner', in: 'header', schema: inline }],
              requestBody: {
                content: json({ type: 'object', properties: { owner: inline, e: ref(e), m: ref(m) } }),
              },
              responses: { '200': { description: 'OK' } },
            },
          },
          petSold: {
            post: {
              requestBody: {
                content: json({
                  oneOf: [
                    { title: 'Buyer', ...inline },
                    { title: 'Seller', type: 'object', properties: { shop: { type: 'string' }, e: ref(e) } },
                  ],
                }),
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      });

    /** Every model `sites` mints with no component in its way, by the site that mints it. */
    const SITE_NAMES = [
      'ListPetsResponse',
      'CreatePetResponse',
      'CreatePetResponseOwner',
      'CreatePetRequest',
      'ListNotesItem',
      'ListNotesResponse201',
      'ListNotesResponse201Made',
      'NoteThing',
      'NoteThingAt',
      'ShelterReplaceNoteRequest',
      'KeeperReplaceNoteRequest',
      'PetsXOwner',
      'PetsOwner',
      'ListNotesApplicationYamlResponse',
      'ListNotesApplicationYamlResponseAlt',
      'ListNotesDefaultResponse',
      'ListNotesDefaultResponseFallback',
      'PetOwnedPayload',
      'PetOwnedPayloadOwner',
      'PetOwnedXOwner',
      'BuyerPetSoldPayload',
      'SellerPetSoldPayload',
      'CreatePetOnOwnedPayload',
      'CreatePetOnOwnedPayloadOwner',
      'CreatePetOnOwnedXCb',
      'ErrorBodyWithCodeIntegerWithoutMessage',
      'ErrorBodyWithCodeIntegerWithoutMessageDetailWithName',
    ];
    /** A key that resolves to `name` and is not `name`: its snake-case spelling. */
    const snake = (name: string): string =>
      name.replace(/[A-Z]/g, (letter, index: number) => `${index ? '_' : ''}${letter.toLowerCase()}`);
    /** The IR in name order, the enum `enumName` standing under `as` wherever it is named. */
    const withEnumNamed = (spec: ApiSpec, enumName: string, as: string): unknown =>
      JSON.parse(
        JSON.stringify(
          sortedIr({ ...spec, enums: spec.enums.map((e) => (e.name === enumName ? { ...e, name: as } : e)) }),
        )
          .split(`"kind":"enum","name":"${enumName}"`)
          .join(`"kind":"enum","name":"${as}"`),
      );

    it('mints one model per site when no component is in the way', async () => {
      const spec = await parse(sites({ Tint: plainSizes(), Zed: owner(false) }, 'Tint', 'Zed', owner(true)));
      expect(spec.models.map((m) => m.name)).toEqual(['Zed', ...SITE_NAMES]);
    });

    it.each(SITE_NAMES)(
      'settles the inline model that would be %s against the model component, as with the enum under another key',
      async (shared) => {
        const enumKey = snake(shared);
        for (const [label, component, inline] of [
          ['the component admits the site', owner(false), owner(true)],
          ['the component is the site', owner(true), owner(true)],
          ['the component is another shape', tall(), owner(true)],
        ] as const) {
          warn.mockClear();
          const apart = withEnumNamed(
            await parse(sites({ Tint: plainSizes(), [shared]: component }, 'Tint', shared, inline)),
            'Tint',
            shared,
          );
          const apartWarnings = warnings();
          const colliding: Schemas = { [enumKey]: plainSizes(), [shared]: component };
          for (const ordered of [colliding, reversed(colliding)]) {
            warn.mockClear();
            const spec = await parse(sites(ordered, enumKey, shared, inline));
            // Both are there, under the one name.
            expect(spec.models.filter((m) => m.name === shared)).toHaveLength(1);
            expect(spec.enums.filter((e) => e.name === shared)).toHaveLength(1);
            expect(withEnumNamed(spec, shared, shared), label).toEqual(apart);
            expect(warnings(), label).toEqual([
              `[oagen] Warning: Component schemas "${shared}" (a model) and "${enumKey}" (an enum) both resolve to "${shared}" — keeping both, each $ref typed as the component it names; a schemaNameTransform can give one a name of its own`,
              ...apartWarnings,
            ]);
          }
        }
      },
    );

    it('reads an inline enum of the shared name against the enum component, as beside the enum alone', async () => {
      const build = (withModel: boolean, members: string[]): Doc =>
        document('3.1.0', {
          pet_owner: plainSizes(),
          ...(withModel ? { PetOwner: owner(false) } : {}),
          Pet: {
            type: 'object',
            properties: { owner: { type: 'string', enum: members }, e: ref('pet_owner') },
          },
        });
      for (const withModel of [true, false]) {
        // The same members: the component enum's name is shared.
        const same = await parse(build(withModel, ['small', 'large']));
        expect(fieldTypes(same, 'Pet').owner).toEqual({ kind: 'enum', name: 'PetOwner', values: ['small', 'large'] });
        expect(enumSummary(same)).toEqual(['PetOwner: small, large']);
        // Other members: the inline enum steps, the component enum stays.
        const other = await parse(build(withModel, ['y', 'z']));
        expect(fieldTypes(other, 'Pet').owner).toEqual({ kind: 'enum', name: 'PetOwner2', values: ['y', 'z'] });
        expect(enumSummary(other)).toEqual(['PetOwner: small, large', 'PetOwner2: y, z']);
        expect((withModel ? [same, other] : []).every((spec) => modelOf(spec, 'PetOwner') !== undefined)).toBe(true);
      }
    });

    it("reads the error bodies' shared enum against the enum component, as beside the enum alone", async () => {
      const error = (code: string): Doc => ({
        description: 'Error',
        content: json({
          type: 'object',
          required: ['message', 'code'],
          properties: { message: { type: 'string' }, code: { type: 'string', const: code } },
        }),
      });
      /** Two error bodies that pin `code` to two values: the shared enum would be `ErrorBodyCode`. */
      const build = (schemas: Schemas): Doc =>
        document('3.1.0', schemas, {
          paths: {
            '/a': { get: { operationId: 'getA', responses: { '204': { description: 'OK' }, '404': error('gone') } } },
            '/b': { get: { operationId: 'getB', responses: { '204': { description: 'OK' }, '404': error('lost') } } },
          },
        });
      const named = { type: 'object', properties: { name: { type: 'string' } } };
      const sameMembers = { type: 'string', enum: ['gone', 'lost'] };
      const otherMembers = { type: 'string', enum: ['x', 'y'] };
      const plainStrings =
        '[oagen] Warning: The values error bodies pin "code" to would be the shared enum "ErrorBodyCode", which enum "ErrorBodyCode" already holds — keeping those fields plain strings';
      for (const [members, code, said] of [
        [sameMembers, { kind: 'enum', name: 'ErrorBodyCode', values: ['gone', 'lost'] }, []],
        [otherMembers, { kind: 'primitive', type: 'string' }, [plainStrings]],
      ] as const) {
        warn.mockClear();
        const alone = await parse(build({ error_body_code: members }));
        expect(fieldTypes(alone, 'ErrorBodyWithCode').code).toEqual(code);
        expect(warnings()).toEqual(said);
        warn.mockClear();
        const beside = await parse(build({ error_body_code: members, ErrorBodyCode: named }));
        expect(fieldTypes(beside, 'ErrorBodyWithCode').code).toEqual(code);
        expect(beside.enums).toEqual(alone.enums);
        expect(fieldTypes(beside, 'ErrorBodyCode')).toEqual({ name: { kind: 'primitive', type: 'string' } });
        expect(warnings().slice(1)).toEqual(said);
      }
    });

    it('diffs the model and the enum of one name each among its own kind', async () => {
      const used = (schemas: Schemas): Doc => document('3.1.0', { ...schemas, Pet: pet() });
      const both = await parse(used({ Size: objectSize(), Sizes: plainSizes() }));
      const kinds = (from: ApiSpec, to: ApiSpec): string[] =>
        diffSpecs(from, to).changes.map((change) => `${change.kind} ${(change as { name?: string }).name}`);

      // The same document, components reversed: nothing.
      expect(kinds(both, await parse(used({ Sizes: plainSizes(), Size: objectSize() })))).toEqual([]);
      // The enum gains a value: the enum alone.
      const widerEnum = await parse(
        used({ Size: objectSize(), Sizes: { type: 'string', enum: ['small', 'large', 'huge'] } }),
      );
      expect(kinds(both, widerEnum)).toEqual(['enum-modified Size']);
      // The model gains a field: the model alone.
      const widerModel = await parse(
        used({
          Size: { type: 'object', properties: { width: { type: 'integer' }, depth: { type: 'integer' } } },
          Sizes: plainSizes(),
        }),
      );
      expect(kinds(both, widerModel)).toEqual(['model-modified Size']);
      // The object `Size` becomes an enum like `Sizes`: the model goes, the enum stays, `Pet.size` is retyped.
      const enumsOnly = await parse(used({ Size: plainSizes(), Sizes: plainSizes() }));
      expect(kinds(both, enumsOnly)).toEqual(['model-removed Size', 'model-modified Pet']);
      expect(kinds(enumsOnly, both)).toEqual(['model-added Size', 'model-modified Pet']);
    });

    it('hands both to an emitter, each among its own kind', async () => {
      const spec = await parse(
        document(
          '3.1.0',
          { Size: objectSize(), Sizes: plainSizes() },
          {
            paths: {
              '/sizes': {
                get: {
                  operationId: 'listSizes',
                  parameters: [{ name: 'sizes', in: 'query', schema: ref('Sizes') }],
                  responses: { '200': { description: 'OK', content: json(ref('Size')) } },
                },
              },
            },
          },
        ),
      );
      const referenced = collectReferencedNames(spec.services, spec.models);
      expect([...referenced.models]).toEqual(['Size']);
      expect([...referenced.enums]).toEqual(['Size']);

      const seen = { models: [] as Model[], enums: [] as Enum[] };
      const emitter = {
        language: 'recording',
        fileHeader: () => '',
        generateModels: (models: Model[]) => {
          seen.models = models;
          return [];
        },
        generateEnums: (enums: Enum[]) => {
          seen.enums = enums;
          return [];
        },
        generateResources: () => [],
        generateClient: () => [],
        generateErrors: () => [],
        generateTests: () => [],
      } as unknown as Emitter;
      generateAllFiles(spec, emitter, buildEmitterContext(spec, { namespace: 'test', outputDir: '/tmp/out' }));
      expect(seen.models.map((m) => `${m.name}: ${m.fields.map((f) => f.name).join(', ')}`)).toEqual(['Size: width']);
      expect(seen.enums.map((e) => `${e.name}: ${e.values.map((v) => v.value).join(', ')}`)).toEqual([
        'Size: small, large',
      ]);
      // Nothing but the shared name is reported: `validateModelRefs` finds the model its references name.
      expect(warnings()).toEqual([
        '[oagen] Warning: Component schemas "Size" (a model) and "Sizes" (an enum) both resolve to "Size" — keeping both, each $ref typed as the component it names; a schemaNameTransform can give one a name of its own',
      ]);
    });
  });

  describe('aliases and chains', () => {
    it.each(VERSIONS)('reads an alias through the key it names, on OAS %s', async (openapi) => {
      const schemas: Schemas = {
        Size: nullableSize(openapi),
        Sizes: plainSizes(),
        OfSize: ref('Size'),
        OfSizes: ref('Sizes'),
        OfSizesAgain: ref('OfSizes'),
        DescribedSizes: { allOf: [ref('Sizes'), { description: 'Described.' }] },
        DescribedSize: { allOf: [ref('Size'), { description: 'Described.' }] },
        MaybeSizes:
          openapi === '3.1.0' ? { oneOf: [ref('Sizes'), { type: 'null' }] } : { oneOf: [ref('Sizes')], nullable: true },
        Holder: {
          type: 'object',
          properties: Object.fromEntries(
            ['OfSize', 'OfSizes', 'OfSizesAgain', 'DescribedSizes', 'DescribedSize', 'MaybeSizes'].map((key) => [
              key,
              ref(key),
            ]),
          ),
        },
      };
      for (const ordered of [schemas, reversed(schemas)]) {
        const spec = await parse(document(openapi, ordered));
        expect(fieldTypes(spec, 'Holder')).toEqual({
          OfSize: nullable(enumRef('Size')),
          OfSizes: enumRef('Size'),
          OfSizesAgain: enumRef('Size'),
          DescribedSizes: enumRef('Size'),
          DescribedSize: nullable(enumRef('Size')),
          MaybeSizes: nullable(enumRef('Size')),
        });
        expect(spec.models.map((m) => m.name)).toEqual(['Holder']);
        expect(enumSummary(spec)).toEqual(['Size: small, large']);
      }
      expect(warnings()).toEqual([]);
    });

    it('reads what a parameter takes from the component by the key its $ref names', async () => {
      const spec = await parse(
        document(
          '3.1.0',
          {
            Size: { type: 'string', enum: ['small', 'large'], default: 'small', description: 'Of Size.' },
            Sizes: { type: ['string', 'null'], enum: ['large', 'small'], default: 'large', description: 'Of Sizes.' },
          },
          {
            paths: {
              '/pets': {
                get: {
                  operationId: 'listPets',
                  parameters: [
                    { name: 'size', in: 'query', schema: ref('Size') },
                    { name: 'sizes', in: 'query', schema: ref('Sizes') },
                  ],
                  responses: { '204': { description: 'No content' } },
                },
              },
            },
          },
        ),
      );
      expect(
        operationOf(spec, 'listPets').queryParams.map(({ name, type, description, default: def }) => ({
          name,
          type,
          description,
          default: def,
        })),
      ).toEqual([
        { name: 'size', type: enumRef('Size'), description: 'Of Size.', default: 'small' },
        { name: 'sizes', type: nullable(enumRef('Size')), description: 'Of Sizes.', default: 'large' },
      ]);
      // One `Enum`, the definition of the first key in string order; the two differ in `default`, which is reported.
      expect(spec.enums.map(({ name, description, default: def }) => ({ name, description, default: def }))).toEqual([
        { name: 'Size', description: 'Of Size.', default: 'small' },
      ]);
      expect(warnings()).toHaveLength(1);
    });
  });

  describe('the type builder, read directly', () => {
    afterEach(() => {
      clearSchemaNameTransform();
    });

    it('resolves a $ref by the key it names while the schemas are active', () => {
      const schemas: Record<string, SchemaObject> = {
        Size: { type: 'string', nullable: true, enum: ['small', 'large'] },
        Sizes: { type: 'string', enum: ['small', 'large'] },
        Kind: { type: 'object', properties: { name: { type: 'string' } } },
        Kinds: { type: 'string', enum: ['cat', 'dog'] },
      };
      const { enums, models } = extractSchemas(schemas);
      expect(enums.map((e) => e.name)).toEqual(['Size', 'Kind']);
      expect(models.map((m) => m.name)).toEqual(['Kind']);
      expect(componentTypeRef('Size')).toEqual(nullable(enumRef('Size')));
      expect(componentTypeRef('Sizes')).toEqual(enumRef('Size'));
      expect(componentTypeRef('Kind')).toEqual(model('Kind'));
      expect(componentTypeRef('Kinds')).toEqual(enumRef('Kind'));
      expect(schemaToTypeRef({ $ref: '#/components/schemas/Sizes' })).toEqual(enumRef('Size'));
      expect(schemaToTypeRef({ type: 'array', items: { $ref: '#/components/schemas/Kind' } })).toEqual({
        kind: 'array',
        items: model('Kind'),
      });
      // A key the document does not declare is no enum, whatever name it resolves to.
      expect(componentTypeRef('size')).toEqual(model('Size'));
    });

    it('reads every $ref as a model reference once the schemas are cleared, as before', () => {
      extractSchemas({ Sizes: { type: 'string', enum: ['small', 'large'] } });
      clearSchemaNameTransform();
      expect(componentTypeRef('Sizes')).toEqual(model('Size'));
    });
  });
});
