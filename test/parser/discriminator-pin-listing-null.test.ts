import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #678: a discriminator pin that lists `null` among its values —
 * `kind: { type: ['string', 'null'], enum: ['cat', null] }`, or OAS 3.0's
 * `{ type: 'string', enum: ['cat', null], nullable: true }` — pinned
 * nothing, although the model's `kind` field is the `nullable<"cat">` the
 * same declaration written `{ type: ['string', 'null'], const: 'cat' }`
 * gives. The last hop of the pin walk (`pinnedDeclarationValue`) was read
 * by the length of its `enum:` list, so the `null` entry made it two
 * values. A `null` entry marks the declaration nullable and is no value of
 * its own, as the type builder reads the list: the pin is the one string
 * the list holds once `null` is set aside.
 */

type Doc = Record<string, unknown>;

const ref = (name: string): Doc => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown): Doc => ({ 'application/json': { schema } });

/** A plain pin: `{ const: value }`, or the OAS 3.0 spelling `{ type: 'string', enum: [value] }`. */
const pin = (openapi: string, value: string): Doc =>
  openapi === '3.0.3' ? { type: 'string', enum: [value] } : { const: value };

/** The issue's pin: one string and `null` in the list, `null` admitted by the type list (3.1) or the flag (3.0). */
const listed = (openapi: string, value: string): Doc =>
  openapi === '3.0.3'
    ? { type: 'string', enum: [value, null], nullable: true }
    : { type: ['string', 'null'], enum: [value, null] };

/** The spelling of the same nullable pin that mapped before: the issue's `const.json`. */
const twin = (openapi: string, value: string): Doc =>
  openapi === '3.0.3' ? { type: 'string', enum: [value], nullable: true } : { type: ['string', 'null'], const: value };

/** An object requiring `kind`, declared as `kind`, with `extra` properties beside it. */
const object = (kind: Doc, extra: Record<string, Doc> = {}): Doc => ({
  type: 'object',
  required: ['kind'],
  properties: { kind, ...extra },
});

/** A `oneOf` of `variants`, under `discriminator: { propertyName: 'kind' }` when `keyword` is set. */
const union = (variants: Doc[], keyword: boolean): Doc => ({
  oneOf: variants,
  ...(keyword ? { discriminator: { propertyName: 'kind' } } : {}),
});

/** A document returning `Pet` (and `Owner`, when declared) from `schemas`, or with `paths` instead. */
function doc(openapi: string, schemas: Record<string, Doc>, paths?: Doc): Doc {
  const get = (name: string): Doc => ({
    get: {
      operationId: `get${name}`,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK', content: json(ref(name)) } },
    },
  });
  return {
    openapi,
    info: { title: 'Repro 678', version: '1.0.0' },
    paths: paths ?? {
      '/pets/{id}': get('Pet'),
      ...(schemas.Owner ? { '/owners/{id}': get('Owner') } : {}),
    },
    components: { schemas },
  };
}

/**
 * The issue's `repro.json`, with `Cat.kind` written as `catKind`: `Pet` a
 * `oneOf` of `$ref Cat` and `$ref Dog` returned by `GET /pets/{id}`
 * (`getPet`), `kind` required in both.
 */
function issueDocument(openapi: string, catKind: Doc, keyword: boolean): Doc {
  return doc(openapi, {
    Pet: union([ref('Cat'), ref('Dog')], keyword),
    Cat: object(catKind, { lives: { type: 'integer' } }),
    Dog: object(pin(openapi, 'dog'), { barks: { type: 'boolean' } }),
  });
}

/** `Owner.pet: oneOf [$ref Cat, $ref Dog]` and the component `Pet` of the same union, with `Cat.kind` written as `catKind`, plus `extra` components. */
function catAndDog(openapi: string, keyword: boolean, catKind: Doc, extra: Record<string, Doc> = {}): Doc {
  return doc(openapi, {
    Cat: object(catKind, { lives: { type: 'integer' } }),
    Dog: object(pin(openapi, 'dog'), { barks: { type: 'boolean' } }),
    ...extra,
    Owner: { type: 'object', properties: { pet: union([ref('Cat'), ref('Dog')], keyword) } },
    Pet: union([ref('Cat'), ref('Dog')], keyword),
  });
}

type UnionRef = Extract<TypeRef, { kind: 'union' }>;

const nullableCat: TypeRef = { kind: 'nullable', inner: { kind: 'literal', value: 'cat' } };

describe('#678 a discriminator pin that lists null among its values', () => {
  let tmpDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-678-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(document: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, `spec-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(specFile, JSON.stringify(document), 'utf-8');
    return parseSpec(specFile);
  }

  const model = (spec: ApiSpec, name: string): Model => {
    const found = spec.models.find((m) => m.name === name);
    expect(found, name).toBeDefined();
    return found!;
  };
  const fieldType = (spec: ApiSpec, modelName: string, field: string): TypeRef => {
    const found = model(spec, modelName).fields.find((f) => f.name === field);
    expect(found, `${modelName}.${field}`).toBeDefined();
    return found!.type;
  };
  const variantNames = (variants: readonly TypeRef[] = []): string =>
    variants.map((v) => (v.kind === 'model' ? v.name : v.kind)).join(' | ');
  /** `Owner.<field>`'s variants and mapping. */
  const describeUnion = (spec: ApiSpec, field: string): string => {
    const type = fieldType(spec, 'Owner', field);
    expect(type.kind, `Owner.${field}`).toBe('union');
    const { variants, discriminator } = type as UnionRef;
    return `${field}: ${variantNames(variants)} ${JSON.stringify(discriminator?.mapping)}`;
  };
  /** The component union `<name>`'s variants and mapping. */
  const namedUnion = (spec: ApiSpec, name = 'Pet'): string => {
    const { variants, discriminator } = model(spec, name);
    return `${name}: ${variantNames(variants)} ${JSON.stringify(discriminator?.mapping)}`;
  };
  /** What a union that derives no mapping carries: `{}` under the keyword, no discriminator without it. */
  const unmapped = (keyword: boolean): string => (keyword ? '{}' : 'undefined');

  /** `oagen diff` between two parsed documents, one line per change, and the exit code the CLI would give. */
  function diffOf(before: ApiSpec, after: ApiSpec): { changes: string[]; exit: number } {
    const changes = diffSpecs(before, after).changes.map((change) => {
      const { classification, kind, name, operationName } = change as typeof change & {
        name?: string;
        operationName?: string;
      };
      return `${classification} ${kind} ${name ?? operationName}`;
    });
    const exit = changes.some((change) => change.startsWith('breaking')) ? 2 : changes.length > 0 ? 1 : 0;
    return { changes, exit };
  }

  describe.each(['3.0.3', '3.1.0'])('OpenAPI %s', (openapi) => {
    describe.each([true, false])('with the discriminator keyword: %s', (keyword) => {
      it("the issue's repro.json maps { cat: 'Cat', dog: 'Dog' }, as const.json does", async () => {
        const repro = await parseJson(issueDocument(openapi, listed(openapi, 'cat'), keyword));
        const constJson = await parseJson(issueDocument(openapi, twin(openapi, 'cat'), keyword));

        // `Cat` is the same model in both documents…
        expect(fieldType(repro, 'Cat', 'kind')).toEqual(nullableCat);
        expect(fieldType(constJson, 'Cat', 'kind')).toEqual(nullableCat);
        // …and so is `Pet`.
        expect(model(constJson, 'Pet').discriminator).toEqual({
          property: 'kind',
          mapping: { cat: 'Cat', dog: 'Dog' },
        });
        expect(model(repro, 'Pet').discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } });
        expect(namedUnion(repro)).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        expect(warn).not.toHaveBeenCalled();
      });

      it('oagen diff between const.json and repro.json reports nothing, in either direction', async () => {
        const repro = await parseJson(issueDocument(openapi, listed(openapi, 'cat'), keyword));
        const constJson = await parseJson(issueDocument(openapi, twin(openapi, 'cat'), keyword));
        expect(diffOf(constJson, repro)).toEqual({ changes: [], exit: 0 });
        expect(diffOf(repro, constJson)).toEqual({ changes: [], exit: 0 });
      });

      it('pins the one string a list holds beside null, however the list and its null are spelled', async () => {
        const spellings: Array<[string, Doc]> = [
          ['null listed first', { ...listed(openapi, 'cat'), enum: [null, 'cat'] }],
          ['null listed twice', { ...listed(openapi, 'cat'), enum: [null, 'cat', null] }],
          ['no type', { enum: ['cat', null] }],
          ['no type, null first', { enum: [null, 'cat'] }],
          ['a plain string type', { type: 'string', enum: ['cat', null] }],
          ['nullable: true and no type', { enum: ['cat', null], nullable: true }],
        ];
        for (const [label, catKind] of spellings) {
          const spec = await parseJson(catAndDog(openapi, keyword, catKind));
          // The list alone makes the field nullable, as the type builder reads it.
          expect(fieldType(spec, 'Cat', 'kind'), label).toEqual(nullableCat);
          expect(describeUnion(spec, 'pet'), label).toBe('pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
          expect(namedUnion(spec), label).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        }
      });

      it('gives the same mapping whichever variant, component or list entry the document writes first', async () => {
        const cat = object({ ...listed(openapi, 'cat'), enum: [null, 'cat'] }, { lives: { type: 'integer' } });
        const dog = object(pin(openapi, 'dog'), { barks: { type: 'boolean' } });
        const forward = await parseJson(
          doc(openapi, { Cat: cat, Dog: dog, Pet: union([ref('Cat'), ref('Dog')], keyword) }),
        );
        const reversed = await parseJson(
          doc(openapi, { Pet: union([ref('Dog'), ref('Cat')], keyword), Dog: dog, Cat: cat }),
        );
        expect(namedUnion(forward)).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        expect(namedUnion(reversed)).toBe('Pet: Dog | Cat {"dog":"Dog","cat":"Cat"}');
        expect(model(reversed, 'Pet').discriminator?.mapping).toEqual(model(forward, 'Pet').discriminator?.mapping);
        expect(fieldType(reversed, 'Cat', 'kind')).toEqual(fieldType(forward, 'Cat', 'kind'));
      });

      it('pins through a $ref, an allOf, a nullable wrapper and an alias chain, at every hop', async () => {
        const list = listed(openapi, 'cat');
        const wrapped: Array<[string, Doc, Record<string, Doc>, TypeRef]> = [
          ['an allOf around the list', { allOf: [list] }, {}, nullableCat],
          ['an allOf around a typeless list', { allOf: [{ enum: ['cat', null] }] }, {}, nullableCat],
          [
            'an allOf around the list beside an annotating member',
            { allOf: [list, { description: 'The kind of pet.' }], title: 'Kind' },
            {},
            nullableCat,
          ],
          ['a nullable oneOf around the list', { oneOf: [{ enum: ['cat', null] }, { type: 'null' }] }, {}, nullableCat],
          ['a nullable anyOf around the list', { anyOf: [{ type: 'null' }, list] }, {}, nullableCat],
          // A component declaring an `enum:` list is an enum component, a
          // one-value one included, so the field names the enum — nullable,
          // as the list says — and the pin is read through it all the same.
          [
            'a $ref to a component listing null',
            ref('CatKind'),
            { CatKind: list },
            { kind: 'nullable', inner: { kind: 'enum', name: 'CatKind' } },
          ],
          [
            'a $ref to a typeless component listing null',
            ref('CatKind'),
            { CatKind: { enum: [null, 'cat'] } },
            { kind: 'nullable', inner: { kind: 'enum', name: 'CatKind' } },
          ],
          [
            'an allOf of a $ref beside a description',
            { allOf: [ref('CatKind')], description: 'The kind of pet.' },
            { CatKind: list },
            { kind: 'nullable', inner: { kind: 'enum', name: 'CatKind' } },
          ],
          [
            'an alias chain mixing every shape',
            ref('Kind1'),
            {
              Kind1: { allOf: [ref('Kind2')], description: 'An alias of an alias.' },
              Kind2: { oneOf: [ref('Kind3'), { type: 'null' }] },
              Kind3: ref('Kind4'),
              Kind4: { enum: ['cat', null] },
            },
            { kind: 'nullable', inner: { kind: 'enum', name: 'Kind4' } },
          ],
        ];
        for (const [label, catKind, extra, type] of wrapped) {
          const spec = await parseJson(catAndDog(openapi, keyword, catKind, extra));
          expect(fieldType(spec, 'Cat', 'kind'), label).toEqual(type);
          expect(describeUnion(spec, 'pet'), label).toBe('pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
          expect(namedUnion(spec), label).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        }
      });

      it('a list that holds no one string beside null still pins nothing', async () => {
        const unpinned: Array<[string, Doc, object]> = [
          // No value at all: an inline enum with no members, nullable.
          ['null alone', { enum: [null] }, { kind: 'nullable', inner: { kind: 'enum', name: 'CatKind', values: [] } }],
          [
            'two strings beside null',
            { type: 'string', enum: ['cat', 'lion', null] },
            { kind: 'nullable', inner: { kind: 'enum', name: 'CatKind', values: ['cat', 'lion'] } },
          ],
          ['a number beside null', { enum: [1, null] }, { kind: 'nullable', inner: { kind: 'literal', value: 1 } }],
          // A list beside a nullable wrapper the walk reads through types
          // nothing: the field is the wrapper's one variant, a plain string.
          [
            'a list beside a nullable wrapper of a plain type',
            { oneOf: [{ type: 'string' }, { type: 'null' }], enum: ['cat', null] },
            { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
          ],
        ];
        for (const [label, catKind, type] of unpinned) {
          const spec = await parseJson(catAndDog(openapi, keyword, catKind));
          expect(fieldType(spec, 'Cat', 'kind'), label).toMatchObject(type);
          expect(describeUnion(spec, 'pet'), label).toBe(`pet: Cat | Dog ${unmapped(keyword)}`);
          expect(namedUnion(spec), label).toBe(`Pet: Cat | Dog ${unmapped(keyword)}`);
        }
      });

      it('reads a const written beside a list as the type builder does: the const types the declaration, the list is not read', async () => {
        // A string `const` pins, and the `null` the list names beside it is
        // not admitted: the field is the plain literal.
        const beside = await parseJson(catAndDog(openapi, keyword, { const: 'cat', enum: ['cat', null] }));
        expect(fieldType(beside, 'Cat', 'kind')).toEqual({ kind: 'literal', value: 'cat' });
        expect(namedUnion(beside)).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        // A `const` that is no string pins nothing, whatever the list holds:
        // the field is typed by the const, never by the list.
        for (const [label, catKind, type] of [
          [
            'const: null',
            { const: null, enum: ['cat', null] },
            { kind: 'nullable', inner: { kind: 'primitive', type: 'unknown' } },
          ],
          ['const: 5', { const: 5, enum: ['cat'] }, { kind: 'literal', value: 5 }],
        ] as const) {
          const spec = await parseJson(catAndDog(openapi, keyword, { ...catKind }));
          expect(fieldType(spec, 'Cat', 'kind'), label).toEqual(type);
          expect(describeUnion(spec, 'pet'), label).toBe(`pet: Cat | Dog ${unmapped(keyword)}`);
          expect(namedUnion(spec), label).toBe(`Pet: Cat | Dog ${unmapped(keyword)}`);
        }
      });

      it('names and maps two inline variants pinning kind by such a list as with the const written', async () => {
        const variants = (spelling: (value: string) => Doc): Doc[] => [
          object(spelling('cat'), { lives: { type: 'integer' } }),
          object(pin(openapi, 'dog'), { barks: { type: 'boolean' } }),
        ];
        const document = (spelling: (value: string) => Doc): Doc =>
          doc(openapi, {
            Owner: { type: 'object', properties: { pet: union(variants(spelling), keyword) } },
            Pet: union(variants(spelling), keyword),
          });
        const spec = await parseJson(document((value) => listed(openapi, value)));
        const old = await parseJson(document((value) => twin(openapi, value)));
        // The second variant takes its const prefix, as it does beside a
        // variant pinning a `const` (it was `OwnerPetWithBarks`, named from
        // its content, while the first variant pinned nothing).
        expect(describeUnion(spec, 'pet')).toBe('pet: OwnerPet | DogOwnerPet {"cat":"OwnerPet","dog":"DogOwnerPet"}');
        expect(namedUnion(spec)).toBe('Pet: CatPet | DogPet {"cat":"CatPet","dog":"DogPet"}');
        expect(describeUnion(spec, 'pet')).toBe(describeUnion(old, 'pet'));
        expect(namedUnion(spec)).toBe(namedUnion(old));
        for (const name of ['OwnerPet', 'CatPet']) expect(fieldType(spec, name, 'kind'), name).toEqual(nullableCat);
        expect(spec.models.map(({ name }) => name).sort()).toEqual(old.models.map(({ name }) => name).sort());
      });

      it('an allOf+oneOf dispatcher dispatches on a variant pinning kind by such a list, as on the const', async () => {
        const document = (spelling: (value: string) => Doc): Doc =>
          doc(openapi, {
            Pet: {
              allOf: [
                { type: 'object', properties: { id: { type: 'string' } } },
                {
                  oneOf: [
                    object(spelling('cat'), { lives: { type: 'integer' } }),
                    object(pin(openapi, 'dog'), { barks: { type: 'boolean' } }),
                  ],
                },
              ],
              ...(keyword ? { discriminator: { propertyName: 'kind' } } : {}),
            },
          });
        const spec = await parseJson(document((value) => listed(openapi, value)));
        const old = await parseJson(document((value) => twin(openapi, value)));
        // It was flattened into one `Pet { id, kind, lives, barks }`.
        expect(model(spec, 'Pet').discriminator).toEqual({
          property: 'kind',
          mapping: { cat: 'PetCat', dog: 'PetDog' },
        });
        expect(model(spec, 'Pet').fields.map(({ name }) => name)).toEqual(['id']);
        expect(model(spec, 'PetCat').fields.map(({ name }) => name)).toEqual(['id', 'kind', 'lives']);
        expect(model(spec, 'PetDog').fields.map(({ name }) => name)).toEqual(['id', 'kind', 'barks']);
        expect(fieldType(spec, 'PetCat', 'kind')).toEqual(nullableCat);
        expect(diffOf(old, spec)).toEqual({ changes: [], exit: 0 });
      });

      it('a member pinning the property by such a list outranks the open declaration another member makes, in either order', async () => {
        const pinned = { properties: { kind: listed(openapi, 'cat') } };
        const document = (members: Doc[]): Doc =>
          doc(openapi, {
            Base: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
            Cat: { allOf: members },
            Dog: object(pin(openapi, 'dog')),
            Owner: { type: 'object', properties: { pet: union([ref('Cat'), ref('Dog')], keyword) } },
            Pet: union([ref('Cat'), ref('Dog')], keyword),
          });
        for (const members of [
          [ref('Base'), pinned],
          [pinned, ref('Base')],
        ]) {
          const spec = await parseJson(document(members));
          expect(describeUnion(spec, 'pet'), JSON.stringify(members)).toBe('pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
          expect(namedUnion(spec), JSON.stringify(members)).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        }
      });

      it('maps the same union written inline as a response body, array items, map values and a parameter', async () => {
        const pets = union([ref('Cat'), ref('Dog')], keyword);
        const spec = await parseJson(
          doc(
            openapi,
            {
              Cat: object(listed(openapi, 'cat'), { lives: { type: 'integer' } }),
              Dog: object(pin(openapi, 'dog'), { barks: { type: 'boolean' } }),
              Owner: {
                type: 'object',
                properties: {
                  pets: { type: 'array', items: pets },
                  byName: { type: 'object', additionalProperties: pets },
                },
              },
            },
            {
              '/pets': {
                get: {
                  operationId: 'findPet',
                  parameters: [{ name: 'like', in: 'query', schema: pets }],
                  responses: { '200': { description: 'OK', content: json(pets) } },
                },
              },
              '/owners': {
                get: {
                  operationId: 'getOwner',
                  responses: { '200': { description: 'OK', content: json(ref('Owner')) } },
                },
              },
            },
          ),
        );
        // Under the keyword and without it: the implicit discriminator reads the same pins.
        const mapping = { cat: 'Cat', dog: 'Dog' };
        const [findPet] = spec.services
          .flatMap(({ operations }) => operations)
          .filter(({ name }) => name === 'findPet');
        const items = fieldType(spec, 'Owner', 'pets') as Extract<TypeRef, { kind: 'array' }>;
        const values = fieldType(spec, 'Owner', 'byName') as Extract<TypeRef, { kind: 'map' }>;
        const sites: Array<[string, TypeRef | undefined]> = [
          ['response body', findPet?.response],
          ['array items', items.items],
          ['map values', values.valueType],
          ['parameter', findPet?.queryParams.find(({ name }) => name === 'like')?.type],
        ];
        for (const [label, type] of sites) {
          expect(type?.kind, label).toBe('union');
          expect((type as UnionRef).discriminator, label).toEqual({ property: 'kind', mapping });
        }
      });
    });

    it("under the document's own mapping, an inline variant pinned by such a list is referenced by its entry's target, as one pinned by the const is", async () => {
      const document = (spelling: (value: string) => Doc): Doc =>
        doc(openapi, {
          CatDto: object(pin(openapi, 'cat'), { lives: { type: 'integer' } }),
          Dog: object(pin(openapi, 'dog'), { barks: { type: 'boolean' } }),
          Owner: {
            type: 'object',
            properties: {
              pet: {
                oneOf: [object(spelling('cat'), { lives: { type: 'integer' } }), ref('Dog')],
                discriminator: {
                  propertyName: 'kind',
                  mapping: { cat: '#/components/schemas/CatDto', dog: '#/components/schemas/Dog' },
                },
              },
            },
          },
          Pet: union([ref('Dog')], true),
        });
      const spec = await parseJson(document((value) => listed(openapi, value)));
      const old = await parseJson(document((value) => twin(openapi, value)));
      // The variant's reference follows the entry its pinned value selects
      // (`mapVariantToDiscriminatorEntry`); it kept the model's own name,
      // `OwnerPet`, while the list pinned nothing.
      expect(describeUnion(spec, 'pet')).toBe('pet: CatDto | Dog {"cat":"CatDto","dog":"Dog"}');
      expect(describeUnion(spec, 'pet')).toBe(describeUnion(old, 'pet'));
      expect(diffOf(old, spec)).toEqual({ changes: [], exit: 0 });
    });

    it('keeps the titles of a title-mapped union whose variant pins by such a list, and maps by them', async () => {
      const shape = (title: string, kind: Doc, extra: string): Doc => ({
        title,
        type: 'object',
        required: ['kind'],
        properties: { kind, [extra]: { type: 'number' } },
      });
      const document = (spelling: (value: string) => Doc): Doc =>
        doc(openapi, {
          Owner: {
            type: 'object',
            properties: {
              shape: {
                oneOf: [shape('Circle', spelling('circle'), 'radius'), shape('Square', pin(openapi, 'square'), 'side')],
              },
            },
          },
          Pet: union([ref('Owner')], false),
        });
      const spec = await parseJson(document((value) => listed(openapi, value)));
      const old = await parseJson(document((value) => twin(openapi, value)));
      // Every variant is titled and pins `kind`, so the union is title-mapped
      // (it was `OwnerShape | OwnerShapeWithSide`, with no discriminator).
      expect(describeUnion(spec, 'shape')).toBe('shape: Circle | Square {"circle":"Circle","square":"Square"}');
      expect(describeUnion(spec, 'shape')).toBe(describeUnion(old, 'shape'));
      expect(diffOf(old, spec)).toEqual({ changes: [], exit: 0 });
    });

    describe('the request-body fold', () => {
      const inline = (kind: Doc, extra: Record<string, Doc>): Doc => ({
        type: 'object',
        required: ['kind'],
        properties: { kind, ...extra },
      });
      /** `POST /pets` (`createPet`) with a body that is a `oneOf` of two inline objects under the keyword. */
      const document = (kinds: [Doc, Doc], schemas: Record<string, Doc> = {}): Doc =>
        doc(openapi, schemas, {
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: {
                required: true,
                content: json({
                  oneOf: [
                    inline(kinds[0], { lives: { type: 'integer' } }),
                    inline(kinds[1], { barks: { type: 'boolean' } }),
                  ],
                  discriminator: { propertyName: 'kind' },
                }),
              },
              responses: { '204': { description: 'No content' } },
            },
          },
        });
      /** The folded body's `kind`, once the body is checked to be the one folded model. */
      const kindOf = (spec: ApiSpec, label: string): TypeRef => {
        const [op] = spec.services.flatMap((service) => service.operations);
        expect(op?.requestBody, label).toEqual({ kind: 'model', name: 'CreatePetRequest' });
        expect(
          model(spec, 'CreatePetRequest').fields.map(({ name, required }) => `${name}${required ? '' : '?'}`),
          label,
        ).toEqual(['kind', 'lives?', 'barks?']);
        return fieldType(spec, 'CreatePetRequest', 'kind');
      };
      const kindValues = (spec: ApiSpec): unknown =>
        spec.enums.find(({ name }) => name === 'CreatePetRequestKind')?.values.map(({ value }) => value);
      const nullableEnum = { kind: 'nullable', inner: { kind: 'enum', name: 'CreatePetRequestKind' } };

      it('folds a body whose variant pins the discriminator by a list naming null, as one pinning the const', async () => {
        const spec = await parseJson(document([listed(openapi, 'cat'), pin(openapi, 'dog')]));
        const old = await parseJson(document([twin(openapi, 'cat'), pin(openapi, 'dog')]));
        // It stayed a union of `CreatePetRequest` and a second model, under `mapping: {}`.
        expect(kindOf(spec, 'listed')).toMatchObject(nullableEnum);
        expect(kindValues(spec)).toEqual(['cat', 'dog']);
        expect(spec.models.map(({ name }) => name)).toEqual(['CreatePetRequest']);
        expect(kindOf(old, 'const')).toMatchObject(nullableEnum);
        expect(diffOf(old, spec)).toEqual({ changes: [], exit: 0 });
        expect(diffOf(spec, old)).toEqual({ changes: [], exit: 0 });
      });

      it('keeps null on the folded discriminator when the list alone admits it, at any hop', async () => {
        const cases: Array<[string, [Doc, Doc], Record<string, Doc>]> = [
          ['a typeless list', [{ enum: ['cat', null] }, pin(openapi, 'dog')], {}],
          ['a list beside a plain string type', [{ type: 'string', enum: [null, 'cat'] }, pin(openapi, 'dog')], {}],
          ['the second variant listing it', [pin(openapi, 'cat'), { enum: ['dog', null] }], {}],
          ['an allOf around the list', [{ allOf: [{ enum: ['cat', null] }] }, pin(openapi, 'dog')], {}],
          [
            'a $ref to a component listing it',
            [ref('CatKind'), pin(openapi, 'dog')],
            { CatKind: { enum: ['cat', null] } },
          ],
        ];
        for (const [label, kinds, schemas] of cases) {
          const spec = await parseJson(document(kinds, schemas));
          // The folded field admits `null`, as the variant's own field does.
          expect(kindOf(spec, label), label).toMatchObject(nullableEnum);
          expect(kindValues(spec), label).toEqual(['cat', 'dog']);
        }
        // One value pinned by both variants, one listing `null`: the one-value
        // enum — a literal — admits it.
        const one = await parseJson(document([{ enum: ['cat', null] }, pin(openapi, 'cat')]));
        expect(kindOf(one, 'one value')).toEqual(nullableCat);
      });

      it('admits no null the type builder does not read: a list beside a const, an allOf or a $ref', async () => {
        // The const types the declaration, so the `null` the list names is
        // not read: each variant's own field would be the plain literal.
        const besideConst = await parseJson(document([{ const: 'cat', enum: ['cat', null] }, pin(openapi, 'dog')]));
        expect(kindOf(besideConst, 'beside a const')).toMatchObject({ kind: 'enum', name: 'CreatePetRequestKind' });
        // The `allOf` is read as its one member, and the list beside it is not read.
        const besideAllOf = await parseJson(
          document([{ allOf: [pin(openapi, 'cat')], enum: ['cat', null] }, pin(openapi, 'dog')]),
        );
        expect(kindOf(besideAllOf, 'beside an allOf')).toMatchObject({ kind: 'enum', name: 'CreatePetRequestKind' });
        // Nothing beside a `$ref` is read: the pin is the component's, and so is its nullability.
        const besideRef = await parseJson(
          document([{ ...ref('CatKind'), enum: ['cat', null] }, pin(openapi, 'dog')], { CatKind: pin(openapi, 'cat') }),
        );
        expect(kindOf(besideRef, 'beside a $ref')).toMatchObject({ kind: 'enum', name: 'CreatePetRequestKind' });
        const plain = await parseJson(document([pin(openapi, 'cat'), pin(openapi, 'dog')]));
        expect(kindOf(plain, 'no null')).toMatchObject({ kind: 'enum', name: 'CreatePetRequestKind' });
      });
    });

    it('reserves the const prefix a nested variant takes from such a list, as it reserves one written as a const', async () => {
      const inline = (kind: Doc, extra: Record<string, Doc>): Doc => ({
        type: 'object',
        properties: { kind, ...extra },
      });
      const body = (spelling: (value: string) => Doc): Doc => ({
        type: 'object',
        properties: {
          target: {
            oneOf: [
              inline(spelling('email'), { address: { type: 'string' } }),
              inline(spelling('sms'), { number: { type: 'string' } }),
            ],
          },
        },
      });
      const document = (spelling: (value: string) => Doc): Doc =>
        doc(
          openapi,
          { SmsTagsPostRequestTarget: { type: 'object', properties: { x: { type: 'string' } } } },
          {
            '/tags': {
              post: {
                requestBody: { content: json(body(spelling)) },
                responses: { '204': { description: 'OK' } },
              },
            },
          },
        );
      const spec = await parseJson(document((value) => listed(openapi, value)));
      const old = await parseJson(document((value) => twin(openapi, value)));
      const names = (s: ApiSpec) => s.models.map(({ name }) => name).sort();
      expect(names(spec)).toEqual(names(old));
      // The component keeps its name and fields; the nested `sms` variant
      // steps around it rather than overwriting it, in either spelling.
      expect(model(spec, 'SmsTagsPostRequestTarget').fields.map(({ name }) => name)).toEqual(['x']);
      const smsVariant = spec.models.find((m) => m.name !== 'SmsTagsPostRequestTarget' && m.name.startsWith('Sms'));
      expect(smsVariant, names(spec).join(', ')).toBeDefined();
      expect(smsVariant!.fields.map(({ name }) => name)).toEqual(['kind', 'number']);
      expect(diffOf(old, spec)).toEqual({ changes: [], exit: 0 });
    });
  });
});
