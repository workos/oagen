import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec, type ParseOptions } from '../../src/parser/parse.js';
import { pointerTypesAsModel } from '../../src/parser/schema-pointers.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #682: a union variant written as a JSON Pointer deeper into a
 * component (`$ref: '#/components/schemas/Shelter/properties/dog'`) is typed
 * as the model the pointed schema is built as (`ShelterDog`), and an
 * explicit `mapping` entry naming that pointer settles to the same model
 * (#619). With no `mapping`, the derivation named a `$ref` variant only by
 * the component it names exactly, so a pointer variant was unnamed and the
 * union mapped nothing: `{}` under the `discriminator` keyword, no implicit
 * discriminator without it, and an allOf+oneOf component flattened. A
 * pointer variant is now named by the model it settles to: its const is
 * read from the pointed schema and its entry written once the pointer is
 * settled, as the explicit entry naming that pointer is
 * (`deferDerivedPointerEntries`, `resolveSchemaPointers`).
 */

const CAT = '#/components/schemas/Cat';
const SHELTER_DOG = '#/components/schemas/Shelter/properties/dog';

type Discriminator = 'keyword' | 'none' | 'mapping';
type Union = Record<string, unknown> & { oneOf?: unknown[]; anyOf?: unknown[]; discriminator?: unknown };

const ref = (name: string) => ({ $ref: name.startsWith('#') ? name : `#/components/schemas/${name}` });

/** A discriminator pin as the OAS version spells one: `const` in 3.1, a one-value `enum` in 3.0. */
function pin(value: string, openapi: string) {
  return openapi.startsWith('3.0') ? { type: 'string', enum: [value] } : { type: 'string', const: value };
}

/** The issue's animal: `{ kind: <const>, name?: string }`, with `extra` properties beside them. */
function animal(kind: string, openapi: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'object',
    required: ['kind'],
    properties: { kind: pin(kind, openapi), name: { type: 'string' }, ...extra },
  };
}

/** The `discriminator` the issue's three spellings write: the keyword alone (`repro.json`), nothing (`implicit.json`), or the keyword with a mapping naming both variants (`mapping.json`). */
function discriminator(kind: Discriminator, second: string) {
  if (kind === 'none') return {};
  return {
    discriminator: { propertyName: 'kind', ...(kind === 'mapping' ? { mapping: { cat: CAT, dog: second } } : {}) },
  };
}

/** The issue's union: `oneOf` of `$ref: Cat` and `$ref: second`, discriminated as `kind` says. */
function union(kind: Discriminator, second: string = SHELTER_DOG): Union {
  return { oneOf: [ref(CAT), ref(second)], ...discriminator(kind, second) };
}

/** A union of the given variants under the keyword with no mapping, or with no keyword. */
function unionOf(kind: 'keyword' | 'none', variants: unknown[], keyword: 'oneOf' | 'anyOf' = 'oneOf'): Union {
  return { [keyword]: variants, ...(kind === 'keyword' ? { discriminator: { propertyName: 'kind' } } : {}) };
}

/** The issue's components: `Cat` and `Shelter: { dog }`, with `extra` beside them. */
function components(openapi: string, extra: Record<string, unknown> = {}) {
  return {
    Cat: animal('cat', openapi),
    Shelter: { type: 'object', properties: { dog: animal('dog', openapi) } },
    ...extra,
  };
}

/** `GET /<stem>/{id}` returning `schema`, as `operationId`. */
function getOp(operationId: string, schema: unknown) {
  return {
    get: {
      operationId,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
    },
  };
}

/** The issue's document: the given component schemas, served by `GET /pets/{id}` returning `Pet` unless `paths` says otherwise. */
function documentWith(
  openapi: string,
  schemas: Record<string, unknown>,
  paths: Record<string, unknown> = { '/pets/{id}': getOp('getPet', ref('Pet')) },
) {
  return { openapi, info: { title: 'repro', version: '1.0.0' }, paths, components: { schemas } };
}

/**
 * One document carrying `written` at every site that derives a mapping: the
 * component `Pet`; inline on `Owner.pet`, as the items of `Owner.pets` and
 * the values of `Owner.byName`; as the response body of `getInline`; and as
 * the variant axis of the allOf+oneOf component `Dispatcher`. `paths` are
 * served beside them.
 */
function everySite(
  openapi: string,
  schemas: Record<string, unknown>,
  written: Union,
  paths: Record<string, unknown> = {},
) {
  const { discriminator: keyword, ...axis } = written;
  return documentWith(
    openapi,
    {
      ...schemas,
      Pet: written,
      Owner: {
        type: 'object',
        properties: {
          pet: written,
          pets: { type: 'array', items: written },
          byName: { type: 'object', additionalProperties: written },
        },
      },
      Base: { type: 'object', properties: { id: { type: 'string' } } },
      Dispatcher: { allOf: [ref('Base'), axis], ...(keyword === undefined ? {} : { discriminator: keyword }) },
    },
    {
      '/pets/{id}': getOp('getPet', ref('Pet')),
      '/owners/{id}': getOp('getOwner', ref('Owner')),
      '/dispatchers/{id}': getOp('getDispatcher', ref('Dispatcher')),
      '/inline/{id}': getOp('getInline', written),
      ...paths,
    },
  );
}

/** A `dog` query enum of the `shelter` service, which takes the name `ShelterDog`, so `Shelter.dog`'s model steps to `ShelterDog2`. */
const SHELTER_DOG_ENUM = {
  '/shelter': {
    get: {
      operationId: 'listShelter',
      parameters: [{ name: 'dog', in: 'query', schema: { type: 'string', enum: ['x', 'y'] } }],
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Shelter') } } } },
    },
  },
};

const model = (name: string): TypeRef => ({ kind: 'model', name });
const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
const STRING: TypeRef = { kind: 'primitive', type: 'string' };
const UNKNOWN: TypeRef = { kind: 'primitive', type: 'unknown' };

/** The discriminator the issue expects of every spelling. */
const MAPPED = { property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } };

describe('#682 a discriminator with no mapping and a variant written as a pointer into a component', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-682-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown, options?: ParseOptions): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile, options);
  }

  /** Every `console.warn` message so far, in order. */
  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));
  const modelNames = (spec: ApiSpec) => spec.models.map(({ name }) => name).sort();
  const modelOf = (spec: ApiSpec, name: string): Model | undefined => spec.models.find((m) => m.name === name);
  const fieldNames = (spec: ApiSpec, name: string) => modelOf(spec, name)?.fields.map((f) => f.name);
  const fieldType = (spec: ApiSpec, modelName: string, field: string): TypeRef | undefined =>
    modelOf(spec, modelName)?.fields.find((f) => f.name === field)?.type;
  const operation = (spec: ApiSpec, name: string) =>
    spec.services.flatMap(({ operations }) => operations).find((op) => op.name === name);
  const discriminatorOf = (type: TypeRef | undefined) => (type?.kind === 'union' ? type.discriminator : undefined);
  const variantsOf = (type: TypeRef | undefined) => (type?.kind === 'union' ? type.variants : undefined);

  /** The discriminator `everySite`'s union carries at each site. */
  function discriminators(spec: ApiSpec) {
    const pets = fieldType(spec, 'Owner', 'pets');
    const byName = fieldType(spec, 'Owner', 'byName');
    return {
      component: modelOf(spec, 'Pet')?.discriminator,
      field: discriminatorOf(fieldType(spec, 'Owner', 'pet')),
      items: discriminatorOf(pets?.kind === 'array' ? pets.items : undefined),
      values: discriminatorOf(byName?.kind === 'map' ? byName.valueType : undefined),
      response: discriminatorOf(operation(spec, 'getInline')?.response),
      dispatcher: modelOf(spec, 'Dispatcher')?.discriminator,
    };
  }

  /** `expected` at every site of `everySite`. */
  const atEverySite = <T>(expected: T) => ({
    component: expected,
    field: expected,
    items: expected,
    values: expected,
    response: expected,
    dispatcher: expected,
  });

  /** The variants `everySite`'s union holds as a component, on the field and as the response body. */
  function variants(spec: ApiSpec) {
    return {
      component: modelOf(spec, 'Pet')?.variants,
      field: variantsOf(fieldType(spec, 'Owner', 'pet')),
      response: variantsOf(operation(spec, 'getInline')?.response),
    };
  }

  describe.each(['3.1.0', '3.0.3'])('on OpenAPI %s', (openapi) => {
    /** The issue's script: `Pet`'s discriminator and variants in each of its documents. */
    async function petOf(schemas: Record<string, unknown>) {
      const spec = await parseJson(documentWith(openapi, schemas));
      const pet = modelOf(spec, 'Pet');
      return { spec, discriminator: pet?.discriminator, variants: pet?.variants };
    }

    describe('the issue’s documents', () => {
      it('repro.json: maps the pointer variant by its const under the keyword, as mapping.json does', async () => {
        const { spec, discriminator, variants } = await petOf(components(openapi, { Pet: union('keyword') }));
        expect(discriminator).toEqual(MAPPED);
        expect(variants).toEqual([model('Cat'), model('ShelterDog')]);
        expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'Shelter', 'ShelterDog']);
        expect(warnings()).toEqual([]);
      });

      it('implicit.json: is discriminated on `kind` with the same mapping without the keyword', async () => {
        const { spec, discriminator, variants } = await petOf(components(openapi, { Pet: union('none') }));
        expect(discriminator).toEqual(MAPPED);
        expect(variants).toEqual([model('Cat'), model('ShelterDog')]);
        expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'Shelter', 'ShelterDog']);
        expect(warnings()).toEqual([]);
      });

      it('mapping.json: still settles the explicit entry naming the pointer', async () => {
        const { discriminator, variants } = await petOf(components(openapi, { Pet: union('mapping') }));
        expect(discriminator).toEqual(MAPPED);
        expect(variants).toEqual([model('Cat'), model('ShelterDog')]);
      });

      it('alias.json: still names a component that is an alias of the pointer by the alias', async () => {
        const { discriminator, variants } = await petOf(
          components(openapi, { Hound: ref(SHELTER_DOG), Pet: union('keyword', '#/components/schemas/Hound') }),
        );
        expect(discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Hound' } });
        expect(variants).toEqual([model('Cat'), model('Hound')]);
      });

      it('reports no change between any two of the three spellings (`oagen diff` exits 0)', async () => {
        const specs: ApiSpec[] = [];
        for (const kind of ['mapping', 'keyword', 'none'] as const) {
          specs.push(await parseJson(documentWith(openapi, components(openapi, { Pet: union(kind) }))));
        }
        for (const from of specs) {
          for (const to of specs) expect(diffSpecs(from, to).changes).toEqual([]);
        }
      });

      it('reads `mapping: {}` as no mapping', async () => {
        const { discriminator } = await petOf(
          components(openapi, {
            Pet: { oneOf: [ref(CAT), ref(SHELTER_DOG)], discriminator: { propertyName: 'kind', mapping: {} } },
          }),
        );
        expect(discriminator).toEqual(MAPPED);
      });

      it('leaves a mapping the document wrote for one variant alone as written', async () => {
        const { discriminator } = await petOf(
          components(openapi, {
            Pet: {
              oneOf: [ref(CAT), ref(SHELTER_DOG)],
              discriminator: { propertyName: 'kind', mapping: { cat: CAT } },
            },
          }),
        );
        expect(discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat' } });
      });
    });

    describe('at every site that derives a mapping', () => {
      it.each(['keyword', 'none', 'mapping'] as const)(
        'maps the union the same as a component, inline and as an allOf+oneOf dispatcher (%s)',
        async (kind) => {
          const spec = await parseJson(everySite(openapi, components(openapi), union(kind)));
          expect(discriminators(spec)).toEqual(atEverySite(MAPPED));
          expect(variants(spec)).toEqual({
            component: [model('Cat'), model('ShelterDog')],
            field: [model('Cat'), model('ShelterDog')],
            response: [model('Cat'), model('ShelterDog')],
          });
          // The dispatcher dispatches to the models its variants name and builds none of its own.
          expect(fieldNames(spec, 'Dispatcher')).toEqual(['id']);
          expect(modelNames(spec)).toEqual(['Base', 'Cat', 'Dispatcher', 'Owner', 'Pet', 'Shelter', 'ShelterDog']);
          expect(warnings()).toEqual([]);
        },
      );

      it('reports no change between the three spellings at any site', async () => {
        const specs: ApiSpec[] = [];
        for (const kind of ['mapping', 'keyword', 'none'] as const) {
          specs.push(await parseJson(everySite(openapi, components(openapi), union(kind))));
        }
        for (const from of specs) {
          for (const to of specs) expect(diffSpecs(from, to).changes).toEqual([]);
        }
      });

      it.each(['keyword', 'none'] as const)(
        'reads the pointer as the same union written `$ref: Dog` reads its component (%s)',
        async (kind) => {
          const spec = await parseJson(
            everySite(
              openapi,
              { Cat: animal('cat', openapi), Dog: animal('dog', openapi) },
              unionOf(kind, [ref(CAT), ref('Dog')]),
            ),
          );
          expect(discriminators(spec)).toEqual(atEverySite({ property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } }));
        },
      );

      it.each(['keyword', 'none'] as const)(
        'maps the union on a parameter, a header, an error body and inside a request and a response object (%s)',
        async (kind) => {
          const written = union(kind);
          const spec = await parseJson(
            documentWith(openapi, components(openapi), {
              '/pets': {
                post: {
                  operationId: 'createPet',
                  parameters: [{ name: 'filter', in: 'query', schema: written }],
                  requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { type: 'object', properties: { pet: written } } } },
                  },
                  responses: {
                    '200': {
                      description: 'OK',
                      headers: { 'X-Pet': { schema: written } },
                      content: { 'application/json': { schema: { type: 'object', properties: { pet: written } } } },
                    },
                    '400': { description: 'Bad', content: { 'application/json': { schema: written } } },
                  },
                },
              },
            }),
          );
          const op = operation(spec, 'createPet');
          expect(discriminatorOf(op?.queryParams[0]?.type)).toEqual(MAPPED);
          expect(discriminatorOf(fieldType(spec, 'CreatePetRequest', 'pet'))).toEqual(MAPPED);
          expect(discriminatorOf(fieldType(spec, 'CreatePetResponse', 'pet'))).toEqual(MAPPED);
          expect(discriminatorOf(op?.errors[0]?.type)).toEqual(MAPPED);
          expect(discriminatorOf(op?.responseHeaders?.[0]?.type)).toEqual(MAPPED);
          expect(warnings()).toEqual([]);
        },
      );

      it('still carries only the document’s own mapping on a request body written as the `oneOf`, as with `$ref: Dog`', async () => {
        const body = (written: Union) => ({
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: { required: true, content: { 'application/json': { schema: written } } },
              responses: { '204': { description: 'OK' } },
            },
          },
        });
        const bodyOf = async (schemas: Record<string, unknown>, written: Union) =>
          discriminatorOf(
            operation(await parseJson(documentWith(openapi, schemas, body(written))), 'createPet')?.requestBody,
          );
        const dogs = { Cat: animal('cat', openapi), Dog: animal('dog', openapi) };
        // The documented rule for a body's union (`UnionType.discriminator`), whichever way the variant is written.
        expect(await bodyOf(components(openapi), union('keyword'))).toEqual({ property: 'kind', mapping: {} });
        expect(await bodyOf(dogs, unionOf('keyword', [ref(CAT), ref('Dog')]))).toEqual({
          property: 'kind',
          mapping: {},
        });
        expect(await bodyOf(components(openapi), union('none'))).toBeUndefined();
        expect(await bodyOf(dogs, unionOf('none', [ref(CAT), ref('Dog')]))).toBeUndefined();
        expect(await bodyOf(components(openapi), union('mapping'))).toEqual(MAPPED);
      });

      it('maps an `anyOf` under the keyword and never implicitly, as an `anyOf` of components', async () => {
        const mapped = await parseJson(
          everySite(openapi, components(openapi), unionOf('keyword', [ref(CAT), ref(SHELTER_DOG)], 'anyOf')),
        );
        expect(discriminators(mapped)).toEqual(atEverySite(MAPPED));
        const implicit = await parseJson(
          everySite(openapi, components(openapi), unionOf('none', [ref(CAT), ref(SHELTER_DOG)], 'anyOf')),
        );
        // A named or inline `anyOf` is never discriminated implicitly; an allOf+anyOf axis whose variants pin a const dispatches.
        expect(discriminators(implicit)).toEqual({ ...atEverySite(undefined), dispatcher: MAPPED });
      });
    });

    describe('what the pointer lands on', () => {
      /** `everySite` with `Shelter.dog` written as `dog`, under the keyword and without it. */
      const kinds = ['keyword', 'none'] as const;
      const shelter = (dog: unknown, extra: Record<string, unknown> = {}) =>
        components(openapi, { Shelter: { type: 'object', properties: { dog } }, ...extra });

      it.each(kinds)('a schema that admits null: named through its nullable wrapper (%s)', async (kind) => {
        const dog = openapi.startsWith('3.0')
          ? { ...animal('dog', openapi), nullable: true }
          : { ...animal('dog', openapi), type: ['object', 'null'] };
        const spec = await parseJson(everySite(openapi, shelter(dog), union(kind)));
        expect(fieldType(spec, 'Shelter', 'dog')).toEqual(nullable(model('ShelterDog')));
        expect(variants(spec).component).toEqual([model('Cat'), nullable(model('ShelterDog'))]);
        expect(discriminators(spec)).toEqual(atEverySite(MAPPED));
        expect(warnings()).toEqual([]);
      });

      it.each(kinds)('a `$ref` to a component: named by that component (%s)', async (kind) => {
        const spec = await parseJson(
          everySite(openapi, shelter(ref('Dog'), { Dog: animal('dog', openapi) }), union(kind)),
        );
        expect(variants(spec).component).toEqual([model('Cat'), model('Dog')]);
        expect(discriminators(spec)).toEqual(atEverySite({ property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } }));
        expect(modelNames(spec)).not.toContain('ShelterDog');
      });

      it.each(kinds)('another pointer: named by the model the chain ends at (%s)', async (kind) => {
        const spec = await parseJson(
          everySite(
            openapi,
            components(openapi, { Zoo: { type: 'object', properties: { dog: ref(SHELTER_DOG) } } }),
            union(kind, '#/components/schemas/Zoo/properties/dog'),
          ),
        );
        expect(discriminators(spec)).toEqual(atEverySite(MAPPED));
      });

      it.each(kinds)('an `allOf` merged into a model, and a field one `allOf` member declares (%s)', async (kind) => {
        const merged = await parseJson(
          everySite(
            openapi,
            shelter({ allOf: [{ type: 'object', properties: { id: { type: 'string' } } }, animal('dog', openapi)] }),
            union(kind),
          ),
        );
        expect(discriminators(merged)).toEqual(atEverySite(MAPPED));
        const member = await parseJson(
          everySite(
            openapi,
            components(openapi, {
              Shelter: {
                allOf: [
                  { type: 'object', properties: { id: { type: 'string' } } },
                  { type: 'object', properties: { dog: animal('dog', openapi) } },
                ],
              },
            }),
            union(kind, '#/components/schemas/Shelter/allOf/1/properties/dog'),
          ),
        );
        expect(discriminators(member)).toEqual(atEverySite(MAPPED));
      });

      it.each(kinds)('an array’s items, a map’s values and a union’s variant (%s)', async (kind) => {
        const spec = await parseJson(
          everySite(
            openapi,
            components(openapi, {
              Kennel: {
                type: 'object',
                properties: {
                  dogs: { type: 'array', items: animal('dog', openapi) },
                  byName: { type: 'object', additionalProperties: animal('hound', openapi) },
                  pet: { oneOf: [animal('lion', openapi), animal('tiger', openapi)] },
                },
              },
            }),
            unionOf(kind, [
              ref(CAT),
              ref('#/components/schemas/Kennel/properties/dogs/items'),
              ref('#/components/schemas/Kennel/properties/byName/additionalProperties'),
              ref('#/components/schemas/Kennel/properties/pet/oneOf/1'),
            ]),
          ),
        );
        const names = (variants(spec).component ?? []).map((variant) => (variant.kind === 'model' ? variant.name : ''));
        expect(names).toHaveLength(4);
        expect(discriminators(spec)).toEqual(
          atEverySite({
            property: 'kind',
            mapping: { cat: names[0], dog: names[1], hound: names[2], tiger: names[3] },
          }),
        );
        for (const name of names) expect(modelNames(spec)).toContain(name);
        expect(names.slice(0, 3)).toEqual(['Cat', 'KennelDogs', 'KennelByName']);
      });

      it.each(kinds)('a pin behind a `$ref`, and one that lists `null` beside its value (%s)', async (kind) => {
        const kindSchema = openapi.startsWith('3.0')
          ? { type: 'string', enum: ['dog', null], nullable: true }
          : { type: ['string', 'null'], enum: ['dog', null] };
        for (const dogKind of [ref('DogKind'), kindSchema]) {
          const spec = await parseJson(
            everySite(
              openapi,
              shelter(
                { type: 'object', required: ['kind'], properties: { kind: dogKind, name: { type: 'string' } } },
                { DogKind: pin('dog', openapi) },
              ),
              union(kind),
            ),
          );
          expect(discriminators(spec)).toEqual(atEverySite(MAPPED));
        }
      });
    });

    describe('how the variant is written around the pointer', () => {
      const kinds = ['keyword', 'none'] as const;

      it.each(kinds)('under a nullable wrapper (%s)', async (kind) => {
        const spec = await parseJson(
          everySite(
            openapi,
            components(openapi),
            unionOf(kind, [ref(CAT), { oneOf: [ref(SHELTER_DOG), { type: 'null' }] }]),
          ),
        );
        expect(variants(spec).component).toEqual([model('Cat'), nullable(model('ShelterDog'))]);
        expect(discriminators(spec)).toEqual(atEverySite(MAPPED));
      });

      it.each(kinds)('beside a member that names no model (%s)', async (kind) => {
        const spec = await parseJson(
          everySite(
            openapi,
            components(openapi),
            unionOf(kind, [ref(CAT), { anyOf: [ref(SHELTER_DOG), { type: 'string' }] }]),
          ),
        );
        expect(variants(spec).component).toEqual([
          model('Cat'),
          { kind: 'union', variants: [model('ShelterDog'), STRING], compositionKind: 'anyOf' },
        ]);
        expect(discriminators(spec)).toEqual(atEverySite(MAPPED));
        expect(warnings()).toEqual([]);
      });

      it.each(kinds)('as the one member of an `allOf` (%s)', async (kind) => {
        const spec = await parseJson(
          everySite(openapi, components(openapi), unionOf(kind, [ref(CAT), { allOf: [ref(SHELTER_DOG)] }])),
        );
        expect(variants(spec).component).toEqual([model('Cat'), model('ShelterDog')]);
        expect(discriminators(spec)).toEqual(atEverySite(MAPPED));
      });

      it.each(kinds)('as every variant of the union (%s)', async (kind) => {
        const spec = await parseJson(
          everySite(
            openapi,
            components(openapi, { Zoo: { type: 'object', properties: { cat: animal('lion', openapi) } } }),
            unionOf(kind, [ref(SHELTER_DOG), ref('#/components/schemas/Zoo/properties/cat')]),
          ),
        );
        expect(variants(spec).component).toEqual([model('ShelterDog'), model('ZooCat')]);
        expect(discriminators(spec)).toEqual(
          atEverySite({ property: 'kind', mapping: { dog: 'ShelterDog', lion: 'ZooCat' } }),
        );
      });

      it('as the one variant: mapped under the keyword, as one `$ref: Dog` is', async () => {
        const spec = await parseJson(everySite(openapi, components(openapi), unionOf('keyword', [ref(SHELTER_DOG)])));
        expect(discriminators(spec)).toEqual(atEverySite({ property: 'kind', mapping: { dog: 'ShelterDog' } }));
        const implicit = await parseJson(everySite(openapi, components(openapi), unionOf('none', [ref(SHELTER_DOG)])));
        // A union of one variant has no implicit discriminator; an allOf+oneOf axis of one pinned variant dispatches.
        expect(discriminators(implicit)).toEqual({
          ...atEverySite(undefined),
          dispatcher: { property: 'kind', mapping: { dog: 'ShelterDog' } },
        });
      });

      it.each(kinds)('in either order of the variants and the components (%s)', async (kind) => {
        const { Cat, Shelter } = components(openapi);
        const spec = await parseJson(everySite(openapi, { Shelter, Cat }, unionOf(kind, [ref(SHELTER_DOG), ref(CAT)])));
        expect(variants(spec).component).toEqual([model('ShelterDog'), model('Cat')]);
        expect(discriminators(spec)).toEqual(atEverySite(MAPPED));
      });
    });

    describe('beside inline object variants', () => {
      it('names a titled inline variant by its title where the union is discriminated implicitly, as beside `$ref: Dog`', async () => {
        const tabby = { ...animal('cat', openapi), title: 'Tabby' };
        const spec = await parseJson(
          documentWith(openapi, components(openapi, { Pet: unionOf('none', [tabby, ref(SHELTER_DOG)]) })),
        );
        const pet = modelOf(spec, 'Pet');
        expect(pet?.variants).toEqual([model('Tabby'), model('ShelterDog')]);
        expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Tabby', dog: 'ShelterDog' } });
        const dogs = await parseJson(
          documentWith(openapi, {
            Cat: animal('cat', openapi),
            Dog: animal('dog', openapi),
            Pet: unionOf('none', [tabby, ref('Dog')]),
          }),
        );
        expect(modelOf(dogs, 'Pet')?.discriminator).toEqual({
          property: 'kind',
          mapping: { cat: 'Tabby', dog: 'Dog' },
        });
      });

      it.each(['keyword', 'none'] as const)(
        'maps an untitled inline variant by the model extracted for it (%s)',
        async (kind) => {
          const spec = await parseJson(
            documentWith(
              openapi,
              components(openapi, {
                Pet: unionOf(kind, [
                  animal('cat', openapi),
                  animal('bird', openapi, { wings: { type: 'integer' } }),
                  ref(SHELTER_DOG),
                ]),
                Owner: {
                  type: 'object',
                  properties: { pet: unionOf(kind, [animal('cat', openapi), ref(SHELTER_DOG)]) },
                },
              }),
              { '/pets/{id}': getOp('getPet', ref('Pet')), '/owners/{id}': getOp('getOwner', ref('Owner')) },
            ),
          );
          expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
            property: 'kind',
            mapping: { cat: 'CatPet', bird: 'BirdPet', dog: 'ShelterDog' },
          });
          expect(discriminatorOf(fieldType(spec, 'Owner', 'pet'))).toEqual({
            property: 'kind',
            mapping: { cat: 'OwnerPet', dog: 'ShelterDog' },
          });
          for (const name of ['CatPet', 'BirdPet', 'OwnerPet', 'ShelterDog']) expect(modelNames(spec)).toContain(name);
        },
      );

      it.each(['keyword', 'none'] as const)(
        'builds a dispatcher’s inline variant and names the pointer’s model beside it (%s)',
        async (kind) => {
          const spec = await parseJson(
            documentWith(
              openapi,
              components(openapi, {
                Base: { type: 'object', properties: { id: { type: 'string' } } },
                Pet: {
                  allOf: [ref('Base'), { oneOf: [animal('cat', openapi), ref(SHELTER_DOG)] }],
                  ...(kind === 'keyword' ? { discriminator: { propertyName: 'kind' } } : {}),
                },
              }),
            ),
          );
          expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
            property: 'kind',
            mapping: { cat: 'PetCat', dog: 'ShelterDog' },
          });
          expect(fieldNames(spec, 'Pet')).toEqual(['id']);
          expect(modelNames(spec)).toEqual(['Base', 'Cat', 'Pet', 'PetCat', 'Shelter', 'ShelterDog']);
        },
      );
    });

    describe('a rename of the pointed schema’s model after the settle', () => {
      it.each(['keyword', 'none'] as const)(
        'reaches the derived entry at every site, and a copy of the union (%s)',
        async (kind) => {
          const spec = await parseJson(
            everySite(
              openapi,
              components(openapi, {
                // `Keeper` merges `Owner`'s fields, so its `pet` is a copy of `Owner.pet`'s union.
                Keeper: { allOf: [ref('Owner'), { type: 'object', properties: { badge: { type: 'string' } } }] },
              }),
              union(kind),
              { ...SHELTER_DOG_ENUM, '/keepers/{id}': getOp('getKeeper', ref('Keeper')) },
            ),
          );
          expect(spec.enums.map((e) => e.name)).toContain('ShelterDog');
          expect(fieldType(spec, 'Shelter', 'dog')).toEqual(model('ShelterDog2'));
          const renamed = { property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog2' } };
          expect(discriminators(spec)).toEqual(atEverySite(renamed));
          expect(variants(spec).component).toEqual([model('Cat'), model('ShelterDog2')]);
          expect(fieldType(spec, 'Keeper', 'pet')).toEqual({
            kind: 'union',
            variants: [model('Cat'), model('ShelterDog2')],
            compositionKind: 'oneOf',
            discriminator: renamed,
          });
          expect(modelNames(spec)).not.toContain('ShelterDog');
        },
      );

      it.each(['keyword', 'none'] as const)(
        'reaches the entry of a variant that wraps the pointer beside another member (%s)',
        async (kind) => {
          const spec = await parseJson(
            everySite(
              openapi,
              components(openapi),
              unionOf(kind, [ref(CAT), { anyOf: [ref(SHELTER_DOG), { type: 'string' }] }]),
              SHELTER_DOG_ENUM,
            ),
          );
          expect(variants(spec).component).toEqual([
            model('Cat'),
            { kind: 'union', variants: [model('ShelterDog2'), STRING], compositionKind: 'anyOf' },
          ]);
          expect(discriminators(spec)).toEqual(
            atEverySite({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog2' } }),
          );
        },
      );
    });

    describe('a pointer variant that settles to no model is unnamed, so the union derives nothing', () => {
      /** Nothing derived: `{}` under the keyword, no discriminator without it, and the allOf+oneOf component flattened. */
      const nothing = (kind: 'keyword' | 'none') => ({
        ...atEverySite(kind === 'keyword' ? { property: 'kind', mapping: {} } : undefined),
        dispatcher: undefined,
      });
      const kinds = ['keyword', 'none'] as const;

      it.each(kinds)(
        'a schema read as a union of several types, on the union and on a copy of it (%s)',
        async (kind) => {
          const spec = await parseJson(
            everySite(
              openapi,
              components(openapi, {
                Shelter: {
                  type: 'object',
                  properties: { dog: { ...animal('dog', openapi), type: ['object', 'string'] } },
                },
                Keeper: { allOf: [ref('Owner'), { type: 'object', properties: { badge: { type: 'string' } } }] },
              }),
              union(kind),
              { '/keepers/{id}': getOp('getKeeper', ref('Keeper')) },
            ),
          );
          const settled: TypeRef = { kind: 'union', variants: [model('ShelterDog'), STRING] };
          expect(variants(spec).component).toEqual([model('Cat'), settled]);
          expect(discriminators(spec)).toEqual(nothing(kind));
          expect(discriminatorOf(fieldType(spec, 'Keeper', 'pet'))).toEqual(nothing(kind).field);
          // Flattened, as before: the variants' fields are the model's own.
          expect(fieldNames(spec, 'Dispatcher')).toEqual(['id', 'kind', 'name']);
          expect(warnings()).toEqual([]);
        },
      );

      it.each(kinds)(
        'a schema the parser types nothing at (a `$defs` entry), reported once per site (%s)',
        async (kind) => {
          const pointer = '#/components/schemas/Shelter/$defs/dog';
          const spec = await parseJson(
            documentWith(
              openapi,
              {
                Cat: animal('cat', openapi),
                Shelter: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  $defs: { dog: animal('dog', openapi) },
                },
                Pet: union(kind, pointer),
                Owner: { type: 'object', properties: { pet: union(kind, pointer) } },
                Base: { type: 'object', properties: { id: { type: 'string' } } },
                Dispatcher: {
                  allOf: [ref('Base'), { oneOf: [ref(CAT), ref(pointer)] }],
                  ...(kind === 'keyword' ? { discriminator: { propertyName: 'kind' } } : {}),
                },
              },
              {
                '/pets/{id}': getOp('getPet', ref('Pet')),
                '/owners/{id}': getOp('getOwner', ref('Owner')),
                '/dispatchers/{id}': getOp('getDispatcher', ref('Dispatcher')),
              },
            ),
          );
          const expected = kind === 'keyword' ? { property: 'kind', mapping: {} } : undefined;
          expect(modelOf(spec, 'Pet')?.variants).toEqual([model('Cat'), UNKNOWN]);
          expect(modelOf(spec, 'Pet')?.discriminator).toEqual(expected);
          expect(discriminatorOf(fieldType(spec, 'Owner', 'pet'))).toEqual(expected);
          expect(modelOf(spec, 'Dispatcher')?.discriminator).toBeUndefined();
          expect(fieldNames(spec, 'Dispatcher')).toEqual(['id', 'kind', 'name']);
          expect(warnings()).toEqual([
            `[oagen] Warning: Unresolved schema $ref "${pointer}" in Pet.variants: no schema at that pointer — typing the site as unknown`,
            `[oagen] Warning: Unresolved schema $ref "${pointer}" in Owner.pet: no schema at that pointer — typing the site as unknown`,
          ]);
        },
      );

      it.each(kinds)(
        'a variant wrapping such a pointer beside another member: still reported once (%s)',
        async (kind) => {
          const pointer = '#/components/schemas/Shelter/$defs/dog';
          const spec = await parseJson(
            documentWith(openapi, {
              Cat: animal('cat', openapi),
              Shelter: {
                type: 'object',
                properties: { id: { type: 'string' } },
                $defs: { dog: animal('dog', openapi) },
              },
              Pet: unionOf(kind, [ref(CAT), { anyOf: [ref(pointer), { type: 'string' }] }]),
            }),
          );
          expect(modelOf(spec, 'Pet')?.discriminator).toEqual(
            kind === 'keyword' ? { property: 'kind', mapping: {} } : undefined,
          );
          expect(warnings()).toEqual([
            `[oagen] Warning: Unresolved schema $ref "${pointer}" in Pet.variants: no schema at that pointer — typing the site as unknown`,
          ]);
        },
      );

      it.each(kinds)('a string, which pins nothing (%s)', async (kind) => {
        const spec = await parseJson(
          everySite(openapi, components(openapi), union(kind, `${SHELTER_DOG}/properties/name`)),
        );
        expect(variants(spec).component).toEqual([model('Cat'), STRING]);
        expect(discriminators(spec)).toEqual(nothing(kind));
        expect(warnings()).toEqual([]);
      });

      it.each(kinds)('a pointer that leads nowhere, which only `transformSpec` can write (%s)', async (kind) => {
        const nope = '#/components/schemas/Shelter/properties/nope';
        const spec = await parseJson(
          documentWith(openapi, components(openapi, { Dog: animal('dog', openapi), Pet: union(kind, 'Dog') })),
          {
            transformSpec: (document) => {
              const schemas = (document.components as { schemas: Record<string, { oneOf: Array<{ $ref: string }> }> })
                .schemas;
              schemas.Pet!.oneOf[1]!.$ref = nope;
              return document;
            },
          },
        );
        expect(modelOf(spec, 'Pet')?.variants).toEqual([model('Cat'), UNKNOWN]);
        expect(modelOf(spec, 'Pet')?.discriminator).toEqual(
          kind === 'keyword' ? { property: 'kind', mapping: {} } : undefined,
        );
        expect(warnings()).toEqual([
          `[oagen] Warning: Unresolved schema $ref "${nope}" in Pet.variants: no schema at that pointer — typing the site as unknown`,
        ]);
      });

      it.each(kinds)(
        'keeps the names the inline variants had before when the titles cannot map the union (%s)',
        async (kind) => {
          const tabby = { ...animal('cat', openapi), title: 'Tabby' };
          const spec = await parseJson(
            documentWith(
              openapi,
              components(openapi, {
                Shelter: {
                  type: 'object',
                  properties: { dog: { ...animal('dog', openapi), type: ['object', 'string'] } },
                },
                Pet: unionOf(kind, [tabby, ref(SHELTER_DOG)]),
              }),
            ),
          );
          const pet = modelOf(spec, 'Pet');
          expect(pet?.variants?.[0]).toEqual(model('TabbyPet'));
          expect(pet?.discriminator).toEqual(kind === 'keyword' ? { property: 'kind', mapping: {} } : undefined);
        },
      );
    });

    describe('the two decisions made before any model is built read the pointer ahead', () => {
      describe('a type list of several types, read as the type builder reads it (Greptile, review round 1)', () => {
        const kinds = ['keyword', 'none'] as const;
        const dogs = (dog: unknown, extra: Record<string, unknown> = {}) =>
          components(openapi, {
            Dog: animal('dog', openapi),
            Shelter: { type: 'object', properties: { dog } },
            ...extra,
          });
        const DOG = { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } };

        it.each(kinds)('narrowed to one model by its `allOf`: mapped and dispatched (%s)', async (kind) => {
          // `Dog` declares `type: 'object'`, so the `string` copy is left out and the field is `Dog`.
          const spec = await parseJson(
            everySite(openapi, dogs({ type: ['object', 'string'], allOf: [ref('Dog')] }), union(kind)),
          );
          expect(fieldType(spec, 'Shelter', 'dog')).toEqual(model('Dog'));
          expect(discriminators(spec)).toEqual(atEverySite(DOG));
          expect(fieldNames(spec, 'Dispatcher')).toEqual(['id']);
        });

        it.each(kinds)('narrowed and nullable, and a list no entry of which survives (%s)', async (kind) => {
          const nullableList = await parseJson(
            everySite(openapi, dogs({ type: ['object', 'string', 'null'], allOf: [ref('Dog')] }), union(kind)),
          );
          expect(fieldType(nullableList, 'Shelter', 'dog')).toEqual(nullable(model('Dog')));
          expect(discriminators(nullableList)).toEqual(atEverySite(DOG));
          // Neither `string` nor `integer` survives `Dog`, so the list is read as written and holds `Dog` once.
          const contradicted = await parseJson(
            everySite(openapi, dogs({ type: ['string', 'integer'], allOf: [ref('Dog')] }), union(kind)),
          );
          expect(fieldType(contradicted, 'Shelter', 'dog')).toEqual(model('Dog'));
          expect(discriminators(contradicted)).toEqual(atEverySite(DOG));
        });

        it.each(kinds)('narrowed to the model its `allOf` merges into (%s)', async (kind) => {
          const merged = { type: 'object', properties: { size: { type: 'integer' } } };
          const spec = await parseJson(
            everySite(openapi, dogs({ type: ['object', 'string'], allOf: [ref('Dog'), merged] }), union(kind)),
          );
          expect(fieldType(spec, 'Shelter', 'dog')).toEqual(model('ShelterDog'));
          expect(discriminators(spec)).toEqual(atEverySite(MAPPED));
        });

        it.each(kinds)('left a union of its types: nothing derived, and the component flattened (%s)', async (kind) => {
          // `Typeless` declares no `type`, so the `string` copy survives: `Typeless | string`.
          const typeless = { properties: animal('dog', openapi).properties, required: ['kind'] };
          const spec = await parseJson(
            everySite(
              openapi,
              dogs({ type: ['object', 'string'], allOf: [ref('Typeless')] }, { Typeless: typeless }),
              union(kind),
            ),
          );
          expect(fieldType(spec, 'Shelter', 'dog')).toEqual({ kind: 'union', variants: [model('Typeless'), STRING] });
          expect(discriminators(spec)).toEqual({
            ...atEverySite(kind === 'keyword' ? { property: 'kind', mapping: {} } : undefined),
            dispatcher: undefined,
          });
          expect(fieldNames(spec, 'Dispatcher')).toEqual(['id', 'kind', 'name']);
        });
      });

      describe('agrees with the settle on whether the pointer names a model', () => {
        const dog = animal('dog', openapi);
        const extra = { type: 'object', properties: { size: { type: 'integer' } } };
        const shared = {
          Dog: dog,
          Typeless: { properties: dog.properties, required: ['kind'] },
          Hound: ref('Dog'),
          NullableDog: openapi.startsWith('3.0') ? { ...dog, nullable: true } : { ...dog, type: ['object', 'null'] },
          DogOrCat: { oneOf: [ref('Dog'), ref(CAT)] },
          Stringy: { type: 'string', properties: dog.properties },
          Extra: extra,
        };
        const shapes: Array<[string, unknown]> = [
          ['an inline object', dog],
          ['an inline object with no `type`', { properties: dog.properties }],
          ['an inline object beside `additionalProperties`', { ...dog, additionalProperties: { type: 'string' } }],
          ['an inline object beside an `allOf` of bare limits', { ...dog, allOf: [{ minProperties: 1 }] }],
          ['an inline object beside a `oneOf` that types nothing', { ...dog, oneOf: [{ required: ['name'] }] }],
          ['an inline object under `type: [object]`', { ...dog, type: ['object'] }],
          ['an inline object under `nullable: true`', { ...dog, nullable: true }],
          ['an inline object under `type: [object, string]`', { ...dog, type: ['object', 'string'] }],
          ['a `$ref` with text beside it', { ...ref('Dog'), description: 'The dog.' }],
          ['a `$ref` to a component with no `type`', ref('Typeless')],
          ['a `$ref` to an alias', ref('Hound')],
          ['a `$ref` to a component that admits null', ref('NullableDog')],
          ['a `$ref` to a named union', ref('DogOrCat')],
          ['a `$ref` to a primitive component with stray `properties`', ref('Stringy')],
          ['an `allOf` of one `$ref`', { allOf: [ref('Dog')] }],
          ['an `allOf` of one `$ref` and an annotating member', { allOf: [ref('Dog'), { description: 'The dog.' }] }],
          ['an `allOf` of one `$ref` beside `required`', { allOf: [ref('Dog')], required: ['name'] }],
          ['an `allOf` of two `$ref`s', { allOf: [ref('Dog'), ref('Extra')] }],
          ['an `allOf` of a `$ref` and an inline object', { allOf: [ref('Dog'), extra] }],
          ['an `allOf` of one inline object', { allOf: [dog] }],
          ['an `allOf` nested in an `allOf`', { allOf: [{ allOf: [ref('Dog')] }] }],
          ['an `allOf` beside `nullable: true`, which declares nothing', { allOf: [ref('Dog')], nullable: true }],
          ['an `allOf` beside `type: [object, null]`', { type: ['object', 'null'], allOf: [ref('Dog')] }],
          ['a nullable `oneOf` around a `$ref`', { oneOf: [ref('Dog'), { type: 'null' }] }],
          ['a `oneOf` of one `$ref`', { oneOf: [ref('Dog')] }],
          ['an `anyOf` of a `$ref` and a string', { anyOf: [ref('Dog'), { type: 'string' }] }],
          ['an array of the object', { type: 'array', items: dog }],
          ['a map of the object', { type: 'object', additionalProperties: dog }],
        ];

        it.each(shapes)('%s', async (_label, shape) => {
          const pointer = '#/components/schemas/Holder/properties/dog';
          const variants = [ref(CAT), ref(pointer)];
          const spec = await parseJson(
            documentWith(
              openapi,
              {
                Cat: animal('cat', openapi),
                ...shared,
                Holder: { type: 'object', properties: { dog: shape } },
                Base: { type: 'object', properties: { id: { type: 'string' } } },
                Pet: { oneOf: variants, discriminator: { propertyName: 'kind' } },
                Dispatcher: { allOf: [ref('Base'), { oneOf: variants }], discriminator: { propertyName: 'kind' } },
              },
              {
                '/pets/{id}': getOp('getPet', ref('Pet')),
                '/dispatchers/{id}': getOp('getDispatcher', ref('Dispatcher')),
              },
            ),
          );
          const derived = modelOf(spec, 'Pet')?.discriminator;
          const dispatched = modelOf(spec, 'Dispatcher')?.discriminator;
          // The union waits for the settle; the dispatcher read ahead. Both name the same model, or neither names one.
          if (Object.keys(derived?.mapping ?? {}).length > 0) expect(dispatched).toEqual(derived);
          else expect(dispatched).toBeUndefined();
          for (const target of Object.values(derived?.mapping ?? {})) expect(modelNames(spec)).toContain(target);
          expect(warnings()).toEqual([]);
        });
      });

      it('leaves to the settle what the document alone cannot refuse: a pointer through a primitive component’s `properties` derives nothing on a union, and leaves a dispatcher’s entry as the pointer, as the explicit entry naming it is left', async () => {
        const pointer = '#/components/schemas/Code/properties/dog';
        const schemas = (kind: Discriminator) => ({
          Cat: animal('cat', openapi),
          // A string with stray `properties`: the document lands the pointer on an object, the IR has no field to read.
          Code: { type: 'string', properties: { dog: animal('dog', openapi) } },
          Pet: union(kind === 'mapping' ? 'mapping' : kind, pointer),
          Base: { type: 'object', properties: { id: { type: 'string' } } },
          Dispatcher: { allOf: [ref('Base'), { oneOf: [ref(CAT), ref(pointer)] }], ...discriminator(kind, pointer) },
        });
        const paths = {
          '/pets/{id}': getOp('getPet', ref('Pet')),
          '/dispatchers/{id}': getOp('getDispatcher', ref('Dispatcher')),
        };
        const derived = await parseJson(documentWith(openapi, schemas('keyword'), paths));
        expect(modelOf(derived, 'Pet')?.variants).toEqual([model('Cat'), UNKNOWN]);
        expect(modelOf(derived, 'Pet')?.discriminator).toEqual({ property: 'kind', mapping: {} });
        expect(modelOf(derived, 'Dispatcher')?.discriminator).toEqual({
          property: 'kind',
          mapping: { cat: 'Cat', dog: pointer },
        });
        expect(warnings()).toEqual([
          `[oagen] Warning: Unresolved schema $ref "${pointer}" in Pet.variants: primitive has no fields to read "dog" from — typing the site as unknown`,
          `[oagen] Warning: Unresolved schema $ref "${pointer}" in Dispatcher.discriminator.mapping.dog: primitive has no fields to read "dog" from — leaving the entry as written`,
        ]);
        const explicit = await parseJson(documentWith(openapi, schemas('mapping'), paths));
        expect(modelOf(explicit, 'Dispatcher')).toEqual(modelOf(derived, 'Dispatcher'));
      });
    });

    describe('an allOf+oneOf component, however it writes the union', () => {
      const base = { type: 'object', properties: { id: { type: 'string' } } };
      const keyword = { discriminator: { propertyName: 'kind' } };
      const axis = [ref(CAT), ref(SHELTER_DOG)];
      const spellings: Array<[string, Record<string, unknown>]> = [
        ['the keyword on the union', { Pet: { allOf: [ref('Base'), { oneOf: axis, ...keyword }] } }],
        ['`properties` beside the `oneOf`', { Pet: { type: 'object', properties: base.properties, oneOf: axis } }],
        ['a nullable union', { Pet: { allOf: [ref('Base'), { oneOf: [...axis, { type: 'null' }] }] } }],
        [
          'the union behind a `$ref`',
          { Axis: { oneOf: axis }, Pet: { allOf: [ref('Base'), ref('Axis')], ...keyword } },
        ],
      ];

      it.each(spellings)('dispatches to the pointed schema’s model: %s', async (_label, schemas) => {
        const spec = await parseJson(documentWith(openapi, components(openapi, { Base: base, ...schemas })));
        expect(modelOf(spec, 'Pet')?.discriminator).toEqual(MAPPED);
        expect(fieldNames(spec, 'Pet')).toEqual(['id']);
        expect(modelNames(spec)).toContain('ShelterDog');
        expect(warnings()).toEqual([]);
      });

      it('is carried by a component that aliases or extends it as with `$ref: Dog`', async () => {
        const read = async (second: string, schemas: Record<string, unknown>) => {
          const spec = await parseJson(
            documentWith(openapi, {
              ...schemas,
              Base: base,
              Real: { allOf: [ref('Base'), { oneOf: [ref(CAT), ref(second)] }], ...keyword },
              Alias: ref('Real'),
              Extended: { allOf: [ref('Real'), { type: 'object', properties: { extra: { type: 'string' } } }] },
              Pet: ref('Real'),
            }),
          );
          return ['Alias', 'Extended'].map((name) => ({
            name,
            fields: fieldNames(spec, name),
            discriminator: modelOf(spec, name)?.discriminator,
          }));
        };
        const pointer = await read(SHELTER_DOG, components(openapi));
        const component = await read('Dog', { Cat: animal('cat', openapi), Dog: animal('dog', openapi) });
        // The union is left to the dispatcher in both spellings: neither model carries a variant's field.
        expect(pointer).toEqual(component);
        expect(pointer).toEqual([
          { name: 'Alias', fields: ['id'], discriminator: undefined },
          { name: 'Extended', fields: ['id', 'extra'], discriminator: undefined },
        ]);
      });
    });

    describe('a union that derives nothing for another reason', () => {
      it.each(['keyword', 'none'] as const)(
        'a pointed schema written as a nullable `oneOf` around the object, which pins nothing as a component or inline either (%s)',
        async (kind) => {
          const wrapper = { oneOf: [animal('dog', openapi), { type: 'null' }] };
          const nothing = kind === 'keyword' ? { property: 'kind', mapping: {} } : undefined;
          const read = async (schemas: Record<string, unknown>) =>
            modelOf(await parseJson(documentWith(openapi, schemas)), 'Pet');
          const cat = { Cat: animal('cat', openapi) };
          const pointer = await read({
            ...cat,
            Shelter: { type: 'object', properties: { dog: wrapper } },
            Pet: union(kind),
          });
          expect(pointer?.variants).toEqual([model('Cat'), nullable(model('ShelterDog'))]);
          expect(pointer?.discriminator).toEqual(nothing);
          // The const is read off the variant's schema, not through a `oneOf` around it, however the variant is written.
          const component = await read({ ...cat, Dog: wrapper, Pet: unionOf(kind, [ref(CAT), ref('Dog')]) });
          expect(component?.variants).toEqual([model('Cat'), nullable(model('Dog'))]);
          expect(component?.discriminator).toEqual(nothing);
          const inline = await read({ ...cat, Pet: unionOf(kind, [ref(CAT), wrapper]) });
          expect(inline?.discriminator).toEqual(nothing);
          // The document's own mapping still names the pointed schema's model (#619).
          const mapped = await read({
            ...cat,
            Shelter: { type: 'object', properties: { dog: wrapper } },
            Pet: union('mapping'),
          });
          expect(mapped?.discriminator).toEqual(MAPPED);
        },
      );

      it.each(['keyword', 'none'] as const)(
        'two variants written as one pointer, or a pointed schema that pins no const (%s)',
        async (kind) => {
          const nothing = {
            ...atEverySite(kind === 'keyword' ? { property: 'kind', mapping: {} } : undefined),
            dispatcher: undefined,
          };
          const twice = await parseJson(
            everySite(openapi, components(openapi), unionOf(kind, [ref(SHELTER_DOG), ref(SHELTER_DOG)])),
          );
          expect(discriminators(twice)).toEqual(nothing);
          const unpinned = await parseJson(
            everySite(
              openapi,
              components(openapi, {
                Shelter: {
                  type: 'object',
                  properties: { dog: { type: 'object', properties: { name: { type: 'string' } } } },
                },
              }),
              union(kind),
            ),
          );
          expect(variants(unpinned).component).toEqual([model('Cat'), model('ShelterDog')]);
          expect(discriminators(unpinned)).toEqual(nothing);
        },
      );
    });

    it('names the model under the project’s `schemaNameTransform`, as the variant is', async () => {
      const spec = await parseJson(everySite(openapi, components(openapi), union('keyword')), {
        schemaNameTransform: (name) => `Api${name}`,
      });
      expect(modelOf(spec, 'ApiPet')?.variants).toEqual([model('ApiCat'), model('ApiShelterDog')]);
      expect(modelOf(spec, 'ApiPet')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'ApiCat', dog: 'ApiShelterDog' },
      });
      expect(discriminatorOf(fieldType(spec, 'ApiOwner', 'pet'))).toEqual({
        property: 'kind',
        mapping: { cat: 'ApiCat', dog: 'ApiShelterDog' },
      });
      expect(modelOf(spec, 'ApiDispatcher')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'ApiCat', dog: 'ApiShelterDog' },
      });
    });

    it('reads a pointer variant `transformSpec` writes as one the document wrote', async () => {
      const spec = await parseJson(
        documentWith(
          openapi,
          components(openapi, { Dog: animal('dog', openapi), Pet: unionOf('keyword', [ref(CAT), ref('Dog')]) }),
        ),
        {
          transformSpec: (document) => {
            const schemas = (document.components as { schemas: Record<string, { oneOf: Array<{ $ref: string }> }> })
              .schemas;
            schemas.Pet!.oneOf[1]!.$ref = SHELTER_DOG;
            return document;
          },
        },
      );
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual(MAPPED);
    });
  });

  describe('`pointerTypesAsModel`', () => {
    const dog = animal('dog', '3.1.0');
    const pointer = (to: string) => ref(`#/components/schemas/${to}`);
    const schemas: Record<string, SchemaObject> = {
      Dog: dog,
      Kind: { type: 'string', enum: ['cat', 'dog'] },
      Holder: {
        type: 'object',
        properties: {
          dog,
          maybe: { ...dog, type: ['object', 'null'] },
          wrapped: { oneOf: [dog, { type: 'null' }] },
          merged: { allOf: [{ type: 'object', properties: { id: { type: 'string' } } }, dog] },
          lone: { allOf: [dog], description: 'The dog.' },
          friend: ref('Dog'),
          chained: pointer('Holder/properties/dog'),
          dogs: { type: 'array', items: dog },
          name: { type: 'string' },
          either: { ...dog, type: ['object', 'string'] },
          pick: { oneOf: [dog, animal('hound', '3.1.0')] },
          kind: ref('Kind'),
          self: pointer('Holder/properties/self'),
        },
        $defs: { dog },
      },
    };
    const lands = (to: string): boolean => pointerTypesAsModel(`#/components/schemas/${to}`, schemas);

    it('answers from the document alone: a model in any spelling, under a nullable wrapper and through a chain', () => {
      expect(lands('Holder/properties/dog')).toBe(true);
      expect(lands('Holder/properties/maybe')).toBe(true);
      expect(lands('Holder/properties/wrapped')).toBe(true);
      expect(lands('Holder/properties/merged')).toBe(true);
      expect(lands('Holder/properties/lone')).toBe(true);
      expect(lands('Holder/properties/friend')).toBe(true);
      expect(lands('Holder/properties/chained')).toBe(true);
      expect(lands('Holder/properties/dogs/items')).toBe(true);
      expect(lands('Holder/properties/pick/oneOf/1')).toBe(true);
    });

    it('is false for anything typed otherwise, for a pointer the settle types nothing at, and past a cycle', () => {
      expect(lands('Holder/properties/name')).toBe(false);
      expect(lands('Holder/properties/dogs')).toBe(false);
      expect(lands('Holder/properties/either')).toBe(false);
      expect(lands('Holder/properties/pick')).toBe(false);
      expect(lands('Holder/properties/kind')).toBe(false);
      expect(lands('Holder/properties/self')).toBe(false);
      expect(lands('Holder/properties/nope')).toBe(false);
      expect(lands('Holder/$defs/dog')).toBe(false);
      expect(lands('Nope/properties/dog')).toBe(false);
      expect(pointerTypesAsModel('#/components/responses/Problem', schemas)).toBe(false);
      expect(pointerTypesAsModel('#/components/schemas/Holder/properties/dog', undefined)).toBe(false);
    });
  });

  it('maps the union as a webhook payload', async () => {
    const spec = await parseJson({
      ...documentWith('3.1.0', components('3.1.0'), {}),
      webhooks: {
        petChanged: {
          post: {
            operationId: 'petChanged',
            requestBody: { content: { 'application/json': { schema: union('none') } } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });
    expect(discriminatorOf(spec.webhooks?.[0]?.requestBody)).toEqual(MAPPED);
  });
});
