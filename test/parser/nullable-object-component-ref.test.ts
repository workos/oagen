import { describe, it, expect, afterAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #615: a `$ref` to an object component that admits `null` —
 * `type: ['object', 'null']`, or `nullable: true` in OAS 3.0 — was typed as
 * the bare model, while the same schema written inline, and a JSON Pointer
 * to that inline field (#592), were `nullable<PetOwner>`. A `$ref` to such
 * a component now carries the component's own nullability, as a `$ref` to
 * a nullable enum, array, primitive or named-union component does, at every
 * reference site, and an alias of it (`allOf: [{ $ref }]`) carries it too,
 * while an `allOf` that merges a typing member beside the `$ref` stays the
 * object its fields describe.
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

async function writeDoc(doc: unknown, name = 'spec.json'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-615-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}
const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeDoc(doc));

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const model = (name: string): TypeRef => ({ kind: 'model', name });
const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
const string: TypeRef = { kind: 'primitive', type: 'string' };

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

const nameProperties = { name: { type: 'string' } };
/** The issue's `owner` schema: an object that admits `null`, in the version's own spelling. */
const nullableOwner = (openapi: Version) =>
  openapi === '3.1.0'
    ? { type: ['object', 'null'], required: ['name'], properties: nameProperties }
    : { type: 'object', nullable: true, required: ['name'], properties: nameProperties };
/** An object that admits nothing but an object. */
const plainObject = { type: 'object', properties: { id: { type: 'string' } } };

const getPetOwner = (schema: unknown) => ({
  '/pets/{petId}/owner': {
    get: {
      operationId: 'getPetOwner',
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'The owner.', content: { 'application/json': { schema } } } },
    },
  },
});

const doc = (
  openapi: Version,
  schemas: Record<string, unknown>,
  paths: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({ openapi, info: { title: 'repro', version: '1' }, paths, components: { schemas }, ...extra });

/** `pointer.json`: `Pet.owner` written inline, the response a JSON Pointer to it. */
const pointerDoc = (openapi: Version) =>
  doc(
    openapi,
    { Pet: { type: 'object', properties: { owner: nullableOwner(openapi) } } },
    getPetOwner(ref('Pet/properties/owner')),
  );
/** `component.json`: `owner` extracted as `PetOwner`, `Pet.owner` and the response both `$ref: PetOwner`. */
const componentDoc = (openapi: Version, order: 'pet-first' | 'owner-first' = 'pet-first') => {
  const Pet = { type: 'object', properties: { owner: ref('PetOwner') } };
  const PetOwner = nullableOwner(openapi);
  return doc(openapi, order === 'pet-first' ? { Pet, PetOwner } : { PetOwner, Pet }, getPetOwner(ref('PetOwner')));
};

const modelOf = (spec: ApiSpec, name: string) => spec.models.find((m) => m.name === name);
const fieldType = (spec: ApiSpec, modelName: string, field: string): TypeRef | undefined =>
  modelOf(spec, modelName)?.fields.find((f) => f.name === field)?.type;
const fieldNames = (spec: ApiSpec, modelName: string): string[] | undefined =>
  modelOf(spec, modelName)?.fields.map((f) => f.name);
const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((o) => [o.name, o]));

describe('#615', () => {
  describe.each(VERSIONS)('on OAS %s', (openapi) => {
    it('types `Pet.owner` and the `getPetOwner` response as `nullable<PetOwner>` through a `$ref` to the component, as through a pointer to the inline field (issue repro)', async () => {
      const specs: Array<[string, ApiSpec]> = [
        ['pointer.json', await parse(pointerDoc(openapi))],
        ['component.json', await parse(componentDoc(openapi))],
        ['component.json, PetOwner declared first', await parse(componentDoc(openapi, 'owner-first'))],
      ];
      for (const [label, spec] of specs) {
        expect(fieldType(spec, 'Pet', 'owner'), label).toEqual(nullable(model('PetOwner')));
        expect(opsOf(spec).getPetOwner.response, label).toEqual(nullable(model('PetOwner')));
        // The model is untouched: it carries the fields, never a wrapper.
        expect(
          modelOf(spec, 'PetOwner')?.fields.map(({ name, type, required }) => ({ name, type, required })),
          label,
        ).toEqual([{ name: 'name', type: string, required: true }]);
      }
      expect(warnings()).toEqual([]);
    });

    it('`oagen diff` between the two spellings reports no change and exits 0', async () => {
      const files = {
        pointer: await writeDoc(pointerDoc(openapi), 'pointer.json'),
        component: await writeDoc(componentDoc(openapi), 'component.json'),
      };
      const specs = { pointer: await parseSpec(files.pointer), component: await parseSpec(files.component) };
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        for (const [from, to] of [
          ['component', 'pointer'],
          ['pointer', 'component'],
        ] as const) {
          expect(diffSpecs(specs[from], specs[to]).changes, `${from} → ${to}`).toEqual([]);
          const error = (await diffCommand({ old: files[from], new: files[to] }).catch((e: unknown) => e)) as {
            exitCode: number;
          };
          expect(error.exitCode, `${from} → ${to}`).toBe(0);
        }
      } finally {
        log.mockRestore();
      }
    });

    const spellings: Array<[string, Record<string, unknown>]> =
      openapi === '3.1.0'
        ? [
            ['an OAS 3.1 type list', { type: ['object', 'null'], properties: nameProperties }],
            ['an OAS 3.1 type list, null first', { type: ['null', 'object'], properties: nameProperties }],
            [
              'a single-member `allOf` around a type list',
              { allOf: [{ type: ['object', 'null'], properties: nameProperties }] },
            ],
          ]
        : [
            ['an OAS 3.0 nullable flag', { type: 'object', nullable: true, properties: nameProperties }],
            [
              'a single-member `allOf` around a nullable flag',
              { allOf: [{ type: 'object', nullable: true, properties: nameProperties }] },
            ],
          ];
    const objectVariant = { type: 'object', properties: nameProperties };
    spellings.push(
      ['a `oneOf` with a `null` variant', { oneOf: [objectVariant, { type: 'null' }] }],
      ['a `oneOf` with a `null` variant first', { oneOf: [{ type: 'null' }, objectVariant] }],
      ['an `anyOf` with a `null` variant', { anyOf: [objectVariant, { type: 'null' }] }],
      [
        '`properties` beside a `oneOf` with a `null` variant',
        { properties: { own: { type: 'string' } }, oneOf: [objectVariant, { type: 'null' }] },
      ],
    );

    it.each(spellings)(
      'wraps a `$ref` to a component that admits `null` through %s, as the same schema written inline is wrapped',
      async (label, schema) => {
        const spec = await parse(
          doc(
            openapi,
            { Thing: schema, Holder: { type: 'object', properties: { via_ref: ref('Thing'), inline: schema } } },
            getPetOwner(ref('Thing')),
          ),
        );
        expect(fieldType(spec, 'Holder', 'via_ref')).toEqual(nullable(model('Thing')));
        expect(fieldType(spec, 'Holder', 'inline')).toEqual(nullable(model('HolderInline')));
        expect(opsOf(spec).getPetOwner.response).toEqual(nullable(model('Thing')));
        expect(fieldNames(spec, 'Thing')).toEqual(label.startsWith('`properties`') ? ['own', 'name'] : ['name']);
      },
    );

    it('carries the nullability to every reference site, and wraps a site that wraps the `$ref` itself once', async () => {
      const C = nullableOwner(openapi);
      const refC = ref('C');
      const wrappedRef = openapi === '3.1.0' ? { ...refC, type: ['object', 'null'] } : { ...refC, nullable: true };
      const spec = await parse(
        doc(
          openapi,
          {
            C,
            Pet: plainObject,
            Union: { oneOf: [refC, ref('Pet')] },
            MaybeC: { oneOf: [refC, { type: 'null' }] },
            Holder: {
              type: 'object',
              properties: {
                c: refC,
                items: { type: 'array', items: refC },
                values: { type: 'object', additionalProperties: refC },
                either: { oneOf: [refC, ref('Pet')] },
                union: ref('Union'),
                maybe_c: ref('MaybeC'),
                pointer: ref('Holder/properties/c'),
                // Each wraps the `$ref` itself: one wrapper, never two.
                one_of_null: { oneOf: [refC, { type: 'null' }] },
                null_one_of: { oneOf: [{ type: 'null' }, refC] },
                any_of_null: { anyOf: [refC, { type: 'null' }] },
                all_of_ref: { allOf: [refC] },
                all_of_ref_nullable: { allOf: [refC], nullable: true },
                wrapped_ref: wrappedRef,
              },
            },
          },
          {
            '/cs/{id}': {
              get: {
                operationId: 'getC',
                parameters: [
                  { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                  { name: 'filter', in: 'query', schema: refC },
                  { name: 'X-C', in: 'header', schema: refC },
                  { name: 'session', in: 'cookie', schema: refC },
                ],
                responses: {
                  '200': {
                    description: 'ok',
                    headers: { 'X-Out': { schema: refC } },
                    content: { 'application/json': { schema: refC } },
                  },
                  '404': { description: 'missing', content: { 'application/json': { schema: refC } } },
                  default: { description: 'error', content: { 'application/json': { schema: refC } } },
                },
                callbacks: {
                  onC: {
                    '{$request.body#/url}': {
                      post: {
                        requestBody: { content: { 'application/json': { schema: refC } } },
                        responses: { '204': { description: 'ack' } },
                      },
                    },
                  },
                },
              },
              put: {
                operationId: 'putC',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: { content: { 'application/json': { schema: refC } } },
                responses: { '200': { description: 'ok', content: { 'application/json': { schema: refC } } } },
              },
            },
          },
          {
            webhooks: {
              cChanged: {
                post: {
                  requestBody: { content: { 'application/json': { schema: refC } } },
                  responses: { '200': { description: 'ok' } },
                },
              },
            },
          },
        ),
      );
      const wrapped = nullable(model('C'));
      expect(Object.fromEntries(modelOf(spec, 'Holder')!.fields.map((f) => [f.name, f.type]))).toEqual({
        c: wrapped,
        items: { kind: 'array', items: wrapped },
        values: { kind: 'map', valueType: wrapped },
        either: { kind: 'union', variants: [wrapped, model('Pet')], compositionKind: 'oneOf' },
        union: model('Union'),
        maybe_c: nullable(model('MaybeC')),
        pointer: wrapped,
        one_of_null: wrapped,
        null_one_of: wrapped,
        any_of_null: wrapped,
        all_of_ref: wrapped,
        all_of_ref_nullable: wrapped,
        wrapped_ref: wrapped,
      });
      expect(modelOf(spec, 'Union')?.variants).toEqual([wrapped, model('Pet')]);
      expect(modelOf(spec, 'MaybeC')?.variants).toEqual([wrapped]);

      const { getC, putC } = opsOf(spec);
      expect(getC.response).toEqual(wrapped);
      expect(getC.queryParams.map((p) => [p.name, p.type])).toEqual([['filter', wrapped]]);
      expect(getC.headerParams.map((p) => [p.name, p.type])).toEqual([['X-C', wrapped]]);
      expect(getC.cookieParams?.map((p) => [p.name, p.type])).toEqual([['session', wrapped]]);
      expect(getC.responseHeaders?.map((h) => [h.name, h.type])).toEqual([['X-Out', wrapped]]);
      expect(getC.errors.map((e) => [e.statusCode, e.type])).toEqual([[404, wrapped]]);
      expect(getC.defaultResponse?.type).toEqual(wrapped);
      expect(getC.callbacks?.map((cb) => [cb.name, cb.requestBody])).toEqual([['onC', wrapped]]);
      expect(putC.requestBody).toEqual(wrapped);
      expect(putC.response).toEqual(wrapped);
      expect(spec.webhooks?.map((w) => [w.name, w.requestBody])).toEqual([['cChanged', wrapped]]);
      expect(warnings()).toEqual([]);
    });

    it('wraps a `$ref` to an alias of the component, and leaves an `allOf` that merges a typing member the bare object it describes', async () => {
      const C = nullableOwner(openapi);
      const refC = ref('C');
      const ownNullable =
        openapi === '3.1.0'
          ? { type: ['object', 'null'], allOf: [ref('Pet'), { properties: { meow: { type: 'string' } } }] }
          : { type: 'object', nullable: true, allOf: [ref('Pet'), { properties: { meow: { type: 'string' } } }] };
      const spec = await parse(
        doc(openapi, {
          C,
          Pet: plainObject,
          // Aliases: an `allOf` read as its `$ref` member, followed through aliases of aliases.
          CAlias: { allOf: [refC] },
          CAliasDocumented: { allOf: [refC, { description: 'The owner.' }] },
          CAliasOfAlias: { allOf: [ref('CAlias')] },
          CAliasNullableFlag: { allOf: [refC], nullable: true },
          // Merges: the composed model is the object its fields describe.
          Cat: { allOf: [refC, { type: 'object', properties: { meow: { type: 'string' } } }] },
          TwoRefs: { allOf: [refC, ref('Pet')] },
          Required: { allOf: [refC], required: ['name'] },
          // A merge's own declaration wraps it; `nullable: true` beside an `allOf` with no `type` declares nothing.
          OwnNullable: ownNullable,
          OwnNullableFlagOnly: { nullable: true, allOf: [ref('Pet'), { properties: { meow: { type: 'string' } } }] },
          PetAlias: { allOf: [ref('Pet')] },
          // A chain of aliases that returns to itself admits nothing through the loop.
          Loop1: { allOf: [ref('Loop2')] },
          Loop2: { allOf: [ref('Loop1')] },
          Holder: {
            type: 'object',
            properties: {
              c_alias: ref('CAlias'),
              c_alias_documented: ref('CAliasDocumented'),
              c_alias_of_alias: ref('CAliasOfAlias'),
              c_alias_nullable_flag: ref('CAliasNullableFlag'),
              cat: ref('Cat'),
              two_refs: ref('TwoRefs'),
              required: ref('Required'),
              own_nullable: ref('OwnNullable'),
              own_nullable_flag_only: ref('OwnNullableFlagOnly'),
              pet_alias: ref('PetAlias'),
              loop: ref('Loop1'),
              // The same `allOf` on a field is read as the reference, wrapper included.
              inline_alias: { allOf: [refC] },
              inline_merge: { allOf: [refC, { type: 'object', properties: { meow: { type: 'string' } } }] },
            },
          },
        }),
      );
      expect(Object.fromEntries(modelOf(spec, 'Holder')!.fields.map((f) => [f.name, f.type]))).toEqual({
        c_alias: nullable(model('CAlias')),
        c_alias_documented: nullable(model('CAliasDocumented')),
        c_alias_of_alias: nullable(model('CAliasOfAlias')),
        c_alias_nullable_flag: nullable(model('CAliasNullableFlag')),
        cat: model('Cat'),
        two_refs: model('TwoRefs'),
        required: model('Required'),
        own_nullable: nullable(model('OwnNullable')),
        own_nullable_flag_only: model('OwnNullableFlagOnly'),
        pet_alias: model('PetAlias'),
        loop: model('Loop1'),
        inline_alias: nullable(model('C')),
        inline_merge: model('HolderInlineMerge'),
      });
      expect(fieldNames(spec, 'CAlias')).toEqual(['name']);
      expect(fieldNames(spec, 'Cat')).toEqual(['name', 'meow']);
      expect(fieldNames(spec, 'TwoRefs')).toEqual(['name', 'id']);
      expect(fieldNames(spec, 'OwnNullable')).toEqual(['id', 'meow']);
    });
  });

  it('wraps a `$ref` to a `null`-only component in either spelling, which keeps its fieldless model', async () => {
    const spec = await parse(
      doc('3.1.0', {
        NullOnly: { type: 'null' },
        NullList: { type: ['null'] },
        Holder: { type: 'object', properties: { null_only: ref('NullOnly'), null_list: ref('NullList') } },
      }),
    );
    expect(fieldType(spec, 'Holder', 'null_only')).toEqual(nullable(model('NullOnly')));
    expect(fieldType(spec, 'Holder', 'null_list')).toEqual(nullable(model('NullList')));
    expect(fieldNames(spec, 'NullOnly')).toEqual([]);
    expect(fieldNames(spec, 'NullList')).toEqual([]);
  });

  it('reports the extraction of a nullable inline object into a component as no change, in either direction', async () => {
    // The issue's documents, before and after `owner` is extracted — one model `PetOwner` either way.
    for (const openapi of VERSIONS) {
      const inline = await parse(pointerDoc(openapi));
      const extracted = await parse(componentDoc(openapi));
      expect(diffSpecs(inline, extracted).changes, openapi).toEqual([]);
      expect(diffSpecs(extracted, inline).changes, openapi).toEqual([]);
    }
  });

  // Two keys can resolve to one model (`Note` / `note`, or `Notes` / `Note`
  // through singularization). The nullability is the key's, as the `$ref`
  // names it: only the key that admits `null` wraps its references, so a
  // reference to the other never gains a `null` its schema does not admit
  // (Greptile, #641 review).
  describe.each(VERSIONS)('two keys that resolve to one name, on OAS %s', (openapi) => {
    const nullableNote =
      openapi === '3.1.0'
        ? { type: ['object', 'null'], properties: { text: { type: 'string' } } }
        : { type: 'object', nullable: true, properties: { text: { type: 'string' } } };
    const plainNote = { type: 'object', properties: { text: { type: 'string' } } };

    it.each([
      ['`Note` admits null, `note` does not', { Note: nullableNote, note: plainNote }, 'Note', 'note'],
      ['`note` admits null, `Note` does not', { note: nullableNote, Note: plainNote }, 'note', 'Note'],
      ['`Notes` admits null, `Note` does not', { Notes: nullableNote, Note: plainNote }, 'Notes', 'Note'],
    ])('wraps a `$ref` by the key it names when %s', async (_label, schemas, nullableKey, plainKey) => {
      const spec = await parse(
        doc(openapi, {
          ...schemas,
          // A named union pair, read by key as well.
          Shape: { oneOf: [ref('A'), ref('B'), { type: 'null' }] },
          shape: { oneOf: [ref('A'), ref('B')] },
          A: { type: 'object', properties: { a: { type: 'string' } } },
          B: { type: 'object', properties: { b: { type: 'string' } } },
          Holder: {
            type: 'object',
            properties: {
              admits_null: ref(nullableKey),
              plain: ref(plainKey),
              shape_with_null: ref('Shape'),
              shape_plain: ref('shape'),
            },
          },
        }),
      );
      expect(Object.fromEntries(modelOf(spec, 'Holder')!.fields.map((f) => [f.name, f.type]))).toEqual({
        admits_null: nullable(model('Note')),
        plain: model('Note'),
        shape_with_null: nullable(model('Shape')),
        shape_plain: model('Shape'),
      });
      // One model either way, the fields it always had.
      expect(spec.models.map((m) => m.name)).toEqual(['Note', 'Shape', 'A', 'B', 'Holder']);
      expect(fieldNames(spec, 'Note')).toEqual(['text']);
      expect(warnings()).toEqual([]);
    });
  });
});
