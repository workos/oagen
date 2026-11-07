import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec, type ParseOptions } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #619: a discriminator `mapping` entry whose target is a JSON Pointer
 * into a component outside the union's variants
 * (`dog: '#/components/schemas/Shelter/properties/dog'` beside a variant
 * `#/components/schemas/Zoo/properties/dog`) kept the key the bundler
 * rewrote it to and named the bundler's hoisted copy (`Dog`, a model nothing
 * referenced; `dog`, no model at all, inline) instead of `ShelterDog`, the
 * model built for the schema the target points at. The bundler's rewrite is
 * now undone before the parser reads the document (`loadAndBundleSpec`), and
 * every pointer entry settles to the model the pointed schema is built as —
 * with the variant written as that pointer, or on its own at the mapping
 * site (`deferPointerMappingEntries`, `settleDeferredMappingEntries`).
 */

const CAT = '#/components/schemas/Cat';
const ZOO_DOG = '#/components/schemas/Zoo/properties/dog';
const SHELTER_DOG = '#/components/schemas/Shelter/properties/dog';

/** The issue's animal: `{ kind: <const>, name?: string }`, the const spelled as the OAS version spells one. */
function animal(kind: string, openapi: string) {
  return {
    type: 'object',
    required: ['kind'],
    properties: {
      kind: openapi.startsWith('3.0') ? { type: 'string', enum: [kind] } : { type: 'string', const: kind },
      name: { type: 'string' },
    },
  };
}

/** The issue's union: `oneOf` the given variants, discriminated on `kind` with the given mapping. */
function union(mapping: Record<string, string>, variants: readonly string[] = [CAT, ZOO_DOG]) {
  return { oneOf: variants.map(($ref) => ({ $ref })), discriminator: { propertyName: 'kind', mapping } };
}

/** The issue's components: `Cat`, `Shelter: { dog }` and `Zoo: { dog }`, with `extra` beside them. */
function components(openapi: string, extra: Record<string, unknown> = {}) {
  return {
    Cat: animal('cat', openapi),
    Shelter: { type: 'object', properties: { dog: animal('dog', openapi) } },
    Zoo: { type: 'object', properties: { dog: animal('dog', openapi) } },
    ...extra,
  };
}

/** `GET /<stem>/{id}` returning `$ref`, as `operationId`. */
function getOp(operationId: string, $ref: string) {
  return {
    get: {
      operationId,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref } } } } },
    },
  };
}

/** The issue's document: the given component schemas, served by `GET /pets/{id}` returning `Pet` unless `paths` says otherwise. */
function documentWith(
  openapi: string,
  schemas: Record<string, unknown>,
  paths: Record<string, unknown> = { '/pets/{id}': getOp('getPet', '#/components/schemas/Pet') },
  rest: Record<string, unknown> = {},
) {
  return { openapi, info: { title: 'repro', version: '1' }, paths, components: { schemas, ...rest } };
}

const model = (name: string): TypeRef => ({ kind: 'model', name });

/** The inline union the issue writes on `Home.pet`, as the IR carries it: variants `Cat | ZooDog`, the `dog` entry mapped to `dog`. */
function expectedInlineUnion(dog: string) {
  return {
    kind: 'union',
    variants: [model('Cat'), model('ZooDog')],
    compositionKind: 'oneOf',
    discriminator: { property: 'kind', mapping: { cat: 'Cat', dog } },
  };
}

describe('#619', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-619-'));
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
  const variantNames = (m: Model | undefined) => m?.variants?.map((v) => (v.kind === 'model' ? v.name : v.kind));
  const fieldType = (spec: ApiSpec, modelName: string, field: string): TypeRef | undefined =>
    modelOf(spec, modelName)?.fields.find((f) => f.name === field)?.type;

  describe.each(['3.1.0', '3.0.3'])('on OpenAPI %s', (openapi) => {
    const issueMapping = { cat: CAT, dog: SHELTER_DOG };

    it('names the model built for the schema a component union’s entry points at, and builds no model for the bundler’s hoisted copy', async () => {
      const spec = await parseJson(documentWith(openapi, components(openapi, { Pet: union(issueMapping) })));
      const pet = modelOf(spec, 'Pet');
      expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } });
      expect(variantNames(pet)).toEqual(['Cat', 'ZooDog']);
      // No `Dog`: the component the bundler hoisted `Shelter.dog` into is dropped with the rewrite.
      expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('reads the same union written inline on a field the same way', async () => {
      const spec = await parseJson(
        documentWith(
          openapi,
          components(openapi, { Home: { type: 'object', properties: { pet: union(issueMapping) } } }),
          { '/homes/{id}': getOp('getHome', '#/components/schemas/Home') },
        ),
      );
      expect(fieldType(spec, 'Home', 'pet')).toEqual(expectedInlineUnion('ShelterDog'));
      expect(modelNames(spec)).toEqual(['Cat', 'Home', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('settles an allOf+oneOf dispatcher’s entry the same way, though it holds no variants', async () => {
      const spec = await parseJson(
        documentWith(
          openapi,
          components(openapi, {
            Base: { type: 'object', properties: { id: { type: 'string' } } },
            Pet: { allOf: [{ $ref: '#/components/schemas/Base' }, union(issueMapping)] },
          }),
        ),
      );
      const pet = modelOf(spec, 'Pet');
      expect(pet?.variants).toBeUndefined();
      expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } });
      expect(modelNames(spec)).toEqual(['Base', 'Cat', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('still settles an entry written as a variant’s own pointer with the variant, now without the hoisted copy', async () => {
      const spec = await parseJson(
        documentWith(openapi, components(openapi, { Pet: union({ cat: CAT, dog: ZOO_DOG }) })),
      );
      const pet = modelOf(spec, 'Pet');
      expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ZooDog' } });
      expect(variantNames(pet)).toEqual(['Cat', 'ZooDog']);
      expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('keeps naming a component target outside the variants by that component’s model', async () => {
      const spec = await parseJson(
        documentWith(
          openapi,
          components(openapi, {
            Wolf: animal('dog', openapi),
            Pet: union({ cat: CAT, dog: '#/components/schemas/Wolf' }),
          }),
        ),
      );
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Wolf' } });
      expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'Shelter', 'ShelterDog', 'Wolf', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('names the model built for an array’s items or a map’s values a pointer target lands on', async () => {
      const spec = await parseJson(
        documentWith(
          openapi,
          components(openapi, {
            Kennel: {
              type: 'object',
              properties: {
                dogs: { type: 'array', items: animal('dog', openapi) },
                byName: { type: 'object', additionalProperties: animal('hound', openapi) },
              },
            },
            Pet: union({
              cat: CAT,
              dog: '#/components/schemas/Kennel/properties/dogs/items',
              hound: '#/components/schemas/Kennel/properties/byName/additionalProperties',
            }),
          }),
        ),
      );
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'Cat', dog: 'KennelDogs', hound: 'KennelByName' },
      });
      // No `Item`, no `AdditionalProperties`: the components the bundler hoisted those schemas into are dropped.
      expect(modelNames(spec)).toEqual([
        'Cat',
        'Kennel',
        'KennelByName',
        'KennelDogs',
        'Pet',
        'Shelter',
        'ShelterDog',
        'Zoo',
        'ZooDog',
      ]);
      expect(warnings()).toEqual([]);
    });

    it('names one schema’s model from two keys pointing at it', async () => {
      const spec = await parseJson(
        documentWith(openapi, components(openapi, { Pet: union({ cat: CAT, dog: SHELTER_DOG, hound: SHELTER_DOG }) })),
      );
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'Cat', dog: 'ShelterDog', hound: 'ShelterDog' },
      });
      expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('follows a rename of the pointed schema’s model after the settle, as a component and inline', async () => {
      const spec = await parseJson(
        documentWith(
          openapi,
          components(openapi, {
            Pet: union(issueMapping),
            Home: { type: 'object', properties: { pet: union(issueMapping) } },
          }),
          {
            '/pets/{id}': getOp('getPet', '#/components/schemas/Pet'),
            '/homes/{id}': getOp('getHome', '#/components/schemas/Home'),
            // A `dog` query enum of the `shelter` service takes the name `ShelterDog`, so `Shelter.dog`'s model steps to `ShelterDog2`.
            '/shelter': {
              get: {
                operationId: 'listShelter',
                parameters: [{ name: 'dog', in: 'query', schema: { type: 'string', enum: ['x', 'y'] } }],
                responses: {
                  '200': {
                    description: 'OK',
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/Shelter' } } },
                  },
                },
              },
            },
          },
        ),
      );
      expect(spec.enums.map((e) => e.name)).toContain('ShelterDog');
      expect(fieldType(spec, 'Shelter', 'dog')).toEqual(model('ShelterDog2'));
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'Cat', dog: 'ShelterDog2' },
      });
      expect(fieldType(spec, 'Home', 'pet')).toEqual(expectedInlineUnion('ShelterDog2'));
      expect(modelNames(spec)).toEqual(['Cat', 'Home', 'Pet', 'Shelter', 'ShelterDog2', 'Zoo', 'ZooDog']);
    });

    it('reads a pointed schema that admits null through its nullable wrapper', async () => {
      const dog = openapi.startsWith('3.0')
        ? { ...animal('dog', openapi), nullable: true }
        : { oneOf: [animal('dog', openapi), { type: 'null' }] };
      const spec = await parseJson(
        documentWith(
          openapi,
          components(openapi, { Shelter: { type: 'object', properties: { dog } }, Pet: union(issueMapping) }),
        ),
      );
      expect(fieldType(spec, 'Shelter', 'dog')).toEqual({ kind: 'nullable', inner: model('ShelterDog') });
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'Cat', dog: 'ShelterDog' },
      });
      expect(warnings()).toEqual([]);
    });

    it('names the component a pointer target lands on a `$ref` to', async () => {
      const spec = await parseJson(
        documentWith(
          openapi,
          components(openapi, {
            Shelter: { type: 'object', properties: { friend: { $ref: CAT } } },
            Pet: union({ cat: CAT, dog: '#/components/schemas/Shelter/properties/friend' }),
          }),
        ),
      );
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Cat' } });
      expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'Shelter', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('warns about a target that leads nowhere and leaves the entry as written, as a component and inline', async () => {
      // The bundler rejects such a pointer (`Can't resolve $ref`), so one reaches the parser only through `transformSpec`.
      const nope = '#/components/schemas/Shelter/properties/nope';
      const spec = await parseJson(
        documentWith(
          openapi,
          components(openapi, {
            Pet: union({ cat: CAT }),
            Home: { type: 'object', properties: { pet: union({ cat: CAT }) } },
          }),
          {
            '/pets/{id}': getOp('getPet', '#/components/schemas/Pet'),
            '/homes/{id}': getOp('getHome', '#/components/schemas/Home'),
          },
        ),
        {
          transformSpec: (doc) => {
            const schemas = (
              doc.components as { schemas: Record<string, { discriminator: { mapping: Record<string, string> } }> }
            ).schemas;
            schemas.Pet!.discriminator.mapping.dog = nope;
            (
              schemas.Home as unknown as { properties: { pet: { discriminator: { mapping: Record<string, string> } } } }
            ).properties.pet.discriminator.mapping.dog = nope;
            return doc;
          },
        },
      );
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: nope } });
      expect(fieldType(spec, 'Home', 'pet')).toEqual({
        kind: 'union',
        variants: [model('Cat'), model('ZooDog')],
        compositionKind: 'oneOf',
        discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Shelter/properties/nope' } },
      });
      expect(warnings()).toEqual([
        `[oagen] Warning: Unresolved schema $ref "${nope}" in Pet.discriminator.mapping.dog: no schema at that pointer — leaving the entry as written`,
        `[oagen] Warning: Unresolved schema $ref "${nope}" in Home.pet.discriminator.mapping.dog: no schema at that pointer — leaving the entry as written`,
      ]);
    });

    it('leaves an entry pointing at a schema that builds no model — a string — as written', async () => {
      const name = '#/components/schemas/Shelter/properties/dog/properties/name';
      const spec = await parseJson(documentWith(openapi, components(openapi, { Pet: union({ cat: CAT, dog: name }) })));
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: name } });
      // No `Name`: the component the bundler hoisted the string schema into is dropped too.
      expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('reads a pointer target written through transformSpec as one the document wrote', async () => {
      const spec = await parseJson(documentWith(openapi, components(openapi, { Pet: union({ cat: CAT }) })), {
        transformSpec: (doc) => {
          const schemas = (
            doc.components as { schemas: Record<string, { discriminator: { mapping: Record<string, string> } }> }
          ).schemas;
          schemas.Pet!.discriminator.mapping.dog = SHELTER_DOG;
          return doc;
        },
      });
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'Cat', dog: 'ShelterDog' },
      });
      expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('keeps a component the document declares that equals the pointed schema, and still names the pointed schema’s model', async () => {
      // The bundler folds the target onto the document's own `dog` instead of adding a component: the entry names `ShelterDog` all the same, and `Dog` stays.
      const spec = await parseJson(
        documentWith(openapi, components(openapi, { dog: animal('dog', openapi), Pet: union(issueMapping) })),
      );
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'Cat', dog: 'ShelterDog' },
      });
      expect(modelNames(spec)).toEqual(['Cat', 'Dog', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('keeps a component the document declares under the hoist’s name with another shape, and drops the stepped hoist', async () => {
      // The bundler steps its hoist to `dog-2` beside the document's own `dog`: the stepped component goes, `Dog` stays.
      const spec = await parseJson(
        documentWith(
          openapi,
          components(openapi, {
            dog: { type: 'object', properties: { bark: { type: 'string' } } },
            Pet: union(issueMapping),
          }),
        ),
      );
      expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'Cat', dog: 'ShelterDog' },
      });
      expect(modelNames(spec)).toEqual(['Cat', 'Dog', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    it('reads the same whatever the order of the variants, the entries and the components', async () => {
      const reversed = {
        Pet: union({ dog: SHELTER_DOG, cat: CAT }, [ZOO_DOG, CAT]),
        Zoo: components(openapi).Zoo,
        Shelter: components(openapi).Shelter,
        Cat: components(openapi).Cat,
      };
      const spec = await parseJson(documentWith(openapi, reversed));
      const pet = modelOf(spec, 'Pet');
      expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } });
      expect(variantNames(pet)).toEqual(['ZooDog', 'Cat']);
      expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
      expect(warnings()).toEqual([]);
    });

    describe('an inline object variant pinning the entry’s value (Greptile, review round 1)', () => {
      // The entry redirects the variant to its target, as a component target does (`Wolf`): the
      // variant's reference is typed as the pointed schema's model, and its own model is kept beside.
      const inlineDog = (openapi: string) => ({
        ...animal('dog', openapi),
        properties: { ...animal('dog', openapi).properties, bark: { type: 'string' } },
      });
      const redirected = (openapi: string, variant: Record<string, unknown> = inlineDog(openapi)) => ({
        oneOf: [{ $ref: CAT }, variant],
        discriminator: { propertyName: 'kind', mapping: issueMapping },
      });

      it('is typed as the pointed schema’s model, as a component and inline', async () => {
        const spec = await parseJson(
          documentWith(
            openapi,
            components(openapi, {
              Pet: redirected(openapi),
              Home: { type: 'object', properties: { pet: redirected(openapi) } },
            }),
            {
              '/pets/{id}': getOp('getPet', '#/components/schemas/Pet'),
              '/homes/{id}': getOp('getHome', '#/components/schemas/Home'),
            },
          ),
        );
        const pet = modelOf(spec, 'Pet');
        expect(pet?.variants).toEqual([model('Cat'), model('ShelterDog')]);
        expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } });
        expect(fieldType(spec, 'Home', 'pet')).toEqual({
          kind: 'union',
          variants: [model('Cat'), model('ShelterDog')],
          compositionKind: 'oneOf',
          discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } },
        });
        expect(modelNames(spec)).toEqual([
          'Cat',
          'Home',
          'HomePet',
          'Pet',
          'PetWithKind',
          'Shelter',
          'ShelterDog',
          'Zoo',
          'ZooDog',
        ]);
        expect(warnings()).toEqual([]);
      });

      it('types the object member of a multi-type variant so, its other members as extracted', async () => {
        const spec = await parseJson(
          documentWith(
            openapi,
            components(openapi, { Pet: redirected(openapi, { ...inlineDog(openapi), type: ['object', 'string'] }) }),
          ),
        );
        const pet = modelOf(spec, 'Pet');
        expect(pet?.variants).toEqual([
          model('Cat'),
          { kind: 'union', variants: [model('ShelterDog'), { kind: 'primitive', type: 'string' }] },
        ]);
        expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } });
        expect(modelNames(spec)).toEqual(['Cat', 'Pet', 'PetWithKind', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
        expect(warnings()).toEqual([]);
      });

      it('follows a rename of the pointed schema’s model into a multi-type variant’s object member and its entry', async () => {
        // Greptile, round 2: the member sits inside the variant's union, which no rename reads a mapping entry through.
        const spec = await parseJson(
          documentWith(
            openapi,
            components(openapi, { Pet: redirected(openapi, { ...inlineDog(openapi), type: ['object', 'string'] }) }),
            {
              '/pets/{id}': getOp('getPet', '#/components/schemas/Pet'),
              '/shelter': {
                get: {
                  operationId: 'listShelter',
                  parameters: [{ name: 'dog', in: 'query', schema: { type: 'string', enum: ['x', 'y'] } }],
                  responses: {
                    '200': {
                      description: 'OK',
                      content: { 'application/json': { schema: { $ref: '#/components/schemas/Shelter' } } },
                    },
                  },
                },
              },
            },
          ),
        );
        expect(fieldType(spec, 'Shelter', 'dog')).toEqual(model('ShelterDog2'));
        const pet = modelOf(spec, 'Pet');
        expect(pet?.variants).toEqual([
          model('Cat'),
          { kind: 'union', variants: [model('ShelterDog2'), { kind: 'primitive', type: 'string' }] },
        ]);
        expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog2' } });
      });

      it('is made the pointer’s own beside a pointer variant of the same schema, as a component and inline', async () => {
        // Greptile, round 3: `dog` is the pointer variant, `hound` an inline variant, both entries targeting
        // `Shelter/properties/dog`; the identity match for `hound` must not leave its variant holding the pointer.
        const inlineHound = {
          ...animal('hound', openapi),
          properties: { ...animal('hound', openapi).properties, bark: { type: 'string' } },
        };
        const both = {
          oneOf: [{ $ref: CAT }, { $ref: SHELTER_DOG }, inlineHound],
          discriminator: { propertyName: 'kind', mapping: { cat: CAT, dog: SHELTER_DOG, hound: SHELTER_DOG } },
        };
        const spec = await parseJson(
          documentWith(
            openapi,
            components(openapi, { Pet: both, Home: { type: 'object', properties: { pet: both } } }),
            {
              '/pets/{id}': getOp('getPet', '#/components/schemas/Pet'),
              '/homes/{id}': getOp('getHome', '#/components/schemas/Home'),
            },
          ),
        );
        const mapping = { cat: 'Cat', dog: 'ShelterDog', hound: 'ShelterDog' };
        const pet = modelOf(spec, 'Pet');
        expect(pet?.variants).toEqual([model('Cat'), model('ShelterDog'), model('ShelterDog')]);
        expect(pet?.discriminator).toEqual({ property: 'kind', mapping });
        expect(fieldType(spec, 'Home', 'pet')).toEqual({
          kind: 'union',
          variants: [model('Cat'), model('ShelterDog'), model('ShelterDog')],
          compositionKind: 'oneOf',
          discriminator: { property: 'kind', mapping },
        });
        expect(modelNames(spec)).toEqual([
          'Cat',
          'Home',
          'HomePet',
          'Pet',
          'PetWithKind',
          'Shelter',
          'ShelterDog',
          'Zoo',
          'ZooDog',
        ]);
        expect(warnings()).toEqual([]);
      });

      it('follows a rename of the pointed schema’s model with the variant', async () => {
        const spec = await parseJson(
          documentWith(openapi, components(openapi, { Pet: redirected(openapi) }), {
            '/pets/{id}': getOp('getPet', '#/components/schemas/Pet'),
            // A `dog` query enum of the `shelter` service takes `ShelterDog`, so `Shelter.dog`'s model steps to `ShelterDog2`.
            '/shelter': {
              get: {
                operationId: 'listShelter',
                parameters: [{ name: 'dog', in: 'query', schema: { type: 'string', enum: ['x', 'y'] } }],
                responses: {
                  '200': {
                    description: 'OK',
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/Shelter' } } },
                  },
                },
              },
            },
          }),
        );
        expect(fieldType(spec, 'Shelter', 'dog')).toEqual(model('ShelterDog2'));
        const pet = modelOf(spec, 'Pet');
        expect(pet?.variants).toEqual([model('Cat'), model('ShelterDog2')]);
        expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog2' } });
      });

      it('types a variant redirected to a target that leads nowhere as unknown, with the pointer warning', async () => {
        const nope = '#/components/schemas/Shelter/properties/nope';
        const spec = await parseJson(documentWith(openapi, components(openapi, { Pet: redirected(openapi) })), {
          transformSpec: (doc) => {
            const schemas = (
              doc.components as { schemas: Record<string, { discriminator: { mapping: Record<string, string> } }> }
            ).schemas;
            schemas.Pet!.discriminator.mapping.dog = nope;
            return doc;
          },
        });
        const pet = modelOf(spec, 'Pet');
        expect(pet?.variants).toEqual([model('Cat'), { kind: 'primitive', type: 'unknown' }]);
        expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: nope } });
        expect(warnings()).toEqual([
          `[oagen] Warning: Unresolved schema $ref "${nope}" in Pet.variants: no schema at that pointer — typing the site as unknown`,
        ]);
      });

      describe('three keys sharing one pointed model, a pointer variant and a redirected variant beside (Greptile, round 4)', () => {
        // `dog` is the pointer variant, `hound` an inline variant, `puppy` no variant: all three target `Shelter/properties/dog`.
        const inlineHound = {
          ...animal('hound', openapi),
          properties: { ...animal('hound', openapi).properties, bark: { type: 'string' } },
        };
        const three = {
          oneOf: [{ $ref: CAT }, { $ref: SHELTER_DOG }, inlineHound],
          discriminator: {
            propertyName: 'kind',
            mapping: { cat: CAT, dog: SHELTER_DOG, hound: SHELTER_DOG, puppy: SHELTER_DOG },
          },
        };
        const schemas = components(openapi, { Pet: three, Home: { type: 'object', properties: { pet: three } } });
        const paths = {
          '/pets/{id}': getOp('getPet', '#/components/schemas/Pet'),
          '/homes/{id}': getOp('getHome', '#/components/schemas/Home'),
        };
        // A `dog` query enum of the `shelter` service takes `ShelterDog`, so `Shelter.dog`'s model steps to `ShelterDog2`.
        const shelterDogEnumListing = {
          get: {
            operationId: 'listShelter',
            parameters: [{ name: 'dog', in: 'query', schema: { type: 'string', enum: ['x', 'y'] } }],
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Shelter' } } },
              },
            },
          },
        };
        const expectAll = (spec: ApiSpec, name: string) => {
          const mapping = { cat: 'Cat', dog: name, hound: name, puppy: name };
          const pet = modelOf(spec, 'Pet');
          expect(pet?.variants).toEqual([model('Cat'), model(name), model(name)]);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping });
          expect(fieldType(spec, 'Home', 'pet')).toEqual({
            kind: 'union',
            variants: [model('Cat'), model(name), model(name)],
            compositionKind: 'oneOf',
            discriminator: { property: 'kind', mapping },
          });
        };

        it('names the pointed model from every key', async () => {
          const spec = await parseJson(documentWith(openapi, schemas, paths));
          expectAll(spec, 'ShelterDog');
          expect(warnings()).toEqual([]);
        });

        it('follows a rename of the pointed model from every key', async () => {
          const spec = await parseJson(documentWith(openapi, schemas, { ...paths, '/shelter': shelterDogEnumListing }));
          expect(fieldType(spec, 'Shelter', 'dog')).toEqual(model('ShelterDog2'));
          expectAll(spec, 'ShelterDog2');
        });
      });

      describe('a component target that is an alias of a pointer (MichaelDeBoey, review round 1)', () => {
        // The bundler follows `Hound` to the pointed schema and rewrites the entry to the component it hoists it into;
        // the entry is written back and read through the alias, so it names what the alias stands for and no `Dog` is built.
        const HOUND = '#/components/schemas/Hound';
        const aliased = (extra: Record<string, unknown> = {}) =>
          components(openapi, { Hound: { $ref: SHELTER_DOG }, ...extra });
        const homes = { '/homes/{id}': getOp('getHome', '#/components/schemas/Home') };

        it('names the pointer variant’s model, as the pointer spelling does, as a component and inline', async () => {
          const spec = await parseJson(
            documentWith(
              openapi,
              aliased({
                Pet: union({ cat: CAT, dog: HOUND }, [CAT, SHELTER_DOG]),
                Home: { type: 'object', properties: { pet: union({ cat: CAT, dog: HOUND }, [CAT, SHELTER_DOG]) } },
              }),
              { '/pets/{id}': getOp('getPet', '#/components/schemas/Pet'), ...homes },
            ),
          );
          const pet = modelOf(spec, 'Pet');
          expect(pet?.variants).toEqual([model('Cat'), model('ShelterDog')]);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } });
          expect(fieldType(spec, 'Home', 'pet')).toEqual({
            kind: 'union',
            variants: [model('Cat'), model('ShelterDog')],
            compositionKind: 'oneOf',
            discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } },
          });
          expect(modelNames(spec)).toEqual(['Cat', 'Home', 'Hound', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
          expect(warnings()).toEqual([]);
        });

        it('reads as the pointer spelling reads, so `oagen diff` between the two reports no change', async () => {
          const asAlias = await parseJson(
            documentWith(openapi, aliased({ Pet: union({ cat: CAT, dog: HOUND }, [CAT, SHELTER_DOG]) })),
          );
          const asPointer = await parseJson(
            documentWith(openapi, aliased({ Pet: union({ cat: CAT, dog: SHELTER_DOG }, [CAT, SHELTER_DOG]) })),
          );
          const { changes, summary } = diffSpecs(asAlias, asPointer);
          expect(changes).toEqual([]);
          expect(summary.breaking).toBe(0);
          expect(modelNames(asAlias)).toEqual(modelNames(asPointer));
        });

        it('settles an alias of a pointer outside the variants to the pointed schema’s model', async () => {
          const spec = await parseJson(documentWith(openapi, aliased({ Pet: union({ cat: CAT, dog: HOUND }) })));
          const pet = modelOf(spec, 'Pet');
          expect(variantNames(pet)).toEqual(['Cat', 'ZooDog']);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } });
          expect(modelNames(spec)).toEqual(['Cat', 'Hound', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
          expect(warnings()).toEqual([]);
        });

        it('names the alias itself when the alias is the variant', async () => {
          const spec = await parseJson(
            documentWith(openapi, aliased({ Pet: union({ cat: CAT, dog: HOUND }, [CAT, HOUND]) })),
          );
          const pet = modelOf(spec, 'Pet');
          expect(variantNames(pet)).toEqual(['Cat', 'Hound']);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Hound' } });
          expect(modelNames(spec)).toEqual(['Cat', 'Hound', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
          expect(warnings()).toEqual([]);
        });

        it('names the component an alias of a component stands for, as the bundler’s rewrite did', async () => {
          const spec = await parseJson(
            documentWith(openapi, aliased({ Hound: { $ref: CAT }, Pet: union({ cat: CAT, dog: HOUND }) })),
          );
          const pet = modelOf(spec, 'Pet');
          expect(variantNames(pet)).toEqual(['Cat', 'ZooDog']);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Cat' } });
          expect(modelNames(spec)).toEqual(['Cat', 'Hound', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
          expect(warnings()).toEqual([]);
        });

        it('follows a chain of aliases to the pointer variant’s model', async () => {
          const spec = await parseJson(
            documentWith(
              openapi,
              aliased({
                Mutt: { $ref: HOUND },
                Pet: union({ cat: CAT, dog: '#/components/schemas/Mutt' }, [CAT, SHELTER_DOG]),
              }),
            ),
          );
          const pet = modelOf(spec, 'Pet');
          expect(variantNames(pet)).toEqual(['Cat', 'ShelterDog']);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } });
          expect(modelNames(spec)).toEqual(['Cat', 'Hound', 'Mutt', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
          expect(warnings()).toEqual([]);
        });

        it('types an inline variant the entry redirects to the alias as the pointed schema’s model', async () => {
          const inlineDog = {
            ...animal('dog', openapi),
            properties: { ...animal('dog', openapi).properties, bark: { type: 'string' } },
          };
          const spec = await parseJson(
            documentWith(
              openapi,
              aliased({
                Pet: {
                  oneOf: [{ $ref: CAT }, inlineDog],
                  discriminator: { propertyName: 'kind', mapping: { cat: CAT, dog: HOUND } },
                },
              }),
            ),
          );
          const pet = modelOf(spec, 'Pet');
          expect(pet?.variants).toEqual([model('Cat'), model('ShelterDog')]);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } });
          expect(modelNames(spec)).toEqual([
            'Cat',
            'Hound',
            'Pet',
            'PetWithKind',
            'Shelter',
            'ShelterDog',
            'Zoo',
            'ZooDog',
          ]);
          expect(warnings()).toEqual([]);
        });
      });

      describe('a pointer target matched to a member the site holds no pending variant for (Greptile, round 5)', () => {
        it('settles a dispatcher’s entry written as its own pointer member’s pointer', async () => {
          // A dispatcher holds no variants, so the pointer member's match defers to a reference of the pointer's own.
          const spec = await parseJson(
            documentWith(
              openapi,
              components(openapi, {
                Base: { type: 'object', properties: { id: { type: 'string' } } },
                Pet: { allOf: [{ $ref: '#/components/schemas/Base' }, union({ cat: CAT, dog: ZOO_DOG })] },
              }),
            ),
          );
          const pet = modelOf(spec, 'Pet');
          expect(pet?.variants).toBeUndefined();
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ZooDog' } });
          expect(modelNames(spec)).toEqual(['Base', 'Cat', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
          expect(warnings()).toEqual([]);
        });

        it('names a named alias variant for a pointer target matched through it, as a component and inline', async () => {
          // `$ref: Hound` aliases `Shelter/properties/dog`: the entry names the variant's model, not the pointer it reached it by.
          const HOUND = '#/components/schemas/Hound';
          const aliasVariant = union({ cat: CAT, dog: SHELTER_DOG }, [CAT, HOUND]);
          const spec = await parseJson(
            documentWith(
              openapi,
              components(openapi, {
                Hound: { $ref: SHELTER_DOG },
                Pet: aliasVariant,
                Home: { type: 'object', properties: { pet: aliasVariant } },
              }),
              {
                '/pets/{id}': getOp('getPet', '#/components/schemas/Pet'),
                '/homes/{id}': getOp('getHome', '#/components/schemas/Home'),
              },
            ),
          );
          const pet = modelOf(spec, 'Pet');
          expect(pet?.variants).toEqual([model('Cat'), model('Hound')]);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Hound' } });
          expect(fieldType(spec, 'Home', 'pet')).toEqual({
            kind: 'union',
            variants: [model('Cat'), model('Hound')],
            compositionKind: 'oneOf',
            discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Hound' } },
          });
          expect(modelNames(spec)).toEqual(['Cat', 'Home', 'Hound', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
          expect(warnings()).toEqual([]);
        });
      });

      describe('a variant of its own naming the component a pointer entry’s alias target names (Greptile, round 6)', () => {
        it('keeps an array variant’s items as written while the entry settles through the alias, as a component and inline', async () => {
          // `items: { $ref: Hound }` is the document's own reference, not one a redirect made: only references
          // `inlineVariantTypeRef` built for a redirect follow the entry to the pointer.
          const HOUND = '#/components/schemas/Hound';
          const withArray = {
            oneOf: [{ $ref: CAT }, { $ref: SHELTER_DOG }, { type: 'array', items: { $ref: HOUND } }],
            discriminator: { propertyName: 'kind', mapping: { cat: CAT, dog: HOUND } },
          };
          const spec = await parseJson(
            documentWith(
              openapi,
              components(openapi, {
                Hound: { $ref: SHELTER_DOG },
                Pet: withArray,
                Home: { type: 'object', properties: { pet: withArray } },
              }),
              {
                '/pets/{id}': getOp('getPet', '#/components/schemas/Pet'),
                '/homes/{id}': getOp('getHome', '#/components/schemas/Home'),
              },
            ),
          );
          const variants = [model('Cat'), model('ShelterDog'), { kind: 'array', items: model('Hound') }];
          const pet = modelOf(spec, 'Pet');
          expect(pet?.variants).toEqual(variants);
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } });
          expect(fieldType(spec, 'Home', 'pet')).toEqual({
            kind: 'union',
            variants,
            compositionKind: 'oneOf',
            discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'ShelterDog' } },
          });
          expect(modelNames(spec)).toEqual(['Cat', 'Home', 'Hound', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
          expect(warnings()).toEqual([]);
        });
      });

      describe('two alias variants, one an alias of the other (Greptile, round 7)', () => {
        // `Mutt: { $ref: Hound }`, `Hound: { $ref: Shelter/properties/dog }`: a target names the variant reached through the
        // fewest aliases of its own, whatever order the variants are declared in.
        const HOUND = '#/components/schemas/Hound';
        const MUTT = '#/components/schemas/Mutt';
        const aliases = { Hound: { $ref: SHELTER_DOG }, Mutt: { $ref: HOUND } };
        const orders: Array<[string, string[]]> = [
          ['Mutt first', [CAT, MUTT, HOUND]],
          ['Hound first', [CAT, HOUND, MUTT]],
        ];

        it.each(orders)('names the variant an entry names outright, %s', async (_label, variants) => {
          const spec = await parseJson(
            documentWith(openapi, components(openapi, { ...aliases, Pet: union({ cat: CAT, dog: HOUND }, variants) })),
          );
          const pet = modelOf(spec, 'Pet');
          expect(variantNames(pet)).toEqual(variants.map((v) => v.split('/').pop()));
          expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Hound' } });
          expect(modelNames(spec)).toEqual(['Cat', 'Hound', 'Mutt', 'Pet', 'Shelter', 'ShelterDog', 'Zoo', 'ZooDog']);
          expect(warnings()).toEqual([]);
        });

        it.each(orders)(
          'names the alias nearest the pointer for an entry written as the pointer, %s',
          async (_label, variants) => {
            const spec = await parseJson(
              documentWith(
                openapi,
                components(openapi, { ...aliases, Pet: union({ cat: CAT, dog: SHELTER_DOG }, variants) }),
              ),
            );
            expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
              property: 'kind',
              mapping: { cat: 'Cat', dog: 'Hound' },
            });
            expect(warnings()).toEqual([]);
          },
        );

        it.each(orders)('names the farther alias when the entry names it outright, %s', async (_label, variants) => {
          const spec = await parseJson(
            documentWith(openapi, components(openapi, { ...aliases, Pet: union({ cat: CAT, dog: MUTT }, variants) })),
          );
          expect(modelOf(spec, 'Pet')?.discriminator).toEqual({
            property: 'kind',
            mapping: { cat: 'Cat', dog: 'Mutt' },
          });
          expect(warnings()).toEqual([]);
        });
      });
    });
  });
});
